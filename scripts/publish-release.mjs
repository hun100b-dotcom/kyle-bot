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
      // ② [v0.97.0] blockmap 업로드 중단 — 릴리스 페이지에서 "쓸모없는 파일"의 주범이었다.
      //   blockmap은 "차등 업데이트"(달라진 조각만 내려받기) 전용 파일인데, 우리는 그 기능을
      //   electron/main.ts의 `autoUpdater.disableDifferentialDownload = true` 로 **이미 꺼 뒀다**
      //   (v0.27.1 — 서명 인증서가 없는 조합에서 차등 다운로드가 실패하는 사고가 반복돼 끈 것).
      //   즉 아무도 안 쓰는 파일이 매 배포마다 4~6개씩 쌓여 사람이 받을 파일을 가리고 있었다.
    }
    // ③ yml 자체(이게 없으면 업데이트 팝업이 안 뜬다 — 가장 중요한 파일)
    assets.push({ name: yml, file: ymlPath });
  }

  // ④ [v0.97.0] 맥 올인원 설치팩(.pkg) — latest-mac.yml은 "자동 업데이트용 zip"만 가리키므로
  //   사람이 받는 이 파일은 yml을 아무리 뒤져도 안 나온다. 여기서 직접 집어넣지 않으면
  //   **릴리스에 아예 안 올라가서 신규 팀원이 받을 파일이 없어진다.** (dmg 시절에는 dmg가
  //   latest-mac.yml에 실려 자동으로 따라 올라갔기 때문에 이 처리가 필요 없었다.)
  for (const f of readdirSync(RELEASE_DIR)) {
    if (f.endsWith(".pkg") && !assets.some((a) => a.name === f)) {
      assets.push({ name: f, file: join(RELEASE_DIR, f) });
    }
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

// -----------------------------------------------------------------------------
// 3-1) [v0.102.1] 릴리스 파일 교체(삭제 확인 → 업로드 → 충돌 시 재시도) — 같은 버전을 다시 배포해도 성공하게 하는 장치
// -----------------------------------------------------------------------------
const GONE_POLLS = 8; // 삭제가 반영됐는지 목록을 다시 보는 최대 횟수
const GONE_WAIT_MS = 2000; // 확인 사이 대기(2초) → 한 번의 삭제 확인은 최대 약 16초
const UPLOAD_TRIES = 3; // 업로드 최대 시도 횟수(처음 1번 + 충돌 재시도 2번)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 릴리스에 지금 올라가 있는 파일 목록(이름·번호). 조회 실패 시 null. */
async function listAssets(token, relId) {
  const r = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/releases/${relId}/assets?per_page=100`);
  return r.status === 200 && Array.isArray(r.body) ? r.body : null;
}

/** 같은 이름의 파일을 모두 지우고, 목록에서 정말 사라질 때까지 기다린다(상한 있음). 사라졌으면 true. */
async function deleteAndConfirmGone(token, relId, name) {
  const list = await listAssets(token, relId);
  const dups = (list ?? []).filter((e) => e.name === name);
  if (dups.length === 0) return true; // 지울 게 없음
  for (const d of dups) {
    const del = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${d.id}`, { method: "DELETE" });
    // 204=삭제됨, 404=이미 없음(둘 다 목적 달성). 그 외는 실패이므로 기록만 하고 아래 확인 단계가 최종 판단한다.
    console.log(`  (기존 ${name} 삭제 요청 → HTTP ${del.status})`);
  }
  for (let i = 1; i <= GONE_POLLS; i++) {
    const now = await listAssets(token, relId);
    if (now && !now.some((e) => e.name === name)) {
      console.log(`  (기존 ${name} 삭제 확인됨${i > 1 ? ` — ${i}번째 확인에서` : ""})`);
      return true;
    }
    console.log(`  (기존 ${name} 아직 목록에 남아 있음 — ${GONE_WAIT_MS / 1000}초 기다림 ${i}/${GONE_POLLS})`);
    await sleep(GONE_WAIT_MS);
  }
  return false;
}

