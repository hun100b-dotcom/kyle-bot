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

/** 이 아키텍처(arm64/x64)에 맞는 자동업데이트용 zip 자산을 고른다. */
export function pickMacZipAsset(assets: ReleaseAsset[], arch: string): ReleaseAsset | null {
  const wantArm = arch === "arm64";
  return (
    assets.find((a) => a.name.endsWith("-mac.zip") && (wantArm ? a.name.includes("-arm64") : !a.name.includes("-arm64"))) ?? null
  );
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
 * 앱 종료 시 실행할 교체 스크립트(순수 텍스트 — $1 PID, $2 기존 .app, $3 새 .app을
 * 인자로 받는다. 값을 스크립트 문자열에 직접 끼워 넣지 않고 인자로 넘기는 이유는 경로에
 * 공백이 있어도(예: "/Users/Kail Kim/Applications/Capri.app") 안전하게 다루기 위해서다).
 */
export function buildSwapScript(): string {
  return `#!/bin/sh
# Capri 맥 자동업데이트 — 앱이 완전히 종료된 뒤에만 번들을 교체한다.
set -u
PID="$1"
OLD_APP="$2"
NEW_APP="$3"

# 1) 기존 프로세스가 완전히 끝날 때까지 기다린다(최대 30초, 0.1초 간격 확인).
#    살아있는 동안은 아래 어떤 파일 작업도 하지 않는다 — 실행 중 번들 교체 금지.
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 300 ]; then
    exit 1
  fi
  sleep 0.1
done

# 2) 이름 바꿔치기로 교체한다. 같은 볼륨 안의 mv(rename)는 원자적이라, 두 mv 사이의
#    아주 짧은 순간을 빼면 "기존 앱 또는 새 앱 중 하나"는 항상 제자리에 있다.
BACKUP="\${OLD_APP}.capri-update-backup"
rm -rf "$BACKUP"
if ! mv "$OLD_APP" "$BACKUP"; then
  # 기존 앱을 백업 이름으로도 못 옮겼으면 아무것도 건드리지 않은 것과 같다 — 그대로 중단.
  exit 1
fi
if ! mv "$NEW_APP" "$OLD_APP"; then
  # 새 앱으로 못 옮겼으면 반드시 기존 앱을 되돌린다 — 자리가 빈 채로 끝나면 안 된다.
  mv "$BACKUP" "$OLD_APP"
  exit 1
fi
rm -rf "$BACKUP"

# 3) 다시 연다.
open "$OLD_APP"
exit 0
`;
}

export interface MacUpdateReadyInfo {
  version: string;
  newAppPath: string;
  oldAppPath: string;
}

const RELEASES_LATEST_API = "https://api.github.com/repos/hun100b-dotcom/kyle-bot-releases/releases/latest";

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

    const res = await fetch(RELEASES_LATEST_API);
    if (!res.ok) return null;
    const rel = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
    const latest = String(rel.tag_name ?? "").replace(/^v/, "");
    if (!latest || !isNewerVersion(latest, currentVersion)) return null;

    const assets = rel.assets ?? [];
    const zipAsset = pickMacZipAsset(assets, process.arch);
    const ymlAsset = assets.find((a) => a.name === "latest-mac.yml");
    if (!zipAsset || !ymlAsset) return null;

    const stagingDir = join(app.getPath("temp"), `capri-mac-update-${latest}`);
    const cached = readReadyMarker(stagingDir);
    if (cached) return cached; // 이미 이번 버전을 준비해 뒀다 — 재다운로드 생략

    mkdirSync(stagingDir, { recursive: true });

    const ymlRes = await fetch(ymlAsset.browser_download_url);
    if (!ymlRes.ok) return null;
    const ymlText = await ymlRes.text();
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
    const unzipResult = spawnSync("unzip", ["-q", "-o", zipPath, "-d", extractDir], { stdio: "ignore" });
    if (unzipResult.status !== 0) {
      console.error("[capri][mac-self-update] 압축 해제 실패:", unzipResult.error ?? unzipResult.status);
      return null;
    }

    const appEntry = readdirSync(extractDir).find((f) => f.endsWith(".app"));
    if (!appEntry) return null;
    const newAppPath = join(extractDir, appEntry);
    if (!existsSync(join(newAppPath, "Contents", "MacOS"))) return null; // 최소한의 구조 확인

    // 격리(quarantine) 속성 재귀 제거 — 안 지우면 교체해도 실행할 때마다 Gatekeeper 경고.
    spawnSync("xattr", ["-cr", newAppPath], { stdio: "ignore" });

    const ready: MacUpdateReadyInfo = { version: latest, newAppPath, oldAppPath };
    writeFileSync(join(stagingDir, ".ready"), JSON.stringify(ready), "utf8");
    console.log(`[capri][mac-self-update] 새 버전(${latest}) 준비 완료 — 앱 종료 시 자동 적용됩니다.`);
    return ready;
  } catch (err) {
    console.error("[capri][mac-self-update] 준비 실패(조용히 무시, 다음 주기에 재시도):", err);
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
      const child = spawn("/bin/sh", [scriptPath, String(process.pid), ready.oldAppPath, ready.newAppPath], {
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
