// =============================================================================
// mocks/toss-mock.ts  —  가짜 토스 서버 (설계서 S4)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   실제 토스 증권 서버가 없어도(키·계좌 미정) 우리 어댑터(lib/toss.ts)가
//   "진짜처럼" 도는지 확인하려고, 토스를 흉내 내는 가짜 서버를 내 PC에 띄웁니다.
//   진짜 HTTP 서버(node http)라서, 어댑터의 fetch·헤더·JSON 파싱까지 실제로 왕복합니다.
//
// [왜 진짜 HTTP 서버로?]
//   fetch를 가짜 함수로 바꿔치기하는 방법도 있지만, 그러면 "네트워크 부분"은 검증이
//   안 됩니다. 실제 서버를 띄워 진짜 요청을 주고받아야, 키만 꽂으면 그대로 실전에
//   쓸 수 있다는 확신이 생깁니다. (그래서 포트를 실제로 여는 방식을 택했습니다.)
//
// [메모리에만 저장]
//   주문/토큰 상태는 서버 프로세스의 메모리(Map)에만 담습니다. 서버를 끄면 사라집니다.
//   테스트용이라 DB가 필요 없습니다.
//
// [시나리오]
//   심볼 이름으로 상황을 고릅니다(테스트에서 제어하기 쉬우라고):
//     - 'AAPL'    : 현재가 2.05. 삼분할 지정가 체결 판정용(지정가>=현재가면 체결)
//     - 'PARTIAL' : 부분 체결. 처음엔 절반만, 다시 조회하면 나머지 채워짐(누적 시연)
//     - 'REJECT'  : 잔고 부족으로 주문 거부(402)
//     - 'SLOW'    : 응답을 일부러 늦춤(어댑터 타임아웃 시험용)
//     - 그 외     : 현재가 100 기본
// =============================================================================

import http from "node:http";
import type { AddressInfo } from "node:net";

/** 목 서버가 다루는 주문 한 건(메모리 저장용) */
interface MockOrder {
  tossOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  price?: number;
  quantity: number;
  status: "submitted" | "filled" | "partial" | "cancelled";
  filled_qty: number;
  remaining: number; // 부분체결에서 아직 안 채워진 수량
}

/** 목 서버의 내부 상태(테스트에서 들여다볼 수 있게 밖으로 노출) */
export interface MockState {
  tokenIssueCount: number; // 토큰을 몇 번 새로 발급했는지(캐싱/재발급 검증용)
  orders: Map<string, MockOrder>; // clientOrderId → 주문 (멱등키 저장소)
  seq: number; // tossOrderId 일련번호
  prices: Record<string, number>; // 심볼별 현재가(테스트에서 setPrice로 바꿀 수 있음)
}

/** 심볼별 현재가 초기값(시나리오 기준값) */
const INITIAL_PRICES: Record<string, number> = {
  AAPL: 2.05,
  PARTIAL: 2.05,
  REJECT: 2.05,
  SLOW: 2.05,
};

function priceOf(prices: Record<string, number>, symbol: string): number {
  return prices[symbol] ?? 100; // 등록 안 된 심볼은 기본 100
}

/** JSON 응답 보내기 */
function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** 요청 본문(JSON)을 읽어오는 헬퍼 */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolve({}); // 폼 데이터(토큰 요청 등)는 JSON이 아니므로 빈 객체 처리
      }
    });
  });
}

/** 잠깐 기다리기(타임아웃 시나리오용) */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * createMockTossServer — 가짜 토스 서버를 만든다.
 *   반환된 객체의 listen()으로 실제 포트를 열고, close()로 닫습니다.
 */
