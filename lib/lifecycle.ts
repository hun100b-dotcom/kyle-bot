// =============================================================================
// lib/lifecycle.ts  —  주문 라이프사이클 오케스트레이션 (설계서 M3)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   지금까지 만든 조각들 — 계산(calc)·세션(session)·안전장치(risk)·어댑터(toss) —
//   을 하나로 엮어, "실제로 주문을 내고 관리하는" 흐름을 담당합니다.
//   이 파일이 봇의 "행동 대장"입니다.
//
// [상태 흐름(상태머신)]
//   draft(초안) → armed(진입 지정가 등록) → active(체결 감지) → closed(청산 완료)
//
// [가장 중요한 원칙: 안전장치 우선 — 우회 경로 없음]
//   신규 진입 주문은 반드시 risk.canPlaceOrder 게이트를 먼저 통과해야만 나갑니다.
//     - BLOCKED  → 주문 안 냄
//     - DRY_RUN  → 실주문 대신 "이런 주문을 냈을 것" 로그만
//     - LIVE     → 실제 toss.createOrder 호출
//   이 게이트를 건너뛰고 주문을 내는 함수는 이 파일에 존재하지 않습니다(placeEntry로 일원화).
//
// [청산(익절/손절/마감)은 게이트를 안 거친다 — 의도된 설계]
//   청산은 "위험을 줄이는" 행위입니다. 포지션을 못 닫으면 오히려 위험이 커지므로,
//   canPlaceOrder(신규 진입 억제용)로 막지 않습니다. 청산 전용 placeExit로 처리합니다.
//
// [삼분할 특칙]
//   각 레벨(1·2·3분할)은 "독립된 한 판"입니다. 각자 자기 진입·익절·손절을 가지며,
//   1분할이 익절돼도 2·3분할 진입은 그대로 유지됩니다. 한 레벨의 손절이 다른 레벨을
//   막지 않습니다. 단, 손익은 일일 한도(risk_state)에 합산됩니다.
//
// [DB 쓰기는 인터페이스(Store)로 추상화]
//   실제 Supabase 연결 대신 Store 인터페이스만 정의합니다. 테스트는 인메모리 구현을,
//   실운영은 Supabase 구현을 끼웁니다(SupabaseStore는 TODO).
// =============================================================================

import { DateTime } from "luxon";
import { getCloseDeadline } from "./session";
import { canPlaceOrder, type RiskConfig, type RiskState } from "./risk";
import { makeClientOrderId } from "./toss";

// -----------------------------------------------------------------------------
// 1) 런타임 데이터 모델
// -----------------------------------------------------------------------------

/** 포지션 상태(레벨 하나의 진행 단계) */
export type PositionState =
  | "pending_entry" //  진입 주문 냄, 아직 체결 안 됨
  | "entered" //        진입 체결됨(익절 주문 등록됨) — 보유 중
  | "closed" //         청산 완료
  | "skipped"; //       안전장치/드라이런으로 진입 자체를 안 함

/** 삼분할의 한 레벨 = 독립된 한 판 */
export interface Position {
  level: number; // 1|2|3 (단일 기법이면 1)
  entryPrice: number;
  tpPrice: number; // 익절가
  slPrice: number; // 손절가
  quantity: number;
  amountUsd: number; // 이 진입에 쓰는 금액(안전장치 검사에 사용)

  // 멱등키(중복 주문 방지) — 역할별로 미리 만들어 둠
  entryClientId: string;
  tpClientId: string;
  exitClientId: string;

  entryOrderId?: string; // 토스 진입 주문번호
  tpOrderId?: string; // 토스 익절 주문번호

  state: PositionState;
  exitReason?: "take_profit" | "stop_loss" | "eod_close" | "cancelled";
  enteredAt?: string;
  exitedAt?: string;
}

