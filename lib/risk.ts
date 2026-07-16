// =============================================================================
// lib/risk.ts  —  안전장치(리스크 게이트) (설계서 M5)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   "이 주문을 실제로 내도 되는가?"를 판단하는 문지기(게이트)입니다.
//   자동매매 봇은 사람이 매번 확인하지 않으니, 사고를 막는 자동 안전장치가
//   반드시 필요합니다. 이 파일이 그 안전장치들의 모음입니다.
//
// [설계 원칙: 안전장치 우선]
//   실제 주문을 내는 코드(실행부, 아직 없음)는 반드시 이 게이트(canPlaceOrder)를
//   먼저 통과해야만 주문을 낼 수 있게 만듭니다. 게이트가 막으면(allowed=false)
//   주문은 절대 나가지 않습니다. "돌다리도 두들겨 보고 건너는" 구조입니다.
//   → 실행부 연결 지점은 이 파일 하단 TODO 주석 참고.
//
// [순수 로직이라 100% 검증 가능]
//   네트워크·키 없이, 입력(현재 상태 + 주문 + 설정)만으로 판단합니다.
//   그래서 모든 차단/통과 케이스를 vitest로 완벽히 테스트할 수 있습니다.
//
// [미확정 수치는 "기본값 + 설정 가능" 구조]
//   일일 손실 한도·연속 손절 컷 등 구체 수치는 아직 확정 전입니다(설계서).
//   그래서 합리적 기본값을 두되, 설정으로 언제든 바꿀 수 있게 했습니다.
//   확정되면 DEFAULT_RISK_CONFIG 값만 바꾸면 됩니다.
// =============================================================================

// -----------------------------------------------------------------------------
// 1) 차단 사유 (왜 막혔는지)
// -----------------------------------------------------------------------------
// [왜 문자열 코드로?] "그냥 막힘"이 아니라 "무엇 때문에 막혔는지"를 정확히 남겨야
//   로그·대시보드에서 원인을 알 수 있고, 사람이 판단해 대응할 수 있습니다.
export type BlockReason =
  | "KILL_SWITCH" //          킬 스위치 작동(사람이 비상정지 누름)
  | "HALTED" //               이미 거래 정지 상태(risk_state.halted)
  | "DAILY_LOSS_LIMIT" //     일일 손실 한도 도달
  | "CONSECUTIVE_LOSS_CUT" // 연속 손절 컷
  | "MAX_ORDERS" //           일일 최대 주문 횟수 초과
  | "ORDER_AMOUNT_LIMIT" //   세션당 주문 금액 상한 초과
  | "SEED_EXCEEDED" //        매수가능금액(시드) 초과
  | "PRICE_ANOMALY"; //       가격 이상(현재가 대비 크게 벗어남)

/** 각 차단 사유의 한국어 설명(로그·화면 표시용) */
export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  KILL_SWITCH: "킬 스위치가 켜져 있어 신규 주문을 전면 차단합니다.",
  HALTED: "이미 거래 정지 상태입니다.",
  DAILY_LOSS_LIMIT: "일일 손실 한도에 도달해 오늘은 신규 주문을 막습니다.",
  CONSECUTIVE_LOSS_CUT: "연속 손절 한도에 도달해 자동 중단합니다.",
  MAX_ORDERS: "오늘 최대 주문 횟수를 초과했습니다.",
  ORDER_AMOUNT_LIMIT: "세션당 주문 금액 상한을 초과했습니다.",
  SEED_EXCEEDED: "주문 금액이 매수 가능 금액(시드)을 초과합니다.",
  PRICE_ANOMALY: "주문 가격이 현재가에서 너무 벗어났습니다(입력 오타 의심).",
};

// -----------------------------------------------------------------------------
// 2) 설정값 (기본값 + 설정 가능)
// -----------------------------------------------------------------------------
export interface RiskConfig {
  /** 드라이런(모의) 모드. true면 실주문 대신 로그만. 초기 기본값 true(안전). */
  dryRun: boolean;
  /** 일일 손실 한도(%). 이 값 "이하"로 내려가면 차단. 음수로 표기(예: -3 = -3%). */
  dailyLossLimitPct: number;
  /** 하루 최대 주문 횟수. 이 값 "이상"이면 차단. */
  maxOrdersPerDay: number;
  /** 연속 손절 컷 횟수. 이 값 "이상" 연속 손절 시 중단. */
  consecutiveLossCut: number;
  /** 세션당 주문 금액 상한(달러). 세션 누적 + 이번 주문이 넘으면 거부. */
  maxOrderAmountUsd: number;
  /** 가격 이상 허용 편차(%). 현재가 대비 이 % 넘게 벗어나면 거부(오타 방지). */
  priceDeviationPct: number;
}

