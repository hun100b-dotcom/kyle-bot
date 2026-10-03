// =============================================================================
// tests/indicators.test.ts — 스크리너 지표 계산 회귀 테스트 (v0.6.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나?]
//   스크리너가 잘못된 종목을 후보로 내놓지 않도록, 지표 규칙을 고정한다.
//   ① 순수 함수(lib/indicators.ts): 5분봉 합성·EMA·이치모쿠·음봉도지·세션패턴
//   ② 세션 시작시각(lib/session.ts getSessionStart)
//   ③ 엔진 스캔 왕복(연습 모드 + 목 서버): 스캔이 끝까지 돌고 결과를 만드는지
// =============================================================================

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate1mTo5m, dropIncompleteBucket, toHeikinAshi, inPriceBand, ema, ichimoku, isBearishDoji, scanSessionPattern, WICK_MIN_RATIO, DOJI_MAX_AGE_MINUTES, type Candle } from "../lib/indicators";
import { getSessionStart, getSession } from "../lib/session";
import { ToolEngine } from "../electron/tool-engine";

const MIN = 60_000;
// 1분봉 하나 만들기(도우미)
const c = (time: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: v });

describe("1분봉 → 5분봉 합성(aggregate1mTo5m)", () => {
  it("5개의 1분봉이 한 5분봉으로 묶이고 OHLCV가 맞다", () => {
    const base = 0; // 5분 경계
    const oneMin = [
      c(base + 0 * MIN, 10, 10.5, 9.9, 10.2, 100),
      c(base + 1 * MIN, 10.2, 10.8, 10.1, 10.6, 120),
      c(base + 2 * MIN, 10.6, 10.7, 10.3, 10.4, 90),
      c(base + 3 * MIN, 10.4, 10.9, 10.2, 10.7, 110),
      c(base + 4 * MIN, 10.7, 11.0, 10.5, 10.9, 130),
    ];
    const five = aggregate1mTo5m(oneMin);
    expect(five).toHaveLength(1);
    expect(five[0]).toMatchObject({ open: 10, high: 11.0, low: 9.9, close: 10.9, volume: 550 });
    expect(five[0].time).toBe(0); // 버킷 시작
  });

  it("6번째 1분봉은 다음 5분 버킷으로 넘어간다", () => {
    const five = aggregate1mTo5m([c(0, 1, 1, 1, 1), c(5 * MIN, 2, 2, 2, 2)]);
    expect(five).toHaveLength(2);
    expect(five[1].time).toBe(5 * MIN);
  });

  it("순서가 뒤섞여 들어와도 시각순으로 합성한다", () => {
    const five = aggregate1mTo5m([c(2 * MIN, 3, 3, 3, 3), c(0, 1, 1, 1, 1), c(1 * MIN, 2, 2, 2, 2)]);
    expect(five[0].open).toBe(1); // 가장 이른 봉의 시가
    expect(five[0].close).toBe(3); // 가장 늦은 봉의 종가
  });
});

describe("EMA(ema)", () => {
  it("[1,2,3,4,5] period 3 → 4 (SMA 시드 후 재귀)", () => {
    // 시드 SMA(1,2,3)=2, k=0.5 → 4*.5+2*.5=3 → 5*.5+3*.5=4
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
  });
  it("값이 period보다 적으면 null", () => {
    expect(ema([1, 2], 3)).toBeNull();
  });
});

describe("이치모쿠 구름(ichimoku)", () => {
  it("고가·저가가 일정하면 구름top = (고가+저가)/2", () => {
    // 100개 봉 모두 high=11, low=9, close=10 → 모든 스팬 = 10, cloudTop=10
    const candles: Candle[] = Array.from({ length: 100 }, (_, i) => c(i * MIN, 10, 11, 9, 10));
    const cloud = ichimoku(candles);
    expect(cloud).not.toBeNull();
    expect(cloud!.cloudTop).toBeCloseTo(10, 6);
    expect(cloud!.cloudBottom).toBeCloseTo(10, 6);
  });
  it("데이터가 부족하면(78봉 미만) null", () => {
    const candles: Candle[] = Array.from({ length: 50 }, (_, i) => c(i * MIN, 10, 11, 9, 10));
    expect(ichimoku(candles)).toBeNull();
  });
});

