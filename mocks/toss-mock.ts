// =============================================================================
// mocks/toss-mock.ts  —  가짜 토스 서버 (실제 OpenAPI 스펙 형태로 응답)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   실제 토스 서버 없이 어댑터(lib/toss.ts)를 리허설하기 위한 가짜 서버입니다.
//   진짜 HTTP 서버(node http)로 떠서 fetch·헤더·JSON까지 실제로 왕복합니다.
//
// [2026-07-16 실제 스펙 반영]
//   토스 공식 OpenAPI 문서를 확인해, 응답 형태를 실제와 동일하게 맞췄습니다:
//     - 모든 성공 응답은 { result: ... } 로 감싼다(토큰 제외)
//     - 가격/수량은 "문자열"로 준다 (예: lastPrice: "2.05")
//     - 주문 상태는 대문자 enum (PENDING/PARTIAL_FILLED/FILLED/CANCELED/REJECTED)
//     - 현재가는 symbols(복수) 쿼리, 매수가능금액은 currency 쿼리+계좌 헤더 필수
//     - 정정/취소는 POST /orders/{id}/modify, /cancel
//   이렇게 해야 "어댑터의 번역(실스펙→내부표준)"까지 목 테스트로 검증됩니다.
//
// [시나리오(심볼로 선택)]
//   - 'AAPL'    : 현재가 2.05. 지정가 체결 판정용
//   - 'PARTIAL' : 부분 체결(첫 조회 절반 → 두 번째 조회부터 전량)
//   - 'REJECT'  : 잔고 부족 402 거부
//   - 'SLOW'    : 응답 지연(타임아웃 시험)
//   테스트에서 setPrice(symbol, price)로 현재가를 바꿔 익절/손절을 재현합니다.
// =============================================================================

import http from "node:http";
import type { AddressInfo } from "node:net";

/** 목 서버가 다루는 주문 한 건(메모리 저장, 상태는 실제 스펙처럼 대문자) */
interface MockOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  price?: number;
  quantity: number;
  status: "PENDING" | "FILLED" | "PARTIAL_FILLED" | "CANCELED";
  filledQuantity: number;
  remaining: number;
  pollCount: number; // 단건 조회 횟수(부분체결 "누적" 시연용)
}

/** 조건주문 한 다리(leg) — [v0.51.0] 실스펙 정합: status/triggeredOrderId를 실제처럼 갖는다. */
interface MockCondLeg {
  orderSide: "BUY" | "SELL";
  triggerPrice: number;
  orderPrice?: number;
  status: "WATCHING" | "HOLDING" | "COMPLETED";
  triggeredOrderId: string | null;
}

/**
 * 목 서버의 조건주문 한 건(실스펙 흉내: 감시 조건 1~2개).
 *
 * [v0.51.0 긴급 수정] 예전엔 이 상태값이 "WAITING"/"TRIGGERED"/"CANCELED" +
 *   그룹 레벨 `triggeredLeg` 필드였는데, 이건 실제 토스 API에 없는 **발명된 값**이었다
 *   (electron/tool-engine.ts의 `reconcileAutoPositions`가 실계좌에서 이 값을 영원히 못
 *   찾아 "이미 끝난 포지션을 계속 감시 중으로 착각"하던 정합성 버그의 원인 — 이미 검증돼
 *   정상 동작 중인 "주문현황" 화면 경로(condOrdersView/CondOrderRow/CondLegView 타입,
 *   src/App.tsx의 condStatusKo/legStatusKo)를 근거로 실제 값을 확인했다). 이제 목 서버도
 *   그 실제 값(그룹 status: WATCHING/COMPLETED, 다리별 status + triggeredOrderId)을
 *   그대로 흉내 낸다 — 테스트가 이 정합성 버그 부류를 다시 놓치지 않도록.
 */
interface MockConditional {
  conditionalOrderId: string;
  symbol: string;
  type: "SINGLE" | "OCO" | "OTO";
  quantity: number;
  orderType: "LIMIT" | "MARKET";
  expireDate: string;
  status: "WATCHING" | "COMPLETED";
  first: MockCondLeg;
  second?: MockCondLeg | null;
}

