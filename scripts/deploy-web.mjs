// =============================================================================
// scripts/deploy-web.mjs  —  아이폰 웹앱(PWA) + PC앱 원격 화면을 인터넷에 올리는 배포 스크립트
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   ① dist-web/ (빌드된 아이폰 PWA)을 저장소 루트에,
//   ② dist/     (빌드된 PC앱 화면 — vite.config.ts, Electron용)을 `/app/` 하위 폴더에
//   **공개 저장소 capri-web** 에 한 번의 커밋으로 함께 올리고, GitHub Pages 를 켜서
//   https 주소를 만든다.
//
//   [② 가 왜 필요한가 — v0.58.0] 오너 불만("업데이트 누르고 재시작 적용 누르는 게
//   번거롭다. 맥은 그 버튼조차 안 먹는다")의 근본 해법. PC앱(Electron)의 화면(React)은
//   순수 UI일 뿐 매매 엔진과의 통신은 전부 window.kyletool(로컬 IPC 다리)로만 하므로,
//   화면 파일만 여기 올려 두면 electron/main.ts가 앱을 켤 때마다 **설치파일 없이도** 이
//   최신 화면을 바로 불러온다(installer가 필요한 건 엔진(main 프로세스) 코드가 바뀐
//   드문 배포뿐). 자세한 설계 이유는 electron/main.ts의 loadRenderer() 주석 참고.
//
//   [왜 한 커밋에 같이 올리나?] 이 스크립트는 매번 저장소를 새로 밀어 넣는 방식(강제
//   푸시)이라, ①과 ②를 각각 다른 실행으로 올리면 나중 실행이 먼저 실행의 결과물을
//   통째로 지워 버린다(서로 다른 폴더인데도 작업 디렉터리 자체가 매번 새로 만들어지기
//   때문). 그래서 반드시 같은 작업 폴더에 둘 다 채운 뒤 한 번에 커밋·푸시한다.
//
// [왜 GitHub Pages 인가?]
//   이 PC에는 GitHub 자격증명이 이미 있어 **오늘 바로** 올릴 수 있기 때문이다.
//   (Vercel 은 로그인이 안 돼 있어 사람이 `npx vercel login` 을 한 번 해야 한다.
//    시세·환율 자동조회 같은 '서버가 필요한 기능'은 그때 Vercel 로 옮긴다 — README-web.md)
//
// [주의] Pages 는 **공개 사이트**다. 실제 API 키·계좌번호는 여기 올라가는 그 어떤
//   파일에도 들어있지 않다(키는 기기 저장소에만 저장 — kyletool-adapter.ts/electron/main.ts
//   참고). 폰(웹앱)이 이미 같은 전제로 실사용 중이며, PC앱 화면도 매매를 직접 하지 않고
//   로컬 IPC로만 엔진과 대화하므로 같은 신뢰 범위를 넓히는 것뿐 — 새로운 위험 종류가
//   아니다(kyle-bot-releases 배포에 쓰는 GitHub 토큰이 새면 어차피 설치파일 자체를
//   조작당할 수 있으므로, 이미 존재하는 "이 GitHub 계정이 뚫리면 위험하다"는 전제와 같다).
//
// [사용법] npm run web:deploy   (npm run build + npm run web:build 를 먼저 자동 실행)
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");
const DESKTOP_UI_DIST = join(ROOT, "dist"); // [v0.58.0] PC앱(Electron) 화면 빌드 — vite.config.ts
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

  // ② dist-web(루트) + dist(/app/, PC앱 화면) 내용을 한 작업 폴더에 함께 채운 뒤 통째로
  //   밀어 넣는다(웹앱은 '지금 상태'만 있으면 되므로 강제 덮어쓰기).
  const work = mkdtempSync(join(tmpdir(), "capri-web-"));
  try {
    cpSync(DIST, work, { recursive: true });
    // [v0.58.0] PC앱 화면(dist/)을 /app/ 하위 폴더로 함께 올린다.
    //   [중요] 이 스크립트는 매번 저장소를 '통째로 새로' 채워 강제 푸시한다(기존 git 이력을
    //   보존하지 않음) — 그래서 dist/가 없다고 조용히 건너뛰면 지금까지 올라가 있던 /app/
    //   폴더가 이번 푸시로 그대로 **삭제**돼 버린다(PC앱 사용자는 로컬 내장 화면으로
    //   자동 대체되니 앱이 멈추진 않지만, "원격 화면이 항상 최신"이라는 이번 기능의 목적
    //   자체가 조용히 무력화된다 — 소리 없이 새는 걸 막기 위해 아예 배포를 막는다).
    if (!existsSync(join(DESKTOP_UI_DIST, "index.html"))) {
      console.error("✖ dist/index.html 이 없습니다. 먼저 `npm run build` 를 실행하세요(PC앱 화면 빌드).");
      console.error("   (그냥 웹앱만 다시 올리고 싶어도, 여기서 건너뛰면 이미 올라가 있는 PC앱 원격 화면이 삭제됩니다.)");
      process.exit(1);
    }
    cpSync(DESKTOP_UI_DIST, join(work, "app"), { recursive: true });
    console.log("PC앱 화면(dist/)도 /app/ 으로 함께 올립니다.");
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
  console.log(`\n웹앱 주소(폰): ${url}`);
  console.log(`PC앱 원격 화면(참고용, 사람이 직접 열 필요 없음): ${url}app/`);
  console.log("(처음 켠 뒤 1~2분 정도 지나야 페이지가 실제로 뜹니다)");
}

main().catch((e) => {
  console.error("✖ 배포 중 오류", e.message ?? e);
  process.exit(1);
});
