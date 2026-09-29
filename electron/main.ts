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

import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { join } from "node:path";
import { ToolEngine } from "./tool-engine";
import { startRelay, type RelayHandle } from "./relay"; //   [폰 연동] 집 PC 릴레이
import { startTunnel, type TunnelHandle } from "./tunnel"; // [폰 연동] 인터넷 터널
import QRCode from "qrcode"; //                              [폰 연동] 접속 주소 QR
import electronUpdater from "electron-updater";

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
// 자동 업데이트 (electron-updater)
// -----------------------------------------------------------------------------
// [흐름] 앱 시작 → 조용히 새 버전 확인 → 있으면 화면에 팝업 신호(update:available)
//   → 사용자가 "지금 업데이트" 누르면 다운로드(진행률 update:progress)
//   → 완료(update:downloaded) → "재시작하고 적용" 누르면 quitAndInstall.
//
// [★ 안전 원칙] 업데이트 확인/다운로드가 실패해도(오프라인·서버오류 등) 앱은
//   절대 죽지 않는다. 모든 호출을 try/catch로 감싸고, 자동 다운로드는 끈다
//   (사용자가 팝업에서 승낙할 때만 받는다).
// =============================================================================
function setupAutoUpdater(): void {
  // 사용자 승낙 전에는 자동으로 받지도, 자동으로 설치하지도 않는다.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // [v0.27.1] "업데이트 다운로드에 실패했습니다" 오류 대응 — electron-updater는 기본적으로
  //   "차등 업데이트"(설치돼 있는 옛 버전과 새 버전을 비교해 달라진 부분만 내려받음)를 먼저
  //   시도한다. 이 방식은 옛 버전의 blockmap이 없거나(첫 업데이트 등) 조건이 안 맞으면 중간에
  //   실패하는 경우가 실제로 보고돼 있다(우리 앱은 서명 인증서가 없어 더 취약한 조합).
  //   용량을 좀 더 받더라도(설치파일 전체, 약 100MB) 항상 되는 전체 다운로드만 쓰도록 끈다.
  autoUpdater.disableDifferentialDownload = true;

  // 새 버전이 있을 때: 화면에 버전·변경사항을 보내 팝업을 띄운다.
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

  // 다운로드 완료: 이제 "재시작하고 적용"을 누를 수 있다.
  autoUpdater.on("update-downloaded", () => {
    win?.webContents.send("update:downloaded");
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

  // [v0.51.0 긴급 수정] 예전엔 "시작 시 1회"뿐이라, 오너가 실계좌 자동매매를 켜 둔 채 몇 시간씩
  //   앱을 계속 켜 두면(=흔한 실사용 패턴) 그 사이 새 배포가 여러 번 나가도 전혀 알 길이 없었다.
  //   이번 세션에서만도 v0.45.0~v0.50.0이 약 1시간 안에 연달아 배포됐는데, 오너가 그때마다
  //   "고쳤다더니 그대로다"라고 반복 보고한 것과 시점이 정확히 겹친다 — 앱을 껐다 켜거나 업데이트
  //   팝업을 직접 확인하지 않는 한 새 버전이 실행 중인 화면에 반영될 방법이 구조적으로 없었다.
  //   이제 30분마다도 조용히 한 번씩 재확인해, 오래 켜 둔 세션도 새 배포를 놓치지 않게 한다
  //   (실패해도 조용히 무시 — 위 안전 원칙과 동일. 자동 다운로드/설치는 여전히 안 함 — 오너가
  //   팝업에서 직접 승낙할 때만).
  setInterval(() => {
    try {
      void autoUpdater.checkForUpdates().catch(() => {});
    } catch {
      /* 무시 — 다음 주기에 다시 시도 */
    }
  }, 30 * 60_000);
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

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(app.getAppPath(), "dist", "index.html"));

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

// =============================================================================
// [폰에서 쓰기] 집 PC 릴레이 + 인터넷 터널
// -----------------------------------------------------------------------------
// 토스 키는 '허용된 IP'에서만 쓸 수 있어 클라우드 서버로는 막힌다(403). 집 PC는 허용돼 있다.
// 그래서 이 앱이 켜져 있는 동안 **집 PC가 폰의 중계소**가 된다:
//     폰(웹앱) → 터널(임시 https 주소) → 이 앱의 릴레이 → 토스
// 화면에는 접속 주소와 QR을 띄워, 사장님이 폰으로 스캔만 하면 되게 한다.
// =============================================================================
let relay: RelayHandle | null = null;
let tunnel: TunnelHandle | null = null;
let phoneState: { status: string; url: string | null; qr: string | null; error: string | null } = {
  status: "꺼짐",
  url: null,
  qr: null,
  error: null,
};

const WEB_APP_URL = "https://hun100b-dotcom.github.io/capri-web/";

/** 화면에 현재 상태를 알려 준다(진행 상황이 실시간으로 보이게) */
function pushPhoneState(): void {
  win?.webContents.send("phone:state", phoneState);
}

/** 폰 연결 켜기: 릴레이 → 터널 → 주소/QR 생성 */
async function startPhoneAccess(): Promise<typeof phoneState> {
  if (relay && tunnel && phoneState.url) return phoneState; // 이미 켜져 있으면 그대로

  try {
    phoneState = { status: "릴레이 준비 중…", url: null, qr: null, error: null };
    pushPhoneState();
    if (!relay) relay = await startRelay(8790);

    phoneState.status = "인터넷 주소 만드는 중… (처음이면 프로그램을 내려받느라 1~2분)";
    pushPhoneState();
    if (!tunnel) {
      tunnel = await startTunnel(relay.port, join(app.getPath("userData"), "bin"), (msg) => {
        phoneState.status = msg;
        pushPhoneState();
      });
    }

    // 폰이 열 최종 주소(웹앱 + 릴레이 주소를 ?api= 로 전달)
    const api = `${tunnel.publicUrl}/r/${relay.token}`;
    const url = `${WEB_APP_URL}?api=${encodeURIComponent(api)}`;
    phoneState = {
      status: "연결됨 — 폰에서 QR을 찍으세요",
      url,
      qr: await QRCode.toDataURL(url, { width: 320, margin: 1 }),
      error: null,
    };
  } catch (e) {
    phoneState = {
      status: "실패",
      url: null,
      qr: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  pushPhoneState();
  return phoneState;
}

/** 폰 연결 끄기 */
async function stopPhoneAccess(): Promise<typeof phoneState> {
  tunnel?.stop();
  tunnel = null;
  await relay?.stop();
  relay = null;
  phoneState = { status: "꺼짐", url: null, qr: null, error: null };
  pushPhoneState();
  return phoneState;
}

/** 화면 요청(window.kyletool.*) ↔ 엔진 연결 */
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
  // [v0.10.0→v0.24.0] 매매 이력 암호화 동기화(로그인 비밀번호로, 로그인 시 자동 호출됨)
  ipcMain.handle("tool:tradesync:push", () => e.syncPushTrades());
  ipcMain.handle("tool:tradesync:pull", () => e.syncPullTrades());
  // [v0.31.0] 자동매매 기록(포지션+이력) 기기 간 동기화
  ipcMain.handle("tool:autostatesync:push", () => e.syncPushAutoState());
  ipcMain.handle("tool:autostatesync:pull", () => e.syncPullAutoState());
  // [v0.35.0] 그룹(공동개발자) 전체 연구용 공유 — 평문, 본인 것만 올리고 전원 것을 받아온다
  ipcMain.handle("tool:grouptrades:push", () => e.syncPushGroupTrades());
  ipcMain.handle("tool:grouptrades:pull", () => e.syncPullGroupHistory());
  // [v0.56.0] "그룹 전체 실시간 동기화" — 로그인 상태면 3분마다 자동으로 push+pull을 돈다.
  //   화면이 켜질 때마다(마운트 시) 불러도 안전(이미 돌고 있으면 아무 일도 안 함).
  ipcMain.handle("tool:groupsync:ensure", () => { e.startGroupSyncLoop(); return { ok: true }; });
  e.on("groupSync", (members) => win?.webContents.send("tool:groupSyncEvent", members));
  // [v0.56.0] 그룹 채팅 — 가입 허용목록 전원이 실명으로 함께 쓰는 대화방.
  ipcMain.handle("tool:groupchat:send", (_ev, body: string) => e.sendGroupChatMessage(body));
  ipcMain.handle("tool:groupchat:list", () => e.getGroupChatMessages());
  ipcMain.handle("tool:trades:stats", () => e.getTradeStats());
  ipcMain.handle("tool:trades:close", (_ev, id: string, exitPrice: number, kind: "tp" | "sl" | "manual") => e.closeTradeManual(id, exitPrice, kind));
  ipcMain.handle("tool:trades:delete", (_ev, id: string) => e.deleteTrade(id));
  e.on("trades", (log) => win?.webContents.send("tool:tradesEvent", log));
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
  ipcMain.handle("tool:auto:cancelPosition", (_ev, symbol: string, entry: number, enteredAtMs: number) =>
    e.cancelAutoPosition(symbol, entry, enteredAtMs),
  );

  ipcMain.handle("tool:mockSetPrice", (_ev, symbol: string, price: number) => e.mockSetPrice(symbol, price));

  // --- [폰에서 쓰기] 릴레이/터널 제어 ---
  ipcMain.handle("phone:start", () => startPhoneAccess());
  ipcMain.handle("phone:stop", () => stopPhoneAccess());
  ipcMain.handle("phone:status", () => phoneState);

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
  ipcMain.handle("update:install", () => {
    try {
      setImmediate(() => autoUpdater.quitAndInstall());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  // 현재 앱 버전(화면 표시용)
  ipcMain.handle("app:version", () => app.getVersion());

  e.on("journal", (entry) => win?.webContents.send("tool:journalEvent", entry));
  // [v0.32.0] 자동매매 관찰 확정·주문 알림 — 화면(App.tsx)이 이 이벤트를 받아 브라우저/OS
  //   Notification API로 띄운다(창이 최소화·백그라운드여도 뜬다 — 앱이 켜져 있는 동안만).
  e.on("notify", (payload) => win?.webContents.send("tool:notifyEvent", payload));
}

// 앱을 끌 때 릴레이·터널도 같이 정리한다(좀비 프로세스 방지).
app.on("before-quit", () => {
  tunnel?.stop();
  void relay?.stop();
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
  engine = new ToolEngine(app.getPath("userData"), { forceMock: process.env.KYLEBOT_E2E === "1" });
  registerIpc(engine);
  createWindow();

  // 자동 업데이트는 실제 설치본에서만(개발/검증 실행 제외). 실패해도 앱은 정상.
  if (app.isPackaged && !process.env.KYLEBOT_SHOT) {
    setupAutoUpdater();
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
