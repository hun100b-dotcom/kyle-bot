// =============================================================================
// electron/bot-engine.ts  —  봇 엔진 (데스크톱 앱 안에서 카일봇을 실제로 돌리는 심장)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   지금까지 만든 부품 — 세션 판정(session)·안전장치(risk)·토스 어댑터(toss)·
//   실행부(lifecycle)·워커 루프(worker) — 를 데스크톱 앱 안에서 하나로 엮는 층입니다.
//   Electron 메인 프로세스(= 앱의 백그라운드, Node 환경)에서 이 엔진이 돌고,
//   화면(React)은 IPC(프로세스 간 통신)로 이 엔진의 상태를 읽어 표시만 합니다.
//
// [두 가지 모드]
//   - 연습 모드(mock): 앱 안에서 "가짜 토스 서버"를 켜고 거기에 붙는다.
//       실제 돈·실제 계좌와 완전히 무관. 키도 필요 없음. 처음 설치하면 이 모드.
//   - 실서버 모드(live): .env(앱 데이터 폴더)의 토스 키로 실제 서버에 붙는다.
//       단, 이 버전에서는 DRY_RUN(드라이런)이 강제 true 라서 "읽기 + 주문 로그"만 하고
//       실주문은 코드 경로상 절대 나가지 않는다(아래 참고).
//
// [★ 안전 최우선: 이 버전은 실주문이 불가능하게 잠갔다]
//   progress.md 남은 일 1번 — "주문 생성 요청바디 필수필드(timeInForce 등) 확정"이
//   아직 안 끝났습니다. 스펙이 덜 확정된 채 실주문을 켜면 실계좌가 위험하므로,
//   설계서 원칙(키도착→읽기전용→드라이런→소액)에 따라 이 앱 v0.1은
//   riskConfig.dryRun 을 코드에서 true 로 고정했습니다. 설정 파일을 바꿔도 안 풀립니다.
//   실주문 해금은 "주문 스펙 확정 + 소액 검증" 단계에서 별도 릴리스로 진행합니다.
//
// [시크릿(토스 키) 취급]
//   - 키는 앱 데이터 폴더의 .env 파일에만 둡니다(파일 권한 600 = 본인만 읽기).
//   - 로그·화면·저장 데이터 어디에도 키 값을 남기지 않습니다.
// =============================================================================

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
import { getSession, getDayMarketOpen, getCloseDeadline, type Session } from "../lib/session";
import { roundPrice } from "../lib/calc";
import {
  createSession,
  armSession,
  advanceSession,
  type LifecycleDeps,
  type SessionRuntime,
} from "../lib/lifecycle";
import { runOneTick } from "../lib/worker";
import { getPrice, getBuyingPower, getOrder, cancelOrder, createOrder, clearTokenCache } from "../lib/toss";
import { createMockTossServer } from "../mocks/toss-mock";
import { FileStore } from "./file-store";

// -----------------------------------------------------------------------------
// 1) 설정 (.env) 읽기/쓰기 — 앱 데이터 폴더 기준
// -----------------------------------------------------------------------------

/** 화면 설정 창과 주고받는 설정 모양(시크릿 값 자체는 마스킹해서 내보냄) */
export interface BotSettings {
  mode: "mock" | "live"; // 연습(가짜 서버) / 실서버(읽기+드라이런)
  hasClientId: boolean; //  키가 저장돼 있는지 여부만 알려줌(값은 절대 안 내보냄)
  hasClientSecret: boolean;
  account: string; //       계좌 번호(accountSeq)는 시크릿이 아니라 표시함
  tickSeconds: number; //   워커가 깨어나는 간격(초)
}

/** .env 텍스트를 { KEY: value } 로 파싱 */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// -----------------------------------------------------------------------------
// 2) 엔진 본체
// -----------------------------------------------------------------------------

/** 화면(대시보드)에 보내는 상태 스냅샷 */
export interface BotStatus {
  running: boolean; //          워커 루프가 돌고 있는가
  mode: "mock" | "live"; //     연습/실서버
  dryRun: true; //              이 버전은 항상 true(실주문 잠금)
  killSwitch: boolean; //       킬 스위치(비상정지) 상태
  session: Session; //          지금 장 세션(day/pre/regular/after/closed)
  clockNote: string; //         화면에 보여줄 시각 설명(연습 모드는 가상 시각)
  nextDayOpen: string; //       다음 데이마켓 개장(KST)
  closeDeadline: string; //     청산 데드라인(KST)
  sessions: SessionRuntime[]; //  진행 중/완료 세션들(런타임)
  tradeLogs: unknown[]; //      매매일지(파일 저장소 누적)
  riskState: unknown | null; // 오늘의 리스크 상태
  buyingPowerUsd: number | null; // 매수 가능 금액(최근 조회값)
  lastTickAt: string | null; // 마지막 틱 시각
  tickSeconds: number;
}

