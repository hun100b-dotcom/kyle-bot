// =============================================================================
// lib/calc.ts  —  카프리 계산 엔진 (설계서 M1)
// -----------------------------------------------------------------------------
// 이 파일은 "주문 가격을 계산"하는 순수 함수들만 모아둔 곳입니다.
// - 실제 주문을 넣거나 네트워크를 호출하지 않습니다(S1 단계: 계산 로직만).
// - 입력을 넣으면 항상 같은 결과가 나오는 "순수 함수"라서 테스트가 쉽습니다.
//
// [왜 순수 함수로 만드나?]
//   판단(사람)과 실행(기계)을 분리한다는 설계 원칙 때문입니다.
//   가격 계산은 실주문 코드와 완전히 떼어 놓아야, 값이 맞는지 vitest로
//   눈으로 확인하고 나서 나중에 실주문에 연결할 수 있습니다.
// =============================================================================

// -----------------------------------------------------------------------------
// [부동소수점(소수 계산) 오차 문제]
//   컴퓨터는 0.1 + 0.2 를 정확히 0.3 으로 계산하지 못합니다(0.30000000000000004).
//   주식 가격은 센트($0.01) 단위로 딱 떨어져야 하는데, 이런 오차가 남으면
//   토스 서버가 "유효하지 않은 가격"이라며 400 에러를 냅니다.
//   그래서 "모든 최종 가격"은 반드시 roundPrice()를 통과시켜 유효 틱으로 만듭니다.
// -----------------------------------------------------------------------------

/**
 * getTick — 그 가격대에서 최소 호가 단위(틱)를 돌려준다.
 *
 *   - $1 이상: 0.01 (1센트)
 *   - $1 미만: 0.0001 (0.01센트)
 *
 * [왜 필요한가?]
 *   미국 주식은 가격대에 따라 움직일 수 있는 최소 폭이 다릅니다.
 *   "매수벽 + 1틱" 같은 계산에서 이 틱 값을 써야 정확합니다.
 *
 * [반페니($0.005) 틱은?]
 *   2027-11까지 유예되어 아직 적용 안 됩니다. 그래서 당분간 위 두 규칙만 씁니다.
 */
export function getTick(price: number): number {
  return price >= 1 ? 0.01 : 0.0001;
}

/**
 * roundPrice — 가격을 유효한 틱 단위로 "절삭(내림)"한다.
 *
 *   - $1 이상: 소수 2자리에서 절삭 (예: 2.1522 → 2.15)
 *   - $1 미만: 소수 4자리에서 절삭 (예: 0.73105 → 0.7310)
 *
 * [왜 반올림이 아니라 절삭인가?]
 *   설계서 검증 케이스가 절삭 기준입니다.
 *   예) 손절 1.8990 → 1.89 (반올림이면 1.90이 되지만, 설계서는 1.89를 원함).
 *   보수적으로 내려 잡아 두는 편이 손절/익절 가격을 안전하게 만듭니다.
 *
 * [부동소수점 보정: 왜 +1e-6을 더하나?]
 *   예를 들어 실제로는 7311.0 이어야 할 값이 부동소수점 오차로
 *   7310.9999999... 로 저장되면, 그냥 floor 하면 7310으로 "한 틱 밀려" 버립니다.
 *   아주 작은 값(1e-6)을 더해 이 음(-)의 오차만 보정하고 floor 합니다.
 *   1e-6은 한 틱(0.01 또는 0.0001)보다 훨씬 작아, 진짜 절삭 결과는 바꾸지 않습니다.
 */
export function roundPrice(price: number): number {
  // scale: 정수로 바꾸기 위한 배율. $1 이상은 100(센트), 미만은 10000(1만분의1달러).
  const scale = price >= 1 ? 100 : 10000;
  // price * scale 을 정수에 가깝게 만든 뒤, 음의 오차만 보정(+1e-6)하고 내림.
  return Math.floor(price * scale + 1e-6) / scale;
}

/**
 * calcTpSl — 진입가로부터 익절가/손절가를 계산한다(내부 공용 헬퍼).
 *
 *   - 익절 = 진입 × (1 + tp_pct/100)
 *   - 손절 = 진입 × (1 − sl_pct/100)
 *
 * [주의] 익절/손절가도 반드시 roundPrice()를 거칩니다.
 *        토스에 넣을 실제 주문 가격이라 유효 틱이 아니면 거부되기 때문입니다.
 */
function calcTpSl(entry: number, tpPct: number, slPct: number): { tp: number; sl: number } {
  const tp = roundPrice(entry * (1 + tpPct / 100));
  const sl = roundPrice(entry * (1 - slPct / 100));
  return { tp, sl };
}

/** 한 분할(진입/익절/손절 한 세트)을 표현하는 타입 */
export interface SplitOrder {
  /** 분할 번호 (1, 2, 3) */
  level: number;
  /** 진입가 */
  entry: number;
  /** 익절가 */
  tp: number;
  /** 손절가 */
  sl: number;
}

