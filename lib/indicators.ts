// =============================================================================
// lib/indicators.ts  —  스크리너 지표 계산 엔진 (순수 함수)  [v0.6.0]
// -----------------------------------------------------------------------------
// [이 파일이 하는 일]
//   종목 "탐색(스크리너)"에 필요한 기술적 지표를 계산합니다.
//   토스는 5분봉을 안 주므로, 1분봉을 받아 여기서 5분봉으로 합성한 뒤
//   EMA200·이치모쿠 구름·음봉 도지 패턴을 계산합니다.
//
// [왜 순수 함수인가?] calc.ts/strength.ts와 같은 이유 — 네트워크·파일 없이
//   "입력→출력"만 있으므로 vitest로 규칙을 눈으로 검증하고 나서 엔진에 붙입니다.
//   (숫자가 조용히 틀리면 잘못된 종목을 후보로 내놓으므로 반드시 테스트로 고정.)
// =============================================================================

/** 봉(캔들) 하나 — 1분봉/5분봉 공통. 시각은 '봉 시작' 밀리초. */
export interface Candle {
  time: number; //   봉 시작 시각(ms epoch)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

/**
 * aggregate1mTo5m — 1분봉 배열을 5분봉으로 합성한다.
 *   5분 경계(:00,:05,:10…)에 맞춰 버킷을 나눈다(버킷 = floor(time/5분)×5분).
 *   시가=버킷 첫 봉의 시가, 종가=마지막 봉의 종가, 고가=max, 저가=min, 거래량=합.
 *   [정렬] 입력 순서를 신뢰하지 않고 시각 오름차순으로 정렬한 뒤 묶는다.
 */
export function aggregate1mTo5m(oneMin: Candle[]): Candle[] {
  const sorted = [...oneMin].sort((a, b) => a.time - b.time);
  const buckets = new Map<number, Candle>();
  const order: number[] = []; // 버킷 등장 순서 보존
  for (const c of sorted) {
    const key = Math.floor(c.time / FIVE_MIN_MS) * FIVE_MIN_MS;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      order.push(key);
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close; // 마지막 1분봉의 종가가 5분봉 종가
      b.volume += c.volume;
    }
  }
  return order.map((k) => buckets.get(k)!);
}

/**
 * toHeikinAshi — 일반 캔들을 하이킨아시(平均足) 캔들로 변환한다.
 *
 *   [하이킨아시란?] "노이즈를 줄여 추세를 매끄럽게 보는" 변형 캔들. 트레이딩뷰에서
 *   차트 종류를 Heikin Ashi로 바꾸면 보이는 그 캔들이다. 실제 체결가가 아니라 평균값이다.
 *
 *   공식(표준):
 *     HA종가 = (시+고+저+종) / 4
 *     HA시가 = (직전 HA시가 + 직전 HA종가) / 2   (첫 봉은 (시+종)/2)
 *     HA고가 = max(해당봉 고가, HA시가, HA종가)
 *     HA저가 = min(해당봉 저가, HA시가, HA종가)
 *   시각·거래량은 원본 그대로 둔다.
 *
 *   [왜 필요한가?] 사용자는 하이킨아시 차트로 도지·음봉을 판단한다. 일반캔들로 판정하면
 *   음/양·도지가 사용자 눈과 어긋난다(예: 일반 음봉이 HA에선 양봉). 그래서 도지·음봉·
 *   세션최고점·EMA200·이치모쿠까지 HA 기준으로 계산해 트레이딩뷰 HA 차트와 맞춘다.
 */
export function toHeikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen = 0;
  let prevClose = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    out.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

/**
 * inPriceBand — 현재가가 [min, max] 가격대 안(포함)인지. 스크리너 가격 필터용.
 *   기본 $1~$9 (초저가·고가 종목 제외). 값이 없거나 범위 밖이면 false.
 */
export function inPriceBand(price: number | null | undefined, min = 1, max = 9): boolean {
  return price != null && Number.isFinite(price) && price >= min && price <= max;
}

/**
 * ema — 지수이동평균의 '마지막 값'을 돌려준다(부족하면 null).
 *   시드는 처음 period개의 단순평균(SMA), 그 뒤로 EMA 재귀:
 *   EMA_t = 값_t × k + EMA_(t-1) × (1-k),  k = 2/(period+1).
 *   (표준 정의. 값이 period개 미만이면 계산 불가 → null.)
 */
export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  // 시드: 앞 period개의 SMA
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/** 구간 [i-n+1 .. i]의 최고 고가·최저 저가(도우미). */
function highest(candles: Candle[], end: number, n: number): number {
  let h = -Infinity;
  for (let i = end - n + 1; i <= end; i++) h = Math.max(h, candles[i].high);
  return h;
}
function lowest(candles: Candle[], end: number, n: number): number {
  let l = Infinity;
  for (let i = end - n + 1; i <= end; i++) l = Math.min(l, candles[i].low);
  return l;
}

export interface IchimokuCloud {
  spanA: number; //     현재 시점의 선행스팬A
  spanB: number; //     현재 시점의 선행스팬B
  cloudTop: number; //  구름 위 경계 = max(spanA, spanB)
  cloudBottom: number; // 구름 아래 경계 = min(spanA, spanB)
}

/**
 * ichimoku — "현재 시점의 구름(선행스팬 A/B)"을 계산한다(표준 9·26·52·26).
 *
 *   [핵심] 선행스팬은 26봉 '앞으로' 밀어 그린다. 그래서 '지금' 위치의 구름은
 *   26봉 전에 산출된 값이다:
 *     현재구름 = 인덱스 j = (마지막-26) 에서 계산한 스팬A/B.
 *       전환선(tenkan, 9)  = (9봉 최고+최저)/2
 *       기준선(kijun, 26)  = (26봉 최고+최저)/2
 *       스팬A = (전환선+기준선)/2
 *       스팬B = (52봉 최고+최저)/2
 *   충분한 데이터(마지막-26 지점에서 52봉 되돌아보기)가 없으면 null.
 */
