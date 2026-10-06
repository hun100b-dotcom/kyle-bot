// =============================================================================
// tests/lab.test.ts — [v0.65.0] 매매연구소(lib/lab.ts): 신호 탐지·가상 체결·집계 규칙 고정
// =============================================================================
import { describe, it, expect } from "vitest";
import {
  emaSeries,
  detectRuns,
  findLinkage,
  simulateSignal,
  summarizeVariants,
  breakdownBy,
  buildFunnel,
  summarizeLinkage,
  combinedScenario,
  signalsToCsv,
  tradesToCsv,
  bodyPct,
  volRatioAt,
  LAB_PARAMS_DEFAULT,
  type LabSignal,
  type LabBar5,
  type LabPath1m,
} from "../lib/lab";
import { ema, type Candle } from "../lib/indicators";

const MIN = 60_000;
const FIVE = 5 * MIN;
const T0 = 1_760_000_000_000 - (1_760_000_000_000 % FIVE); // 5분 경계

/** 5분봉 한 개(시작 시각 = T0 + idx×5분). */
const k = (idx: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ time: T0 + idx * FIVE, open: o, high: h, low: l, close: c, volume: v });

describe("[v0.65.0] 보조 계산", () => {
  it("emaSeries 마지막 값은 기존 ema()와 같다", () => {
    const v = Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 5));
    const s = emaSeries(v, 20);
    expect(s[18]).toBeNull();
    expect(s[59]).toBeCloseTo(ema(v, 20) as number, 10);
  });
  it("몸통 비율·거래량 배수(신호 봉 제외 직전 5평균)", () => {
    expect(bodyPct(k(0, 10, 11, 9, 10.2))).toBeCloseTo(10, 6); // 0.2/2
    const ha = [1000, 1000, 1000, 1000, 1000, 3000].map((v, i) => k(i, 10, 11, 9, 10, v));
    expect(volRatioAt(ha, 5, 5)).toBe(3);
    expect(volRatioAt(ha, 3, 5)).toBeNull(); // 봉 부족
    expect(volRatioAt([...ha.slice(0, 5).map((c) => ({ ...c, volume: 0 })), ha[5]], 5, 5)).toBeNull(); // 평균 0
  });
});

/** EMA를 9로 고정한(가격 ~10 > EMA) 시리즈 + 패턴 캔들들. 앞 6봉은 평범한 횡보(양봉/음봉 섞임). */
function base(): Candle[] {
  const a: Candle[] = [];
  for (let i = 0; i < 6; i++) a.push(k(i, 10, 10.1, 9.9, i % 2 ? 10.05 : 9.95, 1000));
  return a;
}
const flatEma = (n: number) => new Array(n).fill(9) as number[];

