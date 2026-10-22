// =============================================================================
// electron/main.ts  —  데스크톱 앱 진입점 (v2: Capri 매매도구)
// -----------------------------------------------------------------------------
// [v2 컨셉] "자율 봇" → "수동 계산기 + 온디맨드 주문 도구".
//   앱은 창을 하나 띄우고, 화면의 버튼 입력을 도구 엔진(tool-engine.ts)에
//   전달만 한다. 스스로 도는 루프(워커 틱)는 v2에서 제거됐다 — 익절/손절 감시는
//   토스 서버의 조건주문(OCO/OTO)이 대신하므로 앱이 항상 켜져 있을 필요가 없다.
//
// [보안 기본기] contextIsolation 켬 + nodeIntegration 끔.
//   화면은 preload.cjs가 허용한 창구(window.kyletool.*)로만 엔진과 대화한다.
// =============================================================================

import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { ToolEngine } from "./tool-engine";
import electronUpdater from "electron-updater";
import { prepareMacSelfUpdate, scheduleMacSelfUpdateSwap } from "./mac-self-update"; // [v0.60.0] 맥 직접교체 자동업데이트

const { autoUpdater } = electronUpdater;

// =============================================================================
// [v0.41.0 긴급 방어] 처리되지 않은 예외/거부가 앱 전체를 죽이지 않게 한다.
// -----------------------------------------------------------------------------
//   [오너 실사용 보고] "여러 사용자가 동시에 스크리너를 실행하면 다운된다." 조사 결과,
//   이 메인 프로세스(Electron main)에는 uncaughtException/unhandledRejection에 대한
//   전역 안전망이 전혀 없었다 — Node.js는 기본적으로 처리 안 된 예외·프라미스 거부가
//   생기면 프로세스 자체를 종료한다. 자동매매 사이클(autoTradeTick)은 이미 자체
//   try/catch로 감싸져 있어 안전하지만, 스크리너·시세 조회 등 다른 비동기 경로 어딘가에서
//   (특히 부하가 커지는 동시 실행·요청 한도(429) 상황에서 나타나기 쉬운 예상 못한 응답
//   모양·네트워크 순단 등으로) 단 한 곳이라도 놓친 예외가 나면 앱 전체가 조용히 죽어버릴
//   수 있었다 — "여러 사용자가 동시에 쓰면 더 잘 죽는다"는 보고와 정확히 들어맞는 취약점.
//   이제 두 이벤트를 전역으로 잡아 로그만 남기고 계속 실행한다(어떤 개별 비동기 작업이
//   실패해도 앱 자체는 살아있어야 한다는 원칙 — 자동매매 안전장치와 같은 철학).
// =============================================================================
process.on("uncaughtException", (err) => {
  console.error("[capri][uncaughtException] 처리 안 된 예외 — 앱은 계속 실행됩니다:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[capri][unhandledRejection] 처리 안 된 프라미스 거부 — 앱은 계속 실행됩니다:", reason);
});

let engine: ToolEngine | null = null;
let win: BrowserWindow | null = null;

// =============================================================================
// [v0.58.0] 화면(UI) 원격 우선 로딩 — "설치파일 없이도 화면은 항상 최신"
// -----------------------------------------------------------------------------
// [왜 만들었나] 오너 불만: "수정·배포할 때마다 윈도우·맥에서 업데이트 누르고 재시작
//   적용 누르는 게 번거롭다. 맥은 그 버튼조차 실행이 안 된다." 조사 결과 이 앱의 화면
//   (React, src/App.tsx)은 electron/tool-engine.ts(매매 엔진)를 window.kyletool 다리로만
//   부르고, 화면 코드 자체는 fetch/XHR 등 브라우저 네트워크 API를 전혀 쓰지 않는다
//   (엔진 호출은 전부 이 파일의 preload.cjs↔ipcMain 다리를 거친다 — 페이지가 어느 주소에서
//   불려왔든 이 다리는 그대로 살아있다). 즉 화면(껍데기)과 엔진(매매 로직)이 이미 분리돼
//   있다는 뜻이라, **화면만 인터넷에서 즉시 불러오면 대부분의 배포(v0.47~v0.57 이력의
//   거의 전부 — 새 탭 신설, 표시 개선, 버그 수정 등)는 설치파일을 다시 받을 필요가 아예
//   없어진다.** 앱을 껐다 켜기만 하면 그새 배포된 최신 화면이 바로 뜬다.
//
//   [이미 검증된 패턴] 이 방식은 새로 지어낸 게 아니라, 이 프로젝트가 폰(웹앱, capri-web)
//   에서 이미 실사용 중인 방식과 완전히 같다(web/kyletool-adapter.ts) — 폰은 이미 매매
//   엔진 전체가 딸린 화면을 GitHub Pages에서 통째로 불러와 쓰고 있다. PC는 그보다도 안전한
//   조합이다: 원격에서 불러오는 건 순수 화면(UI) 뿐이고, 실제 매매 엔진(계정 키·주문·
//   자동매매 루프)은 이 메인 프로세스(로컬 Node)에 그대로 남아 있어 원격 화면 쪽 코드가
//   직접 건드릴 수 없다.
//
// [오프라인/장애 대비] 원격 화면을 못 불러오면(인터넷 없음·GitHub Pages 장애 등) 5초 안에
//   포기하고 **설치파일 안에 들어있는 내장(로컬) 화면**으로 조용히 대체한다 — 이 폴백
//   덕분에 원격이 무엇이든 앱이 아예 안 뜨는 사고는 구조적으로 생기지 않는다. 원격 화면은
//   "있으면 최신, 없으면 예전 버전(설치 당시 화면)"일 뿐 필수 경로가 아니다.
//
// [preload.cjs의 window.kyletool 다리는?] contextBridge.exposeInMainWorld는 이 창의
//   webPreferences.preload로 지정되며, 이 창에 어떤 주소가 로드되든(로컬 파일이든 원격
//   https든) 항상 그대로 걸린다 — 화면 코드는 자신이 어디서 왔는지 신경 쓸 필요가 없다.
// =============================================================================
const REMOTE_UI_BASE = "https://hun100b-dotcom.github.io/capri-web/app/";

/** 원격 화면을 먼저 시도하고, 실패/시간초과(5초)면 내장(로컬) 화면으로 대체한다. */
async function loadRenderer(target: BrowserWindow): Promise<void> {
  const localIndex = join(app.getAppPath(), "dist", "index.html");
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    target.loadURL(devUrl);
    return;
  }
  // 개발 실행(npm run app)·자동 검증(KYLEBOT_SHOT/E2E)은 항상 로컬만 쓴다 — 아직 배포되지
  // 않은 로컬 수정사항을 그대로 봐야 하고, 검증 캡처는 결과가 매번 똑같아야 하기 때문.
  if (!app.isPackaged || process.env.KYLEBOT_SHOT || process.env.KYLEBOT_E2E === "1") {
    target.loadFile(localIndex);
    return;
  }

  // 캐시된 옛 화면을 계속 받는 사고를 막기 위해 매번 새 주소(캐시 무력화)로 요청한다.
  const remoteUrl = `${REMOTE_UI_BASE}index.html?t=${Date.now()}`;
  const loadedRemote = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    target.webContents.once("did-finish-load", () => finish(true));
    target.webContents.once("did-fail-load", () => finish(false));
    target.loadURL(remoteUrl).catch(() => finish(false));
    setTimeout(() => finish(false), 5000);
  });

  if (loadedRemote) {
    console.log("[capri][ui] 원격 최신 화면을 불러왔습니다:", remoteUrl);
  } else {
    console.log("[capri][ui] 원격 화면을 못 불러와 내장(로컬) 화면으로 대체합니다.");
    target.loadFile(localIndex);
  }
}

