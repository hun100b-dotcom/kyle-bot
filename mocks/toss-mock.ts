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

/** 목 서버의 조건주문 한 건(실스펙 흉내: 감시 조건 1~2개) */
interface MockConditional {
  conditionalOrderId: string;
  symbol: string;
  type: "SINGLE" | "OCO" | "OTO";
  quantity: number;
  orderType: "LIMIT" | "MARKET";
  expireDate: string;
  status: "WAITING" | "TRIGGERED" | "CANCELED";
  first: { orderSide: "BUY" | "SELL"; triggerPrice: number; orderPrice?: number };
  second?: { orderSide: "BUY" | "SELL"; triggerPrice: number; orderPrice?: number } | null;
}

/** 목 서버 내부 상태(테스트에서 조작/검증 가능하게 노출) */
export interface MockState {
  tokenIssueCount: number;
  orders: Map<string, MockOrder>; // clientOrderId → 주문(멱등키 저장소)
  seq: number;
  prices: Record<string, number>;
  conditionals: Map<string, MockConditional>; // 조건주문 저장소
  fxRate: number; // USD→KRW 환율(연습용 고정값, setFxRate로 조작 가능)
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

export function createMockTossServer() {
  const state: MockState = {
    tokenIssueCount: 0,
    orders: new Map(),
    seq: 0,
    prices: { ...INITIAL_PRICES },
    conditionals: new Map(),
    fxRate: 1390.5, // 연습용 기본 환율: 1 USD = 1,390.5 KRW
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
      const body = await readJsonBody(req);
      const type = String(body.type ?? "SINGLE") as MockConditional["type"];
      const first = body.first as MockConditional["first"] | undefined;
      const second = body.second as MockConditional["second"] | undefined;

      // 실스펙 검증 흉내: 필수 필드
      if (!body.symbol || !first || !body.expireDate || !body.quantity) {
        return sendJson(res, 400, { error: "invalid_request", message: "필수 필드 누락" });
      }
      // OCO 규칙: 둘 다 SELL + 익절 감시가 > 현재가 > 손절 감시가
      if (type === "OCO") {
        const cur = priceOf(state.prices, String(body.symbol));
        if (!second) return sendJson(res, 400, { error: "invalid_request", message: "OCO는 second 필수" });
        if (first.orderSide !== "SELL" || second.orderSide !== "SELL")
          return sendJson(res, 400, { error: "invalid_request", message: "OCO는 두 다리 모두 SELL" });
        if (!(Number(first.triggerPrice) > cur && cur > Number(second.triggerPrice)))
          return sendJson(res, 400, { error: "invalid_request", message: "OCO는 first감시가>현재가>second감시가" });
      }

      state.seq += 1;
      const cond: MockConditional = {
        conditionalOrderId: `C${state.seq}`,
        symbol: String(body.symbol),
        type,
        quantity: Number(body.quantity),
        orderType: (body.orderType ?? "LIMIT") as "LIMIT" | "MARKET",
        expireDate: String(body.expireDate),
        status: "WAITING",
        first: { ...first, triggerPrice: Number(first.triggerPrice), orderPrice: first.orderPrice != null ? Number(first.orderPrice) : undefined },
        second: second ? { ...second, triggerPrice: Number(second.triggerPrice), orderPrice: second.orderPrice != null ? Number(second.orderPrice) : undefined } : null,
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
      if (!cond) return sendJson(res, 404, { error: "not_found" });
      if (method === "GET") return sendResult(res, 200, { ...cond, quantity: String(cond.quantity) });
      if (method === "DELETE") {
        cond.status = "CANCELED";
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
      if (status === "OPEN") list = list.filter((o) => o.status === "PENDING" || o.status === "PARTIAL_FILLED");
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
        order.status = "CANCELED";
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
