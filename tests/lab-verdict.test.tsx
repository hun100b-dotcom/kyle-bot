// =============================================================================
// tests/lab-verdict.test.tsx — [v0.66.0] 결과 요약의 결론 계산·데이터 검증·가이드·결과 화면
// =============================================================================
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerdict, verifyLocal, compareWithFresh, buildAssessment, bootstrapCi, holdoutCheck, concentrationOf, contributionVector, GATE_THRESHOLDS } from "../lib/lab-verdict";
import { summarizeVariants, summarizeLinkage, buildFunnel, simulateSignal, breakdownBy, LAB_PARAMS_DEFAULT, type LabSignal, type LabBar5, type LabPath1m, type VariantRow } from "../lib/lab";
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
    status: { enabled: true, rankCount: 60, dojiBodyMaxPct: 15, bodyMinPct: 60, volRatioMin: 1.5, minRangePct: 0.5, note: "테스트 안내", verify: { localAt: T0, localOk: true, localFailed: [], tossAt: T0, tossRequested: 3, tossMatched: 3 }, feePct: null, collect: { scans: 12, activeHours: 1, paused: false, pauseReason: null, resumesAtMs: null }, scanning: false, lastTickAtMs: T0, lastTickDurMs: 1000, lastScanned: 10, lastError: null, lastSkip: null, startedAtMs: T0, nextTickAtMs: T0 + FIVE, totalSignals: sigs.length, params: {} },
    funnel: buildFunnel({ a: 0, b: 1, c: 3, d: 4 }, sigs),
    linkage: summarizeLinkage(sigs),
    variants,
    signals: sigs.map((s) => ({ id: s.id, symbol: s.symbol, rank: s.rank, session: s.session, thinHours: s.thinHours, backfilled: s.backfilled, eligible: s.eligible, whyIneligible: s.whyIneligible ?? null, rangePct2: s.rangePct2 ?? null, c2T: s.c2T, dojiT: s.dojiT, volRatio2: s.volRatio2, body2: s.body2, secondQualified: false, c4Block: null, emaGapPct: 16, atrPct: 1, price: 10.48, linked: false, complete: true, ref: null })),
    refKey: "DD-1.5-e1",
    counts: { total: sigs.length, eligible: sigs.filter((x) => x.eligible).length, complete: sigs.length, open: 0 },
  };
  return { summary, filter: {}, setFilter: () => undefined, busy: false, msg: "", setMsg: () => undefined, refresh: async () => undefined, saveSettings: async () => undefined, scanNow: async () => undefined, reset: async () => undefined, download: async () => undefined, isMirror: mirror, isWeb: mirror } as unknown as LabApi;
}

