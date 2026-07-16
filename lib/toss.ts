// =============================================================================
// lib/toss.ts  —  토스 Open API 어댑터 (설계서 3장 M2)
// -----------------------------------------------------------------------------
// [이 파일이 하는 일]
//   "카일봇 ↔ 토스 증권 서버" 사이의 통역사입니다. 시세 조회, 잔고 확인, 주문 넣기
//   같은 요청을 토스가 알아듣는 형식(HTTP 요청)으로 바꿔 보내고, 답을 받아옵니다.
//
// [지금 단계(S3)에서 지킬 것]
//   - 실제 네트워크 호출 코드는 넣되, 키(client secret)와 계좌가 아직 없으므로
//     호출하는 순간 "환경변수 없음" 에러로 안전하게 즉시 실패합니다.
//   - 그래서 이 파일에서 "키 없이도 검증 가능한 부분"은 순수 계산 로직뿐입니다
//     (멱등키 생성, 토큰 만료 판정, 매수 가능 수량 계산 등). 이건 vitest로 테스트합니다.
//   - 실제 API가 진짜로 오가는 리허설은 S4(목 서버)에서 합니다.
//
// [보안 절대규칙]
//   client secret 등 비밀값은 서버 환경변수(process.env)에서만 읽습니다.
//   코드에 하드코딩 금지, git 커밋 금지, 프론트엔드 노출 금지.
//
// [주의] 아래 엔드포인트 경로/요청·응답 필드는 설계서 M2 기준의 "예상"입니다.
//   토스 실제 스펙과 다를 수 있으므로, 확정되면 이 파일의 상수/타입을 조정합니다.
//   (각 부분에 TODO(스펙확정) 주석을 달아 두었습니다.)
// =============================================================================

import { roundPrice } from "./calc";

// -----------------------------------------------------------------------------
// 0) 엔드포인트 경로 상수 (TODO(스펙확정): 실제 경로로 맞추기)
// -----------------------------------------------------------------------------
// [왜 상수로 모으나?] 경로가 바뀌면 여기 한 곳만 고치면 되도록 모아둡니다.
const ENDPOINTS = {
  token: "/oauth2/token", // 토큰 발급(OAuth2 client_credentials)
  prices: "/api/v1/prices", // 현재가
  orderbook: "/api/v1/orderbook", // 호가(매수/매도벽)
  candles: "/api/v1/candles", // 1분봉/일봉
  balance: "/api/v1/balance", // 잔고
  buyingPower: "/api/v1/buying-power", // 매수 가능 금액
  sellable: "/api/v1/sellable", // 매도 가능 수량
  commission: "/api/v1/commission", // 수수료
  orders: "/api/v1/orders", // 주문 생성/목록
  // 정정/취소는 orders/{tossOrderId} 형태로 조합해서 사용
} as const;

// 시세 조회 Rate limit: 초당 10회 → 최소 호출 간격 100ms.
const PRICE_MIN_INTERVAL_MS = 100;

// 토큰 안전 마진: 만료 10분 전에 미리 재발급.
// [왜?] 토큰 유효시간이 약 1시간(3600초)이라, 만료 10분 전(=발급 후 약 50분)에
//   선제적으로 새로 받아두면, 밤새 돌아가는 봇이 "토큰 만료" 때문에 멈추지 않습니다.
const TOKEN_SAFETY_MARGIN_MS = 10 * 60 * 1000;

// =============================================================================
// 1) 타입 정의 (TODO(스펙확정): 실제 토스 응답 필드에 맞춰 조정)
// =============================================================================

/** 토큰 발급 응답 */
export interface TokenResponse {
  access_token: string;
  token_type: string; // 보통 "Bearer"
  expires_in: number; // 유효시간(초). 약 3600.
}

/** 현재가 응답 */
export interface PriceResponse {
  symbol: string;
  price: number; // 현재가(달러)
  timestamp: string;
}

/** 호가 한 줄(가격+대기물량) */
export interface OrderbookLevel {
  price: number;
  quantity: number;
}

/** 호가 응답: 매수벽(bids)/매도벽(asks) */
export interface OrderbookResponse {
  symbol: string;
  bids: OrderbookLevel[]; // 매수 대기(벽). 두꺼울수록 지지력.
  asks: OrderbookLevel[]; // 매도 대기
  timestamp: string;
}

/** 캔들(봉) 한 개 */
export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 캔들 응답 */
export interface CandlesResponse {
  symbol: string;
  interval: "1m" | "1d"; // 1분봉 | 일봉
  candles: Candle[];
}

