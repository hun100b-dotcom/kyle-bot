// =============================================================================
// tests/strength-signals.test.ts — 체결강도 '신호' 감지 규칙 고정 (v0.12.0, 2단계)
// -----------------------------------------------------------------------------
// [정본] docs/체결강도_분석_2026-07-24.html 3·5장.
//   · 바닥반전(진입)   = 강도가 100 아래(매도우세)에서 연속 상승으로 전환.
//   · 정점꺾임(익절)   = 강도가 100 위(매수우세)에서 정점 찍고 연속 하락으로 전환.
//   · 강세 다이버전스  = 가격은 신저점인데 강도는 직전 저점보다 높음.
//   · 국면(phase)     = 하락중/진입/보유/익절/고점경고/중립.
//   이 규칙들을 순수함수로 못 박아, 값이 조용히 틀려 잘못된 신호가 뜨는 것을 막는다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { analyzeStrengthSeries, type SeriesPoint } from "../lib/strength";

/** 강도만 있는 시계열(가격은 임의) 만들기 도우미 */
function series(strengths: (number | null)[], prices?: (number | null)[]): SeriesPoint[] {
  return strengths.map((s, i) => ({ strength: s, price: prices ? prices[i] : 100 }));
}

describe("바닥반전(진입 신호) — 100 아래에서 연속 상승 전환", () => {
  it("100 아래에서 3점 연속 상승이면 바닥반전", () => {
    // 하락(120→90→70) 후 바닥(70)에서 연속 상승(70→80→95)
    const r = analyzeStrengthSeries(series([120, 90, 70, 80, 95]));
    expect(r.bottomReversal).toBe(true);
  });

  it("바닥이 100 위(과매도 아님)면 바닥반전 아님", () => {
    // 110→105→108→112 : 100 위에서의 잔물결은 바닥반전으로 치지 않음
    const r = analyzeStrengthSeries(series([130, 110, 105, 108, 112]));
    expect(r.bottomReversal).toBe(false);
  });

  it("계속 하락 중(반전 없음)이면 바닥반전 아님", () => {
    const r = analyzeStrengthSeries(series([120, 100, 85, 70, 55]));
    expect(r.bottomReversal).toBe(false);
  });

  it("[B리뷰 #3] 이미 과매수로 폭주(강도 200)했으면 '진입' 오신호를 내지 않는다", () => {
    // 60→70→130→200: 바닥은 있었지만 latest 200 = 이미 늦음 → 진입 아님
    const r = analyzeStrengthSeries(series([60, 70, 130, 200]));
    expect(r.bottomReversal).toBe(false);
    expect(r.phase).not.toBe("진입");
  });
});

describe("정점꺾임(익절 신호) — 100 위에서 연속 하락 전환", () => {
  it("100 위에서 3점 연속 하락이면 정점꺾임", () => {
    // 반등(90→130→160) 후 정점(160)에서 연속 하락(160→140→120)
    const r = analyzeStrengthSeries(series([90, 130, 160, 140, 120]));
    expect(r.peakRollover).toBe(true);
  });

  it("정점이 100 아래면 정점꺾임 아님", () => {
    const r = analyzeStrengthSeries(series([95, 90, 85, 80, 75]));
    expect(r.peakRollover).toBe(false);
  });

  it("[B리뷰 #3] 이미 과매도로 붕괴(강도 30)했으면 '익절' 오신호를 내지 않는다", () => {
    // 200→130→70→30: 정점은 있었지만 latest 30 = 이미 늦음 → 익절 아님
    const r = analyzeStrengthSeries(series([200, 130, 70, 30]));
    expect(r.peakRollover).toBe(false);
    expect(r.phase).not.toBe("익절");
  });
});

describe("강세 다이버전스 — 가격 신저점 + 강도는 더 높음", () => {
  it("가격이 더 낮은 저점인데 강도는 직전 저점보다 높으면 다이버전스", () => {
    // 앞 저점: price 10.0 / strength 60,  뒤 저점: price 9.5(신저점) / strength 75(더 높음)
    const prices = [10.5, 10.0, 10.3, 9.8, 9.5, 9.7];
    const strengths = [80, 60, 70, 72, 75, 78];
    const r = analyzeStrengthSeries(series(strengths, prices));
    expect(r.bullishDivergence).toBe(true);
  });

  it("가격 신저점에서 강도도 더 낮으면 다이버전스 아님(약세 지속)", () => {
    const prices = [10.5, 10.0, 10.3, 9.8, 9.5, 9.7];
    const strengths = [80, 70, 65, 55, 50, 52];
    const r = analyzeStrengthSeries(series(strengths, prices));
    expect(r.bullishDivergence).toBe(false);
  });
});

describe("국면(phase) 판정", () => {
  it("바닥반전이면 '진입'", () => {
    expect(analyzeStrengthSeries(series([120, 90, 70, 80, 95])).phase).toBe("진입");
  });
  it("정점꺾임이면 '익절'", () => {
    expect(analyzeStrengthSeries(series([90, 130, 160, 140, 120])).phase).toBe("익절");
  });
  it("100 위 상승 지속이면 '보유'", () => {
    expect(analyzeStrengthSeries(series([100, 110, 125, 140, 155])).phase).toBe("보유");
  });
  it("100 아래 하락 지속이면 '하락중'", () => {
    expect(analyzeStrengthSeries(series([100, 90, 80, 70, 60])).phase).toBe("하락중");
  });
});

describe("신뢰도·경계", () => {
  it("점이 너무 적으면 thinSample=true, 신호는 조용(false), 국면은 중립", () => {
    const r = analyzeStrengthSeries(series([80, 95]));
    expect(r.thinSample).toBe(true);
    expect(r.bottomReversal).toBe(false);
    expect(r.peakRollover).toBe(false);
    expect(r.phase).toBe("중립"); // [L2] 표본 얇으면 국면도 단정 안 함
  });

  it("빈 시계열도 터지지 않고 중립", () => {
    const r = analyzeStrengthSeries([]);
    expect(r.phase).toBe("중립");
    expect(r.bottomReversal).toBe(false);
  });

  it("강도 null(매수 일방)은 계산에서 제외해도 터지지 않는다", () => {
    const r = analyzeStrengthSeries(series([120, 90, null, 70, 80, 95]));
    expect(r.bottomReversal).toBe(true); // null 제외하면 120,90,70,80,95 → 바닥반전
  });
});