describe("[v0.66.0] 결과 요약 화면·가이드 렌더링", () => {
  it("결과 요약: 신호등·결론·KPI·항목별 막대·연계 흐름·답변판·다음 할 일·검증이 나온다", () => {
    const sigs45 = manySignals(45);
    const html = renderToString(<LabResultTab lab={fakeLab(sigs45)} initialAssessment={buildAssessment(sigs45, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: T0 + 90 * FIVE })} />);
    for (const t of ["결과 요약", "실시간 포착", "백필 포함", "허점 점검", "실매매 전환 게이트", "자동 검증", "참고용", "지금의 결론", "누적 신호", "매수 방식", "손절 방식", "익절 목표", "삼분할 이어짐", "카일 질문 답변판", "다음에 할 일", "데이터 검증 실행", "테스트 안내", "❓ 가이드"]) {
      expect(html).toContain(t);
    }
    expect(html).toContain("data-guide=\"result-grade\"");
  });

  it("결과 요약(폰 미러): 검증 버튼 대신 PC 안내", () => {
    const sigs10 = manySignals(10);
    const lab = fakeLab(sigs10, true);
    (lab.summary as unknown as { assessment: unknown }).assessment = buildAssessment(sigs10, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: T0 + 90 * FIVE });
    const html = renderToString(<LabResultTab lab={lab} />);
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

// =============================================================================
// [v0.67.0] 허점 점검(신뢰구간·시간 분할·스트레스·집중도·지연)·실매매 전환 게이트·운영 안전
// =============================================================================
describe("[v0.67.0] 허점 점검 계산", () => {
  it("부트스트랩 신뢰구간: 결정적(같은 입력→같은 결과)이고, 전부 플러스면 하한>0, 섞여 있으면 0을 걸친다", () => {
    const allPos = Array.from({ length: 30 }, (_, i) => 1 + (i % 3) * 0.1);
    const a = bootstrapCi(allPos, 500, 7)!;
    const b = bootstrapCi(allPos, 500, 7)!;
    expect(a).toEqual(b);
    expect(a.lo).toBeGreaterThan(0);
    const mixed = Array.from({ length: 30 }, (_, i) => (i % 2 ? 2 : -2));
    const m = bootstrapCi(mixed, 500, 7)!;
    expect(m.lo).toBeLessThan(0);
    expect(m.hi).toBeGreaterThan(0);
    expect(bootstrapCi([1, 2, 3], 100, 1)).toBeNull(); // 5건 미만
  });

  it("집중도: 종목 수·거래일 수·최다 종목 비중", () => {
    const mk = (sym: string, day: number, i: number) => sig(`${sym}:${i}`, win, { symbol: sym, c2T: T0 + day * 86_400_000 + i });
    const c = concentrationOf([mk("AAA", 0, 1), mk("AAA", 0, 2), mk("AAA", 1, 3), mk("BBB", 2, 4)]);
    expect(c.symbols).toBe(2);
    expect(c.days).toBe(3);
    expect(c.topSymbol).toBe("AAA");
    expect(c.topShare).toBe(0.75);
  });

  it("시간 분할 검증: 앞 60%로 고른 조합을 뒤 40%에서 다시 본다(표본이 적으면 판단 불가)", () => {
    // 시각을 통째로 옮긴 신호(봉·1분봉 경로·기준 시각이 모두 같이 이동해야 시뮬레이션이 성립한다)
    const shifted = (i: number): LabSignal => {
      const d = i * 3600_000;
      const base = sig(`H${i}:${i}`, win);
      return { ...base, dojiT: base.dojiT + d, c2T: base.c2T + d, runEndT: base.runEndT + d, bars: base.bars.map((b) => ({ ...b, t: b.t + d })), path1m: base.path1m.map((p) => [p[0] + d, p[1], p[2], p[3], p[4], p[5]] as [number, number, number, number, number, number]) };
    };
    const sigs = Array.from({ length: 30 }, (_, i) => shifted(i));
    const h = holdoutCheck(sigs, LAB_PARAMS_DEFAULT, 5);
    expect(h.trainN).toBe(18);
    expect(h.testN).toBe(12);
    expect(h.key).not.toBeNull();
    expect(h.testFilled).toBeGreaterThan(0);
    expect(holdoutCheck(sigs.slice(0, 6), LAB_PARAMS_DEFAULT).holds).toBeNull();
  });

  it("기여값 벡터: 체결 청산은 순손익, 미체결은 0", () => {
    const v = contributionVector([sig("W:1", win), sig("N:1", path(tail(0, 10.9, 11, 10.8, 10.9)))], "BC-1.5-e1", LAB_PARAMS_DEFAULT);
    expect(v).toHaveLength(2);
    expect(v[0]).toBeGreaterThan(0);
    expect(v[1]).toBe(0);
  });

  it("변형 성적표에 스트레스·최악 1회·최대 낙폭이 들어간다(스트레스 = 체결 건마다 추가 비용을 뺀 기대값)", () => {
    const sigs = [sig("W:1", win), sig("L:1", lose), sig("W:2", win)];
    const r = summarizeVariants(sigs, {}, { ...LAB_PARAMS_DEFAULT, stressPct: 0.5 }).find((x) => x.key === "BC-1.5-e1")!;
    expect(r.stressExpectancy).toBeCloseTo(((r.totalNetPct as number) - 0.5 * r.closed) / r.signals, 1);
    expect(r.worstNetPct).toBeLessThan(0);
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
  });

  it("주문 지연(latencyMin)을 주면 가상 체결이 그만큼 늦게 시작한다 — 지연 없이는 체결되던 것이 안 될 수 있다", () => {
    // 첫 1분봉에서만 지정가 아래로 내려오고 그 뒤로는 오른다
    const p = path([[0, 10.5, 10.55, 10.46, 10.5], ...tail(1, 10.7, 10.8, 10.7, 10.75)]);
    const s = sig("LAT:1", p);
    expect(simulateSignal(s, LAB_PARAMS_DEFAULT).find((t) => t.key === "BC-1.5-e1")!.fillPx).toBe(10.48);
    const late = simulateSignal(s, { ...LAB_PARAMS_DEFAULT, latencyMin: 2 }).find((t) => t.key === "BC-1.5-e1")!;
    expect(late.status).toBe("unfilled"); // 2분 뒤엔 이미 가격이 달아남
  });

  it("거래량 순위별 분해는 백필 신호를 제외한다(오늘 순위는 미래 정보라 선택 편향)", () => {
    const sigs = [sig("R1:1", win, { rank: 3 }), sig("R2:2", win, { rank: 3, backfilled: true })];
    const rows = breakdownBy(sigs, "BC-1.5-e1", "rank");
    expect(rows.reduce((s, r) => s + r.n, 0)).toBe(1);
    const sess = breakdownBy(sigs, "BC-1.5-e1", "session");
    expect(sess.reduce((s, r) => s + r.n, 0)).toBe(2);
  });
});

describe("[v0.67.0] 종합 평가·실매매 전환 게이트", () => {
  const verifyOk = { localOk: true, localAt: T0 + 60 * FIVE, tossRate: 1, tossAt: T0 + 60 * FIVE };
  const NOW = T0 + 61 * FIVE;

  it("신호가 적으면 🔴 no — 게이트 대부분 미통과, 실매매 금지 문구", () => {
    const a = buildAssessment(manySignals(8), LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW, verify: verifyOk });
    expect(a.readiness).toBe("no");
    expect(a.gates).toHaveLength(12);
    expect(a.gatesPassed).toBeLessThan(a.gates.length);
    expect(a.readinessText).toContain("아직 실매매를 검토할 단계가 아닙니다");
    expect(a.gates.find((g) => g.id === "realtime")?.ok).toBe(false);
  });

  it("백필 신호는 '실시간 인정 신호' 게이트에 세지 않는다", () => {
    const bf = Array.from({ length: 120 }, (_, i) => sig(`B${i}:${i}`, win, { backfilled: true, c2T: T0 + i * 3600_000 }));
    const a = buildAssessment(bf, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW, verify: verifyOk });
    expect(a.counts.realtimeEligible).toBe(0);
    expect(a.counts.backfilledEligible).toBe(120);
    expect(a.gates.find((g) => g.id === "realtime")?.ok).toBe(false);
    // 실시간만 보면 신호가 0건
    expect(buildAssessment(bf, LAB_PARAMS_DEFAULT, { realtimeOnly: true, nowMs: NOW }).verdict.eligible).toBe(0);
  });

  it("검증 기록이 없으면 verify 게이트는 '확인 불가(null)', 24시간 넘은 검증은 실패", () => {
    const sigs = manySignals(10);
    expect(buildAssessment(sigs, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW, verify: null }).gates.find((g) => g.id === "verify")?.ok).toBeNull();
    const stale = { ...verifyOk, localAt: NOW - 25 * 3600_000, tossAt: NOW - 25 * 3600_000 };
    expect(buildAssessment(sigs, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW, verify: stale }).gates.find((g) => g.id === "verify")?.ok).toBe(false);
    const failing = { ...verifyOk, localOk: false };
    expect(buildAssessment(sigs, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW, verify: failing }).gates.find((g) => g.id === "verify")?.ok).toBe(false);
  });

  it("지연 게이트: 실측 중앙값이 가정보다 길면 실패, 짧으면 통과, 표본 10건 미만이면 확인 불가", () => {
    const mk = (n: number, latMin: number) => Array.from({ length: n }, (_, i) => sig(`LT${i}:${i}`, win, { detectedAtMs: T0 + 8 * FIVE + FIVE + latMin * 60_000 }));
    const slow = buildAssessment(mk(12, 4), { ...LAB_PARAMS_DEFAULT, latencyMin: 2 }, { realtimeOnly: false, nowMs: NOW });
    expect(slow.latency.medianMin).toBe(4);
    expect(slow.gates.find((g) => g.id === "latency")?.ok).toBe(false);
    const fast = buildAssessment(mk(12, 1), { ...LAB_PARAMS_DEFAULT, latencyMin: 2 }, { realtimeOnly: false, nowMs: NOW });
    expect(fast.gates.find((g) => g.id === "latency")?.ok).toBe(true);
    expect(buildAssessment(mk(5, 1), { ...LAB_PARAMS_DEFAULT, latencyMin: 2 }, { realtimeOnly: false, nowMs: NOW }).gates.find((g) => g.id === "latency")?.ok).toBeNull();
  });

  it("규칙 일관성: 판정 기준이 다른 신호가 섞이면 실패", () => {
    const a = sig("RU1:1", win, { rule: { d: 15, b: 60, v: 1.5, r: 0.5 } });
    const b = sig("RU2:2", win, { rule: { d: 15, b: 60, v: 1.5, r: 0 } });
    expect(buildAssessment([a, a], LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW }).gates.find((g) => g.id === "rule")?.ok).toBe(true);
    const mixed = buildAssessment([a, b], LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: NOW });
    expect(mixed.ruleVersions).toBe(2);
    expect(mixed.gates.find((g) => g.id === "rule")?.ok).toBe(false);
  });

  it("임계값은 보수적으로 고정되어 있다(실시간 100건·10거래일·15종목·체결 30건)", () => {
    expect(GATE_THRESHOLDS.realtimeEligible).toBe(100);
    expect(GATE_THRESHOLDS.days).toBe(10);
    expect(GATE_THRESHOLDS.symbols).toBe(15);
    expect(GATE_THRESHOLDS.bestFilled).toBe(30);
  });
});

