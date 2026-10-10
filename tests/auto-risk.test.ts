// =============================================================================
// tests/auto-risk.test.ts — 자동매매 안전장치 게이트 테스트 (v0.26.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나?]
//   lib/auto-risk.ts는 자동매매가 신규 진입을 넣기 전 반드시 통과해야 하는 단일 관문이다
//   (CLAUDE.md의 예전 lib/risk.ts canPlaceOrder 원칙을 v2 방식으로 재구현한 것 — 실제
//   lib/risk.ts 파일은 조사 결과 이미 삭제되어 있었음). 이 게이트가 조용히 틀리면 최대
//   종목 수를 넘겨 진입하거나, 손실 한도를 넘겨서도 계속 매매하는 가장 위험한 사고로
//   이어지므로 경계값까지 전부 고정한다. 순수 함수라 네트워크·엔진 없이 빠르게 검증된다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { canAutoEnter, isLossLimitBreached, volScaledInvestPct, type AutoTradeLimits } from "../lib/auto-risk";

const LIMITS: AutoTradeLimits = { enabled: true, maxPositions: 3, maxLossPct: 5, maxInvestPct: 30 };

describe("isLossLimitBreached", () => {
  it("시드 대비 손실이 한도 미만이면 아직 안 넘음", () => {
    // 시드 $1000, 한도 5% → $50. 손실 $49면 아직.
    expect(isLossLimitBreached(-49, 1000, 5)).toBe(false);
  });
  it("시드 대비 손실이 한도와 같거나 넘으면 넘음(경계값 포함)", () => {
    expect(isLossLimitBreached(-50, 1000, 5)).toBe(true); // 정확히 한도
    expect(isLossLimitBreached(-51, 1000, 5)).toBe(true); // 한도 초과
  });
  it("이익 중이면(양수) 당연히 안 넘음", () => {
    expect(isLossLimitBreached(120, 1000, 5)).toBe(false);
  });
  it("시드를 모르면(null/0/음수) 판단을 보류한다(막지 않음)", () => {
    expect(isLossLimitBreached(-9999, null, 5)).toBe(false);
    expect(isLossLimitBreached(-9999, 0, 5)).toBe(false);
    expect(isLossLimitBreached(-9999, -100, 5)).toBe(false);
  });
  it("한도(maxLossPct)가 0 이하면 판단을 보류한다", () => {
    expect(isLossLimitBreached(-9999, 1000, 0)).toBe(false);
    expect(isLossLimitBreached(-9999, 1000, -5)).toBe(false);
  });
});

describe("canAutoEnter — 진입 허용/거부 판단", () => {
  it("모든 조건이 정상이면 허용", () => {
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 1, realizedPnlUsd: 0, seedUsd: 1000, candidateQty: 5 });
    expect(r.allow).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("자동매매가 꺼져 있으면(enabled:false) 거부", () => {
    const r = canAutoEnter({ limits: { ...LIMITS, enabled: false }, activePositionCount: 0, realizedPnlUsd: 0, seedUsd: 1000, candidateQty: 5 });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("꺼져");
  });

  it("현재 보유 종목 수가 최대치에 '도달'하면 거부(경계값)", () => {
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 3, realizedPnlUsd: 0, seedUsd: 1000, candidateQty: 5 });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("종목 수");
  });

  it("보유 종목 수가 최대치보다 하나 적으면 허용(경계값)", () => {
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 2, realizedPnlUsd: 0, seedUsd: 1000, candidateQty: 5 });
    expect(r.allow).toBe(true);
  });

  it("최대손실 한도를 넘었으면(시드 대비 %) 거부", () => {
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 0, realizedPnlUsd: -60, seedUsd: 1000, candidateQty: 5 }); // 한도 5%=$50, 손실 $60
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("손실");
  });

  it("시드를 확인할 수 없으면(null) 거부", () => {
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 0, realizedPnlUsd: 0, seedUsd: null, candidateQty: 5 });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("시드");
  });

  it("배정 예산으로 1주도 못 사면(candidateQty<1) 거부", () => {
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 0, realizedPnlUsd: 0, seedUsd: 1000, candidateQty: 0 });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("예산");
  });

  it("거부 이유는 가장 근본적인 것부터 나온다(종목 수 > 손실 > 시드 > 수량 순)", () => {
    // 종목 수도 꽉 찼고 손실 한도도 넘겼다면, '종목 수' 사유가 먼저 나와야 한다
    // (사이클 루프가 이 사유를 보고 더 시도할지 말지 결정하므로 순서가 중요).
    const r = canAutoEnter({ limits: LIMITS, activePositionCount: 3, realizedPnlUsd: -60, seedUsd: 1000, candidateQty: 5 });
    expect(r.reason).toContain("종목 수");
  });
});

