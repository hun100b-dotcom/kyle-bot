// =============================================================================
// tests/report.test.ts — "오늘의 매매 리포트" 집계 규칙 고정 (v0.9.1)
// -----------------------------------------------------------------------------
// [왜 테스트가 필요한가?]
//   이 화면은 사장님이 "오늘 얼마 벌었나"를 판단하는 곳입니다. 숫자가 틀리면
//   판단이 틀어집니다. 특히 아래 두 가지가 조용히 깨지면 아주 위험합니다:
//     ① 연습(mock)·드라이런 기록이 섞여 **번 적 없는 돈이 벌었다고 표시**되는 것
//     ② 아직 안 판 종목(미청산)이 실현손익에 들어가는 것
//   그래서 규칙을 테스트로 못 박습니다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { buildDailyReport, tradePnlUsd, type ReportTrade } from "../lib/report";

const TODAY = "08-19";
const YESTERDAY = "08-18";

/** 거래 한 건 만들기(필요한 것만 넘기고 나머지는 기본값) */
function trade(over: Partial<ReportTrade> = {}): ReportTrade {
  return {
    symbol: "AAPL",
    mode: "real",
    entryTs: `${TODAY} 10:00:00`,
    entryPrice: 100,
    exitTs: `${TODAY} 11:00:00`,
    exitPrice: 102,
    exitKind: "tp",
    resultPct: 2,
    outcome: "win",
    quantity: 10,
    ...over,
  };
}

describe("tradePnlUsd — 한 건의 실현 금액", () => {
  it("수량이 있으면 (청산가−진입가)×수량", () => {
    expect(tradePnlUsd(trade({ entryPrice: 100, exitPrice: 102, quantity: 10 }))).toBe(20);
    expect(tradePnlUsd(trade({ entryPrice: 100, exitPrice: 90, quantity: 3 }))).toBe(-30);
  });

  it("수량을 모르면 추측하지 않고 null (옛 기록 보호)", () => {
    expect(tradePnlUsd(trade({ quantity: undefined }))).toBeNull();
  });
});

describe("buildDailyReport — 오늘 청산된 '실제' 거래만", () => {
  it("[가장 중요] 연습·드라이런 기록은 절대 섞이지 않는다", () => {
    const r = buildDailyReport(
      [
        trade({ symbol: "REAL", mode: "real" }),
        trade({ symbol: "MOCK", mode: "mock", resultPct: 999 }),
        trade({ symbol: "DRY", mode: "dryrun", resultPct: 999 }),
      ],
      TODAY,
    );
    expect(r.closed).toBe(1);
    expect(r.rows.map((x) => x.symbol)).toEqual(["REAL"]);
  });

  it("어제 청산분은 오늘 리포트에 안 들어간다", () => {
    const r = buildDailyReport(
      [trade({ exitTs: `${YESTERDAY} 23:50:00` }), trade({ symbol: "TSLA" })],
      TODAY,
    );
    expect(r.closed).toBe(1);
    expect(r.rows[0].symbol).toBe("TSLA");
  });

  it("아직 안 판 종목(미청산)은 실현손익에 안 들어가고 '진행 중'으로만 센다", () => {
    const r = buildDailyReport(
      [trade(), trade({ symbol: "HOLD", exitTs: null, exitPrice: null, resultPct: null, outcome: null, exitKind: null })],
      TODAY,
    );
    expect(r.closed).toBe(1);
    expect(r.openNow).toBe(1);
  });

  it("익절·손절 횟수와 승률을 센다", () => {
    const r = buildDailyReport(
      [
        trade({ exitKind: "tp", outcome: "win", resultPct: 2 }),
        trade({ symbol: "B", exitKind: "tp", outcome: "win", resultPct: 3 }),
        trade({ symbol: "C", exitKind: "sl", outcome: "loss", resultPct: -10, exitPrice: 90 }),
        trade({ symbol: "D", exitKind: "manual", outcome: "win", resultPct: 1 }),
      ],
      TODAY,
    );
    expect(r.tpCount).toBe(2);
    expect(r.slCount).toBe(1);
    expect(r.manualCount).toBe(1);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(1);
    expect(r.winRate).toBe(75); // 4건 중 3건
  });

  it("실현 손익 합계와 평균 수익률을 낸다", () => {
    const r = buildDailyReport(
      [
        trade({ entryPrice: 100, exitPrice: 110, quantity: 2, resultPct: 10 }), // +20
        trade({ symbol: "B", entryPrice: 50, exitPrice: 45, quantity: 4, resultPct: -10, outcome: "loss", exitKind: "sl" }), // −20
      ],
      TODAY,
    );
    expect(r.totalPnlUsd).toBe(0);
    expect(r.avgPct).toBe(0); // (+10 −10) / 2
  });

  it("오늘의 1등 = 가장 잘 먹은 한 방이 큰 종목", () => {
    const r = buildDailyReport(
      [
        trade({ symbol: "SLOW", resultPct: 1.5 }),
        trade({ symbol: "STAR", resultPct: 8.4 }),
        trade({ symbol: "MID", resultPct: 3 }),
      ],
      TODAY,
    );
    expect(r.best?.symbol).toBe("STAR");
    expect(r.best?.pctBest).toBe(8.4);
  });

  it("같은 종목을 여러 번 매매하면 한 줄로 묶는다", () => {
    const r = buildDailyReport(
      [
        trade({ symbol: "IONQ", resultPct: 2, entryPrice: 100, exitPrice: 102, quantity: 1 }),
        trade({ symbol: "IONQ", resultPct: 4, entryPrice: 100, exitPrice: 104, quantity: 1 }),
      ],
      TODAY,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].trades).toBe(2);
    expect(r.rows[0].pctAvg).toBe(3); // (2+4)/2
    expect(r.rows[0].pctBest).toBe(4);
    expect(r.rows[0].pnlUsd).toBe(6); // 2 + 4
  });

  it("수량을 모르는 옛 기록만 있으면 금액은 null, 수익률은 그대로 보여 준다", () => {
    const r = buildDailyReport([trade({ quantity: undefined, resultPct: 5 })], TODAY);
    expect(r.totalPnlUsd).toBeNull();
    expect(r.avgPct).toBe(5);
    expect(r.rows[0].hasAmount).toBe(false);
  });

  it("오늘 거래가 하나도 없으면 빈 리포트(0건)를 돌려준다", () => {
    const r = buildDailyReport([], TODAY);
    expect(r.closed).toBe(0);
    expect(r.rows).toHaveLength(0);
    expect(r.best).toBeNull();
    expect(r.winRate).toBeNull();
    expect(r.totalPnlUsd).toBeNull();
  });
});