export class BotEngine extends EventEmitter {
  private userDataDir: string;
  private envPath: string;
  private store: FileStore;

  private mode: "mock" | "live" = "mock";
  private tickSeconds = 5;
  private killSwitch = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 앱이 관리하는 세션들(봇의 작업 목록). 껐다 켜면 저장소 스냅샷은 남지만 진행은 초기화. */
  private sessions: SessionRuntime[] = [];

  private mock: ReturnType<typeof createMockTossServer> | null = null;
  private buyingPowerUsd: number | null = null;
  private lastTickAt: string | null = null;
  private logs: Array<{ ts: string; msg: string }> = [];

  constructor(userDataDir: string) {
    super();
    this.userDataDir = userDataDir;
    mkdirSync(userDataDir, { recursive: true });
    this.envPath = join(userDataDir, ".env");
    this.store = new FileStore(userDataDir);
    this.loadEnvIntoProcess();
  }

  // ---------------------------------------------------------------------------
  // 로그: 화면으로 실시간 전송 + 최근 500줄 보관(키 값은 애초에 로그에 안 넣음)
  // ---------------------------------------------------------------------------
  private log(msg: string): void {
    const entry = { ts: DateTime.now().setZone("Asia/Seoul").toFormat("HH:mm:ss"), msg };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift(); // 오래된 것부터 버림(메모리 보호)
    this.emit("log", entry);
  }

  getRecentLogs() {
    return this.logs;
  }

  // ---------------------------------------------------------------------------
  // .env 로드/저장 — 키는 앱 데이터 폴더에만, 권한 600
  // ---------------------------------------------------------------------------

  /** 앱 데이터 폴더의 .env 를 process.env 로 올린다(없으면 연습 모드 기본값). */
  private loadEnvIntoProcess(): void {
    if (existsSync(this.envPath)) {
      const env = parseEnv(readFileSync(this.envPath, "utf8"));
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
    }
    // 키가 둘 다 있어야 실서버 모드가 가능. 아니면 연습 모드로 강제.
    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    this.mode = process.env.TOSS_MOCK !== "true" && hasKeys ? "live" : "mock";
  }

  /** 설정 화면에 보여줄 값(키 값 자체는 절대 내보내지 않고 유무만) */
  getSettings(): BotSettings {
    return {
      mode: this.mode,
      hasClientId: !!process.env.TOSS_CLIENT_ID,
      hasClientSecret: !!process.env.TOSS_CLIENT_SECRET,
      account: process.env.TOSS_ACCOUNT ?? "",
      tickSeconds: this.tickSeconds,
    };
  }

  /**
   * 설정 저장. 키는 "새로 입력했을 때만" 갈아끼운다(빈 칸이면 기존 값 유지).
   * 저장 후 파일 권한을 600(본인만 읽기)으로 조인다.
   */
  saveSettings(input: { mode: "mock" | "live"; clientId?: string; clientSecret?: string; account?: string; tickSeconds?: number }): BotSettings {
    if (input.clientId) process.env.TOSS_CLIENT_ID = input.clientId.trim();
    if (input.clientSecret) process.env.TOSS_CLIENT_SECRET = input.clientSecret.trim();
    if (input.account !== undefined) process.env.TOSS_ACCOUNT = input.account.trim();
    if (input.tickSeconds && input.tickSeconds >= 2) this.tickSeconds = Math.floor(input.tickSeconds);

    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    this.mode = input.mode === "live" && hasKeys ? "live" : "mock";
    process.env.TOSS_MOCK = this.mode === "mock" ? "true" : "false";
    if (this.mode === "live") process.env.TOSS_BASE_URL = process.env.TOSS_LIVE_BASE_URL ?? "https://apigw.tossinvest.com";

    // 파일로 저장(다음 실행에도 유지). DRY_RUN 은 항상 true 로 쓴다(실주문 잠금).
    const lines = [
      "# 카일봇 앱 설정(자동 생성). 이 파일은 본인 컴퓨터에만 있습니다.",
      `TOSS_MOCK=${this.mode === "mock" ? "true" : "false"}`,
      `TOSS_BASE_URL=${process.env.TOSS_BASE_URL ?? ""}`,
      `TOSS_CLIENT_ID=${process.env.TOSS_CLIENT_ID ?? ""}`,
      `TOSS_CLIENT_SECRET=${process.env.TOSS_CLIENT_SECRET ?? ""}`,
      `TOSS_ACCOUNT=${process.env.TOSS_ACCOUNT ?? ""}`,
      "DRY_RUN=true",
      "",
    ].join("\n");
    writeFileSync(this.envPath, lines, "utf8");
    chmodSync(this.envPath, 0o600); // 본인 계정만 읽고 쓸 수 있게(보안)

    clearTokenCache(); // 키가 바뀌었을 수 있으니 기존 토큰 캐시 폐기
    this.log(`설정 저장됨 (모드: ${this.mode === "mock" ? "연습(가짜 서버)" : "실서버(드라이런)"})`);
    this.emitStatus();
    return this.getSettings();
  }

