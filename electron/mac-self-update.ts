// =============================================================================
// electron/mac-self-update.ts — macOS 전용 "직접 교체" 자동업데이트
// -----------------------------------------------------------------------------
// [오너 지시 원문] "개발자 등록 안 할거야 한계를 뛰어넘어 방법을 찾아라." (애플 개발자
//   계정은 연 유료라 등록하지 않는다는 전제 — Squirrel.Mac은 쓰지 말 것.)
//
// [왜 electron-updater(Squirrel.Mac)로는 안 되나]
//   electron-updater의 macOS 자동설치는 내부적으로 Squirrel.Mac을 쓰는데, 이게 "새
//   버전과 기존 설치본의 코드서명이 일치하는지"를 macOS 자체가 검증한다. 이 앱은
//   애드혹(identity: "-") 서명이라 매 빌드마다 서명 자체가 달라져(애드혹은 안정적인
//   서명 아이덴티티가 아니다) 이 검증을 원천적으로 통과할 수 없다 — 유료 인증서 없이는
//   구조적으로 막혀 있는 경로다(electron/main.ts의 checkMacDmgFallback·updateInstallStuck
//   주석 참고 — 그동안의 "dmg를 받아만 두고 사람이 직접 설치" 차선책이 나온 이유).
//
// [이 파일의 전략] macOS는 앱이 "자기 자신의 번들(.app)을 통째로 교체"하는 것 자체는
//   막지 않는다 — 막는 건 오직 Squirrel의 서명 검증뿐이다. 그래서 서명 검증이 필요한
//   경로를 아예 타지 않고 직접 교체한다:
//     1) GitHub 릴리스에서 이 아키텍처(arm64/x64)용 zip을 받는다 — electron-builder가
//        macOS 자동업데이트용으로 이미 만들어 올려 두는 파일이다(electron-builder.yml의
//        mac.target 참고, dmg가 아니라 zip인 이유는 dmg는 마운트가 필요해 프로그램이
//        조용히 다루기 어렵고 zip은 압축만 풀면 되기 때문 — 그 주석 그대로).
//     2) latest-mac.yml에 실려 있는 sha512 체크섬과 다운로드 결과를 대조해 온전한지
//        검증한다(electron-updater 자신도 쓰는 것과 같은 필드 — 새로 지어낸 검증 방식이
//        아니다).
//     3) 임시 폴더에 압축을 풀고(macOS 기본 내장 unzip) `xattr -cr`로 격리(quarantine)
//        속성을 재귀적으로 지운다(Gatekeeper가 "인터넷에서 받은 파일"이라고 매번 경고하는
//        원인 — 안 지우면 자동 교체해도 실행할 때마다 다시 경고가 뜬다).
//     4) 여기까지 전부 성공해야만 "준비 완료"로 표시한다. 하나라도 실패하면 기존 앱은
//        전혀 건드리지 않는다 — 원본은 그대로, 완전히 안전하다(prepareMacSelfUpdate는
//        무엇이 잘못되든 절대 throw하지 않고 null을 돌려준다).
//     5) 앱이 실제로 종료될 때(quit)만 분리된(detached) 셸 스크립트를 하나 띄운다. 그
//        스크립트는 이 앱 프로세스가 완전히 끝나길(kill -0 실패) 기다렸다가 — 살아있는
//        동안은 번들을 절대 건드리지 않는다 — 기존 번들을 백업 이름으로 옮기고(rename) →
//        새 번들을 제자리로 옮기고(같은 볼륨 안 mv는 원자적) → 성공하면 백업을 지우고
//        재실행한다. 두 번째 mv가 실패하면 즉시 백업에서 되돌린다 — 기존 앱이 "없어진
//        채로" 끝나는 경우가 스크립트 구조상 생기지 않는다.
// =============================================================================

import { app } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** "1.2.3" 형태의 두 버전을 비교해 a가 b보다 최신이면 true(electron/main.ts와 동일 로직). */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * 이 아키텍처(arm64/x64)에 맞는 자동업데이트용 zip 자산을 고른다.
 *
 * [universal 폴백이 왜 있나 — v0.97.0]
 *   사람이 받는 설치팩(.pkg)은 두 칩을 한 파일에 담은 universal로 바꿨다. 자동업데이트용
 *   zip은 용량 때문에 칩별로 그대로 두지만, 나중에 누군가 zip까지 universal로 바꾸면
 *   `-arm64-mac.zip`이 사라져 **자동업데이트가 조용히 멈춘다**(찾는 이름이 없으니 null →
 *   준비 실패 → 영원히 옛 버전에 머무름). 그 사고를 구조적으로 막으려고, 칩별 파일을 못
 *   찾으면 universal을 받아들인다 — universal은 어느 칩에서도 실행되므로 안전한 폴백이다.
 */
