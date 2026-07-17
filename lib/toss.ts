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
  conditionalOrders: "/api/v1/conditional-orders", // 조건주문(감시는 토스 서버가 함)
  exchangeRate: "/api/v1/exchange-rate", //           환율(USD↔KRW, 1분 갱신 참고용)
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

/**
 * 주문 생성 요청(우리 표준).
 * [2026-07-17 스펙 확정 — 공식 openapi.json 재확인 결과]
 *   - 필수: symbol / side / orderType / quantity. LIMIT면 price도 필수.
 *   - timeInForce: 선택, 기본 DAY(당일 유효 — 정규장 종료까지 미체결분 자동 취소).
 *   - 수량·가격은 전송 시 "문자열(decimal)"이어야 한다(직렬화는 createOrder가 처리).
 *   - confirmHighValueOrder: 1억원 이상 주문 시 true 필수(착오주문 방지).
 */
export interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  price?: number;
  quantity?: number;
  amountUsd?: number;
  clientOrderId: string;
  timeInForce?: "DAY" | "CLS"; // 기본 DAY
  confirmHighValueOrder?: boolean;
}

// -----------------------------------------------------------------------------
// 조건주문 타입 (공식 스펙: POST /api/v1/conditional-orders)
//   "이 가격(triggerPrice)에 닿으면 이 지정가(orderPrice)로 매수/매도" 를
//   토스 서버가 대신 감시·집행한다. → 앱을 꺼도 익절/손절이 작동하는 핵심.
// -----------------------------------------------------------------------------

/** 감시 조건 한 다리(leg): 감시가에 닿으면 orderSide 방향의 지정가 주문이 나간다 */
export interface ConditionLeg {
  orderSide: OrderSide; //  BUY(진입) 또는 SELL(익절/손절)
  triggerPrice: number; //  감시 가격(현재가가 닿으면 발동)
  orderPrice?: number; //   발동 시 낼 지정가(LIMIT일 때 필수)
}

/**
 * 조건주문 생성 요청.
 *   - SINGLE: first 하나만 감시
 *   - OCO: first(위·익절)·second(아래·손절) 동시 감시, 한쪽 발동 시 다른 쪽 자동 취소.
 *          둘 다 SELL + 지정가만 허용, "익절 감시가 > 현재가 > 손절 감시가" 필수.
 *   - OTO: first(BUY 진입) 체결 후 second(SELL) 감시 시작. 지정가만.
 */
export interface ConditionalOrderRequest {
  symbol: string;
  type: "SINGLE" | "OCO" | "OTO";
  quantity: number; //      그룹 공통 수량
  orderType: OrderType; //  OCO/OTO는 LIMIT만 지원(스펙)
  expireDate: string; //    만료일 YYYY-MM-DD (필수)
  first: ConditionLeg;
  second?: ConditionLeg;
  clientOrderId?: string;
  confirmHighValueOrder?: boolean;
}

/** 조건주문 응답(우리 표준) */
export interface ConditionalOrderResponse {
  conditionalOrderId: string;
  symbol?: string;
  type?: string;
  status?: string;
  quantity?: number;
  first?: { orderSide?: string; triggerPrice?: number; orderPrice?: number };
  second?: { orderSide?: string; triggerPrice?: number; orderPrice?: number } | null;
  expireDate?: string;
}

