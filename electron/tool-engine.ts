// =============================================================================
// electron/tool-engine.ts  —  Capri 매매도구 엔진 (v2: 자율판단 제거, 온디맨드 전용)
// -----------------------------------------------------------------------------
// [v1(bot-engine)과 무엇이 다른가? — 컨셉 전환의 핵심]
//   v1: 봇이 5초마다 스스로 깨어나(틱 루프) 세션을 자동 전진(체결확인·익절·손절).
//   v2: ★자동으로 도는 것이 하나도 없다.★ 모든 동작은 사람이 화면에서 버튼을
//       눌렀을 때만 1회 실행된다(계산·시세조회·주문). 익절/손절 감시는 봇이 아니라
//       "토스 서버의 조건주문(OCO/OTO)"이 대신한다 — 그래서 앱을 꺼도 작동한다.
//
// [남긴 안전장치]
//   - 킬 스위치: 켜면 모든 주문 버튼이 잠긴다(계산·조회는 가능).
//   - 가격 이상 감지: 주문가가 현재가 ±5%를 벗어나면 오타로 보고 차단(제안값).
//   - 실주문 잠금: 실서버 모드의 주문은 전부 "드라이런"(모의 기록만).
//     해금은 소액(1주) 테스트를 사람이 직접 통과시킨 뒤 별도 버전에서(사용자 확정).
//
// [시크릿] 키는 앱 데이터 폴더 .env(권한 600)에만. 로그·화면·저장 데이터에 값 노출 금지.
// =============================================================================

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { getSession, isOrderFrozen, type Session } from "../lib/session";
import { calcSplit3, calcOrderbook, calcCandle, roundPrice, getTick, type SplitOrder } from "../lib/calc";
import {
  getPrice,
  getAccounts,
  getBuyingPower,
  getExchangeRate,
  createOrder,
  createConditionalOrder,
  listOrders,
  listConditionalOrders,
  cancelOrder,
  cancelConditionalOrder,
  clearTokenCache,
  makeClientOrderId,
  type ConditionalOrderResponse,
  type OrderResponse,
} from "../lib/toss";
import { createMockTossServer } from "../mocks/toss-mock";

// -----------------------------------------------------------------------------
// 타입: 화면과 주고받는 모양
// -----------------------------------------------------------------------------

/** 매매기법 종류(사용자가 매번 직접 선택) */
export type Technique = "split3" | "orderbook" | "candle" | "manual";

/** 계산 요청: 기법별로 필요한 재료가 다르다(화면이 기법에 맞는 칸만 보여줌) */
export interface CalcRequest {
  technique: Technique;
  tpPct: number; //  익절 % (기본 2)
  slPct: number; //  손절 % (기본 10)
  baseClose?: number; // [삼분할] 전봉 종가
  ema200?: number; //    [삼분할] EMA200
  wallPrice?: number; // [호가창] 매수벽 가격
  barOpen?: number; //   [캔들] 현재봉 시가 (전봉 양봉 확인은 사람 몫)
  entry?: number; //     [수동] 진입가 직접 입력
}

/** 계산 결과 한 줄(분할 레벨 하나) */
export interface CalcLevel {
  level: number;
  entry: number;
  tp: number;
  sl: number;
}

export interface CalcResult {
  technique: Technique;
  levels: CalcLevel[];
  note: string; // 화면에 보여줄 기법 설명 한 줄
}

/** 도구 상태(화면 표시용) */
export interface ToolStatus {
  mode: "mock" | "live";
  dryRun: boolean;
  liveOrdersEnabled: boolean; // 실주문 활성화 토글 상태(빨간 배지 표시용)
  skipOrderConfirm: boolean; // 주문 확인 팝업 건너뛰기
  killSwitch: boolean;
  session: Session; //       지금 장 세션(정보 표시용 — 주문을 막지는 않음)
  orderFrozen: boolean; //   마감 1분 전 정정·취소 불가 구간 경고
  clockNote: string;
  fxRate: number | null; //  1 USD = ? KRW (토스 API, 1분 캐시)
  fxSource: "toss" | "manual" | null;
  buyingPowerUsd: number | null;
}

/** 주문/기록 저널 한 줄(파일로 영속) */
export interface JournalEntry {
  ts: string;
  kind: "entry" | "oco" | "oto" | "cancel" | "dryrun" | "info";
  symbol: string;
  summary: string; // 사람이 읽는 한 줄 요약
  detail?: unknown;
}

// -----------------------------------------------------------------------------
// .env 파싱(경량)
// -----------------------------------------------------------------------------
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// -----------------------------------------------------------------------------
// 엔진 본체
// -----------------------------------------------------------------------------

