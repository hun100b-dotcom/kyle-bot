// =============================================================================
// supabase/functions/toss-proxy/index.ts
//   Capri 웹앱(PWA)이 토스 OpenAPI를 부를 수 있게 해 주는 중계(프록시) 함수 — Deno
// -----------------------------------------------------------------------------
// [왜 필요한가?]
//   ① 토스는 브라우저 호출을 허용하는 CORS 헤더를 주지 않는다(실측). 폰에서 직접 못 부른다.
//   ② 브라우저에서 직접 부르면 Client Secret 이 폰 화면·네트워크에 노출된다.
//   → 그래서 폰은 이 함수를 부르고, 이 함수가 토스를 부른다.
//
// [이 함수가 지키는 것]
//   · 전달 허용 경로를 토스 것(/oauth2/…, /api/v1/…)으로 제한한다.
//   · CORS 허용 주소를 우리 웹앱으로 제한한다.
//   · 아무것도 저장하지 않고, 아무것도 로그로 남기지 않는다.
//     (키·토큰·계좌·응답 전부 그 자리에서 흘려보낸다. 토큰만 메모리에 잠깐 캐시)
//
// [주소 구조]
//   함수 URL:  https://<프로젝트>.supabase.co/functions/v1/toss-proxy
//   웹앱은 그 뒤에 경로를 붙여 부른다:
//     …/functions/v1/toss-proxy/api/toss/api/v1/prices?symbols=AAPL   ← 통째 전달
//     …/functions/v1/toss-proxy/api/quote    (POST)
//     …/functions/v1/toss-proxy/api/fx       (POST)
//     …/functions/v1/toss-proxy/api/health   (GET, 키 불필요)
//   함수 안에서 "/functions/v1/toss-proxy" 앞부분을 떼어 내고 라우팅한다.
//
// [인증] verify_jwt=false 로 배포한다(Authorization 없이도 호출 가능).
//   여기 오는 Authorization 헤더는 토스 액세스 토큰이며 그대로 토스로 전달한다.
// =============================================================================

const TOSS_BASE = "https://openapi.tossinvest.com";

/** 이 프록시를 쓸 수 있는 웹앱 주소(허용 목록) */
const ALLOWED_ORIGINS = [
  "https://hun100b-dotcom.github.io", // 실제 웹앱(GitHub Pages)
  "http://localhost:5174", //            개발 미리보기
  "http://localhost:5175", //            빌드 미리보기
];

/** 함수 URL 앞부분(이 뒤가 우리가 쓰는 실제 경로) */
const FN_PREFIX = "/functions/v1/toss-proxy";

/** 토스로 전달해도 되는 경로인가 */
function isAllowedTossPath(path: string): boolean {
  return path.startsWith("/oauth2/") || path.startsWith("/api/v1/");
}

/** 토스로 넘겨야 하는 헤더만 골라 넘긴다(브라우저·게이트웨이가 붙이는 나머지는 제외) */
const FORWARD_HEADERS = ["authorization", "content-type", "x-tossinvest-account", "idempotency-key"];

function cors(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    // 엔진이 쓰는 헤더 + Supabase 게이트웨이가 요구할 수 있는 헤더까지 허용해 둔다.
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Tossinvest-Account, Idempotency-Key, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

/** 상태코드를 들고 다니는 에러 */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// -----------------------------------------------------------------------------
// 토큰 발급(간이 엔드포인트 /api/quote·/api/fx 전용)
//   ※ 통째 전달 경로는 웹앱(엔진)이 스스로 토큰을 관리하므로 여기를 거치지 않는다.
// -----------------------------------------------------------------------------
interface Creds {
  clientId: string;
  clientSecret: string;
  account?: string;
}

// 같은 키로 요청이 몰릴 때 토스에 토큰을 여러 번 조르지 않도록 잠깐만 들고 있는다.
// (함수 인스턴스가 사라지면 같이 사라진다 — 저장이 아니다)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(creds: Creds): Promise<string> {
  const hit = tokenCache.get(creds.clientId);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;

  const res = await fetch(`${TOSS_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: "",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 && text.includes("invalid_client")) {
      throw new HttpError(
        401,
        "토스가 이 키를 거부했습니다. 키가 만료·재발급됐을 수 있습니다. 토스 개발자센터에서 키를 확인한 뒤 다시 저장해 주세요.",
      );
    }
    throw new HttpError(res.status, `토큰 발급 실패(${res.status})`);
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(creds.clientId, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

/** 토스 GET 호출(읽기 전용) — 토스는 값을 {result:…} 로 감싸 주므로 벗겨서 돌려준다 */
async function tossGet(path: string, creds: Creds): Promise<unknown> {
  const token = await getToken(creds);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (creds.account) headers["X-Tossinvest-Account"] = creds.account;

  const res = await fetch(`${TOSS_BASE}${path}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `토스 조회 실패(${res.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { result?: unknown };
  return json.result ?? json;
}

/** 요청 본문에서 자격증명을 꺼낸다(형식 검사 포함) */
async function readCreds(req: Request): Promise<{ creds: Creds; body: Record<string, unknown> }> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "요청 형식이 잘못됐습니다(JSON 필요).");
  }
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
  if (!clientId || !clientSecret) {
    throw new HttpError(400, "키가 없습니다. 웹앱 설정에서 토스 키를 먼저 불러오세요.");
  }
  const account = typeof body.account === "string" ? body.account : undefined;
  return { creds: { clientId, clientSecret, account }, body };
}

// -----------------------------------------------------------------------------
// 라우팅
// -----------------------------------------------------------------------------
async function handleHealth(origin: string | null): Promise<Response> {
  // 가짜 키로 토큰 발급을 시도한다.
  //   401 invalid_client = 네트워크로 토스까지 '닿기는 한다'는 뜻일 뿐이다.
  //   ⚠️ 실제 키가 이 서버 IP에서 허용되는지는 이걸로 알 수 없다(토스는 키를 먼저 확인한 뒤
  //      그 키의 IP 허용목록을 본다). 실측 결과 진짜 키로는 403 "IP address not allowed" 가 났다.
  let tossReach = "확인 실패";
  try {
    const r = await fetch(`${TOSS_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=PROBE_ONLY&client_secret=PROBE_ONLY&scope=",
    });
    tossReach = r.status === 401 ? "도달 가능(401 = 인증단계까지 감)" : `예상 밖 응답 ${r.status}`;
  } catch (e) {
    tossReach = `네트워크 오류: ${e instanceof Error ? e.message : "알 수 없음"}`;
  }
  return jsonResponse(
    {
      ok: true,
      service: "capri-toss-proxy",
      runtime: "supabase-edge",
      toss: tossReach,
      note: "이 값은 네트워크 도달 여부만 뜻한다. 실제 키의 IP 허용 여부는 별개(403 가능).",
      time: new Date().toISOString(),
    },
    200,
    origin,
  );
}

