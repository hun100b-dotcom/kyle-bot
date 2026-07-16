// =============================================================================
// scripts/demo.ts  —  카일봇 "지금 상태" 데모 (키 없이 목 서버로 실행)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   실제 토스·실계좌 없이(키 미정), 지금까지 만든 봇이 어떻게 도는지 눈으로 보는
//   최소 데모입니다. 가짜 토스 서버를 내 PC에 띄우고, 워커(심장 박동)가 거기에 붙어
//   "세션 확인 → 시세 폴링 → 진입 → 체결 → 익절 청산"까지 한 판을 돌립니다.
//
// [실행 방법] 터미널에서:  npm run demo
//   (내부에서 TOSS_MOCK=true 로 가짜 서버를 쓰므로, 진짜 키가 없어도 돌아갑니다.)
//
// [왜 .exe 더블클릭이 아닌가?]
//   더블클릭 실행파일(.exe)로 만드는 건 S5 Electron 패키징 단계입니다(아직 안 함).
//   지금은 개발자 방식(터미널 명령)으로 도는 상태입니다.
// =============================================================================

import { DateTime } from "luxon";
import { createMockTossServer } from "../mocks/toss-mock";
import { createOrder, getOrder, cancelOrder, getPrice, getBuyingPower } from "../lib/toss";
import { getSession } from "../lib/session";
import {
  createSession,
  armSession,
  advanceSession,
  type Store,
  type SessionRuntime,
  type OrderRecord,
  type TradeLogRecord,
  type LifecycleDeps,
} from "../lib/lifecycle";
import { runOneTick, type WorkerDeps } from "../lib/worker";
import type { RiskState } from "../lib/risk";

// 화면 구분선/제목 헬퍼(보기 좋게).
const line = () => console.log("─".repeat(60));
const title = (s: string) => {
  line();
  console.log(`■ ${s}`);
  line();
};

// -----------------------------------------------------------------------------
// 아주 단순한 인메모리 DB(데모용). 실제 Supabase 연결은 다음 단계(Store 구현).
// -----------------------------------------------------------------------------
class InMemoryStore implements Store {
  orders: OrderRecord[] = [];
  tradeLogs: TradeLogRecord[] = [];
  private risk = new Map<string, RiskState>();

  async saveSession(_rt: SessionRuntime) {}
  async saveOrder(o: OrderRecord) {
    this.orders.push(o);
  }
  async appendTradeLog(l: TradeLogRecord) {
    this.tradeLogs.push(l);
  }
  async getRiskState(d: string): Promise<RiskState> {
    if (!this.risk.has(d)) {
      this.risk.set(d, {
        trade_date: d,
        realized_pnl_pct: 0,
        order_count: 0,
        consecutive_losses: 0,
        halted: false,
        halt_reason: null,
      });
    }
    return this.risk.get(d)!;
  }
  async updateRiskState(d: string, apply: (s: RiskState) => RiskState) {
    this.risk.set(d, apply(await this.getRiskState(d)));
  }
}

