// =============================================================================
// scripts/deploy-web.mjs  —  아이폰 웹앱(PWA)을 인터넷에 올리는 배포 스크립트
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   dist-web/ (빌드된 웹앱)을 **공개 저장소 capri-web** 에 통째로 올리고,
//   GitHub Pages 를 켜서 https 주소를 만든다. 아이폰 사파리로 그 주소에 들어가
//   "홈 화면에 추가" 하면 앱처럼 쓸 수 있다.
//
// [왜 GitHub Pages 인가?]
//   이 PC에는 GitHub 자격증명이 이미 있어 **오늘 바로** 올릴 수 있기 때문이다.
//   (Vercel 은 로그인이 안 돼 있어 사람이 `npx vercel login` 을 한 번 해야 한다.
//    시세·환율 자동조회 같은 '서버가 필요한 기능'은 그때 Vercel 로 옮긴다 — README-web.md)
//
// [주의] Pages 는 **공개 사이트**다. 그래서 이 웹앱에는 키·계좌번호를 넣지 않는다.
//        지금 올라가는 것은 계산기·장 상태뿐이며, 설정값은 폰 안에만 저장된다.
//
// [사용법] npm run web:deploy   (npm run web:build 를 먼저 자동 실행)
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");
const OWNER = "hun100b-dotcom";
const REPO = "capri-web"; // 웹앱 전용 공개 저장소(소스 레포 kyle-bot 은 private 유지)

// ---- 토큰 찾기 (값은 절대 화면에 찍지 않는다) --------------------------------
function findToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (t) return t;
  } catch {
    /* gh 미로그인 → 다음 후보 */
  }
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error("GitHub 자격증명을 찾지 못했습니다. `gh auth login` 을 실행해 주세요.");
  return m[1].trim();
}

async function api(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
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
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("✖ dist-web/ 이 없습니다. 먼저 `npm run web:build` 를 실행하세요.");
    process.exit(1);
  }
  // 서비스 워커가 빠지면 자동 업데이트가 동작하지 않는다 → 배포 전에 확인.
  for (const must of ["sw.js", "manifest.webmanifest", "icons/icon-192.png"]) {
    if (!existsSync(join(DIST, must))) {
      console.error(`✖ dist-web/${must} 이 없습니다(PWA 필수 파일). 빌드를 다시 하세요.`);
      process.exit(1);
    }
  }

  const token = findToken();

  // ① 저장소가 없으면 만든다(공개 — Pages 가 공개 저장소에서만 무료로 동작).
  const repo = await api(token, `/repos/${OWNER}/${REPO}`);
  if (repo.status === 404) {
    const created = await api(token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: REPO,
        description: "Capri 웹앱(PWA) — 아이폰 홈 화면에 추가해 쓰는 계산기. 빌드 결과만 올라갑니다.",
        private: false, // GitHub Pages 무료 사용 조건
        has_issues: false,
        has_wiki: false,
        auto_init: false,
      }),
    });
    if (created.status !== 201) {
      console.error("✖ 저장소 생성 실패", created.status, created.body);
      process.exit(1);
    }
    console.log(`저장소 새로 만듦: ${created.body.html_url}`);
  } else if (repo.status === 200) {
    console.log(`기존 저장소 사용: ${repo.body.html_url}`);
  } else {
    console.error("✖ 저장소 조회 실패", repo.status, repo.body);
    process.exit(1);
  }

  // ② dist-web 내용을 통째로 밀어 넣는다(웹앱은 '지금 상태'만 있으면 되므로 강제 덮어쓰기).
  const work = mkdtempSync(join(tmpdir(), "capri-web-"));
  try {
    cpSync(DIST, work, { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("checkout", "-q", "-B", "main");
    git("add", "-A");
    git("-c", "user.name=capri-deploy", "-c", "user.email=noreply@example.com", "commit", "-q", "-m", `웹앱 배포 ${new Date().toISOString()}`);
    // 토큰은 원격 주소에 담아 쓰고, 화면에는 절대 출력하지 않는다.
    git("remote", "add", "origin", `https://x-access-token:${token}@github.com/${OWNER}/${REPO}.git`);
    git("push", "-q", "--force", "origin", "main");
    console.log("웹앱 파일 업로드 완료");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // ③ GitHub Pages 켜기(이미 켜져 있으면 그대로 둔다)
  const pages = await api(token, `/repos/${OWNER}/${REPO}/pages`);
  if (pages.status === 404) {
    const on = await api(token, `/repos/${OWNER}/${REPO}/pages`, {
      method: "POST",
      body: JSON.stringify({ source: { branch: "main", path: "/" } }),
    });
    if (on.status !== 201 && on.status !== 409) {
      console.error("⚠ Pages 자동 활성화 실패", on.status, on.body);
      console.error(`   저장소 Settings → Pages 에서 'main / (root)' 로 한 번만 켜 주세요.`);
    } else {
      console.log("GitHub Pages 활성화됨");
    }
  }

  const url = `https://${OWNER}.github.io/${REPO}/`;
  console.log(`\n웹앱 주소: ${url}`);
  console.log("(처음 켠 뒤 1~2분 정도 지나야 페이지가 실제로 뜹니다)");
}

main().catch((e) => {
  console.error("✖ 배포 중 오류", e.message ?? e);
  process.exit(1);
});
