// =============================================================================
// electron/preload.cjs  —  화면(React) ↔ 도구 엔진 사이의 "다리" (v2)
// -----------------------------------------------------------------------------
// 보안(contextIsolation) 때문에 화면은 Node 기능을 직접 못 씁니다.
// 여기서 허용한 창구만 window.kyletool 이름으로 노출합니다.
// =============================================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kyletool", {
  // 상태·기록
  status: () => ipcRenderer.invoke("tool:status"),
  journal: () => ipcRenderer.invoke("tool:journal"),

  // 설정
  getSettings: () => ipcRenderer.invoke("tool:settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("tool:settings:save", input),
  setKillSwitch: (on) => ipcRenderer.invoke("tool:killSwitch", on),
  setLiveOrders: (on) => ipcRenderer.invoke("tool:liveOrders", on),

  // 조회(버튼 눌렀을 때 1회)
  quote: (symbol) => ipcRenderer.invoke("tool:quote", symbol),
  fx: () => ipcRenderer.invoke("tool:fx"),
  setManualFx: (rate) => ipcRenderer.invoke("tool:fx:manual", rate),
  buyingPower: () => ipcRenderer.invoke("tool:buyingPower"),

  // 계산기(Capri매매기법 3종 + 수동)
  calc: (req) => ipcRenderer.invoke("tool:calc", req),

  // 주문(화면의 확인 팝업 통과 후에만 호출됨)
  placeEntry: (spec) => ipcRenderer.invoke("tool:order:entry", spec),
  placeOco: (spec) => ipcRenderer.invoke("tool:order:oco", spec),

  // 주문 현황
  openOrders: () => ipcRenderer.invoke("tool:orders:open"),
  conditionals: () => ipcRenderer.invoke("tool:orders:conditionals"),
  cancelOrder: (id) => ipcRenderer.invoke("tool:orders:cancel", id),
  cancelConditional: (id) => ipcRenderer.invoke("tool:orders:cancelConditional", id),

  // 연습 모드 전용
  mockSetPrice: (symbol, price) => ipcRenderer.invoke("tool:mockSetPrice", symbol, price),

  // 실시간 저널 구독
  onJournal: (cb) => {
    const h = (_ev, entry) => cb(entry);
    ipcRenderer.on("tool:journalEvent", h);
    return () => ipcRenderer.removeListener("tool:journalEvent", h);
  },

  // --- 자동 업데이트 ---
  appVersion: () => ipcRenderer.invoke("app:version"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  // 업데이트 이벤트 구독(있음/진행률/완료/오류). 반환값은 구독 해제 함수.
  onUpdate: (handlers) => {
    const onAvail = (_ev, info) => handlers.available?.(info);
    const onProg = (_ev, pct) => handlers.progress?.(pct);
    const onDone = () => handlers.downloaded?.();
    const onErr = (_ev, msg) => handlers.error?.(msg);
    ipcRenderer.on("update:available", onAvail);
    ipcRenderer.on("update:progress", onProg);
    ipcRenderer.on("update:downloaded", onDone);
    ipcRenderer.on("update:error", onErr);
    return () => {
      ipcRenderer.removeListener("update:available", onAvail);
      ipcRenderer.removeListener("update:progress", onProg);
      ipcRenderer.removeListener("update:downloaded", onDone);
      ipcRenderer.removeListener("update:error", onErr);
    };
  },
});