describe("[v0.65.0] 패턴 탐지(detectRuns) — 도지 → 1(관망) → 2(1차) → 3(2차) → 4(고점 차단)", () => {
  // idx6=도지(몸통 5%), 7=1번째 양봉, 8=2번째(몸통 80%, 거래량 3배), 9=3번째(몸통 75%, 거래량 3배), 10=4번째 양봉
  const doji = k(6, 10.0, 10.2, 9.8, 10.02, 1000);
  const c1 = k(7, 10.02, 10.15, 10.0, 10.12, 1000);
  const c2 = k(8, 10.12, 10.62, 10.1, 10.55, 3000); // 몸통 0.43/0.52=83%
  const c3 = k(9, 10.55, 11.05, 10.5, 10.95, 3000); // 몸통 0.40/0.55=72%
  const c4 = k(10, 10.95, 11.2, 10.9, 11.1, 1500);

  it("완전한 패턴: 신호 성립 + 2차 신호 인정 + 4번째 양봉은 고점 차단", () => {
    const ha = [...base(), doji, c1, c2, c3, c4];
    const r = detectRuns(ha, flatEma(ha.length));
    const run = r.find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(3);
    expect(run.volOk2).toBe(true);
    expect(run.c3?.qualified).toBe(true);
    expect(run.c4?.block).toBe(true);
    expect(run.endIdx).toBe(10);
  });

  it("1번째가 음봉이면 패턴 무효(엄격 연속) — 신호 없음", () => {
    const ha = [...base(), doji, k(7, 10.02, 10.05, 9.9, 9.95), c2, c3];
    const run = detectRuns(ha, flatEma(ha.length)).find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(0);
  });

  it("2번째 몸통이 60% 미만이면 신호 아님(stage 2에서 멈춤)", () => {
    const weak = k(8, 10.12, 10.62, 10.1, 10.38, 3000); // 몸통 0.26/0.52=50%
    const run = detectRuns([...base(), doji, c1, weak, c3], flatEma(10)).find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(2);
  });

  it("2번째 거래량이 150% 미만이면 '비인정 신호'(volOk2=false)로 남고 3번째는 보지 않는다", () => {
    const lowVol = k(8, 10.12, 10.62, 10.1, 10.55, 1200);
    const run = detectRuns([...base(), doji, c1, lowVol, c3], flatEma(10)).find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(3);
    expect(run.volOk2).toBe(false);
    expect(run.c3).toBeNull();
  });

  it("3번째가 조건 미달이면 거기서 종료(4번째를 보지 않음), 4번째가 음봉이면 block=false", () => {
    const weak3 = k(9, 10.55, 11.05, 10.5, 10.7, 3000);
    const r1 = detectRuns([...base(), doji, c1, c2, weak3, c4], flatEma(11)).find((x) => x.dojiIdx === 6)!;
    expect(r1.c3?.qualified).toBe(false);
    expect(r1.c4).toBeNull();
    const bear4 = k(10, 10.95, 11.0, 10.7, 10.8, 1500);
    const r2 = detectRuns([...base(), doji, c1, c2, c3, bear4], flatEma(11)).find((x) => x.dojiIdx === 6)!;
    expect(r2.c4?.block).toBe(false);
  });

  it("200 EMA 아래의 도지·캔들은 무시(글로벌 필터)", () => {
    const ha = [...base(), doji, c1, c2, c3];
    const low = new Array(ha.length).fill(10.3); // 도지 종가 10.02 < EMA 10.3
    expect(detectRuns(ha, low).find((x) => x.dojiIdx === 6)).toBeUndefined();
  });

  it("신호가 성립한 패턴 구간 안의 작은 양봉은 새 출발로 겹쳐 세지 않는다", () => {
    const tiny = k(7, 10.02, 10.2, 9.8, 10.04, 1000); // 몸통 5% — 도지이면서 양봉(1번째 역할)
    const ha = [...base(), doji, tiny, c2, c3];
    const runs = detectRuns(ha, flatEma(ha.length));
    expect(runs.filter((x) => x.stage >= 3)).toHaveLength(1);
  });
});

// ── 시뮬레이션용 수동 신호 ──
function bar(idx: number, o: number, h: number, l: number, c: number, e = 9.0): LabBar5 {
  return { t: T0 + idx * FIVE, o, h, l, c, v: 1000, ho: o, hh: h, hl: l, hc: c, e };
}
/** 1분봉 경로(신호 2번째 캔들=idx8 마감 이후부터). [분 오프셋, o, h, l, c] */
function path(rows: Array<[number, number, number, number, number]>): LabPath1m {
  return rows.map(([m, o, h, l, c]) => [T0 + 9 * FIVE + m * MIN, o, h, l, c, 100]);
}
function sig(over: Partial<LabSignal> = {}): LabSignal {
  return {
    id: "TEST:1", symbol: "TEST", rank: 5, detectedAtMs: T0 + 20 * FIVE, backfilled: false, thinHours: false, session: "regular", eligible: true,
    dojiT: T0 + 6 * FIVE, c2T: T0 + 8 * FIVE, volRatio2: 3, body2: 80, second: null, c4: null, runEndT: T0 + 8 * FIVE,
    metrics: { price: 10.48, ema: 9, emaGapPct: 16, lowVsEmaPct: 10, dojiEmaDistPct: 11, dojiBodyPct: 5, atrPct: 1, emaSlopePct: 0.5, runRangePct: 6 },
    // c2 원본: o 10.00 h 10.50 l 9.98 c 10.48 (몸통 96%)
    bars: [bar(6, 10, 10.1, 9.9, 10.02), bar(7, 10.02, 10.15, 10.0, 10.12), bar(8, 10.0, 10.5, 9.98, 10.48)],
    path1m: [], linkage: null, linkageDone: true, complete: true,
    ...over,
  };
}
const find = (r: ReturnType<typeof simulateSignal>, key: string) => r.find((t) => t.key === key)!;


