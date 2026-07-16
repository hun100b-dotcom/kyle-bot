// =============================================================================
// lib/toss.ts  —  토스 Open API 어댑터 (설계서 3장 M2)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   "카일봇 ↔ 토스 증권 서버" 사이의 통역사이자 "번역 계층"입니다.
//   토스가 주는 실제 응답 형태(가격이 문자열, 상태가 대문자, 응답이 {result:...}로 감쌈)를
//   우리 내부에서 다루기 쉬운 표준형(가격 number, 상태 소문자)으로 바꿔서 돌려줍니다.
//   덕분에 실행부(lifecycle)·워커·안전장치는 토스 스펙을 몰라도 됩니다.
//
// [실제 스펙 반영 — 2026-07-16 검증]
//   토스 공식 OpenAPI(https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)를
//   내려받아 실제 필드/경로를 맞췄고, 읽기전용 호출(토큰·현재가·계좌·매수가능금액)이
//   실서버에서 HTTP 200으로 도는 것을 확인했습니다. 주요 실제 스펙:
//     - 응답은 모두 { result: ... } 로 감싸짐(토큰 발급 제외)
//     - 현재가: GET /api/v1/prices?symbols=AAPL → result[].lastPrice(문자열)
//     - 매수가능금액: GET /api/v1/buying-power?currency=USD, 헤더 X-Tossinvest-Account=accountSeq
//     - 계좌 목록: GET /api/v1/accounts → result[].accountSeq (이 값이 계좌 헤더)
//     - 주문 상태 enum은 대문자(FILLED/PARTIAL_FILLED/CANCELED/REJECTED…)
//     - 정정/취소는 POST /api/v1/orders/{id}/modify, /cancel
//
// [보안] client secret 등 비밀값은 로컬 .env(gitignore)/OS 환경변수에서만. 커밋·프론트 노출 금지.
// [남은 TODO(주문 실행 전 확정)] 주문 생성 요청 바디의 정확한 필드(timeInForce 등)와
//   orderbook/candles 세부 응답 필드는 실제 주문/시세를 붙일 때 최종 확정합니다.
// =============================================================================

import { roundPrice } from "./calc";

// -----------------------------------------------------------------------------
// 0) 엔드포인트 경로 (실제 토스 스펙에 맞춤)
// -----------------------------------------------------------------------------
const ENDPOINTS = {
  token: "/oauth2/token",
  prices: "/api/v1/prices",
  orderbook: "/api/v1/orderbook",
  candles: "/api/v1/candles",
  accounts: "/api/v1/accounts", // 계좌 목록(여기서 accountSeq 획득)
  holdings: "/api/v1/holdings", // 보유 종목
  buyingPower: "/api/v1/buying-power",
  sellable: "/api/v1/sellable-quantity",
  commissions: "/api/v1/commissions",
  orders: "/api/v1/orders",
} as const;

const PRICE_MIN_INTERVAL_MS = 100; // 시세 Rate limit: 초당 10회 → 최소 100ms 간격
const TOKEN_SAFETY_MARGIN_MS = 10 * 60 * 1000; // 만료 10분 전 선제 재발급

// =============================================================================
// 1) 타입: 실제 응답(Raw) + 우리 내부 표준형
// =============================================================================

/** 토큰 발급 응답(그대로) */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** 현재가: 실제 응답 한 건(가격이 "문자열"임에 주의) */
interface PriceRaw {
  symbol: string;
  timestamp: string | null;
  lastPrice: string; // 문자열! 예 "327.7"
  currency: string;
}
/** 현재가: 우리 내부 표준형(가격을 number로 변환해 제공) */
export interface PriceResponse {
  symbol: string;
  price: number;
  currency: string;
  timestamp: string | null;
}

/** 매수 가능 금액: 실제 응답 */
interface BuyingPowerRaw {
  currency: string;
  cashBuyingPower: string; // 문자열
}
/** 매수 가능 금액: 내부 표준형 */
export interface BuyingPowerResponse {
  buyingPowerUsd: number;
  currency: string;
}

/** 계좌: 실제 응답 한 건 */
export interface AccountInfo {
  accountNo: string;
  accountSeq: number; // 이 값이 X-Tossinvest-Account 헤더로 들어감
  accountType: string;
}

/** 매도 가능 수량: 실제 응답 */
interface SellableRaw {
  sellableQuantity: string;
}
export interface SellableResponse {
  symbol: string;
  sellableQty: number;
}