/** 환율 응답: 1 baseCurrency = rate quoteCurrency (예: 1 USD = 1,390 KRW) */
export interface ExchangeRateResponse {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  validFrom?: string;
  validUntil?: string;
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
 *   [2026-07-17 스펙 확정] 요청 바디의 수량·가격은 "문자열(decimal)"로 전송해야 한다.
 *   timeInForce 는 선택(기본 DAY = 당일 유효). 응답은 { orderId, clientOrderId }.
 */
export async function createOrder(req: CreateOrderRequest): Promise<OrderResponse> {
  const price = req.orderType === "LIMIT" && req.price !== undefined ? roundPrice(req.price) : undefined;
  // 실제 스펙 형태로 직렬화: 숫자 → 문자열, LIMIT 아닐 땐 price 자체를 보내지 않음.
  const body: Record<string, unknown> = {
    symbol: req.symbol,
    side: req.side,
    orderType: req.orderType,
    timeInForce: req.timeInForce ?? "DAY",
    clientOrderId: req.clientOrderId,
  };
  if (req.quantity !== undefined) body.quantity = String(req.quantity);
  if (price !== undefined) body.price = String(price);
  if (req.amountUsd !== undefined) body.orderAmount = String(req.amountUsd); // US MARKET 전용(정규장만)
  if (req.confirmHighValueOrder) body.confirmHighValueOrder = true;

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

// =============================================================================
// 7) 조건주문 API (2026-07-17 신규 — 공식 스펙 확인 완료)
//    "감시가에 닿으면 지정가 주문"을 토스 서버가 대신 감시한다.
//    → 앱을 꺼도 익절/손절이 작동한다(수동 도구 전환의 핵심 근거).
//    ⚠️ 이 함수들도 실주문 계열이므로, 호출부는 반드시 드라이런 게이트를 먼저 거친다.
// =============================================================================

/** 조건 다리(leg)를 실제 스펙 형태(문자열 숫자)로 직렬화 */
function legToBody(leg: ConditionLeg): Record<string, unknown> {
  const out: Record<string, unknown> = {
    orderSide: leg.orderSide,
    triggerPrice: String(roundPrice(leg.triggerPrice)),
  };
  if (leg.orderPrice !== undefined) out.orderPrice = String(roundPrice(leg.orderPrice));
  return out;
}

/** 실제 응답의 조건주문을 우리 표준형으로 변환(문자열 숫자 → number) */
function toConditionalResponse(raw: Record<string, unknown>): ConditionalOrderResponse {
  const leg = (v: unknown) => {
    if (!v || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    return {
      orderSide: o.orderSide as string | undefined,
      triggerPrice: o.triggerPrice != null ? Number(o.triggerPrice) : undefined,
      orderPrice: o.orderPrice != null ? Number(o.orderPrice) : undefined,
    };
  };
  return {
    conditionalOrderId: String(raw.conditionalOrderId ?? raw.id ?? ""),
    symbol: raw.symbol as string | undefined,
    type: raw.type as string | undefined,
    status: raw.status as string | undefined,
    quantity: raw.quantity != null ? Number(raw.quantity) : undefined,
    first: leg(raw.first),
    second: raw.second === null ? null : leg(raw.second),
    expireDate: raw.expireDate as string | undefined,
  };
}

/**
 * createConditionalOrder — 조건주문 생성.
 *   OCO(익절+손절 동시)·OTO(진입 체결 후 감시)·SINGLE 을 지원한다.
 *   [스펙 제약] OCO/OTO 는 지정가(LIMIT)만. OCO 는 둘 다 SELL 이고
 *   "first 감시가 > 현재가 > second 감시가" 여야 한다(아니면 서버가 거부).
 */
export async function createConditionalOrder(req: ConditionalOrderRequest): Promise<ConditionalOrderResponse> {
  const body: Record<string, unknown> = {
    symbol: req.symbol,
    type: req.type,
    quantity: String(req.quantity),
    orderType: req.orderType,
    expireDate: req.expireDate,
    first: legToBody(req.first),
  };
  if (req.second) body.second = legToBody(req.second);
  if (req.clientOrderId) body.clientOrderId = req.clientOrderId;
  if (req.confirmHighValueOrder) body.confirmHighValueOrder = true;

  const raw = await tossFetch<Record<string, unknown>>(ENDPOINTS.conditionalOrders, {
    method: "POST",
    body,
    withAccount: true,
  });
  return toConditionalResponse(raw);
}

/** listConditionalOrders — 조건주문 목록 조회 */
export async function listConditionalOrders(): Promise<ConditionalOrderResponse[]> {
  const raw = await tossFetch<unknown>(ENDPOINTS.conditionalOrders, { withAccount: true });
  // 응답이 배열이거나 { conditionalOrders: [...] } 형태 둘 다 수용(방어적).
  const arr = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)?.conditionalOrders as unknown[]) ?? [];
  return arr.map((r) => toConditionalResponse(r as Record<string, unknown>));
}

/** cancelConditionalOrder — 조건주문 취소(DELETE) */
export async function cancelConditionalOrder(conditionalOrderId: string): Promise<void> {
  await tossFetch<unknown>(`${ENDPOINTS.conditionalOrders}/${encodeURIComponent(conditionalOrderId)}`, {
    method: "DELETE",
    withAccount: true,
  });
}

// =============================================================================
// 8) 환율 API (2026-07-17 신규)
// =============================================================================

/**
 * getExchangeRate — USD↔KRW 환율 조회(원화 병기 표시용).
 *   [스펙 주의] 1분 갱신 "참고용 표시 환율"이며, 실제 주문에 적용되는 거래 환율과
 *   다를 수 있다(공식 문구). 화면에도 이 사실을 함께 표기할 것.
 */
export async function getExchangeRate(base = "USD", quote = "KRW"): Promise<ExchangeRateResponse> {
  const raw = await tossFetch<Record<string, unknown>>(ENDPOINTS.exchangeRate, {
    query: { baseCurrency: base, quoteCurrency: quote },
  });
  return {
    baseCurrency: String(raw.baseCurrency ?? base),
    quoteCurrency: String(raw.quoteCurrency ?? quote),
    rate: Number(raw.rate ?? raw.exchangeRate ?? 0),
    validFrom: raw.validFrom as string | undefined,
    validUntil: raw.validUntil as string | undefined,
  };
}