/** 매매 세션(런타임) — DB trade_sessions 에 대응 */
export interface SessionRuntime {
  id: string;
  symbol: string;
  strategy: "split3" | "orderbook" | "candle";
  status: "draft" | "armed" | "active" | "closed";
  tpPct: number;
  slPct: number;
  positions: Position[];
  /** 분할 체결 정책. 기본 first_only(설계서). 구체 동작은 TODO(미확정). */
  splitFillPolicy: "first_only" | "independent";
}

// -----------------------------------------------------------------------------
// 2) DB 추상화(Store) + 기록 타입
// -----------------------------------------------------------------------------

export interface OrderRecord {
  sessionId: string;
  level: number;
  role: "entry" | "take_profit" | "stop_loss";
  clientOrderId: string;
  tossOrderId?: string;
  side: "BUY" | "SELL";
  price?: number;
  status: string;
}

export interface TradeLogRecord {
  sessionId: string;
  symbol: string;
  level: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  exitReason: "take_profit" | "stop_loss" | "eod_close";
  enteredAt?: string;
  exitedAt: string;
}

/**
 * Store — DB 읽기/쓰기 창구(추상화).
 *   [왜 인터페이스로?] 오케스트레이션 로직을 특정 DB에 묶지 않기 위해서입니다.
 *   테스트는 인메모리 구현을, 실운영은 Supabase 구현을 끼워 넣습니다.
 */
export interface Store {
  saveSession(rt: SessionRuntime): Promise<void>;
  saveOrder(o: OrderRecord): Promise<void>;
  appendTradeLog(l: TradeLogRecord): Promise<void>;
  getRiskState(tradeDate: string): Promise<RiskState>;
  updateRiskState(tradeDate: string, apply: (s: RiskState) => RiskState): Promise<void>;
}

/** 토스 어댑터에서 오케스트레이션이 실제로 쓰는 기능만 추린 포트(주입 가능) */
export interface TossPort {
  createOrder(req: {
    symbol: string;
    side: "BUY" | "SELL";
    orderType: "LIMIT" | "MARKET";
    price?: number;
    quantity?: number;
    clientOrderId: string;
  }): Promise<{ tossOrderId: string; status: string }>;
  getOrder(tossOrderId: string): Promise<{ status: string; filled_qty?: number }>;
  cancelOrder(tossOrderId: string): Promise<{ status: string }>;
  getPrice(symbol: string): Promise<{ price: number }>;
  getBuyingPower(): Promise<{ buyingPowerUsd: number }>;
}

/** 오케스트레이션에 필요한 모든 의존성 묶음 */
export interface LifecycleDeps {
  toss: TossPort;
  store: Store;
  riskConfig?: Partial<RiskConfig>;
  killSwitch?: () => boolean; // 킬 스위치 상태를 읽어오는 함수(원터치 비상정지)
  log: (msg: string, data?: unknown) => void;
  /** now(DateTime) → KST 거래일 문자열(예: '2026-07-16') */
  tradeDateOf: (now: DateTime) => string;
}

// -----------------------------------------------------------------------------
// 3) 세션 만들기
// -----------------------------------------------------------------------------

/** 포지션 하나를 만든다(멱등키까지 준비) */
function makePosition(
  sessionId: string,
  level: number,
  entryPrice: number,
  tpPrice: number,
  slPrice: number,
  quantity: number,
): Position {
  return {
    level,
    entryPrice,
    tpPrice,
    slPrice,
    quantity,
    amountUsd: entryPrice * quantity,
    entryClientId: makeClientOrderId(sessionId, level, "entry"),
    tpClientId: makeClientOrderId(sessionId, level, "tp"),
    exitClientId: makeClientOrderId(sessionId, level, "exit"),
    state: "pending_entry",
  };
}

/**
 * createSession — 임의의 포지션들로 세션을 만든다(단일 기법/테스트용).
 *   spec: [{level, entryPrice, tpPrice, slPrice, quantity}, ...]
 */
