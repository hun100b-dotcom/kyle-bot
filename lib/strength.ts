// =============================================================================
// lib/strength.ts  —  체결강도(Trade Strength) 계산 엔진 (순수 함수)  [v0.5.0]
// -----------------------------------------------------------------------------
// [이 파일이 하는 일]
//   토스가 주는 "개별 체결(틱)"에는 그 거래가 매수였는지 매도였는지(방향)가 없습니다.
//   그래서 학계 고전인 틱룰(Lee & Ready, 1991)로 방향을 "추정"한 뒤,
//   체결강도 = (매수체결량 ÷ 매도체결량) × 100 을 계산합니다.
//   (근거·한계는 docs/체결강도_분석_2026-07-24.html 4장 참고.)
//
// [왜 순수 함수인가?]
//   calc.ts 와 같은 이유입니다. 네트워크·파일 없이 "입력→출력"만 있으므로
//   vitest 로 규칙이 맞는지 눈으로 검증하고 나서 엔진에 연결합니다.
//
// [틱룰(tick test) 규칙 — 직전 체결가와 비교]
//   · 이번가 > 직전가  → 업틱(up-tick)   → 매수(buy) 로 분류
//   · 이번가 < 직전가  → 다운틱(down-tick) → 매도(sell) 로 분류
//   · 이번가 = 직전가  → 제로틱(zero-tick) → "직전에 정해진 방향"을 그대로 승계
//   맨 처음 틱은 비교할 직전이 없으므로, 외부에서 이어받은 방향(prevSide)이 있으면
//   그걸 쓰고, 없으면 매수(buy)를 기본값으로 둡니다(관례. 표본 1개 영향이라 무시할 수준).
// =============================================================================

/** 개별 체결(틱) — 문자열이 아니라 숫자로 정규화한 형태(엔진이 변환해 넘긴다) */
export interface Tick {
  price: number;
  volume: number;
  timestamp: string; // ISO8601 (정렬·중복제거용)
}

export type Side = "buy" | "sell";

/** 틱룰 분류 결과 한 건(원본 틱 + 추정 방향) */
export interface ClassifiedTick extends Tick {
  side: Side;
}

/**
 * classifyTicks — 틱 배열을 시각 오름차순으로 정렬한 뒤 틱룰로 방향을 매긴다.
 *
 *   @param ticks     이번에 받은 틱들(순서 무관 — 내부에서 시각순 정렬).
 *   @param prevPrice 직전 폴링에서의 마지막 체결가(연속 폴링을 자연스럽게 이어 붙이기 위함).
 *   @param prevSide  직전 폴링에서의 마지막 방향(제로틱 승계 seed).
 *   @returns { classified, lastPrice, lastSide } — 분류 결과 + 다음 폴링에 넘길 마지막 상태.
 *
 *   [정렬을 왜 우리가?] 토스가 최신순으로 줄지 과거순으로 줄지 보장이 없어,
 *   방향 추정이 뒤집히지 않도록 항상 오름차순(과거→현재)으로 맞춘 뒤 계산한다.
 */
export function classifyTicks(
  ticks: Tick[],
  prevPrice?: number,
  prevSide: Side = "buy",
): { classified: ClassifiedTick[]; lastPrice: number | undefined; lastSide: Side } {
  // 시각 오름차순 정렬(같은 시각이면 원래 순서 유지 — 안정 정렬)
  const sorted = [...ticks].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const classified: ClassifiedTick[] = [];
  let lastPrice = prevPrice; // 직전 체결가(비교 기준)
  let lastSide = prevSide; //  직전 방향(제로틱 승계용)

  for (const t of sorted) {
    let side: Side;
    if (lastPrice === undefined) {
      side = lastSide; // 맨 처음(비교 대상 없음) → 이어받은 방향(기본 buy)
    } else if (t.price > lastPrice) {
      side = "buy"; // 업틱
    } else if (t.price < lastPrice) {
      side = "sell"; // 다운틱
    } else {
      side = lastSide; // 제로틱(동일가) → 직전 방향 승계
    }
    classified.push({ ...t, side });
    lastPrice = t.price;
    lastSide = side;
  }

  return { classified, lastPrice, lastSide };
}

/** 체결강도 계산 결과 */
export interface StrengthResult {
  buyVol: number; //   매수로 분류된 체결량 합
  sellVol: number; //  매도로 분류된 체결량 합
  /** (매수/매도)×100. 매도량이 0이면 나눗셈 불가라 null(화면은 "매수 일방"으로 표기). */
  strength: number | null;
  nTicks: number; //   표본 틱 수
  nZeroLike: number; // (참고) 방향이 승계로 정해진(=업/다운 아님) 틱 수 — 신뢰도 참고용
}

/**
 * computeStrength — 분류된 틱들로 체결강도를 계산한다.
 *   체결강도 = (Σ매수량 ÷ Σ매도량) × 100.  100=균형, >100 매수우세, <100 매도우세.
 *   매도량이 0이면(전부 매수) 무한대가 되므로 strength=null 로 두고, 화면이 "매수 일방"으로 안내.
 *   반대로 매수량이 0이면 strength=0(완전 매도우세)로 표현된다((0/양수)×100=0).
 */
export function computeStrength(classified: ClassifiedTick[]): StrengthResult {
  let buyVol = 0;
  let sellVol = 0;
  for (const t of classified) {
    if (t.side === "buy") buyVol += t.volume;
    else sellVol += t.volume;
  }
  const strength = sellVol > 0 ? round1((buyVol / sellVol) * 100) : buyVol > 0 ? null : round1(100);
  // (틱이 하나도 없으면 buy=sell=0 → 균형 100으로 둔다. 아래 nZeroLike는 신뢰도 참고용.)
  return { buyVol, sellVol, strength, nTicks: classified.length, nZeroLike: 0 };
}

/**
 * strengthFromTicks — "틱 배열 → 체결강도" 한 번에(엔진에서 호출하는 진입점).
 *   분류(classifyTicks) + 합산(computeStrength)을 묶고, 다음 폴링에 넘길 마지막 상태도 돌려준다.
 */
export function strengthFromTicks(
  ticks: Tick[],
  prevPrice?: number,
  prevSide: Side = "buy",
): { result: StrengthResult; lastPrice: number | undefined; lastSide: Side } {
  const { classified, lastPrice, lastSide } = classifyTicks(ticks, prevPrice, prevSide);
  const result = computeStrength(classified);
  return { result, lastPrice, lastSide };
}

/** 소수 첫째 자리 반올림(체결강도는 150.0 처럼 한 자리면 충분). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
