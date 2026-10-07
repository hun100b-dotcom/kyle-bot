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

/** [v0.56.0] "서버 로그" 탭의 카테고리 토글 필터가 쓰는 대분류. */
type JournalCategory = "주문" | "인증" | "동기화" | "자동매매" | "시스템" | "오류";

interface JournalEntry {
  ts: string;
  kind: "entry" | "oco" | "oto" | "cancel" | "dryrun" | "info";
  symbol: string;
  summary: string;
  category?: JournalCategory;
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
  /** [v0.42.0] 장기간 미체결 자동취소 기준(분) — 전부터 있던 값이지만 하드코딩이라 화면에 안 보이고
   *  조절도 안 됐던 것을 오너 요청으로 노출/조절 가능하게 했다. */
  autoTradeWatchMinutes: number;
  /** [v0.61.8] 삼분할 매매기법의 몇 분할 타점을 자동매매 매수가로 쓸지(1~2). 공장값 1(가장
   *  얕은 눌림). 2를 고르면 더 깊이 눌렸을 때만 사는 보수적 진입(체결 자체는 덜 될 수 있음). */
  autoTradeEntryLevel: 1 | 1.5 | 2;
  /** [v0.63.0] 방어 전략 — 손절 방식(고정 % / EMA 기준), EMA 아래 여유%, 손절 종목 당일 재진입 금지, 연속 손절 자동중지 횟수(0=끔). 옛 PC면 없을 수 있음. */
  autoTradeSlMode?: "fixed" | "ema";
  autoTradeEmaStopBufferPct?: number;
  autoTradeReentryBlockEnabled?: boolean;
  autoTradeLossStreakLimit?: number;
  autoTradeReprotectVanished?: boolean; // [v0.69.0]
  autoTradeEnabled: boolean;
  /** [v0.44.0] 시스템 휴무 시간대(매일 05:00~17:00 KST — 스크리닝·주문·자동매매 전부 정지) 기능
   *  켜짐 여부. 다른 자동매매 토글과 달리 이건 재시작해도 유지된다(안전장치). */
  systemPauseEnabled: boolean;
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
  autoScanDojiMaxGapEnabled: boolean; // [v0.62.1]
  autoScanDojiMaxGapMinutes: number;
  /** [v0.63.0] 방어 필터 — EMA 최소 이격도·EMA 상승·변동성 상한(옛 PC면 없을 수 있음) */
  autoScanEmaMinGapEnabled?: boolean;
  autoScanEmaMinGapPct?: number;
  autoScanEmaSlopeEnabled?: boolean;
  autoScanAtrFilterEnabled?: boolean;
  autoScanAtrMaxPct?: number;
  autoScanNextCandleConfirmEnabled: boolean;
  autoScanExcludeEtf: boolean;
  /** [v0.45.0] "매매진행할 장" 선택 — 자동매매가 신규 진입을 시도할 세션(전부 켜짐/꺼짐). */
  autoScanDayEnabled: boolean;
  autoScanPreEnabled: boolean;
  autoScanRegularEnabled: boolean;
  autoScanAfterEnabled: boolean;
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
  /** [v0.60.0] 조건주문 상태 확인이 반복 실패했을 때의 경고(화면에 그대로 표시). */
  syncWarning?: string | null;
}