async function handleQuote(req: Request, origin: string | null): Promise<Response> {
  const { creds, body } = await readCreds(req);
  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase().trim() : "";
  if (!symbol) throw new HttpError(400, "종목코드(symbol)가 없습니다.");

  // [경로 주의] 검증된 실제 경로는 /api/v1/prices 다(데스크톱 앱 lib/toss.ts 와 동일).
  const result = (await tossGet(`/api/v1/prices?symbols=${encodeURIComponent(symbol)}`, creds)) as
    | Array<Record<string, unknown>>
    | { prices?: Array<Record<string, unknown>> };

  const first = Array.isArray(result) ? result[0] : result?.prices?.[0];
  if (!first) throw new HttpError(404, `${symbol} 시세를 찾지 못했습니다. 종목코드를 확인해 주세요.`);
  return jsonResponse({ symbol, price: Number(first.lastPrice ?? first.price), raw: first }, 200, origin);
}

async function handleFx(req: Request, origin: string | null): Promise<Response> {
  const { creds } = await readCreds(req);
  // [필수 파라미터] baseCurrency·quoteCurrency 를 빼면 토스가 400(invalid-request)을 준다.
  const r = (await tossGet("/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW", creds)) as Record<
    string,
    unknown
  >;
  // 데스크톱과 같은 규칙: 스프레드 없는 midRate(매매기준율) 우선.
  const mid = Number(r.midRate ?? r.rate);
  if (!Number.isFinite(mid)) throw new HttpError(502, "환율 응답을 해석하지 못했습니다.");
  return jsonResponse({ rate: mid, basis: r.midRate != null ? "midRate(매매기준율)" : "rate", raw: r }, 200, origin);
}

/** 통째 전달: 웹앱(엔진)이 부르는 토스 경로를 그대로 토스에 넘긴다 */
async function handlePassThrough(req: Request, url: URL, tossPath: string, origin: string | null): Promise<Response> {
  if (!isAllowedTossPath(tossPath)) {
    return jsonResponse({ error: `허용되지 않은 경로입니다: ${tossPath}` }, 400, origin);
  }

  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(`${TOSS_BASE}${tossPath}${url.search}`, {
    method: req.method,
    headers,
    body,
  });

  // 토스 응답을 상태코드·본문 그대로 돌려준다
  //   → 웹앱 엔진의 오류 처리(친절한 한국어 안내 등)가 PC와 똑같이 동작한다.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      ...cors(origin),
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  // 브라우저의 사전 확인(프리플라이트)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  const url = new URL(req.url);

  // 함수 URL 앞부분을 떼어 낸다.
  //   운영: /functions/v1/toss-proxy/api/…   ·   로컬(supabase serve): /toss-proxy/api/…
  let path = url.pathname;
  if (path.startsWith(FN_PREFIX)) path = path.slice(FN_PREFIX.length);
  else if (path.startsWith("/toss-proxy")) path = path.slice("/toss-proxy".length);
  if (path === "") path = "/";

  try {
    if (path === "/api/health" || path === "/health" || path === "/") {
      return await handleHealth(origin);
    }
    if (path === "/api/quote") {
      if (req.method !== "POST") return jsonResponse({ error: "POST 로 요청하세요." }, 405, origin);
      return await handleQuote(req, origin);
    }
    if (path === "/api/fx") {
      if (req.method !== "POST") return jsonResponse({ error: "POST 로 요청하세요." }, 405, origin);
      return await handleFx(req, origin);
    }
    if (path.startsWith("/api/toss")) {
      return await handlePassThrough(req, url, path.slice("/api/toss".length), origin);
    }
    return jsonResponse({ error: `알 수 없는 경로입니다: ${path}` }, 404, origin);
  } catch (e) {
    // 오류 메시지는 돌려주되, 키가 담길 수 있는 요청 내용은 절대 기록하지 않는다.
    const status = e instanceof HttpError ? e.status : 500;
    return jsonResponse({ error: e instanceof Error ? e.message : "알 수 없는 오류" }, status, origin);
  }
});
