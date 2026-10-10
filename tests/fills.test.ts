// =============================================================================
// tests/fills.test.ts — 토스 실제 체결내역으로 매매 성적 계산 (v0.9.6)
// -----------------------------------------------------------------------------
// [배경 — 실제 사고]
//   리포트가 늘 비어 있었다. 앱이 남긴 기록만 보고 있었는데, 그 기록은 앱에서 [매도]를
//   눌렀을 때만 '판 것'으로 남는다. 사장님은 **조건주문(자동 체결)·토스 앱**으로도 파시므로
//   앱은 판 사실을 몰랐다(매수 22건·매도 0건 → 리포트 0건).
//
//   그래서 토스에 남은 **실제 체결 내역**으로 계산하도록 바꿨다. 이 파일은 그 계산 규칙을 고정한다:
//     ① 먼저 산 것부터 팔린 것으로 본다(선입선출) — 증권사와 같은 방식
//     ② 수수료·세금을 빼서 '손에 쥔 금액'에 맞춘다
//     ③ 취소·미체결 주문은 계산에 넣지 않는다(호출부에서 걸러 넣는다)
// =============================================================================

import { describe, it, expect } from "vitest";
import { matchFifo, type Fill } from "../lib/fills";
import { buildReportFromRealized, makePeriod } from "../lib/report";

const KST = 540;
function ms(y: number, m: number, d: number, hh = 10): number {
  return Date.UTC(y, m - 1, d, hh) - KST * 60_000;
}
function fill(over: Partial<Fill> = {}): Fill {
  return { symbol: "XOS", side: "BUY", qty: 100, price: 4, atMs: ms(2026, 8, 19), commission: 0, tax: 0, ...over };
}

describe("matchFifo — 선입선출 실현손익", () => {
  it("산 뒤 판 한 쌍의 손익을 계산한다(수수료·세금 반영)", () => {
    const r = matchFifo([
      fill({ side: "BUY", qty: 108, price: 4.26, commission: 0.46, atMs: ms(2026, 8, 19, 0) }),
      fill({ side: "SELL", qty: 108, price: 4.45, commission: 0.48, tax: 0.01, atMs: ms(2026, 8, 19, 1) }),
    ]);
    expect(r).toHaveLength(1);
    // (4.45−4.26)×108 = 20.52, 수수료·세금 0.46+0.48+0.01 = 0.95 → 19.57
    expect(r[0].pnl).toBeCloseTo(19.57, 2);
    expect(r[0].qty).toBe(108);
    expect(r[0].matched).toBe(true);
  });

  it("여러 번 나눠 산 뒤 한 번에 팔면 '먼저 산 것부터' 계산한다", () => {
    const r = matchFifo([
      fill({ side: "BUY", qty: 100, price: 4.0, atMs: ms(2026, 8, 18, 9) }),
      fill({ side: "BUY", qty: 50, price: 4.2, atMs: ms(2026, 8, 18, 10) }),
      fill({ side: "SELL", qty: 120, price: 4.5, atMs: ms(2026, 8, 18, 11) }),
    ]);
    // 100주는 4.0에서, 20주는 4.2에서 산 것 → 평균 (100×4 + 20×4.2)/120 = 4.0333
    expect(r[0].buyAvg).toBeCloseTo(4.0333, 3);
    expect(r[0].pnl).toBeCloseTo((4.5 - 4.0333) * 120, 1);
  });

  it("나눠 팔면(부분 매도) 각각 별개의 매매로 잡힌다", () => {
    const r = matchFifo([
      fill({ side: "BUY", qty: 100, price: 10, atMs: ms(2026, 8, 17, 9) }),
      fill({ side: "SELL", qty: 40, price: 11, atMs: ms(2026, 8, 17, 10) }),
      fill({ side: "SELL", qty: 60, price: 9, atMs: ms(2026, 8, 17, 11) }),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0].pnl).toBeCloseTo(40, 2); //  (11−10)×40
    expect(r[1].pnl).toBeCloseTo(-60, 2); // (9−10)×60
  });

  it("산 기록이 없는 매도는 계좌 평균매입가로 메운다", () => {
    const r = matchFifo([fill({ side: "SELL", qty: 10, price: 5, atMs: ms(2026, 8, 19) })], { XOS: 4 });
    expect(r).toHaveLength(1);
    expect(r[0].pnl).toBeCloseTo(10, 2); // (5−4)×10
  });

  it("산 기록도 평균매입가도 없으면 손익을 지어내지 않는다(제외)", () => {
    const r = matchFifo([fill({ side: "SELL", qty: 10, price: 5 })], {});
    expect(r).toHaveLength(0);
  });

  it("종목이 섞여 있어도 각자 계산된다", () => {
    const r = matchFifo([
      fill({ symbol: "A", side: "BUY", qty: 10, price: 10, atMs: ms(2026, 8, 19, 9) }),
      fill({ symbol: "B", side: "BUY", qty: 10, price: 20, atMs: ms(2026, 8, 19, 9) }),
      fill({ symbol: "B", side: "SELL", qty: 10, price: 22, atMs: ms(2026, 8, 19, 10) }),
      fill({ symbol: "A", side: "SELL", qty: 10, price: 9, atMs: ms(2026, 8, 19, 11) }),
    ]);
    expect(r.find((x) => x.symbol === "B")?.pnl).toBeCloseTo(20, 2);
    expect(r.find((x) => x.symbol === "A")?.pnl).toBeCloseTo(-10, 2);
  });
});