/** 잔고 응답 */
export interface BalanceResponse {
  account: string;
  cashUsd: number; // 예수금(달러)
  positions: Array<{ symbol: string; quantity: number; avgPrice: number }>;
}

/** 매수 가능 금액 응답 */
export interface BuyingPowerResponse {
  account: string;
  buyingPowerUsd: number; // 이 계좌로 지금 살 수 있는 달러 금액
}

/** 매도 가능 수량 응답 */
export interface SellableResponse {
  account: string;
  symbol: string;
  sellableQty: number; // 지금 팔 수 있는 수량
}

/** 수수료 응답 */
export interface CommissionResponse {
  rate: number; // 수수료율(예: 0.0025 = 0.25%)
}

/** 주문 방향/유형/역할 (DB orders 테이블과 맞춤) */
export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

/** 주문 생성 요청 */
export interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  price?: number; // 지정가(LIMIT)일 때 필수. 시장가면 생략.
  quantity?: number; // 수량 지정 주문일 때
  amountUsd?: number; // 달러 금액 지정 주문일 때(달러 주문 고정 원칙)
  clientOrderId: string; // 멱등키(중복 주문 방지)
}

/** 주문 응답 */
export interface OrderResponse {
  tossOrderId: string; // 토스가 부여한 주문번호
  clientOrderId: string;
  status: string; // 토스 상태값(스펙확정 시 DB status로 매핑)
  symbol: string;
  side: OrderSide;
  price?: number;
  quantity?: number;
}

/** 주문 목록 응답 */
export interface OrderListResponse {
  orders: OrderResponse[];
}

// =============================================================================
// 2) 순수 로직 (키 없이도 검증 가능 — vitest 대상)
// =============================================================================

/**
 * isTokenExpired — 캐시된 토큰을 "지금 다시 발급해야 하는가?" 판정.
 *
 *   expiresAtMs : 토큰이 실제로 만료되는 시각(밀리초 타임스탬프)
 *   nowMs       : 현재 시각
 *   marginMs    : 안전 마진(만료 이 시간 전이면 미리 갱신)
 *
 * [왜 마진을 두나?] 딱 만료 순간에 갱신하려 하면, 요청이 오가는 찰나에 만료돼
 *   실패할 수 있습니다. 여유(10분)를 두고 미리 바꿔 끼웁니다.
 */
export function isTokenExpired(expiresAtMs: number, nowMs: number, marginMs: number): boolean {
  return nowMs >= expiresAtMs - marginMs;
}

/**
 * sanitizeIdPart — 멱등키 조각을 "영숫자와 -_ 만" 남도록 정리(내부용).
 *   토스가 허용하는 문자만 남겨, 규칙 위반으로 주문이 거부되는 걸 막습니다.
 */
function sanitizeIdPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * makeClientOrderId — 멱등키(중복 주문 방지용 고유 ID)를 만든다.
 *
 *   규칙: `{session_id 앞 8자}-{level}-{role}`
 *   - 예) 세션 "a1b2c3d4-...." , level 1, role "entry" → "a1b2c3d4-1-entry"
 *   - 허용 문자: 영숫자 + - + _ 만
 *   - 길이: 36자 이내
 *
 * [멱등키가 왜 필요한가?]
 *   네트워크가 끊겨 "주문이 갔는지" 모를 때 봇은 같은 주문을 재시도합니다.
 *   이때 같은 clientOrderId 를 쓰면, 토스가 "이미 받은 주문"으로 알고 중복 체결을
 *   막아줍니다. 즉 몇 번을 다시 보내도 실제 주문은 한 번만 나갑니다(멱등성).
 *
 * [왜 session+level+role 조합인가?]
 *   같은 세션의 같은 분할(level)의 같은 역할(entry/tp/sl)은 "세상에 하나뿐"이어야
 *   합니다. 이 세 가지를 합치면 자연스럽게 유일한 키가 됩니다.
 *
 * @param sessionId 세션 UUID
 * @param level 삼분할 레벨(1|2|3). 분할이 없는 기법이면 0 을 넘겨도 됨.
 * @param role 'entry' | 'take_profit' | 'stop_loss'
 */
export function makeClientOrderId(sessionId: string, level: number, role: string): string {
  const head = sanitizeIdPart(sessionId).slice(0, 8); // 세션 앞 8자
  const lvl = sanitizeIdPart(String(level));
  const r = sanitizeIdPart(role);
  let id = `${head}-${lvl}-${r}`;

  // 36자 초과 시 잘라냄(규칙 위반 방지). 실제 조합은 대개 여유롭게 36자 미만입니다.
  if (id.length > 36) id = id.slice(0, 36);
  return id;
}

