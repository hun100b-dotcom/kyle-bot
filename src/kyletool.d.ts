// =============================================================================
// src/kyletool.d.ts — 화면에서 쓰는 window.kyletool 타입 선언 (v2 도구)
//   실제 구현: electron/preload.cjs + electron/tool-engine.ts
// =============================================================================

type Technique = "split3" | "orderbook" | "candle" | "manual";

interface CalcLevel {
  level: number;
  entry: number;
  tp: number;
  sl: number;
}

interface CalcResult {
  technique: Technique;
  levels: CalcLevel[];
  note: string;
}

interface ToolStatus {
  mode: "mock" | "live";
  dryRun: boolean;
  liveOrdersEnabled: boolean;
  skipOrderConfirm: boolean;
  killSwitch: boolean;
  session: "day" | "pre" | "regular" | "after" | "closed";
  closedReason: string | null; // [v0.8.4] 휴장 사유(주말/공휴일 이름). 열려 있으면 null
  earlyClose: string | null; //   [v0.8.4] 조기폐장일 이름(정규장 뉴욕 13:00 마감)
  nextOpenNote: string | null; // [v0.8.4] 다음 개장 안내 문자열
  orderFrozen: boolean;
  clockNote: string;
  fxRate: number | null;
  fxSource: "toss" | "manual" | null;
  buyingPowerUsd: number | null;
}

interface PhoneState {
  status: string;
  url: string | null;
  qr: string | null;
  error: string | null;
}

/** [v0.9.1] 오늘의 매매 리포트 */
interface ReportRow {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  pnlUsd: number | null;
  pctAvg: number;
  pctBest: number;
  hasAmount: boolean;
}

type PeriodKind = "today" | "week" | "month" | "date";

interface DailyReport {
  dateKey: string;
  periodLabel: string;
  periodKind: PeriodKind;
  closed: number;
  openNow: number;
  tpCount: number;
  slCount: number;
  manualCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnlUsd: number | null;
  avgPct: number | null;
  best: ReportRow | null;
  rows: ReportRow[];
  /** [v0.9.8] 숫자의 출처: live=방금 받아옴 / cache=저장된 기록 / none=저장된 기록 없음 */
  source?: "live" | "cache" | "none";
  lastSyncMs?: number | null;
  savedTotal?: number;
  /** [v0.10.1] 매매가 너무 많아 이 기간 일부가 빠졌을 수 있으면 true(화면이 경고 표시). */
  truncated?: boolean;
}

interface JournalEntry {
  ts: string;
  kind: "entry" | "oco" | "oto" | "cancel" | "dryrun" | "info";
  symbol: string;
  summary: string;
}

/** [v0.32.0] 자동매매 관찰 확정·주문 알림 — PC/폰이 각자 Notification API로 띄운다. */
interface NotifyEvent {
  title: string;
  body: string;
  symbol: string;
  ts: string;
}

interface ToolSettings {
  mode: "mock" | "live";
  liveOrdersEnabled: boolean;
  priceGuardEnabled: boolean;
  priceGuardPct: number;
  skipOrderConfirm: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  account: string;
  // [v0.3.0] 세션별 시드 비율 + 시드 기준
  seedDayPct: number;
  seedPrePct: number;
  seedRegularPct: number;
  seedBasis: "auto" | "fixed";
  seedFixedUsd: number | null;
  // [v0.8.3] 기본 손익비
  defaultTpPct: number;
  defaultSlPct: number;
  // [v0.26.0] 자동매매 한도(3개, 전부 수정 가능) + 켜짐 여부(런타임 전용 — 저장 안 됨)
  autoTradeMaxPositions: number;
  autoTradeMaxLossPct: number;
  autoTradeMaxInvestPct: number;
  autoTradeEnabled: boolean;
  // [v0.28.0] 자동매매용 스크리너 조건(4개, 전부 수정 가능 — 메뉴얼 스크리너와 같은 항목)
  autoScanCount: number;
  autoScanPriceMin: number;
  autoScanPriceMax: number;
  autoScanBodyRatio: number;
  // [v0.33.0] "스크리닝 기준" 탭 — 추가 8개 조건(전부 켜짐/꺼짐 + 수치 수정 가능)
  autoScanEmaTrendEnabled: boolean;
  autoScanEmaPeriod: number;
  autoScanCloudEnabled: boolean;
  autoScanDojiWickMinRatio: number;
  autoScanDojiMaxAgeEnabled: boolean;
  autoScanDojiMaxAgeMinutes: number;
  autoScanNextCandleConfirmEnabled: boolean;
  autoScanExcludeEtf: boolean;
}

