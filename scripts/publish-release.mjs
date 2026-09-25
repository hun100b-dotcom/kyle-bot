// =============================================================================
// scripts/publish-release.mjs  —  빌드 결과물을 GitHub 릴리스에 올리는 배포 스크립트
// -----------------------------------------------------------------------------
// [왜 만들었나? — 반복된 사고 3가지를 코드로 막는다]
//   ① electron-builder 의 `--publish always` 가 latest.yml 업로드에서 422 오류를 내는 일이
//      네 번 연속 재발했습니다. 그때마다 사람이 latest.yml 을 손으로 만들어 올렸는데,
//      **latest.yml 이 안 올라가면 사장님 앱에 "업데이트 있음" 팝업이 아예 안 뜹니다.**
//   ② 파일 이름에 공백이 있으면(`Capri Setup 0.8.4.exe`) GitHub 자산 이름은 하이픈으로
//      바뀝니다. latest.yml 이 가리키는 이름과 실제 자산 이름이 다르면 업데이트가 깨집니다.
//   ③ 맥(dmg/zip)은 latest-mac.yml 이 따로 필요합니다. 빠뜨리기 쉽습니다.
//
//   그래서 이 스크립트는 **latest.yml / latest-mac.yml 이 가리키는 파일을 기준으로**
//   올릴 목록을 정하고, 이름을 자산 규칙에 맞춰 바꿔 올리고, 마지막에 다시 내려받아
//   검증까지 합니다. 사람이 기억할 일을 없앱니다.
//
// [토큰은 어디서 오나?]  아래 순서로 자동으로 찾습니다(값은 절대 화면에 찍지 않습니다).
//   1) 환경변수 GH_TOKEN / GITHUB_TOKEN
//   2) `gh auth token` (GitHub CLI 로그인 상태)
//   3) `git credential fill` (이 PC에 저장된 git 자격증명 — 푸시가 되면 이것도 됩니다)
//
// [사용법]
//   node scripts/publish-release.mjs             # 이번 버전 배포(빌드 산출물 필요)
//   node scripts/publish-release.mjs --dry-run   # 올리지 않고 무엇을 올릴지만 확인
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = join(ROOT, "release");
const OWNER = "hun100b-dotcom";
const REPO = "kyle-bot-releases"; // 바이너리 전용 공개 레포(소스 레포는 private 유지)
const DRY = process.argv.includes("--dry-run");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

// -----------------------------------------------------------------------------
// 1) 토큰 찾기
// -----------------------------------------------------------------------------
function findToken() {
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, from: "환경변수 GH_TOKEN" };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: "환경변수 GITHUB_TOKEN" };
  try {
    const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (t) return { token: t, from: "gh auth token(GitHub CLI 로그인)" };
  } catch {
    /* gh 미설치·미로그인 → 다음 후보로 */
  }
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const m = out.match(/^password=(.*)$/m);
    if (m && m[1]) return { token: m[1].trim(), from: "git 자격증명 저장소" };
  } catch {
    /* 저장된 자격증명 없음 */
  }
  return null;
}