describe("음봉 도지(isBearishDoji) — 양쪽 꼬리 조건 포함", () => {
  it("음봉 + 작은 몸통 + 위·아래 꼬리 둘 다 → 도지", () => {
    // 몸통 0.1(10%), 윗꼬리 0.5(50%), 아래꼬리 0.4(40%) → 통과
    expect(isBearishDoji(c(0, 100, 100.5, 99.5, 99.9), 0.3)).toBe(true);
  });
  it("양봉이면(종가≥시가) 도지 아님", () => {
    expect(isBearishDoji(c(0, 100, 100.5, 99.5, 100.2), 0.3)).toBe(false);
  });
  it("몸통이 크면(범위의 30% 초과) 도지 아님", () => {
    expect(isBearishDoji(c(0, 100, 100.4, 99.4, 99.5), 0.3)).toBe(false);
  });
  it("[망치형] 아래꼬리만 길고 윗꼬리 거의 없음 → 도지 아님", () => {
    // 윗꼬리 0.05/범위1.55 ≈ 3.2% < 10% → 제외
    expect(isBearishDoji(c(0, 100, 100.05, 98.5, 99.9), 0.3)).toBe(false);
  });
  it("[유성형/비석] 윗꼬리만 길고 아래꼬리 거의 없음 → 도지 아님", () => {
    // 아래꼬리 0.02/범위1.62 ≈ 1.2% < 10% → 제외
    expect(isBearishDoji(c(0, 100, 101.5, 99.88, 99.9), 0.3)).toBe(false);
  });
});

describe("세션 패턴(scanSessionPattern)", () => {
  // c0가 세션 최고점(high=100), c1이 첫 음봉 도지, c2가 다음 봉
  const highC = c(0, 98, 100, 97, 99); //         최고점
  const dojiC = c(1 * MIN, 99, 99.5, 98.5, 98.9); // 음봉 도지(몸통0.1/범위1.0)
  const bearC = c(2 * MIN, 98.9, 99, 98, 98.2); //   음봉

  it("최고점 이후 도지 + 다음 봉 음봉 → confirmed", () => {
    const r = scanSessionPattern([highC, dojiC, bearC], 0, 0.3);
    expect(r.sessionHigh).toBe(100);
    expect(r.dojiIndex).toBe(1);
    expect(r.status).toBe("confirmed");
  });
  it("도지까지만 있고 다음 봉이 아직 없으면 → watch", () => {
    expect(scanSessionPattern([highC, dojiC], 0, 0.3).status).toBe("watch");
  });
  it("도지 다음 봉이 양봉이면 → none(패턴 깨짐)", () => {
    const bull = c(2 * MIN, 98.9, 99.5, 98.8, 99.4);
    expect(scanSessionPattern([highC, dojiC, bull], 0, 0.3).status).toBe("none");
  });
  it("세션 시작 이전 봉은 무시한다", () => {
    // 시작 이전에 더 높은 고점이 있어도 세션 최고점에 안 잡힌다
    const before = c(-5 * MIN, 200, 200, 200, 200);
    const r = scanSessionPattern([before, highC, dojiC, bearC], 0, 0.3);
    expect(r.sessionHigh).toBe(100); // 200이 아니라 100
    expect(r.status).toBe("confirmed");
  });

  it("[신고가 무효화] 도지+음봉 뒤 신고가가 나오면 그 셋업은 무효(none)", () => {
    // 최고점(100) → 도지 → 음봉(=원래 confirmed) → 이후 신고가 105
    const newHigh = c(3 * MIN, 99, 105, 99, 104);
    const r = scanSessionPattern([highC, dojiC, bearC, newHigh], 0, 0.3);
    expect(r.sessionHigh).toBe(105); // 최고점이 신고가로 이동
    expect(r.status).toBe("none"); // 말아올려 신고가 → 무효
    // 신고가가 없으면 그대로 confirmed
    expect(scanSessionPattern([highC, dojiC, bearC], 0, 0.3).status).toBe("confirmed");
  });
});