describe("[v0.65.0] 가상 체결 시뮬레이션(simulateSignal) — 보수적 체결 가정", () => {
  it("B(종가 지정가): 한 틱 이상 뚫어야 체결, 익절 +1.5%(10.63)를 한 틱 넘어야 익절, 수수료 0.2% 차감", () => {
    const p = path([
      [0, 10.5, 10.55, 10.46, 10.5], // 저가 10.46 ≤ 10.48−0.01 → 체결 @10.48
      [1, 10.5, 10.62, 10.5, 10.6], //  고가 10.62 < 10.64 → 아직
      [2, 10.6, 10.7, 10.6, 10.68], //  고가 10.7 ≥ 10.64 → 익절
    ]);
    const t = find(simulateSignal(sig({ path1m: p })), "BC-1.5-e1"); // 손절 C = 신호봉 저가−1틱 = 9.97
    expect(t.status).toBe("win");
    expect(t.fillPx).toBe(10.48);
    expect(t.tpPx).toBe(10.63);
    expect(t.stopPx).toBe(9.97);
    expect(t.exitPx).toBe(10.63);
    expect(t.grossPct).toBeCloseTo(1.43, 1);
    expect(t.netPct).toBeCloseTo(1.23, 1);
    expect(t.riskPct).toBeCloseTo(4.86, 1);
  });

  it("시가가 이미 지정가 아래면 시가에 체결(가격 개선)", () => {
    const p = path([[0, 10.4, 10.45, 10.39, 10.42], [1, 10.42, 10.5, 10.4, 10.5]]);
    const t = find(simulateSignal(sig({ path1m: p })), "BC-1.5-e1");
    expect(t.fillPx).toBe(10.4);
  });

  it("A(저가+3틱=10.01 지정가): 15분 안에 안 내려오면 미체결(원안의 체결 문제)", () => {
    const p = path(Array.from({ length: 20 }, (_, i) => [i, 10.5, 10.6, 10.45, 10.55] as [number, number, number, number, number]));
    const t = find(simulateSignal(sig({ path1m: p })), "AC-1.5-e1");
    expect(t.status).toBe("unfilled");
    expect(t.note).toContain("15분");
  });

  it("C(고가 돌파 +1틱=10.51 스톱매수): 고가가 한 틱 넘어야 체결, 시가가 이미 위면 시가", () => {
    const p1 = path([[0, 10.45, 10.5, 10.4, 10.48], [1, 10.48, 10.52, 10.47, 10.5]]);
    expect(find(simulateSignal(sig({ path1m: p1 })), "CC-1.5-e1").fillPx).toBe(10.51);
    const p2 = path([[0, 10.55, 10.6, 10.5, 10.58]]);
    expect(find(simulateSignal(sig({ path1m: p2 })), "CC-1.5-e1").fillPx).toBe(10.55); // 갭 상승 → 시가
  });

  it("D(몸통 50% 되돌림=10.24 지정가)", () => {
    const p = path([[0, 10.45, 10.5, 10.2, 10.3]]);
    expect(find(simulateSignal(sig({ path1m: p })), "DC-1.5-e1").fillPx).toBe(10.24);
  });

  it("같은 봉에서 손절·익절이 둘 다 닿으면 손절 우선(보수적), 갭 하락이면 시가로 손절", () => {
    const p = path([
      [0, 10.5, 10.55, 10.46, 10.5], //     B 체결 @10.48
      [1, 10.5, 10.75, 9.9, 10.0], //       고가는 익절선 위, 저가는 손절선(9.97) 아래 → 손절
    ]);
    const t = find(simulateSignal(sig({ path1m: p })), "BC-1.5-e1");
    expect(t.status).toBe("loss");
    expect(t.exitPx).toBe(9.97);
    const pGap = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 9.8, 9.85, 9.7, 9.75]]); // 시가가 이미 손절선 아래
    expect(find(simulateSignal(sig({ path1m: pGap })), "BC-1.5-e1").exitPx).toBe(9.8);
  });

  it("체결 봉에서는 익절을 보지 않는다(봉 안 순서 모름) — 다음 봉에서 익절", () => {
    const p = path([[0, 10.5, 10.9, 10.46, 10.85], [1, 10.85, 10.86, 10.8, 10.82]]);
    const t = find(simulateSignal(sig({ path1m: p })), "BC-1.5-e1");
    expect(t.status).toBe("win");
    expect(t.exitT).toBe(p[1][0]);
  });

  it("4번째 캔들이 양봉(고점 차단)이면 그 봉 마감 시각의 시가로 정리(time)", () => {
    const c4T = T0 + 10 * FIVE; // 4번째 캔들 시작 → 마감 = T0 + 11×5분 = 경로 기준 분 10
    const rows: Array<[number, number, number, number, number]> = [];
    for (let m = 0; m < 14; m++) rows.push([m, 10.5, 10.55, m === 0 ? 10.46 : 10.5, 10.52]);
    const t = find(simulateSignal(sig({ path1m: path(rows), c4: { t: c4T, block: true } })), "BC-1.5-e1");
    expect(t.status).toBe("time");
    expect(t.exitT).toBe(T0 + 11 * FIVE);
  });

  it("관찰 시간이 지나도 안 끝나면 마지막 종가로 horizon 정리, 데이터가 모자라면 open", () => {
    const rows: Array<[number, number, number, number, number]> = [[0, 10.5, 10.55, 10.46, 10.5]];
    for (let m = 1; m <= 200; m++) rows.push([m, 10.5, 10.55, 10.45, 10.5]);
    expect(find(simulateSignal(sig({ path1m: path(rows) })), "BC-1.5-e1").status).toBe("horizon");
    expect(find(simulateSignal(sig({ path1m: path(rows.slice(0, 30)), complete: false })), "BC-1.5-e1").status).toBe("open");
    // 이미 끝난(complete) 신호인데 데이터가 일찍 끊겼다면(장 마감) 경로 끝에서 정리한다
    const ended = find(simulateSignal(sig({ path1m: path(rows.slice(0, 30)), complete: true })), "BC-1.5-e1");
    expect(ended.status).toBe("horizon");
    expect(ended.exitReason).toContain("장 종료");
  });

  it("2차 진입(3번째 캔들): 1차가 보유 중이고 수익권일 때만, 아니면 skipped", () => {
    const bar3 = bar(9, 10.48, 11.0, 10.45, 10.95);
    const second = { t: T0 + 9 * FIVE, qualified: true, body: 80, volRatio: 3 };
    const rows: Array<[number, number, number, number, number]> = [[0, 10.5, 10.55, 10.46, 10.5]];
    for (let m = 1; m <= 12; m++) rows.push([m, 10.55, 10.6, 10.5, 10.58]); // 1차는 익절선(10.63) 아래에서 계속 보유
    const s = sig({ bars: [...sig().bars, bar3], second, path1m: path(rows) });
    const e2 = find(simulateSignal(s), "BC-1.5-e2");
    expect(e2.status).not.toBe("skipped"); // 3번째 캔들 종가(10.95) > 1차 체결가(10.48), 아직 보유 중
    // 1차가 3번째 캔들 마감 전에 손절되면 skipped
    const rows2: Array<[number, number, number, number, number]> = [[0, 10.5, 10.55, 10.46, 10.5], [1, 9.8, 9.85, 9.7, 9.75]];
    for (let m = 2; m <= 12; m++) rows2.push([m, 9.8, 9.9, 9.7, 9.8]);
    const e2b = find(simulateSignal({ ...s, path1m: path(rows2) }), "BC-1.5-e2");
    expect(e2b.status).toBe("skipped");
    expect(e2b.note).toContain("보유 중이 아님");
    // 3번째 캔들 종가가 1차 체결가보다 낮으면 "수익권 아님"
    const s3 = { ...s, bars: [...sig().bars, bar(9, 10.48, 10.5, 10.3, 10.4)] };
    const e2c = find(simulateSignal(s3), "BC-1.5-e2");
    expect(e2c.status).toBe("skipped");
    expect(e2c.note).toContain("수익권");
  });

  it("손절선이 진입가 이상이면 그 변형은 skipped(EMA가 진입가보다 높은 경우)", () => {
    const hi = sig({ bars: [bar(6, 10, 10.1, 9.9, 10.02), bar(7, 10.02, 10.15, 10.0, 10.12), bar(8, 10.0, 10.5, 9.98, 10.48, 20)] });
    const t = find(simulateSignal({ ...hi, path1m: path([[0, 10.5, 10.55, 10.46, 10.5]]) }), "BB-1.5-e1"); // 손절 B = EMA20 아래
    expect(t.status).toBe("skipped");
  });
});

