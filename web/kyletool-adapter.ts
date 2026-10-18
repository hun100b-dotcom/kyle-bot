// =============================================================================
// web/kyletool-adapter.ts — 웹앱에서 데스크톱과 '똑같은' 화면을 돌리기 위한 다리
// -----------------------------------------------------------------------------
// [무슨 일을 하나?]
//   데스크톱 앱의 화면(src/App.tsx)은 `window.kyletool.무엇()` 을 불러서 엔진과 대화합니다.
//   PC에서는 그 다리를 Electron(IPC)이 놓아 줍니다. 웹에는 Electron이 없으니
//   **똑같은 이름·똑같은 모양의 다리를 브라우저 안에** 놓아 주는 것이 이 파일입니다.
//
//   그 덕분에 화면 코드(2,600여 줄)와 엔진 코드(2,600여 줄)를 **하나도 다시 짜지 않고**
//   웹에서 그대로 씁니다. → PC와 웹이 같은 계산·같은 안전장치·같은 주문 규칙으로 동작합니다.
//
// [토스 호출은 어떻게?]
//   브라우저는 토스를 직접 못 부릅니다(CORS). 그래서 엔진의 토스 주소(TOSS_BASE_URL)를
//   **우리 프록시 서버 주소**로 바꿔 둡니다. 엔진은 평소처럼 호출하고, 프록시가
//   그대로 토스에 전달합니다. 엔진 코드는 자기가 프록시를 쓰는지도 모릅니다.
//
// [키는 어디에?]
//   폰 안에만 있습니다(브라우저 저장소). 프록시 서버는 지나가는 요청을 전달만 하고
//   저장하지 않습니다. 데스크톱과 같은 '마스터 비밀번호로 클라우드에서 불러오기'도 그대로 됩니다.
// =============================================================================

// [순서 중요] env 껍데기를 **엔진보다 먼저** 불러와야 한다(엔진이 불러오는 순간 설정을 읽기 때문).
import env, { setProxyBase } from "./env-shim";
import { ToolEngine } from "../electron/tool-engine";
import { fetchWithTimeout } from "../lib/fetch-timeout";

/**
 * ★ 중계 서버 기본 주소 ★
 *
 * [왜 비어 있나 — 중요한 교훈]
 *   한때 여기에 클라우드(Supabase) 프록시 주소를 넣어 뒀는데, **토스가 그 주소를 막습니다**
 *   (키에 IP 허용목록이 걸려 있고 클라우드 IP는 매 요청 바뀜 → 403 "IP address not allowed").
 *   그 결과 웹앱은 열리지만 시세·현황이 전부 실패했습니다. "작동 안 된다"의 원인이었습니다.
 *
 *   지금은 **집 PC 릴레이**만 씁니다. 집 PC 주소는 토스가 허용하기 때문입니다.
 *   릴레이 주소는 켤 때마다 바뀌므로 여기 고정할 수 없고, PC 앱이 만들어 주는
 *   QR(?api=...)로 전달됩니다. 그래서 기본값은 비어 있는 것이 정상입니다.
 */
const DEFAULT_API_BASE = "";