/**
 * calcSplit3 — "삼분할 진입" 가격을 계산한다. (설계서 M1 핵심)
 *
 *   전봉 종가(baseClose)와 EMA200 사이 구간을 3등분해서
 *   1·2·3분할 진입가를 만들고, 각각의 익절/손절가를 붙여 돌려줍니다.
 *
 *   gap = 전봉종가 − EMA200
 *     1분할 = 전봉종가 − gap/3      (가장 위, 얕게 눌렸을 때)
 *     2분할 = 전봉종가 − gap*2/3    (중간)
 *     3분할 = EMA200                (가장 아래, EMA200까지 왔을 때)
 *
 * [진입 필터] baseClose <= ema200 이면(=gap이 0 이하) 에러를 던집니다.
 *   전봉 종가가 EMA200 위에 있어야(=상승 추세) 매수 전략이 성립하기 때문입니다.
 *   gap이 0 이하라는 건 이 조건이 깨졌다는 뜻이라 "진입 거부"가 맞습니다.
 *
 * [왜 throw(예외)인가?]
 *   잘못된 가격으로 주문이 나가는 것보다, 아예 계산을 멈추는 편이 안전합니다.
 *   호출부는 try/catch 또는 사전 검사로 "이 종목은 진입 안 함"을 처리합니다.
 */
export function calcSplit3(
  baseClose: number,
  ema200: number,
  tpPct: number,
  slPct: number,
): { splits: SplitOrder[] } {
  const gap = baseClose - ema200;

  // 진입 필터: gap > 0 이 아니면 거부(전봉종가가 EMA200 이하이면 진입 안 함).
  if (gap <= 0) {
    throw new Error(
      `진입 필터 불성립: 전봉종가(${baseClose})가 EMA200(${ema200}) 이하입니다. gap>0 이어야 진입합니다.`,
    );
  }

  // 세 진입가를 계산하고 각각 유효 틱으로 절삭(roundPrice).
  // 나눗셈(gap/3)에서 부동소수점 오차가 생길 수 있으므로 roundPrice가 꼭 필요합니다.
  const entry1 = roundPrice(baseClose - gap / 3);
  const entry2 = roundPrice(baseClose - (gap * 2) / 3);
  const entry3 = roundPrice(ema200); // 3분할은 EMA200 자체(값이 이미 유효하지 않을 수 있어 절삭)

  const splits: SplitOrder[] = [
    { level: 1, entry: entry1, ...calcTpSl(entry1, tpPct, slPct) },
    { level: 2, entry: entry2, ...calcTpSl(entry2, tpPct, slPct) },
    { level: 3, entry: entry3, ...calcTpSl(entry3, tpPct, slPct) },
  ];

  return { splits };

  // TODO(S2): split_fill_policy 기본값은 first_only(1분할만 체결 확인 후 진행).
  //           이 정책 처리는 실주문 어댑터 단계에서 결정합니다.
}

/** 단일 진입(호가창/캔들) 주문을 표현하는 타입 */
export interface SingleOrder {
  /** 진입가 */
  entry: number;
  /** 익절가 (tpPct를 주지 않으면 null) */
  tp: number | null;
  /** 손절가 (slPct를 주지 않으면 null) */
  sl: number | null;
}

/**
 * calcOrderbook — "호가창(매수벽)" 전략의 진입가를 계산한다.
 *
 *   진입 = 매수벽 가격(wallPrice) + 1틱(tick)
 *
 * [왜 +1틱인가?]
 *   두꺼운 매수벽 바로 한 틱 위에 사면, 그 벽이 가격을 받쳐 주는 동안
 *   먼저 체결될 가능성이 높습니다. 벽에 딱 붙이지 않고 한 칸 위에 두는 이유입니다.
 *
 * tpPct/slPct 는 선택 인자입니다(안 주면 tp/sl 은 null).
 * 진입가만 필요할 때도 있어서 익절/손절 계산을 강제하지 않습니다.
 *
 * [TODO(S2)] "매수벽"의 정량 기준(몇 주 이상을 벽으로 볼지)은 아직 미확정입니다.
 *            여기서는 이미 판별된 wallPrice를 인자로 받는 것으로 가정합니다.
 */
export function calcOrderbook(
  wallPrice: number,
  tick: number,
  tpPct?: number,
  slPct?: number,
): SingleOrder {
  const entry = roundPrice(wallPrice + tick);
  return withOptionalTpSl(entry, tpPct, slPct);
}

/**
 * calcCandle — "캔들(현재봉 시가 기준)" 전략의 진입가를 계산한다.
 *
 *   진입 = 현재봉 시가(barOpen) − 3틱(tick)
 *
 * [전제] 전봉이 "양봉"(종가 > 시가, 상승 마감)일 때만 사용하는 전략입니다.
 *   양봉 다음의 눌림목을 시가보다 3틱 아래에서 싸게 받으려는 의도입니다.
 *
 * [TODO(S2)] "전봉이 양봉인가?" 판정은 이 함수의 책임이 아니라 호출부의 책임입니다.
 *            호출부에서 양봉을 먼저 확인하고 이 함수를 부르도록 합니다.
 *            (이 함수는 순수하게 진입가 계산만 담당합니다.)
 */
export function calcCandle(
  barOpen: number,
  tick: number,
  tpPct?: number,
  slPct?: number,
): SingleOrder {
  const entry = roundPrice(barOpen - 3 * tick);
  return withOptionalTpSl(entry, tpPct, slPct);
}

/**
 * withOptionalTpSl — 진입가에 (선택적) 익절/손절을 붙여 SingleOrder로 만든다.
 *   tpPct/slPct가 둘 다 주어졌을 때만 tp/sl을 계산하고, 아니면 null로 둡니다.
 */
function withOptionalTpSl(entry: number, tpPct?: number, slPct?: number): SingleOrder {
  if (tpPct === undefined || slPct === undefined) {
    return { entry, tp: null, sl: null };
  }
  const { tp, sl } = calcTpSl(entry, tpPct, slPct);
  return { entry, tp, sl };
}