export function createSession(
  id: string,
  symbol: string,
  strategy: SessionRuntime["strategy"],
  specs: Array<{ level: number; entryPrice: number; tpPrice: number; slPrice: number; quantity: number }>,
  opts?: { tpPct?: number; slPct?: number; splitFillPolicy?: "first_only" | "independent" },
): SessionRuntime {
  return {
    id,
    symbol,
    strategy,
    status: "draft",
    tpPct: opts?.tpPct ?? 2,
    slPct: opts?.slPct ?? 10,
    splitFillPolicy: opts?.splitFillPolicy ?? "first_only",
    positions: specs.map((s) => makePosition(id, s.level, s.entryPrice, s.tpPrice, s.slPrice, s.quantity)),
  };
}

// -----------------------------------------------------------------------------
// 4) 주문 실행: 진입(게이트 필수) / 청산(게이트 없음)
// -----------------------------------------------------------------------------

/**
 * placeEntry — 신규 진입 주문. 반드시 안전장치 게이트를 통과해야 실주문이 나간다.
 *   이 함수가 "안전장치 우회 불가"의 유일한 진입 관문입니다.
 */
async function placeEntry(
  rt: SessionRuntime,
  pos: Position,
  deps: LifecycleDeps,
  now: DateTime,
): Promise<"LIVE" | "DRY_RUN" | "BLOCKED"> {
  const tradeDate = deps.tradeDateOf(now);
  const riskState = await deps.store.getRiskState(tradeDate);

  // 현재가·매수가능금액을 조회해 안전장치 판단에 넘긴다.
  const [{ price: currentPrice }, { buyingPowerUsd }] = await Promise.all([
    deps.toss.getPrice(rt.symbol),
    deps.toss.getBuyingPower(),
  ]);

  // 이 세션에서 이미 진입에 쓴 금액(세션당 금액 상한 검사용).
  const sessionSpentUsd = rt.positions
    .filter((p) => p.state === "entered" || (p.state === "pending_entry" && p.entryOrderId))
    .reduce((sum, p) => sum + p.amountUsd, 0);

  const decision = canPlaceOrder(
    riskState,
    { symbol: rt.symbol, side: "BUY", price: pos.entryPrice, amountUsd: pos.amountUsd },
    {
      config: deps.riskConfig,
      currentPrice,
      buyingPowerUsd,
      sessionSpentUsd,
      killSwitch: deps.killSwitch?.() ?? false,
    },
  );

  if (decision.mode === "BLOCKED") {
    deps.log(`[진입 차단] level ${pos.level}: ${decision.reasonText}`, { reason: decision.reason });
    pos.state = "skipped";
    return "BLOCKED";
  }

  if (decision.mode === "DRY_RUN") {
    // 드라이런: 실주문 대신 로그만 남긴다. toss.createOrder는 호출하지 않는다.
    deps.log(`[드라이런] level ${pos.level} 진입 예정(실주문 안 냄): ${pos.entryPrice} x ${pos.quantity}`);
    pos.state = "skipped";
    return "DRY_RUN";
  }

  // LIVE: 실제 진입 주문을 낸다.
  const order = await deps.toss.createOrder({
    symbol: rt.symbol,
    side: "BUY",
    orderType: "LIMIT",
    price: pos.entryPrice,
    quantity: pos.quantity,
    clientOrderId: pos.entryClientId,
  });
  pos.entryOrderId = order.tossOrderId;
  await deps.store.saveOrder({
    sessionId: rt.id,
    level: pos.level,
    role: "entry",
    clientOrderId: pos.entryClientId,
    tossOrderId: order.tossOrderId,
    side: "BUY",
    price: pos.entryPrice,
    status: order.status,
  });
  // 주문 횟수 +1 (일일 최대 주문 횟수 안전장치의 재료).
  await deps.store.updateRiskState(tradeDate, (s) => ({ ...s, order_count: s.order_count + 1 }));
  deps.log(`[진입 실주문] level ${pos.level}: ${pos.entryPrice} x ${pos.quantity}`);
  return "LIVE";
}