export function pickMacZipAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  const zips = assets.filter((a) => a.name.endsWith("-mac.zip"));
  const wantArm = arch === "arm64";
  const exact = zips.find((a) =>
    wantArm ? a.name.includes("-arm64") : !a.name.includes("-arm64") && !a.name.includes("-universal"),
  );
  return exact ?? zips.find((a) => a.name.includes("-universal")) ?? null;
}

/**
 * electron-builder가 만드는 latest-mac.yml에서 특정 파일명의 sha512(base64)를 뽑는다.
 * 전체 YAML을 파싱하지 않고(새 의존성을 안 늘리려고) files: 목록만 줄 단위로 훑는다 —
 * 형식은 electron-builder가 고정적으로 만드는 아래와 같은 모양이다:
 *   files:
 *     - url: Capri-0.60.0-mac.zip
 *       sha512: xxxxx==
 *       size: 123
 *     - url: Capri-0.60.0-arm64-mac.zip
 *       ...
 *   path: Capri-0.60.0-mac.zip
 *   sha512: xxxxx==   ← files: 블록 바깥(최상위, path와 짝) — 이건 무시해야 한다.
 */
export function parseLatestMacYmlSha512(ymlText: string, fileName: string): string | null {
  const lines = ymlText.split(/\r?\n/);
  let inFiles = false;
  let currentUrl: string | null = null;
  for (const raw of lines) {
    if (/^files:\s*$/.test(raw)) {
      inFiles = true;
      continue;
    }
    if (inFiles && /^\S/.test(raw)) {
      // 들여쓰기 없는 줄(예: 최상위 path:/sha512:)을 만나면 files: 블록이 끝난 것.
      inFiles = false;
    }
    if (!inFiles) continue;
    const urlMatch = raw.match(/^\s*-\s*url:\s*(.+?)\s*$/);
    if (urlMatch) {
      currentUrl = urlMatch[1];
      continue;
    }
    const shaMatch = raw.match(/^\s*sha512:\s*(.+?)\s*$/);
    if (shaMatch && currentUrl === fileName) return shaMatch[1];
  }
  return null;
}

/** 실행파일 경로에서 감싸고 있는 .app 번들 루트를 찾는다(macOS 경로는 항상 '/'). */
export function resolveAppBundleRoot(execPath: string): string | null {
  const parts = execPath.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].endsWith(".app")) return parts.slice(0, i + 1).join("/");
  }
  return null;
}

/** 파일의 sha512를 base64로(electron-builder/electron-updater와 동일 인코딩). */
export function sha512Base64OfFile(filePath: string): string {
  return createHash("sha512").update(readFileSync(filePath)).digest("base64");
}

/**
 * 앱 종료 시 실행할 교체 스크립트(순수 텍스트). 값은 스크립트에 끼워 넣지 않고 **인자로** 받는다
 * — 경로에 공백이 있어도(예: "/Users/Kail Kim/Applications/Capri.app") 안전하게 다루기 위해서다.
 *   $1 PID(끝나길 기다릴 옛 앱) · $2 기존 .app · $3 새 .app · $4 로그 파일 · $5 실패 표식 파일 · $6 새 버전
 *
 * [v0.107.0 — 2026-10-21 "재시작 창 뜬 뒤 앱이 꺼지고 다시 안 켜짐" 긴급 수정]
 *   옛 스크립트는 어느 단계든 실패하면 `exit 1`로 **조용히 끝나 버렸다** — 앱은 이미 꺼진
 *   상태라, 사용자 눈에는 "꺼지고 다시 안 켜짐"으로 보인다. 게다가 새 앱이 켜지자마자 죽어도
 *   (서명 문제 등) 백업을 이미 지운 뒤라 되돌릴 길이 없었다. 그래서 이렇게 바꿨다:
 *     ① **어떤 경우에도 마지막엔 반드시 앱을 다시 연다**(새 앱이 안 되면 옛 앱이라도).
 *     ② 교체 직후 새 앱이 20초 동안 정말 살아 있는지 확인한 **뒤에야** 백업을 지운다 —
 *        죽으면 백업으로 되돌리고 옛 앱을 연다.
 *     ③ 실패한 버전은 표식 파일에 적어 둔다 → 다음 실행이 같은 버전을 또 시도해
 *        "꺼졌다 켜졌다"를 무한 반복하지 않게(prepareMacSelfUpdate가 이 표식을 본다).
 *     ④ 설치팩(.pkg)으로 깐 앱은 관리자(root) 소유라 일반 권한으로 못 옮길 수 있다 →
 *        그때만 macOS 기본 "관리자 암호" 창으로 한 번 더 시도한다.
 *     ⑤ 모든 단계를 로그 파일(~/Library/Logs/Capri/update-swap.log)에 남긴다 — 다음에
 *        무슨 일이 있었는지 추측이 아니라 기록으로 확인하려고.
 *   테스트에서 바꿔 끼울 수 있게 open 명령과 생존 확인 시간은 환경변수로 덮어쓸 수 있다.
 */