/**
 * DEFAULT_RISK_CONFIG — 기본 안전장치 설정.
 *
 * [TODO(수치 확정)] 아래 숫자들은 설계서에서 아직 "미확정"입니다. 지금은 보수적인
 *   제안값을 넣어 뒀습니다. 실제 운용 전에 오너가 확정하면 이 값만 바꾸면 됩니다.
 *   - dailyLossLimitPct: -3  → 하루 -3% 손실이면 그날 멈춤(제안)
 *   - maxOrdersPerDay:   20  → 하루 20건 넘으면 과매매로 보고 차단(제안)
 *   - consecutiveLossCut: 3  → 3연속 손절이면 뭔가 잘못됐다고 보고 중단(제안)
 *   - maxOrderAmountUsd: 1000 → 한 세션에서 최대 $1000까지만(제안)
 *   - priceDeviationPct: 5   → 현재가 ±5% 벗어난 주문가는 오타로 의심(제안)
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  dryRun: true,
  dailyLossLimitPct: -3,
  maxOrdersPerDay: 20,
  consecutiveLossCut: 3,
  maxOrderAmountUsd: 1000,
  priceDeviationPct: 5,
};

/** 부분 설정을 기본값과 합쳐 완전한 설정으로 만든다(안 준 값은 기본값 사용). */
export function mergeRiskConfig(partial?: Partial<RiskConfig>): RiskConfig {
  return { ...DEFAULT_RISK_CONFIG, ...(partial ?? {}) };
}

// -----------------------------------------------------------------------------
// 3) 입력 타입
// -----------------------------------------------------------------------------

/** 오늘의 리스크 상태(DB risk_state 한 행에 대응) */
export interface RiskState {
  trade_date: string;
  realized_pnl_pct: number; // 그날 실현 손익률(%)
  order_count: number; // 그날 낸 주문 수
  consecutive_losses: number; // 연속 손절 횟수
  halted: boolean; // 이미 정지됐는지
  halt_reason?: string | null;
}

/** 검사 대상 주문(이 주문을 내도 되는지 볼 대상) */
export interface OrderIntent {
  symbol: string;
  side: "BUY" | "SELL";
  price?: number; // 지정가(있으면 가격 이상 검사)
  amountUsd?: number; // 이 주문에 쓸 금액(있으면 금액/시드 검사)
}

/** 판단에 필요한 현재 맥락(설정·현재가·잔고·스위치 등) */
export interface RiskContext {
  config?: Partial<RiskConfig>;
  currentPrice?: number; // 가격 이상 검사 기준(현재 시장가)
  buyingPowerUsd?: number; // 매수 가능 금액(시드 초과 검사)
  sessionSpentUsd?: number; // 이 세션에서 이미 쓴 금액(금액 상한 검사)
  killSwitch?: boolean; // 킬 스위치 상태
}

/** 게이트가 취할 행동 모드 */
export type ExecutionMode =
  | "LIVE" //     안전장치 통과 + 실거래 → 실제 주문
  | "DRY_RUN" //  안전장치 통과 + 드라이런 → 실주문 없이 로그만
  | "BLOCKED"; // 안전장치가 막음 → 아무 주문도 안 함

/** 게이트 판정 결과 */
export interface RiskDecision {
  /** 위험 게이트를 전부 통과했는가? (드라이런 여부와 무관) */
  allowed: boolean;
  /** 막힌 이유(통과면 null) */
  reason: BlockReason | null;
  /** 이유의 한국어 설명(통과면 "정상") */
  reasonText: string;
  /** 실행부가 실제로 취할 행동: LIVE / DRY_RUN / BLOCKED */
  mode: ExecutionMode;
}

// -----------------------------------------------------------------------------
// 4) 핵심: canPlaceOrder — 주문 가능?/왜 막혔나
// -----------------------------------------------------------------------------
/**
 * canPlaceOrder — 이 주문을 내도 되는지 모든 안전장치를 순서대로 검사한다.
 *
 *   위험한 것부터(킬스위치·정지·손실한도…) 차례로 확인하고, 하나라도 걸리면
 *   거기서 멈추고 "막힘 + 이유"를 돌려줍니다. 전부 통과하면 통과입니다.
 *
 * [반환]
 *   - allowed=false, reason=BLOCK, mode='BLOCKED' : 막힘
 *   - allowed=true,  reason=null, mode='DRY_RUN'  : 통과했지만 드라이런(로그만)
 *   - allowed=true,  reason=null, mode='LIVE'     : 통과 + 실거래(실주문 가능)
 *
 * [왜 순서(우선순위)가 있나?] 여러 개가 동시에 걸릴 수 있는데, 가장 중대한 사유를
 *   먼저 알려주는 게 대응에 유리합니다(예: 킬스위치가 손실한도보다 우선).
 */
