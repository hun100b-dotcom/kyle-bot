// =============================================================================
// tests/lifecycle.integration.test.ts  —  실행부 오케스트레이션 통합 리허설
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   실제 목 토스 서버 + 인메모리 DB로, "진입→체결→익절/손절/마감청산"의 전체 흐름을
//   왕복 검증합니다. 안전장치(risk)·어댑터(toss)·세션(session)·계산(calc)이 lifecycle로
//   제대로 엮이는지, 그리고 "문지기 우회 불가"가 실제로 지켜지는지 확인합니다.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { createMockTossServer } from "../mocks/toss-mock";
import { createOrder, getOrder, cancelOrder, getPrice, getBuyingPower, clearTokenCache } from "../lib/toss";
import { calcSplit3 } from "../lib/calc";
import {
  createSession,
  armSession,
  advanceSession,
  type LifecycleDeps,
  type Store,
  type SessionRuntime,
  type OrderRecord,
  type TradeLogRecord,
} from "../lib/lifecycle";
import type { RiskState } from "../lib/risk";

// -----------------------------------------------------------------------------
// 인메모리 Store(테스트용 가짜 DB). 실제 Supabase 구현은 별도(TODO).
// -----------------------------------------------------------------------------
class InMemoryStore implements Store {
  sessions = new Map<string, SessionRuntime>();
  orders: OrderRecord[] = [];
  tradeLogs: TradeLogRecord[] = [];
  riskStates = new Map<string, RiskState>();

  async saveSession(rt: SessionRuntime) {
    this.sessions.set(rt.id, rt);
  }
  async saveOrder(o: OrderRecord) {
    this.orders.push(o);
  }
  async appendTradeLog(l: TradeLogRecord) {
    this.tradeLogs.push(l);
  }
  async getRiskState(tradeDate: string): Promise<RiskState> {
    if (!this.riskStates.has(tradeDate)) {
      this.riskStates.set(tradeDate, {
        trade_date: tradeDate,
        realized_pnl_pct: 0,
        order_count: 0,
        consecutive_losses: 0,
        halted: false,
        halt_reason: null,
      });
    }
    return this.riskStates.get(tradeDate)!;
  }
  async updateRiskState(tradeDate: string, apply: (s: RiskState) => RiskState) {
    const cur = await this.getRiskState(tradeDate);
    this.riskStates.set(tradeDate, apply(cur));
  }
}

let mock: ReturnType<typeof createMockTossServer>;

/** lifecycle 의존성 묶음 만들기(store와 오버라이드 주입) */
function makeDeps(store: Store, override?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    toss: { createOrder, getOrder, cancelOrder, getPrice, getBuyingPower },
    store,
    riskConfig: { dryRun: false }, // 기본은 실거래 모드로 흐름을 보기 쉽게
    killSwitch: () => false,
    log: () => {},
    tradeDateOf: (now: DateTime) => now.setZone("Asia/Seoul").toFormat("yyyy-MM-dd"),
    ...override,
  };
}

// 데이마켓 시간대(마감 데드라인 16:45보다 한참 전)
const NOW = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 10, minute: 0 }, { zone: "Asia/Seoul" });

beforeAll(async () => {
  mock = createMockTossServer();
  const port = await mock.listen();
  process.env.TOSS_MOCK = "true";
  process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TOSS_ACCOUNT = "mock-account";
});

afterAll(async () => {
  await mock.close();
  delete process.env.TOSS_MOCK;
  delete process.env.TOSS_BASE_URL;
  delete process.env.TOSS_ACCOUNT;
});

beforeEach(() => {
  clearTokenCache();
  mock.setPrice("AAPL", 2.05); // 각 테스트는 현재가 2.05에서 시작
});

describe("① 해피패스: 진입 → 체결 → 익절 청산", () => {
  it("진입 체결 후 익절가 도달하면 익절로 청산된다", async () => {
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const rt = createSession("happy1", "AAPL", "candle", [
      { level: 1, entryPrice: 2.11, tpPrice: 2.15, slPrice: 1.89, quantity: 10 },
    ]);

    await armSession(rt, deps, NOW); // 진입 BUY 2.11 (현재가 2.05<=2.11 → 체결)
    await advanceSession(rt, deps, NOW); // 체결 감지 → entered + 익절 SELL 2.15 등록
    expect(rt.positions[0].state).toBe("entered");

    mock.setPrice("AAPL", 2.2); // 가격 상승 → 익절가 2.15 도달
    await advanceSession(rt, deps, NOW); // 익절 체결 감지 → 청산

    expect(rt.positions[0].state).toBe("closed");
    expect(rt.positions[0].exitReason).toBe("take_profit");
    expect(rt.status).toBe("closed");

    // 매매일지에 익절 1건, 손익 +.
    expect(store.tradeLogs).toHaveLength(1);
    expect(store.tradeLogs[0].exitReason).toBe("take_profit");
    expect(store.tradeLogs[0].pnlPct).toBeGreaterThan(0);
  });
});

