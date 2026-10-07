// =============================================================================
// tests/guardian-audit.test.ts — [v0.69.1 긴급] 보호 구멍 메우기: 독립 감사 + 취소 실패 시 감시 유지
// -----------------------------------------------------------------------------
// [배경] 오너 지시 "매도 주문 안 거는 문제 전수 확인". v0.69.0 가드는 '실패가 눈에 보이는 입구'(OCO 등록 실패·조건주문 소멸)만 막았다.
//   코드를 전수 점검해 찾은 틈:
//     ① 자동 취소 API 자체가 실패("timeout")하면 포지션을 지워 버려, 그 주문이 나중에 체결돼도 아무도 보호를 안 걸었다(AIB 실사례).
//     ② 어떤 경로로든 추적에서 빠진 "봇이 산 보유 종목 + 조건주문 없음"을 결과로 직접 대조하는 장치가 없었다.
//   ⚠️ 실계좌 안 건드림(forceMock — 엔진 내장 가짜 토스 서버. 가짜 계좌는 AAPL 100주를 보유).
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type AutoPosition, type AutoTradeHistoryEntry, type UnprotectedPos } from "../electron/tool-engine";

type Internals = {
  autoUnprotected: UnprotectedPos[];
  autoTradePositions: AutoPosition[];
  autoTradeHistory: AutoTradeHistoryEntry[];
  onAutoBracketResolved: (symbol: string, entry: number, res: { status: "timeout" }) => void;
  guardTimer: ReturnType<typeof setTimeout> | null;
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kyle-audit-"));
  const eng = new ToolEngine(dir, { forceMock: true });
  await eng.quote("AAPL"); // 목 서버를 먼저 깨운다
  const x = eng as unknown as Internals;
  const stopTimer = () => { if (x.guardTimer) { clearTimeout(x.guardTimer); x.guardTimer = null; } };
  return { dir, eng, x, stopTimer };
}

const histEntry = (over: Partial<AutoTradeHistoryEntry> = {}): AutoTradeHistoryEntry => {
  const ms = Date.now() - 3600_000;
  return {
    id: `AAPL@2.1@${ms}`, symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 100, enteredAt: "10-07 22:00:00",
    status: "closed_manual", exitedAt: "10-07 22:06:00", exitPrice: null, pnlUsd: null, pnlPct: null, note: "테스트", ...over,
  };
};

describe("[v0.69.1] 독립 감사 — 봇이 산 보유 종목인데 보호 조건주문이 없으면 가드에 올린다", () => {
  it("추적에서 빠진 봇 종목(보유 100주·조건주문 없음)을 찾아 가드 대기 목록에 올린다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      const added = await eng.auditUnprotectedHoldings();
      stopTimer();
      expect(added).toBe(1);
      expect(x.autoUnprotected.map((u) => u.symbol)).toEqual(["AAPL"]);
      expect(x.autoUnprotected[0].quantity).toBe(100); // 기록의 수량이 아니라 실계좌 보유 수량 기준
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("봇이 산 적 없는 종목(수동 보유)은 절대 건드리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const added = await eng.auditUnprotectedHoldings(); // 기록 없음
      stopTimer();
      expect(added).toBe(0);
      expect(x.autoUnprotected).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("이미 토스에 조건주문이 걸려 있으면 올리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      await eng.placeOco({ symbol: "AAPL", quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30" });
      expect(await eng.auditUnprotectedHoldings()).toBe(0);
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("지금 추적 중인(감시·보호) 종목은 건너뛴다 — 체결 직후 OCO 등록 중인 종목을 가로채지 않게", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      x.autoTradePositions.push({ symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 100, enteredAtMs: Date.now(), status: "watching", conditionalOrderId: null });
      expect(await eng.auditUnprotectedHoldings()).toBe(0);
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("정상 청산(closed_win) 기록뿐이면 올리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry({ status: "closed_win" }));
      expect(await eng.auditUnprotectedHoldings()).toBe(0);
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("[v0.69.1] 자동 취소 API 실패(timeout) — 포지션을 지우지 않고 감시를 이어 간다", () => {
  it("timeout이면 watching 포지션이 그대로 남아 5분 재확인 경로가 이어받는다", async () => {
    const { dir, x } = await setup();
    try {
      const p: AutoPosition = { symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 10, enteredAtMs: Date.now(), status: "watching", conditionalOrderId: null, buyOrderId: "X" };
      x.autoTradePositions.push(p);
      x.onAutoBracketResolved("AAPL", 2.1, { status: "timeout" });
      expect(x.autoTradePositions).toHaveLength(1);
      expect(x.autoTradePositions[0].status).toBe("watching");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
