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
}

interface JournalEntry {
  ts: string;
  kind: "entry" | "oco" | "oto" | "cancel" | "dryrun" | "info";
  symbol: string;
  summary: string;
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
  nTicks: number;
  session: string;
}
/** [v0.5.0] 체결강도 상태(현재값 + 최근 시계열) */
interface StrengthState {
  symbol: string;
  running: boolean;
  intervalSec: number;
  latest: StrengthSample | null;
  samples: StrengthSample[];
  lastError: string | null;
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
  };
}
interface ScreenResult {
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
  excludedEtf: number;
  results: ScreenResult[];
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
  syncPushKeys(passphrase: string): Promise<{ ok: boolean; message: string }>;
  syncPullKeys(passphrase: string): Promise<{ ok: boolean; message: string }>;
  authSignUp(email: string, password: string): Promise<{ ok: boolean; needsConfirm: boolean; message: string }>;
  authSignIn(email: string, password: string): Promise<{ ok: boolean; message: string }>;
  authSignOut(): Promise<{ ok: boolean }>;
  authStatus(): Promise<{ email: string | null; loggedIn: boolean }>;
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
  strengthStart(symbol: string, intervalSec?: number): Promise<StrengthState>;
  strengthStop(symbol: string): Promise<StrengthState>;
  strengthGet(symbol: string): Promise<StrengthState>;
  onStrength(cb: (state: StrengthState) => void): () => void;
  // [v0.6.0] 종목 스크리너(탐색)
  screenerScan(bodyRatio?: number): Promise<ScreenRun>;
  onScreenerProgress(cb: (p: ScreenProgress) => void): () => void;
  // [v0.7.0] 체결강도 자동 기록(매매 연동)
  tradesList(): Promise<StrengthTrade[]>;
  todayReport(): Promise<DailyReport>;
  report(kind: PeriodKind, picked?: string): Promise<DailyReport>;
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

  // 자동 업데이트
  appVersion(): Promise<string>;
  downloadUpdate(): Promise<{ ok: boolean; error?: string }>;
  installUpdate(): Promise<void>;
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