describe("[v0.51.0 긴급 수정] nextCandleConfirmEnabled=false — 도지만으로 즉시 확정", () => {
  // 오너가 [스크리닝 기준] 탭에서 "다음봉 확인"을 꺼도, 스캔 타이밍에 따라(다음 봉이 이미
  //   나왔는데 마침 양봉이면) 여전히 탈락하던 버그를 고친 회귀 테스트. 버그 상세는
  //   lib/indicators.ts의 scanSessionPattern 문서 주석 참고.
  const highC = c(0, 98, 100, 97, 99);
  const dojiC = c(1 * MIN, 99, 99.5, 98.5, 98.9);

  it("다음 봉이 아직 없어도(watch였을 자리) 곧바로 confirmed", () => {
    const r = scanSessionPattern([highC, dojiC], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, false);
    expect(r.status).toBe("confirmed");
  });

  it("[핵심] 다음 봉이 이미 나왔고 양봉이어도(예전엔 none) confirmed — 꺼진 필터는 더 이상 영향 없음", () => {
    const bull = c(2 * MIN, 98.9, 99.5, 98.8, 99.4); // 양봉(패턴상 '깨짐'이던 케이스)
    const r = scanSessionPattern([highC, dojiC, bull], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, false);
    expect(r.status).toBe("confirmed");
  });

  it("도지 자체가 없으면 토글을 꺼도 여전히 none(구제 대상이 아님)", () => {
    const noDoji = c(1 * MIN, 98.5, 99.5, 98, 99.3); // 몸통이 커서 도지가 아님
    const r = scanSessionPattern([highC, noDoji], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, false);
    expect(r.status).toBe("none");
  });

  it("파라미터를 안 주면(기본 true) 예전 그대로 — 양봉이면 none(회귀 없음)", () => {
    const bull = c(2 * MIN, 98.9, 99.5, 98.8, 99.4);
    expect(scanSessionPattern([highC, dojiC, bull], 0, 0.3).status).toBe("none");
  });
});