describe("[v0.67.0] 엔진 운영 안전 — 자동 검증·양보·초기화 경합·마감", () => {
  const clear = () => { for (const k of Object.keys(process.env)) if (k.startsWith("LAB_") || k.startsWith("AUTO_SCAN_")) delete process.env[k]; };

  it("스캔이 끝나면 저장된 로우 재계산 검증이 자동으로 돌고 상태에 반영된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-av-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      type I = { labSignals: LabSignal[]; labAutoVerify: () => Promise<void> };
      const x = eng as unknown as I;
      x.labSignals = [sig("AV:1", win, { detectedAtMs: Date.now(), c2T: Date.now() - 3600_000 })];
      expect(eng.getLabStatus().verify.localAt).toBeNull();
      await x.labAutoVerify();
      const v = eng.getLabStatus().verify;
      expect(v.localAt).not.toBeNull();
      expect(typeof v.localOk).toBe("boolean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clear();
    }
  });

  it("자동매매 사이클이 진행 중이면 연구소 스캔은 양보한다(실주문 경로 우선)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-av-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      (eng as unknown as { autoTradeTickBusy: boolean }).autoTradeTickBusy = true;
      const before = eng.getLabStatus().lastTickAtMs;
      await (eng as unknown as { labScanOnce: (m?: boolean) => Promise<void> }).labScanOnce(false);
      const st = eng.getLabStatus();
      expect(st.lastSkip).toContain("양보");
      expect(st.lastTickAtMs).toBe(before); // 스캔이 실제로 돌지 않음
      const deferTimer = (eng as unknown as { labDeferTimer: ReturnType<typeof setTimeout> | null }).labDeferTimer;
      if (deferTimer) clearTimeout(deferTimer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clear();
    }
  });

  it("초기화하면 진행 중이던 스캔 결과가 뒤늦게 다시 쓰이지 않는다(세대 번호)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-av-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      type I = { labGen: number; labSignals: LabSignal[] };
      const x = eng as unknown as I;
      const g0 = x.labGen;
      eng.labReset();
      expect(x.labGen).toBe(g0 + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clear();
    }
  });

  it("갱신이 끊겨 영원히 '진행 중'으로 남던 신호는 관찰 구간이 지나면 마감된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-av-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      type I = { labSignals: LabSignal[]; labFinalizeStale: (n: number) => void };
      const x = eng as unknown as I;
      x.labSignals = [sig("ST:1", win, { complete: false, linkageDone: false })];
      x.labFinalizeStale(T0 + 8 * FIVE + 60 * 60_000); // 1시간 뒤 — 아직 관찰 중
      expect(x.labSignals[0].complete).toBe(false);
      x.labFinalizeStale(T0 + 8 * FIVE + 24 * 3600_000); // 하루 뒤 — 마감
      expect(x.labSignals[0].complete).toBe(true);
      expect(x.labSignals[0].linkageDone).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clear();
    }
  });

  it("종합 평가 API: 기본은 실시간만, 구조(게이트 12개)와 가정(지연 2분·스트레스 0.3%)을 돌려준다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-av-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const a = eng.getLabAssessment();
      expect(a.scope).toBe("realtime");
      expect(a.gates).toHaveLength(12);
      expect(a.latency.assumedMin).toBe(2);
      expect(a.stress).toBeNull(); // 비교할 조합이 없으면 null
      expect(eng.getLabAssessment(false).scope).toBe("all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clear();
    }
  });
});

