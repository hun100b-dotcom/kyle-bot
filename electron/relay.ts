// =============================================================================
// electron/relay.ts — 집 PC에서 도는 "폰↔토스 중계(릴레이) 서버"
// -----------------------------------------------------------------------------
// [왜 이게 필요한가 — 사장님께]
//   토스 API 키에는 **허용된 인터넷 주소(IP)** 가 걸려 있습니다. 그래서 클라우드
//   서버(주소가 계속 바뀜)에서 부르면 토스가 막습니다(403 "IP address not allowed").
//   반면 **집 PC의 주소는 이미 허용**돼 있습니다(실측 200).
//
//   그래서 구조를 이렇게 바꿉니다:
//        폰(웹앱) → 인터넷 터널 → 집 PC(이 릴레이) → 토스
//   토스 입장에서는 늘 '집 PC'가 부르는 것이라 IP 등록을 새로 할 필요가 없습니다.
//
// [키는 어디에? — v0.9.7 중요]
//   **폰에는 키를 넣지 않아도 됩니다.** 집 PC(이 앱)에 이미 키가 있으니, 폰이 "키 대신"
//   요청을 보내면 릴레이가 **PC의 키로 토큰을 발급해** 토스에 전달합니다.
//   · 폰에 실제 키를 저장하지 않으므로 더 안전합니다.
//   · 사장님은 QR만 찍으면 되고, 폰에서 로그인·키 입력이 전혀 필요 없습니다.
//   (원래는 키 동기화용 클라우드에서 키를 받아야 했는데, 그 서버가 멈춰 있어 폰이 통째로 막혔습니다)
//
// [아무나 못 쓰게 — 통행증(토큰)]
//   터널 주소는 인터넷에 열려 있으므로, 주소를 우연히 아는 사람이 우리 집 IP로
//   토스를 부르는 걸 막아야 합니다. 그래서 주소에 **통행증**을 넣습니다.
//        https://<터널주소>/r/<통행증>/api/toss/...
//   통행증이 없거나 틀리면 401로 거절합니다. 폰에는 QR/주소로 통행증까지 전달됩니다.
// =============================================================================

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes } from "node:crypto";

const TOSS_BASE = "https://openapi.tossinvest.com";

/** 폰이 "키 대신" 보내는 표식. 이 값이 오면 릴레이가 이 PC의 실제 키로 바꿔 준다. */
export const RELAY_KEY_PLACEHOLDER = "RELAY";

/** 브라우저(웹앱)가 이 릴레이를 부를 수 있게 하는 CORS 허용 주소 */
const ALLOWED_ORIGINS = [
  "https://hun100b-dotcom.github.io", // 실제 웹앱(GitHub Pages)
  "http://localhost:5174", //            개발 미리보기
  "http://localhost:5175", //            빌드 미리보기
];

/** 토스로 전달해도 되는 경로인가 (그 외는 거절) */
function isAllowedTossPath(path: string): boolean {
  return path.startsWith("/oauth2/") || path.startsWith("/api/v1/");
}

/** 토스로 넘길 헤더만 골라 넘긴다 */
const FORWARD_HEADERS = ["authorization", "content-type", "x-tossinvest-account", "idempotency-key"];

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tossinvest-Account, Idempotency-Key",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function sendJson(res: ServerResponse, status: number, data: unknown, origin: string | undefined): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) });
  res.end(JSON.stringify(data));
}

/** 요청 본문 전부 읽기 */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export interface RelayHandle {
  /** 이 PC 안에서의 주소 */
  localUrl: string;
  /** 폰에 알려 줄 통행증(주소에 포함됨) */
  token: string;
  /** 서버 끄기 */
  stop: () => Promise<void>;
  port: number;
}

/**
 * startRelay — 릴레이 서버를 켠다.
 * @param port 0이면 빈 포트를 자동으로 고른다.
 * @param token 통행증(안 주면 새로 만든다)
 */