describe(`[v0.25.0/v0.29.0] 도지 신선도(기본 ${DOJI_MAX_AGE_MINUTES}분 초과 시 불합격)`, () => {
  // c0=최고점(0분), c1=도지(1분), c2=도지 다음 음봉(2분) — 위 describe와 동일한 시나리오.
  const highC = c(0, 98, 100, 97, 99);
  const dojiC = c(1 * MIN, 99, 99.5, 98.5, 98.9); // 도지 시각 = 1분
  const bearC = c(2 * MIN, 98.9, 99, 98, 98.2);

  it("nowMs를 안 주면(과거 호출 호환) 시간 검사를 생략하고 그대로 confirmed", () => {
    const r = scanSessionPattern([highC, dojiC, bearC], 0, 0.3);
    expect(r.status).toBe("confirmed");
    expect(r.tooOld).toBe(false);
  });

  it(`도지 시각이 지금으로부터 ${DOJI_MAX_AGE_MINUTES}분 이내면 그대로 confirmed`, () => {
    // 도지=1분, now=1분+(기준-1)분 → 경과가 기준보다 1분 적음
    const r = scanSessionPattern([highC, dojiC, bearC], 0, 0.3, undefined, 1 * MIN + (DOJI_MAX_AGE_MINUTES - 1) * MIN);
    expect(r.tooOld).toBe(false);
    expect(r.status).toBe("confirmed");
  });

  it(`도지 시각이 지금으로부터 ${DOJI_MAX_AGE_MINUTES}분 넘게 지났으면 confirmed였어도 강제로 none`, () => {
    // 도지=1분, now=1분+(기준+1)분 → 경과가 기준보다 1분 많음
    const now = 1 * MIN + (DOJI_MAX_AGE_MINUTES + 1) * MIN;
    const r = scanSessionPattern([highC, dojiC, bearC], 0, 0.3, WICK_MIN_RATIO, now);
    expect(r.tooOld).toBe(true);
    expect(r.status).toBe("none");
    // 근거(도지·다음봉)는 여전히 남아 있어야 화면에서 '왜 오래됐는지' 보여줄 수 있다.
    expect(r.dojiCandle).not.toBeNull();
  });

  it("watch 상태(다음 봉 아직 없음)여도 도지가 오래됐으면 none", () => {
    const now = 1 * MIN + (DOJI_MAX_AGE_MINUTES + 1) * MIN;
    const r = scanSessionPattern([highC, dojiC], 0, 0.3, WICK_MIN_RATIO, now);
    expect(r.tooOld).toBe(true);
    expect(r.status).toBe("none");
  });

  it("maxAgeMinutes를 직접 지정하면 그 기준을 따른다", () => {
    // 도지=1분, now=1분+3분=4분(경과 3분). 기준 5분이면 안 오래됨, 기준 2분이면 오래됨.
    const now = 1 * MIN + 3 * MIN;
    expect(scanSessionPattern([highC, dojiC, bearC], 0, 0.3, WICK_MIN_RATIO, now, 5).tooOld).toBe(false);
    expect(scanSessionPattern([highC, dojiC, bearC], 0, 0.3, WICK_MIN_RATIO, now, 2).tooOld).toBe(true);
  });
});

describe("[v0.62.1] 최고점→도지 간격 제한(RUBI 사례: 05:00 고점 → 08:55 도지)", () => {
  const highC = c(0, 98, 100, 97, 99); // 최고점(0분)
  const dojiAt = (min: number) => c(min * MIN, 99, 99.5, 98.5, 98.9); // 음봉 도지
  const bearAt = (min: number) => c(min * MIN, 98.9, 99, 98, 98.2);

  it("한도를 안 주면(과거 호출 호환) 간격과 무관 — 235분 뒤 도지도 그대로 confirmed", () => {
    const r = scanSessionPattern([highC, dojiAt(235), bearAt(240)], 0, 0.3);
    expect(r.status).toBe("confirmed");
    expect(r.gapFromHighMinutes).toBe(235);
    expect(r.tooFarFromHigh).toBe(false);
  });

  it("한도(30분)를 주면 235분 뒤 도지는 none + tooFarFromHigh (스크린샷 사례 차단)", () => {
    const r = scanSessionPattern([highC, dojiAt(235), bearAt(240)], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, true, 30);
    expect(r.status).toBe("none");
    expect(r.tooFarFromHigh).toBe(true);
    expect(r.gapFromHighMinutes).toBe(235);
    // 근거 표시용 도지 정보는 남겨 둔다(왜 탈락했는지 보여주기 위해)
    expect(r.dojiCandle).not.toBeNull();
  });

  it("다음봉 확인을 꺼도(도지만으로 확정) 간격 한도는 여전히 적용된다", () => {
    const r = scanSessionPattern([highC, dojiAt(235)], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, false, 30);
    expect(r.status).toBe("none");
  });

  it("한도 이내(10분 뒤)는 통과, 정확히 한도(30분)도 통과, 31분은 탈락", () => {
    expect(scanSessionPattern([highC, dojiAt(10), bearAt(15)], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, true, 30).status).toBe("confirmed");
    expect(scanSessionPattern([highC, dojiAt(30), bearAt(35)], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, true, 30).status).toBe("confirmed");
    expect(scanSessionPattern([highC, dojiAt(31), bearAt(36)], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, true, 30).status).toBe("none");
  });

  it("도지가 아예 없으면 간격은 null", () => {
    const r = scanSessionPattern([highC], 0, 0.3, WICK_MIN_RATIO, undefined, undefined, true, 30);
    expect(r.gapFromHighMinutes).toBeNull();
    expect(r.tooFarFromHigh).toBe(false);
  });
});

