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
      q.push({ qty: f.qty, price: f.price, feePerShare: f.qty > 0 ? (f.commission + f.tax) / f.qty : 0 });
      lots.set(f.symbol, q);
      continue;
    }

    // ── 매도: 먼저 산 것부터 채운다 ──
    const q = lots.get(f.symbol) ?? [];
    let remain = f.qty;
    let costSum = 0; //  팔린 수량의 매입 원가 합
    let buyFee = 0; //   그 수량에 해당하는 매수 수수료
    let filled = 0; //   실제로 매칭된 수량

    while (remain > 0 && q.length > 0) {
      const lot = q[0];
      const take = Math.min(lot.qty, remain);
      costSum += take * lot.price;
      buyFee += take * lot.feePerShare;
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