export function buildSwapScript(): string {
  return `#!/bin/sh
# Capri 맥 자동업데이트 — 앱이 완전히 종료된 뒤에만 번들을 교체하고, 무슨 일이 있어도 앱을 다시 연다.
set -u
PID="$1"
OLD_APP="$2"
NEW_APP="$3"
LOG="$4"
FAIL_MARK="$5"
NEW_VER="$6"
OPEN_CMD="\${CAPRI_SWAP_OPEN:-open}"
ALIVE_WAIT="\${CAPRI_SWAP_ALIVE_WAIT:-20}"
BACKUP="\${OLD_APP}.capri-update-backup"

mkdir -p "$(dirname "$LOG")" 2>/dev/null
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG" 2>/dev/null; }
reopen() { log "앱 다시 열기: $1"; $OPEN_CMD "$1" >>"$LOG" 2>&1 || log "열기 실패(open 종료코드 $?)"; }
mark_failed() { log "실패 — v$NEW_VER 은(는) 자동 적용 실패로 표시(같은 버전 재시도 안 함): $1"; echo "$NEW_VER" >"$FAIL_MARK" 2>/dev/null; }
alive() { pgrep -f "$OLD_APP/Contents/MacOS/" >/dev/null 2>&1; }

log "=== 교체 시작: PID=$PID 새 버전=v$NEW_VER 기존=$OLD_APP 새 앱=$NEW_APP"

# 1) 옛 앱이 완전히 끝날 때까지 기다린다(최대 120초). 살아 있는 동안은 파일을 절대 건드리지 않는다.
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 1200 ]; then
    log "옛 앱이 120초 안에 안 꺼짐 — 교체 포기(옛 앱은 그대로 실행 중)"
    exit 1
  fi
  sleep 0.1
done
log "옛 앱 종료 확인"

if [ ! -d "$NEW_APP/Contents/MacOS" ]; then
  mark_failed "새 앱 폴더가 없음"
  reopen "$OLD_APP"
  exit 1
fi

# 2) 이름 바꿔치기. 같은 볼륨 안 mv(rename)는 원자적이라 "기존 앱 또는 새 앱 중 하나"는 항상 제자리에 있다.
#    ★ [v0.107.0 사고의 직접 원인] 설치팩(.pkg)으로 깐 앱은 관리자(root) 소유다. 첫 자동 업데이트 때
#    그 root 소유 옛 앱이 백업 이름으로 옮겨진 뒤 **일반 권한으론 못 지워져 남는다.** 그러면 두 번째
#    업데이트 때 옛 스크립트의 'mv 기존앱 백업이름'이 "이미 있는 root 폴더 안으로 넣기"가 되어 권한
#    오류로 실패 → 조용히 종료 → 앱이 꺼진 채 안 켜졌다. 그래서 지우지 못한 백업이 남아 있으면
#    겹치지 않는 새 이름(시각 붙임)을 쓴다.
rm -rf "$BACKUP" 2>/dev/null
if [ -e "$BACKUP" ]; then
  log "지우지 못한 옛 백업이 남아 있음(관리자 소유로 추정) — 새 백업 이름 사용"
  BACKUP="\${OLD_APP}.capri-update-backup-$(date +%s)"
fi
SWAPPED=0
if mv "$OLD_APP" "$BACKUP" 2>>"$LOG"; then
  if mv "$NEW_APP" "$OLD_APP" 2>>"$LOG"; then
    SWAPPED=1
  else
    log "새 앱 옮기기 실패 — 기존 앱 되돌림"
    mv "$BACKUP" "$OLD_APP" 2>>"$LOG"
  fi
fi

if [ "$SWAPPED" -ne 1 ]; then
  # 일반 권한으로 못 옮겼다(설치팩으로 깐 앱 = 관리자 소유). macOS 기본 관리자 암호 창으로 한 번만 더 시도.
  log "일반 권한 교체 실패 — 관리자 권한으로 재시도"
  ME="$(id -un)"
  /usr/bin/osascript - "$OLD_APP" "$NEW_APP" "$BACKUP" "$ME" >>"$LOG" 2>&1 <<'APPLESCRIPT'
on run argv
  set o to quoted form of item 1 of argv
  set n to quoted form of item 2 of argv
  set b to quoted form of item 3 of argv
  set u to quoted form of item 4 of argv
  do shell script "rm -rf " & b & " && mv " & o & " " & b & " && (mv " & n & " " & o & " || (mv " & b & " " & o & "; exit 1)) && chown -R " & u & " " & o & " " & b with prompt "Capri 새 버전을 설치하려면 암호가 한 번 필요합니다." with administrator privileges
end run
APPLESCRIPT
  if [ -d "$BACKUP" ] && [ -d "$OLD_APP/Contents/MacOS" ] && [ ! -d "$NEW_APP" ]; then
    SWAPPED=1
    log "관리자 권한 교체 성공"
  fi
fi

if [ "$SWAPPED" -ne 1 ]; then
  mark_failed "교체 불가(권한 등) — 기존 앱 유지"
  [ -d "$OLD_APP" ] || { [ -d "$BACKUP" ] && mv "$BACKUP" "$OLD_APP"; }
  reopen "$OLD_APP"
  exit 1
fi

# 3) 새 앱을 열고, 정말 살아 있는지 확인한 뒤에야 백업을 지운다.
log "교체 완료 — 새 앱 실행"
reopen "$OLD_APP"
sleep "$ALIVE_WAIT"
if alive; then
  log "새 앱 정상 실행 확인 — 백업 삭제, 업데이트 성공(v$NEW_VER)"
  rm -rf "$BACKUP" 2>/dev/null
  rm -f "$FAIL_MARK" 2>/dev/null
  exit 0
fi

log "새 앱이 \${ALIVE_WAIT}초 안에 꺼짐 — 옛 앱으로 되돌림"
rm -rf "$OLD_APP.capri-failed" 2>/dev/null
if mv "$OLD_APP" "$OLD_APP.capri-failed" 2>>"$LOG" && mv "$BACKUP" "$OLD_APP" 2>>"$LOG"; then
  rm -rf "$OLD_APP.capri-failed" 2>/dev/null
  log "되돌리기 완료"
else
  log "되돌리기 실패 — 남아 있는 앱을 그대로 연다"
  [ -d "$OLD_APP" ] || mv "$OLD_APP.capri-failed" "$OLD_APP" 2>>"$LOG"
fi
mark_failed "새 앱 실행 직후 종료"
reopen "$OLD_APP"
exit 1
`;
}