describe("canAutoEnter — 종목당 투입 비율은 종목 수로 나뉘지 않는다(2026-09-25 버그 수정 검증)", () => {
  it("종목 수가 3이어도 maxInvestPct(30%)는 그대로 종목 1개당 배정 비율이다", () => {
    // 옛(버그) 동작이었다면 30%÷3종목=10%로 계산돼 시드 $1000·가격 $9.20에서 예산 $100×
    // (10%중략 아님, 이 테스트는 엔진 쪽 예산 계산이 아니라 게이트가 나눗셈을 하지 않는지만 확인).
    // 시드 $1000, 투입비율 30% 그대로 → 예산 $300, 가격 $9.20 → qty=32주(옛 버그였다면 10%=$100→10주).
    const seedUsd = 1000;
    const maxInvestPct = 30;
    const price = 9.2;
    const budget = seedUsd * (maxInvestPct / 100); // 게이트가 나누지 않는다는 전제하의 올바른 예산
    const qty = Math.floor(budget / price);
    expect(budget).toBe(300); // 옛 버그였다면 100(=1000*0.10)이었을 값
    expect(qty).toBe(32); // 옛 버그였다면 10이었을 값(1주가 아니라 32주가 정상)

    const r = canAutoEnter({
      limits: { enabled: true, maxPositions: 3, maxLossPct: 5, maxInvestPct },
      activePositionCount: 0,
      realizedPnlUsd: 0,
      seedUsd,
      candidateQty: qty,
    });
    expect(r.allow).toBe(true);
  });
});

describe("volScaledInvestPct — ATR(변동성)에 반비례한 투입 비율 축소(v0.72.0, '2번' 지시 반영)", () => {
  it("ATR이 기준(기본 6%)과 같으면 깎지 않는다(scale=1 경계값)", () => {
    expect(volScaledInvestPct(30, 6)).toBe(30);
  });

  it("ATR이 기준보다 낮아 안정적이어도 원래 비율보다 늘리지는 않는다(방어적 스케일링만)", () => {
    // 6/3=2배 스케일이 나오지만 Math.min(1, ...)로 상한이 걸려야 한다.
    expect(volScaledInvestPct(30, 3)).toBe(30);
  });

  it("ATR이 기준의 2배(12%)면 절반으로 깎인다", () => {
    expect(volScaledInvestPct(30, 12)).toBe(15); // 30 * min(1, 6/12=0.5) = 15
  });

  it("ATR이 아주 높아도 바닥선(기본 0.4) 밑으로는 안 깎인다", () => {
    // 6/30=0.2인데 floorScale 0.4가 더 크므로 0.4가 적용돼야 한다.
    expect(volScaledInvestPct(30, 30)).toBe(12); // 30 * 0.4 = 12
  });

  it("바닥선 경계값 — scale이 정확히 floorScale과 같으면 그 값 그대로", () => {
    // referenceAtrPct(6) / candidateAtrPct(15) = 0.4 = floorScale 기본값과 정확히 일치.
    expect(volScaledInvestPct(30, 15)).toBe(12); // 30 * 0.4 = 12
  });

  it("ATR을 모르면(null) 원래 비율을 그대로 돌려준다 — 깎지 않는다", () => {
    expect(volScaledInvestPct(30, null)).toBe(30);
  });

  it("ATR이 비정상값(NaN/0/음수)이어도 원래 비율을 그대로 돌려준다(안전한 폴백)", () => {
    expect(volScaledInvestPct(30, NaN)).toBe(30);
    expect(volScaledInvestPct(30, 0)).toBe(30);
    expect(volScaledInvestPct(30, -5)).toBe(30);
  });

  it("referenceAtrPct·floorScale을 직접 지정하면 그 값으로 계산한다", () => {
    // 기준을 10%로, 바닥을 0.5로 바꾼 경우: ATR 20% → 10/20=0.5배, 바닥(0.5)과 같아 그대로 0.5배.
    expect(volScaledInvestPct(30, 20, 10, 0.5)).toBe(15);
  });
});
