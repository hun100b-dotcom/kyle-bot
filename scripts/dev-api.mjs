// =============================================================================
// scripts/dev-api.mjs — Vercel 서버리스 함수를 '내 PC에서' 그대로 돌려 보는 도우미
// -----------------------------------------------------------------------------
// [왜?] Vercel 배포 전에, 프록시 코드가 진짜 토스와 대화하는지 확인하려면
//       똑같은 핸들러를 로컬에서 띄워 보면 된다. 배포용 코드는 한 글자도 바꾸지 않는다.
//   실행: npx tsx scripts/dev-api.mjs   → http://localhost:8787
// =============================================================================

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(ROOT, "deploy", "capri-api", "api");
const PORT = 8787;

const handlers = new Map();
for (const name of ["quote", "fx", "health"]) {
  const mod = await import(pathToFileURL(join(API_DIR, `${name}.ts`)).href);
  handlers.set(`/api/${name}`, mod.default);
}

/** 설치된 카프리(.env)에서 키를 읽는다 — 로컬 시험 전용 */
function localKeys() {
  const envPath = `${process.env.APPDATA}/kyle-bot/.env`;
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    out[t.slice(0, t.indexOf("=")).trim()] = t.slice(t.indexOf("=") + 1).trim();
  }
  return out;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = handlers.get(url.pathname);
  if (!handler) {
    res.writeHead(404).end("no such endpoint");
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = chunks.length ? Buffer.concat(chunks) : undefined;

  // [로컬 시험 전용] clientId 가 "USE_LOCAL_ENV" 면 이 PC에 설치된 카프리의 키로 바꿔 넣는다.
  //   왜? 브라우저에서 전 구간(화면 → 프록시 → 토스)을 시험할 때
  //   **실제 키를 화면이나 기록에 남기지 않기 위해서**다.
  //   이 편의 기능은 배포되는 deploy/capri-api/ 안에는 없다(로컬 도우미 전용).
  if (body && body.includes("USE_LOCAL_ENV")) {
    const env = localKeys();
    const parsed = JSON.parse(body.toString("utf8"));
    parsed.clientId = env.TOSS_CLIENT_ID;
    parsed.clientSecret = env.TOSS_CLIENT_SECRET;
    body = Buffer.from(JSON.stringify(parsed));
    console.log("[로컬 전용] 설치본 키로 치환해 토스 호출");
  }

  // node 요청 → 표준 Request 로 변환(서버리스 환경과 같은 모양으로 넘긴다)
  const request = new Request(url, { method: req.method, headers: req.headers, body });
  const out = await handler(request);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`로컬 API 실행: http://localhost:${PORT} (/api/health, /api/fx, /api/quote)`));