export interface MacUpdateReadyInfo {
  version: string;
  newAppPath: string;
  oldAppPath: string;
}

const RELEASES_BASE = "https://github.com/hun100b-dotcom/kyle-bot-releases/releases";
const LATEST_MAC_YML_URL = `${RELEASES_BASE}/latest/download/latest-mac.yml`;

/** latest-mac.yml 맨 위의 `version: 0.107.0` 줄에서 버전을 뽑는다. */
export function parseLatestMacYmlVersion(ymlText: string): string | null {
  const m = ymlText.match(/^version:\s*['"]?([0-9][0-9A-Za-z.\-]*)['"]?\s*$/m);
  return m ? m[1] : null;
}

/** latest-mac.yml의 files 목록에 있는 zip들을 "다운로드 주소가 붙은 자산"으로 바꾼다. */
export function macZipAssetsFromYml(ymlText: string, version: string): ReleaseAsset[] {
  const out: ReleaseAsset[] = [];
  for (const m of ymlText.matchAll(/^\s*-\s*url:\s*(\S+?-mac\.zip)\s*$/gm)) {
    out.push({ name: m[1], browser_download_url: `${RELEASES_BASE}/download/v${version}/${m[1]}` });
  }
  return out;
}

/** stagingDir/.ready 마커 — 30분마다 재확인할 때마다 120MB를 다시 받지 않기 위한 캐시. */
function readReadyMarker(stagingDir: string): MacUpdateReadyInfo | null {
  try {
    const raw = readFileSync(join(stagingDir, ".ready"), "utf8");
    const info = JSON.parse(raw) as MacUpdateReadyInfo;
    if (existsSync(info.newAppPath)) return info;
  } catch {
    /* 마커 없음/손상 — 새로 받는다 */
  }
  return null;
}

/**
 * 새 버전을 확인·다운로드·검증·압축해제·격리속성 제거까지 전부 끝내 "종료 시 바로
 * 교체 가능한" 상태로 만든다. 무엇이 잘못되든(네트워크·체크섬불일치·unzip 없음 등)
 * 절대 throw하지 않고 null을 돌려준다 — 실패해도 기존 앱은 원본 그대로다.
 */
export async function prepareMacSelfUpdate(currentVersion: string): Promise<MacUpdateReadyInfo | null> {
  if (process.platform !== "darwin") return null;
  try {
    const execPath = app.getPath("exe");
    const oldAppPath = resolveAppBundleRoot(execPath);
    if (!oldAppPath) {
      // 패키징되지 않은 실행(npm run app 등)이면 .app 번들 구조가 아니다 — 대상 없음.
      return null;
    }

    // [v0.107.0] 새 버전 확인은 GitHub "API"가 아니라 릴리스 파일(latest-mac.yml)을 직접 받아서 한다.
    //   API는 로그인 없이 쓰면 같은 인터넷 주소(IP)당 시간당 60번까지만 허용돼서, 회사·카페처럼
    //   여러 사람이 같은 주소를 쓰거나 30분마다 확인이 쌓이면 조용히 막혀(403) 업데이트가 멈출 수
    //   있다(실제 맥 검증 중 GitHub 러너에서 바로 이 제한에 걸렸다). 릴리스 파일 다운로드에는 그런
    //   제한이 없고, 맥 빌드가 다 올라간 뒤에만 이 파일이 생기므로 "윈도우만 먼저 올라간 반쪽
    //   릴리스"를 잘못 집을 일도 없다.
    const ymlRes = await fetch(LATEST_MAC_YML_URL);
    if (!ymlRes.ok) return null;
    const ymlText = await ymlRes.text();
    const latest = parseLatestMacYmlVersion(ymlText);
    if (!latest || !isNewerVersion(latest, currentVersion)) return null;
    // [v0.107.0] 교체 스크립트가 "이 버전은 자동 적용에 실패했다"고 적어 둔 버전이면 다시 시도하지 않는다 —
    //   같은 실패를 되풀이하며 앱이 꺼졌다 켜졌다 하는 무한 반복을 막는다(다음 새 버전은 정상 시도).
    if (readFailedVersion() === latest) return null;

    const assets = macZipAssetsFromYml(ymlText, latest);
    const zipAsset = pickMacZipAsset(assets, process.arch);
    if (!zipAsset) return null;

    const stagingDir = join(app.getPath("temp"), `capri-mac-update-${latest}`);
    const cached = readReadyMarker(stagingDir);
    if (cached) return cached; // 이미 이번 버전을 준비해 뒀다 — 재다운로드 생략

    mkdirSync(stagingDir, { recursive: true });

    const expectedSha512 = parseLatestMacYmlSha512(ymlText, zipAsset.name);
    if (!expectedSha512) return null;

    const zipPath = join(stagingDir, zipAsset.name);
    const dl = await fetch(zipAsset.browser_download_url);
    if (!dl.ok || !dl.body) return null;
    await pipeline(Readable.fromWeb(dl.body as never), createWriteStream(zipPath));

    const actualSha512 = sha512Base64OfFile(zipPath);
    if (actualSha512 !== expectedSha512) {
      console.error("[capri][mac-self-update] 체크섬 불일치 — 다운로드를 버립니다.", { expectedSha512, actualSha512 });
      rmSync(zipPath, { force: true });
      return null;
    }

    const extractDir = join(stagingDir, "extracted");
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    // [v0.107.0] 압축 풀기는 macOS 기본 도구 ditto를 먼저 쓴다 — 애플이 앱 번들(.app)용으로 권장하는
    //   방식이라 심볼릭 링크·실행 권한·확장 속성을 빠짐없이 보존한다(앱 서명이 깨지지 않게).
    //   ditto가 어떤 이유로 실패하면 예전 방식(unzip)으로 한 번 더 시도한다.
    let unzipResult = spawnSync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], { stdio: "ignore" });
    if (unzipResult.status !== 0) {
      rmSync(extractDir, { recursive: true, force: true });
      mkdirSync(extractDir, { recursive: true });
      unzipResult = spawnSync("unzip", ["-q", "-o", zipPath, "-d", extractDir], { stdio: "ignore" });
    }
    if (unzipResult.status !== 0) {
      console.error("[capri][mac-self-update] 압축 해제 실패:", unzipResult.error ?? unzipResult.status);
      return null;
    }

    const appEntry = readdirSync(extractDir).find((f) => f.endsWith(".app"));
    if (!appEntry) return null;
    const newAppPath = join(extractDir, appEntry);
    if (!existsSync(join(newAppPath, "Contents", "MacOS"))) return null; // 최소한의 구조 확인

    // 격리(quarantine) 속성 재귀 제거 — 안 지우면 교체해도 실행할 때마다 Gatekeeper 경고.
    spawnSync("/usr/bin/xattr", ["-cr", newAppPath], { stdio: "ignore" });

    // [v0.107.0] ★ 애드혹 서명을 이 맥에서 다시 찍고, 서명이 온전한지 검사한다.
    //   설치팩(.pkg)의 postinstall은 2026-10-16 사고(실행 0.4초 만에 꺼짐) 뒤로 설치할 때마다
    //   이 두 가지(xattr + 재서명)를 해 왔는데, 자동 업데이트 경로엔 재서명이 빠져 있었다.
    //   서명이 깨진 앱은 애플 실리콘에서 실행하는 순간 커널이 죽인다 → "재시작 후 안 켜짐".
    //   검사에 실패하면 교체 자체를 하지 않는다(기존 앱은 그대로, 다음 주기에 다시 받음).
    spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", newAppPath], { stdio: "ignore" });
    const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", newAppPath], { encoding: "utf8" });
    if (verify.status !== 0) {
      console.error("[capri][mac-self-update] 새 앱 서명 검사 실패 — 교체하지 않습니다:", verify.stderr);
      return null;
    }

    const ready: MacUpdateReadyInfo = { version: latest, newAppPath, oldAppPath };
    writeFileSync(join(stagingDir, ".ready"), JSON.stringify(ready), "utf8");
    console.log(`[capri][mac-self-update] 새 버전(${latest}) 준비 완료 — 앱 종료 시 자동 적용됩니다.`);
    return ready;
  } catch (err) {
    console.error("[capri][mac-self-update] 준비 실패(조용히 무시, 다음 주기에 재시도):", err);
    return null;
  }
}

