// =============================================================================
// api/quote.ts — [2단계] 미국주식 현재가 조회 (읽기 전용)
// -----------------------------------------------------------------------------
// 폰(PWA) → 이 서버 → 토스 OpenAPI 순서로 호출합니다.
// 사용법: POST { clientId, clientSecret, symbol: "AAPL" }
// =============================================================================

import { HttpError, json, readCreds, tossGet, corsHeaders } from "./_toss";

export const config = { runtime: "edge" }; // 가볍고 빠른 실행 환경(콜드스타트 최소화)

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST 로 요청하세요." }, 405, origin);

  try {
    const { creds, body } = await readCreds(req);
    const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase().trim() : "";
    if (!symbol) throw new HttpError(400, "종목코드(symbol)가 없습니다.");

    // [경로 주의] 검증된 실제 경로는 /api/v1/prices 다(데스크톱 앱 lib/toss.ts 와 동일).
    //   추측으로 stock-prices 를 썼다가 404 를 받았다 — 스펙은 반드시 기존 구현을 따른다.
    const result = (await tossGet(`/api/v1/prices?symbols=${encodeURIComponent(symbol)}`, creds)) as
      | Array<Record<string, unknown>>
      | { prices?: Array<Record<string, unknown>> };

    // 응답은 배열이 정상이지만, 객체로 감싸 오는 경우도 방어한다.
    const first = Array.isArray(result) ? result[0] : result?.prices?.[0];
    if (!first) throw new HttpError(404, `${symbol} 시세를 찾지 못했습니다. 종목코드를 확인해 주세요.`);

    return json({ symbol, price: Number(first.lastPrice ?? first.price), raw: first }, 200, origin);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : "알 수 없는 오류" }, status, origin);
  }
}