export class ToolEngine extends EventEmitter {
  private envPath: string;
  private journalPath: string;
  private journal: JournalEntry[] = [];

  private mode: "mock" | "live" = "mock";
  private killSwitch = false;
  /** [v0.2.5] 실주문 활성화 스위치. 기본 false(잠금) — 설정 탭에서 사용자가 명시적으로 켠다. */
  private liveOrdersEnabled = false;
  /**
   * [v0.2.7] 오입력 방지(현재가에서 크게 벗어난 가격 경고). **기본 꺼짐**.
   *   예전엔 ±15%가 코드에 박혀 있어 오너가 원하는 가격도 앱이 임의로 막았다.
   *   이제 기본은 "앱이 막지 않음"이고, 원할 때만 켜고 임계값도 직접 정한다.
   */
  private priceGuardEnabled = false;
  private priceGuardPct = 15; // 켰을 때 쓸 기본 제안값(사용자가 바꿀 수 있음)
  /** [v0.2.7] 주문 확인 팝업 건너뛰기(기본 false = 팝업 표시) */
  private skipOrderConfirm = false;
  private mock: ReturnType<typeof createMockTossServer> | null = null;
  private mockPort = 0;

  // 환율 캐시(토스 스펙: 1분 갱신이므로 60초 캐시)
  private fxCache: { rate: number; atMs: number; source: "toss" | "manual" } | null = null;
  private buyingPowerUsd: number | null = null;

  constructor(
    private userDataDir: string,
    opts?: { forceMock?: boolean },
  ) {
    super();
    mkdirSync(userDataDir, { recursive: true });
    this.envPath = join(userDataDir, ".env");
    this.journalPath = join(userDataDir, "kylebot-journal.json");
    this.loadEnv();
    // [개발 검증용] E2E 등 자동 검증은 절대 실서버를 건드리면 안 되므로 연습 모드 강제.
    if (opts?.forceMock) this.mode = "mock";
    this.loadJournal();
  }

  // --------------------------------------------------------------------------
  // 설정/모드 (v1과 동일한 규칙: 키가 있어야 실서버, 아니면 연습)
  // --------------------------------------------------------------------------
  private loadEnv(): void {
    if (existsSync(this.envPath)) {
      for (const [k, v] of Object.entries(parseEnv(readFileSync(this.envPath, "utf8")))) process.env[k] = v;
    }
    // [이중 안전] 구버전(0.2.0)이 저장해둔 틀린 주소(apigw)가 .env에 남아 있을 수 있다.
    //   prepareBackend가 실서버 요청 직전에 openapi로 덮어쓰지만, 여기서도 선제 교정해
    //   혹시 모를 경로로 낡은 주소가 새어나가지 않게 한다.
    if (process.env.TOSS_BASE_URL && /apigw\.tossinvest\.com/i.test(process.env.TOSS_BASE_URL)) {
      process.env.TOSS_BASE_URL = ToolEngine.LIVE_BASE_URL;
    }
    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    this.mode = process.env.TOSS_MOCK !== "true" && hasKeys ? "live" : "mock";
  }

  getSettings() {
    return {
      mode: this.mode,
      hasClientId: !!process.env.TOSS_CLIENT_ID,
      hasClientSecret: !!process.env.TOSS_CLIENT_SECRET,
      account: process.env.TOSS_ACCOUNT ?? "",
      liveOrdersEnabled: this.liveOrdersEnabled, // 실주문 활성화 여부(설정 탭 토글 상태)
      priceGuardEnabled: this.priceGuardEnabled,
      priceGuardPct: this.priceGuardPct,
      skipOrderConfirm: this.skipOrderConfirm,
    };
  }