/** 목 서버 내부 상태(테스트에서 조작/검증 가능하게 노출) */
export interface MockState {
  tokenIssueCount: number;
  orders: Map<string, MockOrder>; // clientOrderId → 주문(멱등키 저장소)
  seq: number;
  prices: Record<string, number>;
  conditionals: Map<string, MockConditional>; // 조건주문 저장소
  fxRate: number; // USD→KRW 환율(연습용 고정값, setFxRate로 조작 가능)
  /** [v0.41.0] 429(요청 한도 초과) 재현용 — 이 값이 0보다 크면 인증된 요청 하나마다
   *  1씩 깎으면서 429를 돌려주고, 0이 되면 평소대로 응답한다. 재시도(backoff) 로직
   *  테스트에서 `state.rateLimitRemaining = 1`처럼 직접 설정해 쓴다. */
  rateLimitRemaining: number;
  /** [v0.50.0] 거래량 랭킹(rankings) API가 특정 type 값을 거부하는 상황(예: 잘못 추정한
   *  enum 값)을 재현하기 위한 스위치. 이 값과 요청의 type이 같으면 400을 돌려준다 —
   *  getRankings()의 "새 타입이 거부되면 예전 값으로 폴백" 안전망을 검증하는 용도.
   *  기본은 null(아무 type도 거부 안 함 — 기존 테스트 전부 그대로 통과). */
  rankingsRejectType: string | null;
  /** [v0.50.0] 가장 최근 rankings 요청이 실제로 보낸 type 값(테스트 검증용). */
  lastRankingsType: string | null;
  /** [v0.52.0] 주문 취소(POST /orders/{id}/cancel) 응답 상태를 강제로 바꿔치기하는 스위치 —
   *  "취소 요청은 성공(예외 없음)했지만 실제 반환 상태는 CANCELED가 아닌" 경쟁 상태(막판 체결
   *  등)를 재현한다(watchAndBracket의 cancelOnTimeout 안전망 검증용). 값이 있으면 그 값을 쓰고
   *  한 번 쓰면 다시 null로 돌아간다(한 번만 재현). 기본은 null(예전처럼 항상 CANCELED — 회귀 없음).*/
  cancelReturnsStatus: MockOrder["status"] | null;
  /** [v0.57.0] 조건주문 등록(POST /api/v1/conditional-orders) 응답을 강제로 실패시키는
   *  일회성 스위치 — 체결 직후 "보호주문 등록 실패" 실사례(BGIN insufficient-sellable-quantity,
   *  SMJF "현재가가 두 감시가 사이에 있어야 함")를 재현해 registerOcoForFilled의 재시도·즉시
   *  보호매도 안전망을 검증하는 용도. 값이 있으면 그 status/code/message로 실패시키고 한 번
   *  쓰면 다시 null로 돌아간다(기본은 null — 정상 동작, 기존 테스트 전부 그대로 통과). */
  conditionalOrderRejectOnce: { httpStatus: number; code: string; message: string } | null;
}

const INITIAL_PRICES: Record<string, number> = { AAPL: 2.05, PARTIAL: 2.05, REJECT: 2.05, SLOW: 2.05 };

