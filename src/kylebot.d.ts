// =============================================================================
// src/kylebot.d.ts  —  화면에서 쓰는 window.kylebot 의 타입 선언
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   preload.cjs 가 화면에 노출하는 window.kylebot 창구의 "사용 설명서(타입)"입니다.
//   타입스크립트가 오타·잘못된 인자 사용을 컴파일 단계에서 잡아 주도록 합니다.
//   (실제 구현은 electron/preload.cjs + electron/bot-engine.ts 에 있음)
// =============================================================================

/** 포지션(삼분할의 한 레벨) 상태 — lib/lifecycle.ts 와 동일한 모양 */
interface UiPosition {
  level: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  quantity: number;
  state: "pending_entry" | "entered" | "closed" | "skipped";
  exitReason?: string;
}

/** 매매 세션(런타임) 요약 */
interface UiSession {
  id: string;
  symbol: string;
  strategy: string;
  status: "draft" | "armed" | "active" | "closed";
  positions: UiPosition[];
}

/** 매매일지 한 줄 */
interface UiTradeLog {
  sessionId: string;
  symbol: string;
  level: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsd: number;
  exitReason: string;
  exitedAt: string;
}

/** 오늘의 리스크(안전장치) 상태 */
interface UiRiskState {
  trade_date: string;
  realized_pnl_pct: number;
  order_count: number;
  consecutive_losses: number;
  halted: boolean;
  halt_reason: string | null;
}

/** 엔진이 보내 주는 상태 스냅샷 */
interface UiStatus {
  running: boolean;
  mode: "mock" | "live";
  dryRun: true;
  killSwitch: boolean;
  session: "day" | "pre" | "regular" | "after" | "closed";
  clockNote: string;
  nextDayOpen: string;
  closeDeadline: string;
  sessions: UiSession[];
  tradeLogs: UiTradeLog[];
  riskState: UiRiskState | null;
  buyingPowerUsd: number | null;
  lastTickAt: string | null;
  tickSeconds: number;
}

/** 설정 화면 값(키 값 자체는 절대 안 옴 — 저장 여부만) */
interface UiSettings {
  mode: "mock" | "live";
  hasClientId: boolean;
  hasClientSecret: boolean;
  account: string;
  tickSeconds: number;
}

interface UiLogEntry {
  ts: string;
  msg: string;
}

/** preload.cjs 가 노출하는 창구 전체 */
interface KylebotBridge {
  getStatus(): Promise<UiStatus>;
  getLogs(): Promise<UiLogEntry[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
  setKillSwitch(on: boolean): Promise<void>;
  getSettings(): Promise<UiSettings>;
  saveSettings(input: {
    mode: "mock" | "live";
    clientId?: string;
    clientSecret?: string;
    account?: string;
    tickSeconds?: number;
  }): Promise<UiSettings>;
  planFromQuote(symbol: string): Promise<{ symbol: string; price: number; entry: number; tp: number; sl: number }>;
  createSession(spec: { symbol: string; entry: number; tp: number; sl: number; quantity: number }): Promise<void>;
  mockSetPrice(symbol: string, price: number): Promise<boolean>;
  refreshBuyingPower(): Promise<number | null>;
  quote(symbol: string): Promise<number>;
  onLog(cb: (entry: UiLogEntry) => void): () => void;
  onStatus(cb: (status: UiStatus) => void): () => void;
}

interface Window {
  kylebot: KylebotBridge;
}