/** 파일 한 개를 안전하게 교체 업로드한다. 성공하면 true. */
async function replaceAsset(token, relId, a) {
  const data = readFileSync(a.file);
  for (let attempt = 1; attempt <= UPLOAD_TRIES; attempt++) {
    const gone = await deleteAndConfirmGone(token, relId, a.name);
    if (!gone) console.log(`  ⚠ ${a.name}: 삭제 확인이 끝내 안 됐지만 업로드를 시도합니다(시도 ${attempt}/${UPLOAD_TRIES}).`);
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
    console.log(`  ↑ ${a.name} → HTTP ${res.status}${attempt > 1 ? ` (재시도 ${attempt}/${UPLOAD_TRIES})` : ""}`);
    if (res.status === 201) return true;
    const text = await res.text();
    const retryable = (res.status === 422 && text.includes("already_exists")) || res.status >= 500;
    if (!retryable || attempt === UPLOAD_TRIES) {
      console.error(`✖ 업로드 실패 (${a.name}, 시도 ${attempt}/${UPLOAD_TRIES})`, text);
      return false;
    }
    console.log(`  ↻ ${a.name}: ${res.status === 422 ? "같은 이름이 아직 남아 있음(already_exists)" : "서버 일시 오류"} → ${attempt * 3}초 뒤 지우고 다시 올립니다.`);
    await sleep(attempt * 3000);
  }
  return false;
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
        // [v0.97.0] 릴리스 노트를 "받을 파일 딱 2개"로 줄였다.
        //   예전엔 맥에서 칩(Apple Silicon/Intel)을 사람이 직접 골라야 해서 안내가 길었고,
        //   그마저도 잘못 고르는 사고가 났다. 이제 맥은 두 칩을 한 파일에 담은 universal
        //   설치팩(.pkg) 하나뿐이라 고를 일이 없다. 나머지 파일(-mac.zip, latest*.yml)은
        //   앱이 자동 업데이트할 때 쓰는 것이라 사람은 건드릴 필요가 없다 — 그렇게 적어 둔다.
        body: [
          `Capri ${VERSION} 배포`,
          "",
          "### 받을 파일은 이것 하나뿐입니다",
          "",
          "| 쓰는 컴퓨터 | 받을 파일 |",
          "| --- | --- |",
          "| 🍎 맥 (M1·M2·M3·Intel 전부) | `Capri-" + VERSION + "-universal.pkg` |",
          "| 🪟 윈도우 | `Capri-Setup-" + VERSION + ".exe`|",
          "",
          "### 🍎 맥 설치 방법",
          "",
          "1. `.pkg` 파일을 **더블클릭**합니다.",
          "2. `Apple은 ... 악성 코드가 없음을 확인할 수 없습니다` 경고가 뜹니다 — **정상입니다**(유료 애플 인증서가 없어서 뜨는 것).",
          "   🚫 **「휴지통으로 이동」을 누르지 마세요 — 파일이 지워집니다.** **「완료」** 를 누르세요.",
          "3. **시스템 설정 → 개인정보 보호 및 보안** → 오른쪽을 **맨 아래까지 스크롤** → **보안** 항목",
          "4. `\"Capri-" + VERSION + "-universal.pkg\"은(는) ... 차단되었습니다` 옆의 **「그래도 열기」** → **「열기」** → Touch ID 또는 맥 비밀번호",
          "   (버튼이 안 보이면 `.pkg`를 한 번 더 더블클릭하고 바로 이 화면으로 오세요 — 차단 기록이 약 1시간만 남습니다.)",
          "5. 설치 프로그램이 열립니다 → **계속 → 설치 → 맥 비밀번호**. 끝입니다.",
          "",
          "**이 관문은 설치할 때 딱 한 번뿐입니다** — 설치팩이 격리 꼬리표를 지워 주므로 앱 본체는 이후 한 번도 막히지 않습니다.",
          "설치가 끝나면 응용 프로그램에 Capri가 생깁니다. 터미널을 열거나 명령어를 칠 일은 없습니다.",
          "",
          "<sub>※ macOS 14(소노마)까지 쓰던 \"우클릭 → 열기\"는 **macOS 15(세쿼이아)부터 애플이 막았습니다.** 위 시스템 설정 경로가 두 버전 모두에서 동작하는 유일한 방법입니다.</sub>",
          "",
          "<sub>나머지 파일(`-mac.zip`, `latest.yml`, `latest-mac.yml`)은 앱이 스스로 업데이트할 때 쓰는 파일입니다 — 사람이 받을 필요 없습니다.</sub>",
        ].join("\n"),
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

  // ② 같은 이름 자산이 이미 있으면 지우고 다시 올린다(재배포 시 덮어쓰기) — [v0.102.1] 멱등(몇 번을 다시 돌려도 성공)
  //
  // [왜 고쳤나] 예전엔 "삭제 요청 → 곧바로 업로드"였다. 그런데 GitHub는 삭제를 **바로 반영하지 않는 경우**가 있어서,
  //   같은 버전을 두 번째로 배포하면 "이미 같은 이름이 있다"(HTTP 422 already_exists)며 업로드가 거절됐고 배포 전체가 실패했다.
  //   (삭제 요청의 결과도 확인하지 않아서, 삭제가 실패해도 조용히 넘어갔다.)
  // [어떻게 막나] 한 파일마다 ① 지우고 → ② 목록을 다시 조회해 **정말 사라졌는지 확인**(짧게 기다리며 최대 8번(GONE_POLLS))
  //   → ③ 업로드. 그래도 422(already_exists)가 나면 **한 번 더 지우고** 다시 올린다(최대 3번, UPLOAD_TRIES).
  //   모든 대기와 재시도에 **상한**이 있어 무한히 기다리지 않는다. 로그에는 어떤 경로를 탔는지(삭제함/기다림/재시도함) 남긴다.
  for (const a of assets) {
    const ok = await replaceAsset(token, relId, a);
    if (!ok) process.exit(1);
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