describe("미완성 5분봉 제외(dropIncompleteBucket)", () => {
  // 버킷 시작 0/5분/10분. 봉 [T,T+5분)은 now≥T+5분이라야 완성.
  const c0 = c(0, 1, 1, 1, 1);
  const c5 = c(5 * MIN, 2, 2, 2, 2);
  const c10 = c(10 * MIN, 3, 3, 3, 3);
  it("아직 끝나지 않은 마지막 봉(10분 버킷)을 now=12분이면 버린다", () => {
    const out = dropIncompleteBucket([c0, c5, c10], 12 * MIN);
    expect(out.map((x) => x.time)).toEqual([0, 5 * MIN]); // 10분 버킷 제외(끝=15분>12분)
  });
  it("그 봉이 마감되면(now=15분) 다시 포함된다", () => {
    expect(dropIncompleteBucket([c0, c5, c10], 15 * MIN).map((x) => x.time)).toEqual([0, 5 * MIN, 10 * MIN]);
  });

  it("[핵심] 확정 음봉이 아직 형성 중이면 confirmed가 아니라 watch로 남는다", () => {
    // 최고점(0) → 음봉 도지(5분) → 음봉(10분, 아직 형성 중)
    const high = c(0, 98, 100, 97, 99);
    const doji = c(5 * MIN, 99, 99.5, 98.5, 98.9);
    const bear = c(10 * MIN, 98.9, 99, 98, 98.2);
    // now=12분: 10분 봉 미완성 → 제외 → 도지까지만 → watch (성급한 확정 방지)
    const pending = dropIncompleteBucket([high, doji, bear], 12 * MIN);
    expect(scanSessionPattern(pending, 0, 0.3).status).toBe("watch");
    // now=15분: 10분 봉 완성 → 포함 → confirmed
    const done = dropIncompleteBucket([high, doji, bear], 15 * MIN);
    expect(scanSessionPattern(done, 0, 0.3).status).toBe("confirmed");
  });
});

describe("하이킨아시 변환(toHeikinAshi)", () => {
  it("첫 봉: HA종가=(O+H+L+C)/4, HA시가=(O+C)/2", () => {
    const ha = toHeikinAshi([c(0, 10, 12, 8, 11)]);
    expect(ha[0].close).toBeCloseTo(10.25, 6); // (10+12+8+11)/4
    expect(ha[0].open).toBeCloseTo(10.5, 6); //  (10+11)/2
    expect(ha[0].high).toBeCloseTo(12, 6); //    max(12, 10.5, 10.25)
    expect(ha[0].low).toBeCloseTo(8, 6); //      min(8, 10.5, 10.25)
    expect(ha[0].close < ha[0].open).toBe(true); // HA 음봉
  });
  it("둘째 봉: HA시가=(직전 HA시가+직전 HA종가)/2", () => {
    const ha = toHeikinAshi([c(0, 10, 12, 8, 11), c(1, 11, 13, 10, 12)]);
    expect(ha[1].open).toBeCloseTo((10.5 + 10.25) / 2, 6); // 10.375
    expect(ha[1].close).toBeCloseTo(11.5, 6); // (11+13+10+12)/4
    expect(ha[1].close > ha[1].open).toBe(true); // HA 양봉
  });
  it("일반캔들과 음/양이 달라질 수 있다(하이킨아시의 핵심)", () => {
    // 일반: 종가11>시가10 → 양봉. 하이킨아시: 종가10.25<시가10.5 → 음봉.
    const g = c(0, 10, 12, 8, 11);
    expect(g.close > g.open).toBe(true); // 일반 양봉
    const ha = toHeikinAshi([g])[0];
    expect(ha.close < ha.open).toBe(true); // HA 음봉 (반대!)
  });
});

