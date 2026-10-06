// =============================================================================
// tests/lab-verdict.test.tsx — [v0.66.0] 결과 요약의 결론 계산·데이터 검증·가이드·결과 화면
// =============================================================================
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerdict, verifyLocal, compareWithFresh } from "../lib/lab-verdict";
import { summarizeVariants, summarizeLinkage, buildFunnel, type LabSignal, type LabBar5, type LabPath1m, type VariantRow } from "../lib/lab";
import { LabResultTab } from "../src/LabResult";
import { GuideModal, PatternScene, FunnelScene, EntryScene, StopScene, ExpectScene, LinkScene, ReadScene, ToggleScene, VerifyScene, GaugeScene } from "../src/LabGuide";
import type { LabApi } from "../src/useLab";
import type { Candle } from "../lib/indicators";
import { ToolEngine } from "../electron/tool-engine";

const MIN = 60_000;
const FIVE = 5 * MIN;
const T0 = 1_760_000_000_000 - (1_760_000_000_000 % FIVE);

const bar = (idx: number, o: number, h: number, l: number, c: number, v = 1000, e = 9): LabBar5 => ({ t: T0 + idx * FIVE, o, h, l, c, v, ho: o, hh: h, hl: l, hc: c, e });
const path = (rows: Array<[number, number, number, number, number]>): LabPath1m => rows.map(([m, o, h, l, c]) => [T0 + 9 * FIVE + m * MIN, o, h, l, c, 100]);
const tail = (start: number, o: number, h: number, l: number, c: number): Array<[number, number, number, number, number]> => Array.from({ length: 200 }, (_, i) => [start + i, o, h, l, c]);
const win = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 10.5, 10.7, 10.5, 10.68], ...tail(2, 10.68, 10.7, 10.65, 10.68)]);
const lose = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 9.8, 9.85, 9.7, 9.75], ...tail(2, 9.75, 9.8, 9.7, 9.75)]);

/** 몸통 80%·봉 크기 4.8%·거래량 3배 — 직전 5개 봉 거래량 1000, 신호 봉 3000 */
function sig(id: string, p: LabPath1m, over: Partial<LabSignal> = {}): LabSignal {
  const bars: LabBar5[] = [
    bar(0, 10, 10.1, 9.9, 10.0), bar(1, 10, 10.1, 9.9, 10.0), bar(2, 10, 10.1, 9.9, 10.0), bar(3, 10, 10.1, 9.9, 10.0), bar(4, 10, 10.1, 9.9, 10.0), bar(5, 10, 10.1, 9.9, 10.0),
    bar(6, 10.0, 10.2, 9.8, 10.02), bar(7, 10.02, 10.15, 10.0, 10.12), bar(8, 10.0, 10.5, 9.98, 10.48, 3000),
  ];
  return {
    id, symbol: id.split(":")[0], rank: 5, detectedAtMs: T0 + 20 * FIVE, backfilled: false, thinHours: false, session: "regular", eligible: true,
    rangePct2: 4.9, whyIneligible: null,
    dojiT: T0 + 6 * FIVE, c2T: T0 + 8 * FIVE, volRatio2: 3, body2: 92.3,
    second: null, c4: null, runEndT: T0 + 8 * FIVE,
    metrics: { price: 10.48, ema: 9, emaGapPct: 16, lowVsEmaPct: 10, dojiEmaDistPct: 11, dojiBodyPct: 5, atrPct: 1, emaSlopePct: 0.5, runRangePct: 6 },
    bars, path1m: p, linkage: null, linkageDone: true, complete: true,
    ...over,
  };
}

function manySignals(n: number): LabSignal[] {
  return Array.from({ length: n }, (_, i) => sig(`S${i}:${i}`, i % 3 === 0 ? lose : win));
}