/** 프록시 주소를 정한다: ?api=(주소창) → 저장값 → 기본값(위 상수) */
export function resolveApiBase(): string {
  const KEY = "capri-api-base";
  try {
    const q = new URLSearchParams(location.search).get("api");
    if (q) {
      // 주소창으로 지정하면 그 값을 저장해 다음부터는 자동으로 쓴다.
      localStorage.setItem(KEY, q.trim().replace(/\/$/, ""));
    }
    return localStorage.getItem(KEY) ?? DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

/**
 * process.env 흉내내기.
 *   엔진과 lib/toss.ts 는 설정을 process.env 에서 읽고 씁니다(예: TOSS_CLIENT_ID).
 *   브라우저엔 process 가 없으니 같은 모양의 빈 객체를 만들어 둡니다.
 *   ※ 실제 키 값은 이 객체(메모리)와 브라우저 저장소에만 있고 서버로 가지 않습니다.
 */
function installProcessShim(apiBase: string): void {
  // 토스 주소를 프록시로 고정한다(엔진이 공식 주소로 되돌리려 해도 유지된다 — env-shim 참고).
  if (apiBase) {
    setProxyBase(`${apiBase}/api/toss`);

    // [v0.9.7] **폰에는 키를 넣지 않아도 되게** 한다.
    //   집 PC 릴레이에 이미 키가 있으므로, 폰은 "RELAY" 라는 표식만 보내고
    //   실제 인증은 릴레이가 PC의 키로 처리한다.
    //   · 폰에 실제 키가 저장되지 않아 더 안전하다.
    //   · 사장님이 직접 키를 넣었다면 그 값을 그대로 존중한다(덮어쓰지 않는다).
    //   (키 동기화용 클라우드가 멈춰 있어 폰이 통째로 막혔던 문제의 해결책이기도 하다)
    if (!env.TOSS_CLIENT_ID) env.TOSS_CLIENT_ID = "RELAY";
    if (!env.TOSS_CLIENT_SECRET) env.TOSS_CLIENT_SECRET = "RELAY";
    if (!env.TOSS_ACCOUNT) env.TOSS_ACCOUNT = "RELAY";
  } else {
    installNoRelayGuard(); // 중계 주소가 없으면 '왜 안 되는지' 알려 주는 안내를 깐다
  }
  env.DRY_RUN = env.DRY_RUN ?? "true"; // 실주문은 [실주문] 토글을 켜야만 나간다
  env.TOSS_MOCK = "false"; //            연습(목) 서버는 브라우저에서 띄울 수 없다
}

/**
 * installNoRelayGuard — 중계 주소가 없을 때 '무슨 일을 해야 하는지' 알려 준다.
 *
 *   중계 주소가 없으면 엔진은 토스 공식 주소로 직접 요청하고, 브라우저는 그걸 CORS로 막습니다.
 *   그때 화면에 뜨는 메시지("Failed to fetch")로는 사장님이 무엇을 해야 할지 알 수 없습니다.
 *   그래서 토스로 향하는 요청을 가로채, 해야 할 일을 한국어로 알려 줍니다.
 *   (계산기·장 상태 등 인터넷이 필요 없는 기능은 그대로 동작합니다)
 */
function installNoRelayGuard(): void {
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://openapi.tossinvest.com")) {
      return Promise.reject(
        // [v0.99.0 긴급 수정] "설정 → 📱 폰에서 쓰기 → 폰 연결 켜기 → QR 찍기"는 v0.91.0에
        //   삭제된 옛(QR 중계) 방식 안내였다 — 지금은 그 메뉴 자체가 없다. 지금 아키텍처에서
        //   토스 실시간 조회는 PC(데스크톱 앱)에서만 가능하고, 폰(웹)은 PC가 클라우드에
        //   올려 둔 상태를 읽기만 한다(실시간 재조회가 아님) — 그 사실을 정직하게 안내한다.
        new Error(
          "이 기능은 토스에 실시간으로 접속해야 해서, 폰(웹)에서는 직접 쓸 수 없습니다." +
            "\n\n토스 실시간 조회·주문은 집 PC의 Capri 앱(데스크톱)에서만 됩니다. " +
            "폰에서는 PC가 클라우드에 올려 둔 최신 상태를 보기만 할 수 있어요." +
            "\n\n(계산기와 장 상태는 연결 없이도 쓸 수 있습니다.)",
        ),
      );
    }
    return orig(input as RequestInfo, init);
  }) as typeof fetch;
}

let engine: ToolEngine | null = null;