// =============================================================================
// 자동 업데이트 (electron-updater) — [v0.58.0] "사람 개입 0회" 전면 자동화
// -----------------------------------------------------------------------------
// [예전 흐름] 앱 시작 → 조용히 새 버전 확인 → 있으면 화면에 팝업 → 사용자가
//   "지금 업데이트"를 눌러야 다운로드 → "재시작하고 적용"을 또 눌러야 설치.
// [바뀐 흐름] 앱 시작(+30분마다) → 새 버전을 찾으면 **묻지 않고 바로 다운로드** →
//   다 받으면, "자동매매가 꺼져 있는" 순간을 5분마다 확인해 그때 **조용히 재시작·적용**
//   한다(quitAndInstall(true, true) — 확인창 없음). 자동매매가 켜져 있으면 무슨 일이
//   있어도 재시작하지 않는다(실계좌 매매 도중 앱이 꺼지는 사고를 막기 위한 최우선
//   안전장치이자, 이제 유일한 조건) — 그런 경우엔 다음 자연 종료(앱을 직접 끌 때,
//   autoInstallOnAppQuit) 때 적용된다.
//
// [v0.79.0 — 오너 지시로 "유휴 10분" 조건 제거] 원래는 ①자동매매 꺼짐 + ②사람이 10분
//   이상 손을 안 댐(유휴), 두 조건을 모두 만족해야 조용히 재시작했다. 그런데 오너는
//   "업데이트 받고 지금바로재시작 버튼 누르는 과정조차 사치다. 항상 자동반영해서 자동
//   다운, 업데이트 모두 자동화하라"고 명시적으로 지시했다 — 조사해보니 오너는 자동매매를
//   몇 시간씩 켜 두는 게 일상이라 ①이 좀처럼 안 풀리고, 설령 풀려도 컴퓨터를 계속
//   쓰고 있으면 ②(유휴 10분) 때문에 또 안 적용돼 결국 매번 직접 버튼을 눌러야 했던 게
//   불편의 실제 원인이었다. ②는 애초에 "화면을 보다가 갑자기 창이 재시작되면 놀라지
//   않게" 하려던 배려일 뿐 돈 안전과는 무관해서 없앤다 — ①(자동매매 중엔 절대 재시작
//   안 함)만은 실계좌 보호용 핵심 안전장치라 그대로 남긴다.
//
// [화면 표시] 버튼을 눌러야만 진행되던 팝업은 없앴다. 대신 작게 접히는 배너로 "새 버전을
//   자동으로 받고 있어요/적용 대기 중이에요"만 알리고, "지금 바로 재시작" 버튼은 급한
//   경우를 위해 선택적으로만 남겨 둔다(누르지 않아도 알아서 적용됨).
//
// [★ 안전 원칙] 업데이트 확인/다운로드가 실패해도(오프라인·서버오류 등) 앱은
//   절대 죽지 않는다 — 모든 호출을 try/catch로 감싼다.
// =============================================================================
let updateReadyToInstall = false;
let pendingUpdateVersion: string | null = null;
let restartInProgress = false;

// =============================================================================
// [v0.87.0] ★ 업데이트 적용·재시작 정책 — 오너 확정(2026-10-13, 재논의 대상 아님. CLAUDE.md "업데이트 정책" 참고)
// -----------------------------------------------------------------------------
//   자동매매가 돌고 있어도, 포지션을 보유 중이어도 업데이트를 적용하고 재시작한다(OCO는 토스 서버에 있어 앱이 꺼져도 살아 있다).
//   미루는 순간은 딱 두 곳 — ① 주문 전송 후 응답을 못 받은 구간(in-flight) ② 매수 체결 확인 ~ OCO 등록 완료 전 구간 — 둘 다 길어야
//   수 초~수십 초이고 "그 순간 죽으면 주문 상태가 깨지기 때문"이지 조심해서가 아니다. 지나가면 바로 재시작한다.
//   (v0.79.0: 유휴 조건 제거 / v0.86.0: 자동매매 조건 제거 + 자동 재개 / v0.87.0: 위 두 구간 구분 + 15초 폴링 + 맥 동일 적용 + 직전·직후 기록)
//   윈도우·맥 공통 진입점이다 — 다운로드 완료 즉시·15초마다·수동 버튼 모두 이 함수를 거친다.
// =============================================================================
async function tryApplyUpdate(source: string): Promise<{ started: boolean; reason?: string }> {
  if (!updateReadyToInstall && !macSwapReadyToInstall) return { started: false, reason: "적용할 업데이트가 아직 준비되지 않았습니다." };
  if (restartInProgress) return { started: false, reason: "이미 재시작 중입니다." };
  const decision = engine?.getRestartDecision();
  if (decision && !decision.ok) {
    const why = decision.active.map((b) => b.label).join(", ");
    console.log(`[capri][update] 재시작 보류(${source}) — 진행 중: ${why}`);
    return { started: false, reason: `진행 중인 주문 처리(${why})가 끝나는 대로 재시작합니다.` };
  }
  restartInProgress = true;
  try {
    // 재시작 직전: 새 주문을 잠시 막고(방금 확인한 안전한 순간을 지키려고), 상태 저장 + 자동매매 재개 표시 + 기록(저널·디스코드).
    engine?.setRestartFrozen(true);
    await engine?.prepareForRestart({ toVersion: pendingUpdateVersion });
    // 준비하는 몇 초 사이에 주문이 시작됐다면(드문 경우) 포기하고 다음 폴링에서 다시 시도한다.
    const again = engine?.getRestartDecision();
    if (again && !again.ok) {
      engine?.setRestartFrozen(false);
      restartInProgress = false;
      return { started: false, reason: "재시작 준비 중 주문 처리가 시작돼 잠시 더 기다립니다." };
    }
    console.log(`[capri][update] 업데이트 적용을 위해 재시작합니다(${source}).`);
    if (process.platform === "darwin") {
      app.quit(); // before-quit 훅(scheduleMacSelfUpdateSwap)이 번들 교체 후 재실행한다.
    } else {
      autoUpdater.quitAndInstall(true, true); // 확인창 없이(silent) 설치하고 곧바로 다시 실행
    }
    return { started: true };
  } catch (err) {
    console.error("[capri][update] 재시작 시도 실패(다음 폴링에서 다시 시도):", err);
    engine?.setRestartFrozen(false);
    restartInProgress = false;
    return { started: false, reason: String(err) };
  }
}

