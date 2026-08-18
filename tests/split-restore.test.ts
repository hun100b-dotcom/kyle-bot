// =============================================================================
// tests/split-restore.test.ts — 옛 기록 [계산기로 불러오기] 되살리기 (v0.9.3)
// -----------------------------------------------------------------------------
// [배경 — 실제 사고]
//   "계산기로 불러오기 버튼이 안 눌린다"는 신고가 들어왔다. 원인은 버그가 아니라
//   **입력값 저장 기능이 생기기 전에 만든 기록**이라 버튼이 비활성이었던 것.
//   화면에는 이유가 잘 안 보였고(폰은 마우스 올리기가 없다), 사장님 기록 전부가 그 상태였다.
//
//   그래서 결과(진입가)에서 재료를 거꾸로 계산해 되살리기로 했다. 그 계산이 틀리면
//   엉뚱한 값이 계산기에 들어가므로, 왕복(계산 → 저장 → 되살리기)이 맞는지 테스트로 고정한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { restoreInputsFromSaved, type RestorableSplit } from "../lib/split-restore";
import { calcSplit3, calcOrderbook, calcCandle, getTick } from "../lib/calc";

describe("restoreInputsFromSaved — 삼분할", () => {
  it("[왕복] 계산 결과에서 전봉종가·EMA200 을 되살린다(1틱 이내)", () => {
    const baseClose = 305;
    const ema200 = 295;
    const { splits } = calcSplit3(baseClose, ema200, 2, 10);

    const saved: RestorableSplit = {
      symbol: "AAPL",
      technique: "split3",
      levels: splits.map((s) => ({ level: s.level, entry: s.entry })),
      tpPct: 2,
      slPct: 10,
      qty: 3,
    };

    const r = restoreInputsFromSaved(saved)!;
    expect(r).not.toBeNull();
    // EMA200 은 3분할 진입가 그대로 → 정확히 일치
    expect(Number(r.ema200)).toBe(ema200);
    // 전봉종가는 호가 절삭 때문에 1틱(0.01) 이내 오차 허용
    expect(Math.abs(Number(r.baseClose) - baseClose)).toBeLessThanOrEqual(0.01);
    // 조건들도 함께 복원
    expect(r.tpPct).toBe("2");
    expect(r.slPct).toBe("10");
    expect(r.qty).toBe("3");
    expect(r.symbol).toBe("AAPL");
    expect(r.technique).toBe("split3");
  });

  it("[왕복] 되살린 값으로 다시 계산하면 원래 타점과 거의 같다", () => {
    const { splits } = calcSplit3(48.2, 44.9, 3, 12);
    const saved: RestorableSplit = {
      symbol: "IONQ",
      technique: "split3",
      levels: splits.map((s) => ({ level: s.level, entry: s.entry })),
      tpPct: 3,
      slPct: 12,
      qty: 5,
    };

    const r = restoreInputsFromSaved(saved)!;
    const again = calcSplit3(Number(r.baseClose), Number(r.ema200), 3, 12);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(again.splits[i].entry - splits[i].entry)).toBeLessThanOrEqual(0.02);
    }
  });

  it("값이 이상하면(전봉종가 ≤ EMA200) 되살리지 않는다(null)", () => {
    const saved: RestorableSplit = {
      symbol: "BAD",
      technique: "split3",
      levels: [
        { level: 1, entry: 10 },
        { level: 2, entry: 10 },
        { level: 3, entry: 10 }, // gap 0 → 복원 불가
      ],
      tpPct: 2,
      slPct: 10,
      qty: 1,
    };
    expect(restoreInputsFromSaved(saved)).toBeNull();
  });

  it("분할이 빠져 있으면 되살리지 않는다(null)", () => {
    expect(
      restoreInputsFromSaved({
        symbol: "X",
        technique: "split3",
        levels: [{ level: 1, entry: 10 }], // 3분할 없음
        tpPct: null,
        slPct: null,
        qty: null,
      }),
    ).toBeNull();
  });
});

describe("restoreInputsFromSaved — 다른 기법", () => {
  it("호가창: 진입가에서 매수벽 가격을 되살린다", () => {
    const wall = 230;
    const o = calcOrderbook(wall, getTick(wall), 2, 10);
    const r = restoreInputsFromSaved({
      symbol: "T",
      technique: "orderbook",
      levels: [{ level: 1, entry: o.entry }],
      tpPct: 2,
      slPct: 10,
      qty: 1,
    })!;
    expect(Math.abs(Number(r.wallPrice) - wall)).toBeLessThanOrEqual(0.01);
    expect(r.baseClose).toBe(""); // 이 기법과 무관한 칸은 비어 있어야 한다
  });

  it("캔들: 진입가에서 현재봉 시가를 되살린다", () => {
    const open = 231.2;
    const o = calcCandle(open, getTick(open), 2, 10);
    const r = restoreInputsFromSaved({
      symbol: "N",
      technique: "candle",
      levels: [{ level: 1, entry: o.entry }],
      tpPct: 2,
      slPct: 10,
      qty: 1,
    })!;
    expect(Math.abs(Number(r.barOpen) - open)).toBeLessThanOrEqual(0.01);
  });

  it("수동 입력: 진입가가 그대로 들어간다", () => {
    const r = restoreInputsFromSaved({
      symbol: "M",
      technique: "manual",
      levels: [{ level: 1, entry: 12.34 }],
      tpPct: 2,
      slPct: 10,
      qty: 2,
    })!;
    expect(r.manualEntry).toBe("12.34");
  });
});