/** 주문 방향/유형 */
export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

/** 주문 생성 요청(우리 표준). TODO(실주문 전): timeInForce 등 실제 필수 필드 확정. */
export interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  price?: number;
  quantity?: number;
  amountUsd?: number;
  clientOrderId: string;
}

/** 주문 상세: 실제 응답(일부) */
interface OrderDetailRaw {
  orderId: string;
  clientOrderId?: string | null;
  symbol?: string;
  side?: OrderSide;
  status: string; // 대문자 enum
  price?: string | null;
  quantity?: string;
  execution?: {
    filledQuantity: string;
    averageFilledPrice?: string | null;
  } | null;
}

/** 주문: 우리 내부 표준형(상태는 소문자로 매핑, 수량은 number) */
export interface OrderResponse {
  tossOrderId: string;
  clientOrderId?: string | null;
  status: string; // 내부 표준 소문자: pending|submitted|filled|partial|cancelled|failed
  symbol?: string;
  side?: OrderSide;
  price?: number;
  filled_qty?: number;
}

export interface OrderListResponse {
  orders: OrderResponse[];
  nextCursor?: string | null;
  hasNext?: boolean;
}

// =============================================================================
// 2) 순수 로직 (키 없이도 검증 가능 — vitest 대상)
// =============================================================================

/** 토큰을 지금 다시 발급해야 하는가? (만료 marginMs 전이면 true) */
export function isTokenExpired(expiresAtMs: number, nowMs: number, marginMs: number): boolean {
  return nowMs >= expiresAtMs - marginMs;
}

function sanitizeIdPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * makeClientOrderId — 멱등키(중복 주문 방지) 생성. `{세션앞8자}-{level}-{role}`, 36자·영숫자-_.
 *   같은 주문을 재시도해도 토스가 "이미 받은 주문"으로 인식해 이중 체결을 막습니다.
 */
export function makeClientOrderId(sessionId: string, level: number, role: string): string {
  const head = sanitizeIdPart(sessionId).slice(0, 8);
  const lvl = sanitizeIdPart(String(level));
  const r = sanitizeIdPart(role);
  let id = `${head}-${lvl}-${r}`;
  if (id.length > 36) id = id.slice(0, 36);
  return id;
}

/** 매수 가능 금액으로 최대 몇 주 살 수 있는지(수수료 포함, 내림). 사전검증용. */
export function calcMaxBuyQty(buyingPowerUsd: number, price: number, commissionRate: number): number {
  if (price <= 0) return 0;
  const perShareCost = price * (1 + commissionRate);
  return Math.floor(buyingPowerUsd / perShareCost);
}

/**
 * mapOrderStatus — 토스의 대문자 주문 상태를 우리 내부 표준(소문자)으로 번역.
 *   [왜?] 실행부(lifecycle)는 'filled'/'partial'/'submitted' 같은 우리 표준으로만 판단합니다.
 *   토스가 상태 이름을 바꾸거나 늘려도 이 함수만 고치면 됩니다(번역 계층의 핵심).
 */
export function mapOrderStatus(tossStatus: string): string {
  switch (tossStatus) {
    case "PENDING":
    case "PENDING_CANCEL":
    case "PENDING_REPLACE":
    case "REPLACED":
      return "submitted";
    case "PARTIAL_FILLED":
      return "partial";
    case "FILLED":
      return "filled";
    case "CANCELED":
      return "cancelled";
    case "REJECTED":
    case "CANCEL_REJECTED":
    case "REPLACE_REJECTED":
      return "failed";
    default:
      return "submitted";
  }
}

// =============================================================================
// 3) 설정/토큰/레이트리밋 (실행 인프라)
// =============================================================================

interface TossConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  account: string; // accountSeq 문자열
}

/**
 * getConfig — 환경변수에서 토스 설정을 읽는다. 없으면 즉시 명확한 에러.
 *   TOSS_MOCK=true 면 실제 키 없이 목 서버(baseUrl)만으로 동작(리허설용).
 */
