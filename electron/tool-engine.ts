// =============================================================================
// electron/tool-engine.ts  —  카일 매매도구 엔진 (v2: 자율판단 제거, 온디맨드 전용)
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
  dryRun: boolean; //        실서버 주문 잠금 여부(이 버전은 live=항상 true)
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
  private mock: ReturnType<typeof createMockTossServer> | null = null;

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
    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    this.mode = process.env.TOSS_MOCK !== "true" && hasKeys ? "live" : "mock";
  }

  getSettings() {
    return {
      mode: this.mode,
      hasClientId: !!process.env.TOSS_CLIENT_ID,
      hasClientSecret: !!process.env.TOSS_CLIENT_SECRET,
      account: process.env.TOSS_ACCOUNT ?? "",
    };
  }

  async saveSettings(input: { mode: "mock" | "live"; clientId?: string; clientSecret?: string; account?: string }) {
    if (input.clientId) process.env.TOSS_CLIENT_ID = input.clientId.trim();
    if (input.clientSecret) process.env.TOSS_CLIENT_SECRET = input.clientSecret.trim();
    if (input.account !== undefined) process.env.TOSS_ACCOUNT = input.account.trim();

    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    const newMode = input.mode === "live" && hasKeys ? "live" : "mock";
    if (newMode !== this.mode) {
      this.mode = newMode;
      await this.stopMock(); // 모드가 바뀌면 연습 서버 상태 초기화
      this.fxCache = null;
      this.buyingPowerUsd = null;
    }
    process.env.TOSS_MOCK = this.mode === "mock" ? "true" : "false";
    if (this.mode === "live") process.env.TOSS_BASE_URL = "https://apigw.tossinvest.com";

    const lines = [
      "# 카일 매매도구 설정(자동 생성). 이 파일은 본인 컴퓨터에만 있습니다.",
      `TOSS_MOCK=${this.mode === "mock" ? "true" : "false"}`,
      `TOSS_BASE_URL=${process.env.TOSS_BASE_URL ?? ""}`,
      `TOSS_CLIENT_ID=${process.env.TOSS_CLIENT_ID ?? ""}`,
      `TOSS_CLIENT_SECRET=${process.env.TOSS_CLIENT_SECRET ?? ""}`,
      `TOSS_ACCOUNT=${process.env.TOSS_ACCOUNT ?? ""}`,
      "DRY_RUN=true", // ★ 실주문 잠금: 소액 테스트 통과 전까지 해제 불가(사용자 확정 사항)
      "",
    ].join("\n");
    writeFileSync(this.envPath, lines, "utf8");
    chmodSync(this.envPath, 0o600);
    clearTokenCache();
    this.addJournal({ kind: "info", symbol: "-", summary: `설정 저장 (모드: ${this.mode === "mock" ? "연습" : "실서버(주문 잠금)"})` });
    return this.getSettings();
  }

  /** 연습 모드일 때 가짜 토스 서버를 (필요 시점에) 켠다 — 버튼 없이 자동 준비 */
  private async ensureBackend(): Promise<void> {
    if (this.mode !== "mock" || this.mock) return;
    this.mock = createMockTossServer();
    const port = await this.mock.listen();
    process.env.TOSS_MOCK = "true";
    process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
    if (!process.env.TOSS_ACCOUNT) process.env.TOSS_ACCOUNT = "practice";
    this.addJournal({ kind: "info", symbol: "-", summary: `연습용 가짜 토스 서버 준비 (127.0.0.1:${port})` });
  }

  async stopMock(): Promise<void> {
    if (this.mock) {
      await this.mock.close();
      this.mock = null;
    }
  }

  /** 연습 모드 전용: 가짜 서버 현재가 조작(익절/손절 발동 연습) */
  async mockSetPrice(symbol: string, price: number): Promise<boolean> {
    await this.ensureBackend();
    if (!this.mock) return false;
    this.mock.setPrice(symbol.toUpperCase(), Math.round(price * 100) / 100);
    return true;
  }

  // --------------------------------------------------------------------------
  // 킬 스위치: 모든 "주문" 버튼 잠금(조회·계산은 허용)
  // --------------------------------------------------------------------------
  setKillSwitch(on: boolean): void {
    this.killSwitch = on;
    this.addJournal({ kind: "info", symbol: "-", summary: on ? "🔴 킬 스위치 ON — 주문 버튼 전체 잠금" : "🟢 킬 스위치 OFF" });
  }

  // --------------------------------------------------------------------------
  // 조회(사람이 버튼 눌렀을 때만 1회)
  // --------------------------------------------------------------------------
  async quote(symbol: string): Promise<number> {
    await this.ensureBackend();
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
      await this.ensureBackend();
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
      await this.ensureBackend();
      const bp = await getBuyingPower("USD");
      this.buyingPowerUsd = bp.buyingPowerUsd;
      return this.buyingPowerUsd;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // ★ 계산기: 카일매매기법 3종 + 수동 (설계서 M1의 검증된 함수를 그대로 호출)
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
    await this.ensureBackend();
    const { price: cur } = await getPrice(symbol.toUpperCase());
    for (const p of entryPrices) {
      const dev = Math.abs((p - cur) / cur) * 100;
      if (dev > 15) {
        throw new Error(
          `가격 이상 감지: 진입가 $${p} 는 현재가 $${cur} 대비 ${dev.toFixed(1)}% 벗어남(±15% 제한). 오타인지 확인하세요.`,
        );
      }
    }
    return cur;
  }

  /** 이 주문이 실제로 나가도 되는가? 실서버 모드는 무조건 드라이런(잠금). */
  private isDryRun(): boolean {
    return this.mode === "live"; // 연습 모드(가짜 서버)만 실제 API 왕복(돈과 무관)
  }

  /** ① 진입: 일반 지정가 매수 */
  async placeEntry(spec: { symbol: string; price: number; quantity: number }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    await this.orderGate(symbol, [spec.price]);

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
    });
    return this.addJournal({
      kind: "oco",
      symbol,
      summary: `OCO 등록 완료 ${symbol} ${spec.quantity}주: 익절 $${spec.tpTrigger} / 손절 $${spec.slTrigger} (번호 ${c.conditionalOrderId}) — 토스 서버가 감시, 앱 꺼도 작동`,
      detail: c,
    });
  }

  /** ③ 진입+익절 원스톱(OTO): 진입(BUY) 체결되면 익절(SELL) 감시 시작. */
  async placeOto(spec: {
    symbol: string;
    quantity: number;
    entryTrigger: number;
    entryPrice: number;
    exitTrigger: number;
    exitPrice: number;
    expireDate: string;
  }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    await this.orderGate(symbol, [spec.entryTrigger]); // 진입 감시가만 오타 검사(익절은 기법상 먼 값)

    if (this.isDryRun()) {
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] OTO 등록 ${symbol} ${spec.quantity}주: 진입 $${spec.entryTrigger} → 체결 후 익절 $${spec.exitTrigger} 감시 (실주문 잠금)`,
        detail: spec,
      });
    }
    const c = await createConditionalOrder({
      symbol,
      type: "OTO",
      quantity: spec.quantity,
      orderType: "LIMIT",
      expireDate: spec.expireDate,
      first: { orderSide: "BUY", triggerPrice: spec.entryTrigger, orderPrice: spec.entryPrice },
      second: { orderSide: "SELL", triggerPrice: spec.exitTrigger, orderPrice: spec.exitPrice },
    });
    return this.addJournal({
      kind: "oto",
      symbol,
      summary: `OTO 등록 완료 ${symbol} ${spec.quantity}주: 진입 $${spec.entryTrigger} → 익절 $${spec.exitTrigger} (번호 ${c.conditionalOrderId})`,
      detail: c,
    });
  }

  // --------------------------------------------------------------------------
  // 주문 현황(조회·취소) — 조회는 드라이런과 무관하게 실서버에서도 안전(읽기)
  // --------------------------------------------------------------------------
  async openOrders(): Promise<OrderResponse[]> {
    await this.ensureBackend();
    const r = await listOrders({ status: "OPEN" });
    return r.orders;
  }

  async conditionals(): Promise<ConditionalOrderResponse[]> {
    await this.ensureBackend();
    return listConditionalOrders();
  }

  async cancelNormalOrder(orderId: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    if (isOrderFrozen(DateTime.now())) throw new Error("마감 1분 전 취소 불가 구간입니다(토스 제약).");
    if (this.isDryRun()) {
      return this.addJournal({ kind: "dryrun", symbol: "-", summary: `[드라이런] 주문 취소 ${orderId} (실제 전송 안 함)` });
    }
    const o = await cancelOrder(orderId);
    return this.addJournal({ kind: "cancel", symbol: o.symbol ?? "-", summary: `주문 취소 ${orderId} → ${o.status}` });
  }

  async cancelConditional(id: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
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
      dryRun: this.mode === "live", // 실서버 = 주문 잠금(모의 기록만). 연습 = 가짜 서버라 실제 왕복.
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