/**
 * placeExit — 청산/익절 주문. 안전장치 게이트를 거치지 않는다(위험 축소 행위).
 *   [지정가 청산 원칙] 데이/프리/애프터마켓은 지정가 필수·시장가 지양(설계서)이라,
 *   손절/마감 청산도 시장가 대신 "현재가 지정가(marketable limit)"로 즉시 체결을 노립니다.
 *   TODO(정책): 스탑-지정가 방식(스탑 트리거→지정가 제출)의 구체 파라미터 확정.
 */
async function placeExit(
  rt: SessionRuntime,
  pos: Position,
  price: number,
  clientOrderId: string,
  role: "take_profit" | "stop_loss",
  deps: LifecycleDeps,
): Promise<{ tossOrderId: string; status: string }> {
  const order = await deps.toss.createOrder({
    symbol: rt.symbol,
    side: "SELL",
    orderType: "LIMIT",
    price,
    quantity: pos.quantity,
    clientOrderId,
  });
  await deps.store.saveOrder({
    sessionId: rt.id,
    level: pos.level,
    role,
    clientOrderId,
    tossOrderId: order.tossOrderId,
    side: "SELL",
    price,
    status: order.status,
  });
  return order;
}

// -----------------------------------------------------------------------------
// 5) 상태 전이 함수들
// -----------------------------------------------------------------------------

/**
 * armSession — draft → armed. 각 포지션의 진입 지정가를 등록한다.
 *   삼분할이면 3레벨 모두 등록(각자 독립). 각 진입은 placeEntry(게이트)를 통과해야 한다.
 */
export async function armSession(rt: SessionRuntime, deps: LifecycleDeps, now: DateTime): Promise<void> {
  for (const pos of rt.positions) {
    if (pos.state !== "pending_entry") continue;
    await placeEntry(rt, pos, deps, now);
  }
  rt.status = "armed";
  await deps.store.saveSession(rt);
}

/** 포지션을 청산 완료 처리하고 매매일지·리스크를 갱신한다(내부 공용). */
async function closePosition(
  rt: SessionRuntime,
  pos: Position,
  reason: "take_profit" | "stop_loss" | "eod_close",
  exitPrice: number,
  now: DateTime,
  deps: LifecycleDeps,
): Promise<void> {
  pos.state = "closed";
  pos.exitReason = reason;
  pos.exitedAt = now.toISO() ?? undefined;

  // 손익 계산: 매수 후 매도이므로 (청산가-진입가) 기준.
  const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlUsd = (exitPrice - pos.entryPrice) * pos.quantity;

  await deps.store.appendTradeLog({
    sessionId: rt.id,
    symbol: rt.symbol,
    level: pos.level,
    entryPrice: pos.entryPrice,
    exitPrice,
    pnlPct,
    pnlUsd,
    exitReason: reason,
    enteredAt: pos.enteredAt,
    exitedAt: pos.exitedAt ?? "",
  });

  // 일일 리스크 갱신: 손익률 합산 + 연속손절 카운터 관리.
  //   [삼분할 합산] 레벨별 손익이 모두 여기 누적되어 일일 한도에 반영됩니다.
  const tradeDate = deps.tradeDateOf(now);
  await deps.store.updateRiskState(tradeDate, (s) => ({
    ...s,
    realized_pnl_pct: s.realized_pnl_pct + pnlPct,
    consecutive_losses: reason === "stop_loss" ? s.consecutive_losses + 1 : 0, // 익절/마감이면 연속손절 리셋
  }));

  deps.log(`[청산] level ${pos.level} ${reason}: ${pos.entryPrice}→${exitPrice} (${pnlPct.toFixed(2)}%)`);
}

/**
 * advanceSession — 활성 세션을 한 걸음 전진시킨다(워커가 매 틱 호출).
 *
 *   1) 장 종료 데드라인 도달 → 강제 청산(handleCloseDeadline).
 *   2) 각 포지션 폴링:
 *      - pending_entry: 진입 체결됐으면 → entered + 익절 지정가 등록
 *      - entered: 손절선 도달이면 손절 청산 / 아니면 익절 체결 확인
 *   3) 세션 상태(active/closed) 갱신.
 */