/** [v0.107.0] 교체 기록(로그)·실패 표식 파일 위치. 로그는 사람이 Finder에서 찾기 쉬운 표준 위치에 둔다. */
export function swapLogPath(): string {
  return join(app.getPath("logs"), "update-swap.log");
}
function failedMarkPath(): string {
  return join(app.getPath("userData"), "mac-update-failed-version.txt");
}
function readFailedVersion(): string | null {
  try {
    return readFileSync(failedMarkPath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

let swapScheduled = false;

/**
 * 앱이 실제로 종료될 때(quit) 분리된 셸 스크립트를 띄워 번들을 교체하고 재실행한다.
 * 스크립트 자체가 "이 프로세스가 완전히 끝날 때까지" 기다리므로, 여기서는 그냥
 * 스크립트를 던져 두고(detached) 앱 종료는 평소대로 계속 진행하면 된다 — quit을
 * 가로막지 않는다.
 */
export function scheduleMacSelfUpdateSwap(ready: MacUpdateReadyInfo): void {
  if (swapScheduled) return; // 여러 번 준비돼도 종료 훅은 한 번만 건다
  swapScheduled = true;
  app.on("before-quit", () => {
    try {
      const scriptPath = join(app.getPath("temp"), "capri-mac-swap.sh");
      writeFileSync(scriptPath, buildSwapScript(), { mode: 0o755 });
      const child = spawn("/bin/sh", [scriptPath, String(process.pid), ready.oldAppPath, ready.newAppPath, swapLogPath(), failedMarkPath(), ready.version], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`[capri][mac-self-update] 종료 후 교체 스크립트를 띄웠습니다(v${ready.version}).`);
    } catch (err) {
      console.error("[capri][mac-self-update] 교체 스크립트 실행 실패(앱 종료는 정상 진행):", err);
    }
  });
}
