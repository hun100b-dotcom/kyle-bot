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

// =============================================================================
// [v0.12.0 · 2단계] 체결강도 '신호' 감지 — 원래 기획(정본 3·5장)을 순수함수로
// -----------------------------------------------------------------------------
// [정본] docs/체결강도_분석_2026-07-24.html
//   · 바닥반전(진입)  = 강도가 100 아래(매도 우세)에서 '연속 상승'으로 전환.
//   · 정점꺾임(익절)  = 강도가 100 위(매수 우세)에서 '연속 하락'으로 전환.
//   · 강세 다이버전스 = 가격은 신저점인데 강도는 직전 저점보다 높음(파는 힘 약화).
//   · 국면(phase)    = 하락중/진입/보유/익절/고점경고/중립.
//
// [설계 원칙 — 정본 6장]
//   · 절댓값("150이면 매수")이 아니라 '변화·전환'만 신호로 삼는다.
//   · 표본이 얇으면(점이 적으면) 값이 튀므로 신호를 내지 않고 thinSample로 표시한다.
//   · 이 신호는 '보조 렌즈'일 뿐, 단독 매매 규칙이 아니다(화면에서 병행 안내).
// =============================================================================

/** 신호 계산 입력 한 점(엔진의 StrengthSample 중 쓰는 것만 — 엔진 타입에 의존하지 않으려 최소화). */
export interface SeriesPoint {
  price: number | null;
  strength: number | null; // null = 매수 일방(매도 0). 계산에서 제외한다.
}

/** 국면 — 정본 3장의 5국면(+중립). */
export type StrengthPhase = "하락중" | "진입" | "보유" | "익절" | "고점경고" | "중립";

/** 신호 판정 결과. */
export interface StrengthSignals {
  bottomReversal: boolean; //    바닥반전(진입 근거)
  bullishDivergence: boolean; // 강세 다이버전스(진입 근거 강화)
  peakRollover: boolean; //      정점꺾임(익절 근거)
  phase: StrengthPhase;
  thinSample: boolean; //        표본이 얇아 신뢰도 낮음(신호를 억제)
}

/** 신호를 내기 위한 최소 표본(강도 있는 점) 수. 이보다 적으면 thinSample=true, 신호는 전부 false. */
const MIN_SAMPLE = 4;

/**
 * detectBullishDivergence — 가격 신저점 + 강도는 직전 저점보다 높음.
 *   시계열을 앞/뒤 절반으로 나눠 각 구간의 '가격 최저점'을 찾고,
 *   뒤 저점이 더 낮은데(가격 신저점) 강도는 더 높으면 강세 다이버전스.
 */
function detectBullishDivergence(pts: { price: number; strength: number }[]): boolean {
  if (pts.length < MIN_SAMPLE) return false;
  const mid = Math.floor(pts.length / 2);
  const first = pts.slice(0, mid);
  const second = pts.slice(mid);
  if (first.length === 0 || second.length === 0) return false;
  const lowest = (arr: { price: number; strength: number }[]) => arr.reduce((m, p) => (p.price < m.price ? p : m));
  const lo1 = lowest(first); //  앞 구간 저점
  const lo2 = lowest(second); // 뒤 구간 저점
  return lo2.price < lo1.price && lo2.strength > lo1.strength;
}

/**
 * analyzeStrengthSeries — 강도 시계열에서 신호·국면을 한 번에 판정(순수 계산).
 *   @param points 오래된→최신 순의 시계열(엔진 samples 를 그대로 넣어도 됨).
 */
export function analyzeStrengthSeries(points: SeriesPoint[]): StrengthSignals {
  // 강도가 있는 점만(매수 일방 null 은 방향 비율을 못 내므로 제외).
  const pts = points.filter((p): p is { price: number | null; strength: number } => p.strength != null && Number.isFinite(p.strength));
  const s = pts.map((p) => p.strength);
  const n = s.length;
  const thinSample = n < MIN_SAMPLE;

  // 최근 3점의 연속 상승/하락(변화의 방향).
  const rising3 = n >= 3 && s[n - 1] > s[n - 2] && s[n - 2] > s[n - 3];
  const falling3 = n >= 3 && s[n - 1] < s[n - 2] && s[n - 2] < s[n - 3];
  // 전환의 시작점(3점 전)이 100 아래/위였는가 = 과매도/과매수에서의 전환인가.
  const bottomBelow100 = n >= 3 && s[n - 3] < 100;
  const peakAbove100 = n >= 3 && s[n - 3] > 100;
  // [B 리뷰 #3] '시작점만' 100 기준으로 보면, 이미 강도 200까지 치솟았는데도 "진입"으로 오신호가 난다.
  //   전환이 '아직 신선한'(100 근방을 벗어나 폭주하지 않은) 상태일 때만 신호로 인정한다.
  //   FRESH_BAND=30 → 바닥반전은 latest<130(아직 과매수 폭주 아님), 정점꺾임은 latest>70(아직 과매도 폭주 아님).
  const FRESH_BAND = 30;
  const freshUp = n >= 1 && s[n - 1] < 100 + FRESH_BAND; // 바닥반전이 신선한가(아직 안 치솟음)
  const freshDown = n >= 1 && s[n - 1] > 100 - FRESH_BAND; // 정점꺾임이 신선한가(아직 안 무너짐)

  const bottomReversal = !thinSample && rising3 && bottomBelow100 && freshUp;
  const peakRollover = !thinSample && falling3 && peakAbove100 && freshDown;

  // 다이버전스는 가격이 필요 → 가격 있는 점만 추려서 판정.
  const priced = pts.filter((p): p is { price: number; strength: number } => p.price != null && Number.isFinite(p.price));
  const bullishDivergence = !thinSample && detectBullishDivergence(priced);

  const latest = n ? s[n - 1] : null;
  const rising = n >= 2 && s[n - 1] > s[n - 2];

  let phase: StrengthPhase;
  // [A 리뷰 L2] 표본이 얇으면(신뢰 낮음) 국면도 단정하지 않는다 → 중립.
  //   "표본 얇음" 칩 옆에 '고점경고' 같은 확정 문구가 뜨는 모순을 막는다.
  if (thinSample || latest == null) phase = "중립";
  else if (peakRollover) phase = "익절";
  else if (bottomReversal || bullishDivergence) phase = "진입";
  else if (latest > 100) phase = rising ? "보유" : "고점경고";
  else if (latest < 100) phase = "하락중";
  else phase = "중립";

  return { bottomReversal, bullishDivergence, peakRollover, phase, thinSample };
}