describe("가격 필터(inPriceBand $1~$9)", () => {
  it("$1·$5·$9는 통과, $0.5·$9.01은 탈락, null 탈락", () => {
    expect(inPriceBand(1)).toBe(true);
    expect(inPriceBand(5)).toBe(true);
    expect(inPriceBand(9)).toBe(true);
    expect(inPriceBand(0.5)).toBe(false);
    expect(inPriceBand(9.01)).toBe(false);
    expect(inPriceBand(null)).toBe(false);
  });
});

describe("세션 시작시각(getSessionStart)", () => {
  it("서머 정규장(2026-07-16 23:00 KST)의 시작은 22:30", () => {
    const now = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 23, minute: 0 }, { zone: "Asia/Seoul" });
    expect(getSession(now)).toBe("regular");
    const start = getSessionStart(now);
    expect(start).not.toBeNull();
    expect(start!.setZone("Asia/Seoul").toFormat("HH:mm")).toBe("22:30"); // 개장 09:00 + 13.5h
  });
  it("데이마켓 시간(서머 10:00 KST)의 시작은 개장(09:00)", () => {
    const now = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 10, minute: 0 }, { zone: "Asia/Seoul" });
    expect(getSession(now)).toBe("day");
    expect(getSessionStart(now)!.setZone("Asia/Seoul").toFormat("HH:mm")).toBe("09:00");
  });
});