describe("[v0.65.0] 삼분할 연계(findLinkage) — 상승 구간 끝난 뒤 기존 삼분할 패턴이 이어졌는가", () => {
  // 상승 구간 후 고점(idx 9) → idx10 음봉 도지 → idx11 음봉 = 확정
  const seq = (): Candle[] => [
    ...base(),
    k(6, 10.0, 10.2, 9.8, 10.02),
    k(7, 10.02, 10.15, 10.0, 10.12),
    k(8, 10.12, 10.62, 10.1, 10.55, 3000),
    k(9, 10.55, 11.05, 10.5, 10.95, 3000), // 세션 최고점 11.05
    k(10, 10.95, 11.0, 10.6, 10.93, 1500), // 음봉 도지(몸통 5%, 양쪽 꼬리)
    k(11, 10.9, 10.92, 10.6, 10.7, 1500), //  다음 음봉 → 확정
  ];
  const o = { sessionStartMs: T0 - 1, bodyRatio: 0.3, wickMin: 0.1, maxAgeMin: 40, maxGapMin: 30, tpPct: 2, slPct: 10, emaPeriod: 200 };

  it("고점→도지→음봉이 상승 구간 뒤에 나오면 연계로 잡히고, calcSplit3 타점이 담긴다", () => {
    const c = seq();
    expect(findLinkage(c, c, 8, 8, o)).toBeNull(); // EMA200은 데이터 부족 → 못 찾음
    const lk = findLinkage(c, c, 8, 8, { ...o, emaPeriod: 5 });
    expect(lk).not.toBeNull();
    expect(lk!.highPx).toBe(11.05);
    expect(lk!.confirmT).toBe(T0 + 11 * FIVE);
    expect(lk!.splits).toHaveLength(3);
    expect(lk!.splits[0].entry).toBeLessThan(lk!.prevClose);
    expect(lk!.splits[2].entry).toBeCloseTo(lk!.ema, 1);
  });

  it("그 고점이 이 상승 이전의 옛 고점이면 연계로 보지 않는다", () => {
    const c = seq();
    c[2] = k(2, 10, 20, 9.9, 10.1); // 훨씬 높은 옛 고점(상승 이전)
    expect(findLinkage(c, c, 8, 8, { ...o, emaPeriod: 5 })).toBeNull();
  });
});