/** [v0.26.0] 자동매매 현황판. */
/** [v0.69.0] 보호주문 없이 남은 보유 종목 — 봇이 보호가 걸릴 때까지 반복 시도 중 */
interface UnprotectedPos {
  fillPrice?: number | null;
  symbol: string; entry: number; tp: number; sl: number; quantity: number; enteredAtMs: number;
  reason: string; sinceMs: number; attempts: number; lastAttemptMs: number | null; lastError: string | null;
}
interface AutoTradeStatus {
  enabled: boolean;
  unprotected?: UnprotectedPos[];
  orderBlocks?: Array<{ ts: string; symbol: string; kind: string; reasons: string[] }>; // [v0.69.2] 주문 전 검증에서 막힌 주문
  positions: AutoPosition[];
  realizedPnlUsd: number;
  maxPositions: number;
  maxLossPct: number;
  maxInvestPct: number;
  /** [v0.42.0] 장기간 미체결 자동취소 기준(분). */
  watchMinutes: number;
  lastCycleAt: string | null;
  /** [v0.27.0] 이번 사이클에서 스캔한 결과("스크리닝 결과" 탭이 그대로 보여줌). 아직 안 돌았으면 null. */
  lastScan: ScreenRun | null;
  /** [v0.45.0] 가장 최근 스캔 실패(취소 제외) 기록. 성공하면 즉시 null로 지워진다. */
  lastScanError: { message: string; atMs: number } | null;
  lastCycleSkipReason: { message: string; atMs: number } | null;
  /** [v0.29.0] 다음 사이클 예정 시각(ms, epoch) — "다음 스캔까지 N분 N초" 카운트다운용. 꺼져 있으면 null. */
  nextCycleAtMs: number | null;
  /** [v0.35.0] "확정인데 왜 안 사졌지?"에 답하는 사유 — 종목코드 → 한 줄 설명. 매 사이클 새로 채워짐. */
  skipReasons: Record<string, string>;
  /** [v0.40.0] auto 모드에서 "이번 실행" 동안 고정해 쓰는 시드 스냅샷(달러). fixed 모드거나
   *  아직 계산 전이면 null. */
  seedUsdSnapshot: number | null;
}

/** [v0.56.0] 그룹 채팅 메시지 한 줄(capri_group_chat). */
interface GroupChatMessage {
  id: number;
  email: string;
  body: string;
  createdAt: string; // ISO(UTC) — 화면에서 로컬 시각으로 변환해 표시
}

/** [v0.61.9] "업데이트 내역" 탭 한 줄 — 그룹 전원이 함께 보는 공개 변경 로그. */
interface ChangelogEntry {
  version: string;
  title: string;
  body: string;
  publishedAt: string;
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
  conditionalOrderId?: string | null;
  buyOrderId?: string | null;
  /** [v0.45.0] 이 매매가 실제로 어떤 스크리닝·리스크 설정으로 진입됐는지의 스냅샷(자동매매만,
   *  electron/tool-engine.ts의 AutoTradeHistoryEntry.criteriaSnapshot 주석 참고). */
  criteriaSnapshot?: {
    bodyRatio: number;
    emaTrendEnabled: boolean;
    emaPeriod: number;
    cloudEnabled: boolean;
    dojiWickMinRatio: number;
    dojiMaxAgeEnabled: boolean;
    dojiMaxAgeMinutes: number;
    dojiMaxGapEnabled?: boolean; // [v0.62.1] 옛 기록엔 없음
    dojiMaxGapMinutes?: number;
    nextCandleConfirmEnabled: boolean;
    excludeEtf: boolean;
    session: "day" | "pre" | "regular" | "after" | "closed";
    maxPositions: number;
    maxLossPct: number;
    maxInvestPct: number;
    watchMinutes: number;
    entryLevel?: 1 | 1.5 | 2;
    emaMinGapEnabled?: boolean; // [v0.63.0]
    emaMinGapPct?: number;
    emaSlopeEnabled?: boolean;
    atrFilterEnabled?: boolean;
    atrMaxPct?: number;
    slMode?: "fixed" | "ema";
    emaStopBufferPct?: number;
  };
  /** [v0.63.0 측정] 진입 당시 이격도·ATR%·EMA 기울기 / 보유 중 최대 역행·순행 / 실제 체결가·슬리피지 */
  entryMetrics?: EntryMetrics;
  maePct?: number | null;
  mfePct?: number | null;
  exitFillPrice?: number | null;
  slippagePct?: number | null;
}