describe("엔진 스캔 왕복(연습 모드 + 목 서버)", () => {
  it("scanScreener가 끝까지 돌아 결과를 만들고, 데이터가 충분하다(5분봉≥200)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-scr-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true }); // 실계좌 안 건드림
      const run = await eng.scanScreener({ bodyRatio: 0.3, count: 10, priceMin: 1, priceMax: 9 }); // 최소치(10종목)로 빠르게
      expect(run.total).toBeGreaterThan(0);
      expect(run.total).toBeLessThanOrEqual(10); // ETF 제외로 10보다 작을 수 있음
      expect(run.results.length).toBe(run.total);
      // [v0.11.0] 사용한 가격대가 결과에 담긴다(화면 표시·검증용)
      expect(run.priceMin).toBe(1);
      expect(run.priceMax).toBe(9);
      // [v0.47.0 — 오너 요청 "어떤 필터가 적용됐는지 보이게"] 옵션을 안 주면(위 호출처럼
      //   bodyRatio/count/priceMin/priceMax만 줌) 나머지는 전부 기본값(켜짐)으로 echo돼야 한다.
      expect(run.emaTrendEnabled).toBe(true);
      expect(run.cloudEnabled).toBe(true);
      expect(run.dojiMaxAgeEnabled).toBe(true);
      expect(run.nextCandleConfirmEnabled).toBe(true);
      expect(run.excludeEtf).toBe(true);
      expect(run.emaPeriod).toBe(200);
      // 목 서버가 1300분치 1분봉을 주므로 5분봉 200개 이상 합성돼야 한다(데이터 부족 아님)
      const anySufficient = run.results.some((r) => r.status !== "insufficient" && r.n5m >= 200);
      expect(anySufficient).toBe(true);
      // 각 결과에 지표가 채워진다
      const ok = run.results.find((r) => r.status !== "insufficient")!;
      expect(ok.ema200).not.toBeNull();
      expect(ok.cloudTop).not.toBeNull();
      // [v0.16.0] 전봉종가(prevClose)가 채워진다 — 탐색→계산기 자동입력의 원천값(EMA200과 함께 넘긴다)
      expect(ok.prevClose).not.toBeNull();
      expect(typeof ok.prevClose).toBe("number");
      // [v0.6.1] 근거(evidence)와 가격밴드 필터가 붙는다
      expect(ok.evidence).not.toBeNull();
      expect(ok.evidence!.mode).toBe("ha"); // 하이킨아시 기준
      expect(typeof ok.priceInBand).toBe("boolean");
      expect(ok.evidence!.filters).toHaveProperty("priceBand");
      // [v0.6.3] 도지 꼬리 필터 칩이 근거에 있다
      expect(ok.evidence!.filters).toHaveProperty("bothWicks");
      eng.stopAllStrength();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000); // 페이지네이션·페이싱 때문에 넉넉히

  it("[v0.6.3] ETF·레버리지 종목은 스캔에서 배제된다(mock BITO=ETF)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-etf-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 상위 12종목에 BITO(mock에서 ETF) 포함 → 배제되어야 한다
      const run = await eng.scanScreener({ bodyRatio: 0.3, count: 12 });
      expect(run.excludedEtf).toBeGreaterThanOrEqual(1); // 최소 1개(BITO) 제외
      expect(run.results.some((r) => r.symbol === "BITO")).toBe(false); // 결과에 ETF 없음
      expect(run.total).toBe(12 - run.excludedEtf); // 스캔 대상은 제외 후 수
      eng.stopAllStrength();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // 12종목 페이지네이션 → 넉넉히

  it("[v0.47.0] 스캔 옵션을 끄면(off) ScreenRun에 꺼진 채로 echo된다 — 화면이 '그때 뭐가 켜져 있었는지' 정확히 보여주기 위한 근거", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-scr-opts-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const run = await eng.scanScreener({
        bodyRatio: 0.3, count: 10, priceMin: 1, priceMax: 9,
        emaTrendEnabled: false, cloudEnabled: false, dojiMaxAgeEnabled: false,
        nextCandleConfirmEnabled: false, excludeEtf: false, emaPeriod: 100,
      });
      expect(run.emaTrendEnabled).toBe(false);
      expect(run.cloudEnabled).toBe(false);
      expect(run.dojiMaxAgeEnabled).toBe(false);
      expect(run.nextCandleConfirmEnabled).toBe(false);
      expect(run.excludeEtf).toBe(false);
      expect(run.emaPeriod).toBe(100);
      eng.stopAllStrength();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("[v0.43.0] cancelScreenerScan — 스캔 중이 아니면 취소할 게 없다고 알린다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-scr-cancel-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const r = eng.cancelScreenerScan();
      expect(r.ok).toBe(false);
      expect(r.message).toContain("없습니다");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.43.0] cancelScreenerScan — 진행 중 취소하면 스캔이 취소 에러로 끝나고, 이후 새 스캔은 정상 재개된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-scr-cancel-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // scanScreener는 async 함수라 첫 await(prepareBackend) 전까지는 동기로 실행된다 — 즉 이 줄이
      // 끝난 시점엔 이미 screenBusy=true다. 그 직후(아직 첫 종목도 조회 전) 취소를 요청해도
      // scanScreener 루프가 반드시 그 요청을 확인하게 되므로(모든 루프 반복 시작 시 확인) 타이밍에
      // 흔들리지 않는 결정적인 테스트다.
      const scanPromise = eng.scanScreener({ bodyRatio: 0.3, count: 10, priceMin: 1, priceMax: 9 });
      const cancelResult = eng.cancelScreenerScan();
      expect(cancelResult.ok).toBe(true);
      expect(cancelResult.message).toContain("취소");

      await expect(scanPromise).rejects.toThrow(/취소/);

      // screenBusy가 제대로 풀렸는지 — 다음 스캔이 "이미 진행 중" 에러 없이 정상적으로 돈다.
      const run2 = await eng.scanScreener({ bodyRatio: 0.3, count: 10, priceMin: 1, priceMax: 9 });
      expect(run2.total).toBeGreaterThan(0);
      eng.stopAllStrength();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
