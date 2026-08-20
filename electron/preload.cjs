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
  saveSeedSettings: (input) => ipcRenderer.invoke("tool:settings:seed", input), // [v0.3.0]
  saveDefaultRatio: (input) => ipcRenderer.invoke("tool:settings:defaults", input), // [v0.8.3]
  syncPushKeys: (passphrase) => ipcRenderer.invoke("tool:sync:push", passphrase), // [v0.8.0]
  syncPullKeys: (passphrase) => ipcRenderer.invoke("tool:sync:pull", passphrase), // [v0.8.0]
  authSignUp: (email, pw) => ipcRenderer.invoke("tool:auth:signup", email, pw), // [v0.8.1]
  authSignIn: (email, pw) => ipcRenderer.invoke("tool:auth:signin", email, pw),
  authSignOut: () => ipcRenderer.invoke("tool:auth:signout"),
  authStatus: () => ipcRenderer.invoke("tool:auth:status"),
  setKillSwitch: (on) => ipcRenderer.invoke("tool:killSwitch", on),
  setLiveOrders: (on) => ipcRenderer.invoke("tool:liveOrders", on),
  setPriceGuard: (on, pct) => ipcRenderer.invoke("tool:priceGuard", on, pct),
  setSkipConfirm: (on) => ipcRenderer.invoke("tool:skipConfirm", on),

  // 조회(버튼 눌렀을 때 1회)
  quote: (symbol) => ipcRenderer.invoke("tool:quote", symbol),
  fx: () => ipcRenderer.invoke("tool:fx"),
  setManualFx: (rate) => ipcRenderer.invoke("tool:fx:manual", rate),
  buyingPower: () => ipcRenderer.invoke("tool:buyingPower"),
  accountSummary: () => ipcRenderer.invoke("tool:accountSummary"), // [v0.3.0]
  sellable: (symbol) => ipcRenderer.invoke("tool:sellable", symbol),
  capacity: (symbol, price) => ipcRenderer.invoke("tool:capacity", symbol, price),

  // 계산기(Capri매매기법 3종 + 수동)
  calc: (req) => ipcRenderer.invoke("tool:calc", req),

  // 주문(화면의 확인 팝업 통과 후에만 호출됨)
  placeEntry: (spec) => ipcRenderer.invoke("tool:order:entry", spec),
  placeOco: (spec) => ipcRenderer.invoke("tool:order:oco", spec),
  placeOto: (spec) => ipcRenderer.invoke("tool:order:oto", spec), // [v0.3.2] 진입+익절(OTO)

  // 주문 현황
  // [v0.2.10] 주문 근거(기법 스냅샷) 목록 / 보유 포지션 손익
  rationales: () => ipcRenderer.invoke("tool:rationales"),

  // [v0.4.0] 삼분할 타점 기록(여러 종목 동시 운용) — 저장/조회/삭제/진입완료 체크
  splitsList: () => ipcRenderer.invoke("tool:splits:list"),
  splitsAdd: (input) => ipcRenderer.invoke("tool:splits:add", input),
  splitsDelete: (id) => ipcRenderer.invoke("tool:splits:delete", id),
  splitsToggle: (id, level) => ipcRenderer.invoke("tool:splits:toggle", id, level),
  splitsRename: (id, memo) => ipcRenderer.invoke("tool:splits:rename", id, memo), // [v0.5.1] 제목 수정

  // [v0.5.0] 체결강도 기록(온디맨드 시계열) — 시작/중지/조회 + 실시간 구독
  strengthStart: (symbol, intervalSec) => ipcRenderer.invoke("tool:strength:start", symbol, intervalSec),
  strengthStop: (symbol) => ipcRenderer.invoke("tool:strength:stop", symbol),
  strengthGet: (symbol) => ipcRenderer.invoke("tool:strength:get", symbol),
  onStrength: (cb) => {
    const h = (_ev, state) => cb(state);
    ipcRenderer.on("tool:strengthEvent", h);
    return () => ipcRenderer.removeListener("tool:strengthEvent", h);
  },

  // [v0.6.0] 종목 스크리너(탐색) — 스캔 + 진행률 구독
  screenerScan: (opts) => ipcRenderer.invoke("tool:screener:scan", opts),
  onScreenerProgress: (cb) => {
    const h = (_ev, p) => cb(p);
    ipcRenderer.on("tool:screenerProgress", h);
    return () => ipcRenderer.removeListener("tool:screenerProgress", h);
  },

  // [v0.7.0] 체결강도 자동 기록(매매 연동)
  tradesList: () => ipcRenderer.invoke("tool:trades:list"),
  todayReport: () => ipcRenderer.invoke("tool:report:today"),
  report: (kind, picked) => ipcRenderer.invoke("tool:report", kind, picked),
  tradeSyncPush: (pass) => ipcRenderer.invoke("tool:tradesync:push", pass),
  tradeSyncPull: (pass) => ipcRenderer.invoke("tool:tradesync:pull", pass),
  tradeSyncPass: (pass) => ipcRenderer.invoke("tool:tradesync:pass", pass),
  tradesStats: () => ipcRenderer.invoke("tool:trades:stats"),
  tradesClose: (id, exitPrice, kind) => ipcRenderer.invoke("tool:trades:close", id, exitPrice, kind),
  tradesDelete: (id) => ipcRenderer.invoke("tool:trades:delete", id),
  onTrades: (cb) => {
    const h = (_ev, log) => cb(log);
    ipcRenderer.on("tool:tradesEvent", h);
    return () => ipcRenderer.removeListener("tool:tradesEvent", h);
  },
  positions: () => ipcRenderer.invoke("tool:positions"),
  holdingsView: () => ipcRenderer.invoke("tool:holdingsView"),
  ordersView: (status) => ipcRenderer.invoke("tool:ordersView", status),
  condOrdersView: (status) => ipcRenderer.invoke("tool:condOrdersView", status),
  placeSell: (spec) => ipcRenderer.invoke("tool:order:sell", spec),
  openOrders: () => ipcRenderer.invoke("tool:orders:open"),
  conditionals: () => ipcRenderer.invoke("tool:orders:conditionals"),
  cancelOrder: (id) => ipcRenderer.invoke("tool:orders:cancel", id),
  cancelConditional: (id) => ipcRenderer.invoke("tool:orders:cancelConditional", id),

  // 연습 모드 전용
  // [폰에서 쓰기] 집 PC 릴레이 + 인터넷 터널 제어
  phoneStart: () => ipcRenderer.invoke("phone:start"),
  phoneStop: () => ipcRenderer.invoke("phone:stop"),
  phoneStatus: () => ipcRenderer.invoke("phone:status"),
  onPhoneState: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on("phone:state", h);
    return () => ipcRenderer.removeListener("phone:state", h);
  },
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