/** [v0.26.0] 자동매매가 지금 감시·보유 중인 포지션 하나. */
interface AutoPosition {
  symbol: string;
  entry: number;
  tp: number;
  sl: number;
  quantity: number;
  enteredAtMs: number;
  status: "watching" | "active";
  conditionalOrderId: string | null;
}

/** [v0.26.0] 자동매매 현황판. */
interface AutoTradeStatus {
  enabled: boolean;
  positions: AutoPosition[];
  realizedPnlUsd: number;
  maxPositions: number;
  maxLossPct: number;
  maxInvestPct: number;
  lastCycleAt: string | null;
  /** [v0.27.0] 이번 사이클에서 스캔한 결과("스크리닝 결과" 탭이 그대로 보여줌). 아직 안 돌았으면 null. */
  lastScan: ScreenRun | null;
  /** [v0.29.0] 다음 사이클 예정 시각(ms, epoch) — "다음 스캔까지 N분 N초" 카운트다운용. 꺼져 있으면 null. */
  nextCycleAtMs: number | null;
}

/** [v0.30.0] 자동매매기록 한 줄 — "자동매매기록" 탭이 그대로 보여준다. */
interface AutoTradeHistoryEntry {
  id: string;
  symbol: string;
  entry: number;
  tp: number;
  sl: number;
  quantity: number;
  enteredAt: string;
  status: "watching" | "active" | "closed_win" | "closed_loss" | "closed_manual" | "cancelled" | "oco_failed" | "dryrun";
  exitedAt: string | null;
  exitPrice: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  note: string;
}

/** [v0.3.0] orderCapacity(capacity) 응답 — 주문가능/보유 + 세션 시드 제안 */
interface Capacity {
  buyingPowerUsd: number | null;
  commissionRate: number | null;
  maxBuyQty: number | null;
  heldQty: number | null;
  sellableQty: number | null;
  session: "day" | "pre" | "regular" | "after" | "closed";
  sessionPct: number;
  seedBasis: "auto" | "fixed";
  seedUsd: number | null;
  seedQty: number | null;
}

interface OpenOrder {
  tossOrderId: string;
  status: string;
  symbol?: string;
  side?: "BUY" | "SELL";
  price?: number;
  filled_qty?: number;
}

interface CondOrder {
  conditionalOrderId: string;
  symbol?: string;
  type?: string;
  status?: string;
  quantity?: number;
  first?: { orderSide?: string; triggerPrice?: number; orderPrice?: number };
  second?: { orderSide?: string; triggerPrice?: number; orderPrice?: number } | null;
  expireDate?: string;
}

/** [v0.2.10] 주문 시점에 함께 보내는 "매매기법 근거" (왜 이 가격에 샀는가) */
interface RationaleInput {
  technique: Technique;
  /** [v0.30.0] 자동매매가 낸 주문인지 사람이 버튼을 눌렀는지. 안 보내면 "manual"로 간주. */
  source?: "auto" | "manual";
  level?: number; //     삼분할 몇 분할 타점인지
  baseClose?: number; // [삼분할] 전봉 종가
  ema200?: number; //    [삼분할] EMA200
  wallPrice?: number; // [호가창] 매수벽
  barOpen?: number; //   [캔들] 현재봉 시가
  entry?: number;
  tp?: number;
  sl?: number;
  tpPct?: number;
  slPct?: number;
  priceAtOrder?: number | null;
}