/**
 * calcMaxBuyQty — "매수 가능 금액"으로 최대 몇 주까지 살 수 있는지 계산(사전검증용).
 *
 *   1주당 실제 비용 = 가격 × (1 + 수수료율)   ← 수수료까지 포함해야 진짜 비용
 *   최대 수량 = floor(매수가능금액 / 1주당 비용)
 *
 * [왜 사전검증을 하나?]
 *   돈이 모자라거나 수량이 안 맞으면 토스가 주문을 거부(에러)합니다. 미리 계산해
 *   "살 수 있는 만큼만" 주문하면 불필요한 에러와 위험을 줄입니다.
 *
 * [floor(내림)인 이유] 살짝이라도 초과하면 거부되니, 안전하게 정수 주수로 내립니다.
 *   (TODO(스펙확정): 토스 달러(소수주) 주문을 지원하면 소수 수량 허용으로 조정)
 */
export function calcMaxBuyQty(buyingPowerUsd: number, price: number, commissionRate: number): number {
  if (price <= 0) return 0;
  const perShareCost = price * (1 + commissionRate);
  return Math.floor(buyingPowerUsd / perShareCost);
}

// =============================================================================
// 3) 설정/토큰/레이트리밋 (실행 인프라)
// =============================================================================

/** 환경변수에서 읽은 토스 접속 설정 */
interface TossConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  account: string;
}

/**
 * getConfig — 서버 환경변수에서 토스 설정을 읽는다. 없으면 "즉시" 명확한 에러.
 *
 * [왜 즉시 에러인가?]
 *   지금은 키가 없습니다. 값이 없는 채로 네트워크 호출을 시도하면 이상한 에러가
 *   나거나, 최악의 경우 잘못된 요청이 나갈 수 있습니다. 그래서 호출 초입에서
 *   "무엇이 비어 있는지" 콕 집어 알려주고 멈춥니다(안전장치).
 *
 * [보안] process.env 는 서버(Vercel 함수/Node)에서만 존재합니다. 브라우저에는
 *   이 값들이 전달되지 않습니다(VITE_ 접두사가 없기 때문). 토스 키는 서버 전용입니다.
 */
function getConfig(): TossConfig {
  const baseUrl = process.env.TOSS_BASE_URL;
  const clientId = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;
  const account = process.env.TOSS_ACCOUNT;

  const missing: string[] = [];
  if (!baseUrl) missing.push("TOSS_BASE_URL");
  if (!clientId) missing.push("TOSS_CLIENT_ID");
  if (!clientSecret) missing.push("TOSS_CLIENT_SECRET");
  if (!account) missing.push("TOSS_ACCOUNT");

  if (missing.length > 0) {
    throw new Error(
      `토스 환경변수가 없습니다: ${missing.join(", ")}. ` +
        `서버 환경변수(Vercel 등)에 설정하세요. (S3 단계에서는 키가 없어 정상적으로 실패합니다)`,
    );
  }

  // 위 if에서 걸러졌으므로 여기서는 모두 값이 있음(TS에게 확신을 주기 위해 as string).
  return {
    baseUrl: baseUrl as string,
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    account: account as string,
  };
}

// 토큰 캐시(모듈 메모리에 보관). 서버 프로세스가 살아있는 동안 재사용됩니다.
let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

/**
 * getAccessToken — 유효한 액세스 토큰을 돌려준다(캐시 + 자동 재발급).
 *
 *   1) 캐시에 아직 유효한(만료 10분 전 이내가 아닌) 토큰이 있으면 그대로 씀.
 *   2) 없거나 곧 만료면 /oauth2/token 으로 새로 발급받아 캐시에 저장.
 *
 * [왜 캐싱하나?] 매 요청마다 토큰을 새로 받으면 느리고 Rate limit도 낭비합니다.
 *   한 번 받아 약 50분간 재사용하는 게 효율적이고 안정적입니다.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && !isTokenExpired(tokenCache.expiresAtMs, now, TOKEN_SAFETY_MARGIN_MS)) {
    return tokenCache.accessToken;
  }

  const cfg = getConfig();

  // OAuth2 client_credentials 방식. (TODO(스펙확정): 토스가 form/json 중 무엇을
  //   요구하는지에 맞춰 body 형식 조정. 표준을 따라 form-urlencoded 로 작성.)
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const res = await fetch(`${cfg.baseUrl}${ENDPOINTS.token}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`토큰 발급 실패: HTTP ${res.status} ${await safeText(res)}`);
  }

  const data = (await res.json()) as TokenResponse;
  tokenCache = {
    accessToken: data.access_token,
    // 만료 시각 = 지금 + 유효시간(초)*1000. 이 시각 기준으로 재발급 타이밍을 잡습니다.
    expiresAtMs: now + data.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

/** (테스트/재로그인용) 토큰 캐시를 비운다. */
export function clearTokenCache(): void {
  tokenCache = null;
}