  async saveSettings(input: { mode: "mock" | "live"; clientId?: string; clientSecret?: string; account?: string }) {
    const prevAccount = process.env.TOSS_ACCOUNT ?? "";
    if (input.clientId) process.env.TOSS_CLIENT_ID = input.clientId.trim();
    if (input.clientSecret) process.env.TOSS_CLIENT_SECRET = input.clientSecret.trim();
    if (input.account !== undefined) process.env.TOSS_ACCOUNT = input.account.trim();

    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    const newMode = input.mode === "live" && hasKeys ? "live" : "mock";
    // 모드가 바뀌거나 "계좌만" 바뀌어도 이전 계좌의 매수가능금액/환율 캐시는 무효화한다.
    const accountChanged = (process.env.TOSS_ACCOUNT ?? "") !== prevAccount;
    if (newMode !== this.mode || accountChanged) {
      this.fxCache = null;
      this.buyingPowerUsd = null;
    }
    if (newMode !== this.mode) {
      this.mode = newMode;
      await this.stopMock(); // 모드가 바뀌면 연습 서버 상태 초기화
    }
    process.env.TOSS_MOCK = this.mode === "mock" ? "true" : "false";
    // 실서버 주소는 검증된 openapi 도메인으로 고정(틀린 apigw 주소 버그 수정).
    if (this.mode === "live") process.env.TOSS_BASE_URL = ToolEngine.LIVE_BASE_URL;
    clearTokenCache(); // 키/계좌가 바뀌었을 수 있으니 토큰 재발급

    // [계좌 자동 조회] 실서버인데 계좌가 비어 있으면 /api/v1/accounts 로 accountSeq를 자동 확보한다.
    //   (예전엔 사용자가 "1"을 손으로 입력해야 했고, 실제 accountSeq가 1이 아니면 조용히 틀렸다.)
    //   실패해도 저장 자체는 진행(사용자가 나중에 직접 입력 가능).
    if (this.mode === "live" && !process.env.TOSS_ACCOUNT?.trim()) {
      try {
        const accts = await getAccounts();
        if (accts.length > 0) {
          process.env.TOSS_ACCOUNT = String(accts[0].accountSeq);
          this.addJournal({ kind: "info", symbol: "-", summary: `계좌 자동 확인: accountSeq ${accts[0].accountSeq}` });
        }
      } catch {
        /* 조회 실패해도 저장은 계속(사용자가 설정 탭에서 직접 입력 가능) */
      }
    }

    const lines = [
      "# Capri 매매도구 설정(자동 생성). 이 파일은 본인 컴퓨터에만 있습니다.",
      `TOSS_MOCK=${this.mode === "mock" ? "true" : "false"}`,
      `TOSS_BASE_URL=${this.mode === "live" ? ToolEngine.LIVE_BASE_URL : ""}`,
      `TOSS_CLIENT_ID=${process.env.TOSS_CLIENT_ID ?? ""}`,
      `TOSS_CLIENT_SECRET=${process.env.TOSS_CLIENT_SECRET ?? ""}`,
      `TOSS_ACCOUNT=${process.env.TOSS_ACCOUNT ?? ""}`,
      "DRY_RUN=true", // ★ 실주문 잠금: 소액 테스트 통과 전까지 해제 불가(사용자 확정 사항)
      "",
    ].join("\n");
    writeFileSync(this.envPath, lines, "utf8");
    chmodSync(this.envPath, 0o600);
    this.addJournal({ kind: "info", symbol: "-", summary: `설정 저장 (모드: ${this.mode === "mock" ? "연습" : "실서버(주문 잠금)"})` });
    return this.getSettings();
  }

  // 실서버(실제 토스) 기본 주소 — 읽기전용 검증에서 실제로 200이 확인된 도메인.
  //  [교훈] 이전엔 apigw.tossinvest.com 을 썼는데 그건 틀린 주소라 모든 실서버 요청이
  //  실패했다. 반드시 아래 openapi 도메인을 쓴다(2026-07-18 실검증).
  private static readonly LIVE_BASE_URL = "https://openapi.tossinvest.com";

  /**
   * prepareBackend — 매 조회·주문 직전에 "현재 모드에 맞는 접속 상태"를 확실히 맞춘다.
   *
   * [왜 매번 맞추나? = 버그 재발 방지]
   *   예전엔 모드/주소를 여러 곳(설정 저장·백엔드 준비)에서 따로 정해서, 배지는 "연습"인데
   *   요청은 실서버로 나가는 모순이 생겼다. 이제 이 함수 하나가 "모드와 실제 접속 주소"를
   *   항상 일치시킨다(단일 진실 소스).
   *     - 연습 모드: 가짜 서버(127.0.0.1)로만. 계좌 없으면 practice 로 자동 채움.
   *     - 실서버 모드: 실제 토스(openapi)로만. 가짜 서버는 끈다.
   */
  private async prepareBackend(): Promise<void> {
    if (this.mode === "mock") {
      if (!this.mock) {
        this.mock = createMockTossServer();
        this.mockPort = await this.mock.listen();
        this.addJournal({ kind: "info", symbol: "-", summary: `연습용 가짜 토스 서버 준비 (127.0.0.1:${this.mockPort})` });
      }
      process.env.TOSS_MOCK = "true";
      process.env.TOSS_BASE_URL = `http://127.0.0.1:${this.mockPort}`;
      if (!process.env.TOSS_ACCOUNT) process.env.TOSS_ACCOUNT = "practice";
    } else {
      await this.stopMock();
      process.env.TOSS_MOCK = "false";
      process.env.TOSS_BASE_URL = ToolEngine.LIVE_BASE_URL;
    }
  }

