// =============================================================================
// tests/lab-ui.test.tsx — [v0.65.0] 매매연구소 화면 스모크 테스트(서버 렌더링)
// -----------------------------------------------------------------------------
// 브라우저 없이 react-dom/server로 세 탭과 차트를 그려 본다 — 렌더 중 예외(없는 값 접근·타입 가정 오류)가
// 없는지, 핵심 문구·숫자가 화면에 나오는지를 확인한다. (클릭·네트워크 동작은 검증하지 않는다.)
// =============================================================================
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { LabLiveTab, LabSignalsTab, LabCompareTab, CandleChart } from "../src/LabTabs";
import type { LabApi } from "../src/useLab";
import { summarizeVariants, summarizeLinkage, buildFunnel, simulateSignal, type LabSignal, type LabBar5, type LabPath1m } from "../lib/lab";

const MIN = 60_000;
const FIVE = 5 * MIN;
const T0 = 1_760_000_000_000 - (1_760_000_000_000 % FIVE);

const bar = (idx: number, o: number, h: number, l: number, c: number, e = 9): LabBar5 => ({ t: T0 + idx * FIVE, o, h, l, c, v: 1000, ho: o, hh: h, hl: l, hc: c, e });
const path = (rows: Array<[number, number, number, number, number]>): LabPath1m => rows.map(([m, o, h, l, c]) => [T0 + 9 * FIVE + m * MIN, o, h, l, c, 100]);

function sig(id: string, p: LabPath1m, over: Partial<LabSignal> = {}): LabSignal {
  return {
    id, symbol: id.split(":")[0], rank: 5, detectedAtMs: T0, backfilled: false, thinHours: false, session: "regular", eligible: true,
    dojiT: T0 + 6 * FIVE, c2T: T0 + 8 * FIVE, volRatio2: 3, body2: 80,
    second: { t: T0 + 9 * FIVE, qualified: true, body: 75, volRatio: 2.5 },
    c4: { t: T0 + 10 * FIVE, block: true }, runEndT: T0 + 10 * FIVE,
    metrics: { price: 10.48, ema: 9, emaGapPct: 16, lowVsEmaPct: 10, dojiEmaDistPct: 11, dojiBodyPct: 5, atrPct: 1, emaSlopePct: 0.5, runRangePct: 6 },
    bars: [bar(6, 10, 10.1, 9.9, 10.02), bar(7, 10.02, 10.15, 10.0, 10.12), bar(8, 10.0, 10.5, 9.98, 10.48), bar(9, 10.48, 11.0, 10.45, 10.95), bar(10, 10.95, 11.2, 10.9, 11.1)],
    path1m: p, linkage: null, linkageDone: true, complete: true,
    ...over,
  };
}

const win = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 10.5, 10.7, 10.5, 10.68], ...Array.from({ length: 200 }, (_, i) => [i + 2, 10.68, 10.7, 10.65, 10.68] as [number, number, number, number, number])]);
const lose = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 9.8, 9.85, 9.7, 9.75], ...Array.from({ length: 200 }, (_, i) => [i + 2, 9.75, 9.8, 9.7, 9.75] as [number, number, number, number, number])]);
const sigs = [sig("AAA:1", win), sig("BBB:2", lose), sig("CCC:3", win, { eligible: false, volRatio2: 1.1 })];

function fakeLab(over: Partial<LabApi> = {}, mirror = false): LabApi {
  const variants = summarizeVariants(sigs);
  const status: LabStatus = {
    enabled: true, rankCount: 60, dojiBodyMaxPct: 15, bodyMinPct: 60, volRatioMin: 1.5, scanning: false, lastTickAtMs: T0, lastTickDurMs: 42_000,
    lastScanned: 58, lastError: null, lastSkip: null, startedAtMs: T0, nextTickAtMs: T0 + FIVE, totalSignals: sigs.length,
    params: { dojiBodyMaxPct: 15, bodyMinPct: 60, volRatioMin: 1.5, volLookback: 5, fillWindowMin: 15, linkFillWindowMin: 10, horizonMin: 180, feeRoundTripPct: 0.2, fixedSlPct: 10, emaBufferPct: 1.5 },
  };
  const summary: LabSummary = {
    updatedAtMs: T0,
    status,
    funnel: buildFunnel({ a: 0, b: 1, c: 3, d: 4, e: 4 }, sigs),
    linkage: summarizeLinkage(sigs),
    variants,
    signals: sigs.map((s) => {
      const t = simulateSignal(s).find((x) => x.key === "DD-1.5-e1");
      return {
        id: s.id, symbol: s.symbol, rank: s.rank, session: s.session, thinHours: s.thinHours, backfilled: s.backfilled, eligible: s.eligible,
        c2T: s.c2T, dojiT: s.dojiT, volRatio2: s.volRatio2, body2: s.body2, secondQualified: true, c4Block: true, emaGapPct: 16, atrPct: 1,
        price: s.metrics.price, linked: false, complete: true,
        ref: t ? { key: t.key, status: t.status, netPct: t.netPct ?? null, fillPx: t.fillPx ?? null, exitPx: t.exitPx ?? null, note: t.note ?? null } : null,
      };
    }),
    refKey: "DD-1.5-e1",
    counts: { total: 3, eligible: 2, complete: 3, open: 0 },
  };
  return {
    summary, filter: { includeIneligible: false, includeThin: false, includeBackfilled: true, refKey: "DD-1.5-e1" },
    setFilter: () => undefined, busy: false, msg: "", setMsg: () => undefined, refresh: async () => undefined,
    saveSettings: async () => undefined, scanNow: async () => undefined, reset: async () => undefined, download: async () => undefined,
    isMirror: mirror, isWeb: mirror, ...over,
  } as LabApi;
}