async function main() {
  title("카일봇 데모 시작 (키 없이 가짜 토스 서버로 실행)");

  // 1) 가짜 토스 서버를 실제 포트로 띄운다.
  const mock = createMockTossServer();
  const port = await mock.listen();
  process.env.TOSS_MOCK = "true";
  process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TOSS_ACCOUNT = "demo-account";
  console.log(`가짜 토스 서버가 http://127.0.0.1:${port} 에서 켜졌습니다.`);
  console.log("초기 현재가: AAPL = $2.05");

  // 2) 실행 의존성 묶기(가짜 토스 + 인메모리 DB + 한국어 로그).
  const store = new InMemoryStore();
  const lifecycleDeps: LifecycleDeps = {
    toss: { createOrder, getOrder, cancelOrder, getPrice, getBuyingPower },
    store,
    riskConfig: { dryRun: false }, // 데모에서는 실주문 흐름을 보여주려 실거래 모드(가짜 서버라 안전)
    killSwitch: () => false,
    log: (msg) => console.log("   " + msg), // lifecycle 내부 로그를 콘솔로
    tradeDateOf: (now) => now.setZone("Asia/Seoul").toFormat("yyyy-MM-dd"),
  };

  // 3) 매매 세션 하나 만들기: AAPL, 진입 2.11 / 익절 2.15 / 손절 1.89, 10주.
  const rt = createSession("demo-sess-0001", "AAPL", "candle", [
    { level: 1, entryPrice: 2.11, tpPrice: 2.15, slPrice: 1.89, quantity: 10 },
  ]);

  // 데모는 "데이마켓 시간"으로 고정해 전체 흐름을 보여줍니다(실제 지금 시각은 아래에 참고로 출력).
  const now = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 10, minute: 0 }, { zone: "Asia/Seoul" });
  const realNow = DateTime.now().setZone("Asia/Seoul");
  console.log(`\n(참고) 실제 지금 시각 기준 세션: '${getSession(realNow)}'`);
  console.log(`(데모) 아래는 데이마켓 시각(2026-07-16 10:00 KST)으로 진행합니다.`);

  // 4) 세션 장전(armed): 진입 지정가 등록.
  title("1단계: 세션 장전 — 진입 지정가 등록");
  console.log(`지금 세션: '${getSession(now)}' / 종목 AAPL / 진입 $2.11, 익절 $2.15, 손절 $1.89`);
  await armSession(rt, lifecycleDeps, now);
  console.log(`세션 상태: ${rt.status} / 포지션 상태: ${rt.positions[0].state}`);

  // 워커 의존성: 활성 세션을 advance로 전진.
  const workerDeps: WorkerDeps = {
    getActiveSessions: () => [rt],
    advance: (session, tickNow) => advanceSession(session, lifecycleDeps, tickNow),
    log: (msg, data) => console.log("   " + msg, data ?? ""),
  };

  // 5) 워커 틱 1: 체결 감지 → 익절 등록.
  title("2단계: 워커 틱 #1 — 시세 폴링·체결 감지");
  const t1 = await runOneTick(now, workerDeps);
  console.log(`틱 결과: 세션='${t1.session}', 동작='${t1.action}', 전진=${t1.advanced}건, 오류=${t1.errors}건`);
  console.log(`포지션 상태: ${rt.positions[0].state} (진입 체결 → 익절 주문 등록됨)`);

  // 6) 가격 상승 시뮬 → 익절가 도달.
  title("3단계: 가격 상승 — AAPL $2.05 → $2.20 (익절가 $2.15 돌파)");
  mock.setPrice("AAPL", 2.2);
  console.log("현재가를 $2.20 으로 올렸습니다(시장 상승 시뮬).");

  // 7) 워커 틱 2: 익절 체결 → 청산.
  title("4단계: 워커 틱 #2 — 익절 체결·청산");
  const t2 = await runOneTick(now, workerDeps);
  console.log(`틱 결과: 세션='${t2.session}', 동작='${t2.action}', 전진=${t2.advanced}건`);
  console.log(`포지션 상태: ${rt.positions[0].state} / 청산 사유: ${rt.positions[0].exitReason}`);
  console.log(`세션 상태: ${rt.status}`);

  // 8) 결과 요약(매매일지).
  title("결과: 매매일지 (승률·손익 산출 재료)");
  for (const log of store.tradeLogs) {
    console.log(
      `종목 ${log.symbol} / 진입 $${log.entryPrice} → 청산 $${log.exitPrice} / ` +
        `손익 ${log.pnlPct.toFixed(2)}% ($${log.pnlUsd.toFixed(2)}) / 사유 ${log.exitReason}`,
    );
  }
  console.log(`\n총 주문 기록: ${store.orders.length}건, 매매일지: ${store.tradeLogs.length}건`);

  // 9) 정리.
  await mock.close();
  title("데모 종료 — 가짜 토스 서버를 껐습니다");
  console.log("이 전체가 '키 없이 목 서버로' 돈 것입니다. 실제 키를 넣으면 같은 코드가 실거래로 동작합니다.");
}

main().catch((err) => {
  console.error("데모 실행 중 오류:", err);
  process.exit(1);
});