  /**
   * assertAccountReady — 실서버 모드에서 계좌가 비어 있으면, 서버에 요청을 보내기 전에
   *   "설정 탭에서 계좌를 입력하라"고 사람이 이해할 수 있는 한국어로 막는다.
   *   [왜?] 계좌가 비면 토스가 400 missing_account 를 주는데, 그 원시 에러가 화면에
   *   그대로 노출돼 오너가 원인을 알 수 없었다(실제 발생한 버그).
   */
  private assertAccountReady(): void {
    if (this.mode === "live" && !process.env.TOSS_ACCOUNT?.trim()) {
      throw new Error(
        "계좌가 설정되지 않았습니다. [설정] 탭에서 '계좌번호(accountSeq)' 칸에 보통 1 을 입력하고 저장한 뒤 다시 시도하세요.",
      );
    }
  }

  async stopMock(): Promise<void> {
    if (this.mock) {
      await this.mock.close();
      this.mock = null;
    }
  }

  /** 연습 모드 전용: 가짜 서버 현재가 조작(익절/손절 발동 연습) */
  async mockSetPrice(symbol: string, price: number): Promise<boolean> {
    await this.prepareBackend();
    if (!this.mock) return false;
    this.mock.setPrice(symbol.toUpperCase(), Math.round(price * 100) / 100);
    return true;
  }

  // --------------------------------------------------------------------------
  // 킬 스위치: 모든 "주문" 버튼 잠금(조회·계산은 허용)
  // --------------------------------------------------------------------------
  /**
   * setKillSwitch — 비상 정지.
   *   [v0.2.5 실효화] 예전엔 "신규 주문 차단"만 했고 이미 걸린 미체결 주문은 그대로 남았다.
   *   이제 켜는 순간 **미체결 주문·조건주문을 실제로 전량 취소**한다(실주문 모드일 때).
   *   취소 자체가 실패해도 신규 차단은 유지되고, 무엇이 실패했는지 기록에 남긴다.
   */
  async setKillSwitch(on: boolean): Promise<void> {
    this.killSwitch = on;
    this.addJournal({ kind: "info", symbol: "-", summary: on ? "🔴 킬 스위치 ON — 신규 주문 전체 잠금" : "🟢 킬 스위치 OFF" });
    if (!on) return;

    // 켜졌을 때: 살아있는 주문을 거둬들인다(읽기+취소). 드라이런이면 기록만.
    try {
      await this.prepareBackend();
      const [open, conds] = await Promise.all([this.openOrders(), this.conditionals()]);
      const dry = this.isDryRun();
      let done = 0;
      for (const o of open) {
        try {
          if (!dry) await cancelOrder(o.tossOrderId);
          done++;
        } catch (e) {
          this.addJournal({ kind: "info", symbol: o.symbol ?? "-", summary: `⚠️ 주문 취소 실패 ${o.tossOrderId}: ${String(e).slice(0, 80)}` });
        }
      }
      for (const c of conds) {
        try {
          if (!dry) await cancelConditionalOrder(c.conditionalOrderId);
          done++;
        } catch (e) {
          this.addJournal({ kind: "info", symbol: "-", summary: `⚠️ 조건주문 취소 실패 ${c.conditionalOrderId}: ${String(e).slice(0, 80)}` });
        }
      }
      this.addJournal({
        kind: dry ? "dryrun" : "cancel",
        symbol: "-",
        summary: `${dry ? "[드라이런] " : ""}킬 스위치: 미체결 ${open.length}건 + 조건주문 ${conds.length}건 → ${done}건 취소${dry ? " 예정(실제 전송 안 함)" : " 완료"}`,
      });
    } catch (e) {
      this.addJournal({ kind: "info", symbol: "-", summary: `⚠️ 킬 스위치 취소 처리 중 오류(신규 차단은 유지됨): ${String(e).slice(0, 100)}` });
    }
  }

