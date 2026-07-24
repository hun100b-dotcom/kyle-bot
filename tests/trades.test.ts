// =============================================================================
// tests/trades.test.ts — 체결강도 자동 기록(매매 연동) 테스트 (v0.7.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나?]
//   카프리로 주문할 때 진입·청산 순간의 체결강도를 자동 스냅샷해 트레이드로 쌓고
//   결과(%)·요약통계를 만든다. 이 로직이 조용히 틀리면 분석이 엉터리가 되므로 고정한다.
//   ① 순수 함수 summarizeTrades — 수익/손실의 진입 시 평균 체결강도·승률
//   ② 엔진 연동 — 진입(placeEntry)→청산(placeSell) 자동 기록 + 결과계산 + 저장 왕복(연습 모드)
//   ⚠️ 실계좌 안 건드림(forceMock). 주문 로직은 그대로, 기록만 얹혔는지 본다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, summarizeTrades, type StrengthTrade } from "../electron/tool-engine";

// 트레이드 하나 만들기(도우미)
function tr(over: Partial<StrengthTrade>): StrengthTrade {
  return {
    id: Math.random().toString(36).slice(2),
    symbol: "AAPL",
    mode: "dryrun",
    entryTs: "07-25 10:00:00",
    entryPrice: 10,
    entry: { strength: 120, buyVol: 0, sellVol: 0, rising: null },
    exitTs: null,
    exitPrice: null,
    exit: null,
    exitKind: null,
    resultPct: null,
    outcome: null,
    ...over,
  };
}

describe("요약 통계(summarizeTrades)", () => {
  it("수익 vs 손실의 진입 시 평균 체결강도·승률을 계산한다", () => {
    const trades: StrengthTrade[] = [
      tr({ entry: { strength: 150, buyVol: 0, sellVol: 0, rising: null }, resultPct: 2, outcome: "win" }),
      tr({ entry: { strength: 130, buyVol: 0, sellVol: 0, rising: null }, resultPct: 1, outcome: "win" }),
      tr({ entry: { strength: 90, buyVol: 0, sellVol: 0, rising: null }, resultPct: -3, outcome: "loss" }),
      tr({ entry: { strength: 100, buyVol: 0, sellVol: 0, rising: null }, resultPct: null, outcome: null }), // 미청산
    ];
    const s = summarizeTrades(trades);
    expect(s.total).toBe(4);
    expect(s.open).toBe(1);
    expect(s.closed).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(66.7, 1); // 2/3
    expect(s.avgEntryStrengthWin).toBe(140); // (150+130)/2
    expect(s.avgEntryStrengthLoss).toBe(90);
    expect(s.avgResultPct).toBe(0); // (2+1-3)/3
  });

  it("체결강도 null(매수 일방)은 평균에서 제외한다", () => {
    const trades: StrengthTrade[] = [
      tr({ entry: { strength: null, buyVol: 0, sellVol: 0, rising: null }, resultPct: 5, outcome: "win" }),
      tr({ entry: { strength: 200, buyVol: 0, sellVol: 0, rising: null }, resultPct: 5, outcome: "win" }),
    ];
    expect(summarizeTrades(trades).avgEntryStrengthWin).toBe(200); // null 제외 → 200만
  });

  it("트레이드가 없으면 승률·평균은 null", () => {
    const s = summarizeTrades([]);
    expect(s.winRate).toBeNull();
    expect(s.avgEntryStrengthWin).toBeNull();
  });
});

// 다음 "trades" 이벤트 한 번을 기다리는 도우미(기록이 파일까지 반영된 뒤 emit됨).
function nextTrades(eng: ToolEngine): Promise<void> {
  return new Promise((resolve) => eng.once("trades", () => resolve()));
}

describe("엔진 연동 — 진입→청산 자동 기록(연습 모드)", () => {
  it("placeEntry가 트레이드를 열고, placeSell이 닫으며 결과를 계산한다(재시작에도 유지)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-trd-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true }); // 실계좌 안 건드림

      // 진입 — 자동 기록 이벤트를 기다린다
      const p1 = nextTrades(eng);
      await eng.placeEntry({ symbol: "AAPL", price: 2.0, quantity: 1 });
      await p1;
      let log = eng.getTradeLog();
      expect(log.length).toBe(1);
      expect(log[0].symbol).toBe("AAPL");
      expect(log[0].mode).toBe("mock"); // 연습 모드 태그
      expect(log[0].outcome).toBeNull(); // 아직 미청산
      expect(log[0].entry).not.toBeNull(); // 진입 체결강도 스냅샷됨

      // 청산(매도 지정가 $2.2 → +10%)
      const p2 = nextTrades(eng);
      await eng.placeSell({ symbol: "AAPL", quantity: 1, orderType: "LIMIT", price: 2.2 });
      await p2;
      log = eng.getTradeLog();
      expect(log[0].outcome).toBe("win");
      expect(log[0].resultPct).toBeCloseTo(10, 1); // (2.2-2.0)/2.0×100
      expect(log[0].exit).not.toBeNull();

      // 요약 통계 반영
      const stats = eng.getTradeStats();
      expect(stats.wins).toBe(1);
      expect(stats.winRate).toBe(100);

      // 재시작(새 엔진)해도 유지
      const eng2 = new ToolEngine(dir, { forceMock: true });
      expect(eng2.getTradeLog()[0].outcome).toBe("win");

      // 수동 청산 API + 삭제
      const seeded = eng2.getTradeLog()[0];
      const afterDel = eng2.deleteTrade(seeded.id);
      expect(afterDel.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
