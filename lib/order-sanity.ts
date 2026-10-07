// =============================================================================
// lib/order-sanity.ts — [v0.69.2 긴급] 주문 전 정합성 검사(sanity gate) — 순수 함수
// -----------------------------------------------------------------------------
// [왜 만들었나 — 오너 지시 "계산된 주문 가격을 아무도 검증하지 않고 토스에 보낸다"]
//   같은 계열 사고가 세 번 났다:
//     · QTEX: 손절 감시가가 0 → 토스가 "감시 가격은 0으로 설정할 수 없습니다"로 거부
//     · 카일: 손절% 설정이 100 → 손절가 0 (위와 같은 결과, 설정 자체가 비정상)
//     · SXTC: 지정가 $2.41로 주문했는데 실제 체결은 $2.22 — 익절/손절은 주문가 기준($2.45/$2.16)으로 걸려서
//             실제 체결가 기준으로는 익절 +10.4% / 손절 −2.7%가 됐다(설정은 +2% / −10%).
//   이 파일은 "손절폭이 몇 %여야 하나"를 판단하지 않는다(그건 오너가 정한다). 오직
//   "오너가 정한 값대로 계산·등록되는가"만 기계가 확인한다.
// [허용 오차] 호가 단위(틱) 절삭 1틱뿐이다(roundPrice가 내림으로 자르므로).
// =============================================================================

import { getTick, roundPrice } from "./calc";

/** 설정값 대조용 기대 조건 — basis(기준가=실제 체결가 또는 진입가) 대비 설정 %로 계산돼야 한다. */
export interface SanityExpect {
  basis: number;
  tpPct: number;
  slPct: number;
  slMode: "fixed" | "ema";
}

const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** 설정값(익절%·손절%) 자체가 정상인가. 손절% ≥ 100이면 손절가가 0 이하가 되어 주문이 불가능하다. */
export function checkPercentSettings(tpPct: number, slPct: number): string[] {
  const out: string[] = [];
  if (!(typeof tpPct === "number" && Number.isFinite(tpPct) && tpPct > 0)) out.push(`익절% 설정이 비정상입니다(${tpPct}) — 0보다 커야 합니다.`);
  if (!(typeof slPct === "number" && Number.isFinite(slPct) && slPct > 0)) out.push(`손절% 설정이 비정상입니다(${slPct}) — 0보다 커야 합니다.`);
  else if (slPct >= 100) out.push(`손절% 설정이 ${slPct}%입니다 — 100% 이상이면 손절가가 0 이하가 되어 주문이 불가능합니다. [설정]에서 100 미만으로 고쳐 주세요.`);
  return out;
}

/**
 * 익절/손절(브라켓·OCO) 가격 검사.
 *   - 수량이 1 이상의 정수인가, 모든 가격이 0보다 큰 유한한 수인가
 *   - 익절 감시가 > (진입가) > 손절 감시가 방향이 맞는가
 *   - expect가 있으면: 실제 가격이 설정 %대로 기준가에서 계산된 값과 1틱 이내로 일치하는가
 */
export function checkBracketPrices(p: {
  quantity: number;
  tpTrigger: number;
  tpPrice: number;
  slTrigger: number;
  slPrice: number;
  entry?: number | null;
  expect?: SanityExpect;
}): string[] {
  const out: string[] = [];
  if (!(Number.isInteger(p.quantity) && p.quantity > 0)) out.push(`수량이 비정상입니다(${p.quantity}).`);
  const names: Array<[string, unknown]> = [["익절 감시가", p.tpTrigger], ["익절 지정가", p.tpPrice], ["손절 감시가", p.slTrigger], ["손절 지정가", p.slPrice]];
  const bad = names.filter(([, v]) => !pos(v));
  for (const [n, v] of bad) out.push(`${n}가 0이거나 음수·비정상 값입니다(${v}).`);
  if (bad.length) return out; // 값 자체가 깨졌으면 이후 비교는 의미 없다
  if (!(p.tpTrigger > p.slTrigger)) out.push(`익절 감시가($${p.tpTrigger})가 손절 감시가($${p.slTrigger})보다 높지 않습니다.`);
  if (pos(p.entry)) {
    if (!(p.tpTrigger > p.entry)) out.push(`익절 감시가($${p.tpTrigger})가 진입가($${p.entry})보다 높지 않습니다.`);
    if (!(p.slTrigger < p.entry)) out.push(`손절 감시가($${p.slTrigger})가 진입가($${p.entry})보다 낮지 않습니다.`);
  }
  const e = p.expect;
  if (e && pos(e.basis)) {
    const tol = getTick(e.basis) * 1.01;
    const expTp = roundPrice(e.basis * (1 + e.tpPct / 100));
    const actTpPct = (p.tpTrigger / e.basis - 1) * 100;
    if (Math.abs(p.tpTrigger - expTp) > tol) {
      out.push(`익절가 $${p.tpTrigger}는 기준가 $${e.basis} 대비 +${actTpPct.toFixed(2)}%인데, 설정(익절 ${e.tpPct}%)대로라면 $${expTp} 근처여야 합니다.`);
    }
    const expSl = roundPrice(e.basis * (1 - e.slPct / 100));
    const actSlPct = (p.slTrigger / e.basis - 1) * 100;
    if (e.slMode === "fixed") {
      if (Math.abs(p.slTrigger - expSl) > tol) {
        out.push(`손절가 $${p.slTrigger}는 기준가 $${e.basis} 대비 ${actSlPct.toFixed(2)}%인데, 설정(손절 ${e.slPct}%)대로라면 $${expSl} 근처여야 합니다.`);
      }
    } else if (p.slTrigger >= e.basis || p.slTrigger < expSl - tol) {
      // EMA 기준 손절은 절대가라 % 일치를 못 보지만, 진입가 아래이면서 고정 손절보다 깊지는 않아야 한다(설계 규칙).
      out.push(`EMA 기준 손절가 $${p.slTrigger}가 기준가 $${e.basis} 아래·설정 손절 한도(−${e.slPct}% = $${expSl}) 이내가 아닙니다.`);
    }
  }
  return out;
}

/** 일반 주문(매수·매도, 지정가·시장가) 최소 검사. */
export function checkSimpleOrder(p: { quantity: number; orderType: "LIMIT" | "MARKET"; price?: number | null }): string[] {
  const out: string[] = [];
  if (!(Number.isInteger(p.quantity) && p.quantity > 0)) out.push(`수량이 비정상입니다(${p.quantity}).`);
  if (p.orderType === "LIMIT" && !pos(p.price)) out.push(`지정가가 0이거나 음수·비정상 값입니다(${p.price}).`);
  return out;
}