function setupAutoUpdater(): void {
  // [v0.87.0] 적용 대기 폴링 — 15초마다 두 구간(주문 in-flight, 체결~OCO 등록 전)이 비었는지 보고, 비면 바로 재시작한다.
  //   (v0.86.0까지는 5분 주기에 구간 구분 없이 재시작했다 — 체결~OCO 등록 사이에 죽을 수 있었다.)
  //   맥·윈도우 공통이라 아래 맥 조기 반환보다 먼저 건다.
  setInterval(() => {
    void tryApplyUpdate("폴링").catch(() => undefined);
  }, 15_000);

  // [v0.107.0] ★ 맥에서는 electron-updater(Squirrel.Mac)를 아예 켜지 않는다.
  //   애드혹 서명이라 Squirrel 설치는 구조적으로 실패한다(mac-self-update.ts 맨 위 주석). 그런데도
  //   켜 두면 ① 같은 120MB zip을 한 번 더 받고 ② "앱을 끌 때 자동 설치(autoInstallOnAppQuit)"가
  //   우리 교체 스크립트와 같은 순간에 Capri.app을 건드리려 할 수 있다 — 재시작 사고의 위험 요소라 끈다.
  //   맥 업데이트는 오직 runMacAutoUpdateCycle(직접 교체)만 담당한다.
  if (process.platform === "darwin") {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }

  // [v0.58.0] 묻지 않고 자동으로 받고, 앱을 끌 때는 자동으로 적용한다.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // [v0.27.1] "업데이트 다운로드에 실패했습니다" 오류 대응 — electron-updater는 기본적으로
  //   "차등 업데이트"(설치돼 있는 옛 버전과 새 버전을 비교해 달라진 부분만 내려받음)를 먼저
  //   시도한다. 이 방식은 옛 버전의 blockmap이 없거나(첫 업데이트 등) 조건이 안 맞으면 중간에
  //   실패하는 경우가 실제로 보고돼 있다(우리 앱은 서명 인증서가 없어 더 취약한 조합).
  //   용량을 좀 더 받더라도(설치파일 전체, 약 100MB) 항상 되는 전체 다운로드만 쓰도록 끈다.
  autoUpdater.disableDifferentialDownload = true;

  // 새 버전이 있을 때: 화면에 버전·변경사항을 보내 배너를 띄운다(참고용 — 다운로드는
  // 이미 자동으로 시작됐다).
  autoUpdater.on("update-available", (info) => {
    // [v0.32.3] GitHub 릴리스 노트는 electron-updater가 마크다운→HTML로 변환해 주는데,
    //   화면은 이걸 그냥 <pre>로 그대로 찍어서 "<p>...</p>" 태그가 글자 그대로 보였다
    //   (오너가 스크린샷으로 확인). 굳이 HTML로 렌더링할 필요 없는 한 줄짜리 배포 문구라,
    //   태그만 걷어내고 순수 텍스트로 보여준다.
    const rawNotes = typeof info.releaseNotes === "string" ? info.releaseNotes : "";
    const notes = rawNotes.replace(/<[^>]+>/g, "").trim();
    win?.webContents.send("update:available", {
      version: info.version,
      notes,
    });
  });

  // 다운로드 진행률(0~100)을 화면에 실시간 전달.
  autoUpdater.on("download-progress", (p) => {
    win?.webContents.send("update:progress", Math.round(p.percent));
  });

  // 다운로드 완료: 재시작 대기 상태로 기록하고, 아래 무음 재시작 타이머가 조용히 적용한다.
  autoUpdater.on("update-downloaded", (info) => {
    updateReadyToInstall = true;
    pendingUpdateVersion = info?.version ?? pendingUpdateVersion;
    win?.webContents.send("update:downloaded");
    void tryApplyUpdate("다운로드 완료"); // [v0.87.0] 기다리지 않고 바로(두 구간만 피해서)
  });

  // 오류가 나도 조용히 넘어간다(앱은 계속 동작). 화면엔 참고용으로만 알림.
  autoUpdater.on("error", (err) => {
    win?.webContents.send("update:error", String(err?.message ?? err));
  });

  // 시작 시 1회 확인. 실패해도 무시(오프라인 등).
  try {
    void autoUpdater.checkForUpdates().catch(() => {});
  } catch {
    /* 개발 실행 등에서 실패해도 앱은 정상 */
  }

  // [v0.51.0] "시작 시 1회"뿐이면, 오너가 실계좌 자동매매를 켜 둔 채 몇 시간씩 앱을 계속
  //   켜 두는 흔한 실사용 패턴에서 그 사이 나온 새 배포를 놓친다. 30분마다 조용히 재확인.
  setInterval(() => {
    try {
      void autoUpdater.checkForUpdates().catch(() => {});
    } catch {
      /* 무시 — 다음 주기에 다시 시도 */
    }
  }, 30 * 60_000);

}

// =============================================================================
// [v0.58.0] macOS 차선책 — "새 dmg 자동 다운로드 후 안내"
// -----------------------------------------------------------------------------
// [왜 필요한가] 위 electron-updater(Squirrel.Mac) 자동 적용은 유료 애플 개발자 인증서
//   (Developer ID + 공증)가 있어야만 동작한다(electron-builder.yml 참고 — 이 앱은 애드혹
//   서명이라 조건 미충족). 원격 화면(위 loadRenderer)이 대부분의 배포(화면 변경)는 이미
//   해결하지만, **메인 프로세스 코드(이 파일·preload.cjs·tool-engine.ts 등 엔진 자체)가
//   바뀐 배포는 화면만 새로 받아서는 반영되지 않는다** — 그런 드문 경우를 위한 차선책이다.
//   GitHub 릴리스 API로 최신 버전을 조용히 확인해, 새 버전이 있으면 맞는 아키텍처(Apple
//   Silicon/Intel)의 dmg를 다운로드 폴더에 미리 받아 두고, 화면에 "받아 놨어요, 눌러서
//   폴더 열기"만 알린다. Gatekeeper 우클릭→열기 한 번은 공증 없이는 여전히 피할 수
//   없다(README에 이미 안내돼 있음) — 그래도 "릴리스 페이지를 찾아가 맞는 파일을 고르는"
//   수고는 없앤다.
// =============================================================================
const RELEASES_LATEST_API = "https://api.github.com/repos/hun100b-dotcom/kyle-bot-releases/releases/latest";
let lastMacDmgPath: string | null = null;
// [v0.79.0] 직접교체 준비가 끝났는지 — 아래 "자동 재시작" 루프가 이 플래그로 판단한다.
let macSwapReadyToInstall = false;

/** "1.2.3" 형태의 두 버전을 비교해 a가 b보다 최신이면 true. */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkMacDmgFallback(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  try {
    const current = app.getVersion();
    const res = await fetch(RELEASES_LATEST_API);
    if (!res.ok) return;
    const rel = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const latest = String(rel.tag_name ?? "").replace(/^v/, "");
    if (!latest || !isNewerVersion(latest, current)) return;

    // [v0.97.0] dmg → pkg. 사람이 받는 맥 설치파일은 이제 universal 설치팩(.pkg) 하나뿐이라
    //   "내 맥이 Apple Silicon인가 Intel인가"를 따질 필요가 없어졌다(electron-builder.yml 참고).
    //   옛 릴리스에는 .pkg가 없으므로, 못 찾으면 예전 방식(칩별 dmg)으로 한 번 더 찾는다 —
    //   이 차선책은 "최신 버전을 받을 길이 아예 없어지지 않게" 하려고 있는 것이므로, 옛
    //   릴리스로 되돌아가는 상황에서도 빈손이 되면 안 된다.
    const assetList = rel.assets ?? [];
    const wantArm = process.arch === "arm64";
    const asset =
      assetList.find((a) => a.name.endsWith(".pkg")) ??
      assetList.find((a) => a.name.endsWith(".dmg") && (wantArm ? a.name.includes("-arm64") : !a.name.includes("-arm64")));
    if (!asset) return;

    const dest = join(app.getPath("downloads"), asset.name);
    if (existsSync(dest)) {
      lastMacDmgPath = dest;
      win?.webContents.send("update:macDmgReady", { version: latest, fileName: asset.name });
      return;
    }

    const dl = await fetch(asset.browser_download_url);
    if (!dl.ok || !dl.body) return;
    const buf = Buffer.from(await dl.arrayBuffer());
    writeFileSync(dest, buf);
    lastMacDmgPath = dest;
    console.log(`[capri][mac-dmg] 새 버전(${latest}) dmg를 받아 뒀습니다: ${dest}`);
    win?.webContents.send("update:macDmgReady", { version: latest, fileName: asset.name });
  } catch (err) {
    console.error("[capri][mac-dmg] 확인/다운로드 실패(조용히 무시, 다음 주기에 재시도):", err);
  }
}

