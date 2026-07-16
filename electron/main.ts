// =============================================================================
// electron/main.ts  —  데스크톱 앱 진입점 (Electron 메인 프로세스)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   "카일봇.app 을 더블클릭하면 여기부터 실행"되는 파일입니다.
//   1) 창(BrowserWindow)을 하나 만들고, 그 안에 React 화면(dist/index.html)을 띄운다.
//   2) 봇 엔진(bot-engine.ts)을 만들어 백그라운드에서 돌린다.
//   3) 화면 ↔ 엔진 사이의 요청/응답 통로(IPC)를 연결한다.
//
// [왜 Electron 인가? (패키징 방식 선택 이유)]
//   - 카일봇의 두뇌(lib/)와 워커는 전부 Node(자바스크립트 런타임) 코드다.
//     Electron 은 Node 를 앱 안에 통째로 품고 있어 기존 코드를 "그대로" 쓸 수 있다.
//   - 화면도 이미 React 로 준비돼 있어 Electron 의 크롬 창에 바로 띄우면 된다.
//   - 대안인 Tauri 는 러스트(다른 언어) 기반이라 두뇌 코드를 옮겨 써야 해서 부적합.
//   - 설계서/progress.md 의 S5 계획도 "React 를 Electron 으로 감싼 데스크톱 앱"이다.
//
// [보안 기본기]
//   - contextIsolation(화면과 Node 격리) 켬 + nodeIntegration 끔.
//     화면(웹 기술)이 곧바로 파일·네트워크를 만지지 못하게 하고,
//     preload.cjs 가 허용한 통로(window.kylebot.*)로만 엔진과 대화한다.
// =============================================================================

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { BotEngine } from "./bot-engine";

let engine: BotEngine | null = null;
let win: BrowserWindow | null = null;

/** 메인 창 만들기 */
function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: "카일봇",
    backgroundColor: "#0f1115", // 화면 로드 전에도 다크 배경(깜빡임 방지)
    webPreferences: {
      preload: join(__dirname, "preload.cjs"), // 화면-엔진 다리
      contextIsolation: true, //                  화면과 Node 격리(보안)
      nodeIntegration: false, //                  화면에서 Node 직접 사용 금지(보안)
    },
  });

  // 빌드된 React 화면을 파일로 로드한다.
  //   개발 중 ELECTRON_START_URL 이 있으면(예: vite dev 서버) 그걸 우선 사용.
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(app.getAppPath(), "dist", "index.html"));

  win.on("closed", () => {
    win = null;
  });

  // ---------------------------------------------------------------------------
  // [개발 검증용] 환경변수 KYLEBOT_SHOT=경로 를 주고 실행하면:
  //   화면 로드 완료 → 2초 뒤 창을 이미지로 캡처해 그 경로에 저장하고 종료한다.
  //   화면(렌더러)의 오류 메시지도 터미널로 흘려보낸다.
  //   일반 실행(더블클릭)에는 아무 영향 없음(환경변수가 없으므로 건너뜀).
  // ---------------------------------------------------------------------------
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
 * [개발 검증용] KYLEBOT_E2E=1 이면 연습 모드로 매매 한 판을 자동 재생한다:
 *   봇 시작 → AAPL 계획 → 세션 장전 → (틱) 진입 체결 → 가격 상승 → (틱) 익절 청산.
 *   마지막에 화면을 캡처하고 매매일지를 터미널로 출력한 뒤 종료.
 *   일반 실행(더블클릭)과 무관: 환경변수가 있을 때만 동작.
 */
async function runVerification(shotPath: string): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    if (process.env.KYLEBOT_E2E === "1" && engine) {
      console.log("[검증] E2E 시작: 봇 켜기");
      await engine.start();
      const plan = await engine.planFromQuote("AAPL");
      console.log(`[검증] 계획: 현재가 $${plan.price} → 진입 $${plan.entry} / 익절 $${plan.tp} / 손절 $${plan.sl}`);
      await engine.createAndArmSession({ symbol: "AAPL", entry: plan.entry, tp: plan.tp, sl: plan.sl, quantity: 3 });
      engine.mockSetPrice("AAPL", plan.entry); // 시장 하락 시뮬 → 진입 지정가 도달(체결)
      await wait(6000); // 틱 1~2회: 진입 체결 감지 대기
      engine.mockSetPrice("AAPL", plan.tp * 1.05); // 시장 상승 시뮬 → 익절가 돌파
      await wait(7000); // 틱: 익절 체결 → 청산
      const st = engine.getStatus();
      console.log(`[검증] 세션 상태: ${st.sessions.map((s) => s.status).join(",")} / 매매일지 ${st.tradeLogs.length}건`);
      for (const t of st.tradeLogs as Array<{ symbol: string; pnlPct: number; exitReason: string }>) {
        console.log(`[검증] 일지: ${t.symbol} 손익 ${t.pnlPct.toFixed(2)}% (${t.exitReason})`);
      }
      await engine.stop();
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

/** 엔진 이벤트(로그/상태)를 화면으로 실시간 전달 */
function wireEngineToWindow(e: BotEngine): void {
  e.on("log", (entry) => win?.webContents.send("bot:log", entry));
  e.on("status", (status) => win?.webContents.send("bot:status", status));
}

/** 화면의 요청(window.kylebot.*)을 엔진 함수로 연결 */
function registerIpc(e: BotEngine): void {
  ipcMain.handle("bot:getStatus", () => e.getStatus());
  ipcMain.handle("bot:getLogs", () => e.getRecentLogs());
  ipcMain.handle("bot:start", () => e.start());
  ipcMain.handle("bot:stop", () => e.stop());
  ipcMain.handle("bot:killSwitch", (_ev, on: boolean) => e.setKillSwitch(!!on));
  ipcMain.handle("bot:getSettings", () => e.getSettings());
  ipcMain.handle("bot:saveSettings", (_ev, input) => e.saveSettings(input));
  ipcMain.handle("bot:planFromQuote", (_ev, symbol: string) => e.planFromQuote(symbol));
  ipcMain.handle("bot:createSession", (_ev, spec) => e.createAndArmSession(spec));
  ipcMain.handle("bot:mockSetPrice", (_ev, symbol: string, price: number) => e.mockSetPrice(symbol, price));
  ipcMain.handle("bot:refreshBuyingPower", () => e.refreshBuyingPower());
  ipcMain.handle("bot:quote", (_ev, symbol: string) => e.quote(symbol));
}

// --- 앱 수명주기 ---

app.whenReady().then(() => {
  // 엔진은 앱 데이터 폴더(예: ~/Library/Application Support/카일봇)를 저장소로 쓴다.
  engine = new BotEngine(app.getPath("userData"));
  registerIpc(engine);
  createWindow();
  wireEngineToWindow(engine);

  // macOS 관례: 독(Dock) 아이콘 클릭 시 창이 없으면 다시 연다.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (engine) wireEngineToWindow(engine);
    }
  });
});

// 모든 창이 닫히면 봇도 정지하고 앱 종료.
//   [주의] "창만 닫고 봇은 계속" 기능(트레이 상주)은 다음 버전 후보.
app.on("window-all-closed", async () => {
  await engine?.stop();
  app.quit();
});
