// =============================================================================
// electron/preload.cjs  —  화면(React) ↔ 엔진(메인 프로세스) 사이의 "다리"
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   보안을 위해 화면은 Node 기능(파일, 네트워크 등)을 직접 못 씁니다(contextIsolation).
//   대신 이 파일이 "허용된 창구"만 골라 window.kylebot 이라는 이름으로 화면에
//   노출합니다. 화면은 window.kylebot.start() 처럼 부르기만 하면 되고,
//   실제 일은 메인 프로세스의 봇 엔진이 합니다.
//
// [왜 .cjs 인가?]
//   프로젝트가 ESM(type: module)이지만, Electron 의 preload 는 CommonJS 가
//   가장 호환이 좋아 확장자를 .cjs 로 명시했습니다(빌드 없이 그대로 복사해서 씀).
// =============================================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kylebot", {
  // --- 상태 조회 ---
  getStatus: () => ipcRenderer.invoke("bot:getStatus"),
  getLogs: () => ipcRenderer.invoke("bot:getLogs"),

  // --- 봇 조작 ---
  start: () => ipcRenderer.invoke("bot:start"),
  stop: () => ipcRenderer.invoke("bot:stop"),
  setKillSwitch: (on) => ipcRenderer.invoke("bot:killSwitch", on),

  // --- 설정 ---
  getSettings: () => ipcRenderer.invoke("bot:getSettings"),
  saveSettings: (input) => ipcRenderer.invoke("bot:saveSettings", input),

  // --- 매매 계획/세션 ---
  planFromQuote: (symbol) => ipcRenderer.invoke("bot:planFromQuote", symbol),
  createSession: (spec) => ipcRenderer.invoke("bot:createSession", spec),
  mockSetPrice: (symbol, price) => ipcRenderer.invoke("bot:mockSetPrice", symbol, price),
  refreshBuyingPower: () => ipcRenderer.invoke("bot:refreshBuyingPower"),
  quote: (symbol) => ipcRenderer.invoke("bot:quote", symbol),

  // --- 실시간 이벤트 구독(엔진 → 화면) ---
  onLog: (cb) => {
    const h = (_ev, entry) => cb(entry);
    ipcRenderer.on("bot:log", h);
    return () => ipcRenderer.removeListener("bot:log", h); // 구독 해제 함수 반환
  },
  onStatus: (cb) => {
    const h = (_ev, status) => cb(status);
    ipcRenderer.on("bot:status", h);
    return () => ipcRenderer.removeListener("bot:status", h);
  },
});