function getConfig(): TossConfig {
  const baseUrl = process.env.TOSS_BASE_URL;

  if (process.env.TOSS_MOCK === "true") {
    if (!baseUrl) throw new Error("TOSS_MOCK=true 인데 TOSS_BASE_URL(목 서버 주소)이 없습니다.");
    return {
      baseUrl,
      clientId: "mock-client",
      clientSecret: "mock-secret",
      account: process.env.TOSS_ACCOUNT ?? "1",
    };
  }

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
        `로컬 .env 파일 또는 OS 환경변수에 설정하세요.`,
    );
  }
  return {
    baseUrl: baseUrl as string,
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    account: account as string,
  };
}

/** 요청 타임아웃(ms). 기본 10초, TOSS_TIMEOUT_MS로 조정. */
function getTimeoutMs(): number {
  const v = process.env.TOSS_TIMEOUT_MS;
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/** 제한 시간 안에 응답이 없으면 요청을 끊는 fetch(봇이 한 요청에 매달려 멈추지 않게). */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`요청 타임아웃(${timeoutMs}ms 초과): ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;
// 발급 "진행 중"인 요청을 공유하기 위한 자리(single-flight 패턴).
let tokenInFlight: Promise<string> | null = null;

/**
 * getAccessToken — 유효한 액세스 토큰을 돌려준다(캐시 + 만료 10분 전 자동 재발급).
 *
 * [single-flight 패턴 — 실서버에서 발견한 실전 버그의 해결책]
 *   여러 API를 "동시에" 부르면(Promise.all), 캐시가 빈 순간 토큰 발급 요청이
 *   여러 개 동시에 나갑니다. 토스는 새 토큰을 발급하면 직전 토큰을 무효화하므로,
 *   나중에 발급된 토큰이 먼저 발급된 토큰을 죽여 일부 호출이 401로 실패합니다
 *   (2026-07-16 실서버에서 실제 재현). 그래서 "누군가 이미 발급 중이면 새로 요청하지
 *   않고 그 결과를 같이 기다리는" 구조로 만들어, 토큰 발급이 항상 1개만 나가게 합니다.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && !isTokenExpired(tokenCache.expiresAtMs, now, TOKEN_SAFETY_MARGIN_MS)) {
    return tokenCache.accessToken;
  }
  // 이미 다른 호출이 발급 중이면 그 결과를 같이 기다린다(중복 발급 방지).
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    try {
      const cfg = getConfig();
      // 실제 스펙: application/x-www-form-urlencoded, body에 grant_type/client_id/client_secret.
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      });

      const res = await fetchWithTimeout(
        `${cfg.baseUrl}${ENDPOINTS.token}`,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        getTimeoutMs(),
        "POST /oauth2/token",
      );
      if (!res.ok) throw new Error(`토큰 발급 실패: HTTP ${res.status} ${await safeText(res)}`);

      const data = (await res.json()) as TokenResponse;
      tokenCache = { accessToken: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 };
      return tokenCache.accessToken;
    } finally {
      tokenInFlight = null; // 성공/실패와 무관하게 자리 비움(다음 발급 가능하게)
    }
  })();
  return tokenInFlight;
}

/** (테스트/재로그인용) 토큰 캐시 비우기. */
export function clearTokenCache(): void {
  tokenCache = null;
}

/** 호출 사이 최소 간격을 강제해 Rate limit을 지키는 도우미. */
class RateLimiter {
  private lastCallMs = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const remain = this.minIntervalMs - (now - this.lastCallMs);
    if (remain > 0) await new Promise((r) => setTimeout(r, remain));
    this.lastCallMs = Date.now();
  }
}
const priceLimiter = new RateLimiter(PRICE_MIN_INTERVAL_MS);

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
  withAccount?: boolean; // true면 X-Tossinvest-Account(accountSeq) 헤더 추가
}

/**
 * tossFetch — 인증 헤더를 붙여 토스 API를 호출하고, 응답의 { result } 를 벗겨 돌려준다.
 *   [실제 스펙] 토스는 성공 응답을 { result: 실제데이터 } 로 감쌉니다. 그 껍질을 여기서
 *   한 번에 벗겨, 각 함수는 알맹이(result)만 받게 합니다.
 */
async function tossFetch<T>(path: string, opts: RequestOptions = {}, isRetry = false): Promise<T> {
  const cfg = getConfig();
  const token = await getAccessToken();

  const url = new URL(`${cfg.baseUrl}${path}`);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (opts.withAccount) headers["X-Tossinvest-Account"] = cfg.account; // accountSeq

  const res = await fetchWithTimeout(
    url.toString(),
    { method: opts.method ?? "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined },
    getTimeoutMs(),
    `${opts.method ?? "GET"} ${path}`,
  );

  // [401 자동 복구] 토큰이 서버 쪽에서 무효화됐을 수 있음(예: 다른 프로세스가 새 토큰
  //   발급 → 기존 토큰 죽음). 캐시를 비우고 새 토큰으로 "딱 한 번만" 재시도한다.
  //   (읽기 요청은 재시도해도 안전. 무한 재시도는 금지 — isRetry 플래그로 1회 제한)
  if (res.status === 401 && !isRetry) {
    clearTokenCache();
    return tossFetch<T>(path, opts, true);
  }

  if (!res.ok) throw new Error(`토스 API 실패 [${opts.method ?? "GET"} ${path}]: HTTP ${res.status} ${await safeText(res)}`);

  const json = (await res.json()) as { result?: T };
  // 토스 표준: { result }. 혹시 없는 응답이면 본문 그대로.
  return (json.result ?? (json as unknown as T)) as T;
}

// =============================================================================
// 4) 시세 API (인증 필요, 계좌 헤더 불필요, Rate limit 적용)
// =============================================================================

/** getPrice — 현재가 조회. 실제 스펙은 symbols(복수)·가격 문자열 → number로 변환해 반환. */
export async function getPrice(symbol: string): Promise<PriceResponse> {
  await priceLimiter.wait();
  const arr = await tossFetch<PriceRaw[]>(ENDPOINTS.prices, { query: { symbols: symbol } });
  const p = arr[0];
  return { symbol: p.symbol, price: Number(p.lastPrice), currency: p.currency, timestamp: p.timestamp };
}

/** getOrderbook — 호가 조회. (세부 응답 필드는 TODO(실시세 붙일 때 확정)) */
export async function getOrderbook(symbol: string): Promise<unknown> {
  await priceLimiter.wait();
  return tossFetch<unknown>(ENDPOINTS.orderbook, { query: { symbols: symbol } });
}

/** getCandles — 캔들(봉) 조회. (interval/count 파라미터 및 응답 필드는 TODO(실시세 확정)) */
export async function getCandles(symbol: string, interval = "1m", count = 200): Promise<unknown> {
  await priceLimiter.wait();
  return tossFetch<unknown>(ENDPOINTS.candles, { query: { symbols: symbol, interval, count } });
}

// =============================================================================
// 5) 계좌 API
// =============================================================================

/** getAccounts — 계좌 목록. 계좌 헤더 불필요. 여기서 accountSeq(계좌 헤더 값)를 얻는다. */
export async function getAccounts(): Promise<AccountInfo[]> {
  return tossFetch<AccountInfo[]>(ENDPOINTS.accounts);
}

/** getHoldings — 보유 종목 조회(계좌 헤더 필요). */
export async function getHoldings(): Promise<unknown> {
  return tossFetch<unknown>(ENDPOINTS.holdings, { withAccount: true });
}

/** getBuyingPower — 매수 가능 금액(계좌 헤더 필요, currency 필수). 문자열 → number 변환. */
export async function getBuyingPower(currency = "USD"): Promise<BuyingPowerResponse> {
  const r = await tossFetch<BuyingPowerRaw>(ENDPOINTS.buyingPower, { query: { currency }, withAccount: true });
  return { buyingPowerUsd: Number(r.cashBuyingPower), currency: r.currency };
}

/** getSellable — 매도 가능 수량(계좌 헤더 필요). 문자열 → number. */
export async function getSellable(symbol: string): Promise<SellableResponse> {
  const r = await tossFetch<SellableRaw>(ENDPOINTS.sellable, { query: { symbol }, withAccount: true });
  return { symbol, sellableQty: Number(r.sellableQuantity) };
}

/** getCommissions — 수수료 조회(계좌 헤더 필요). 실제 응답은 배열(구간별). 그대로 반환. */
export async function getCommissions(): Promise<unknown> {
  return tossFetch<unknown>(ENDPOINTS.commissions, { withAccount: true });
}

// =============================================================================
// 6) 주문 API (인증 + 계좌 헤더 필요)
//    ⚠️ 실주문은 안전장치(risk) 게이트를 통과한 실행부(lifecycle)에서만 호출한다.
// =============================================================================

/**
 * preflightBuyCheck — 매수 전 사전검증. 매수가능금액으로 최대 수량 계산.
 *   [주의] 실제 수수료 응답(commissions)은 구간별 배열이라, 여기서는 보수적으로 0을 써
 *   최대 수량을 계산한다(TODO: 실제 수수료율 파싱해 반영). buying-power는 실제 조회.
 */
export async function preflightBuyCheck(
  price: number,
): Promise<{ maxQty: number; buyingPowerUsd: number; commissionRate: number }> {
  const bp = await getBuyingPower("USD");
  const commissionRate = 0; // TODO(스펙확정): commissions 배열에서 실제 요율 파싱
  const maxQty = calcMaxBuyQty(bp.buyingPowerUsd, price, commissionRate);
  return { maxQty, buyingPowerUsd: bp.buyingPowerUsd, commissionRate };
}

/** 실제 주문 응답(생성)을 우리 표준으로 변환하는 헬퍼. */
function toOrderResponse(raw: OrderDetailRaw): OrderResponse {
  return {
    tossOrderId: raw.orderId,
    clientOrderId: raw.clientOrderId ?? undefined,
    status: mapOrderStatus(raw.status ?? "PENDING"),
    symbol: raw.symbol,
    side: raw.side,
    price: raw.price != null ? Number(raw.price) : undefined,
    filled_qty: raw.execution ? Number(raw.execution.filledQuantity) : 0,
  };
}

/**
 * createOrder — 주문 생성. 지정가면 price를 roundPrice로 유효 틱에 맞춘다.
 *   [실제 스펙] 응답은 { orderId, clientOrderId }. TODO(실주문 전): 요청 바디의 실제
 *   필수 필드(timeInForce=DAY 등)와 금액/수량 표기(문자열 여부)를 최종 확정.
 */
export async function createOrder(req: CreateOrderRequest): Promise<OrderResponse> {
  const body = {
    ...req,
    price: req.orderType === "LIMIT" && req.price !== undefined ? roundPrice(req.price) : req.price,
  };
  const raw = await tossFetch<OrderDetailRaw>(ENDPOINTS.orders, { method: "POST", body, withAccount: true });
  return toOrderResponse(raw);
}

/** getOrder — 단건 주문 상태 조회(체결 진행 확인). 상태는 소문자로 매핑, 체결수량 number. */
export async function getOrder(tossOrderId: string): Promise<OrderResponse> {
  const raw = await tossFetch<OrderDetailRaw>(`${ENDPOINTS.orders}/${encodeURIComponent(tossOrderId)}`, {
    withAccount: true,
  });
  return toOrderResponse(raw);
}

/**
 * modifyOrder — 주문 정정. 실제 스펙: POST /api/v1/orders/{id}/modify.
 *   [주의] 마감 1분 전은 정정 불가 구간(session.isOrderFrozen). 호출 전 확인 필요.
 */
export async function modifyOrder(
  tossOrderId: string,
  changes: { price?: number; quantity?: number },
): Promise<OrderResponse> {
  const body = { ...changes, price: changes.price !== undefined ? roundPrice(changes.price) : undefined };
  const raw = await tossFetch<OrderDetailRaw>(`${ENDPOINTS.orders}/${encodeURIComponent(tossOrderId)}/modify`, {
    method: "POST",
    body,
    withAccount: true,
  });
  return toOrderResponse(raw);
}

/** cancelOrder — 주문 취소. 실제 스펙: POST /api/v1/orders/{id}/cancel. */
export async function cancelOrder(tossOrderId: string): Promise<OrderResponse> {
  const raw = await tossFetch<OrderDetailRaw>(`${ENDPOINTS.orders}/${encodeURIComponent(tossOrderId)}/cancel`, {
    method: "POST",
    withAccount: true,
  });
  return toOrderResponse(raw);
}

/** listOrders — 주문 목록 조회. 실제 스펙: status 필수, 응답 { orders, nextCursor, hasNext }. */
export async function listOrders(query: { status: string; symbol?: string }): Promise<OrderListResponse> {
  const raw = await tossFetch<{ orders: OrderDetailRaw[]; nextCursor?: string | null; hasNext?: boolean }>(
    ENDPOINTS.orders,
    { query: query as Record<string, string>, withAccount: true },
  );
  return {
    orders: (raw.orders ?? []).map(toOrderResponse),
    nextCursor: raw.nextCursor,
    hasNext: raw.hasNext,
  };
}
