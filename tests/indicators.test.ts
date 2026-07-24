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
import { aggregate1mTo5m, dropIncompleteBucket, toHeikinAshi, inPriceBand, ema, ichimoku, isBearishDoji, scanSessionPattern, type Candle } from "../lib/indicators";
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

describe("음봉 도지(isBearishDoji)", () => {
  it("종가<시가 + 몸통이 범위의 30% 이하면 도지", () => {
    // open 100, close 99.9 (몸통 0.1), high 100.5 low 99.5 (범위 1.0) → 0.1/1.0=10% ≤ 30%
    expect(isBearishDoji(c(0, 100, 100.5, 99.5, 99.9), 0.3)).toBe(true);
  });
  it("양봉이면(종가≥시가) 도지 아님", () => {
    expect(isBearishDoji(c(0, 100, 100.5, 99.5, 100.2), 0.3)).toBe(false);
  });
  it("몸통이 크면(범위의 30% 초과) 도지 아님", () => {
    // 몸통 0.5, 범위 1.0 → 50% > 30%
    expect(isBearishDoji(c(0, 100, 100.4, 99.4, 99.5), 0.3)).toBe(false);
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
      const run = await eng.scanScreener(0.3, 5); // 5종목만 빠르게
      expect(run.total).toBe(5);
      expect(run.results.length).toBe(5);
      // 목 서버가 1300분치 1분봉을 주므로 5분봉 200개 이상 합성돼야 한다(데이터 부족 아님)
      const anySufficient = run.results.some((r) => r.status !== "insufficient" && r.n5m >= 200);
      expect(anySufficient).toBe(true);
      // 각 결과에 지표가 채워진다
      const ok = run.results.find((r) => r.status !== "insufficient")!;
      expect(ok.ema200).not.toBeNull();
      expect(ok.cloudTop).not.toBeNull();
      // [v0.6.1] 근거(evidence)와 가격밴드 필터가 붙는다
      expect(ok.evidence).not.toBeNull();
      expect(ok.evidence!.mode).toBe("ha"); // 하이킨아시 기준
      expect(typeof ok.priceInBand).toBe("boolean");
      expect(ok.evidence!.filters).toHaveProperty("priceBand");
      eng.stopAllStrength();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000); // 페이지네이션·페이싱 때문에 넉넉히
});