describe("buildReportFromRealized — 기간별 집계", () => {
  const realized = [
    { symbol: "XOS", sellAtMs: ms(2026, 8, 19, 1), qty: 108, pnl: 19.57, pct: 4.46 },
    { symbol: "SLE", sellAtMs: ms(2026, 8, 17, 3), qty: 50, pnl: 30, pct: 12.73 },
    { symbol: "PATH", sellAtMs: ms(2026, 8, 13, 3), qty: 20, pnl: -29.68, pct: -5.72 },
    { symbol: "OLD", sellAtMs: ms(2026, 7, 1, 3), qty: 10, pnl: 100, pct: 50 }, // 30일 밖
  ];
  const NOW = ms(2026, 8, 19, 15);

  it("오늘은 오늘 판 것만", () => {
    const r = buildReportFromRealized(realized, makePeriod("today", NOW, KST));
    expect(r.closed).toBe(1);
    expect(r.totalPnlUsd).toBe(19.57);
    expect(r.best?.symbol).toBe("XOS");
  });

  it("최근 7일은 7일치 전부 합산", () => {
    const r = buildReportFromRealized(realized, makePeriod("week", NOW, KST));
    expect(r.closed).toBe(3); // 8/19, 8/17, 8/13
    expect(r.totalPnlUsd).toBeCloseTo(19.89, 2);
    expect(r.tpCount).toBe(2); // 이익 매도 2건
    expect(r.slCount).toBe(1); // 손실 매도 1건
    expect(r.winRate).toBeCloseTo(66.7, 1);
    expect(r.best?.symbol).toBe("SLE"); // 최고 수익률
  });

  it("최근 30일 밖의 오래된 매매는 빠진다", () => {
    const r = buildReportFromRealized(realized, makePeriod("month", NOW, KST));
    expect(r.closed).toBe(3);
    expect(r.rows.find((x) => x.symbol === "OLD")).toBeUndefined();
  });

  it("특정 날짜만 골라 볼 수 있다", () => {
    const r = buildReportFromRealized(realized, makePeriod("date", NOW, KST, "2026-08-17"));
    expect(r.closed).toBe(1);
    expect(r.rows[0].symbol).toBe("SLE");
  });

  it("기간에 매매가 없으면 빈 리포트", () => {
    const r = buildReportFromRealized(realized, makePeriod("date", NOW, KST, "2026-08-15"));
    expect(r.closed).toBe(0);
    expect(r.best).toBeNull();
    expect(r.totalPnlUsd).toBeNull();
  });
});