export function startRelay(port = 8790, token?: string): Promise<RelayHandle> {
  const pass = token ?? randomBytes(9).toString("base64url"); // 12자 정도의 통행증

  const server: Server = createServer(async (req, res) => {
    const origin = req.headers.origin;

    // 브라우저 사전 확인(프리플라이트)
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      let path = url.pathname;

      // ── 통행증 확인 ────────────────────────────────────────────
      //   주소가 /r/<통행증>/… 형태여야 한다. 없으면 거절(단, 헬스체크는 열어 둔다).
      if (path === "/health" || path === "/api/health") {
        sendJson(res, 200, { ok: true, service: "capri-home-relay", time: new Date().toISOString() }, origin);
        return;
      }
      if (!path.startsWith(`/r/${pass}`)) {
        sendJson(res, 401, { error: "통행증이 없거나 올바르지 않습니다(주소를 다시 확인해 주세요)." }, origin);
        return;
      }
      path = path.slice(`/r/${pass}`.length) || "/";

      // ── 라우팅 ────────────────────────────────────────────────
      if (path === "/api/health" || path === "/") {
        sendJson(
          res,
          200,
          { ok: true, service: "capri-home-relay", note: "집 PC 경유(토스 허용 IP)", time: new Date().toISOString() },
          origin,
        );
        return;
      }

      if (path.startsWith("/api/toss")) {
        const tossPath = path.slice("/api/toss".length);
        if (!isAllowedTossPath(tossPath)) {
          sendJson(res, 400, { error: `허용되지 않은 경로입니다: ${tossPath}` }, origin);
          return;
        }

        const headers: Record<string, string> = {};
        for (const h of FORWARD_HEADERS) {
          const v = req.headers[h];
          if (typeof v === "string") headers[h] = v;
        }

        let body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);

        // ── [v0.9.7] 폰에 키가 없을 때: 이 PC의 키로 대신 인증한다 ──
        //   폰은 client_id 자리에 "RELAY" 라는 표식만 보낸다. 실제 키는 이 PC에만 있다.
        if (tossPath.startsWith("/oauth2/token") && body) {
          const form = new URLSearchParams(body.toString("utf8"));
          if ((form.get("client_id") ?? "") === RELAY_KEY_PLACEHOLDER) {
            const id = process.env.TOSS_CLIENT_ID ?? "";
            const secret = process.env.TOSS_CLIENT_SECRET ?? "";
            if (!id || !secret) {
              sendJson(res, 400, { error: "이 PC에 토스 키가 없습니다. PC의 Capri 설정에서 키를 먼저 저장해 주세요." }, origin);
              return;
            }
            form.set("client_id", id);
            form.set("client_secret", secret);
            body = Buffer.from(form.toString());
          }
        }
        // 계좌 번호도 폰이 모르므로, 표식이면 이 PC의 계좌로 바꿔 준다.
        if (headers["x-tossinvest-account"] === RELAY_KEY_PLACEHOLDER) {
          const acct = process.env.TOSS_ACCOUNT ?? "";
          if (acct) headers["x-tossinvest-account"] = acct;
        }
        const upstream = await fetch(`${TOSS_BASE}${tossPath}${url.search}`, {
          method: req.method,
          headers,
          body: body as BodyInit | undefined,
        });

        // 토스 응답을 상태코드·본문 그대로 돌려준다(엔진의 오류 처리가 PC와 동일하게 동작).
        const text = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
          ...corsHeaders(origin),
        });
        res.end(text);
        return;
      }

      sendJson(res, 404, { error: `알 수 없는 경로입니다: ${path}` }, origin);
    } catch (e) {
      // 오류 내용만 돌려주고, 키가 담길 수 있는 요청 본문은 절대 기록하지 않는다.
      sendJson(res, 500, { error: e instanceof Error ? e.message : "알 수 없는 오류" }, origin);
    }
  });

  return new Promise((resolve, reject) => {
    // [포트가 이미 쓰이는 경우] 데스크톱 앱과 `npm run relay` 를 함께 켜면 같은 포트를 다툰다.
    //   그때 앱이 죽으면 안 되므로, 비어 있는 포트를 자동으로 하나 골라 다시 연다.
    let retried = false;
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !retried) {
        retried = true;
        server.listen(0, "127.0.0.1"); // 0 = 비어 있는 포트 아무거나
        return;
      }
      reject(err);
    });
    // 127.0.0.1 로만 연다: 같은 공유기 안의 다른 기기도 직접은 못 붙는다.
    //   외부에서는 반드시 '터널'을 거쳐야 하므로 노출 지점이 하나로 줄어든다.
    server.on("listening", () => {
      const actual = (server.address() as { port: number }).port;
      resolve({
        localUrl: `http://127.0.0.1:${actual}/r/${pass}`,
        token: pass,
        port: actual,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
    server.listen(port, "127.0.0.1");
  });
}
