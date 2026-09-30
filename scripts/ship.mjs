// =============================================================================
// scripts/ship.mjs — "한 방 배포": 폰(웹)과 PC(설치파일)를 동시에 최신으로
// -----------------------------------------------------------------------------
// [왜 만들었나 — 사장님 지시]
//   "모든 사항 업데이트 바로바로 진행되게 해."
//   지금까지 폰(웹앱)은 자동인데 PC 설치파일은 사람이 따로 빌드·업로드해야 해서
//   **폰만 최신이고 PC는 옛 버전**인 상태가 생겼습니다. 그걸 없애는 명령입니다.
//
// [무엇을 하나 — 순서대로]
//   0) 안전 점검: 테스트·타입체크(실계좌를 다루는 앱이라 깨진 채로 배포하지 않는다)
//   1) 버전 올리기(0.9.0 → 0.9.1 식). --minor / --version=X.Y.Z 로 바꿀 수 있음
//   2) 웹앱 빌드 → GitHub Pages 배포        → **폰 즉시 반영**
//   3) 윈도우 설치파일(exe) 빌드 → 릴리스 게시 → **PC 자동 업데이트 팝업**
//   4) 결과 요약(폰 주소 / PC 릴리스 주소)
//
// [사용법]
//   npm run ship                    # 끝자리 버전 +1 (예: 0.9.0 → 0.9.1)
//   npm run ship -- --minor         # 가운데 버전 +1 (0.9.1 → 0.10.0)
//   npm run ship -- --version=1.0.0 # 버전 직접 지정
//   npm run ship -- --web-only      # 폰(웹)만 배포(빠름)
//   npm run ship -- --skip-tests    # 급할 때 검사 건너뛰기(권장하지 않음)
//   npm run ship -- --dry-run       # 무엇을 할지 보기만 하고 실제로는 안 함
// =============================================================================

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY = has("--dry-run");
const WEB_ONLY = has("--web-only");
const SKIP_TESTS = has("--skip-tests");

/** 명령 실행(실패하면 즉시 중단 — 반쯤 배포된 상태를 만들지 않기 위해) */
function run(cmd, cmdArgs, label) {
  console.log(`\n▶ ${label}`);
  if (DRY) {
    console.log(`   (--dry-run) 실행 안 함: ${cmd} ${cmdArgs.join(" ")}`);
    return;
  }
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`\n✖ 실패: ${label}`);
    console.error("   배포를 중단합니다(반쯤 배포된 상태를 만들지 않기 위해).");
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 0) 안전 점검
// -----------------------------------------------------------------------------
console.log("=== Capri 배포(ship) 시작 ===");
if (SKIP_TESTS) {
  console.log("⚠ 검사 건너뜀(--skip-tests) — 실계좌를 다루는 앱이라 권장하지 않습니다.");
} else {
  run("npx", ["vitest", "run"], "테스트 실행");
  run("npx", ["tsc", "-b"], "타입 검사(데스크톱)");
  run("npm", ["run", "web:check"], "타입 검사(웹앱)");
}

// -----------------------------------------------------------------------------
// 1) 버전 올리기
// -----------------------------------------------------------------------------
const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const before = pkg.version;

function nextVersion(cur) {
  const forced = valueOf("version");
  if (forced) return forced;
  const [maj, min, pat] = cur.split(".").map((n) => Number(n));
  if (has("--minor")) return `${maj}.${min + 1}.0`;
  if (has("--major")) return `${maj + 1}.0.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const after = nextVersion(before);
console.log(`\n▶ 버전: ${before} → ${after}`);
if (!DRY) {
  // JSON.stringify 로 다시 쓰면 줄바꿈·순서가 흐트러질 수 있어, 문자열만 정확히 바꾼다.
  writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").replace(`"version": "${before}"`, `"version": "${after}"`));
}

// -----------------------------------------------------------------------------
// 2) 폰(웹앱) + PC앱 원격 화면 배포
// -----------------------------------------------------------------------------
// [v0.58.0] `npm run build`(PC앱 화면, dist/)도 함께 배포한다 — deploy-web.mjs가
//   이 폴더를 /app/ 밑에 같이 올려서, PC앱이 설치파일 없이도 다음 실행 때 최신 화면을
//   받아 본다(electron/main.ts의 loadRenderer 참고). 빠뜨리면 deploy-web.mjs가 아예
//   실패한다(이미 올라가 있는 PC앱 원격 화면을 지워 버리지 않기 위한 안전장치).
run("npm", ["run", "build"], "PC앱 화면 빌드(dist/)");
run("npm", ["run", "web:build"], "웹앱 빌드");
run("node", ["scripts/deploy-web.mjs"], "배포(GitHub Pages) → 폰 즉시 반영 + PC앱 원격 화면 갱신");

// -----------------------------------------------------------------------------
// 3) PC(설치파일) 배포
// -----------------------------------------------------------------------------
if (WEB_ONLY) {
  console.log("\n▶ --web-only : PC 설치파일은 건너뜁니다.");
} else if (process.platform === "win32") {
  run("npm", ["run", "dist:win"], "윈도우 설치파일(exe) 빌드");
  run("node", ["scripts/publish-release.mjs"], "릴리스 게시 → PC 자동 업데이트 팝업");
} else if (process.platform === "darwin") {
  run("npm", ["run", "dist:mac"], "맥 설치파일(dmg+zip) 빌드");
  run("node", ["scripts/publish-release.mjs"], "릴리스 게시 → 맥 자동 업데이트");
} else {
  console.log("\n⚠ 이 컴퓨터에서는 설치파일을 만들 수 없습니다(윈도우/맥에서 실행하세요). 웹앱만 배포됨.");
}

// -----------------------------------------------------------------------------
// 4) 커밋(버전 변경분) — 사람이 따로 커밋하는 것을 잊지 않게
// -----------------------------------------------------------------------------
if (!DRY) {
  try {
    execFileSync("git", ["add", "package.json"], { cwd: ROOT });
    execFileSync("git", ["commit", "-m", `chore: v${after} 배포(폰+PC)`], { cwd: ROOT, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: ROOT, stdio: "ignore" });
    console.log(`\n▶ 버전 커밋·푸시 완료 (v${after})`);
  } catch {
    console.log("\n⚠ 버전 커밋/푸시는 건너뜀(이미 커밋됐거나 변경 없음).");
  }
}

console.log(`
==========================================================
 배포 완료 — v${after}
   · 폰(웹앱) : https://hun100b-dotcom.github.io/capri-web/
                앱을 열면 "새 버전이 준비됐습니다" 배너 → 누르면 최신
   · PC(설치) : https://github.com/hun100b-dotcom/kyle-bot-releases/releases
                Capri 앱을 켜면 업데이트 팝업이 뜹니다
==========================================================
`);
