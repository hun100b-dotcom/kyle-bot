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
  hasClientId: boolean;
  hasClientSecret: boolean;
  account: string;
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

interface KyletoolBridge {
  status(): Promise<ToolStatus>;
  journal(): Promise<JournalEntry[]>;
  getSettings(): Promise<ToolSettings>;
  saveSettings(input: { mode: "mock" | "live"; clientId?: string; clientSecret?: string; account?: string }): Promise<ToolSettings>;
  setKillSwitch(on: boolean): Promise<void>;

  quote(symbol: string): Promise<number>;
  fx(): Promise<{ rate: number; source: "toss" | "manual" } | null>;
  setManualFx(rate: number): Promise<void>;
  buyingPower(): Promise<number | null>;

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

  placeEntry(spec: { symbol: string; price: number; quantity: number }): Promise<JournalEntry>;
  placeOco(spec: {
    symbol: string;
    quantity: number;
    tpTrigger: number;
    tpPrice: number;
    slTrigger: number;
    slPrice: number;
    expireDate: string;
  }): Promise<JournalEntry>;
  placeOto(spec: {
    symbol: string;
    quantity: number;
    entryTrigger: number;
    entryPrice: number;
    exitTrigger: number;
    exitPrice: number;
    expireDate: string;
  }): Promise<JournalEntry>;

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