export function canPlaceOrder(state: RiskState, order: OrderIntent, ctx: RiskContext = {}): RiskDecision {
  const cfg = mergeRiskConfig(ctx.config);

  // 막힘 결과를 만드는 작은 도우미.
  const block = (reason: BlockReason): RiskDecision => ({
    allowed: false,
    reason,
    reasonText: BLOCK_REASON_TEXT[reason],
    mode: "BLOCKED",
  });

  // (1) 킬 스위치: 사람이 누른 비상정지. 무엇보다 우선해서 전면 차단.
  if (ctx.killSwitch === true) return block("KILL_SWITCH");

  // (2) 이미 정지 상태: 앞선 사고로 halted가 켜져 있으면 더 진행 안 함.
  if (state.halted === true) return block("HALTED");

  // (3) 일일 손실 한도: 실현 손익률이 한도 이하로 내려갔으면 오늘은 그만.
  //     예) 한도 -3%, 현재 -3.2% → -3.2 <= -3 → 차단.
  if (state.realized_pnl_pct <= cfg.dailyLossLimitPct) return block("DAILY_LOSS_LIMIT");

  // (4) 연속 손절 컷: 연달아 N번 손절이면 전략이 안 맞는 상황일 수 있어 중단.
  if (state.consecutive_losses >= cfg.consecutiveLossCut) return block("CONSECUTIVE_LOSS_CUT");

  // (5) 일일 최대 주문 횟수: 과도한 주문(오작동·과매매) 방지.
  if (state.order_count >= cfg.maxOrdersPerDay) return block("MAX_ORDERS");

  // (6) 세션당 주문 금액 상한: 이미 쓴 금액 + 이번 금액이 상한을 넘으면 거부.
  //     (amountUsd가 있을 때만 검사 — 매도 등 금액이 없는 주문은 건너뜀)
  if (order.amountUsd !== undefined) {
    const spent = ctx.sessionSpentUsd ?? 0;
    if (spent + order.amountUsd > cfg.maxOrderAmountUsd) return block("ORDER_AMOUNT_LIMIT");
  }

  // (7) 시드 초과: 주문 금액이 매수 가능 금액보다 크면 애초에 못 삼 → 거부.
  //     (어댑터의 preflightBuyCheck와 연동되는 마지막 안전선)
  if (order.amountUsd !== undefined && ctx.buyingPowerUsd !== undefined) {
    if (order.amountUsd > ctx.buyingPowerUsd) return block("SEED_EXCEEDED");
  }

  // (8) 가격 이상 감지: 주문가가 현재가에서 ±N% 넘게 벗어나면 입력 오타로 의심 → 거부.
  //     예) 현재가 2.10인데 실수로 21.0을 넣으면 900% 벗어남 → 차단.
  if (order.price !== undefined && ctx.currentPrice !== undefined && ctx.currentPrice > 0) {
    const deviationPct = (Math.abs(order.price - ctx.currentPrice) / ctx.currentPrice) * 100;
    if (deviationPct > cfg.priceDeviationPct) return block("PRICE_ANOMALY");
  }

  // 모든 위험 게이트 통과 → 드라이런이면 로그만, 실거래면 실주문.
  return {
    allowed: true,
    reason: null,
    reasonText: "정상(모든 안전장치 통과)",
    mode: cfg.dryRun ? "DRY_RUN" : "LIVE",
  };
}

// -----------------------------------------------------------------------------
// 5) 킬 스위치 보조: 미체결 전량 취소 대상 뽑기
// -----------------------------------------------------------------------------
/**
 * killSwitchCancelTargets — 킬 스위치가 켜졌을 때 "취소해야 할 미체결 주문"의
 *   토스 주문번호 목록을 뽑아준다.
 *
 * [왜 함수로?] 킬 스위치는 신규 주문 차단(canPlaceOrder에서 처리)만으로 끝나지 않고,
 *   이미 걸어둔 미체결 주문도 전부 거둬들여야 진짜 "정지"가 됩니다.
 *   실행부는 이 목록을 받아 toss.cancelOrder(id)를 하나씩 호출하면 됩니다.
 *
 * [주의] 설계서 M0-A: 마감 1분 전은 취소 불가 구간입니다. 실행부에서
 *   session.isOrderFrozen()으로 그 구간을 피해 호출해야 합니다(여기선 대상만 계산).
 */
export function killSwitchCancelTargets(
  openOrders: Array<{ tossOrderId: string; status: string }>,
): string[] {
  // 아직 살아있는(체결·취소되지 않은) 주문만 취소 대상.
  const alive = new Set(["submitted", "partial", "pending"]);
  return openOrders.filter((o) => alive.has(o.status)).map((o) => o.tossOrderId);
}

// =============================================================================
// [실행부 연결 지점 — TODO(다음 단계)]
//   실제 주문을 내는 코드가 생기면(현재 없음), 반드시 아래 순서를 지킨다:
//     1) const decision = canPlaceOrder(state, order, ctx)
//     2) if (decision.mode === 'BLOCKED') → 주문 안 함(이유 로깅/알림)
//     3) if (decision.mode === 'DRY_RUN') → 실주문 대신 "이런 주문을 냈을 것" 로그만
//     4) if (decision.mode === 'LIVE')    → toss.createOrder(...) 실제 호출
//   또한 킬 스위치가 켜지면 killSwitchCancelTargets로 미체결을 전량 취소한다.
//   이 게이트를 우회해 createOrder를 직접 부르는 경로는 절대 만들지 않는다(안전장치 우선).
// =============================================================================