describe("[v0.66.0] 결론(buildVerdict)", () => {
  const counts = (e: number) => ({ total: e + 5, eligible: e, complete: e + 5, open: 0 });
  const link = { runsWithBlock: 0, linked: 0, linkRate: null, linkedAnyEligible: 0 };

  it("인정 신호 30건 미만이면 🔴, 30~99는 🟡, 100 이상(그리고 1위 체결 30건 이상)이면 🟢", () => {
    const few = buildVerdict(summarizeVariants(manySignals(6)), counts(6), link);
    expect(few.grade).toBe("red");
    expect(few.gradeTitle).toContain("표본 부족");
    const mid = buildVerdict(summarizeVariants(manySignals(40)), counts(40), link);
    expect(mid.grade).toBe("yellow");
    const lots = buildVerdict(summarizeVariants(manySignals(120)), counts(120), link);
    expect(lots.grade).toBe("green");
    expect(lots.gradeReasons.join(" ")).toContain("우연");
  });

  it("체결이 거의 없으면 비교 불가 문구(승자 없음)와 '자료 부족' 확신도", () => {
    const v = buildVerdict([], { total: 0, eligible: 0, complete: 0, open: 0 }, link);
    expect(v.best).toBeNull();
    expect(v.entry.winner).toBeNull();
    expect(v.entry.confidence).toBe("thin");
    expect(v.headline).toContain("아직");
    expect(v.qa).toHaveLength(4);
    expect(v.qa[3].a).toBe("자료 부족");
  });

  it("합산 기대값으로 항목별 승자를 고르고, 1위 조합 문장이 나온다", () => {
    const v = buildVerdict(summarizeVariants(manySignals(45)), counts(45), link);
    expect(v.best).not.toBeNull();
    expect(v.entry.rows).toHaveLength(4);
    expect(v.stop.rows).toHaveLength(4);
    expect(v.tp.rows).toHaveLength(3);
    expect(v.entry.winner).not.toBeNull();
    expect(v.headline).toMatch(/1위|가장 나은/);
    expect(v.actions.length).toBeGreaterThan(1);
  });

  it("모든 조합이 손실이면 '수익 구조가 확인되지 않았다'고 정직하게 말한다", () => {
    const losers = Array.from({ length: 20 }, (_, i) => sig(`L${i}:${i}`, lose));
    const v = buildVerdict(summarizeVariants(losers), counts(20), link);
    expect(v.profitable).toBe(false);
    expect(v.headline).toContain("수익 구조가 확인되지 않았습니다");
  });

  it("1~2위 차이가 작으면 '비슷', 크면 '뚜렷' 확신도", () => {
    const mk = (key: string, expectancy: number): VariantRow => ({
      key, kind: "candle", entryIdx: 1, entryMode: key[0], stopMode: "D", tpPct: 1.5, signals: 20, filled: 20, fillRate: 100, closed: 20, wins: 10, losses: 10,
      winRate: 50, avgNetPct: expectancy, avgWinPct: 1, avgLossPct: -1, profitFactor: 1, expectancyPerSignal: expectancy, totalNetPct: expectancy * 20, avgMaePct: -1, avgRiskPct: 4, avgHoldMin: 10,
    });
    const close = buildVerdict([mk("AD-1.5-e1", 0.5), mk("BD-1.5-e1", 0.45)], counts(40), link);
    expect(close.entry.confidence).toBe("close");
    const clear = buildVerdict([mk("AD-1.5-e1", 0.9), mk("BD-1.5-e1", 0.2)], counts(40), link);
    expect(clear.entry.confidence).toBe("clear");
    expect(clear.entry.winner?.key).toBe("A");
  });

  it("연계 답변: 연계율에 따라 문구가 달라진다", () => {
    const v1 = buildVerdict([], { total: 30, eligible: 30, complete: 30, open: 0 }, { runsWithBlock: 20, linked: 14, linkRate: 70, linkedAnyEligible: 14 });
    expect(v1.qa[3].a).toContain("자주");
    const v2 = buildVerdict([], { total: 30, eligible: 30, complete: 30, open: 0 }, { runsWithBlock: 20, linked: 1, linkRate: 5, linkedAnyEligible: 1 });
    expect(v2.qa[3].a).toContain("거의 안");
  });
});

