// =============================================================================
// lib/auto-risk.ts — 자동매매 안전장치 게이트 (v0.26.0)
// -----------------------------------------------------------------------------
// [왜 이 파일이 필요한가?]
//   CLAUDE.md에는 예전부터 "신규 진입 주문은 반드시 lib/risk.ts의 canPlaceOrder 게이트를
//   통과해야만 나간다(우회 경로 금지)"는 안전 규칙이 적혀 있다. 그런데 실제로 이 저장소를
//   조사해 보니 lib/risk.ts·lib/worker.ts·lib/lifecycle.ts는 이미 예전(v1→v2 전환) 어느
//   시점에 삭제되어 있었다(문서만 남고 실제 코드가 없는 상태 — 오너에게 이 사실을 보고함).
//   자동매매(사람이 매번 버튼을 누르지 않고 프로그램이 스스로 진입하는 기능)를 처음 만드는
//   지금이야말로 "신규 진입 전에는 반드시 이 게이트를 통과해야 한다"는 원칙이 진짜로
//   필요해지는 순간이라, 이 파일로 그 정신을 다시 세운다.
//
// [왜 순수 함수로 만드나?]
//   판단(사람이 정한 한도)과 실행(주문 전송)을 분리하기 위해서다. 이 파일은 네트워크를
//   호출하지 않고 "숫자만 보고 허용/거부를 결정"하므로, vitest로 모든 경계값을 눈으로
//   확인할 수 있다. electron/tool-engine.ts의 자동매매 루프는 매 진입 시도 전에 반드시
//   canAutoEnter()를 호출해야 하며, 이 게이트를 건너뛰는 경로가 있으면 안 된다(우회 금지).
// =============================================================================

/** 오너가 설정 탭에서 직접 조절하는 자동매매 한도(전부 수동 수정 가능). */
export interface AutoTradeLimits {
  /** 자동매매 켜짐 여부(마스터 스위치). 꺼져 있으면 무조건 거부. */
  enabled: boolean;
  /** 동시에 보유할 최대 종목 수(오너 기본값 3). */
  maxPositions: number;
  /** 최대손실 한도(시드 대비 %). 이 자동매매 실행 동안의 누적 실현손실이 이 비율을 넘으면 중단. */
  maxLossPct: number;
  /** 시드 대비 총 투입 비율 한도(%). 종목 수만큼 나눠서 슬롯당 예산을 정한다. */
  maxInvestPct: number;
}

/** 진입 시도 하나를 판단하기 위해 필요한 현재 상태값. */
export interface AutoRiskInput {
  limits: AutoTradeLimits;
  /** 지금 자동매매로 보유·감시 중인 종목 수(이번 진입 포함 전). */
  activePositionCount: number;
  /** 이번 자동매매 실행(시작~지금) 동안 누적 실현손익(달러). 손실이면 음수. */
  realizedPnlUsd: number;
  /** 시드 기준 금액(달러) — 매수가능금액 또는 오너가 정한 고정 시드. 모르면 null. */
  seedUsd: number | null;
  /** 이번 진입에 배정한(예산÷가격으로 계산한) 수량. */
  candidateQty: number;
}

export interface AutoRiskResult {
  allow: boolean;
  /** 거부 이유(한국어, 저널에 그대로 써도 되는 문장). allow=true면 없음. */
  reason?: string;
}

/**
 * isLossLimitBreached — 누적 실현손실이 "시드 대비 maxLossPct%" 한도를 넘었는지만 순수하게 판단.
 *   canAutoEnter 내부에서도 쓰지만, 자동매매 루프가 "새 진입 없이도 지금 당장 꺼야 하는지"를
 *   매 사이클 확인할 때도 이 함수만 따로 부른다(진입 후보가 없어도 손실 한도 감시는 계속돼야 함).
 */
export function isLossLimitBreached(realizedPnlUsd: number, seedUsd: number | null, maxLossPct: number): boolean {
  if (seedUsd == null || !Number.isFinite(seedUsd) || seedUsd <= 0) return false; // 시드를 모르면 판단 보류(막지 않음)
  if (!Number.isFinite(maxLossPct) || maxLossPct <= 0) return false;
  const maxLossUsd = seedUsd * (maxLossPct / 100);
  return realizedPnlUsd <= -maxLossUsd;
}

/**
 * canAutoEnter — 자동매매가 새 진입을 하나 넣어도 되는지 최종 판단(단일 관문).
 *   [순서가 중요] 마스터 스위치 → 종목 수 한도 → 손실 한도 → 시드 확인 → 수량(1주 미만이면 무의미)
 *   순으로 검사해, 거부 이유가 가장 근본적인 것부터 나오게 한다.
 */
export function canAutoEnter(input: AutoRiskInput): AutoRiskResult {
  const { limits } = input;
  if (!limits.enabled) return { allow: false, reason: "자동매매가 꺼져 있습니다." };
  if (!Number.isFinite(limits.maxPositions) || limits.maxPositions <= 0) {
    return { allow: false, reason: "최대 종목 수 설정이 올바르지 않습니다." };
  }
  if (input.activePositionCount >= limits.maxPositions) {
    return { allow: false, reason: `최대 종목 수(${limits.maxPositions}개)에 도달했습니다.` };
  }
  if (isLossLimitBreached(input.realizedPnlUsd, input.seedUsd, limits.maxLossPct)) {
    return { allow: false, reason: `최대손실 한도(시드 대비 ${limits.maxLossPct}%)에 도달해 자동매매를 멈춥니다.` };
  }
  if (input.seedUsd == null || input.seedUsd <= 0) {
    return { allow: false, reason: "시드(매수가능금액) 확인이 안 돼 진입할 수 없습니다." };
  }
  if (!Number.isFinite(input.candidateQty) || input.candidateQty < 1) {
    return { allow: false, reason: "배정된 예산으로 1주도 살 수 없어 건너뜁니다." };
  }
  return { allow: true };
}

/**
 * perSlotInvestPct — "시드 대비 총 투입 비율 한도"를 종목 수만큼 균등 분배해 슬롯 하나의
 *   투입 비율(%)을 구한다. 예: 총 한도 30%, 최대 3종목 → 슬롯당 10%.
 *   [왜 균등 분배인가?] 오너가 더 세밀한 기준(예: 종목마다 비중 다르게)을 요청하기 전까지는
 *   "간단하고 확실하게"가 원칙이라, 가장 이해하기 쉬운 규칙을 쓴다.
 */
export function perSlotInvestPct(maxInvestPct: number, maxPositions: number): number {
  if (!Number.isFinite(maxInvestPct) || maxInvestPct <= 0) return 0;
  if (!Number.isFinite(maxPositions) || maxPositions <= 0) return 0;
  return maxInvestPct / maxPositions;
}
