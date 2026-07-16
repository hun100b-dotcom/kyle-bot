// =============================================================================
// tests/calc.test.ts  —  계산 엔진(lib/calc.ts) 검증
// -----------------------------------------------------------------------------
// 설계서에 적힌 "이 입력이면 이 값이 나와야 한다" 케이스를 그대로 옮긴 테스트입니다.
// 여기 전부 초록불(통과)이 떠야 계산 엔진이 사양대로 동작한다고 볼 수 있습니다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { calcSplit3, calcOrderbook, calcCandle, roundPrice, getTick } from "../lib/calc";

describe("calcSplit3 (삼분할 진입)", () => {
  it("(2.20, 1.93) → 1분할 2.11 / 2분할 2.02 / 3분할 1.93", () => {
    const { splits } = calcSplit3(2.2, 1.93, 2, 10);
    expect(splits[0].entry).toBe(2.11); // 1분할 = 2.20 - 0.27/3
    expect(splits[1].entry).toBe(2.02); // 2분할 = 2.20 - 0.27*2/3
    expect(splits[2].entry).toBe(1.93); // 3분할 = EMA200
  });

  it("(1.80, 1.93) → 에러(진입 필터 미충족: 전봉종가 <= EMA200)", () => {
    // gap = 1.80 - 1.93 < 0 이므로 진입 거부(예외).
    expect(() => calcSplit3(1.8, 1.93, 2, 10)).toThrow();
  });

  it("익절 2% / 손절 10%: 진입 2.11 → 익절 2.15 / 손절 1.89", () => {
    const { splits } = calcSplit3(2.2, 1.93, 2, 10);
    // 1분할(진입 2.11) 기준
    // 익절 = 2.11 * 1.02 = 2.1522 → roundPrice → 2.15
    // 손절 = 2.11 * 0.90 = 1.8990 → roundPrice → 1.89
    expect(splits[0].tp).toBe(2.15);
    expect(splits[0].sl).toBe(1.89);
  });
});

describe("calcOrderbook (호가창/매수벽 전략)", () => {
  it("calcOrderbook(1.85, 0.01) → 진입 1.86 (= 매수벽 + 1틱)", () => {
    expect(calcOrderbook(1.85, 0.01).entry).toBe(1.86);
  });
});

describe("calcCandle (캔들/현재봉 시가 전략)", () => {
  it("calcCandle(1.50, 0.01) → 진입 1.47 (= 시가 - 3틱)", () => {
    expect(calcCandle(1.5, 0.01).entry).toBe(1.47);
  });
});

describe("roundPrice (가격 절삭)", () => {
  it("roundPrice(0.73105) → 0.7310 ($1 미만: 소수 4자리 절삭)", () => {
    expect(roundPrice(0.73105)).toBe(0.731);
  });
  it("roundPrice(2.1522) → 2.15 ($1 이상: 소수 2자리 절삭)", () => {
    expect(roundPrice(2.1522)).toBe(2.15);
  });
  it("roundPrice(1.8990) → 1.89 (반올림 아님, 절삭 확인)", () => {
    expect(roundPrice(1.899)).toBe(1.89);
  });
});

describe("getTick (호가 단위)", () => {
  it("getTick(0.99) → 0.0001 ($1 미만)", () => {
    expect(getTick(0.99)).toBe(0.0001);
  });
  it("getTick(1.00) → 0.01 ($1 이상)", () => {
    expect(getTick(1.0)).toBe(0.01);
  });
});