/** [v0.63.0] 진입 시점 측정값(lib/defense.ts와 같은 모양). */
interface EntryMetrics {
  emaGapPct: number | null;
  atrPct: number | null;
  emaSlopePct: number | null;
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
/** [v0.64.0] 자동매매기록 한 건을 토스 실제 체결과 대조한 결과. */
interface HistoryReconcileResult {
  status: "matched" | "mismatch" | "enriched" | "not_found" | "not_applicable";
  realBuyPrice?: number;
  realSellPrice?: number;
  realQty?: number;
  realPnlUsd?: number;
  realPnlPct?: number;
  realSellAtMs?: number;
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
    dojiNearHigh: boolean; // [v0.62.1] 도지가 최고점 직후(간격 한도 이내)인지
  };
  gapFromHighMinutes: number | null; // [v0.62.1] 최고점→도지 간격(분)
}
/** [v0.65.0] 매매연구소 화면용 타입(electron/tool-engine.ts · lib/lab.ts와 같은 모양의 복제). */
interface LabParamsT {
  dojiBodyMaxPct: number; bodyMinPct: number; volRatioMin: number; volLookback: number; fillWindowMin: number;
  linkFillWindowMin: number; horizonMin: number; feeRoundTripPct: number; fixedSlPct: number; emaBufferPct: number;
  minRangePct: number; maxSignalAgeHours: number; maxEmaSpanDays: number;
}
interface LabStatus {
  enabled: boolean; rankCount: number; dojiBodyMaxPct: number; bodyMinPct: number; volRatioMin: number; minRangePct: number; note: string | null; scanning: boolean;
  verify: { localAt: number | null; localOk: boolean | null; localFailed: string[]; tossAt: number | null; tossRequested: number; tossMatched: number };
  feePct: number | null;
  collect: { scans: number; activeHours: number; paused: boolean; pauseReason: string | null; resumesAtMs: number | null };
  lastTickAtMs: number | null; lastTickDurMs: number | null; lastScanned: number; lastError: string | null; lastSkip: string | null;
  startedAtMs: number | null; nextTickAtMs: number | null; totalSignals: number; params: LabParamsT;
}
interface LabQueryFilter { includeIneligible?: boolean; includeThin?: boolean; includeBackfilled?: boolean; session?: string; refKey?: string }
interface LabSignalRow {
  id: string; symbol: string; rank: number; session: string; thinHours: boolean; backfilled: boolean; eligible: boolean;
  whyIneligible: "volume" | "range" | "both" | null; rangePct2: number | null;
  c2T: number; dojiT: number; volRatio2: number | null; body2: number; secondQualified: boolean; c4Block: boolean | null;
  emaGapPct: number | null; atrPct: number | null; price: number; linked: boolean; complete: boolean;
  ref: { key: string; status: string; netPct: number | null; fillPx: number | null; exitPx: number | null; note: string | null } | null;
}
interface LabFunnel { dojis: number; c1: number; c2Bull: number; c2Body: number; eligible: number; second: number; block4: number; linked: number }
interface LabLinkageSummary { runsWithBlock: number; linked: number; linkRate: number | null; avgGapMin: number | null; avgEmaGapPct: number | null; linkedAnyEligible: number }
interface LabVariantRow {
  key: string; kind: "candle" | "link"; entryIdx: number; entryMode: string; stopMode: string; tpPct: number; signals: number; filled: number;
  fillRate: number | null; closed: number; wins: number; losses: number; winRate: number | null; avgNetPct: number | null; avgWinPct: number | null;
  avgLossPct: number | null; profitFactor: number | null; expectancyPerSignal: number | null; totalNetPct: number; avgMaePct: number | null;
  avgRiskPct: number | null; avgHoldMin: number | null; stressExpectancy: number | null; worstNetPct: number | null; maxDrawdownPct: number | null;
}
interface LabCounts { total: number; eligible: number; complete: number; open: number }
interface LabSummary {
  updatedAtMs: number; status: LabStatus; funnel: LabFunnel; linkage: LabLinkageSummary; variants: LabVariantRow[]; signals: LabSignalRow[];
  refKey: string; counts: LabCounts;
  assessment?: import("../lib/lab-verdict").Assessment; // 폰(미러) 전용
}
interface LabMirror {
  updatedAtMs: number; status: LabStatus; funnel: LabFunnel; linkage: LabLinkageSummary; topVariants: LabVariantRow[]; signals: LabSignalRow[];
  counts: LabCounts; refKey: string;
  assessment?: import("../lib/lab-verdict").Assessment;
}
interface LabBar5 { t: number; o: number; h: number; l: number; c: number; v: number; ho: number; hh: number; hl: number; hc: number; e: number | null }
interface LabSignalFull {
  id: string; symbol: string; rank: number; detectedAtMs: number; backfilled: boolean; thinHours: boolean; session: string; eligible: boolean;
  rangePct2?: number | null; whyIneligible?: "volume" | "range" | "both" | null;
  dojiT: number; c2T: number; volRatio2: number | null; body2: number;
  second: { t: number; qualified: boolean; body: number; volRatio: number | null } | null;
  c4: { t: number; block: boolean } | null; runEndT: number;
  metrics: { price: number; ema: number | null; emaGapPct: number | null; lowVsEmaPct: number | null; dojiEmaDistPct: number | null; dojiBodyPct: number; atrPct: number | null; emaSlopePct: number | null; runRangePct: number | null };
  bars: LabBar5[];
  path1m: Array<[number, number, number, number, number, number]>;
  linkage: { confirmT: number; dojiT: number; highT: number; highPx: number; prevClose: number; ema: number; emaGapPct: number; splits: Array<{ level: number; entry: number; tp: number; sl: number }> } | null;
  linkageDone: boolean; complete: boolean;
}
interface LabTrade {
  key: string; kind: "candle" | "link"; entryIdx: number; entryMode: string; stopMode: string; tpPct: number;
  status: "unfilled" | "skipped" | "win" | "loss" | "time" | "horizon" | "open"; note?: string;
  entryT?: number; fillPx?: number; stopPx?: number; tpPx?: number; riskPct?: number; exitT?: number; exitPx?: number; exitReason?: string;
  grossPct?: number; netPct?: number; maePct?: number; mfePct?: number; holdMin?: number;
}
type LabBreakdownDim = "session" | "hour" | "rank" | "volRatio" | "emaGap" | "atr" | "price" | "runRange";
interface LabBreakdownRow { label: string; n: number; winRate: number | null; avgNetPct: number | null; totalNetPct: number }
interface LabCombined {
  n: number; candleOnlyAvg: number | null; linkOnlyAvg: number | null; combinedAvg: number | null; combinedTotal: number;
  skippedByLoss: number; skippedByOverlap: number;
}