/** 저장된 근거 한 건(위 입력 + 주문 시점에 앱이 자동으로 채운 값) */
interface TradeRationale extends RationaleInput {
  clientOrderId: string;
  ts: string;
  kind: "entry" | "oco" | "oto";
  symbol: string;
  quantity: number;
  priceAtOrder: number | null;
  tossOrderId?: string;
  dryRun: boolean;
}

/** [v0.4.0] 저장된 삼분할 타점 한 줄(계산 결과 + '진입완료' 체크) */
interface SavedSplitLevel {
  level: number;
  entry: number;
  tp: number;
  sl: number;
  entered: boolean;
}
/** [v0.4.0] 저장된 삼분할 기록 한 건(종목 하나의 3개 타점 묶음) */
/** [v0.9.0] 계산기에 다시 채워 넣기 위한 원본 입력값(옛 기록에는 없을 수 있음) */
interface SplitInputs {
  technique: Technique;
  symbol: string;
  tpPct: string;
  slPct: string;
  qty: string;
  baseClose: string;
  ema200: string;
  wallPrice: string;
  barOpen: string;
  manualEntry: string;
  candleYang: boolean;
  gap: number | null;
  curPrice: number | null;
}

interface SavedSplit {
  id: string;
  ts: string;
  symbol: string;
  technique: Technique;
  levels: SavedSplitLevel[];
  tpPct: number | null;
  slPct: number | null;
  qty: number | null;
  memo: string;
  /** [v0.9.0] 계산기 원본 입력값 — 이 기능 이전 기록에는 없다(그때는 불러오기 비활성) */
  inputs?: SplitInputs;
}

/** [v0.5.0] 체결강도 시계열 한 점 */
interface StrengthSample {
  ts: string;
  tsMs: number;
  price: number | null;
  buyVol: number;
  sellVol: number;
  strength: number | null; // (매수/매도)×100. 매도 0이면 null("매수 일방")
  nTicks: number; // [v0.27.0] "최근 5분 시간창" 안의 표본 수(틱개수창 아님)
  windowCapped: boolean; // [v0.27.0] 서버 50건 상한에 걸려 일부 체결을 놓쳤을 가능성
  session: string;
}
/** [v0.5.0] 체결강도 상태(현재값 + 최근 시계열) */
interface TradeCycle {
  symbol: string;
  buyAtMs?: number;
  sellAtMs: number;
  holdMs?: number;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pct: number;
  win: boolean;
  technique?: string;
  entryStrength?: number | null;
  exitStrength?: number | null; // [v0.22.0] 청산 시 체결강도
}
interface TradeBucket { n: number; winRate: number | null; avgPct: number | null; }
interface TradeSymbolStat { symbol: string; n: number; wins: number; winRate: number | null; totalPnl: number; avgPct: number; }
interface TradeInsights {
  n: number; wins: number; losses: number; winRate: number | null;
  totalPnl: number; avgPct: number | null; avgHoldMin: number | null;
  best: TradeCycle | null; worst: TradeCycle | null;
  strong: TradeBucket; weak: TradeBucket; strengthKnown: number;
  headline: string | null; bySymbol: TradeSymbolStat[];
}

interface StrengthSignals {
  bottomReversal: boolean;
  bullishDivergence: boolean;
  peakRollover: boolean;
  phase: "하락중" | "진입" | "보유" | "익절" | "고점경고" | "중립";
  thinSample: boolean;
}

interface StrengthState {
  symbol: string;
  running: boolean;
  intervalSec: number;
  windowSec: number; // [v0.27.0] 체결강도 시간창 길이(초) — 지금은 고정 300(5분)
  latest: StrengthSample | null;
  samples: StrengthSample[];
  lastError: string | null;
  signals: StrengthSignals; // [v0.12.0]
}

