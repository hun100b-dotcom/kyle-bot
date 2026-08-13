// =============================================================================
// api/toss/[...path].ts — 토스 OpenAPI '통째로 전달(pass-through)' 프록시
// -----------------------------------------------------------------------------
// [왜 이런 방식인가?]
//   웹앱은 데스크톱과 **똑같은 엔진 코드**를 브라우저에서 돌립니다. 그 엔진은
//   토스의 여러 주소(시세·호가·캔들·계좌·보유·주문·조건주문·환율…)를 자기 방식대로 부릅니다.
//   그래서 서버에 주소를 하나씩 만들어 두는 대신, **오는 요청을 그대로 토스에 전달**합니다.
//   → 엔진이 새 기능을 써도 서버를 고칠 필요가 없습니다(기능 동등성 유지가 쉬움).
//
// [무엇을 지키나 — 안전장치]
//   ① 전달 허용 경로를 토스 것(/oauth2/…, /api/v1/…)으로 **제한**한다. 아무 데나 못 보낸다.
//   ② CORS 허용 주소를 우리 웹앱으로 **제한**한다.
//   ③ 어떤 것도 저장하지 않는다(키·토큰·응답 전부 그 자리에서 흘려보낸다). 로그도 남기지 않는다.
//
// [주소 예]
//   웹앱 → https://<배포주소>/api/toss/api/v1/prices?symbols=AAPL
//   서버 → https://openapi.tossinvest.com/api/v1/prices?symbols=AAPL
// =============================================================================

export const config = { runtime: "edge" };

const TOSS_BASE = "https://openapi.tossinvest.com";

const ALLOWED_ORIGINS = [
  "https://hun100b-dotcom.github.io", // 실제 웹앱
  "http://localhost:5174", //            개발 미리보기
  "http://localhost:5175", //            빌드 미리보기
];

/** 토스로 전달해도 되는 경로인가 (그 외는 거절) */
function isAllowedPath(path: string): boolean {
  return path.startsWith("/oauth2/") || path.startsWith("/api/v1/");
}

/** 토스로 넘겨야 하는 헤더만 골라 넘긴다(브라우저가 붙이는 잡다한 헤더는 제외) */
const FORWARD_HEADERS = ["authorization", "content-type", "x-tossinvest-account", "idempotency-key"];

function cors(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    // 엔진이 쓰는 헤더를 브라우저가 보낼 수 있게 허용한다(빠지면 요청이 막힌다).
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tossinvest-Account, Idempotency-Key",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  const url = new URL(req.url);
  // 우리 주소 앞부분(/api/toss)을 떼어내면 토스에 보낼 경로가 된다.
  const path = url.pathname.replace(/^\/api\/toss/, "");
  if (!isAllowedPath(path)) {
    return new Response(JSON.stringify({ error: `허용되지 않은 경로입니다: ${path}` }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) },
    });
  }

  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(`${TOSS_BASE}${path}${url.search}`, {
    method: req.method,
    headers,
    body,
  });

  // 토스 응답을 그대로 돌려준다(상태코드·본문 유지 → 엔진의 오류 처리 로직이 PC와 동일하게 동작).
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      ...cors(origin),
    },
  });
}
