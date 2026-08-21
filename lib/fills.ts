// =============================================================================
// lib/fills.ts — 토스 '실제 체결 내역'으로 매매 성적을 계산한다 (순수 계산, PC·폰 공통)
// -----------------------------------------------------------------------------
// [왜 새로 만들었나 — 실제로 겪은 문제]
//   리포트가 앱이 자체적으로 남긴 '매매 기록'만 보고 있었습니다. 그런데 그 기록은
//   **앱에서 [매도] 버튼을 눌렀을 때만** 청산으로 남습니다. 사장님은
//     · 익절/손절을 **토스 조건주문**에 맡기거나(토스 서버가 알아서 체결)
//     · 토스 앱에서 직접 파시기도 하므로
//   앱은 "판 사실"을 알 수 없었고, 그래서 리포트가 **항상 비어 있었습니다**(매수 22건·매도 0건).
//
//   이제는 **토스에 실제로 남은 체결 내역**을 그대로 가져와 계산합니다.
//   어디서 주문했든(카프리·토스앱·조건주문 자동체결) 전부 잡힙니다.
//
// [손익은 어떻게 계산하나 — 선입선출(FIFO)]
//   판 수량은 '먼저 산 것부터' 팔린 것으로 봅니다(증권사 계산과 같은 방식).
//     예) 100주 $4.00 매수 → 50주 $4.20 매수 → 120주 $4.50 매도
//         = 100주는 $4.00에서, 20주는 $4.20에서 산 것으로 보고 손익을 낸다.
//   수수료·세금은 실제 체결에 붙은 값을 그대로 빼서 **손에 쥔 금액**에 가깝게 만듭니다.
// =============================================================================

/** 체결 한 건(토스 주문 내역에서 뽑아낸 것) */
export interface Fill {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number; //         체결 수량
  price: number; //       평균 체결가
  atMs: number; //        체결 시각(밀리초)
  commission: number; //  수수료
  tax: number; //         세금
  currency?: string; //   통화(USD 등) — 표시용
}

/** 매도 한 건으로 확정된 손익 */
export interface RealizedTrade {
  symbol: string;
  sellAtMs: number;
  buyAtMs?: number; //    [v0.19.0] 팔린 물량 중 '가장 이른 매수' 시각(보유기간용). 폴백매칭이면 없음.
  qty: number;
  buyAvg: number; //      팔린 수량의 평균 매입가
  sellPrice: number; //   평균 매도가
  pnl: number; //         실현 손익(수수료·세금 반영)
  pct: number; //         수익률 %
  matched: boolean; //    매입 기록을 찾아 계산했는가(false면 추정)
}

/** 매입 대기열(선입선출) 한 덩어리 */
interface Lot {
  qty: number;
  price: number;
  feePerShare: number; // 매수 수수료를 주당으로 나눠 둔 값
  atMs: number; //       [v0.19.0] 그 매수 체결 시각(보유기간 계산용)
}

/**
 * matchFifo — 체결 목록을 시간순으로 훑으며 '매도 건별 실현손익'을 만든다.
 *
 * @param fills      체결 목록(기간보다 **넉넉히** 넣어야 한다. 예전에 산 것을 오늘 팔 수 있으므로)
 * @param avgCostFallback 매입 기록이 없을 때 쓸 평균매입가(계좌의 보유 평균가). 없으면 그 매도는 손익 제외.
 */