export async function advanceSession(rt: SessionRuntime, deps: LifecycleDeps, now: DateTime): Promise<void> {
  if (rt.status === "closed") return;

  // (1) 장 종료 임박: 미체결 취소 + 보유분 청산.
  if (now >= getCloseDeadline(now)) {
    await handleCloseDeadline(rt, deps, now);
    return;
  }

  const { price: currentPrice } = await deps.toss.getPrice(rt.symbol);

  for (const pos of rt.positions) {
    // 진입 대기: 체결됐는지 확인.
    if (pos.state === "pending_entry" && pos.entryOrderId) {
      const o = await deps.toss.getOrder(pos.entryOrderId);
      if (o.status === "filled") {
        pos.state = "entered";
        pos.enteredAt = now.toISO() ?? undefined;
        // 진입 체결 → 익절 지정가 자동 등록(청산 계열이라 게이트 없음).
        const tp = await placeExit(rt, pos, pos.tpPrice, pos.tpClientId, "take_profit", deps);
        pos.tpOrderId = tp.tossOrderId;
        deps.log(`[진입 체결→익절 등록] level ${pos.level}: 익절 ${pos.tpPrice}`);
      }
      continue;
    }

    // 보유 중: 손절 우선 확인, 그다음 익절.
    if (pos.state === "entered") {
      // 손절선 도달: 현재가가 손절가 이하로 내려오면 손절 청산.
      if (currentPrice <= pos.slPrice) {
        if (pos.tpOrderId) await deps.toss.cancelOrder(pos.tpOrderId); // 익절 주문 먼저 취소
        // 현재가 지정가로 즉시 체결을 노리는 청산(지정가 필수 제약 준수).
        await placeExit(rt, pos, currentPrice, pos.exitClientId, "stop_loss", deps);
        await closePosition(rt, pos, "stop_loss", currentPrice, now, deps);
        continue;
      }
      // 익절 체결 확인.
      if (pos.tpOrderId) {
        const t = await deps.toss.getOrder(pos.tpOrderId);
        if (t.status === "filled") {
          await closePosition(rt, pos, "take_profit", pos.tpPrice, now, deps);
        }
      }
    }
  }

  // (3) 세션 상태 갱신.
  const anyEntered = rt.positions.some((p) => p.state === "entered");
  const allDone = rt.positions.every((p) => p.state === "closed" || p.state === "skipped");
  if (allDone) rt.status = "closed";
  else if (anyEntered) rt.status = "active";

  await deps.store.saveSession(rt);
}

/**
 * handleCloseDeadline — 장 종료 임박 시 강제 정리.
 *   미체결 진입은 취소(다음 세션 이월 방지 — M0-A), 보유 포지션은 현재가로 청산.
 *   [주의] 마감 1분 전은 취소 불가 구간(isOrderFrozen). 실제 호출 시 그 구간을 피해야 함.
 */
async function handleCloseDeadline(rt: SessionRuntime, deps: LifecycleDeps, now: DateTime): Promise<void> {
  const { price: currentPrice } = await deps.toss.getPrice(rt.symbol);

  for (const pos of rt.positions) {
    // 미체결 진입 주문: 취소(자동 이월에 의존하지 않고 봇이 명시적으로 거둔다).
    if (pos.state === "pending_entry" && pos.entryOrderId) {
      await deps.toss.cancelOrder(pos.entryOrderId);
      pos.state = "closed";
      pos.exitReason = "cancelled";
      pos.exitedAt = now.toISO() ?? undefined;
      deps.log(`[마감 취소] level ${pos.level} 미체결 진입 취소`);
      continue;
    }
    // 보유 포지션: 익절 주문 취소 후 현재가로 청산.
    if (pos.state === "entered") {
      if (pos.tpOrderId) await deps.toss.cancelOrder(pos.tpOrderId);
      await placeExit(rt, pos, currentPrice, pos.exitClientId, "stop_loss", deps);
      await closePosition(rt, pos, "eod_close", currentPrice, now, deps);
    }
  }

  rt.status = "closed";
  await deps.store.saveSession(rt);
}