describe("② 손절 경로", () => {
  it("현재가가 손절선 아래로 내려가면 손절 청산된다", async () => {
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const rt = createSession("sl1", "AAPL", "candle", [
      { level: 1, entryPrice: 2.11, tpPrice: 2.15, slPrice: 1.89, quantity: 10 },
    ]);

    await armSession(rt, deps, NOW); // 진입 체결
    await advanceSession(rt, deps, NOW); // entered

    mock.setPrice("AAPL", 1.85); // 손절가 1.89 아래로 급락
    await advanceSession(rt, deps, NOW); // 손절 청산

    expect(rt.positions[0].state).toBe("closed");
    expect(rt.positions[0].exitReason).toBe("stop_loss");
    expect(store.tradeLogs[0].pnlPct).toBeLessThan(0); // 손실
    // 연속 손절 카운터 +1
    const risk = await store.getRiskState("2026-07-16");
    expect(risk.consecutive_losses).toBe(1);
  });
});

describe("③ 장 종료 강제 청산", () => {
  it("마감 데드라인을 지나면 보유분을 청산한다(eod_close)", async () => {
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const rt = createSession("eod1", "AAPL", "candle", [
      { level: 1, entryPrice: 2.11, tpPrice: 2.15, slPrice: 1.89, quantity: 10 },
    ]);

    await armSession(rt, deps, NOW);
    await advanceSession(rt, deps, NOW); // entered

    // 마감 데드라인(16:45) 이후 시각으로 전진 → 강제 청산.
    const lateNow = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 16, minute: 50 }, { zone: "Asia/Seoul" });
    await advanceSession(rt, deps, lateNow);

    expect(rt.positions[0].state).toBe("closed");
    expect(rt.positions[0].exitReason).toBe("eod_close");
    expect(rt.status).toBe("closed");
  });
});

describe("④ 삼분할 3레벨 독립 동작", () => {
  it("1분할이 익절돼도 2·3분할 진입은 그대로 유지된다", async () => {
    const store = new InMemoryStore();
    // [주의] 삼분할은 현재가에서 EMA200까지 "일부러 떨어진 가격"에 3단계로 건다.
    //   그래서 3분할(1.93)은 현재가(2.05) 대비 약 5.85% 벗어나, 기본 가격이상 임계(5%)에
    //   걸린다(안전장치가 정상 작동한 것). 삼분할 세션은 임계를 전략 폭보다 넉넉히 준다.
    const deps = makeDeps(store, { riskConfig: { dryRun: false, priceDeviationPct: 15 } });

    // 계산 엔진으로 삼분할 진입/익절/손절 산출: 진입 2.11 / 2.02 / 1.93
    const { splits } = calcSplit3(2.2, 1.93, 2, 10);
    const specs = splits.map((s) => ({
      level: s.level,
      entryPrice: s.entry,
      tpPrice: s.tp,
      slPrice: s.sl,
      quantity: 10,
    }));
    const rt = createSession("split1", "AAPL", "split3", specs, { splitFillPolicy: "first_only" });

    await armSession(rt, deps, NOW);
    // 현재가 2.05: 1분할 2.11만 체결, 2분할 2.02·3분할 1.93은 미체결.
    await advanceSession(rt, deps, NOW); // 1분할 entered + 익절 등록

    mock.setPrice("AAPL", 2.2); // 1분할 익절가(2.15)만 도달, 2·3분할 진입가(2.02/1.93)엔 안 닿음
    await advanceSession(rt, deps, NOW);

    // 1분할은 익절 청산, 2·3분할은 여전히 진입 대기(독립 유지).
    expect(rt.positions[0].state).toBe("closed");
    expect(rt.positions[0].exitReason).toBe("take_profit");
    expect(rt.positions[1].state).toBe("pending_entry");
    expect(rt.positions[2].state).toBe("pending_entry");
  });
});

describe("⑤ 안전장치 우회 불가: risk BLOCKED면 실주문이 안 나간다", () => {
  it("halted 상태면 진입 주문이 아예 생성되지 않는다", async () => {
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    // 오늘 거래를 정지 상태로 만든다.
    await store.updateRiskState("2026-07-16", (s) => ({ ...s, halted: true }));

    const rt = createSession("blk1", "AAPL", "candle", [
      { level: 1, entryPrice: 2.11, tpPrice: 2.15, slPrice: 1.89, quantity: 10 },
    ]);

    await armSession(rt, deps, NOW);

    // 진입은 skipped, 어떤 주문도 안 나감(목 서버·DB 모두 이 주문 없음).
    expect(rt.positions[0].state).toBe("skipped");
    const cid = rt.positions[0].entryClientId;
    expect(mock.state.orders.has(cid)).toBe(false); // 목 서버에 주문 없음
    expect(store.orders.find((o) => o.clientOrderId === cid)).toBeUndefined(); // DB에도 없음
  });
});

describe("⑥ DRY_RUN: 실주문 대신 로그만", () => {
  it("dryRun=true면 진입 실주문이 나가지 않는다", async () => {
    const store = new InMemoryStore();
    const logs: string[] = [];
    const deps = makeDeps(store, { riskConfig: { dryRun: true }, log: (m) => logs.push(m) });

    const rt = createSession("dry1", "AAPL", "candle", [
      { level: 1, entryPrice: 2.11, tpPrice: 2.15, slPrice: 1.89, quantity: 10 },
    ]);

    await armSession(rt, deps, NOW);

    expect(rt.positions[0].state).toBe("skipped"); // 진입 안 함
    const cid = rt.positions[0].entryClientId;
    expect(mock.state.orders.has(cid)).toBe(false); // 실주문 없음
    expect(logs.some((m) => m.includes("드라이런"))).toBe(true); // 로그만 남음
  });
});