/** [v0.6.0] 스크리너 결과 한 종목 */
type ScreenStatus = "confirmed" | "watch" | "none" | "insufficient";
interface EvidenceCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  bearish: boolean;
}
interface ScreenEvidence {
  mode: "ha" | "normal";
  sessionStart: string;
  sessionHigh: number | null;
  sessionHighTime: string | null;
  doji: (EvidenceCandle & { bodyRatio: number | null; upperWickPct: number | null; lowerWickPct: number | null }) | null;
  next: EvidenceCandle | null;
  filters: {
    priceBand: boolean;
    aboveEma: boolean;
    aboveCloud: boolean;
    firstDoji: boolean;
    bothWicks: boolean;
    nextBearish: boolean;
    recentDoji: boolean; // [v0.25.0] 도지 발생 시점이 20분 이내인지
  };
}
interface ScreenResult {
  prevClose?: number | null; // [v0.16.0] 전봉종가(계산기 자동입력용)
  rank: number;
  symbol: string;
  price: number | null;
  ema200: number | null;
  cloudTop: number | null;
  priceInBand: boolean;
  aboveEma: boolean;
  aboveCloud: boolean;
  status: ScreenStatus;
  sessionHigh: number | null;
  proximityPct: number | null;
  n1m: number;
  n5m: number;
  evidence: ScreenEvidence | null;
  note?: string;
}
interface ScreenProgress {
  phase: "ranking" | "scanning" | "done";
  done: number;
  total: number;
  symbol: string;
}
interface ScreenRun {
  scannedAt: string;
  total: number;
  bodyRatio: number;
  priceMin: number;
  priceMax: number;
  excludedEtf: number;
  results: ScreenResult[];
}

/** [v0.25.0] 탐색 종목 차트 캔들/전체 */
interface ScreenChartCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
interface ScreenChart {
  symbol: string;
  candles: ScreenChartCandle[];
  ema200: number | null;
  cloudTop: number | null;
  sessionHigh: number | null;
  sessionHighTime: string | null;
  dojiTime: string | null;
  nextTime: string | null;
  price: number | null;
  patternStatus: ScreenStatus;
}

/** [v0.7.0] 체결강도 자동 기록 트레이드 */
interface TradeSnapshot {
  strength: number | null;
  buyVol: number;
  sellVol: number;
  rising: boolean | null;
}
interface StrengthTrade {
  id: string;
  symbol: string;
  mode: "mock" | "dryrun" | "real";
  entryTs: string;
  entryPrice: number;
  entry: TradeSnapshot | null;
  exitTs: string | null;
  exitPrice: number | null;
  exit: TradeSnapshot | null;
  exitKind: "tp" | "sl" | "manual" | null;
  resultPct: number | null;
  outcome: "win" | "loss" | null;
}
interface TradeStats {
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgEntryStrengthWin: number | null;
  avgEntryStrengthLoss: number | null;
  avgResultPct: number | null;
}

/** 보유 포지션 한 줄(근거 + 실시간 손익) */
interface PositionView {
  symbol: string;
  quantity: number;
  currency: string;
  avgPrice: number | null;
  entryPrice: number | null;
  entrySource: "rationale" | "toss" | "none";
  currentPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  toTpPct: number | null;
  toSlPct: number | null;
  rationale: TradeRationale | null;
}