/**
 * RateLimiter — 호출 사이 최소 간격을 강제해 Rate limit(초당 횟수 제한)을 지킨다.
 *
 * [왜 필요한가?] 토스 시세 API는 초당 10회 제한이 있습니다. 그보다 빨리 부르면
 *   차단당합니다. 마지막 호출 시각을 기억했다가, 너무 빠르면 그 차이만큼 기다립니다.
 *
 * [TODO(S4/실운영)] 지금은 "직전 호출과의 간격"만 보장합니다. 실제로는 여러 종목을
 *   동시에 폴링하므로, 초당 10회 예산을 종목/우선순위별로 나누는 큐 설계가 필요합니다.
 *   (예: 보유·주문대기 종목 우선, 나머지는 라운드로빈)
 */
class RateLimiter {
  private lastCallMs = 0;
  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    const remain = this.minIntervalMs - elapsed;
    if (remain > 0) {
      await new Promise((resolve) => setTimeout(resolve, remain));
    }
    this.lastCallMs = Date.now();
  }
}

// 시세 계열 전용 레이트리미터(초당 10회 = 100ms 간격).
const priceLimiter = new RateLimiter(PRICE_MIN_INTERVAL_MS);

// -----------------------------------------------------------------------------
// 공통 요청 헬퍼
// -----------------------------------------------------------------------------

/** 응답 본문을 안전하게 텍스트로 읽기(에러 메시지에 붙이기 위함). */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number>;
  body?: unknown;
  /** 계좌 API 여부: true면 X-Tossinvest-Account 헤더도 붙임 */
  withAccount?: boolean;
}

/**
 * tossFetch — 인증 헤더를 붙여 토스 API를 호출하는 공통 함수.
 *
 * [헤더 규칙(설계서 M2)]
 *   - Authorization: Bearer {토큰}         ← 모든 인증 필요 API
 *   - X-Tossinvest-Account: {계좌 식별자}  ← 계좌·주문 API에만 (withAccount=true)
 *   한 사용자가 여러 계좌를 가질 수 있어, "어느 계좌로 하는 요청인지" 반드시 지정합니다.
 */
