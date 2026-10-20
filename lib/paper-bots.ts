// =============================================================================
// lib/paper-bots.ts — [v0.103.0] 가상매매 봇(페이퍼 트레이딩) — 순수 함수 모음
// -----------------------------------------------------------------------------
// [왜 만들었나 — 오너 요청 2026-10-19]
//   "손절을 어디로 설정할지 끊임없이 고민된다. 고민이 아니라 데이터로 답을 얻고 싶다."
//   → 설정만 다른 가상매매 봇(봇 = 하나의 설정 묶음)을 여러 개 동시에 돌려서, 손절%·익절%·
//     스크리닝 기준별로 수익률·승률이 어떻게 갈리는지 "실제 시장 시세"로 비교한다.
//
// [이 파일이 하는 일]  (순수 함수 — 파일·네트워크 없음. 그래서 테스트로 규칙을 고정할 수 있다)
//   1) 봇 설정의 기본값 만들기·값 보정(sanitize)         — defaultBotConfig / sanitizeConfig
//   2) 가상 체결 한 걸음(advanceBot): 1분봉으로 매수 체결·익절·손절·미체결 취소를 판정
//   3) 신규 가상 주문(placeEntries): 스크리닝 "확정" 종목에 삼분할 타점으로 가상 지정가 매수
//   4) 기기 간 합치기(mergeStores): PC 두 대 + 폰이 같은 봇 목록을 오차 없이 공유
//   5) 성적 계산(botStats)·대시보드 집계(paperDashboard)
//
// [가상 체결 규칙 — 일부러 "보수적"으로 (매매연구소 lib/lab.ts와 같은 원칙)]
//   · 매수(지정가): 1분봉 저가가 주문가보다 "아래로 뚫고" 내려가야 체결(가격에 딱 닿기만 하면 미체결로 본다).
//     봉이 주문가보다 낮게 시작(갭 하락)했으면 그 시가에 체결(실제 지정가 주문도 더 싼 값에 체결된다).
//   · 주문을 낸 그 분(分)의 봉은 쓰지 않는다 — 주문 전 가격으로 체결된 것처럼 착각하지 않게.
//   · 손절: 저가가 손절가 이하로 닿으면 손절가(갭 하락이면 그보다 낮은 시가)에 청산.
//   · 익절: 고가가 익절가를 "뚫고" 올라가야 청산(갭 상승이면 시가).
//   · 같은 봉에서 손절·익절이 둘 다 가능하면 **손절 먼저**(봉 안의 순서는 알 수 없으므로 불리한 쪽으로).
//   · 매수가 체결된 그 봉에서는 손절만 확인한다(익절은 다음 봉부터) — 역시 불리한 쪽.
//   · 수수료: 왕복 수수료율(%)을 매수·매도에 반씩 나눠 뺀다.
//   이렇게 해야 "가상으로는 잘 벌었는데 실제로는 아닌" 착시가 줄어든다.
// =============================================================================

import { DateTime } from "luxon";
import { calcSplit3Level, roundPrice } from "./calc";
import { structuralStopPrice } from "./defense";

// ─────────────────────────────────────────────────────────────────────────────
// 1) 타입
// ─────────────────────────────────────────────────────────────────────────────

/** 스크리닝 기준(=엔진 ScreenOpts의 "전부 채운" 모양). 자동매매 [스크리닝 기준] 탭과 같은 항목들. */
export interface PaperScreen {
  count: number; //               거래량 상위 몇 종목을 훑을지(10~200)
  priceMin: number; //            현재가 하한($)
  priceMax: number; //            현재가 상한($)
  bodyRatio: number; //           도지 몸통 비율 상한(0.1~0.8)
  emaTrendEnabled: boolean; //    현재가 > EMA 조건
  emaPeriod: number; //           EMA 기간
  cloudEnabled: boolean; //       현재가 > 구름 상단 조건
  dojiWickMinRatio: number; //    도지 최소 꼬리 비율
  dojiMaxAgeEnabled: boolean; //  도지 신선도 검사
  dojiMaxAgeMinutes: number;
  dojiMaxGapEnabled: boolean; //  최고점→도지 간격 검사
  dojiMaxGapMinutes: number;
  emaMinGapEnabled: boolean; //   EMA 최소 이격도
  emaMinGapPct: number;
  emaSlopeEnabled: boolean; //    EMA 상승 중
  atrFilterEnabled: boolean; //   변동성 상한
  atrMaxPct: number;
  nextCandleConfirmEnabled: boolean; // 도지 다음 봉 음봉 확인
  excludeEtf: boolean; //         ETF 제외
}

/** 청산(손절) 방식 — PaperTradeRules.slMode 설명 참고. */
export type PaperSlMode = "fixed" | "ema" | "emaOnly";

/** 자동매매 기준(봇이 "어떻게 사고 몇 개까지 들고 있을지"). 자동매매 현황 탭의 설정과 같은 뜻. */
export interface PaperTradeRules {
  entryLevel: 1 | 1.5 | 2; //     삼분할 몇 분할 타점으로 살지
  maxPositions: number; //        동시에 들고 있을 최대 종목 수(대기 주문 포함)
  investPct: number; //           종목 1개당 투입 비율(현재 평가 시드 대비 %)
  watchMinutes: number; //        매수 지정가가 이 시간 안에 안 닿으면 취소(분)
  // 청산(손절) 방식 — [v0.104.0] 3가지:
  //   "fixed"   = 고정 손절 %만(진입가 −N%)
  //   "ema"     = 고정 손절 % + 200EMA 이탈(둘 중 먼저 닿는 쪽 = 더 높은 손절가). 자동매매 "EMA 기준"과 같은 뜻
  //   "emaOnly" = 200EMA 이탈만(고정 손절 %는 안 씀). 손절가 = 진입 시점 5분봉 EMA200 × (1 − 여유%)
  // 이유: "ema"라는 저장값은 v0.103.0부터 "둘 다" 뜻으로 저장돼 있었으므로, 기존 봇의 의미가
  // 바뀌지 않도록 그대로 두고 "EMA만"은 새 값(emaOnly)으로 추가했다.
  slMode: PaperSlMode;
  emaStopBufferPct: number; //    EMA 이탈 기준일 때 EMA 아래 여유(%) — 자동매매 설정과 같은 값(기본 1.5)
  reentryBlock: boolean; //       오늘 손절된 종목 재진입 금지
  sessions: { day: boolean; pre: boolean; regular: boolean; after: boolean }; // 매매할 장
}

