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
  syncPushKeys: () => ipcRenderer.invoke("tool:sync:push"), // [v0.8.0→v0.24.0] 로그인 비밀번호로 암호화
  syncPullKeys: () => ipcRenderer.invoke("tool:sync:pull"), // [v0.8.0→v0.24.0] 로그인 시 자동 호출됨
  authSignUp: (email, pw) => ipcRenderer.invoke("tool:auth:signup", email, pw), // [v0.8.1]
  authSignIn: (email, pw) => ipcRenderer.invoke("tool:auth:signin", email, pw),
  authSignOut: () => ipcRenderer.invoke("tool:auth:signout"),
  authStatus: () => ipcRenderer.invoke("tool:auth:status"),
  // [v0.24.0] 가입 승인 요청함
  requestAccess: (email, note) => ipcRenderer.invoke("tool:auth:requestAccess", email, note),
  listAccessRequests: () => ipcRenderer.invoke("tool:auth:listRequests"),
  approveAccessRequest: (email) => ipcRenderer.invoke("tool:auth:approve", email),
  rejectAccessRequest: (email) => ipcRenderer.invoke("tool:auth:reject", email),
  // [v0.59.0] 로그인 게이트(capri_accounts) — 승인 대기 목록/결정 + 알림 설정 + 소셜 로그인
  pendingAccounts: () => ipcRenderer.invoke("tool:auth:pendingAccounts"),
  decideAccount: (userId, decision) => ipcRenderer.invoke("tool:auth:decideAccount", userId, decision),
  getNotifySettings: () => ipcRenderer.invoke("tool:notify:get"),
  saveNotifySettings: (url) => ipcRenderer.invoke("tool:notify:save", url),
  authOAuth: (provider) => ipcRenderer.invoke("tool:auth:oauth", provider),
  // [v0.59.0] 폰 원격 조종 — 명령 보내기/조회 + PC 생존신호 조회(실행은 항상 PC가 자동으로 한다)
  sendCommand: (type, payload) => ipcRenderer.invoke("tool:remote:send", type, payload),
  listMyCommands: (limit) => ipcRenderer.invoke("tool:remote:list", limit),
  getDesktopHeartbeat: () => ipcRenderer.invoke("tool:remote:heartbeat"),
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
  placeBracket: (spec) => ipcRenderer.invoke("tool:order:bracket", spec), // [v0.25.0] 매수+익절+손절 한번에

  // [v0.26.0] 자동매매 — 시작/중지/현황 + 한도 설정
  autoTradeStart: () => ipcRenderer.invoke("tool:autoTrade:start"),
  autoTradeStop: () => ipcRenderer.invoke("tool:autoTrade:stop"),
  autoTradeStatus: () => ipcRenderer.invoke("tool:autoTrade:status"),
  reconcileAutoPositionsNow: () => ipcRenderer.invoke("tool:autoTrade:reconcileNow"), // [v0.45.0]
  saveAutoTradeSettings: (input) => ipcRenderer.invoke("tool:autoTrade:settings", input),
  getSystemPauseStatus: () => ipcRenderer.invoke("tool:systemPause:status"), // [v0.44.0]
  saveSystemPauseEnabled: (enabled) => ipcRenderer.invoke("tool:systemPause:save", enabled), // [v0.44.0]
  // [v0.28.0] 자동매매용 스크리너 조건 저장 + 수동 새로고침
  saveAutoScanSettings: (input) => ipcRenderer.invoke("tool:autoTrade:scanSettings", input),
  autoScanNow: () => ipcRenderer.invoke("tool:autoTrade:scanNow"),
  autoTradeHistory: () => ipcRenderer.invoke("tool:autoTrade:history"),
  getAutoReports: () => ipcRenderer.invoke("tool:autoTrade:reports"), // [v0.62.1] 자동매매 리포트
  // [v0.65.0] 매매연구소(신호 기록 모드)
  getLabStatus: () => ipcRenderer.invoke("tool:lab:status"),
  saveLabSettings: (input) => ipcRenderer.invoke("tool:lab:save", input),
  labScanNow: () => ipcRenderer.invoke("tool:lab:scanNow"),
  labReset: () => ipcRenderer.invoke("tool:lab:reset"),
  getLabSummary: (filter) => ipcRenderer.invoke("tool:lab:summary", filter),
  getLabSignal: (id) => ipcRenderer.invoke("tool:lab:signal", id),
  getLabBreakdown: (key, dim, filter) => ipcRenderer.invoke("tool:lab:breakdown", key, dim, filter),
  getLabCombined: (candleKey, linkKey, filter) => ipcRenderer.invoke("tool:lab:combined", candleKey, linkKey, filter),
  exportLab: (kind) => ipcRenderer.invoke("tool:lab:export", kind),
  verifyLab: (sample) => ipcRenderer.invoke("tool:lab:verify", sample),

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
  strengthStart: (symbol, intervalSec, auto) => ipcRenderer.invoke("tool:strength:start", symbol, intervalSec, auto),
  strengthStop: (symbol) => ipcRenderer.invoke("tool:strength:stop", symbol),
  strengthGet: (symbol) => ipcRenderer.invoke("tool:strength:get", symbol),
  onStrength: (cb) => {
    const h = (_ev, state) => cb(state);
    ipcRenderer.on("tool:strengthEvent", h);
    return () => ipcRenderer.removeListener("tool:strengthEvent", h);
  },

  // [v0.6.0] 종목 스크리너(탐색) — 스캔 + 진행률 구독
  screenerScan: (opts) => ipcRenderer.invoke("tool:screener:scan", opts),
  cancelScreenerScan: () => ipcRenderer.invoke("tool:screener:cancel"), // [v0.43.0]
  screenerChart: (symbol) => ipcRenderer.invoke("tool:screener:chart", symbol), // [v0.25.0]
  onScreenerProgress: (cb) => {
    const h = (_ev, p) => cb(p);
    ipcRenderer.on("tool:screenerProgress", h);
    return () => ipcRenderer.removeListener("tool:screenerProgress", h);
  },

  // [v0.7.0] 체결강도 자동 기록(매매 연동)
  tradesList: () => ipcRenderer.invoke("tool:trades:list"),
  todayReport: () => ipcRenderer.invoke("tool:report:today"),
  report: (kind, picked) => ipcRenderer.invoke("tool:report", kind, picked),
  tradeAnalysis: () => ipcRenderer.invoke("tool:trade-analysis"),
  reconcileAutoHistory: () => ipcRenderer.invoke("tool:reconcile-auto-history"), // [v0.64.0]
  tradeSyncPush: () => ipcRenderer.invoke("tool:tradesync:push"), // [v0.24.0] 로그인 비밀번호로 암호화
  tradeSyncPull: () => ipcRenderer.invoke("tool:tradesync:pull"), // [v0.24.0] 로그인 시 자동 호출됨
  autoStateSyncPush: () => ipcRenderer.invoke("tool:autostatesync:push"), // [v0.31.0] 자동매매 기록 동기화
  autoStateSyncPull: () => ipcRenderer.invoke("tool:autostatesync:pull"), // [v0.31.0] 로그인 시 자동 호출됨
  splitsSyncPush: () => ipcRenderer.invoke("tool:splitssync:push"), // [v0.61.7] 삼분할 타점 기록 동기화
  splitsSyncPull: () => ipcRenderer.invoke("tool:splitssync:pull"), // [v0.61.7] 로그인 시 자동 호출됨
  groupTradesPush: () => ipcRenderer.invoke("tool:grouptrades:push"), // [v0.35.0] 그룹 공유(평문)
  groupTradesPull: () => ipcRenderer.invoke("tool:grouptrades:pull"), // [v0.35.0] 그룹 전원 기록 받기
  groupSyncEnsure: () => ipcRenderer.invoke("tool:groupsync:ensure"), // [v0.56.0] 실시간 자동 동기화 시작(이미 돌면 무해)
  onGroupSync: (cb) => {
    const h = (_ev, members) => cb(members);
    ipcRenderer.on("tool:groupSyncEvent", h);
    return () => ipcRenderer.removeListener("tool:groupSyncEvent", h);
  },
  groupChatSend: (body) => ipcRenderer.invoke("tool:groupchat:send", body), // [v0.56.0] 그룹 채팅
  groupChatList: () => ipcRenderer.invoke("tool:groupchat:list"),
  getChangelog: () => ipcRenderer.invoke("tool:changelog:get"), // [v0.61.9] 업데이트 내역
  markChangelogSeen: (version) => ipcRenderer.invoke("tool:changelog:seen", version),
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
  cancelAutoPosition: (symbol, entry, enteredAtMs) => ipcRenderer.invoke("tool:auto:cancelPosition", symbol, entry, enteredAtMs),

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

  // [v0.32.0] 자동매매 관찰 확정·주문 알림 구독(화면이 OS/브라우저 알림으로 띄운다)
  onNotify: (cb) => {
    const h = (_ev, payload) => cb(payload);
    ipcRenderer.on("tool:notifyEvent", h);
    return () => ipcRenderer.removeListener("tool:notifyEvent", h);
  },

  // --- 자동 업데이트 ---
  appVersion: () => ipcRenderer.invoke("app:version"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  // [v0.58.0] macOS 차선책 — 받아 둔 dmg 폴더를 Finder로 열기
  openMacDmg: () => ipcRenderer.invoke("update:openMacDmg"),
  // [v0.60.0] macOS 직접 교체 자동업데이트 — "지금 바로 재시작"(그냥 앱을 끄면 종료
  //   훅이 알아서 교체한다).
  installMacSwap: () => ipcRenderer.invoke("update:installMacSwap"),
  // 업데이트 이벤트 구독(있음/진행률/완료/오류/맥 dmg 준비됨/맥 직접교체 준비됨). 반환값은 구독 해제 함수.
  onUpdate: (handlers) => {
    const onAvail = (_ev, info) => handlers.available?.(info);
    const onProg = (_ev, pct) => handlers.progress?.(pct);
    const onDone = () => handlers.downloaded?.();
    const onErr = (_ev, msg) => handlers.error?.(msg);
    const onMacDmg = (_ev, info) => handlers.macDmgReady?.(info);
    const onMacSwap = (_ev, info) => handlers.macSwapReady?.(info);
    ipcRenderer.on("update:available", onAvail);
    ipcRenderer.on("update:progress", onProg);
    ipcRenderer.on("update:downloaded", onDone);
    ipcRenderer.on("update:error", onErr);
    ipcRenderer.on("update:macDmgReady", onMacDmg);
    ipcRenderer.on("update:macSwapReady", onMacSwap);
    return () => {
      ipcRenderer.removeListener("update:available", onAvail);
      ipcRenderer.removeListener("update:progress", onProg);
      ipcRenderer.removeListener("update:downloaded", onDone);
      ipcRenderer.removeListener("update:error", onErr);
      ipcRenderer.removeListener("update:macDmgReady", onMacDmg);
      ipcRenderer.removeListener("update:macSwapReady", onMacSwap);
    };
  },
});
