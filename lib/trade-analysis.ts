// =============================================================================
// lib/trade-analysis.ts — 매매 '한 사이클'(진입→청산) 자동 추적 + 유의미한 분석 (순수 계산)
// -----------------------------------------------------------------------------
// [사장님 요구 정확히]
//   "내가 매매한 종목을 진입 시점부터 청산 시점까지 자동으로 기록하고, 유의미한 데이터를 보여줘라."
//   → 실제 체결이력(matchFifo)에서 매도 건별로 [진입가·청산가·수량·보유기간·수익률·손익금액·승패]를
//     자동 산출하고, 진입 시 체결강도·기법을 아는 만큼 붙여 "강할 때 산 매매 vs 약할 때" 같은 인사이트까지.
//
// [순수 함수인 이유] 화면·네트워크와 분리 → PC/폰 동일 + 테스트로 규칙 고정.
// =============================================================================

import type { RealizedTrade } from "./fills";

/** 진입 순간 정보(아는 매매에만 붙는다 — Capri로 주문해 기록이 남은 경우). */
export interface CycleEnrichment {
  technique?: string; //          사용한 기법(삼분할/호가창/캔들/수동)
  entryStrength?: number | null; // 진입 시 체결강도(추정치)
}

/** 매매 한 사이클(진입→청산). */
export interface TradeCycle {
  symbol: string;
  buyAtMs?: number; //   진입 시각(ms)
  sellAtMs: number; //   청산 시각(ms)
  holdMs?: number; //    보유기간(ms) = sellAtMs - buyAtMs (아는 경우)
  qty: number;
  entryPrice: number; // 진입가(평균 매입가)
  exitPrice: number; //  청산가(평균 매도가)
  pnl: number; //        실현 손익(수수료·세금 반영)
  pct: number; //        수익률 %
  win: boolean; //       이익이면 true
  technique?: string; //       기법(아는 경우)
  entryStrength?: number | null; // 진입 체결강도(아는 경우)
}

/** '강할 때/약할 때' 같은 묶음 통계. */
export interface Bucket {
  n: number;
  winRate: number | null; // %
  avgPct: number | null; //  평균 수익률 %
}

/** 종목별 요약. */
export interface SymbolStat {
  symbol: string;
  n: number;
  wins: number;
  winRate: number | null;
  totalPnl: number;
  avgPct: number;
}

/** 분석 결과 전체. */
export interface TradeInsights {
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  avgPct: number | null;
  avgHoldMin: number | null; // 평균 보유(분)
  best: TradeCycle | null; //  가장 잘 번 사이클
  worst: TradeCycle | null; // 가장 크게 잃은 사이클
  /** 진입 체결강도를 아는 매매만 대상: 강함(≥100) vs 약함(<100) 비교 */
  strong: Bucket;
  weak: Bucket;
  strengthKnown: number; // 진입 체결강도를 아는 매매 수(표본)
  /** 사람 말 한 줄 인사이트(표본이 충분할 때만). null이면 아직 데이터 부족. */
  headline: string | null;
  bySymbol: SymbolStat[];
}

/**
 * buildCycles — 실현손익(matchFifo 결과)에 진입정보(enrich)를 붙여 사이클 배열로.
 *   @param enrich (선택) 각 실현손익에 기법·진입강도를 붙이는 함수(엔진이 근거기록으로 매칭).
 */
export function buildCycles(realized: RealizedTrade[], enrich?: (r: RealizedTrade) => CycleEnrichment | undefined): TradeCycle[] {
  return realized.map((r) => {
    const e = enrich?.(r);
    const holdMs = r.buyAtMs != null ? Math.max(0, r.sellAtMs - r.buyAtMs) : undefined;
    return {
      symbol: r.symbol,
      buyAtMs: r.buyAtMs,
      sellAtMs: r.sellAtMs,
      holdMs,
      qty: r.qty,
      entryPrice: r.buyAvg,
      exitPrice: r.sellPrice,
      pnl: r.pnl,
      pct: r.pct,
      win: r.pnl >= 0,
      technique: e?.technique,
      entryStrength: e?.entryStrength ?? null,
    };
  });
}