async function tossFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const cfg = getConfig();
  const token = await getAccessToken();

  // 쿼리스트링 조립(?symbol=AAPL 같은 부분).
  const url = new URL(`${cfg.baseUrl}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (opts.withAccount) {
    headers["X-Tossinvest-Account"] = cfg.account;
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`토스 API 실패 [${opts.method ?? "GET"} ${path}]: HTTP ${res.status} ${await safeText(res)}`);
  }
  return (await res.json()) as T;
}

// =============================================================================
// 4) 시세 API (인증 필요, 계좌 헤더 불필요, Rate limit 적용)
// =============================================================================

/** getPrice — 현재가 조회. */
export async function getPrice(symbol: string): Promise<PriceResponse> {
  await priceLimiter.wait(); // 초당 10회 제한 준수
  return tossFetch<PriceResponse>(ENDPOINTS.prices, { query: { symbol } });
}

/** getOrderbook — 호가(매수벽/매도벽) 조회. 호가창 기법의 핵심 데이터. */
export async function getOrderbook(symbol: string): Promise<OrderbookResponse> {
  await priceLimiter.wait();
  return tossFetch<OrderbookResponse>(ENDPOINTS.orderbook, { query: { symbol } });
}

/** getCandles — 캔들(1분봉/일봉) 조회. EMA200·양봉 판정 등의 재료. */
export async function getCandles(symbol: string, interval: "1m" | "1d", count = 200): Promise<CandlesResponse> {
  await priceLimiter.wait();
  return tossFetch<CandlesResponse>(ENDPOINTS.candles, { query: { symbol, interval, count } });
}

// =============================================================================
// 5) 계좌 API (인증 + 계좌 헤더 필요)
// =============================================================================

/** getBalance — 잔고(예수금·보유종목) 조회. */
export async function getBalance(): Promise<BalanceResponse> {
  return tossFetch<BalanceResponse>(ENDPOINTS.balance, { withAccount: true });
}

/** getBuyingPower — 매수 가능 금액(지금 살 수 있는 달러) 조회. */
export async function getBuyingPower(): Promise<BuyingPowerResponse> {
  return tossFetch<BuyingPowerResponse>(ENDPOINTS.buyingPower, { withAccount: true });
}

/** getSellable — 특정 종목의 매도 가능 수량 조회. */
export async function getSellable(symbol: string): Promise<SellableResponse> {
  return tossFetch<SellableResponse>(ENDPOINTS.sellable, { query: { symbol }, withAccount: true });
}

/** getCommission — 수수료율 조회. 사전검증에서 진짜 비용 계산에 사용. */
export async function getCommission(): Promise<CommissionResponse> {
  return tossFetch<CommissionResponse>(ENDPOINTS.commission, { withAccount: true });
}

// =============================================================================
// 6) 주문 API (인증 + 계좌 헤더 필요)
// =============================================================================

/**
 * preflightBuyCheck — 매수 주문 전 사전검증. (설계서 M2)
 *
 *   매수가능금액 + 수수료율을 조회해, "이 가격에 최대 몇 주 살 수 있는지"와
 *   "예상 비용"을 돌려줍니다. 주문이 돈 부족으로 거부되는 걸 미리 막습니다.
 *
 * [키 없이는?] 내부에서 getBuyingPower/getCommission(네트워크)을 부르므로,
 *   지금은 환경변수 에러로 안전하게 실패합니다. 순수 계산 부분은 calcMaxBuyQty로
 *   분리해 두어 그 함수만 따로 테스트합니다.
 */
export async function preflightBuyCheck(
  price: number,
): Promise<{ maxQty: number; buyingPowerUsd: number; commissionRate: number }> {
  const [bp, comm] = await Promise.all([getBuyingPower(), getCommission()]);
  const maxQty = calcMaxBuyQty(bp.buyingPowerUsd, price, comm.rate);
  return { maxQty, buyingPowerUsd: bp.buyingPowerUsd, commissionRate: comm.rate };
}

/**
 * createOrder — 주문 생성.
 *
 * [가격 정리] 지정가(LIMIT) 주문이면 price 를 반드시 roundPrice 로 유효 틱에 맞춥니다.
 *   (계산 엔진과 동일 규칙. 안 맞으면 토스가 400 에러를 냅니다 — 설계서 M1 주의사항)
 *
 * [멱등키] clientOrderId 는 makeClientOrderId 로 만든 값을 넣어, 재시도해도
 *   중복 주문이 나가지 않게 합니다.
 */
export async function createOrder(req: CreateOrderRequest): Promise<OrderResponse> {
  // 지정가면 가격을 유효 틱으로 절삭 정리.
  const body: CreateOrderRequest = {
    ...req,
    price: req.orderType === "LIMIT" && req.price !== undefined ? roundPrice(req.price) : req.price,
  };
  return tossFetch<OrderResponse>(ENDPOINTS.orders, { method: "POST", body, withAccount: true });
}

/**
 * amendOrder — 미체결 주문의 가격/수량 정정.
 *   (TODO(스펙확정): 실제 정정 방식이 PUT /orders/{id} 인지 별도 경로인지 확인)
 * [주의] 설계서 M0-A: 마감 1분 전은 정정·취소 불가 구간. 호출 전에
 *   session.isOrderFrozen() 으로 막아야 합니다(여기서는 순수 전송만 담당).
 */
export async function amendOrder(
  tossOrderId: string,
  changes: { price?: number; quantity?: number },
): Promise<OrderResponse> {
  const body = {
    ...changes,
    price: changes.price !== undefined ? roundPrice(changes.price) : undefined,
  };
  return tossFetch<OrderResponse>(`${ENDPOINTS.orders}/${encodeURIComponent(tossOrderId)}`, {
    method: "PUT",
    body,
    withAccount: true,
  });
}

/**
 * cancelOrder — 주문 취소.
 * [주의] 미체결 주문은 다음 세션으로 자동 이월되므로(M0-A), 봇이 명시적으로
 *   이 함수를 호출해 취소해야 합니다. 토스의 자동취소에 의존하지 않습니다.
 */
export async function cancelOrder(tossOrderId: string): Promise<OrderResponse> {
  return tossFetch<OrderResponse>(`${ENDPOINTS.orders}/${encodeURIComponent(tossOrderId)}`, {
    method: "DELETE",
    withAccount: true,
  });
}

/** listOrders — 주문 목록 조회(미체결 확인·이월 취소 대상 파악용). */
export async function listOrders(query?: { status?: string; symbol?: string }): Promise<OrderListResponse> {
  return tossFetch<OrderListResponse>(ENDPOINTS.orders, {
    query: query as Record<string, string> | undefined,
    withAccount: true,
  });
}
