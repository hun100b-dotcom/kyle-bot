// =============================================================================
// tests/trade-analysis.test.ts — 매매 사이클 자동추적 + 인사이트 규칙 고정 (v0.19.0)
// -----------------------------------------------------------------------------
// 실제 체결이력(matchFifo)로 진입→청산 사이클을 만들고, 강할 때/약할 때 승률 인사이트를
// 순수 계산으로 못 박는다. 사장님 요구("이걸 보고 뭘 하라는 거냐"에 답)를 검증.
// =============================================================================

import { describe, it, expect } from "vitest";
import { matchFifo, type Fill } from "../lib/fills";
import { buildCycles, analyzeTrades, type TradeCycle } from "../lib/trade-analysis";

const H = 3600000;
const base = 1_700_000_000_000;
function f(o: Partial<Fill>): Fill {
  return { symbol: "AAPL", side: "BUY", qty: 10, price: 100, atMs: base, commission: 0, tax: 0, ...o };
}

describe("matchFifo — 보유기간용 buyAtMs", () => {
  it("매도에 채워진 가장 이른 매수 시각을 buyAtMs로 준다", () => {
    const r = matchFifo([
      f({ side: "BUY", qty: 10, price: 100, atMs: base }),
      f({ side: "SELL", qty: 10, price: 110, atMs: base + 3 * H }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].buyAtMs).toBe(base);
    expect(r[0].sellAtMs).toBe(base + 3 * H);
  });

  it("계좌 평균가 폴백으로만 매칭되면 buyAtMs는 없다(보유기간 계산 불가)", () => {
    const r = matchFifo([f({ side: "SELL", qty: 5, price: 110, atMs: base + H })], { AAPL: 100 });
    expect(r[0].buyAtMs).toBeUndefined();
  });
});

describe("buildCycles — 진입→청산 사이클 + 보유기간", () => {
  it("보유기간(holdMs)이 sell-buy로 계산된다", () => {
    const realized = matchFifo([
      f({ side: "BUY", qty: 10, price: 100, atMs: base }),
      f({ side: "SELL", qty: 10, price: 110, atMs: base + 2 * H }),
    ]);
    const cycles = buildCycles(realized);
    expect(cycles[0].holdMs).toBe(2 * H);
    expect(cycles[0].entryPrice).toBe(100);
    expect(cycles[0].exitPrice).toBe(110);
    expect(cycles[0].win).toBe(true);
  });

  it("enrich로 기법·진입강도가 붙는다", () => {
    const realized = matchFifo([
      f({ symbol: "X", side: "BUY", qty: 10, price: 10, atMs: base }),
      f({ symbol: "X", side: "SELL", qty: 10, price: 11, atMs: base + H }),
    ]);
    const cycles = buildCycles(realized, () => ({ technique: "split3", entryStrength: 150 }));
    expect(cycles[0].technique).toBe("split3");
    expect(cycles[0].entryStrength).toBe(150);
  });
});

/** 사이클 하나 만들기(분석 테스트용). */
function cyc(o: Partial<TradeCycle>): TradeCycle {
  return { symbol: "S", sellAtMs: base, qty: 10, entryPrice: 10, exitPrice: 11, pnl: 10, pct: 10, win: true, ...o };
}

describe("analyzeTrades — 전체·강약·인사이트", () => {
  it("전체 통계(승률·손익·평균)를 계산한다", () => {
    const r = analyzeTrades([
      cyc({ pnl: 10, pct: 5, win: true }),
      cyc({ pnl: -4, pct: -2, win: false }),
      cyc({ pnl: 6, pct: 3, win: true }),
    ]);
    expect(r.n).toBe(3);
    expect(r.wins).toBe(2);
    expect(r.winRate).toBe(66.7);
    expect(r.totalPnl).toBe(12);
  });

  it("보유기간 평균(분)을 낸다", () => {
    const r = analyzeTrades([cyc({ holdMs: 60000 }), cyc({ holdMs: 180000 })]);
    expect(r.avgHoldMin).toBe(2); // (1분+3분)/2
  });

  it("★핵심 인사이트: 강할 때 산 매매 승률 > 약할 때 → 헤드라인 생성", () => {
    // 강함(강도≥100) 4건 중 3승(75%), 약함(<100) 4건 중 1승(25%)
    const strong = [
      cyc({ entryStrength: 150, win: true, pct: 5, pnl: 5 }),
      cyc({ entryStrength: 120, win: true, pct: 4, pnl: 4 }),
      cyc({ entryStrength: 110, win: true, pct: 3, pnl: 3 }),
      cyc({ entryStrength: 130, win: false, pct: -2, pnl: -2 }),
    ];
    const weak = [
      cyc({ entryStrength: 80, win: true, pct: 2, pnl: 2 }),
      cyc({ entryStrength: 70, win: false, pct: -3, pnl: -3 }),
      cyc({ entryStrength: 90, win: false, pct: -1, pnl: -1 }),
      cyc({ entryStrength: 60, win: false, pct: -2, pnl: -2 }),
    ];
    const r = analyzeTrades([...strong, ...weak]);
    expect(r.strong.n).toBe(4);
    expect(r.strong.winRate).toBe(75);
    expect(r.weak.winRate).toBe(25);
    expect(r.headline).toContain("강할 때");
  });

  it("진입강도를 아는 매매가 적으면(3건 미만) 인사이트는 null(오해 방지)", () => {
    const r = analyzeTrades([cyc({ entryStrength: 150 }), cyc({ entryStrength: 80 })]);
    expect(r.headline).toBeNull();
    expect(r.strengthKnown).toBe(2);
  });

  it("종목별 요약이 손익순으로 나온다", () => {
    const r = analyzeTrades([
      cyc({ symbol: "A", pnl: 3, pct: 3 }),
      cyc({ symbol: "B", pnl: 20, pct: 10 }),
      cyc({ symbol: "A", pnl: 2, pct: 2 }),
    ]);
    expect(r.bySymbol[0].symbol).toBe("B");
    expect(r.bySymbol.find((s) => s.symbol === "A")?.n).toBe(2);
  });

  it("빈 입력도 안 터진다", () => {
    const r = analyzeTrades([]);
    expect(r.n).toBe(0);
    expect(r.winRate).toBeNull();
    expect(r.headline).toBeNull();
  });
});
