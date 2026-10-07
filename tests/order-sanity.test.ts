// =============================================================================
// tests/order-sanity.test.ts — [v0.69.2/v0.69.3 긴급] 주문 전 정합성 검사 + 체결가 기준 재계산 + 고아 주문 정리
// -----------------------------------------------------------------------------
// 실사고 3종(QTEX 감시가 0 / 카일 손절% 100 / SXTC 주문가≠체결가로 익절 +10.4%)과 "미체결 매수 주문이 토스에 남음" 회귀를 고정한다.
// ⚠️ 실계좌 안 건드림(forceMock).
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBracketPrices, checkPercentSettings, checkSimpleOrder } from "../lib/order-sanity";
import { ToolEngine, type AutoPosition, type AutoTradeHistoryEntry } from "../electron/tool-engine";

describe("order-sanity — 순수 검사", () => {
  const ok = { quantity: 10, tpTrigger: 2.45, tpPrice: 2.45, slTrigger: 2.16, slPrice: 2.13, entry: 2.41 };

  it("정상 값은 통과한다(설정 익절 2%·손절 10% 일치)", () => {
    expect(checkBracketPrices({ ...ok, expect: { basis: 2.41, tpPct: 2, slPct: 10, slMode: "fixed" } })).toEqual([]);
  });

  it("QTEX: 손절 감시가 0이면 막는다", () => {
    const r = checkBracketPrices({ ...ok, slTrigger: 0, slPrice: 0 });
    expect(r.join(" ")).toContain("손절 감시가");
  });

  it("방향이 뒤집히면(익절≤진입 또는 손절≥진입) 막는다", () => {
    expect(checkBracketPrices({ ...ok, tpTrigger: 2.4, tpPrice: 2.4 }).length).toBeGreaterThan(0);
    expect(checkBracketPrices({ ...ok, slTrigger: 2.5, slPrice: 2.49 }).length).toBeGreaterThan(0);
  });

  it("SXTC: 체결가 2.22 기준으로 보면 주문가 기준 익절 2.45는 +10.4% → 설정(2%)과 달라 막는다", () => {
    const r = checkBracketPrices({ ...ok, entry: 2.22, expect: { basis: 2.22, tpPct: 2, slPct: 10, slMode: "fixed" } });
    expect(r.some((m) => m.includes("익절가") && m.includes("10."))).toBe(true);
    expect(r.some((m) => m.includes("손절가"))).toBe(true);
  });

  it("호가 단위 절삭 1틱 차이는 허용한다", () => {
    // 2.41 × 1.02 = 2.4582 → 2.45(절삭). 2.46이어도 1틱 이내라 통과.
    expect(checkBracketPrices({ ...ok, tpTrigger: 2.46, tpPrice: 2.46, expect: { basis: 2.41, tpPct: 2, slPct: 10, slMode: "fixed" } })).toEqual([]);
  });

  it("EMA 기준 손절은 진입가 아래·고정 한도 이내일 때만 통과한다", () => {
    const base = { ...ok, expect: { basis: 2.41, tpPct: 2, slPct: 10, slMode: "ema" as const } };
    expect(checkBracketPrices({ ...base, slTrigger: 2.3, slPrice: 2.27 })).toEqual([]);
    expect(checkBracketPrices({ ...base, slTrigger: 1.5, slPrice: 1.48 }).length).toBeGreaterThan(0); // 고정 한도(−10%)보다 깊음
  });

  it("카일: 손절% 100 이상 설정 자체가 비정상이다", () => {
    expect(checkPercentSettings(2, 100).join(" ")).toContain("100");
    expect(checkPercentSettings(2, 10)).toEqual([]);
    expect(checkPercentSettings(0, 10).length).toBeGreaterThan(0);
  });

  it("일반 주문: 수량 0·지정가 0은 막는다", () => {
    expect(checkSimpleOrder({ quantity: 0, orderType: "MARKET" }).length).toBeGreaterThan(0);
    expect(checkSimpleOrder({ quantity: 3, orderType: "LIMIT", price: 0 }).length).toBeGreaterThan(0);
    expect(checkSimpleOrder({ quantity: 3, orderType: "MARKET" })).toEqual([]);
  });
});

type Internals = {
  autoTradePositions: AutoPosition[];
  autoTradeHistory: AutoTradeHistoryEntry[];
  rebaseToFill: (spec: any, plan: any, fill: number | null) => { spec: any; basis: number | null; rebased: boolean };
  reconcileAutoPositions: () => Promise<void>;
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kyle-sanity-"));
  const eng = new ToolEngine(dir, { forceMock: true });
  await eng.quote("AAPL");
  return { dir, eng, x: eng as unknown as Internals };
}