describe("[v0.66.0] 저장된 로우 자체 검증(verifyLocal) — 오너 실데이터에서 발견된 오류 유형을 잡아낸다", () => {
  it("정상 신호는 전 항목 통과", () => {
    const r = verifyLocal([sig("OK:1", win)], undefined, T0 + 30 * FIVE);
    expect(r.allOk).toBe(true);
    expect(r.checked).toBe(1);
    expect(r.symbols).toBe(1);
    expect(r.checks.find((c) => c.id === "contig")?.passed).toBe(1);
  });

  it("연속이 아닌 봉(가운데가 빠짐)은 contig 실패", () => {
    const s = sig("GAP:1", win);
    s.bars = s.bars.map((b, i) => (i === 7 ? { ...b, t: b.t + 5 * FIVE } : b)); // 1번째 봉이 한참 뒤로
    const r = verifyLocal([s], undefined, T0 + 30 * FIVE);
    expect(r.allOk).toBe(false);
    expect(r.checks.find((c) => c.id === "contig")?.failed).toBe(1);
  });

  it("봉 크기·인정 표시가 서로 모순이면 rule 실패(초소형 봉이 인정으로 표시된 경우)", () => {
    const s = sig("TINY:1", win, { rangePct2: 0.04, eligible: true });
    const r = verifyLocal([s], undefined, T0 + 30 * FIVE);
    expect(r.checks.find((c) => c.id === "rule")?.failed).toBe(1);
  });

  it("몸통·거래량 기록값이 저장된 봉과 다르면 body/vol 실패", () => {
    const r = verifyLocal([sig("BAD:1", win, { body2: 55, volRatio2: 9 })], undefined, T0 + 30 * FIVE);
    expect(r.checks.find((c) => c.id === "body")?.failed).toBe(1);
    expect(r.checks.find((c) => c.id === "vol")?.failed).toBe(1);
  });

  it("가격이 비정상(고가 < 종가)이면 ohlc 실패, 며칠 뒤 연계는 link 실패, 오래된 신호는 age 실패", () => {
    const s = sig("ODD:1", win);
    s.bars = s.bars.map((b, i) => (i === 8 ? { ...b, h: b.c - 0.5 } : b));
    expect(verifyLocal([s], undefined, T0 + 30 * FIVE).checks.find((c) => c.id === "ohlc")?.failed).toBe(1);
    const far = sig("FAR:1", win, { linkage: { confirmT: T0 + 8 * FIVE + 3 * 86_400_000, dojiT: 0, highT: 0, highPx: 11, prevClose: 10.5, ema: 9, emaGapPct: 10, splits: [] } });
    expect(verifyLocal([far], undefined, T0 + 30 * FIVE).checks.find((c) => c.id === "link")?.failed).toBe(1);
    const old = sig("OLD:1", win, { detectedAtMs: T0 + 80 * 3600_000 });
    expect(verifyLocal([old], undefined, T0 + 90 * 3600_000).checks.find((c) => c.id === "age")?.failed).toBe(1);
  });
});

describe("[v0.66.0] 토스 대조(compareWithFresh)", () => {
  const s = sig("CMP:1", win);
  const fresh = (over: Partial<Candle> = {}): Candle[] => [{ time: s.c2T, open: 10.0, high: 10.5, low: 9.98, close: 10.48, volume: 3000, ...over }];
  it("가격·거래량이 같으면 일치, 가격이 어긋나면 차이, 봉이 없으면 비교 불가", () => {
    expect(compareWithFresh(s, fresh()).status).toBe("match");
    expect(compareWithFresh(s, fresh({ close: 10.9 })).status).toBe("diff");
    expect(compareWithFresh(s, fresh({ volume: 9000 })).status).toBe("diff");
    expect(compareWithFresh(s, []).status).toBe("missing");
  });
});

