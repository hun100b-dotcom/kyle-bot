// =============================================================================
// api/_toss.ts  —  [2단계] 클라우드에서 토스 OpenAPI를 대신 불러 주는 공용 코드
// -----------------------------------------------------------------------------
// [왜 서버가 필요한가? — 실측으로 확인한 사실]
//   ① 토스 응답에 CORS 허용 헤더가 **없다**(2026-08-13 실측). 브라우저가 직접 부르면 차단된다.
//   ② 설령 뚫려도 브라우저에서 부르면 **Client Secret이 폰에 노출**된다. 절대 안 된다.
//   → 그래서 폰(PWA)은 이 서버를 부르고, 서버가 토스를 부른다.
//
// [클라우드에서 토스가 열려 있나? — 예, 확인했다]
//   미국 클라우드(GitHub Actions 러너)에서 가짜 키로 토큰 발급을 시도했더니
//   `401 invalid_client`가 돌아왔다. 즉 요청이 **인증 단계까지 도달**했다는 뜻으로,
//   IP·지역 차단이 없다는 근거다. (403이나 타임아웃이었다면 서버리스로는 불가능했다)
//
// [키를 서버에 저장하지 않는다 — 설계상의 안전장치]
//   이 서버는 **키를 어디에도 저장하지 않는다.** 요청이 올 때마다 폰이 보내 준 키를
//   메모리에서만 쓰고 버린다. 폰은 Supabase에 있는 '암호문'을 마스터 비밀번호로
//   **폰 안에서 복호화**해 들고 있다가 요청할 때만 보낸다(lib/keysync.ts와 같은 방식).
//   → 클라우드에는 평문 키가 저장되지 않는다.
//
// [읽기 전용] 지금은 시세·환율만 연다. 주문(매수/매도)은 여기에 없다.
//   실주문은 데스크톱 앱(Capri)에서만 나간다 — 안전장치·확인 팝업이 거기 있기 때문이다.
// =============================================================================

const TOSS_BASE = "https://openapi.tossinvest.com";

/** 브라우저(PWA)가 이 서버를 부를 수 있게 하는 CORS 헤더 */
export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    // 배포 후 실제 웹앱 주소만 허용하도록 좁히는 게 좋다(지금은 어디서든 호출 가능).
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store", // 시세·환율은 절대 캐시하지 않는다
  };
}

/** 요청 본문에 담겨 오는 자격증명(서버에 저장하지 않음) */
export interface Creds {
  clientId: string;
  clientSecret: string;
  account?: string; // accountSeq — 계좌가 필요한 조회에만
}

// 토큰은 짧게만 메모리에 둔다(같은 요청 폭주 시 토스에 토큰을 여러 번 요구하지 않도록).
// 서버리스는 인스턴스가 수시로 사라지므로 '캐시가 없어도 정상 동작'해야 한다.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** 액세스 토큰 발급(또는 캐시 재사용) */
export async function getToken(creds: Creds): Promise<string> {
  const key = creds.clientId;
  const hit = tokenCache.get(key);
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
    // 토스가 키를 거부하는 가장 흔한 경우를 한국어로 안내한다(데스크톱 앱과 같은 문구 취지).
    if (res.status === 401 && text.includes("invalid_client")) {
      throw new HttpError(401, "토스가 이 키를 거부했습니다. 키가 만료·재발급됐을 수 있습니다. 토스 개발자센터에서 키를 확인한 뒤 다시 저장해 주세요.");
    }
    throw new HttpError(res.status, `토큰 발급 실패(${res.status})`);
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const ttl = (json.expires_in ?? 3600) * 1000;
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + ttl });
  return json.access_token;
}

/** 상태코드를 들고 다니는 에러(핸들러가 그대로 응답으로 바꾼다) */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 토스 GET 호출(읽기 전용) */
export async function tossGet(path: string, creds: Creds): Promise<unknown> {
  const token = await getToken(creds);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (creds.account) headers["X-Tossinvest-Account"] = creds.account;

  const res = await fetch(`${TOSS_BASE}${path}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `토스 조회 실패(${res.status}): ${text.slice(0, 200)}`);

  // 토스는 실제 값을 {result: ...} 로 한 번 감싸서 준다 → 벗겨서 돌려준다(데스크톱 앱과 동일).
  const json = JSON.parse(text) as { result?: unknown };
  return json.result ?? json;
}

/** 요청 본문에서 자격증명을 꺼내며 형식을 검사한다 */
export async function readCreds(req: Request): Promise<{ creds: Creds; body: Record<string, unknown> }> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "요청 형식이 잘못됐습니다(JSON 필요).");
  }
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
  if (!clientId || !clientSecret) throw new HttpError(400, "키가 없습니다. 웹앱 설정에서 토스 키를 먼저 불러오세요.");
  const account = typeof body.account === "string" ? body.account : undefined;
  return { creds: { clientId, clientSecret, account }, body };
}

/** 공통 응답 포장(에러도 한국어 메시지로 통일) */
export function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}