  /**
   * setLiveOrders — 실주문 활성화 토글(해금). 기본은 꺼짐(잠금).
   *   [안전 설계] 켜는 행위는 반드시 사람이 화면에서 경고를 확인한 뒤에만 일어난다(UI가 보장).
   *   여기서는 상태만 바꾸고, 무엇이 바뀌었는지 기록에 크게 남긴다.
   */
  /** [v0.2.7] 오입력 방지 설정(켜기/끄기 + 임계값). 기본은 꺼짐. */
  setPriceGuard(on: boolean, pct?: number): void {
    this.priceGuardEnabled = on;
    if (typeof pct === "number" && Number.isFinite(pct) && pct > 0) this.priceGuardPct = pct;
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: on ? `오입력 방지 ON (±${this.priceGuardPct}%)` : "오입력 방지 OFF — 앱이 가격으로 막지 않습니다",
    });
  }

  /** [v0.2.7] 주문 확인 팝업 건너뛰기(기본 끔 = 팝업 표시). 화면에서만 쓰지만 상태는 여기 보관. */
  setSkipConfirm(on: boolean): void {
    this.skipOrderConfirm = on;
    this.addJournal({ kind: "info", symbol: "-", summary: on ? "주문 확인 팝업 건너뛰기 ON" : "주문 확인 팝업 표시 ON" });
  }

  setLiveOrders(on: boolean): void {
    this.liveOrdersEnabled = on;
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: on
        ? "🔴🔴 실주문 활성화됨 — 이제 주문 버튼을 누르면 실제 돈으로 주문이 전송됩니다"
        : "🔒 실주문 잠금(드라이런)으로 되돌림 — 주문은 모의 기록만 남습니다",
    });
  }

  // --------------------------------------------------------------------------
  // 조회(사람이 버튼 눌렀을 때만 1회)
  // --------------------------------------------------------------------------
  async quote(symbol: string): Promise<number> {
    await this.prepareBackend();
    const { price } = await getPrice(symbol.toUpperCase());
    return price;
  }

  /**
   * 환율: 토스 공식 API(1분 갱신 참고용)를 60초 캐시로 조회.
   * 실패하면 null을 돌려주고, 화면은 "수동 입력" 칸을 보여준다(사용자 확정: 자동 우선+수동 폴백).
   */
  async fx(): Promise<{ rate: number; source: "toss" | "manual" } | null> {
    if (this.fxCache && Date.now() - this.fxCache.atMs < 60_000) {
      return { rate: this.fxCache.rate, source: this.fxCache.source };
    }
    try {
      await this.prepareBackend();
      const r = await getExchangeRate("USD", "KRW");
      if (r.rate > 0) {
        this.fxCache = { rate: r.rate, atMs: Date.now(), source: "toss" };
        return { rate: r.rate, source: "toss" };
      }
      return null;
    } catch {
      return null; // 화면이 수동 입력 폴백을 띄움
    }
  }

  /** 수동 환율 입력(자동 조회 실패 시 폴백) */
  setManualFx(rate: number): void {
    if (rate > 0) this.fxCache = { rate, atMs: Date.now(), source: "manual" };
  }

  async refreshBuyingPower(): Promise<number | null> {
    try {
      await this.prepareBackend();
      this.assertAccountReady();
      const bp = await getBuyingPower("USD");
      this.buyingPowerUsd = bp.buyingPowerUsd;
      return this.buyingPowerUsd;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // ★ 계산기: Capri매매기법 3종 + 수동 (설계서 M1의 검증된 함수를 그대로 호출)
  // --------------------------------------------------------------------------
  calc(req: CalcRequest): CalcResult {
    const tp = req.tpPct;
    const sl = req.slPct;

    switch (req.technique) {
      case "split3": {
        if (req.baseClose == null || req.ema200 == null) throw new Error("삼분할: 전봉 종가와 EMA200을 입력하세요.");
        // 진입 필터(gap>0) 위반이면 calcSplit3가 명확한 한국어 에러를 던진다 → 그대로 화면에.
        const { splits } = calcSplit3(req.baseClose, req.ema200, tp, sl);
        return {
          technique: "split3",
          levels: splits.map((s: SplitOrder) => ({ level: s.level, entry: s.entry, tp: s.tp, sl: s.sl })),
          note: "전봉종가~EMA200 구간 3등분. 각 분할은 독립된 한 판(사양서).",
        };
      }
      case "orderbook": {
        if (req.wallPrice == null) throw new Error("호가창: 매수벽 가격을 입력하세요.");
        const o = calcOrderbook(req.wallPrice, getTick(req.wallPrice), tp, sl);
        return {
          technique: "orderbook",
          levels: [{ level: 1, entry: o.entry, tp: o.tp!, sl: o.sl! }],
          note: "진입 = 매수벽 + 1틱. 벽 판단은 사람 몫(정량 기준 미확정).",
        };
      }
      case "candle": {
        if (req.barOpen == null) throw new Error("캔들: 현재봉 시가를 입력하세요.");
        const o = calcCandle(req.barOpen, getTick(req.barOpen), tp, sl);
        return {
          technique: "candle",
          levels: [{ level: 1, entry: o.entry, tp: o.tp!, sl: o.sl! }],
          note: "진입 = 현재봉 시가 − 3틱. ★전봉이 양봉일 때만 쓰는 기법(확인은 사람 몫).",
        };
      }
      case "manual": {
        if (req.entry == null) throw new Error("수동: 진입가를 입력하세요.");
        const entry = roundPrice(req.entry);
        return {
          technique: "manual",
          levels: [{ level: 1, entry, tp: roundPrice(entry * (1 + tp / 100)), sl: roundPrice(entry * (1 - sl / 100)) }],
          note: "직접 입력한 진입가 기준 익절/손절 계산.",
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // 주문(전부 사람이 확인 팝업을 누른 뒤에만 호출됨 — UI가 보장)
  // --------------------------------------------------------------------------

  /**
   * 주문 공통 게이트: 킬스위치 확인 + (진입가에 한해) 가격 이상 검사.
   *
   * [왜 진입가만 검사하나?] 익절/손절 감시가는 기법상 "원래 현재가에서 먼 값"이다
   *   (손절 기본 −10%). 여기에 ±5%를 들이대면 정상 주문이 다 막힌다 — v1 실검증에서
   *   확인된 교훈(progress.md). 익절/손절은 대신 OCO 규칙(익절>현재가>손절)으로 검증.
   * [한도 ±15%인 이유] 삼분할 3분할(EMA200)은 깊은 눌림 대기 주문이라 5%보다 멀 수
   *   있다. 오타(자릿수 실수)는 보통 수십% 이상 어긋나므로 15%면 오타는 잡고
   *   전략 주문은 통과시킨다(제안값 — 오너가 조정 가능).
   */
  private async orderGate(symbol: string, entryPrices: number[] = []): Promise<number> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있어 주문이 잠겨 있습니다.");
    await this.prepareBackend();
    this.assertAccountReady(); // 실서버인데 계좌 미설정이면 친절한 안내로 막음
    const { price: cur } = await getPrice(symbol.toUpperCase());
    // [현재가 방어] cur가 0/음수/NaN이면 아래 편차 계산이 0으로 나누기(Infinity)나
    //   NaN이 되어 오차단·오통과가 생긴다(프리마켓 무거래 등). 먼저 막는다.
    if (!Number.isFinite(cur) || cur <= 0) {
      throw new Error("현재가를 확인할 수 없습니다(무거래 시간대이거나 종목코드 확인). 잠시 후 다시 시도하세요.");
    }
    // [오입력 방지] 기본은 꺼져 있어 어떤 가격이든 통과한다(오너 결정).
    //   설정 탭에서 켠 경우에만, 사용자가 정한 임계값으로 경고 차단한다.
    if (this.priceGuardEnabled) {
      for (const p of entryPrices) {
        const dev = Math.abs((p - cur) / cur) * 100;
        if (dev > this.priceGuardPct) {
          throw new Error(
            `[오입력 방지 — 설정에서 켜둔 기능] 주문을 보내지 않았습니다.
` +
              `· 입력한 진입가: $${p}
` +
              `· 현재가: $${cur}
` +
              `· 차이: ${dev.toFixed(1)}% (내가 정한 한도 ±${this.priceGuardPct}%)

` +
              `의도한 가격이 맞다면 설정 탭에서 이 기능을 끄거나 한도를 넓히세요.`,
          );
        }
      }
    }
    return cur;
  }

  /**
   * assertAffordable — [B4 수정] 매수 주문이 "매수 가능 금액"을 넘지 않는지 실제로 막는다.
   *
   * [왜 필요했나?] 사전검증 함수(preflightBuyCheck)는 있었지만 주문 버튼이 부르지 않아
   *   무용지물이었다(pre-flight에서 발견). 돈이 모자란 주문은 토스가 거부하는데, 그 전에
   *   우리가 먼저 한국어로 막아야 사용자가 원인을 안다.
   *
   * [연습 모드는 건너뜀] 가짜 서버의 잔고는 의미가 없으므로 실서버에서만 검사한다.
   */
  private async assertAffordable(price: number, quantity: number): Promise<void> {
    if (this.mode !== "live") return;
    const need = price * quantity;
    let available: number;
    try {
      const bp = await getBuyingPower("USD");
      available = bp.buyingPowerUsd;
      this.buyingPowerUsd = available; // 화면 표시용 캐시도 갱신
    } catch {
      // 잔고 조회 자체가 실패하면 "확인 불가"이므로 안전하게 막는다.
      throw new Error("매수 가능 금액을 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
    }
    if (!Number.isFinite(available)) {
      throw new Error("매수 가능 금액을 확인하지 못했습니다(응답 이상). 잠시 후 다시 시도하세요.");
    }
    if (need > available) {
      throw new Error(
        `주문 금액이 매수 가능 금액을 초과합니다.\n` +
          `· 필요: $${need.toFixed(2)} (${price} × ${quantity}주)\n` +
          `· 가능: $${available.toFixed(2)}\n` +
          `수량을 줄이거나 예수금을 확인하세요.`,
      );
    }
  }

  /**
   * 이 주문이 실제로 나가도 되는가?
   *
   * [해금 구조 — v0.2.5]
   *   예전엔 "실서버 모드면 무조건 드라이런"이라 코드를 다시 빌드해야만 실주문이 가능했다.
   *   이제는 사용자가 설정 탭에서 "실주문 활성화"를 명시적으로 켰을 때만(liveOrdersEnabled)
   *   실주문이 나간다. 기본값은 꺼짐(잠금)이라, 실수로 돈이 나갈 일은 없다.
   *   - 연습 모드: 항상 실제 왕복(가짜 서버라 돈과 무관)
   *   - 실서버 모드 + 토글 OFF: 드라이런(모의 기록만)  ← 기본
   *   - 실서버 모드 + 토글 ON : 진짜 주문 전송
   */
  private isDryRun(): boolean {
    if (this.mode !== "live") return false; // 연습 모드는 가짜 서버라 실제 왕복
    return !this.liveOrdersEnabled; // 실서버는 토글을 켠 경우에만 실주문
  }

  /** ① 진입: 일반 지정가 매수 */
  async placeEntry(spec: { symbol: string; price: number; quantity: number }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    await this.orderGate(symbol, [spec.price]);
    // [B4] 매수 가능 금액 초과면 여기서 막는다(실서버에서만 검사).
    await this.assertAffordable(spec.price, spec.quantity);

    if (this.isDryRun()) {
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 진입 지정가 매수 ${symbol} $${spec.price} × ${spec.quantity}주 (실주문 잠금 — 실제 전송 안 함)`,
        detail: spec,
      });
    }
    const o = await createOrder({
      symbol,
      side: "BUY",
      orderType: "LIMIT",
      price: spec.price,
      quantity: spec.quantity,
      clientOrderId: makeClientOrderId(`tool${DateTime.now().toFormat("HHmmss")}`, 1, "entry"),
    });
    return this.addJournal({
      kind: "entry",
      symbol,
      summary: `진입 지정가 매수 접수 ${symbol} $${spec.price} × ${spec.quantity}주 (주문번호 ${o.tossOrderId}, 상태 ${o.status})`,
      detail: o,
    });
  }

  /** ② 익절+손절 동시(OCO): 보유 중일 때. 토스 서버가 감시 — 앱 꺼도 작동. */
  async placeOco(spec: {
    symbol: string;
    quantity: number;
    tpTrigger: number; // 익절 감시가(현재가보다 위)
    tpPrice: number; //   익절 지정가
    slTrigger: number; // 손절 감시가(현재가보다 아래)
    slPrice: number; //   손절 지정가(감시가보다 살짝 아래 = 즉시 체결 노림)
    expireDate: string; // YYYY-MM-DD
  }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    const cur = await this.orderGate(symbol); // 익절/손절 감시가는 ±검사 대신 아래 OCO 규칙으로 검증
    // 스펙 규칙 사전 검증(서버 400 전에 친절한 한국어로)
    if (!(spec.tpTrigger > cur && cur > spec.slTrigger)) {
      throw new Error(`OCO 규칙: 익절 감시가($${spec.tpTrigger}) > 현재가($${cur}) > 손절 감시가($${spec.slTrigger}) 여야 합니다.`);
    }

    if (this.isDryRun()) {
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] OCO 등록 ${symbol} ${spec.quantity}주: 익절 $${spec.tpTrigger}↑ / 손절 $${spec.slTrigger}↓ (실주문 잠금)`,
        detail: spec,
      });
    }
    const c = await createConditionalOrder({
      symbol,
      type: "OCO",
      quantity: spec.quantity,
      orderType: "LIMIT",
      expireDate: spec.expireDate,
      first: { orderSide: "SELL", triggerPrice: spec.tpTrigger, orderPrice: spec.tpPrice },
      second: { orderSide: "SELL", triggerPrice: spec.slTrigger, orderPrice: spec.slPrice },
      // [B5] 멱등키: 네트워크 재시도로 조건주문이 두 번 등록되는 걸 막는다(진입 주문과 동일 원칙).
      clientOrderId: makeClientOrderId(`oco${DateTime.now().toFormat("HHmmss")}`, 1, "oco"),
    });
    return this.addJournal({
      kind: "oco",
      symbol,
      summary: `OCO 등록 완료 ${symbol} ${spec.quantity}주: 익절 $${spec.tpTrigger} / 손절 $${spec.slTrigger} (번호 ${c.conditionalOrderId}) — 토스 서버가 감시, 앱 꺼도 작동`,
      detail: c,
    });
  }

  // [OTO 제거됨] 진입→익절만 걸리고 손절이 안 걸려 반쪽짜리라 위험(오너 판단).
  //   남은 주문 수단: ① 진입 지정가  ② 조건주문(OCO: 익절+손절 동시) 두 가지.

  // --------------------------------------------------------------------------
  // 주문 현황(조회·취소) — 조회는 드라이런과 무관하게 실서버에서도 안전(읽기)
  // --------------------------------------------------------------------------
  async openOrders(): Promise<OrderResponse[]> {
    await this.prepareBackend();
    this.assertAccountReady(); // 계좌 API라 계좌 헤더 필요 → 미설정이면 친절한 안내
    const r = await listOrders({ status: "OPEN" });
    return r.orders;
  }

  async conditionals(): Promise<ConditionalOrderResponse[]> {
    await this.prepareBackend();
    this.assertAccountReady();
    return listConditionalOrders("OPEN"); // status 필수(실스펙). 진행 중 조건주문만.
  }

  async cancelNormalOrder(orderId: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    await this.prepareBackend(); // 접속 상태(주소/모드) 단일 진실 소스 유지
    if (isOrderFrozen(DateTime.now())) throw new Error("마감 1분 전 취소 불가 구간입니다(토스 제약).");
    if (this.isDryRun()) {
      return this.addJournal({ kind: "dryrun", symbol: "-", summary: `[드라이런] 주문 취소 ${orderId} (실제 전송 안 함)` });
    }
    const o = await cancelOrder(orderId);
    return this.addJournal({ kind: "cancel", symbol: o.symbol ?? "-", summary: `주문 취소 ${orderId} → ${o.status}` });
  }

  async cancelConditional(id: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    await this.prepareBackend(); // 접속 상태 단일 진실 소스 유지
    if (this.isDryRun()) {
      return this.addJournal({ kind: "dryrun", symbol: "-", summary: `[드라이런] 조건주문 취소 ${id} (실제 전송 안 함)` });
    }
    await cancelConditionalOrder(id);
    return this.addJournal({ kind: "cancel", symbol: "-", summary: `조건주문 취소 ${id}` });
  }

  // --------------------------------------------------------------------------
  // 상태·저널
  // --------------------------------------------------------------------------
  getStatus(): ToolStatus {
    const now = DateTime.now().setZone("Asia/Seoul");
    return {
      mode: this.mode,
      dryRun: this.isDryRun(),
      liveOrdersEnabled: this.liveOrdersEnabled,
      skipOrderConfirm: this.skipOrderConfirm,
      killSwitch: this.killSwitch,
      session: getSession(now),
      orderFrozen: isOrderFrozen(now),
      clockNote: `${now.toFormat("MM-dd HH:mm")} KST`,
      fxRate: this.fxCache?.rate ?? null,
      fxSource: this.fxCache?.source ?? null,
      buyingPowerUsd: this.buyingPowerUsd,
    };
  }

  getJournal(): JournalEntry[] {
    return this.journal.slice(-100); // 최근 100건만 화면으로
  }

  private loadJournal(): void {
    try {
      this.journal = existsSync(this.journalPath) ? (JSON.parse(readFileSync(this.journalPath, "utf8")) as JournalEntry[]) : [];
    } catch {
      this.journal = [];
    }
  }

  private addJournal(e: Omit<JournalEntry, "ts">): JournalEntry {
    const entry: JournalEntry = { ts: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"), ...e };
    this.journal.push(entry);
    if (this.journal.length > 1000) this.journal.shift();
    // 원자적 저장(임시 파일 → 교체): 쓰다 만 파일 방지
    const tmp = this.journalPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.journal, null, 2), "utf8");
    renameSync(tmp, this.journalPath);
    this.emit("journal", entry);
    return entry;
  }
}