/** [v0.62.1] 자동매매 리포트 — lib/auto-report.ts의 AutoReport와 같은 모양(화면 표시용 복제). */
interface AutoReport {
  runId: string;
  generatedAtMs: number;
  live: boolean;
  overview: { startedAtMs: number; endedAtMs: number; uptimeMs: number; loopCount: number; scanCount: number; endReason: string };
  money: {
    startAssetsUsd: number | null;
    endAssetsUsd: number | null;
    realizedGrossUsd: number;
    estFeesUsd: number | null;
    realizedNetUsd: number;
    returnPct: number | null;
    mddUsd: number;
    mddPct: number | null;
    slippage: string;
  };
  trades: {
    total: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    grossProfitUsd: number;
    grossLossUsd: number;
    profitFactor: number | null;
    profitFactorLabel: string;
    avgHoldMs: number | null;
    cancelled: number;
    ocoFailed: number;
  };
  positions: { openAtEnd: Array<{ symbol: string; status: string; entry: number; quantity: number }> };
  system: { apiTimeouts: number; apiRetries: number; apiFailures: number; cycleErrors: number };
  notes: string[];
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
  /** [v0.36.0] 워런트 의심 코멘트(확정/관찰 후보만, 티커 추측 방식 — 차단 아님, 표시 전용). */
  warrantWarning?: string | null;
  /** [v0.63.0] 진입 시점 측정값 + 방어 필터 탈락 사유 */
  entryMetrics?: EntryMetrics;
  defenseReasons?: string[];
}
interface ScreenProgress {
  phase: "ranking" | "scanning" | "done";
  done: number;
  total: number;
  symbol: string;
}
/** [v0.61.4] 상태 미러로 받는 실시간 스캔 진행률 — ScreenProgress + "지금 도는 중인지"(running) +
 *  "언제 시작했는지"(startedAtMs). */
