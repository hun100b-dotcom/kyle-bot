// =============================================================================
// electron/main.ts  —  데스크톱 앱 진입점 (v2: 카일 매매도구)
// -----------------------------------------------------------------------------
// [v2 컨셉] "자율 봇" → "수동 계산기 + 온디맨드 주문 도구".
//   앱은 창을 하나 띄우고, 화면의 버튼 입력을 도구 엔진(tool-engine.ts)에
//   전달만 한다. 스스로 도는 루프(워커 틱)는 v2에서 제거됐다 — 익절/손절 감시는
//   토스 서버의 조건주문(OCO/OTO)이 대신하므로 앱이 항상 켜져 있을 필요가 없다.
//
// [보안 기본기] contextIsolation 켬 + nodeIntegration 끔.
//   화면은 preload.cjs가 허용한 창구(window.kyletool.*)로만 엔진과 대화한다.
// =============================================================================

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { ToolEngine } from "./tool-engine";

let engine: ToolEngine | null = null;
let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: "카일 매매도구",
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

/** 화면 요청(window.kyletool.*) ↔ 엔진 연결 */
function registerIpc(e: ToolEngine): void {
  ipcMain.handle("tool:status", () => e.getStatus());
  ipcMain.handle("tool:journal", () => e.getJournal());
  ipcMain.handle("tool:settings:get", () => e.getSettings());
  ipcMain.handle("tool:settings:save", (_ev, input) => e.saveSettings(input));
  ipcMain.handle("tool:killSwitch", (_ev, on: boolean) => e.setKillSwitch(!!on));

  ipcMain.handle("tool:quote", (_ev, symbol: string) => e.quote(symbol));
  ipcMain.handle("tool:fx", () => e.fx());
  ipcMain.handle("tool:fx:manual", (_ev, rate: number) => e.setManualFx(rate));
  ipcMain.handle("tool:buyingPower", () => e.refreshBuyingPower());
  ipcMain.handle("tool:calc", (_ev, req) => e.calc(req));

  ipcMain.handle("tool:order:entry", (_ev, spec) => e.placeEntry(spec));
  ipcMain.handle("tool:order:oco", (_ev, spec) => e.placeOco(spec));
  ipcMain.handle("tool:order:oto", (_ev, spec) => e.placeOto(spec));
  ipcMain.handle("tool:orders:open", () => e.openOrders());
  ipcMain.handle("tool:orders:conditionals", () => e.conditionals());
  ipcMain.handle("tool:orders:cancel", (_ev, id: string) => e.cancelNormalOrder(id));
  ipcMain.handle("tool:orders:cancelConditional", (_ev, id: string) => e.cancelConditional(id));

  ipcMain.handle("tool:mockSetPrice", (_ev, symbol: string, price: number) => e.mockSetPrice(symbol, price));

  e.on("journal", (entry) => win?.webContents.send("tool:journalEvent", entry));
}

app.whenReady().then(() => {
  // KYLEBOT_E2E(자동 검증)일 때는 실서버 접근을 원천 차단(연습 모드 강제).
  engine = new ToolEngine(app.getPath("userData"), { forceMock: process.env.KYLEBOT_E2E === "1" });
  registerIpc(engine);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await engine?.stopMock();
  app.quit();
});
