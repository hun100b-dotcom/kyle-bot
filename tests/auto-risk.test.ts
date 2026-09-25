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
import { canAutoEnter, isLossLimitBreached, perSlotInvestPct, type AutoTradeLimits } from "../lib/auto-risk";

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

describe("perSlotInvestPct — 슬롯당 투입 비율 균등 분배", () => {
  it("총 한도를 종목 수만큼 나눈다", () => {
    expect(perSlotInvestPct(30, 3)).toBe(10);
    expect(perSlotInvestPct(30, 1)).toBe(30);
  });
  it("이상값(0 이하)은 0을 돌려준다", () => {
    expect(perSlotInvestPct(0, 3)).toBe(0);
    expect(perSlotInvestPct(30, 0)).toBe(0);
    expect(perSlotInvestPct(-10, 3)).toBe(0);
  });
});