export function matchFifo(fills: Fill[], avgCostFallback: Record<string, number> = {}): RealizedTrade[] {
  const sorted = [...fills].sort((a, b) => a.atMs - b.atMs); // 시간순(과거 → 최근)
  const lots = new Map<string, Lot[]>();
  const out: RealizedTrade[] = [];

  for (const f of sorted) {
    if (!(f.qty > 0)) continue;

    if (f.side === "BUY") {
      const q = lots.get(f.symbol) ?? [];
      q.push({ qty: f.qty, price: f.price, feePerShare: f.qty > 0 ? (f.commission + f.tax) / f.qty : 0, atMs: f.atMs });
      lots.set(f.symbol, q);
      continue;
    }

    // ── 매도: 먼저 산 것부터 채운다 ──
    const q = lots.get(f.symbol) ?? [];
    let remain = f.qty;
    let costSum = 0; //  팔린 수량의 매입 원가 합
    let buyFee = 0; //   그 수량에 해당하는 매수 수수료
    let filled = 0; //   실제로 매칭된 수량
    let firstBuyAtMs = Number.POSITIVE_INFINITY; // [v0.19.0] 이 매도에 채워진 가장 이른 매수 시각

    while (remain > 0 && q.length > 0) {
      const lot = q[0];
      const take = Math.min(lot.qty, remain);
      costSum += take * lot.price;
      buyFee += take * lot.feePerShare;
      firstBuyAtMs = Math.min(firstBuyAtMs, lot.atMs);
      lot.qty -= take;
      remain -= take;
      filled += take;
      if (lot.qty <= 0.0000001) q.shift();
    }
    lots.set(f.symbol, q);

    // 매칭이 부족하면(이 기간 전에 산 물량) 계좌 평균매입가로 메운다.
    let matched = remain === 0;
    if (remain > 0) {
      const fallback = avgCostFallback[f.symbol];
      if (fallback != null && Number.isFinite(fallback)) {
        costSum += remain * fallback;
        filled += remain;
        remain = 0;
      } else {
        matched = false;
      }
    }

    if (filled <= 0) continue; // 계산할 근거가 전혀 없으면 건너뛴다(추측하지 않는다)

    const buyAvg = costSum / filled;
    const gross = (f.price - buyAvg) * filled;
    // 매도 수수료·세금은 판 수량 비율만큼, 매수 수수료는 위에서 모은 값만큼 뺀다.
    const sellFee = ((f.commission + f.tax) * filled) / f.qty;
    const pnl = gross - sellFee - buyFee;

    out.push({
      symbol: f.symbol,
      sellAtMs: f.atMs,
      // [v0.19.0] 매수 시각 → 보유기간(sellAtMs - buyAtMs). 매칭된 매수가 없으면(폴백만) undefined.
      buyAtMs: Number.isFinite(firstBuyAtMs) ? firstBuyAtMs : undefined,
      qty: filled,
      buyAvg: Math.round(buyAvg * 10000) / 10000,
      sellPrice: f.price,
      pnl: Math.round(pnl * 100) / 100,
      pct: buyAvg > 0 ? Math.round(((f.price - buyAvg) / buyAvg) * 10000) / 100 : 0,
      matched,
    });
  }

  return out;
}

/**
 * fillKey — 체결 한 건을 구분하는 열쇠(중복 저장 방지용).
 *   토스가 같은 체결을 여러 번 돌려줘도 한 번만 쌓이게 한다.
 */
export function fillKey(f: Fill): string {
  return [f.symbol, f.side, f.atMs, f.qty, f.price].join("|");
}

// =============================================================================
// [v0.10.1] 기간 리포트 정확도 — "얼마나 깊이 가져왔나"를 정확히 다루는 순수 헬퍼
// -----------------------------------------------------------------------------
// [무엇이 문제였나 — 실제로 겪은 부정확]
//   토스 '종료된 주문'을 페이지 넘겨 가져올 때 **8페이지(약 160건)에서 무조건 끊었다.**
//   매매가 잦으면 "최근 30일"을 눌러도 160건 안에 30일치가 다 안 들어와 **옛 매매가 조용히 빠졌고**,
//   게다가 '일부만 가져옴(partial)' 표시도 안 됐다(예외가 날 때만 표시). → 기간 리포트가 부정확.
//
// [두 번째 문제 — 캐시가 '깊이'를 기억하지 않음]
//   "오늘"(45일 버퍼)을 먼저 받아 캐시하면, 60초 안에 "1개월"(약 74일 필요)을 눌러도
//   그 얕은 캐시를 그대로 재사용해 월간 리포트가 잘렸다.
//
// 아래 두 함수는 "이번에 어디까지 확실히 커버했나(coveredSinceMs)"와
// "그 캐시가 이번 요청을 감당하나(cacheCovers)"를 순수 계산으로 못 박아 테스트한다.
// =============================================================================

/** 페이지 넘김을 멈춘 이유 */
export interface FetchOutcome {
  /** 더 받을 페이지가 없어(hasNext=false) 끝까지 다 받았다 = 전 구간 커버 */
  reachedEnd: boolean;
  /** 요청한 sinceMs 보다 오래된 체결을 만나 목표 깊이에 도달했다 */
  reachedTarget: boolean;
  /** 이번 요청이 바란 최소 깊이(밀리초). 이 시각까지는 있어야 한다 */
  sinceMs: number;
  /** 이번에 실제로 본 가장 오래된 체결 시각(하나도 없으면 +Infinity) */
  oldestSeenMs: number;
}

/**
 * coveredSince — 이번 수집이 "어느 시각까지 확실히 커버했는지"를 돌려준다.
 *   · 끝까지 다 받았으면(reachedEnd) → -Infinity(전부 있다).
 *   · 목표 깊이에 도달했으면(reachedTarget) → sinceMs(요청한 만큼은 확실히 있다).
 *   · 둘 다 아니면(= 안전 상한에 걸려 중간에 끊김) → 실제로 본 가장 오래된 시각까지만.
 *  이 값이 캐시에 저장되어, 다음 요청이 더 깊이 필요할 때 재수집을 유도한다.
 */