function fakeLab(sigs: LabSignal[], mirror = false): LabApi {
  const variants = summarizeVariants(sigs);
  const summary = {
    updatedAtMs: T0,
    status: { enabled: true, rankCount: 60, dojiBodyMaxPct: 15, bodyMinPct: 60, volRatioMin: 1.5, minRangePct: 0.5, note: "테스트 안내", scanning: false, lastTickAtMs: T0, lastTickDurMs: 1000, lastScanned: 10, lastError: null, lastSkip: null, startedAtMs: T0, nextTickAtMs: T0 + FIVE, totalSignals: sigs.length, params: {} },
    funnel: buildFunnel({ a: 0, b: 1, c: 3, d: 4 }, sigs),
    linkage: summarizeLinkage(sigs),
    variants,
    signals: sigs.map((s) => ({ id: s.id, symbol: s.symbol, rank: s.rank, session: s.session, thinHours: s.thinHours, backfilled: s.backfilled, eligible: s.eligible, whyIneligible: s.whyIneligible ?? null, rangePct2: s.rangePct2 ?? null, c2T: s.c2T, dojiT: s.dojiT, volRatio2: s.volRatio2, body2: s.body2, secondQualified: false, c4Block: null, emaGapPct: 16, atrPct: 1, price: 10.48, linked: false, complete: true, ref: null })),
    refKey: "DD-1.5-e1",
    counts: { total: sigs.length, eligible: sigs.filter((x) => x.eligible).length, complete: sigs.length, open: 0 },
  };
  return { summary, filter: {}, setFilter: () => undefined, busy: false, msg: "", setMsg: () => undefined, refresh: async () => undefined, saveSettings: async () => undefined, scanNow: async () => undefined, reset: async () => undefined, download: async () => undefined, isMirror: mirror } as unknown as LabApi;
}

describe("[v0.66.0] 결과 요약 화면·가이드 렌더링", () => {
  it("결과 요약: 신호등·결론·KPI·항목별 막대·연계 흐름·답변판·다음 할 일·검증이 나온다", () => {
    const html = renderToString(<LabResultTab lab={fakeLab(manySignals(45))} />);
    for (const t of ["결과 요약", "참고용", "지금의 결론", "누적 신호", "매수 방식", "손절 방식", "익절 목표", "삼분할 이어짐", "카일 질문 답변판", "다음에 할 일", "데이터 검증 실행", "테스트 안내", "❓ 가이드"]) {
      expect(html).toContain(t);
    }
    expect(html).toContain("data-guide=\"result-grade\"");
  });

  it("결과 요약(폰 미러): 검증 버튼 대신 PC 안내", () => {
    const html = renderToString(<LabResultTab lab={fakeLab(manySignals(10), true)} />);
    expect(html).toContain("데이터 검증은 PC 앱에서 실행하세요");
    expect(html).not.toContain("데이터 검증 실행");
  });

  it("요약이 없으면 안내만", () => {
    const lab = { ...fakeLab([]), summary: null } as unknown as LabApi;
    expect(renderToString(<LabResultTab lab={lab} />)).toContain("불러오는 중");
  });

  it("가이드 패널: 열려 있으면 단계·그림·버튼이 나오고, 닫혀 있으면 아무것도 안 나온다", () => {
    for (const tab of ["result", "live", "signals", "compare"] as const) {
      const html = renderToString(<GuideModal tab={tab} open={true} onClose={() => undefined} />);
      expect(html).toContain("🎓 가이드");
      expect(html).toContain("<svg");
      expect(html).toContain("다음 →");
    }
    expect(renderToString(<GuideModal tab="live" open={false} onClose={() => undefined} />)).toBe("");
  });

  it("모든 애니메이션 장면이 오류 없이 그려진다", () => {
    const scenes = [<PatternScene key="1" />, <FunnelScene key="2" />, <EntryScene key="3" />, <StopScene key="4" />, <ExpectScene key="5" />, <LinkScene key="6" />, <ReadScene key="7" cols={["a", "b", "c"]} />, <ToggleScene key="8" />, <VerifyScene key="9" />, <GaugeScene key="10" />];
    for (const s of scenes) expect(renderToString(s)).toContain("<svg");
  });
});

describe("[v0.66.0] 엔진 verifyLab", () => {
  it("저장된 로우가 없어도 구조를 돌려주고(local 0건), 토스 대조는 표본 없음 안내", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ver-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const r = await eng.verifyLab(5);
      expect(r.local.checked).toBe(0);
      expect(r.local.allOk).toBe(true);
      expect(r.toss?.requested).toBe(0);
      expect(r.toss?.error).toContain("표본");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
