// =============================================================================
// tests/sync-gaps-v0101.test.ts — [v0.101.0] PR #51(v0.98.0) 병합 후 점검에서 찾은 남은 틈 3건
// -----------------------------------------------------------------------------
// ① 추가매수분이 조건주문 밖에 남으면, 익절/손절 후에도 보호 없이 계좌에 영영 방치되던 문제
//    + 손익이 "보유 수량" 기준으로 부풀려지던 문제
// ② 오너가 조건주문을 취소하고 새 가격으로 다시 거는 중인데, 가드가 3초 만에 예전 가격으로
//    먼저 걸어 버리던 경쟁(유예 시간 2분 도입)
// ③ 오너가 건 조건주문으로 추적을 복원할 때 수량(조건주문 수량)·실제 체결가를 빠뜨리던 문제
// ⚠️ 실계좌 안 건드림(forceMock — 엔진 내장 가짜 토스 서버. 가짜 계좌는 AAPL 100주를 보유).
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type AutoPosition, type AutoTradeHistoryEntry, type UnprotectedPos } from "../electron/tool-engine";

// 테스트에서만 엔진 내부를 들여다보기 위한 타입(실제 코드에서는 private)
type Internals = {
  autoUnprotected: UnprotectedPos[];
  autoTradePositions: AutoPosition[];
  autoTradeHistory: AutoTradeHistoryEntry[];
  guardTimer: ReturnType<typeof setTimeout> | null;
  resolveCompletedConditional: (pos: AutoPosition, resp: Record<string, unknown>) => Promise<void>;
  clearAutoPositionWithoutPnl: (pos: AutoPosition, s: string, n: string, graceMs?: number) => Promise<void>;
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kyle-v0101-"));
  const eng = new ToolEngine(dir, { forceMock: true });
  await eng.quote("AAPL"); // 목 서버를 먼저 깨운다
  const x = eng as unknown as Internals;
  // 가드 예약 타이머가 테스트 밖에서 저절로 돌지 않게 멈춘다(테스트가 직접 runGuard를 부른다)
  const stopTimer = () => { if (x.guardTimer) { clearTimeout(x.guardTimer); x.guardTimer = null; } };
  return { dir, eng, x, stopTimer };
}

const pos = (over: Partial<AutoPosition> = {}): AutoPosition => ({
  symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 100, enteredAtMs: Date.now() - 3600_000,
  status: "active", conditionalOrderId: "cond-1", ...over,
});
const histOf = (p: AutoPosition, over: Partial<AutoTradeHistoryEntry> = {}): AutoTradeHistoryEntry => ({
  id: `${p.symbol}@${p.entry}@${p.enteredAtMs}`, symbol: p.symbol, entry: p.entry, tp: p.tp, sl: p.sl, quantity: p.quantity,
  enteredAt: "10-18 22:00:00", status: "active", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "테스트", ...over,
});