// =============================================================================
// [v0.68.0] 오너 화면의 "데이터 검증 경고"는 검증기 자체의 오탐이었다 — 실제 저장 파일에서 재현해 고친 것을 고정
// =============================================================================
describe("[v0.68.0] 검증기 오탐 수정(실제 데이터에서 발견) + 수집 속도 계산", () => {
  it("직전 5개 봉이 이어지지 않아 거래량 배수가 null로 저장된 신호는 다시 계산해도 null이면 '일치'다", () => {
    const s = sig("NULLVOL:1", win, { volRatio2: null, eligible: false, whyIneligible: "volume" });
    // 직전 봉 간격을 어긋나게 해 재계산도 null이 되게 한다
    s.bars = s.bars.map((b, i) => (i === 3 ? { ...b, t: b.t + 2 * MIN } : b));
    const r = verifyLocal([s], undefined, T0 + 30 * FIVE);
    expect(r.checks.find((c) => c.id === "vol")?.failed).toBe(0);
  });

  it("고저폭이 호가 몇 틱뿐인 봉은 소수 4자리 반올림 때문에 몸통 비율이 흔들려도 허용한다(그러나 큰 차이는 여전히 실패)", () => {
    const s = sig("TICK:1", win);
    s.bars = s.bars.map((b, i) => (i === 8 ? { ...b, ho: 2.25, hh: 2.2503, hl: 2.2497, hc: 2.2499 } : b));
    // 실제 비율 = |2.2499-2.25| / 0.0006 = 16.7% — 기록값 17.5%(반올림 전 값이었다고 가정)와 차이 0.8%p는 반올림 오차 범위
    expect(verifyLocal([{ ...s, body2: 17.5 }], undefined, T0 + 30 * FIVE).checks.find((c) => c.id === "body")?.failed).toBe(0);
    expect(verifyLocal([{ ...s, body2: 60 }], undefined, T0 + 30 * FIVE).checks.find((c) => c.id === "body")?.failed).toBe(1);
  });

  it("신호 직후 거래가 20분 뒤에 재개되는 종목은 경로 시작 지연 허용(30분 이내)", () => {
    const delayed = win.map((p) => [p[0] + 20 * MIN, p[1], p[2], p[3], p[4], p[5]] as [number, number, number, number, number, number]);
    expect(verifyLocal([sig("DLY:1", delayed)], undefined, T0 + 60 * FIVE).checks.find((c) => c.id === "path")?.failed).toBe(0);
    const tooLate = win.map((p) => [p[0] + 45 * MIN, p[1], p[2], p[3], p[4], p[5]] as [number, number, number, number, number, number]);
    expect(verifyLocal([sig("DLY:2", tooLate)], undefined, T0 + 90 * FIVE).checks.find((c) => c.id === "path")?.failed).toBe(1);
  });

  it("수집 속도: 활성 시간당 실시간 인정 신호 → 목표 100건까지 예상 일수(하루 활성 12시간)", () => {
    const rt = Array.from({ length: 4 }, (_, i) => sig(`P${i}:${i}`, win));
    const a = buildAssessment(rt, LAB_PARAMS_DEFAULT, { realtimeOnly: true, nowMs: T0 + 61 * FIVE, collect: { activeMs: 8 * 3_600_000, scans: 96 } });
    expect(a.pace.activeHours).toBe(8);
    expect(a.pace.perHour).toBe(0.5);
    expect(a.pace.etaDays).toBe(16); // (100−4) ÷ (0.5×12)
    expect(a.pace.scans).toBe(96);
    const none = buildAssessment(rt, LAB_PARAMS_DEFAULT, { realtimeOnly: true, nowMs: T0 + 61 * FIVE, collect: { activeMs: 1_000, scans: 1 } });
    expect(none.pace.perHour).toBeNull(); // 활성 1시간 미만이면 속도 계산 안 함
  });
});

