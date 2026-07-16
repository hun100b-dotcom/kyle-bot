// =============================================================================
// tests/risk.test.ts  —  안전장치(lib/risk.ts) 검증
// -----------------------------------------------------------------------------
// 각 안전장치가 "막아야 할 때 막고, 통과시켜야 할 때 통과"시키는지 전부 확인합니다.
// 순수 로직이라 키·네트워크 없이 100% 검증됩니다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { canPlaceOrder, killSwitchCancelTargets, type RiskState, type OrderIntent, type RiskContext } from "../lib/risk";

// 아무 문제 없는 기본 상태/주문/맥락(각 테스트에서 필요한 부분만 덮어씀).
const okState: RiskState = {
  trade_date: "2026-07-16",
  realized_pnl_pct: 0,
  order_count: 0,
  consecutive_losses: 0,
  halted: false,
  halt_reason: null,
};
const okOrder: OrderIntent = { symbol: "AAPL", side: "BUY", price: 2.11, amountUsd: 100 };
// 기본 맥락: 실거래 모드(dryRun=false)로 두어 "통과 시 LIVE"를 확인하기 쉽게.
const okCtx: RiskContext = {
  config: { dryRun: false },
  currentPrice: 2.1,
  buyingPowerUsd: 10000,
  sessionSpentUsd: 0,
  killSwitch: false,
};

describe("정상 케이스", () => {
  it("문제 없으면 통과하고 실거래(LIVE)", () => {
    const d = canPlaceOrder(okState, okOrder, okCtx);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.mode).toBe("LIVE");
  });
});

describe("드라이런(DRY_RUN)", () => {
  it("dryRun=true면 통과해도 실주문 대신 DRY_RUN(로그만)", () => {
    const d = canPlaceOrder(okState, okOrder, { ...okCtx, config: { dryRun: true } });
    expect(d.allowed).toBe(true); // 위험 게이트는 통과
    expect(d.mode).toBe("DRY_RUN"); // 하지만 실주문은 안 나감
  });

  it("설정을 안 주면 기본값 dryRun=true (안전한 기본)", () => {
    const d = canPlaceOrder(okState, okOrder, { ...okCtx, config: undefined });
    expect(d.mode).toBe("DRY_RUN");
  });
});

describe("킬 스위치", () => {
  it("ON이면 무조건 전면 차단(최우선)", () => {
    const d = canPlaceOrder(okState, okOrder, { ...okCtx, killSwitch: true });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("KILL_SWITCH");
    expect(d.mode).toBe("BLOCKED");
  });

  it("killSwitchCancelTargets는 살아있는 미체결 주문만 취소 대상으로 뽑는다", () => {
    const open = [
      { tossOrderId: "T1", status: "submitted" },
      { tossOrderId: "T2", status: "partial" },
      { tossOrderId: "T3", status: "filled" }, // 이미 체결 → 대상 아님
      { tossOrderId: "T4", status: "cancelled" }, // 이미 취소 → 대상 아님
    ];
    expect(killSwitchCancelTargets(open)).toEqual(["T1", "T2"]);
  });
});

describe("이미 정지 상태(halted)", () => {
  it("halted=true면 차단", () => {
    const d = canPlaceOrder({ ...okState, halted: true }, okOrder, okCtx);
    expect(d.reason).toBe("HALTED");
  });
});

describe("일일 손실 한도", () => {
  it("한도(-3%) 도달하면 차단", () => {
    const d = canPlaceOrder({ ...okState, realized_pnl_pct: -3 }, okOrder, okCtx);
    expect(d.reason).toBe("DAILY_LOSS_LIMIT");
  });
  it("한도 미도달(-2.9%)이면 통과", () => {
    const d = canPlaceOrder({ ...okState, realized_pnl_pct: -2.9 }, okOrder, okCtx);
    expect(d.allowed).toBe(true);
  });
});

describe("연속 손절 컷", () => {
  it("N회(기본 3) 연속 손절이면 중단", () => {
    const d = canPlaceOrder({ ...okState, consecutive_losses: 3 }, okOrder, okCtx);
    expect(d.reason).toBe("CONSECUTIVE_LOSS_CUT");
  });
  it("N-1회(2)면 통과", () => {
    const d = canPlaceOrder({ ...okState, consecutive_losses: 2 }, okOrder, okCtx);
    expect(d.allowed).toBe(true);
  });
});

describe("일일 최대 주문 횟수", () => {
  it("상한(기본 20) 도달하면 차단", () => {
    const d = canPlaceOrder({ ...okState, order_count: 20 }, okOrder, okCtx);
    expect(d.reason).toBe("MAX_ORDERS");
  });
  it("19회면 통과", () => {
    const d = canPlaceOrder({ ...okState, order_count: 19 }, okOrder, okCtx);
    expect(d.allowed).toBe(true);
  });
});

describe("세션당 주문 금액 상한", () => {
  it("이미 쓴 금액 + 이번 주문이 상한(기본 1000) 초과면 거부", () => {
    const d = canPlaceOrder(okState, { ...okOrder, amountUsd: 200 }, { ...okCtx, sessionSpentUsd: 900 });
    expect(d.reason).toBe("ORDER_AMOUNT_LIMIT"); // 900+200=1100 > 1000
  });
  it("상한 이내면 통과", () => {
    const d = canPlaceOrder(okState, { ...okOrder, amountUsd: 100 }, { ...okCtx, sessionSpentUsd: 800 });
    expect(d.allowed).toBe(true); // 800+100=900 <= 1000
  });
});

describe("시드(매수가능금액) 초과", () => {
  it("주문 금액이 매수 가능 금액보다 크면 거부", () => {
    // 금액 상한에 먼저 걸리지 않도록 상한을 크게, 시드는 작게.
    const d = canPlaceOrder(
      okState,
      { ...okOrder, amountUsd: 500 },
      { ...okCtx, config: { dryRun: false, maxOrderAmountUsd: 100000 }, buyingPowerUsd: 100 },
    );
    expect(d.reason).toBe("SEED_EXCEEDED"); // 500 > 100
  });
});

describe("가격 이상 감지", () => {
  it("현재가 대비 ±N%(기본 5%) 넘게 벗어나면 거부(오타 방지)", () => {
    // 현재가 2.10인데 실수로 3.00 입력 → 약 42% 벗어남 → 차단
    const d = canPlaceOrder(okState, { ...okOrder, price: 3.0 }, okCtx);
    expect(d.reason).toBe("PRICE_ANOMALY");
  });
  it("편차가 허용 범위 이내면 통과", () => {
    // 현재가 2.10, 주문가 2.11 → 약 0.5% → 통과
    const d = canPlaceOrder(okState, { ...okOrder, price: 2.11 }, okCtx);
    expect(d.allowed).toBe(true);
  });
});

describe("우선순위(여러 개 동시 위반 시 가장 중대한 사유)", () => {
  it("킬스위치와 손실한도가 동시에 걸려도 킬스위치가 먼저", () => {
    const d = canPlaceOrder({ ...okState, realized_pnl_pct: -10 }, okOrder, { ...okCtx, killSwitch: true });
    expect(d.reason).toBe("KILL_SWITCH");
  });
});
