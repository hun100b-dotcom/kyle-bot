// =============================================================================
// api/fx.ts — [2단계] 원-달러 환율 조회 (읽기 전용)
// -----------------------------------------------------------------------------
// 데스크톱 앱과 같은 규칙: **midRate(매매기준율)** 를 우선 사용합니다.
//   rate 는 살 때 환율이라 스프레드가 섞여 토스 화면보다 높게 보입니다(v0.2.3 교훈).
// 사용법: POST { clientId, clientSecret }
// =============================================================================

import { HttpError, json, readCreds, tossGet, corsHeaders } from "./_toss";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "POST 로 요청하세요." }, 405, origin);

  try {
    const { creds } = await readCreds(req);
    // [필수 파라미터] baseCurrency·quoteCurrency 를 빼면 토스가 400(invalid-request)을 준다.
    //   (v0.2.4 때 조건주문 status 를 빠뜨려 똑같이 400 을 맞은 적이 있다 — 같은 실수 반복 금지)
    const r = (await tossGet("/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW", creds)) as Record<
      string,
      unknown
    >;
    const mid = Number(r.midRate ?? r.rate);
    if (!Number.isFinite(mid)) throw new HttpError(502, "환율 응답을 해석하지 못했습니다.");
    return json({ rate: mid, basis: r.midRate != null ? "midRate(매매기준율)" : "rate", raw: r }, 200, origin);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : "알 수 없는 오류" }, status, origin);
  }
}