/** [v0.3.3] 보유 한 줄(holdings 전부 + 근거) */
interface HoldingRow {
  symbol: string;
  name: string | null;
  marketCountry: string | null;
  currency: string;
  quantity: number;
  lastPrice: number | null;
  avgPrice: number | null;
  purchaseAmt: number | null;
  marketValueAmt: number | null;
  pnlAmt: number | null;
  pnlRate: number | null;
  dailyPnlAmt: number | null;
  dailyPnlRate: number | null;
  commission: number | null;
  tax: number | null;
  rationale: TradeRationale | null;
}
interface HoldingsSummary {
  marketValueUsd: number | null;
  marketValueKrw: number | null;
  pnlUsd: number | null;
  pnlKrw: number | null;
  pnlRate: number | null;
  dailyPnlUsd: number | null;
  dailyPnlKrw: number | null;
}
interface OrderRow {
  orderId: string;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  orderType: string | null;
  statusRaw: string | null;
  statusStd: string;
  price: number | null;
  quantity: number | null;
  orderAmount: number | null;
  currency: string | null;
  timeInForce: string | null;
  orderedAt: string | null;
  canceledAt: string | null;
  filledQty: number | null;
  avgFilledPrice: number | null;
  filledAmount: number | null;
  commission: number | null;
  tax: number | null;
  filledAt: string | null;
  isOpen: boolean;
}
interface CondLegView {
  legType: string | null;
  status: string | null;
  triggerPrice: number | null;
  orderPrice: number | null;
  triggeredOrderId: string | null;
}
interface CondOrderRow {
  conditionalOrderId: string;
  type: string | null;
  status: string | null;
  symbol: string | null;
  market: string | null;
  quantity: number | null;
  orderType: string | null;
  expireDate: string | null;
  createdAt: string | null;
  first: CondLegView | null;
  second: CondLegView | null;
  rationale: TradeRationale | null;
  isOpen: boolean;
}

interface KyletoolBridge {
  status(): Promise<ToolStatus>;
  journal(): Promise<JournalEntry[]>;
  getSettings(): Promise<ToolSettings>;
  saveSettings(input: { mode: "mock" | "live"; clientId?: string; clientSecret?: string; account?: string }): Promise<ToolSettings>;
  saveDefaultRatio(input: { tpPct?: number; slPct?: number }): Promise<ToolSettings>;
  saveSeedSettings(input: {
    seedDayPct?: number;
    seedPrePct?: number;
    seedRegularPct?: number;
    seedBasis?: "auto" | "fixed";
    seedFixedUsd?: number | null;
  }): Promise<ToolSettings>;
  syncPushKeys(): Promise<{ ok: boolean; message: string }>;
  syncPullKeys(): Promise<{ ok: boolean; message: string }>;
  authSignUp(email: string, password: string): Promise<{ ok: boolean; needsConfirm: boolean; message: string; canRequestAccess?: boolean }>;
  authSignIn(email: string, password: string): Promise<{ ok: boolean; message: string }>;
  authSignOut(): Promise<{ ok: boolean }>;
  authStatus(): Promise<{ email: string | null; loggedIn: boolean; isOwner: boolean }>;
  /** [v0.24.0] 가입 승인 요청함 — 누구나 신청(로그인 불필요), 운영자만 조회·승인·거절 */
  requestAccess(email: string, note?: string): Promise<{ ok: boolean; message: string }>;
  listAccessRequests(): Promise<Array<{ email: string; note: string | null; requestedAt: string }>>;
  approveAccessRequest(email: string): Promise<{ ok: boolean; message: string }>;
  rejectAccessRequest(email: string): Promise<{ ok: boolean; message: string }>;
  setKillSwitch(on: boolean): Promise<void>;
  setLiveOrders(on: boolean): Promise<void>;
  setPriceGuard(on: boolean, pct?: number): Promise<void>;
  setSkipConfirm(on: boolean): Promise<void>;

  quote(symbol: string): Promise<number>;
  fx(): Promise<{ rate: number; source: "toss" | "manual" } | null>;
  setManualFx(rate: number): Promise<void>;
  buyingPower(): Promise<number | null>;
  accountSummary(): Promise<{ buyingPowerUsd: number | null; totalPnlUsd: number | null; totalPnlRate: number | null }>;
  sellable(symbol: string): Promise<number | null>;
  capacity(symbol: string, price?: number): Promise<Capacity>;

