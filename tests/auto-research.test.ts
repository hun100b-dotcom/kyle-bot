// =============================================================================
// tests/auto-research.test.ts — "자동매매기록 → 연구" 탭 통계 규칙 고정 (v0.33.0)
// -----------------------------------------------------------------------------
// summarizeAutoHistory(순수 함수)가 승/패 집계·종목별/시간대별 성적·헤드라인을 규칙대로
// 뽑는지 검증. 실제 엔진(목 서버) 없이도 AutoTradeHistoryEntry 배열만 있으면 되므로
// 순수 데이터로 빠르게 고정한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { summarizeAutoHistory } from "../lib/auto-research";
import type { AutoTradeHistoryEntry } from "../electron/tool-engine";

function entry(o: Partial<AutoTradeHistoryEntry>): AutoTradeHistoryEntry {
  return {
    id: `${o.symbol ?? "AAPL"}@${o.entry ?? 100}@${Math.random()}`,
    symbol: "AAPL",
    entry: 100,
    tp: 102,
    sl: 98,
    quantity: 1,
    enteredAt: "09-28 10:00:00",
    status: "closed_win",
    exitedAt: "09-28 10:05:00",
    exitPrice: 102,
    pnlUsd: 2,
    pnlPct: 2,
    note: "테스트",
    ...o,
  };
}

describe("summarizeAutoHistory — 기본 승/패 집계", () => {
  it("승/패/수동청산/취소를 각각 올바른 통에 담는다", () => {
    const s = summarizeAutoHistory([
      entry({ status: "closed_win", pnlUsd: 5, pnlPct: 3 }),
      entry({ status: "closed_loss", pnlUsd: -3, pnlPct: -2 }),
      entry({ status: "closed_manual", pnlUsd: 1, pnlPct: 1 }),
      entry({ status: "cancelled", pnlUsd: null, pnlPct: null, exitPrice: null, exitedAt: null }),
    ]);
    expect(s.totalEntries).toBe(4);
    expect(s.cancelledCount).toBe(1);
    expect(s.manualCloses).toBe(1);
    expect(s.overall.n).toBe(2); // 승패로 마감된 것만(수동청산·취소 제외)
    expect(s.overall.wins).toBe(1);
    expect(s.overall.losses).toBe(1);
    expect(s.overall.winRate).toBe(50);
    expect(s.overall.totalPnlUsd).toBe(2); // 5 + -3
  });

  it("표본이 없으면 winRate는 null(0%로 거짓 표시하지 않는다)", () => {
    const s = summarizeAutoHistory([]);
    expect(s.overall.n).toBe(0);
    expect(s.overall.winRate).toBeNull();
    expect(s.headline).toBeNull();
  });
});

describe("summarizeAutoHistory — 종목별/시간대별 성적", () => {
  it("종목별로 승/패·손익이 따로 집계되고 손익 합계 내림차순으로 정렬된다", () => {
    const s = summarizeAutoHistory([
      entry({ symbol: "AAPL", status: "closed_win", pnlUsd: 10 }),
      entry({ symbol: "AAPL", status: "closed_win", pnlUsd: 5 }),
      entry({ symbol: "TSLA", status: "closed_loss", pnlUsd: -20 }),
    ]);
    expect(s.bySymbol[0].symbol).toBe("AAPL");
    expect(s.bySymbol[0].n).toBe(2);
    expect(s.bySymbol[0].totalPnlUsd).toBe(15);
    expect(s.bySymbol[1].symbol).toBe("TSLA");
    expect(s.bySymbol[1].totalPnlUsd).toBe(-20);
  });

  it("진입 시각(시 단위, KST)별로 집계된다", () => {
    const s = summarizeAutoHistory([
      entry({ enteredAt: "09-28 09:15:00", status: "closed_win" }),
      entry({ enteredAt: "09-28 09:45:00", status: "closed_win" }),
      entry({ enteredAt: "09-28 14:00:00", status: "closed_loss" }),
    ]);
    const h9 = s.byHour.find((h) => h.hour === 9);
    const h14 = s.byHour.find((h) => h.hour === 14);
    expect(h9?.n).toBe(2);
    expect(h14?.n).toBe(1);
  });
});

describe("summarizeAutoHistory — 보유시간·최고/최악 매매·헤드라인", () => {
  it("보유시간(분)을 진입~청산으로 계산한다", () => {
    const s = summarizeAutoHistory([
      entry({ enteredAt: "09-28 10:00:00", exitedAt: "09-28 10:07:00", status: "closed_win" }),
    ]);
    expect(s.avgHoldMin).toBe(7);
  });

  it("best/worst가 손익 기준으로 정확히 뽑힌다", () => {
    const s = summarizeAutoHistory([
      entry({ symbol: "A", status: "closed_win", pnlUsd: 3 }),
      entry({ symbol: "B", status: "closed_win", pnlUsd: 30 }),
      entry({ symbol: "C", status: "closed_loss", pnlUsd: -15 }),
    ]);
    expect(s.best?.symbol).toBe("B");
    expect(s.worst?.symbol).toBe("C");
  });

  it("표본이 10건 미만이면 헤드라인을 만들지 않는다(성급한 결론 방지)", () => {
    const few = Array.from({ length: 5 }, () => entry({ status: "closed_win" }));
    expect(summarizeAutoHistory(few).headline).toBeNull();
  });

  it("표본이 10건 이상이면 헤드라인 문장을 만든다", () => {
    const many = Array.from({ length: 10 }, () => entry({ status: "closed_win", pnlUsd: 1 }));
    const s = summarizeAutoHistory(many);
    expect(s.headline).toContain("10건");
    expect(s.headline).toContain("승률");
  });
});