describe("[v0.65.0] 집계(summarizeVariants·breakdownBy·funnel·linkage·combined·csv)", () => {
  const tail = (start: number, o: number, h: number, l: number, c: number): Array<[number, number, number, number, number]> =>
    Array.from({ length: 200 }, (_, i) => [start + i, o, h, l, c]);
  const win = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 10.5, 10.7, 10.5, 10.68], ...tail(2, 10.68, 10.7, 10.65, 10.68)]);
  const lose = path([[0, 10.5, 10.55, 10.46, 10.5], [1, 9.8, 9.85, 9.7, 9.75], ...tail(2, 9.75, 9.8, 9.7, 9.75)]);
  const none = path(tail(0, 10.6, 10.7, 10.55, 10.65));
  const sigs = [
    sig({ id: "W:1", symbol: "W", path1m: win, rank: 3 }),
    sig({ id: "L:1", symbol: "L", path1m: lose, rank: 40 }),
    sig({ id: "N:1", symbol: "N", path1m: none, rank: 70 }),
    sig({ id: "X:1", symbol: "X", path1m: win, eligible: false }), //  비인정(거래량 미달)
    sig({ id: "T:1", symbol: "T", path1m: win, thinHours: true }), //  얇은 시간대
  ];

  it("기본 필터: 비인정·얇은 시간대 제외 → 3건. 변형 BC-1.5-e1은 시도 3·체결 2·승 1·패 1", () => {
    const r = summarizeVariants(sigs).find((x) => x.key === "BC-1.5-e1")!;
    expect(r.signals).toBe(3);
    expect(r.filled).toBe(2);
    expect(r.fillRate).toBeCloseTo(66.67, 1);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.winRate).toBe(50);
    expect(r.profitFactor).not.toBeNull();
    // 미체결은 0으로 쳐서 신호 하나당 기대값 = (익절 순손익 + 손절 순손익) ÷ 3
    expect(r.expectancyPerSignal).toBeCloseTo((r.totalNetPct as number) / 3, 1);
  });

  it("필터를 풀면 비인정·얇은 시간대도 포함(5건)", () => {
    const r = summarizeVariants(sigs, { includeIneligible: true, includeThin: true }).find((x) => x.key === "BC-1.5-e1")!;
    expect(r.signals).toBe(5);
  });

  it("조건별 분해: 순위 구간별로 나뉜다(미체결 신호는 분해 대상 아님)", () => {
    const rows = breakdownBy(sigs, "BC-1.5-e1", "rank");
    const byLabel = Object.fromEntries(rows.map((x) => [x.label, x]));
    expect(byLabel["1~10위"].n).toBe(1);
    expect(byLabel["31~60위"].n).toBe(1);
    expect(byLabel["61위~"]).toBeUndefined();
  });

  it("깔때기·연계 요약", () => {
    const withLink = sig({
      id: "K:1", symbol: "K", path1m: win, c4: { t: T0 + 10 * FIVE, block: true }, runEndT: T0 + 10 * FIVE,
      linkage: { confirmT: T0 + 14 * FIVE, dojiT: T0 + 13 * FIVE, highT: T0 + 10 * FIVE, highPx: 11, prevClose: 10.7, ema: 9, emaGapPct: 18.9, splits: [{ level: 1, entry: 10.1, tp: 10.3, sl: 9.09 }, { level: 2, entry: 9.8, tp: 10, sl: 8.8 }, { level: 3, entry: 9, tp: 9.2, sl: 8.1 }] },
    });
    const f = buildFunnel({ a: 0, b: 1, c: 3, d: 3, e: 2 }, [withLink, ...sigs]);
    expect(f.dojis).toBe(5);
    expect(f.c1).toBe(4);
    expect(f.c2Body).toBe(2);
    expect(f.block4).toBe(1);
    expect(f.linked).toBe(1);
    const ls = summarizeLinkage([withLink, ...sigs]);
    expect(ls.runsWithBlock).toBe(1);
    expect(ls.linked).toBe(1);
    expect(ls.linkRate).toBe(100);
    expect(ls.avgGapMin).toBe(20);
  });

  it("CSV: 헤더와 신호 수만큼 행, 가상 매매 CSV는 변형 수만큼 행", () => {
    const csv = signalsToCsv(sigs).split("\n");
    expect(csv[0]).toContain("symbol");
    expect(csv).toHaveLength(6);
    const tcsv = tradesToCsv([sigs[0]]).split("\n");
    expect(tcsv[0]).toContain("netPct");
    expect(tcsv.length).toBeGreaterThanOrEqual(49);
  });

  it("combinedScenario: 캔들 손절이면 삼분할 건너뜀(Q9-A)", () => {
    const mkLink = (confirmIdx: number) => ({ confirmT: T0 + confirmIdx * FIVE, dojiT: T0 + (confirmIdx - 1) * FIVE, highT: T0 + 9 * FIVE, highPx: 11, prevClose: 10.7, ema: 9, emaGapPct: 18, splits: [{ level: 1, entry: 10.5, tp: 10.7, sl: 9.4 }, { level: 2, entry: 10.2, tp: 10.4, sl: 9.1 }, { level: 3, entry: 9, tp: 9.2, sl: 8 }] });
    const sLoss = sig({ path1m: lose, linkage: mkLink(12) });
    const res = combinedScenario([sLoss], "BC-1.5-e1", "L1A-1.5");
    expect(res.n).toBe(0);
    expect(res.skippedByLoss + res.skippedByOverlap).toBeLessThanOrEqual(1);
  });

  it("기본 파라미터는 오너·카일 합의값", () => {
    expect(LAB_PARAMS_DEFAULT.dojiBodyMaxPct).toBe(15);
    expect(LAB_PARAMS_DEFAULT.bodyMinPct).toBe(60);
    expect(LAB_PARAMS_DEFAULT.volRatioMin).toBe(1.5);
    expect(LAB_PARAMS_DEFAULT.volLookback).toBe(5);
  });
});