  // ---------------------------------------------------------------------------
  // "지금 시각" 공급자 — 연습 모드는 데이마켓 한복판의 가상 시각을 쓴다
  // ---------------------------------------------------------------------------
  // [왜?] 데이마켓(밤 시간대)이 아닐 때 앱을 켜면 워커가 "장이 아니라 쉼(idle)"만
  //   반복해서, 처음 써 보는 사람이 아무것도 볼 수 없습니다. 연습 모드에서는
  //   demo.ts 와 같은 방식으로 "2026-07-16(목) 10:00 KST = 데이마켓"으로 시각을
  //   고정해, 언제 켜도 진입→체결→익절 흐름을 눈으로 볼 수 있게 했습니다.
  //   실서버 모드는 당연히 진짜 현재 시각을 씁니다.
  private now(): DateTime {
    if (this.mode === "mock") {
      return DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 10, minute: 0 }, { zone: "Asia/Seoul" });
    }
    return DateTime.now().setZone("Asia/Seoul");
  }

  // ---------------------------------------------------------------------------
  // lifecycle 의존성 묶음(실행부가 쓰는 도구 상자)
  // ---------------------------------------------------------------------------
  private lifecycleDeps(): LifecycleDeps {
    return {
      toss: { createOrder, getOrder, cancelOrder, getPrice, getBuyingPower },
      store: this.store,
      // ★ 실주문 잠금: 이 버전은 무조건 드라이런. (연습 모드의 가짜 서버만 예외적으로
      //   실주문 흐름을 보여준다 — 가짜 서버라 실제 돈과 무관하기 때문)
      riskConfig: { dryRun: this.mode !== "mock" },
      killSwitch: () => this.killSwitch,
      log: (msg) => this.log(msg),
      tradeDateOf: (now) => now.setZone("Asia/Seoul").toFormat("yyyy-MM-dd"),
    };
  }

  // ---------------------------------------------------------------------------
  // 봇 켜기/끄기 (워커 루프)
  // ---------------------------------------------------------------------------

  /** 봇 시작: 연습 모드면 가짜 토스 서버부터 켠 뒤, 틱 루프를 돌린다. */
  async start(): Promise<void> {
    if (this.running) return;

    if (this.mode === "mock") {
      // 가짜 토스 서버를 앱 안에서 켠다(실제 네트워크로 안 나감, 내 컴퓨터 안에서만).
      this.mock = createMockTossServer();
      const port = await this.mock.listen();
      process.env.TOSS_MOCK = "true";
      process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
      if (!process.env.TOSS_ACCOUNT) process.env.TOSS_ACCOUNT = "practice-account";
      this.log(`연습용 가짜 토스 서버 시작 (127.0.0.1:${port}) — 실제 돈과 무관합니다`);
    } else {
      this.log("실서버 모드 시작 — 읽기 + 드라이런(실주문은 코드에서 차단됨)");
    }

    // 워커 루프: tickSeconds 마다 runOneTick. startWorker 대신 자체 setInterval 을
    // 쓰는 이유는 연습 모드의 "가상 시각"을 주입해야 하기 때문(worker.ts 는 실제 시각 고정).
    const workerDeps = {
      getActiveSessions: () => this.sessions,
      advance: (rt: SessionRuntime, now: DateTime) => advanceSession(rt, this.lifecycleDeps(), now),
      log: (msg: string, data?: unknown) => this.log(`${msg} ${data ? JSON.stringify(data) : ""}`),
    };
    this.timer = setInterval(async () => {
      try {
        const r = await runOneTick(this.now(), workerDeps);
        this.lastTickAt = DateTime.now().setZone("Asia/Seoul").toFormat("HH:mm:ss");
        if (r.action === "advanced") this.log(`틱: 세션 ${r.advanced}건 전진${r.errors ? `, 오류 ${r.errors}건` : ""}`);
        this.emitStatus();
      } catch (err) {
        this.log(`틱 오류(루프는 계속): ${String(err)}`);
      }
    }, this.tickSeconds * 1000);

    this.running = true;
    this.log(`봇 시작 — ${this.tickSeconds}초마다 시장을 확인합니다`);
    this.emitStatus();
  }

  /** 봇 정지: 루프를 멈추고, 연습 모드면 가짜 서버도 끈다. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    if (this.mock) {
      await this.mock.close();
      this.mock = null;
    }
    this.log("봇 정지");
    this.emitStatus();
  }

  /** 킬 스위치(비상정지): 켜면 신규 진입이 안전장치 게이트에서 전부 차단된다. */
  setKillSwitch(on: boolean): void {
    this.killSwitch = on;
    this.log(on ? "🔴 킬 스위치 ON — 신규 진입 전면 차단" : "🟢 킬 스위치 OFF — 정상 운전");
    this.emitStatus();
  }

  // ---------------------------------------------------------------------------
  // 세션 만들기 (화면의 "새 매매 계획" 폼에서 호출)
  // ---------------------------------------------------------------------------

  /**
   * 현재가를 조회해 "진입 -0.5% / 익절 +2% / 손절 -10%" 기본 계획을 계산해 돌려준다.
   * (설계서의 캔들 기법 기본 비율. 화면에서 사용자가 수치를 고쳐서 확정할 수 있음)
   */
  async planFromQuote(symbol: string): Promise<{ symbol: string; price: number; entry: number; tp: number; sl: number }> {
    const { price } = await getPrice(symbol);
    const entry = roundPrice(price * 0.995);
    return { symbol, price, entry, tp: roundPrice(entry * 1.02), sl: roundPrice(entry * 0.9) };
  }

  /** 세션을 만들고 즉시 장전(armed)한다. 진입은 안전장치 게이트를 반드시 통과. */
  async createAndArmSession(spec: { symbol: string; entry: number; tp: number; sl: number; quantity: number }): Promise<void> {
    const id = `sess-${DateTime.now().toFormat("yyyyMMdd-HHmmss")}`;
    const rt = createSession(id, spec.symbol.toUpperCase(), "candle", [
      { level: 1, entryPrice: spec.entry, tpPrice: spec.tp, slPrice: spec.sl, quantity: spec.quantity },
    ]);
    this.sessions.push(rt);
    this.log(`세션 생성: ${rt.symbol} 진입 $${spec.entry} / 익절 $${spec.tp} / 손절 $${spec.sl} / ${spec.quantity}주`);
    await armSession(rt, this.lifecycleDeps(), this.now());
    this.emitStatus();
  }

  /** 연습 모드 전용: 가짜 서버의 현재가를 바꿔 시장 상승/하락을 시뮬레이션한다. */
  mockSetPrice(symbol: string, price: number): boolean {
    if (!this.mock) return false;
    // 부동소수점 꼬리(예: 2.1734999999…) 방지: 센트 단위로 반올림해서 쓴다.
    const clean = Math.round(price * 100) / 100;
    this.mock.setPrice(symbol.toUpperCase(), clean);
    this.log(`(연습) ${symbol.toUpperCase()} 현재가를 $${clean} 로 변경`);
    return true;
  }

  /** 잔고(매수가능 금액) 새로고침 — 버튼 눌렀을 때만 호출(불필요한 API 호출 최소화) */
  async refreshBuyingPower(): Promise<number | null> {
    try {
      const bp = await getBuyingPower("USD");
      this.buyingPowerUsd = bp.buyingPowerUsd;
      this.emitStatus();
      return this.buyingPowerUsd;
    } catch (err) {
      this.log(`잔고 조회 실패: ${String(err)}`);
      return null;
    }
  }

  /** 시세 조회(화면 시세 확인 버튼) */
  async quote(symbol: string): Promise<number> {
    const { price } = await getPrice(symbol.toUpperCase());
    return price;
  }

  // ---------------------------------------------------------------------------
  // 상태 스냅샷 (화면이 주기적으로 읽어 감)
  // ---------------------------------------------------------------------------

  getStatus(): BotStatus {
    const now = this.now();
    const realNow = DateTime.now().setZone("Asia/Seoul");
    return {
      running: this.running,
      mode: this.mode,
      dryRun: true, // 이 버전은 실주문 잠금(표시용으로도 항상 true)
      killSwitch: this.killSwitch,
      session: getSession(now),
      clockNote:
        this.mode === "mock"
          ? `연습 모드 가상 시각 ${now.toFormat("MM-dd HH:mm")} KST (실제 ${realNow.toFormat("HH:mm")})`
          : `현재 ${realNow.toFormat("MM-dd HH:mm")} KST`,
      nextDayOpen: getDayMarketOpen(now).toFormat("HH:mm"),
      closeDeadline: getCloseDeadline(now).toFormat("HH:mm"),
      sessions: this.sessions.map((s) => structuredClone(s)),
      tradeLogs: this.store.getTradeLogs().slice(-50), // 최근 50건만 화면으로
      riskState: this.store.peekRiskState(now.toFormat("yyyy-MM-dd")) ?? null,
      buyingPowerUsd: this.buyingPowerUsd,
      lastTickAt: this.lastTickAt,
      tickSeconds: this.tickSeconds,
    };
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }
}