export function ichimoku(candles: Candle[], tenkanP = 9, kijunP = 26, senkouBP = 52, shift = 26): IchimokuCloud | null {
  const n = candles.length;
  const j = n - 1 - shift; // '지금' 구름을 만든 과거 인덱스
  if (j < senkouBP - 1) return null; // j에서 52봉 되돌아볼 수 없으면 계산 불가
  const tenkan = (highest(candles, j, tenkanP) + lowest(candles, j, tenkanP)) / 2;
  const kijun = (highest(candles, j, kijunP) + lowest(candles, j, kijunP)) / 2;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (highest(candles, j, senkouBP) + lowest(candles, j, senkouBP)) / 2;
  return { spanA, spanB, cloudTop: Math.max(spanA, spanB), cloudBottom: Math.min(spanA, spanB) };
}

/**
 * isBearishDoji — "음봉 도지"인지 판정.
 *   음봉(종가<시가) + 몸통이 아주 작음(|시가-종가| ≤ 전체범위 × bodyRatioMax).
 *   bodyRatioMax 기본 0.3 (몸통이 전체 범위의 30% 이하). 범위(high-low)가 0이면 도지 아님.
 */
export function isBearishDoji(c: Candle, bodyRatioMax = 0.3): boolean {
  const range = c.high - c.low;
  if (range <= 0) return false;
  if (c.close >= c.open) return false; // 음봉이어야 함
  const body = c.open - c.close; // 음봉이므로 양수
  return body <= bodyRatioMax * range;
}

export type PatternStatus = "confirmed" | "watch" | "none";

export interface SessionPattern {
  sessionHigh: number | null; // 현재 장 시작 이후 최고 고가
  highTime: number | null; //   그 최고점을 만든 봉의 시각(ms, 없으면 null)
  highIndex: number; //         그 최고점을 만든 봉 인덱스(sessionCandles 기준, 없으면 -1)
  dojiIndex: number; //         최고점 이후 첫 음봉 도지 인덱스(없으면 -1)
  dojiCandle: Candle | null; // 기준으로 잡은 첫 음봉 도지 봉(근거 표시용)
  dojiBodyRatio: number | null; // 그 도지의 몸통비율(=몸통/범위, 근거 표시용)
  nextCandle: Candle | null; // 도지 다음 봉(근거 표시용)
  status: PatternStatus; //     confirmed(도지+다음음봉) / watch(도지만) / none
}

/**
 * scanSessionPattern — "현재 장 시작 이후 최고점 → 그 이후 첫 음봉 도지 → 다음 봉도 음봉" 판정.
 *
 *   @param candles5m      5분봉 전체(시각 오름차순)
 *   @param sessionStartMs 현재 활성 장의 시작 시각(ms). 이 시각 이후 봉만 본다.
 *   @param bodyRatioMax   도지 몸통 비율 상한(기본 0.3)
 *
 *   판정 규칙:
 *     1) 현재 장 봉들 중 '최고 고가'를 찾는다(같은 값이면 마지막 것 — 고점 재terminal 시 리셋 효과).
 *     2) 그 최고점 '이후' 첫 음봉 도지를 찾는다.
 *     3) 도지 다음 봉이 있고 음봉이면 → confirmed. 다음 봉이 아직 없으면 → watch.
 *        다음 봉이 양봉이면 패턴이 깨진 것 → none.
 */
export function scanSessionPattern(candles5m: Candle[], sessionStartMs: number, bodyRatioMax = 0.3): SessionPattern {
  // 현재 장 봉만 추린다(원래 인덱스 매핑은 필요 없어 새 배열로 다룬다).
  const s = candles5m.filter((c) => c.time >= sessionStartMs);
  const empty: SessionPattern = { sessionHigh: null, highTime: null, highIndex: -1, dojiIndex: -1, dojiCandle: null, dojiBodyRatio: null, nextCandle: null, status: "none" };
  if (s.length === 0) return empty;

  // 1) 최고 고가와 그 인덱스(마지막으로 최고를 찍은 봉).
  let sessionHigh = -Infinity;
  let highIndex = -1;
  s.forEach((c, i) => {
    if (c.high >= sessionHigh) { sessionHigh = c.high; highIndex = i; } // '>=' → 동점이면 뒤 봉으로 갱신
  });
  const highTime = highIndex >= 0 ? s[highIndex].time : null;

  // 2) 최고점 이후 첫 음봉 도지.
  let dojiIndex = -1;
  for (let i = highIndex + 1; i < s.length; i++) {
    if (isBearishDoji(s[i], bodyRatioMax)) { dojiIndex = i; break; }
  }
  if (dojiIndex === -1) return { ...empty, sessionHigh, highTime, highIndex };

  // 근거용: 도지 봉과 몸통비율.
  const dojiCandle = s[dojiIndex];
  const range = dojiCandle.high - dojiCandle.low;
  const dojiBodyRatio = range > 0 ? (dojiCandle.open - dojiCandle.close) / range : null;

  // 3) 도지 다음 봉 판정.
  const next = s[dojiIndex + 1] ?? null;
  const base = { sessionHigh, highTime, highIndex, dojiIndex, dojiCandle, dojiBodyRatio, nextCandle: next };
  if (!next) return { ...base, status: "watch" }; //                    다음 봉 대기
  const nextBearish = next.close < next.open;
  return { ...base, status: nextBearish ? "confirmed" : "none" };
}
