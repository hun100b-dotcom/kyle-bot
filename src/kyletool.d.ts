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
  orderFrozen: boolean;
  clockNote: string;
  fxRate: number | null;
  fxSource: "toss" | "manual" | null;
  buyingPowerUsd: number | null;
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
  saveSeedSettings(input: {
    seedDayPct?: number;
    seedPrePct?: number;
    seedRegularPct?: number;
    seedBasis?: "auto" | "fixed";
    seedFixedUsd?: number | null;
  }): Promise<ToolSettings>;
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
  }): Promise<SavedSplit[]>;
  splitsDelete(id: string): Promise<SavedSplit[]>;
  splitsToggle(id: string, level: number): Promise<SavedSplit[]>;
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