interface LiveScanProgress extends ScreenProgress {
  running: boolean;
  startedAtMs: number;
}
interface ScreenRun {
  scannedAt: string;
  total: number;
  bodyRatio: number;
  priceMin: number;
  priceMax: number;
  excludedEtf: number;
  results: ScreenResult[];
  // [v0.47.0] 이번 스캔에 실제로 쓰인 나머지 기준값(화면이 "그때 뭐가 켜져 있었는지" 보여줄 때 씀)
  emaTrendEnabled: boolean;
  emaPeriod: number;
  cloudEnabled: boolean;
  dojiWickMinRatio: number;
  dojiMaxAgeEnabled: boolean;
  dojiMaxAgeMinutes: number;
  dojiMaxGapEnabled: boolean; // [v0.62.1]
  dojiMaxGapMinutes: number;
  emaMinGapEnabled?: boolean; // [v0.63.0] 옛 PC 스캔엔 없을 수 있음
  emaMinGapPct?: number;
  emaSlopeEnabled?: boolean;
  atrFilterEnabled?: boolean;
  atrMaxPct?: number;
  nextCandleConfirmEnabled: boolean;
  excludeEtf: boolean;
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
  /** [v0.59.0] accountStatus 추가 — "unknown"이면 조회 실패일 뿐 차단 신호가 아니다(화면은 막지 않는다). */
  authStatus(): Promise<{ email: string | null; loggedIn: boolean; isOwner: boolean; accountStatus: "pending" | "approved" | "rejected" | "unknown" }>;
  /** [v0.24.0] 가입 승인 요청함(옛 모델 — 가입 자체가 막혔을 때의 보조 경로). 누구나 신청(로그인 불필요), 운영자만 조회·승인·거절 */
  requestAccess(email: string, note?: string): Promise<{ ok: boolean; message: string }>;
  listAccessRequests(): Promise<Array<{ email: string; note: string | null; requestedAt: string }>>;
  approveAccessRequest(email: string): Promise<{ ok: boolean; message: string }>;
  rejectAccessRequest(email: string): Promise<{ ok: boolean; message: string }>;
  /** [v0.59.0] 로그인 게이트(capri_accounts) — 진짜 승인 대기 목록(가입은 항상 성공, 이게 진짜 게이트). */
  listPendingAccounts(): Promise<Array<{ userId: string; email: string; requestedAt: string }>>;
  decideAccount(userId: string, decision: "approved" | "rejected"): Promise<{ ok: boolean; message: string }>;
  /** [v0.59.0] 디스코드 웹훅 알림 설정(운영자 전용). */
  getNotifySettings(): Promise<{ discordWebhookUrl: string | null }>;
  saveNotifySettings(url: string): Promise<{ ok: boolean; message: string }>;
  /** [v0.59.0→v0.60.0] 소셜 로그인(구글만 — 카카오는 오너 요청으로 제거). Supabase에
   *  provider가 설정돼 있어야 실제로 동작한다. */
  authOAuth(provider: "google"): Promise<{ ok: boolean; message: string }>;
  /** [v0.59.0] 폰 원격 조종 — 명령을 큐에 "넣기"만 한다. 실행은 로그인된 PC가 자동으로 한다. */
  sendCommand(type: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; message: string; commandId?: string }>;
  listMyCommands(limit?: number): Promise<Array<{ id: string; type: string; status: string; result: unknown; createdAt: string }>>;
  /** [v0.59.0] PC가 지금 켜져 있는지(최근 생존 신호). null이면 한 번도 신호가 없었던 것. */
  getDesktopHeartbeat(): Promise<{ lastSeenMs: number | null; autoTradeEnabled: boolean | null; pcAppVersion: string | null }>;
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
  /** [v0.45.0] 감시 중인 포지션을 지금 바로 재확인(체결·익절/손절 발동 여부)하고 최신 상태를 돌려준다. */
  reconcileAutoPositionsNow(): Promise<AutoTradeStatus>;
  saveAutoTradeSettings(input: {
    maxPositions?: number;
    maxLossPct?: number;
    maxInvestPct?: number;
    watchMinutes?: number;
    /** [v0.61.8] 진입 타점 분할(1~2). */
    entryLevel?: 1 | 1.5 | 2;
    /** [v0.63.0] 방어 전략 */
    slMode?: "fixed" | "ema";
    emaStopBufferPct?: number;
    reentryBlockEnabled?: boolean;
    lossStreakLimit?: number;
    reprotectVanished?: boolean; // [v0.69.0] 보호주문이 사라진 보유 종목 자동 재보호
  }): Promise<ToolSettings>;
  /** [v0.44.0] 지금 "시스템 휴무 시간대(또는 휴장)"인지 + 왜 + 언제 재개되는지. */
  getSystemPauseStatus(): Promise<{ paused: boolean; reason: string | null; resumesAtMs: number | null }>;
  /** [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST) 기능을 켜고 끈다. */
  saveSystemPauseEnabled(enabled: boolean): Promise<ToolSettings>;
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
    dojiMaxGapEnabled?: boolean; // [v0.62.1]
    dojiMaxGapMinutes?: number;
    emaMinGapEnabled?: boolean; // [v0.63.0]
    emaMinGapPct?: number;
    emaSlopeEnabled?: boolean;
    atrFilterEnabled?: boolean;
    atrMaxPct?: number;
    nextCandleConfirmEnabled?: boolean;
    excludeEtf?: boolean;
    // [v0.45.0] "매매진행할 장" 선택
    dayEnabled?: boolean;
    preEnabled?: boolean;
    regularEnabled?: boolean;
    afterEnabled?: boolean;
  }): Promise<ToolSettings>;
  autoScanNow(): Promise<AutoTradeStatus>;
  /** [v0.30.0] 자동매매기록 — 자동매매가 낸 매매의 전체 생애주기 로그(읽기 전용, 최신순). */
  autoTradeHistory(): Promise<AutoTradeHistoryEntry[]>;
  /** [v0.62.1] 자동매매 리포트(최근 실행 최대 10건, 최신순). 폰은 PC가 올린 미러에서 읽는다. */
  getAutoReports?(): Promise<{ ok: boolean; reports: AutoReport[]; source: "local" | "pc"; message?: string }>;
  // [v0.65.0] 매매연구소(신호 기록 모드) — 주문 없는 읽기 전용 연구 기능
  getLabStatus?(): Promise<LabStatus>;
  saveLabSettings?(input: { enabled?: boolean; rankCount?: number; dojiBodyMaxPct?: number; bodyMinPct?: number; volRatioMin?: number; minRangePct?: number }): Promise<LabStatus>;
  labScanNow?(): Promise<LabStatus>;
  labReset?(): Promise<LabStatus>;
  getLabSummary?(filter?: LabQueryFilter): Promise<LabSummary>;
  getLabSignal?(id: string): Promise<{ signal: LabSignalFull; trades: LabTrade[] } | null>;
  getLabBreakdown?(key: string, dim: LabBreakdownDim, filter?: LabQueryFilter): Promise<LabBreakdownRow[]>;
  getLabCombined?(candleKey: string, linkKey: string, filter?: LabQueryFilter): Promise<LabCombined>;
  exportLab?(kind: "signals-csv" | "trades-csv" | "json"): Promise<{ filename: string; text: string }>;
  /** [v0.66.0] 데이터 검증: 저장된 로우 재계산 + 토스 실데이터 대조(표본). */
  /** [v0.67.0] 종합 평가(결론+허점 점검+실매매 전환 게이트). realtimeOnly 기본 true. */
  getLabAssessment?(realtimeOnly?: boolean): Promise<import("../lib/lab-verdict").Assessment>;
  verifyLab?(sample?: number): Promise<{
    at: number;
    local: import("../lib/lab-verdict").LocalVerify;
    toss: { requested: number; matched: number; rows: import("../lib/lab-verdict").TossCompareRow[]; error: string | null } | null;
  }>;
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
  /** [v0.43.0] 진행 중인 스크리닝 스캔을 취소한다(수동/자동 공용). */
  cancelScreenerScan(): Promise<{ ok: boolean; message: string }>;
  /** [v0.25.0] 탐색 결과 한 종목의 차트를 불러온다(클릭 시에만, 온디맨드). */
  screenerChart(symbol: string): Promise<ScreenChart>;
  onScreenerProgress(cb: (p: ScreenProgress) => void): () => void;
  // [v0.7.0] 체결강도 자동 기록(매매 연동)
  tradesList(): Promise<StrengthTrade[]>;
  todayReport(): Promise<DailyReport>;
  report(kind: PeriodKind, picked?: string): Promise<DailyReport>;
  tradeAnalysis(): Promise<{ cycles: TradeCycle[]; insights: TradeInsights; source: "live" | "cache" | "none" }>; // [v0.19.0]
  /** [v0.64.0] 자동매매기록을 토스 실제 체결과 대조("자동매매기록" 탭 "🔄 토스 체결과 대조" 버튼). */
  reconcileAutoHistory(): Promise<{ results: Record<string, HistoryReconcileResult>; source: "live" | "cache" | "none" }>;
  /** [v0.10.0→v0.24.0] 매매 이력 동기화(로그인 비밀번호로 암호화, 로그인 시 자동 호출됨) */
  tradeSyncPush(): Promise<{ ok: boolean; message: string; count?: number }>;
  tradeSyncPull(): Promise<{ ok: boolean; message: string; count?: number }>;
  /** [v0.31.0] 자동매매 기록(포지션+이력) 기기 간 동기화 — 로그인 시 자동 호출됨. */
  autoStateSyncPush(): Promise<{ ok: boolean; message: string; count?: number }>;
  autoStateSyncPull(): Promise<{ ok: boolean; message: string; count?: number }>;
  /** [v0.61.7 — ③ 전수조사 중간-2] 삼분할 타점 기록 기기 간 동기화 — 로그인 시 자동 호출됨.
   *  없으면(옛 버전) 선택적으로 건너뛴다. */
  splitsSyncPush?(): Promise<{ ok: boolean; message: string; count?: number }>;
  splitsSyncPull?(): Promise<{ ok: boolean; message: string; count?: number }>;
  /** [v0.35.0] 그룹(공동개발자) 전체 연구용 공유 — 평문, 비식별화 없음(오너 지시). */
  groupTradesPush(): Promise<{ ok: boolean; message: string; count?: number }>;
  groupTradesPull(): Promise<{ ok: boolean; message: string; members: { email: string; history: AutoTradeHistoryEntry[] }[] }>;
  /** [v0.56.0] "그룹 전체 실시간 동기화" — 로그인 상태면 3분마다 자동으로 push+pull. 마운트 시
   *  아무 때나 불러도 안전(이미 돌고 있으면 아무 일도 안 함). 결과는 onGroupSync로 받는다. */
  groupSyncEnsure(): Promise<{ ok: boolean }>;
  onGroupSync(cb: (members: { email: string; history: AutoTradeHistoryEntry[] }[]) => void): () => void;
  /** [v0.56.0] 그룹 채팅 — 가입 허용목록 전원이 실명으로 함께 쓰는 대화방. */
  groupChatSend(body: string): Promise<{ ok: boolean; message: string }>;
  groupChatList(): Promise<{ ok: boolean; message: string; chat: GroupChatMessage[] }>;
  /** [v0.61.9] "업데이트 내역" 탭 — 그룹 전원이 함께 보는 공개 변경 로그(읽기 전용, 쓰기는
   *  오너 계정만 서버에서 직접). 없으면(옛 버전) 선택적으로 건너뛴다. */
  getChangelog?(): Promise<{ ok: boolean; message: string; entries: ChangelogEntry[]; lastSeenVersion: string | null }>;
  /** [v0.61.9] "최신 업데이트를 봤다"고 이 기기에 로컬로 기록(팝업 중복 방지, 기기별 관리). */
  markChangelogSeen?(version: string): Promise<void>;
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
  /** [v0.41.0] 자동매매가 지금 감시 중인 포지션 하나를 즉시 직접 취소한다. */
  cancelAutoPosition(symbol: string, entry: number, enteredAtMs: number): Promise<{ ok: boolean; message: string }>;
  /** [v0.69.4] 보호 복구(봇이 계속 보호주문을 다시 거는 중)를 중단하고 일정 시간 직접 관리로 전환. */
  dismissUnprotected(symbol: string): Promise<{ ok: boolean; message: string }>;

  mockSetPrice(symbol: string, price: number): Promise<boolean>;

  /** [v0.60.5] 이 세션이 토스에 직접 닿을 수 있는지(데스크톱=항상 true, 웹=QR 중계 연결
   *  여부). 없으면(옛 버전 등) 데스크톱으로 간주해 기존 동작 그대로 둔다. */
  hasTossRelay?(): Promise<boolean>;
  /** [v0.61.0] 상태 미러 — PC가 올려 둔 최신 자동매매 현황+최근 로그를 읽는다(폰 전용,
   *  주 사용처). updatedAtMs로 "마지막 갱신 시각"을 화면에 표시한다. 없으면(옛 버전) 화면은
   *  기존 방식(autoStateSyncPull 등)으로 대체한다. */
  getLiveState?(): Promise<{
    ok: boolean;
    /** [v0.65.0] PC의 매매연구소 요약(폰 표시용). 옛 PC·기록 없음이면 null/없음. */
    lab?: LabMirror | null;
    status: AutoTradeStatus | null;
    journal: JournalEntry[];
    /** [v0.61.2] PC의 실제 비상 정지(킬 스위치) 상태. 없으면(옛 버전 PC) null. */
    killSwitch: boolean | null;
    /** [v0.61.4] 지금 PC가 스캔 중인지 + 진행률(게이지). 스캔이 한 번도 안 돌았거나 옛 버전
     *  PC면 null. */
    scanProgress: LiveScanProgress | null;
    updatedAtMs: number | null;
    message?: string;
  }>;

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
  /** [v0.58.0] macOS 차선책 — 받아 둔 dmg가 있는 폴더를 Finder로 연다(선택 항목). */
  openMacDmg?(): Promise<{ ok: boolean }>;
  /** [v0.60.0] macOS 직접 교체 자동업데이트 — "지금 바로 재시작"(그냥 앱을 끈다). */
  installMacSwap?(): Promise<{ ok: boolean; error?: string }>;
  onUpdate(handlers: {
    available?: (info: { version: string; notes: string }) => void;
    progress?: (pct: number) => void;
    downloaded?: () => void;
    error?: (msg: string) => void;
    /** [v0.58.0] macOS 차선책 — 새 dmg를 받아 뒀다는 알림(직접 교체가 실패했을 때만 뜬다). */
    macDmgReady?: (info: { version: string; fileName: string }) => void;
    /** [v0.60.0] macOS 직접 교체 자동업데이트 — 앱 종료 시 자동 적용될 준비가 끝났다는 알림. */
    macSwapReady?: (info: { version: string }) => void;
  }): () => void;
}

interface Window {
  kyletool: KyletoolBridge;
}
