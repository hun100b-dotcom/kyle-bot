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
 * dropIncompleteBucket — "아직 형성 중(미완성)인 마지막 5분봉"을 제거한다.
 *
 *   [왜 필요한가? — 정확성의 핵심]
 *     5분봉은 [T, T+5분) 구간이 다 지나야 '완성'된다. 아직 진행 중인 봉으로 판정하면,
 *     스캔 시점엔 음봉 도지였다가 봉이 마감되며 양봉으로 바뀌어 판정이 뒤집힐 수 있다.
 *     특히 하이킨아시는 봉이 진행되는 내내 값이 계속 변하므로 더 위험하다.
 *     그래서 도지·음봉·다음봉·최고점·지표를 모두 '완성된 봉'으로만 계산한다.
 *
 *   판정: 버킷 시작 T에 대해 (T + 5분) ≤ now 이면 그 5분 창이 끝났으므로 '완성'.
 *   now 이후로 끝나는(=아직 진행 중) 봉은 버린다. (보통 마지막 1개만 해당)
 *
 *   @param candles5m 5분봉(합성 결과)
 *   @param nowMs     현재 시각(ms epoch). 엔진이 DateTime.now()로 넘긴다.
 */
export function dropIncompleteBucket(candles5m: Candle[], nowMs: number): Candle[] {
  return candles5m.filter((c) => c.time + FIVE_MIN_MS <= nowMs);
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

/** 꼬리(그림자) 크기를 전체범위 대비 비율로 반환. 위/아래 꼬리 존재 여부 판단·근거 표시용. */
export function candleWicks(c: Candle): { upper: number; lower: number; upperPct: number | null; lowerPct: number | null } {
  const range = c.high - c.low;
  const bodyTop = Math.max(c.open, c.close);
  const bodyBottom = Math.min(c.open, c.close);
  const upper = c.high - bodyTop; //   윗꼬리 길이
  const lower = bodyBottom - c.low; // 아래꼬리 길이
  return { upper, lower, upperPct: range > 0 ? upper / range : null, lowerPct: range > 0 ? lower / range : null };
}

/** [v0.6.3] 유효 도지의 최소 꼬리 비율 — 위·아래 꼬리가 각각 전체범위의 이 비율 이상이어야 한다.
 *  망치형(아래꼬리만)·유성형/비석(윗꼬리만)·민둥봉(꼬리 없음)을 배제하기 위한 기준(노이즈 방지). */
export const WICK_MIN_RATIO = 0.1; // 10%

/**
 * isBearishDoji — "음봉 도지"인지 판정. [v0.6.3] 양쪽 꼬리 조건 추가.
 *   ① 음봉(종가<시가)
 *   ② 몸통이 작음(|시가-종가| ≤ 전체범위 × bodyRatioMax, 기본 0.3)
 *   ③ 위꼬리·아래꼬리가 '둘 다' 의미 있게 존재(각각 ≥ 전체범위 × wickMinRatio, 기본 10%)
 *      → 망치형(아래꼬리만)·유성형/비석(윗꼬리만)·민둥봉(꼬리 없음)은 도지 아님.
 *   범위(high-low)가 0이면 도지 아님.
 */
export function isBearishDoji(c: Candle, bodyRatioMax = 0.3, wickMinRatio = WICK_MIN_RATIO): boolean {
  const range = c.high - c.low;
  if (range <= 0) return false;
  if (c.close >= c.open) return false; // ① 음봉이어야 함
  const body = c.open - c.close; //       음봉이므로 양수
  if (body > bodyRatioMax * range) return false; // ② 몸통 작아야 함
  const { upper, lower } = candleWicks(c); //        ③ 양쪽 꼬리 존재
  return upper >= wickMinRatio * range && lower >= wickMinRatio * range;
}

export type PatternStatus = "confirmed" | "watch" | "none";

/** [v0.25.0 → v0.29.0 20분→40분 완화] 도지 발생 시점이 이보다 오래되면 실 매매에 쓰기엔 불확실한
 *  과거 데이터로 보고 불합격시킨다.
 *  [왜 40분인가 — 오너 지시 2026-09-25 "후보가 너무 안 나온다, 기준 재점검"에 따른 재검토]
 *  확정(confirmed) 판정은 "도지 발생 + 다음 5분봉까지 완성"이 필요해, 20분 기준일 때 실제로
 *  유효했던 구간은 도지 형성 후 최대 15분(3개 봉)뿐이었다 — 5분마다 도는 자동매매 사이클과
 *  맞물리면 한두 번 확인을 놓치는 순간 바로 탈락해버릴 만큼 빠듯했다. 이 필터는 "이 도지가 지금
 *  매매 근거로 쓰기엔 너무 옛날 얘기인가"를 걸러내려는 목적이지 패턴 자체의 정확성과는 무관하므로
 *  (몸통·꼬리 비율 조건이 이미 패턴 품질을 담보) 40분(=8개 5분봉)으로 완화해도 "몇 시간 전 도지가
 *  계속 확정으로 남는" 원래 문제는 여전히 막으면서, 후보가 너무 드물게 나오던 병목은 줄어든다.
 *  손익 규칙(진입가·익절·손절)은 전혀 건드리지 않으므로 매매 안전성에는 영향 없음. */
export const DOJI_MAX_AGE_MINUTES = 40;

export interface SessionPattern {
  sessionHigh: number | null; // 현재 장 시작 이후 최고 고가
  highTime: number | null; //   그 최고점을 만든 봉의 시각(ms, 없으면 null)
  highIndex: number; //         그 최고점을 만든 봉 인덱스(sessionCandles 기준, 없으면 -1)
  dojiIndex: number; //         최고점 이후 첫 음봉 도지 인덱스(없으면 -1)
  dojiCandle: Candle | null; // 기준으로 잡은 첫 음봉 도지 봉(근거 표시용)
  dojiBodyRatio: number | null; // 그 도지의 몸통비율(=몸통/범위, 근거 표시용)
  dojiUpperWickPct: number | null; // [v0.6.3] 그 도지의 윗꼬리 비율
  dojiLowerWickPct: number | null; // [v0.6.3] 그 도지의 아래꼬리 비율
  nextCandle: Candle | null; // 도지 다음 봉(근거 표시용)
  status: PatternStatus; //     confirmed(도지+다음음봉) / watch(도지만) / none
  tooOld: boolean; //           [v0.25.0] 도지 발생 시점이 기준(maxAgeMinutes)보다 오래돼 강제로 none 처리됐는지
}

/**
 * scanSessionPattern — "현재 장 시작 이후 최고점 → 그 이후 첫 음봉 도지 → 다음 봉도 음봉" 판정.
 *
 *   @param candles5m      5분봉 전체(시각 오름차순)
 *   @param sessionStartMs 현재 활성 장의 시작 시각(ms). 이 시각 이후 봉만 본다.
 *   @param bodyRatioMax   도지 몸통 비율 상한(기본 0.3)
 *   @param wickMinRatio   도지 최소 꼬리 비율(기본 WICK_MIN_RATIO)
 *   @param nowMs          [v0.25.0] 지금 시각(ms). 주면 도지 발생 시점이 오래됐는지 검사한다(안 주면 검사 생략 — 과거 호출 호환).
 *   @param maxAgeMinutes  [v0.25.0] 도지가 이보다 오래되면 불합격(기본 20분)
 *
 *   판정 규칙:
 *     1) 현재 장 봉들 중 '최고 고가'를 찾는다(같은 값이면 마지막 것 — 고점 재terminal 시 리셋 효과).
 *     2) 그 최고점 '이후' 첫 음봉 도지를 찾는다.
 *     3) 도지 다음 봉이 있고 음봉이면 → confirmed. 다음 봉이 아직 없으면 → watch.
 *        다음 봉이 양봉이면 패턴이 깨진 것 → none.
 *     4) [v0.25.0] 그 도지가 nowMs 기준 maxAgeMinutes보다 오래전 봉이면, 위 판정과 무관하게 → none.
 *        [왜?] 세션 최고점 갱신 없이 오래 옆걸음치면, 몇 시간 전에 잡힌 도지가 계속 "확정"으로 남아
 *        나온다. 그 시점 가격 흐름은 이미 다 지나간 과거라 지금 매매 근거로 쓰기엔 불확실하다.
 *
 *   @param nextCandleConfirmEnabled [v0.51.0 긴급 수정] 꺼져 있으면(false) 도지가 나온 즉시 confirmed —
 *     다음 봉이 아직 없든, 이미 나왔는데 양봉이든 상관없이 "다음 봉" 자체를 더 이상 보지 않는다.
 *     [버그였던 이전 동작] 이 파라미터가 아예 없어서, 스크리닝 기준 탭에서 "다음봉 확인"을 꺼도
 *     electron/tool-engine.ts의 applyScreenGates()는 "아직 다음 봉이 없어 watch인" 경우만
 *     confirmed로 승격시켜 줄 수 있었다 — 그런데 5분마다 도는 스캔은 대부분 다음 봉이 '이미'
 *     나와 있는 시점에 맞아떨어지므로, 그 다음 봉이 우연히 양봉이면 status가 곧장 "none"으로
 *     확정 판정 자체가 나 버렸고, applyScreenGates는 watch만 구제할 뿐 none은 손대지 않아 그대로
 *     탈락했다(꺼도 꺼지지 않는 필터처럼 보인 실제 원인 — 스캔 타이밍에 따라 같은 도지가 어떨 땐
 *     구제되고 어떨 땐 안 되는 식으로 들쭉날쭉했다). 이제 이 함수 자체가 토글을 알고 있어, 꺼져
 *     있으면 다음 봉의 색과 무관하게 즉시 confirmed로 판정한다(문서화된 의도 "도지만으로 확정"과 일치).
 */
export function scanSessionPattern(
  candles5m: Candle[],
  sessionStartMs: number,
  bodyRatioMax = 0.3,
  wickMinRatio = WICK_MIN_RATIO,
  nowMs?: number,
  maxAgeMinutes = DOJI_MAX_AGE_MINUTES,
  nextCandleConfirmEnabled = true,
): SessionPattern {
  // 현재 장 봉만 추린다(원래 인덱스 매핑은 필요 없어 새 배열로 다룬다).
  const s = candles5m.filter((c) => c.time >= sessionStartMs);
  const empty: SessionPattern = {
    sessionHigh: null, highTime: null, highIndex: -1, dojiIndex: -1, dojiCandle: null,
    dojiBodyRatio: null, dojiUpperWickPct: null, dojiLowerWickPct: null, nextCandle: null,
    status: "none", tooOld: false,
  };
  if (s.length === 0) return empty;

  // 1) 세션 '전체' 최고 고가와, 그 최고를 마지막으로 찍은 봉의 인덱스.
  //    [v0.6.3 신고가 무효화 — 임의 N봉 창을 쓰지 않는 이유]
  //    highIndex는 "세션에서 가장 높이 오른(마지막) 봉"이다. 도지는 아래(2)에서 'highIndex 이후'만
  //    찾으므로, 만약 도지 뒤에 가격이 '신고가'를 다시 냈다면 그 신고가 봉이 새 최고점이 되어
  //    highIndex가 그쪽으로 이동한다 → 이전 도지는 'highIndex 이후'가 아니게 되어 자동 폐기된다.
  //    즉 "말아올려 신고가를 낸" 셋업은 저절로 무효가 된다(고정 창 없이, 최고점 갱신만으로).
  let sessionHigh = -Infinity;
  let highIndex = -1;
  s.forEach((c, i) => {
    if (c.high >= sessionHigh) { sessionHigh = c.high; highIndex = i; } // '>=' → 동점(재terminal)이어도 뒤 봉으로 갱신
  });
  const highTime = highIndex >= 0 ? s[highIndex].time : null;

  // 2) 최고점 이후 첫 '유효 음봉 도지'(몸통 작음 + 양쪽 꼬리 존재).
  let dojiIndex = -1;
  for (let i = highIndex + 1; i < s.length; i++) {
    if (isBearishDoji(s[i], bodyRatioMax, wickMinRatio)) { dojiIndex = i; break; }
  }
  if (dojiIndex === -1) return { ...empty, sessionHigh, highTime, highIndex };

  // 근거용: 도지 봉의 몸통·꼬리 비율.
  const dojiCandle = s[dojiIndex];
  const range = dojiCandle.high - dojiCandle.low;
  const dojiBodyRatio = range > 0 ? (dojiCandle.open - dojiCandle.close) / range : null;
  const wk = candleWicks(dojiCandle);

  // 4) [v0.25.0] 도지가 너무 오래됐는지 먼저 판정 — 오래됐으면 아래 3)의 결과와 무관하게 none.
  const tooOld = nowMs != null && dojiCandle.time < nowMs - maxAgeMinutes * 60_000;

  // 3) 도지 다음 봉 판정.
  const next = s[dojiIndex + 1] ?? null;
  const base = { sessionHigh, highTime, highIndex, dojiIndex, dojiCandle, dojiBodyRatio, dojiUpperWickPct: wk.upperPct, dojiLowerWickPct: wk.lowerPct, nextCandle: next, tooOld };
  if (tooOld) return { ...base, status: "none" };
  // [v0.51.0] "다음 봉 확인" 자체를 꺼 뒀으면, 다음 봉이 있는지·무슨 색인지 아예 보지 않고
  //   도지 하나만으로 즉시 확정(위 함수 설명 참고 — 버그였던 이전 동작 설명 포함).
  if (!nextCandleConfirmEnabled) return { ...base, status: "confirmed" as PatternStatus };
  if (!next) return { ...base, status: "watch" as PatternStatus }; //   다음 봉 대기
  const nextBearish = next.close < next.open;
  return { ...base, status: (nextBearish ? "confirmed" : "none") as PatternStatus };
}