// =============================================================================
// [v0.65.1] 실데이터 검증에서 발견된 오류의 재발 방지 테스트
//   (오너의 실제 기록 파일 분석: 인정 신호 15건 중 9건이 호가 1~2틱짜리 초소형 봉, 몇 주 전 봉, 연속 아닌 봉 연결,
//    삼분할 연계가 며칠 뒤 패턴까지 무한정 탐색되어 70건 중 47건이 "연계" → 전부 규칙 오류)
// =============================================================================
describe("[v0.65.1] 데이터 정직성 규칙 — 연속성·최신성·최소 봉 크기·연계 탐색 상한", () => {
  const doji = k(6, 10.0, 10.2, 9.8, 10.02, 1000);
  const c1 = k(7, 10.02, 10.15, 10.0, 10.12, 1000);
  const c2 = k(8, 10.12, 10.62, 10.1, 10.55, 3000);
  const c3 = k(9, 10.55, 11.05, 10.5, 10.95, 3000);
  const good = () => [...base(), doji, c1, c2, c3];

  it("봉이 빠져 이웃이 아니면(5분 간격이 아님) 연속으로 보지 않는다", () => {
    const ha = good();
    ha[8] = { ...ha[8], time: ha[8].time + FIVE }; // 2번째 봉이 5분 늦게(그 사이 봉 하나 없음)
    const run = detectRuns(ha, flatEma(ha.length)).find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(1); // 1번째까지만 이어지고 2번째와는 끊김
  });

  it("거래량 평균 구간에 빠진 봉이 있으면 배수를 계산하지 않는다(null → 비인정)", () => {
    const ha = good();
    ha[3] = { ...ha[3], time: ha[3].time + 2 * MIN }; // 직전 5개 안에 간격이 어긋난 봉
    const run = detectRuns(ha, flatEma(ha.length)).find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(3);
    expect(run.volOk2).toBe(false);
  });

  it("봉 크기(고저폭÷종가)가 최소 기준 미만이면 몸통 비율이 100%여도 비인정(rangeOk2=false)", () => {
    // 가격 10 근처에서 고저폭 0.01(=0.1%) — 호가 1틱짜리 "몸통 100%" 봉
    const tiny = k(8, 10.1, 10.11, 10.1, 10.11, 3000);
    const ha = [...base(), doji, c1, tiny, c3];
    const run = detectRuns(ha, flatEma(ha.length)).find((x) => x.dojiIdx === 6)!;
    expect(run.stage).toBe(3);
    expect(run.rangeOk2).toBe(false);
    expect(run.c3).toBeNull(); // 비인정이면 3번째를 보지 않는다
    // 기준을 끄면(0) 통과
    const off = detectRuns(ha, flatEma(ha.length), { ...LAB_PARAMS_DEFAULT, minRangePct: 0 }).find((x) => x.dojiIdx === 6)!;
    expect(off.rangeOk2).toBe(true);
  });

  it("너무 오래된 패턴(72시간 초과)은 무시한다 — 거래 드문 종목의 몇 주 전 봉 방지", () => {
    const ha = good();
    const now = ha[ha.length - 1].time + 80 * 3600_000;
    expect(detectRuns(ha, flatEma(ha.length), LAB_PARAMS_DEFAULT, now).find((x) => x.dojiIdx === 6)).toBeUndefined();
    const recent = ha[ha.length - 1].time + 3600_000;
    expect(detectRuns(ha, flatEma(ha.length), LAB_PARAMS_DEFAULT, recent).find((x) => x.dojiIdx === 6)?.stage).toBe(3);
  });

  it("EMA200을 만든 봉 200개가 5일보다 넓게 퍼져 있으면(거래 드문 종목) 그 EMA 기반 패턴은 제외", () => {
    const n = 260;
    const ha: Candle[] = [];
    for (let i = 0; i < n; i++) ha.push({ time: T0 + i * 3 * 3600_000, open: 10, high: 10.1, low: 9.9, close: 10.02, volume: 1000 }); // 3시간 간격(희소)
    const emaAll = new Array(n).fill(9) as number[];
    const runs = detectRuns(ha, emaAll);
    expect(runs.filter((r) => r.dojiIdx >= 199)).toHaveLength(0);
  });

  it("삼분할 연계 탐색은 상한(상승 끝+관찰시간) 이후의 패턴을 연계로 잡지 않는다", () => {
    const c: Candle[] = [
      ...base(),
      k(6, 10.0, 10.2, 9.8, 10.02),
      k(7, 10.02, 10.15, 10.0, 10.12),
      k(8, 10.12, 10.62, 10.1, 10.55, 3000),
      k(9, 10.55, 11.05, 10.5, 10.95, 3000),
      k(10, 10.95, 11.0, 10.6, 10.93, 1500),
      k(11, 10.9, 10.92, 10.6, 10.7, 1500),
    ];
    const o = { sessionStartMs: T0 - 1, bodyRatio: 0.3, wickMin: 0.1, maxAgeMin: 40, maxGapMin: 30, tpPct: 2, slPct: 10, emaPeriod: 5 };
    expect(findLinkage(c, c, 8, 8, o, c[11].time)).not.toBeNull(); // 상한이 확정 봉을 포함하면 잡힘
    expect(findLinkage(c, c, 8, 8, o, c[10].time)).toBeNull(); //      상한이 그 앞에서 끊기면 못 잡음
  });
});