/** 봇 설정(오너가 서랍에서 고치는 부분). updatedAtMs가 "이 설정의 버전"이다(기기 간 합치기 기준). */
export interface PaperBotConfig {
  name: string;
  seedUsd: number; //   시작 시드($)
  tpPct: number; //     익절 %
  slPct: number; //     손절 %
  trade: PaperTradeRules;
  screen: PaperScreen;
  /**
   * [v0.105.0] 스크리닝 기준을 "지금 자동매매 설정"에서 그대로 가져올지(기본 켬).
   *   켜면 아래 screen 값은 무시하고, 봇을 돌리는 PC의 자동매매 스크리닝 기준을 매번 그대로 쓴다
   *   → 자동매매가 "관찰 확정"으로 잡은 종목을 가상봇도 똑같이 본다(자동매매 스캔 결과를 나눠 씀).
   *   이유: 봇을 만들 때 복사해 둔 기준이 나중에 자동매매 설정을 바꾸면 어긋나, 자동매매는 종목을
   *   잡는데 봇은 0종목인 일이 실제로 있었다(2026-10-20 오너 제보). 끄면 screen 값을 직접 쓴다.
   */
  followAutoScreen: boolean;
  running: boolean; //  자동매매(가상) 켜짐 여부 — 이 값은 저장·동기화된다(실계좌 자동매매와 다름: 주문이 안 나가므로)
  /** 실제로 이 봇을 돌리는 PC의 기기 번호. 폰에서 켜면 null → 켜져 있는 PC가 가져가 돌린다. */
  runnerDeviceId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 아직 체결 안 된 가상 매수 지정가 주문. */
export interface PaperOrder {
  id: string;
  symbol: string;
  entry: number; //  지정가
  tp: number;
  sl: number;
  qty: number;
  placedAtMs: number;
  expiresAtMs: number;
  /** 이 시각(봉 시작 ms)까지의 1분봉은 이미 확인했다 — 같은 봉을 두 번 세지 않게. */
  lastBarMs: number;
}

/** 체결돼 보유 중인 가상 포지션. */
export interface PaperPosition extends PaperOrder {
  fillPrice: number;
  filledAtMs: number;
  lastPrice: number | null; // 가장 최근 확인한 1분봉 종가(평가손익 표시용)
}

/** 끝난 가상 매매 한 건. */
export interface PaperTrade {
  id: string;
  symbol: string;
  fillPrice: number;
  exitPrice: number;
  qty: number;
  tp: number;
  sl: number;
  result: "tp" | "sl";
  pnlUsd: number; //   수수료 뺀 순손익($)
  pnlPct: number; //   투입금 대비 순손익(%)
  filledAtMs: number;
  exitedAtMs: number;
}

/** 누적 집계(최근 기록만 보관해도 전체 성적이 정확하도록 따로 센다). */
export interface PaperAgg {
  n: number;
  wins: number;
  losses: number;
  grossWinUsd: number;
  grossLossUsd: number; // 양수로 보관(손실 합계의 크기)
  sumPnlPct: number;
  unfilled: number; //    시간 안에 안 닿아 취소된 주문 수
  orders: number; //      낸 주문 수(체결률 계산용)
  peakEquity: number;
  maxDdPct: number; //    실현 기준 최대 낙폭(%)
}

/** 봇의 진행 상태(이 봇을 돌리는 PC만 고친다). epoch는 "초기화 횟수" — 초기화하면 1 올라간다. */
export interface PaperSim {
  epoch: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  realizedUsd: number;
  pending: PaperOrder[];
  open: PaperPosition[];
  trades: PaperTrade[]; // 최근 PAPER_TRADES_KEEP건(최신이 뒤)
  agg: PaperAgg;
  lastTickMs: number | null;
  lastNote: string | null;
  /** 최근 장부(평가금) 곡선 — 청산 때마다 한 점(최대 PAPER_CURVE_KEEP개). 대시보드 그래프용. */
  curve: Array<{ t: number; eq: number }>;
}

export interface PaperBot {
  id: string;
  config: PaperBotConfig;
  sim: PaperSim;
}

/** 전체 저장 단위(클라우드 한 줄 = 이 객체 하나). deleted는 "지운 봇" 표식(되살아나지 않게). */
export interface PaperStore {
  v: 1;
  bots: PaperBot[];
  deleted: Record<string, number>;
}

/** 스크리닝 결과 중 봇이 쓰는 최소 필드(엔진 ScreenResult의 부분집합). */
export interface PaperCandidate {
  symbol: string;
  status: string;
  price: number | null;
  prevClose?: number | null;
  ema200: number | null;
}

/** 1분봉(엔진 Candle과 같은 모양). time = 봉 시작 시각(ms). */
export interface PaperBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const PAPER_TRADES_KEEP = 200;
export const PAPER_CURVE_KEEP = 300;
export const PAPER_MAX_BOTS = 30;
const MIN = 60_000;
/** 지운 봇 표식은 30일 뒤 정리(그 사이 모든 기기가 한 번은 받아 갔다고 본다). */
const TOMBSTONE_TTL_MS = 30 * 24 * 3600_000;

// ─────────────────────────────────────────────────────────────────────────────
// 2) 기본값·보정
// ─────────────────────────────────────────────────────────────────────────────

/** 값 하나를 범위 안으로 — 숫자가 아니면 기본값. */
function clampNum(v: unknown, lo: number, hi: number, fallback: number, digits = 2): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const f = 10 ** digits;
  return Math.round(Math.min(hi, Math.max(lo, n)) * f) / f;
}
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** 앱 설정(ToolSettings 비슷한 모양)에서 봇 기본 설정을 만든다 — "지금 내 자동매매 설정 그대로"로 시작. */
export function defaultBotConfig(s: Record<string, unknown> | null | undefined, nowMs: number, name = "가상봇"): PaperBotConfig {
  const g = (k: string) => (s ? s[k] : undefined);
  const lvl = g("autoTradeEntryLevel");
  return sanitizeConfig({
    name,
    seedUsd: 10_000,
    tpPct: g("defaultTpPct") as number,
    slPct: g("defaultSlPct") as number,
    trade: {
      entryLevel: lvl === 1.5 || lvl === 2 ? lvl : 1,
      maxPositions: g("autoTradeMaxPositions") as number,
      investPct: g("autoTradeMaxInvestPct") as number,
      watchMinutes: g("autoTradeWatchMinutes") as number,
      slMode: g("autoTradeSlMode") === "ema" ? "ema" : "fixed",
      emaStopBufferPct: g("autoTradeEmaStopBufferPct") as number,
      reentryBlock: g("autoTradeReentryBlockEnabled") as boolean,
      sessions: {
        day: g("autoScanDayEnabled") as boolean,
        pre: g("autoScanPreEnabled") as boolean,
        regular: g("autoScanRegularEnabled") as boolean,
        after: g("autoScanAfterEnabled") as boolean,
      },
    },
    screen: {
      count: g("autoScanCount") as number,
      priceMin: g("autoScanPriceMin") as number,
      priceMax: g("autoScanPriceMax") as number,
      bodyRatio: g("autoScanBodyRatio") as number,
      emaTrendEnabled: g("autoScanEmaTrendEnabled") as boolean,
      emaPeriod: g("autoScanEmaPeriod") as number,
      cloudEnabled: g("autoScanCloudEnabled") as boolean,
      dojiWickMinRatio: g("autoScanDojiWickMinRatio") as number,
      dojiMaxAgeEnabled: g("autoScanDojiMaxAgeEnabled") as boolean,
      dojiMaxAgeMinutes: g("autoScanDojiMaxAgeMinutes") as number,
      dojiMaxGapEnabled: g("autoScanDojiMaxGapEnabled") as boolean,
      dojiMaxGapMinutes: g("autoScanDojiMaxGapMinutes") as number,
      emaMinGapEnabled: g("autoScanEmaMinGapEnabled") as boolean,
      emaMinGapPct: g("autoScanEmaMinGapPct") as number,
      emaSlopeEnabled: g("autoScanEmaSlopeEnabled") as boolean,
      atrFilterEnabled: g("autoScanAtrFilterEnabled") as boolean,
      atrMaxPct: g("autoScanAtrMaxPct") as number,
      nextCandleConfirmEnabled: g("autoScanNextCandleConfirmEnabled") as boolean,
      excludeEtf: g("autoScanExcludeEtf") as boolean,
    },
    followAutoScreen: true,
    running: false,
    runnerDeviceId: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

/**
 * sanitizeConfig — 어디서 온 값이든(화면 입력·옛 버전·다른 기기) 안전한 범위로 맞춘다.
 *   범위는 엔진의 saveAutoScanSettings / saveAutoTradeSettings / scanScreener 보정과 같게 맞췄다.
 */
export function sanitizeConfig(c: Omit<Partial<PaperBotConfig>, "trade" | "screen"> & { trade?: Partial<PaperTradeRules>; screen?: Partial<PaperScreen> }): PaperBotConfig {
  const t = (c.trade ?? {}) as Partial<PaperTradeRules>;
  const s = (c.screen ?? {}) as Partial<PaperScreen>;
  const ss = (t.sessions ?? {}) as Partial<PaperTradeRules["sessions"]>;
  let priceMin = clampNum(s.priceMin, 0, 10_000, 1);
  let priceMax = clampNum(s.priceMax, 0, 10_000, 9);
  if (priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
  const lvl = t.entryLevel;
  return {
    name: (typeof c.name === "string" && c.name.trim() ? c.name.trim() : "가상봇").slice(0, 30),
    seedUsd: clampNum(c.seedUsd, 100, 10_000_000, 10_000, 0),
    tpPct: clampNum(c.tpPct, 0.1, 100, 2),
    slPct: clampNum(c.slPct, 0.1, 100, 10),
    trade: {
      entryLevel: lvl === 1.5 || lvl === 2 ? lvl : 1,
      maxPositions: clampNum(t.maxPositions, 1, 20, 3, 0),
      investPct: clampNum(t.investPct, 1, 100, 30, 1),
      watchMinutes: clampNum(t.watchMinutes, 1, 600, 10, 0),
      // 모르는 값(옛 버전·오타)은 가장 보수적인 "고정 %"로 되돌린다.
      slMode: t.slMode === "ema" || t.slMode === "emaOnly" ? t.slMode : "fixed",
      emaStopBufferPct: clampNum(t.emaStopBufferPct, 0, 20, 1.5, 2),
      reentryBlock: bool(t.reentryBlock, true),
      sessions: { day: bool(ss.day, true), pre: bool(ss.pre, true), regular: bool(ss.regular, true), after: bool(ss.after, true) },
    },
    screen: {
      count: clampNum(s.count, 10, 200, 60, 0),
      priceMin,
      priceMax,
      bodyRatio: clampNum(s.bodyRatio, 0.1, 0.8, 0.3, 3),
      emaTrendEnabled: bool(s.emaTrendEnabled, true),
      emaPeriod: clampNum(s.emaPeriod, 50, 300, 200, 0),
      cloudEnabled: bool(s.cloudEnabled, true),
      dojiWickMinRatio: clampNum(s.dojiWickMinRatio, 0, 0.4, 0.1, 3),
      dojiMaxAgeEnabled: bool(s.dojiMaxAgeEnabled, true),
      dojiMaxAgeMinutes: clampNum(s.dojiMaxAgeMinutes, 10, 180, 40, 0),
      dojiMaxGapEnabled: bool(s.dojiMaxGapEnabled, true),
      dojiMaxGapMinutes: clampNum(s.dojiMaxGapMinutes, 5, 240, 30, 0),
      emaMinGapEnabled: bool(s.emaMinGapEnabled, false),
      emaMinGapPct: clampNum(s.emaMinGapPct, 0.5, 50, 6, 1),
      emaSlopeEnabled: bool(s.emaSlopeEnabled, false),
      atrFilterEnabled: bool(s.atrFilterEnabled, false),
      atrMaxPct: clampNum(s.atrMaxPct, 0.5, 20, 3, 1),
      nextCandleConfirmEnabled: bool(s.nextCandleConfirmEnabled, true),
      excludeEtf: bool(s.excludeEtf, true),
    },
    // 값이 없으면(v0.104.0 이하에서 만든 봇) 켬 — 그 봇들도 원래 "자동매매 설정 복사본"이었다.
    followAutoScreen: bool(c.followAutoScreen, true),
    running: bool(c.running, false),
    runnerDeviceId: typeof c.runnerDeviceId === "string" && c.runnerDeviceId ? c.runnerDeviceId : null,
    createdAtMs: clampNum(c.createdAtMs, 0, Number.MAX_SAFE_INTEGER, 0, 0),
    updatedAtMs: clampNum(c.updatedAtMs, 0, Number.MAX_SAFE_INTEGER, 0, 0),
  };
}

/** 빈 진행 상태(새 봇·초기화). */
export function freshSim(epoch: number, nowMs: number, seedUsd: number): PaperSim {
  return {
    epoch,
    updatedAtMs: nowMs,
    startedAtMs: null,
    realizedUsd: 0,
    pending: [],
    open: [],
    trades: [],
    agg: { n: 0, wins: 0, losses: 0, grossWinUsd: 0, grossLossUsd: 0, sumPnlPct: 0, unfilled: 0, orders: 0, peakEquity: seedUsd, maxDdPct: 0 },
    lastTickMs: null,
    lastNote: null,
    curve: [],
  };
}

/** 봇 id — 기기마다 겹치지 않게 시각+난수. */
export function newBotId(nowMs: number, rnd: () => number = Math.random): string {
  return `pb_${nowMs.toString(36)}_${Math.floor(rnd() * 1e9).toString(36)}`;
}

export function emptyStore(): PaperStore {
  return { v: 1, bots: [], deleted: {} };
}

/** 스크리닝 기준이 같은 봇끼리 스캔 한 번을 나눠 쓰려고 만드는 열쇠(같은 기준 = 같은 문자열). */
export function screenKey(s: PaperScreen): string {
  const k = Object.keys(s).sort() as Array<keyof PaperScreen>;
  return k.map((x) => `${x}=${String(s[x])}`).join("&");
}

/** 받은 데이터가 우리 형식인지(깨진 값·옛 형식이면 false — 그대로 쓰지 않는다). */
export function isPaperStore(p: unknown): p is PaperStore {
  if (!p || typeof p !== "object") return false;
  const o = p as Partial<PaperStore>;
  return o.v === 1 && Array.isArray(o.bots) && !!o.deleted && typeof o.deleted === "object" &&
    o.bots.every((b) => !!b && typeof b.id === "string" && !!b.config && !!b.sim && typeof b.sim.epoch === "number");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 기기 간 합치기 — "데이터 오차 0"의 핵심
// ─────────────────────────────────────────────────────────────────────────────
//   봇 하나를 두 부분으로 나눠 따로 합친다:
//     · 설정(config) — 어느 기기에서든 오너가 고칠 수 있다 → updatedAtMs가 큰(나중에 고친) 쪽이 이긴다.
//     · 진행(sim)    — 그 봇을 돌리는 PC 한 대만 고친다 → (epoch, updatedAtMs)가 큰 쪽이 이긴다.
//       초기화(epoch+1)는 어느 기기에서 하든 옛 진행 기록을 이긴다.
//   이렇게 나누면 "폰에서 익절%를 바꾸는 순간 PC가 쌓던 결과가 덮여 사라지는" 일이 구조적으로 없다.
//   지운 봇은 표식(deleted)이 남아, 아직 그 봇을 들고 있는 다른 기기가 다시 올려도 되살아나지 않는다.

function simNewer(a: PaperSim, b: PaperSim): boolean {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  return a.updatedAtMs > b.updatedAtMs;
}

export function mergeStores(a: PaperStore, b: PaperStore, nowMs: number): PaperStore {
  const deleted: Record<string, number> = {};
  for (const src of [a.deleted, b.deleted]) {
    for (const [id, t] of Object.entries(src ?? {})) {
      if (typeof t !== "number" || !Number.isFinite(t)) continue;
      if (nowMs - t > TOMBSTONE_TTL_MS) continue; // 오래된 표식은 정리
      deleted[id] = Math.max(deleted[id] ?? 0, t);
    }
  }
  const byId = new Map<string, PaperBot>();
  for (const bot of [...a.bots, ...b.bots]) {
    if (deleted[bot.id] != null) continue;
    const cur = byId.get(bot.id);
    if (!cur) {
      byId.set(bot.id, bot);
      continue;
    }
    const config = bot.config.updatedAtMs > cur.config.updatedAtMs ? bot.config : cur.config;
    const sim = simNewer(bot.sim, cur.sim) ? bot.sim : cur.sim;
    byId.set(bot.id, { id: bot.id, config, sim });
  }
  // 순서: 만든 순서(오래된 것 위) — 기기마다 화면 순서가 같아야 헷갈리지 않는다.
  const bots = [...byId.values()].sort((x, y) => x.config.createdAtMs - y.config.createdAtMs || (x.id < y.id ? -1 : 1));
  return { v: 1, bots, deleted };
}

/** 내용 비교용 정렬된 문자열(순서 차이로 '다르다'가 나오지 않게 합치기 규칙으로 한 번 정돈한 뒤 비교). */
export function storeFingerprint(s: PaperStore, nowMs: number): string {
  return JSON.stringify(mergeStores(s, emptyStore(), nowMs));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 가상 체결 — 1분봉으로 한 걸음 나아가기
// ─────────────────────────────────────────────────────────────────────────────

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** 청산 한 건을 장부에 반영(누적 집계·곡선 포함). */
function closePosition(sim: PaperSim, seedUsd: number, p: PaperPosition, exitPrice: number, result: "tp" | "sl", exitedAtMs: number, feeRoundTripPct: number): void {
  const cost = p.fillPrice * p.qty;
  const gross = (exitPrice - p.fillPrice) * p.qty;
  const fee = ((p.fillPrice + exitPrice) * p.qty * feeRoundTripPct) / 200; // 왕복 수수료를 매수·매도에 반씩
  const pnlUsd = r4(gross - fee);
  const pnlPct = cost > 0 ? r4((pnlUsd / cost) * 100) : 0;
  sim.trades.push({ id: p.id, symbol: p.symbol, fillPrice: p.fillPrice, exitPrice, qty: p.qty, tp: p.tp, sl: p.sl, result, pnlUsd, pnlPct, filledAtMs: p.filledAtMs, exitedAtMs });
  if (sim.trades.length > PAPER_TRADES_KEEP) sim.trades.splice(0, sim.trades.length - PAPER_TRADES_KEEP);
  sim.realizedUsd = r4(sim.realizedUsd + pnlUsd);
  const a = sim.agg;
  a.n++;
  // 승패는 "순손익"으로 센다 — 익절로 끝났어도 수수료 때문에 손해면 패(정직한 승률).
  if (pnlUsd > 0) {
    a.wins++;
    a.grossWinUsd = r4(a.grossWinUsd + pnlUsd);
  } else {
    a.losses++;
    a.grossLossUsd = r4(a.grossLossUsd - pnlUsd);
  }
  a.sumPnlPct = r4(a.sumPnlPct + pnlPct);
  const eq = r4(seedUsd + sim.realizedUsd);
  a.peakEquity = Math.max(a.peakEquity, eq);
  if (a.peakEquity > 0) a.maxDdPct = Math.max(a.maxDdPct, r4(((a.peakEquity - eq) / a.peakEquity) * 100));
  sim.curve.push({ t: exitedAtMs, eq });
  if (sim.curve.length > PAPER_CURVE_KEEP) sim.curve.splice(0, sim.curve.length - PAPER_CURVE_KEEP);
}

/**
 * advanceBot — 대기 주문·보유 포지션을 받은 1분봉으로 한 걸음 진행한다(새 sim을 돌려준다, 입력은 안 바꿈).
 *   bars: 종목 → 1분봉(시간순). 아직 안 끝난 봉(time + 1분 > now)은 쓰지 않는다.
 *   봉 데이터를 못 받은 종목은 그대로 둔다(다음 걸음에 이어서) — 단 대기 주문은 유효시간이 지나면 취소.
 */
export function advanceBot(bot: PaperBot, bars: Map<string, PaperBar[]>, nowMs: number, feeRoundTripPct: number): PaperSim {
  const sim: PaperSim = structuredCloneSim(bot.sim);
  const seed = bot.config.seedUsd;
  const done = (b: PaperBar) => b.time + MIN <= nowMs;

  // ① 대기 주문 → 체결/취소
  const stillPending: PaperOrder[] = [];
  const newlyOpen: PaperPosition[] = [];
  for (const o of sim.pending) {
    // 주문을 낸 "그 분"의 봉은 제외: 봉 시작이 주문 시각 이후(올림)인 것부터.
    const firstBar = Math.ceil(o.placedAtMs / MIN) * MIN;
    const list = (bars.get(o.symbol) ?? []).filter((b) => b.time >= firstBar && b.time > o.lastBarMs && done(b));
    let filled: PaperPosition | null = null;
    let lastBarMs = o.lastBarMs;
    for (const b of list) {
      if (b.time >= o.expiresAtMs) break; // 유효시간이 지난 봉은 보지 않는다
      lastBarMs = b.time;
      if (b.low < o.entry) {
        const fillPrice = Math.min(o.entry, b.open);
        filled = { ...o, fillPrice, filledAtMs: b.time, lastBarMs: b.time, lastPrice: b.close };
        // 체결된 그 봉에서 손절선까지 찍었으면 손절(불리한 쪽).
        if (b.low <= o.sl) {
          closePosition(sim, seed, filled, Math.min(o.sl, fillPrice), "sl", b.time + MIN, feeRoundTripPct);
          filled = null;
          lastBarMs = -1; // 표식: 이미 끝남
        }
        break;
      }
    }
    if (lastBarMs === -1) continue; // 체결 즉시 손절로 끝난 주문
    if (filled) {
      newlyOpen.push(filled);
      continue;
    }
    if (nowMs >= o.expiresAtMs) {
      sim.agg.unfilled++; // 시간 안에 안 닿음 → 취소(매매 아님)
      continue;
    }
    stillPending.push({ ...o, lastBarMs });
  }
  sim.pending = stillPending;

  // ② 보유 포지션(방금 체결된 것 포함) → 익절/손절
  const stillOpen: PaperPosition[] = [];
  for (const p0 of [...sim.open, ...newlyOpen]) {
    const p = { ...p0 };
    const list = (bars.get(p.symbol) ?? []).filter((b) => b.time > p.lastBarMs && done(b));
    let closed = false;
    for (const b of list) {
      p.lastBarMs = b.time;
      p.lastPrice = b.close;
      if (b.low <= p.sl) {
        closePosition(sim, seed, p, Math.min(p.sl, b.open), "sl", b.time + MIN, feeRoundTripPct);
        closed = true;
        break;
      }
      if (b.high > p.tp) {
        closePosition(sim, seed, p, Math.max(p.tp, b.open), "tp", b.time + MIN, feeRoundTripPct);
        closed = true;
        break;
      }
    }
    if (!closed) stillOpen.push(p);
  }
  sim.open = stillOpen;
  return sim;
}

/** sim 깊은 복사(배열·객체를 새로 만든다 — 원본을 절대 바꾸지 않기 위해). */
function structuredCloneSim(s: PaperSim): PaperSim {
  return {
    ...s,
    pending: s.pending.map((o) => ({ ...o })),
    open: s.open.map((p) => ({ ...p })),
    trades: s.trades.map((t) => ({ ...t })),
    agg: { ...s.agg },
    curve: s.curve.map((c) => ({ ...c })),
  };
}

/** 중지된 봇: 대기 주문은 취소한다(보유 중인 것은 익절/손절까지 계속 지켜본다 — 결과가 허공에 뜨지 않게). */
export function cancelPending(sim: PaperSim): PaperSim {
  return { ...structuredCloneSim(sim), pending: [] };
}

function kstDay(ms: number): string {
  return DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat("yyyy-MM-dd");
}

/**
 * placeEntries — 스크리닝 "확정" 종목에 가상 지정가 매수를 낸다(자동매매 autoTradeTick의 진입 규칙과 같게).
 *   · 자리(최대 종목 수 − 보유 − 대기)가 있을 때만, 순위 순서대로
 *   · 이미 이 봇이 들고 있거나 주문 낸 종목은 건너뜀
 *   · 손절 종목 당일 재진입 금지(켜져 있으면)
 *   · 진입가 = 삼분할 N분할 타점(전봉종가·EMA200 기준), 익절/손절 = 진입가 ± 봇의 %
 *   · 손절 방식이 EMA면 "EMA 아래 여유%"와 고정 손절 중 높은 쪽(엔진과 같은 함수)
 *   · 수량 = 현재 평가 시드 × 투입 비율 ÷ 진입가(내림), 남은 현금을 넘지 않게
 *   돌려주는 notes는 화면에 "왜 안 샀나"를 보여 주는 용도.
 */
export function placeEntries(bot: PaperBot, sim0: PaperSim, candidates: PaperCandidate[], nowMs: number): { sim: PaperSim; placed: number; notes: string[] } {
  const sim = structuredCloneSim(sim0);
  const c = bot.config;
  const notes: string[] = [];
  let placed = 0;
  const held = new Set([...sim.pending.map((o) => o.symbol), ...sim.open.map((p) => p.symbol)]);
  const today = kstDay(nowMs);
  for (const cand of candidates) {
    if (cand.status !== "confirmed") continue;
    if (sim.pending.length + sim.open.length >= c.trade.maxPositions) {
      notes.push(`${cand.symbol}: 최대 종목 수(${c.trade.maxPositions}) 도달`);
      continue;
    }
    if (held.has(cand.symbol)) continue;
    if (c.trade.reentryBlock && sim.trades.some((t) => t.symbol === cand.symbol && t.result === "sl" && kstDay(t.exitedAtMs) === today)) {
      notes.push(`${cand.symbol}: 오늘 손절된 종목(재진입 금지)`);
      continue;
    }
    if (cand.ema200 == null || cand.prevClose == null) {
      notes.push(`${cand.symbol}: 가격 데이터 부족`);
      continue;
    }
    let lv: { entry: number; tp: number; sl: number };
    try {
      lv = calcSplit3Level(cand.prevClose, cand.ema200, c.tpPct, c.slPct, c.trade.entryLevel);
    } catch {
      notes.push(`${cand.symbol}: 전봉종가가 EMA 이하라 삼분할 진입 불가`);
      continue;
    }
    if (c.trade.slMode !== "fixed") {
      const s = paperStopPrice(c.trade.slMode, lv.entry, cand.ema200, c.trade.emaStopBufferPct, lv.sl);
      if (s == null) {
        // EMA 아래 여유를 둔 손절가가 진입가보다 높거나 같으면 손절선을 둘 곳이 없다 → 진입 안 함
        // (자동매매의 "EMA 기준 손절"과 똑같은 처리).
        notes.push(`${cand.symbol}: EMA 기준 손절선을 둘 수 없음`);
        continue;
      }
      lv = { ...lv, sl: roundPrice(s) };
    }
    if (!(lv.entry > 0) || !(lv.sl < lv.entry) || !(lv.tp > lv.entry)) {
      notes.push(`${cand.symbol}: 타점 계산값이 비정상`);
      continue;
    }
    const equity = c.seedUsd + sim.realizedUsd;
    const committed = sim.open.reduce((s, p) => s + p.fillPrice * p.qty, 0) + sim.pending.reduce((s, o) => s + o.entry * o.qty, 0);
    const cash = equity - committed;
    const budget = Math.min((equity * c.trade.investPct) / 100, cash);
    const qty = Math.floor(budget / lv.entry);
    if (qty < 1) {
      notes.push(`${cand.symbol}: 가상 현금 부족(1주도 못 삼)`);
      continue;
    }
    sim.pending.push({
      id: `${cand.symbol}@${nowMs}`,
      symbol: cand.symbol,
      entry: lv.entry,
      tp: lv.tp,
      sl: lv.sl,
      qty,
      placedAtMs: nowMs,
      expiresAtMs: nowMs + c.trade.watchMinutes * MIN,
      lastBarMs: 0,
    });
    sim.agg.orders++;
    held.add(cand.symbol);
    placed++;
  }
  return { sim, placed, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) 성적·대시보드
// ─────────────────────────────────────────────────────────────────────────────

export interface PaperBotStats {
  equityUsd: number; //       실현 기준 평가금(시드 + 실현손익)
  realizedUsd: number;
  returnPct: number; //       실현 수익률(%)
  unrealizedUsd: number; //   보유 중 평가손익(마지막 1분봉 종가 기준, 수수료 제외 전)
  n: number;
  wins: number;
  losses: number;
  winRate: number | null; //  %
  avgPnlPct: number | null; // 매매 1건 평균 순손익(%)
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null; // 총이익 ÷ 총손실
  maxDdPct: number;
  fillRate: number | null; // 낸 주문 중 체결된 비율(%)
  openCount: number;
  pendingCount: number;
  tpCount: number;
  slCount: number;
}

export function botStats(bot: PaperBot): PaperBotStats {
  const s = bot.sim;
  const a = s.agg;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const wins = s.trades.filter((t) => t.pnlUsd > 0);
  const losses = s.trades.filter((t) => t.pnlUsd <= 0);
  const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((p, q) => p + q, 0) / xs.length) : null);
  const settled = a.orders - s.pending.length; // 결론이 난 주문(체결 or 취소)
  return {
    equityUsd: r2(bot.config.seedUsd + s.realizedUsd),
    realizedUsd: r2(s.realizedUsd),
    returnPct: bot.config.seedUsd > 0 ? r2((s.realizedUsd / bot.config.seedUsd) * 100) : 0,
    unrealizedUsd: r2(s.open.reduce((sum, p) => sum + ((p.lastPrice ?? p.fillPrice) - p.fillPrice) * p.qty, 0)),
    n: a.n,
    wins: a.wins,
    losses: a.losses,
    winRate: a.n ? r2((a.wins / a.n) * 100) : null,
    avgPnlPct: a.n ? r2(a.sumPnlPct / a.n) : null,
    avgWinPct: avg(wins.map((t) => t.pnlPct)), //   최근 보관분 기준
    avgLossPct: avg(losses.map((t) => t.pnlPct)),
    profitFactor: a.grossLossUsd > 0 ? r2(a.grossWinUsd / a.grossLossUsd) : a.grossWinUsd > 0 ? null : null,
    maxDdPct: r2(a.maxDdPct),
    fillRate: settled > 0 ? r2(((settled - a.unfilled) / settled) * 100) : null,
    openCount: s.open.length,
    pendingCount: s.pending.length,
    tpCount: s.trades.filter((t) => t.result === "tp").length,
    slCount: s.trades.filter((t) => t.result === "sl").length,
  };
}

/**
 * paperStopPrice — 청산 방식별 손절가. EMA는 "진입 시점 5분봉 EMA200"(스크리닝 결과값)이고,
 * 진입 후 EMA가 움직여도 손절가는 그대로다(자동매매·실험실의 "EMA 기준 손절"과 같은 정의 — 
 * 토스 서버 OCO에 고정 가격으로 걸리는 실제 매매와 똑같이 비교하려는 것).
 *   - "ema"     : lib/defense.ts structuralStopPrice 그대로(고정 손절가와 EMA 손절가 중 더 높은 쪽)
 *   - "emaOnly" : EMA × (1 − 여유%) 그대로(고정 손절 % 무시)
 *   - 둘 다 EMA 손절가가 진입가 이상이면 null(손절선을 둘 수 없음 → 진입 안 함)
 */
export function paperStopPrice(mode: PaperSlMode, entry: number, emaValue: number, bufferPct: number, fixedSl: number): number | null {
  if (mode === "fixed") return fixedSl;
  if (mode === "ema") return structuralStopPrice(entry, emaValue, bufferPct, fixedSl);
  const emaStop = emaValue * (1 - bufferPct / 100);
  return emaStop < entry ? emaStop : null;
}

/** 청산 방식을 사람이 읽는 말로(행 요약·대시보드 공용). */
export function exitLabel(t: Pick<PaperTradeRules, "slMode" | "emaStopBufferPct">, slPct: number): string {
  if (t.slMode === "emaOnly") return `200EMA 이탈만(여유 ${t.emaStopBufferPct}%)`;
  if (t.slMode === "ema") return `손절 ${slPct}% + 200EMA 이탈(여유 ${t.emaStopBufferPct}%)`;
  return `손절 ${slPct}%`;
}

/** 청산 방식만 따로 본 이름(손절 %는 빼고) — "청산 방식별 비교" 묶음용. */
function exitMethodLabel(t: Pick<PaperTradeRules, "slMode" | "emaStopBufferPct">): string {
  if (t.slMode === "emaOnly") return `200EMA 이탈만(여유 ${t.emaStopBufferPct}%)`;
  if (t.slMode === "ema") return `손절 % + 200EMA 이탈(여유 ${t.emaStopBufferPct}%)`;
  return "고정 손절 %만";
}

/** 청산 방식 정렬 번호(표에서 고정 → 둘 다 → EMA만 순서로 보이게). */
const EXIT_ORDER: Record<PaperSlMode, number> = { fixed: 0, ema: 1, emaOnly: 2 };

/** 같은 설정값(예: 손절 5%)을 쓰는 봇들을 한 묶음으로 본 성적. */
export interface PaperGroupRow {
  label: string; //        예: "손절 5%"
  value: number;
  bots: number;
  trades: number;
  winRate: number | null; //    묶음 전체 매매를 합친 승률
  avgReturnPct: number; //       묶음 안 봇들 수익률의 평균
  avgPnlPct: number | null; //   매매 1건 평균 순손익(%)
  enough: boolean; //            표본(매매 수)이 충분한가
}

export interface PaperDashboard {
  ranking: Array<{ id: string; name: string; returnPct: number; trades: number; winRate: number | null; tpPct: number; slPct: number; exit: string; enough: boolean; running: boolean }>;
  bySl: PaperGroupRow[]; //   손절 %별(손절 %를 안 쓰는 "200EMA 이탈만" 봇은 빠짐)
  byTp: PaperGroupRow[];
  byExit: PaperGroupRow[]; // [v0.104.0] 청산 방식별(고정 % / 손절 %+EMA / EMA만)
  byCombo: PaperGroupRow[]; // 익절 × 청산(손절 % 또는 EMA) 조합별
  best: { bot: string | null; sl: number | null; tp: number | null; exit: string | null; combo: string | null };
  minTrades: number;
}

/** 이 정도 매매가 쌓이기 전에는 "최고"라고 부르지 않는다(운 좋은 몇 번으로 결론 내리지 않게). */
export const PAPER_MIN_TRADES = 20;

// 묶음 기준 — key: 같은 묶음인지 가르는 값, value: 표 정렬 순서(작은 것부터), label: 표에 보일 이름.
// [v0.104.0] 숫자 하나로는 "청산 방식 + 손절 % + EMA 여유"를 담기 어려워 문자열 key로 바꿨다.
interface GroupKey { key: string; value: number; label: string }

function groupRows(bots: PaperBot[], keyOf: (b: PaperBot) => GroupKey, minTrades: number): PaperGroupRow[] {
  const m = new Map<string, { k: GroupKey; list: PaperBot[] }>();
  for (const b of bots) {
    const k = keyOf(b);
    const g = m.get(k.key);
    if (g) g.list.push(b);
    else m.set(k.key, { k, list: [b] });
  }
  const rows: PaperGroupRow[] = [];
  for (const { k, list } of m.values()) {
    const st = list.map(botStats);
    const n = st.reduce((s, x) => s + x.n, 0);
    const w = st.reduce((s, x) => s + x.wins, 0);
    const sumPct = list.reduce((s, b) => s + b.sim.agg.sumPnlPct, 0);
    rows.push({
      label: k.label,
      value: k.value,
      bots: list.length,
      trades: n,
      winRate: n ? Math.round((w / n) * 10_000) / 100 : null,
      avgReturnPct: Math.round((st.reduce((s, x) => s + x.returnPct, 0) / st.length) * 100) / 100,
      avgPnlPct: n ? Math.round((sumPct / n) * 100) / 100 : null,
      enough: n >= minTrades,
    });
  }
  return rows.sort((a, b) => a.value - b.value || a.label.localeCompare(b.label));
}

/** 가장 좋은 묶음 — 표본이 충분한 것 중 "평균 수익률"이 가장 높은 것(없으면 null). */
function bestOf(rows: PaperGroupRow[]): PaperGroupRow | null {
  if (rows.length < 2) return null; // 비교할 다른 값이 없으면 "최고"라고 부를 수 없다
  const ok = rows.filter((r) => r.enough);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.avgReturnPct > a.avgReturnPct ? b : a));
}

export function paperDashboard(bots: PaperBot[], minTrades = PAPER_MIN_TRADES): PaperDashboard {
  const ranking = bots
    .map((b) => {
      const s = botStats(b);
      return { id: b.id, name: b.config.name, returnPct: s.returnPct, trades: s.n, winRate: s.winRate, tpPct: b.config.tpPct, slPct: b.config.slPct, exit: exitLabel(b.config.trade, b.config.slPct), enough: s.n >= minTrades, running: b.config.running };
    })
    .sort((a, b) => b.returnPct - a.returnPct || b.trades - a.trades);
  // 손절 %별 비교: "200EMA 이탈만" 봇은 손절 %를 쓰지 않으므로 빼야 숫자가 섞이지 않는다.
  const bySl = groupRows(
    bots.filter((b) => b.config.trade.slMode !== "emaOnly"),
    (b) => ({ key: String(b.config.slPct), value: b.config.slPct, label: `손절 ${b.config.slPct}%` }),
    minTrades,
  );
  const byTp = groupRows(bots, (b) => ({ key: String(b.config.tpPct), value: b.config.tpPct, label: `익절 ${b.config.tpPct}%` }), minTrades);
  // 청산 방식별 비교: 고정 % / 손절 %+EMA / EMA만 (EMA 여유 %가 다르면 다른 묶음).
  const byExit = groupRows(
    bots,
    (b) => {
      const t = b.config.trade;
      const buf = t.slMode === "fixed" ? 0 : t.emaStopBufferPct;
      return { key: `${t.slMode}|${buf}`, value: EXIT_ORDER[t.slMode] * 1000 + buf, label: exitMethodLabel(t) };
    },
    minTrades,
  );
  // 조합: 익절 × 청산(손절 % / EMA) — 같은 익절끼리 모이도록 익절을 먼저 정렬한다.
  const byCombo = groupRows(
    bots,
    (b) => {
      const c = b.config;
      const ex = exitLabel(c.trade, c.slPct);
      return { key: `${c.tpPct}|${ex}`, value: c.tpPct * 1_000_000 + EXIT_ORDER[c.trade.slMode] * 100_000 + (c.trade.slMode === "emaOnly" ? 0 : c.slPct), label: `익절 ${c.tpPct}% · ${ex}` };
    },
    minTrades,
  );
  const bestBot = ranking.find((r) => r.enough) ?? null;
  const bs = bestOf(bySl);
  const bt = bestOf(byTp);
  const be = bestOf(byExit);
  const bc = bestOf(byCombo);
  return { ranking, bySl, byTp, byExit, byCombo, best: { bot: bestBot?.name ?? null, sl: bs?.value ?? null, tp: bt?.value ?? null, exit: be?.label ?? null, combo: bc?.label ?? null }, minTrades };
}
