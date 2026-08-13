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

    const result = (await tossGet(`/api/v1/stock-prices?symbols=${encodeURIComponent(symbol)}`, creds)) as
      | { stockPrices?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>;

    // 응답 모양이 배열/객체 어느 쪽이든 첫 종목을 꺼낸다(스펙 변화에 덜 민감하게).
    const first = Array.isArray(result) ? result[0] : result?.stockPrices?.[0];
    if (!first) throw new HttpError(404, `${symbol} 시세를 찾지 못했습니다. 종목코드를 확인해 주세요.`);

    return json({ symbol, price: Number(first.lastPrice ?? first.price), raw: first }, 200, origin);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : "알 수 없는 오류" }, status, origin);
  }
}