  calc(req: {
    technique: Technique;
    tpPct: number;
    slPct: number;
    baseClose?: number;
    ema200?: number;
    wallPrice?: number;
    barOpen?: number;
    entry?: number;
  }): Promise<CalcResult>;

  placeEntry(spec: {
    symbol: string;
    price: number;
    quantity: number;
    rationale?: RationaleInput;
  }): Promise<JournalEntry>;
  placeOco(spec: {
    symbol: string;
    quantity: number;
    tpTrigger: number;
    tpPrice: number;
    slTrigger: number;
    slPrice: number;
    expireDate: string;
    rationale?: RationaleInput;
  }): Promise<JournalEntry>;
  placeOto(spec: {
    symbol: string;
    quantity: number;
    entryTrigger: number;
    entryPrice: number;
    tpTrigger: number;
    tpPrice: number;
    expireDate: string;
    rationale?: RationaleInput;
  }): Promise<JournalEntry>;
  /** [v0.25.0] 매수+익절+손절 한번에 — 진입 접수 후 체결을 감시(최대 watchMinutes)하다 체결되면 자동으로 OCO(익절+손절) 등록 */
  placeBracket(spec: {
    symbol: string;
    price: number;
    quantity: number;
    tpTrigger: number;
    tpPrice: number;
    slTrigger: number;
    slPrice: number;
    expireDate: string;
    watchMinutes?: number;
    pollMs?: number; // [테스트 전용] 체결 확인 주기(기본 5000ms)
    rationale?: RationaleInput;
  }): Promise<JournalEntry>;
  // [v0.26.0] 자동매매 — 시작/중지/현황 + 한도 설정
  autoTradeStart(): Promise<AutoTradeStatus>;
  autoTradeStop(): Promise<AutoTradeStatus>;
  autoTradeStatus(): Promise<AutoTradeStatus>;
  saveAutoTradeSettings(input: { maxPositions?: number; maxLossPct?: number; maxInvestPct?: number }): Promise<ToolSettings>;
  // [v0.28.0] 자동매매용 스크리너 조건 저장 + 수동 새로고침(5분 기다리지 않고 지금 훑기)
  // [v0.33.0] "스크리닝 기준" 탭에서 8개 조건(켜짐/꺼짐 + 수치)이 추가됨 — 전부 선택 항목(안 보내면 이전값 유지)
  saveAutoScanSettings(input: {
    count?: number;
    priceMin?: number;
    priceMax?: number;
    bodyRatio?: number;
    emaTrendEnabled?: boolean;
    emaPeriod?: number;
    cloudEnabled?: boolean;
    dojiWickMinRatio?: number;
    dojiMaxAgeEnabled?: boolean;
    dojiMaxAgeMinutes?: number;
    nextCandleConfirmEnabled?: boolean;
    excludeEtf?: boolean;
  }): Promise<ToolSettings>;
  autoScanNow(): Promise<AutoTradeStatus>;
  /** [v0.30.0] 자동매매기록 — 자동매매가 낸 매매의 전체 생애주기 로그(읽기 전용, 최신순). */
  autoTradeHistory(): Promise<AutoTradeHistoryEntry[]>;
  rationales(): Promise<TradeRationale[]>;
  // [v0.4.0] 삼분할 타점 기록(여러 종목 동시 운용)
  splitsList(): Promise<SavedSplit[]>;
  splitsAdd(input: {
    symbol: string;
    technique: Technique;
    levels: CalcLevel[];
    tpPct: number | null;
    slPct: number | null;
    qty: number | null;
    memo?: string;
    inputs?: SplitInputs;
  }): Promise<SavedSplit[]>;
  splitsDelete(id: string): Promise<SavedSplit[]>;
  splitsToggle(id: string, level: number): Promise<SavedSplit[]>;
  splitsRename(id: string, memo: string): Promise<SavedSplit[]>; // [v0.5.1] 제목(메모) 수정
  // [v0.5.0] 체결강도 기록(온디맨드 시계열)
  strengthStart(symbol: string, intervalSec?: number, auto?: boolean): Promise<StrengthState>;
  strengthStop(symbol: string): Promise<StrengthState>;
  strengthGet(symbol: string): Promise<StrengthState>;
  onStrength(cb: (state: StrengthState) => void): () => void;
  // [v0.6.0] 종목 스크리너(탐색)
  screenerScan(opts?: { bodyRatio?: number; count?: number; priceMin?: number; priceMax?: number }): Promise<ScreenRun>;
  /** [v0.25.0] 탐색 결과 한 종목의 차트를 불러온다(클릭 시에만, 온디맨드). */
  screenerChart(symbol: string): Promise<ScreenChart>;
  onScreenerProgress(cb: (p: ScreenProgress) => void): () => void;
  // [v0.7.0] 체결강도 자동 기록(매매 연동)
  tradesList(): Promise<StrengthTrade[]>;
  todayReport(): Promise<DailyReport>;
  report(kind: PeriodKind, picked?: string): Promise<DailyReport>;
  tradeAnalysis(): Promise<{ cycles: TradeCycle[]; insights: TradeInsights; source: "live" | "cache" | "none" }>; // [v0.19.0]
  /** [v0.10.0→v0.24.0] 매매 이력 동기화(로그인 비밀번호로 암호화, 로그인 시 자동 호출됨) */
  tradeSyncPush(): Promise<{ ok: boolean; message: string; count?: number }>;
  tradeSyncPull(): Promise<{ ok: boolean; message: string; count?: number }>;
  /** [v0.31.0] 자동매매 기록(포지션+이력) 기기 간 동기화 — 로그인 시 자동 호출됨. */
  autoStateSyncPush(): Promise<{ ok: boolean; message: string; count?: number }>;
  autoStateSyncPull(): Promise<{ ok: boolean; message: string; count?: number }>;
  tradesStats(): Promise<TradeStats>;
  tradesClose(id: string, exitPrice: number, kind: "tp" | "sl" | "manual"): Promise<StrengthTrade[]>;
  tradesDelete(id: string): Promise<StrengthTrade[]>;
  onTrades(cb: (log: StrengthTrade[]) => void): () => void;
  positions(): Promise<PositionView[]>;
  holdingsView(): Promise<{ summary: HoldingsSummary; items: HoldingRow[] }>;
  ordersView(status: "OPEN" | "CLOSED"): Promise<OrderRow[]>;
  condOrdersView(status: "OPEN" | "CLOSED"): Promise<CondOrderRow[]>;
  placeSell(spec: { symbol: string; quantity: number; orderType: "LIMIT" | "MARKET"; price?: number }): Promise<JournalEntry>;
  openOrders(): Promise<OpenOrder[]>;
  conditionals(): Promise<CondOrder[]>;
  cancelOrder(id: string): Promise<JournalEntry>;
  cancelConditional(id: string): Promise<JournalEntry>;

  mockSetPrice(symbol: string, price: number): Promise<boolean>;

  // [폰에서 쓰기] 집 PC 릴레이 + 인터넷 터널 (웹앱에서는 없을 수 있어 선택 항목)
  phoneStart?(): Promise<PhoneState>;
  phoneStop?(): Promise<PhoneState>;
  phoneStatus?(): Promise<PhoneState>;
  onPhoneState?(cb: (v: PhoneState) => void): () => void;
  onJournal(cb: (entry: JournalEntry) => void): () => void;
  onNotify(cb: (entry: NotifyEvent) => void): () => void;

  // 자동 업데이트
  appVersion(): Promise<string>;
  downloadUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<{ ok: boolean; error?: string }>;
  onUpdate(handlers: {
    available?: (info: { version: string; notes: string }) => void;
    progress?: (pct: number) => void;
    downloaded?: () => void;
    error?: (msg: string) => void;
  }): () => void;
}

interface Window {
  kyletool: KyletoolBridge;
}