describe("[v0.69.2] 체결가 기준 재계산 + 주문 차단 기록", () => {
  it("SXTC 재현: 주문가 2.41·체결 2.22면 익절/손절을 체결가 기준(설정 2%/10%)으로 다시 계산한다", async () => {
    const { dir, x } = await setup();
    try {
      const spec = { price: 2.41, tpTrigger: 2.45, tpPrice: 2.45, slTrigger: 2.16, slPrice: 2.13 };
      const r = x.rebaseToFill(spec, { tpPct: 2, slPct: 10, slMode: "fixed" }, 2.22);
      expect(r.rebased).toBe(true);
      expect(r.basis).toBe(2.22);
      expect(r.spec.tpTrigger).toBe(2.26); // 2.22 × 1.02 = 2.2644 → 2.26
      expect(r.spec.slTrigger).toBe(1.99); // 2.22 × 0.9 = 1.998 → 1.99
      // 체결가가 주문가와 같으면(1틱 이내) 그대로 둔다.
      expect(x.rebaseToFill(spec, { tpPct: 2, slPct: 10, slMode: "fixed" }, 2.41).rebased).toBe(false);
      // 자동매매 계획이 없는(수동 브라켓) 주문은 오너가 정한 가격 그대로.
      expect(x.rebaseToFill(spec, undefined, 2.22).rebased).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("손절%≥100 같은 비정상 설정의 자동매매 진입은 매수 주문 자체를 보내지 않고 붉은 경고(orderBlocks)를 남긴다", async () => {
    const { dir, eng } = await setup();
    try {
      await expect(
        eng.placeBracket({
          symbol: "AAPL", price: 2.0, quantity: 1, tpTrigger: 2.04, tpPrice: 2.04, slTrigger: 0, slPrice: 0, expireDate: "2026-12-30",
          autoPlan: { tpPct: 2, slPct: 100, slMode: "fixed" },
        } as never),
      ).rejects.toThrow(/주문 검증 실패/);
      const st = eng.getAutoTradeStatus();
      expect(st.orderBlocks.length).toBe(1);
      expect(st.orderBlocks[0].reasons.join(" ")).toContain("손절");
      expect((await eng.openOrders()).length).toBe(0); // 매수가 토스(목)로 나가지 않았다
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("[v0.69.3] 미체결 매수 주문이 토스에 남는 문제", () => {
  it("추적에서 빠진 봇 매수 주문(기록에 번호가 있음)은 감사가 취소한다 — 수동 브라켓 주문은 건드리지 않는다", async () => {
    const { dir, eng, x } = await setup();
    try {
      await eng.placeBracket({ symbol: "AAPL", price: 1.9, quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30", watchMinutes: 0.01, pollMs: 20 });
      await new Promise((r) => setTimeout(r, 1100)); // 주문번호(멱등키)가 초 단위 시각이라 같은 초에 두 번 내면 같은 주문으로 합쳐진다
      await eng.placeBracket({ symbol: "AAPL", price: 1.91, quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30", watchMinutes: 0.01, pollMs: 20 });
      const open = await eng.openOrders();
      expect(open.length).toBe(2);
      const botOne = open.find((o) => Math.abs((o.price ?? 0) - 1.9) < 1e-9)!;
      // 봇이 낸 주문으로 기록만 있고 추적 포지션은 없는 상태(고아)
      x.autoTradeHistory.push({
        id: `AAPL@1.9@${Date.now() - 3_600_000}`, symbol: "AAPL", entry: 1.9, tp: 2.5, sl: 1.8, quantity: 1, enteredAt: "10-07 22:00:00",
        status: "closed_manual", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "테스트", buyOrderId: botOne.tossOrderId,
      });
      const n = await eng.auditOrphanBuyOrders();
      expect(n).toBe(1);
      const left = await eng.openOrders();
      expect(left.length).toBe(1);
      expect(Math.abs((left[0].price ?? 0) - 1.91)).toBeLessThan(1e-9); // 수동 주문은 그대로
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("재시작으로 감시가 끊긴 미체결 주문은 감시시간이 지나면 reconcile이 취소를 요청한다", async () => {
    const { dir, eng, x } = await setup();
    try {
      await eng.placeBracket({ symbol: "AAPL", price: 1.9, quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30", watchMinutes: 0.01, pollMs: 20 });
      const o = (await eng.openOrders())[0];
      x.autoTradePositions.push({
        symbol: "AAPL", entry: 1.9, tp: 2.5, sl: 1.8, quantity: 1, enteredAtMs: Date.now() - 3 * 3_600_000, status: "watching", conditionalOrderId: null, buyOrderId: o.tossOrderId,
      });
      await x.reconcileAutoPositions();
      // 취소 요청 후 목 서버에선 즉시 반영 — 다음 확인에서 "취소됨"으로 정리된다.
      expect((await eng.openOrders()).length).toBe(0);
      await x.reconcileAutoPositions();
      expect(x.autoTradePositions.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