function priceOf(prices: Record<string, number>, symbol: string): number {
  return prices[symbol] ?? 100;
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** 성공 응답을 실제 스펙처럼 { result } 로 감싸 보낸다. */
function sendResult(res: http.ServerResponse, status: number, result: unknown): void {
  sendJson(res, status, { result });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 주문 상세를 실제 스펙 형태(문자열 숫자 + execution)로 변환 */
function toDetail(o: MockOrder) {
  return {
    orderId: o.orderId,
    clientOrderId: o.clientOrderId,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    status: o.status,
    price: o.price !== undefined ? String(o.price) : null,
    quantity: String(o.quantity),
    execution: {
      filledQuantity: String(o.filledQuantity),
      averageFilledPrice: o.filledQuantity > 0 && o.price !== undefined ? String(o.price) : null,
    },
  };
}

/** 지정가 대기 주문의 체결 여부를 현재가로 판정 */
function limitFill(side: "BUY" | "SELL", cur: number, price: number): boolean {
  return side === "BUY" ? cur <= price : cur >= price;
}

/**
 * [v0.26.0→v0.51.0] OCO(익절+손절) 재판정 — 대기 주문(limitFill)과 같은 원칙: 조회 시점의
 *   현재가로 "발동 조건에 닿았는지"를 다시 확인한다. first=익절(위쪽 감시가, 가격이 올라야
 *   발동), second=손절(아래쪽 감시가, 가격이 내려야 발동) — placeOco/watchAndBracket이 항상 이
 *   모양으로 등록하므로(OCO 규칙: 둘 다 SELL, first감시가>현재가>second감시가) 이 방향으로
 *   고정해도 된다. 자동매매(startAutoTrade)가 "내 포지션이 익절/손절로 끝났는지"를 감지하는
 *   유일한 방법이라 실제 체결처럼 조회할 때마다 다시 확인해 준다(COMPLETED가 되면 더 이상
 *   재판정하지 않음).
 *   [v0.51.0] 그룹/다리 상태를 실스펙(WATCHING/COMPLETED, 다리별 triggeredOrderId)으로 표현.
 */
function reevaluateOco(cond: MockConditional, state: MockState): void {
  if (cond.status !== "WATCHING" || cond.type !== "OCO" || !cond.second) return;
  const cur = priceOf(state.prices, cond.symbol);
  if (cur >= cond.first.triggerPrice) {
    state.seq += 1;
    cond.status = "COMPLETED";
    cond.first.status = "COMPLETED";
    cond.first.triggeredOrderId = `T${state.seq}`;
    cond.second.status = "COMPLETED"; // OCO: 반대쪽(손절)은 발동 없이 함께 종료
  } else if (cur <= cond.second.triggerPrice) {
    state.seq += 1;
    cond.status = "COMPLETED";
    cond.second.status = "COMPLETED";
    cond.second.triggeredOrderId = `T${state.seq}`;
    cond.first.status = "COMPLETED"; // OCO: 반대쪽(익절)은 발동 없이 함께 종료
  }
}

export function createMockTossServer() {
  const state: MockState = {
    tokenIssueCount: 0,
    orders: new Map(),
    seq: 0,
    prices: { ...INITIAL_PRICES },
    conditionals: new Map(),
    fxRate: 1390.5, // 연습용 기본 환율: 1 USD = 1,390.5 KRW
    rateLimitRemaining: 0,
    rankingsRejectType: null,
    lastRankingsType: null,
    cancelReturnsStatus: null,
    conditionalOrderRejectOnce: null,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // ---------- 1) 토큰 발급 (유일하게 result 래핑 없음 — 실제 스펙과 동일) ----------
    if (path === "/oauth2/token" && method === "POST") {
      state.tokenIssueCount += 1;
      return sendJson(res, 200, {
        access_token: `mock-token-${state.tokenIssueCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    // 인증 확인(실제처럼)
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    // [v0.41.0] 429(요청 한도 초과) 재현 — rateLimitRemaining이 남아있으면 그만큼 이 응답부터 429.
    if (state.rateLimitRemaining > 0) {
      state.rateLimitRemaining -= 1;
      res.setHeader("Retry-After", "0"); // 테스트가 빠르게 끝나도록 0초로(실서버는 실제 값을 줌)
      return sendJson(res, 429, { error: "rate_limit_exceeded" });
    }

    // ---------- 2) 시세 ----------
    if (path === "/api/v1/prices" && method === "GET") {
      // 실제 스펙: symbols(복수, 콤마 구분) → result 배열
      const symbols = (url.searchParams.get("symbols") ?? "AAPL").split(",");
      if (symbols.includes("SLOW")) await delay(500); // 타임아웃 시나리오
      return sendResult(
        res,
        200,
        symbols.map((sym) => ({
          symbol: sym,
          timestamp: new Date().toISOString(),
          lastPrice: String(priceOf(state.prices, sym)), // 실제 스펙: 문자열!
          currency: "USD",
        })),
      );
    }

    if (path === "/api/v1/orderbook" && method === "GET") {
      // [v0.5.0] 실서버는 symbol(단수)를 쓰지만, 목은 둘 다 받아 준다(예전 테스트 호환).
      const sym = (url.searchParams.get("symbol") ?? url.searchParams.get("symbols") ?? "AAPL").split(",")[0];
      const cur = priceOf(state.prices, sym);
      return sendResult(res, 200, {
        symbol: sym,
        bids: [
          { price: String(cur - 0.01), quantity: "5000" },
          { price: String(cur - 0.02), quantity: "1200" },
        ],
        asks: [
          { price: String(cur + 0.01), quantity: "800" },
          { price: String(cur + 0.02), quantity: "1500" },
        ],
      });
    }

    if (path === "/api/v1/candles" && method === "GET") {
      // [v0.6.0] 스크리너용: 실스펙 필드(openPrice 등) + before/nextBefore 페이지네이션.
      //   결정적 가상 1분봉을 최근 HORIZON_MIN분까지 생성해, 200개씩 과거로 넘겨준다.
      const sym = (url.searchParams.get("symbol") ?? url.searchParams.get("symbols") ?? "AAPL").split(",")[0];
      const cur = priceOf(state.prices, sym);
      const count = Math.min(Number(url.searchParams.get("count") ?? 200) || 200, 200);
      const before = url.searchParams.get("before");
      const HORIZON_MIN = 1300; // 모의 1분봉 최대 과거(분) — EMA200(5분봉 200개=1분봉 1000개)에 충분
      const MIN = 60_000;
      const nowMin = Math.floor(Date.now() / MIN) * MIN;
      const oldestAllowed = nowMin - HORIZON_MIN * MIN;
      let top = before ? Math.min(Date.parse(before), nowMin) : nowMin;
      top = Math.floor(top / MIN) * MIN;
      // 종목별로 조금씩 다른 가격대(결정적): 심볼 글자합으로 오프셋
      const symOffset = sym.split("").reduce((s, ch) => s + ch.charCodeAt(0), 0) % 20;
      const base = cur + symOffset * 0.01;
      const candleAt = (t: number) => {
        const minsAgo = (nowMin - t) / MIN; // 0=지금, 클수록 과거
        // 과거일수록 살짝 낮게(완만한 상승) + 잔물결 → EMA200 아래에서 현재가 위로
        const p = base * (1 - minsAgo * 0.00002) + Math.sin(t / 6e6) * base * 0.001;
        const open = Math.round(p * 100) / 100;
        const close = Math.round((p + base * 0.0002) * 100) / 100;
        const high = Math.round((Math.max(open, close) + base * 0.0006) * 100) / 100;
        const low = Math.round((Math.min(open, close) - base * 0.0006) * 100) / 100;
        return {
          timestamp: new Date(t).toISOString(),
          openPrice: String(open),
          highPrice: String(high),
          lowPrice: String(low),
          closePrice: String(close),
          volume: String(1000 + ((t / MIN) % 500)),
          currency: "USD",
        };
      };
      const candles = [];
      for (let k = 0; k < count; k++) {
        const t = top - k * MIN; // 최신→과거 순
        if (t < oldestAllowed) break;
        candles.push(candleAt(t));
      }
      const oldest = candles.length ? Date.parse(candles[candles.length - 1].timestamp) : null;
      const nextBefore = oldest && oldest - MIN >= oldestAllowed ? new Date(oldest - MIN).toISOString() : null;
      return sendResult(res, 200, { candles, nextBefore });
    }

    // [v0.6.0] 거래량 랭킹 — 스크리너 스캔 대상(가상 상위 종목).
    if (path === "/api/v1/rankings" && method === "GET") {
      const reqType = url.searchParams.get("type");
      state.lastRankingsType = reqType; // [v0.50.0] 테스트가 "실제로 어떤 type을 보냈는지" 검증할 수 있게
      // [v0.50.0] 특정 type이 거부되는 상황(잘못 추정한 enum) 재현용 — 기본은 비활성.
      if (state.rankingsRejectType && reqType === state.rankingsRejectType) {
        return sendJson(res, 400, { error: `지원하지 않는 랭킹 타입: ${reqType}` });
      }
      const count = Math.min(Number(url.searchParams.get("count") ?? 100) || 100, 100);
      const bases = ["AAPL", "NVDA", "TSLA", "SOFI", "AMD", "PLTR", "AMZN", "META", "MSFT", "GOOGL", "NU", "BITO"];
      const rankings = [];
      for (let i = 0; i < count; i++) {
        const symbol = i < bases.length ? bases[i] : `SYM${String(i + 1).padStart(2, "0")}`;
        const cur = priceOf(state.prices, symbol);
        rankings.push({
          rank: i + 1,
          symbol,
          currency: "USD",
          price: { lastPrice: String(cur), basePrice: String(cur), changeRate: "0.0" },
          tradingVolume: String(1_000_000 - i * 1000),
          tradingAmount: String((1_000_000 - i * 1000) * cur),
        });
      }
      return sendResult(res, 200, { rankedAt: new Date().toISOString(), rankings });
    }

    // [v0.6.3] 종목 메타(유형/레버리지) — ETF 배제 필터용. 몇몇 심볼을 ETF로 표시해 필터를 시연.
    if (path === "/api/v1/stocks" && method === "GET") {
      const syms = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      const ETFS: Record<string, number> = { BITO: 1, TQQQ: 3, SQQQ: -3, SOXL: 3 }; // 가상 ETF(레버리지 배수)
      const out = syms.map((symbol) => {
        const isEtf = symbol in ETFS;
        return {
          symbol,
          name: symbol,
          securityType: isEtf ? "ETF" : "STOCK",
          isCommonShare: true,
          leverageFactor: isEtf ? String(ETFS[symbol]) : null,
        };
      });
      return sendResult(res, 200, out);
    }

    // [v0.5.0] 개별 체결(틱) — 체결강도 추정용 가상 데이터.
    //   실스펙: symbol(단수), count 최대 50, 최근 것만. 응답 = [{price, volume, timestamp, currency}].
    //   방향 필드는 실서버에도 없다(그래서 앱이 틱룰로 추정). 여기선 "매수 우세로 보이는"
    //   지그재그(위로 좀 더 자주 움직이는) 가상 틱을 결정적으로 생성해, 앱·테스트가 붙을 값을 준다.
    if (path === "/api/v1/trades" && method === "GET") {
      const sym = (url.searchParams.get("symbol") ?? url.searchParams.get("symbols") ?? "AAPL").split(",")[0];
      const cur = priceOf(state.prices, sym);
      const count = Math.min(Number(url.searchParams.get("count") ?? 50) || 50, 50);
      const now = Date.now();
      const trades = [];
      let px = cur - 0.1; // 창 시작가(아래에서 위로 올라오며 매수 우세를 연출)
      for (let i = 0; i < count; i++) {
        // 3틱 중 2틱은 업틱, 1틱은 다운틱(결정적 패턴) → 매수 체결량이 더 크게 잡히도록
        const step = i % 3 === 2 ? -0.01 : 0.01;
        px = Math.round((px + step) * 100) / 100;
        trades.push({
          price: String(px),
          volume: String(3 + (i % 5)), // 3~7주로 변동
          timestamp: new Date(now - (count - i) * 1000).toISOString(), // 과거→현재 순
          currency: "USD",
        });
      }
      return sendResult(res, 200, trades);
    }

    // ---------- 3) 계좌 ----------
    if (path === "/api/v1/accounts" && method === "GET") {
      // 계좌 헤더 불필요(실제 스펙). accountSeq가 이후 계좌 헤더 값이 된다.
      return sendResult(res, 200, [{ accountNo: "1400100000000", accountSeq: 1, accountType: "BROKERAGE" }]);
    }

    if (path === "/api/v1/holdings" && method === "GET") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      // [실스펙 정합] 실서버 holdings는 배열이 아니라 "객체"(요약 + items)다.
      //   목이 배열을 주면 나중에 getHoldings를 붙일 때 목만 초록·실서버는 파싱 깨짐.
      return sendResult(res, 200, {
        totalPurchaseAmount: { krw: "200", usd: "100" },
        marketValue: { amount: { krw: "205", usd: "102.5" } },
        profitLoss: { amount: { krw: "5", usd: "2.5" }, rate: "0.025" },
        dailyProfitLoss: { amount: { krw: "1", usd: "0.5" } },
        items: [{ symbol: "AAPL", quantity: "100", averagePrice: "2.00" }],
      });
    }

    if (path === "/api/v1/buying-power" && method === "GET") {
      // 실제 스펙: 계좌 헤더 + currency 쿼리 필수
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      const currency = url.searchParams.get("currency");
      if (!currency) return sendJson(res, 400, { error: "missing_currency" });
      return sendResult(res, 200, { currency, cashBuyingPower: "10000" }); // 문자열!
    }

    if (path === "/api/v1/sellable-quantity" && method === "GET") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      return sendResult(res, 200, { sellableQuantity: "1000" });
    }

    if (path === "/api/v1/commissions" && method === "GET") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      return sendResult(res, 200, []); // 구간별 수수료 배열(비워둠)
    }

    // ---------- 3.5) 환율 (실스펙: baseCurrency/quoteCurrency 필수) ----------
    if (path === "/api/v1/exchange-rate" && method === "GET") {
      const base = url.searchParams.get("baseCurrency");
      const quote = url.searchParams.get("quoteCurrency");
      if (!base || !quote) return sendJson(res, 400, { error: "missing_currency_params" });
      const now = new Date();
      return sendResult(res, 200, {
        baseCurrency: base,
        quoteCurrency: quote,
        rate: String(state.fxRate), // 매수환율(스프레드 포함) — 실스펙 관례에 맞춰 문자열
        midRate: String(state.fxRate), // 매매기준율(어댑터가 우선 사용). 목에선 동일값
        basisPoint: "0",
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 60_000).toISOString(), // 1분 유효
      });
    }

    // ---------- 3.6) 조건주문 (실스펙: SINGLE/OCO/OTO) ----------
    if (path === "/api/v1/conditional-orders" && method === "POST") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      // [v0.57.0] 오너 실사례(BGIN/SMJF) 재현용 강제 실패 — 한 번 쓰면 원상복귀.
      if (state.conditionalOrderRejectOnce) {
        const { httpStatus, code, message } = state.conditionalOrderRejectOnce;
        state.conditionalOrderRejectOnce = null;
        return sendJson(res, httpStatus, { error: { requestId: "mock-req-id", code, message } });
      }
      const body = await readJsonBody(req);
      const type = String(body.type ?? "SINGLE") as MockConditional["type"];
      const first = body.first as MockConditional["first"] | undefined;
      const second = body.second as MockConditional["second"] | undefined;

      // 실스펙 검증 흉내: 필수 필드
      if (!body.symbol || !first || !body.expireDate || !body.quantity) {
        return sendJson(res, 400, { error: { code: "invalid-request", message: "필수 필드 누락" } });
      }
      // OCO 규칙: 둘 다 SELL + 익절 감시가 > 현재가 > 손절 감시가
      if (type === "OCO") {
        const cur = priceOf(state.prices, String(body.symbol));
        if (!second) return sendJson(res, 400, { error: { code: "invalid-request", message: "OCO는 second 필수" } });
        if (first.orderSide !== "SELL" || second.orderSide !== "SELL")
          return sendJson(res, 400, { error: { code: "invalid-request", message: "OCO는 두 다리 모두 SELL" } });
        // [v0.57.0 실스펙 정합] 실제 토스 에러 메시지 그대로("현재가가 두 감시가 사이에 있어야
        //   합니다") — registerOcoForFilled가 이 문구를 실제로 감지해 재시도/보호매도로 넘어가는지
        //   테스트가 검증하므로, 목도 실제 문구와 같아야 그 검증이 의미가 있다.
        if (!(Number(first.triggerPrice) > cur && cur > Number(second.triggerPrice)))
          return sendJson(res, 400, { error: { code: "invalid-request", message: "OCO 조건주문은 현재가가 두 감시가 사이에 있어야 합니다." } });
      }

      state.seq += 1;
      const cond: MockConditional = {
        conditionalOrderId: `C${state.seq}`,
        symbol: String(body.symbol),
        type,
        quantity: Number(body.quantity),
        orderType: (body.orderType ?? "LIMIT") as "LIMIT" | "MARKET",
        expireDate: String(body.expireDate),
        status: "WATCHING", // [v0.51.0] 실스펙: 생성 직후엔 그룹도 "감시 중"
        first: {
          ...first,
          triggerPrice: Number(first.triggerPrice),
          orderPrice: first.orderPrice != null ? Number(first.orderPrice) : undefined,
          status: "WATCHING",
          triggeredOrderId: null,
        },
        second: second
          ? {
              ...second,
              triggerPrice: Number(second.triggerPrice),
              orderPrice: second.orderPrice != null ? Number(second.orderPrice) : undefined,
              status: "WATCHING",
              triggeredOrderId: null,
            }
          : null,
      };
      state.conditionals.set(cond.conditionalOrderId, cond);
      return sendResult(res, 201, { ...cond, quantity: String(cond.quantity) });
    }

    if (path === "/api/v1/conditional-orders" && method === "GET") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      // [실스펙 정합] status 쿼리 필수(없으면 실서버가 400). 목서버도 동일하게 강제해야
      //   "status 누락" 같은 실서버 전용 버그를 테스트가 잡아낸다(과거엔 관대해서 놓쳤음).
      if (!url.searchParams.get("status")) {
        return sendJson(res, 400, { error: { code: "invalid-request", message: "status 필수", data: { field: "status" } } });
      }
      // [v0.26.0] 대기 주문 재판정과 같은 원칙: 목록을 조회하는 시점에 OCO 발동 조건을 다시 확인.
      for (const c of state.conditionals.values()) reevaluateOco(c, state);
      // 실서버 형태({ conditionalOrders, nextCursor, hasNext })로 응답.
      return sendResult(res, 200, {
        conditionalOrders: [...state.conditionals.values()].map((c) => ({ ...c, quantity: String(c.quantity) })),
        nextCursor: null,
        hasNext: false,
      });
    }

    const cm = path.match(/^\/api\/v1\/conditional-orders\/([^/]+)$/);
    if (cm) {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      const cond = state.conditionals.get(decodeURIComponent(cm[1]));
      // [v0.60.1] 실서버와 동일한 오류 모양으로 — 오너 실사용 사고(SLND·VNDA·SDEV가
      //   "HTTP 404 conditional-order-not-found"로 계속 남던 문제)를 목서버로 그대로
      //   재현해 회귀 테스트를 붙일 수 있게 한다(예전엔 { error: "not_found" }라는
      //   단순한 모양이라 실서버 응답을 흉내 못 냈다).
      if (!cond) {
        return sendJson(res, 404, {
          error: { requestId: `mock-req-${++state.seq}`, code: "conditional-order-not-found", message: "존재하지 않는 설정입니다." },
        });
      }
      if (method === "GET") {
        reevaluateOco(cond, state); // [v0.26.0] 단건 조회 시점에도 재판정
        return sendResult(res, 200, { ...cond, quantity: String(cond.quantity) });
      }
      if (method === "DELETE") {
        // [v0.51.0] 실스펙엔 "CANCELED"가 없다 — 사람이 직접 취소해도 그룹 상태는 COMPLETED가 되고,
        //   어느 다리도 triggeredOrderId가 없으므로 tool-engine.ts가 "수동 취소"로 인식한다.
        cond.status = "COMPLETED";
        cond.first.status = "COMPLETED";
        if (cond.second) cond.second.status = "COMPLETED";
        return sendResult(res, 200, { conditionalOrderId: cond.conditionalOrderId, status: cond.status });
      }
    }

    // ---------- 4) 주문 ----------

    // 주문 생성
    if (path === "/api/v1/orders" && method === "POST") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      const body = await readJsonBody(req);
      const symbol = String(body.symbol ?? "");
      const side = (body.side ?? "BUY") as "BUY" | "SELL";
      const orderType = (body.orderType ?? "LIMIT") as "LIMIT" | "MARKET";
      // 실스펙: 가격·수량은 문자열로 온다 → 숫자로 변환(문자열/숫자 둘 다 수용).
      const price = body.price != null ? Number(body.price) : undefined;
      const clientOrderId = String(body.clientOrderId ?? "");
      const quantity = Number(body.quantity ?? 10);

      // (a) 멱등키: 같은 clientOrderId면 기존 주문 반환(이중 주문 방지)
      const existing = state.orders.get(clientOrderId);
      if (existing) {
        return sendResult(res, 200, { orderId: existing.orderId, clientOrderId });
      }

      // (b) 거부 시나리오
      if (symbol === "REJECT") {
        return sendJson(res, 402, { error: "insufficient_funds", message: "매수 가능 금액 부족" });
      }
      // (c) 가격 검증
      if (orderType === "LIMIT" && (price === undefined || price <= 0)) {
        return sendJson(res, 400, { error: "invalid_price" });
      }

      // (d) 체결 판정(생성 시점)
      state.seq += 1;
      const order: MockOrder = {
        orderId: `T${state.seq}`,
        clientOrderId,
        symbol,
        side,
        orderType,
        price,
        quantity,
        status: "PENDING",
        filledQuantity: 0,
        remaining: quantity,
        pollCount: 0,
      };

      if (symbol === "PARTIAL") {
        const half = Math.floor(quantity / 2);
        order.status = "PARTIAL_FILLED";
        order.filledQuantity = half;
        order.remaining = quantity - half;
      } else if (orderType === "MARKET") {
        order.status = "FILLED";
        order.filledQuantity = quantity;
        order.remaining = 0;
      } else if (limitFill(side, priceOf(state.prices, symbol), price as number)) {
        order.status = "FILLED";
        order.filledQuantity = quantity;
        order.remaining = 0;
      }

      state.orders.set(clientOrderId, order);
      // 실제 스펙: 생성 응답은 { orderId, clientOrderId } 뿐(상태는 단건 조회로 확인)
      return sendResult(res, 201, { orderId: order.orderId, clientOrderId });
    }

    // 주문 목록 (실제 스펙: status 쿼리 필수, { orders, nextCursor, hasNext })
    if (path === "/api/v1/orders" && method === "GET") {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      const status = url.searchParams.get("status");
      if (!status) return sendJson(res, 400, { error: "missing_status" });
      let list = [...state.orders.values()];
      // [v0.60.3 수정] CLOSED를 literal "CLOSED" 문자열과 대조하고 있었다 — 이 목서버의
      //   실제 주문 status 값은 PENDING/PARTIAL_FILLED/FILLED/CANCELED뿐이라 "CLOSED"와
      //   글자 그대로 일치하는 주문은 존재할 수 없다(항상 빈 목록). 실스펙의 OPEN/CLOSED는
      //   "미체결이냐 종료됐냐"를 뜻하므로, OPEN(대기중)이 아닌 전부를 CLOSED로 본다.
      if (status === "OPEN") list = list.filter((o) => o.status === "PENDING" || o.status === "PARTIAL_FILLED");
      else if (status === "CLOSED") list = list.filter((o) => o.status !== "PENDING" && o.status !== "PARTIAL_FILLED");
      else if (status !== "ALL") list = list.filter((o) => o.status === status);
      const symbol = url.searchParams.get("symbol");
      if (symbol) list = list.filter((o) => o.symbol === symbol);
      return sendResult(res, 200, { orders: list.map(toDetail), nextCursor: null, hasNext: false });
    }

    // /api/v1/orders/{orderId}(/modify|/cancel)
    const m = path.match(/^\/api\/v1\/orders\/([^/]+)(?:\/(modify|cancel))?$/);
    if (m) {
      if (!req.headers["x-tossinvest-account"]) return sendJson(res, 400, { error: "missing_account" });
      const orderId = decodeURIComponent(m[1]);
      const action = m[2];
      const order = [...state.orders.values()].find((o) => o.orderId === orderId);
      if (!order) return sendJson(res, 404, { error: "not_found" });

      // 단건 조회: GET /orders/{id}
      if (!action && method === "GET") {
        order.pollCount += 1;
        // [부분체결 누적 시연] 첫 조회는 절반 그대로, 두 번째 조회부터 나머지 체결.
        if (order.status === "PARTIAL_FILLED" && order.remaining > 0 && order.pollCount >= 2) {
          order.filledQuantity += order.remaining;
          order.remaining = 0;
          order.status = "FILLED";
        }
        // [대기 주문 재판정] 가격이 움직인 뒤 조회하면 체결 조건을 다시 확인(실제 시장처럼).
        if (order.status === "PENDING" && order.orderType === "LIMIT" && order.price !== undefined) {
          if (limitFill(order.side, priceOf(state.prices, order.symbol), order.price)) {
            order.status = "FILLED";
            order.filledQuantity = order.quantity;
            order.remaining = 0;
          }
        }
        return sendResult(res, 200, toDetail(order));
      }

      // 정정: POST /orders/{id}/modify (실제 스펙)
      if (action === "modify" && method === "POST") {
        const body = await readJsonBody(req);
        if (body.price !== undefined) order.price = Number(body.price);
        if (body.quantity !== undefined) order.quantity = Number(body.quantity);
        return sendResult(res, 200, toDetail(order));
      }

      // 취소: POST /orders/{id}/cancel (실제 스펙)
      if (action === "cancel" && method === "POST") {
        // [v0.52.0] 취소 응답 상태 강제 스위치가 설정돼 있으면 그 값을(한 번만) 쓴다 —
        //   "취소 API 호출은 성공했지만 실제로는 아직 CANCELED가 아닌" 경쟁 상태 재현용.
        if (state.cancelReturnsStatus) {
          order.status = state.cancelReturnsStatus;
          state.cancelReturnsStatus = null;
        } else {
          order.status = "CANCELED";
        }
        return sendResult(res, 200, toDetail(order));
      }
    }

    return sendJson(res, 404, { error: "not_found", path });
  });

  return {
    server,
    state,
    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /** (테스트용) 심볼 현재가 변경 — 익절/손절/체결 시나리오 재현 */
    setPrice(symbol: string, price: number): void {
      state.prices[symbol] = price;
    },
    /** (테스트용) 환율 변경 */
    setFxRate(rate: number): void {
      state.fxRate = rate;
    },
  };
}