export function createMockTossServer() {
  const state: MockState = {
    tokenIssueCount: 0,
    orders: new Map(),
    seq: 0,
    prices: { ...INITIAL_PRICES }, // 복사본(테스트마다 원본을 오염시키지 않도록)
  };

  const server = http.createServer(async (req, res) => {
    // 요청 URL에서 경로와 쿼리 분리 (예: /api/v1/prices?symbol=AAPL)
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // -------------------------------------------------------------------------
    // 1) 토큰 발급: POST /oauth2/token
    // -------------------------------------------------------------------------
    if (path === "/oauth2/token" && method === "POST") {
      state.tokenIssueCount += 1;
      // 유효시간 1시간짜리 가짜 토큰. 발급할 때마다 번호를 붙여 구분(재발급 확인용).
      return sendJson(res, 200, {
        access_token: `mock-token-${state.tokenIssueCount}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    // 여기부터는 Authorization 헤더(출입증)가 있어야 함(실제 토스처럼).
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) {
      return sendJson(res, 401, { error: "unauthorized", message: "Authorization 헤더 필요" });
    }

    // -------------------------------------------------------------------------
    // 2) 시세: 현재가 / 호가 / 캔들
    // -------------------------------------------------------------------------
    if (path === "/api/v1/prices" && method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "AAPL";
      // SLOW 심볼이면 응답을 늦춰 어댑터 타임아웃을 유발.
      if (symbol === "SLOW") await delay(500);
      return sendJson(res, 200, {
        symbol,
        price: priceOf(state.prices, symbol),
        timestamp: new Date().toISOString(),
      });
    }

    if (path === "/api/v1/orderbook" && method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "AAPL";
      const cur = priceOf(state.prices, symbol);
      // 가짜 호가: 현재가 근처에 매수벽(bids)/매도벽(asks)을 몇 개 만들어 둠.
      return sendJson(res, 200, {
        symbol,
        bids: [
          { price: cur - 0.01, quantity: 5000 }, // 두꺼운 매수벽(호가창 기법 테스트용)
          { price: cur - 0.02, quantity: 1200 },
        ],
        asks: [
          { price: cur + 0.01, quantity: 800 },
          { price: cur + 0.02, quantity: 1500 },
        ],
        timestamp: new Date().toISOString(),
      });
    }

    if (path === "/api/v1/candles" && method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "AAPL";
      const interval = (url.searchParams.get("interval") ?? "1m") as "1m" | "1d";
      const cur = priceOf(state.prices, symbol);
      // 가짜 캔들 3개(양봉 하나 포함 — 캔들 기법 판정 재료).
      return sendJson(res, 200, {
        symbol,
        interval,
        candles: [
          { time: "T-2", open: cur - 0.05, high: cur, low: cur - 0.06, close: cur - 0.02, volume: 10000 },
          { time: "T-1", open: cur - 0.02, high: cur + 0.03, low: cur - 0.03, close: cur + 0.02, volume: 12000 }, // 양봉
          { time: "T-0", open: cur, high: cur + 0.01, low: cur - 0.01, close: cur, volume: 8000 },
        ],
      });
    }

    // -------------------------------------------------------------------------
    // 3) 계좌: 매수가능금액 / 매도가능수량 / 수수료 / 잔고
    // -------------------------------------------------------------------------
    if (path === "/api/v1/buying-power" && method === "GET") {
      const account = req.headers["x-tossinvest-account"];
      // 계좌 헤더도 확인(실제 토스처럼). 없으면 400.
      if (!account) return sendJson(res, 400, { error: "missing_account" });
      return sendJson(res, 200, { account, buyingPowerUsd: 10000 });
    }

    if (path === "/api/v1/sellable" && method === "GET") {
      const account = req.headers["x-tossinvest-account"];
      const symbol = url.searchParams.get("symbol") ?? "AAPL";
      return sendJson(res, 200, { account, symbol, sellableQty: 1000 });
    }

    if (path === "/api/v1/commission" && method === "GET") {
      return sendJson(res, 200, { rate: 0.0025 }); // 0.25%
    }

    if (path === "/api/v1/balance" && method === "GET") {
      const account = req.headers["x-tossinvest-account"];
      return sendJson(res, 200, {
        account,
        cashUsd: 10000,
        positions: [{ symbol: "AAPL", quantity: 100, avgPrice: 2.0 }],
      });
    }

    // -------------------------------------------------------------------------
    // 4) 주문: 생성 / 목록 / 단건조회 / 정정 / 취소
    // -------------------------------------------------------------------------

    // 주문 생성: POST /api/v1/orders
    if (path === "/api/v1/orders" && method === "POST") {
      const body = await readJsonBody(req);
      const symbol = String(body.symbol ?? "");
      const side = (body.side ?? "BUY") as "BUY" | "SELL";
      const orderType = (body.orderType ?? "LIMIT") as "LIMIT" | "MARKET";
      const price = body.price as number | undefined;
      const clientOrderId = String(body.clientOrderId ?? "");
      const quantity = Number(body.quantity ?? 10); // 수량 없으면 기본 10주로 가정

      // (a) 멱등키 검사: 같은 clientOrderId가 이미 있으면 새로 만들지 않고 기존 주문을 반환.
      //     → 재시도로 두 번 들어와도 주문은 한 번만 생김(이중주문 방지).
      const existing = state.orders.get(clientOrderId);
      if (existing) {
        return sendJson(res, 200, toOrderResponse(existing, true));
      }

      // (b) 거부 시나리오: REJECT 심볼은 잔고 부족으로 거부.
      if (symbol === "REJECT") {
        return sendJson(res, 402, { error: "insufficient_funds", message: "매수 가능 금액 부족" });
      }

      // (c) 가격 검증: 지정가인데 가격이 없거나 0 이하면 거부(토스도 이런 값은 400).
      if (orderType === "LIMIT" && (price === undefined || price <= 0)) {
        return sendJson(res, 400, { error: "invalid_price", message: "지정가 주문에 유효한 가격 필요" });
      }

      // (d) 체결 판정
      state.seq += 1;
      const order: MockOrder = {
        tossOrderId: `T${state.seq}`,
        clientOrderId,
        symbol,
        side,
        orderType,
        price,
        quantity,
        status: "submitted",
        filled_qty: 0,
        remaining: quantity,
      };

      if (symbol === "PARTIAL") {
        // 부분 체결: 우선 절반만 채우고 나머지는 남겨둠(단건 조회 시 마저 채워짐).
        const half = Math.floor(quantity / 2);
        order.status = "partial";
        order.filled_qty = half;
        order.remaining = quantity - half;
      } else if (orderType === "MARKET") {
        // 시장가는 즉시 전량 체결로 간주.
        order.status = "filled";
        order.filled_qty = quantity;
        order.remaining = 0;
      } else {
        // 지정가 체결 규칙(핵심):
        //   매수(BUY): 시장 현재가 <= 내가 부른 지정가 → 체결(그 가격 이하로 살 수 있으니)
        //   매도(SELL): 시장 현재가 >= 내가 부른 지정가 → 체결
        // [삼분할 시연] AAPL 현재가 2.05일 때, 1분할 2.11은 체결(2.05<=2.11),
        //   2분할 2.02·3분할 1.93은 미체결(시장이 거기까지 안 내려옴) → "하나만 체결"이 재현됨.
        const cur = priceOf(state.prices, symbol);
        const fill = side === "BUY" ? cur <= (price as number) : cur >= (price as number);
        if (fill) {
          order.status = "filled";
          order.filled_qty = quantity;
          order.remaining = 0;
        } else {
          order.status = "submitted"; // 대기(미체결)
        }
      }

      state.orders.set(clientOrderId, order);
      return sendJson(res, 201, toOrderResponse(order, false));
    }

    // 주문 목록: GET /api/v1/orders
    if (path === "/api/v1/orders" && method === "GET") {
      const filterStatus = url.searchParams.get("status");
      const filterSymbol = url.searchParams.get("symbol");
      let list = [...state.orders.values()];
      if (filterStatus) list = list.filter((o) => o.status === filterStatus);
      if (filterSymbol) list = list.filter((o) => o.symbol === filterSymbol);
      return sendJson(res, 200, { orders: list.map((o) => toOrderResponse(o, false)) });
    }

    // 아래는 /api/v1/orders/{tossOrderId} 형태 (단건 조회/정정/취소)
    const orderIdMatch = path.match(/^\/api\/v1\/orders\/([^/]+)$/);
    if (orderIdMatch) {
      const tossOrderId = decodeURIComponent(orderIdMatch[1]);
      const order = findByTossId(state, tossOrderId);
      if (!order) return sendJson(res, 404, { error: "not_found" });

      // 단건 조회: GET — 부분체결 주문이면 남은 수량을 마저 채워(누적) 준다.
      if (method === "GET") {
        if (order.status === "partial" && order.remaining > 0) {
          order.filled_qty += order.remaining; // 나머지 누적 체결
          order.remaining = 0;
          order.status = "filled";
        }
        // [대기 주문 재판정] 아직 안 채워진 지정가 주문(submitted)은, 조회 시점의
        //   현재가를 다시 보고 체결 조건이 맞으면 체결로 바꾼다.
        //   [왜?] 실제 시장에서도 "그때는 안 됐지만 가격이 움직여 나중에 체결"이 일어납니다.
        //   덕분에 테스트에서 setPrice로 가격을 바꾼 뒤 조회하면 익절/진입 체결을 재현할 수 있습니다.
        if (order.status === "submitted" && order.orderType === "LIMIT" && order.price !== undefined) {
          const cur = priceOf(state.prices, order.symbol);
          const fill = order.side === "BUY" ? cur <= order.price : cur >= order.price;
          if (fill) {
            order.status = "filled";
            order.filled_qty = order.quantity;
            order.remaining = 0;
          }
        }
        return sendJson(res, 200, toOrderResponse(order, false));
      }

      // 정정: PUT — 가격/수량 변경.
      if (method === "PUT") {
        const body = await readJsonBody(req);
        if (body.price !== undefined) order.price = body.price as number;
        if (body.quantity !== undefined) order.quantity = Number(body.quantity);
        return sendJson(res, 200, toOrderResponse(order, false));
      }

      // 취소: DELETE — 상태를 cancelled로.
      if (method === "DELETE") {
        order.status = "cancelled";
        return sendJson(res, 200, toOrderResponse(order, false));
      }
    }

    // 매칭되는 경로 없음
    return sendJson(res, 404, { error: "not_found", path });
  });

  return {
    server,
    state,
    /** 실제 포트를 열고, 열린 포트 번호를 돌려준다. */
    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          resolve(addr.port);
        });
      });
    },
    /** 서버를 닫는다. */
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /** (테스트용) 심볼의 현재가를 바꾼다. 익절/손절 체결 시나리오를 만들 때 사용. */
    setPrice(symbol: string, price: number): void {
      state.prices[symbol] = price;
    },
  };
}

/** 내부 주문(MockOrder)을 API 응답 형태(OrderResponse 유사)로 변환 */
function toOrderResponse(o: MockOrder, idempotentHit: boolean) {
  return {
    tossOrderId: o.tossOrderId,
    clientOrderId: o.clientOrderId,
    status: o.status,
    symbol: o.symbol,
    side: o.side,
    price: o.price,
    quantity: o.quantity,
    filled_qty: o.filled_qty,
    idempotentHit, // 멱등키 재요청이었는지 표시(테스트에서 확인용)
  };
}

/** tossOrderId로 주문 찾기 */
function findByTossId(state: MockState, tossOrderId: string): MockOrder | undefined {
  for (const o of state.orders.values()) {
    if (o.tossOrderId === tossOrderId) return o;
  }
  return undefined;
}
