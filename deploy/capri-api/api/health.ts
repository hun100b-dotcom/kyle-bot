// =============================================================================
// api/health.ts — 배포가 살아 있는지 확인하는 점검용 엔드포인트 (키 불필요)
// -----------------------------------------------------------------------------
// 왜 필요한가: 시세/환율은 키가 있어야 확인할 수 있어서, 배포 자체가 성공했는지
// 가리기 어렵다. 이 주소는 키 없이 200을 돌려주므로 "서버는 떴다"를 바로 알 수 있다.
// 덤으로 토스 서버까지 네트워크가 닿는지도(가짜 키로) 함께 본다.
// =============================================================================

export const config = { runtime: "edge" };

export default async function handler(): Promise<Response> {
  // 가짜 키로 토큰 발급을 시도한다. 401 invalid_client 가 오면
  // "이 클라우드에서 토스까지 도달 가능"이라는 뜻이다(IP·지역 차단 없음).
  let tossReach = "확인 실패";
  try {
    const r = await fetch("https://openapi.tossinvest.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=PROBE_ONLY&client_secret=PROBE_ONLY&scope=",
    });
    tossReach = r.status === 401 ? "도달 가능(401 = 인증단계까지 감)" : `예상 밖 응답 ${r.status}`;
  } catch (e) {
    tossReach = `네트워크 오류: ${e instanceof Error ? e.message : "알 수 없음"}`;
  }

  return new Response(
    JSON.stringify({ ok: true, service: "capri-api", toss: tossReach, time: new Date().toISOString() }, null, 2),
    { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } },
  );
}
