// =============================================================================
// tests/report-period.test.ts — 리포트 '기간 조회'(오늘/1주일/1개월/날짜) 규칙 고정 (v0.9.2)
// -----------------------------------------------------------------------------
// [왜 중요한가?]
//   사장님이 "이번 주 얼마 벌었나"를 볼 때, 하루라도 잘못 포함/제외되면 판단이 틀어집니다.
//   특히 **경계**(기간의 첫날·마지막날, 자정 직전·직후)가 조용히 어긋나기 쉬워 못 박아 둡니다.
//
//   기간 정의(화면 설명과 같아야 함):
//     · 오늘   = 오늘 하루(한국 시각 00:00~23:59:59)
//     · 1주일  = 오늘 포함 최근 7일
//     · 1개월  = 오늘 포함 최근 30일
//     · 날짜   = 고른 그 하루
// =============================================================================

import { describe, it, expect } from "vitest";
import { makePeriod, buildReport, type ReportTrade, type Period } from "../lib/report";

const KST = 540; // 한국 = UTC+9 (분)
const DAY = 86_400_000;

/** 한국 시각으로 특정 날짜·시각의 밀리초 */
function kstMs(y: number, m: number, d: number, hh = 12, mm = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm) - KST * 60_000;
}

/** 청산 시각(밀리초)을 가진 거래 한 건 */
function trade(exitAtMs: number, over: Partial<ReportTrade> = {}): ReportTrade {
  const d = new Date(exitAtMs + KST * 60_000);
  const key = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return {
    symbol: "AAPL",
    mode: "real",
    entryTs: `${key} 10:00:00`,
    entryPrice: 100,
    exitTs: `${key} 11:00:00`,
    exitPrice: 102,
    exitKind: "tp",
    resultPct: 2,
    outcome: "win",
    quantity: 10,
    exitAtMs,
    ...over,
  };
}

const NOW = kstMs(2026, 8, 19, 15, 0); // 2026-08-19 15:00 KST 기준으로 시험

describe("makePeriod — 기간 만들기", () => {
  it("오늘 = 그 날 00:00~23:59:59", () => {
    const p = makePeriod("today", NOW, KST);
    expect(p.label).toBe("오늘");
    expect(p.keys).toEqual(["08-19"]);
    expect(new Date(p.fromMs + KST * 60_000).toISOString()).toContain("2026-08-19T00:00");
    expect(p.toMs - p.fromMs).toBe(DAY - 1);
  });

  it("1주일 = 오늘 포함 7일(08-13 ~ 08-19)", () => {
    const p = makePeriod("week", NOW, KST);
    expect(p.label).toBe("최근 7일");
    expect(p.keys).toHaveLength(7);
    expect(p.keys[0]).toBe("08-13");
    expect(p.keys[6]).toBe("08-19");
  });

  it("1개월 = 오늘 포함 30일(07-21 ~ 08-19)", () => {
    const p = makePeriod("month", NOW, KST);
    expect(p.label).toBe("최근 30일");
    expect(p.keys).toHaveLength(30);
    expect(p.keys[0]).toBe("07-21");
    expect(p.keys[29]).toBe("08-19");
  });

  it("날짜 선택 = 고른 그 하루", () => {
    const p = makePeriod("date", NOW, KST, "2026-08-15");
    expect(p.label).toBe("2026-08-15");
    expect(p.keys).toEqual(["08-15"]);
  });
});