// =============================================================================
// [v0.60.0] macOS 직접 교체 자동업데이트 — "한 번에 최우선"으로 먼저 시도한다.
// -----------------------------------------------------------------------------
//   위 checkMacDmgFallback(dmg를 받아만 두고 사람이 직접 설치)은 이제 "직접 교체가
//   어떤 이유로든 준비 못 했을 때"만 쓰이는 차선책으로 격하된다. 매 주기(시작 5초 후+
//   30분마다) 먼저 electron/mac-self-update.ts의 prepareMacSelfUpdate를 시도해 완전
//   자동 교체가 가능한지 보고, 준비되면 종료 훅을 걸고 화면에 알린다. 준비에 실패하면
//   (네트워크 문제·unzip 없음·체크섬 불일치 등 무엇이든) 조용히 옛 dmg 차선책으로
//   넘어간다 — 어떤 경우에도 사람이 새 버전을 받을 방법 자체가 없어지진 않는다.
//
// [v0.79.0 — "준비"와 "적용"을 분리] 예전엔 여기서 준비만 해 두고, 실제 교체는 오너가
//   버튼을 누르거나 앱을 자연스럽게 껐다 켤 때까지 기다렸다 — 그런데 오너가 "재시작
//   버튼 누르는 과정조차 사치"라고 지시해, 아래 macSwapReadyToInstall 플래그를 세워
//   두고 별도의 5분 주기 루프(whenReady 안, Windows의 무음 재시작과 동일한 패턴)가
//   "자동매매가 꺼져 있으면" 스스로 app.quit()한다 — 종료 훅(scheduleMacSelfUpdateSwap)이
//   이미 걸려 있으니 그 quit 과정에서 교체+재실행까지 알아서 끝난다.
// =============================================================================
async function runMacAutoUpdateCycle(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  try {
    const ready = await prepareMacSelfUpdate(app.getVersion());
    if (ready) {
      scheduleMacSelfUpdateSwap(ready);
      macSwapReadyToInstall = true;
      pendingUpdateVersion = ready.version; // [v0.87.0] 재시작 기록(이전→새 버전)용
      win?.webContents.send("update:macSwapReady", { version: ready.version });
      return; // 직접 교체가 준비됐으니 dmg 차선책은 필요 없다
    }
  } catch (err) {
    console.error("[capri][mac-self-update] 자동 교체 준비 사이클 실패(차선책으로 대체):", err);
  }
  await checkMacDmgFallback();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: "Capri — 토스 미국주식 매매도구",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void loadRenderer(win);

  win.on("closed", () => {
    win = null;
  });

  // [개발 검증용] KYLEBOT_SHOT=경로: 로드 후 캡처 저장하고 종료(일반 실행과 무관).
  const shotPath = process.env.KYLEBOT_SHOT;
  if (shotPath) {
    win.webContents.on("console-message", (_ev, level, message) => {
      if (level >= 2) console.log(`[화면 콘솔 ${level}] ${message}`);
    });
    win.webContents.once("did-finish-load", () => {
      setTimeout(() => runVerification(shotPath), 1500);
    });
  }
}

/**
 * [개발 검증용] KYLEBOT_E2E=1: 연습 모드로 도구 흐름을 자동 재생.
 *   시세 → 환율 → 캔들 계산 → 진입 주문 → OCO 등록 → 목록 확인 → 캡처 → 종료.
 */
async function runVerification(shotPath: string): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    if (process.env.KYLEBOT_E2E === "1" && engine) {
      console.log("[검증] E2E 시작 (도구 모드)");
      const price = await engine.quote("AAPL");
      const fx = await engine.fx();
      console.log(`[검증] 시세 $${price} / 환율 ${fx ? `${fx.rate} KRW (${fx.source})` : "실패"}`);
      const calc = engine.calc({ technique: "candle", tpPct: 2, slPct: 10, barOpen: price });
      const lv = calc.levels[0];
      console.log(`[검증] 캔들 계산: 진입 $${lv.entry} / 익절 $${lv.tp} / 손절 $${lv.sl}`);
      await engine.placeEntry({ symbol: "AAPL", price: lv.entry, quantity: 2 });
      // OCO 는 "보유 중" 가정: 익절 감시가 > 현재가 > 손절 감시가 여야 함.
      await engine.placeOco({
        symbol: "AAPL",
        quantity: 2,
        tpTrigger: lv.tp,
        tpPrice: lv.tp,
        slTrigger: lv.sl,
        slPrice: lv.sl,
        expireDate: "2026-08-16",
      });
      const conds = await engine.conditionals();
      console.log(`[검증] 조건주문 ${conds.length}건 등록 확인 (첫 건: ${conds[0]?.type} ${conds[0]?.status})`);
      await wait(1500);
    }
    const img = await win!.webContents.capturePage();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(shotPath, img.toPNG());
    console.log(`[검증] 화면 캡처 저장: ${shotPath}`);
  } catch (err) {
    console.error("[검증] 실패:", err);
  } finally {
    app.quit();
  }
}

// [v0.91.0] "폰에서 쓰기"(QR 릴레이·터널)는 오너 결정으로 삭제했다 — 폰은 로그인만으로 상태 미러·원격 명령·동기화 기록을 쓴다.
/** 화면 요청(window.kyletool.*) ↔ 엔진 연결 */
// =============================================================================
// [v0.59.0→v0.60.0] 소셜 로그인(구글만 — 카카오는 오너 요청으로 제거) 팝업 — 데스크톱 전용
// -----------------------------------------------------------------------------
// [왜 팝업인가] Supabase OAuth는 "브라우저를 그 provider(구글) 로그인 페이지로
//   보냈다가, 로그인이 끝나면 우리가 정한 주소(redirect_to)로 돌려보내며 그 주소의
//   #뒤에 access_token을 실어 준다"는 방식이다. 웹(폰)은 이걸 페이지 전체 이동으로
//   처리하면 되지만, 데스크톱 앱은 메인 화면 자체를 구글 로그인 페이지로 이동시킬 수
//   없다(원격 화면 로딩과 충돌하고, 로그인 끝나고 돌아올 곳도 마땅찮다) — 그래서 별도
//   창을 하나 띄워 그 창 안에서만 로그인을 진행하고, 우리 주소로 돌아오려는 순간(아직
//   실제로 로드되기 전에) 그 주소의 #뒤 조각만 가로채 창을 닫는다. 사용자 눈에는
//   "로그인 창이 잠깐 떴다가 자동으로 닫히고 로그인된다"로 보인다.
// [redirect_to를 왜 실제 서비스 주소(capri-web)로 하나] Supabase가 등록되지 않은
//   임의의 주소로는 리다이렉트를 허용하지 않기 때문에(Auth 설정의 허용 리다이렉트
//   목록), 이미 허용돼 있을 가능성이 매우 높은 이 프로젝트의 실제 웹앱 주소를 그대로
//   쓴다 — 실제로 그 페이지가 로드되기 전에 가로채 닫으므로 문제없다.
// =============================================================================
const OAUTH_REDIRECT_TO = "https://hun100b-dotcom.github.io/capri-web/";

function startOAuthPopup(engine: ToolEngine, provider: "google"): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      if (!popup.isDestroyed()) popup.destroy();
      resolve(result);
    };

    const popup = new BrowserWindow({
      width: 480,
      height: 640,
      parent: win ?? undefined,
      modal: false,
      title: "구글로 로그인",
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    const tryCapture = (url: string) => {
      if (!url.startsWith(OAUTH_REDIRECT_TO)) return;
      const hashIdx = url.indexOf("#");
      const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : "";
      void engine.applyOAuthCallback(fragment).then(finish);
    };

    popup.webContents.on("will-redirect", (_ev, url) => tryCapture(url));
    popup.webContents.on("will-navigate", (_ev, url) => tryCapture(url));
    popup.on("closed", () => finish({ ok: false, message: "로그인이 취소되었습니다." }));

    popup.loadURL(engine.authOAuthUrl(provider, OAUTH_REDIRECT_TO));
  });
}