describe("[v0.65.0] 매매연구소 화면 렌더링", () => {
  it("신호기록 현황: 상태·설정·깔때기·규칙 설명·내보내기가 나온다", () => {
    const html = renderToString(<LabLiveTab lab={fakeLab()} />);
    expect(html).toContain("신호기록 현황"); // [v0.99.0] 탭 제목을 실제 탭 이름(TAB_LABEL.labLive)과 통일
    expect(html).toContain("기록 중");
    expect(html).toContain("거래량 순위 몇 위까지 탐색");
    expect(html).toContain("신호 깔때기");
    expect(html).toContain("기록 규칙");
    expect(html).toContain("신호 로우 CSV");
    expect(html).toContain("30건 미만"); // 인정 신호 2건 → 표본 부족 경고
  });

  it("신호기록 현황(폰 미러): 내보내기·초기화·지금 스캔은 안 보이고 안내가 나온다", () => {
    const html = renderToString(<LabLiveTab lab={fakeLab({}, true)} />);
    expect(html).toContain("PC가 올려 둔 요약");
    expect(html).not.toContain("신호 로우 CSV");
    expect(html).not.toContain("데이터 초기화");
  });

  it("신호 로우: 종목·결과가 줄로 나오고, 비인정 신호도 목록엔 있다(흐리게)", () => {
    const html = renderToString(<LabSignalsTab lab={fakeLab()} />);
    expect(html).toContain("AAA");
    expect(html).toContain("BBB");
    expect(html).toContain("CCC");
    expect(html).toContain("기준 변형");
    expect(html).toMatch(/익절|손절|미체결/);
  });

  it("전략 비교: 변형 순위표·매수×손절 매트릭스·연계 요약이 나온다", () => {
    const html = renderToString(<LabCompareTab lab={fakeLab()} />);
    expect(html).toContain("전략 비교");
    expect(html).toContain("매수 방식 × 손절 방식");
    expect(html).toContain("전체 변형 순위");
    expect(html).toContain("캔들 → 삼분할 연계");
    expect(html).toContain("신호당 기대값");
  });

  it("전략 비교(폰 미러): 매트릭스는 숨기고 안내만", () => {
    const html = renderToString(<LabCompareTab lab={fakeLab({}, true)} />);
    expect(html).not.toContain("매수 방식 × 손절 방식");
    expect(html).toContain("상위 변형만");
  });

  it("요약이 없으면(PC가 아직 안 올림) 안내 문구", () => {
    const html = renderToString(<LabLiveTab lab={fakeLab({ summary: null }, true)} />);
    expect(html).toContain("PC가 아직 연구소 데이터를 올리지 않았습니다");
  });

  it("캔들 차트(SVG): 캔들·EMA·마커·가상 매매 선이 그려진다", () => {
    const s = sigs[0];
    const trade = simulateSignal(s).find((t) => t.key === "BC-1.5-e1")!;
    const html = renderToString(<CandleChart sig={s as unknown as LabSignalFull} trade={trade as unknown as LabTrade} ha={false} />);
    expect(html).toContain("<svg");
    expect(html).toContain("lab-ema");
    expect(html).toContain("lab-line-entry");
    expect(html).toContain("도지");
    expect(html).toContain("4▲");
    const ha = renderToString(<CandleChart sig={s as unknown as LabSignalFull} trade={null} ha={true} />);
    expect(ha).toContain("<svg");
  });
});