describe("buildReport — 기간별 집계", () => {
  it("[경계] 오늘 00:00 과 23:59:59 는 포함, 어제 23:59 와 내일 00:00 은 제외", () => {
    const p = makePeriod("today", NOW, KST);
    const r = buildReport(
      [
        trade(p.fromMs, { symbol: "START" }), //        오늘 00:00 정각
        trade(p.toMs, { symbol: "END" }), //            오늘 23:59:59.999
        trade(p.fromMs - 1, { symbol: "YESTERDAY" }), // 어제 마지막 순간
        trade(p.toMs + 1, { symbol: "TOMORROW" }), //    내일 첫 순간
      ],
      p,
    );
    expect(r.closed).toBe(2);
    expect(r.rows.map((x) => x.symbol).sort()).toEqual(["END", "START"]);
  });

  it("1주일은 7일 전까지 포함하고 8일 전은 뺀다", () => {
    const p = makePeriod("week", NOW, KST);
    const r = buildReport(
      [
        trade(kstMs(2026, 8, 13, 9), { symbol: "IN7" }), //  7일 전(포함)
        trade(kstMs(2026, 8, 12, 23), { symbol: "OUT8" }), // 8일 전(제외)
      ],
      p,
    );
    expect(r.rows.map((x) => x.symbol)).toEqual(["IN7"]);
  });

  it("기간 안의 여러 날 거래가 합산된다(손익·승률)", () => {
    const p = makePeriod("week", NOW, KST);
    const r = buildReport(
      [
        trade(kstMs(2026, 8, 17), { symbol: "A", entryPrice: 100, exitPrice: 110, quantity: 1, resultPct: 10 }),
        trade(kstMs(2026, 8, 18), { symbol: "B", entryPrice: 100, exitPrice: 95, quantity: 2, resultPct: -5, outcome: "loss", exitKind: "sl" }),
        trade(kstMs(2026, 8, 19), { symbol: "A", entryPrice: 100, exitPrice: 104, quantity: 1, resultPct: 4 }),
      ],
      p,
    );
    expect(r.closed).toBe(3);
    expect(r.totalPnlUsd).toBe(10 - 10 + 4); // +4
    expect(r.tpCount).toBe(2);
    expect(r.slCount).toBe(1);
    expect(r.winRate).toBe(66.7);
    // 같은 종목은 한 줄로
    expect(r.rows.find((x) => x.symbol === "A")?.trades).toBe(2);
  });

  it("1등은 기간 전체에서 가장 잘 먹은 한 방", () => {
    const p = makePeriod("month", NOW, KST);
    const r = buildReport(
      [
        trade(kstMs(2026, 8, 1), { symbol: "OLDSTAR", resultPct: 12 }),
        trade(kstMs(2026, 8, 19), { symbol: "TODAY", resultPct: 3 }),
      ],
      p,
    );
    expect(r.best?.symbol).toBe("OLDSTAR");
    expect(r.periodLabel).toBe("최근 30일");
  });

  it("연습·드라이런은 기간 조회에서도 절대 안 섞인다", () => {
    const p = makePeriod("month", NOW, KST);
    const r = buildReport(
      [
        trade(kstMs(2026, 8, 18), { symbol: "REAL" }),
        trade(kstMs(2026, 8, 18), { symbol: "MOCK", mode: "mock", resultPct: 999 }),
        trade(kstMs(2026, 8, 18), { symbol: "DRY", mode: "dryrun", resultPct: 999 }),
      ],
      p,
    );
    expect(r.rows.map((x) => x.symbol)).toEqual(["REAL"]);
  });

  it("[옛 기록 호환] 시각(ms)이 없어도 날짜 문자열로 걸러진다", () => {
    const p = makePeriod("week", NOW, KST);
    const old: ReportTrade = { ...trade(kstMs(2026, 8, 18), { symbol: "OLDREC" }), exitAtMs: undefined };
    const tooOld: ReportTrade = { ...trade(kstMs(2026, 8, 1), { symbol: "TOOOLD" }), exitAtMs: undefined };
    const r = buildReport([old, tooOld], p);
    expect(r.rows.map((x) => x.symbol)).toEqual(["OLDREC"]);
  });

  it("기간에 거래가 없으면 빈 리포트(라벨은 유지)", () => {
    const p: Period = makePeriod("date", NOW, KST, "2026-01-01");
    const r = buildReport([trade(kstMs(2026, 8, 19))], p);
    expect(r.closed).toBe(0);
    expect(r.rows).toHaveLength(0);
    expect(r.best).toBeNull();
    expect(r.periodLabel).toBe("2026-01-01");
  });
});