function registerIpc(e: ToolEngine): void {
  ipcMain.handle("tool:status", () => e.getStatus());
  ipcMain.handle("tool:journal", () => e.getJournal());
  ipcMain.handle("tool:settings:get", () => e.getSettings());
  ipcMain.handle("tool:settings:save", (_ev, input) => e.saveSettings(input));
  ipcMain.handle("tool:settings:seed", (_ev, input) => e.saveSeedSettings(input)); // [v0.3.0] 세션 시드 설정
  ipcMain.handle("tool:settings:defaults", (_ev, input) => e.saveDefaultRatio(input)); // [v0.8.3] 기본 손익비
  ipcMain.handle("tool:sync:push", () => e.syncPushKeys()); // [v0.8.0→v0.24.0] 키 클라우드 저장(로그인 비밀번호로 암호화)
  ipcMain.handle("tool:sync:pull", () => e.syncPullKeys()); // [v0.8.0→v0.24.0] 키 클라우드 불러오기(로그인 시 자동 호출됨)
  ipcMain.handle("tool:auth:signup", (_ev, email, pw) => e.authSignUp(email, pw)); // [v0.8.1] 회원가입
  ipcMain.handle("tool:auth:signin", (_ev, email, pw) => e.authSignIn(email, pw)); // [v0.8.1] 로그인
  ipcMain.handle("tool:auth:signout", () => e.authSignOut());
  ipcMain.handle("tool:auth:status", () => e.authStatus());
  // [v0.24.0] 가입 승인 요청함 — 누구나 신청, 운영자만 조회·승인·거절.
  ipcMain.handle("tool:auth:requestAccess", (_ev, email: string, note?: string) => e.requestAccess(email, note));
  ipcMain.handle("tool:auth:listRequests", () => e.listAccessRequests());
  ipcMain.handle("tool:auth:approve", (_ev, email: string) => e.approveAccessRequest(email));
  ipcMain.handle("tool:auth:reject", (_ev, email: string) => e.rejectAccessRequest(email));
  // [v0.59.0] 로그인 게이트(capri_accounts) — 승인 대기 목록/결정 + 알림 설정 + 소셜 로그인
  ipcMain.handle("tool:auth:pendingAccounts", () => e.listPendingAccounts());
  ipcMain.handle("tool:auth:decideAccount", (_ev, userId: string, decision: "approved" | "rejected") => e.decideAccount(userId, decision));
  ipcMain.handle("tool:notify:get", () => e.getNotifySettings());
  ipcMain.handle("tool:notify:save", (_ev, url: string) => e.saveNotifySettings(url));
  // [v0.83.0] 개인용 디스코드 알림(로그인한 사람 누구나 자기 웹훅 등록)
  ipcMain.handle("tool:notify:getMine", () => e.getMyNotifySettings());
  ipcMain.handle("tool:toss:testConnection", () => e.testTossConnection()); // [v0.91.0] 튜토리얼 연결 테스트
  ipcMain.handle("tool:notify:testMine", () => e.sendMyDiscordTest()); //        [v0.91.0] 튜토리얼 디스코드 테스트
  ipcMain.handle("tool:notify:saveMine", (_ev, url: string) => e.saveMyNotifySettings(url));
  // [v0.109.0] 오너 공지 → 팀원 디스코드 웹훅(서버 함수가 대신 발송)
  ipcMain.handle("tool:announce:send", (_ev, title: string, body: string) => e.sendAnnouncement(title, body));
  ipcMain.handle("tool:announce:list", () => e.listAnnouncements());
  ipcMain.handle("tool:announce:status", (_ev, id: number) => e.getAnnouncementStatus(id));
  ipcMain.handle("tool:announce:retry", (_ev, id: number) => e.retryAnnouncement(id));
  ipcMain.handle("tool:auth:oauth", (_ev, provider: "google") => startOAuthPopup(e, provider));
  // [v0.59.0] 폰 원격 조종 — 명령 보내기/조회 + PC 생존신호 조회. 명령 "실행"(폴링 루프)은
  //   IPC로 노출하지 않는다(engine.startRemoteControlLoop()는 main.ts가 직접 부른다 — 아래 참고).
  ipcMain.handle("tool:remote:send", (_ev, type: string, payload?: Record<string, unknown>) => e.sendCommand(type, payload));
  ipcMain.handle("tool:remote:list", (_ev, limit?: number) => e.listMyCommands(limit));
  ipcMain.handle("tool:remote:heartbeat", () => e.getDesktopHeartbeat());
  ipcMain.handle("tool:killSwitch", (_ev, on: boolean) => e.setKillSwitch(!!on));
  ipcMain.handle("tool:liveOrders", (_ev, on: boolean) => e.setLiveOrders(!!on));
  ipcMain.handle("tool:priceGuard", (_ev, on: boolean, pct?: number) => e.setPriceGuard(!!on, pct));
  ipcMain.handle("tool:skipConfirm", (_ev, on: boolean) => e.setSkipConfirm(!!on));

  ipcMain.handle("tool:quote", (_ev, symbol: string) => e.quote(symbol));
  ipcMain.handle("tool:fx", () => e.fx());
  ipcMain.handle("tool:fx:manual", (_ev, rate: number) => e.setManualFx(rate));
  ipcMain.handle("tool:buyingPower", () => e.refreshBuyingPower());
  ipcMain.handle("tool:accountSummary", () => e.accountSummary()); // [v0.3.0] 예수금+총손익
  ipcMain.handle("tool:sellable", (_ev, symbol: string) => e.sellableQty(symbol));
  ipcMain.handle("tool:capacity", (_ev, symbol: string, price?: number) => e.orderCapacity(symbol, price));
  ipcMain.handle("tool:calc", (_ev, req) => e.calc(req));

  ipcMain.handle("tool:order:entry", (_ev, spec) => e.placeEntry(spec));
  ipcMain.handle("tool:order:oco", (_ev, spec) => e.placeOco(spec));
  ipcMain.handle("tool:order:oto", (_ev, spec) => e.placeOto(spec)); // [v0.3.2] 진입+익절(OTO)
  ipcMain.handle("tool:order:bracket", (_ev, spec) => e.placeBracket(spec)); // [v0.25.0] 매수+익절+손절 한번에
  // [v0.26.0] 자동매매 — 시작/중지/현황 + 한도 설정(3개, 전부 수정 가능)
  ipcMain.handle("tool:autoTrade:start", () => e.startAutoTrade());
  ipcMain.handle("tool:autoTrade:stop", () => e.stopAutoTrade());
  ipcMain.handle("tool:autoTrade:status", () => e.getAutoTradeStatus());
  ipcMain.handle("tool:autoTrade:reconcileNow", () => e.reconcileAutoPositionsNow()); // [v0.45.0]
  ipcMain.handle("tool:autoTrade:settings", (_ev, input) => e.saveAutoTradeSettings(input));
  // [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST) — 현재 상태 조회 + 기능 켜고 끄기
  ipcMain.handle("tool:systemPause:status", () => e.getSystemPauseStatus());
  ipcMain.handle("tool:systemPause:save", (_ev, enabled: boolean) => e.saveSystemPauseEnabled(enabled));
  // [v0.28.0] 자동매매용 스크리너 조건 저장 + 수동 새로고침(5분 기다리지 않고 지금 훑기)
  ipcMain.handle("tool:autoTrade:scanSettings", (_ev, input) => e.saveAutoScanSettings(input));
  ipcMain.handle("tool:autoTrade:scanNow", () => e.autoScanNow());
  // [v0.30.0] 자동매매기록 — 자동매매가 낸 매매의 전체 생애주기 로그(읽기 전용)
  ipcMain.handle("tool:autoTrade:history", () => e.getAutoTradeHistory());
  ipcMain.handle("tool:autoTrade:reports", () => e.getAutoReports()); // [v0.62.1] 자동매매 리포트
  // [v0.65.0] 매매연구소(신호 기록 모드)
  ipcMain.handle("tool:watchHistory:list", (_ev, filter) => e.getWatchHistory(filter));
  ipcMain.handle("tool:watchHistory:summary", (_ev, sinceMs) => e.getWatchHistorySummary(sinceMs));
  ipcMain.handle("tool:lab:status", () => e.getLabStatus());
  ipcMain.handle("tool:lab:save", (_ev, input) => e.saveLabSettings(input));
  ipcMain.handle("tool:lab:scanNow", () => e.labScanNow());
  ipcMain.handle("tool:lab:reset", () => e.labReset());
  ipcMain.handle("tool:lab:summary", (_ev, filter) => e.getLabSummary(filter));
  ipcMain.handle("tool:lab:signal", (_ev, id) => e.getLabSignal(id));
  ipcMain.handle("tool:lab:breakdown", (_ev, key, dim, filter) => e.getLabBreakdown(key, dim, filter));
  ipcMain.handle("tool:lab:combined", (_ev, candleKey, linkKey, filter) => e.getLabCombined(candleKey, linkKey, filter));
  ipcMain.handle("tool:lab:export", (_ev, kind) => e.exportLab(kind));
  ipcMain.handle("tool:lab:verify", (_ev, sample) => e.verifyLab(sample));
  ipcMain.handle("tool:lab:assessment", (_ev, realtimeOnly) => e.getLabAssessment(realtimeOnly !== false));
  // [v0.103.0] 가상매매 봇(주문 없음 — 시세·스크리닝 조회만으로 모의 체결)
  ipcMain.handle("tool:paper:list", () => e.getPaperBots());
  ipcMain.handle("tool:paper:refresh", () => e.paperBotsRefresh());
  ipcMain.handle("tool:paper:add", (_ev, base) => e.paperBotAdd(base));
  ipcMain.handle("tool:paper:addSlSet", (_ev, baseId, slList) => e.paperBotAddSlSet(baseId ?? null, Array.isArray(slList) ? slList : []));
  ipcMain.handle("tool:paper:update", (_ev, id, patch) => e.paperBotUpdate(id, patch ?? {}));
  ipcMain.handle("tool:paper:start", (_ev, id) => e.paperBotStart(id));
  ipcMain.handle("tool:paper:stop", (_ev, id) => e.paperBotStop(id));
  ipcMain.handle("tool:paper:reset", (_ev, id) => e.paperBotReset(id));
  ipcMain.handle("tool:paper:delete", (_ev, id) => e.paperBotDelete(id));
  ipcMain.handle("tool:paper:duplicate", (_ev, id) => e.paperBotDuplicate(id));
  ipcMain.handle("tool:paper:runNow", () => e.paperBotsRunNow());
  // [v0.2.10] 매매 근거 목록 / 보유 포지션(손익 포함) — 둘 다 읽기 전용이라 안전하다.
  ipcMain.handle("tool:rationales", () => e.getRationales());
  // [v0.4.0] 삼분할 타점 기록(여러 종목 동시 운용) — 저장/조회/삭제/진입완료 체크
  ipcMain.handle("tool:splits:list", () => e.getSplits());
  ipcMain.handle("tool:splits:add", (_ev, input) => e.addSplit(input));
  ipcMain.handle("tool:splits:delete", (_ev, id: string) => e.deleteSplit(id));
  ipcMain.handle("tool:splits:toggle", (_ev, id: string, level: number) => e.toggleSplitEntered(id, level));
  ipcMain.handle("tool:splits:rename", (_ev, id: string, memo: string) => e.renameSplit(id, memo)); // [v0.5.1] 제목 수정
  // [v0.5.0] 체결강도 기록(온디맨드 시계열) — 시작/중지/조회 + 실시간 이벤트 중계
  ipcMain.handle("tool:strength:start", (_ev, symbol: string, intervalSec?: number, auto?: boolean) => e.startStrength(symbol, intervalSec, auto));
  ipcMain.handle("tool:strength:stop", (_ev, symbol: string) => e.stopStrength(symbol));
  ipcMain.handle("tool:strength:get", (_ev, symbol: string) => e.getStrengthState(symbol));
  e.on("strength", (state) => win?.webContents.send("tool:strengthEvent", state));
  // [v0.6.0] 종목 스크리너(탐색) — 온디맨드 스캔 + 진행률 이벤트 중계
  ipcMain.handle("tool:screener:scan", (_ev, opts?: { bodyRatio?: number; count?: number; priceMin?: number; priceMax?: number }) => e.scanScreener(opts));
  ipcMain.handle("tool:screener:cancel", () => e.cancelScreenerScan()); // [v0.43.0] 진행 중인 스크리닝 취소
  ipcMain.handle("tool:screener:chart", (_ev, symbol: string) => e.getScreenerChart(symbol)); // [v0.25.0] 탐색 종목 차트(온디맨드)
  e.on("screener:progress", (p) => win?.webContents.send("tool:screenerProgress", p));
  // [v0.7.0] 체결강도 자동 기록(매매 연동) — 목록/요약/수동청산/삭제 + 실시간 이벤트
  ipcMain.handle("tool:trades:list", () => e.getTradeLog());
  ipcMain.handle("tool:report:today", () => e.todayReport()); // [v0.9.1] 오늘의 매매 리포트
  ipcMain.handle("tool:report", (_ev, kind, picked) => e.report(kind, picked)); // [v0.9.2] 기간별 리포트
  ipcMain.handle("tool:trade-analysis", () => e.tradeAnalysis()); // [v0.19.0] 매매 사이클 자동추적·분석
  ipcMain.handle("tool:reconcile-auto-history", () => e.reconcileAutoHistory()); // [v0.64.0] 자동매매기록을 토스 실제 체결과 대조
  // [v0.10.0→v0.24.0] 매매 이력 암호화 동기화(로그인 비밀번호로, 로그인 시 자동 호출됨)
  ipcMain.handle("tool:tradesync:push", () => e.syncPushTrades());
  ipcMain.handle("tool:tradesync:pull", () => e.syncPullTrades());
  // [v0.31.0] 자동매매 기록(포지션+이력) 기기 간 동기화
  ipcMain.handle("tool:autostatesync:push", () => e.syncPushAutoState());
  ipcMain.handle("tool:autostatesync:pull", () => e.syncPullAutoState());
  ipcMain.handle("tool:splitssync:push", () => e.syncPushSplits());
  ipcMain.handle("tool:splitssync:pull", () => e.syncPullSplits());
  // [v0.35.0] 그룹(공동개발자) 전체 연구용 공유 — 평문, 본인 것만 올리고 전원 것을 받아온다
  ipcMain.handle("tool:grouptrades:push", () => e.syncPushGroupTrades());
  ipcMain.handle("tool:grouptrades:pull", () => e.syncPullGroupHistory());
  // [v0.56.0] "그룹 전체 실시간 동기화" — 로그인 상태면 3분마다 자동으로 push+pull을 돈다.
  //   화면이 켜질 때마다(마운트 시) 불러도 안전(이미 돌고 있으면 아무 일도 안 함).
  // [v0.88.0] 클라우드 동기화 상태 조회 / 잠금 해제(로그인 비밀번호 한 번 입력 → 데이터 키 보관 + 밀린 기록 전부 올리기)
  ipcMain.handle("tool:cloudsync:status", () => e.getSyncStatus());
  ipcMain.handle("tool:cloudsync:unlock", (_ev, password: string) => e.unlockSync(String(password ?? "")));
  ipcMain.handle("tool:cloudsync:pushAll", () => e.syncPushAll());
  ipcMain.handle("tool:cloudsync:all", () => e.syncAllNow()); // [v0.98.0] 🔄 전체 동기화 버튼
  ipcMain.handle("tool:groupsync:ensure", () => { e.startGroupSyncLoop(); return { ok: true }; });
  e.on("groupSync", (members) => win?.webContents.send("tool:groupSyncEvent", members));
  // [v0.56.0] 그룹 채팅 — 가입 허용목록 전원이 실명으로 함께 쓰는 대화방.
  ipcMain.handle("tool:groupchat:send", (_ev, body: string) => e.sendGroupChatMessage(body));
  ipcMain.handle("tool:groupchat:list", () => e.getGroupChatMessages());
  // [v0.109.0] 그룹 실시간 갱신(채팅·공지·근황·업데이트 내역) + 공지(오너 전용 쓰기)
  e.on("groupFeed", (ev) => win?.webContents.send("tool:groupFeedEvent", ev));
  ipcMain.handle("tool:grouppresence:get", () => e.getGroupPresence());
  ipcMain.handle("tool:notices:get", () => e.getNotices());
  ipcMain.handle("tool:changelog:get", () => e.getChangelog());
  ipcMain.handle("tool:changelog:seen", (_ev, version: string) => e.markChangelogSeen(version));
  ipcMain.handle("tool:trades:stats", () => e.getTradeStats());
  ipcMain.handle("tool:trades:close", (_ev, id: string, exitPrice: number, kind: "tp" | "sl" | "manual") => e.closeTradeManual(id, exitPrice, kind));
  ipcMain.handle("tool:trades:delete", (_ev, id: string) => e.deleteTrade(id));
  e.on("trades", (log) => win?.webContents.send("tool:tradesEvent", log));
  // [v0.108.0] 계정 동기화(설정·기록) — 다른 기기에서 바꾼 설정이 들어오면 화면 입력칸을 즉시 다시 채운다.
  e.on("settingsSynced", (st) => win?.webContents.send("tool:settingsSyncedEvent", st));
  e.on("uiPrefsSynced", (p) => win?.webContents.send("tool:uiPrefsSyncedEvent", p));
  e.on("itemsSynced", (p) => win?.webContents.send("tool:itemsSyncedEvent", p));
  ipcMain.handle("tool:uipref:get", (_ev, key: string) => e.getUiPref(String(key ?? "")));
  ipcMain.handle("tool:uipref:set", (_ev, key: string, value: string | null) => e.setUiPref(String(key ?? ""), value == null ? null : String(value)));
  ipcMain.handle("tool:itemsync:status", () => e.getItemSyncStatus());
  ipcMain.handle("tool:itemsync:now", () => e.itemSyncNow());
  ipcMain.handle("tool:positions", () => e.positions());
  // [v0.3.3] 주문 현황(토스 스타일) 리치 뷰
  ipcMain.handle("tool:holdingsView", () => e.holdingsView());
  ipcMain.handle("tool:ordersView", (_ev, status) => e.ordersView(status));
  ipcMain.handle("tool:condOrdersView", (_ev, status) => e.condOrdersView(status));
  ipcMain.handle("tool:order:sell", (_ev, spec) => e.placeSell(spec)); // 매도(사람이 버튼 눌러야 호출)
  ipcMain.handle("tool:orders:open", () => e.openOrders());
  ipcMain.handle("tool:orders:conditionals", () => e.conditionals());
  ipcMain.handle("tool:orders:cancel", (_ev, id: string) => e.cancelNormalOrder(id));
  ipcMain.handle("tool:orders:cancelConditional", (_ev, id: string) => e.cancelConditional(id));
  ipcMain.handle("tool:auto:dismissUnprotected", (_ev, symbol: string) => e.dismissUnprotected(symbol)); // [v0.69.4]
  ipcMain.handle("tool:auto:cancelPosition", (_ev, symbol: string, entry: number, enteredAtMs: number) =>
    e.cancelAutoPosition(symbol, entry, enteredAtMs),
  );

  ipcMain.handle("tool:mockSetPrice", (_ev, symbol: string, price: number) => e.mockSetPrice(symbol, price));

  // --- 자동 업데이트: 화면 버튼 → updater 동작 (전부 실패해도 안전) ---
  ipcMain.handle("update:download", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  // "재시작하고 적용": 앱을 끄고 새 버전 설치 후 다시 켠다.
  // [v0.32.2] 예전엔 실패해도(quitAndInstall이 던지는 예외) 화면에 아무 신호도 안 가서
  //   "버튼을 눌러도 반응이 없다"는 것처럼 보였다(update:download는 이미 v0.27.1에서
  //   같은 방식으로 고쳐 놨었는데 install 쪽은 빠져 있었음). 다운로드 실패 처리와 동일한
  //   패턴으로 맞춘다 — try/catch로 감싸 결과를 화면에 그대로 돌려준다.
  ipcMain.handle("update:install", async () => {
    try {
      const r = await tryApplyUpdate("수동 버튼"); // [v0.87.0] 버튼도 같은 정책 — 막혀 있으면 곧 자동으로 이어서 적용된다
      return r.started ? { ok: true } : { ok: true, error: r.reason };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  // 현재 앱 버전(화면 표시용)
  ipcMain.handle("app:version", () => app.getVersion());
  // [v0.58.0] macOS 차선책(직접 교체 자동업데이트가 어떤 이유로든 준비 못 했을 때만
  //   쓰인다) — 받아 둔 dmg가 있는 폴더를 Finder로 연다.
  ipcMain.handle("update:openMacDmg", () => {
    if (!lastMacDmgPath) return { ok: false };
    shell.showItemInFolder(lastMacDmgPath);
    return { ok: true };
  });
  // [v0.60.0] macOS 직접 교체 자동업데이트 — "지금 바로 재시작"을 누르면 그냥 앱을
  //   끈다. 종료 훅(scheduleMacSelfUpdateSwap이 이미 걸어 둔 before-quit)이 알아서
  //   교체 스크립트를 띄운다 — Windows의 quitAndInstall과 달리 Squirrel을 전혀 안 타므로
  //   여기서 autoUpdater를 부를 필요가 없다(오히려 부르면 서명 불일치로 실패한다).
  ipcMain.handle("update:installMacSwap", async () => {
    try {
      const r = await tryApplyUpdate("수동 버튼(맥)"); // [v0.87.0] 같은 정책
      return r.started ? { ok: true } : { ok: true, error: r.reason };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  e.on("journal", (entry) => win?.webContents.send("tool:journalEvent", entry));
  // [v0.32.0] 자동매매 관찰 확정·주문 알림 — 화면(App.tsx)이 이 이벤트를 받아 브라우저/OS
  //   Notification API로 띄운다(창이 최소화·백그라운드여도 뜬다 — 앱이 켜져 있는 동안만).
  e.on("notify", (payload) => win?.webContents.send("tool:notifyEvent", payload));
}

// 앱을 끌 때 릴레이·터널도 같이 정리한다(좀비 프로세스 방지).
// [v0.90.0] 디바운스 중이던 저널·포지션 저장 등을 종료 직전에 동기로 확정한다 — 그냥 종료하면
//   300ms 디바운스 타이머가 아직 안 돈 마지막 기록이 디스크에 반영되기 전에 프로세스가 죽을 수 있다
//   (업데이트 재시작 경로는 prepareForRestart()가 이미 같은 이유로 호출 — 평소 종료도 똑같이 챙긴다).
app.on("before-quit", () => {
  engine?.flushAllFileSavesSync();
});

app.whenReady().then(async () => {
  // [자가진단] CAPRI_SELFTEST=1: 실제 Electron 메인 프로세스에서 실서버 시세·환율을
  //   호출해보고 콘솔에 결과를 찍은 뒤 종료한다(창 안 띄움). 오너 환경에서 "시세 실패"
  //   같은 문제가 나면, 진짜로 Electron 런타임의 네트워크가 문제인지 이걸로 가른다.
  if (process.env.CAPRI_SELFTEST === "1") {
    try {
      const { readFileSync } = await import("node:fs");
      for (const raw of readFileSync(join(process.cwd(), ".env"), "utf8").split("\n")) {
        const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) process.env[m[1]] = m[2].trim();
      }
      process.env.TOSS_MOCK = "false";
      process.env.TOSS_BASE_URL = "https://openapi.tossinvest.com";
      const t = await import("../lib/toss");
      const p = await t.getPrice("AAPL");
      console.log("[SELFTEST] getPrice OK:", p.price, p.currency);
      const fx = await t.getExchangeRate("USD", "KRW");
      console.log("[SELFTEST] getExchangeRate OK:", fx.rate, fx.quoteCurrency);
      console.log("[SELFTEST] ✅ Electron 메인 프로세스 네트워크 정상");
    } catch (e) {
      console.log("[SELFTEST] ❌ 실패:", String(e));
    }
    app.quit();
    return;
  }

  // [v0.32.3 — 전수조사로 발견] 상단 기본 메뉴바(File/Edit/View/Window) 제거는
  //   윈도우에서는 문제 없지만(복붙은 운영체제가 메뉴와 무관하게 처리), **맥에서는
  //   메뉴가 아예 없으면 Cmd+C/V/X/A/Z(복사·붙여넣기·잘라내기·전체선택·실행취소)가
  //   텍스트 입력창 전체에서 먹통이 된다**(macOS는 이 단축키들을 메뉴의 Edit 역할에
  //   연결해서만 처리 — Electron의 잘 알려진 함정). 설정 탭에 토스 Client
  //   ID/Secret(길어서 대부분 복사→붙여넣기로 입력)을 붙여넣으려다 계속 실패했던 게
  //   바로 이 문제였을 가능성이 크다 — "파일 열기·설정 오류가 계속 난다"는 보고와 일치.
  //   그래서 맥에서만 최소 메뉴(Edit 역할 포함)를 만들어 붙여넣기가 되게 하고,
  //   윈도우/리눅스는 기존처럼 메뉴 없이 깔끔하게 유지한다.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" }, // ★ 이게 없으면 설정 탭에 키를 붙여넣을 수 없었다
            { role: "selectAll" },
          ],
        },
        {
          label: "Window",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  // KYLEBOT_E2E(자동 검증)일 때는 실서버 접근을 원천 차단(연습 모드 강제).
  // [v0.60.9] 실행 중인 버전을 엔진에 넘겨 하트비트로 폰에 보고한다 — "자동매매가 켜져
  //   있으면 재시작 안 함" 안전장치 때문에 PC가 몇 시간째 옛 버전을 그대로 돌릴 수 있는데,
  //   폰에서 그 사실을 바로 알 수 있어야 "업데이트가 안 먹는 건지, PC가 아직 안 받은
  //   건지"를 헷갈리지 않는다.
  engine = new ToolEngine(app.getPath("userData"), { forceMock: process.env.KYLEBOT_E2E === "1", appVersion: app.getVersion() });
  registerIpc(engine);
  createWindow();

  // [v0.59.0] 폰 원격 조종 루프 — 이 인스턴스(데스크톱 main 프로세스)에서만 시작한다
  //   (웹/폰 쪽 ToolEngine 인스턴스는 이 메서드를 아예 안 부른다 — 그래서 폰이 명령을
  //   "실행"할 방법은 구조적으로 없다, 오직 "넣기"만 한다). startRemoteControlLoop()는
  //   로그인 전에는 조용히 아무 일도 안 하므로(engine 내부 가드), 15초마다 재시도해
  //   로그인되는 순간(세션 복원이든 화면에서 방금 로그인했든) 자동으로 붙는다.
  engine.startRemoteControlLoop();
  setInterval(() => engine?.startRemoteControlLoop(), 15_000);

  // [v0.87.0] 업데이트 재시작 직후 복구 — "재시작 기록" 표식이 있으면 한 번: 이전/새 버전 기록 → 실계좌↔OCO 대조 → 보호 없는 종목 재보호 → 디스코드·저널 기록.
  //   (자동매매 자동 재개는 ToolEngine 생성자가 v0.86.0 방식으로 이미 한다.) 토스 연결·로그인이 아직이면 15초마다(최대 20분) 다시 시도하고,
  //   표식이 없으면(평소 실행) 아무 일도 안 한다.
  {
    let tries = 0;
    const tryResume = async () => {
      tries++;
      let r: string = "none";
      try {
        r = (await engine?.resumeAfterRestart()) ?? "none";
      } catch (err) {
        console.error("[capri][resume] 재시작 복구 중 오류(다시 시도):", err);
        r = "pending";
      }
      if (r === "pending" && tries < 80) setTimeout(() => void tryResume(), 15_000);
    };
    setTimeout(() => void tryResume(), 3_000);
  }

  // [v0.71.0] 보호 감사 루프 — "자동매매가 꺼져 있어도" 이미 산 종목의 조건주문(OCO)이
  //   사라지지 않았는지 계속 확인한다(위 engine.ts의 protectionAuditTimer 필드 주석 참고).
  //   위 원격 조종 루프와 똑같은 재시도 패턴(로그인 전엔 조용히 무시, 15초마다 재시도).
  engine.startCloudSyncLoop(); // [v0.88.0] 암호화 개인 기록 주기 업로드(재시작 뒤 밀린 것 포함)
  setInterval(() => engine?.startCloudSyncLoop(), 15_000);
  engine.startProtectionAuditLoop();
  setInterval(() => engine?.startProtectionAuditLoop(), 15_000);

  // [v0.74.0 — task #72 "토스 증권과의 실시간 양방향 동기화"(오너 지시 "가장 중요")] 포지션
  //   동기화 루프 — 화면 탭이 닫혀 있거나 자동매매가 꺼져 있어도, 토스 앱에서 직접 주문을
  //   취소·체결했을 때 그 변화가 최대 20초 안에 반영되게 한다(위 engine.ts의
  //   positionSyncTimer 필드 주석 참고). 위 두 루프와 똑같은 재시도 패턴.
  engine.startPositionSyncLoop();
  setInterval(() => engine?.startPositionSyncLoop(), 15_000);

  // [v0.103.0] 가상매매 봇 루프 — PC(데스크톱)만 봇을 실제로 돌린다(폰은 보기·설정만). 주문은 절대 안 나간다.
  engine.startPaperBotLoop();

  // 자동 업데이트는 실제 설치본에서만(개발/검증 실행 제외). 실패해도 앱은 정상.
  if (app.isPackaged && !process.env.KYLEBOT_SHOT) {
    setupAutoUpdater();
    // [v0.60.0] macOS 자동업데이트(직접 교체 우선, 실패 시 dmg 차선책) — 시작 시 1회 +
    //   30분마다 재확인. (엔진 코드가 바뀐 드문 배포에서만 의미 있음 — 대부분의 배포는
    //   화면(UI) 원격 로딩만으로 재시작 없이 반영된다.)
    if (process.platform === "darwin") {
      setTimeout(() => void runMacAutoUpdateCycle(), 5000);
      setInterval(() => void runMacAutoUpdateCycle(), 30 * 60_000);
      // [v0.79.0] 무음 자동 재시작 — Windows(setupAutoUpdater 안의 5분 루프)와 똑같은
      //   패턴. 예전엔 직접교체가 준비돼도 오너가 "지금 바로 재시작"을 누르거나 앱을
      //   자연스럽게 껐다 켤 때까지 기다렸는데, 그러면 오너가 버튼을 누르지 않는 한
      //   사실상 적용이 안 됐다 — "재시작 버튼 누르는 과정조차 사치" 지시에 따라, 이제
      //   5분마다 "자동매매가 꺼져 있으면" 스스로 app.quit()한다. 종료 훅
      //   (scheduleMacSelfUpdateSwap이 runMacAutoUpdateCycle에서 이미 걸어 둠)이 그
      //   quit 과정에서 번들 교체+재실행까지 알아서 끝낸다.
      // [v0.87.0] 맥도 같은 정책 — 위 15초 폴링(tryApplyUpdate)이 macSwapReadyToInstall을 보고 비는 순간 app.quit() → 종료 훅이 교체·재실행.
      //   (v0.86.0은 이 맥 루프에 "자동매매 중엔 절대 재시작 안 함"이 남아 있었다 — 제거.)
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  engine?.stopAllStrength(); // [v0.5.0] 체결강도 폴링 타이머 정리(누수 방지)
  await engine?.stopMock();
  app.quit();
});