/** 엔진을 만들고 window.kyletool 다리를 놓는다(화면이 뜨기 전에 호출) */
export function installKyleTool(): ToolEngine {
  const apiBase = resolveApiBase();
  installProcessShim(apiBase);

  // 저장 폴더 이름은 브라우저 저장소의 접두어로만 쓰인다(실제 폴더는 없음).
  const e = new ToolEngine("capri-web");
  engine = e;

  // 화면이 구독하는 실시간 이벤트(매매일지·체결강도·스크리너 진행률·트레이드)
  const subs = {
    journal: new Set<(v: unknown) => void>(),
    strength: new Set<(v: unknown) => void>(),
    screener: new Set<(v: unknown) => void>(),
    trades: new Set<(v: unknown) => void>(),
    notify: new Set<(v: unknown) => void>(),
    groupSync: new Set<(v: unknown) => void>(),
  };
  e.on("journal", (v: unknown) => subs.journal.forEach((f) => f(v)));
  e.on("strength", (v: unknown) => subs.strength.forEach((f) => f(v)));
  e.on("screener:progress", (v: unknown) => subs.screener.forEach((f) => f(v)));
  e.on("trades", (v: unknown) => subs.trades.forEach((f) => f(v)));
  e.on("notify", (v: unknown) => subs.notify.forEach((f) => f(v))); // [v0.32.0] 관찰 확정·주문 알림
  e.on("groupSync", (v: unknown) => subs.groupSync.forEach((f) => f(v))); // [v0.56.0] 그룹 실시간 동기화

  const api = {
    // ── 상태·설정 ──────────────────────────────────────────────
    //   [웹 보정] 키가 없으면 엔진은 '연습(mock) 모드'가 된다. 데스크톱에선 가짜 서버로
    //   주문이 실제로 체결되지만, 웹에는 가짜 서버가 없어 아무 주문도 나갈 수 없다.
    //   그런데 화면은 "실주문 활성 — 실제 체결됩니다" 빨간 경고를 띄운다(연습 모드 기준).
    //   웹에서는 사실과 다르고 겁만 주므로, 이 경우 드라이런으로 표시를 바로잡는다.
    //   ※ 실제 주문 가능 여부를 바꾸는 게 아니라 '표시'만 정확하게 만드는 것이다.
    status: () => {
      const st = e.getStatus();
      return Promise.resolve(st.mode === "mock" ? { ...st, dryRun: true } : st);
    },
    journal: () => Promise.resolve(e.getJournal()),
    getSettings: () => Promise.resolve(e.getSettings()),
    saveSettings: (input: Parameters<ToolEngine["saveSettings"]>[0]) => e.saveSettings(input),
    saveSeedSettings: (input: Parameters<ToolEngine["saveSeedSettings"]>[0]) => Promise.resolve(e.saveSeedSettings(input)),
    saveDefaultRatio: (input: Parameters<ToolEngine["saveDefaultRatio"]>[0]) => Promise.resolve(e.saveDefaultRatio(input)),

    // ── 계정(멀티유저) + 키 클라우드 동기화 ────────────────────
    authSignUp: (email: string, pw: string) => e.authSignUp(email, pw),
    authSignIn: (email: string, pw: string) => e.authSignIn(email, pw),
    authSignOut: () => Promise.resolve(e.authSignOut()),
    authStatus: () => Promise.resolve(e.authStatus()),
    // [v0.24.0] 가입 승인 요청함
    requestAccess: (email: string, note?: string) => e.requestAccess(email, note),
    listAccessRequests: () => e.listAccessRequests(),
    approveAccessRequest: (email: string) => e.approveAccessRequest(email),
    rejectAccessRequest: (email: string) => e.rejectAccessRequest(email),
    // [v0.59.0] 로그인 게이트(capri_accounts) — 진짜 승인 대기 목록
    listPendingAccounts: () => e.listPendingAccounts(),
    decideAccount: (userId: string, decision: "approved" | "rejected") => e.decideAccount(userId, decision),
    getNotifySettings: () => e.getNotifySettings(),
    saveNotifySettings: (url: string) => e.saveNotifySettings(url),
    getMyNotifySettings: () => e.getMyNotifySettings(),
    testTossConnection: () => e.testTossConnection(), // [v0.91.0]
    sendMyDiscordTest: () => e.sendMyDiscordTest(), //   [v0.91.0]
    saveMyNotifySettings: (url: string) => e.saveMyNotifySettings(url),
    // [v0.59.0→v0.60.0] 소셜 로그인(구글만 — 카카오는 오너 요청으로 제거) — 웹은 전체
    //   페이지 이동(리다이렉트) 방식. 돌아온 뒤 처리는 이 파일 아래
    //   installOAuthCallbackHandler()가 페이지 로드 시 자동으로 한다.
    authOAuth: (provider: "google") => {
      const redirectTo = `${location.origin}${location.pathname}`;
      location.href = e.authOAuthUrl(provider, redirectTo);
      return new Promise<{ ok: boolean; message: string }>(() => {}); // 페이지가 이동하므로 이 값은 쓰이지 않는다
    },
    syncPushKeys: () => e.syncPushKeys(),
    syncPullKeys: () => e.syncPullKeys(),
    // [v0.59.0] 폰 원격 조종 — 폰은 "넣기"·"조회"만 한다("실행"은 PC의 startRemoteControlLoop
    //   전용이라 이 어댑터는 아예 그 메서드를 부르지 않는다 — 웹 빌드에서 명령 실행 루프가
    //   도는 일은 구조적으로 없다).
    sendCommand: (type: string, payload?: Record<string, unknown>) => e.sendCommand(type, payload),
    listMyCommands: (limit?: number) => e.listMyCommands(limit),
    getDesktopHeartbeat: () => e.getDesktopHeartbeat(),

    // ── 안전장치 토글 ──────────────────────────────────────────
    setKillSwitch: (on: boolean) => e.setKillSwitch(!!on),
    setLiveOrders: (on: boolean) => Promise.resolve(e.setLiveOrders(!!on)),
    setPriceGuard: (on: boolean, pct?: number) => Promise.resolve(e.setPriceGuard(!!on, pct)),
    setSkipConfirm: (on: boolean) => Promise.resolve(e.setSkipConfirm(!!on)),

    // ── 시세·환율·계좌 ─────────────────────────────────────────
    quote: (symbol: string) => e.quote(symbol),
    fx: () => e.fx(),
    setManualFx: (rate: number) => Promise.resolve(e.setManualFx(rate)),
    buyingPower: () => e.refreshBuyingPower(),
    accountSummary: () => e.accountSummary(),
    sellable: (symbol: string) => e.sellableQty(symbol),
    capacity: (symbol: string, price?: number) => e.orderCapacity(symbol, price),
    calc: (req: Parameters<ToolEngine["calc"]>[0]) => Promise.resolve(e.calc(req)),

    // ── 주문(진입·조건주문·매도) ───────────────────────────────
    placeEntry: (spec: Parameters<ToolEngine["placeEntry"]>[0]) => e.placeEntry(spec),
    placeOco: (spec: Parameters<ToolEngine["placeOco"]>[0]) => e.placeOco(spec),
    placeOto: (spec: Parameters<ToolEngine["placeOto"]>[0]) => e.placeOto(spec),
    placeBracket: (spec: Parameters<ToolEngine["placeBracket"]>[0]) => e.placeBracket(spec), // [v0.25.0]

    // [v0.26.0] 자동매매 — "앱이 켜져 있는 동안"은 웹에서는 "이 브라우저 탭이 열려 있는 동안"과 같다.
    // [실측 발견] 이 4개는 엔진에서 동기 함수라, Electron IPC(invoke)는 알아서 Promise로 감싸 주지만
    //   웹은 그 다리가 없어 그대로 반환하면 "...then is not a function"으로 화면이 깨진다(getSettings와
    //   동일한 이유·동일한 해법 — Promise.resolve로 감싼다).
    autoTradeStart: () => Promise.resolve(e.startAutoTrade()),
    autoTradeStop: () => Promise.resolve(e.stopAutoTrade()),
    autoTradeStatus: () => Promise.resolve(e.getAutoTradeStatus()),
    reconcileAutoPositionsNow: () => e.reconcileAutoPositionsNow(), // [v0.45.0]
    saveAutoTradeSettings: (input: Parameters<ToolEngine["saveAutoTradeSettings"]>[0]) => Promise.resolve(e.saveAutoTradeSettings(input)),
    getSystemPauseStatus: () => Promise.resolve(e.getSystemPauseStatus()), // [v0.44.0]
    saveSystemPauseEnabled: (enabled: boolean) => Promise.resolve(e.saveSystemPauseEnabled(enabled)), // [v0.44.0]
    saveAutoScanSettings: (input: Parameters<ToolEngine["saveAutoScanSettings"]>[0]) => Promise.resolve(e.saveAutoScanSettings(input)),
    autoScanNow: () => e.autoScanNow(),
    autoTradeHistory: () => Promise.resolve(e.getAutoTradeHistory()),
    getAutoReports: () => e.getAutoReports(), // [v0.62.1] 폰은 로컬 기록이 없어 PC가 올린 미러에서 읽는다
    // [v0.65.0] 매매연구소 — 폰의 로컬 엔진에는 데이터가 없으므로 화면은 PC가 올린 미러(getLiveState().lab)를 보고, 켜기/끄기만 원격 명령으로 보낸다.
    getWatchHistory: (filter?: Parameters<typeof e.getWatchHistory>[0]) => Promise.resolve(e.getWatchHistory(filter)),
    getWatchHistorySummary: (sinceMs?: Parameters<typeof e.getWatchHistorySummary>[0]) => Promise.resolve(e.getWatchHistorySummary(sinceMs)),
    getLabStatus: () => Promise.resolve(e.getLabStatus()),
    saveLabSettings: (input: Parameters<typeof e.saveLabSettings>[0]) => Promise.resolve(e.saveLabSettings(input)),
    labScanNow: () => e.labScanNow(),
    labReset: () => Promise.resolve(e.labReset()),
    getLabSummary: (filter?: Parameters<typeof e.getLabSummary>[0]) => Promise.resolve(e.getLabSummary(filter)),
    getLabSignal: (id: string) => Promise.resolve(e.getLabSignal(id)),
    getLabBreakdown: (key: string, dim: Parameters<typeof e.getLabBreakdown>[1], filter?: Parameters<typeof e.getLabBreakdown>[2]) => Promise.resolve(e.getLabBreakdown(key, dim, filter)),
    getLabCombined: (candleKey: string, linkKey: string, filter?: Parameters<typeof e.getLabCombined>[2]) => Promise.resolve(e.getLabCombined(candleKey, linkKey, filter)),
    exportLab: (kind: Parameters<typeof e.exportLab>[0]) => Promise.resolve(e.exportLab(kind)),
    verifyLab: (sample?: number) => e.verifyLab(sample),
    getLabAssessment: (realtimeOnly?: boolean) => Promise.resolve(e.getLabAssessment(realtimeOnly !== false)),
    placeSell: (spec: Parameters<ToolEngine["placeSell"]>[0]) => e.placeSell(spec),
    openOrders: () => e.openOrders(),
    conditionals: () => e.conditionals(),
    cancelOrder: (id: string) => e.cancelNormalOrder(id),
    cancelConditional: (id: string) => e.cancelConditional(id),
    cancelAutoPosition: (symbol: string, entry: number, enteredAtMs: number) => e.cancelAutoPosition(symbol, entry, enteredAtMs),
    getSyncStatus: () => e.getSyncStatus(), // [v0.88.0]
    unlockSync: (password: string) => e.unlockSync(password),
    syncPushAll: () => e.syncPushAll(),
    dismissUnprotected: async (symbol: string) => e.dismissUnprotected(symbol), // [v0.69.4]

    // ── 현황(보유·주문·포지션·근거) ────────────────────────────
    positions: () => e.positions(),
    holdingsView: () => e.holdingsView(),
    ordersView: (status: "OPEN" | "CLOSED") => e.ordersView(status),
    condOrdersView: (status: "OPEN" | "CLOSED") => e.condOrdersView(status),
    rationales: () => Promise.resolve(e.getRationales()),

    // ── 삼분할 타점 기록 ───────────────────────────────────────
    splitsList: () => Promise.resolve(e.getSplits()),
    splitsAdd: (input: Parameters<ToolEngine["addSplit"]>[0]) => Promise.resolve(e.addSplit(input)),
    splitsDelete: (id: string) => Promise.resolve(e.deleteSplit(id)),
    splitsToggle: (id: string, level: number) => Promise.resolve(e.toggleSplitEntered(id, level)),
    splitsRename: (id: string, memo: string) => Promise.resolve(e.renameSplit(id, memo)),

    // ── 체결강도 ───────────────────────────────────────────────
    strengthStart: (symbol: string, intervalSec?: number, auto?: boolean) => e.startStrength(symbol, intervalSec, auto),
    strengthStop: (symbol: string) => Promise.resolve(e.stopStrength(symbol)),
    strengthGet: (symbol: string) => Promise.resolve(e.getStrengthState(symbol)),
    onStrength: (cb: (v: unknown) => void) => {
      subs.strength.add(cb);
      return () => subs.strength.delete(cb);
    },

    // ── 스크리너(탐색) ─────────────────────────────────────────
    screenerScan: (opts?: { bodyRatio?: number; count?: number; priceMin?: number; priceMax?: number }) => e.scanScreener(opts),
    cancelScreenerScan: () => Promise.resolve(e.cancelScreenerScan()), // [v0.43.0]
    screenerChart: (symbol: string) => e.getScreenerChart(symbol), // [v0.25.0]
    onScreenerProgress: (cb: (v: unknown) => void) => {
      subs.screener.add(cb);
      return () => subs.screener.delete(cb);
    },

    // ── 트레이드 기록 ──────────────────────────────────────────
    tradesList: () => Promise.resolve(e.getTradeLog()),
    todayReport: () => Promise.resolve(e.todayReport()), // [v0.9.1] 오늘의 매매 리포트
    report: (kind: Parameters<ToolEngine["report"]>[0], picked?: string) => Promise.resolve(e.report(kind, picked)),
    tradeAnalysis: () => Promise.resolve(e.tradeAnalysis()), // [v0.19.0] 매매 사이클 분석
    reconcileAutoHistory: () => Promise.resolve(e.reconcileAutoHistory()), // [v0.64.0] 토스 실제 체결과 대조
    // [v0.10.0→v0.24.0] 매매 이력 동기화 — 로그인 비밀번호로 암호화, 로그인 시 자동 호출됨
    tradeSyncPush: () => e.syncPushTrades(),
    tradeSyncPull: () => e.syncPullTrades(),
    autoStateSyncPush: () => e.syncPushAutoState(),
    autoStateSyncPull: () => e.syncPullAutoState(),
    // [v0.61.7 — ③ 전수조사 중간-2] 삼분할 타점 기록 기기 간 동기화.
    splitsSyncPush: () => e.syncPushSplits(),
    splitsSyncPull: () => e.syncPullSplits(),
    groupTradesPush: () => e.syncPushGroupTrades(),
    groupTradesPull: () => e.syncPullGroupHistory(),
    groupSyncEnsure: () => { e.startGroupSyncLoop(); return Promise.resolve({ ok: true }); },
    onGroupSync: (cb: (v: unknown) => void) => {
      subs.groupSync.add(cb);
      return () => subs.groupSync.delete(cb);
    },
    groupChatSend: (body: string) => e.sendGroupChatMessage(body),
    groupChatList: () => e.getGroupChatMessages(),
    // [v0.61.9] "업데이트 내역" 탭 — getChangelog는 async라 그대로, markChangelogSeen은
    //   엔진에서 동기 함수라(getSettings 등과 동일 이유) Promise.resolve로 감싼다.
    getChangelog: () => e.getChangelog(),
    markChangelogSeen: (version: string) => Promise.resolve(e.markChangelogSeen(version)),
    tradesStats: () => Promise.resolve(e.getTradeStats()),
    tradesClose: (id: string, exitPrice: number, kind: "tp" | "sl" | "manual") => e.closeTradeManual(id, exitPrice, kind),
    tradesDelete: (id: string) => Promise.resolve(e.deleteTrade(id)),
    onTrades: (cb: (v: unknown) => void) => {
      subs.trades.add(cb);
      return () => subs.trades.delete(cb);
    },

    // ── 매매일지 이벤트 ────────────────────────────────────────
    onJournal: (cb: (v: unknown) => void) => {
      subs.journal.add(cb);
      return () => subs.journal.delete(cb);
    },

    // [v0.32.0] 자동매매 관찰 확정·주문 알림(브라우저 Notification API로 화면이 띄운다)
    onNotify: (cb: (v: unknown) => void) => {
      subs.notify.add(cb);
      return () => subs.notify.delete(cb);
    },

    // ── 연습(목) 모드는 웹에서 불가 — 누르면 안내만 ────────────
    mockSetPrice: (_symbol: string, _price: number) =>
      Promise.reject(new Error("연습 모드는 웹앱에서 지원하지 않습니다(PC용 Capri를 사용하세요).")),

    // [v0.60.5 → v0.72.0 긴급 수정] 지금 이 웹 세션이 토스에 실제로 닿을 수 있는지(QR로 집 PC
    //   중계 연결이 돼 있는지). 없으면(apiBase 빈 값) 화면이 "감시 중 포지션을 직접 재확인"처럼
    //   실제 토스 호출이 필요한 폴링을 스스로 끄는 데 쓴다 — 안 그러면 매번 실패만 반복하며
    //   "폰 연결이 아직 안 돼 있습니다" 경고가 포지션에 계속 쌓인다(오너 실사용 보고).
    //   [v0.72.0 — 오너 보고 "매매기록 탭이 전부 작동 안 함, 새로고침도 무반응" 원인 규명]
    //   예전엔 apiBase 문자열이 "있는지"만 보고 true로 믿었다 — 그런데 이 문자열은 QR을 한 번
    //   스캔하면 브라우저에 영구 저장돼, **그 뒤로 집 PC(릴레이)가 꺼지거나 재워지거나 터널이
    //   끊겨도 문자열 자체는 그대로 남아** 계속 "연결됨"으로 잘못 보고했다. 그러면 주문현황
    //   탭은 새로고침 버튼이 꺼지지 않은 채(disabled 조건이 이 값을 보므로) 눌러도 매번 조용히
    //   실패하고, 자동매매기록 탭은 "지금 토스에 직접 물어보기" 경로를 타다가 똑같이 실패해
    //   클라우드 동기화(폴백)로 안 넘어갔다 — 오너가 "여러 탭이 동시에 먹통"이라고 느낀 진짜
    //   원인이다. 이제는 문자열 존재 여부가 아니라 **릴레이의 헬스체크(/api/health)를 실제로
    //   불러서 응답이 오는지**로 판단한다(electron/relay.ts가 토큰 없이도 응답하는 전용 경로 —
    //   새 서버 추가 없이 이미 있는 것을 그대로 씀). 아래 App.tsx 쪽도 이 확인을 한 번만 하지
    //   않고 30초마다 다시 해, PC가 꺼졌다 켜져도 새로고침 없이 자동으로 복구되게 했다.
    hasTossRelay: () => {
      if (!apiBase) return Promise.resolve(false); // 아예 QR을 스캔한 적 없음 — 네트워크 호출 불필요
      return fetchWithTimeout(`${apiBase}/api/health`, { method: "GET" }, 5000, "toss-relay-health")
        .then((r) => r.ok)
        .catch(() => false); // 타임아웃·연결거부 등 전부 "연결 안 됨"으로 간주(안전한 쪽)
    },
    // [v0.61.0] 상태 미러 — PC가 올려 둔 최신 자동매매 현황+최근 로그를 읽는다(capri_live_state).
    getLiveState: () => e.getLiveState(),

    // ── 앱 업데이트: 웹은 서비스 워커가 담당하므로 여기선 무해한 값만 ──
    // [v0.60.8 긴급 수정 — 오너 실사용 보고 "버전 정보에 vweb-202610010438만 떠서 뭔
    //   버전인지 모르겠다"] 빌드 타임스탬프만 보여줬던 걸 package.json 버전(데스크톱
    //   화면·릴리스 태그와 완전히 같은 값, 예: "0.60.8")으로 바꾸고, 빌드 시각은 괄호
    //   보조 정보로만 남긴다 — 오너가 지금 버전이 PC·릴리스 노트와 같은지 바로 비교 가능.
    appVersion: () => Promise.resolve(`${__APP_VERSION__} (web ${__BUILD_ID__})`),
    downloadUpdate: () => Promise.resolve({ ok: true }),
    installUpdate: () => Promise.resolve({ ok: true }),
    onUpdate: (_cb: (v: unknown) => void) => () => {},
  };

  (window as unknown as { kyletool: typeof api }).kyletool = api;
  return e;
}

/**
 * [v0.59.0] 소셜 로그인(구글·카카오)에서 돌아온 직후 처리.
 *   Supabase가 로그인 뒤 이 페이지 주소로 돌려보내며 #access_token=…&refresh_token=…
 *   형태로 토큰을 URL 조각(fragment)에 실어 준다. 화면(App)이 뜨기 전에 이걸 먼저
 *   처리해야 authStatus()가 첫 렌더부터 로그인 상태를 정확히 보여준다. 처리 후에는
 *   주소창에서 토큰 조각을 지운다(새로고침 시 재처리·주소창 노출 방지).
 */
export async function handleOAuthRedirect(engine: ToolEngine): Promise<void> {
  const hash = location.hash;
  if (!hash || !hash.includes("access_token")) return;
  try {
    await engine.applyOAuthCallback(hash);
  } finally {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

/** 이미 만들어진 엔진(진단용) */
export function getEngine(): ToolEngine | null {
  return engine;
}

declare const __BUILD_ID__: string;
declare const __APP_VERSION__: string;