function bucket(cycles: TradeCycle[]): Bucket {
  const n = cycles.length;
  if (n === 0) return { n: 0, winRate: null, avgPct: null };
  const wins = cycles.filter((c) => c.win).length;
  const avgPct = cycles.reduce((a, c) => a + c.pct, 0) / n;
  return { n, winRate: Math.round((wins / n) * 1000) / 10, avgPct: Math.round(avgPct * 100) / 100 };
}

/**
 * analyzeTrades — 사이클 배열에서 전체·강약·종목별 통계와 한 줄 인사이트를 만든다.
 */
export function analyzeTrades(cycles: TradeCycle[]): TradeInsights {
  const n = cycles.length;
  const wins = cycles.filter((c) => c.win).length;
  const losses = n - wins;
  const totalPnl = Math.round(cycles.reduce((a, c) => a + c.pnl, 0) * 100) / 100;
  const avgPct = n ? Math.round((cycles.reduce((a, c) => a + c.pct, 0) / n) * 100) / 100 : null;
  const holds = cycles.map((c) => c.holdMs).filter((v): v is number => v != null);
  const avgHoldMin = holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length / 60000) : null;

  const sorted = [...cycles].sort((a, b) => b.pnl - a.pnl);
  const best = sorted[0] ?? null;
  const worst = sorted.length ? sorted[sorted.length - 1] : null;

  // 진입 체결강도를 아는 매매만: 강함(≥100) vs 약함(<100)
  const known = cycles.filter((c) => c.entryStrength != null);
  const strong = bucket(known.filter((c) => (c.entryStrength as number) >= 100));
  const weak = bucket(known.filter((c) => (c.entryStrength as number) < 100));

  // 종목별
  const bySym = new Map<string, TradeCycle[]>();
  for (const c of cycles) {
    const arr = bySym.get(c.symbol) ?? [];
    arr.push(c);
    bySym.set(c.symbol, arr);
  }
  const bySymbol: SymbolStat[] = [...bySym.entries()].map(([symbol, list]) => {
    const w = list.filter((c) => c.win).length;
    return {
      symbol,
      n: list.length,
      wins: w,
      winRate: Math.round((w / list.length) * 1000) / 10,
      totalPnl: Math.round(list.reduce((a, c) => a + c.pnl, 0) * 100) / 100,
      avgPct: Math.round((list.reduce((a, c) => a + c.pct, 0) / list.length) * 100) / 100,
    };
  }).sort((a, b) => b.totalPnl - a.totalPnl);

  // 사람 말 인사이트(강/약 각 3건 이상일 때만 — 표본 적으면 오해를 준다)
  let headline: string | null = null;
  if (strong.n >= 3 && weak.n >= 3 && strong.winRate != null && weak.winRate != null) {
    const diff = strong.winRate - weak.winRate;
    if (Math.abs(diff) >= 5) {
      headline =
        diff > 0
          ? `체결강도가 셀 때(100↑) 산 매매의 승률이 ${strong.winRate}%(평균 ${strong.avgPct}%)로, 약할 때(${weak.winRate}%)보다 높습니다 → 강할 때 진입이 유리했어요.`
          : `체결강도가 약할 때(100↓) 산 매매의 승률이 ${weak.winRate}%로 오히려 더 높습니다 → 이 종목군에선 '강함'만으로 판단하지 마세요.`;
    } else {
      headline = `강할 때(${strong.winRate}%)와 약할 때(${weak.winRate}%) 승률 차이가 크지 않습니다 → 체결강도 단독보다 가격·캔들과 함께 보세요.`;
    }
  }

  return {
    n, wins, losses,
    winRate: n ? Math.round((wins / n) * 1000) / 10 : null,
    totalPnl, avgPct, avgHoldMin, best, worst,
    strong, weak, strengthKnown: known.length,
    headline, bySymbol,
  };
}