// -----------------------------------------------------------------------------
// 2) 올릴 파일 목록 만들기 — latest*.yml 이 '진실의 원천'
// -----------------------------------------------------------------------------
/** yml 안의 `url:` / `path:` 값들을 모아 자산 이름 목록으로 만든다(중복 제거) */
function assetNamesFromYml(ymlText) {
  const names = new Set();
  for (const m of ymlText.matchAll(/^\s*(?:-\s*)?(?:url|path):\s*(.+)$/gm)) {
    names.add(m[1].trim().replace(/^["']|["']$/g, ""));
  }
  return [...names];
}

/**
 * 자산 이름(하이픈 표기)에 해당하는 실제 파일을 release/ 에서 찾는다.
 *   electron-builder 는 파일을 `Capri Setup 0.8.4.exe`(공백)로 만들지만
 *   latest.yml 에는 `Capri-Setup-0.8.4.exe`(하이픈)로 적는다. GitHub 자산 이름 규칙 때문.
 */
function findLocalFile(assetName) {
  const direct = join(RELEASE_DIR, assetName);
  if (existsSync(direct)) return direct;
  const spaced = join(RELEASE_DIR, assetName.replace(/-/g, " "));
  if (existsSync(spaced)) return spaced;
  // 마지막 수단: 하이픈/공백 차이를 무시하고 비교
  const norm = (s) => s.replace(/[-\s]+/g, " ").toLowerCase();
  for (const f of readdirSync(RELEASE_DIR)) {
    if (norm(f) === norm(assetName)) return join(RELEASE_DIR, f);
  }
  return null;
}

function collectAssets() {
  const assets = []; // { name, file }
  for (const yml of ["latest.yml", "latest-mac.yml"]) {
    const ymlPath = join(RELEASE_DIR, yml);
    if (!existsSync(ymlPath)) continue;
    const text = readFileSync(ymlPath, "utf8");

    // ① yml 이 가리키는 설치/업데이트 파일들
    for (const name of assetNamesFromYml(text)) {
      const file = findLocalFile(name);
      if (!file) {
        console.warn(`⚠ ${yml} 이 가리키는 ${name} 을(를) release/ 에서 못 찾음 — 건너뜀`);
        continue;
      }
      if (!assets.some((a) => a.name === name)) assets.push({ name, file });
      // ② blockmap(차등 업데이트용)이 있으면 함께
      const bm = findLocalFile(`${name}.blockmap`);
      if (bm && !assets.some((a) => a.name === `${name}.blockmap`)) {
        assets.push({ name: `${name}.blockmap`, file: bm });
      }
    }
    // ③ yml 자체(이게 없으면 업데이트 팝업이 안 뜬다 — 가장 중요한 파일)
    assets.push({ name: yml, file: ymlPath });
  }
  return assets;
}

// -----------------------------------------------------------------------------
// 3) GitHub API 도우미
// -----------------------------------------------------------------------------
async function api(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // [수정] 요청 바디가 JSON 문자열인데 Content-Type을 안 붙이면, 이 요청을 중계하는
      // 프록시(정책 검사를 위해 바디를 읽어야 함)가 415로 거부한다 — 실제 파일 업로드(바이너리
      // octet-stream)는 아래 uploadAsset()이 자기 헤더로 덮어써서 영향 없다.
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function main() {
  console.log(`\n=== Capri 릴리스 배포: ${TAG} ===`);

  const assets = collectAssets();
  if (assets.length === 0) {
    console.error(`✖ release/ 에 올릴 것이 없습니다. 먼저 빌드하세요(npm run dist:win 또는 dist:mac).`);
    process.exit(1);
  }
  console.log("올릴 파일:");
  for (const a of assets) console.log(`  · ${a.name}`);

  // 안전장치: 산출물 버전이 package.json 버전과 다르면 중단(옛 파일 잘못 올리는 사고 방지)
  const wrong = assets.filter((a) => /\d+\.\d+\.\d+/.test(a.name) && !a.name.includes(VERSION));
  if (wrong.length) {
    console.error(`✖ 버전이 안 맞는 산출물이 섞였습니다(package.json=${VERSION}): ${wrong.map((w) => w.name).join(", ")}`);
    console.error(`   release/ 의 옛 파일을 지우거나 다시 빌드하세요.`);
    process.exit(1);
  }

  if (DRY) {
    console.log("\n(--dry-run) 실제 업로드는 하지 않았습니다.");
    const t = findToken();
    console.log(t ? `토큰 확보 경로: ${t.from}` : "⚠ 토큰을 못 찾음 — GH_TOKEN 설정 또는 gh auth login 필요");
    return;
  }

  const found = findToken();
  if (!found) {
    console.error("✖ GitHub 토큰을 찾지 못했습니다. `gh auth login` 하거나 GH_TOKEN 을 설정하세요.");
    process.exit(1);
  }
  const { token, from } = found;
  console.log(`\n토큰 확보(${from}).`);

  // ① 이미 있는 릴리스면 재사용, 없으면 생성
  let rel = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (rel.status === 404) {
    rel = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: TAG,
        name: `Capri ${TAG}`,
        body: `Capri ${VERSION} 배포`,
        draft: false,
        prerelease: false,
      }),
    });
    if (rel.status !== 201) {
      console.error("✖ 릴리스 생성 실패", rel.status, rel.body);
      process.exit(1);
    }
    console.log(`릴리스 새로 만듦: ${rel.body.html_url}`);
  } else if (rel.status === 200) {
    console.log(`기존 릴리스 재사용: ${rel.body.html_url}`);
  } else {
    console.error("✖ 릴리스 조회 실패", rel.status, rel.body);
    process.exit(1);
  }

  const relId = rel.body.id;

  // ② 같은 이름 자산이 이미 있으면 지우고 다시 올린다(재배포 시 덮어쓰기)
  const existing = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/releases/${relId}/assets?per_page=100`);
  for (const a of assets) {
    const dup = Array.isArray(existing.body) ? existing.body.find((e) => e.name === a.name) : null;
    if (dup) {
      await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${dup.id}`, { method: "DELETE" });
      console.log(`  (기존 ${a.name} 삭제 후 재업로드)`);
    }
    const data = readFileSync(a.file);
    const res = await fetch(
      `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${relId}/assets?name=${encodeURIComponent(a.name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": a.name.endsWith(".yml") ? "text/yaml" : "application/octet-stream",
          "Content-Length": String(data.length),
        },
        body: data,
      },
    );
    console.log(`  ↑ ${a.name} → HTTP ${res.status}`);
    if (res.status !== 201) {
      console.error("✖ 업로드 실패", await res.text());
      process.exit(1);
    }
  }

  // ③ 검증: 공개된 latest*.yml 을 다시 내려받아 로컬과 같은지 확인
  //    (이게 어긋나면 자동 업데이트가 조용히 안 뜬다 — 과거에 실제로 겪은 사고)
  //
  //    [주의] 방금 올린 직후에는 GitHub CDN이 **이전 파일을 잠깐 더 내려준다**(캐시).
  //    그래서 한 번 다르다고 바로 실패로 보면 안 된다. 캐시 무력화 쿼리를 붙여 몇 번 다시 본다.
  for (const yml of ["latest.yml", "latest-mac.yml"]) {
    const local = join(RELEASE_DIR, yml);
    if (!existsSync(local)) continue;
    const want = readFileSync(local, "utf8").trim();

    let same = false;
    for (let attempt = 1; attempt <= 6 && !same; attempt++) {
      const res = await fetch(
        `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${yml}?cb=${attempt}-${process.pid}`,
        { redirect: "follow", headers: { "Cache-Control": "no-cache" } },
      );
      same = (await res.text()).trim() === want;
      if (!same && attempt < 6) await new Promise((r) => setTimeout(r, 3000)); // CDN 반영 대기
    }
    console.log(`검증 ${yml}: ${same ? "로컬과 동일 ✅" : "❌ 내용이 다름 — 릴리스 페이지에서 직접 확인 필요"}`);
    if (!same) process.exitCode = 1;
  }

  console.log(`\n완료: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
}

main().catch((e) => {
  console.error("✖ 배포 중 오류", e);
  process.exit(1);
});