describe("[v0.101.0 ①] 추가매수분 — 익절/손절 후 남은 수량을 놓치지 않는다", () => {
  it("추가매수를 반영해도 '조건주문이 덮는 수량'(protectedQty)은 처음 수량 그대로 기억한다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = pos({ quantity: 60 });
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      expect(await eng.auditActivePositionQuantities()).toBe(1);
      stopTimer();
      const after = x.autoTradePositions.find((q) => q.symbol === "AAPL");
      expect(after?.quantity).toBe(100); // 보유는 실계좌 기준
      expect(after?.protectedQty).toBe(60); // 보호는 원래 조건주문 수량 그대로
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("익절 후 손익은 실제로 팔린 60주로 계산하고, 남은 40주는 새 기록으로 분리해 가드에 넘긴다", async () => {
    const { dir, x, stopTimer } = await setup();
    try {
      const p = pos({ quantity: 100, protectedQty: 60 });
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      // 토스 응답 모양: 그룹이 끝났고(COMPLETED) 익절 다리(first)가 발동, 조건주문 수량 60주
      await x.resolveCompletedConditional(p, {
        conditionalOrderId: "cond-1", status: "COMPLETED", quantity: 60,
        first: { triggeredOrderId: "no-such-order" }, second: { triggeredOrderId: null },
      });
      stopTimer();
      const closed = x.autoTradeHistory.find((h) => h.id === histOf(p).id);
      expect(closed?.status).toBe("closed_win");
      expect(closed?.quantity).toBe(60);
      expect(closed?.pnlUsd).toBeCloseTo((2.5 - 2.1) * 60, 2); // 예전엔 100주로 계산돼 부풀려졌다
      // 남은 40주: 원래 기록을 덮어쓰지 않도록 다른 id의 새 기록 + 가드 대기 목록
      const rest = x.autoTradeHistory.find((h) => h.symbol === "AAPL" && h.id !== histOf(p).id);
      expect(rest?.quantity).toBe(40);
      expect(rest?.status).toBe("oco_failed");
      expect(x.autoUnprotected.map((u) => [u.symbol, u.quantity])).toEqual([["AAPL", 40]]);
      expect(x.autoTradePositions.some((q) => q === p)).toBe(false); // 원래 포지션은 정상 종료
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("추가매수가 없었으면(보호 수량 = 보유 수량) 예전과 똑같이 끝난다 — 새 기록·가드 없음", async () => {
    const { dir, x, stopTimer } = await setup();
    try {
      const p = pos({ quantity: 100 });
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      await x.resolveCompletedConditional(p, {
        conditionalOrderId: "cond-1", status: "COMPLETED", quantity: 100,
        first: { triggeredOrderId: "no-such-order" }, second: { triggeredOrderId: null },
      });
      stopTimer();
      expect(x.autoTradeHistory).toHaveLength(1);
      expect(x.autoTradeHistory[0].pnlUsd).toBeCloseTo(40, 2);
      expect(x.autoUnprotected).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("[v0.101.0 ②] 오너가 조건주문을 직접 취소했을 때 — 2분 동안은 새 주문을 내지 않고 기다린다", () => {
  it("유예 중엔 가드가 조건주문을 새로 걸지 않는다(시도 횟수도 안 셈)", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = pos();
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      await x.clearAutoPositionWithoutPnl(p, "취소됨", "사람이 직접 취소", ToolEngine.OWNER_REREGISTER_GRACE_MS);
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(1);
      await eng.runGuard();
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(1); // 아직 대기 중
      expect(x.autoUnprotected[0].attempts).toBe(0);
      expect(x.autoTradePositions.some((q) => q.symbol === "AAPL")).toBe(false); // 봇이 주문을 안 냈다
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("유예 중에 오너가 새 조건주문을 걸면, 그 주문(오너 가격)으로 추적을 복원한다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = pos();
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      await x.clearAutoPositionWithoutPnl(p, "취소됨", "사람이 직접 취소", ToolEngine.OWNER_REREGISTER_GRACE_MS);
      stopTimer();
      // 오너가 토스에서 새 가격(익절 2.7 / 손절 1.9)으로 다시 건 상황
      await eng.placeOco({ symbol: "AAPL", quantity: 100, tpTrigger: 2.7, tpPrice: 2.7, slTrigger: 1.9, slPrice: 1.88, expireDate: "2026-12-30" });
      await eng.runGuard();
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(0);
      const restored = x.autoTradePositions.find((q) => q.symbol === "AAPL");
      expect(restored?.status).toBe("active");
      expect(restored?.tp).toBe(2.7); // 봇의 예전 가격(2.5)이 아니라 오너가 건 가격
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("유예가 끝났는데도 새 조건주문이 없으면, 그때 가드가 예전처럼 보호를 다시 건다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      await eng.mockSetPrice("AAPL", 2.2); // 익절/손절선 사이 — 조건주문을 걸 수 있는 가격
      const p = pos();
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      await x.clearAutoPositionWithoutPnl(p, "취소됨", "사람이 직접 취소", ToolEngine.OWNER_REREGISTER_GRACE_MS);
      stopTimer();
      x.autoUnprotected[0].graceUntilMs = Date.now() - 1; // 2분이 지났다고 가정
      await eng.runGuard();
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(0);
      expect(x.autoTradePositions.find((q) => q.symbol === "AAPL")?.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("유예 없는 경로(조건주문이 원인 모르게 사라짐 등)는 지금처럼 바로 보호한다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      await eng.mockSetPrice("AAPL", 2.2);
      const p = pos();
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      await x.clearAutoPositionWithoutPnl(p, "사라짐", "토스에 조건주문 없음"); // 유예 인자 없음
      stopTimer();
      expect(x.autoUnprotected[0].graceUntilMs ?? null).toBeNull();
      await eng.runGuard();
      stopTimer();
      expect(x.autoTradePositions.find((q) => q.symbol === "AAPL")?.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("[v0.101.0 ③] 오너가 건 조건주문으로 복원할 때 — 조건주문 수량·실제 체결가를 정확히 남긴다", () => {
  it("보유 100주인데 오너가 1주만 걸었으면 보호 수량은 1주, 99주 무보호를 알리고, 체결가도 이어받는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = pos({ fillPrice: 2.12 });
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histOf(p));
      await x.clearAutoPositionWithoutPnl(p, "취소됨", "사람이 직접 취소", ToolEngine.OWNER_REREGISTER_GRACE_MS);
      stopTimer();
      await eng.placeOco({ symbol: "AAPL", quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30" });
      await eng.runGuard();
      stopTimer();
      const restored = x.autoTradePositions.find((q) => q.symbol === "AAPL");
      expect(restored?.quantity).toBe(100);
      expect(restored?.protectedQty).toBe(1);
      expect(restored?.fillPrice).toBe(2.12);
      const hist = x.autoTradeHistory.find((h) => h.id === histOf(p).id);
      expect(hist?.note).toContain("99주");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