// =============================================================================
// [v0.69.0] 데이터 신선도 띠(모든 연구소 탭) + % 설명
// =============================================================================
import { LabFreshBar, LabLiveTab, LabSignalsTab } from "../src/LabTabs";

describe("[v0.69.0] 데이터 신선도 띠 — 오래된 데이터를 실시간처럼 보여 주지 않는다", () => {
  const labWith = (patch: Record<string, unknown>) => {
    const lab = fakeLab(manySignals(3));
    const st = (lab.summary as unknown as { status: Record<string, unknown> }).status;
    Object.assign(st, patch);
    return lab;
  };

  it("기록이 꺼져 있으면 '새 데이터가 쌓이지 않습니다'", () => {
    expect(renderToString(<LabFreshBar lab={labWith({ enabled: false })} />)).toContain("기록 꺼짐");
  });

  it("휴무 시간이면 정상임을 말하고 재개 시각을 보여 준다", () => {
    const html = renderToString(<LabFreshBar lab={labWith({ enabled: true, collect: { scans: 5, activeHours: 1, paused: true, pauseReason: "지정된 휴무 시간대(05:00~17:00 KST)", resumesAtMs: Date.now() + 3600_000 } })} />);
    expect(html).toContain("수집 휴무 시간");
    expect(html).toContain("재개");
  });

  it("켜져 있고 휴무도 아닌데 마지막 스캔이 15분 넘게 없으면 경고(앱 꺼짐·멈춤 가능)", () => {
    const html = renderToString(<LabFreshBar lab={labWith({ enabled: true, scanning: false, lastTickAtMs: Date.now() - 3 * 3600_000, collect: { scans: 5, activeHours: 1, paused: false, pauseReason: null, resumesAtMs: null } })} />);
    expect(html).toContain("스캔이");
    expect(html).toContain("앱이 꺼져 있었거나");
  });

  it("정상 수집 중이면 ✅, 그리고 실시간 포착/백필 건수와 '실시간' 정의를 항상 밝힌다", () => {
    const html = renderToString(<LabFreshBar lab={labWith({ enabled: true, scanning: false, lastTickAtMs: Date.now() - 2 * 60_000, collect: { scans: 5, activeHours: 1, paused: false, pauseReason: null, resumesAtMs: null } })} />);
    expect(html).toContain("실시간으로 수집 중");
    expect(html).toContain("실시간 포착");
    expect(html).toContain("10분 안에 발견");
  });

  it("연구소 세 탭과 결과 요약 모두에 신선도 띠가 붙고, 결과 요약엔 % 설명이 있다", () => {
    const lab = fakeLab(manySignals(3));
    expect(renderToString(<LabLiveTab lab={lab} />)).toContain("lab-fresh");
    for (const el of [<LabLiveTab key="a" lab={lab} />, <LabSignalsTab key="b" lab={lab} />]) {
      expect(renderToString(el)).toContain("lab-fresh");
    }
    const sigs = manySignals(10);
    const html = renderToString(<LabResultTab lab={fakeLab(sigs)} initialAssessment={buildAssessment(sigs, LAB_PARAMS_DEFAULT, { realtimeOnly: false, nowMs: T0 + 90 * FIVE })} />);
    expect(html).toContain("lab-fresh");
    expect(html).toContain("계좌 수익률이 아닙니다");
    expect(html).toContain("신호당 기대값(%)");
  });
});