export function coveredSince(o: FetchOutcome): number {
  if (o.reachedEnd) return -Infinity;
  if (o.reachedTarget) return o.sinceMs;
  return Number.isFinite(o.oldestSeenMs) ? o.oldestSeenMs : Number.POSITIVE_INFINITY;
}

/**
 * cacheCovers — 저장된 캐시(coveredSinceMs 까지 커버)가 이번 요청(requestSinceMs 만큼 필요)을 감당하나?
 *   캐시가 요청이 바라는 시각과 같거나 더 깊이(더 과거까지) 커버할 때만 true.
 *   (requestSinceMs 가 coveredSinceMs 보다 과거 = 더 깊이 필요 → false → 재수집)
 */
export function cacheCovers(coveredSinceMs: number, requestSinceMs: number): boolean {
  return requestSinceMs >= coveredSinceMs;
}

/** 60초 캐시의 최소 정보(재사용 판단에 필요한 것만) */
export interface FillsCacheMeta {
  atMs: number; //          이 캐시를 만든 시각
  coveredSinceMs: number; // 어느 시각까지 커버하나
  /**
   * canDeepen: "지금 다시 조회하면 '더 과거'를 실제로 더 가져올 수 있나?"
   *   · true  = 목표 깊이에 닿아 일찍 멈춘 경우(reachedTarget). 더 깊은 요청이 오면 재조회가 이득.
   *   · false = 끝까지 다 받았거나(reachedEnd) / 안전 상한에 걸렸거나(capped) / 조회 실패한 경우.
   *             이 경우 60초 안에 다시 불러도 '더'는 못 얻는다 → 재조회는 낭비(+요청 한도 위험)일 뿐.
   */
  canDeepen: boolean;
}

/**
 * shouldReuseCache — 60초 캐시를 이번 요청에 그대로 써도 되나? (순수 판단)
 *
 * [왜 이 함수가 핵심인가 — A/B 리뷰가 잡은 회귀]
 *   앞서 "캐시가 요청 깊이를 커버할 때만 재사용"으로 바꿨더니, 잦은 매매자는
 *   ① 매매가 많아 상한(capped)에 걸려 캐시가 얕게 잡히고
 *   ② 리포트는 항상 45일 이상을 요구하므로 매 버튼마다 '재조회'가 터져
 *   60초 캐시가 무력화 → 오히려 요청 한도(429) 폭풍이 됐다. 오프라인 실패 캐시도 같은 이유로 난타됐다.
 *
 *   해결: **재조회가 실제로 이득일 때만**(캐시가 더 깊이 갈 수 있는데 이번에 더 깊이 필요할 때만) 재조회한다.
 *   그 밖에는(상한·끝·실패로 더 못 가는 캐시) 60초 동안 그대로 재사용해 두드림을 막는다.
 *   대신 '얕게 잘렸다'는 사실은 리포트 쪽에서 정직하게 표시한다(partial).
 */
export function shouldReuseCache(cache: FillsCacheMeta | null, requestSinceMs: number, nowMs: number, ttlMs = 60_000): boolean {
  if (!cache) return false;
  if (nowMs - cache.atMs >= ttlMs) return false; // 오래된 캐시는 재사용 안 함
  const needDeeper = !cacheCovers(cache.coveredSinceMs, requestSinceMs); // 이번 요청이 캐시보다 더 깊이 필요한가
  // 더 깊이 필요하고(needDeeper) 캐시가 더 깊이 갈 수 있을 때만(canDeepen) 재조회. 그 외엔 재사용.
  return !(needDeeper && cache.canDeepen);
}

/**
 * mergeFills — 저장해 둔 체결과 새로 받은 체결을 합친다(중복 제거, 시간순).
 *
 * [왜 필요한가 — 사장님이 회사에서 겪은 문제]
 *   리포트가 매번 토스에서 '실시간으로' 불러오게 만들었더니, 집 PC에 연결되지 않은 곳
 *   (회사·이동 중)에서는 조회 자체가 안 돼 **리포트가 통째로 비어** 보였습니다.
 *   그래서 한 번 받은 체결은 기기에 쌓아 두고, 연결이 없을 때는 그 기록으로 보여 줍니다.
 */
export function mergeFills(saved: Fill[], incoming: Fill[]): Fill[] {
  const map = new Map<string, Fill>();
  for (const f of saved) map.set(fillKey(f), f);
  for (const f of incoming) map.set(fillKey(f), f);
  return [...map.values()].sort((a, b) => a.atMs - b.atMs);
}
