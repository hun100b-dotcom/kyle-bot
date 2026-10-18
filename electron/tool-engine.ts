// =============================================================================
// electron/tool-engine.ts  —  Capri 매매도구 엔진 (v2: 자율판단 제거, 온디맨드 전용)
// -----------------------------------------------------------------------------
// [v1(bot-engine)과 무엇이 다른가? — 컨셉 전환의 핵심]
//   v1: 봇이 5초마다 스스로 깨어나(틱 루프) 세션을 자동 전진(체결확인·익절·손절).
//   v2: ★자동으로 도는 것이 하나도 없다.★ 모든 동작은 사람이 화면에서 버튼을
//       눌렀을 때만 1회 실행된다(계산·시세조회·주문). 익절/손절 감시는 봇이 아니라
//       "토스 서버의 조건주문(OCO/OTO)"이 대신한다 — 그래서 앱을 꺼도 작동한다.
//
// [남긴 안전장치]
//   - 킬 스위치: 켜면 모든 주문 버튼이 잠긴다(계산·조회는 가능).
//   - 가격 이상 감지: 주문가가 현재가 ±5%를 벗어나면 오타로 보고 차단(제안값).
//   - 실주문 잠금: 실서버 모드의 주문은 전부 "드라이런"(모의 기록만).
//     해금은 소액(1주) 테스트를 사람이 직접 통과시킨 뒤 별도 버전에서(사용자 확정).
//
// [시크릿] 키는 앱 데이터 폴더 .env(권한 600)에만. 로그·화면·저장 데이터에 값 노출 금지.
// =============================================================================

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { writeFile as writeFileAsync, rename as renameAsync } from "node:fs/promises"; // [v0.90.0] 디바운스 저장용 — 메인 프로세스를 안 막는 비동기 쓰기
import { join } from "node:path";
import { DateTime } from "luxon";
import { getSession, getSessionStart, getMarketStatus, isOrderFrozen, isInDailyPauseWindow, type Session } from "../lib/session";
import { calcSplit3, calcSplit3Level, calcOrderbook, calcCandle, roundPrice, getTick, type SplitOrder } from "../lib/calc";
import { encryptSecret, decryptSecret, encryptJson, decryptJson, deriveDataKey, encryptJsonWithDataKey, decryptJsonAuto } from "../lib/keysync"; // [v0.8.0] 키 기기 간 동기화(클라이언트 암호화) + [v0.10.0] 매매 이력용
import { classifyTicks, strengthFromTicks, strengthFromVolumes, updateStrengthWindow, isWindowCapped, analyzeStrengthSeries, type Side, type StrengthSignals, type WindowBufferEntry } from "../lib/strength";
import { buildReportFromRealized, makePeriod, type DailyReport, type PeriodKind } from "../lib/report"; // [v0.9.1] 매매 리포트
import { matchFifo, mergeFills, coveredSince, shouldReuseCache, type Fill, type RealizedTrade } from "../lib/fills"; // [v0.9.6] 토스 실제 체결내역으로 손익 계산 (+v0.10.1 기간 커버리지 헬퍼)
import { reconcileHistoryEntry, enteredAtMsFromId, type HistoryReconcileResult } from "../lib/history-reconcile"; // [v0.64.0] 자동매매기록을 토스 실제 체결과 대조
import { buildCycles, analyzeTrades, type TradeCycle, type TradeInsights } from "../lib/trade-analysis"; // [v0.19.0] 매매 사이클 자동추적·분석
import { toSyncPayload, isSyncPayload, type TradeSyncPayload } from "../lib/trade-sync";
import { toAutoStateSyncPayload, isAutoStateSyncPayload, mergeAutoHistory, derivePositionsFromHistory, type AutoStateSyncPayload } from "../lib/auto-state-sync"; // [v0.31.0] 자동매매 기록 기기 간 동기화
import { classifyPullResult } from "../lib/sync-all"; // [v0.98.0] 전체 동기화: 받기 결과 분류(진짜 실패면 올리기 보류)
import { toSplitsSyncPayload, isSplitsSyncPayload, mergeSplits, mergeTombstones, type SplitsSyncPayload, type Tombstones } from "../lib/splits-sync"; // [v0.61.7] 삼분할 타점 기록 기기 간 동기화
import { aggregate1mTo5m, dropIncompleteBucket, toHeikinAshi, inPriceBand, ema, ichimoku, scanSessionPattern, WICK_MIN_RATIO, DOJI_MAX_AGE_MINUTES, type Candle, type SessionPattern } from "../lib/indicators";
import { buildAutoReport, type AutoRunRecord, type AutoReport } from "../lib/auto-report"; // [v0.62.1] 자동매매 리포트
import {
  atrPct,
  emaSlopePct,
  emaGapPct,
  evaluateDefenseFilters,
  structuralStopPrice,
  isReentryBlocked,
  trailingStopLossStreak,
  excursion,
  type EntryMetrics,
} from "../lib/defense"; // [v0.63.0] 방어 전략(이격도·기울기·변동성 필터, EMA 기준 손절, 재진입 금지, 연속 손절 중지)
import {
  LAB_PARAMS_DEFAULT,
  buildSeries,
  detectRuns,
  buildSignal,
  simulateSignal,
  summarizeVariants,
  summarizeLinkage,
  breakdownBy,
  buildFunnel,
  combinedScenario,
  signalsToCsv,
  tradesToCsv,
  type LabSignal,
  type LabParams,
  type LabFilter,
  type VariantRow,
  type LinkageSummary,
  type Funnel,
  type SimTrade,
  type BreakdownDim,
  type BreakdownRow,
  type CombinedResult,
} from "../lib/lab"; // [v0.65.0] 매매연구소(신호 기록 모드)
import { verifyLocal, compareWithFresh, buildAssessment, type LocalVerify, type TossCompareRow, type Assessment } from "../lib/lab-verdict"; // [v0.66.0] 데이터 검증 + [v0.67.0] 종합 평가
import { requiredPathEndMs } from "../lib/lab";
import { fetchWithTimeout, netStats } from "../lib/fetch-timeout"; // [v0.61.5 — ③ 전수조사 "높음-1"] Supabase REST 호출도 토스처럼 타임아웃을 건다
import {
  getPrice,
  getTrades,
  getRankings,
  getStocks,
  getCandles1mPaged,
  getCandles1mLatest,
  getAccounts,
  getBuyingPower,
  getSellable,
  getHoldings,
  getCommissions,
  getExchangeRate,
  createOrder,
  createConditionalOrder,
  getOrder,
  getConditionalOrder,
  listOrders,
  listConditionalOrders,
  listOrdersRaw,
  listConditionalOrdersRaw,
  mapOrderStatus,
  cancelOrder,
  cancelConditionalOrder,
  clearTokenCache,
  getAccessToken,
  makeClientOrderId,
  type ConditionalOrderResponse,
  type OrderResponse,
} from "../lib/toss";
import { createMockTossServer } from "../mocks/toss-mock";
import { canAutoEnter, isLossLimitBreached, volScaledInvestPct } from "../lib/auto-risk";
import { classifyTossError, CONNECTION_STEP_NAMES, type ConnectionTestResult } from "../lib/connection-test"; // [v0.91.0] 튜토리얼 연결 테스트
import { evaluateRestart, isMarkerFresh, describeRestart, type RestartBlocker, type RestartMarker } from "../lib/update-policy"; // [v0.70.0] 자동 업데이트 재시작 정책
import { checkBracketPrices, checkPercentSettings, checkSimpleOrder, type SanityExpect } from "../lib/order-sanity"; // [v0.69.2] 주문 전 정합성 검사
import { guessWarrantTickers, applyWarrantGate } from "../lib/warrant"; // [v0.36.0] 워런트 의심 종목 감지 / [v0.70.0] 탈락 게이트

// -----------------------------------------------------------------------------
// 타입: 화면과 주고받는 모양
// -----------------------------------------------------------------------------

/** 매매기법 종류(사용자가 매번 직접 선택) */
export type Technique = "split3" | "orderbook" | "candle" | "manual";

/** 계산 요청: 기법별로 필요한 재료가 다르다(화면이 기법에 맞는 칸만 보여줌) */
export interface CalcRequest {
  technique: Technique;
  tpPct: number; //  익절 % (기본 2)
  slPct: number; //  손절 % (기본 10)
  baseClose?: number; // [삼분할] 전봉 종가
  ema200?: number; //    [삼분할] EMA200
  wallPrice?: number; // [호가창] 매수벽 가격
  barOpen?: number; //   [캔들] 현재봉 시가 (전봉 양봉 확인은 사람 몫)
  entry?: number; //     [수동] 진입가 직접 입력
}

/** 계산 결과 한 줄(분할 레벨 하나) */
export interface CalcLevel {
  level: number;
  entry: number;
  tp: number;
  sl: number;
}

export interface CalcResult {
  technique: Technique;
  levels: CalcLevel[];
  note: string; // 화면에 보여줄 기법 설명 한 줄
}

/** 도구 상태(화면 표시용) */
export interface ToolStatus {
  mode: "mock" | "live";
  dryRun: boolean;
  liveOrdersEnabled: boolean; // 실주문 활성화 토글 상태(빨간 배지 표시용)
  skipOrderConfirm: boolean; // 주문 확인 팝업 건너뛰기
  killSwitch: boolean;
  session: Session; //       지금 장 세션(정보 표시용 — 주문을 막지는 않음)
  // [v0.8.4] 휴장(주말·미국 공휴일) 안내 — 표시용이며 주문을 막지는 않는다.
  closedReason: string | null; // 닫혀 있는 이유("주말(일요일)", "추수감사절", "장 시간 아님")
  earlyClose: string | null; //   오늘이 조기폐장일이면 그 이름(정규장이 뉴욕 13:00 마감)
  nextOpenNote: string | null; // 다음 개장 안내(예: "다음 개장 08-17(월) 09:00")
  orderFrozen: boolean; //   마감 1분 전 정정·취소 불가 구간 경고
  clockNote: string;
  fxRate: number | null; //  1 USD = ? KRW (토스 API, 1분 캐시)
  fxSource: "toss" | "manual" | null;
  buyingPowerUsd: number | null;
}

/**
 * [v0.2.10] 매매 근거 스냅샷 — "이 주문을 왜 이 가격에 냈는가"를 주문 시점에 통째로 찍어 둔다.
 *
 * [왜 필요한가?]
 *   토스 API는 주문 결과(가격·수량·상태)만 돌려주고, "삼분할 2분할 타점이었다"거나
 *   "EMA200이 얼마였다" 같은 **우리 기법의 근거**는 어디에도 남지 않는다. 나중에 복기할 때
 *   "이 주문 왜 냈지?"를 알 수 없다. 그래서 주문을 낼 때 우리가 직접 기록해 둔다.
 *
 * [어떻게 토스 주문과 연결하나?]
 *   clientOrderId(우리가 만든 주문 고유번호)를 열쇠로 쓴다. 이 번호는 주문 요청에 담아 보내므로
 *   나중에 토스 주문/체결과 짝을 맞출 수 있다.
 */
export interface TradeRationale {
  clientOrderId: string; //  열쇠(토스 주문과 매칭용)
  ts: string; //             주문 시각(KST)
  kind: "entry" | "oco" | "oto"; //  진입 지정가 / 조건주문(익절+손절) / 진입+익절(OTO)
  symbol: string;
  technique: Technique; //   사용한 기법
  level?: number; //         [삼분할] 몇 분할 타점인지(1/2/3)
  baseClose?: number; //     [삼분할] 전봉 종가
  ema200?: number; //        [삼분할] EMA200
  wallPrice?: number; //     [호가창] 매수벽 가격
  barOpen?: number; //       [캔들] 현재봉 시가
  entry?: number; //         진입가
  tp?: number; //            익절가
  sl?: number; //            손절가
  tpPct?: number; //         익절 %
  slPct?: number; //         손절 %
  quantity: number;
  priceAtOrder: number | null; // 주문 낼 때의 현재가
  tossOrderId?: string; //   토스가 준 주문번호(성공 시)
  dryRun: boolean; //        모의 전송이었는지(실제로 안 나간 주문)
  /** [v0.30.0] 이 주문을 누가 냈는지 — 자동매매인지 사람이 버튼을 눌렀는지.
   *  [오너 지시 2026-09-26] "자동매매로 진행된 모든 매매는 식별할 수 있도록 표기". technique은
   *  "어떤 계산식을 썼는지"만 구분해(자동매매도 수동 삼분할과 똑같이 technique:"split3"을 씀) 이
   *  용도로는 못 쓰므로 별도 필드로 둔다. optional인 이유: 기존 수동 버튼 호출부 전부를 건드리지
   *  않기 위해(technique와 달리 명시적으로 안 보내도 되게) — saveRationale이 "manual"로 기본
   *  채운다. 자동매매(autoTradeTick)만 명시적으로 "auto"를 보낸다. */
  source?: "auto" | "manual";
}

/** 화면이 주문할 때 함께 보내는 근거 입력(위 타입에서 자동 채워지는 항목 제외) */
export type RationaleInput = Omit<TradeRationale, "clientOrderId" | "ts" | "kind" | "symbol" | "quantity" | "tossOrderId" | "dryRun">;

/** [v0.2.10] 보유 포지션 한 줄 — 근거 + 실시간 손익까지 합쳐 화면에 그대로 뿌린다. */
export interface PositionView {
  symbol: string;
  quantity: number;
  /** 통화. 실계좌에는 국내 종목(원화)도 섞여 있어 $로만 표시하면 금액을 오해한다. */
  currency: string;
  avgPrice: number | null; //     토스가 알려준 평균매입가
  entryPrice: number | null; //   손익 기준가(우리 기록 우선, 없으면 평균매입가)
  entrySource: "rationale" | "toss" | "none"; // 기준가를 어디서 얻었는지(화면 표기용)
  currentPrice: number | null; // 지금 시세
  pnlPct: number | null; //       (현재가-기준가)/기준가 × 100
  pnlUsd: number | null; //       평가손익(달러)
  toTpPct: number | null; //      익절가까지 몇 %p 남았는지
  toSlPct: number | null; //      손절가까지 몇 %p 남았는지
  rationale: TradeRationale | null; // 이 종목의 가장 최근 매매 근거
}

// -----------------------------------------------------------------------------
// [v0.3.3] 주문 현황 화면(토스 스타일)용 리치 뷰 타입 — holdings/orders/conditional 원본을
//   빠짐없이 담아 화면에 그대로 뿌린다. 금액은 통화까지 함께 줘서 $/₩ 를 올바로 표기한다.
// -----------------------------------------------------------------------------

/** 보유 한 줄(holdings items[] 전부 + 우리 근거) */
export interface HoldingRow {
  symbol: string;
  name: string | null; //          한글 종목명(예: 아이온큐)
  marketCountry: string | null; //  US / KR
  currency: string; //             USD / KRW
  quantity: number; //             보유 수량(소수주 그대로)
  lastPrice: number | null; //     현재가(holdings에 이미 포함 — 재조회 안 함)
  avgPrice: number | null; //      평균매입가(averagePurchasePrice)
  purchaseAmt: number | null; //   매입원가
  marketValueAmt: number | null; // 평가금액(해당 통화)
  pnlAmt: number | null; //        평가손익(해당 통화)
  pnlRate: number | null; //       수익률 %(소수×100)
  dailyPnlAmt: number | null; //   당일손익 금액
  dailyPnlRate: number | null; //  당일손익 %
  commission: number | null; //    수수료
  tax: number | null; //           세금
  rationale: TradeRationale | null; // 우리가 저장한 기법 근거(있으면)
}

/** 보유 요약(holdings 최상위) — 총평가·총손익·당일손익, 통화별 병기 */
export interface HoldingsSummary {
  marketValueUsd: number | null;
  marketValueKrw: number | null;
  pnlUsd: number | null;
  pnlKrw: number | null;
  pnlRate: number | null; //       총 수익률 %
  dailyPnlUsd: number | null;
  dailyPnlKrw: number | null;
}

/** 일반 주문 한 줄(원본 필드 전부) */
export interface OrderRow {
  orderId: string;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  orderType: string | null; //     LIMIT / MARKET
  statusRaw: string | null; //     토스 원본 대문자(FILLED 등)
  statusStd: string; //            우리 표준 소문자(filled/submitted/cancelled…)
  price: number | null;
  quantity: number | null;
  orderAmount: number | null;
  currency: string | null;
  timeInForce: string | null;
  orderedAt: string | null; //     주문 시각(ISO+KST)
  canceledAt: string | null;
  filledQty: number | null; //     체결 수량
  avgFilledPrice: number | null; // 평균 체결가
  filledAmount: number | null;
  commission: number | null;
  tax: number | null;
  filledAt: string | null;
  isOpen: boolean; //              미체결(취소 가능) 여부
}

/** 조건주문 다리(leg) 한 개 */
export interface CondLegView {
  legType: string | null; //       STOP 등
  status: string | null; //        WATCHING / HOLDING / COMPLETED
  triggerPrice: number | null;
  orderPrice: number | null;
  triggeredOrderId: string | null; // 발동되면 실제 주문 ID로 연결
}

/** 조건주문 한 줄(OTO/OCO) */
export interface CondOrderRow {
  conditionalOrderId: string;
  type: string | null; //          OCO / OTO / SINGLE
  status: string | null; //        WATCHING / COMPLETED
  symbol: string | null;
  market: string | null;
  quantity: number | null;
  orderType: string | null;
  expireDate: string | null;
  createdAt: string | null;
  first: CondLegView | null; //    진입(먼저 감시)
  second: CondLegView | null; //   청산(익절/손절)
  rationale: TradeRationale | null;
  isOpen: boolean; //              진행 중(삭제 가능) 여부
}

/** [v0.56.0] "서버 로그" 탭의 카테고리 토글 필터가 쓰는 대분류.
 *  addJournal이 kind·summary 문구로 자동 판정해 채운다(호출부를 일일이 안 고쳐도 되게). */
export type JournalCategory = "주문" | "인증" | "동기화" | "자동매매" | "시스템" | "오류";

/** 주문/기록 저널 한 줄(파일로 영속) */
export interface JournalEntry {
  ts: string;
  kind: "entry" | "oco" | "oto" | "cancel" | "dryrun" | "info";
  symbol: string;
  summary: string; // 사람이 읽는 한 줄 요약
  detail?: unknown;
  /** [v0.32.0] true면 이 저널과 함께 오너에게 알림(PC 데스크톱 알림/폰 브라우저 알림)도 띄운다.
   *  자동매매의 주요 이벤트(관찰 확정·진입·체결·익절손절·취소·실패)에만 붙인다 — 모든 로그를
   *  알림으로 띄우면 알림 피로만 쌓이므로, 화면을 안 보고 있어도 놓치면 안 되는 것만 고른다. */
  notify?: boolean;
  /** notify=true일 때 알림 제목(짧게). 없으면 addJournal이 일반 제목으로 채운다. */
  notifyTitle?: string;
  /** [v0.56.0 — 오너 지시 "서버 로그의 기능 고도화... 카테고리화 토글로 원하는 데이터를
   *  식별할 수 있게"] addJournal이 자동으로 채운다(호출부에서 명시적으로 안 넣어도 됨). */
  category?: JournalCategory;
}

/**
 * [v0.56.0] classifyJournalEntry — 저널 한 줄을 6개 대분류 중 하나로 자동 분류한다.
 *   호출부(수백 곳)를 일일이 고쳐 카테고리를 명시하게 하는 대신, kind와 summary 문구만으로
 *   합리적으로 추정한다(순수 함수라 테스트 가능). 오너가 "서버 로그" 탭에서 카테고리 토글로
 *   필요한 것만 골라 보고 싶다는 요청에 따른 것 — 완벽한 분류가 목적이 아니라, 지금까지
 *   전부 "기타"로 뭉뚱그려 보이던 것을 실전에서 쓸 만한 수준으로 나누는 것이 목적이다.
 *   우선순위: ①오류(문구에 실패·오류 표시) → ②주문(kind 기준, 가장 명확) → ③문구 키워드로
 *   인증/동기화/자동매매 순서로 추정 → ④나머지는 시스템.
 */
/** [v0.57.0] OCO 규칙: 반드시 "익절 감시가 > 현재가 > 손절 감시가"여야 한다(토스 스펙). 사전
 *  경고(placeOco)와 체결 후 재시도 중 즉시 보호매도 판단(registerOcoForFilled)이 정확히 같은
 *  기준을 써야 하므로 한 곳에 모아 둔다 — 따로 두면 나중에 한쪽만 고쳐질 위험이 있다. */
export function isWithinOcoBand(cur: number, tpTrigger: number, slTrigger: number): boolean {
  return tpTrigger > cur && cur > slTrigger;
}

/** [v0.62.0 긴급 — 오너 실사용 재발(VEEA, v0.57.0 배포 이후에도 발생)] registerOcoForFilled가
 *  재시도 전 현재가를 다시 확인해 "밴드 안"이라고 판단해도, 그 직후 보낸 placeOco 요청은
 *  토스 쪽에서 매번 "밴드 밖"이라며 거부될 수 있다 — 우리가 확인한 시점과 토스가 실제로
 *  요청을 처리하는 시점 사이에도 가격이 또 움직이는 경쟁(TOCTOU)이다. 변동성 큰 저가주에서는
 *  이 경쟁에서 매 시도 계속 질 수 있어, 재시도를 전부 소진해도 "밴드 위반"만 반복될 수 있다.
 *  이 함수는 그 최종 실패 사유가 정확히 이 밴드 위반인지 식별한다(마지막 보루 보호매도 판단용). */
export function isOcoPriceBandError(e: unknown): boolean {
  const s = String(e);
  return s.includes("HTTP 400") && s.includes("두 감시가 사이에 있어야 합니다");
}

export function classifyJournalEntry(e: Pick<JournalEntry, "kind" | "summary">): JournalCategory {
  const s = e.summary;
  if (/⚠️|실패|오류/.test(s)) return "오류";
  if (e.kind === "entry" || e.kind === "oco" || e.kind === "oto" || e.kind === "cancel" || e.kind === "dryrun") return "주문";
  if (/로그인|로그아웃|가입|승인|CAPRI_NOT_ALLOWED/.test(s)) return "인증";
  if (/동기화|그룹|공유|클라우드|받았습니다|채팅/.test(s)) return "동기화";
  if (/자동매매|스크리닝|스캔|관찰 확정|킬 스위치/.test(s)) return "자동매매";
  return "시스템";
}

/** [v0.32.0] addJournal이 notify:true인 저널마다 함께 내보내는 알림 이벤트.
 *  PC(Electron)와 웹앱(브라우저) 양쪽이 각자의 Notification API로 화면 밖에서도 띄운다. */
export interface NotifyEvent {
  title: string;
  body: string;
  symbol: string;
  ts: string;
}

/** [v0.56.0] 그룹 채팅 메시지 한 줄(capri_group_chat). */
export interface GroupChatMessage {
  id: number;
  email: string;
  body: string;
  createdAt: string; // ISO(UTC) — 화면에서 로컬 시각으로 변환해 표시
}

/** [v0.61.9] "업데이트 내역" 탭 한 줄 — 그룹 전원이 함께 보는 공개 변경 로그. */
export interface ChangelogEntry {
  version: string;
  title: string;
  body: string; // 마크다운 형식의 상세 리포트
  publishedAt: string; // ISO(UTC)
}

// -----------------------------------------------------------------------------
// .env 파싱(경량)
// -----------------------------------------------------------------------------
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// -----------------------------------------------------------------------------
// [v0.3.0] 세션별 시드 진입 수량 계산(순수 함수 — 화면·엔진과 분리해 테스트 가능)
// -----------------------------------------------------------------------------
/**
 * computeSeedQty — "시드의 몇 %로, 이 가격에 몇 주 살 수 있나"를 계산한다.
 *
 *   공식: floor( 시드금액 × (세션비율/100) ÷ ( 현재가 × (1 + 수수료율) ) )
 *
 *   - seedUsd     : 시드 기준 금액(달러). 매수가능금액 또는 오너가 정한 고정값.
 *   - pct         : 이번 세션에 쓸 비율(예: 데이 90, 프리/본장 50).
 *   - price       : 현재가(1주 가격, 달러).
 *   - commission  : 수수료율(비율. 0.001 = 0.1%). 수수료로 1주 모자라는 사고를 막으려 반영.
 *   값이 없거나 이상하면 null(화면은 "조회 불가"로 표시하고 강제하지 않는다).
 */
export function computeSeedQty(seedUsd: number | null, pct: number, price: number | null | undefined, commission: number | null): number | null {
  if (seedUsd == null || !Number.isFinite(seedUsd) || seedUsd <= 0) return null;
  if (!price || price <= 0) return null;
  if (!Number.isFinite(pct) || pct < 0) return null;
  const fee = commission ?? 0;
  const budget = seedUsd * (pct / 100); // 이번 진입에 쓸 금액
  const perShare = price * (1 + fee); // 수수료 포함 1주 실비용
  return Math.max(0, Math.floor(budget / perShare));
}

/**
 * [v0.60.0→v0.61.8] "방향 정합성" 재진입 체크 — 같은 종목에 직전보다 더 비싼 타점으로
 *   재진입하려는 시도를 막기 위해 비교할 "직전 기록"을 찾는다. 순수 함수로 빼서(autoTradeTick
 *   안에 묻혀 있던 로직) 실제 스캔 없이도 검증할 수 있게 했다 — 오너 지적("과거 매매이력을
 *   기준으로 하면 진입할 종목도 막히는 경우가 있음")을 코드로 증명하는 자리.
 *
 *   비교 대상: ①아직 안 끝난(watching/active) 포지션은 진입 시각과 무관하게 항상 포함(그
 *   포지션이 살아있는 한 더 비싸게 또 사는 건 전략 모순이므로). ②완전히 청산된 매매는
 *   "recentWindowMs 이내에 진입했던" 것만(기본값은 자동매매 한 사이클, 5분 — v0.60.0 원래
 *   사고인 "같은 사이클 직후 재평가에서 노이즈로 역전"은 여전히 잡되, 몇 시간~하루 전에 이미
 *   끝난 매매가 전혀 다른 시점의 정당한 새 기회까지 막는 일은 없앤다).
 *   드라이런 기록은 애초에 비교 대상에서 제외(실제로 시도됐던 진입만 기준).
 */
export function findDirectionConflict(
  history: AutoTradeHistoryEntry[],
  symbol: string,
  nowMs: number,
  recentWindowMs: number,
): AutoTradeHistoryEntry | null {
  const candidates = history.filter((h) => {
    if (h.symbol !== symbol || h.status === "dryrun") return false;
    if (h.status === "watching" || h.status === "active") return true;
    const enteredAtMs = Number(h.id.split("@").pop());
    return Number.isFinite(enteredAtMs) && nowMs - enteredAtMs < recentWindowMs;
  });
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/**
 * [v0.32.0] 스캔 결과 중 "이번에 새로 확정(confirmed)된" 종목만 골라낸다 — 직전 스캔에서
 *   이미 확정 상태였던 종목은 제외해 "관찰 확정" 알림이 5분마다 중복으로 뜨지 않게 한다.
 *   순수 함수라 실제 스크리너 판정 로직과 분리해 테스트할 수 있다.
 */
export function newlyConfirmedSymbols(results: ScreenResult[], previouslyConfirmed: Set<string>): string[] {
  return results.filter((r) => r.status === "confirmed" && !previouslyConfirmed.has(r.symbol)).map((r) => r.symbol);
}

/**
 * [v0.72.0 — 오너 지시 "관찰, 확정된 종목이 나오면 즉시 디스코드로 알림"] "watch"판도 같은
 *   원리로 신규 여부를 가린다(newlyConfirmedSymbols와 쌍 — 한 줄짜리 로직이라 매개변수로
 *   합치기보다 각자 읽기 쉽게 따로 둔다).
 */
export function newlyWatchedSymbols(results: ScreenResult[], previouslyWatched: Set<string>): string[] {
  return results.filter((r) => r.status === "watch" && !previouslyWatched.has(r.symbol)).map((r) => r.symbol);
}

/**
 * [v0.84.0 — 오너 지시 "확정 시 확정사유"] 디스코드 확정 알림에 "왜 지금 확정됐는지"를 한 줄로
 *   붙이기 위한 요약. ScreenEvidenceView(App.tsx, 화면의 판정 근거 패널)와 같은 데이터를
 *   쓰지만, "확정"은 정의상 모든 체크(✓)가 이미 통과한 상태라 칸을 전부 나열해봐야 전부
 *   ✓뿐이라 의미가 없다 — 대신 "이 종목이 왜 하필 지금 떴는지"를 설명하는 핵심(세션 고점·도지
 *   발생 시각과 몸통 비율·고점과의 간격)만 추려 짧게 보여준다. 순수 함수라 실제 스캔 없이도
 *   문구를 테스트할 수 있다.
 */
export function summarizeConfirmEvidence(ev: ScreenEvidence | null): string {
  if (!ev) return "근거 정보 없음";
  const parts: string[] = [];
  if (ev.sessionHigh != null) parts.push(`세션고점 $${ev.sessionHigh}${ev.sessionHighTime ? `(${ev.sessionHighTime})` : ""}`);
  if (ev.doji) {
    const bodyPct = ev.doji.bodyRatio != null ? ` 몸통${(ev.doji.bodyRatio * 100).toFixed(0)}%` : "";
    parts.push(`도지 ${ev.doji.time}${bodyPct}`);
  }
  if (ev.gapFromHighMinutes != null) parts.push(`고점~도지 ${ev.gapFromHighMinutes}분`);
  if (ev.next) parts.push(`다음봉 ${ev.next.bearish ? "음봉 확인됨" : "확인 중"}`);
  return parts.length > 0 ? parts.join(" · ") : "EMA200·구름 위 + 음봉 도지 패턴 확인";
}

/**
 * [관찰종목 이력 — 오너 지시 "관찰된 종목이 어떻게 탈락/확정됐는지 확인할 수 있는 곳이 필요"]
 *   이 종목이 지금 "watch/confirmed"가 못 된 이유를 전부 모은다. src/App.tsx의 missReasons()와
 *   완전히 같은 판정 순서를 쓰지만(두 곳이 같은 ScreenResult.evidence.filters/defenseReasons/
 *   warrantWarning을 보고 같은 결론을 내야 하므로), 여기 따로 둔 이유는 화면이 꺼져 있을 때도,
 *   그리고 그 스캔 결과 자체가 다음 사이클에 지워진 뒤에도 "그때 왜 탈락했는지" 사유 문장만은
 *   영구히 남아야 하기 때문이다(아래 updateWatchHistory가 이 함수를 "그 순간"에 호출해 결과를
 *   WatchHistoryEntry.reasons에 그대로 박아 둔다 — 나중에 다시 계산하지 않는다).
 */
export function summarizeMissReasons(
  r: ScreenResult,
  run: Pick<ScreenRun, "emaTrendEnabled" | "cloudEnabled" | "nextCandleConfirmEnabled" | "dojiMaxGapMinutes">,
): string[] {
  const reasons: string[] = [];
  if (!r.priceInBand) reasons.push(`가격대 벗어남 (현재가 ${r.price != null ? `$${r.price.toFixed(2)}` : "—"})`);
  if (run.emaTrendEnabled && !r.aboveEma) reasons.push("EMA200 아래");
  if (run.cloudEnabled && !r.aboveCloud) reasons.push("일목균형표 구름 아래/속");
  if (r.evidence) {
    const f = r.evidence.filters;
    if (!f.firstDoji) reasons.push("최고점 이후 음봉 도지 없음");
    else if (!f.bothWicks) reasons.push("도지에 꼬리가 한쪽만(망치형·유성형)");
    else if (f.dojiNearHigh === false) reasons.push(`도지가 최고점에서 너무 한참 뒤에 생김(${r.evidence.gapFromHighMinutes ?? "?"}분 간격 — ${run.dojiMaxGapMinutes}분 초과)`);
    else if (!f.recentDoji) reasons.push("도지 발생이 너무 오래전(20분 초과 — 신뢰 불가)");
    else if (run.nextCandleConfirmEnabled && !f.nextBearish) reasons.push("도지 다음 봉이 음봉 아님(패턴 미완성)");
  }
  for (const d of r.defenseReasons ?? []) reasons.push(d);
  if (r.warrantWarning) reasons.push(r.warrantWarning);
  return reasons;
}

/**
 * [관찰종목 이력] "탈락 사유 병목 분석"용 안정된 분류명 — summarizeMissReasons의 상세 문장(가격 등
 *   매번 바뀌는 숫자가 섞여 있어 그대로 집계하면 사실상 전부 제각각 1건씩이 된다)과는 별도로,
 *   src/App.tsx의 tallyMissReasons와 같은 분류 기준을 그대로 재사용해 "그때그때 바뀌지 않는 이름"만
 *   뽑는다. 같은 ScreenResult를 보고 두 함수가 따로 도는 게 아니라, summarizeMissReasons가 이미
 *   만든 상세 문장을 그대로 분류하므로 두 결과가 어긋날 일이 없다(문장 접두어로만 판별).
 */
export function bucketMissReason(reason: string): string {
  if (reason.startsWith("가격대 벗어남")) return "가격대 벗어남";
  if (reason.startsWith("도지에 꼬리가 한쪽만")) return "도지 꼬리 한쪽만(망치형 등)";
  if (reason.startsWith("도지가 최고점에서 너무 한참 뒤")) return "도지가 최고점 한참 뒤";
  if (reason.startsWith("도지 발생이 너무 오래전")) return "도지 발생 20분 초과(신선도 불합격)";
  if (reason.startsWith("EMA 이격도")) return "EMA 이격도 미달";
  if (reason.startsWith("EMA가 상승") || reason.startsWith("EMA 기울기")) return "EMA 상승 중 아님";
  if (reason.startsWith("ATR") || reason.includes("변동성")) return "변동성 과다/계산 불가";
  if (reason.includes("워런트")) return "워런트 저가 탈락";
  return reason; // EMA200 아래·이치모쿠 구름 아래/속·최고점 이후 음봉 도지 없음·패턴 미완성 등은 이미 고정 문구
}

/** 관찰(watch) 신호 하나의 생애주기 — 언제 관찰이 시작됐고 어떻게 끝났는지를 담는다.
 *   "watching"(관찰 중) → "confirmed"(확정으로 졸업) · "disqualified"(스캔엔 남았지만 조건
 *   미달로 탈락, 사유 있음) · "dropped_from_scan"(이번 스캔 결과에 아예 없음 — 거래량 순위
 *   밖으로 벗어난 것으로 추정되나 정확한 사유는 알 수 없음, 추측으로 메우지 않고 정직하게 둠). */
export type WatchOutcome = "watching" | "confirmed" | "disqualified" | "dropped_from_scan";
export interface WatchHistoryEntry {
  id: string; //              `${symbol}:${watchedAtMs}` — 같은 종목이 나중에 다시 관찰되면 새 id로 별개 기록
  symbol: string;
  watchedAtMs: number; //     처음 "관찰(watch)"로 잡힌 시각
  watchedPrice: number | null;
  lastSeenAtMs: number; //    마지막으로 이 종목이 스캔 결과에 보였던 시각(관찰 중이면 스캔마다 갱신)
  resolvedAtMs: number | null; // outcome이 "watching"이 아니게 된 시각(아직 관찰 중이면 null)
  outcome: WatchOutcome;
  reasons: string[]; //       disqualified(탈락 사유들, 상세)·confirmed(확정 근거 한 줄) — watching/dropped는 각각 빈 배열/추정 안내 한 줄
  reasonBuckets: string[]; // disqualified일 때만 — bucketMissReason으로 정규화한 분류명(병목 집계용, getWatchHistorySummary가 씀)
}

export const WATCH_HISTORY_MAX = 2000;

/**
 * updateWatchHistory — 이번 스캔 결과로 관찰 이력을 갱신한다(순수 함수 — 엔진은 반환값을 그대로
 *   저장만 한다, 테스트도 실제 스캔 없이 가짜 ScreenResult로 가능). 상한을 넘으면 "아직 관찰 중"인
 *   건 전부 보존하고, 끝난 기록 중 오래된 것부터 자른다(관찰 중인 걸 지우면 그 종목의 결말을
 *   영영 못 보게 되므로 최우선 보존).
 */
export function updateWatchHistory(
  history: WatchHistoryEntry[],
  results: ScreenResult[],
  run: Pick<ScreenRun, "emaTrendEnabled" | "cloudEnabled" | "nextCandleConfirmEnabled" | "dojiMaxGapMinutes">,
  nowMs: number,
): WatchHistoryEntry[] {
  const bySymbol = new Map(results.map((r) => [r.symbol, r]));
  let next: WatchHistoryEntry[] = history.map((h) => {
    if (h.outcome !== "watching") return h; // 이미 끝난 기록은 그대로(재계산·재작성 안 함 — 그 순간의 사유를 영구 보존)
    const r = bySymbol.get(h.symbol);
    if (!r) {
      return {
        ...h, resolvedAtMs: nowMs, outcome: "dropped_from_scan", reasonBuckets: [],
        reasons: ["이번 스캔의 거래량 상위 종목 목록에서 더 이상 보이지 않습니다(순위 밖으로 벗어난 것으로 추정 — 정확한 사유는 확인할 수 없습니다)."],
      };
    }
    if (r.status === "watch") return { ...h, lastSeenAtMs: nowMs }; // 계속 관찰 중 — 최신 시각만 갱신
    if (r.status === "confirmed") return { ...h, resolvedAtMs: nowMs, outcome: "confirmed", reasons: [summarizeConfirmEvidence(r.evidence)], reasonBuckets: [] };
    const reasons = summarizeMissReasons(r, run);
    return { ...h, resolvedAtMs: nowMs, outcome: "disqualified", reasons, reasonBuckets: reasons.map(bucketMissReason) };
  });
  for (const r of results) {
    if (r.status !== "watch") continue;
    if (next.some((h) => h.symbol === r.symbol && h.outcome === "watching")) continue; // 이미 관찰 중으로 기록됨
    next = [...next, { id: `${r.symbol}:${nowMs}`, symbol: r.symbol, watchedAtMs: nowMs, watchedPrice: r.price, lastSeenAtMs: nowMs, resolvedAtMs: null, outcome: "watching", reasons: [], reasonBuckets: [] }];
  }
  if (next.length > WATCH_HISTORY_MAX) {
    const watching = next.filter((h) => h.outcome === "watching");
    const resolved = next.filter((h) => h.outcome !== "watching").sort((a, b) => (a.resolvedAtMs ?? 0) - (b.resolvedAtMs ?? 0));
    const keepResolved = resolved.slice(Math.max(0, resolved.length - Math.max(0, WATCH_HISTORY_MAX - watching.length)));
    next = [...keepResolved, ...watching].sort((a, b) => a.watchedAtMs - b.watchedAtMs);
  }
  return next;
}

/** [v0.96.0 — 오너 요청 "확정된 종목이 실제로 매수까지 이어졌는지, 성적이 어땠는지가 보여야
 *   유의미하다"] 확정(confirmed) 관찰 기록 하나가 실제 매수 시도(AutoTradeHistoryEntry)로
 *   이어졌는지 찾은 결과. `traded`는 "주문이 접수됐는가"(체결 여부와 무관 — 체결 전/취소/보호주문
 *   실패까지 포함한 `tradeStatus`로 구분), `pnlUsd`는 청산까지 끝나 손익이 확정된 경우만 값이 있다. */
export interface WatchTradeLink {
  traded: boolean;
  tradeStatus: AutoTradeHistoryEntry["status"] | null;
  pnlUsd: number | null;
}

const WATCH_TRADE_NOT_LINKED: WatchTradeLink = { traded: false, tradeStatus: null, pnlUsd: null };

/**
 * linkWatchToTrade — 확정된 관찰 기록 하나를, 그 확정 직후(windowMs 이내) 같은 종목으로 접수된 가장
 *   빠른 실제 매수 기록과 잇는다(순수 함수 — 아무것도 쓰지 않고 기존 두 기록만 읽어 비교한다. 주문·
 *   진입·게이트 로직은 전혀 건드리지 않음). `tradesBySymbol`은 호출부가 `autoTradeHistory`(최대
 *   500건)를 종목별로 한 번만 `Map`으로 묶어 넘긴다 — 관찰 기록(최대 2000건)마다 전체를 다시 훑지
 *   않기 위함. `AutoTradeHistoryEntry.id`가 `${symbol}@${entry}@${enteredAtMs}` 형태인 기존 관례
 *   (lib/auto-report.ts의 buildAutoReport와 동일)를 그대로 재사용해 진입 접수 시각을 뽑는다.
 *   [한계] 확정됐지만 못 들어간 이유(최대 종목수·손실한도·예산부족 등 게이트 거부)는
 *   `autoTradeSkipReasons`가 사이클마다 메모리에서만 초기화되는 비영속 값이라 여기선 알 수 없다 —
 *   "매수로 안 이어짐"까지만 정직하게 표시한다(추측으로 사유를 채우지 않음, dropped_from_scan과
 *   같은 원칙).
 */
export function linkWatchToTrade(
  entry: Pick<WatchHistoryEntry, "symbol" | "outcome" | "resolvedAtMs">,
  tradesBySymbol: Map<string, AutoTradeHistoryEntry[]>,
  windowMs: number,
): WatchTradeLink {
  if (entry.outcome !== "confirmed" || entry.resolvedAtMs == null) return WATCH_TRADE_NOT_LINKED;
  const candidates = tradesBySymbol.get(entry.symbol.toUpperCase()) ?? [];
  let best: AutoTradeHistoryEntry | null = null;
  let bestEnteredMs = Infinity;
  for (const t of candidates) {
    const idMs = Number(t.id.split("@").pop());
    if (!Number.isFinite(idMs) || idMs <= 1e12) continue; // id 형식이 다르면(옛 기록 등) 매칭 포기
    if (idMs < entry.resolvedAtMs || idMs - entry.resolvedAtMs > windowMs) continue; // 확정 전이거나 너무 늦게 들어간 건 별개 기회
    if (idMs < bestEnteredMs) { bestEnteredMs = idMs; best = t; }
  }
  return best ? { traded: true, tradeStatus: best.status, pnlUsd: best.pnlUsd } : WATCH_TRADE_NOT_LINKED;
}

/** [v0.96.0] watchHistory 전체를 한 번에 연결할 때 쓰는 헬퍼 — autoTradeHistory를 종목별 Map으로
 *   한 번만 묶어 linkWatchToTrade를 반복 호출한다(엔진의 getWatchHistory/getWatchHistorySummary가 공용). */
export function buildTradesBySymbol(autoTradeHistory: AutoTradeHistoryEntry[]): Map<string, AutoTradeHistoryEntry[]> {
  const m = new Map<string, AutoTradeHistoryEntry[]>();
  for (const t of autoTradeHistory) {
    const key = t.symbol.toUpperCase();
    const arr = m.get(key);
    if (arr) arr.push(t);
    else m.set(key, [t]);
  }
  return m;
}

/**
 * [v0.33.0 — 스크리닝 기준 탭] 도지 패턴 판정(watch/confirmed/none) + 하드 게이트(가격대·EMA·
 *   구름) + "다음 봉 확인" 켜짐 여부를 합쳐 최종 상태를 정한다. scanScreener 안에 묻혀 있던
 *   이 결정 로직을 순수 함수로 빼서, 실제 스캔(네트워크·캔들 계산) 없이도 "토글을 끄면 실제로
 *   결과가 달라지는지"를 직접 검증할 수 있게 한다 — 오너가 강조한 핵심 포인트(설정이 진짜
 *   스크리닝에 반영되는지)를 코드로 증명하는 자리.
 */
export function applyScreenGates(
  patStatus: "confirmed" | "watch" | "none",
  gates: { priceInBand: boolean; emaGateOk: boolean; cloudGateOk: boolean; nextCandleConfirmEnabled: boolean },
): ScreenStatus {
  // "다음 봉 확인"을 꺼 두면 도지만 나온 상태(watch)를 곧바로 확정으로 승격한다.
  const promoted: "confirmed" | "watch" | "none" = !gates.nextCandleConfirmEnabled && patStatus === "watch" ? "confirmed" : patStatus;
  return gates.priceInBand && gates.emaGateOk && gates.cloudGateOk ? promoted : "none";
}

// -----------------------------------------------------------------------------
// [v0.4.0] 삼분할 타점 "기록" — 여러 종목을 동시에 굴리기 위한 저장 기능
// -----------------------------------------------------------------------------
// [왜 만들었나? — 오너가 겪은 실제 불편]
//   계산기는 한 번에 "한 종목"만 계산해 보여준다. A종목 삼분할을 계산해 진입하다가
//   B종목을 새로 입력하면, A의 3개 타점(진입가1/2/3)이 화면에서 사라진다.
//   그러면 A~D 여러 종목을 동시에 지켜보며 나눠 담는 매매를 할 수가 없다.
//
// [해결]
//   계산 결과를 [기록 저장] 버튼으로 파일에 남겨 두면, 종목을 바꿔 계산해도
//   저장한 타점들이 "내 삼분할 기록" 탭에 그대로 쌓여 있다. 앱을 껐다 켜도 유지된다
//   (기존 매매근거·저널과 똑같은 'JSON 파일 저장' 방식을 그대로 재사용).
//
// [저장 방식] userData 폴더의 kylebot-splits.json 한 파일. 시크릿·계좌정보는 담지 않는다
//   (종목·가격·메모 같은 계산 결과뿐 — 유출돼도 민감하지 않은 값들).

/** 저장된 삼분할 타점 한 줄(분할 레벨 하나). 계산 결과 + '진입완료' 체크 상태. */
export interface SavedSplitLevel {
  level: number; //   몇 분할 타점인지(1/2/3)
  entry: number; //   진입가
  tp: number; //      이 타점의 익절가
  sl: number; //      이 타점의 손절가
  entered: boolean; // 오너가 [진입완료]를 체크했는지(실제 주문과 무관한 '내 메모용' 표시)
}

/**
 * [v0.9.0] 계산기에 다시 채워 넣기 위한 '원본 입력값' 묶음.
 *
 * [왜 저장하나?]
 *   기록에는 계산 '결과'(진입가·익절·손절)만 남아 있어서, 나중에 2차·3차 매수를 하려면
 *   전봉 종가·EMA200 같은 재료를 처음부터 다시 입력해야 했습니다. 그 번거로움을 없애려고
 *   계산에 쓴 재료를 그대로 함께 저장해 둡니다. → [계산기로 불러오기] 한 번이면 끝.
 *
 * [왜 숫자가 아니라 문자열인가?]
 *   계산기 입력칸은 사람이 친 글자를 그대로 들고 있습니다(입력 중 값이 뭉개지지 않게).
 *   저장도 같은 형태로 해야 불러왔을 때 **한 글자도 다르지 않게** 복원됩니다.
 */
export interface SplitInputs {
  technique: Technique; //  어떤 기법으로 계산했는지
  symbol: string; //        종목 코드
  tpPct: string; //         익절 %
  slPct: string; //         손절 %
  qty: string; //           수량
  baseClose: string; //     전봉 종가(삼분할)
  ema200: string; //        EMA200(삼분할)
  wallPrice: string; //     매수벽 가격(호가창)
  barOpen: string; //       현재봉 시가(캔들)
  manualEntry: string; //   직접 입력 진입가(수동)
  candleYang: boolean; //   캔들: 전봉 양봉 확인 체크
  gap: number | null; //    (참고) 전봉종가 − EMA200. 저장 당시 얼마나 벌어져 있었는지
  curPrice: number | null; // (참고) 저장 당시 현재가
}

/** 저장된 삼분할 기록 한 건(종목 하나에 대한 3개 타점 묶음). */
export interface SavedSplit {
  id: string; //          고유 번호(저장 시각 밀리초 기반 — 삭제·체크의 열쇠)
  ts: string; //          저장 시각(KST, 사람이 읽는 형식)
  symbol: string; //      종목 코드
  technique: Technique; // 어떤 기법으로 뽑은 타점인지(보통 삼분할)
  levels: SavedSplitLevel[]; // 3개 타점(진입가·익절·손절·진입완료)
  tpPct: number | null; //     익절 %(참고 표시용)
  slPct: number | null; //     손절 %(참고 표시용)
  qty: number | null; //       저장 당시 계획 수량(참고 — 강제 아님)
  memo: string; //             오너 자유 메모
  /**
   * [v0.9.0] 계산기 원본 입력값(없을 수 있음).
   *   이 기능이 생기기 전에 저장된 기록에는 없습니다 → 그때는 [계산기로 불러오기]가 비활성화됩니다.
   *   (옛 기록을 잃지 않기 위해 필수가 아닌 '선택' 항목으로 둡니다)
   */
  inputs?: SplitInputs;
  /** [v0.102.0] 마지막으로 손댄 시각(ms) — 메모 수정·진입완료 체크가 다른 기기로 제대로 넘어가게 하는 기준.
   *  (ts는 "저장한 시각"이라 수정해도 안 바뀌어서, 예전엔 다른 기기가 수정본을 옛것으로 보고 무시했다.) */
  updatedAtMs?: number;
}

/**
 * buildSavedLevels — 계산 결과(CalcLevel[])를 저장용 타점(SavedSplitLevel[])으로 바꾼다.
 *   진입완료(entered)는 처음엔 전부 false(아직 안 들어감)로 시작한다. 순수 함수라 테스트가 쉽다.
 */
export function buildSavedLevels(levels: CalcLevel[]): SavedSplitLevel[] {
  return levels.map((lv) => ({ level: lv.level, entry: lv.entry, tp: lv.tp, sl: lv.sl, entered: false }));
}

/**
 * toggleSavedLevel — 특정 기록(id)의 특정 분할(level)에 대해 '진입완료' 체크를 뒤집는다.
 *   [불변성] 원본 배열을 건드리지 않고 새 배열을 돌려준다(React 상태·파일 저장 모두 안전).
 *   순수 함수 — 시간·파일 없이 로직만 검증 가능.
 */
export function toggleSavedLevel(list: SavedSplit[], id: string, level: number): SavedSplit[] {
  return list.map((rec) =>
    rec.id !== id
      ? rec
      : { ...rec, levels: rec.levels.map((lv) => (lv.level === level ? { ...lv, entered: !lv.entered } : lv)) },
  );
}

/** removeSavedSplit — 특정 기록(id) 한 건을 목록에서 뺀다(순수 함수). */
export function removeSavedSplit(list: SavedSplit[], id: string): SavedSplit[] {
  return list.filter((rec) => rec.id !== id);
}

/**
 * renameSavedSplit — 특정 기록(id)의 제목(메모)을 새 값으로 바꾼다(순수 함수).
 *   [불변성] 원본을 건드리지 않고 새 배열을 돌려준다. 앞뒤 공백은 정리한다.
 *   (제목이 곧 memo 필드다 — 저장 시 넣은 자유 이름/메모를 나중에 편집하는 것.)
 */
export function renameSavedSplit(list: SavedSplit[], id: string, memo: string): SavedSplit[] {
  return list.map((rec) => (rec.id === id ? { ...rec, memo: (memo ?? "").trim() } : rec));
}

// -----------------------------------------------------------------------------
// [v0.5.0] 체결강도(Trade Strength) 기록 — 온디맨드 시계열 샘플링
// -----------------------------------------------------------------------------
// 사용자가 [기록 시작]을 누른 종목에 대해, 켜져 있는 동안 주기적으로 체결(틱)을
// 받아 틱룰로 체결강도를 계산해 한 줄씩 저장한다(시계열). 자율 루프가 아니라
// "사람이 켠 동안만 도는" 온디맨드 도구다(카프리 원칙 유지).

/** 체결강도 시계열 한 점(파일에 저장되는 단위) */
export interface StrengthSample {
  ts: string; //             수집 시각(KST, 사람이 읽는 형식)
  tsMs: number; //           수집 시각(밀리초 — 스파크라인 정렬용)
  price: number | null; //   그 순간 마지막 체결가
  buyVol: number; //         "최근 5분 창" 안에서 매수로 분류된 체결량 누적(틱개수창 아님, 아래 참고)
  sellVol: number; //        "최근 5분 창" 안에서 매도로 분류된 체결량 누적
  strength: number | null; // (매수/매도)×100. 매도 0이면 null("매수 일방")
  // [v0.27.0] "최근 50틱"(종목 유동성마다 실제 시간폭이 들쭉날쭉) 대신 "최근 5분"(모든 종목에서
  //   동일한 시간 정의)으로 바꿔, 라이브 반응성과 매매분석 승률비교 양쪽에 다 쓸 수 있게 했다.
  //   자세한 이유는 sampleStrengthOnce 주석 참고.
  nTicks: number; //         지금 이 "최근 5분 창" 안에 있는 체결 건수(표본 크기, 신뢰도 참고)
  windowCapped: boolean; //  서버 조회 상한(50건·커서없음) 때문에 창 안 일부 체결을 놓쳤을 가능성
  session: string; //        데이/프리/본장 등(국면 표시)
}

/** 화면에 돌려주는 체결강도 상태(현재값 + 최근 시계열) */
export interface StrengthState {
  symbol: string;
  running: boolean; //       지금 기록 중인가
  intervalSec: number; //    폴링 간격(초)
  windowSec: number; //      [v0.27.0] 체결강도 계산에 쓰는 시간창 길이(초) — 지금은 고정 300(5분)
  latest: StrengthSample | null; // 가장 최근 샘플
  samples: StrengthSample[]; //     최근 시계열(오래된→최신)
  lastError: string | null; //      마지막 샘플링 오류(있으면 화면에 안내)
  signals: StrengthSignals; //      [v0.12.0] 바닥반전·정점꺾임·다이버전스·국면(정본 3장)
}

// -----------------------------------------------------------------------------
// [v0.6.0] 종목 스크리너(탐색) — 온디맨드 스캔
// -----------------------------------------------------------------------------
// 거래량 상위 종목을 훑어 "현재가>EMA200 & 현재가>이치모쿠 구름 & 장시작후 최고점 이후
// 첫 음봉 도지(+다음 봉 음봉)" 조건을 만족하는 후보를 찾는다. [스캔] 버튼으로만 돈다.

export type ScreenStatus = "confirmed" | "watch" | "none" | "insufficient";

/** 근거용 캔들 한 줄(하이킨아시 OHLC + 음/양). 시각은 KST 문자열. */
export interface EvidenceCandle {
  time: string; //  HH:mm (KST)
  open: number;
  high: number;
  low: number;
  close: number;
  bearish: boolean; // 종가<시가(음봉)
}

/** 결과 한 종목의 판정 근거(펼치면 보이는 상세). 값은 하이킨아시(기본) 기준. */
export interface ScreenEvidence {
  mode: "ha" | "normal"; //   판정에 쓴 캔들 종류(기본 ha)
  sessionStart: string; //     현재 활성 장 시작(KST)
  sessionHigh: number | null; // 세션 최고(HA 고가)
  sessionHighTime: string | null; // 그 시각
  // 기준 음봉 도지 — 몸통·위/아래 꼬리 비율까지(망치형·유성형 배제 근거)
  doji: (EvidenceCandle & { bodyRatio: number | null; upperWickPct: number | null; lowerWickPct: number | null }) | null;
  next: EvidenceCandle | null; //  도지 다음 봉
  filters: {
    priceBand: boolean; //   현재가 $1~$9
    aboveEma: boolean; //    현재가 > EMA200
    aboveCloud: boolean; //  현재가 > 구름top
    firstDoji: boolean; //   최고점 이후 첫 음봉 도지 존재
    bothWicks: boolean; //   [v0.6.3] 위·아래 꼬리 둘 다 존재(망치형·유성형 아님)
    nextBearish: boolean; // 그 다음 봉도 음봉
    recentDoji: boolean; //  [v0.25.0] 도지 발생 시점이 20분 이내(오래되면 false → 불합격)
    dojiNearHigh: boolean; // [v0.62.1] 도지가 최고점 '직후'(간격 한도 이내)에 생겼는지(한참 뒤면 false → 불합격)
  };
  gapFromHighMinutes: number | null; // [v0.62.1] 최고점 봉→도지 봉 간격(분) — 화면 근거 표시용
}

/** 스크리너 결과 한 종목 */
export interface ScreenResult {
  rank: number; //           거래량 순위
  symbol: string;
  price: number | null; //   현재가
  ema200: number | null; //  5분봉 EMA200(하이킨아시 종가 기준)
  prevClose?: number | null; // [v0.16.0] 마지막 완성 5분봉 종가(전봉종가) — 계산기 자동입력용
  cloudTop: number | null; // 이치모쿠 구름 위 경계 max(스팬A,B) (HA 기준)
  priceInBand: boolean; //   현재가 $1~$9
  aboveEma: boolean; //      현재가 > EMA200
  aboveCloud: boolean; //    현재가 > 구름top
  status: ScreenStatus; //   confirmed(🔴)/watch(🟡)/none/insufficient
  sessionHigh: number | null; // 현재 장 시작 이후 최고(HA 고가)
  proximityPct: number | null; // 현재가가 세션 고점 대비 몇 %(음수면 고점 아래)
  n1m: number; //            수집한 1분봉 수(데이터 충분성 참고)
  n5m: number; //            합성한 5분봉 수
  evidence: ScreenEvidence | null; // 판정 근거(펼침용)
  note?: string; //          데이터 부족·오류 등 사유
  /** [v0.36.0→v0.70.0] 워런트 탈락 사유 코멘트(확정/관찰 후보만 확인 — 티커 추측 방식이라
   *  100% 정확하진 않음). 있으면 이 종목은 이미 status가 "none"으로 탈락 처리된 상태다
   *  (applyWarrantGate) — 화면은 "왜 탈락했는지"를 보여주는 데 쓴다. 없으면 워런트 사유로는
   *  탈락하지 않음(확인 안 됨 포함). */
  warrantWarning?: string | null;
  /** [v0.63.0] 진입 시점 측정값(이격도·ATR%·EMA 기울기) — 필터 판정·기록·화면 표시 공용. */
  entryMetrics?: EntryMetrics;
  /** [v0.63.0] 방어 필터(이격도·기울기·변동성)에서 떨어진 사유 — 통과면 빈 배열. */
  defenseReasons?: string[];
}

/** 스캔 진행 상황(진행률 바) */
export interface ScreenProgress {
  phase: "ranking" | "scanning" | "done";
  done: number; //  처리한 종목 수
  total: number; // 전체 종목 수
  symbol: string; // 지금 처리 중인 종목
}

/** [v0.61.4] 상태 미러(capri_live_state)로 폰에 실시간 전달하는 스캔 진행률 — ScreenProgress에
 *  "지금 돌고 있는 중인지"(running)와 "언제 시작했는지"(startedAtMs, 화면이 멈춘 건지 판단용)를
 *  더한 모양. 스캔이 한 번도 안 돌았으면 null. */
export interface LiveScanProgress extends ScreenProgress {
  running: boolean;
  startedAtMs: number;
}

/** [v0.11.0] 스크리너 스캔 옵션 — 화면에서 사용자가 조절한다(전부 선택, 없으면 기본값). */
export interface ScreenOpts {
  bodyRatio?: number; // 도지 몸통비율 상한(0.1~0.8, 기본 0.3) — [v0.28.0] 0.5→0.8로 상한 확대
  count?: number; //     스캔할 거래량 상위 종목 수(10~200, 기본 60)
  priceMin?: number; //  현재가 하한($, 기본 1)
  priceMax?: number; //  현재가 상한($, 기본 9)
  // [v0.33.0 — 스크리닝 기준 탭] 전부 선택 항목. 안 주면(메뉴얼 스크리너처럼) 지금까지의
  //   고정 동작과 완전히 같은 기본값을 쓴다 — 회귀 없음.
  emaTrendEnabled?: boolean; //  "현재가 > EMA" 켜짐 여부(기본 true)
  emaPeriod?: number; //          EMA 기간(기본 200)
  cloudEnabled?: boolean; //      "현재가 > 이치모쿠 구름 상단" 켜짐 여부(기본 true)
  dojiWickMinRatio?: number; //   도지 최소 꼬리 비율(기본 WICK_MIN_RATIO=0.1)
  dojiMaxAgeEnabled?: boolean; // 도지 신선도 검사 켜짐 여부(기본 true)
  dojiMaxAgeMinutes?: number; //  도지 신선도 기준 분(기본 DOJI_MAX_AGE_MINUTES=40)
  dojiMaxGapEnabled?: boolean; // [v0.62.1] 최고점→도지 간격 검사 켜짐 여부(기본 true)
  dojiMaxGapMinutes?: number; //  [v0.62.1] 간격 상한 분(기본 30)
  emaMinGapEnabled?: boolean; //  [v0.63.0] EMA 최소 이격도(전봉종가 기준) 켜짐 여부(기본 false)
  emaMinGapPct?: number; //       [v0.63.0] 최소 이격도 %(기본 6 — 카일 제안)
  emaSlopeEnabled?: boolean; //   [v0.63.0] EMA 상승 중(1시간 전보다 높음) 조건 켜짐 여부(기본 false)
  atrFilterEnabled?: boolean; //  [v0.63.0] 변동성(ATR%) 상한 켜짐 여부(기본 false)
  atrMaxPct?: number; //          [v0.63.0] 5분봉 평균 변동폭 상한 %(기본 3)
  nextCandleConfirmEnabled?: boolean; // 도지 다음 봉 음봉 확인 켜짐 여부(기본 true) — 끄면 도지만으로 확정
  excludeEtf?: boolean; //        ETF/ETN 등 제외 여부(기본 true)
}

/** 스캔 최종 결과 */
export interface ScreenRun {
  scannedAt: string; //  스캔 시각(KST)
  total: number; //      실제 스캔한 종목 수(ETF 제외 후)
  bodyRatio: number; //  사용한 도지 몸통비율
  priceMin: number; //   [v0.11.0] 사용한 가격 하한($)
  priceMax: number; //   [v0.11.0] 사용한 가격 상한($)
  excludedEtf: number; // [v0.6.3] ETF·레버리지·인버스로 제외한 종목 수
  results: ScreenResult[]; // 후보(confirmed·watch) + 참고 목록
  // [v0.47.0 — 오너 요청 "어떤 필터가 적용됐는지 보이게"] bodyRatio/priceMin/priceMax 외
  // 나머지 스크리닝 기준(켜짐/꺼짐 스위치들)도 "이번 스캔에 실제로 쓰인 값"으로 그대로
  // echo해 둔다 — 화면(설정 탭 현재값)과는 별개로, 지나간 스캔 결과가 그때 무슨 기준으로
  // 돌았는지 항상 정확하게(나중에 설정을 바꿔도 이 스캔 기록은 안 바뀌게) 보여주기 위함.
  emaTrendEnabled: boolean;
  emaPeriod: number;
  cloudEnabled: boolean;
  dojiWickMinRatio: number;
  dojiMaxAgeEnabled: boolean;
  dojiMaxAgeMinutes: number;
  dojiMaxGapEnabled: boolean;
  dojiMaxGapMinutes: number;
  emaMinGapEnabled: boolean; // [v0.63.0]
  emaMinGapPct: number;
  emaSlopeEnabled: boolean;
  atrFilterEnabled: boolean;
  atrMaxPct: number;
  nextCandleConfirmEnabled: boolean;
  excludeEtf: boolean;
}

/** [v0.25.0] 차트 캔들 한 개(하이킨아시, 화면 표시용) */
export interface ScreenChartCandle {
  time: string; // HH:mm(KST)
  open: number;
  high: number;
  low: number;
  close: number;
}

/** [v0.25.0] 탐색 결과 종목의 차트 — 스캔 때와 '완전히 같은 계산'(HA·EMA200·구름·패턴)을 재사용해
 *   그대로 그린다(다른 계산이면 "왜 표에서 본 근거랑 차트가 다르지" 하는 혼란이 생긴다). */
export interface ScreenChart {
  symbol: string;
  candles: ScreenChartCandle[]; //  최근 구간 5분봉(HA, 완성봉만)
  ema200: number | null;
  cloudTop: number | null;
  sessionHigh: number | null;
  sessionHighTime: string | null; //  세션 최고점 시각(candles 안의 time과 매칭)
  dojiTime: string | null; //         기준 음봉 도지 시각(candles 안의 time과 매칭)
  nextTime: string | null; //         도지 다음 봉 시각
  price: number | null; //           현재가(조회 실패하면 null — 차트는 그대로 보여준다)
  patternStatus: ScreenStatus; //    참고용 패턴 판정(가격대·EMA·구름 하드게이트는 미적용, 패턴 자체만)
}

// -----------------------------------------------------------------------------
// [v0.7.0] 체결강도 자동 기록(Option A — 카프리 매매 연동)
// -----------------------------------------------------------------------------
// 카프리로 주문(→토스 체결)하므로 진입·청산 시점을 앱이 안다. 그 순간의 체결강도를
// 자동 스냅샷해 트레이드 결과와 짝지어 쌓고 분석한다. 시장데이터는 읽기 전용.

/** 진입/청산 순간의 체결강도 스냅샷(틱룰 계산 결과). */
export interface TradeSnapshot {
  strength: number | null; // (매수/매도)×100. 매도 0이면 null("매수 일방")
  buyVol: number;
  sellVol: number;
  rising: boolean | null; // (참고) 스냅샷 시점 체결강도가 상승 중이었나 — MVP에선 null(추후)
}

/** 자동 기록된 트레이드 한 건(진입 + 청산 + 결과). */
export interface StrengthTrade {
  id: string;
  symbol: string;
  mode: "mock" | "dryrun" | "real"; // 페이퍼(모의)인지 실거래인지 구분 태그
  entryTs: string; //   진입 시각(KST)
  entryPrice: number; // 진입가(주문 전송가)
  entry: TradeSnapshot | null; // 진입 순간 체결강도
  exitTs: string | null; //   청산 시각(미청산이면 null)
  exitPrice: number | null; // 청산가
  exit: TradeSnapshot | null; // 청산 순간 체결강도
  exitKind: "tp" | "sl" | "manual" | null; // 익절/손절/수동
  resultPct: number | null; // (청산가-진입가)/진입가×100
  outcome: "win" | "loss" | null; // 수익/손실
  /**
   * [v0.9.2] 청산 시각(밀리초). 기간 조회(1주일·1개월)를 연도까지 정확히 하기 위해 남긴다.
   *   기존 exitTs("MM-dd HH:mm:ss")에는 연도가 없어서 1년 전 같은 날짜와 구분되지 않는다.
   */
  exitAtMs?: number;
  /**
   * [v0.9.1] 주문 수량 — "오늘 얼마 벌었나"를 금액으로 계산하려면 필요하다.
   *   이 값이 생기기 전 기록에는 없다(그때는 리포트가 금액 대신 수익률만 보여 준다).
   */
  quantity?: number;
}

/** 트레이드 분석 요약(수익 vs 손실의 진입 시 평균 체결강도 등). */
export interface TradeStats {
  total: number;
  open: number; //   미청산
  closed: number; // 청산 완료
  wins: number;
  losses: number;
  winRate: number | null; //             승률 %(청산 기준)
  avgEntryStrengthWin: number | null; //  수익 트레이드의 진입 시 평균 체결강도
  avgEntryStrengthLoss: number | null; // 손실 트레이드의 진입 시 평균 체결강도
  avgResultPct: number | null; //         청산 트레이드 평균 결과%
}

/** 평균 도우미(값이 없으면 null). */
function avgOrNull(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((s, v) => s + v, 0) / nums.length) * 10) / 10;
}

/**
 * summarizeTrades — 트레이드 목록을 분석 요약으로(순수 함수, 테스트 용이).
 *   핵심 질문: "수익 난 트레이드는 진입 때 체결강도가 손실 트레이드보다 높았나?"
 */
export function summarizeTrades(trades: StrengthTrade[]): TradeStats {
  const closed = trades.filter((t) => t.outcome != null);
  const wins = closed.filter((t) => t.outcome === "win");
  const losses = closed.filter((t) => t.outcome === "loss");
  const entS = (arr: StrengthTrade[]) => avgOrNull(arr.map((t) => t.entry?.strength).filter((v): v is number => v != null));
  return {
    total: trades.length,
    open: trades.filter((t) => t.outcome == null).length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 1000) / 10 : null,
    avgEntryStrengthWin: entS(wins),
    avgEntryStrengthLoss: entS(losses),
    avgResultPct: avgOrNull(closed.map((t) => t.resultPct).filter((v): v is number => v != null)),
  };
}

// -----------------------------------------------------------------------------
// [v0.25.0/v0.26.0] 브라켓 주문(매수+익절+손절 한번에) 공용 타입
// -----------------------------------------------------------------------------

/** placeBracket(수동 버튼)과 자동매매가 함께 쓰는 입력 스펙. */
export interface BracketSpec {
  symbol: string;
  price: number; //     진입 지정가
  quantity: number;
  tpTrigger: number; //  익절 감시가
  tpPrice: number; //    익절 지정가
  slTrigger: number; //  손절 감시가
  slPrice: number; //    손절 지정가
  expireDate: string; // OCO(익절+손절) 만료일 YYYY-MM-DD
  watchMinutes?: number; // 체결 감시 최대 시간(기본 15분)
  pollMs?: number; // [테스트 전용] 체결 확인 주기(기본 5000ms) — 자동 테스트를 빠르게 돌리기 위한 값
  rationale?: RationaleInput;
  /** [v0.29.0] 체결 감시가 시간초과로 끝날 때 미체결(또는 부분체결 잔량) 주문을 자동으로 취소할지.
   *  기본 false(수동 버튼 경로는 기존처럼 "체결되면 직접 조건주문을 걸어주세요"로 남겨 둠 —
   *  사람이 지켜보다 판단할 여지를 유지). 자동매매 경로만 true로 켜서, 장시간 안 팔리는 주문이
   *  다음 스크리닝 후보에게 자리를 내주도록 한다(오너 요청 2026-09-25: "장시간 미체결 대책"). */
  cancelOnTimeout?: boolean;
  /** [v0.69.2] 자동매매 진입이 따르는 설정(익절%·손절%·손절 방식). 있으면 (a) 주문 전 검증 관문이 "계산된 가격 = 설정대로인가"를 대조하고
   *  (b) 체결가가 주문가와 다르면 익절/손절을 **실제 체결가 기준으로 다시 계산**해 건다(SXTC 실사고: 주문 $2.41, 체결 $2.22 → 익절 +10.4%). */
  autoPlan?: AutoPlan;
  /** [v0.69.3] 매수 주문이 토스에 접수된 **즉시**(그 뒤 어떤 처리보다 먼저) 주문번호를 알려 준다 — 호출부가 곧바로 기록해
   *  "주문은 나갔는데 번호를 못 적어 둔 채 앱이 꺼지거나 오류가 나서 주문만 토스에 남는" 틈을 없앤다. */
  onOrderCreated?: (tossOrderId: string) => void;
}

/** [v0.69.2] 자동매매의 익절/손절 설정 스냅샷. */
export interface AutoPlan {
  tpPct: number;
  slPct: number;
  slMode: "fixed" | "ema";
}

/**
 * watchAndBracket의 결과 — [v0.26.0] 자동매매가 "체결→OCO 등록"까지 실제로 됐는지, 됐다면
 *   그 조건주문 번호가 뭔지 알아야 포지션을 추적할 수 있어 void 대신 이 결과를 돌려준다.
 *   (수동 버튼 경로는 이 값을 여전히 기다리지 않는다 — placeBracket 참고.)
 */
export type WatchAndBracketResult =
  | { status: "oco_registered"; conditionalOrderId: string; tp?: number; sl?: number; fillPrice?: number | null }
  | { status: "oco_failed"; error: string }
  /** [v0.54.0 긴급 수정 — 오너 보고 "장시간 미체결 취소 시간 반영이 제대로 안 됨"]
   *  폴링 도중(아직 우리 감시 마감 전) 토스가 이미 "취소됨"/"실패"로 응답하면 여기로 온다 —
   *  킬스위치·[주문현황]에서의 직접 취소 등 **우리(타임아웃 로직) 아닌 다른 경로**로 이미
   *  끝난 걸 뒤늦게 발견한 것이다. 예전엔 이것도 아래 `cancelled_by_timeout`과 똑같이
   *  "cancelled"라는 같은 문자열로 뭉뚱그려 돌려줘서, onAutoBracketResolved가 실제로는
   *  타임아웃이 아닌 취소까지도 전부 "장시간 미체결로 자동 취소"라고 잘못 기록했다 — 오너가
   *  본 "설정한 30분이 아니라 15분 만에 취소됨"류 증상이 실은 타임아웃이 아니라 이 경로였을
   *  가능성이 크다(같은 문자열이라 기록만 봐서는 구분이 안 됐다). */
  | { status: "cancelled" | "failed" }
  | { status: "timeout" }
  /** [v0.54.0] 위와 달리, 우리 감시 마감 시각(watchMinutes)이 실제로 다 돼서 cancelOnTimeout
   *  로직이 스스로 취소를 요청했고, 토스도 그 취소를 실제로 "CANCELED"로 확인해 준 경우만
   *  이 상태를 쓴다 — "장시간 미체결로 자동 취소"라는 문구는 이제 이 경우에만 정확하다. */
  | { status: "cancelled_by_timeout" }
  /** [v0.52.0] 장시간 미체결 자동취소(cancelOnTimeout) 경로에서 취소 API 호출 자체는
   *  예외 없이 끝났지만, 그 응답이 아직 "cancelled"가 아닌 경우(막판 체결과의 경쟁 등) —
   *  "끝났다"고 믿고 감시를 놓아버리면 실제 주문은 토스에 그대로 남는데 우리 쪽 감시
   *  목록에서만 사라지는 사고가 난다(ALDX 실사례). 이 상태는 절대 포지션을 지우지
   *  않고, 다음 reconcileAutoPositions 사이클이 다시 확인하게 넘긴다. */
  | { status: "still_pending" }
  /** [v0.57.0 긴급 수정 — 오너 실사례: BGIN/SMJF 체결 후 보호주문(OCO) 등록 실패]
   *  registerOcoForFilled가 재시도하는 도중, 현재가가 이미 익절/손절 감시가를 결정적으로
   *  넘어서 있음을 발견하면(가격이 그 사이에 있어야 하는 OCO 규칙상 더 이상 등록 자체가
   *  불가능한 상황) OCO 재시도 대신 즉시 시장가로 매도해 포지션을 보호한다. 이 경우는
   *  "실패"가 아니라 실제로 포지션이 정상적으로 청산된 것이므로, 손익을 계산해 기록할 수
   *  있게 exitPrice를 함께 돌려준다. */
  | { status: "protected_by_market_sell"; exitPrice: number; quantity: number; exitPriceIsEstimate: boolean };

// -----------------------------------------------------------------------------
// [v0.26.0] 자동매매 타입
// -----------------------------------------------------------------------------

/**
 * 자동매매가 스스로 진입시킨 포지션 하나. 5분 사이클마다 이 목록을 다시 확인해서
 *   ①아직 매수 체결 대기 중인지(watching) ②매수 체결돼 OCO(익절+손절)까지 걸렸는지(active)
 *   ③OCO가 발동돼 끝났는지(closed) 판단한다("빈자리 채우기"·"중복 진입 방지"의 근거 데이터).
 */
export interface AutoPosition {
  symbol: string;
  entry: number; //   계산된 1분할 진입가(중복 진입 방지 키의 일부)
  tp: number;
  sl: number;
  quantity: number;
  enteredAtMs: number;
  status: "watching" | "active";
  /** [v0.69.2] 실제 평균 체결가(주문가 entry와 다를 수 있다). 익절/손절 기준·손익 계산에 우선 사용. */
  fillPrice?: number | null;
  /** OCO 등록 성공 후 채워짐(watching→active 전환 시). 이 번호로 발동 여부를 재조회한다. */
  conditionalOrderId: string | null;
  /** [v0.30.1] 매수(진입) 주문의 토스 주문번호 — watching 상태에서 앱이 재시작돼도(예: PC 껐다 켬,
   *  자동 업데이트) 이 번호로 실제 체결 여부를 다시 물어볼 수 있다(긴급수정, 오너 보고
   *  2026-09-26: "껐다 키거나 업데이트하면 자동매매 기록이 사라짐 — 실제 토스엔 주문이 남아있는데").
   *  이 필드가 생기기 전(v0.30.0 이전) 기록엔 없을 수 있어 optional로 둔다. */
  buyOrderId?: string | null;
  /** [v0.60.0 긴급 수정 — 오너 실사용 보고: "체결 완료된 종목이 목록에 계속 남고 취소도
   *  무반응"] reconcileAutoPositions가 이 포지션의 조건주문 상태를 반복해서 확인 못 하면
   *  (네트워크 오류가 아니라 같은 원인으로 여러 사이클 연속 실패) 여기에 이유를 남긴다 —
   *  예전엔 실패를 조용히 삼키고 다음 사이클에 재시도만 해서, 그 원인이 매 사이클 똑같이
   *  반복되는(예: 이미 존재하지 않는 조건주문 ID) 경우 화면엔 "익절/손절 등록됨"만 영원히
   *  보이고 왜 안 지워지는지 알 방법이 없었다. 성공하면 즉시 지운다(null). */
  syncWarning?: string | null;
  /** [v0.101.0] 걸려 있는 익절/손절 조건주문(OCO)이 실제로 덮고 있는 수량.
   *  quantity(= 실계좌 보유 수량)와 다를 수 있다 — 오너가 토스에서 직접 추가매수하면 보유는
   *  늘지만 기존 OCO는 등록 당시 수량만 판다(OCO 수량은 등록 순간 고정). 이 둘을 따로 들고
   *  있어야 ① 손익을 "실제로 팔린 수량"으로 계산하고 ② OCO가 끝난 뒤 남는 추가매수분을
   *  놓치지 않고 보호할 수 있다. 값이 없으면(예전 기록) quantity와 같다고 본다. */
  protectedQty?: number | null;
}

/** 자동매매 화면 현황판에 보여줄 요약. */
/**
 * [v0.69.0 긴급 — 카일 실사용 보고: "매도(익절·손절) 주문이 자동으로 안 들어가는 종목이 있어 수동으로 매도했다"]
 *   체결은 됐는데 보호주문(OCO) 등록이 실패하면(WETO: 매도 가능 수량 부족 422 / QTEX: 감시가 0 400 / AIB 등) 예전엔
 *   포지션을 추적에서 지우고 "직접 확인 필요"만 남긴 채 끝났다 — 주식은 계좌에 그대로 있는데 봇은 더 이상 쳐다보지 않았다.
 *   이제 그런 종목은 "보호 대기(unprotected)" 목록에 올라 **보호가 걸릴 때까지 봇이 계속 다시 시도**한다.
 */
export interface UnprotectedPos {
  symbol: string;
  entry: number;
  /** [v0.69.2] 실제 평균 체결가(있으면 보호 가격 계산·손익의 기준). */
  fillPrice?: number | null;
  tp: number;
  sl: number;
  quantity: number; //    등록 당시 수량(실제 복구는 항상 실계좌 보유 수량 기준)
  enteredAtMs: number;
  reason: string;
  sinceMs: number;
  attempts: number;
  lastAttemptMs: number | null;
  lastError: string | null;
  /** [v0.101.0] 이 시각(ms)까지는 가드가 새 주문(조건주문 재등록·시장가 매도)을 내지 않고
   *  "오너가 토스에서 직접 조건주문을 다시 거는지"만 지켜본다. 오너가 조건주문을 직접 취소한
   *  경우에만 채워진다(그 밖의 경로는 지금처럼 즉시 보호). 자세한 이유는 registerUnprotected 참고. */
  graceUntilMs?: number | null;
}

export interface AutoTradeStatus {
  enabled: boolean;
  /** [v0.69.0] 보호주문이 없어 봇이 복구를 시도 중인 보유 종목(없으면 빈 배열). */
  unprotected: UnprotectedPos[];
  /** [v0.69.2] 주문 전 검증 관문에서 막힌 최근 주문(최대 10건) — 화면 붉은 경고용. */
  orderBlocks: Array<{ ts: string; symbol: string; kind: string; reasons: string[] }>;
  positions: AutoPosition[];
  realizedPnlUsd: number;
  maxPositions: number;
  maxLossPct: number;
  maxInvestPct: number;
  /** [v0.42.0] 장기간 미체결 자동취소 기준(분) — 오너 요청("이 기준이 뭔지, 조절도 하고 싶다")으로
   *  하드코딩값을 화면에서 직접 보고 바꿀 수 있게 노출한다. */
  watchMinutes: number;
  lastCycleAt: string | null;
  /** [v0.27.0] 이번 사이클에서 스캔한 결과(스크리닝 결과 탭이 그대로 보여줌) — 아직 한 번도 안 돌았으면 null. */
  lastScan: ScreenRun | null;
  /** [v0.45.0] 가장 최근 스캔 실패(취소 제외) 기록 — 성공하면 즉시 지워진다. "왜 결과가 안 뜨지?"에
   *  답하려고 화면에 바로 보여준다(예전엔 저널에만 조용히 남아 오너가 원인을 볼 수 없었다). */
  lastScanError: { message: string; atMs: number } | null;
  /** [v0.48.0 — 오너 보고 "자동매매 시작해도/새로고침해도 반응 없어 보인다"] 휴무 시간대·
   *  세션 미활성처럼 "오류는 아니지만 이번 사이클엔 의도적으로 스캔을 안 했다"는 사유.
   *  이런 경우 lastScan/lastScanError는 그대로라(새로 스캔한 게 없으니) 화면이 "아무 반응
   *  없는 것처럼" 보였다 — 정상 스킵과 오류를 구분해 항상 화면에 이유를 보여주기 위한 필드.
   *  실제로 스캔이 한 번이라도 진행되면 즉시 지워진다. */
  lastCycleSkipReason: { message: string; atMs: number } | null;
  /** [v0.29.0] 다음 사이클 예정 시각(ms, epoch) — 화면의 "다음 스캔까지 N분 N초" 카운트다운용.
   *  자동매매가 꺼져 있거나 아직 한 번도 안 돌았으면 null. */
  nextCycleAtMs: number | null;
  /** [v0.35.0] "스크리닝은 확정인데 왜 안 사졌지?"에 답하는 사유 — 종목코드 → 사람이 읽을 한 줄
   *  문장. 이번 사이클에 진입을 검토했지만 안(못) 산 종목만 있고, 매 사이클 새로 채워진다. */
  skipReasons: Record<string, string>;
  /** [v0.40.0] auto 모드에서 "이번 실행" 동안 고정해 쓰는 시드 스냅샷(달러) — 투입 금액 계산의
   *  실제 기준값을 화면에서 바로 확인할 수 있게 노출한다. fixed 모드거나 아직 한 번도 계산을
   *  시도한 적 없으면(예: 자동매매를 아직 안 켰음) null. */
  seedUsdSnapshot: number | null;
}

/**
 * [v0.30.0] 자동매매 전체 생애주기 기록 — "자동매매기록" 탭용.
 *   [왜 따로 두나? autoTradePositions/getAutoTradeStatus로는 안 되나?]
 *   `autoTradePositions`는 "지금 감시 중인 것"만 담는 살아있는 목록이라 청산되는 순간
 *   배열에서 지워진다(reconcileAutoPositions). 저널(journal)에도 글로 남지만, 저널은 최근
 *   100건짜리 전체 활동 로그라 킬스위치·설정저장 같은 무관한 항목에 금방 밀려난다. 그래서
 *   "자동매매가 낸 매매만" 모아 별도 파일에 영구 보관하고, 진입→(체결확인/취소)→(청산) 상태
 *   전이마다 같은 레코드를 id로 찾아 갱신한다(새 레코드를 또 만들지 않음).
 */
export interface AutoTradeHistoryEntry {
  /** `${symbol}@${entry}@${enteredAtMs}` — 같은 사이클에 같은 값으로 재진입해도 겹치지 않는다. */
  id: string;
  symbol: string;
  entry: number;
  tp: number;
  sl: number;
  quantity: number;
  enteredAt: string; // KST 문자열(진입 접수 시각)
  status: "watching" | "active" | "closed_win" | "closed_loss" | "closed_manual" | "cancelled" | "oco_failed" | "dryrun";
  exitedAt: string | null; // KST 문자열(청산/취소 확정 시각)
  exitPrice: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  note: string; // 사람이 읽을 한 줄 요약(결과 사유)
  /** [v0.31.0] 기기 간 동기화(Supabase)로 이 기록을 받은 다른 기기가, watching/active
   *  상태를 "그냥 화면 표시용"이 아니라 실제로 이어서 감시할 수 있게 남겨 둔다(이 번호가
   *  있어야 getOrder/getConditionalOrder로 실제 체결·발동 여부를 물어볼 수 있다). */
  conditionalOrderId?: string | null;
  buyOrderId?: string | null;
  /** [v0.69.2] 실제 평균 체결가 — 주문가(entry)와 다르면 익절/손절은 이 값 기준으로 걸렸다. */
  fillPrice?: number | null;
  /** [v0.80.0 — 긴급 수정, v0.81.0에서 발생 기능 자체는 제거] 2026-10-11, "Capri가 모르는
   *  보유종목을 참고용으로만 기록"하던 기능(reflectUnknownHoldings)이 남긴 기록을
   *  auditUnprotectedHoldings가 "Capri 포지션인데 보호가 안 됐다"고 착각해 runGuard(실제
   *  매도/조건주문 등록)로 이어진 사고가 있었다(하이닉스·필옵틱스·아이온큐 등 실손실).
   *  그 기능 자체는 완전히 제거했지만(오너 지시), 혹시 비슷한 "참고용 기록" 성격의 기능이
   *  나중에 또 생기면 같은 사고가 재발하지 않도록 이 플래그와 아래 auditUnprotectedHoldings의
   *  제외 로직은 안전장치로 그대로 남겨 둔다 — true면 절대 "Capri가 산 포지션"으로 취급하지
   *  않는다. */
  reflectedOnly?: boolean;
  /** [v0.102.0] 이 기록을 마지막으로 고친 시각(ms). 기기 간 동기화에서 "같은 상태인데 내용이 다를 때"
   *  어느 쪽이 최신인지 가리는 기준이다(lib/auto-state-sync.ts mergeAutoHistory). 옛 기록엔 없다. */
  updatedAtMs?: number;
  /** [v0.45.0 — 오너 요청 "각 사용자가 어떤 기준으로 자동매매를 진행했는지도 연구 데이터에
   *  모이게"] 이 매매가 실제로 어떤 스크리닝·리스크 설정으로 진입됐는지의 스냅샷. 오너들이
   *  설정을 수시로 바꾸고(버전 이력은 안 남음) capri_group_trades는 이 기록을 그룹 전체가
   *  실명으로 함께 보므로, "이 사람은 이런 스타일(공격적 투입비율·느슨한 필터 등)로 이런
   *  성적을 냈다"를 나중에도 정확히 복기하려면 매매 시점에 찍어 함께 저장해야 한다(최신
   *  설정을 나중에 조인하면 그사이 바뀐 값으로 잘못 덮어써 보이는 문제가 생긴다). 자동매매가
   *  낸 매매만 채워진다(수동 매매는 스크리닝 조건 자체가 없어 undefined). */
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
    session: Session; // 진입 당시 세션(day/pre/regular/after)
    maxPositions: number;
    maxLossPct: number;
    maxInvestPct: number;
    /** [v0.72.0] 변동성(ATR) 연동 축소까지 반영해 실제로 이번 진입에 적용된 투입 비율(%).
     *  volScaledSizingEnabled가 꺼져 있었거나 ATR을 몰랐으면 maxInvestPct와 같다. 나중에
     *  "ATR이 높아서 실제로 덜 투입된 매매가 손절을 덜 겪었는지"를 그룹 연구탭에서 복기하려면
     *  설정값(maxInvestPct)만으론 부족하고 실제 적용값이 따로 필요해 추가했다. */
    appliedInvestPct?: number;
    watchMinutes: number;
    /** [v0.61.8] 진입 당시 선택돼 있던 타점 분할(1~2) — 연구탭에서 "몇 분할로 들어갔을 때
     *  성적이 어땠는지" 비교할 수 있게. 이 필드가 생기기 전 기록은 undefined(=당시엔 늘
     *  1분할 고정이었으므로 해석 시 1로 간주해도 된다). */
    entryLevel?: 1 | 1.5 | 2;
    // [v0.63.0] 방어 전략 설정(옛 기록엔 없음)
    emaMinGapEnabled?: boolean;
    emaMinGapPct?: number;
    emaSlopeEnabled?: boolean;
    atrFilterEnabled?: boolean;
    atrMaxPct?: number;
    slMode?: "fixed" | "ema";
    emaStopBufferPct?: number;
  };
  /** [v0.63.0 ② 측정] 진입 당시 이격도·ATR%·EMA 기울기. 나중에 "어떤 조건의 매매가 손절됐나"를 분석하는 재료. */
  entryMetrics?: EntryMetrics;
  /** [v0.63.0 ② 측정] 보유 기간 최대 역행(MAE, 음수 %)·최대 순행(MFE, 양수 %) — 청산 직후 1분봉으로 계산. */
  maePct?: number | null;
  mfePct?: number | null;
  /** [v0.63.0 ② 측정] 익절/손절 주문의 실제 평균 체결가(토스 조회)와, 목표가 대비 차이(슬리피지 %). */
  exitFillPrice?: number | null;
  slippagePct?: number | null;
}

// -----------------------------------------------------------------------------
// 엔진 본체
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// [v0.65.0] 매매연구소 화면·브리지용 타입
// -----------------------------------------------------------------------------
export interface LabStatus {
  enabled: boolean;
  rankCount: number;
  dojiBodyMaxPct: number;
  bodyMinPct: number;
  volRatioMin: number;
  minRangePct: number;
  note: string | null;
  /** [v0.67.0] 자동 검증 상태(스캔마다 로우 재계산, 1시간마다 토스 대조) */
  verify: { localAt: number | null; localOk: boolean | null; localFailed: string[]; tossAt: number | null; tossRequested: number; tossMatched: number };
  feePct: number | null;
  /** [v0.68.0] 수집 현황 — 실제로 돈 스캔 횟수·누적 활성 시간, 지금 휴무(05~17시) 중인지와 재개 시각 */
  collect: { scans: number; activeHours: number; paused: boolean; pauseReason: string | null; resumesAtMs: number | null };
  scanning: boolean;
  lastTickAtMs: number | null;
  lastTickDurMs: number | null;
  lastScanned: number;
  lastError: string | null;
  lastSkip: string | null;
  startedAtMs: number | null;
  nextTickAtMs: number | null;
  totalSignals: number;
  params: LabParams;
}
export interface LabQueryFilter {
  includeIneligible?: boolean;
  includeThin?: boolean;
  includeBackfilled?: boolean;
  session?: string;
  refKey?: string;
}
export interface LabSignalRow {
  id: string;
  symbol: string;
  rank: number;
  session: string;
  thinHours: boolean;
  backfilled: boolean;
  eligible: boolean;
  whyIneligible: "volume" | "range" | "both" | null;
  rangePct2: number | null;
  c2T: number;
  dojiT: number;
  volRatio2: number | null;
  body2: number;
  secondQualified: boolean;
  c4Block: boolean | null;
  emaGapPct: number | null;
  atrPct: number | null;
  price: number;
  linked: boolean;
  complete: boolean;
  ref: { key: string; status: string; netPct: number | null; fillPx: number | null; exitPx: number | null; note: string | null } | null;
}
export interface LabSummary {
  updatedAtMs: number;
  status: LabStatus;
  funnel: Funnel;
  linkage: LinkageSummary;
  variants: VariantRow[];
  signals: LabSignalRow[];
  refKey: string;
  counts: { total: number; eligible: number; complete: number; open: number };
}
export interface LabMirror {
  updatedAtMs: number;
  status: LabStatus;
  funnel: Funnel;
  linkage: LinkageSummary;
  topVariants: VariantRow[];
  signals: LabSignalRow[];
  counts: { total: number; eligible: number; complete: number; open: number };
  refKey: string;
  assessment?: Assessment;
}

export class ToolEngine extends EventEmitter {
  private envPath: string;
  private journalPath: string;
  private journal: JournalEntry[] = [];
  /** [v0.2.10] 매매 근거 파일 경로/메모리 캐시. 저널과 별도 파일로 두는 이유:
   *  저널은 "사람이 읽는 일지"라 100건만 화면에 쓰지만, 근거는 나중에 주문과 매칭해야 하는
   *  '데이터'라 오래 남겨야 한다. 섞으면 저널이 잘릴 때 근거까지 사라진다. */
  private rationalePath: string;
  private rationales: TradeRationale[] = [];
  /** [v0.4.0] 삼분할 타점 기록 파일 경로/메모리 캐시(여러 종목 동시 운용용). 근거와 별도 파일. */
  private splitsPath: string;
  private splits: SavedSplit[] = [];
  /** [v0.102.0] 삼분할 기록 삭제 표식 { id: 지운 시각 } — 지운 기록이 다른 기기에서 다시 살아나지 않게(lib/splits-sync.ts). 별도 파일에 보관. */
  private splitsDeleted: Tombstones = {};
  private splitsDeletedPath = "";
  /** [v0.5.0] 체결강도 시계열 파일 경로 + 종목별 시계열(메모리 캐시). */
  private strengthPath: string;
  private strengthSeries: Record<string, StrengthSample[]> = {};
  /** [v0.5.0] 현재 '기록 중'인 종목들의 타이머·연속 상태(틱룰 seed·중복제거·간격·오류). */
  private strengthRuns = new Map<
    string,
    {
      timer: ReturnType<typeof setInterval>; intervalSec: number; lastPrice?: number; lastSide: Side; seen: Set<string>; lastError: string | null;
      // [v0.22.0] 매매로 '자동 시작'된 기록만 수명을 제한한다(사용자가 직접 켠 건 손대지 않음).
      auto?: boolean; startedAtMs?: number; failCount?: number;
      // [v0.27.0] "최근 5분" 슬라이딩 시간창 버퍼 — 새로 분류된 틱을 여기 쌓고, 오래된 것은
      //   매 폴링마다 잘라낸다(sampleStrengthOnce 참고). 시각순 오름차순을 유지한다.
      buffer: WindowBufferEntry[];
    }
  >();
  private static readonly STRENGTH_MAX_SAMPLES = 500; // 종목당 보관 상한(오래된 것부터 정리)
  /** [v0.27.0] 체결강도를 계산하는 시간창 길이 — "최근 50틱"(종목마다 실제 시간폭이 들쭉날쭉) 대신
   *  고정된 시간(5분)으로 바꿔, 라이브 반응성과 매매분석 비교가능성을 동시에 만족시킨다. */
  private static readonly STRENGTH_WINDOW_MS = 5 * 60_000;
  /** [v0.22.0] 자동 기록 수명 한도: 연속 실패 N회(연결 없음) 또는 최대 시간 초과 시 스스로 끈다(무한 폴링 방지). */
  private static readonly AUTO_FAIL_STOP = 5;
  private static readonly AUTO_MAX_MS = 6 * 3_600_000; // 6시간(한 세션 충분히 커버)
  /** [v0.6.0] 스크리너 중복 실행 방지(스캔 중 또 누르면 무시). */
  private screenBusy = false;
  /** [v0.43.0] 오너가 "스크리닝 취소"를 눌렀는지 — scanScreener 루프가 다음 종목으로 넘어가기 전에
   *  이 값을 확인해 멈춘다("협조적 취소": 이미 날아간 네트워크 요청 하나는 끝까지 기다림). 수동
   *  스캔이든 자동매매 5분 사이클의 스캔이든 어차피 한 번에 하나만 돌기 때문에(screenBusy) 공용으로
   *  둬도 안전하다. */
  private screenCancelRequested = false;
  /** [v0.7.0] 체결강도 자동 기록 트레이드 저장 파일 + 메모리 캐시. */
  private tradesPath: string;
  private trades: StrengthTrade[] = [];

  private mode: "mock" | "live" = "mock";
  private killSwitch = false;
  /** [v0.2.5] 실주문 활성화 스위치. 기본 false(잠금) — 설정 탭에서 사용자가 명시적으로 켠다. */
  private liveOrdersEnabled = false;
  /**
   * [v0.2.7] 오입력 방지(현재가에서 크게 벗어난 가격 경고). **기본 꺼짐**.
   *   예전엔 ±15%가 코드에 박혀 있어 오너가 원하는 가격도 앱이 임의로 막았다.
   *   이제 기본은 "앱이 막지 않음"이고, 원할 때만 켜고 임계값도 직접 정한다.
   */
  private priceGuardEnabled = false;
  private priceGuardPct = 15; // 켰을 때 쓸 기본 제안값(사용자가 바꿀 수 있음)
  /** [v0.2.7] 주문 확인 팝업 건너뛰기(기본 false = 팝업 표시) */
  private skipOrderConfirm = false;

  // [v0.3.0] 세션별 시드 비율 — "지금 장에서 시드의 몇 %로 진입"인지.
  //   데이마켓은 크게(90%), 프리·본장은 절반(50%)이 기본. 오너가 설정에서 바꾼다.
  //   ⚠️ 이건 '제안 수량'을 계산해 보여줄 뿐, 주문을 막지 않는다(기존 원칙).
  private seedDayPct = 90; //     데이마켓 진입 비율(%)
  private seedPrePct = 50; //     프리마켓 진입 비율(%)
  private seedRegularPct = 50; // 정규장(본장) 진입 비율(%)
  // 시드 기준: "auto"=매수가능금액(예수금)을 시드로, "fixed"=오너가 정한 고정 금액을 시드로.
  private seedBasis: "auto" | "fixed" = "auto";
  private seedFixedUsd: number | null = null;
  // [v0.40.0→v0.55.0] auto 모드 전용 — "이번 자동매매 실행" 동안 아래로는 절대 안 낮아지고
  //   (지출로 잔고가 줄어도 무시), 위로만(입금 등으로 잔고가 늘면) 갱신되는 시드 스냅샷(resolveSeedUsd 참고).
  private autoTradeSeedSnapshotUsd: number | null = null;

  // [v0.8.3] 기본 손익비(익절%/손절%). 공장 초기값 2/10. 사용자가 저장하면 그 값을 계산기 초기값으로 쓴다.
  private defaultTpPct = 2;
  private defaultSlPct = 10;

  // -----------------------------------------------------------------------------
  // [v0.26.0] 자동매매(오너 결정으로 v2 "자율 봇 아님" 원칙에서 벗어난 첫 예외 — CLAUDE.md 갱신 참고)
  //   3개 한도(최대 종목 수·최대손실 한도·최대 투입 비율)는 설정 탭에서 오너가 언제든 수정 가능하고
  //   재시작해도 유지된다(persistEnv). 단 "자동매매 켜짐" 자체는 절대 저장하지 않는다 — 앱을 새로
  //   켤 때마다 오너가 다시 명시적으로 눌러야만 자동매매가 돈다(안전 우선, 아래 startAutoTrade 참고).
  // -----------------------------------------------------------------------------
  private autoTradeMaxPositions = 3; //  동시 보유 최대 종목 수(오너 기본값)
  private autoTradeMaxLossPct = 5; //    최대손실 한도(시드 대비 %) — 넘으면 자동매매 자동 중단
  private autoTradeMaxInvestPct = 30; // 종목 1개당 배정하는 시드 대비 투입 비율(%) — 종목 수로 나누지 않음
  /** [v0.61.9] "업데이트 내역" 탭을 이 기기가 마지막으로 읽은 버전 — 로컬(기기별)로만
   *  저장한다(폰에서 읽었다고 PC의 새 업데이트 팝업까지 꺼지면 안 되므로, 오너 지시
   *  "폰 PC 모두" 띄우라는 요구와 맞게 각 화면이 각자 확인). */
  private lastSeenChangelogVersion: string | null = null;
  /** [v0.61.8 — 오너 지시] 삼분할 매매기법의 몇 분할 타점을 자동매매 매수가로 쓸지(1~2).
   *  1분할(얕은 눌림, EMA200과 전봉종가 간격의 1/3 지점)이 공장값. 2분할(gap의 2/3 지점,
   *  더 깊이 눌렸을 때)을 고르면 더 보수적인(더 싸게 사려는) 진입이 된다 — 그만큼 체결
   *  자체가 덜 될 수 있다(깊은 눌림이 덜 자주 오므로). 3분할(EMA200 자체)은 선택지에서
   *  뺐다 — 삼분할 매매기법상 3분할은 "마지막 보루" 성격이라 자동 매수 대상으로 쓰기엔
   *  더 신중한 사람 판단이 필요하다는 게 오너 기존 설계 의도(자동매매는 1분할만 쓴다는
   *  원래 결정)와 결이 맞다. */
  private autoTradeEntryLevel: 1 | 1.5 | 2 = 1;
  // [v0.63.0] 방어 전략 — 매매 리스크 설정
  private autoTradeSlMode: "fixed" | "ema" = "fixed"; // ① 손절 방식: 고정 %(기존) / EMA 기준(구조적 손절)
  private autoTradeEmaStopBufferPct = 1.5; //            EMA 기준 손절일 때 EMA 아래 여유(%)
  private autoTradeReentryBlockEnabled = true; //       ⑤ 손절된 종목은 그날(KST) 재진입 금지 — 보험 성격이라 공장값 켜짐
  private autoTradeLossStreakLimit = 3; //              ⑤ 이번 실행에서 연속 손절 N회면 자동매매 자동 중지(0=끔)
  // [v0.72.0 — 오너 지시 "2번으로 진행"(ATR 상한 심화 + 변동성 연동 투입 비율)] ATR(평균 변동폭)이
  // 높은(위험한) 종목일수록 종목당 투입 비율을 자동으로 깎는다(lib/auto-risk.ts의 volScaledInvestPct).
  // v0.71.0에서 "ATR이 높을수록 손절 확률이 급격히 커진다"가 실데이터로 확인됐고, ATR 상한
  // 게이트(atrMaxPct)는 "아예 거르기"만 하므로 상한 바로 아래 구간의 위험까지 줄이려면 이 설정이
  // 추가로 필요하다는 게 오너 결론 — 보험 성격이라 공장값 켜짐.
  private autoTradeVolScaledSizingEnabled = true;
  // [v0.44.0] 오너 결정 — 매일 05:00~17:00 KST(데이마켓+애프터 구간, 토스 합성시세)는 스크리닝·
  //   수동 주문·자동매매를 전부 멈춘다. 재개는 정확히 17:00(프리마켓 시작)이다. "켜짐" 여부는
  //   다른 자동매매 토글과 달리 껐다 켜도 유지한다(안전장치라 기본 켜짐을 지키는 게 맞음).
  private systemPauseEnabled = true;
  private static readonly SYSTEM_PAUSE_START_HOUR = 5; // KST
  private static readonly SYSTEM_PAUSE_END_HOUR = 17; //  KST
  /** 직전 자동매매 사이클이 일시정지 상태였는지 — 전환(진입/해제) 시점에만 정리 작업을 하기 위해. */
  private autoTradeWasPaused = false;
  // [v0.28.0] 자동매매가 5분마다 스스로 돌리는 스크리너의 조건 — 메뉴얼 스크리너와 같은 4항목을
  //   오너가 똑같이 조절할 수 있게 한다(공장값은 메뉴얼 스크리너 기본값과 동일).
  private autoScanCount = 60; //      스캔할 거래량 상위 종목 수(10~200)
  private autoScanPriceMin = 1; //    현재가 하한($)
  private autoScanPriceMax = 9; //    현재가 상한($)
  private autoScanBodyRatio = 0.3; // 도지 몸통비율 상한(0.1~0.8)
  // [v0.33.0 — 오너 요청 "스크리닝 기준 탭"] 그동안 코드에 고정값으로 박혀 있던 나머지 필터들도
  //   전부 켜기/끄기 + 수치 조절이 가능하게 연다. 기본값은 지금까지 실제로 쓰이던 고정값과
  //   동일해서, 아무도 안 건드리면 기존 동작과 완전히 같다(회귀 없음).
  private autoScanEmaTrendEnabled = true; //  "현재가 > EMA" 추세 필터 켜짐 여부
  private autoScanEmaPeriod = 200; //         EMA 기간(50~300)
  private autoScanCloudEnabled = true; //     "현재가 > 이치모쿠 구름 상단" 추세 필터 켜짐 여부
  private autoScanDojiWickMinRatio = 0.1; //  도지 최소 꼬리 비율(위·아래 각각, 0~0.4)
  private autoScanDojiMaxAgeEnabled = true; // 도지 신선도(너무 오래된 도지 배제) 켜짐 여부
  private autoScanDojiMaxAgeMinutes = 40; //  도지가 이보다 오래되면 배제(10~180분)
  private autoScanDojiMaxGapEnabled = true; //  [v0.62.1] 최고점→도지 간격 제한 켜짐 여부
  private autoScanDojiMaxGapMinutes = 30; //   최고점 봉에서 이보다 한참 뒤에 생긴 도지는 배제(5~240분)
  // [v0.63.0] 방어 전략 — 스크리닝 필터(공장값은 전부 꺼짐: 데이터로 효과 확인 후 켜기로 오너와 합의)
  private autoScanEmaMinGapEnabled = false; // ④ EMA 최소 이격도(전봉종가 기준)
  private autoScanEmaMinGapPct = 6; //         카일 제안값
  private autoScanEmaSlopeEnabled = false; //  ④ EMA 상승 중(1시간 전보다 높음)
  private autoScanAtrFilterEnabled = false; // ③ 변동성 상한
  private autoScanAtrMaxPct = 3; //            5분봉 평균 변동폭 상한(%)
  private autoScanNextCandleConfirmEnabled = true; // 도지 다음 봉까지 음봉이어야 "확정" — 끄면 도지만으로 확정
  private autoScanExcludeEtf = true; //       ETF·ETN 등(일반 주식 아닌 것) 제외 여부
  // [v0.45.0 — 오너 요청 "매매진행할 장 선택"] 자동매매가 어느 장(세션)에서 신규 진입을 시도할지
  //   오너가 직접 고른다. 스크리닝 조건(위 8개)과 달리 "후보를 어떻게 고르나"가 아니라 "언제
  //   사도 되나"를 정하는 것이라 자동매매 사이클(autoTradeTick) 맨 앞에서 별도로 검사한다 —
  //   [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST, 스크리닝·계산기·자동매매 전부 정지)와는
  //   다른 축의 제어다: 휴무 시간대는 "이 시계 구간엔 아예 아무것도 안 한다"는 오너의 고정
  //   결정이고, 여기는 "휴무 시간대가 아닌 나머지 시간 중에서도 어떤 장(세션) 타입일 때만
  //   자동매매가 사도 되는지"를 세션 단위로 더 세밀하게 고르는 것 — 둘 다 켜져 있으면 두 조건을
  //   모두 통과해야 진입한다. 기본값은 4개 전부 켜짐(지금까지의 동작과 동일, 회귀 없음).
  private autoScanDayEnabled = true; //     데이마켓
  private autoScanPreEnabled = true; //     프리마켓
  private autoScanRegularEnabled = true; // 정규장(본장)
  private autoScanAfterEnabled = true; //   애프터마켓

  // [v0.26.0] 자동매매 켜짐 자체(스위치)는 절대 저장 안 함 — 앱을 새로 켤 때마다 오너가 직접
  //   다시 켜야 한다(오너 결정, 안전 원칙). 그러나 "지금 감시 중인 포지션"은 다르다 — [v0.30.1
  //   긴급수정] 예전엔 이것도 런타임 전용(저장 안 함)이었는데, 이게 "OCO는 토스 서버가 감시하니
  //   앱이 꺼져도 안전하다"는 전제만 믿고 "watching(매수는 됐는데 아직 OCO 못 건) 상태에서 앱이
  //   재시작되면 그 사이 체결됐어도 영원히 보호(OCO) 없이 방치된다"는 구멍과, "재시작하면
  //   maxPositions 게이트가 실제 보유 종목 수를 몰라 한도보다 더 많이 진입할 수 있다"는 두
  //   안전 구멍을 만들었다(오너가 실제로 겪음: "껐다 키거나 업데이트하면 기록이 사라짐 — 실제
  //   토스엔 주문이 남아있는데"). 이제 포지션 목록은 파일로 저장하고 재시작해도 그대로 이어받는다.
  private autoTradeEnabled = false;
  /** [v0.86.0 — 오너 지시 "자동매매 중에도 업데이트 발생 시 재시작해서 자동매매 그대로 이어가도록"]
   *  위 "마스터 스위치는 절대 저장 안 함" 원칙의 **유일한 예외**다. 일반적인 종료(오너가 직접 끄거나,
   *  그냥 앱을 닫는 경우)는 여전히 이 플래그와 무관하게 다음 실행이 항상 꺼진 채로 시작한다 —
   *  이 플래그는 main.ts가 "지금 업데이트 때문에 내가 스스로(quitAndInstall) 재시작시킨다"는
   *  그 순간에만 true로 세팅되고(prepareForUpdateRestart 참고), 다음 생성자 실행에서 딱 한 번
   *  읽혀 자동매매를 다시 켠 뒤 즉시 false로 되돌아간다(소비형 — 그 다음 재시작부터는 다시
   *  일반 원칙이 적용됨). */
  private autoResumeAfterUpdatePending = false;
  private autoTradeTimer: ReturnType<typeof setInterval> | null = null;
  private autoTradeTickBusy = false; // 한 사이클이 겹쳐 실행되지 않게
  /** [v0.61.6 — ③ 전수조사 낮음-1] 느린 네트워크에서 한 틱이 8초를 넘기면 다음 타이머와
   *  겹쳐 돌 수 있다(정확성 문제는 없음 — capri_commands의 원자적 claim이 중복 실행을 이미
   *  막는다 — 다만 쓸데없이 두 번 도는 비효율). autoTradeTickBusy와 같은 원칙으로 막는다. */
  private remoteControlTickBusy = false;
  /** [v0.45.0 버그 수정 — 오너 보고 "자동매매 시작해도 스크리닝이 간헐적으로 안 돎"]
   *  원인: startAutoTrade()가 `void this.autoTradeTick()`으로 첫 사이클을 "발사 후 신경 안 씀"으로
   *  돌리고 곧바로 반환하는데, 화면(App.tsx toggleAutoTrade)은 그 직후 곧바로 autoScanNow()(=
   *  "지금 새로고침"과 동일 함수)를 또 호출한다. 이때 방금 발사한 첫 사이클이 아직 끝나지
   *  않았으면(거의 항상 — 스캔은 네트워크 왕복이 많아 수 초~수십 초 걸림) autoScanNow()는
   *  "이미 진행 중"이라며 그 자리에서 **그냥 옛(비어 있는) 상태를 즉시 반환하고 끝나버렸다** —
   *  오너 눈에는 "새로고침을 눌러도 아무 일도 안 일어남"으로 보였다. 이 필드에 "지금 도는 사이클"의
   *  프라미스를 저장해 두면, 나중에 "이미 진행 중"을 만난 쪽이 그 프라미스가 끝날 때까지 실제로
   *  기다렸다가 **최신** 결과를 돌려줄 수 있다(runAutoTradeTick 참고). */
  private autoTradeTickPromise: Promise<void> | null = null;
  private autoTradeRealizedPnlUsd = 0; // 이번 자동매매 실행 동안 누적 실현손익(달러, 손실이면 음수)
  private autoTradePositions: AutoPosition[] = []; // 지금 자동매매로 감시·보유 중인 포지션(파일로 영속)
  /** [v0.69.0] 보호주문 없이 남은 보유 종목 — 가드가 보호가 걸리거나 팔릴 때까지 반복 시도(파일로 영속, 재시작해도 이어감). */
  private autoUnprotected: UnprotectedPos[] = [];
  /** [v0.69.4] 오너가 [보호 중단]을 눌러 "이 종목은 내가 직접 관리한다"고 한 종목 → 해제 시각(ms). 그때까지 가드·감사가 다시 올리지 않는다. */
  private guardDismissed: Record<string, number> = {};
  private guardTimer: ReturnType<typeof setTimeout> | null = null;
  private guardBusy = false;
  /** 조건주문이 토스에서 사라졌는데 실계좌엔 주식이 남은 경우(WHLR·NAUT)에도 자동으로 다시 보호할지(기본 켬). */
  private autoReprotectVanished = true;
  /** [테스트 전용] 보호 시장가 매도 재시도 간격. 실사용 기본 2초/4초/8초. */
  private marketSellRetryDelaysMs: number[] = [2000, 4000, 8000];
  private guardIntervalMs = 30_000;
  /** [v0.60.0] reconcileAutoPositions가 포지션별 조건주문 조회 연속 실패 횟수를 세는 곳
   *  (메모리만 — 재시작하면 0부터 다시 센다, 굳이 파일로 남길 값은 아니다). */
  private reconcileFailCounts: Map<string, number> = new Map();
  private autoTradeUsedKeys = new Set<string>(); // `${symbol}@${entry}` — 같은 종목 같은 타점 재진입 방지(파일로 영속)
  private autoPositionsPath = ""; // [v0.30.1] autoTradePositions/autoTradeUsedKeys 저장 파일
  /** [v0.30.1] 지금 이 프로세스 안에서 watchAndBracket이 실시간(1초~5초 간격)으로 직접 감시
   *  중인 포지션의 키(`symbol@entry@enteredAtMs`) 집합 — **저장 안 함**(런타임 전용). 이 목록에
   *  있으면 reconcileAutoPositions의 "재시작 후 복구" 경로가 같은 포지션을 이중으로 건드리지
   *  않고 건너뛴다(빠른 경로가 이미 처리 중이므로 — 안 그러면 OCO가 두 번 등록될 위험이 있다). */
  private autoTradeActiveWatches = new Set<string>();
  private autoTradeLastCycleAt: string | null = null; // 마지막 사이클 시각(KST, 화면 표시용)
  // [v0.27.0] 이번 사이클에서 스캔한 결과를 화면에 그대로 보여주기 위해 보관(엔진 안에서만 쓰이고
  //   버려지던 것을 "스크리닝 결과" 탭에 노출한다 — 오너 피드백: 사유 문자열 같은 별도 추적은
  //   불필요, lastScan만 있으면 화면(프론트)이 positions와 대조해 진입여부를 계산할 수 있다).
  private autoTradeLastScan: ScreenRun | null = null;
  /** [v0.45.0 — 오너 보고 "간헐적으로 스크리닝이 안 도는데 이유를 모르겠다"] 스캔 실패(취소 제외)가
   *  일어나면 여기 기록해 화면에 바로 보여준다. 예전엔 실패해도 저널(기본 접힘)에만 조용히
   *  남아, 오너가 "스크리닝 결과" 탭에서 그저 텅 빈 화면만 계속 보게 됐다(진짜 원인은 안 보이고
   *  "안 돈다"로만 보임). 성공하면 즉시 null로 지운다. */
  private autoTradeLastScanError: { message: string; atMs: number } | null = null;
  /** [v0.48.0] 휴무 시간대·세션 미활성처럼 "오류가 아니라 이번 사이클을 의도적으로 건너뜀"
   *  사유. lastScan/lastScanError만으로는 이런 정상 스킵이 화면에 전혀 안 보였다(오너 보고:
   *  "자동매매 시작해도/새로고침해도 반응이 없어 보인다" — 실제로는 저널에만 조용히 남던
   *  스킵 사유). 실제로 스캔이 한 번이라도 진행되면 이 필드는 즉시 지운다. */
  private autoTradeLastCycleSkipReason: { message: string; atMs: number } | null = null;
  /** [v0.32.0] "관찰 확정" 알림을 중복으로 보내지 않기 위해, 직전 스캔에서 이미 확정 상태였던
   *  종목을 기억해 둔다(재시작하면 초기화돼도 무해 — 다시 확정되면 또 한 번 알려도 문제 없음). */
  private autoScanNotifiedConfirmed = new Set<string>();
  /** [v0.72.0] 위와 같은 목적, "관찰(watch)" 상태용 — 디스코드 즉시 알림에 쓴다. */
  private autoScanNotifiedWatch = new Set<string>();
  /** [관찰종목 이력 — 오너 요청] 관찰(watch) 신호마다 언제 시작돼 어떻게 끝났는지(확정/탈락 사유/순위
   *  밖) 영속 기록. 스크리닝 결과(run.results)는 매 사이클 통째로 덮어써지지만, 이 배열은 그 사이클이
   *  지나가기 전에 "그때의 결론"을 떼어 내 영구히 보존한다(아래 scanScreener 호출부 참고). */
  private watchHistory: WatchHistoryEntry[] = [];
  private watchHistoryPath = "";
  private static readonly AUTO_TRADE_INTERVAL_MS = 5 * 60_000; // "기본적으로 5분마다"(오너 지시)
  /** [v0.29.0→v0.42.0] 자동매매 진입 주문의 체결 감시 최대 시간 — 오너 요청(2026-09-25) "장시간
   *  미체결 대책": 수동 버튼(기본 15분, 사람이 지켜보며 직접 판단)보다 짧게 잡아, 5분 사이클 기준
   *  최대 2회 안에 포기 여부가 결정되게 한다. 시간초과 시 watchAndBracket이 자동으로 취소하고
   *  (cancelOnTimeout), 빈 자리는 다음 사이클 스크리닝이 새 후보로 채운다.
   *  [v0.42.0] 오너 요청("장기간 미체결 자동 취소 기준 조절") — 하드코딩(고정 10분)이라 오너가
   *  화면에서 실제 기준값조차 볼 수 없던 문제를 고쳤다. 이제 [🤖 자동매매 → 자동매매 현황]에서
   *  직접 조회/수정 가능한 값으로 바뀌었다(기본값은 기존과 동일한 10분 — 동작 변화 없음, 가시성만 추가).*/
  private autoTradeWatchMinutes = 10;
  /** [v0.29.0] 사이클 시작 시각(ms) — 자동 스크리너 탭의 "다음 스캔까지" 카운트다운 계산용. */
  private autoTradeLastCycleAtMs: number | null = null;

  // [v0.8.1] 로그인 세션(Supabase Auth). refresh 토큰만 로컬 저장, access 는 메모리+필요시 갱신.
  private authAccessToken: string | null = null;
  private authRefreshToken: string | null = null;
  private authEmail: string | null = null;
  private authUserId: string | null = null;
  private authExpiresAtMs = 0;
  // [v0.24.0] 로그인 비밀번호 — 오직 "이번에 앱을 켠 동안"만 메모리에 들고 있는다.
  //   ⚠️ 파일에 절대 저장하지 않는다(persistEnv에도 안 씀). 이 값을 그대로
  //   토스 키·매매 이력 암호화 열쇠로 재사용해서, 사용자가 따로 외울 "동기화 비밀번호"가
  //   없어진다(로그인 비밀번호 = 잠금 비밀번호). 앱을 다시 켜면(재로그인 전까지) null이라
  //   자동 동기화가 잠시 쉬는데, 그동안도 로컬에 저장된 값으로는 그대로 동작한다.
  private authPassword: string | null = null;
  /**
   * [v0.88.0 — 오너 보고 "폰 기록이 9월까지만 있다"의 진짜 원인과 해결] 암호화 동기화(capri_trades·capri_auto_state·capri_splits)는 예전엔
   *   위 authPassword가 메모리에 있을 때만 돌았다 — 그런데 앱이 재시작되면(자동 업데이트 포함) 저장된 토큰으로만 로그인이 복원돼 비밀번호가 없다 →
   *   그때부터 PC는 **조용히 아무것도 안 올렸다**. 이제는 비밀번호에서 한 번 만든 "데이터 키"(비밀번호 자체는 여전히 저장 안 함)를 로컬에 보관해
   *   재시작해도 계속 올린다(lib/keysync.ts 참고). 키가 아직 없으면(비밀번호를 한 번도 안 넣은 PC) 화면에 "동기화 잠김"을 크게 띄운다.
   */
  private authDataKey: string | null = null;
  private cloudSyncTimer: ReturnType<typeof setInterval> | null = null;
  private cloudSyncBusy = false;
  private cloudSyncLockedWarnedAtMs = 0;
  /** 채널별 마지막 업로드 결과 — 화면의 "마지막 동기화" 표시와 실패 경고에 쓴다(조용히 넘어가지 않기). */
  private cloudSync: Record<"trades" | "autoState" | "splits", { lastOkMs: number | null; lastTryMs: number | null; lastError: string | null; lastFingerprint: string | null }> = {
    trades: { lastOkMs: null, lastTryMs: null, lastError: null, lastFingerprint: null },
    autoState: { lastOkMs: null, lastTryMs: null, lastError: null, lastFingerprint: null },
    splits: { lastOkMs: null, lastTryMs: null, lastError: null, lastFingerprint: null },
  };
  // [v0.59.0] capri_accounts.status 캐시(60초) — 승인 대기 화면이 반복 폴링해도
  //   매번 Supabase를 다시 부르지 않게 한다. 로그아웃/로그인하면 자연히 비워진다.
  private accountStatusCache: { status: "pending" | "approved" | "rejected"; atMs: number } | null = null;

  private mock: ReturnType<typeof createMockTossServer> | null = null;
  private mockPort = 0;

  // [v0.9.6] 체결내역 캐시 — 기간 버튼을 오갈 때마다 토스를 다시 부르면 요청 한도(429)에 걸린다.
  // [v0.10.1] coveredSinceMs: 이 캐시가 '어느 시각까지' 확실히 커버하는지. canDeepen: 재조회하면 더 깊이 갈 수 있는지.
  private fillsCache: { fills: Fill[]; atMs: number; partial: boolean; fetched: boolean; coveredSinceMs: number; canDeepen: boolean } | null = null;

  /** [v0.9.8] 기기에 저장해 둔 매매(체결) 이력 — 홈 PC 연결이 없어도 리포트를 그릴 수 있게 한다. */
  private savedFills: Fill[] = [];
  private fillsPath = "";
  private fillsSyncedAtMs: number | null = null;
  /** 마지막으로 확인한 보유 평균매입가 — 연결이 없을 때도 손익 계산에 쓰려고 기억해 둔다. */
  private lastAvgCost: Record<string, number> = {};
  /** 마지막으로 클라우드에 올린 시각(표시용) */
  private lastSyncPushAtMs: number | null = null;
  private lastAutoStatePushAtMs: number | null = null; // [v0.31.0] 자동매매 기록 업로드 쓰로틀용
  private lastSplitsPushAtMs: number | null = null; // [v0.61.7] 삼분할 기록 업로드 쓰로틀용
  private lastGroupPushAtMs: number | null = null; // [v0.35.0] 그룹 공유(capri_group_trades) 업로드 쓰로틀용
  /** [v0.61.0] 상태 미러(capri_live_state) 업로드 쓰로틀용 — force=true면 이 쓰로틀을 무시한다
   *  (스캔 종료·시작/중지 직후처럼 "반드시 바로" 올려야 하는 시점에 쓴다). */
  private lastLiveStatePushAtMs: number | null = null;
  private static readonly LIVE_STATE_PUSH_THROTTLE_MS = 5_000;
  /** [v0.61.4 — 오너 지시 "스크리닝시 진행되는 사항들 게이지가 차는 사항이 안 보인다"]
   *  스캔 도중(랭킹 조회~종목별 조사~완료)의 실시간 진행률 — scanScreener가 채우고, 끝나면
   *  running:false로 마감한다. 스캔이 한 번도 안 돌았으면 null(화면이 "진행 중 아님"으로 구분). */
  private scanProgressForMirror: LiveScanProgress | null = null;
  /** 위 scanProgressForMirror 업로드 전용 쓰로틀 — 종목 하나하나마다 올리면 과하므로 2초마다만. */
  private lastScanProgressPushAtMs: number | null = null;
  private static readonly SCAN_PROGRESS_PUSH_THROTTLE_MS = 2_000;
  /** [v0.56.0] "그룹 전체 실시간 동기화" — 로그인해 있는 동안 주기적으로 내 기록을 올리고
   *  그룹 전체 기록을 받아온다(버튼을 눌러야만 동작하던 걸 자동화). 로그인 안 돼 있으면
   *  절대 안 돈다(startGroupSyncLoop 참고). */
  private groupSyncTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly GROUP_SYNC_INTERVAL_MS = 3 * 60_000; // 3분마다
  /** [v0.59.0] 폰 원격 조종 — PC(데스크톱)에서만 돌아야 한다. electron/main.ts가 로그인 직후
   *  이 인스턴스에서만 명시적으로 시작한다(IPC로 노출 안 함 — 화면 코드가 실수로도 못 켠다).
   *  웹(폰) 쪽 ToolEngine 인스턴스는 이 타이머를 절대 돌리지 않는다(kyletool-adapter.ts가
   *  이 메서드를 부르지 않음) — 그래서 폰 브라우저 탭이 실수로 명령을 "실행"하는 일은
   *  구조적으로 없다(폰은 sendCommand로 "넣기"만 한다). */
  private remoteControlTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly REMOTE_CONTROL_INTERVAL_MS = 8_000; // 8초마다(Realtime 대신 폴링)
  /** [v0.71.0 — 오너 보고 "손절 종목이 계속 나온다" 조사 중 발견한 LPCN 37시간 무방비 사례]
   *  보호 감사(auditUnprotectedHoldings)가 지금까지 autoTradeTick 안에서만 돌았다 — 즉
   *  "자동매매가 켜져 있을 때만" 확인됐다. 마스터 스위치는 절대 저장 안 되므로(CLAUDE.md),
   *  앱을 새로 켤 때마다 오너가 자동매매를 다시 켜기 전까지는 이미 보유 중인 종목의
   *  조건주문(OCO)이 사라졌는지 아무도 확인하지 않았다. 실사례: 조건주문이 중간에 사라졌는데
   *  37시간 동안 아무도 못 알아채다가 보호 가드가 결국 시장가로 정리(−26.4%, 이 기록 중
   *  가장 큰 손실). PC(데스크톱)에서만, 로그인해 있는 동안은 자동매매 켜짐과 무관하게 돈다
   *  (startGroupSyncLoop·startRemoteControlLoop와 같은 패턴 — 로그인 직후 시작, 로그아웃
   *  하면 멈춤). 웹(폰) 쪽 인스턴스는 이 타이머를 절대 돌리지 않는다(remoteControlTimer와
   *  같은 이유 — 실제 토스 보유·조건주문 조회라 PC만 할 수 있음). */
  private protectionAuditTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly PROTECTION_AUDIT_INTERVAL_MS = 5 * 60_000; // 5분마다(자동매매 사이클과 같은 주기)
  /** [v0.74.0 — 오너 지시 "토스 증권과의 실시간 양방향 동기화"(task #72, "가장 중요")] 1단계:
   *  토스 앱에서 직접 조건주문을 취소하거나 체결됐을 때, 그 변화를 자동매매 현황·감시
   *  포지션에 반영하는 reconcileAutoPositionsNow()는 이미 있었다(v0.45.0) — 다만 지금까지는
   *  ① 화면에 그 탭이 열려 있는 동안만 도는 20초 자동 갱신(렌더러 쪽 타이머), ② 자동매매가
   *  켜져 있을 때만 도는 5분 사이클, 둘 중 하나로만 불렸다. 앱을 최소화해 두거나(화면 탭을
   *  안 보는 중) 자동매매를 꺼 둔 상태에서 토스 앱으로 직접 주문을 취소·체결하면, 사람이
   *  다시 그 탭을 열거나 "지금 확인"을 누르기 전까지는 반영이 안 됐다 — "실시간 반영"이라는
   *  오너 지시와 어긋나는 지점이다. reconcileAutoPositionsNow()는 이미 "보유 포지션 수만큼만
   *  조회하므로 가볍다, 더 자주 불러도 안전하다"고 문서화돼 있어(위 메서드 주석), 이 루프를
   *  위 protectionAuditTimer와 똑같은 패턴(PC 전용, 로그인해 있는 동안 자동매매 켜짐과 무관)
   *  으로 추가한다 — 이제 화면을 안 보고 있어도, 자동매매가 꺼져 있어도 백그라운드에서
   *  계속 최신 상태를 유지한다. */
  private positionSyncTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POSITION_SYNC_INTERVAL_MS = 20_000; // 20초마다(기존 화면 자동 갱신과 같은 주기)
  /** [v0.35.0] "스크리닝은 확정인데 왜 안 사졌지?"를 화면에서 바로 보이게 — 사이클마다 다시 채움
   *  (지난 사이클 이유가 이번 사이클에도 그대로 남아 헷갈리는 일이 없도록 매번 초기화). */
  private autoTradeSkipReasons: Record<string, string> = {};

  // 환율 캐시(토스 스펙: 1분 갱신이므로 60초 캐시)
  private fxCache: { rate: number; atMs: number; source: "toss" | "manual" } | null = null;
  private buyingPowerUsd: number | null = null;

  /** [v0.30.0] "자동매매기록" 탭용 영구 로그 — 생성자에서 로드, 상태 전이마다 파일로 저장. */
  private autoTradeHistoryPath = "";
  private autoTradeHistory: AutoTradeHistoryEntry[] = [];
  private static readonly AUTO_TRADE_HISTORY_MAX = 500; // 오래된 것부터 정리(무한 증식 방지)

  /** [v0.62.1] 자동매매 "실행(run)" 기록 — 켬→끔 한 번마다 한 건. 리포트(lib/auto-report.ts)의 원본. */
  private autoRunsPath = "";
  private autoRuns: AutoRunRecord[] = [];
  private currentAutoRun: AutoRunRecord | null = null;
  private currentAutoRunNetBase = { timeouts: 0, failures: 0, retries: 0 }; // 이 실행 시작 시점의 전역 오류 카운터
  private static readonly AUTO_RUNS_MAX = 30;

  /**
   * [v0.60.9] 이 엔진(PC)이 실제로 실행 중인 앱 버전 — electron/main.ts가 생성 시점에
   *   app.getVersion()을 넘겨준다. 폰이 "PC가 진짜 최신 버전을 돌리고 있나"를 하트비트로
   *   직접 확인할 수 있게 하는 용도(아래 remoteControlTick 참고) — 오너 실사용 보고
   *   ("폰에서 시작을 눌러도 자동 스크리너가 안 뜬다")의 진짜 원인이 "자동매매가 켜져
   *   있어 PC가 몇 시간째 재시작(=업데이트 적용) 못 하고 옛 코드를 그대로 돌리고 있었다"
   *   였던 걸 뒤늦게 SQL로 확인했다 — 다음부터는 이 값으로 바로 알 수 있게 한다.
   */
  private appVersion: string | null = null;

  constructor(
    private userDataDir: string,
    opts?: { forceMock?: boolean; appVersion?: string },
  ) {
    super();
    this.appVersion = opts?.appVersion ?? null;
    mkdirSync(userDataDir, { recursive: true });
    this.envPath = join(userDataDir, ".env");
    this.journalPath = join(userDataDir, "kylebot-journal.json");
    this.rationalePath = join(userDataDir, "kylebot-rationale.json");
    this.splitsPath = join(userDataDir, "kylebot-splits.json"); // [v0.4.0] 삼분할 기록 파일
    this.splitsDeletedPath = join(userDataDir, "kylebot-splits-deleted.json"); // [v0.102.0] 삼분할 삭제 표식 파일
    this.strengthPath = join(userDataDir, "kylebot-strength.json"); // [v0.5.0] 체결강도 시계열
    this.tradesPath = join(userDataDir, "kylebot-trades.json"); // [v0.7.0] 자동 기록 트레이드
    this.fillsPath = join(userDataDir, "kylebot-fills.json"); // [v0.9.8] 매매(체결) 이력 — 연결 없이도 리포트를 그리기 위해 보관
    this.autoTradeHistoryPath = join(userDataDir, "kylebot-auto-history.json"); // [v0.30.0] 자동매매기록
    this.autoPositionsPath = join(userDataDir, "kylebot-auto-positions.json"); // [v0.30.1] 감시 중 포지션(긴급수정)
    this.autoRunsPath = join(userDataDir, "kylebot-auto-runs.json"); // [v0.62.1] 자동매매 실행 기록(리포트 원본)
    this.labPath = join(userDataDir, "kylebot-lab.json"); // [v0.65.0] 매매연구소 신호 로우
    this.watchHistoryPath = join(userDataDir, "kylebot-watch-history.json"); // [관찰종목 이력]
    this.loadEnv();
    // [v0.68.1] 거래량 순위 기본값이 60→120으로 바뀌었는데, 이미 저장돼 있던 값(옛 기본값 60)은 그대로 남아 오너 화면의 수집이 계속 느렸다.
    //   "옛 기본값 그대로(60)"인 경우에만 한 번 120으로 올리고 화면에 알린다(직접 다른 값으로 바꾼 사람은 건드리지 않음).
    if (process.env.LAB_RANK_MIGRATED !== "1") {
      if (this.labRankCount === 60) {
        this.labRankCount = 120;
        this.labNote = "거래량 순위를 옛 기본값 60위에서 120위로 한 번 넓혔습니다(수집 속도를 높이기 위해). 원하지 않으면 [신호기록 현황]에서 다시 바꾸세요.";
      }
      this.labRankMigrated = true;
      this.persistEnv();
    }
    // [개발 검증용] E2E 등 자동 검증은 절대 실서버를 건드리면 안 되므로 연습 모드 강제.
    if (opts?.forceMock) this.mode = "mock";
    // [v0.45.0] 테스트 엔진은 시스템 휴무 시간대(05:00~17:00 KST) 기능을 항상 꺼진 채로
    //   시작한다(loadEnv가 복원한 값이 있어도 덮어씀) — 이 기능은 실제 벽시계 시각(DateTime.now())
    //   을 보는데, 테스트는 하루 중 언제 돌지 알 수 없다(예: 마침 낮 12시에 테스트를 돌리면 이
    //   기능 때문에 무관한 테스트까지 전부 막혀버린다). [주의] process.env는 같은 테스트 프로세스의
    //   여러 테스트 파일이 공유해(persistEnv가 process.env[k]=v로 전역에 씀), "저장된 값이 있으면
    //   보존"처럼 조건을 걸면 다른 테스트가 먼저 저장한 값이 새어 들어와 무의미해진다 — 그래서
    //   무조건 끈다. 실제 앱(forceMock 없이 생성)은 이 줄과 무관하게 항상 기본 켜짐을 유지한다.
    //   이 기능의 "저장이 재시작해도 유지되는지"는 tests/system-pause.test.ts가 .env 파일 내용을
    //   직접 읽어 검증한다(새 엔진의 getSettings()로는 검증할 수 없음 — 매번 강제로 꺼지므로).
    if (opts?.forceMock) this.systemPauseEnabled = false;
    // [v0.86.0] 위 systemPauseEnabled와 같은 이유로(process.env 테스트 간 오염 방지) 테스트
    //   엔진은 이 플래그도 무조건 끈 채로 시작한다 — 안 그러면 "일반 종료인 척 꾸민" 다른
    //   테스트가 먼저 persistEnv()로 true를 process.env에 남겨 놓으면, 전혀 무관한 다음
    //   forceMock 테스트가 자기도 모르게 자동매매를 자동으로 시작시킬 수 있다.
    if (opts?.forceMock) this.autoResumeAfterUpdatePending = false;
    // [v0.86.0] 생성자가 끝나는 시점의 "진짜" 값을 process.env에도 즉시 되돌려 놓는다(파일에
    //   아직 한 번도 안 써진 상태라도) — 위 두 줄(loadEnv 복원 → forceMock 덮어쓰기)을 전부
    //   거친 뒤의 값이라, 이 한 줄만으로 "이 엔진 인스턴스가 사라진 뒤에도 process.env에
    //   낡은 값이 남아 다음 엔진(같은 테스트 프로세스 안의 또 다른 생성)을 오염시키는" 경로를
    //   원천 차단한다. persistEnv()가 실제로 호출되는지와 무관하게 항상 최신 상태를 보장한다.
    process.env.AUTO_RESUME_AFTER_UPDATE = this.autoResumeAfterUpdatePending ? "true" : "false";
    this.loadJournal();
    this.loadRationales();
    this.loadSplits();
    this.loadStrength();
    this.loadTrades();
    this.loadFills(); // [v0.9.8] 저장해 둔 매매 이력
    this.loadAutoTradeHistory(); // [v0.30.0] 자동매매기록
    this.loadAutoPositions(); // [v0.30.1] 감시 중 포지션(긴급수정 — 재시작해도 이어받기)
    this.loadAutoRuns(); // [v0.62.1] 자동매매 실행 기록
    this.loadLab(); // [v0.65.0] 매매연구소 신호 로우
    this.loadWatchHistory(); // [관찰종목 이력]
    // [v0.69.0] 재시작 전에 보호 못 받던 종목이 남아 있으면 30초 뒤부터 가드가 이어서 처리한다.
    if (this.autoUnprotected.length > 0 && !opts?.forceMock) this.scheduleGuard(30_000);
    // 신호 기록 모드는 주문을 내지 않는 읽기 전용이라 켜 둔 상태를 재시작해도 유지한다(테스트용 forceMock은 자동 시작 안 함).
    if (this.labEnabled && !opts?.forceMock) this.startLabTimer();
    // [v0.86.0] 업데이트로 인한 재시작이면 자동매매를 그대로 이어서 켠다(소비형 — 한 번 쓰면 꺼짐).
    //   startAutoTrade()는 v0.30.1부터 "감시 중이던 포지션을 이어받는" 경로라 재시작 복구와 이미
    //   궁합이 맞는다(이 함수를 새로 만들지 않고 그대로 재사용).
    if (this.autoResumeAfterUpdatePending && !opts?.forceMock) {
      this.autoResumeAfterUpdatePending = false;
      this.persistEnv();
      this.startAutoTrade();
    }
  }

  // --------------------------------------------------------------------------
  // [v0.90.0 — 오너 긴급 보고 "사용 중에 클릭 무반응일 때가 있다"] 디바운스 파일 저장.
  //   원인: 이 엔진은 journal·rationale·splits·체결강도 시계열·trades·autoRuns·lab·
  //   autoTradeHistory·autoPositions·fills — 총 10군데에서 상태가 바뀔 때마다 그 전체를
  //   JSON으로 직렬화해 writeFileSync로 "즉시·동기" 저장했다. 그중에서도 체결강도
  //   (persistStrength)는 **종목을 감시하는 내내 10~60초마다 계속** 불린다(startStrength가
  //   매매 진입 시 자동으로 켜짐 — recordEntry 참고) — 즉 포지션을 들고 있거나 체결강도를
  //   보는 동안은 거의 쉬지 않고 동기 쓰기가 반복된다는 뜻이라, "사용 중 가끔 멈춘다"는
  //   증상과 정확히 들어맞는다. Electron 메인 프로세스는 싱글 스레드라, 이 동기 디스크
  //   쓰기가 도는 그 짧은 순간 IPC(버튼 클릭 포함) 전부가 응답을 못 해 "클릭해도 반응
  //   없음"처럼 보인다 — 저널이 1000건 가까이 쌓여 있으면 매번 그 전체를 다시 쓰는 셈이라
  //   체감될 만큼 길어질 수 있다.
  //   이 10가지는 전부 참고용 로그·기록이라 디스크 반영이 수백ms 늦어도 문제없다(실제
  //   안전에 쓰이는 메모리 상태는 호출 즉시 이미 반영되고, 보유 종목 보호는 토스 서버의
  //   조건주문이 하므로 이 파일 저장과 무관하다). 그래서 **같은 파일로의 저장 요청이 짧은
  //   시간 안에 몰리면 하나로 묶고(디바운스), 쓰기 자체도 비동기로** 돌려 메인 프로세스를
  //   절대 막지 않는다. 단, 업데이트 재시작·앱 종료처럼 "이제 곧 프로세스가 죽는다"가
  //   확실한 순간에는 flushAllFileSavesSync()로 디바운스 중인 것까지 전부 동기로 확정
  //   짓는다(그 직전 기록이 반영 안 된 채 사라지면 안 되므로 — prepareForRestart·main.ts의
  //   before-quit에서 호출).
  //   ⚠️ 설정 파일(persistEnv)과 재시작 표식(restartMarkerPath)은 그대로 동기 유지 —
  //   둘 다 작고 드물게만 쓰여 애초에 블로킹 원인이 아니었고, 재시작 표식은 "지금 이 줄에서
  //   바로 디스크에 남아야" 의미가 있어 디바운스하면 안 된다.
  // --------------------------------------------------------------------------
  private pendingSaves = new Map<string, { path: string; data: () => unknown; timer: ReturnType<typeof setTimeout> | null; dirty: boolean }>();

  private scheduleFileSave(key: string, path: string, data: () => unknown): void {
    let st = this.pendingSaves.get(key);
    if (!st) {
      st = { path, data, timer: null, dirty: false };
      this.pendingSaves.set(key, st);
    } else {
      st.path = path;
      st.data = data; // 다음 flush 때 "그 시점의 최신" 데이터를 쓰게 getter만 갱신
    }
    st.dirty = true;
    if (st.timer) return; // 이미 예약돼 있으면 그대로 둔다(곧 최신 데이터로 저장됨)
    st.timer = setTimeout(() => {
      st!.timer = null;
      void this.flushFileSave(key);
    }, 300);
    (st.timer as unknown as { unref?: () => void }).unref?.(); // 이 타이머가 앱 종료를 붙잡지 않게
  }

  private async flushFileSave(key: string): Promise<void> {
    const st = this.pendingSaves.get(key);
    if (!st || !st.dirty) return;
    st.dirty = false;
    try {
      const tmp = st.path + ".tmp";
      await writeFileAsync(tmp, JSON.stringify(st.data()), "utf8");
      await renameAsync(tmp, st.path);
    } catch {
      /* 저장만 건너뛴다 — 메모리 상태는 이미 최신이라 동작엔 지장 없음 */
    }
  }

  /** [재시작·종료 직전 전용] 디바운스 중인 저장을 전부 지금 당장(동기) 확정 짓는다. */
  flushAllFileSavesSync(): void {
    for (const st of this.pendingSaves.values()) {
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      if (!st.dirty) continue;
      st.dirty = false;
      try {
        const tmp = st.path + ".tmp";
        writeFileSync(tmp, JSON.stringify(st.data()), "utf8");
        renameSync(tmp, st.path);
      } catch {
        /* 무시 — 종료 직전이라 재시도 기회가 없음, 메모리 상태는 이미 최신 */
      }
    }
  }

  // --------------------------------------------------------------------------
  // 설정/모드 (v1과 동일한 규칙: 키가 있어야 실서버, 아니면 연습)
  // --------------------------------------------------------------------------
  private loadEnv(): void {
    if (existsSync(this.envPath)) {
      for (const [k, v] of Object.entries(parseEnv(readFileSync(this.envPath, "utf8")))) process.env[k] = v;
    }
    // [이중 안전] 구버전(0.2.0)이 저장해둔 틀린 주소(apigw)가 .env에 남아 있을 수 있다.
    //   prepareBackend가 실서버 요청 직전에 openapi로 덮어쓰지만, 여기서도 선제 교정해
    //   혹시 모를 경로로 낡은 주소가 새어나가지 않게 한다.
    if (process.env.TOSS_BASE_URL && /apigw\.tossinvest\.com/i.test(process.env.TOSS_BASE_URL)) {
      process.env.TOSS_BASE_URL = ToolEngine.LIVE_BASE_URL;
    }
    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    this.mode = process.env.TOSS_MOCK !== "true" && hasKeys ? "live" : "mock";

    // [v0.3.0] 저장돼 있던 토글·시드 설정을 되살린다(앱 껐다 켜도 유지).
    //   ⚠️ 특히 LIVE_ORDERS: 예전엔 저장을 안 해서 앱 켤 때마다 실주문이 꺼졌다(오너 불편 1위).
    if (process.env.LIVE_ORDERS === "true") this.liveOrdersEnabled = true;
    if (process.env.PRICE_GUARD === "true") this.priceGuardEnabled = true;
    const pg = Number(process.env.PRICE_GUARD_PCT);
    if (Number.isFinite(pg) && pg > 0) this.priceGuardPct = pg;
    if (process.env.SKIP_CONFIRM === "true") this.skipOrderConfirm = true;
    const day = Number(process.env.SEED_DAY_PCT);
    if (Number.isFinite(day) && day >= 0) this.seedDayPct = day;
    const pre = Number(process.env.SEED_PRE_PCT);
    if (Number.isFinite(pre) && pre >= 0) this.seedPrePct = pre;
    const reg = Number(process.env.SEED_REGULAR_PCT);
    if (Number.isFinite(reg) && reg >= 0) this.seedRegularPct = reg;
    if (process.env.SEED_BASIS === "fixed") this.seedBasis = "fixed";
    const sf = Number(process.env.SEED_FIXED_USD);
    if (Number.isFinite(sf) && sf > 0) this.seedFixedUsd = sf;
    // [v0.8.3] 저장된 기본 손익비 복원(있으면 공장값 2/10 대신 사용).
    const dtp = Number(process.env.DEFAULT_TP_PCT);
    if (Number.isFinite(dtp) && dtp > 0) this.defaultTpPct = dtp;
    const dsl = Number(process.env.DEFAULT_SL_PCT);
    if (Number.isFinite(dsl) && dsl > 0) this.defaultSlPct = dsl;
    // [v0.26.0] 저장된 자동매매 한도 복원(3개 전부 오너가 수정 가능). "켜짐" 자체는 저장 안 함.
    const amp = Number(process.env.AUTO_MAX_POSITIONS);
    if (Number.isFinite(amp) && amp > 0) this.autoTradeMaxPositions = Math.round(amp);
    const alp = Number(process.env.AUTO_MAX_LOSS_PCT);
    if (Number.isFinite(alp) && alp > 0) this.autoTradeMaxLossPct = alp;
    const aip = Number(process.env.AUTO_MAX_INVEST_PCT);
    if (Number.isFinite(aip) && aip > 0) this.autoTradeMaxInvestPct = aip;
    // [v0.42.0] 저장된 미체결 자동취소 기준(분) 복원.
    const awm = Number(process.env.AUTO_WATCH_MINUTES);
    if (Number.isFinite(awm) && awm > 0) this.autoTradeWatchMinutes = Math.round(awm);
    // [v0.61.8] 저장된 진입 타점 분할(1~2) 복원.
    const ael = Number(process.env.AUTO_ENTRY_LEVEL);
    if (ael === 1 || ael === 1.5 || ael === 2) this.autoTradeEntryLevel = ael;
    // [v0.86.0] 업데이트로 인한 재시작이면("일반 종료"는 저장 자체가 안 되므로 해당 없음) 복원.
    if (process.env.AUTO_RESUME_AFTER_UPDATE === "true") this.autoResumeAfterUpdatePending = true;
    // [v0.65.0] 매매연구소 설정 복원
    if (process.env.LAB_ENABLED === "true") this.labEnabled = true;
    const lrc = Number(process.env.LAB_RANK_COUNT);
    if (Number.isFinite(lrc) && lrc >= 10) this.labRankCount = Math.min(200, Math.round(lrc));
    const ldb = Number(process.env.LAB_DOJI_BODY_MAX);
    if (Number.isFinite(ldb) && ldb > 0) this.labDojiBodyMax = ldb;
    const lbm = Number(process.env.LAB_BODY_MIN);
    if (Number.isFinite(lbm) && lbm > 0) this.labBodyMin = lbm;
    const lvm = Number(process.env.LAB_VOL_MIN);
    if (Number.isFinite(lvm) && lvm > 0) this.labVolMin = lvm;
    const lmr = Number(process.env.LAB_MIN_RANGE_PCT);
    if (process.env.LAB_MIN_RANGE_PCT !== undefined && process.env.LAB_MIN_RANGE_PCT !== "" && Number.isFinite(lmr) && lmr >= 0) this.labMinRangePct = lmr;
    // [v0.63.0] 방어 전략 설정 복원
    if (process.env.AUTO_SL_MODE === "ema" || process.env.AUTO_SL_MODE === "fixed") this.autoTradeSlMode = process.env.AUTO_SL_MODE;
    const aesb = Number(process.env.AUTO_EMA_STOP_BUFFER_PCT);
    if (Number.isFinite(aesb) && aesb >= 0) this.autoTradeEmaStopBufferPct = aesb;
    if (process.env.AUTO_REENTRY_BLOCK_ENABLED === "false") this.autoTradeReentryBlockEnabled = false;
    else if (process.env.AUTO_REENTRY_BLOCK_ENABLED === "true") this.autoTradeReentryBlockEnabled = true;
    if (process.env.AUTO_VOL_SCALED_SIZING_ENABLED === "false") this.autoTradeVolScaledSizingEnabled = false;
    else if (process.env.AUTO_VOL_SCALED_SIZING_ENABLED === "true") this.autoTradeVolScaledSizingEnabled = true;
    if (process.env.AUTO_REPROTECT_VANISHED === "false") this.autoReprotectVanished = false;
    else if (process.env.AUTO_REPROTECT_VANISHED === "true") this.autoReprotectVanished = true;
    const alsl = Number(process.env.AUTO_LOSS_STREAK_LIMIT);
    if (process.env.AUTO_LOSS_STREAK_LIMIT && Number.isFinite(alsl) && alsl >= 0) this.autoTradeLossStreakLimit = Math.round(alsl);
    // [v0.61.9] 마지막으로 읽은 업데이트 내역 버전 복원(이 기기 전용 — 재시작해도 팝업 중복 안 뜨게).
    if (process.env.LAST_SEEN_CHANGELOG) this.lastSeenChangelogVersion = process.env.LAST_SEEN_CHANGELOG;
    // [v0.44.0] 저장된 시스템 휴무 시간대 기능 켜짐 여부 복원(기본 켜짐 — 명시적으로 껐을 때만 꺼짐).
    if (process.env.SYSTEM_PAUSE_ENABLED === "false") this.systemPauseEnabled = false;
    // [v0.28.0] 저장된 자동매매 스크리너 조건 복원(4개 전부 오너가 수정 가능).
    const asc = Number(process.env.AUTO_SCAN_COUNT);
    if (Number.isFinite(asc) && asc > 0) this.autoScanCount = Math.round(asc);
    const aspMin = Number(process.env.AUTO_SCAN_PRICE_MIN);
    if (Number.isFinite(aspMin) && aspMin >= 0) this.autoScanPriceMin = aspMin;
    const aspMax = Number(process.env.AUTO_SCAN_PRICE_MAX);
    if (Number.isFinite(aspMax) && aspMax >= 0) this.autoScanPriceMax = aspMax;
    const asbr = Number(process.env.AUTO_SCAN_BODY_RATIO);
    if (Number.isFinite(asbr) && asbr > 0) this.autoScanBodyRatio = asbr;
    // [v0.33.0] 나머지 스크리닝 조건(켜짐/꺼짐 + 수치) 복원 — 전부 기본값이 true/기존 고정값이라,
    //   저장된 적 없으면(신규 설치·이전 버전에서 올라온 설정) 지금까지와 동일하게 동작한다.
    if (process.env.AUTO_SCAN_EMA_ENABLED === "false") this.autoScanEmaTrendEnabled = false;
    else if (process.env.AUTO_SCAN_EMA_ENABLED === "true") this.autoScanEmaTrendEnabled = true;
    const asep = Number(process.env.AUTO_SCAN_EMA_PERIOD);
    if (Number.isFinite(asep) && asep > 0) this.autoScanEmaPeriod = Math.round(asep);
    if (process.env.AUTO_SCAN_CLOUD_ENABLED === "false") this.autoScanCloudEnabled = false;
    else if (process.env.AUTO_SCAN_CLOUD_ENABLED === "true") this.autoScanCloudEnabled = true;
    const aswr = Number(process.env.AUTO_SCAN_DOJI_WICK_MIN_RATIO);
    if (Number.isFinite(aswr) && aswr >= 0) this.autoScanDojiWickMinRatio = aswr;
    if (process.env.AUTO_SCAN_DOJI_MAX_AGE_ENABLED === "false") this.autoScanDojiMaxAgeEnabled = false;
    else if (process.env.AUTO_SCAN_DOJI_MAX_AGE_ENABLED === "true") this.autoScanDojiMaxAgeEnabled = true;
    const asdma = Number(process.env.AUTO_SCAN_DOJI_MAX_AGE_MINUTES);
    if (Number.isFinite(asdma) && asdma > 0) this.autoScanDojiMaxAgeMinutes = Math.round(asdma);
    if (process.env.AUTO_SCAN_DOJI_MAX_GAP_ENABLED === "false") this.autoScanDojiMaxGapEnabled = false;
    else if (process.env.AUTO_SCAN_DOJI_MAX_GAP_ENABLED === "true") this.autoScanDojiMaxGapEnabled = true;
    const asdmg = Number(process.env.AUTO_SCAN_DOJI_MAX_GAP_MINUTES);
    if (Number.isFinite(asdmg) && asdmg > 0) this.autoScanDojiMaxGapMinutes = Math.round(asdmg);
    if (process.env.AUTO_SCAN_EMA_MIN_GAP_ENABLED === "true") this.autoScanEmaMinGapEnabled = true;
    else if (process.env.AUTO_SCAN_EMA_MIN_GAP_ENABLED === "false") this.autoScanEmaMinGapEnabled = false;
    const asemg = Number(process.env.AUTO_SCAN_EMA_MIN_GAP_PCT);
    if (Number.isFinite(asemg) && asemg > 0) this.autoScanEmaMinGapPct = asemg;
    if (process.env.AUTO_SCAN_EMA_SLOPE_ENABLED === "true") this.autoScanEmaSlopeEnabled = true;
    else if (process.env.AUTO_SCAN_EMA_SLOPE_ENABLED === "false") this.autoScanEmaSlopeEnabled = false;
    if (process.env.AUTO_SCAN_ATR_FILTER_ENABLED === "true") this.autoScanAtrFilterEnabled = true;
    else if (process.env.AUTO_SCAN_ATR_FILTER_ENABLED === "false") this.autoScanAtrFilterEnabled = false;
    const asam = Number(process.env.AUTO_SCAN_ATR_MAX_PCT);
    if (Number.isFinite(asam) && asam > 0) this.autoScanAtrMaxPct = asam;
    if (process.env.AUTO_SCAN_NEXT_CANDLE_CONFIRM_ENABLED === "false") this.autoScanNextCandleConfirmEnabled = false;
    else if (process.env.AUTO_SCAN_NEXT_CANDLE_CONFIRM_ENABLED === "true") this.autoScanNextCandleConfirmEnabled = true;
    if (process.env.AUTO_SCAN_EXCLUDE_ETF === "false") this.autoScanExcludeEtf = false;
    else if (process.env.AUTO_SCAN_EXCLUDE_ETF === "true") this.autoScanExcludeEtf = true;
    // [v0.45.0] 저장된 "매매진행할 장" 선택 복원(4개 전부 오너가 수정 가능).
    if (process.env.AUTO_SCAN_DAY_ENABLED === "false") this.autoScanDayEnabled = false;
    else if (process.env.AUTO_SCAN_DAY_ENABLED === "true") this.autoScanDayEnabled = true;
    if (process.env.AUTO_SCAN_PRE_ENABLED === "false") this.autoScanPreEnabled = false;
    else if (process.env.AUTO_SCAN_PRE_ENABLED === "true") this.autoScanPreEnabled = true;
    if (process.env.AUTO_SCAN_REGULAR_ENABLED === "false") this.autoScanRegularEnabled = false;
    else if (process.env.AUTO_SCAN_REGULAR_ENABLED === "true") this.autoScanRegularEnabled = true;
    if (process.env.AUTO_SCAN_AFTER_ENABLED === "false") this.autoScanAfterEnabled = false;
    else if (process.env.AUTO_SCAN_AFTER_ENABLED === "true") this.autoScanAfterEnabled = true;
    // [v0.8.1] 저장된 로그인 세션 복원(리프레시 토큰만). access token 은 필요 시 갱신한다.
    if (process.env.CAPRI_AUTH_REFRESH) this.authRefreshToken = process.env.CAPRI_AUTH_REFRESH;
    if (process.env.CAPRI_AUTH_EMAIL) this.authEmail = process.env.CAPRI_AUTH_EMAIL;
    if (process.env.CAPRI_DATA_KEY) this.authDataKey = process.env.CAPRI_DATA_KEY; // [v0.88.0] 비밀번호 대신 데이터 키만 보관(재시작해도 동기화 유지)
  }

  getSettings() {
    return {
      mode: this.mode,
      hasClientId: !!process.env.TOSS_CLIENT_ID,
      hasClientSecret: !!process.env.TOSS_CLIENT_SECRET,
      account: process.env.TOSS_ACCOUNT ?? "",
      liveOrdersEnabled: this.liveOrdersEnabled, // 실주문 활성화 여부(설정 탭 토글 상태)
      priceGuardEnabled: this.priceGuardEnabled,
      priceGuardPct: this.priceGuardPct,
      skipOrderConfirm: this.skipOrderConfirm,
      // [v0.3.0] 세션별 시드 비율 + 시드 기준
      seedDayPct: this.seedDayPct,
      seedPrePct: this.seedPrePct,
      seedRegularPct: this.seedRegularPct,
      seedBasis: this.seedBasis,
      seedFixedUsd: this.seedFixedUsd,
      // [v0.8.3] 기본 손익비
      defaultTpPct: this.defaultTpPct,
      defaultSlPct: this.defaultSlPct,
      // [v0.26.0] 자동매매 한도(3개, 전부 수정 가능) + 켜짐 여부(런타임 전용)
      autoTradeMaxPositions: this.autoTradeMaxPositions,
      autoTradeMaxLossPct: this.autoTradeMaxLossPct,
      autoTradeMaxInvestPct: this.autoTradeMaxInvestPct,
      autoTradeWatchMinutes: this.autoTradeWatchMinutes, // [v0.42.0] 장기간 미체결 자동취소 기준(분)
      autoTradeEntryLevel: this.autoTradeEntryLevel, // [v0.61.8] 진입 타점 분할(1~2)
      autoTradeSlMode: this.autoTradeSlMode, // [v0.63.0] 방어 전략
      autoTradeEmaStopBufferPct: this.autoTradeEmaStopBufferPct,
      autoTradeReentryBlockEnabled: this.autoTradeReentryBlockEnabled,
      autoTradeVolScaledSizingEnabled: this.autoTradeVolScaledSizingEnabled, // [v0.72.0] ATR 연동 투입 비율 축소
      autoTradeLossStreakLimit: this.autoTradeLossStreakLimit,
      autoTradeReprotectVanished: this.autoReprotectVanished, // [v0.69.0]
      autoTradeEnabled: this.autoTradeEnabled,
      systemPauseEnabled: this.systemPauseEnabled, // [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST) 기능
      // [v0.28.0] 자동매매 스크리너 조건(4개)
      autoScanCount: this.autoScanCount,
      autoScanPriceMin: this.autoScanPriceMin,
      autoScanPriceMax: this.autoScanPriceMax,
      autoScanBodyRatio: this.autoScanBodyRatio,
      // [v0.33.0] 스크리닝 기준 탭 — 나머지 조건도 전부 켜짐/꺼짐 + 수치 노출
      autoScanEmaTrendEnabled: this.autoScanEmaTrendEnabled,
      autoScanEmaPeriod: this.autoScanEmaPeriod,
      autoScanCloudEnabled: this.autoScanCloudEnabled,
      autoScanDojiWickMinRatio: this.autoScanDojiWickMinRatio,
      autoScanDojiMaxAgeEnabled: this.autoScanDojiMaxAgeEnabled,
      autoScanDojiMaxAgeMinutes: this.autoScanDojiMaxAgeMinutes,
      autoScanDojiMaxGapEnabled: this.autoScanDojiMaxGapEnabled,
      autoScanDojiMaxGapMinutes: this.autoScanDojiMaxGapMinutes,
      autoScanEmaMinGapEnabled: this.autoScanEmaMinGapEnabled, // [v0.63.0]
      autoScanEmaMinGapPct: this.autoScanEmaMinGapPct,
      autoScanEmaSlopeEnabled: this.autoScanEmaSlopeEnabled,
      autoScanAtrFilterEnabled: this.autoScanAtrFilterEnabled,
      autoScanAtrMaxPct: this.autoScanAtrMaxPct,
      autoScanNextCandleConfirmEnabled: this.autoScanNextCandleConfirmEnabled,
      autoScanExcludeEtf: this.autoScanExcludeEtf,
      // [v0.45.0] "매매진행할 장" 선택
      autoScanDayEnabled: this.autoScanDayEnabled,
      autoScanPreEnabled: this.autoScanPreEnabled,
      autoScanRegularEnabled: this.autoScanRegularEnabled,
      autoScanAfterEnabled: this.autoScanAfterEnabled,
    };
  }

  /**
   * [v0.8.3] 기본 손익비(익절%/손절%) 저장. 계산기 초기값으로 쓰인다.
   *   0 이하·비정상 값은 무시(공장값/이전값 유지). 저장 후 최신 설정을 돌려준다.
   */
  saveDefaultRatio(input: { tpPct?: number; slPct?: number }) {
    if (typeof input.tpPct === "number" && Number.isFinite(input.tpPct) && input.tpPct > 0) this.defaultTpPct = input.tpPct;
    if (typeof input.slPct === "number" && Number.isFinite(input.slPct) && input.slPct > 0) this.defaultSlPct = input.slPct;
    this.persistEnv();
    this.addJournal({ kind: "info", symbol: "-", summary: `기본 손익비 저장 — 익절 ${this.defaultTpPct}% / 손절 ${this.defaultSlPct}%` });
    return this.getSettings();
  }

  /**
   * [v0.26.0] 자동매매 한도 3개(최대 종목 수·최대손실 한도·최대 투입 비율) 저장.
   *   0 이하·비정상 값은 무시(이전값 유지). "켜짐" 여부는 여기서 다루지 않는다(startAutoTrade 참고).
   */
  saveAutoTradeSettings(input: {
    maxPositions?: number;
    maxLossPct?: number;
    maxInvestPct?: number;
    watchMinutes?: number; // [v0.42.0] 장기간 미체결 자동취소 기준(분) — 여기서 함께 저장
    entryLevel?: 1 | 1.5 | 2; // [v0.61.8] 진입 타점 분할(1~2) — 여기서 함께 저장
    slMode?: "fixed" | "ema"; // [v0.63.0] 방어 전략
    emaStopBufferPct?: number;
    reentryBlockEnabled?: boolean;
    volScaledSizingEnabled?: boolean; // [v0.72.0] ATR 연동 투입 비율 축소
    lossStreakLimit?: number;
    reprotectVanished?: boolean; // [v0.69.0] 보호주문이 사라진 보유 종목 자동 재보호
  }) {
    if (typeof input.reprotectVanished === "boolean") this.autoReprotectVanished = input.reprotectVanished;
    if (input.slMode === "fixed" || input.slMode === "ema") this.autoTradeSlMode = input.slMode;
    if (typeof input.emaStopBufferPct === "number" && Number.isFinite(input.emaStopBufferPct) && input.emaStopBufferPct >= 0) {
      this.autoTradeEmaStopBufferPct = Math.min(10, input.emaStopBufferPct); // 0~10%
    }
    if (typeof input.reentryBlockEnabled === "boolean") this.autoTradeReentryBlockEnabled = input.reentryBlockEnabled;
    if (typeof input.volScaledSizingEnabled === "boolean") this.autoTradeVolScaledSizingEnabled = input.volScaledSizingEnabled;
    if (typeof input.lossStreakLimit === "number" && Number.isFinite(input.lossStreakLimit) && input.lossStreakLimit >= 0) {
      this.autoTradeLossStreakLimit = Math.round(Math.min(10, input.lossStreakLimit)); // 0(끔)~10
    }
    if (typeof input.maxPositions === "number" && Number.isFinite(input.maxPositions) && input.maxPositions > 0) {
      this.autoTradeMaxPositions = Math.round(input.maxPositions);
    }
    if (typeof input.maxLossPct === "number" && Number.isFinite(input.maxLossPct) && input.maxLossPct > 0) {
      this.autoTradeMaxLossPct = input.maxLossPct;
    }
    if (typeof input.maxInvestPct === "number" && Number.isFinite(input.maxInvestPct) && input.maxInvestPct > 0) {
      this.autoTradeMaxInvestPct = input.maxInvestPct;
    }
    if (typeof input.watchMinutes === "number" && Number.isFinite(input.watchMinutes) && input.watchMinutes > 0) {
      // 1~60분으로 보정(0이나 음수, 비정상적으로 큰 값 방지 — 5분 사이클 감안 시 60분 넘으면 사실상
      // "자동 취소 안 함"과 다를 바 없어 의미가 퇴색된다).
      this.autoTradeWatchMinutes = Math.round(Math.min(60, Math.max(1, input.watchMinutes)));
    }
    if (input.entryLevel === 1 || input.entryLevel === 1.5 || input.entryLevel === 2) {
      this.autoTradeEntryLevel = input.entryLevel;
    }
    this.persistEnv();
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary:
        `자동매매 한도 저장 — 최대 ${this.autoTradeMaxPositions}종목 · 최대손실 시드대비 ${this.autoTradeMaxLossPct}% · ` +
        `총 투입한도 시드대비 ${this.autoTradeMaxInvestPct}% · 미체결 자동취소 ${this.autoTradeWatchMinutes}분 · ` +
        `진입 타점 ${this.autoTradeEntryLevel}분할 · ` +
        `손절 방식 ${this.autoTradeSlMode === "ema" ? `EMA 기준(EMA 아래 ${this.autoTradeEmaStopBufferPct}%)` : "고정 %"} · ` +
        `손절 종목 당일 재진입 금지 ${this.autoTradeReentryBlockEnabled ? "ON" : "OFF"} · ` +
        `연속 손절 자동중지 ${this.autoTradeLossStreakLimit > 0 ? `${this.autoTradeLossStreakLimit}회` : "OFF"} · ` +
        `변동성(ATR) 연동 투입 비율 축소 ${this.autoTradeVolScaledSizingEnabled ? "ON" : "OFF"}`,
    });
    return this.getSettings();
  }

  /**
   * [v0.44.0] 시스템 휴무 시간대(매일 05:00~17:00 KST) 기능을 켜고 끈다. 시간대 자체(05/17시)는
   *   오너가 명시적으로 정한 값이라 이번 버전에서는 고정값 — 껐다/켰다만 오너가 조절한다.
   */
  saveSystemPauseEnabled(enabled: boolean) {
    this.systemPauseEnabled = enabled;
    this.persistEnv();
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: `⏸ 시스템 휴무 시간대(05:00~17:00 KST) 기능을 ${enabled ? "켰습니다" : "껐습니다"}.`,
    });
    return this.getSettings();
  }

  /**
   * [v0.44.0] 지금 "시스템 휴무 시간대(또는 휴장)"인지, 왜인지, 언제 재개되는지 한 번에 알려준다.
   *   화면 배너·주문 차단 안내 문구가 공용으로 쓴다.
   *
   * [판정 순서]
   *   ① 오늘 KST 05:00~17:00(고정) 안이면 — "지정된 휴무 시간대"로 즉시 확정(제일 흔한 경우).
   *   ② 그 시간대 밖인데도 lib/session.ts의 getMarketStatus가 "closed"라고 하면 — 주말·미국
   *      공휴일이다(평소엔 이 바깥 구간은 항상 프리/정규/애프터 중 하나라 "closed"가 안 나온다 —
   *      세션 표의 유일한 "장 시간 아님" 갭(08:50~09:00)도 이미 ①의 05~17 구간 안에 있다). 오너가
   *      요청한 "휴장일 전면 중지"는 이 경로로 자동으로 이미 커버된다 — 별도 한국/미국 휴장일
   *      캘린더를 새로 만들 필요가 없다(카프리는 한국 증시가 아니라 토스를 통한 미국 증시를
   *      거래하므로, "장이 실제로 열리는가"는 전적으로 이미 구현된 미국 증시 달력이 결정한다).
   */
  getSystemPauseStatus(): { paused: boolean; reason: string | null; resumesAtMs: number | null } {
    if (!this.systemPauseEnabled) return { paused: false, reason: null, resumesAtMs: null };
    const now = DateTime.now().setZone("Asia/Seoul");

    if (isInDailyPauseWindow(now, ToolEngine.SYSTEM_PAUSE_START_HOUR, ToolEngine.SYSTEM_PAUSE_END_HOUR)) {
      // 정의상 지금은 항상 [시작시, 종료시) 사이이므로(자정을 넘지 않는 고정값), 재개는 항상 "오늘
      // 종료시각"이다.
      const resumesAt = now.set({ hour: ToolEngine.SYSTEM_PAUSE_END_HOUR, minute: 0, second: 0, millisecond: 0 });
      return {
        paused: true,
        reason: `지정된 휴무 시간대(05:00~17:00 KST) — 토스 데이마켓 합성시세 구간을 피하려는 오너 설정`,
        resumesAtMs: resumesAt.toMillis(),
      };
    }

    const market = getMarketStatus(now);
    if (market.session === "closed" && market.closedReason) {
      return {
        paused: true,
        reason: `휴장 — ${market.closedReason}`,
        resumesAtMs: market.nextOpen ? market.nextOpen.toMillis() : null,
      };
    }
    return { paused: false, reason: null, resumesAtMs: null };
  }

  /**
   * [v0.44.0] 신규 진입 주문·스크리닝처럼 "휴무 시간대엔 하면 안 되는 행동" 앞에서 공용으로 부른다.
   *   막혀 있으면 오너가 이해할 수 있는 이유+재개 시각과 함께 예외를 던진다.
   */
  private assertNotSystemPaused(action: string): void {
    const st = this.getSystemPauseStatus();
    if (!st.paused) return;
    const resume = st.resumesAtMs != null ? DateTime.fromMillis(st.resumesAtMs).setZone("Asia/Seoul").toFormat("MM-dd HH:mm") : "미정";
    throw new Error(`${st.reason} — 지금은 ${action}을(를) 할 수 없습니다(재개 예정: ${resume}).`);
  }

  /**
   * [v0.28.0] 자동매매가 5분마다 스스로 돌리는 스크리너의 조건 4개(스캔 종목수·가격 하한/상한·
   *   도지 몸통비율 상한) 저장. 메뉴얼 스크리너와 같은 항목이지만 별도로 저장한다 — 자동매매는
   *   사람이 매번 값을 넣어주는 메뉴얼 스크리너와 달리 무인으로 반복 실행되므로, 오너가 "자동매매용"
   *   조건을 따로 정해 두고 화면(메뉴얼 스크리너)의 즉흥적인 값 변경에 영향받지 않게 하기 위함.
   *   0 이하·비정상 값은 무시(이전값 유지). bodyRatio는 0.1~0.8로 보정.
   */
  saveAutoScanSettings(input: {
    count?: number;
    priceMin?: number;
    priceMax?: number;
    bodyRatio?: number;
    // [v0.33.0] 스크리닝 기준 탭에서 새로 추가된 항목들 — 전부 선택(안 보내면 이전값 유지).
    emaTrendEnabled?: boolean;
    emaPeriod?: number;
    cloudEnabled?: boolean;
    dojiWickMinRatio?: number;
    dojiMaxAgeEnabled?: boolean;
    dojiMaxAgeMinutes?: number;
    dojiMaxGapEnabled?: boolean;
    dojiMaxGapMinutes?: number;
    emaMinGapEnabled?: boolean; // [v0.63.0]
    emaMinGapPct?: number;
    emaSlopeEnabled?: boolean;
    atrFilterEnabled?: boolean;
    atrMaxPct?: number;
    nextCandleConfirmEnabled?: boolean;
    excludeEtf?: boolean;
    // [v0.45.0] "매매진행할 장" 선택 — 전부 선택(안 보내면 이전값 유지).
    dayEnabled?: boolean;
    preEnabled?: boolean;
    regularEnabled?: boolean;
    afterEnabled?: boolean;
  }) {
    if (typeof input.count === "number" && Number.isFinite(input.count) && input.count > 0) {
      this.autoScanCount = Math.round(Math.min(200, Math.max(10, input.count)));
    }
    if (typeof input.priceMin === "number" && Number.isFinite(input.priceMin) && input.priceMin >= 0) {
      this.autoScanPriceMin = input.priceMin;
    }
    if (typeof input.priceMax === "number" && Number.isFinite(input.priceMax) && input.priceMax >= 0) {
      this.autoScanPriceMax = input.priceMax;
    }
    if (typeof input.bodyRatio === "number" && Number.isFinite(input.bodyRatio) && input.bodyRatio > 0) {
      this.autoScanBodyRatio = Math.min(0.8, Math.max(0.1, input.bodyRatio));
    }
    if (typeof input.emaTrendEnabled === "boolean") this.autoScanEmaTrendEnabled = input.emaTrendEnabled;
    if (typeof input.emaPeriod === "number" && Number.isFinite(input.emaPeriod) && input.emaPeriod > 0) {
      this.autoScanEmaPeriod = Math.round(Math.min(300, Math.max(50, input.emaPeriod)));
    }
    if (typeof input.cloudEnabled === "boolean") this.autoScanCloudEnabled = input.cloudEnabled;
    if (typeof input.dojiWickMinRatio === "number" && Number.isFinite(input.dojiWickMinRatio) && input.dojiWickMinRatio >= 0) {
      this.autoScanDojiWickMinRatio = Math.min(0.4, Math.max(0, input.dojiWickMinRatio));
    }
    if (typeof input.dojiMaxAgeEnabled === "boolean") this.autoScanDojiMaxAgeEnabled = input.dojiMaxAgeEnabled;
    if (typeof input.dojiMaxAgeMinutes === "number" && Number.isFinite(input.dojiMaxAgeMinutes) && input.dojiMaxAgeMinutes > 0) {
      this.autoScanDojiMaxAgeMinutes = Math.round(Math.min(180, Math.max(10, input.dojiMaxAgeMinutes)));
    }
    if (typeof input.dojiMaxGapEnabled === "boolean") this.autoScanDojiMaxGapEnabled = input.dojiMaxGapEnabled;
    if (typeof input.dojiMaxGapMinutes === "number" && Number.isFinite(input.dojiMaxGapMinutes) && input.dojiMaxGapMinutes > 0) {
      this.autoScanDojiMaxGapMinutes = Math.round(Math.min(240, Math.max(5, input.dojiMaxGapMinutes)));
    }
    if (typeof input.emaMinGapEnabled === "boolean") this.autoScanEmaMinGapEnabled = input.emaMinGapEnabled;
    if (typeof input.emaMinGapPct === "number" && Number.isFinite(input.emaMinGapPct) && input.emaMinGapPct > 0) {
      this.autoScanEmaMinGapPct = Math.round(Math.min(50, Math.max(0.5, input.emaMinGapPct)) * 10) / 10; // 0.5~50%
    }
    if (typeof input.emaSlopeEnabled === "boolean") this.autoScanEmaSlopeEnabled = input.emaSlopeEnabled;
    if (typeof input.atrFilterEnabled === "boolean") this.autoScanAtrFilterEnabled = input.atrFilterEnabled;
    if (typeof input.atrMaxPct === "number" && Number.isFinite(input.atrMaxPct) && input.atrMaxPct > 0) {
      this.autoScanAtrMaxPct = Math.round(Math.min(20, Math.max(0.5, input.atrMaxPct)) * 10) / 10; // 0.5~20%
    }
    if (typeof input.nextCandleConfirmEnabled === "boolean") this.autoScanNextCandleConfirmEnabled = input.nextCandleConfirmEnabled;
    if (typeof input.excludeEtf === "boolean") this.autoScanExcludeEtf = input.excludeEtf;
    if (typeof input.dayEnabled === "boolean") this.autoScanDayEnabled = input.dayEnabled;
    if (typeof input.preEnabled === "boolean") this.autoScanPreEnabled = input.preEnabled;
    if (typeof input.regularEnabled === "boolean") this.autoScanRegularEnabled = input.regularEnabled;
    if (typeof input.afterEnabled === "boolean") this.autoScanAfterEnabled = input.afterEnabled;
    this.persistEnv();
    const sessionsOn = [
      this.autoScanDayEnabled && "데이",
      this.autoScanPreEnabled && "프리",
      this.autoScanRegularEnabled && "본장",
      this.autoScanAfterEnabled && "애프터",
    ].filter(Boolean).join("·") || "없음(!)";
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary:
        `자동매매 스크리너 조건 저장 — 종목수 ${this.autoScanCount} · 가격 $${this.autoScanPriceMin}~$${this.autoScanPriceMax} · ` +
        `도지 몸통상한 ${Math.round(this.autoScanBodyRatio * 100)}% · EMA${this.autoScanEmaPeriod} ${this.autoScanEmaTrendEnabled ? "ON" : "OFF"} · ` +
        `구름 ${this.autoScanCloudEnabled ? "ON" : "OFF"} · 꼬리비율 ${Math.round(this.autoScanDojiWickMinRatio * 100)}% · ` +
        `신선도 ${this.autoScanDojiMaxAgeEnabled ? `${this.autoScanDojiMaxAgeMinutes}분` : "OFF"} · ` +
        `고점~도지 간격 ${this.autoScanDojiMaxGapEnabled ? `${this.autoScanDojiMaxGapMinutes}분` : "OFF"} · ` +
        `EMA 이격도 ${this.autoScanEmaMinGapEnabled ? `≥${this.autoScanEmaMinGapPct}%` : "OFF"} · ` +
        `EMA 상승 ${this.autoScanEmaSlopeEnabled ? "ON" : "OFF"} · ` +
        `변동성 상한 ${this.autoScanAtrFilterEnabled ? `≤${this.autoScanAtrMaxPct}%` : "OFF"} · ` +
        `다음봉확인 ${this.autoScanNextCandleConfirmEnabled ? "ON" : "OFF"} · ETF제외 ${this.autoScanExcludeEtf ? "ON" : "OFF"} · ` +
        `매매 진행할 장: ${sessionsOn}`,
    });
    return this.getSettings();
  }

  /** [v0.33.0] 지금 저장된 "스크리닝 기준" 전부를 scanScreener에 넘길 옵션 객체로 묶는다 —
   *  autoScanNow·autoTradeTick 두 호출부가 항목을 하나씩 나열하다 서로 어긋나는 사고를 막는다. */
  private buildAutoScanOpts(): ScreenOpts {
    return {
      count: this.autoScanCount,
      priceMin: this.autoScanPriceMin,
      priceMax: this.autoScanPriceMax,
      bodyRatio: this.autoScanBodyRatio,
      emaTrendEnabled: this.autoScanEmaTrendEnabled,
      emaPeriod: this.autoScanEmaPeriod,
      cloudEnabled: this.autoScanCloudEnabled,
      dojiWickMinRatio: this.autoScanDojiWickMinRatio,
      dojiMaxAgeEnabled: this.autoScanDojiMaxAgeEnabled,
      dojiMaxAgeMinutes: this.autoScanDojiMaxAgeMinutes,
      dojiMaxGapEnabled: this.autoScanDojiMaxGapEnabled,
      dojiMaxGapMinutes: this.autoScanDojiMaxGapMinutes,
      emaMinGapEnabled: this.autoScanEmaMinGapEnabled,
      emaMinGapPct: this.autoScanEmaMinGapPct,
      emaSlopeEnabled: this.autoScanEmaSlopeEnabled,
      atrFilterEnabled: this.autoScanAtrFilterEnabled,
      atrMaxPct: this.autoScanAtrMaxPct,
      nextCandleConfirmEnabled: this.autoScanNextCandleConfirmEnabled,
      excludeEtf: this.autoScanExcludeEtf,
    };
  }

  /**
   * [v0.28.0→v0.39.0 오너 지시로 동작 변경] 자동매매 스크리너 수동 새로고침 — 5분 주기를
   *   기다리지 않고 지금 바로 다시 훑어 "스크리닝 결과"/"자동 스크리너" 탭을 갱신한다.
   *   [v0.28.0 원안의 문제] 예전엔 여기서 스캔만 하고 진입 시도는 절대 안 했다(모니터링·
   *   미리보기 전용) — 그런데 그러다 보니 "지금 새로고침"으로 갓 나타난 확정 종목엔
   *   `autoTradeSkipReasons`가 아예 채워질 기회가 없어(그건 오직 실제 `autoTradeTick` 안에서만
   *   채워짐), 화면엔 "아직 이유가 안 잡혔습니다" 같은 임시 문구만 계속 떴다. 게다가 "다음 자동
   *   스캔까지" 카운트다운도 이 수동 새로고침과 무관하게 옛 일정 그대로 흘러가, 오너가 방금
   *   확인한 화면과 실제 돌아가는 사이클이 서로 안 맞았다.
   *   [수정] 자동매매가 켜져 있으면 이제 여기서 실제 사이클(`autoTradeTick`)을 그대로 한 번
   *   호출한다 — 스캔은 물론 진입 시도·`skipReasons`까지 전부 실제 로직 그대로 돌고, "다음
   *   자동 스캔까지" 타이머도 이 수동 새로고침이 끝난 시점 기준으로 5분 뒤로 다시 맞춘다(5분
   *   주기 자체는 그대로 유지 — 타이머를 없애는 게 아니라 기준 시각만 지금으로 당김). 마침
   *   다른 사이클이 이미 진행 중이면 새로 겹쳐 돌리지 않되, **그 사이클이 끝날 때까지 기다렸다가**
   *   최신 결과를 돌려준다(자동매매가 꺼져 있을 때는 예전 그대로 "켜면 뭐가 나올지" 미리보기만
   *   한다 — 진입 게이트가 애초에 "자동매매가 꺼져 있습니다"로 막으므로 진입 시도 자체가 의미 없음).
   *
   *   [v0.45.0 버그 수정 — 오너 보고 "자동매매 시작을 눌러도 스크리닝이 진행 안 함"]
   *   startAutoTrade()가 시작하자마자 이 함수와 똑같은 일(스캔+진입 시도)을 하는 첫 사이클을
   *   이미 발사해 둔 상태에서, 화면이 곧바로 이 함수를 또 부른다(오너가 "시작"을 누르면 자동
   *   스크리너 탭도 바로 도는 것처럼 보여주려고). 예전엔 이때 "이미 진행 중"이라며 **그 자리에서
   *   즉시** 옛(텅 빈) 상태를 돌려주고 끝나버려, 오너 눈에는 "눌러도 아무 일도 안 일어남"으로
   *   보였다(거의 항상 이 순서로 겹침 — 실제로는 "간헐적"이 아니라 "거의 매번"에 가까웠다).
   *   이제는 진행 중인 사이클의 완료를 실제로 기다린 뒤 그 결과를 돌려준다.
   */
  async autoScanNow(): Promise<AutoTradeStatus> {
    if (this.autoTradeEnabled) {
      if (this.autoTradeTickBusy) {
        this.addJournal({ kind: "info", symbol: "-", summary: "🤖 자동매매: 마침 사이클이 진행 중이라 끝나는 대로 최신 결과를 보여드립니다." });
        if (this.autoTradeTickPromise) await this.autoTradeTickPromise;
      } else {
        await this.autoTradeTick(true); // 스캔+진입 시도+skipReasons까지 실제 사이클과 완전히 동일(수동 새로고침 — forceScan)
        if (this.autoTradeTimer) {
          // 5분 주기 자체는 유지하되, 기준 시각을 이 수동 새로고침이 끝난 지금으로 다시 맞춘다.
          clearInterval(this.autoTradeTimer);
          this.autoTradeTimer = setInterval(() => this.runAutoTradeTick(), ToolEngine.AUTO_TRADE_INTERVAL_MS);
        }
      }
      return this.getAutoTradeStatus();
    }
    try {
      await this.prepareBackend();
      const run = await this.scanScreener(this.buildAutoScanOpts());
      this.autoTradeLastScan = run;
      this.autoTradeLastScanError = null; // [v0.45.0]
      const cand = run.results.filter((r) => r.status === "confirmed" || r.status === "watch").length;
      this.addJournal({ kind: "info", symbol: "-", summary: `🤖 자동매매 스크리너 수동 새로고침(미리보기) — 후보 ${cand}개` });
    } catch (e) {
      // [v0.43.0] 오너가 취소 버튼을 눌러 멈춘 경우는 "실패"가 아니다 — 문구를 구분한다.
      const msg = String(e).replace(/^Error:\s*/, "");
      const isCancel = msg.includes("취소");
      if (!isCancel) this.autoTradeLastScanError = { message: msg, atMs: Date.now() }; // [v0.45.0]
      this.addJournal({
        kind: "info",
        symbol: "-",
        summary: isCancel ? "🤖 자동매매 스크리너 수동 새로고침을 오너가 직접 취소했습니다." : `🤖 자동매매 스크리너 수동 새로고침 실패 — ${msg}`,
      });
    }
    // [v0.61.4 긴급수정 — 오너 SQL 직접 조회로 확인된 버그] 자동매매가 꺼진 상태의 "미리보기"
    //   스캔은 autoTradeTick()을 거치지 않아 그 finally의 pushLiveState 호출을 못 탄다 —
    //   여기서 직접 저장(재시작 생존)+업로드(폰 반영)하지 않으면, 폰에서 "지금 새로고침"을
    //   몇 번을 눌러도 PC 화면에만 보이고 클라우드로 올라간 적이 없었다.
    this.saveAutoPositions();
    void this.pushLiveState(true);
    return this.getAutoTradeStatus();
  }

  /**
   * [v0.3.0] 모든 설정을 .env 파일에 한 번에 다시 쓴다(단일 저장 경로).
   *   비밀값(키·계좌)은 process.env에 이미 있으므로 그대로 유지된다.
   *   [왜 한 곳으로?] 예전엔 saveSettings만 파일을 썼고 토글은 메모리에만 있어, 앱을 끄면
   *   실주문 활성화·오입력방지·시드설정이 전부 초기화됐다. 이제 어떤 설정을 바꾸든 이 함수를
   *   호출해 파일에 남긴다.
   */
  private persistEnv(): void {
    const lines = [
      "# Capri 매매도구 설정(자동 생성). 이 파일은 본인 컴퓨터에만 있습니다.",
      `TOSS_MOCK=${this.mode === "mock" ? "true" : "false"}`,
      `TOSS_BASE_URL=${this.mode === "live" ? ToolEngine.LIVE_BASE_URL : ""}`,
      `TOSS_CLIENT_ID=${process.env.TOSS_CLIENT_ID ?? ""}`,
      `TOSS_CLIENT_SECRET=${process.env.TOSS_CLIENT_SECRET ?? ""}`,
      `TOSS_ACCOUNT=${process.env.TOSS_ACCOUNT ?? ""}`,
      "DRY_RUN=true", // ★ 코드 레벨 잠금 표식(실주문은 아래 LIVE_ORDERS 토글로만 해금)
      // --- 토글 상태(앱 재시작 후에도 유지) ---
      `LIVE_ORDERS=${this.liveOrdersEnabled ? "true" : "false"}`,
      `PRICE_GUARD=${this.priceGuardEnabled ? "true" : "false"}`,
      `PRICE_GUARD_PCT=${this.priceGuardPct}`,
      `SKIP_CONFIRM=${this.skipOrderConfirm ? "true" : "false"}`,
      // --- 세션별 시드 비율 ---
      `SEED_DAY_PCT=${this.seedDayPct}`,
      `SEED_PRE_PCT=${this.seedPrePct}`,
      `SEED_REGULAR_PCT=${this.seedRegularPct}`,
      `SEED_BASIS=${this.seedBasis}`,
      `SEED_FIXED_USD=${this.seedFixedUsd ?? ""}`,
      // --- [v0.8.3] 기본 손익비 ---
      `DEFAULT_TP_PCT=${this.defaultTpPct}`,
      `DEFAULT_SL_PCT=${this.defaultSlPct}`,
      // --- [v0.26.0] 자동매매 한도(3개). "켜짐" 자체는 여기 없음 — 절대 저장하지 않는다(안전). ---
      `AUTO_MAX_POSITIONS=${this.autoTradeMaxPositions}`,
      `AUTO_MAX_LOSS_PCT=${this.autoTradeMaxLossPct}`,
      `AUTO_MAX_INVEST_PCT=${this.autoTradeMaxInvestPct}`,
      `AUTO_WATCH_MINUTES=${this.autoTradeWatchMinutes}`, // [v0.42.0] 장기간 미체결 자동취소 기준(분)
      `AUTO_ENTRY_LEVEL=${this.autoTradeEntryLevel}`, // [v0.61.8] 진입 타점 분할(1~2)
      `AUTO_RESUME_AFTER_UPDATE=${this.autoResumeAfterUpdatePending}`, // [v0.86.0] 업데이트 재시작 전용 소비형 플래그(일반 종료엔 무관)
      `LAB_ENABLED=${this.labEnabled}`, // [v0.65.0] 매매연구소
      `LAB_RANK_COUNT=${this.labRankCount}`,
      `LAB_RANK_MIGRATED=${this.labRankMigrated || process.env.LAB_RANK_MIGRATED === "1" ? "1" : "0"}`,
      `LAB_DOJI_BODY_MAX=${this.labDojiBodyMax}`,
      `LAB_BODY_MIN=${this.labBodyMin}`,
      `LAB_VOL_MIN=${this.labVolMin}`,
      `LAB_MIN_RANGE_PCT=${this.labMinRangePct}`,
      `AUTO_SL_MODE=${this.autoTradeSlMode}`, // [v0.63.0] 방어 전략
      `AUTO_EMA_STOP_BUFFER_PCT=${this.autoTradeEmaStopBufferPct}`,
      `AUTO_REENTRY_BLOCK_ENABLED=${this.autoTradeReentryBlockEnabled}`,
      `AUTO_VOL_SCALED_SIZING_ENABLED=${this.autoTradeVolScaledSizingEnabled}`, // [v0.72.0]
      `AUTO_LOSS_STREAK_LIMIT=${this.autoTradeLossStreakLimit}`,
      `AUTO_REPROTECT_VANISHED=${this.autoReprotectVanished}`, // [v0.69.0]
      `LAST_SEEN_CHANGELOG=${this.lastSeenChangelogVersion ?? ""}`, // [v0.61.9] 이 기기가 마지막으로 읽은 업데이트 내역 버전
      `SYSTEM_PAUSE_ENABLED=${this.systemPauseEnabled ? "true" : "false"}`, // [v0.44.0] 시스템 휴무 시간대 기능
      // --- [v0.28.0] 자동매매 스크리너 조건(4개) ---
      `AUTO_SCAN_COUNT=${this.autoScanCount}`,
      `AUTO_SCAN_PRICE_MIN=${this.autoScanPriceMin}`,
      `AUTO_SCAN_PRICE_MAX=${this.autoScanPriceMax}`,
      `AUTO_SCAN_BODY_RATIO=${this.autoScanBodyRatio}`,
      // --- [v0.33.0] 스크리닝 기준 탭 — 나머지 조건 ---
      `AUTO_SCAN_EMA_ENABLED=${this.autoScanEmaTrendEnabled}`,
      `AUTO_SCAN_EMA_PERIOD=${this.autoScanEmaPeriod}`,
      `AUTO_SCAN_CLOUD_ENABLED=${this.autoScanCloudEnabled}`,
      `AUTO_SCAN_DOJI_WICK_MIN_RATIO=${this.autoScanDojiWickMinRatio}`,
      `AUTO_SCAN_DOJI_MAX_AGE_ENABLED=${this.autoScanDojiMaxAgeEnabled}`,
      `AUTO_SCAN_DOJI_MAX_AGE_MINUTES=${this.autoScanDojiMaxAgeMinutes}`,
      `AUTO_SCAN_DOJI_MAX_GAP_ENABLED=${this.autoScanDojiMaxGapEnabled}`,
      `AUTO_SCAN_DOJI_MAX_GAP_MINUTES=${this.autoScanDojiMaxGapMinutes}`,
      `AUTO_SCAN_EMA_MIN_GAP_ENABLED=${this.autoScanEmaMinGapEnabled}`, // [v0.63.0] 방어 전략
      `AUTO_SCAN_EMA_MIN_GAP_PCT=${this.autoScanEmaMinGapPct}`,
      `AUTO_SCAN_EMA_SLOPE_ENABLED=${this.autoScanEmaSlopeEnabled}`,
      `AUTO_SCAN_ATR_FILTER_ENABLED=${this.autoScanAtrFilterEnabled}`,
      `AUTO_SCAN_ATR_MAX_PCT=${this.autoScanAtrMaxPct}`,
      `AUTO_SCAN_NEXT_CANDLE_CONFIRM_ENABLED=${this.autoScanNextCandleConfirmEnabled}`,
      `AUTO_SCAN_EXCLUDE_ETF=${this.autoScanExcludeEtf}`,
      // --- [v0.45.0] "매매진행할 장" 선택 ---
      `AUTO_SCAN_DAY_ENABLED=${this.autoScanDayEnabled}`,
      `AUTO_SCAN_PRE_ENABLED=${this.autoScanPreEnabled}`,
      `AUTO_SCAN_REGULAR_ENABLED=${this.autoScanRegularEnabled}`,
      `AUTO_SCAN_AFTER_ENABLED=${this.autoScanAfterEnabled}`,
      // --- [v0.8.1] 로그인 세션(리프레시 토큰만 로컬 저장 → 재시작해도 로그인 유지). 비밀번호·마스터 비번은 저장 안 함. ---
      `CAPRI_AUTH_REFRESH=${this.authRefreshToken ?? ""}`,
      `CAPRI_AUTH_EMAIL=${this.authEmail ?? ""}`,
      `CAPRI_DATA_KEY=${this.authDataKey ?? ""}`, // [v0.88.0] 비밀번호에서 만든 데이터 키(비밀번호 자체가 아님)
      "",
    ].join("\n");
    // 환경변수에도 반영(다음 loadEnv 없이도 일관되게)
    process.env.LIVE_ORDERS = this.liveOrdersEnabled ? "true" : "false";
    process.env.AUTO_RESUME_AFTER_UPDATE = this.autoResumeAfterUpdatePending ? "true" : "false"; // [v0.86.0]
    writeFileSync(this.envPath, lines, "utf8");
    chmodSync(this.envPath, 0o600);
  }

  /**
   * [v0.3.0] 세션별 시드 비율/기준 저장. 오너가 설정 탭에서 바꾼 값을 받아 반영·저장한다.
   *   음수나 이상값은 무시하고, 저장 후 최신 설정을 돌려준다(화면 갱신용).
   */
  saveSeedSettings(input: {
    seedDayPct?: number;
    seedPrePct?: number;
    seedRegularPct?: number;
    seedBasis?: "auto" | "fixed";
    seedFixedUsd?: number | null;
  }) {
    if (typeof input.seedDayPct === "number" && Number.isFinite(input.seedDayPct) && input.seedDayPct >= 0) this.seedDayPct = input.seedDayPct;
    if (typeof input.seedPrePct === "number" && Number.isFinite(input.seedPrePct) && input.seedPrePct >= 0) this.seedPrePct = input.seedPrePct;
    if (typeof input.seedRegularPct === "number" && Number.isFinite(input.seedRegularPct) && input.seedRegularPct >= 0)
      this.seedRegularPct = input.seedRegularPct;
    if (input.seedBasis === "auto" || input.seedBasis === "fixed") this.seedBasis = input.seedBasis;
    // 고정 시드: null/빈값이면 해제, 양수면 설정
    if (input.seedFixedUsd === null) this.seedFixedUsd = null;
    else if (typeof input.seedFixedUsd === "number" && Number.isFinite(input.seedFixedUsd) && input.seedFixedUsd > 0)
      this.seedFixedUsd = input.seedFixedUsd;
    this.persistEnv();
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: `시드 설정 저장 — 데이 ${this.seedDayPct}% / 프리 ${this.seedPrePct}% / 본장 ${this.seedRegularPct}% · 기준 ${this.seedBasis === "auto" ? "매수가능금액" : `고정 $${this.seedFixedUsd ?? "-"}`}`,
    });
    return this.getSettings();
  }

  /** 현재 세션에 적용할 시드 비율(%)을 고른다. 애프터/마감은 본장 비율을 준용한다. */
  private sessionPctFor(session: Session): number {
    switch (session) {
      case "day":
        return this.seedDayPct;
      case "pre":
        return this.seedPrePct;
      case "regular":
        return this.seedRegularPct;
      default:
        return this.seedRegularPct; // after/closed: 본장 비율 준용(별도 설정 없음)
    }
  }

  async saveSettings(input: { mode: "mock" | "live"; clientId?: string; clientSecret?: string; account?: string }) {
    const prevAccount = process.env.TOSS_ACCOUNT ?? "";
    if (input.clientId) process.env.TOSS_CLIENT_ID = input.clientId.trim();
    if (input.clientSecret) process.env.TOSS_CLIENT_SECRET = input.clientSecret.trim();
    if (input.account !== undefined) process.env.TOSS_ACCOUNT = input.account.trim();

    const hasKeys = !!process.env.TOSS_CLIENT_ID && !!process.env.TOSS_CLIENT_SECRET;
    const newMode = input.mode === "live" && hasKeys ? "live" : "mock";
    // 모드가 바뀌거나 "계좌만" 바뀌어도 이전 계좌의 매수가능금액/환율 캐시는 무효화한다.
    const accountChanged = (process.env.TOSS_ACCOUNT ?? "") !== prevAccount;
    if (newMode !== this.mode || accountChanged) {
      this.fxCache = null;
      this.buyingPowerUsd = null;
    }
    if (newMode !== this.mode) {
      this.mode = newMode;
      await this.stopMock(); // 모드가 바뀌면 연습 서버 상태 초기화
    }
    process.env.TOSS_MOCK = this.mode === "mock" ? "true" : "false";
    // 실서버 주소는 검증된 openapi 도메인으로 고정(틀린 apigw 주소 버그 수정).
    if (this.mode === "live") process.env.TOSS_BASE_URL = ToolEngine.LIVE_BASE_URL;
    clearTokenCache(); // 키/계좌가 바뀌었을 수 있으니 토큰 재발급

    // [계좌 자동 조회] 실서버인데 계좌가 비어 있으면 /api/v1/accounts 로 accountSeq를 자동 확보한다.
    //   (예전엔 사용자가 "1"을 손으로 입력해야 했고, 실제 accountSeq가 1이 아니면 조용히 틀렸다.)
    //   실패해도 저장 자체는 진행(사용자가 나중에 직접 입력 가능).
    if (this.mode === "live" && !process.env.TOSS_ACCOUNT?.trim()) {
      try {
        const accts = await getAccounts();
        if (accts.length > 0) {
          process.env.TOSS_ACCOUNT = String(accts[0].accountSeq);
          this.addJournal({ kind: "info", symbol: "-", summary: `계좌 자동 확인: accountSeq ${accts[0].accountSeq}` });
        }
      } catch {
        /* 조회 실패해도 저장은 계속(사용자가 설정 탭에서 직접 입력 가능) */
      }
    }

    this.persistEnv(); // [v0.3.0] 모든 설정을 한 경로로 저장(토글·시드 포함)
    this.addJournal({ kind: "info", symbol: "-", summary: `설정 저장 (모드: ${this.mode === "mock" ? "연습" : "실서버(주문 잠금)"})` });

    // [v0.24.0] 로그인 상태면 방금 저장한 키를 조용히 클라우드에도 올린다(실패해도 무시).
    //   → "로그인 + 키 저장"만 하면 다른 기기는 로그인만으로 자동으로 받아간다.
    if (this.authPassword && (input.clientId || input.clientSecret)) {
      void this.syncPushKeys().catch(() => {
        /* 업로드 실패는 조용히 넘어간다(로컬 저장은 이미 됐다) */
      });
    }

    return this.getSettings();
  }

  // --------------------------------------------------------------------------
  // [v0.8.0] 토스 키 기기 간 동기화 — Supabase에 "암호문만" 저장/복원
  //   ⚠️ 평문 키는 절대 클라우드에 올리지 않는다. 오너의 마스터 비밀번호(passphrase)로
  //   기기에서 암호화한 뒤 암호문만 저장한다. passphrase 는 어디에도 저장하지 않는다.
  // --------------------------------------------------------------------------
  //  아래 두 값은 "공개용(publishable) anon 키/URL"이라 앱에 넣어도 안전하다.
  //  (실제 보호는 RLS + 클라이언트 암호화가 한다. 토스 실키와는 무관하다.)
  //  [v0.8.1] 카프리 '전용' Supabase 프로젝트(CATCH·워크머니와 분리 — auth·데이터 완전 격리).
  private static readonly SUPABASE_URL = "https://fauieykjxdfkngwvfoky.supabase.co";
  private static readonly SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhdWlleWtqeGRma25nd3Zmb2t5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNDY0NDIsImV4cCI6MjEwMDcyMjQ0Mn0.Wq9jnoKGO5CbRbDfzYKrZCaV3RD4zjZCdBgQJLQrqRI";
  // [v0.24.0] 유일한 운영자 계정. 가입 승인 화면(설정 탭)은 로그인한 이메일이 이 값과
  //   같을 때만 보인다. 실제 권한 검사는 Supabase RLS 정책이 같은 이메일 조건으로
  //   서버에서 한 번 더 하므로(마이그레이션 4번), 이 값을 바꿔치기해도 서버가 막는다.
  private static readonly OWNER_EMAIL = "hun100b@gmail.com";

  // ---- 로그인(Supabase Auth) — 사람마다 자기 계정, 키·매매이력은 계정별로 격리 ----
  //   [v0.24.0] "허용된 사람만 가입할 수 있다" — Supabase 쪽에 가입 허용목록 트리거가
  //   있어(supabase/migrations/…_capri_v2_…), 목록에 없는 이메일은 가입 자체가 막힌다.
  //   몇 명까지 쓸지는 오너가 그 목록에 이메일을 추가/삭제하는 것으로 정한다(앱은 관여 안 함).
  //   [v0.24.0 추가] 오너는 더 이상 SQL을 직접 안 써도 된다 — 앱(설정 탭 → 가입 승인)에
  //   로그인만 하면 대기 중인 요청을 보고 [승인]을 누를 수 있다(PC가 꺼져 있어도 폰으로 가능).

  /** 서버가 돌려준 원문 오류를 사람이 이해할 문구로 바꾼다. notAllowed면 "승인 요청 남기기" 버튼을 보여줄 근거가 된다. */
  private static explainSignupError(raw: string): { message: string; notAllowed: boolean } {
    if (/CAPRI_NOT_ALLOWED/i.test(raw)) {
      return { message: "아직 사용 승인이 안 된 이메일입니다. 아래에서 승인 요청을 남겨 주세요.", notAllowed: true };
    }
    // Supabase는 보안상 트리거의 원문 예외를 그대로 안 돌려주고 일반 문구로 감쌀 때가 있다
    // (예: "Database error saving new user"). 그런 경우도 같은 안내를 우선 보여준다.
    if (/database error|unexpected_failure/i.test(raw)) {
      return {
        message: `가입할 수 없습니다 — 아직 운영자 승인이 안 된 이메일일 수 있어요. 아래에서 승인 요청을 남겨 보세요.\n(자세한 오류: ${raw})`,
        notAllowed: true,
      };
    }
    return { message: raw, notAllowed: false };
  }

  /**
   * [v0.8.1→v0.41.0] 회원가입. [v0.24.0] 허용목록에 있는 이메일만 가입되고, 성공하면
   *   바로 로그인·자동 동기화까지 된다.
   *   [v0.41.0 버그 수정 — 오너 실사용 보고: "가입 실패(HTTP 500) 에러가 발생하며
   *   승인 대기 목록에 신규 사용자가 나타나지 않는다"] 이 HTTP 500 자체는 실제로는
   *   버그가 아니라 허용목록 가입 게이트(마이그레이션의 `capri_auth_gate` 트리거,
   *   `raise exception` → Supabase Auth가 이걸 일반 500으로 감싸 돌려줌)가 "아직 승인
   *   안 된 이메일"을 정상적으로 막은 것이다(explainSignupError가 이미 이 500을
   *   친절한 문구로 바꿔 보여주고 있었음). 진짜 문제는 그 다음 단계 — 예전엔 "승인
   *   대기열에 올리기"(requestAccess)가 화면의 별도 버튼을 오너가 다시 눌러야만
   *   실행됐는데, 그 버튼 존재를 모르고 넘어가면 신청 자체가 하나도 안 남아 "승인 대기
   *   목록이 텅 빔"으로 이어졌다. 이제 가입이 허용목록 문제로 막히면 이 함수가 자동으로
   *   승인 요청까지 접수한다 — 오너가 별도로 버튼을 누를 필요가 없다(화면의 버튼은
   *   자동 접수가 실패했을 때 다시 시도하는 용도로만 남겨둔다).
   *
   *   [v0.53.0 긴급 수정 — 오너 실사용 보고: "동료가 가입해도 요청 목록에 하나도 안 뜬다"]
   *   Supabase 프로젝트의 실제 auth 로그를 직접 조회해 재현: 동료(카일)가 가입을 시도하면
   *   서버는 분명히 CAPRI_NOT_ALLOWED 예외를 500으로 감싸 돌려주는데(error_code:
   *   "unexpected_failure"), 그 직후 승인 요청 테이블(capri_access_requests)에 insert 요청
   *   자체가 단 한 번도 나가지 않았다(edge_logs 확인). 원인: 이 함수가 `data.msg`
   *   필드만 보고 있었는데, GoTrue 버전에 따라 실제 필드명이 `msg`가 아닌 `message`일 수
   *   있다 — 그러면 raw가 그 어떤 유용한 문구도 못 담고 `가입 실패(HTTP 500)`라는 안전
   *   기본값으로 떨어져 두 정규식(CAPRI_NOT_ALLOWED / database error) 모두 매치 실패,
   *   `notAllowed`가 false가 돼 requestAccess() 자체가 안 불렸다.
   *   [수정] ① 가능한 필드명을 전부 모아 판정(`msg`/`message`/`error_description`/
   *   `error`/`error_code` — 하나라도 단서가 있으면 잡아낸다). ② 오너의 명시적 지시
   *   ("다른 사용자가 가입 버튼 누르면 무조건 바로 요청 목록에 들어오게") 반영 — 문구
   *   인식에 또 실패하는 경우까지 대비해, HTTP 500(서버 쪽 거부)이면 사유 판별과
   *   무관하게 일단 승인 요청부터 접수한다. 중복 접수는 requestAccess()가 이미 409를
   *   "이미 신청하셨습니다"로 안전하게 처리하므로 부작용이 없다.
   */
  async authSignUp(email: string, password: string): Promise<{ ok: boolean; needsConfirm: boolean; message: string; canRequestAccess?: boolean }> {
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: { apikey: ToolEngine.SUPABASE_ANON, "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      }, 10_000, "signup");
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        // [v0.53.0] 필드명이 서버 버전마다 다를 수 있어 전부 모아 본다(하나라도 단서를 놓치면
        //   "허용목록 문제"를 못 알아채 자동 접수가 통째로 건너뛰어진다 — 실제로 있었던 사고).
        const candidates = [data.msg, data.message, data.error_description, data.error, data.error_code]
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
        const raw = candidates.length > 0 ? candidates.join(" | ") : `가입 실패(HTTP ${res.status})`;
        const explained = ToolEngine.explainSignupError(raw);
        // [v0.53.0] 문구로 못 알아챘어도, 서버가 500(우리 쪽 트리거가 막았을 가능성이 가장 큰
        //   구간)을 돌려줬으면 일단 승인 요청부터 접수한다 — 오너 지시("무조건 요청 목록에
        //   들어오게") 반영. 중복 접수는 requestAccess()가 409로 안전하게 무시한다.
        if (explained.notAllowed || res.status >= 500) {
          const req = await this.requestAccess(email).catch((e) => ({ ok: false, message: String(e) }));
          const suffix = req.ok
            ? " 승인 요청을 자동으로 접수했습니다 — 운영자 승인을 기다려 주세요."
            : ` (승인 요청 자동 접수는 실패했습니다: ${req.message} — 아래 버튼으로 직접 다시 시도하세요.)`;
          return { ok: false, needsConfirm: false, message: explained.message + suffix, canRequestAccess: !req.ok };
        }
        return { ok: false, needsConfirm: false, message: explained.message, canRequestAccess: explained.notAllowed };
      }
      // [v0.8.2] 서버에 자동확인이 걸려 있어 가입하면 보통 바로 세션이 온다 → 즉시 로그인 상태.
      if (data.access_token) {
        this.applySession(data);
        await this.adoptPassword(password); // [v0.24.0→v0.88.0] 잠금 열쇠(비밀번호 + 데이터 키) 확보 + 세션 저장(비밀번호 자체는 저장 안 함)
        return { ok: true, needsConfirm: false, message: "가입·로그인 완료되었습니다." };
      }
      // 혹시 세션이 안 오면(설정 변경 등) 같은 자격증명으로 바로 로그인 시도.
      const signin = await this.authSignIn(email, password);
      if (signin.ok) return { ok: true, needsConfirm: false, message: "가입·로그인 완료되었습니다." };
      return { ok: true, needsConfirm: false, message: "가입되었습니다. [로그인]을 눌러 주세요." };
    } catch (e) {
      return { ok: false, needsConfirm: false, message: String(e).replace(/^Error:\s*/, "") };
    }
  }

  /**
   * [v0.8.1] 로그인(이메일+비밀번호). 성공 시 세션 저장(재시작해도 유지).
   * [v0.24.0] 로그인 = 동기화. 이 기기에 아직 없는 토스 키·매매 이력을 로그인 직후
   *   조용히(실패해도 무시) 자동으로 받아온다 — 사용자가 따로 버튼을 누를 필요가 없다.
   */
  async authSignIn(email: string, password: string): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: ToolEngine.SUPABASE_ANON, "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      }, 10_000, "token");
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok || !data.access_token) {
        let msg = String(data.error_description ?? data.msg ?? `로그인 실패(HTTP ${res.status})`);
        if (/email not confirmed/i.test(msg)) msg = "이메일 확인이 아직 안 됐습니다. 가입 시 받은 메일의 링크를 클릭한 뒤 다시 로그인하세요.";
        return { ok: false, message: msg };
      }
      this.applySession(data);
      await this.adoptPassword(password); // [v0.24.0→v0.88.0] 잠금 열쇠(비밀번호 + 데이터 키) 확보 + refresh 토큰·이메일 저장(비밀번호 자체는 저장 안 함)

      // 자동 동기화: 이 기기에 키가 없으면 클라우드에서 받아오고, 매매 이력도 함께 받아온다.
      let extra = "";
      if (!process.env.TOSS_CLIENT_ID) {
        const pulled = await this.syncPullKeys().catch(() => null);
        if (pulled?.ok) extra += " 저장된 토스 키를 자동으로 불러왔습니다.";
      }
      const pulledTrades = await this.syncPullTrades().catch(() => null);
      if (pulledTrades?.ok && (pulledTrades.count ?? 0) > 0) extra += ` 매매 이력 ${pulledTrades.count}건도 함께 받아왔습니다.`;
      const pulledAutoState = await this.syncPullAutoState().catch(() => null);
      if (pulledAutoState?.ok && (pulledAutoState.count ?? 0) > 0) extra += ` 자동매매 기록도 함께 받아왔습니다.`;
      // [v0.61.7 — ③ 전수조사 중간-2] 삼분할 타점 기록도 같은 타이밍에 받아온다.
      const pulledSplits = await this.syncPullSplits().catch(() => null);
      if (pulledSplits?.ok && (pulledSplits.count ?? 0) > 0) extra += ` 삼분할 기록도 함께 받아왔습니다.`;
      // [v0.35.0] 로그인 시점까지 쌓여 있던 기존 자동매매기록도 그룹 공유 표에 곧바로 올려 둔다
      //   (다음 매매가 나가야만 올라가면, 새로 로그인한 회원의 과거 기록이 그룹 연구탭에
      //   한참 안 보일 수 있음 — 로그인 직후 1회는 즉시 반영).
      void this.syncPushGroupTrades().catch(() => {
        /* 조용히 무시 */
      });
      // [v0.56.0] "그룹 전체 실시간 동기화" — 로그인한 순간부터 3분마다 자동으로 올리고/받아온다.
      this.startGroupSyncLoop();
      // [v0.88.0] 암호화 개인 기록(체결·자동매매·삼분할)도 지금 바로 올리고, 이후 주기적으로 확인·재시도한다.
      void this.syncPushAll().catch(() => undefined);
      this.startCloudSyncLoop();

      return { ok: true, message: `로그인되었습니다(${this.authEmail}).${extra}` };
    } catch (e) {
      return { ok: false, message: String(e).replace(/^Error:\s*/, "") };
    }
  }

  /** 로그아웃 — 세션 지우고 저장에서도 제거(토스 키/설정은 그대로 남는다). */
  authSignOut(): { ok: boolean } {
    this.stopGroupSyncLoop(); // [v0.56.0] 로그아웃하면 그룹 자동 동기화도 즉시 멈춘다.
    this.stopRemoteControlLoop(); // [v0.59.0] 로그아웃하면 원격 명령 폴링도 즉시 멈춘다.
    this.stopProtectionAuditLoop(); // [v0.71.0] 로그아웃하면 보호 감사도 즉시 멈춘다.
    this.stopPositionSyncLoop(); // [v0.74.0] 로그아웃하면 포지션 동기화도 즉시 멈춘다.
    this.authAccessToken = null;
    this.authRefreshToken = null;
    this.authEmail = null;
    this.authUserId = null;
    this.authExpiresAtMs = 0;
    this.authPassword = null; // [v0.24.0] 메모리에서만 들고 있던 비밀번호도 지운다
    this.authDataKey = null; // [v0.88.0] 데이터 키도 지운다(다음 로그인 계정과 섞이지 않게)
    this.stopCloudSyncLoop();
    this.accountStatusCache = null; // [v0.59.0] 다음 로그인 계정과 섞이지 않게 비운다
    this.persistEnv();
    return { ok: true };
  }

  /**
   * 로그인 상태(화면 표시용). isOwner면 화면이 "가입 승인" 패널을 보여준다.
   * [v0.59.0] accountStatus 추가 — 화면이 "로그인 화면 / 승인 대기 화면 / 본 화면" 중
   *   무엇을 보여줄지 이 값 하나로 정한다. 다만 이건 화면단 UX일 뿐이고, 진짜 차단은
   *   서버 RLS(마이그레이션 20260930120000)가 한다 — 그래서 조회가 실패해도(오프라인 등)
   *   "unknown"으로 두고 화면을 막지 않는다(이미 로그인된 사람을 네트워크 문제로 잠그면
   *   안 됨 — 실계좌 앱이라 더 신중해야 한다). 진짜 미승인/거절이 **확인된 경우만** 막는다.
   */
  async authStatus(): Promise<{
    email: string | null;
    loggedIn: boolean;
    isOwner: boolean;
    accountStatus: "pending" | "approved" | "rejected" | "unknown";
  }> {
    const base = {
      email: this.authEmail,
      loggedIn: !!(this.authAccessToken || this.authRefreshToken),
      isOwner: this.authEmail === ToolEngine.OWNER_EMAIL,
    };
    if (!base.loggedIn) return { ...base, accountStatus: "unknown" as const };
    if (base.isOwner) return { ...base, accountStatus: "approved" as const }; // 오너는 게이트 대상 아님
    if (this.accountStatusCache && Date.now() - this.accountStatusCache.atMs < 60_000) {
      return { ...base, accountStatus: this.accountStatusCache.status };
    }
    try {
      const token = await this.ensureAccessToken();
      if (!token) return { ...base, accountStatus: "unknown" as const };
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_accounts?select=status&user_id=eq.${this.authUserId}`, {
        headers: this.authRestHeaders(token),
      }, 10_000, "capri_accounts");
      if (!res.ok) return { ...base, accountStatus: "unknown" as const };
      const rows = (await res.json()) as Array<{ status: "pending" | "approved" | "rejected" }>;
      const status = rows[0]?.status;
      if (!status) return { ...base, accountStatus: "unknown" as const };
      this.accountStatusCache = { status, atMs: Date.now() };
      return { ...base, accountStatus: status };
    } catch {
      return { ...base, accountStatus: "unknown" as const };
    }
  }

  /** 토큰 응답을 세션 상태로 반영. */
  private applySession(data: Record<string, unknown>): void {
    this.authAccessToken = String(data.access_token);
    if (data.refresh_token) this.authRefreshToken = String(data.refresh_token);
    const expiresIn = Number(data.expires_in ?? 3600);
    this.authExpiresAtMs = Date.now() + expiresIn * 1000;
    const user = data.user as Record<string, unknown> | undefined;
    // [v0.59.0] 계정이 바뀌면(다른 사람으로 로그인) 이전 계정의 승인 상태 캐시를 들고
    //   있으면 안 된다 — 잠깐이라도 남의 승인 상태로 화면이 잘못 뜰 수 있다.
    if (user?.id && String(user.id) !== this.authUserId) this.accountStatusCache = null;
    if (user?.id) this.authUserId = String(user.id);
    if (user?.email) this.authEmail = String(user.email);
  }

  /** 유효한 access token 확보(만료 임박이면 refresh 로 갱신). 없으면 null(로그인 필요). */
  private async ensureAccessToken(): Promise<string | null> {
    if (this.authAccessToken && Date.now() < this.authExpiresAtMs - 60_000) return this.authAccessToken;
    if (!this.authRefreshToken) return null;
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: ToolEngine.SUPABASE_ANON, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: this.authRefreshToken }),
      }, 10_000, "token");
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok || !data.access_token) return null;
      this.applySession(data);
      this.persistEnv(); // 새 refresh 토큰 저장
      return this.authAccessToken;
    } catch {
      return null;
    }
  }

  /** RLS 보호 REST 호출용 헤더(로그인 유저의 JWT). auth.uid()=이 유저 → 본인 행만 접근. */
  private authRestHeaders(token: string): Record<string, string> {
    return { apikey: ToolEngine.SUPABASE_ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  /** 로그인 없이(비로그인) REST 호출용 헤더 — 승인 요청 접수처럼 계정이 아직 없는 사람이 쓴다. */
  private anonRestHeaders(): Record<string, string> {
    return { apikey: ToolEngine.SUPABASE_ANON, Authorization: `Bearer ${ToolEngine.SUPABASE_ANON}`, "Content-Type": "application/json" };
  }

  // --------------------------------------------------------------------------
  // [v0.24.0] 가입 승인 요청함 — 오너가 앱 안(로그인만 하면)에서 승인할 수 있게 한다.
  //   PC가 꺼져 있어도, Supabase 사이트에 안 들어가도, 오너가 폰으로 로그인만 하면 된다.
  //   보안: capri_access_requests 는 "요청서 우편함"일 뿐이다. 실제로 가입을 허용하는
  //   열쇠는 capri_allowed_emails 뿐이라, 이 우편함에 아무나 써넣어도 스스로를
  //   승인시킬 수는 없다(RLS로 오너 계정만 capri_allowed_emails 에 쓸 수 있음).
  // --------------------------------------------------------------------------

  /** 가입이 막힌 사람이 "승인해 주세요" 요청을 접수한다. 로그인 불필요(아직 계정이 없으니까). */
  async requestAccess(email: string, note?: string): Promise<{ ok: boolean; message: string }> {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes("@")) return { ok: false, message: "올바른 이메일을 입력하세요." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_access_requests`, {
        method: "POST",
        headers: { ...this.anonRestHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ email: e, note: note?.trim() || null }),
      }, 10_000, "capri_access_requests");
      if (res.status === 409) return { ok: true, message: "이미 신청하셨습니다. 운영자 승인을 기다려 주세요." };
      if (!res.ok) return { ok: false, message: `신청 실패(HTTP ${res.status}).` };
      return { ok: true, message: "사용 신청을 접수했습니다. 운영자 승인 후 가입할 수 있어요." };
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, "") };
    }
  }

  /** [운영자 전용] 대기 중인 승인 요청 목록. RLS가 운영자 계정 로그인일 때만 결과를 준다. */
  async listAccessRequests(): Promise<Array<{ email: string; note: string | null; requestedAt: string }>> {
    const token = await this.ensureAccessToken();
    if (!token) return [];
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_access_requests?status=eq.pending&select=email,note,requested_at&order=requested_at.asc`,
        { headers: this.authRestHeaders(token) },
      10_000, "capri_access_requests");
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ email: string; note: string | null; requested_at: string }>;
      return rows.map((r) => ({ email: r.email, note: r.note, requestedAt: r.requested_at }));
    } catch {
      return [];
    }
  }

  /** [운영자 전용] 요청을 승인 — 허용목록(capri_allowed_emails)에 추가 + 요청 상태를 갱신한다. */
  async approveAccessRequest(email: string): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요." };
    const e = email.trim().toLowerCase();
    try {
      const insertRes = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_allowed_emails`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ email: e, note: "앱에서 승인" }),
      }, 10_000, "capri_allowed_emails");
      if (!insertRes.ok) {
        return { ok: false, message: `허용 목록 추가 실패(HTTP ${insertRes.status}). 운영자 계정으로 로그인했는지 확인하세요.` };
      }
      await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_access_requests?email=eq.${encodeURIComponent(e)}`, {
        method: "PATCH",
        headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" },
        body: JSON.stringify({ status: "approved", decided_at: new Date().toISOString() }),
      }, 10_000, "capri_access_requests");
      this.addJournal({ kind: "info", symbol: "-", summary: `✅ 가입 승인: ${e}` });
      return { ok: true, message: `${e} 승인 완료. 이제 이 이메일로 가입할 수 있습니다.` };
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, "") };
    }
  }

  /** [운영자 전용] 요청을 거절(허용목록에는 추가하지 않고, 요청 상태만 갱신). */
  async rejectAccessRequest(email: string): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요." };
    const e = email.trim().toLowerCase();
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_access_requests?email=eq.${encodeURIComponent(e)}`, {
        method: "PATCH",
        headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" },
        body: JSON.stringify({ status: "rejected", decided_at: new Date().toISOString() }),
      }, 10_000, "capri_access_requests");
      if (!res.ok) return { ok: false, message: `거절 처리 실패(HTTP ${res.status}).` };
      return { ok: true, message: `${e} 요청을 거절했습니다.` };
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, "") };
    }
  }

  // --------------------------------------------------------------------------
  // [v0.59.0] 로그인 게이트 — capri_accounts 기반 승인 대기 목록(진짜 게이트).
  //   위 capri_access_requests(가입 자체가 막히던 예전 모델)와는 별개 표다. 지금은
  //   가입이 항상 성공하고, 승인 전엔 이 표의 status='pending'으로만 남는다
  //   (마이그레이션 20260930120000 참고). 오너 전용 — RLS가 서버에서 한 번 더 막는다.
  // --------------------------------------------------------------------------

  /** [운영자 전용] 승인 대기 중인 계정 목록. */
  async listPendingAccounts(): Promise<Array<{ userId: string; email: string; requestedAt: string }>> {
    const token = await this.ensureAccessToken();
    if (!token) return [];
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_accounts?status=eq.pending&select=user_id,email,requested_at&order=requested_at.asc`,
        { headers: this.authRestHeaders(token) },
      10_000, "capri_accounts");
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ user_id: string; email: string; requested_at: string }>;
      return rows.map((r) => ({ userId: r.user_id, email: r.email, requestedAt: r.requested_at }));
    } catch {
      return [];
    }
  }

  /** [운영자 전용] 대기 계정을 승인/거절한다 — capri_allowed_emails 동기화는 DB 트리거가 자동으로 한다. */
  async decideAccount(userId: string, decision: "approved" | "rejected"): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_accounts?user_id=eq.${userId}`, {
        method: "PATCH",
        headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" },
        body: JSON.stringify({ status: decision, decided_at: new Date().toISOString(), decided_by: this.authEmail }),
      }, 10_000, "capri_accounts");
      if (!res.ok) return { ok: false, message: `처리 실패(HTTP ${res.status}). 운영자 계정으로 로그인했는지 확인하세요.` };
      this.addJournal({ kind: "info", symbol: "-", summary: `${decision === "approved" ? "✅ 계정 승인" : "🚫 계정 거절"}: ${userId}` });
      return { ok: true, message: decision === "approved" ? "승인했습니다. 이제 바로 쓸 수 있습니다." : "거절했습니다." };
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, "") };
    }
  }

  // --------------------------------------------------------------------------
  // [v0.59.0] 알림 설정(디스코드 웹훅) — 오너 전용. 값은 capri_notify_settings에
  //   저장되고, 새 가입 대기가 생기면 DB 트리거가 직접 그 주소로 쏜다(앱이 꺼져
  //   있어도 알림이 온다 — "언제 어디서든" 오너 요청 반영).
  // --------------------------------------------------------------------------

  /** [운영자 전용] 저장된 디스코드 웹훅 주소(있으면). */
  async getNotifySettings(): Promise<{ discordWebhookUrl: string | null }> {
    const token = await this.ensureAccessToken();
    if (!token) return { discordWebhookUrl: null };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_notify_settings?select=discord_webhook_url&id=eq.true`, {
        headers: this.authRestHeaders(token),
      }, 10_000, "capri_notify_settings");
      if (!res.ok) return { discordWebhookUrl: null };
      const rows = (await res.json()) as Array<{ discord_webhook_url: string | null }>;
      return { discordWebhookUrl: rows[0]?.discord_webhook_url ?? null };
    } catch {
      return { discordWebhookUrl: null };
    }
  }

  /** [운영자 전용] 디스코드 웹훅 주소 저장(빈 문자열이면 알림을 끈다). */
  async saveNotifySettings(discordWebhookUrl: string): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_notify_settings?id=eq.true`, {
        method: "PATCH",
        headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" },
        body: JSON.stringify({ discord_webhook_url: discordWebhookUrl.trim() || null, updated_at: new Date().toISOString() }),
      }, 10_000, "capri_notify_settings");
      if (!res.ok) return { ok: false, message: `저장 실패(HTTP ${res.status}). 운영자 계정으로 로그인했는지 확인하세요.` };
      return { ok: true, message: discordWebhookUrl.trim() ? "저장했습니다. 다음 신규 가입부터 디스코드로 알림이 갑니다." : "웹훅 주소를 비웠습니다(알림 꺼짐)." };
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, "") };
    }
  }

  // --------------------------------------------------------------------------
  // [v0.83.0 — 오너 지시 "카일도 디스코드 알림 받으려면 개인용 웹훅 세팅창이 있어야
  //   해"] 위 capri_notify_settings(단일 전역 행)는 "새 가입 대기" 알림 전용으로 계속
  //   두고, 거래 신호(스크리닝·보호 가드)는 로그인한 사람 각자의 웹훅
  //   (capri_user_notify_settings, 본인 행만 RLS)으로 보낸다 — 그룹 전원이 같은 앱을
  //   쓰지만 각자 자기 디스코드로 알림을 받아야 하므로 전역 설정 하나로는 안 됐다.
  // --------------------------------------------------------------------------

  /** [개인용] 로그인한 사람 "본인"의 디스코드 웹훅 주소(있으면). */
  async getMyNotifySettings(): Promise<{ discordWebhookUrl: string | null }> {
    const token = await this.ensureAccessToken();
    if (!token || !this.authUserId) return { discordWebhookUrl: null };
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_user_notify_settings?select=discord_webhook_url&user_id=eq.${this.authUserId}`,
        { headers: this.authRestHeaders(token) }, 10_000, "capri_user_notify_settings",
      );
      if (!res.ok) return { discordWebhookUrl: null };
      const rows = (await res.json()) as Array<{ discord_webhook_url: string | null }>;
      return { discordWebhookUrl: rows[0]?.discord_webhook_url ?? null };
    } catch {
      return { discordWebhookUrl: null };
    }
  }

  /** [개인용] 로그인한 사람 "본인"의 디스코드 웹훅 주소 저장(빈 문자열이면 알림 끔). */
  async saveMyNotifySettings(discordWebhookUrl: string): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token || !this.authUserId) return { ok: false, message: "먼저 로그인하세요." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_user_notify_settings?on_conflict=user_id`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: this.authUserId, discord_webhook_url: discordWebhookUrl.trim() || null, updated_at: new Date().toISOString() }),
      }, 10_000, "capri_user_notify_settings");
      if (!res.ok) return { ok: false, message: `저장 실패(HTTP ${res.status}).` };
      return { ok: true, message: discordWebhookUrl.trim() ? "저장했습니다. 이제부터 스크리닝 신호·보호 가드 알림을 내 디스코드로 받습니다." : "웹훅 주소를 비웠습니다(알림 꺼짐)." };
    } catch (err) {
      return { ok: false, message: String(err).replace(/^Error:\s*/, "") };
    }
  }

  /**
   * [v0.72.0 — 오너 지시 "스크리너를 통해 관찰, 확정된 종목이 나오면 즉시 디스코드로 알림"]
   *   전수조사 결과, capri_notify_settings의 웹훅 주소는 지금까지 "새 가입 대기"(DB 트리거,
   *   위 섹션 참고) 용도로만 쓰이고 있었다 — 스크리닝/매매 신호로 디스코드를 쏘는 경로는
   *   어디에도 없었다(데스크톱 알림(OS Notification, addJournal의 notify 플래그)과는 완전히
   *   별개 통로). [앱이 꺼져 있을 때는?] 스캔 자체가 앱이 켜져 있을 때만 도니, "꺼져 있어도
   *   와야 한다"는 새 가입 알림과 달리 DB 트리거가 필요 없다(알릴 일 자체가 없음).
   *   실패해도 자동매매 사이클을 막으면 안 되므로 항상 조용히 넘어간다(호출부도 await는 하되
   *   에러를 바깥으로 던지지 않음 — try/catch로 완전히 격리).
   *   [v0.83.0] 전역 설정 대신 호출하는 사람 "본인"의 웹훅(getMyNotifySettings)을 쓴다 —
   *   그룹원 각자 자기 디스코드로 받아야 하므로(오너 지시).
   */
  private async sendDiscordAlert(message: string): Promise<void> {
    try {
      const { discordWebhookUrl } = await this.getMyNotifySettings();
      if (!discordWebhookUrl) return; // 설정 안 했으면 조용히 아무 일도 안 함(새 가입 알림과 동일 원칙)
      await fetchWithTimeout(discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      }, 10_000, "discord-webhook");
    } catch {
      /* 알림 실패는 조용히 무시 — 매매 로직엔 영향 없음 */
    }
  }

  /**
   * [v0.91.0 — 튜토리얼 "키 입력 + 연결 테스트"] 저장된 토스 키로 ①키 인증 ②시세 ③계좌를 차례로 시험해 결과를 쉬운 말로 돌려준다.
   *   주문은 절대 내지 않는다(읽기 전용 조회만). 키·토큰은 결과에 담지 않는다. 연습 모드·키 없음은 시험 대신 안내만 한다.
   */
  async testTossConnection(): Promise<ConnectionTestResult> {
    const steps: ConnectionTestResult["steps"] = [];
    if (this.mode !== "live") {
      return {
        ok: false, stage: "mode", steps,
        message: "지금은 연습 모드(앱 안의 가짜 서버)라 토스에 연결하지 않습니다.",
        action: "키를 저장하면서 '실서버 모드'를 고른 뒤 다시 테스트하세요(실서버 모드여도 실주문은 따로 잠겨 있어 안전합니다).",
      };
    }
    if (!process.env.TOSS_CLIENT_ID?.trim() || !process.env.TOSS_CLIENT_SECRET?.trim()) {
      return { ok: false, stage: "keys", steps, message: "토스 키(Client ID/Secret)가 아직 저장돼 있지 않습니다.", action: "키를 입력하고 [저장]을 먼저 눌러 주세요." };
    }
    try {
      await this.prepareBackend();
      clearTokenCache();
      await getAccessToken();
      steps.push({ name: CONNECTION_STEP_NAMES[0], ok: true });
    } catch (e) {
      steps.push({ name: CONNECTION_STEP_NAMES[0], ok: false });
      const c = classifyTossError(String(e));
      return { ok: false, stage: c.stage, steps, message: c.message, action: c.action };
    }
    try {
      await getPrice("AAPL");
      steps.push({ name: CONNECTION_STEP_NAMES[1], ok: true });
    } catch (e) {
      steps.push({ name: CONNECTION_STEP_NAMES[1], ok: false });
      const c = classifyTossError(String(e));
      return { ok: false, stage: c.stage === "price" ? "price" : c.stage, steps, message: c.message, action: c.action };
    }
    try {
      this.assertAccountReady();
      await getBuyingPower("USD");
      steps.push({ name: CONNECTION_STEP_NAMES[2], ok: true });
    } catch (e) {
      steps.push({ name: CONNECTION_STEP_NAMES[2], ok: false });
      const c = classifyTossError(String(e));
      return { ok: false, stage: "account", steps, message: c.stage === "account" ? c.message : "계좌 정보를 읽지 못했습니다.", action: c.stage === "account" ? c.action : "계좌 번호(보통 1번)를 확인하세요. 계속 안 되면 토스 개발자센터에서 키의 권한(조회)을 확인하세요." };
    }
    this.addJournal({ kind: "info", symbol: "-", summary: "✅ 토스 연결 테스트 통과 — 키 인증·시세·계좌 조회 모두 정상." });
    return { ok: true, stage: "done", steps, message: "연결 성공! 키·시세·계좌 모두 정상입니다." };
  }

  /**
   * [v0.91.0 — 튜토리얼 "디스코드 알림"] 내 웹후크로 테스트 한 줄을 보낸다. 주소는 저장돼 있어야 하고, 어디에도 기록하지 않는다.
   */
  async sendMyDiscordTest(): Promise<{ ok: boolean; message: string }> {
    const { discordWebhookUrl } = await this.getMyNotifySettings();
    if (!discordWebhookUrl) return { ok: false, message: "아직 웹후크 주소를 저장하지 않았습니다. 주소를 붙여넣고 [저장]을 먼저 눌러 주세요." };
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(discordWebhookUrl)) {
      return { ok: false, message: "디스코드 웹후크 주소 모양이 아닙니다. 'https://discord.com/api/webhooks/…'로 시작해야 합니다." };
    }
    try {
      const res = await fetchWithTimeout(discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "✅ **Capri 알림 테스트** — 이 메시지가 보이면 알림 연결이 정상입니다. (스크리닝 신호·보호 가드 결과가 이 채널로 옵니다.)" }),
      }, 10_000, "discord-test");
      if (res.ok) return { ok: true, message: "테스트 메시지를 보냈습니다. 디스코드 채널을 확인해 보세요!" };
      if (res.status === 404) return { ok: false, message: "디스코드가 이 주소를 찾지 못했습니다(삭제됐거나 주소가 틀림). 웹후크를 새로 만들어 붙여넣어 주세요." };
      if (res.status === 401 || res.status === 403) return { ok: false, message: "디스코드가 이 주소의 사용을 거부했습니다. 웹후크를 새로 만들어 주세요." };
      return { ok: false, message: `디스코드가 오류로 응답했습니다(HTTP ${res.status}). 잠시 뒤 다시 시도하세요.` };
    } catch {
      return { ok: false, message: "디스코드에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요." };
    }
  }

  // --------------------------------------------------------------------------
  // [v0.59.0→v0.60.0] 소셜 로그인(구글만 — 카카오는 오너 요청으로 제거, "카카오 로그인은
  //   하지 않는다") — Supabase Auth의 OAuth 흐름을 그대로 쓴다.
  //   ⚠️ Supabase 대시보드에서 해당 provider를 켜고 Client ID/Secret을 등록해야만
  //   실제로 동작한다(오너가 구글 클라우드에서 발급받아야 하는 값 — 이 앱 코드로는
  //   대신할 수 없다). 그 전까지는 버튼을 눌러도 provider가 비활성 상태라는 오류가 뜬다.
  //   [플랫폼별 흐름] 웹(폰)은 전체 페이지 이동(리다이렉트) 방식, 데스크톱은 별도
  //   팝업 창을 띄워 리다이렉트 주소만 가로채는 방식 — 각각 electron/main.ts와
  //   web/kyletool-adapter.ts에서 platform-specific으로 이 URL/콜백을 쓴다.
  // --------------------------------------------------------------------------

  /** provider(google) 로그인 시작 주소. redirectTo는 로그인 뒤 돌아올 주소(플랫폼이 정한다). */
  authOAuthUrl(provider: "google", redirectTo: string): string {
    return `${ToolEngine.SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo)}`;
  }

  /**
   * OAuth 콜백 주소의 조각(fragment, "#" 뒤 부분 또는 그 안의 access_token=…&refresh_token=…
   * 형태 쿼리 문자열)을 받아 세션으로 적용한다. authSignIn과 동일하게 로그인 직후
   * 자동 동기화(키·매매 이력·자동매매 기록)까지 함께 한다.
   */
  async applyOAuthCallback(fragment: string): Promise<{ ok: boolean; message: string }> {
    try {
      const params = new URLSearchParams(fragment.replace(/^#/, ""));
      const accessToken = params.get("access_token");
      const errorDesc = params.get("error_description") || params.get("error");
      if (!accessToken) {
        return { ok: false, message: errorDesc ? `로그인 실패: ${errorDesc}` : "로그인 정보를 받지 못했습니다." };
      }
      // /auth/v1/user 로 이 토큰의 계정 정보(이메일 등)를 확인한다.
      const meRes = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ToolEngine.SUPABASE_ANON, Authorization: `Bearer ${accessToken}` },
      }, 10_000, "user");
      const me = (await meRes.json()) as Record<string, unknown>;
      if (!meRes.ok || !me.id) return { ok: false, message: "로그인 정보를 확인하지 못했습니다." };

      this.applySession({
        access_token: accessToken,
        refresh_token: params.get("refresh_token"),
        expires_in: params.get("expires_in"),
        user: me,
      });
      // [v0.24.0] 이메일/비밀번호 로그인과 달리 소셜 로그인은 authPassword가 없다 →
      //   토스 키·매매 이력 자동 동기화(비밀번호로 복호화)는 이 세션에서는 못 한다.
      //   대신 세션(로그인 상태)은 정상 저장되고, 설정 탭에서 이 기기에 직접 키를
      //   입력하면 그때부터는 정상적으로 클라우드에도 올라간다.
      this.persistEnv();
      return { ok: true, message: `로그인되었습니다(${this.authEmail}).` };
    } catch (e) {
      return { ok: false, message: String(e).replace(/^Error:\s*/, "") };
    }
  }

  /**
   * [v0.8.1] 지금 이 기기의 토스 키를 로그인 비밀번호로 암호화해 '내 계정' 행에 저장.
   *   RLS가 user_id=본인만 허용하므로 다른 사람은 절대 못 본다. 평문은 올라가지 않는다.
   * [v0.24.0] 인자로 비밀번호를 따로 안 받는다 — 로그인할 때 쓴 비밀번호(authPassword)를
   *   그대로 잠금 열쇠로 쓴다. [설정 저장] 시 로그인 상태면 자동으로도 호출된다(saveSettings).
   */
  async syncPushKeys(): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요(설정 탭 상단). 로그인해야 내 계정에 키를 저장할 수 있어요." };
    if (!this.authPassword) return { ok: false, message: "다시 로그인해야 동기화할 수 있습니다(비밀번호는 저장해 두지 않아요)." };
    const clientId = process.env.TOSS_CLIENT_ID ?? "";
    const clientSecret = process.env.TOSS_CLIENT_SECRET ?? "";
    const account = process.env.TOSS_ACCOUNT ?? "";
    if (!clientId || !clientSecret) return { ok: false, message: "먼저 [설정]에서 Client ID/Secret을 입력·저장한 뒤 동기화하세요." };
    try {
      const rec = await encryptSecret({ clientId, clientSecret, account }, this.authPassword);
      // upsert: 내 user_id 행이 있으면 갱신, 없으면 삽입. user_id 는 JWT의 것으로 명시(RLS with_check 통과).
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_secrets?on_conflict=user_id`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: this.authUserId, ciphertext: rec.ciphertext, salt: rec.salt, iv: rec.iv, updated_at: new Date().toISOString() }),
      }, 10_000, "capri_secrets");
      if (!res.ok) return { ok: false, message: `클라우드 저장 실패(HTTP ${res.status}). ${await res.text().catch(() => "")}`.slice(0, 160) };
      this.addJournal({ kind: "info", symbol: "-", summary: "🔐 내 토스 키를 암호화해 클라우드(내 계정)에 저장" });
      return { ok: true, message: "내 계정에 암호화 저장했습니다. 다른 기기에서 같은 계정으로 로그인만 하면 자동으로 받아집니다." };
    } catch (e) {
      return { ok: false, message: String(e).replace(/^Error:\s*/, "") };
    }
  }

  /**
   * [v0.8.1] 내 계정의 암호문을 받아 로그인 비밀번호로 복호화해 이 기기에 적용.
   *   복호화 성공 시 로컬 .env에도 저장하고 토큰을 재발급한다(즉시 사용 가능).
   * [v0.24.0] authSignIn 이 로그인 직후 자동으로 이 함수를 부른다 — 보통 사람이 직접
   *   호출할 일이 없다(문제가 있을 때 다시 시도하는 용도로만 UI에 남겨 둔다).
   */
  async syncPullKeys(): Promise<{ ok: boolean; message: string }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요(설정 탭 상단)." };
    if (!this.authPassword) return { ok: false, message: "다시 로그인해야 키를 불러올 수 있습니다(비밀번호는 저장해 두지 않아요)." };
    try {
      // RLS 덕분에 select 는 자동으로 '내 행'만 돌려준다(user_id 조건 불필요).
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_secrets?select=ciphertext,salt,iv`, {
        headers: this.authRestHeaders(token),
      }, 10_000, "capri_secrets");
      if (!res.ok) return { ok: false, message: `클라우드 조회 실패(HTTP ${res.status}).` };
      const rows = (await res.json()) as Array<{ ciphertext: string; salt: string; iv: string }>;
      if (!rows || rows.length === 0) {
        return { ok: false, message: "내 계정에 저장된 키가 없습니다. 이 기기에서 [설정]에 키를 입력·저장하면 자동으로 클라우드에도 올라갑니다." };
      }
      const payload = await decryptSecret(rows[0], this.authPassword); // 틀린 비번이면 여기서 실패
      await this.saveSettings({ mode: "live", clientId: payload.clientId, clientSecret: payload.clientSecret, account: payload.account });
      this.addJournal({ kind: "info", symbol: "-", summary: "🔓 클라우드(내 계정)에서 토스 키를 복호화해 이 기기에 적용" });
      return { ok: true, message: "내 계정에서 키를 불러와 적용했습니다. 이제 이 기기에서 바로 조회·주문이 됩니다." };
    } catch (e) {
      return { ok: false, message: String(e).replace(/^Error:\s*/, "") };
    }
  }

  // 실서버(실제 토스) 기본 주소 — 읽기전용 검증에서 실제로 200이 확인된 도메인.
  //  [교훈] 이전엔 apigw.tossinvest.com 을 썼는데 그건 틀린 주소라 모든 실서버 요청이
  //  실패했다. 반드시 아래 openapi 도메인을 쓴다(2026-07-18 실검증).
  private static readonly LIVE_BASE_URL = "https://openapi.tossinvest.com";

  /**
   * prepareBackend — 매 조회·주문 직전에 "현재 모드에 맞는 접속 상태"를 확실히 맞춘다.
   *
   * [왜 매번 맞추나? = 버그 재발 방지]
   *   예전엔 모드/주소를 여러 곳(설정 저장·백엔드 준비)에서 따로 정해서, 배지는 "연습"인데
   *   요청은 실서버로 나가는 모순이 생겼다. 이제 이 함수 하나가 "모드와 실제 접속 주소"를
   *   항상 일치시킨다(단일 진실 소스).
   *     - 연습 모드: 가짜 서버(127.0.0.1)로만. 계좌 없으면 practice 로 자동 채움.
   *     - 실서버 모드: 실제 토스(openapi)로만. 가짜 서버는 끈다.
   */
  private async prepareBackend(): Promise<void> {
    if (this.mode === "mock") {
      if (!this.mock) {
        this.mock = createMockTossServer();
        this.mockPort = await this.mock.listen();
        this.addJournal({ kind: "info", symbol: "-", summary: `연습용 가짜 토스 서버 준비 (127.0.0.1:${this.mockPort})` });
      }
      process.env.TOSS_MOCK = "true";
      process.env.TOSS_BASE_URL = `http://127.0.0.1:${this.mockPort}`;
      if (!process.env.TOSS_ACCOUNT) process.env.TOSS_ACCOUNT = "practice";
    } else {
      await this.stopMock();
      process.env.TOSS_MOCK = "false";
      process.env.TOSS_BASE_URL = ToolEngine.LIVE_BASE_URL;
    }
  }

  /**
   * assertAccountReady — 실서버 모드에서 계좌가 비어 있으면, 서버에 요청을 보내기 전에
   *   "설정 탭에서 계좌를 입력하라"고 사람이 이해할 수 있는 한국어로 막는다.
   *   [왜?] 계좌가 비면 토스가 400 missing_account 를 주는데, 그 원시 에러가 화면에
   *   그대로 노출돼 오너가 원인을 알 수 없었다(실제 발생한 버그).
   */
  private assertAccountReady(): void {
    if (this.mode === "live" && !process.env.TOSS_ACCOUNT?.trim()) {
      throw new Error(
        "계좌가 설정되지 않았습니다. [설정] 탭에서 '계좌번호(accountSeq)' 칸에 보통 1 을 입력하고 저장한 뒤 다시 시도하세요.",
      );
    }
  }

  async stopMock(): Promise<void> {
    if (this.mock) {
      await this.mock.close();
      this.mock = null;
    }
  }

  /** 연습 모드 전용: 가짜 서버 현재가 조작(익절/손절 발동 연습) */
  async mockSetPrice(symbol: string, price: number): Promise<boolean> {
    await this.prepareBackend();
    if (!this.mock) return false;
    this.mock.setPrice(symbol.toUpperCase(), Math.round(price * 100) / 100);
    return true;
  }

  // --------------------------------------------------------------------------
  // 킬 스위치: 모든 "주문" 버튼 잠금(조회·계산은 허용)
  // --------------------------------------------------------------------------
  /**
   * setKillSwitch — 비상 정지.
   *   [v0.2.5 실효화] 예전엔 "신규 주문 차단"만 했고 이미 걸린 미체결 주문은 그대로 남았다.
   *   이제 켜는 순간 **미체결 주문·조건주문을 실제로 전량 취소**한다(실주문 모드일 때).
   *   취소 자체가 실패해도 신규 차단은 유지되고, 무엇이 실패했는지 기록에 남긴다.
   */
  async setKillSwitch(on: boolean): Promise<void> {
    this.killSwitch = on;
    this.addJournal({ kind: "info", symbol: "-", summary: on ? "🔴 킬 스위치 ON — 신규 주문 전체 잠금" : "🟢 킬 스위치 OFF" });
    void this.pushLiveState(true); // [v0.61.2] 폰이 "꺼짐/켜짐" 전환을 바로 볼 수 있게 즉시 올린다
    if (!on) return;

    // 켜졌을 때: 살아있는 주문을 거둬들인다(읽기+취소). 드라이런이면 기록만.
    try {
      await this.prepareBackend();
      const [open, conds] = await Promise.all([this.openOrders(), this.conditionals()]);
      const dry = this.isDryRun();
      let done = 0;
      for (const o of open) {
        try {
          if (!dry) await cancelOrder(o.tossOrderId);
          done++;
        } catch (e) {
          this.addJournal({ kind: "info", symbol: o.symbol ?? "-", summary: `⚠️ 주문 취소 실패 ${o.tossOrderId}: ${String(e).slice(0, 80)}` });
        }
      }
      for (const c of conds) {
        try {
          if (!dry) await cancelConditionalOrder(c.conditionalOrderId);
          done++;
        } catch (e) {
          this.addJournal({ kind: "info", symbol: "-", summary: `⚠️ 조건주문 취소 실패 ${c.conditionalOrderId}: ${String(e).slice(0, 80)}` });
        }
      }
      this.addJournal({
        kind: dry ? "dryrun" : "cancel",
        symbol: "-",
        summary: `${dry ? "[드라이런] " : ""}킬 스위치: 미체결 ${open.length}건 + 조건주문 ${conds.length}건 → ${done}건 취소${dry ? " 예정(실제 전송 안 함)" : " 완료"}`,
      });
    } catch (e) {
      this.addJournal({ kind: "info", symbol: "-", summary: `⚠️ 킬 스위치 취소 처리 중 오류(신규 차단은 유지됨): ${String(e).slice(0, 100)}` });
    }
  }

  /**
   * setLiveOrders — 실주문 활성화 토글(해금). 기본은 꺼짐(잠금).
   *   [안전 설계] 켜는 행위는 반드시 사람이 화면에서 경고를 확인한 뒤에만 일어난다(UI가 보장).
   *   여기서는 상태만 바꾸고, 무엇이 바뀌었는지 기록에 크게 남긴다.
   */
  /** [v0.2.7] 오입력 방지 설정(켜기/끄기 + 임계값). 기본은 꺼짐. */
  setPriceGuard(on: boolean, pct?: number): void {
    this.priceGuardEnabled = on;
    if (typeof pct === "number" && Number.isFinite(pct) && pct > 0) this.priceGuardPct = pct;
    this.persistEnv(); // [v0.3.0] 껐다 켜도 유지
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: on ? `오입력 방지 ON (±${this.priceGuardPct}%)` : "오입력 방지 OFF — 앱이 가격으로 막지 않습니다",
    });
  }

  /** [v0.2.7] 주문 확인 팝업 건너뛰기(기본 끔 = 팝업 표시). 화면에서만 쓰지만 상태는 여기 보관. */
  setSkipConfirm(on: boolean): void {
    this.skipOrderConfirm = on;
    this.persistEnv(); // [v0.3.0] 껐다 켜도 유지
    this.addJournal({ kind: "info", symbol: "-", summary: on ? "주문 확인 팝업 건너뛰기 ON" : "주문 확인 팝업 표시 ON" });
  }

  setLiveOrders(on: boolean): void {
    this.liveOrdersEnabled = on;
    this.persistEnv(); // [v0.3.0] ★ 실주문 토글 저장 — 앱 재시작 후에도 유지(오너 최우선 요구)
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: on
        ? "🔴🔴 실주문 활성화됨 — 이제 주문 버튼을 누르면 실제 돈으로 주문이 전송됩니다"
        : "🔒 실주문 잠금(드라이런)으로 되돌림 — 주문은 모의 기록만 남습니다",
    });
  }

  // --------------------------------------------------------------------------
  // 조회(사람이 버튼 눌렀을 때만 1회)
  // --------------------------------------------------------------------------
  async quote(symbol: string): Promise<number> {
    await this.prepareBackend();
    const { price } = await getPrice(symbol.toUpperCase());
    return price;
  }

  /**
   * 환율: 토스 공식 API(1분 갱신 참고용)를 60초 캐시로 조회.
   * 실패하면 null을 돌려주고, 화면은 "수동 입력" 칸을 보여준다(사용자 확정: 자동 우선+수동 폴백).
   */
  async fx(): Promise<{ rate: number; source: "toss" | "manual" } | null> {
    if (this.fxCache && Date.now() - this.fxCache.atMs < 60_000) {
      return { rate: this.fxCache.rate, source: this.fxCache.source };
    }
    try {
      await this.prepareBackend();
      const r = await getExchangeRate("USD", "KRW");
      if (r.rate > 0) {
        this.fxCache = { rate: r.rate, atMs: Date.now(), source: "toss" };
        return { rate: r.rate, source: "toss" };
      }
      return null;
    } catch {
      return null; // 화면이 수동 입력 폴백을 띄움
    }
  }

  /** 수동 환율 입력(자동 조회 실패 시 폴백) */
  setManualFx(rate: number): void {
    if (rate > 0) this.fxCache = { rate, atMs: Date.now(), source: "manual" };
  }

  /**
   * [v0.2.9] 주문 수량 자동 계산 — 토스 API 값으로 "살 수 있는 최대 수량"과 "보유 수량"을 함께 준다.
   *
   * [무엇을 조회하나?]
   *   - buying-power : 매수 가능 금액(USD)
   *   - commissions  : 수수료율(미국). 수수료 때문에 1주가 모자라는 사고를 막으려고 반영한다.
   *   - holdings     : 보유 종목 목록 → 이 종목을 몇 주 갖고 있는지
   *   - sellable-quantity : 지금 팔 수 있는 수량(보유 중 묶인 물량 제외)
   *
   * [수수료 단위 주의] 토스 응답이 시장마다 표기가 다르다(KR 0.00015=비율, US 0.1=퍼센트).
   *   그래서 "값이 0.01보다 크면 퍼센트 표기"로 보고 100으로 나눈다. 게다가 최대 수량은
   *   여유(0.5%)를 빼고 내림 계산해, 계산 오차로 주문이 거부되는 일을 막는다.
   *
   * [강제하지 않는다] 이 값은 "참고 표시"일 뿐이다. 오너가 더 큰 수량을 넣어도 막지 않는다.
   */
  async orderCapacity(symbol: string, price?: number): Promise<{
    buyingPowerUsd: number | null;
    commissionRate: number | null;
    maxBuyQty: number | null;
    heldQty: number | null;
    sellableQty: number | null;
    // [v0.3.0] 세션별 시드 제안
    session: Session;
    sessionPct: number; //   이번 세션에 적용되는 비율(%)
    seedBasis: "auto" | "fixed";
    seedUsd: number | null; // 시드 기준 금액(달러)
    seedQty: number | null; // 시드 비율로 살 수 있는 제안 수량
  }> {
    const sym = symbol.toUpperCase();
    const session = getSession(DateTime.now().setZone("Asia/Seoul"));
    const sessionPct = this.sessionPctFor(session);
    const out = {
      buyingPowerUsd: null as number | null,
      commissionRate: null as number | null,
      maxBuyQty: null as number | null,
      heldQty: null as number | null,
      sellableQty: null as number | null,
      session,
      sessionPct,
      seedBasis: this.seedBasis,
      seedUsd: null as number | null,
      seedQty: null as number | null,
    };
    try {
      await this.prepareBackend();
    } catch {
      return out; // 접속 준비 실패해도 화면은 "조회 불가"로만 표시
    }

    // 1) 매수 가능 금액
    try {
      const bp = await getBuyingPower("USD");
      if (Number.isFinite(bp.buyingPowerUsd)) {
        out.buyingPowerUsd = bp.buyingPowerUsd;
        this.buyingPowerUsd = bp.buyingPowerUsd;
      }
    } catch {
      /* 무시 */
    }

    // 2) 수수료율(미국 시장 기준)
    try {
      const raw = (await getCommissions()) as unknown;
      const arr = Array.isArray(raw) ? raw : [];
      const us = arr.find((x) => (x as Record<string, unknown>)?.marketCountry === "US") as Record<string, unknown> | undefined;
      const v = us ? Number(us.commissionRate) : NaN;
      if (Number.isFinite(v)) out.commissionRate = v > 0.01 ? v / 100 : v; // 퍼센트 표기 보정
    } catch {
      /* 무시 */
    }

    // 3) 최대 매수 수량 = 매수가능금액 ÷ (가격 × (1+수수료)) — 여유 0.5% 빼고 내림
    if (out.buyingPowerUsd !== null && price && price > 0) {
      const fee = out.commissionRate ?? 0;
      const perShare = price * (1 + fee);
      const usable = out.buyingPowerUsd * 0.995; // 안전 여유
      out.maxBuyQty = Math.max(0, Math.floor(usable / perShare));
    }

    // 4) 보유 수량(holdings에서 이 종목만)
    try {
      const h = (await getHoldings()) as Record<string, unknown>;
      const items = (h?.items as Array<Record<string, unknown>>) ?? [];
      const mine = items.find((it) => String(it.symbol).toUpperCase() === sym);
      if (mine) {
        const q = Number(mine.quantity);
        if (Number.isFinite(q)) out.heldQty = q;
      } else {
        out.heldQty = 0; // 목록에 없으면 미보유
      }
    } catch {
      /* 무시 */
    }

    // 5) 매도 가능 수량
    try {
      const r = await getSellable(sym);
      if (Number.isFinite(r.sellableQty)) out.sellableQty = r.sellableQty;
    } catch {
      /* 무시 */
    }

    // 6) [v0.3.0] 세션별 시드 제안 수량
    //   시드 기준: auto=매수가능금액(방금 조회한 값), fixed=오너가 정한 고정 금액.
    out.seedUsd = this.seedBasis === "fixed" ? this.seedFixedUsd : out.buyingPowerUsd;
    out.seedQty = computeSeedQty(out.seedUsd, sessionPct, price, out.commissionRate);

    return out;
  }

  /**
   * [v0.3.0] 계좌 요약 — 상단 상시 바에 쓸 "예수금 + 보유 총손익"을 가볍게 조회한다.
   *   holdings 응답 맨 위에 총손익(profitLoss)이 이미 들어 있어, 종목별 시세를 다시 안 불러도 된다.
   *   실패는 null로 두고 화면이 "조회 불가"로 표시(주문 흐름과 무관, 표시용).
   */
  async accountSummary(): Promise<{ buyingPowerUsd: number | null; totalPnlUsd: number | null; totalPnlRate: number | null }> {
    const out = { buyingPowerUsd: null as number | null, totalPnlUsd: null as number | null, totalPnlRate: null as number | null };
    try {
      await this.prepareBackend();
    } catch {
      return out;
    }
    try {
      const bp = await getBuyingPower("USD");
      if (Number.isFinite(bp.buyingPowerUsd)) {
        out.buyingPowerUsd = bp.buyingPowerUsd;
        this.buyingPowerUsd = bp.buyingPowerUsd;
      }
    } catch {
      /* 무시 */
    }
    try {
      const h = (await getHoldings()) as Record<string, unknown>;
      // 응답 구조: { profitLoss: { amount: { usd }, rate }, ... }
      const pl = h?.profitLoss as Record<string, unknown> | undefined;
      const amt = pl?.amount as Record<string, unknown> | undefined;
      const usd = Number(amt?.usd);
      const rate = Number(pl?.rate);
      if (Number.isFinite(usd)) out.totalPnlUsd = usd;
      if (Number.isFinite(rate)) out.totalPnlRate = rate * 100; // 0.025 → 2.5%
    } catch {
      /* 무시 */
    }
    return out;
  }

  /**
   * [v0.2.8] 보유(매도 가능) 수량 조회 — 조건주문 수량 기본값으로 쓴다.
   *   계산기의 "살 수량"과 "이미 보유한 수량"은 다르므로, 조건주문은 보유수량이 기본이어야 한다.
   */
  async sellableQty(symbol: string): Promise<number | null> {
    try {
      await this.prepareBackend();
      const r = await getSellable(symbol.toUpperCase());
      return Number.isFinite(r.sellableQty) ? r.sellableQty : null;
    } catch {
      return null; // 조회 실패해도 막지 않는다(사용자가 직접 입력)
    }
  }

  async refreshBuyingPower(): Promise<number | null> {
    try {
      await this.prepareBackend();
      this.assertAccountReady();
      const bp = await getBuyingPower("USD");
      this.buyingPowerUsd = bp.buyingPowerUsd;
      return this.buyingPowerUsd;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // ★ 계산기: Capri매매기법 3종 + 수동 (설계서 M1의 검증된 함수를 그대로 호출)
  // --------------------------------------------------------------------------
  calc(req: CalcRequest): CalcResult {
    const tp = req.tpPct;
    const sl = req.slPct;

    switch (req.technique) {
      case "split3": {
        if (req.baseClose == null || req.ema200 == null) throw new Error("삼분할: 전봉 종가와 EMA200을 입력하세요.");
        // 진입 필터(gap>0) 위반이면 calcSplit3가 명확한 한국어 에러를 던진다 → 그대로 화면에.
        const { splits } = calcSplit3(req.baseClose, req.ema200, tp, sl);
        return {
          technique: "split3",
          levels: splits.map((s: SplitOrder) => ({ level: s.level, entry: s.entry, tp: s.tp, sl: s.sl })),
          note: "전봉종가~EMA200 구간 3등분. 각 분할은 독립된 한 판(사양서).",
        };
      }
      case "orderbook": {
        if (req.wallPrice == null) throw new Error("호가창: 매수벽 가격을 입력하세요.");
        const o = calcOrderbook(req.wallPrice, getTick(req.wallPrice), tp, sl);
        return {
          technique: "orderbook",
          levels: [{ level: 1, entry: o.entry, tp: o.tp!, sl: o.sl! }],
          note: "진입 = 매수벽 + 1틱. 벽 판단은 사람 몫(정량 기준 미확정).",
        };
      }
      case "candle": {
        if (req.barOpen == null) throw new Error("캔들: 현재봉 시가를 입력하세요.");
        const o = calcCandle(req.barOpen, getTick(req.barOpen), tp, sl);
        return {
          technique: "candle",
          levels: [{ level: 1, entry: o.entry, tp: o.tp!, sl: o.sl! }],
          note: "진입 = 현재봉 시가 − 3틱. ★전봉이 양봉일 때만 쓰는 기법(확인은 사람 몫).",
        };
      }
      case "manual": {
        if (req.entry == null) throw new Error("수동: 진입가를 입력하세요.");
        const entry = roundPrice(req.entry);
        return {
          technique: "manual",
          levels: [{ level: 1, entry, tp: roundPrice(entry * (1 + tp / 100)), sl: roundPrice(entry * (1 - sl / 100)) }],
          note: "직접 입력한 진입가 기준 익절/손절 계산.",
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // 주문(전부 사람이 확인 팝업을 누른 뒤에만 호출됨 — UI가 보장)
  // --------------------------------------------------------------------------

  /**
   * 주문 공통 게이트: 킬스위치 확인 + (진입가에 한해) 가격 이상 검사.
   *
   * [왜 진입가만 검사하나?] 익절/손절 감시가는 기법상 "원래 현재가에서 먼 값"이다
   *   (손절 기본 −10%). 여기에 ±5%를 들이대면 정상 주문이 다 막힌다 — v1 실검증에서
   *   확인된 교훈(progress.md). 익절/손절은 대신 OCO 규칙(익절>현재가>손절)으로 검증.
   * [한도 ±15%인 이유] 삼분할 3분할(EMA200)은 깊은 눌림 대기 주문이라 5%보다 멀 수
   *   있다. 오타(자릿수 실수)는 보통 수십% 이상 어긋나므로 15%면 오타는 잡고
   *   전략 주문은 통과시킨다(제안값 — 오너가 조정 가능).
   */
  private async orderGate(symbol: string, entryPrices: number[] = []): Promise<number> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있어 주문이 잠겨 있습니다.");
    await this.prepareBackend();
    this.assertAccountReady(); // 실서버인데 계좌 미설정이면 친절한 안내로 막음
    const { price: cur } = await getPrice(symbol.toUpperCase());
    // [현재가 방어] cur가 0/음수/NaN이면 아래 편차 계산이 0으로 나누기(Infinity)나
    //   NaN이 되어 오차단·오통과가 생긴다(프리마켓 무거래 등). 먼저 막는다.
    if (!Number.isFinite(cur) || cur <= 0) {
      // [막지 않는다] 현재가를 못 가져와도 주문은 보낼 수 있다(가격은 사용자가 지정). 가드만 생략.
      this.addJournal({ kind: "info", symbol, summary: "⚠️ 참고: 현재가 확인 실패(오입력 방지 검사 생략). 주문은 그대로 전송합니다." });
      return 0;
    }
    // [오입력 방지] 기본은 꺼져 있어 어떤 가격이든 통과한다(오너 결정).
    //   설정 탭에서 켠 경우에만, 사용자가 정한 임계값으로 경고 차단한다.
    if (this.priceGuardEnabled && cur > 0) {
      for (const p of entryPrices) {
        const dev = Math.abs((p - cur) / cur) * 100;
        if (dev > this.priceGuardPct) {
          throw new Error(
            `[오입력 방지 — 설정에서 켜둔 기능] 주문을 보내지 않았습니다.
` +
              `· 입력한 진입가: $${p}
` +
              `· 현재가: $${cur}
` +
              `· 차이: ${dev.toFixed(1)}% (내가 정한 한도 ±${this.priceGuardPct}%)

` +
              `의도한 가격이 맞다면 설정 탭에서 이 기능을 끄거나 한도를 넓히세요.`,
          );
        }
      }
    }
    return cur;
  }

  /**
   * assertAffordable — [B4 수정] 매수 주문이 "매수 가능 금액"을 넘지 않는지 실제로 막는다.
   *
   * [왜 필요했나?] 사전검증 함수(preflightBuyCheck)는 있었지만 주문 버튼이 부르지 않아
   *   무용지물이었다(pre-flight에서 발견). 돈이 모자란 주문은 토스가 거부하는데, 그 전에
   *   우리가 먼저 한국어로 막아야 사용자가 원인을 안다.
   *
   * [연습 모드는 건너뜀] 가짜 서버의 잔고는 의미가 없으므로 실서버에서만 검사한다.
   */
  private async assertAffordable(price: number, quantity: number): Promise<void> {
    if (this.mode !== "live") return;
    const need = price * quantity;
    let available: number;
    try {
      const bp = await getBuyingPower("USD");
      available = bp.buyingPowerUsd;
      this.buyingPowerUsd = available; // 화면 표시용 캐시도 갱신
    } catch {
      // [막지 않는다] 참고용 검사일 뿐이므로 조회 실패로 주문을 막지 않는다.
      return;
    }
    if (!Number.isFinite(available)) return; // 응답 이상으로도 막지 않는다.
    if (need > available) {
      // [v0.2.8 — 막지 않는다] 잔고 판단도 토스가 한다. 경고만 남기고 그대로 전송한다.
      this.addJournal({
        kind: "info",
        symbol: "-",
        summary: `⚠️ 참고: 필요 $${need.toFixed(2)} > 매수가능 $${available.toFixed(2)} — 토스가 거부할 수 있습니다. 그래도 전송합니다.`,
      });
    }
  }

  /**
   * 이 주문이 실제로 나가도 되는가?
   *
   * [해금 구조 — v0.2.5]
   *   예전엔 "실서버 모드면 무조건 드라이런"이라 코드를 다시 빌드해야만 실주문이 가능했다.
   *   이제는 사용자가 설정 탭에서 "실주문 활성화"를 명시적으로 켰을 때만(liveOrdersEnabled)
   *   실주문이 나간다. 기본값은 꺼짐(잠금)이라, 실수로 돈이 나갈 일은 없다.
   *   - 연습 모드: 항상 실제 왕복(가짜 서버라 돈과 무관)
   *   - 실서버 모드 + 토글 OFF: 드라이런(모의 기록만)  ← 기본
   *   - 실서버 모드 + 토글 ON : 진짜 주문 전송
   */
  private isDryRun(): boolean {
    if (this.mode !== "live") return false; // 연습 모드는 가짜 서버라 실제 왕복
    return !this.liveOrdersEnabled; // 실서버는 토글을 켠 경우에만 실주문
  }

  /** ① 진입: 일반 지정가 매수 */
  async placeEntry(spec: {
    symbol: string;
    price: number;
    quantity: number;
    /** [v0.2.10] 이 주문의 매매기법 근거(화면이 함께 보냄). 없어도 주문은 정상 진행된다. */
    rationale?: RationaleInput;
  }): Promise<JournalEntry> {
    this.assertNotSystemPaused("신규 진입 주문"); // [v0.44.0]
    const symbol = spec.symbol.toUpperCase();
    {
      const problems = checkSimpleOrder({ quantity: spec.quantity, orderType: "LIMIT", price: spec.price }); // [v0.69.2] 주문 전 검증 관문
      if (problems.length) this.blockOrder("매수", symbol, problems);
    }
    const cur = await this.orderGate(symbol, [spec.price]);
    // [B4] 매수 가능 금액 초과면 여기서 막는다(실서버에서만 검사).
    await this.assertAffordable(spec.price, spec.quantity);

    // 주문번호(clientOrderId)를 **미리** 만든다. 근거 기록의 열쇠로 써야 하므로
    //   createOrder 호출 안에서 즉석 생성하면 우리가 그 값을 알 수 없다.
    const clientOrderId = makeClientOrderId(`tool${symbol}${DateTime.now().toFormat("HHmmss")}`, 1, "entry");

    if (this.isDryRun()) {
      this.saveRationale(spec.rationale, {
        clientOrderId,
        kind: "entry",
        symbol,
        quantity: spec.quantity,
        priceAtOrder: cur,
        dryRun: true,
      });
      void this.recordEntry(symbol, spec.price, this.currentMode(), spec.quantity); // [v0.7.0] 진입 체결강도 자동 스냅샷(주문과 무관)
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 진입 지정가 매수 ${symbol} $${spec.price} × ${spec.quantity}주 (실주문 잠금 — 실제 전송 안 함)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const o = await this.inflight(`매수 주문 전송 ${symbol}`, () => createOrder({
      symbol,
      side: "BUY",
      orderType: "LIMIT",
      price: spec.price,
      quantity: spec.quantity,
      clientOrderId,
    }));
    // 주문이 실제로 접수된 뒤에 근거를 남긴다(실패한 주문의 근거는 남기지 않는다).
    this.saveRationale(spec.rationale, {
      clientOrderId,
      kind: "entry",
      symbol,
      quantity: spec.quantity,
      priceAtOrder: cur,
      dryRun: false,
      tossOrderId: o.tossOrderId,
    });
    void this.recordEntry(symbol, spec.price, this.currentMode(), spec.quantity); // [v0.7.0] 진입 체결강도 자동 스냅샷(주문과 무관)
    return this.addJournal({
      kind: "entry",
      symbol,
      summary: `진입 지정가 매수 접수 ${symbol} $${spec.price} × ${spec.quantity}주 (주문번호 ${o.tossOrderId}, 상태 ${o.status})`,
      detail: o,
    });
  }

  /** ② 익절+손절 동시(OCO): 보유 중일 때. 토스 서버가 감시 — 앱 꺼도 작동. */
  async placeOco(spec: {
    symbol: string;
    quantity: number;
    tpTrigger: number; // 익절 감시가(현재가보다 위)
    tpPrice: number; //   익절 지정가
    slTrigger: number; // 손절 감시가(현재가보다 아래)
    slPrice: number; //   손절 지정가(감시가보다 살짝 아래 = 즉시 체결 노림)
    expireDate: string; // YYYY-MM-DD
    /** [v0.2.10] 이 조건주문의 매매기법 근거(화면이 함께 보냄). 없어도 주문은 정상 진행. */
    rationale?: RationaleInput;
    /** [v0.69.2] 기준(체결)가 — 있으면 익절>기준가>손절 방향을 검사한다. */
    entry?: number | null;
    /** [v0.69.2] 설정값 대조 — 있으면 가격이 설정 %대로 계산됐는지 검사한다(자동매매 경로). */
    expect?: SanityExpect;
  }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    // [v0.69.2] 주문 전 검증 관문(모든 조건주문의 단일 관문): 0·음수·방향 뒤집힘·설정과 불일치면 보내지 않는다.
    {
      const problems = checkBracketPrices({ quantity: spec.quantity, tpTrigger: spec.tpTrigger, tpPrice: spec.tpPrice, slTrigger: spec.slTrigger, slPrice: spec.slPrice, entry: spec.entry, expect: spec.expect });
      if (spec.expect) problems.push(...checkPercentSettings(spec.expect.tpPct, spec.expect.slPct));
      if (problems.length) this.blockOrder("익절/손절(OCO)", symbol, problems);
    }
    const cur = await this.orderGate(symbol); // 익절/손절 감시가는 ±검사 대신 아래 OCO 규칙으로 검증
    // 스펙 규칙 사전 검증(서버 400 전에 친절한 한국어로)
    if (!isWithinOcoBand(cur, spec.tpTrigger, spec.slTrigger)) {
      // [v0.2.8 — 막지 않는다] 토스 스펙상 OCO는 "익절>현재가>손절"을 요구하지만 그 판단은 토스가 한다.
      //   우리가 미리 막으면 시세가 움직이는 순간 오너가 기회를 놓친다. 경고만 남기고 그대로 전송.
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ 참고: 토스 OCO 규칙(익절 $${spec.tpTrigger} > 현재가 $${cur} > 손절 $${spec.slTrigger})과 어긋납니다. 그래도 전송합니다 — 거부되면 토스 응답을 보여드립니다.`,
      });
    }

    // 근거 기록의 열쇠. 미리 만들어 두고 주문·기록에 같은 값을 쓴다(멱등키 겸용).
    const clientOrderId = makeClientOrderId(`oco${symbol}${DateTime.now().toFormat("HHmmss")}`, 1, "oco");

    if (this.isDryRun()) {
      this.saveRationale(spec.rationale, {
        clientOrderId,
        kind: "oco",
        symbol,
        quantity: spec.quantity,
        priceAtOrder: cur,
        dryRun: true,
      });
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] OCO 등록 ${symbol} ${spec.quantity}주: 익절 $${spec.tpTrigger}↑ / 손절 $${spec.slTrigger}↓ (실주문 잠금)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const c = await this.inflight(`OCO 등록 ${symbol}`, () => createConditionalOrder({
      symbol,
      type: "OCO",
      quantity: spec.quantity,
      orderType: "LIMIT",
      expireDate: spec.expireDate,
      first: { orderSide: "SELL", triggerPrice: spec.tpTrigger, orderPrice: spec.tpPrice },
      second: { orderSide: "SELL", triggerPrice: spec.slTrigger, orderPrice: spec.slPrice },
      // [B5] 멱등키: 네트워크 재시도로 조건주문이 두 번 등록되는 걸 막는다(진입 주문과 동일 원칙).
      clientOrderId,
    }));
    this.saveRationale(spec.rationale, {
      clientOrderId,
      kind: "oco",
      symbol,
      quantity: spec.quantity,
      priceAtOrder: cur,
      dryRun: false,
      tossOrderId: c.conditionalOrderId,
    });
    return this.addJournal({
      kind: "oco",
      symbol,
      summary: `OCO 등록 완료 ${symbol} ${spec.quantity}주: 익절 $${spec.tpTrigger} / 손절 $${spec.slTrigger} (번호 ${c.conditionalOrderId}) — 토스 서버가 감시, 앱 꺼도 작동`,
      detail: c,
    });
  }

  /**
   * ③ [v0.3.2 부활] 진입+익절(OTO) — "사면서 익절까지 한 번에" (손절은 담지 않음, 오너가 수동).
   *
   * [OTO가 뭐길래?] One-Triggers-the-Other. first(진입 매수)가 체결되면 그때부터 second(익절 매도)
   *   감시가 시작된다. 즉 "이 가격에 사고, 사지면 이 가격에 팔아라"를 한 주문으로 예약한다.
   *   토스 앱에서 오너가 손으로 하던 "조건 구매 후 판매"가 바로 이것.
   *
   * [왜 미보유여도 되나?] OTO의 first는 '매수(BUY)'다. 아직 주식이 없어도 사는 주문이므로,
   *   보유가 있어야 하는 OCO(둘 다 매도)와 달리 0주에서도 등록된다.
   *
   * [손절은 왜 안 담나?] 오너 지시. OTO는 다리가 2개뿐(first/second)이라 익절·손절을 동시에 못 담는다.
   *   그래서 여기선 익절만 예약하고, 손절은 오너가 체결 후 수동으로 건다(확인 팝업에 명시).
   *
   * [스펙(공식 openapi.json 확인)]
   *   type=OTO, orderType=LIMIT(지정가만), quantity/orderType/expireDate 그룹 공통,
   *   first  = { orderSide:"BUY",  triggerPrice:진입가, orderPrice:진입가 }
   *   second = { orderSide:"SELL", triggerPrice:익절가, orderPrice:익절가 }
   *   clientOrderId(멱등키)로 중복 등록 방지.
   */
  async placeOto(spec: {
    symbol: string;
    quantity: number;
    entryTrigger: number; // 진입 감시가(현재가 이하로 닿으면 매수)
    entryPrice: number; //   진입 지정가
    tpTrigger: number; //    익절 감시가(진입 체결 후, 이 가격 닿으면 매도)
    tpPrice: number; //      익절 지정가
    expireDate: string; //   YYYY-MM-DD
    rationale?: RationaleInput;
  }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    // [v0.54.0 긴급 수정 — 오너 보고 "프로퓨사가 현재가 대비 터무니없이 높은 가격에 조건주문이
    //   걸림"] 이 함수는 그동안 orderGate()를 가격 인자 없이 불러(`orderGate(symbol)`), [설정 →
    //   주문 편의·안전 옵션]에서 오너가 "오입력 방지"(현재가와 너무 동떨어진 가격이면 주문을
    //   막는 안전장치, priceGuardEnabled)를 켜 놨어도 이 OTO(예약 매수+익절) 경로만은 그 검사를
    //   아예 받지 않았다 — placeBracketCore(수동 브라켓·자동매매 진입)는 이미
    //   `orderGate(symbol, [spec.price])`로 진입가를 검사받고 있었는데, 이 함수만 빠져 있던
    //   구멍이었다. 진입가·익절가 둘 다 넘겨 같은 보호를 받게 한다(켜져 있을 때만 실제로
    //   차단되며, 기본은 여전히 꺼짐 — 오너 결정 유지, 동작 변화 없음).
    {
      // [v0.69.2] 주문 전 검증 관문 — 0·음수, 익절가가 진입가 이하(방향 뒤집힘)는 보내지 않는다.
      const problems = [...checkSimpleOrder({ quantity: spec.quantity, orderType: "LIMIT", price: spec.entryPrice })];
      for (const [n, v] of [["진입 감시가", spec.entryTrigger], ["익절 감시가", spec.tpTrigger], ["익절 지정가", spec.tpPrice]] as Array<[string, number]>) {
        if (!(Number.isFinite(v) && v > 0)) problems.push(`${n}가 0이거나 음수·비정상 값입니다(${v}).`);
      }
      if (Number.isFinite(spec.tpTrigger) && Number.isFinite(spec.entryTrigger) && spec.tpTrigger > 0 && spec.entryTrigger > 0 && !(spec.tpTrigger > spec.entryTrigger)) {
        problems.push(`익절 감시가($${spec.tpTrigger})가 진입가($${spec.entryTrigger})보다 높지 않습니다.`);
      }
      if (problems.length) this.blockOrder("진입+익절(OTO)", symbol, problems);
    }
    const cur = await this.orderGate(symbol, [spec.entryPrice, spec.tpPrice]);
    // [막지 않는다] 통상 진입가는 현재가 이하, 익절가는 진입가 위다. 어긋나도 전송하고 토스 판단에 맡긴다.
    if (!(spec.tpTrigger > spec.entryTrigger)) {
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ 참고: 익절가 $${spec.tpTrigger} 가 진입가 $${spec.entryTrigger} 보다 높지 않습니다. 그래도 전송합니다 — 거부되면 토스 응답을 보여드립니다.`,
      });
    }

    // 근거 기록 열쇠 겸 멱등키(중복 전송 방지). 미리 만들어 주문·기록에 같은 값을 쓴다.
    const clientOrderId = makeClientOrderId(`oto${symbol}${DateTime.now().toFormat("HHmmss")}`, 1, "oto");

    if (this.isDryRun()) {
      this.saveRationale(spec.rationale, {
        clientOrderId,
        kind: "oto",
        symbol,
        quantity: spec.quantity,
        priceAtOrder: cur,
        dryRun: true,
      });
      void this.recordEntry(symbol, spec.entryPrice, this.currentMode(), spec.quantity); // [v0.7.0] 진입(OTO) 체결강도 자동 스냅샷
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] OTO 등록 ${symbol} ${spec.quantity}주: 진입 $${spec.entryPrice} → 익절 $${spec.tpPrice} (손절 미포함·실주문 잠금)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const c = await this.inflight(`OTO 등록 ${symbol}`, () => createConditionalOrder({
      symbol,
      type: "OTO",
      quantity: spec.quantity,
      orderType: "LIMIT",
      expireDate: spec.expireDate,
      first: { orderSide: "BUY", triggerPrice: spec.entryTrigger, orderPrice: spec.entryPrice },
      second: { orderSide: "SELL", triggerPrice: spec.tpTrigger, orderPrice: spec.tpPrice },
      clientOrderId,
    }));
    this.saveRationale(spec.rationale, {
      clientOrderId,
      kind: "oto",
      symbol,
      quantity: spec.quantity,
      priceAtOrder: cur,
      dryRun: false,
      tossOrderId: c.conditionalOrderId,
    });
    void this.recordEntry(symbol, spec.entryPrice, this.currentMode(), spec.quantity); // [v0.7.0] 진입(OTO) 체결강도 자동 스냅샷
    return this.addJournal({
      kind: "oto",
      symbol,
      summary: `OTO 등록 완료 ${symbol} ${spec.quantity}주: 진입 $${spec.entryPrice} 체결 시 → 익절 $${spec.tpPrice} 자동 매도 (번호 ${c.conditionalOrderId}) — 손절 미포함, 토스 서버가 감시`,
      detail: c,
    });
  }

  /**
   * ④ [v0.25.0] 매수+익절+손절 한 번에("브라켓 주문").
   *
   * [왜 OTO/OCO 하나로 안 되나 — 오너 질문에 대한 답]
   *   토스 조건주문(OCO/OTO) 스펙은 다리(leg)가 first/second **최대 2개**뿐이다(위 OTO 주석 참고,
   *   공식 openapi.json으로 이미 확인됨). "매수+익절+손절"은 다리가 3개라 토스 서버가 한 번의
   *   조건주문으로 못 받는다 — PC 화면에서 못 찾은 게 아니라 API 자체의 제약이다. 토스 모바일
   *   앱이 "한 번에" 거는 것처럼 보여도, 내부적으로는 ①매수 주문 ②체결 확인 ③OCO(익절+손절) 등록,
   *   이렇게 최소 2단계일 수밖에 없다(OCO는 실제 보유가 있어야만 등록되기 때문).
   *
   * [그래서 이 기능이 하는 일]
   *   ①진입 지정가 매수를 접수하고 ②그 주문이 체결되는지 이 프로그램이 지켜보다가(최대
   *   watchMinutes분, 기본 15분) ③체결되면 즉시 OCO(익절+손절)를 자동으로 등록한다. 사람이 미리
   *   정한 값(진입가·익절가·손절가·수량)을 그대로 실행할 뿐이라 "판단은 사람, 실행은 기계"
   *   원칙에 어긋나지 않는다.
   *
   * [⚠️ "즉시"의 실제 의미 — 완전한 무지연(0초)은 불가능함, 반드시 알아야 함]
   *   토스 주문 API에는 "체결됐다"고 먼저 알려주는 실시간 알림(웹소켓·푸시) 채널이 없다(공식
   *   openapi.json에도, 이 코드베이스 전체에도 그런 기능은 없음 — 조사 완료). 심지어 주문을 낼 때
   *   받는 응답에도 상태값이 안 들어있고(생성 응답은 orderId뿐), 상태는 오직 "단건 조회"를
   *   반복해서 물어봐야만(폴링) 알 수 있다. 그래서 이 기능도 어쩔 수 없이 주기적으로 "체결됐나요?"
   *   하고 물어보는 방식이며, **그 확인 간격만큼은 항상 지연이 생긴다.** 아래 watchAndBracket이
   *   그 지연을 최대한 줄이도록 "진입 직후 1분은 1초 간격으로 빠르게, 그 이후엔 5초 간격으로
   *   느슨하게" 확인한다(v0.25.1) — 실전에서 체감상 "거의 즉시"에 가깝지만, 수학적으로 정확히
   *   0초는 아니다(최악의 경우 최대 약 1초).
   *
   * [⚠️ 또 다른 중요한 한계 — 반드시 알아야 함]
   *   이 감시는 **이 프로그램이 켜져 있는 동안만** 작동한다. OCO 등록 전에 앱을 끄거나 컴퓨터가
   *   잠들면, 체결이 돼도 손절/익절이 자동으로 걸리지 않는다(진입 주문 자체는 토스에 그대로
   *   남아 있다). 정해진 시간 안에 체결이 안 되면 조용히 감시를 멈추고 알림만 남긴다(진입은 취소
   *   하지 않는다 — 취소는 사람이 판단할 일).
   */
  async placeBracket(spec: BracketSpec): Promise<JournalEntry> {
    const { entryJournal, watchPromise } = await this.placeBracketCore(spec);
    // 화면(수동) 버튼 경로: 최대 watchMinutes만큼 걸릴 수 있는 감시를 기다리지 않는다(기존 동작 그대로).
    //   [v0.26.0] 자동매매 경로(startAutoTrade)는 이 watchPromise를 직접 기다려 OCO 등록 여부를
    //   알아내야 하므로 placeBracketCore를 따로 호출한다(아래 autoTradeTick 참고).
    if (watchPromise) void watchPromise;
    return entryJournal;
  }

  /**
   * [v0.60.3] createOrder가 모호하게(네트워크 순단·타임아웃 등) 실패했을 때, 실제로는
   *   토스에 접수됐을 가능성을 clientOrderId(멱등키)로 직접 확인한다 — OPEN(미체결)을
   *   먼저 보고, 없으면 CLOSED(체결/취소 등 종료)까지 본다(순간 체결됐을 수도 있어서).
   *   조회 자체가 실패해도(같은 순단이 계속될 수 있음) 예외를 던지지 않고 그냥 "못
   *   찾음"으로 취급한다 — 호출부가 원래 오류로 안전하게 폴백한다.
   */
  private async findOrderByClientOrderId(clientOrderId: string, symbol: string): Promise<OrderResponse | null> {
    for (const status of ["OPEN", "CLOSED"] as const) {
      try {
        const r = await listOrders({ status, symbol });
        const found = r.orders.find((o) => o.clientOrderId === clientOrderId);
        if (found) return found;
      } catch {
        /* 이 상태 조회 자체가 실패해도 다음 상태로 계속 확인 */
      }
    }
    return null;
  }

  /**
   * placeBracket의 실제 로직(공용 코어). placeBracket(수동 버튼)과 자동매매 경로가 함께 쓴다.
   *   [v0.26.0] 자동매매는 watchPromise를 끝까지 기다려 "OCO가 실제로 등록됐는지, 등록됐다면
   *   그 조건주문 번호가 뭔지"를 알아야 포지션을 추적할 수 있어 이렇게 분리했다.
   */
  private async placeBracketCore(spec: BracketSpec): Promise<{ entryJournal: JournalEntry; watchPromise: Promise<WatchAndBracketResult> | null }> {
    this.assertNotSystemPaused("신규 진입 주문"); // [v0.44.0] 수동 브라켓 주문 + 자동매매 진입 공용 경로
    const symbol = spec.symbol.toUpperCase();
    // [v0.69.2] 주문 전 검증 관문 — 매수가 나가기 "전에" 익절/손절 계산이 정상인지 확인한다(체결 뒤에야 거절당해 무보호로 남는 일 방지).
    {
      const problems = [
        ...checkSimpleOrder({ quantity: spec.quantity, orderType: "LIMIT", price: spec.price }),
        ...checkBracketPrices({
          quantity: spec.quantity, tpTrigger: spec.tpTrigger, tpPrice: spec.tpPrice, slTrigger: spec.slTrigger, slPrice: spec.slPrice, entry: spec.price,
          expect: spec.autoPlan ? { basis: spec.price, tpPct: spec.autoPlan.tpPct, slPct: spec.autoPlan.slPct, slMode: spec.autoPlan.slMode } : undefined,
        }),
        ...(spec.autoPlan ? checkPercentSettings(spec.autoPlan.tpPct, spec.autoPlan.slPct) : []),
      ];
      if (problems.length) this.blockOrder("진입(매수+익절/손절)", symbol, problems);
    }
    const cur = await this.orderGate(symbol, [spec.price]);
    await this.assertAffordable(spec.price, spec.quantity);

    const clientOrderId = makeClientOrderId(`brk${symbol}${DateTime.now().toFormat("HHmmss")}`, 1, "entry");

    if (this.isDryRun()) {
      // 드라이런은 실제 체결이 없으니(연습·실주문잠금 공통) 진입+조건주문을 한 번에 시뮬레이션한다.
      this.saveRationale(spec.rationale, { clientOrderId, kind: "entry", symbol, quantity: spec.quantity, priceAtOrder: cur, dryRun: true });
      void this.recordEntry(symbol, spec.price, this.currentMode(), spec.quantity);
      this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 진입 매수 ${symbol} $${spec.price} × ${spec.quantity}주 접수(연습)`,
      });
      const entryJournal = this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 체결 시뮬레이션 → OCO 등록 ${symbol} ${spec.quantity}주: 익절 $${spec.tpTrigger}↑ / 손절 $${spec.slTrigger}↓ (실주문 잠금 — 매수+익절+손절 한번에)`,
        detail: { ...spec, clientOrderId },
      });
      return { entryJournal, watchPromise: null };
    }

    let o: OrderResponse;
    try {
      o = await this.inflight(`매수 주문 전송 ${symbol}`, () => createOrder({ symbol, side: "BUY", orderType: "LIMIT", price: spec.price, quantity: spec.quantity, clientOrderId }));
    } catch (e) {
      // [v0.60.3 긴급 — 오너 실사용 보고: "매수 주문이 토스에 실제로 접수됐는데 카프리가
      //   추적을 포기해버림(주문은 그대로 남는데 카프리 혼자 사라짐)"] createOrder 요청
      //   자체가 실패해도, 그게 "토스가 진짜로 거부했다"인지 "요청은 갔는데 응답만 못
      //   받았다(네트워크 순단·타임아웃)"인지는 이 예외만으로 구별할 수 없다. 후자라면
      //   실제로는 주문이 접수됐는데 카프리만 모르는, 가장 위험한 상태(익절/손절 보호
      //   없이 방치)가 된다. 포기하기 전에 clientOrderId(멱등키 — 요청에 실려 보냈으므로
      //   실제로 접수됐다면 토스 쪽 주문에도 그대로 남아있다)로 실제 주문 목록을 뒤져
      //   확인한다 — 있으면 그 주문을 그대로 이어받아 정상 흐름을 계속하고, 정말 없으면
      //   그제서야 실패로 처리한다(호출부 catch가 다음 사이클에 자동 재시도한다).
      const found = await this.findOrderByClientOrderId(clientOrderId, symbol).catch(() => null);
      if (!found) throw e;
      o = found;
      this.addJournal({
        kind: "info",
        symbol,
        summary:
          `⚠️ 매수 주문 응답을 못 받았지만(${String(e).replace(/^Error:\s*/, "")}) 실제로는 토스에 이미 접수돼 있어 ` +
          `정상 진행합니다(주문번호 ${o.tossOrderId}).`,
      });
    }
    try { spec.onOrderCreated?.(o.tossOrderId); } catch { /* 기록 실패가 주문 흐름을 막지 않는다(다음 사이클 복구가 이어받음) */ }
    this.saveRationale(spec.rationale, { clientOrderId, kind: "entry", symbol, quantity: spec.quantity, priceAtOrder: cur, dryRun: false, tossOrderId: o.tossOrderId });
    void this.recordEntry(symbol, spec.price, this.currentMode(), spec.quantity);
    const entryJournal = this.addJournal({
      kind: "entry",
      symbol,
      summary: `진입 지정가 매수 접수 ${symbol} $${spec.price} × ${spec.quantity}주 (주문번호 ${o.tossOrderId}) — 체결되면 자동으로 조건주문(익절+손절)을 등록합니다(최대 ${spec.watchMinutes ?? 15}분 감시)`,
      detail: o,
    });

    const watchPromise = this.watchAndBracket(symbol, o.tossOrderId, spec);
    return { entryJournal, watchPromise };
  }

  /**
   * 진입 주문의 체결을 기다렸다가, 체결되면 OCO(익절+손절)를 자동 등록한다.
   *   [수명 제한] watchMinutes(기본 15분)를 넘기면 조용히 감시를 멈춘다(무한 폴링 방지 —
   *   v0.22.0 체결강도 자동 기록과 같은 원칙). 진입 주문 자체는 취소하지 않는다.
   *   [v0.25.1 — 적응형(빠르게→느슨하게) 폴링] 토스 주문 API는 체결을 먼저 알려주는 실시간
   *   채널이 없어(위 placeBracket 주석 참고) "물어봐야만" 아는데, 무작정 빨리 자주 물어보면
   *   API 호출이 너무 많아지고(공식 한도가 명시돼 있진 않지만 다른 그룹들처럼 초당 제한이
   *   있을 가능성이 큼), 너무 느리게 물어보면 체결→보호(익절/손절) 등록 사이 무방비 시간이
   *   길어진다. 그래서 "체결될 가능성이 가장 높은 진입 직후 FAST_WINDOW_MS(1분) 동안은
   *   FAST_POLL_MS(1초) 간격으로, 그 뒤엔 느슨한 간격(기본 5초)으로" 절충한다. 테스트에서
   *   spec.pollMs를 넘기면 이 적응형 로직을 끄고 그 값 하나로 처음부터 끝까지 폴링한다
   *   (빠른 자동 테스트용 — 화면(UI)은 이 값을 넘기지 않으므로 실사용에는 영향 없음).
   */
  private static readonly BRACKET_FAST_POLL_MS = 1000; // 진입 직후엔 1초 간격(체결 반응을 최대한 빠르게)
  private static readonly BRACKET_FAST_WINDOW_MS = 60_000; // "진입 직후"로 볼 구간(1분)
  private static readonly BRACKET_SLOW_POLL_MS = 5000; // 그 이후엔 5초 간격(API 부담 완화)

  // ==========================================================================
  // [v0.69.2 긴급] 주문 전 검증 관문(sanity gate) — 오너 지시 "계산된 주문 가격을 아무도 검증하지 않고 그대로 토스에 보낸다"
  //   어긋나면 주문을 보내지 않고, 저널·디스코드(notify) + 화면 붉은 경고(orderBlocks)로 즉시 알린다. 조용히 넘어가지 않는다.
  // ==========================================================================
  private orderBlocks: Array<{ ts: string; symbol: string; kind: string; reasons: string[] }> = [];
  private blockNotifiedAt = new Map<string, number>();

  private blockOrder(kind: string, symbol: string, problems: string[]): never {
    const ts = DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss");
    this.orderBlocks.unshift({ ts, symbol, kind, reasons: problems });
    this.orderBlocks = this.orderBlocks.slice(0, 10);
    // 자동매매는 5분마다 같은 후보를 다시 시도하므로, 같은 사유는 30분에 한 번만 디스코드로 보낸다(화면 경고·저널은 항상 남김).
    const key = `${symbol}|${kind}|${problems.join("|")}`;
    const last = this.blockNotifiedAt.get(key) ?? 0;
    const notify = Date.now() - last > 30 * 60_000;
    if (notify) this.blockNotifiedAt.set(key, Date.now());
    this.addJournal({
      kind: "info",
      symbol,
      summary: `🚫 ${symbol} ${kind} 주문을 보내지 않았습니다 — 주문 검증 실패: ${problems.join(" / ")}`,
      notify,
      notifyTitle: `🚫 주문 차단(검증 실패): ${symbol}`,
    });
    void this.pushLiveState(true);
    throw new Error(`주문 검증 실패 — ${problems.join(" / ")}`);
  }

  /** 지금 설정으로 만든 자동매매 익절/손절 계획(재시작 복구·가드처럼 주문 당시 계획을 모를 때 쓴다). */
  private currentAutoPlan(): AutoPlan {
    return { tpPct: this.defaultTpPct, slPct: this.defaultSlPct, slMode: this.autoTradeSlMode };
  }

  /**
   * [v0.69.2] 체결가가 주문가와 한 틱 넘게 다르면 익절/손절을 체결가 기준(설정 %)으로 다시 계산한다.
   *   EMA 기준 손절은 절대가라 그대로 두되, 체결가 아래이면서 고정 손절 한도보다 깊지 않을 때만 유지한다.
   */
  private rebaseToFill<S extends { price?: number; tpTrigger: number; tpPrice: number; slTrigger: number; slPrice: number }>(
    spec: S,
    plan: AutoPlan | undefined,
    fillPrice: number | null | undefined,
  ): { spec: S; basis: number | null; rebased: boolean } {
    const planned = typeof spec.price === "number" ? spec.price : null;
    if (!plan || !(typeof fillPrice === "number" && Number.isFinite(fillPrice) && fillPrice > 0)) return { spec, basis: planned, rebased: false };
    if (planned != null && Math.abs(fillPrice - planned) <= getTick(planned) * 1.01) return { spec, basis: planned, rebased: false };
    const tp = roundPrice(fillPrice * (1 + plan.tpPct / 100));
    const fixedSl = roundPrice(fillPrice * (1 - plan.slPct / 100));
    const keepStructural = plan.slMode === "ema" && spec.slTrigger < fillPrice && spec.slTrigger >= fixedSl;
    const sl = keepStructural ? spec.slTrigger : fixedSl;
    return { spec: { ...spec, tpTrigger: tp, tpPrice: tp, slTrigger: sl, slPrice: roundPrice(sl * 0.99) }, basis: fillPrice, rebased: true };
  }

  /** [테스트 전용] registerOcoForFilled의 재시도 대기 시간. 실사용 기본값은 3초/5초/8초 —
   *  체결 직후 토스 내부 보유수량 원장이 아직 안 따라잡은 경우(insufficient-sellable-quantity
   *  실사례)가 몇 초 안에 스스로 풀리는지 지켜볼 여유를 준다. */
  private ocoRetryDelaysMs: number[] = [3000, 5000, 8000];

  /**
   * filled 수량만큼 OCO(익절+손절)를 걸고 결과를 WatchAndBracketResult로 돌려주는 공용 내부 로직
   *  (정상 체결 경로·타임아웃 시 부분체결 보호 경로가 함께 쓴다 — 로직 중복 방지).
   *
   * [v0.57.0 긴급 수정 — 오너 실사례(BGIN·SMJF) "체결 후 보호주문 등록 실패"]
   *   실제 토스 응답 두 종류를 직접 확인했다:
   *   ① HTTP 422 insufficient-sellable-quantity("보유 수량이 없습니다") — 매수 체결 직후
   *      토스 내부의 "매도 가능 수량" 원장이 아직 반영 전이라 생기는 일시적 경합으로 보인다.
   *   ② HTTP 400 invalid-request("OCO 조건주문은 현재가가 두 감시가 사이에 있어야 합니다") —
   *      체결 시점에 계산해 둔 익절/손절 감시가 사이에 지금 가격이 더 이상 없다는 뜻. 변동성
   *      큰 저가주에서 체결~OCO등록 사이 몇 초 동안 가격이 이미 감시가를 넘어가 버린 것이다.
   *   예전엔 두 경우 다 그냥 "실패, 직접 확인 필요"로 저널만 남기고 끝났다 — 그 사이 포지션은
   *   토스에 보호장치 없이 그대로 남는다(가장 위험한 상태). 이제:
   *   - 몇 초 뒤 다시 시도한다(①류의 일시적 경합은 대개 이 안에 스스로 풀린다).
   *   - 재시도 전 현재가를 다시 확인해서, 가격이 이미 감시가를 "결정적으로" 넘어섰으면(②가
   *     스스로 풀릴 문제가 아님 — 가격이 되돌아오길 기다리는 건 방치와 같다) OCO 재시도 대신
   *     즉시 시장가로 매도해 포지션을 보호한다(protectByMarketSell).
   *   - 그래도 전부 실패하면 예전처럼 저널+알림으로 오너에게 직접 확인을 요청한다.
   */
  private async registerOcoForFilled(
    symbol: string,
    quantity: number,
    specIn: Parameters<ToolEngine["registerOcoForFilledInner"]>[2],
    fillPrice?: number | null,
  ): Promise<WatchAndBracketResult> {
    // [v0.70.0] 매수 체결 확인 ~ OCO 등록 완료 전 구간 — 이 순간 앱이 꺼지면 보호 없는 포지션이 생기므로 업데이트 재시작을 미룬다(길어야 수십 초).
    return this.windowGuard("oco-window", `체결 확인 → OCO 등록 ${symbol}`, () => this.registerOcoForFilledInner(symbol, quantity, specIn, fillPrice));
  }

  private async registerOcoForFilledInner(
    symbol: string,
    quantity: number,
    specIn: { price?: number; tpTrigger: number; tpPrice: number; slTrigger: number; slPrice: number; expireDate: string; rationale?: RationaleInput; autoPlan?: AutoPlan; strictPlan?: boolean },
    fillPrice?: number | null,
  ): Promise<WatchAndBracketResult> {
    // [v0.69.2 긴급 — SXTC 실사고] 주문가가 아니라 실제 체결가 기준으로 익절/손절을 건다(자동매매 진입만 — 수동 브라켓은 오너가 정한 가격 그대로).
    const rb = this.rebaseToFill(specIn, specIn.autoPlan, fillPrice);
    const spec = rb.spec;
    const basis = rb.basis;
    if (rb.rebased) {
      this.addJournal({
        kind: "info",
        symbol,
        summary:
          `🔧 ${symbol} 실제 체결가 $${fillPrice}가 주문가 $${specIn.price}와 달라, 익절/손절을 체결가 기준으로 다시 계산했습니다 — ` +
          `익절 $${specIn.tpTrigger}→$${spec.tpTrigger} (+${specIn.autoPlan?.tpPct}%) / 손절 $${specIn.slTrigger}→$${spec.slTrigger}.`,
        notify: true,
        notifyTitle: `🔧 체결가 기준 재계산: ${symbol}`,
      });
    }
    const expect: SanityExpect | undefined =
      specIn.autoPlan && basis != null && (rb.rebased || specIn.strictPlan !== false) ? { basis, tpPct: specIn.autoPlan.tpPct, slPct: specIn.autoPlan.slPct, slMode: specIn.autoPlan.slMode } : undefined;
    const maxAttempts = this.ocoRetryDelaysMs.length + 1;
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, this.ocoRetryDelaysMs[attempt - 2]));
        try {
          const { price: cur } = await getPrice(symbol);
          if (Number.isFinite(cur) && cur > 0 && !isWithinOcoBand(cur, spec.tpTrigger, spec.slTrigger)) {
            return await this.protectByMarketSell(symbol, quantity, cur, spec);
          }
        } catch {
          // 현재가 재확인 실패 — 판단할 근거가 없으니 아래에서 OCO 재등록을 그대로 다시 시도한다.
        }
      }
      try {
        const ocoJournal = await this.placeOco({
          symbol,
          quantity,
          tpTrigger: spec.tpTrigger,
          tpPrice: spec.tpPrice,
          slTrigger: spec.slTrigger,
          slPrice: spec.slPrice,
          expireDate: spec.expireDate,
          rationale: spec.rationale,
          entry: basis,
          expect,
        });
        // [v0.26.0] 자동매매가 이 OCO를 추적할 수 있게 조건주문 번호를 결과로 돌려준다.
        const conditionalOrderId = (ocoJournal.detail as { conditionalOrderId?: string } | undefined)?.conditionalOrderId;
        if (conditionalOrderId) return { status: "oco_registered", conditionalOrderId, tp: spec.tpTrigger, sl: spec.slTrigger, fillPrice: rb.rebased ? fillPrice : null };
        // 드라이런처럼 conditionalOrderId가 없는 경우(이론상 이 분기는 isDryRun()이 이미
        // placeBracketCore에서 걸러내 도달하지 않지만, 안전하게 실패로 취급한다).
        lastError = "조건주문 번호를 확인할 수 없습니다.";
      } catch (e) {
        lastError = String(e).replace(/^Error:\s*/, "");
        if (lastError.startsWith("주문 검증 실패")) break; // 같은 값으로 다시 해도 같은 결과 — 재시도하지 않는다(이미 붉은 경고·알림이 나갔다)
      }
    }
    // [v0.62.0 긴급 — VEEA 실사례] 재시도를 전부 소진했는데 마지막 실패 사유가 "밴드 위반"이면,
    //   그동안의 사전 확인(위 isWithinOcoBand 체크)이 전부 토스의 실제 처리 시점과 어긋났다는
    //   뜻이다 — 포기 대신 마지막으로 한 번 더 지금 가격으로 즉시 보호매도를 시도한다. 그 외
    //   사유(매도가능수량 부족 등)는 가격과 무관해 블라인드 매도가 더 위험할 수 있어 그대로
    //   아래 경고로 넘긴다.
    if (isOcoPriceBandError(lastError)) {
      try {
        const { price: cur } = await getPrice(symbol);
        if (Number.isFinite(cur) && cur > 0) {
          return await this.protectByMarketSell(
            symbol,
            quantity,
            cur,
            spec,
            `${maxAttempts}번 재시도하는 내내 가격이 익절 $${spec.tpTrigger}/손절 $${spec.slTrigger} 감시가 밴드를 벗어나` +
              `(토스가 매번 "밴드 밖"으로 거부 — 확인 시점과 실제 처리 시점 사이 가격 변동으로 추정됩니다)`,
          );
        }
      } catch {
        // 현재가 조회조차 실패 — 아래 기존 경고(직접 확인 요청)로 폴백.
      }
    }
    this.addJournal({
      kind: "info",
      symbol,
      summary: `⚠️ 체결을 확인했지만 조건주문(익절+손절) 자동 등록에 ${maxAttempts}번 시도해도 실패했습니다 — 직접 걸어 주세요: ${lastError}`,
      // [v0.32.0] 보호주문 없이 포지션만 남은 상태라 매매 방식(수동/자동)과 무관하게 중요한 알림.
      notify: true,
      notifyTitle: `⚠️ 보호주문 등록 실패: ${symbol}`,
    });
    return { status: "oco_failed", error: lastError };
  }

  /**
   * [v0.57.0] 체결 후 가격이 이미 익절/손절 감시가를 넘어서 OCO 자체를 등록할 수 없을 때의
   *   마지막 방어선 — 조건주문을 기다리는 대신 즉시 시장가로 팔아 포지션을 정리한다. "가격이
   *   되돌아와 OCO가 등록되길" 기다리는 것보다, 지금 확정할 수 있는 손익으로 끝내는 쪽이
   *   훨씬 안전하다(무보호 상태로 방치하지 않음).
   */
  private async protectByMarketSell(
    symbol: string,
    quantity: number,
    cur: number,
    spec: { tpTrigger: number; slTrigger: number },
    /** [v0.62.0] registerOcoForFilled의 재시도-소진 폴백(아래 isOcoPriceBandError 분기)이
     *  호출할 때는 cur 자체가 우리 쪽에서 보기엔 "밴드 안"일 수 있다(그런데도 토스가 매번
     *  거부했다는 게 바로 그 상황의 핵심) — 그 경우 cur과 tpTrigger/slTrigger를 비교해
     *  "이미 올라/내려가 있다"고 단정하는 기존 문구를 그대로 쓰면 사실과 다를 수 있어,
     *  호출부가 정직한 사유를 직접 넘길 수 있게 한다. 생략하면 기존 비교 로직 그대로. */
    reasonOverride?: string,
  ): Promise<WatchAndBracketResult> {
    const reason =
      reasonOverride ?? (cur >= spec.tpTrigger ? `익절 감시가($${spec.tpTrigger}) 이상으로 이미 올라` : `손절 감시가($${spec.slTrigger}) 이하로 이미 내려가`);
    try {
      // [v0.69.0] 한 번 실패하면 포기하던 것을 재시도로 바꾼다 — WETO 실사례는 "매도 가능 수량 부족(422)"으로 이 시장가 매도가
      //   실패하자 그대로 무보호 상태로 끝났다. 실제 매도 가능 수량을 확인해 그만큼만(전량 아니면 가드가 나머지를 이어서) 판다.
      let soldAll = false;
      let lastSellErr: unknown = null;
      let sellOrderId: string | null = null;
      for (let attempt = 0; attempt <= this.marketSellRetryDelaysMs.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, this.marketSellRetryDelaysMs[attempt - 1]));
        try {
          const sq = await this.sellableQty(symbol).catch(() => null);
          const qty = sq != null && Number.isFinite(sq) ? Math.min(quantity, Math.floor(sq)) : quantity;
          if (qty <= 0) { lastSellErr = new Error("매도 가능 수량이 아직 0입니다(체결 직후 반영 대기)"); continue; }
          const sellEntry = await this.placeSell({ symbol, quantity: qty, orderType: "MARKET" });
          sellOrderId = (sellEntry.detail as OrderResponse | undefined)?.tossOrderId ?? null;
          soldAll = qty >= quantity;
          if (!soldAll) { lastSellErr = new Error(`일부(${qty}/${quantity}주)만 매도 가능 — 나머지는 가드가 이어서 처리`); }
          break;
        } catch (e) {
          lastSellErr = e;
        }
      }
      if (!soldAll) throw lastSellErr instanceof Error ? lastSellErr : new Error(String(lastSellErr ?? "시장가 매도 실패"));
      // [v0.73.0 긴급 수정 — 오너 실계좌 보고 "매수가와 똑같은 가격에 매도 기록, 실제론 손실인데
      //   앱은 +$7.42 익절로 기록"(AGRZ, 2026-10-10)] 시장가 주문 생성 응답 자체는 체결가를 안
      //   준다(토스 스펙상 orderId뿐) — 예전엔 그래서 "매도 직전 조회한 현재가(cur)"를 그대로
      //   손익 계산에 썼는데, 변동성 큰 저가주는 그사이 가격이 몇 %씩 움직일 수 있어 "몇 센트
      //   차이"로 넘길 수준이 아니었다(실제로 +3.29% 익절 기록이 실제로는 수수료만 까먹은 거래
      //   였음). 이제는 매도 주문번호로 실제 체결가(avg_filled_price)를 직접 조회해 그 값을
      //   쓴다 — 시장가 주문은 거의 즉시 체결되므로 짧게 몇 번만 재확인한다. 그래도 못 받아오면
      //   (조회 실패·드라이런 등) 그때만 예전처럼 추정가로 폴백하되, 기록에 "추정가"임을 남긴다.
      let exitPrice = cur;
      let exitPriceIsEstimate = true;
      if (sellOrderId) {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, ToolEngine.BRACKET_FAST_POLL_MS));
          try {
            const filled = await getOrder(sellOrderId);
            if (filled.avg_filled_price != null && filled.avg_filled_price > 0) {
              exitPrice = filled.avg_filled_price;
              exitPriceIsEstimate = false;
              break;
            }
          } catch {
            // 조회 실패는 다음 시도에서 재시도(아래 폴백이 있으므로 막지 않음)
          }
        }
      }
      this.addJournal({
        kind: "info",
        symbol,
        summary:
          `⚠️ 체결 후 보호주문(OCO)을 걸려 했지만, 그 사이 현재가($${cur})가 ${reason} 있어 OCO 등록이 불가능했습니다(토스 규칙상 감시가 사이에 있어야 함) — 대기 대신 즉시 시장가로 매도해 포지션을 정리했습니다` +
          (exitPriceIsEstimate
            ? `(실제 체결가 조회에 실패해 매도 직전 조회한 추정가 $${cur}로 기록 — 실제 체결가와 다를 수 있습니다).`
            : `(실제 체결가 $${exitPrice} 확인 완료).`),
        notify: true,
        notifyTitle: `⚠️ 즉시 보호매도: ${symbol}`,
      });
      return { status: "protected_by_market_sell", exitPrice, quantity, exitPriceIsEstimate };
    } catch (e) {
      const error = String(e).replace(/^Error:\s*/, "");
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ 가격이 감시가를 넘어서 즉시 시장가 매도를 시도했지만 그마저 실패했습니다 — 직접 확인 필요: ${error}`,
        notify: true,
        notifyTitle: `⚠️ 긴급: 보호매도 실패: ${symbol}`,
      });
      return { status: "oco_failed", error };
    }
  }

  private async watchAndBracket(
    symbol: string,
    tossOrderId: string,
    spec: {
      quantity: number;
      tpTrigger: number;
      tpPrice: number;
      slTrigger: number;
      slPrice: number;
      expireDate: string;
      watchMinutes?: number;
      pollMs?: number;
      rationale?: RationaleInput;
      cancelOnTimeout?: boolean;
    },
  ): Promise<WatchAndBracketResult> {
    const watchMinutes = spec.watchMinutes ?? 15;
    const startedAt = Date.now();
    const deadline = startedAt + watchMinutes * 60_000;
    let lastOrder: OrderResponse | null = null; // [v0.29.0] 타임아웃 시 "막판 체결/부분체결" 판단용

    while (Date.now() < deadline) {
      // spec.pollMs가 있으면(테스트 전용) 처음부터 끝까지 그 값 하나로 고정. 없으면(실사용)
      // 진입 직후 1분은 1초, 그 이후는 5초로 적응형 폴링(위 클래스 설명 참고).
      const elapsed = Date.now() - startedAt;
      const pollMs =
        spec.pollMs ?? (elapsed < ToolEngine.BRACKET_FAST_WINDOW_MS ? ToolEngine.BRACKET_FAST_POLL_MS : ToolEngine.BRACKET_SLOW_POLL_MS);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let o: OrderResponse;
      try {
        o = await getOrder(tossOrderId);
        lastOrder = o;
      } catch {
        continue; // 조회 실패는 다음 폴링에서 재시도(막지 않음)
      }
      if (o.status === "filled") {
        return this.registerOcoForFilled(symbol, o.filled_qty && o.filled_qty > 0 ? o.filled_qty : spec.quantity, spec, o.avg_filled_price);
      }
      if (o.status === "cancelled" || o.status === "failed") {
        // [v0.69.1 긴급] 일부만 체결된 채로 취소(킬스위치·[주문현황]에서 직접 취소·토스의 잔량 취소)되면 그 체결분은 계좌에 남는다 —
        //   예전엔 이 경우도 "그냥 취소됨"으로 끝내 체결분이 보호 없이 방치됐다. 체결된 수량만큼은 반드시 OCO로 보호한다.
        const partFilled = o.filled_qty ?? 0;
        if (partFilled > 0) {
          this.addJournal({
            kind: "info", symbol,
            summary: `진입 주문이 일부(${partFilled}주)만 체결된 채 ${o.status === "cancelled" ? "취소" : "실패"}됐습니다 — 체결된 ${partFilled}주는 보호를 위해 익절/손절을 겁니다.`,
            notify: true, notifyTitle: `🛡 부분체결 보호: ${symbol}`,
          });
          return this.registerOcoForFilled(symbol, partFilled, spec, o.avg_filled_price);
        }
        this.addJournal({
          kind: "info", symbol, summary: `진입 주문이 ${o.status === "cancelled" ? "취소" : "실패"}돼 자동 감시를 멈췄습니다.`,
          notify: true, notifyTitle: `${o.status === "cancelled" ? "취소됨" : "⚠️ 실패"}: ${symbol}`,
        });
        return { status: o.status };
      }
      // pending/partial/unknown이면 계속 기다린다.
    }

    // [v0.29.0] 시간초과 — cancelOnTimeout이 꺼져 있으면(수동 버튼 경로) 예전처럼 감시만 멈추고
    //   주문은 그대로 둔다(사람이 지켜보다 직접 판단하도록).
    if (!spec.cancelOnTimeout) {
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⏱ ${watchMinutes}분 동안 체결을 기다렸지만 되지 않아 자동 감시를 멈췄습니다. 진입 주문은 그대로 있으니, 체결되면 [주문현황]에서 직접 조건주문(익절+손절)을 걸어 주세요.`,
        notify: true,
        notifyTitle: `⏱ 미체결 감시 종료: ${symbol}`,
      });
      return { status: "timeout" };
    }

    // [v0.29.0 — 오너 요청: "장시간 미체결 대책"] 자동매매 경로는 여기서 끝내지 않는다:
    //   막판에 체결됐을 수 있으니 한 번 더 확인 → 다 체결됐으면 정상 OCO 등록, 일부만 체결됐으면
    //   그 수량만큼 OCO로 보호하고 나머지는 취소, 전혀 안 됐으면 그냥 취소. 취소로 비운 자리는
    //   다음 5분 사이클의 스크리닝이 자동으로 새 후보로 채운다(autoTradeTick의 freeSlots 계산).
    let finalOrder: OrderResponse | null = lastOrder;
    try {
      finalOrder = await getOrder(tossOrderId);
    } catch {
      // 재조회 실패 — 마지막으로 알던 상태(lastOrder)로 대체 판단.
    }
    if (finalOrder?.status === "filled") {
      return this.registerOcoForFilled(symbol, finalOrder.filled_qty && finalOrder.filled_qty > 0 ? finalOrder.filled_qty : spec.quantity, spec, finalOrder.avg_filled_price);
    }
    let cancelResult: OrderResponse;
    try {
      cancelResult = await this.inflight(`주문 취소 ${symbol}`, () => cancelOrder(tossOrderId));
    } catch (e) {
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ ${watchMinutes}분 동안 체결되지 않아 자동 취소를 시도했지만 실패했습니다 — [주문현황]에서 직접 확인해 주세요: ${String(e).replace(/^Error:\s*/, "")}`,
        notify: true,
        notifyTitle: `⚠️ 자동 취소 실패: ${symbol}`,
      });
      return { status: "timeout" };
    }
    // [v0.52.0 긴급 수정 — ALDX 실사례: "감시 리스트에서는 빠졌는데 주문만 덩그러니 남음"]
    //   예전엔 cancelOrder()가 예외만 안 던지면 무조건 "취소 성공"으로 믿고 감시를 끝냈다.
    //   그런데 cancelOrder()는 실제로 취소 "직후" 토스가 돌려준 주문 상태를 그대로 준다 —
    //   막판에 체결이 먼저 반영되면 "filled"로, 취소가 아직 실제로 안 끝났으면
    //   "submitted"/"partial"/"unknown" 등으로 돌아올 수 있다. 이걸 확인하지 않고 바로
    //   "cancelled"로 단정하면, 실제 주문은 토스에 그대로 남았는데 우리 쪽 감시 목록에서만
    //   사라져 버린다(오너가 정확히 이 증상을 보고함). 이제 취소 API의 반환값(cancelResult)
    //   자체를 진실로 삼아 분기한다 — 취소 전에 미리 봐둔 finalOrder/filledQty는 더 안 쓴다.
    if (cancelResult.status === "filled") {
      // 취소 요청이 도착하기 직전에 전량 체결까지 끝나버린 경우 — 보호 없이 두면 안 되므로 OCO.
      return this.registerOcoForFilled(symbol, cancelResult.filled_qty && cancelResult.filled_qty > 0 ? cancelResult.filled_qty : spec.quantity, spec, cancelResult.avg_filled_price);
    }
    if (cancelResult.status !== "cancelled" && cancelResult.status !== "failed") {
      // 취소 요청 자체는 받아들여졌지만(예외 없음) 아직 실제로 "취소됨"이 아니다 — 절대 여기서
      // 감시를 놓지 않는다. 포지션을 watching 그대로 남겨, 다음 reconcileAutoPositions
      // 사이클(orphanedWatching 경로)이 buyOrderId로 다시 확인하게 넘긴다.
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ ${watchMinutes}분 초과로 취소를 요청했지만 토스 응답상 아직 '${cancelResult.status}' 상태입니다 — 감시를 계속 유지하며 다음 확인 때 다시 처리합니다. [주문현황]에서도 확인해 주세요.`,
        notify: true,
        notifyTitle: `⚠️ 취소 반영 지연: ${symbol}`,
      });
      return { status: "still_pending" };
    }
    const filledQty = cancelResult.filled_qty ?? 0;
    if (filledQty > 0) {
      // 일부만 체결된 채로 취소된 경우 — 그 수량은 보호(OCO) 없이 남겨두면 위험하니 반드시 걸어준다.
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⏱ ${watchMinutes}분 동안 전량 체결되지 않아 나머지 주문은 자동 취소했습니다. 이미 부분 체결된 ${filledQty}주는 보호를 위해 익절/손절(조건주문)을 걸었습니다.`,
        notify: true,
        notifyTitle: `⏱ 부분체결 취소: ${symbol}`,
      });
      return this.registerOcoForFilled(symbol, filledQty, spec, cancelResult.avg_filled_price);
    }
    this.addJournal({
      kind: "info",
      symbol,
      summary: `⏱ ${watchMinutes}분 동안 체결되지 않아 미체결 주문을 자동 취소했습니다(다음 자동매매 사이클에서 새 후보로 대체됩니다).`,
      notify: true,
      notifyTitle: `⏱ 미체결 자동 취소: ${symbol}`,
    });
    // [v0.54.0] 여기가 진짜 "장시간 미체결 자동취소"다 — 위 폴링 도중 감지되는 일반 "cancelled"와
    //   구분되는 전용 상태로 돌려줘야 onAutoBracketResolved가 정확한 사유를 기록할 수 있다.
    return { status: "cancelled_by_timeout" };
  }

  // --------------------------------------------------------------------------
  // 주문 현황(조회·취소) — 조회는 드라이런과 무관하게 실서버에서도 안전(읽기)
  // --------------------------------------------------------------------------
  async openOrders(): Promise<OrderResponse[]> {
    await this.prepareBackend();
    this.assertAccountReady(); // 계좌 API라 계좌 헤더 필요 → 미설정이면 친절한 안내
    const r = await listOrders({ status: "OPEN" });
    return r.orders;
  }

  async conditionals(): Promise<ConditionalOrderResponse[]> {
    await this.prepareBackend();
    this.assertAccountReady();
    return listConditionalOrders("OPEN"); // status 필수(실스펙). 진행 중 조건주문만.
  }

  async cancelNormalOrder(orderId: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    await this.prepareBackend(); // 접속 상태(주소/모드) 단일 진실 소스 유지
    if (isOrderFrozen(DateTime.now())) {
      this.addJournal({ kind: "info", symbol: "-", summary: "⚠️ 참고: 마감 1분 전은 토스가 취소를 거부할 수 있습니다. 그래도 시도합니다." });
    }
    if (this.isDryRun()) {
      return this.addJournal({ kind: "dryrun", symbol: "-", summary: `[드라이런] 주문 취소 ${orderId} (실제 전송 안 함)` });
    }
    const o = await this.inflight("주문 취소", () => cancelOrder(orderId));
    return this.addJournal({ kind: "cancel", symbol: o.symbol ?? "-", summary: `주문 취소 ${orderId} → ${o.status}` });
  }

  async cancelConditional(id: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    await this.prepareBackend(); // 접속 상태 단일 진실 소스 유지
    if (this.isDryRun()) {
      return this.addJournal({ kind: "dryrun", symbol: "-", summary: `[드라이런] 조건주문 취소 ${id} (실제 전송 안 함)` });
    }
    await this.inflight("조건주문 취소", () => cancelConditionalOrder(id));
    return this.addJournal({ kind: "cancel", symbol: "-", summary: `조건주문 취소 ${id}` });
  }

  /**
   * [v0.41.0 — 오너 요청 "자동매매 주문건에 대해 취소할 수 있는 버튼 추가"] 자동매매가
   *   지금 감시 중인 포지션 하나를 사람이 즉시 직접 취소한다. `watching`(매수 체결
   *   대기 중)이면 매수 주문 자체를(`cancelNormalOrder`), `active`(익절/손절 등록됨)면
   *   조건주문(OCO)을(`cancelConditional`) 취소한다 — 둘 다 킬스위치·드라이런을 이미
   *   각자 처리하므로 여기서 다시 검사하지 않는다. 취소가 실제로 성공했을 때만 이
   *   기기의 감시 목록에서 즉시 빼고 기록도 "사람이 직접 취소"로 남긴다(다음 5분
   *   재확인을 기다리지 않음 — 오너가 지금 당장 빼고 싶어서 누른 버튼이므로).
   */
  async cancelAutoPosition(symbol: string, entry: number, enteredAtMs: number): Promise<{ ok: boolean; message: string }> {
    const pos = this.autoTradePositions.find((p) => p.symbol === symbol && p.entry === entry && p.enteredAtMs === enteredAtMs);
    if (!pos) return { ok: false, message: "이미 사라진 포지션입니다(새로고침해 보세요)." };
    try {
      if (pos.status === "active" && pos.conditionalOrderId) {
        await this.cancelConditional(pos.conditionalOrderId);
      } else if (pos.buyOrderId) {
        await this.cancelNormalOrder(pos.buyOrderId);
      } else {
        return { ok: false, message: "취소할 주문 번호를 찾을 수 없습니다 — [현황 → 주문 현황] 탭에서 직접 확인해 주세요." };
      }
    } catch (e) {
      // [v0.60.0 긴급 수정 — 오너 실사용 보고: "체결 완료된 종목이 목록에 남고 취소도 무반응"]
      //   취소가 실패하는 흔한 이유 중 하나: 이 조건주문이 그 사이 이미 발동(COMPLETED)돼서
      //   "취소할 살아있는 주문"이 더는 없는 경우 — Toss가 이걸 오류로 돌려주면 예전엔 그냥
      //   "취소 실패"만 보여주고 목록엔 계속 남았다(오너가 본 그 증상). 포기하기 전에 실제
      //   상태를 한 번 더 물어봐서, 이미 끝나 있으면 "취소"가 아니라 "정리"로 처리한다.
      if (pos.status === "active" && pos.conditionalOrderId) {
        // [v0.60.1 긴급 — SDEV 실사용 사고: 취소(DELETE) 자체가 이미 404
        // conditional-order-not-found였다] 이 경우 재확인(GET)도 십중팔구 같은 404를
        // 준다 — 먼저 취소 오류 자체가 이미 "존재하지 않는 설정"이면 재확인을 시도할
        // 것도 없이 바로 정리한다(예전엔 이 경우 재확인 GET도 404로 실패하고 그
        // 실패를 조용히 삼켜 원래의 "취소 실패"만 보여줬다 — 오너가 본 그 증상).
        if (this.isConditionalOrderGoneError(e)) {
          await this.clearAutoPositionWithoutPnl(
            pos,
            `🤖 자동매매 포지션 정리: ${symbol}(토스에 조건주문이 더 이상 존재하지 않음)`,
            "취소 시도 시 토스에 조건주문이 이미 없었음(직접 취소했거나 만료된 것으로 보임 — 손익 미확정)",
          );
          return { ok: true, message: `${symbol}은 토스에 조건주문이 이미 없어(존재하지 않는 설정) 취소 대신 목록에서 정리했습니다.` };
        }
        try {
          const resp = await getConditionalOrder(pos.conditionalOrderId);
          if (resp.status === "COMPLETED") {
            await this.resolveCompletedConditional(pos, resp);
            return { ok: true, message: `${symbol}은 이미 종료된 주문이라 취소 대신 목록에서 정리했습니다(익절/손절/수동취소 중 하나로 이미 끝나 있었음).` };
          }
        } catch (e2) {
          // [v0.60.1] 재확인(GET) 자체가 404 conditional-order-not-found면 이것도 정리 대상.
          if (this.isConditionalOrderGoneError(e2)) {
            await this.clearAutoPositionWithoutPnl(
              pos,
              `🤖 자동매매 포지션 정리: ${symbol}(토스에 조건주문이 더 이상 존재하지 않음)`,
              "취소 재확인 시 토스에 조건주문이 이미 없었음(직접 취소했거나 만료된 것으로 보임 — 손익 미확정)",
            );
            return { ok: true, message: `${symbol}은 토스에 조건주문이 이미 없어(존재하지 않는 설정) 취소 대신 목록에서 정리했습니다.` };
          }
          /* 그 외 재확인 실패는 원래 오류 메시지를 그대로 보여준다(아래) */
        }
      }
      return { ok: false, message: `취소 실패: ${String(e).replace(/^Error:\s*/, "")}` };
    }
    this.autoTradeActiveWatches.delete(`${symbol}@${entry}@${enteredAtMs}`);
    this.autoTradePositions = this.autoTradePositions.filter((p) => p !== pos);
    this.saveAutoPositions();
    this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
      status: "closed_manual",
      exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
      note: "오너가 [자동매매 현황]에서 직접 취소함",
    });
    this.addJournal({
      kind: "cancel", symbol, summary: `🤖 자동매매 포지션 직접 취소: ${symbol}`,
      notify: true, notifyTitle: `취소됨: ${symbol}`,
    });
    return { ok: true, message: `${symbol} 취소를 완료했습니다.` };
  }

  // --------------------------------------------------------------------------
  // 상태·저널
  // --------------------------------------------------------------------------
  getStatus(): ToolStatus {
    const now = DateTime.now().setZone("Asia/Seoul");
    const market = getMarketStatus(now); // [v0.8.4] 세션 + 휴장 사유 + 다음 개장
    return {
      mode: this.mode,
      dryRun: this.isDryRun(),
      liveOrdersEnabled: this.liveOrdersEnabled,
      skipOrderConfirm: this.skipOrderConfirm,
      killSwitch: this.killSwitch,
      session: market.session,
      closedReason: market.closedReason,
      earlyClose: market.earlyClose,
      // 다음 개장은 "08-17(월) 09:00" 처럼 요일까지 붙여 사람이 바로 읽게 한다.
      nextOpenNote: market.nextOpen ? `${market.nextOpen.setLocale("ko").toFormat("MM-dd(ccc) HH:mm")}` : null,
      orderFrozen: isOrderFrozen(now),
      clockNote: `${now.toFormat("MM-dd HH:mm")} KST`,
      fxRate: this.fxCache?.rate ?? null,
      fxSource: this.fxCache?.source ?? null,
      buyingPowerUsd: this.buyingPowerUsd,
    };
  }

  // --------------------------------------------------------------------------
  // [v0.2.10] 매매 근거 저장/조회
  // --------------------------------------------------------------------------

  /** 근거 파일 읽기(없거나 깨졌으면 빈 목록으로 시작 — 앱은 계속 동작해야 한다). */
  private loadRationales(): void {
    try {
      this.rationales = existsSync(this.rationalePath)
        ? (JSON.parse(readFileSync(this.rationalePath, "utf8")) as TradeRationale[])
        : [];
    } catch {
      this.rationales = [];
    }
  }

  /**
   * 근거 한 건 저장. 화면이 보낸 기법 입력(input)에 주문 시점 정보(fixed)를 합쳐 파일에 남긴다.
   * 근거가 없어도(=화면이 안 보냈어도) 최소 정보는 남긴다 — "언제 무엇을 몇 주" 만이라도 있어야
   * 나중에 토스 주문과 짝을 맞출 수 있기 때문이다.
   * ⚠️ 이 기록이 실패해도 주문은 이미 나갔으므로, 예외를 밖으로 던지지 않는다(주문 흐름 보호).
   */
  private saveRationale(
    input: RationaleInput | undefined,
    fixed: {
      clientOrderId: string;
      kind: "entry" | "oco" | "oto";
      symbol: string;
      quantity: number;
      priceAtOrder: number | null;
      dryRun: boolean;
      tossOrderId?: string;
    },
  ): void {
    try {
      const rec: TradeRationale = {
        ts: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
        technique: input?.technique ?? "manual", // 화면이 안 보냈으면 '수동'으로 간주
        source: input?.source ?? "manual", // [v0.30.0] 마찬가지로 안 보내면(수동 버튼 전부) '수동'
        ...input,
        ...fixed,
      };
      this.rationales.push(rec);
      if (this.rationales.length > 2000) this.rationales.shift(); // 오래된 것부터 정리
      this.scheduleFileSave("rationale", this.rationalePath, () => this.rationales); // [v0.90.0] 디바운스
    } catch {
      /* 기록 실패는 주문을 되돌리지 않는다 */
    }
  }

  /** 최근 근거 목록(화면 표시용). 최신이 위로 오게 뒤집어 준다. */
  getRationales(): TradeRationale[] {
    return this.rationales.slice(-200).reverse();
  }

  // --------------------------------------------------------------------------
  // [v0.4.0] 삼분할 타점 기록 저장/조회/삭제/체크 (여러 종목 동시 운용용)
  //   저장 방식은 매매근거·저널과 동일: JSON 파일 + 임시파일 원자적 교체.
  //   ⚠️ 이 기능은 '기록'일 뿐 주문을 내지 않는다(실주문 로직과 완전히 분리).
  // --------------------------------------------------------------------------

  /** 기록 파일 읽기(없거나 깨졌으면 빈 목록 — 앱은 계속 동작해야 한다). */
  private loadSplits(): void {
    try {
      this.splits = existsSync(this.splitsPath)
        ? (JSON.parse(readFileSync(this.splitsPath, "utf8")) as SavedSplit[])
        : [];
    } catch {
      this.splits = [];
    }
    // [v0.102.0] 삭제 표식 — 이 기기에도 따로 보관한다. 혹시 옛 버전 앱이 클라우드의 표식을 지운 채 올려도
    //   이 기기가 표식을 기억하고 있어서, 다음 동기화 때 지운 기록을 다시 지우고 표식도 되살린다.
    try {
      const raw = existsSync(this.splitsDeletedPath) ? (JSON.parse(readFileSync(this.splitsDeletedPath, "utf8")) as unknown) : {};
      this.splitsDeleted = raw && typeof raw === "object" && !Array.isArray(raw) ? mergeTombstones(raw as Tombstones, {}, Date.now()) : {};
    } catch {
      this.splitsDeleted = {};
    }
  }

  /** 메모리의 기록 목록을 파일에 저장(디바운스 — v0.90.0). */
  private persistSplits(): void {
    this.saveSplitsLocal();
    // [v0.61.7 — ③ 전수조사 중간-2] 로그인 상태면 다른 기기도 곧바로 볼 수 있게 클라우드에도 올려 둔다.
    //   [v0.102.0] 15초 안에 또 바뀌어도 건너뛰지 않고 "남은 시간 뒤"로 예약한다(schedulePush) — 변경 누락 방지.
    this.schedulePush("splits", 15_000);
  }

  /** [v0.102.0] 이 기기 파일에만 저장(클라우드로 올리지 않음) — 클라우드에서 받아 합친 직후에 쓴다(받자마자 다시 올리는 핑퐁 방지). */
  private saveSplitsLocal(): void {
    this.scheduleFileSave("splits", this.splitsPath, () => this.splits);
    this.scheduleFileSave("splitsDeleted", this.splitsDeletedPath, () => this.splitsDeleted);
  }

  /**
   * addSplit — 계산 결과 한 종목분을 기록으로 저장한다.
   *   화면(App.tsx)이 계산 결과의 타점(levels)과 종목·%·수량·메모를 보내면,
   *   고유 id와 저장 시각을 붙여 목록 맨 앞(최신)에 추가하고 파일에 저장한다.
   *   반환값은 갱신된 전체 목록(화면이 바로 다시 그리게).
   */
  addSplit(input: {
    symbol: string;
    technique: Technique;
    levels: CalcLevel[];
    tpPct: number | null;
    slPct: number | null;
    qty: number | null;
    memo?: string;
    /** [v0.9.0] 계산기 입력값(있으면 그대로 저장 → 나중에 계산기로 다시 불러올 수 있다) */
    inputs?: SplitInputs;
  }): SavedSplit[] {
    const now = DateTime.now().setZone("Asia/Seoul");
    const rec: SavedSplit = {
      // id: 저장 시각(밀리초) — 사람이 같은 순간에 두 번 누르긴 어렵고, 삭제·체크의 열쇠로 충분.
      id: String(now.toMillis()),
      ts: now.toFormat("MM-dd HH:mm:ss"),
      symbol: (input.symbol || "").toUpperCase().trim(),
      technique: input.technique,
      levels: buildSavedLevels(input.levels), // 진입완료는 전부 false로 시작
      tpPct: input.tpPct,
      slPct: input.slPct,
      qty: input.qty,
      memo: (input.memo ?? "").trim(),
      // 입력값은 준 경우에만 담는다(안 주면 예전과 똑같은 모양으로 저장 — 하위호환).
      ...(input.inputs ? { inputs: input.inputs } : {}),
      updatedAtMs: now.toMillis(), // [v0.102.0] 마지막으로 손댄 시각(기기 간 "누가 최신인가"의 기준)
    };
    this.splits.unshift(rec); // 최신이 맨 위
    if (this.splits.length > 500) this.splits.pop(); // 너무 쌓이면 오래된 것부터 정리
    this.persistSplits();
    return this.getSplits();
  }

  /** 저장된 삼분할 기록 목록(최신이 위). 화면 표시용. */
  getSplits(): SavedSplit[] {
    return this.splits;
  }

  /** 기록 한 건 삭제(휴지통 아이콘). 순수 함수 removeSavedSplit로 목록을 새로 만든 뒤 저장. */
  deleteSplit(id: string): SavedSplit[] {
    this.splits = removeSavedSplit(this.splits, id);
    // [v0.102.0] 삭제 표식을 남긴다 — 이게 없으면 아직 이 기록을 가진 다른 기기가 "새 기록"으로 착각해 다시 올려 부활시킨다.
    this.splitsDeleted = { ...this.splitsDeleted, [id]: Date.now() };
    this.persistSplits();
    return this.getSplits();
  }

  /** 특정 기록의 특정 분할에 대해 [진입완료] 체크를 뒤집는다. */
  toggleSplitEntered(id: string, level: number): SavedSplit[] {
    this.splits = this.touchSplit(toggleSavedLevel(this.splits, id, level), id);
    this.persistSplits();
    return this.getSplits();
  }

  /** 기록의 제목(메모)을 수정한다(연필 → 인라인 편집). 파일에 반영, 앱 재시작해도 유지. */
  renameSplit(id: string, memo: string): SavedSplit[] {
    this.splits = this.touchSplit(renameSavedSplit(this.splits, id, memo), id);
    this.persistSplits();
    return this.getSplits();
  }

  /** [v0.102.0] 기록 하나를 "방금 손댐"으로 표시(updatedAtMs) — 이게 있어야 수정본이 다른 기기의 옛 값을 이긴다. */
  private touchSplit(list: SavedSplit[], id: string): SavedSplit[] {
    const now = Date.now();
    return list.map((s) => (s.id === id ? { ...s, updatedAtMs: Math.max(now, (s.updatedAtMs ?? 0) + 1) } : s));
  }
  // --------------------------------------------------------------------------
  // [v0.5.0] 체결강도 기록 — 온디맨드 시계열 샘플링(시작/중지/조회)
  //   ⚠️ 읽기 전용(trades 조회만). 주문 로직과 완전히 분리.
  // --------------------------------------------------------------------------

  /** 시계열 파일 읽기(없거나 깨졌으면 빈 객체 — 앱은 계속 동작). */
  private loadStrength(): void {
    try {
      this.strengthSeries = existsSync(this.strengthPath)
        ? (JSON.parse(readFileSync(this.strengthPath, "utf8")) as Record<string, StrengthSample[]>)
        : {};
    } catch {
      this.strengthSeries = {};
    }
  }

  /** 시계열을 파일에 저장(디바운스 — v0.90.0. 감시 중엔 10~60초마다 불려 가장 잦은 호출원이었다). */
  private persistStrength(): void {
    this.scheduleFileSave("strength", this.strengthPath, () => this.strengthSeries);
  }

  /** 지금 이 종목을 기록 중인가. */
  isStrengthRunning(symbol: string): boolean {
    return this.strengthRuns.has((symbol || "").toUpperCase().trim());
  }

  /**
   * startStrength — 이 종목의 체결강도 기록을 시작한다(이미 켜져 있으면 그대로 유지).
   *   즉시 한 번 샘플링하고, 이후 intervalSec 마다 반복한다. 화면은 이벤트로 갱신을 받는다.
   *   @param intervalSec 폴링 간격(초). 5~15 권장, 기본 10. 범위 밖이면 보정.
   */
  startStrength(symbol: string, intervalSec = 10, auto = false): StrengthState {
    const sym = (symbol || "").toUpperCase().trim();
    if (!sym) throw new Error("종목 코드를 입력하세요.");
    const iv = Math.min(60, Math.max(3, Math.floor(intervalSec) || 10)); // 3~60초로 안전 보정
    if (this.strengthRuns.has(sym)) return this.getStrengthState(sym); // 중복 시작 방지

    // 연속 상태 초기화: 틱룰 seed(직전가/방향)와 중복제거 집합.
    // [v0.22.0] auto=true(매매로 자동 시작)면 수명 제한 필드(startedAtMs/failCount)를 심는다.
    const run = { timer: setInterval(() => void this.sampleStrengthOnce(sym), iv * 1000), intervalSec: iv, lastSide: "buy" as Side, seen: new Set<string>(), lastError: null as string | null, auto, startedAtMs: Date.now(), failCount: 0, buffer: [] as WindowBufferEntry[] };
    this.strengthRuns.set(sym, run);
    void this.sampleStrengthOnce(sym); // 시작 즉시 1회(기다리지 않게)
    this.addJournal({ kind: "info", symbol: sym, summary: auto ? `체결강도 자동 기록 시작 (매매 감지 · ${iv}초 간격)` : `체결강도 기록 시작 (${iv}초 간격)` });
    return this.getStrengthState(sym);
  }

  /** stopStrength — 기록 중지(타이머 해제). 저장된 시계열은 남는다. */
  stopStrength(symbol: string): StrengthState {
    const sym = (symbol || "").toUpperCase().trim();
    const run = this.strengthRuns.get(sym);
    if (run) {
      clearInterval(run.timer);
      this.strengthRuns.delete(sym);
      this.addJournal({ kind: "info", symbol: sym, summary: "체결강도 기록 중지" });
    }
    return this.getStrengthState(sym);
  }

  /** 앱 종료 시 모든 타이머 정리(누수 방지). main.ts의 before-quit에서 호출. */
  stopAllStrength(): void {
    for (const run of this.strengthRuns.values()) clearInterval(run.timer);
    this.strengthRuns.clear();
  }

  /** 현재 상태(현재값 + 최근 시계열)를 화면에 돌려준다. */
  getStrengthState(symbol: string): StrengthState {
    const sym = (symbol || "").toUpperCase().trim();
    const samples = this.strengthSeries[sym] ?? [];
    const run = this.strengthRuns.get(sym);
    return {
      symbol: sym,
      running: !!run,
      intervalSec: run?.intervalSec ?? 10,
      windowSec: ToolEngine.STRENGTH_WINDOW_MS / 1000,
      latest: samples.length ? samples[samples.length - 1] : null,
      samples: samples.slice(-120), // 최근 120개만 화면으로(스파크라인·표에 충분)
      lastError: run?.lastError ?? null,
      // [v0.12.0] 최근 시계열로 신호·국면을 계산(순수함수 재사용). 가격·강도만 넘긴다.
      signals: analyzeStrengthSeries(samples.slice(-30).map((s) => ({ price: s.price, strength: s.strength }))),
    };
  }

  /**
   * sampleStrengthOnce — 체결강도 한 점을 수집한다(타이머가 부르는 실제 작업).
   *
   *   [v0.27.0 — "최근 50틱" → "최근 5분" 시간창으로 변경한 이유]
   *   예전엔 폴링마다 getTrades(sym,50)로 받은 "최근 50틱"을 통째로 다시 분류해 강도를 계산했다.
   *   문제는 "최근 50틱"이 가리키는 실제 시간 범위가 종목 유동성마다 완전히 다르다는 것 —
   *   활발한 종목은 몇 초, 뜸한 종목은 십수 분. 그래서 화면에 뜨는 "142" 같은 숫자가 종목마다
   *   서로 다른 자로 잰 값이라 (a) 라이브 타이밍 판단에서 오래된 반응을 "지금"처럼 보여주거나
   *   (b) 매매분석에서 진입시점 강도들을 모아 승률 비교를 해도 비교 자체가 무의미했다.
   *   지금은 "최근 5분"이라는 고정 시간창(모든 종목에 동일 정의)으로 바꿔 반응성과 비교가능성을
   *   둘 다 만족시킨다(감시 시작부터 무한정 누적하지 않는 이유: 시간이 지날수록 창이 계속 커져
   *   방금 일어난 변화가 과거 흐름에 묻혀버리면 라이브 타이밍 용도에 안 맞기 때문).
   *
   *   ① trades(최근 ~50틱) 조회 → ② 숫자 정규화 → ③ 신규 틱만 골라(dedup) 틱룰로 분류 →
   *   ④ 분류된 신규 틱을 시간창 버퍼에 더하고 5분 넘은 옛 것은 버림 → ⑤ 버퍼 전체로 강도 계산
   *   → ⑥ 샘플 한 줄 저장 → ⑦ 화면에 이벤트로 알림. 오류는 삼켜서(다음 주기 재시도) 앱을 지킨다.
   */
  private async sampleStrengthOnce(sym: string): Promise<void> {
    const run = this.strengthRuns.get(sym);
    if (!run) return; // 중지된 사이 타이머가 늦게 도착한 경우
    try {
      await this.prepareBackend();
      const raw = await getTrades(sym, 50);
      // 문자열 → 숫자 정규화(이상값은 버림)
      const ticks = raw
        .map((t) => ({ price: Number(t.price), volume: Number(t.volume), timestamp: t.timestamp }))
        .filter((t) => Number.isFinite(t.price) && Number.isFinite(t.volume) && t.volume > 0);

      // [중복 제거] trades는 커서가 없어 폴링 사이 같은 틱이 겹친다.
      //   (timestamp|price|volume)를 열쇠로, 이번 창에서 '처음 보는' 틱만 남긴다.
      //   [v0.27.0] 이 신규(fresh) 틱만 시간창 버퍼에 더한다 — 예전엔 계산돼 있었는데 실제로는
      //   버려지고 있던 값을 이제 진짜로 쓴다.
      const fresh = ticks.filter((t) => !run.seen.has(`${t.timestamp}|${t.price}|${t.volume}`));
      for (const t of ticks) run.seen.add(`${t.timestamp}|${t.price}|${t.volume}`);
      if (run.seen.size > 5000) run.seen = new Set([...run.seen].slice(-2000)); // 메모리 상한

      // 신규 틱만 틱룰로 분류(이전 폴링의 마지막 가격·방향을 이어받아 연속성 유지).
      const { classified, lastPrice, lastSide } = classifyTicks(fresh, run.lastPrice, run.lastSide);
      run.lastPrice = lastPrice;
      run.lastSide = lastSide;
      run.lastError = null;
      run.failCount = 0; // [v0.22.0] 성공했으니 연속 실패 카운터 리셋

      // 시간창 버퍼에 신규 분류 결과를 더하고, "지금-5분"보다 오래된 것은 잘라낸다(슬라이딩 윈도).
      const now = DateTime.now().setZone("Asia/Seoul");
      const nowMs = now.toMillis();
      const win = updateStrengthWindow(run.buffer, classified, nowMs, ToolEngine.STRENGTH_WINDOW_MS);
      run.buffer = win.buffer;
      const { buyVol, sellVol, strength } = win;

      // [상한도달 표시] 이번 폴링이 서버 상한(50건)을 다 채웠고, 그마저 전부 신규(직전 폴링과
      //   하나도 안 겹침)라면 — 두 폴링 사이에 창을 벗어나 놓친 체결이 있었을 가능성이 크다는
      //   신호다(커서가 없어 그 이상은 확인 불가 — 화면에 정직하게 알린다).
      const windowCapped = isWindowCapped(ticks.length, fresh.length);

      const sample: StrengthSample = {
        ts: now.toFormat("MM-dd HH:mm:ss"),
        tsMs: nowMs,
        price: lastPrice ?? null,
        buyVol,
        sellVol,
        strength,
        nTicks: win.nTicks,
        windowCapped,
        session: getSession(now),
      };

      const arr = this.strengthSeries[sym] ?? (this.strengthSeries[sym] = []);
      arr.push(sample);
      if (arr.length > ToolEngine.STRENGTH_MAX_SAMPLES) arr.shift();
      this.persistStrength();
      this.emit("strength", this.getStrengthState(sym)); // 화면 실시간 갱신
      // [v0.22.0] 자동 기록이 너무 오래 돌면(최대 시간 초과) 스스로 끈다(잊힌 포지션의 무한 폴링 방지).
      if (run.auto && run.startedAtMs != null && Date.now() - run.startedAtMs > ToolEngine.AUTO_MAX_MS) {
        this.addJournal({ kind: "info", symbol: sym, summary: "체결강도 자동 기록 종료 (최대 기록 시간 도달)" });
        this.stopStrength(sym);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (run) {
        run.lastError = msg;
        // [v0.22.0] 자동 기록인데 연속으로 계속 실패하면(연결 없음 등) 무한 재시도 대신 스스로 끈다.
        //   수동으로 켠 기록은 사용자 판단이므로 건드리지 않는다(계속 재시도).
        run.failCount = (run.failCount ?? 0) + 1;
        if (run.auto && run.failCount >= ToolEngine.AUTO_FAIL_STOP) {
          this.addJournal({ kind: "info", symbol: sym, summary: "체결강도 자동 기록 종료 (연결이 없어 기록을 못 함 — 나중에 다시 매매하면 재시작)" });
          this.stopStrength(sym);
        }
      }
      this.emit("strength", this.getStrengthState(sym)); // 오류도 화면에 알림(다음 주기 재시도)
    }
  }

  // --------------------------------------------------------------------------
  // [v0.7.0] 체결강도 자동 기록(Option A) — 진입·청산 순간 스냅샷 + 결과
  //   ⚠️ 전부 '주문 흐름 밖'에서 fire-and-forget + try/catch. 주문 로직/반환값/토글 불변.
  // --------------------------------------------------------------------------

  private loadTrades(): void {
    try {
      this.trades = existsSync(this.tradesPath) ? (JSON.parse(readFileSync(this.tradesPath, "utf8")) as StrengthTrade[]) : [];
    } catch {
      this.trades = [];
    }
  }

  private persistTrades(): void {
    this.scheduleFileSave("trades", this.tradesPath, () => this.trades); // [v0.90.0] 디바운스
  }

  // --------------------------------------------------------------------------
  // [v0.30.0] 자동매매기록 — 자동매매가 낸 매매의 전체 생애주기를 영구 보관한다.
  //   진입 접수 시 한 줄 만들고(watching), 이후 체결확인/청산/취소 시점마다 같은 줄을 id로
  //   찾아 갱신한다. ⚠️ 전부 주문 흐름 밖에서 fire-and-forget + try/catch(기록 실패가 매매를
  //   막으면 안 된다 — saveRationale과 같은 원칙).
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // [v0.62.1] 자동매매 실행(run) 기록 + 리포트
  //   · 켤 때 한 건 열고(openAutoRun), 사이클마다 갱신(touchAutoRun), 끌 때 닫는다(closeAutoRun).
  //   · 앱이 갑자기 꺼져 닫히지 못한 기록은 다음 실행 때 "앱 종료"로 마감한다(loadAutoRuns).
  //   · 모든 기록 작업은 try/catch — 리포트용 기록이 실패해도 매매를 절대 막지 않는다.
  // --------------------------------------------------------------------------

  private loadAutoRuns(): void {
    try {
      const arr = existsSync(this.autoRunsPath) ? (JSON.parse(readFileSync(this.autoRunsPath, "utf8")) as AutoRunRecord[]) : [];
      this.autoRuns = Array.isArray(arr) ? arr : [];
    } catch {
      this.autoRuns = [];
    }
    // 닫히지 않은 채 남은 기록 = 앱이 꺼지면서 끝난 실행. 마지막 활동 시각을 종료 시각으로 삼는다.
    let changed = false;
    for (const r of this.autoRuns) {
      if (r.endedAtMs == null) {
        r.endedAtMs = r.lastActiveAtMs;
        r.endReason = "앱 종료·재시작(자동매매는 앱이 켜져 있는 동안만 작동 — 종료 시각은 마지막 사이클 기준)";
        changed = true;
      }
    }
    if (changed) this.persistAutoRuns();
  }

  private persistAutoRuns(): void {
    try {
      if (this.autoRuns.length > ToolEngine.AUTO_RUNS_MAX) this.autoRuns = this.autoRuns.slice(-ToolEngine.AUTO_RUNS_MAX);
      this.scheduleFileSave("autoRuns", this.autoRunsPath, () => this.autoRuns); // [v0.90.0] 디바운스
    } catch {
      /* 리포트용 기록 실패는 자동매매 진행을 막지 않는다 */
    }
  }

  private openAutoRun(carried: number): void {
    try {
      const now = Date.now();
      this.currentAutoRun = {
        id: `run-${now}`,
        startedAtMs: now,
        lastActiveAtMs: now,
        endedAtMs: null,
        loopCount: 0,
        scanCount: 0,
        endReason: null,
        startAssetsUsd: this.seedBasis === "fixed" ? this.seedFixedUsd : null, // 자동 시드는 첫 사이클에서 채움(touchAutoRun)
        commissionRate: null,
        carriedPositions: carried,
        openPositions: [],
        errors: { apiTimeouts: 0, apiRetries: 0, apiFailures: 0, cycleErrors: 0 },
      };
      this.currentAutoRunNetBase = { ...netStats };
      this.autoRuns.push(this.currentAutoRun);
      this.persistAutoRuns();
    } catch {
      this.currentAutoRun = null;
    }
  }

  /** 사이클이 끝날 때마다(그리고 종료 직전) 실행 기록의 "지금 값"을 갱신하고 저장한다. */
  private touchAutoRun(): void {
    const run = this.currentAutoRun;
    if (!run) return;
    try {
      run.lastActiveAtMs = Date.now();
      run.errors.apiTimeouts = netStats.timeouts - this.currentAutoRunNetBase.timeouts;
      run.errors.apiRetries = netStats.retries - this.currentAutoRunNetBase.retries;
      run.errors.apiFailures = netStats.failures - this.currentAutoRunNetBase.failures;
      run.openPositions = this.autoTradePositions.map((p) => ({ symbol: p.symbol, status: p.status, entry: p.entry, quantity: p.quantity }));
      // 시작 자산: 이 실행의 시드 스냅샷이 잡히면 그 값을 한 번만 기록(이후 입금으로 스냅샷이 올라도 "시작 시점" 값 유지).
      if (run.startAssetsUsd == null) {
        const seed = this.seedBasis === "fixed" ? this.seedFixedUsd : this.autoTradeSeedSnapshotUsd;
        if (seed != null && Number.isFinite(seed)) run.startAssetsUsd = seed;
      }
      this.persistAutoRuns();
      // 수수료율은 한 번만 비동기로 조회(실패하면 null 유지 → 리포트가 "수수료 추정 불가"로 표시)
      if (run.commissionRate == null && !this.commissionLookupBusy) {
        this.commissionLookupBusy = true;
        void this.resolveCommissionRate()
          .then((rate) => {
            if (rate != null && this.currentAutoRun === run) {
              run.commissionRate = rate;
              this.persistAutoRuns();
            }
          })
          .catch(() => undefined)
          .finally(() => {
            this.commissionLookupBusy = false;
          });
      }
    } catch {
      /* 무시 */
    }
  }

  private commissionLookupBusy = false;

  private closeAutoRun(reason: string): void {
    const run = this.currentAutoRun;
    if (!run) return;
    this.touchAutoRun();
    run.endedAtMs = Date.now();
    run.endReason = reason;
    this.currentAutoRun = null;
    this.persistAutoRuns();
  }

  // ==========================================================================
  // [v0.65.0] 매매연구소 — 신호 기록 모드 (주문 없음, 읽기 전용)
  //   오너·카일 합의: "연속 상승 캔들 매매기법"을 실매매에 붙이기 전에, 실제 스크리닝 → 가상 매수 →
  //   로직대로 가상 매매 → 현황까지 전부 **로우 데이터**로 쌓고, 그 로우에서 통계를 낸다.
  //   · 5분마다(앱이 켜져 있는 동안) 토스 거래량 순위 상위 N종목을 훑어 패턴(도지→양봉 연속)을 찾는다.
  //   · 찾은 신호는 "로우"(신호 당시 캔들·지표 + 이후 1분봉 경로)만 저장한다. 가상 매매 결과는
  //     저장하지 않고 로우에서 매번 다시 계산한다(lib/lab.ts — 체결 가정을 바꿔도 과거 데이터가 유효).
  //   · 이 기능은 어떤 주문 API도 부르지 않는다(시세·캔들 조회만).
  // ==========================================================================

  private labPath = "";
  private labSignals: LabSignal[] = [];
  private labAttempts: Record<string, number> = {};
  private labEnabled = false;
  private labRankMigrated = false;
  private labRankCount = 120; //    거래량 순위 몇 위까지 탐색(10~200) — v0.68.0부터 스캔당 요청이 종목당 1회라 기본을 120으로 넓힘(이미 저장된 값은 유지)
  private labDojiBodyMax = 15; //   도지 몸통 비율 상한(%)
  private labBodyMin = 60; //       신호 캔들 몸통 비율 하한(%)
  private labVolMin = 1.5; //       신호 캔들 거래량 배수(직전 5개 평균 대비)
  private labMinRangePct = 0.5; //   [v0.65.1] 신호 캔들 최소 크기(고저폭 ÷ 종가 %) — 1~2틱짜리 초소형 봉의 "몸통 100%" 잡음 제거(0=끔)
  private labNote: string | null = null; // 화면에 한 번 보여 줄 안내(예: 규칙 오류로 옛 데이터 폐기)
  /** [v0.68.0] 매매연구소 전용 1분봉 저장소 — 처음 한 번만 깊게 받고, 이후엔 "새로 생긴 분"만 1회 요청으로 이어 붙인다. */
  private labStore = new Map<string, { candles: Candle[]; deep: boolean }>();
  private labScanCount = 0; //       실제로 돈 스캔 횟수(휴무·양보로 건너뛴 것 제외)
  private labActiveMs = 0; //        스캔이 돈 누적 활성 시간(수집 속도 계산용)
  private labLastScanEndMs: number | null = null;
  private labGen = 0; //            [v0.67.0] 초기화 세대 — 스캔 도중 초기화하면 진행 중이던 스캔이 옛 데이터를 다시 쓰지 못하게
  private labFeePct: number | null = null; // 왕복 수수료 추정(%) — 토스 수수료율 조회가 되면 그 값
  private labLocalVerify: LocalVerify | null = null;
  private labLocalVerifyAt: number | null = null;
  private labTossVerify: { at: number; requested: number; matched: number } | null = null;
  private labDeferTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LAB_LATENCY_MIN = 2; // 가상 체결의 주문 지연 가정(분)
  private static readonly LAB_TOSS_VERIFY_EVERY_MS = 60 * 60_000; // 토스 대조 자동 점검 주기(1시간)
  private static readonly LAB_SCHEMA = 2;
  private labTimer: ReturnType<typeof setInterval> | null = null;
  private labBusy = false;
  private labLastTickAtMs: number | null = null;
  private labLastTickDurMs: number | null = null;
  private labLastError: string | null = null;
  private labLastSkip: string | null = null;
  private labLastScanned = 0;
  private labStartedAtMs: number | null = null;
  private labVersion = 0; //        데이터가 바뀔 때마다 증가 — 요약 캐시 무효화용
  private labMemo = new Map<string, { version: number; value: unknown }>();
  private static readonly LAB_MAX_SIGNALS = 500;
  private static readonly LAB_MAX_ATTEMPTS = 20000;
  private static readonly LAB_INTERVAL_MS = 5 * 60_000;

  /** 1분봉 공용 캐시(2분) — 자동매매 스캔과 매매연구소가 같은 종목을 번갈아 조회해도 토스 요청은 한 번만 나간다. */
  private candleCache = new Map<string, { atMs: number; want: number; candles: Awaited<ReturnType<typeof getCandles1mPaged>> }>();
  /** 매매연구소가 종목마다 "처음 한 번만" 깊게(약 2400개 = 영업시간 기준 하루 반 이상) 받아 과거 신호를 백필한 종목. */
  private labDeepDone = new Set<string>();
  private async getCandles1mCached(symbol: string, ttlMs = 120_000, want = 1100): Promise<Awaited<ReturnType<typeof getCandles1mPaged>>> {
    const hit = this.candleCache.get(symbol);
    if (hit && Date.now() - hit.atMs < ttlMs && hit.want >= want) return hit.candles;
    const candles = want > 1100 ? await getCandles1mPaged(symbol, want, 14) : await getCandles1mPaged(symbol, want);
    this.candleCache.set(symbol, { atMs: Date.now(), want, candles });
    if (this.candleCache.size > 400) {
      const oldest = [...this.candleCache.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0];
      if (oldest) this.candleCache.delete(oldest[0]);
    }
    return candles;
  }

  private labParams(): LabParams {
    return {
      ...LAB_PARAMS_DEFAULT,
      dojiBodyMaxPct: this.labDojiBodyMax,
      bodyMinPct: this.labBodyMin,
      volRatioMin: this.labVolMin,
      minRangePct: this.labMinRangePct,
      latencyMin: ToolEngine.LAB_LATENCY_MIN, //     [v0.67.0] 주문 지연 가정
      feeRoundTripPct: this.labFeePct ?? LAB_PARAMS_DEFAULT.feeRoundTripPct, // 실제 수수료율을 알면 그 값
    };
  }

  private loadLab(): void {
    try {
      if (!existsSync(this.labPath)) return;
      const d = JSON.parse(readFileSync(this.labPath, "utf8")) as { v?: number; signals?: LabSignal[]; attempts?: Record<string, number>; startedAtMs?: number | null };
      // [v0.65.1] 1판(v1) 데이터는 규칙 오류(연속이 아닌 봉을 이어 붙임·몇 주 전 봉·1틱짜리 초소형 봉·무한정 연계 탐색)로
      //   부풀려져 있어 신뢰할 수 없다 — 폐기하고 새 규칙으로 다시 쌓는다(로우는 새로 받아 오므로 백필로 금방 채워진다).
      if ((d.v ?? 1) < ToolEngine.LAB_SCHEMA) {
        const n = Array.isArray(d.signals) ? d.signals.length : 0;
        this.labNote = `v0.65.1 검증 정정: 이전 규칙의 기록 ${n}건은 오류(연속 아닌 봉 연결·몇 주 전 봉·1틱짜리 초소형 봉·무한정 연계 탐색)가 섞여 있어 폐기하고 새 규칙으로 다시 쌓습니다.`;
        this.labSignals = [];
        this.labAttempts = {};
        this.labStartedAtMs = d.startedAtMs ?? null;
        this.persistLab();
        return;
      }
      this.labScanCount = Number((d as { scans?: number }).scans) || 0;
      this.labActiveMs = Number((d as { activeMs?: number }).activeMs) || 0;
      this.labSignals = Array.isArray(d.signals) ? d.signals : [];
      this.labAttempts = d.attempts && typeof d.attempts === "object" ? d.attempts : {};
      this.labStartedAtMs = d.startedAtMs ?? null;
    } catch {
      this.labSignals = [];
      this.labAttempts = {};
    }
  }

  // ==========================================================================
  // [관찰종목 이력 — 오너 요청 "스크리닝 기준 재검토를 위해 관찰 종목도 기록 누적이 필요"]
  // -----------------------------------------------------------------------------
  // 자동 스크리너는 5분마다 통째로 덮어써지는 스냅샷(autoTradeLastScan)만 남겨서, "관찰(watch)"로
  // 잡혔던 종목이 다음에 확정됐는지 탈락했는지(왜) 추적할 길이 없었다. 여기서는 그 생애주기만
  // 별도로 영속 기록한다 — 계산은 전부 순수 함수(updateWatchHistory, 위쪽)가 하고, 엔진은
  // scanScreener 처리부(아래 autoTradeTick)에서 호출해 결과를 저장만 한다.
  // ==========================================================================

  private loadWatchHistory(): void {
    try {
      if (!existsSync(this.watchHistoryPath)) return;
      const d = JSON.parse(readFileSync(this.watchHistoryPath, "utf8")) as { entries?: WatchHistoryEntry[] };
      this.watchHistory = Array.isArray(d.entries) ? d.entries : [];
    } catch {
      this.watchHistory = [];
    }
  }

  private persistWatchHistory(): void {
    this.scheduleFileSave("watchHistory", this.watchHistoryPath, () => ({ entries: this.watchHistory }));
  }

  /** [관찰종목 이력] 화면용 조회 — 최근 시작순, 종목·결과·기간으로 필터. */
  getWatchHistory(f?: { symbol?: string; outcome?: WatchOutcome; sinceMs?: number }): (WatchHistoryEntry & { link: WatchTradeLink })[] {
    // [v0.96.0] confirmed 기록이 실제 매수로 이어졌는지(및 그 성적)를 화면이 매번 다시 계산하지
    // 않도록, 조회 시점에 한 번만 연결해 함께 돌려준다(저장 데이터 자체는 그대로 — 계산은 읽을 때).
    const tradesBySymbol = buildTradesBySymbol(this.autoTradeHistory);
    return this.watchHistory
      .filter(
        (h) =>
          (!f?.symbol || h.symbol.toUpperCase() === f.symbol.toUpperCase()) &&
          (!f?.outcome || h.outcome === f.outcome) &&
          (f?.sinceMs == null || h.watchedAtMs >= f.sinceMs),
      )
      .sort((a, b) => b.watchedAtMs - a.watchedAtMs)
      .map((h) => ({ ...h, link: linkWatchToTrade(h, tradesBySymbol, ToolEngine.AUTO_TRADE_INTERVAL_MS) }));
  }

  /** [관찰종목 이력 — 스크리닝 기준 재검토용] 탈락 사유별 건수 집계 + [v0.96.0] 확정이 실제 매수로
   *  얼마나 이어졌는지(및 그 매매 성적). src/App.tsx의 tallyMissReasons(스캔 1회 안에서만 집계)와
   *  달리 쌓인 전체 이력을 보므로, 기간을 넓게 두고 "스크리닝 기준이 실제로 돈이 되는 신호를
   *  내는지"를 판단하는 데 쓴다. */
  getWatchHistorySummary(sinceMs?: number): {
    total: number;
    watching: number;
    confirmed: number;
    disqualified: number;
    droppedFromScan: number;
    topReasons: { label: string; count: number }[];
    confirmedEntered: number; // [v0.96.0] 확정 → 실제 매수 주문까지 접수된 건수(체결 여부와 무관)
    confirmedNotEntered: number; // 확정됐지만 끝내 매수로 안 이어진 건수(사유는 과거 기록엔 없음)
    confirmToEntryRatePct: number | null; // confirmedEntered ÷ confirmed × 100
    tradeWinCount: number; // 그 매매들 중 청산 손익이 양수로 끝난 건수
    tradeLossCount: number; // 음수로 끝난 건수
    tradeNetPnlUsd: number; // 청산 손익이 확정된 것들의 합(보유 중·미체결은 제외)
  } {
    const rows = sinceMs != null ? this.watchHistory.filter((h) => h.watchedAtMs >= sinceMs) : this.watchHistory;
    const counts: Record<string, number> = {};
    for (const h of rows) {
      if (h.outcome !== "disqualified") continue;
      for (const bucket of h.reasonBuckets) counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    const confirmed = rows.filter((h) => h.outcome === "confirmed");
    const tradesBySymbol = buildTradesBySymbol(this.autoTradeHistory);
    const links = confirmed.map((h) => linkWatchToTrade(h, tradesBySymbol, ToolEngine.AUTO_TRADE_INTERVAL_MS));
    const entered = links.filter((l) => l.traded);
    const pnls = entered.map((l) => l.pnlUsd).filter((p): p is number => p != null);
    return {
      total: rows.length,
      watching: rows.filter((h) => h.outcome === "watching").length,
      confirmed: confirmed.length,
      disqualified: rows.filter((h) => h.outcome === "disqualified").length,
      droppedFromScan: rows.filter((h) => h.outcome === "dropped_from_scan").length,
      topReasons: Object.entries(counts)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      confirmedEntered: entered.length,
      confirmedNotEntered: confirmed.length - entered.length,
      confirmToEntryRatePct: confirmed.length > 0 ? Math.round((entered.length / confirmed.length) * 1000) / 10 : null,
      tradeWinCount: pnls.filter((p) => p > 0).length,
      tradeLossCount: pnls.filter((p) => p < 0).length,
      tradeNetPnlUsd: Math.round(pnls.reduce((s, p) => s + p, 0) * 100) / 100,
    };
  }

  private persistLab(): void {
    try {
      // [v0.90.0] 디바운스 — 연구용 데이터는 자주 쌓여 동기 저장이 메인 프로세스를 자주 막던 지점 중 하나였다.
      this.scheduleFileSave("lab", this.labPath, () => ({
        v: ToolEngine.LAB_SCHEMA, scans: this.labScanCount, activeMs: this.labActiveMs,
        startedAtMs: this.labStartedAtMs, attempts: this.labAttempts, signals: this.labSignals,
      }));
    } catch {
      /* 기록 실패는 무시 — 연구용 데이터라 매매와 무관 */
    }
  }

  private startLabTimer(): void {
    if (this.labTimer) return;
    if (this.labStartedAtMs == null) this.labStartedAtMs = Date.now();
    // [v0.67.0] 앱을 막 켠 직후엔 자동매매·다른 초기 조회가 몰리므로 첫 스캔을 45초 늦춘다(자동매매가 실주문 경로라 우선).
    this.labDeferTimer = setTimeout(() => void this.labScanOnce(), 45_000);
    this.labTimer = setInterval(() => void this.labScanOnce(), ToolEngine.LAB_INTERVAL_MS);
  }

  private stopLabTimer(): void {
    if (this.labTimer) clearInterval(this.labTimer);
    if (this.labDeferTimer) clearTimeout(this.labDeferTimer);
    this.labDeferTimer = null;
    this.labTimer = null;
  }

  /** 연구소 설정 저장 + 켜짐/꺼짐. 값은 범위로 보정한다. */
  saveLabSettings(input: { enabled?: boolean; rankCount?: number; dojiBodyMaxPct?: number; bodyMinPct?: number; volRatioMin?: number; minRangePct?: number }): LabStatus {
    if (typeof input.minRangePct === "number" && Number.isFinite(input.minRangePct)) this.labMinRangePct = Math.round(Math.min(5, Math.max(0, input.minRangePct)) * 100) / 100;
    if (typeof input.rankCount === "number" && Number.isFinite(input.rankCount)) this.labRankCount = Math.round(Math.min(200, Math.max(10, input.rankCount)));
    if (typeof input.dojiBodyMaxPct === "number" && Number.isFinite(input.dojiBodyMaxPct)) this.labDojiBodyMax = Math.round(Math.min(30, Math.max(5, input.dojiBodyMaxPct)) * 10) / 10;
    if (typeof input.bodyMinPct === "number" && Number.isFinite(input.bodyMinPct)) this.labBodyMin = Math.round(Math.min(90, Math.max(40, input.bodyMinPct)) * 10) / 10;
    if (typeof input.volRatioMin === "number" && Number.isFinite(input.volRatioMin)) this.labVolMin = Math.round(Math.min(5, Math.max(1, input.volRatioMin)) * 100) / 100;
    if (typeof input.enabled === "boolean") {
      this.labEnabled = input.enabled;
      if (input.enabled) {
        this.startLabTimer();
        // 오너가 직접 켠 경우엔 45초를 기다리지 않고 바로 한 번 스캔한다(앱 시작 때 자동 재개만 늦춘다).
        if (this.labDeferTimer) { clearTimeout(this.labDeferTimer); this.labDeferTimer = null; void this.labScanOnce(true); }
      } else this.stopLabTimer();
    }
    this.persistEnv();
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary:
        `🔬 매매연구소 설정 — 신호 기록 ${this.labEnabled ? "ON" : "OFF"} · 거래량 순위 ${this.labRankCount}위까지 · ` +
        `도지 몸통 <${this.labDojiBodyMax}% · 신호 몸통 ≥${this.labBodyMin}% · 거래량 ≥직전5평균×${this.labVolMin} · 최소 봉 크기 ${this.labMinRangePct}%`,
      category: "시스템",
    });
    this.labVersion++;
    void this.pushLiveState(true);
    return this.getLabStatus();
  }

  getLabStatus(): LabStatus {
    return {
      enabled: this.labEnabled,
      rankCount: this.labRankCount,
      dojiBodyMaxPct: this.labDojiBodyMax,
      bodyMinPct: this.labBodyMin,
      volRatioMin: this.labVolMin,
      minRangePct: this.labMinRangePct,
      note: this.labNote,
      verify: {
        localAt: this.labLocalVerifyAt,
        localOk: this.labLocalVerify ? this.labLocalVerify.allOk : null,
        localFailed: (this.labLocalVerify?.checks ?? []).filter((c) => c.failed > 0).map((c) => `${c.label} ${c.failed}건`),
        tossAt: this.labTossVerify?.at ?? null,
        tossRequested: this.labTossVerify?.requested ?? 0,
        tossMatched: this.labTossVerify?.matched ?? 0,
      },
      feePct: this.labFeePct,
      collect: (() => {
        const p = this.getSystemPauseStatus();
        return { scans: this.labScanCount, activeHours: Math.round((this.labActiveMs / 3_600_000) * 100) / 100, paused: p.paused, pauseReason: p.reason, resumesAtMs: p.resumesAtMs };
      })(),
      scanning: this.labBusy,
      lastTickAtMs: this.labLastTickAtMs,
      lastTickDurMs: this.labLastTickDurMs,
      lastScanned: this.labLastScanned,
      lastError: this.labLastError,
      lastSkip: this.labLastSkip,
      startedAtMs: this.labStartedAtMs,
      nextTickAtMs: this.labEnabled && this.labLastTickAtMs != null ? this.labLastTickAtMs - (this.labLastTickDurMs ?? 0) + ToolEngine.LAB_INTERVAL_MS : null,
      totalSignals: this.labSignals.length,
      params: this.labParams(),
    };
  }

  /** "지금 스캔" — 켜짐 여부와 무관하게 한 번 훑는다(첫 실행에는 지금 데이터에 남아 있는 과거 약 18시간 분량을 백필한다). */
  async labScanNow(): Promise<LabStatus> {
    await this.labScanOnce(true); // 오너가 직접 누른 스캔은 양보하지 않는다
    return this.getLabStatus();
  }

  /** 모든 연구소 데이터 삭제(복구 불가 — 화면에서 확인 후에만 호출). */
  labReset(): LabStatus {
    this.labGen++; // 진행 중인 스캔의 결과가 초기화 뒤에 다시 쓰이지 않게
    this.labSignals = [];
    this.labAttempts = {};
    this.labLocalVerify = null;
    this.labLocalVerifyAt = null;
    this.labTossVerify = null;
    this.labStartedAtMs = this.labEnabled ? Date.now() : null;
    this.persistLab();
    this.labVersion++;
    void this.pushLiveState(true);
    return this.getLabStatus();
  }

  private async labScanOnce(manual = false): Promise<void> {
    if (this.labBusy) return;
    // [v0.67.0 리스크 해소] 자동매매는 실주문 경로다. 자동매매 사이클·스크리닝이 돌고 있으면 연구소는 양보한다
    //   (같은 토스 "차트" 요청 한도 — 초당 약 5회 — 를 나눠 쓰므로, 연구소가 점유하면 자동매매 스캔이 느려지거나 429가 난다).
    if (!manual && (this.autoTradeTickBusy || this.screenBusy)) {
      this.labLastSkip = "자동매매·스크리닝이 진행 중이라 양보했습니다(곧 다시 시도)";
      if (!this.labDeferTimer) this.labDeferTimer = setTimeout(() => { this.labDeferTimer = null; void this.labScanOnce(); }, 60_000);
      return;
    }
    this.labBusy = true;
    const gen = this.labGen;
    const t0 = Date.now();
    this.labLastError = null;
    this.labLastSkip = null;
    try {
      const pause = this.getSystemPauseStatus();
      if (pause.paused) {
        this.labLastSkip = pause.reason ?? "일시정지 구간";
        return;
      }
      await this.prepareBackend();
      if (this.labFeePct == null) {
        const rate = await this.resolveCommissionRate().catch(() => null);
        if (rate != null && rate > 0) this.labFeePct = Math.max(0.1, Math.round(rate * 2 * 100 * 1000) / 1000); // 왕복 %
      }
      const ranked = await getRankings(this.labRankCount);
      let rankings = ranked;
      if (this.autoScanExcludeEtf) {
        try {
          const metas = await getStocks(ranked.map((r) => r.symbol));
          const bySym = new Map(metas.map((m) => [m.symbol, m]));
          rankings = ranked.filter((r) => {
            const m = bySym.get(r.symbol);
            return !m || m.securityType === "STOCK";
          });
        } catch {
          /* 메타 조회 실패 → 필터 생략 */
        }
      }
      const nowMs = Date.now();
      let scanned = 0;
      // 자동매매가 켜져 있으면 깊은 백필(종목당 최대 14회 요청)은 하지 않고 얕게만 — 실주문 경로의 요청 한도를 아낀다.
      const allowDeep = !this.autoTradeEnabled;
      for (const rk of rankings) {
        if (gen !== this.labGen) break; // 스캔 도중 초기화됨
        try {
          await this.labProcessSymbol(rk.symbol, rk.rank, Number.isFinite(rk.lastPrice) ? rk.lastPrice : null, nowMs, gen, allowDeep);
          scanned++;
        } catch {
          /* 종목 하나의 실패가 전체를 멈추지 않게 */
        }
        await new Promise((r) => setTimeout(r, this.autoTradeEnabled ? 400 : 120)); // 요청 간격을 벌려 한도를 나눠 쓴다
      }
      if (gen !== this.labGen) return;
      this.labLastScanned = scanned;
      this.labScanCount++;
      this.labActiveMs += Math.min(Date.now() - (this.labLastScanEndMs ?? Date.now() - ToolEngine.LAB_INTERVAL_MS), 6 * 60_000);
      this.labLastScanEndMs = Date.now();
      this.labFinalizeStale(nowMs);
      this.labTrim();
      this.persistLab();
      this.labVersion++;
      await this.labAutoVerify();
    } catch (e) {
      this.labLastError = String(e).replace(/^Error:\s*/, "");
    } finally {
      this.labBusy = false;
      this.labLastTickAtMs = Date.now();
      this.labLastTickDurMs = Date.now() - t0;
      void this.pushLiveState(true);
    }
  }

  /**
   * [v0.68.0] 연구소 전용 1분봉 조회 — 종목당 처음 한 번만 깊게(2400개) 받고, 이후엔 가장 최근 200개(요청 1회)만 받아 이어 붙인다.
   *   예전엔 스캔마다 종목당 6회 요청이라 순위를 넓히기 어려웠다(60종목=360회/5분). 이제 60종목=60회, 200종목=200회(약 40초).
   *   앱이 오래 멈췄다 돌아와 마지막 봉이 150분보다 오래됐으면(최근 200개로는 공백을 못 메움) 다시 통으로 받는다.
   *   자동매매 스캔이 쓰는 공용 캐시(getCandles1mCached)는 건드리지 않는다 — 실주문 경로라 연구소 변경의 영향을 받으면 안 된다.
   */
  private async labFetch1m(symbol: string, allowDeep: boolean): Promise<Candle[]> {
    const ent = this.labStore.get(symbol);
    const last = ent && ent.candles.length ? ent.candles[ent.candles.length - 1].time : 0;
    const needFull = !ent || (allowDeep && !ent.deep) || Date.now() - last > 150 * 60_000;
    if (needFull) {
      const deep = allowDeep;
      const candles = deep ? await getCandles1mPaged(symbol, 2400, 14) : await getCandles1mPaged(symbol, 1100);
      this.labStore.set(symbol, { candles, deep: deep || (ent?.deep ?? false) });
      this.labTrimStore();
      return candles;
    }
    const fresh = await getCandles1mLatest(symbol, 200);
    const m = new Map<number, Candle>();
    for (const c of ent!.candles) m.set(c.time, c);
    for (const c of fresh) m.set(c.time, c); // 같은 분이면 새 값으로(진행 중이던 분이 확정됨)
    const merged = [...m.values()].sort((a, b) => a.time - b.time).slice(-2600);
    this.labStore.set(symbol, { candles: merged, deep: ent!.deep });
    return merged;
  }

  /** 저장소가 너무 커지지 않게(종목 수가 많이 바뀌어도) 오래 안 쓴 종목부터 비운다. */
  private labTrimStore(): void {
    if (this.labStore.size <= 400) return;
    const oldest = [...this.labStore.entries()].sort((a, b) => (a[1].candles.at(-1)?.time ?? 0) - (b[1].candles.at(-1)?.time ?? 0))[0];
    if (oldest) this.labStore.delete(oldest[0]);
  }

  /** [v0.67.0] 갱신이 끊긴(시리즈에서 사라진) 미완료 신호를 정리한다 — 필요한 관찰 구간이 지났으면 그대로 마감한다(영원히 "진행 중"으로 남지 않게). */
  private labFinalizeStale(nowMs: number): void {
    const P = this.labParams();
    this.labSignals = this.labSignals.map((s) => (!s.complete && nowMs >= requiredPathEndMs(s, P) + 10 * 60_000 ? { ...s, complete: true, linkageDone: true } : s));
  }

  /**
   * [v0.67.0 — 오너 질문 "실제 데이터 검증을 주기적으로 하고 있나?"] 예전엔 버튼을 눌러야만 검증이 돌았다. 이제 스캔이 끝날 때마다
   *   ① 저장된 로우 재계산 검증(가벼움)을 자동으로 돌리고 ② 1시간마다 표본 3건을 토스에서 다시 받아 대조한다.
   *   실패하면 서버 로그에 경고를 남기고(화면 배너에도 표시) 결과 요약의 "실매매 전환 게이트"가 막힌다.
   */
  private async labAutoVerify(): Promise<void> {
    try {
      const prevOk = this.labLocalVerify?.allOk ?? true;
      this.labLocalVerify = verifyLocal(this.labSignals, this.labParams());
      this.labLocalVerifyAt = Date.now();
      if (!this.labLocalVerify.allOk && prevOk) {
        const bad = this.labLocalVerify.checks.filter((c) => c.failed > 0).map((c) => `${c.label} ${c.failed}건`).join(", ");
        this.addJournal({ kind: "info", symbol: "-", summary: `🔬 매매연구소 데이터 검증 경고 — 저장된 로우 재계산에서 불일치: ${bad}`, category: "시스템" });
      }
      const due = this.labTossVerify == null || Date.now() - this.labTossVerify.at >= ToolEngine.LAB_TOSS_VERIFY_EVERY_MS;
      if (due && this.labSignals.length > 0) {
        const t = await this.labTossCheck(3);
        if (t.requested > 0) {
          this.labTossVerify = { at: Date.now(), requested: t.requested, matched: t.matched };
          if (t.matched / t.requested < 0.8) {
            this.addJournal({ kind: "info", symbol: "-", summary: `🔬 매매연구소 토스 대조 경고 — 표본 ${t.requested}건 중 ${t.matched}건만 일치(저장된 봉이 토스 재조회 값과 다름)`, category: "시스템" });
          }
        }
      }
    } catch {
      /* 검증 자체의 실패가 연구소 동작을 막지 않게 */
    }
  }

  private async labProcessSymbol(symbol: string, rank: number, lastPrice: number | null, nowMs: number, gen: number = this.labGen, allowDeep = true): Promise<void> {
    // EMA200은 5분봉 200개(1분봉 1000개)가 있어야 시작되므로 보통 받는 1100개로는 최근 약 3시간만 패턴을 찾을 수 있다.
    //   그래서 종목마다 처음 한 번은 더 깊게(2400개) 받아 과거 신호를 백필하고, 그 뒤엔 공용 캐시(1100개)로 가볍게 이어간다.
    const oneMin = await this.labFetch1m(symbol, allowDeep);
    const raw5m: Candle[] = dropIncompleteBucket(aggregate1mTo5m(oneMin), nowMs);
    if (raw5m.length < 210) return; // EMA200 + 여유
    const P = this.labParams();
    const series = buildSeries(raw5m, 200);
    const runs = detectRuns(series.ha, series.emaS, P, nowMs);

    for (const run of runs) {
      const dojiT = series.ha[run.dojiIdx].time;
      const id = `${symbol}:${dojiT}`;
      const stage = run.stage === 3 && run.volOk2 && run.rangeOk2 ? 4 : run.stage; // 4 = 인정 신호(몸통+거래량+봉 크기)
      if ((this.labAttempts[id] ?? -1) < stage) this.labAttempts[id] = stage;
      if (run.stage < 3) continue;

      const idx = this.labSignals.findIndex((s) => s.id === id);
      const existing = idx >= 0 ? this.labSignals[idx] : null;
      if (existing?.complete) continue; // 끝난 신호는 고정(더 이상 건드리지 않음)

      const c2T = series.ha[run.dojiIdx + 2].time;
      const c2Close = series.raw[run.dojiIdx + 2].close;
      // 가격대: 자동매매 스캔과 같은 가격대($1~9 기본)에 든 종목만 기록(쓸데없는 데이터 배제)
      if (!(c2Close >= this.autoScanPriceMin && c2Close <= this.autoScanPriceMax)) continue;

      const dtC2 = DateTime.fromMillis(c2T).setZone("Asia/Seoul");
      const sessionStart = getSessionStart(dtC2);
      const link = {
        sessionStartMs: sessionStart ? sessionStart.toMillis() : c2T - 8 * 3600_000,
        bodyRatio: this.autoScanBodyRatio,
        wickMin: this.autoScanDojiWickMinRatio,
        maxAgeMin: this.autoScanDojiMaxAgeEnabled ? this.autoScanDojiMaxAgeMinutes : Number.POSITIVE_INFINITY,
        maxGapMin: this.autoScanDojiMaxGapEnabled ? this.autoScanDojiMaxGapMinutes : Number.POSITIVE_INFINITY,
        tpPct: this.defaultTpPct,
        slPct: this.defaultSlPct,
        emaPeriod: this.autoScanEmaPeriod,
      };
      const built = buildSignal({
        symbol,
        rank,
        run,
        series,
        oneMin,
        nowMs,
        session: getSession(dtC2.plus({ minutes: 5 })),
        thinHours: isInDailyPauseWindow(dtC2, ToolEngine.SYSTEM_PAUSE_START_HOUR, ToolEngine.SYSTEM_PAUSE_END_HOUR),
        link,
        P,
      });
      // 처음 발견한 시각·순위·실시간 여부는 보존한다.
      const next: LabSignal = existing ? { ...built, detectedAtMs: existing.detectedAtMs, backfilled: existing.backfilled, rank: existing.rank } : built;
      if (gen !== this.labGen) return; // 초기화된 뒤엔 옛 스캔 결과를 쓰지 않는다
      if (idx >= 0) this.labSignals[idx] = next;
      else this.labSignals.push(next);
    }
    void lastPrice;
  }

  /** 상한을 넘으면 오래된(이미 끝난) 신호부터 버린다. attempts도 상한 관리. */
  private labTrim(): void {
    if (this.labSignals.length > ToolEngine.LAB_MAX_SIGNALS) {
      this.labSignals.sort((a, b) => a.c2T - b.c2T);
      const drop = this.labSignals.length - ToolEngine.LAB_MAX_SIGNALS;
      this.labSignals = this.labSignals.slice(drop);
    }
    const keys = Object.keys(this.labAttempts);
    if (keys.length > ToolEngine.LAB_MAX_ATTEMPTS) {
      for (const k of keys.slice(0, keys.length - ToolEngine.LAB_MAX_ATTEMPTS)) delete this.labAttempts[k];
    }
  }

  private labFilterFrom(f?: LabQueryFilter): LabFilter {
    return {
      includeIneligible: !!f?.includeIneligible,
      includeThin: !!f?.includeThin,
      includeBackfilled: f?.includeBackfilled !== false,
      session: f?.session || undefined,
    };
  }

  private labMemoGet<T>(key: string, build: () => T): T {
    const hit = this.labMemo.get(key);
    if (hit && hit.version === this.labVersion) return hit.value as T;
    const value = build();
    this.labMemo.set(key, { version: this.labVersion, value });
    if (this.labMemo.size > 60) this.labMemo.delete(this.labMemo.keys().next().value as string);
    return value;
  }

  /** 화면용 요약: 깔때기·변형 성적표·연계 요약·신호 목록(가벼운 행). 기준 변형(refKey)의 결과를 행마다 붙인다. */
  getLabSummary(f?: LabQueryFilter): LabSummary {
    const filter = this.labFilterFrom(f);
    const refKey = f?.refKey || "DD-1.5-e1";
    // 무거운 계산(변형 성적표 등)은 데이터 버전별로 캐시하고, 상태(스캔 중 여부 등)는 매번 새로 붙인다.
    const memo = this.labMemoGet(`sum|${JSON.stringify(filter)}|${refKey}`, () => {
      const P = this.labParams();
      const pool = this.labSignals.filter((s) => (filter.includeThin || !s.thinHours) && (filter.includeBackfilled !== false || !s.backfilled));
      const rows: LabSignalRow[] = [...this.labSignals]
        .sort((a, b) => b.c2T - a.c2T)
        .slice(0, 300)
        .map((s) => {
          const t = simulateSignal(s, P).find((x) => x.key === refKey) ?? null;
          return {
            id: s.id,
            symbol: s.symbol,
            rank: s.rank,
            session: s.session,
            thinHours: s.thinHours,
            backfilled: s.backfilled,
            eligible: s.eligible,
            whyIneligible: s.whyIneligible ?? null,
            rangePct2: s.rangePct2 ?? null,
            c2T: s.c2T,
            dojiT: s.dojiT,
            volRatio2: s.volRatio2,
            body2: s.body2,
            secondQualified: s.second?.qualified ?? false,
            c4Block: s.c4 ? s.c4.block : null,
            emaGapPct: s.metrics.emaGapPct,
            atrPct: s.metrics.atrPct,
            price: s.metrics.price,
            linked: s.linkage != null,
            complete: s.complete,
            ref: t ? { key: t.key, status: t.status, netPct: t.netPct ?? null, fillPx: t.fillPx ?? null, exitPx: t.exitPx ?? null, note: t.note ?? null } : null,
          };
        });
      return {
        updatedAtMs: Date.now(),
        status: this.getLabStatus(),
        funnel: buildFunnel(this.labAttempts, pool),
        linkage: summarizeLinkage(this.labSignals, filter),
        variants: summarizeVariants(this.labSignals, filter, P),
        signals: rows,
        refKey,
        counts: {
          total: this.labSignals.length,
          eligible: this.labSignals.filter((s) => s.eligible).length,
          complete: this.labSignals.filter((s) => s.complete).length,
          open: this.labSignals.filter((s) => !s.complete).length,
        },
      } satisfies LabSummary;
    });
    return { ...memo, status: this.getLabStatus() };
  }

  /** 신호 한 건의 전체 로우 + 모든 변형 결과(상세 보기용). */
  getLabSignal(id: string): { signal: LabSignal; trades: SimTrade[] } | null {
    const s = this.labSignals.find((x) => x.id === id);
    return s ? { signal: s, trades: simulateSignal(s, this.labParams()) } : null;
  }

  getLabBreakdown(key: string, dim: BreakdownDim, f?: LabQueryFilter): BreakdownRow[] {
    const filter = this.labFilterFrom(f);
    return this.labMemoGet(`bd|${key}|${dim}|${JSON.stringify(filter)}`, () => breakdownBy(this.labSignals, key, dim, filter, this.labParams()));
  }

  getLabCombined(candleKey: string, linkKey: string, f?: LabQueryFilter): CombinedResult {
    const filter = this.labFilterFrom(f);
    return this.labMemoGet(`cb|${candleKey}|${linkKey}|${JSON.stringify(filter)}`, () => combinedScenario(this.labSignals, candleKey, linkKey, filter, this.labParams()));
  }

  /** 내보내기: 신호 로우 CSV / 가상 매매 CSV(신호×변형) / 원본 JSON(전체 로우). */
  exportLab(kind: "signals-csv" | "trades-csv" | "json"): { filename: string; text: string } {
    const stamp = DateTime.now().setZone("Asia/Seoul").toFormat("yyyyMMdd-HHmm");
    if (kind === "signals-csv") return { filename: `capri-lab-signals-${stamp}.csv`, text: signalsToCsv(this.labSignals) };
    if (kind === "trades-csv") return { filename: `capri-lab-trades-${stamp}.csv`, text: tradesToCsv(this.labSignals, this.labParams()) };
    return { filename: `capri-lab-raw-${stamp}.json`, text: JSON.stringify({ exportedAt: new Date().toISOString(), params: this.labParams(), attempts: this.labAttempts, signals: this.labSignals }) };
  }

  /**
   * [v0.66.0 — 오너 요청 "갑자기 데이터가 엄청 나왔는데 실제 데이터가 맞는지 검증"] 두 단계 검증:
   *   ① local: 저장된 로우를 다시 계산해 규칙과 맞는지(연속성·몸통·거래량·가격 정합성·최신성·경로·연계 상한).
   *   ② toss : 표본 신호의 신호 봉을 토스에서 **지금 다시 받아** 저장된 값과 비교(캐시를 거치지 않는 새 요청).
   *   읽기 전용(시세 조회만). 토스 대조는 연결이 없거나 오류여도 ①은 항상 돌려준다.
   */
  async verifyLab(sample = 8): Promise<{ at: number; local: LocalVerify; toss: { requested: number; matched: number; rows: TossCompareRow[]; error: string | null } | null }> {
    const local = verifyLocal(this.labSignals, this.labParams());
    this.labLocalVerify = local;
    this.labLocalVerifyAt = Date.now();
    const toss = await this.labTossCheck(sample);
    if (toss.requested > 0) this.labTossVerify = { at: Date.now(), requested: toss.requested, matched: toss.matched };
    this.labVersion++; // 게이트(검증 최신성)가 바뀌므로 평가 캐시 무효화
    return { at: Date.now(), local, toss };
  }

  /** 표본 신호의 신호 봉을 토스에서 캐시 없이 다시 받아 비교한다. */
  private async labTossCheck(sample: number): Promise<{ requested: number; matched: number; rows: TossCompareRow[]; error: string | null }> {
    let toss: { requested: number; matched: number; rows: TossCompareRow[]; error: string | null };
    try {
      await this.prepareBackend();
      // 표본: 최근 신호 위주(토스 1분봉은 최근 약 하루 반만 받을 수 있다), 종목이 겹치지 않게
      const pick: LabSignal[] = [];
      const seen = new Set<string>();
      for (const s of [...this.labSignals].sort((a, b) => b.c2T - a.c2T)) {
        if (Date.now() - s.c2T > 30 * 3600_000) continue;
        if (seen.has(s.symbol)) continue;
        seen.add(s.symbol);
        pick.push(s);
        if (pick.length >= Math.max(1, Math.min(20, sample))) break;
      }
      const rows: TossCompareRow[] = [];
      for (const s of pick) {
        try {
          const one = await getCandles1mPaged(s.symbol, 2400, 14); // 캐시를 거치지 않는 새 요청
          const fresh5m = aggregate1mTo5m(one);
          rows.push(compareWithFresh(s, fresh5m));
        } catch (e) {
          rows.push({ id: s.id, symbol: s.symbol, c2T: s.c2T, status: "missing" });
          void e;
        }
      }
      toss = { requested: pick.length, matched: rows.filter((r) => r.status === "match").length, rows, error: pick.length === 0 ? "최근 30시간 안의 신호가 없어 대조할 표본이 없습니다." : null };
    } catch (e) {
      toss = { requested: 0, matched: 0, rows: [], error: String(e).replace(/^Error:\s*/, "") };
    }
    return toss;
  }

  /**
   * [v0.67.0] 종합 평가 — 결론 + 허점 점검(신뢰구간·시간 분할 검증·스트레스·집중도·지연) + 실매매 전환 게이트.
   *   realtimeOnly=true(기본, 권장): 신호 봉이 마감된 직후 실시간으로 발견한 신호만으로 결론(백필은 오늘 거래량 상위 종목만 골라 본 선택 편향이 있다).
   */
  getLabAssessment(realtimeOnly = true): Assessment {
    const key = `as|${realtimeOnly}|${this.labLocalVerifyAt ?? 0}|${this.labTossVerify?.at ?? 0}|${this.labScanCount}`;
    return this.labMemoGet(key, () =>
      buildAssessment(this.labSignals, this.labParams(), {
        realtimeOnly,
        nowMs: Date.now(),
        collect: { activeMs: this.labActiveMs, scans: this.labScanCount, startedAtMs: this.labStartedAtMs },
        verify: {
          localOk: this.labLocalVerify ? this.labLocalVerify.allOk : null,
          localAt: this.labLocalVerifyAt,
          tossRate: this.labTossVerify && this.labTossVerify.requested > 0 ? this.labTossVerify.matched / this.labTossVerify.requested : null,
          tossAt: this.labTossVerify?.at ?? null,
        },
      }),
    );
  }

  /** 폰 미러용 가벼운 요약(상위 변형 + 최근 신호). */
  private labMirror(): LabMirror | null {
    try {
      if (!this.labEnabled && this.labSignals.length === 0) return null;
      const s = this.getLabSummary({});
      const top = s.variants
        .filter((v) => v.filled >= 3 && v.kind === "candle" && v.entryIdx === 1)
        .sort((a, b) => (b.expectancyPerSignal ?? -999) - (a.expectancyPerSignal ?? -999))
        .slice(0, 12);
      return { updatedAtMs: s.updatedAtMs, status: s.status, funnel: s.funnel, linkage: s.linkage, topVariants: top, signals: s.signals.slice(0, 40), counts: s.counts, refKey: s.refKey, assessment: this.getLabAssessment(true) };
    } catch {
      return null;
    }
  }

  /** 최근 실행 N건의 리포트(최신순). 지금 실행 중인 건 "진행 중" 리포트로 포함된다. */
  private buildRecentReports(n: number): AutoReport[] {
    try {
      const now = Date.now();
      return this.autoRuns
        .slice(-n)
        .reverse()
        .map((r) => buildAutoReport(r, this.autoTradeHistory, now));
    } catch {
      return [];
    }
  }

  /**
   * [v0.62.1] 자동매매 리포트 목록. PC(실제로 자동매매를 돌리는 쪽)는 자기 실행 기록으로 계산하고,
   *   기록이 없는 기기(폰 등)는 PC가 상태 미러(capri_live_state)에 올려 둔 최근 리포트를 대신 보여준다.
   */
  async getAutoReports(): Promise<{ ok: boolean; reports: AutoReport[]; source: "local" | "pc"; message?: string }> {
    const local = this.buildRecentReports(10);
    if (local.length > 0) return { ok: true, reports: local, source: "local" };
    const live = await this.getLiveState();
    if (live.ok) {
      return { ok: true, reports: live.reports, source: "pc", message: live.reports.length === 0 ? "PC에 아직 자동매매 실행 기록이 없습니다." : undefined };
    }
    return { ok: true, reports: [], source: "local", message: "아직 자동매매 실행 기록이 없습니다. 자동매매를 한 번 켰다 끄면 리포트가 만들어집니다." };
  }

  private loadAutoTradeHistory(): void {
    try {
      this.autoTradeHistory = existsSync(this.autoTradeHistoryPath)
        ? (JSON.parse(readFileSync(this.autoTradeHistoryPath, "utf8")) as AutoTradeHistoryEntry[])
        : [];
    } catch {
      this.autoTradeHistory = [];
    }
  }

  /** [v0.102.0] 이 기기 파일에만 저장(클라우드로 올리지 않음) — 클라우드에서 받아 합친 직후에 쓴다. */
  private saveAutoHistoryLocal(): void {
    try {
      if (this.autoTradeHistory.length > ToolEngine.AUTO_TRADE_HISTORY_MAX) {
        // 기록은 진입 시각(연도 포함) 순으로 정렬돼 있으므로 앞쪽(가장 오래된 것)부터 잘린다 — 모든 기기가 같은 규칙.
        this.autoTradeHistory = this.autoTradeHistory.slice(-ToolEngine.AUTO_TRADE_HISTORY_MAX);
      }
      this.scheduleFileSave("autoHistory", this.autoTradeHistoryPath, () => this.autoTradeHistory); // [v0.90.0] 디바운스
    } catch {
      /* 기록 실패는 자동매매 진행을 막지 않는다 */
    }
  }

  private persistAutoTradeHistory(): void {
    this.saveAutoHistoryLocal();
    // [v0.31.0] 로그인 상태면 다른 기기도 곧바로 볼 수 있게 클라우드에도 올려 둔다(실패는 recordSync가 기록·경고).
    //   · 15초에 한 번으로 제한 — 상태 전이마다(watching→active→종료) 매번 올리면 과함.
    //   · [v0.102.0] 15초 안에 또 바뀌면 건너뛰지 않고 남은 시간 뒤로 예약한다(예전엔 그 변경이 다음 점검까지 누락).
    this.schedulePush("autoState", 15_000);
    // [v0.35.0] 그룹 공유(평문, capri_group_trades)도 같은 타이밍·쓰로틀로 함께 올린다 —
    //   로그인만 돼 있으면 되고(비밀번호는 필요 없음 — 암호화하지 않으므로), 실패해도
    //   조용히 무시(개인 기록은 이미 로컬+개인 클라우드에 안전하게 저장돼 있다).
    const groupLongEnough = Date.now() - (this.lastGroupPushAtMs ?? 0) > 15_000;
    if (groupLongEnough && this.authEmail) {
      void this.syncPushGroupTrades().catch(() => {
        /* 업로드 실패는 조용히 넘어간다 */
      });
    }
  }

  /** 새 진입이 접수될 때 한 줄 추가("watching" 상태).
   *  [v0.45.0] criteriaSnapshot — 자동매매 진입일 때만 호출부(autoTradeTick)가 "지금 이 순간의
   *  스크리닝·리스크 설정"을 함께 넘긴다(수동 매매 경로는 이 함수를 호출하지 않음). */
  private addAutoTradeHistory(pos: AutoPosition, criteriaSnapshot?: AutoTradeHistoryEntry["criteriaSnapshot"]): void {
    try {
      this.autoTradeHistory.push({
        id: `${pos.symbol}@${pos.entry}@${pos.enteredAtMs}`,
        symbol: pos.symbol,
        entry: pos.entry,
        tp: pos.tp,
        sl: pos.sl,
        quantity: pos.quantity,
        enteredAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
        status: "watching",
        exitedAt: null,
        exitPrice: null,
        pnlUsd: null,
        pnlPct: null,
        note: "매수 주문 접수 — 체결 대기 중",
        conditionalOrderId: pos.conditionalOrderId,
        buyOrderId: pos.buyOrderId,
        criteriaSnapshot,
        updatedAtMs: Date.now(), // [v0.102.0] 마지막으로 고친 시각(기기 간 "누가 최신인가"의 기준)
      });
      this.persistAutoTradeHistory();
    } catch {
      /* 위와 동일 */
    }
  }

  /**
   * [v0.63.0] 매매 하나가 익절/손절로 끝난 직후 실행.
   *   ⑤-b 이번 실행에서 연속 손절이 한도에 닿으면 자동매매를 스스로 멈춘다(보험).
   *   ② 보유 기간의 최저·최고가(MAE/MFE)를 1분봉으로 계산해 기록한다(fire-and-forget, 실패해도 무시).
   */
  private afterAutoTradeClosed(h: AutoTradeHistoryEntry): void {
    try {
      if (h.status === "closed_loss" && this.autoTradeEnabled && this.autoTradeLossStreakLimit > 0) {
        const since = this.currentAutoRun?.startedAtMs;
        const streak = trailingStopLossStreak(this.autoTradeHistory, since, Date.now());
        if (streak >= this.autoTradeLossStreakLimit) {
          this.stopAutoTrade(
            `연속 손절 ${streak}회(한도 ${this.autoTradeLossStreakLimit}회) — 시장 상황이 전략과 맞지 않을 수 있어 자동으로 멈췄습니다. ` +
              `확인 후 다시 켜 주세요(설정에서 한도 조절·끄기 가능).`,
          );
        }
      }
    } catch {
      /* 무시 — 기록 훅 실패가 매매 흐름을 막으면 안 된다 */
    }
    void this.recordExcursion(h).catch(() => undefined);
  }

  /** ② 보유 중 최대 역행·순행(MAE/MFE) — 진입 접수 시각부터 지금까지의 1분봉 최저·최고가로 계산. */
  private async recordExcursion(h: AutoTradeHistoryEntry): Promise<void> {
    const enteredMs = Number(h.id.split("@").pop());
    if (!Number.isFinite(enteredMs)) return;
    const nowMs = Date.now();
    const minutes = Math.ceil((nowMs - enteredMs) / 60_000) + 5;
    if (minutes > 1100) return; // 너무 오래 보유한 건(약 18시간 초과) 1분봉 조회량이 커 생략
    const candles = await getCandles1mPaged(h.symbol, minutes, 6);
    const ex = excursion(candles, h.entry, enteredMs, nowMs);
    if (!ex) return;
    const idx = this.autoTradeHistory.findIndex((x) => x.id === h.id);
    if (idx === -1) return;
    this.autoTradeHistory[idx] = { ...this.autoTradeHistory[idx], maePct: ex.maePct, mfePct: ex.mfePct, updatedAtMs: this.nextHistoryStamp(this.autoTradeHistory[idx]) };
    this.persistAutoTradeHistory();
  }

  /** [v0.102.0] 수정 시각 — 시계가 같은 ms를 돌려줘도 항상 이전 값보다 커지게(+1ms) 해서 "최신" 판정이 흔들리지 않게 한다. */
  private nextHistoryStamp(prev: AutoTradeHistoryEntry): number {
    return Math.max(Date.now(), (prev.updatedAtMs ?? 0) + 1);
  }

  /** 이후 상태 전이(체결확인/청산/취소) 때 같은 줄을 id로 찾아 갱신. */
  private updateAutoTradeHistory(symbol: string, entry: number, enteredAtMs: number, patch: Partial<AutoTradeHistoryEntry>): void {
    try {
      const id = `${symbol}@${entry}@${enteredAtMs}`;
      const idx = this.autoTradeHistory.findIndex((h) => h.id === id);
      if (idx === -1) return; // 기록 자체가 없으면(예: 구버전 데이터) 조용히 무시
      const before = this.autoTradeHistory[idx];
      // [v0.102.0] 고칠 때마다 updatedAtMs를 새로 찍는다 — 상태가 같은 수정(수량·체결가·익절/손절가 등)도 다른 기기로 넘어가게.
      this.autoTradeHistory[idx] = { ...before, ...patch, updatedAtMs: this.nextHistoryStamp(before) };
      this.persistAutoTradeHistory();
      // [v0.63.0] 익절/손절로 "막 끝난" 순간(전이 시점에 한 번만) — 측정·연속 손절 확인.
      const wasClosed = before.status === "closed_win" || before.status === "closed_loss";
      const nowClosed = patch.status === "closed_win" || patch.status === "closed_loss";
      if (!wasClosed && nowClosed) this.afterAutoTradeClosed(this.autoTradeHistory[idx]);
    } catch {
      /* 위와 동일 */
    }
  }

  /** "자동매매기록" 탭이 읽는 목록 — 최신이 위로 오게 뒤집어 준다(rationale 목록과 같은 관례). */
  getAutoTradeHistory(): AutoTradeHistoryEntry[] {
    return this.autoTradeHistory.slice(-300).reverse();
  }

  // --------------------------------------------------------------------------
  // [v0.30.1 긴급수정] 자동매매 "지금 감시 중" 포지션 영속화 — 오너 보고: 앱을 껐다 켜거나
  //   업데이트하면 이 목록이 사라지는데, 실제 토스엔 그 주문이 그대로 남아있어 위험하다.
  //   구조는 autoTradeHistory와 동일(파일 하나, 변경마다 원자적 저장) — usedKeys(중복진입 방지)도
  //   같은 파일에 함께 저장한다(둘 다 "지금 감시 대상이 뭔지"를 나타내는 한 묶음 상태이므로).
  // --------------------------------------------------------------------------
  /**
   * [v0.61.4 긴급수정 — 오너 SQL 직접 조회로 원인 확정] lastScan/lastCycleAt(Ms)도 이 파일에
   *   함께 저장한다. 예전엔 이 셋이 메모리 전용이라 **앱이 재시작될 때마다 사라졌다** —
   *   `autoTradePositions`(감시 포지션)는 이미 재시작해도 이어받는데, 정작 "방금 뭘 스캔했는지"는
   *   매번 null로 리셋됐다. 평소엔 5분마다 새 스캔이 돌아 금방 다시 채워지니 티가 안 났지만,
   *   **자동매매가 꺼진 상태로 재시작**되면(예: 자동 업데이트 — "자동매매 켜져 있으면 재시작 안
   *   함" 안전장치가 풀리는 바로 그 순간) 아무도 다시 스캔을 안 돌려 영원히 null로 남았다.
   *   거기다 그 "방금 리셋된 null"이 재시작 직후 포지션 재확인(reconcileAutoPositionsNow)의
   *   `pushLiveState`를 타고 그대로 클라우드에 올라가, **재시작 전까지 폰에 잘 보이던 실제
   *   스캔 결과를 null로 덮어써 지워버렸다** — 오너가 "지금 새로고침을 4번 눌러도 안 바뀐다"고
   *   보고한 증상의 실제 원인(SQL로 직접 확인: PC app_version=0.61.3, 재시작 직후로 보이는
   *   시점부터 lastScan·lastCycleAt이 전부 null).
   */
  private loadAutoPositions(): void {
    try {
      if (!existsSync(this.autoPositionsPath)) return;
      const raw = JSON.parse(readFileSync(this.autoPositionsPath, "utf8")) as {
        positions?: AutoPosition[];
        usedKeys?: string[];
        lastScan?: ScreenRun | null;
        lastCycleAt?: string | null;
        lastCycleAtMs?: number | null;
        unprotected?: UnprotectedPos[];
        dismissed?: Record<string, number>;
      };
      this.autoUnprotected = Array.isArray(raw.unprotected) ? raw.unprotected : [];
      this.guardDismissed = raw.dismissed && typeof raw.dismissed === "object" ? raw.dismissed : {};
      this.autoTradePositions = Array.isArray(raw.positions) ? raw.positions : [];
      this.autoTradeUsedKeys = new Set(Array.isArray(raw.usedKeys) ? raw.usedKeys : []);
      this.autoTradeLastScan = raw.lastScan ?? null;
      this.autoTradeLastCycleAt = raw.lastCycleAt ?? null;
      this.autoTradeLastCycleAtMs = raw.lastCycleAtMs ?? null;
    } catch {
      // 파일이 깨졌어도 앱이 죽으면 안 된다 — 빈 상태로 시작(실제 주문은 토스에 남아있으니
      // 오너가 [주문현황]에서 직접 확인 가능, 최소한 새 진입이 막히진 않음).
      this.autoTradePositions = [];
      this.autoTradeUsedKeys = new Set();
      this.autoTradeLastScan = null;
      this.autoTradeLastCycleAt = null;
      this.autoTradeLastCycleAtMs = null;
    }
  }

  private saveAutoPositions(): void {
    try {
      // [v0.90.0] 디바운스 — getter가 flush 시점의 최신 멤버들을 다시 모아 담는다(스냅샷을 미리 만들어두지 않음).
      this.scheduleFileSave("autoPositions", this.autoPositionsPath, () => ({
        positions: this.autoTradePositions,
        usedKeys: [...this.autoTradeUsedKeys],
        lastScan: this.autoTradeLastScan,
        lastCycleAt: this.autoTradeLastCycleAt,
        lastCycleAtMs: this.autoTradeLastCycleAtMs,
        unprotected: this.autoUnprotected,
        dismissed: this.guardDismissed,
      }));
    } catch {
      /* 저장 실패는 매매 흐름을 막지 않는다(다음 변경 때 다시 시도됨) */
    }
  }

  // ── [v0.9.8] 매매(체결) 이력 보관 ─────────────────────────────
  //   [왜 저장하나?] 리포트를 매번 토스에서 실시간으로 불러오게 했더니, 홈 PC에 연결되지 않은 곳
  //   (회사·이동 중)에서는 조회가 안 돼 **리포트가 통째로 비어** 보였다.
  //   한 번 받아 온 체결은 기기에 쌓아 두고, 연결이 없으면 그 기록으로 그린다.
  private loadFills(): void {
    try {
      const raw = existsSync(this.fillsPath) ? JSON.parse(readFileSync(this.fillsPath, "utf8")) : null;
      if (raw && Array.isArray(raw.fills)) {
        this.savedFills = raw.fills as Fill[];
        this.fillsSyncedAtMs = typeof raw.syncedAtMs === "number" ? raw.syncedAtMs : null;
      } else if (Array.isArray(raw)) {
        this.savedFills = raw as Fill[]; // 옛 형식(배열만) 호환
      }
    } catch {
      this.savedFills = [];
    }
  }

  private persistFills(): void {
    try {
      // [v0.90.0] 디바운스
      this.scheduleFileSave("fills", this.fillsPath, () => ({ syncedAtMs: this.fillsSyncedAtMs, fills: this.savedFills }));
    } catch {
      /* 저장 실패해도 이번 화면은 그대로 보여 준다 */
    }
  }

  // ── [v0.10.0→v0.24.0] 매매 이력 암호화 동기화 (로그인 계정 안에서 PC↔폰) ────
  //   회사에서도 리포트를 보려면 이력이 폰에 있어야 한다. 로그인한 기기가 이력을
  //   **로그인 비밀번호로 암호화해서** Supabase(내 계정 전용 행)에 올려 두면, 같은
  //   계정으로 로그인한 다른 기기가 자동으로 받아서 푼다.
  //   ⚠️ 토스 키·토큰·계좌번호는 **절대** 올리지 않는다(매매 결과만).
  //   [v0.24.0] 예전엔 GitHub 공개 저장소 + 별도 "동기화 비밀번호"를 썼다(githubToken
  //   으로 git 자격증명을 찾아야 해서, 일반 사용자 PC에서는 애초에 작동하지 않았다).
  //   지금은 토스 키(capri_secrets)와 완전히 같은 방식 — capri_trades 표에 RLS로
  //   저장한다. 비밀번호는 로그인 비밀번호(authPassword) 하나뿐이다.

  // ==========================================================================
  // [v0.88.0] 클라우드 동기화 — 열쇠 관리 · 상태 표시 · 자동 재시도
  // ==========================================================================

  /** 비밀번호를 받았을 때(로그인·잠금 해제): 메모리에 비밀번호 + 로컬에 데이터 키(비밀번호 아님)를 두고 세션과 함께 저장한다. */
  private async adoptPassword(password: string): Promise<void> {
    this.authPassword = password;
    try {
      if (this.authUserId) this.authDataKey = await deriveDataKey(password, this.authUserId);
    } catch {
      /* 비밀번호가 짧은 등 — 키를 못 만들면 이번 세션은 비밀번호로만 동작 */
    }
    this.persistEnv();
  }

  /** 암호화 동기화에 쓸 열쇠가 있는가(데이터 키 또는 비밀번호). */
  private syncKeyReady(): boolean {
    return !!(this.authDataKey || (this.authPassword && this.authUserId));
  }

  private async currentDataKey(): Promise<string | null> {
    if (this.authDataKey) return this.authDataKey;
    if (this.authPassword && this.authUserId) {
      this.authDataKey = await deriveDataKey(this.authPassword, this.authUserId);
      this.persistEnv();
      return this.authDataKey;
    }
    return null;
  }

  private async encryptForSync(data: unknown) {
    const dk = await this.currentDataKey();
    if (!dk) throw new Error("동기화 키가 없습니다.");
    return encryptJsonWithDataKey(data, dk);
  }

  private async decryptFromSync<T>(rec: { ciphertext: string; salt: string; iv: string }): Promise<T> {
    try {
      return await decryptJsonAuto<T>(rec, { password: this.authPassword, dataKey: this.authDataKey, userId: this.authUserId });
    } catch (e) {
      if (String(e).includes("NEED_KEY")) throw new Error("이 기록은 예전 방식으로 잠겨 있어 로그인 비밀번호가 필요합니다(비밀번호를 한 번 입력하면 풀립니다).");
      throw e;
    }
  }

  /** 채널별 업로드 결과를 기록한다. 실패면 저널에도 남기고(같은 사유는 1시간에 한 번 알림) 호출부에 {ok:false}를 돌려준다 — 조용히 넘어가지 않는다. */
  private recordSync(channel: "trades" | "autoState" | "splits", ok: boolean, error: string | null, fingerprint?: string): { ok: boolean; message: string } {
    const st = this.cloudSync[channel];
    st.lastTryMs = Date.now();
    if (ok) {
      st.lastOkMs = Date.now();
      st.lastError = null;
      if (fingerprint != null) st.lastFingerprint = fingerprint;
      return { ok: true, message: "" };
    }
    const label = channel === "trades" ? "체결 이력" : channel === "autoState" ? "자동매매 기록" : "삼분할 기록";
    const first = st.lastError !== error;
    st.lastError = error;
    if (first) {
      this.addJournal({ kind: "info", symbol: "-", summary: `⚠️ 클라우드 동기화 실패(${label}): ${error} — 폰에서 최신 기록이 안 보일 수 있습니다. 자동으로 다시 시도합니다.`, notify: true, notifyTitle: "⚠️ 클라우드 동기화 실패" });
    }
    return { ok: false, message: error ?? "실패" };
  }

  private syncLockedResult(channel: "trades" | "autoState" | "splits"): { ok: boolean; message: string } {
    const msg = "동기화 키가 없어 올리지 못했습니다 — 로그인 비밀번호를 한 번 입력해 주세요(화면 상단 '동기화 잠김' 안내).";
    const st = this.cloudSync[channel];
    st.lastTryMs = Date.now();
    st.lastError = msg;
    return { ok: false, message: msg };
  }

  /**
   * [v0.102.0] "내용 지문" — 지난번 올린 뒤로 기록이 바뀌었는지 판단하는 값.
   *   예전 지문은 일부만 봤다(삼분할은 '개수'만, 자동매매는 상태·손익만) → 메모 수정·진입완료 체크·수량/체결가 수정처럼
   *   개수·상태가 그대로인 변경은 "안 바뀜"으로 보여 최대 1시간 동안 클라우드에 안 올라갔다. 이제 내용 전체로 계산한다.
   */
  private static contentHash(v: unknown): string {
    const text = JSON.stringify(v) ?? "";
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `${text.length}:${h}`;
  }
  private fillsFingerprint(): string {
    // 체결은 토스가 확정한 사실이라 바뀌지 않는다 — 개수와 처음/마지막 시각이면 충분하다(수천 건을 매번 해시하지 않게).
    const first = this.savedFills[0];
    const last = this.savedFills[this.savedFills.length - 1];
    return `${this.savedFills.length}:${first ? first.atMs : 0}:${last ? last.atMs : 0}`;
  }
  private historyFingerprint(): string {
    return ToolEngine.contentHash(this.autoTradeHistory);
  }
  private splitsFingerprint(): string {
    return ToolEngine.contentHash([this.splits, this.splitsDeleted]);
  }
  private syncFingerprint(ch: "trades" | "autoState" | "splits"): string {
    return ch === "trades" ? this.fillsFingerprint() : ch === "autoState" ? this.historyFingerprint() : this.splitsFingerprint();
  }

  /** 모든 암호화 채널을 지금 올린다(로그인 직후·잠금 해제 직후·주기 점검에서 호출). */
  async syncPushAll(): Promise<{ ok: boolean; message: string }> {
    if (!this.syncKeyReady()) {
      this.syncLockedResult("trades");
      return { ok: false, message: "동기화 키가 없습니다." };
    }
    const safe = async (p: Promise<{ ok: boolean; message?: string }>): Promise<{ ok: boolean; skipped: boolean }> => {
      try {
        const x = await p;
        return { ok: x.ok, skipped: !x.ok && /올릴 .*없습니다/.test(x.message ?? "") }; // 올릴 기록 자체가 없는 채널은 실패가 아니다
      } catch {
        return { ok: false, skipped: false };
      }
    };
    const r = [await safe(this.syncPushTrades()), await safe(this.syncPushAutoState()), await safe(this.syncPushSplits())];
    const mark = (x: { ok: boolean; skipped: boolean }) => (x.ok ? "✓" : x.skipped ? "(올릴 것 없음)" : "✗");
    return { ok: r.every((x) => x.ok || x.skipped), message: `체결 ${mark(r[0])} · 자동매매 ${mark(r[1])} · 삼분할 ${mark(r[2])}` };
  }

  /**
   * [오너 요청] PC·폰 어디서든 "마지막 동기화 시각"을 볼 수 있게 — 클라우드에 실제로 올라가 있는 각 채널의 updated_at을 직접 읽는다.
   *   (이 기기의 업로드 시도 결과도 함께 돌려줘서, PC는 "내가 못 올리는 중"을, 폰은 "PC가 낡았다"를 바로 알 수 있다.)
   */
  async getSyncStatus(): Promise<{
    loggedIn: boolean;
    locked: boolean;
    channels: Array<{ key: string; label: string; cloudUpdatedAtMs: number | null; lastOkMs: number | null; lastTryMs: number | null; lastError: string | null; ageHours: number | null; stale: boolean }>;
    worstAgeHours: number | null;
    summary: string;
  }> {
    const token = await this.ensureAccessToken();
    // [v0.98.0] 화면의 동기화 띠가 1분마다 이 함수를 부른다 — 폰(웹)처럼 로그인을 '복원'만 한 세션은 로그인 순간의 시작 경로를 안 타서
    //   자동 동기화 루프가 한 번도 안 켜졌다. 여기서 (이미 돌고 있으면 아무 일 없이) 켜 둔다.
    if (token) this.startCloudSyncLoop();
    const chans: Array<{ key: "trades" | "autoState" | "splits"; table: string; label: string }> = [
      { key: "autoState", table: "capri_auto_state", label: "자동매매 기록" },
      { key: "trades", table: "capri_trades", label: "체결 이력(리포트·분석)" },
      { key: "splits", table: "capri_splits", label: "삼분할 기록" },
    ];
    const out: Array<{ key: string; label: string; cloudUpdatedAtMs: number | null; lastOkMs: number | null; lastTryMs: number | null; lastError: string | null; ageHours: number | null; stale: boolean }> = [];
    for (const c of chans) {
      let cloud: number | null = null;
      if (token) {
        try {
          const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/${c.table}?select=updated_at`, { headers: this.authRestHeaders(token) }, 8_000, c.table);
          if (res.ok) {
            const rows = (await res.json()) as Array<{ updated_at: string }>;
            if (rows[0]?.updated_at) cloud = Date.parse(rows[0].updated_at);
          }
        } catch {
          /* 조회 실패 — null로 표시 */
        }
      }
      const st = this.cloudSync[c.key];
      const ageHours = cloud != null ? Math.round(((Date.now() - cloud) / 3_600_000) * 10) / 10 : null;
      // "낡음": 클라우드 기록이 24시간 넘게 갱신 안 됨(자동매매·체결이 매일 생기는 계정 기준 — 데이터가 없는 채널은 이 판단에서 제외)
      const hasLocal = c.key === "trades" ? this.savedFills.length > 0 : c.key === "autoState" ? this.autoTradeHistory.length > 0 : this.splits.length > 0;
      out.push({ key: c.key, label: c.label, cloudUpdatedAtMs: cloud, lastOkMs: st.lastOkMs, lastTryMs: st.lastTryMs, lastError: st.lastError, ageHours, stale: hasLocal && (cloud == null || (ageHours ?? 0) > 24) });
    }
    const ages = out.map((o) => o.ageHours).filter((x): x is number => x != null);
    const worst = ages.length ? Math.max(...ages) : null;
    const locked = !this.syncKeyReady();
    const stale = out.some((o) => o.stale);
    const anyLocal = this.savedFills.length > 0 || this.autoTradeHistory.length > 0 || this.splits.length > 0;
    const summary = !token ? "로그인이 필요합니다." : locked && anyLocal ? "🔒 동기화 잠김 — 이 기기가 클라우드(폰)로 기록을 올리지 못하고 있습니다. 로그인 비밀번호를 한 번 입력해 주세요." : stale ? "⚠️ 클라우드 기록이 24시간 넘게 갱신되지 않았습니다." : "✅ 클라우드 동기화 정상";
    return { loggedIn: !!token, locked: locked && anyLocal, channels: out, worstAgeHours: worst, summary }; // 올릴 기록이 아직 없는 기기는 '잠김'으로 보지 않는다
  }

  /**
   * [잠금 해제] 로그인 비밀번호를 한 번 받아 데이터 키를 만들어 보관하고 곧바로 전부 올린다(소급 동기화 — 그동안 쌓인 로컬 기록 전체).
   *   비밀번호가 틀리면 Supabase 로그인이 실패해 아무것도 바뀌지 않는다. 비밀번호 자체는 저장하지 않는다.
   */
  async unlockSync(password: string): Promise<{ ok: boolean; message: string }> {
    if (!this.authEmail) return { ok: false, message: "먼저 로그인하세요." };
    const r = await this.authSignIn(this.authEmail, password); // 비밀번호 검증 + 키 생성 + 받기(병합) + 올리기를 한 번에
    if (!r.ok) return r;
    const pushed = await this.syncPushAll();
    return { ok: pushed.ok, message: pushed.ok ? `잠금을 풀고 전부 올렸습니다 — ${pushed.message}` : `잠금은 풀렸지만 일부 올리기에 실패했습니다 — ${pushed.message}` };
  }

  /**
   * [v0.98.0 — 오너 지시 "윈도우·폰·맥 기록이 연동이 안 된다. 기본은 자동, 필요시 수동 '전체 동기화' 버튼"]
   *   세 채널(체결 이력·자동매매 기록·삼분할 기록)을 "먼저 받아서 합친 뒤 → 올리는" 순서로 맞춘다.
   *
   * [왜 '받기 → 올리기' 순서인가]
   *   예전엔 올리기만 주기로 돌았다. 올리기는 클라우드 한 줄을 이 기기의 기록으로 통째로 덮어쓴다 —
   *   맥이 윈도우 기록을 한 번도 못 받은 채 올리면 윈도우가 올려 둔 기록이 사라질 수 있었다(마지막에 올린 기기가 이기는 구조).
   *   이제는 올리기 직전에 반드시 받아서 합치므로(합집합) 어느 기기가 먼저 올려도 서로의 기록이 보존된다.
   *
   * [안전장치]
   *   · 받기가 '진짜 실패'(복호화 실패·네트워크 오류)면 그 채널은 올리지 않는다 — 모른 채 덮어쓰는 사고 방지.
   *     (클라우드에 아직 아무것도 없는 '빈 채널'은 정상이라 그대로 올린다.)
   *   · 자동매매가 켜져 있는 기기는 "지금 감시 중" 목록을 다시 만들지 않는다(syncPullAutoState 안의 가드) — 실거래 중인 포지션을 건드리지 않는다.
   *   · force=false(자동)면 바뀐 채널만 올리고, force=true(수동 버튼)면 변화가 없어도 전부 올린다.
   */
  private async syncChannels(force: boolean): Promise<Array<{ key: "trades" | "autoState" | "splits"; label: string; added: number; pulled: "ok" | "empty" | "fail"; pushed: "ok" | "skip" | "fail" | "held"; detail: string }>> {
    const now = Date.now();
    const stale = (c: "trades" | "autoState" | "splits") => now - (this.cloudSync[c].lastOkMs ?? 0) > 3_600_000;
    const defs = [
      { key: "trades" as const, label: "체결 이력", count: () => this.savedFills.length, pull: () => this.syncPullTrades(), push: () => this.syncPushTrades(), fp: () => this.fillsFingerprint() },
      { key: "autoState" as const, label: "자동매매 기록", count: () => this.autoTradeHistory.length, pull: () => this.syncPullAutoState(), push: () => this.syncPushAutoState(), fp: () => this.historyFingerprint() },
      { key: "splits" as const, label: "삼분할 기록", count: () => this.splits.length, pull: () => this.syncPullSplits(), push: () => this.syncPushSplits(), fp: () => this.splitsFingerprint() },
    ];
    const out: Array<{ key: "trades" | "autoState" | "splits"; label: string; added: number; pulled: "ok" | "empty" | "fail"; pushed: "ok" | "skip" | "fail" | "held"; detail: string }> = [];
    for (const d of defs) {
      const before = d.count();
      let pr: { ok: boolean; message: string };
      try {
        pr = await d.pull();
      } catch (e) {
        pr = { ok: false, message: `받기 실패: ${e instanceof Error ? e.message : String(e)}` };
      }
      const pulled = classifyPullResult(pr);
      const added = Math.max(0, d.count() - before);
      let pushed: "ok" | "skip" | "fail" | "held" = "skip";
      let detail = pulled === "fail" ? pr.message : "";
      if (pulled === "fail") {
        pushed = "held"; // 받지 못한 채 올리면 클라우드의 다른 기기 기록을 덮어쓸 수 있다 → 보류
      } else if (this.syncChannelDef(d.key).hasData() && (force || this.cloudSync[d.key].lastFingerprint !== d.fp() || stale(d.key))) {
        // [v0.102.0] 기록이 0건이어도 삭제 표식이 있으면 올린다(hasData) — "전부 지웠다"도 다른 기기에 전해야 하는 변경이다.
        try {
          const x = await d.push();
          pushed = x.ok ? "ok" : "fail";
          if (!x.ok) detail = x.message;
        } catch (e) {
          pushed = "fail";
          detail = e instanceof Error ? e.message : String(e);
        }
      }
      out.push({ key: d.key, label: d.label, added, pulled, pushed, detail });
    }
    return out;
  }

  /**
   * [v0.98.0] "🔄 전체 동기화" 수동 버튼의 본체 — 받기(합치기) → 올리기를 지금 즉시, 변화 유무와 상관없이 전부 실행한다.
   *   자동(5분 주기)과 같은 로직(syncChannels)을 쓰되 force=true. 잠겨 있으면(구글 로그인·재시작 등 데이터 키 없음)
   *   암호화 기록은 건드릴 수 없으므로 평문 안전망(그룹 공유 기록)만 합치고, 비밀번호 입력이 필요하다고 알린다.
   */
  async syncAllNow(): Promise<{ ok: boolean; locked: boolean; busy: boolean; message: string; lines: string[] }> {
    if (this.cloudSyncBusy) return { ok: false, locked: false, busy: true, message: "이미 동기화가 진행 중입니다. 잠시 후 다시 눌러 주세요.", lines: [] };
    this.cloudSyncBusy = true;
    try {
      const token = await this.ensureAccessToken();
      if (!token) return { ok: false, locked: false, busy: false, message: "먼저 로그인하세요.", lines: [] };
      if (!this.syncKeyReady()) {
        const added = await this.mergeOwnGroupHistory().catch(() => 0);
        return {
          ok: false,
          locked: true,
          busy: false,
          message: `🔒 동기화 키가 없어 암호화 기록(체결·삼분할 등)은 맞추지 못했습니다. 로그인 비밀번호를 한 번 입력해 주세요.${added > 0 ? ` (자동매매 기록은 그룹 공유본에서 ${added}건 보강했습니다.)` : ""}`,
          lines: [],
        };
      }
      const rep = await this.syncChannels(true);
      void this.syncPushGroupTrades().catch(() => undefined); // 그룹 공유(평문)도 함께 최신으로
      const lines = rep.map((r) => `${r.label}: 받기 ${r.pulled === "ok" ? `✓ (+${r.added}건)` : r.pulled === "empty" ? "(클라우드에 아직 없음)" : "✗"} · 올리기 ${r.pushed === "ok" ? "✓" : r.pushed === "skip" ? "(올릴 것 없음)" : r.pushed === "held" ? "보류(받기 실패)" : "✗"}${r.detail ? ` — ${r.detail}` : ""}`);
      const bad = rep.some((r) => r.pulled === "fail" || r.pushed === "fail" || r.pushed === "held");
      return { ok: !bad, locked: false, busy: false, message: bad ? "⚠️ 일부 채널이 맞춰지지 않았습니다." : "✅ 전체 동기화 완료 — 이 기기의 기록과 클라우드가 같아졌습니다(다른 기기는 몇 분 안에 자동 반영).", lines };
    } finally {
      this.cloudSyncBusy = false;
    }
  }

  /** 주기 점검(5분): 키가 있으면 [받아서 합치기 → 바뀐 채널 올리기]. 마지막 성공이 오래됐으면(1시간) 변화가 없어도 다시 올린다. 키가 없으면 하루 한 번 저널·알림으로 알린다. */
  private async cloudSyncTick(): Promise<void> {
    if (this.cloudSyncBusy) return;
    this.cloudSyncBusy = true;
    try {
      if (!(this.authAccessToken || this.authRefreshToken)) return;
      if (!this.syncKeyReady()) {
        if (Date.now() - this.cloudSyncLockedWarnedAtMs > 24 * 3_600_000 && (this.savedFills.length > 0 || this.autoTradeHistory.length > 0)) {
          this.cloudSyncLockedWarnedAtMs = Date.now();
          this.addJournal({ kind: "info", symbol: "-", summary: "🔒 클라우드 동기화 잠김 — 이 PC에 동기화 키가 없어 폰으로 기록을 못 올리고 있습니다. 화면 상단 안내에서 로그인 비밀번호를 한 번 입력해 주세요.", notify: true, notifyTitle: "🔒 폰 동기화 잠김" });
        }
        return;
      }
      // [v0.98.0] 예전엔 여기서 올리기만 했다(받기는 로그인 순간 1회뿐) → 다른 기기의 새 기록이 영영 안 들어왔다. 이제 매 주기 받아서 합친 뒤 올린다.
      await this.syncChannels(false);
    } finally {
      this.cloudSyncBusy = false;
    }
  }

  startCloudSyncLoop(): void {
    if (this.cloudSyncTimer) return;
    if (!(this.authAccessToken || this.authRefreshToken)) return; // 로그인 안 돼 있으면 시작 안 함
    setTimeout(() => void this.cloudSyncTick(), 20_000); // 시작 직후 한 번(재시작 뒤 밀린 것 바로 올리기)
    this.cloudSyncTimer = setInterval(() => void this.cloudSyncTick(), 5 * 60_000);
  }

  stopCloudSyncLoop(): void {
    if (this.cloudSyncTimer) {
      clearInterval(this.cloudSyncTimer);
      this.cloudSyncTimer = null;
    }
  }

  /** 내 계정의 그룹 공유(평문) 기록을 받아 자동매매 기록에 병합한다 — 암호화 채널이 낡았을 때의 안전망(폰이 PC 열쇠 없이도 최신 기록을 보게). */
  private async mergeOwnGroupHistory(): Promise<number> {
    const token = await this.ensureAccessToken();
    if (!token || !this.authUserId) return 0;
    const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_group_trades?user_id=eq.${this.authUserId}&select=history`, { headers: this.authRestHeaders(token) }, 10_000, "capri_group_trades");
    if (!res.ok) return 0;
    const rows = (await res.json()) as Array<{ history: unknown }>;
    const remote = Array.isArray(rows[0]?.history) ? (rows[0].history as AutoTradeHistoryEntry[]) : [];
    if (remote.length === 0) return 0;
    const before = this.autoTradeHistory.length;
    this.autoTradeHistory = mergeAutoHistory(this.autoTradeHistory, remote);
    this.persistAutoTradeHistory();
    // 실제로 자동매매를 돌리는 중인 기기(PC)에서는 "지금 감시 중" 목록을 기록으로 덮어쓰지 않는다(폰·조회 전용 기기에서만 다시 만든다).
    if (!this.autoTradeEnabled) {
      this.autoTradePositions = derivePositionsFromHistory(this.autoTradeHistory);
      this.saveAutoPositions();
    }
    return this.autoTradeHistory.length - before;
  }

  private async pullOwnGroupHistoryFallback(why: string): Promise<{ ok: boolean; message: string; count?: number }> {
    try {
      const added = await this.mergeOwnGroupHistory();
      return { ok: added >= 0 && this.autoTradeHistory.length > 0, message: `${why} — 대신 그룹 공유 기록에서 ${added}건을 보강했습니다.`, count: this.autoTradeHistory.length };
    } catch (e) {
      return { ok: false, message: `${why}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ===========================================================================
  // [v0.102.0 — 오너 지시 "맥·윈도우·폰이 같은 계정으로 동기화하는데 데이터 오차가 절대 생기면 안 된다"]
  //   암호화 동기화 3채널(체결 이력·자동매매 기록·삼분할 기록)의 받기/올리기를 하나의 공통 틀로 다시 짰다.
  //
  // [예전 구조의 빈틈 — 실제로 오차가 생길 수 있던 경로]
  //   ① "올리기"가 클라우드 한 줄을 이 기기 내용으로 통째로 덮어썼다. 기록이 바뀔 때마다 바로 올리는 경로
  //      (persistSplits·persistAutoTradeHistory)는 받기 없이 곧장 덮어써서, 그 사이 다른 기기가 올린 기록이
  //      클라우드에서 사라질 수 있었다(나중에 다시 합쳐지긴 해도 그동안 폰엔 안 보임).
  //   ② 두 기기가 거의 동시에 "받기→합치기→올리기"를 하면, 늦게 올린 쪽이 먼저 올린 쪽을 모른 채 덮어썼다.
  //   ③ 지운 기록이 다른 기기에서 다시 살아났다(삭제 표식이 없었음 — lib/splits-sync.ts 설명 참고).
  //
  // [새 구조 — "버전 확인 후 저장"(compare-and-swap, 은행 송금과 같은 원리)]
  //   올리기는 이제 항상 ①클라우드 줄을 읽고(그 줄의 버전 = updated_at 기억) ②내 기록과 합친 뒤
  //   ③"클라우드 버전이 아까 읽은 그대로일 때만" 저장한다. 그 사이 다른 기기가 먼저 저장했으면 저장이
  //   거절되고(0줄 변경), 처음부터 다시 읽고 합쳐서 저장한다(최대 4번). → 누가 먼저 저장하든 서로의 기록이
  //   절대 덮여 사라지지 않는다.
  //   또 같은 기기 안에서도 채널마다 줄을 세워(한 번에 하나씩) 받기와 올리기가 서로 엉키지 않게 했다.
  // ===========================================================================

  /** 채널별 "줄 세우기"(한 번에 하나의 받기/올리기만 진행) — 같은 기기 안에서 둘이 겹쳐 반쯤 합쳐진 상태로 올라가는 일을 막는다. */
  private syncLocks: Record<"trades" | "autoState" | "splits", Promise<unknown>> = { trades: Promise.resolve(), autoState: Promise.resolve(), splits: Promise.resolve() };
  /** 채널별 "곧 올리기" 예약 타이머(기록이 바뀌었는데 쓰로틀 때문에 바로 못 올린 경우, 빠뜨리지 않고 나중에 올린다). */
  private syncPushTimers: Partial<Record<"trades" | "autoState" | "splits", ReturnType<typeof setTimeout>>> = {};

  private withSyncLock<T>(ch: "trades" | "autoState" | "splits", fn: () => Promise<T>): Promise<T> {
    const run = this.syncLocks[ch].then(fn, fn); // 앞 작업이 실패했어도 다음 작업은 진행
    this.syncLocks[ch] = run.catch(() => undefined);
    return run;
  }

  /**
   * schedulePush — 기록이 바뀌었을 때 "곧" 올리도록 예약한다.
   *   예전엔 "15초 안에 이미 올렸으면 그냥 건너뜀"이라, 15초 안에 두 번 바뀌면 두 번째 변경은 다음 5분 점검까지
   *   (삼분할은 지문이 '개수'뿐이라 최대 1시간까지) 클라우드에 안 올라갔다. 이제는 건너뛰지 않고 남은 시간 뒤로 예약한다.
   */
  private schedulePush(ch: "trades" | "autoState" | "splits", minGapMs: number): void {
    if (!this.syncKeyReady()) return;
    if (this.syncPushTimers[ch]) return; // 이미 예약됨 — 그때 최신 내용으로 올라간다
    const last = ch === "trades" ? this.lastSyncPushAtMs : ch === "autoState" ? this.lastAutoStatePushAtMs : this.lastSplitsPushAtMs;
    const wait = Math.max(0, minGapMs - (Date.now() - (last ?? 0)));
    const go = () => void this.syncPushChannel(ch).catch(() => undefined); // 업로드 실패는 recordSync가 기록·경고한다
    if (wait === 0) {
      go();
      return;
    }
    const t = setTimeout(() => {
      delete this.syncPushTimers[ch];
      go();
    }, wait);
    (t as unknown as { unref?: () => void }).unref?.(); // 이 타이머가 앱 종료를 붙잡지 않게
    this.syncPushTimers[ch] = t;
  }

  /** 채널별 차이점(테이블 이름·검사기·합치는 방법 등)을 한곳에 모았다 — 아래 공통 받기/올리기가 이것만 보고 동작한다. */
  private syncChannelDef(ch: "trades" | "autoState" | "splits"): {
    table: string;
    noun: string;
    validate: (p: unknown) => boolean;
    absorb: (p: unknown) => { received: number; added: number };
    /** 합친 뒤에도 "클라우드 내용 ≠ 이 기기 내용"인가 — 그렇다면 이 기기가 다시 올려 클라우드를 바로잡아야 한다(아래 absorbSyncRow). */
    differs: (p: unknown) => boolean;
    hasData: () => boolean;
    build: (nowMs: number) => unknown;
    count: () => number;
  } {
    if (ch === "trades") {
      return {
        table: "capri_trades",
        noun: "매매 이력",
        validate: isSyncPayload,
        absorb: (p) => {
          const payload = p as TradeSyncPayload;
          const before = this.savedFills.length;
          // 체결은 토스가 확정한 사실이라 "같은 체결 = 같은 열쇠"(fillKey)로 중복 없이 합쳐진다(합집합).
          this.savedFills = mergeFills(this.savedFills, payload.fills);
          this.fillsSyncedAtMs = Math.max(this.fillsSyncedAtMs ?? 0, payload.pushedAtMs);
          this.persistFills();
          return { received: payload.fills.length, added: this.savedFills.length - before };
        },
        differs: (p) => {
          const remote = mergeFills([], (p as TradeSyncPayload).fills);
          return ToolEngine.contentHash(toSyncPayload(remote, 0).fills) !== ToolEngine.contentHash(toSyncPayload(this.savedFills, 0).fills);
        },
        hasData: () => this.savedFills.length > 0,
        build: (now) => toSyncPayload(this.savedFills, now),
        count: () => this.savedFills.length,
      };
    }
    if (ch === "splits") {
      return {
        table: "capri_splits",
        noun: "삼분할 기록",
        validate: isSplitsSyncPayload,
        absorb: (p) => {
          const payload = p as SplitsSyncPayload;
          const before = this.splits.length;
          // 삭제 표식부터 합친다 → 그다음 기록을 합칠 때 표식이 있는 id는 빠진다(부활 방지).
          this.splitsDeleted = mergeTombstones(this.splitsDeleted, payload.deleted, Date.now());
          this.splits = mergeSplits(this.splits, payload.splits, this.splitsDeleted);
          this.saveSplitsLocal();
          return { received: payload.splits.length, added: this.splits.length - before };
        },
        differs: (p) => {
          const payload = p as SplitsSyncPayload;
          const now = Date.now();
          const rt = mergeTombstones(payload.deleted, {}, now); // 같은 규칙으로 정돈한 뒤 비교(순서 차이로 '다름'이 나오지 않게)
          const remote = toSplitsSyncPayload(mergeSplits([], payload.splits, rt), 0, rt);
          const lt = mergeTombstones(this.splitsDeleted, {}, now);
          const local = toSplitsSyncPayload(mergeSplits([], this.splits, lt), 0, lt);
          return ToolEngine.contentHash(remote) !== ToolEngine.contentHash(local);
        },
        // 기록이 0건이어도 삭제 표식이 있으면 올려야 한다 — "전부 지웠다"도 다른 기기에 알려야 하는 변경이다.
        hasData: () => this.splits.length > 0 || Object.keys(this.splitsDeleted).length > 0,
        build: (now) => toSplitsSyncPayload(this.splits, now, this.splitsDeleted),
        count: () => this.splits.length,
      };
    }
    return {
      table: "capri_auto_state",
      noun: "자동매매 기록",
      validate: isAutoStateSyncPayload,
      absorb: (p) => {
        const payload = p as AutoStateSyncPayload;
        const before = this.autoTradeHistory.length;
        this.autoTradeHistory = mergeAutoHistory(this.autoTradeHistory, payload.history);
        this.saveAutoHistoryLocal();
        // [핵심] "지금 감시 중" 목록도 병합된 기록에서 다시 만든다 — 이 기기가 한 번도 진입시킨
        //   적 없는 포지션이라도, 다른 기기가 올려 둔 기록에 conditionalOrderId/buyOrderId가
        //   있으면 이 기기도 그 번호로 실제 체결·발동 여부를 재확인할 수 있게 된다.
        //   [v0.98.0] 단, 이 기기에서 자동매매가 실제로 켜져 있으면 다시 만들지 않는다 — 실거래 중인 기기의
        //   감시 목록을 기록으로 덮어쓰면 보호주문 관리가 흔들린다(mergeOwnGroupHistory와 같은 원칙).
        if (!this.autoTradeEnabled) {
          this.autoTradePositions = derivePositionsFromHistory(this.autoTradeHistory);
          this.saveAutoPositions();
        }
        return { received: payload.history.length, added: this.autoTradeHistory.length - before };
      },
      differs: (p) => {
        const remote = mergeAutoHistory([], (p as AutoStateSyncPayload).history).slice(-ToolEngine.AUTO_TRADE_HISTORY_MAX);
        return ToolEngine.contentHash(remote) !== ToolEngine.contentHash(mergeAutoHistory([], this.autoTradeHistory));
      },
      hasData: () => this.autoTradeHistory.length > 0,
      build: (now) => toAutoStateSyncPayload(this.autoTradeHistory, now),
      count: () => this.autoTradeHistory.length,
    };
  }

  /** 클라우드에서 이 계정의 그 채널 한 줄(암호문 + 버전 = updated_at)을 읽는다. 없으면 row=null. */
  private async fetchSyncRow(
    table: string,
    token: string,
  ): Promise<{ ok: true; row: { ciphertext: string; salt: string; iv: string; updated_at?: string } | null } | { ok: false; message: string }> {
    const mine = this.authUserId ? `&user_id=eq.${encodeURIComponent(this.authUserId)}` : "";
    const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/${table}?select=ciphertext,salt,iv,updated_at${mine}`, { headers: this.authRestHeaders(token) }, 10_000, table);
    if (!res.ok) return { ok: false, message: `클라우드 조회 실패(HTTP ${res.status}).` };
    const rows = (await res.json()) as Array<{ ciphertext: string; salt: string; iv: string; updated_at?: string }>;
    return { ok: true, row: rows && rows.length > 0 ? rows[0] : null };
  }

  /** 읽어 온 한 줄을 풀어서(복호화) 이 기기 기록에 합친다. 풀지 못하면 예외 — 부른 쪽이 "올리기 보류"로 처리한다. */
  private async absorbSyncRow(ch: "trades" | "autoState" | "splits", row: { ciphertext: string; salt: string; iv: string }): Promise<{ received: number; added: number }> {
    const def = this.syncChannelDef(ch);
    const payload = await this.decryptFromSync<unknown>(row); // 틀린 비번/키면 여기서 실패
    if (!def.validate(payload)) throw new Error("받은 데이터 형식이 올바르지 않습니다.");
    const r = def.absorb(payload);
    // [v0.102.0] 합친 결과가 클라우드 내용과 다르면(이 기기에만 있는 기록, 또는 클라우드에 남아 있는 '지워진' 기록 등)
    //   "지난번 올린 지문"을 지워 이번 점검에서 반드시 다시 올리게 한다. 이게 없으면 이 기기 내용이 안 바뀐 경우
    //   (예: 옛 버전 앱이 지운 기록을 다시 올려 둔 상태) 클라우드가 틀린 채로 남아, 새로 로그인한 폰이 그걸 받아 간다.
    if (def.differs(payload)) this.cloudSync[ch].lastFingerprint = null;
    return r;
  }

  /**
   * syncPushChannel — [핵심] 받기 → 합치기 → "버전이 그대로일 때만" 저장, 을 한 덩어리로 한다(위 큰 주석 참고).
   *   · 클라우드 줄을 풀지 못하면(다른 키·깨짐·네트워크) 절대 올리지 않는다 — 모르는 기록을 덮어쓰지 않기 위해.
   *   · 저장이 거절되면(그 사이 다른 기기가 먼저 저장) 처음부터 다시: 최대 4번.
   */
  private syncPushChannel(ch: "trades" | "autoState" | "splits"): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.withSyncLock(ch, async () => {
      const def = this.syncChannelDef(ch);
      const token = await this.ensureAccessToken();
      if (!token) return { ok: false, message: "먼저 로그인하세요." };
      if (!this.syncKeyReady()) return this.syncLockedResult(ch);
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          // ① 읽기
          const got = await this.fetchSyncRow(def.table, token);
          if (!got.ok) return this.recordSync(ch, false, `올리기 보류 — ${got.message}`);
          // ② 합치기(클라우드에만 있던 다른 기기 기록·삭제 표식을 먼저 받아들인다)
          if (got.row) {
            try {
              await this.absorbSyncRow(ch, got.row);
            } catch (e) {
              return this.recordSync(ch, false, `올리기 보류 — 클라우드 기록을 풀지 못했습니다(${e instanceof Error ? e.message : String(e)}). 덮어쓰지 않았습니다.`);
            }
          }
          if (!def.hasData()) return { ok: false, message: `올릴 ${def.noun}이 없습니다.` };
          // ③ 버전 확인 후 저장
          const rec = await this.encryptForSync(def.build(Date.now()));
          const prevMs = got.row?.updated_at ? Date.parse(got.row.updated_at) : 0;
          // 새 버전은 반드시 이전 버전보다 커야 한다(같은 ms에 두 기기가 저장해도 버전이 겹치지 않게 +1ms).
          const nextAt = new Date(Math.max(Date.now(), (Number.isFinite(prevMs) ? prevMs : 0) + 1)).toISOString();
          let res: Response;
          if (got.row) {
            // 이미 줄이 있으면: "updated_at이 아까 읽은 값 그대로인 줄"만 고친다. 그 사이 누가 저장했으면 0줄이 고쳐진다(=거절).
            const mine = this.authUserId ? `user_id=eq.${encodeURIComponent(this.authUserId)}` : "";
            const ver = got.row.updated_at ? `&updated_at=eq.${encodeURIComponent(got.row.updated_at)}` : "";
            res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/${def.table}?${mine}${ver}`, {
              method: "PATCH",
              headers: { ...this.authRestHeaders(token), Prefer: "return=representation" },
              body: JSON.stringify({ ciphertext: rec.ciphertext, salt: rec.salt, iv: rec.iv, updated_at: nextAt }),
            }, 10_000, def.table);
          } else {
            // 줄이 아직 없으면: 새로 만든다. 그 사이 다른 기기가 먼저 만들었으면 "중복 무시"로 0줄이 돌아온다(=거절).
            res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/${def.table}?on_conflict=user_id`, {
              method: "POST",
              headers: { ...this.authRestHeaders(token), Prefer: "resolution=ignore-duplicates,return=representation" },
              body: JSON.stringify({ user_id: this.authUserId, ciphertext: rec.ciphertext, salt: rec.salt, iv: rec.iv, updated_at: nextAt }),
            }, 10_000, def.table);
            if (res.status === 409) continue; // 동시에 만들어짐 — 다시 읽고 합친다
          }
          if (!res.ok) return this.recordSync(ch, false, `클라우드 저장 실패(HTTP ${res.status}).`);
          const written = await res.json().catch(() => null);
          if (Array.isArray(written) && written.length === 0) continue; // 거절됨(다른 기기가 먼저 저장) — 처음부터 다시
          // 저장 성공
          if (ch === "trades") this.lastSyncPushAtMs = Date.now();
          else if (ch === "autoState") this.lastAutoStatePushAtMs = Date.now();
          else this.lastSplitsPushAtMs = Date.now();
          this.recordSync(ch, true, null, this.syncFingerprint(ch));
          return { ok: true, message: `${def.noun} ${def.count()}건을 올렸습니다(암호화됨).`, count: def.count() };
        }
        return this.recordSync(ch, false, "다른 기기와 동시에 저장하느라 계속 충돌했습니다 — 잠시 후 자동으로 다시 시도합니다(기록은 지워지지 않았습니다).");
      } catch (e) {
        return this.recordSync(ch, false, `올리기 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** syncPullChannel — 받아서 합치기만 한다(올리지 않음). 결과 문구는 lib/sync-all.ts classifyPullResult가 읽는다("저장된 ... 없습니다" = 빈 채널). */
  private syncPullChannel(ch: "trades" | "autoState" | "splits"): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.withSyncLock(ch, async () => {
      const def = this.syncChannelDef(ch);
      const token = await this.ensureAccessToken();
      if (!token) return { ok: false, message: "먼저 로그인하세요." };
      if (!this.syncKeyReady()) {
        if (ch === "autoState") return this.pullOwnGroupHistoryFallback("동기화 키가 없어 암호화 기록은 못 받았습니다");
        return { ok: false, message: `동기화 키가 없어 ${def.noun}을 받을 수 없습니다(로그인 비밀번호를 한 번 입력하면 풀립니다).` };
      }
      try {
        const got = await this.fetchSyncRow(def.table, token);
        if (!got.ok) return { ok: false, message: got.message };
        if (!got.row) {
          if (ch === "autoState") return this.pullOwnGroupHistoryFallback("내 계정에 저장된 암호화 자동매매 기록이 없습니다");
          return { ok: false, message: `내 계정에 저장된 ${def.noun}이 없습니다.` };
        }
        const r = await this.absorbSyncRow(ch, got.row);
        if (ch === "autoState") {
          // [v0.88.0] 암호화 기록이 낡았을 수 있다(PC가 못 올린 기간) — 같은 계정의 그룹 공유(평문, 3분마다 갱신) 기록도 함께 병합해 최신으로 맞춘다.
          await this.mergeOwnGroupHistory().catch(() => 0);
          return { ok: true, message: `자동매매 기록 ${r.received}건을 받았습니다(새로 추가 ${Math.max(0, r.added)}건, 지금 감시 중 ${this.autoTradePositions.length}종목).`, count: this.autoTradeHistory.length };
        }
        return { ok: true, message: `${def.noun} ${r.received}건을 받았습니다(새로 추가 ${Math.max(0, r.added)}건).`, count: def.count() };
      } catch (e) {
        return { ok: false, message: `받기 실패: ${e instanceof Error ? e.message : String(e)}` };
      }
    });
  }

  /** syncPushTrades — 저장된 매매 이력을 (받아 합친 뒤) 암호화해 내 계정(capri_trades) 행에 올린다. */
  async syncPushTrades(): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.syncPushChannel("trades");
  }

  /** syncPullTrades — 내 계정에 올려 둔 매매 이력을 받아 복호화해 저장본에 합친다(authSignIn·주기 점검이 자동으로 부른다). */
  async syncPullTrades(): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.syncPullChannel("trades");
  }

  /** syncPushSplits — 삼분할 타점 기록 전체(+삭제 표식)를 (받아 합친 뒤) 암호화해 내 계정(capri_splits) 행에 올린다. */
  async syncPushSplits(): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.syncPushChannel("splits");
  }

  /** syncPullSplits — 내 계정에 올려 둔 삼분할 기록을 받아 복호화해 병합한다(삭제 표식 반영). */
  async syncPullSplits(): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.syncPullChannel("splits");
  }

  /**
   * syncPushAutoState — 자동매매 기록 전체를 (받아 합친 뒤) 암호화해 내 계정(capri_auto_state) 행에 올린다
   *   (다른 기기가 로그인하면 내 매매이력을 그대로 이어받을 수 있게 — 순수 개인기록 동기화).
   *   [v0.61.0] "마지막 스캔 결과·탈락 사유"는 capri_live_state(pushLiveState/getLiveState)가 따로 맡는다.
   */
  async syncPushAutoState(): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.syncPushChannel("autoState");
  }

  /**
   * syncPullAutoState — 내 계정에 올려 둔 자동매매 기록을 받아 복호화해 병합하고,
   *   "지금 감시 중" 목록(autoTradePositions)도 병합된 기록에서 다시 만든다(자동매매가 꺼진 기기만).
   */
  async syncPullAutoState(): Promise<{ ok: boolean; message: string; count?: number }> {
    return this.syncPullChannel("autoState");
  }

  // ---------------------------------------------------------------------------
  // [v0.61.0] 상태 미러(state mirror) — PC → 폰 방향. capri_commands(폰→PC 명령 큐)와
  //   capri_auto_state(암호화 개인기록 동기화)는 둘 다 "PC가 지금 뭘 하고 있는지"를
  //   폰이 실시간으로 볼 수 있게 해주지 못했다(오너 보고: "PC에서와 같이 자동 스크리닝이
  //   돌아가는 걸 폰에서도 보고 싶은데 아무것도 안 나온다" — 화면 문제가 아니라 애초에
  //   PC가 그 데이터를 어디에도 올리지 않아서였다). capri_live_state는 그 전용 통로:
  //   평문(capri_group_trades와 같은 원칙 — 이 테이블은 비공개 그룹 전원 소유, 전부 자기
  //   계정 행만 RLS로 보호), kind별 한 행만 유지(upsert), Realtime 대신 폰이 짧은 주기로
  //   폴링한다(이 프로젝트는 realtime.subscription 오류 상태라 못 씀).
  // ---------------------------------------------------------------------------

  /**
   * pushLiveState — 지금 상태(getAutoTradeStatus 그대로 + 최근 저널 50건)를 통째로
   *   capri_live_state에 올린다. force=true면 쓰로틀(5초)을 무시한다 — 스캔이 막 끝났을
   *   때처럼 "반드시 바로" 올려야 하는 지점에서 쓴다. 로그인 안 돼 있으면 조용히 아무 일도
   *   하지 않는다(웹/폰 세션도 이 함수를 그냥 불러도 안전 — fire-and-forget 전제).
   */
  async pushLiveState(force = false): Promise<void> {
    if (!force) {
      const longEnough = Date.now() - (this.lastLiveStatePushAtMs ?? 0) > ToolEngine.LIVE_STATE_PUSH_THROTTLE_MS;
      if (!longEnough) return;
    }
    const token = await this.ensureAccessToken();
    if (!token || !this.authUserId) return;
    try {
      // [v0.61.2 — ② 전수조사에서 발견한 치명 버그 수정] killSwitch(비상 정지)도 함께 싣는다.
      //   예전엔 상단 "🛑 비상 정지" 버튼이 웹(폰)에서도 로컬(의미 없는) 엔진의 killSwitch를
      //   직접 켰다 — 화면은 "🔴 비상 정지 중"으로 바뀌어도 PC의 실제 매매는 전혀 멈추지
      //   않는, 비상정지 버튼치고는 가장 위험한 종류의 거짓 안도감이었다.
      const payload = {
        status: this.getAutoTradeStatus(),
        journal: this.getJournal().slice(-50),
        killSwitch: this.killSwitch,
        scanProgress: this.scanProgressForMirror,
        reports: this.buildRecentReports(5), // [v0.62.1] 폰도 자동매매 리포트를 볼 수 있게
        lab: this.labMirror(), // [v0.65.0] 폰도 매매연구소 요약을 볼 수 있게
        // [v0.70.0 — 오너 지시 "세팅값 수정 후 저장을 눌러도 이게 적용이되는건지 명확히
        //   모르겠다"] 지금 PC에 실제로 저장된 설정 전체(자동매매 한도 + 스크리닝 기준
        //   포함)를 그대로 싣는다. 폰은 "보냈다"는 메시지만 보고 믿는 게 아니라, 이 값을
        //   직접 읽어 "PC가 실제로 지금 뭘 쓰고 있는지"를 보여줄 수 있다(App.tsx의 pcSettings).
        settings: this.getSettings(),
      };
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_live_state?on_conflict=user_id,kind`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: this.authUserId, kind: "snapshot", payload, updated_at: new Date().toISOString() }),
      }, 10_000, "capri_live_state");
      if (res.ok) this.lastLiveStatePushAtMs = Date.now();
    } catch {
      /* 실패해도 조용히 무시 — 다음 기회(다음 사이클·다음 쓰로틀 통과)에 다시 시도 */
    }
  }

  /**
   * [v0.61.4 — 오너 지시 "스크리닝시 진행되는 사항들 게이지가 차는 사항이 안 보인다"]
   *   scanScreener 안에서만 쓰는 전용 쓰로틀 — 종목 하나 조사할 때마다(초 단위) 올리면
   *   과하므로 2초에 한 번만. phase가 ranking/done일 때는 "스캔 시작/끝"이라는 중요한
   *   전환 신호라 쓰로틀 없이 바로 올린다.
   */
  private pushScanProgress(p: LiveScanProgress): void {
    this.scanProgressForMirror = p;
    const isEdge = p.phase === "ranking" || p.phase === "done" || !p.running;
    if (!isEdge) {
      const longEnough = Date.now() - (this.lastScanProgressPushAtMs ?? 0) > ToolEngine.SCAN_PROGRESS_PUSH_THROTTLE_MS;
      if (!longEnough) return;
    }
    this.lastScanProgressPushAtMs = Date.now();
    void this.pushLiveState(true);
  }

  /**
   * getLiveState — PC가 올려 둔 최신 상태를 읽는다(폰이 주로 쓰지만 PC 자신도 쓸 수 있다).
   *   updatedAtMs(올라간 시각)를 함께 돌려줘, 화면이 "멈춘 건지 원래 이 상태인지"를
   *   구분해 보여줄 수 있게 한다(오너 지시: "마지막 갱신 시각을 표시해라").
   */
  async getLiveState(): Promise<{
    ok: boolean;
    status: AutoTradeStatus | null;
    journal: JournalEntry[];
    killSwitch: boolean | null;
    scanProgress: LiveScanProgress | null;
    reports: AutoReport[];
    lab: LabMirror | null;
    /** [v0.70.0] PC에 지금 실제로 저장된 설정 전체 — "저장은 됐는데 반영은 됐나?"를 폰이
     *  직접 확인할 수 있게 한다. 옛 PC가 올린 상태(이 필드 없음)면 null. */
    settings: ReturnType<ToolEngine["getSettings"]> | null;
    updatedAtMs: number | null;
    message?: string;
  }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, status: null, journal: [], killSwitch: null, scanProgress: null, reports: [], lab: null, settings: null, updatedAtMs: null, message: "먼저 로그인하세요." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_live_state?kind=eq.snapshot&select=payload,updated_at`, {
        headers: this.authRestHeaders(token),
      }, 10_000, "capri_live_state");
      if (!res.ok)
        return { ok: false, status: null, journal: [], killSwitch: null, scanProgress: null, reports: [], lab: null, settings: null, updatedAtMs: null, message: `조회 실패(HTTP ${res.status}).` };
      const rows = (await res.json()) as Array<{
        payload: {
          status?: AutoTradeStatus; journal?: JournalEntry[]; killSwitch?: boolean; scanProgress?: LiveScanProgress | null;
          reports?: AutoReport[]; lab?: LabMirror; settings?: ReturnType<ToolEngine["getSettings"]>;
        };
        updated_at: string;
      }>;
      if (!rows[0])
        return { ok: false, status: null, journal: [], killSwitch: null, scanProgress: null, reports: [], lab: null, settings: null, updatedAtMs: null, message: "PC가 아직 상태를 올린 적이 없습니다." };
      return {
        ok: true,
        status: rows[0].payload.status ?? null,
        journal: rows[0].payload.journal ?? [],
        killSwitch: rows[0].payload.killSwitch ?? null,
        scanProgress: rows[0].payload.scanProgress ?? null,
        reports: rows[0].payload.reports ?? [],
        lab: rows[0].payload.lab ?? null,
        settings: rows[0].payload.settings ?? null,
        updatedAtMs: new Date(rows[0].updated_at).getTime(),
      };
    } catch (e) {
      return { ok: false, status: null, journal: [], killSwitch: null, scanProgress: null, reports: [], lab: null, settings: null, updatedAtMs: null, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---------------------------------------------------------------------------
  // [v0.35.0] 그룹(공동개발자·동업자) 전체 연구용 — capri_group_trades에 "평문"으로 올린다.
  //   [오너 지시 2026-09-28] 카프리는 비공개 그룹(가입 자체가 모든 사항에 대한 동의 전제)이고
  //   전원이 소유주(고객 없음)라, 위 syncPushAutoState/syncPullAutoState(본인만 보는 암호화
  //   동기화)와는 완전히 별도로, "그룹 전원이 실명으로 함께 보는" 표를 하나 더 둔다.
  //   비식별화하지 않는다 — 오너 지시 그대로 이메일을 그대로 올린다.
  // ---------------------------------------------------------------------------

  /**
   * syncPushGroupTrades — 내 자동매매기록 전체를 평문 그대로 그룹 공유 표에 올린다(암호화 없음).
   *
   * [v0.56.0 긴급 수정] capri_group_trades는 `user_id` 기준 "행 전체"를 통째로 덮어쓰는
   *   업서트(on_conflict=user_id)다. 카프리는 과거에 "로그인 비밀번호 하나로 통합"해서 쓰던
   *   시절이 있었고(CLAUDE.md 참고), 지금도 같은 계정을 여러 기기에서 같이 쓰는 경우가 있을 수
   *   있는데 — 그런 상황에서 기기 A가 자기 로컬 기록(예: 10건)만으로 이 행을 덮어쓰면, 기기
   *   B가 조금 전에 올려 둔 기록(A가 모르는 것)이 통째로 사라진다. "그룹 전체 실시간 동기화"를
   *   철저히 하려면 이 쓰기 경합이 데이터를 잃어버리면 안 된다. 그래서 올리기 전에 서버에 이미
   *   있는 내용을 먼저 받아와, 이 기기가 모르는 기록(다른 기기가 남긴 것)은 살려 두고 합쳐서
   *   올린다. 같은 id(종목@진입가@진입시각)가 양쪽에 있으면 **"더 진행된 상태"가 이긴다**
   *   (watching(0) < active(1) < 끝난 상태(2)) — 단순 "이 기기가 무조건 최신"으로 덮어쓰면,
   *   이 기기가 옛 상태(예: watching)를 여태 못 받아온 사이 다른 기기가 이미 그 매매를
   *   closed로 끝내고 올려 둔 걸 되돌려 버리는 사고가 날 수 있다(2차 검토에서 발견 — 상태
   *   전이는 절대 거꾸로 안 간다는 성질을 이용해 항상 안전한 쪽으로만 병합). 이 규칙은
   *   `syncPullAutoState`(개인용 기기 간 동기화)가 이미 쓰는 것과 완전히 같은 함수
   *   (`mergeAutoHistory`, lib/auto-state-sync.ts)를 그대로 재사용한다 — 새 규칙을 또
   *   만들지 않는다.
   */
  async syncPushGroupTrades(): Promise<{ ok: boolean; message: string; count?: number }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요." };
    if (!this.authEmail || !this.authUserId) return { ok: false, message: "로그인 정보가 없습니다." };
    if (this.autoTradeHistory.length === 0) return { ok: false, message: "올릴 자동매매 기록이 없습니다." };

    let merged: AutoTradeHistoryEntry[] = this.autoTradeHistory;
    try {
      const existing = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_group_trades?user_id=eq.${this.authUserId}&select=history`, {
        headers: this.authRestHeaders(token),
      }, 10_000, "capri_group_trades");
      if (existing.ok) {
        const rows = (await existing.json()) as Array<{ history: unknown }>;
        const remoteHistory = Array.isArray(rows[0]?.history) ? (rows[0].history as AutoTradeHistoryEntry[]) : [];
        merged = mergeAutoHistory(this.autoTradeHistory, remoteHistory);
      }
    } catch {
      // 병합용 조회 실패 — 이 기기가 아는 기록만으로라도 올린다(완전 실패보단 낫다).
    }

    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_group_trades?on_conflict=user_id`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: this.authUserId,
          member_email: this.authEmail,
          history: merged,
          updated_at: new Date().toISOString(),
        }),
      }, 10_000, "capri_group_trades");
      if (!res.ok) return { ok: false, message: `그룹 공유 저장 실패(HTTP ${res.status}).` };
      this.lastGroupPushAtMs = Date.now();
      return { ok: true, message: `그룹에 자동매매 기록 ${merged.length}건을 공유했습니다.`, count: merged.length };
    } catch (e) {
      return { ok: false, message: `공유 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * syncPullGroupHistory — 그룹(가입 허용목록) 전원의 자동매매기록을 실명(이메일)째로 받아온다.
   *
   * [v0.60.0 긴급 수정 — 오너 실사용 보고: "매매연구 탭이 그룹원 데이터를 못 불러옴", "그룹원
   *   관리 탭에 실제 그룹원(카일)이 안 보임"] 예전엔 capri_group_trades에 실제로 행이 있는
   *   사람만 나열했다 — 로그인만 하고 자동매매 기록을 한 번도 안 올린 그룹원(가입만 하고 아직
   *   안 써 본 경우 등)은 통째로 목록에서 빠졌다("아직 기록 없음"으로 보여야 한다는 화면 쪽
   *   의도와 다르게, 아예 안 보임). capri_allowed_emails(가입 허용목록 = 그룹 명단)에서
   *   먼저 "그룹원이 누구누구인지" 전체 명단을 받아온 뒤, capri_group_trades의 실제 기록을
   *   그 위에 덧씌운다 — 기록이 없는 그룹원은 빈 배열로 명단에 남아, 화면이 원래 의도대로
   *   "아직 기록 없음"을 보여줄 수 있게 됐다. (capri_allowed_emails를 일반 그룹원도 조회할
   *   수 있어야 이게 가능한데, 예전엔 오너 전용이었다 — 새 마이그레이션
   *   20260930140000_capri_group_roster_rls.sql로 "승인된 그룹원이면 명단을 볼 수 있다"
   *   정책을 추가했다.)
   */
  async syncPullGroupHistory(): Promise<{ ok: boolean; message: string; members: { email: string; history: AutoTradeHistoryEntry[] }[] }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요.", members: [] };

    try {
      const [rosterRes, tradesRes] = await Promise.all([
        fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_allowed_emails?select=email&order=email.asc`, {
          headers: this.authRestHeaders(token),
        }, 10_000, "capri_allowed_emails"),
        fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_group_trades?select=member_email,history`, {
          headers: this.authRestHeaders(token),
        }, 10_000, "capri_group_trades"),
      ]);
      if (!tradesRes.ok) return { ok: false, message: `그룹 기록 조회 실패(HTTP ${tradesRes.status}).`, members: [] };
      const tradeRows = (await tradesRes.json()) as Array<{ member_email: string; history: unknown }>;
      const historyByEmail = new Map<string, AutoTradeHistoryEntry[]>();
      for (const r of tradeRows) {
        if (Array.isArray(r.history)) historyByEmail.set(r.member_email, r.history as AutoTradeHistoryEntry[]);
      }
      // 명단(roster) 조회는 실패해도 전체를 실패로 만들지 않는다 — 예전 동작(기록이 있는
      // 사람만 나열)으로 조용히 대체된다(마이그레이션 미적용 등 과도기 대비 안전망).
      let rosterEmails: string[] = [...historyByEmail.keys()];
      if (rosterRes.ok) {
        const rosterRows = (await rosterRes.json()) as Array<{ email: string }>;
        const merged = new Set<string>(rosterRows.map((r) => r.email));
        for (const e of historyByEmail.keys()) merged.add(e); // 명단에 없어도 기록이 있으면 보여준다
        rosterEmails = [...merged].sort();
      }
      const members = rosterEmails.map((email) => ({ email, history: historyByEmail.get(email) ?? [] }));
      return { ok: true, message: `그룹 회원 ${members.length}명의 자동매매기록을 받았습니다.`, members };
    } catch (e) {
      return { ok: false, message: `받기 실패: ${e instanceof Error ? e.message : String(e)}`, members: [] };
    }
  }

  /**
   * [v0.56.0] "그룹 전체 실시간 동기화" — 오너 지시: 버튼을 눌러야만 올리고/받던 걸 자동화.
   *   로그인해 있는 동안(자동매매 켜짐 여부와 무관) 3분마다 스스로 ①내 기록을 올리고(있으면)
   *   ②그룹 전체 기록을 받아와 "groupSync" 이벤트로 화면에 뿌린다. 실계좌 주문과 무관한
   *   "내 기록 공유"일 뿐이라 자동매매급 안전장치는 필요 없지만, 그래도 앱이 켜져 있는 동안만
   *   돈다는 원칙(자동매매와 동일)은 지킨다 — 로그아웃하면 즉시 멈춘다.
   */
  startGroupSyncLoop(): void {
    if (this.groupSyncTimer) return; // 이미 돌고 있음
    if (!this.authAccessToken && !this.authRefreshToken) return; // 로그인 안 돼 있으면 시작 안 함
    void this.groupSyncTick(); // 기다리지 않고 즉시 1회(다음 3분을 기다리지 않게)
    this.groupSyncTimer = setInterval(() => void this.groupSyncTick(), ToolEngine.GROUP_SYNC_INTERVAL_MS);
  }

  stopGroupSyncLoop(): void {
    if (this.groupSyncTimer) {
      clearInterval(this.groupSyncTimer);
      this.groupSyncTimer = null;
    }
  }

  private async groupSyncTick(): Promise<void> {
    try {
      if (this.autoTradeHistory.length > 0) await this.syncPushGroupTrades();
      const pulled = await this.syncPullGroupHistory();
      if (pulled.ok) this.emit("groupSync", pulled.members);
    } catch {
      // 한 사이클 실패는 조용히 넘어간다 — 다음 3분에 다시 시도(자가 복구, 자동매매 사이클과 동일 원칙).
    }
  }

  // ==========================================================================
  // [v0.59.0] 폰 원격 조종 — "PC가 켜져 있는 동안은 폰에서 전부 조작 가능해야 한다"(오너 지시).
  //   마이그레이션 20260930130000 참고. 흐름:
  //     폰/PC 아무 기기 → sendCommand(type,payload) → capri_commands에 pending 한 줄 →
  //     PC(이 루프)가 8초마다 폴링해 집어서(acked) 실행 → 결과(done/failed+result) 기록.
  //   Realtime을 못 쓰는 이유·멱등성 설계는 마이그레이션 파일 주석 참고.
  // ==========================================================================

  /** [PC 전용 — main.ts만 호출] 로그인 직후 시작. 이미 돌고 있으면 무시(안전한 재호출). */
  startRemoteControlLoop(): void {
    if (this.remoteControlTimer) return;
    if (!this.authAccessToken && !this.authRefreshToken) return;
    void this.remoteControlTick();
    this.remoteControlTimer = setInterval(() => void this.remoteControlTick(), ToolEngine.REMOTE_CONTROL_INTERVAL_MS);
  }

  stopRemoteControlLoop(): void {
    if (this.remoteControlTimer) {
      clearInterval(this.remoteControlTimer);
      this.remoteControlTimer = null;
    }
  }

  /** [PC 전용 — main.ts만 호출] 로그인 직후 시작. 이미 돌고 있으면 무시(안전한 재호출).
   *  [v0.71.0] auditUnprotectedHoldings를 자동매매 켜짐 여부와 무관하게 돌린다 — 왜 필요한지는
   *  위 protectionAuditTimer 필드 주석(LPCN 37시간 무방비 사례) 참고.
   *  [v0.78.0→v0.81.0] 한때 reflectUnknownHoldings("Capri가 모르는 보유종목 참고용 기록")도
   *  같은 주기로 함께 돌았으나, 그 기록을 auditUnprotectedHoldings가 "Capri 포지션"으로 오인해
   *  실제로 매도까지 나간 사고(2026-10-11, 하이닉스·필옵틱스·아이온큐)가 있었다 — 오너 지시로
   *  기능 자체를 완전히 제거했다. */
  startProtectionAuditLoop(): void {
    if (this.protectionAuditTimer) return;
    if (!this.authAccessToken && !this.authRefreshToken) return;
    const tick = () => {
      void this.auditUnprotectedHoldings().catch(() => 0);
    };
    tick();
    this.protectionAuditTimer = setInterval(tick, ToolEngine.PROTECTION_AUDIT_INTERVAL_MS);
  }

  stopProtectionAuditLoop(): void {
    if (this.protectionAuditTimer) {
      clearInterval(this.protectionAuditTimer);
      this.protectionAuditTimer = null;
    }
  }

  /** [PC 전용 — main.ts만 호출] 로그인 직후 시작. 이미 돌고 있으면 무시(안전한 재호출).
   *  [v0.74.0] 위 positionSyncTimer 필드 주석(task #72) 참고 — 화면 탭이 닫혀 있거나
   *  자동매매가 꺼져 있어도 감시 포지션 상태를 계속 최신으로 유지한다. */
  startPositionSyncLoop(): void {
    if (this.positionSyncTimer) return;
    if (!this.authAccessToken && !this.authRefreshToken) return;
    void this.reconcileAutoPositionsNow().catch(() => 0);
    this.positionSyncTimer = setInterval(() => void this.reconcileAutoPositionsNow().catch(() => 0), ToolEngine.POSITION_SYNC_INTERVAL_MS);
  }

  stopPositionSyncLoop(): void {
    if (this.positionSyncTimer) {
      clearInterval(this.positionSyncTimer);
      this.positionSyncTimer = null;
    }
  }

  /** 한 주기: ①생존 신호 갱신 ②내 pending 명령을 폴링해 실행. 실패해도 다음 주기에 재시도. */
  private async remoteControlTick(): Promise<void> {
    if (this.remoteControlTickBusy) return;
    this.remoteControlTickBusy = true;
    try {
      await this.remoteControlTickInner();
    } finally {
      this.remoteControlTickBusy = false;
    }
  }

  private async remoteControlTickInner(): Promise<void> {
    const token = await this.ensureAccessToken();
    if (!token || !this.authUserId) return;
    try {
      // [v0.60.4] auto_trade_enabled도 함께 실어 보낸다 — 폰이 "PC에서 지금 자동매매가
      //   진짜로 돌고 있는지"를 알 방법이 이것뿐이었다(오너 실사용 보고: "원격으로 시작을
      //   눌러도 진행되고 있는지 모르겠다").
      // [v0.60.9] app_version도 함께 보낸다 — "자동매매가 켜져 있으면 절대 재시작 안 함"
      //   안전장치 때문에, PC가 몇 시간째 켜둔 자동매매를 안 끄면 새 버전을 받아도 적용이
      //   안 된 채로(옛 코드 그대로) 계속 돈다. 폰에서 "PC가 지금 몇 버전을 돌리는지"를
      //   바로 볼 수 있어야 "업데이트가 안 먹는 건지, PC가 아직 옛 버전인 건지"를 헷갈리지
      //   않는다 — 이 칼럼은 원래부터 있었는데 지금까지 아무도 채워 넣지 않고 있었다.
      await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_desktop_heartbeat?on_conflict=user_id`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: this.authUserId,
          last_seen: new Date().toISOString(),
          auto_trade_enabled: this.autoTradeEnabled,
          app_version: this.appVersion,
        }),
      }, 10_000, "capri_desktop_heartbeat");
    } catch {
      /* 생존 신호 실패는 조용히 무시(다음 8초 주기에 재시도) */
    }
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_commands?status=eq.pending&select=id,type,payload&order=created_at.asc&limit=5`,
        { headers: this.authRestHeaders(token) },
      10_000, "capri_commands");
      if (!res.ok) return;
      const rows = (await res.json()) as Array<{ id: string; type: string; payload: Record<string, unknown> }>;
      for (const row of rows) await this.claimAndExecuteCommand(token, row);
    } catch {
      /* 폴링 실패는 조용히 무시(다음 8초 주기에 재시도) */
    }
    void this.cleanupOldCommands(token);
  }

  private lastCommandsCleanupAtMs: number | null = null;
  private static readonly COMMANDS_CLEANUP_INTERVAL_MS = 24 * 3600_000; // 하루에 한 번이면 충분

  /**
   * [v0.61.6 — ③ 전수조사 중간-4] capri_commands에 보존 기간이 없어 done/failed 행이
   *   무한정 쌓이고 있었다(SQL로 확인: 당장은 208KB로 작지만 수개월~수년 누적되면 커진다).
   *   PC가 8초마다 도는 이 루프에 묻어가되, 하루 한 번만(네트워크·DB 부담 최소화) 30일
   *   지난 done/failed 행을 지운다. RLS가 "본인 행만"을 이미 강제하므로 user_id 조건은
   *   없어도 안전하다(다른 사람 행은 애초에 안 보이고 못 지운다).
   */
  private async cleanupOldCommands(token: string): Promise<void> {
    const longEnough = Date.now() - (this.lastCommandsCleanupAtMs ?? 0) > ToolEngine.COMMANDS_CLEANUP_INTERVAL_MS;
    if (!longEnough) return;
    this.lastCommandsCleanupAtMs = Date.now(); // 실패해도 다음 8초 주기에 바로 재시도하지 않도록 먼저 찍어 둔다(하루 뒤 재시도)
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_commands?status=in.(done,failed)&created_at=lt.${encodeURIComponent(cutoff)}`,
        { method: "DELETE", headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" } },
        10_000,
        "capri_commands_cleanup",
      );
    } catch {
      /* 청소 실패는 조용히 무시 — 다음 날 다시 시도, 당장 기능엔 영향 없음 */
    }
  }

  /**
   * [멱등성 핵심] status='pending'인 행만 골라 'acked'로 **조건부** UPDATE한다. 같은 행을
   *   두 폴링 주기(또는 이론상 두 PC)가 동시에 집으려 해도, WHERE status='pending' 조건에
   *   걸려 둘 중 하나만 실제로 행을 바꾼다(PostgREST의 Prefer: return=representation로
   *   "내가 바꾼 행"을 돌려받아 확인 — 빈 배열이면 이미 누가 선점한 것이므로 건너뛴다).
   *   선점에 성공한 행만 실행하고, 끝나면 즉시 done/failed로 확정한다(재시도 없음 — 실주문
   *   명령을 여러 번 내는 것보다 한 번 실패하고 사람이 다시 보내는 쪽이 훨씬 안전하다).
   */
  private async claimAndExecuteCommand(token: string, row: { id: string; type: string; payload: Record<string, unknown> }): Promise<void> {
    let claimed: unknown[] = [];
    try {
      const claim = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_commands?id=eq.${row.id}&status=eq.pending`, {
        method: "PATCH",
        headers: { ...this.authRestHeaders(token), Prefer: "return=representation" },
        body: JSON.stringify({ status: "acked" }),
      }, 10_000, "capri_commands");
      if (!claim.ok) return;
      claimed = (await claim.json()) as unknown[];
    } catch {
      return;
    }
    if (claimed.length === 0) return; // 이미 다른 폴링 주기가 선점함 — 건너뛴다(중복 실행 방지)

    let result: { ok: boolean; message?: string; [k: string]: unknown };
    try {
      result = await this.dispatchCommand(row.type, row.payload);
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: `📱 원격 명령 실행: ${row.type} → ${result.ok ? "성공" : "실패"}`,
      category: "자동매매",
    });
    try {
      await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_commands?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" },
        body: JSON.stringify({ status: result.ok ? "done" : "failed", result, executed_at: new Date().toISOString() }),
      }, 10_000, "capri_commands");
    } catch {
      /* 결과 기록 실패는 조용히 무시 — 명령 자체는 이미 실행됐다(재실행 안 함) */
    }
  }

  /**
   * [화이트리스트 디스패처] 여기 나열된 타입만 실행된다(마이그레이션의 check 제약과 이중으로
   *   맞춰 둠). 전부 기존에 로컬 버튼(IPC)이 이미 부르던 **바로 그 함수**를 그대로 호출한다
   *   — DRY_RUN·킬스위치·가격보호 같은 안전장치는 그 함수들 안에 이미 있으므로, 원격이라고
   *   다르게 취급되지 않는다(우회 경로 없음).
   */
  private async dispatchCommand(type: string, payload: Record<string, unknown>): Promise<{ ok: boolean; message?: string; [k: string]: unknown }> {
    switch (type) {
      case "autoTradeStart":
        return { ok: true, status: this.startAutoTrade() };
      case "autoTradeStop":
        return { ok: true, status: this.stopAutoTrade() };
      case "saveAutoTradeSettings":
        return { ok: true, settings: await this.saveAutoTradeSettings(payload as Parameters<ToolEngine["saveAutoTradeSettings"]>[0]) };
      case "saveLabSettings":
        // [v0.65.0] 매매연구소(신호 기록 모드)는 주문을 내지 않는 읽기 전용이라 폰에서 켜고 꺼도 안전하다.
        return { ok: true, status: this.saveLabSettings(payload as Parameters<ToolEngine["saveLabSettings"]>[0]) };
      case "saveAutoScanSettings":
        // [v0.61.1 — ③ 전수조사에서 발견한 치명 버그 수정] 폰이 "스크리닝 기준" 탭에서
        //   저장해도 예전엔 이 명령 자체가 화이트리스트에 없어 폰의 로컬(의미 없는) 엔진에만
        //   적용되고 PC는 전혀 몰랐다 — PC가 실제로 돌리는 스캔 조건이 안 바뀌는데도 화면은
        //   "저장됨"이라고 떠 오너를 속이는 상태 불일치였다.
        return { ok: true, settings: await this.saveAutoScanSettings(payload as Parameters<ToolEngine["saveAutoScanSettings"]>[0]) };
      case "setKillSwitch":
        await this.setKillSwitch(!!payload.on);
        return { ok: true };
      case "setLiveOrders":
        // [v0.61.6 — ③ 전수조사 중간-1, 오너 승인] 실주문 활성화는 killSwitch·자동매매 한도와
        //   같은 "PC의 실제 매매 동작을 바꾸는" 공유 안전 설정이라 원격화했다 — 반면
        //   setPriceGuard·setSkipConfirm은 그 기기 자신이 직접 내는 주문에만 적용되는
        //   화면별 설정이라(각 기기가 자기 주문을 자기 설정으로 보호) 원격화하지 않는다
        //   (docs/audit-2026-10-01.md [중간-1] 참고).
        this.setLiveOrders(!!payload.on);
        return { ok: true };
      case "saveSystemPauseEnabled":
        return { ok: true, settings: this.saveSystemPauseEnabled(!!payload.enabled) };
      case "placeEntry":
        return { ok: true, journal: await this.placeEntry(payload as Parameters<ToolEngine["placeEntry"]>[0]) };
      case "placeSell":
        return { ok: true, journal: await this.placeSell(payload as Parameters<ToolEngine["placeSell"]>[0]) };
      case "cancelAutoPosition":
        return await this.cancelAutoPosition(String(payload.symbol), Number(payload.entry), Number(payload.enteredAtMs));
      case "dismissUnprotected":
        return this.dismissUnprotected(String(payload.symbol));
      case "autoScanNow":
        return { ok: true, status: await this.autoScanNow() };
      default:
        return { ok: false, message: `알 수 없는 명령: ${type}` };
    }
  }

  /** [폰/PC 공용] 명령을 큐에 넣는다. 실행은 로그인된 PC가 한다(이 함수는 "넣기"만). */
  async sendCommand(type: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; message: string; commandId?: string }> {
    const token = await this.ensureAccessToken();
    if (!token || !this.authUserId) return { ok: false, message: "먼저 로그인하세요." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_commands`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "return=representation" },
        body: JSON.stringify({ user_id: this.authUserId, type, payload }),
      }, 10_000, "capri_commands");
      if (!res.ok) return { ok: false, message: `명령 접수 실패(HTTP ${res.status}). PC가 켜져 있고 승인된 계정인지 확인하세요.` };
      const rows = (await res.json()) as Array<{ id: string }>;
      return { ok: true, message: "명령을 보냈습니다. PC가 몇 초 안에 실행합니다.", commandId: rows[0]?.id };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** [폰/PC 공용] 최근에 보낸 명령들의 처리 상태(참고용 — "지금 몇 개 보냈고, 처리됐는지"). */
  async listMyCommands(limit = 10): Promise<Array<{ id: string; type: string; status: string; result: unknown; createdAt: string }>> {
    const token = await this.ensureAccessToken();
    if (!token) return [];
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_commands?select=id,type,status,result,created_at&order=created_at.desc&limit=${limit}`,
        { headers: this.authRestHeaders(token) },
      10_000, "capri_commands");
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ id: string; type: string; status: string; result: unknown; created_at: string }>;
      return rows.map((r) => ({ id: r.id, type: r.type, status: r.status, result: r.result, createdAt: r.created_at }));
    } catch {
      return [];
    }
  }

  /**
   * [폰/PC 공용] "PC가 지금 켜져 있나? 자동매매는 켜져 있나?" — 최근 생존 신호 시각(없으면
   *   null) + PC가 보낸 실제 자동매매 켜짐/꺼짐. 화면이 임계값(예: 90초)과 비교해 판단한다.
   *   [v0.60.4] autoTradeEnabled 추가 — 예전엔 이 값이 없어 폰의 [자동매매 현황] 탭이
   *   "그 기기 자체의 로컬 상태"(web 세션은 의미 없는 값)를 보여줄 수밖에 없었다(오너
   *   실사용 보고: "원격으로 시작을 눌러도 진행되고 있는지 모르겠다"). 이제 PC가 실제로
   *   보낸 값을 그대로 보여줄 수 있다.
   */
  async getDesktopHeartbeat(): Promise<{ lastSeenMs: number | null; autoTradeEnabled: boolean | null; pcAppVersion: string | null }> {
    const token = await this.ensureAccessToken();
    if (!token) return { lastSeenMs: null, autoTradeEnabled: null, pcAppVersion: null };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_desktop_heartbeat?select=last_seen,auto_trade_enabled,app_version`, {
        headers: this.authRestHeaders(token),
      }, 10_000, "capri_desktop_heartbeat");
      if (!res.ok) return { lastSeenMs: null, autoTradeEnabled: null, pcAppVersion: null };
      const rows = (await res.json()) as Array<{ last_seen: string; auto_trade_enabled: boolean | null; app_version: string | null }>;
      if (!rows[0]) return { lastSeenMs: null, autoTradeEnabled: null, pcAppVersion: null };
      return {
        lastSeenMs: new Date(rows[0].last_seen).getTime(),
        autoTradeEnabled: rows[0].auto_trade_enabled ?? null,
        pcAppVersion: rows[0].app_version ?? null,
      };
    } catch {
      return { lastSeenMs: null, autoTradeEnabled: null, pcAppVersion: null };
    }
  }

  // -----------------------------------------------------------------------------
  // [v0.56.0] 그룹 채팅 — 오너 지시: "그룹원끼리의 근황 현황파악 가능하도록 CHAT 기능도 도입".
  //   capri_group_trades와 같은 원칙(비공개 그룹, 실명, 비식별화 없음) — 가입 허용목록에 있는
  //   사람이면 누구나 전체 대화를 보고 쓸 수 있다(마이그레이션의 RLS 정책 참고).
  // -----------------------------------------------------------------------------

  /** sendGroupChatMessage — 그룹 채팅에 메시지 한 줄을 남긴다. */
  async sendGroupChatMessage(body: string): Promise<{ ok: boolean; message: string }> {
    const text = body.trim();
    if (!text) return { ok: false, message: "빈 메시지는 보낼 수 없습니다." };
    if (text.length > 2000) return { ok: false, message: "메시지가 너무 깁니다(2000자 이하)." };
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요." };
    if (!this.authEmail || !this.authUserId) return { ok: false, message: "로그인 정보가 없습니다." };
    try {
      const res = await fetchWithTimeout(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_group_chat`, {
        method: "POST",
        headers: { ...this.authRestHeaders(token), Prefer: "return=minimal" },
        body: JSON.stringify({ user_id: this.authUserId, member_email: this.authEmail, body: text }),
      }, 10_000, "capri_group_chat");
      if (!res.ok) return { ok: false, message: `채팅 전송 실패(HTTP ${res.status}).` };
      return { ok: true, message: "전송했습니다." };
    } catch (e) {
      return { ok: false, message: `전송 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** getGroupChatMessages — 최근 그룹 채팅을 오래된순으로 받아온다(최대 200개). */
  async getGroupChatMessages(): Promise<{ ok: boolean; message: string; chat: GroupChatMessage[] }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요.", chat: [] };
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_group_chat?select=id,member_email,body,created_at&order=created_at.desc&limit=200`,
        { headers: this.authRestHeaders(token) },
      10_000, "capri_group_chat");
      if (!res.ok) return { ok: false, message: `채팅 조회 실패(HTTP ${res.status}).`, chat: [] };
      const rows = (await res.json()) as Array<{ id: number; member_email: string; body: string; created_at: string }>;
      const chat: GroupChatMessage[] = rows
        .map((r) => ({ id: r.id, email: r.member_email, body: r.body, createdAt: r.created_at }))
        .reverse(); // 서버는 최신순으로 주므로, 화면(위→아래 시간순) 표시를 위해 뒤집는다.
      return { ok: true, message: `메시지 ${chat.length}건을 받았습니다.`, chat };
    } catch (e) {
      return { ok: false, message: `조회 실패: ${e instanceof Error ? e.message : String(e)}`, chat: [] };
    }
  }

  // -----------------------------------------------------------------------------
  // [v0.61.9 — 오너 지시] "업데이트 내역 탭을 신설하고, 개발 보고를 동업자들과 공유하고
  //   싶다" — capri_group_chat과 같은 원칙(비공개 그룹, 평문, 그룹 전원이 함께 본다).
  //   다만 쓰기는 오너 계정만(마이그레이션 RLS 참고) — 그룹원이 실수로 변경 로그를
  //   건드리지 않게. 실제 글 작성은 이 앱의 UI가 아니라 각 버전을 커밋할 때 Supabase에
  //   직접 올린다(오너가 "나에게 보고하는 것처럼" 요청한 리포트 — 민감사항은 뺀 버전).
  // -----------------------------------------------------------------------------

  /** getChangelog — 업데이트 내역을 최신순으로 받아온다(최대 50개) + 이 기기가 마지막으로
   *  읽은 버전(팝업 표시 여부 판단용 — 로컬 저장, 기기별로 따로 관리). */
  async getChangelog(): Promise<{ ok: boolean; message: string; entries: ChangelogEntry[]; lastSeenVersion: string | null }> {
    const token = await this.ensureAccessToken();
    if (!token) return { ok: false, message: "먼저 로그인하세요.", entries: [], lastSeenVersion: this.lastSeenChangelogVersion };
    try {
      const res = await fetchWithTimeout(
        `${ToolEngine.SUPABASE_URL}/rest/v1/capri_changelog?select=version,title,body,published_at&order=published_at.desc&limit=50`,
        { headers: this.authRestHeaders(token) },
        10_000,
        "capri_changelog",
      );
      if (!res.ok) return { ok: false, message: `업데이트 내역 조회 실패(HTTP ${res.status}).`, entries: [], lastSeenVersion: this.lastSeenChangelogVersion };
      const rows = (await res.json()) as Array<{ version: string; title: string; body: string; published_at: string }>;
      const entries: ChangelogEntry[] = rows.map((r) => ({ version: r.version, title: r.title, body: r.body, publishedAt: r.published_at }));
      return { ok: true, message: `업데이트 내역 ${entries.length}건을 받았습니다.`, entries, lastSeenVersion: this.lastSeenChangelogVersion };
    } catch (e) {
      return { ok: false, message: `조회 실패: ${e instanceof Error ? e.message : String(e)}`, entries: [], lastSeenVersion: this.lastSeenChangelogVersion };
    }
  }

  /** markChangelogSeen — "최신 업데이트 내역을 봤다"고 이 기기에 로컬로 기록한다(팝업이
   *  매번 다시 뜨지 않게). 기기마다 따로 관리 — 폰에서 읽었다고 PC의 팝업까지 안 꺼진다
   *  (오너 지시: "폰 pc 모두" 띄우라고 했으므로 각 화면이 각자 확인하는 게 맞다). */
  markChangelogSeen(version: string): void {
    this.lastSeenChangelogVersion = version;
    this.persistEnv();
  }

  /** 새로 받은 체결을 저장본에 합친다(중복 제거). 다른 화면(주문 현황 등)에서도 부를 수 있다. */
  private absorbFills(incoming: Fill[]): void {
    if (incoming.length === 0) return;
    const before = this.savedFills.length;
    this.savedFills = mergeFills(this.savedFills, incoming);
    // 너무 오래된 것은 정리(2년치면 충분 — 저장 공간이 무한하지 않다)
    const cutoff = Date.now() - 730 * 86_400_000;
    this.savedFills = this.savedFills.filter((f) => f.atMs >= cutoff);
    this.fillsSyncedAtMs = Date.now();
    this.persistFills();

    // [v0.10.0] 새 매매가 생겼으면 클라우드에도 올려 둔다(폰이 회사에서 볼 수 있게).
    //   · 로그인 상태(authPassword 있음)일 때만 동작한다.
    //   · 실패해도 무시한다(로컬 저장본은 그대로라 화면은 정상).
    //   · 5분에 한 번으로 제한 — 너무 잦은 업로드 방지.
    //   · [v0.102.0] 5분 안에 또 생기면 건너뛰지 않고 남은 시간 뒤로 예약한다(schedulePush).
    const changed = this.savedFills.length !== before;
    if (changed) this.schedulePush("trades", 5 * 60_000);
    // [v0.22.0] 청산 강도는 여기서 체결을 보고 '기록'하지 않는다.
    //   대신 tradeAnalysis가 자동 저장된 체결강도 시계열을 '청산 시각(sellAtMs)'으로 조회해 붙인다
    //   (strengthAt). 체결→매매 매칭의 시간역전·다진입·부분청산 오류를 원천 회피하기 위함.
  }

  /** 지금 모드가 페이퍼(mock/dryrun)인지 실거래(real)인지 태그. */
  private currentMode(): "mock" | "dryrun" | "real" {
    if (this.mode === "mock") return "mock";
    return this.isDryRun() ? "dryrun" : "real";
  }

  /**
   * [v0.22.0] strengthAt — 자동 저장된 체결강도 시계열에서 특정 시각(atMs)에 '가장 가까운' 값을 찾는다.
   *   매매분석이 진입/청산 시각으로 그때의 체결강도를 되짚어 붙이는 데 쓴다. 체결↔매매를 시각으로만
   *   잇기 때문에 다진입·부분청산·조건주문 자동청산에도 안전하다(트레이드를 건드리지 않음, 읽기 전용).
   *   @param toleranceMs 이 시간 안에 기록이 있어야 인정(기본 30분). 기록이 없으면 null(정직).
   */
  private strengthAt(symbol: string, atMs: number | undefined, toleranceMs = 30 * 60_000): number | null {
    if (atMs == null || !Number.isFinite(atMs)) return null;
    const arr = this.strengthSeries[(symbol || "").toUpperCase().trim()];
    if (!arr || arr.length === 0) return null;
    let best: StrengthSample | null = null;
    let bestGap = Infinity;
    for (const s of arr) {
      if (s.strength == null || s.tsMs == null) continue;
      const gap = Math.abs(s.tsMs - atMs);
      if (gap < bestGap) { bestGap = gap; best = s; }
    }
    return best != null && bestGap <= toleranceMs ? best.strength : null;
  }

  /**
   * 체결강도 스냅샷(읽기 전용). 실패해도 null만 돌려주고 절대 예외를 위로 던지지 않는다.
   *   [v0.27.0] 이 심볼에 이미 돌고 있는 체결강도 기록(run)이 있으면 그 "최근 5분" 시간창
   *   버퍼를 그대로 읽어 계산한다 — 화면(매매분석)에 보이는 실시간 값과 저널에 찍히는 진입/
   *   청산 스냅샷이 항상 같은 정의(최근 5분)로 일치하게 된다. run이 없으면(기록을 안 켰거나
   *   이미 멈췄으면) 예전처럼 그 순간 1회성으로 최근 50틱을 받아 독립 계산(최선 추정치)한다.
   */
  private async snapshotStrength(symbol: string): Promise<TradeSnapshot | null> {
    const sym = (symbol || "").toUpperCase().trim();
    const run = this.strengthRuns.get(sym);
    if (run) {
      let buyVol = 0;
      let sellVol = 0;
      for (const b of run.buffer) { if (b.side === "buy") buyVol += b.volume; else sellVol += b.volume; }
      return { strength: strengthFromVolumes(buyVol, sellVol), buyVol, sellVol, rising: null };
    }
    try {
      const raw = await getTrades(symbol, 50);
      const ticks = raw
        .map((t) => ({ price: Number(t.price), volume: Number(t.volume), timestamp: t.timestamp }))
        .filter((t) => Number.isFinite(t.price) && Number.isFinite(t.volume) && t.volume > 0);
      const { result } = strengthFromTicks(ticks);
      return { strength: result.strength, buyVol: result.buyVol, sellVol: result.sellVol, rising: null };
    } catch {
      return null;
    }
  }

  /**
   * recordEntry — 진입 주문 순간, 트레이드를 '열고' 진입 시 체결강도를 스냅샷한다.
   *   ⚠️ 주문 메서드에서 `void this.recordEntry(...)`로 부른다(대기하지 않음 → 주문 응답 지연·오류 무관).
   */
  private async recordEntry(symbol: string, price: number, mode: "mock" | "dryrun" | "real", quantity?: number): Promise<void> {
    try {
      const now = DateTime.now().setZone("Asia/Seoul");
      const snap = await this.snapshotStrength(symbol);
      const trade: StrengthTrade = {
        id: String(now.toMillis()) + "-" + symbol,
        symbol,
        mode,
        entryTs: now.toFormat("MM-dd HH:mm:ss"),
        entryPrice: price,
        entry: snap,
        exitTs: null,
        exitPrice: null,
        exit: null,
        exitKind: null,
        resultPct: null,
        outcome: null,
        // 수량은 알 때만 담는다(모르면 옛 기록과 같은 모양 — 리포트가 금액을 생략한다).
        ...(Number.isFinite(quantity as number) ? { quantity } : {}),
      };
      this.trades.push(trade);
      if (this.trades.length > 1000) this.trades.shift();
      this.persistTrades();
      this.emit("trades", this.getTradeLog());
      // [v0.22.0] 매매하면 자동으로 이 종목의 체결강도 '연속 기록'을 켠다(auto=true).
      //   → 수동 [기록 시작]을 누르지 않아도 진입~보유 동안 시계열이 자동으로 쌓인다.
      //   이미 켜져 있으면 startStrength가 중복 시작을 막고(무해), 연결이 없으면 몇 번 재시도 후
      //   스스로 종료한다(무한 폴링 방지 — sampleStrengthOnce의 수명 제한). 화면엔 오류 안내가 뜬다.
      try { this.startStrength(symbol, 10, true); } catch { /* 기록 시작 실패는 주문과 무관 */ }
    } catch {
      /* 기록 실패는 주문과 무관 — 삼킨다 */
    }
  }

  /**
   * recordExit — 청산(매도) 순간, 그 종목의 '가장 최근 미청산 트레이드'를 닫고 결과를 계산한다.
   *   @param kind 익절(tp)/손절(sl)/수동(manual). placeSell은 manual로 부른다.
   */
  private async recordExit(symbol: string, exitPrice: number | null, kind: "tp" | "sl" | "manual", _mode: "mock" | "dryrun" | "real"): Promise<void> {
    try {
      // 가장 최근 미청산 트레이드(같은 종목)를 찾는다.
      let idx = -1;
      for (let i = this.trades.length - 1; i >= 0; i--) {
        if (this.trades[i].symbol === symbol && this.trades[i].outcome == null) { idx = i; break; }
      }
      if (idx === -1) return; // 짝지을 진입이 없으면 무시(수동 진입 등)
      // 청산가가 없으면(시장가 매도 등) 현재가로 대체.
      let px = exitPrice;
      if (px == null || !Number.isFinite(px)) {
        try { px = (await getPrice(symbol)).price; } catch { px = null; }
      }
      const snap = await this.snapshotStrength(symbol);
      const t = this.trades[idx];
      const now = DateTime.now().setZone("Asia/Seoul");
      t.exitTs = now.toFormat("MM-dd HH:mm:ss");
      t.exitAtMs = now.toMillis(); // [v0.9.2] 기간 조회용 정확한 시각
      t.exitPrice = px;
      t.exit = snap;
      t.exitKind = kind;
      t.resultPct = px != null && t.entryPrice ? Math.round(((px - t.entryPrice) / t.entryPrice) * 10000) / 100 : null;
      t.outcome = t.resultPct == null ? null : t.resultPct > 0 ? "win" : "loss";
      this.persistTrades();
      this.emit("trades", this.getTradeLog());
      // [v0.22.0] 이 종목에 미청산 매매가 더 없으면 자동 기록을 끈다(보유가 끝났으니 계속 폴링할 이유 없음).
      //   부분 청산으로 아직 남은 매매가 있으면 계속 기록한다.
      const stillOpen = this.trades.some((x) => x.symbol === symbol && x.outcome == null);
      if (!stillOpen) { try { this.stopStrength(symbol); } catch { /* 무해 */ } }
    } catch {
      /* 기록 실패는 주문과 무관 */
    }
  }

  /** 트레이드 목록(최신이 위). 화면 표시용. */
  getTradeLog(): StrengthTrade[] {
    return [...this.trades].reverse();
  }

  /** 트레이드 분석 요약. */
  getTradeStats(): TradeStats {
    return summarizeTrades(this.trades);
  }

  /**
   * [v0.9.1] 오늘의 매매 리포트 — 오늘 청산된 '실제 체결'만 모아 요약한다.
   *   집계 규칙은 lib/report.ts(순수 함수)에 있어 PC·폰이 똑같이 계산한다.
   */
  todayReport(): Promise<DailyReport> {
    return this.report("today");
  }

  /**
   * [v0.9.2] 기간별 매매 리포트 — 오늘 / 최근 7일 / 최근 30일 / 고른 날짜.
   *   @param kind   기간 종류
   *   @param picked "yyyy-MM-dd" (kind가 "date" 일 때)
   */
  async report(kind: PeriodKind = "today", picked?: string): Promise<DailyReport> {
    // 한국 시각 기준으로 기간을 만든다.
    const period = makePeriod(kind, Date.now(), 540, picked);

    // ① 연결돼 있으면 최신 체결을 받아와 저장본에 합친다(실패해도 그냥 넘어간다).
    let source: "live" | "cache" | "none" = "cache";
    let fetchPartial = false; // 이번 조회가 상한에 걸려 일부만 받아왔는가(정직 표시용)
    if (this.mode === "live") {
      try {
        // [v0.10.1] 수집 깊이를 '가장 깊은 최근 기간(최근 30일+매칭 버퍼)'으로 통일한다.
        //   오늘→1주일→1개월 버튼을 오가도 '한 번의 깊은 조회'로 전부 커버돼(60초 캐시 재사용),
        //   버튼마다 새로 조회해 요청 한도(429)에 걸리던 문제를 막는다. 더 과거의 특정 날짜를
        //   고른 경우엔 그만큼만 더 깊이 내려간다(min = 더 과거).
        const need = period.fromMs - 45 * 86_400_000; // 이 기간 매칭에 필요한 최소 깊이
        const commonFloor = Date.now() - 75 * 86_400_000; // 최근 30일 + 45일 버퍼 = 공통 바닥
        const { fills, fetched, partial } = await this.collectFills(Math.min(need, commonFloor));
        this.absorbFills(fills);
        fetchPartial = partial;
        // 한 번도 못 받아왔으면(회사·이동 중 등 연결 없음) '저장된 기록'으로 표시해야 한다.
        source = fetched ? "live" : "cache";
      } catch (e) {
        // 홈 PC 연결이 없거나(회사·이동 중) 조회가 막힌 경우 — **저장해 둔 기록으로 계속 간다.**
        this.addJournal({ kind: "info", symbol: "-", summary: `최신 체결 조회 실패(저장된 기록으로 표시): ${String(e).slice(0, 60)}` });
      }
    }

    // ①-B [v0.10.0] 토스 조회가 안 됐고(회사·PC 꺼짐) 로그인 상태면,
    //     클라우드에 올려 둔 매매 이력을 받아 온다 → 홈 연결 없이도 리포트가 채워진다.
    if (source !== "live" && this.syncKeyReady()) {
      try {
        await this.syncPullTrades();
      } catch {
        /* 받기 실패해도 저장본으로 계속 간다 */
      }
    }

    // ② 계좌 평균매입가(있으면 매칭 보정에 쓴다. 연결 없으면 생략)
    const avgCost: Record<string, number> = {};
    if (source === "live") {
      try {
        const h = (await getHoldings()) as { items?: Record<string, unknown>[] };
        for (const it of h.items ?? []) {
          const sym = String(it.symbol ?? "");
          const avg = Number(it.averagePurchasePrice);
          if (sym && Number.isFinite(avg)) avgCost[sym] = avg;
        }
        this.lastAvgCost = avgCost; // 다음에 연결이 없을 때도 쓰도록 기억해 둔다
        this.persistFills();
      } catch {
        /* 보유 조회 실패는 치명적이지 않다 */
      }
    }
    const costs = source === "live" ? avgCost : this.lastAvgCost;

    // ③ **저장된 매매 이력**으로 계산한다(연결 여부와 무관하게 항상 있다).
    const realized = matchFifo(this.savedFills, costs);
    if (this.savedFills.length === 0) source = "none";

    const openNow = Object.keys(costs).length;
    const rep = buildReportFromRealized(realized, period, openNow);

    // [v0.10.1] '이 기간이 실제로 잘렸을 수 있나'를 정직하게 판정(A/B 리뷰 반영).
    //   리포트는 누적 저장본(savedFills)으로 그리므로, 이번 조회가 상한에 걸렸어도(fetchPartial)
    //   저장본이 기간 시작보다 더 과거까지 덮고 있으면 빠진 게 없다. 둘 다일 때만 경고한다:
    //     ① 이번 조회가 상한에 걸렸고(fetchPartial)  ② 저장본의 가장 오래된 체결이 기간 시작보다 나중 =
    //     그 기간 앞부분을 저장본이 못 덮음 → 일부 매매가 빠졌을 수 있다.
    const oldestSaved = this.savedFills.length ? Math.min(...this.savedFills.map((f) => f.atMs)) : Number.POSITIVE_INFINITY;
    const truncated = fetchPartial && oldestSaved > period.fromMs;

    return {
      ...rep,
      source,
      lastSyncMs: this.fillsSyncedAtMs,
      savedTotal: realized.length, // 기간과 무관하게 저장된 '매도' 총 건수
      truncated, // [v0.10.1] 이 기간 일부가 빠졌을 수 있으면 true → 화면이 경고를 띄운다
    };
  }

  /**
   * [v0.19.0] tradeAnalysis — 실제 체결이력으로 '매매 사이클'(진입→청산)을 자동 추적하고 분석한다.
   *   · 저장된 체결(savedFills)을 선입선출로 매칭 → 매도 건별 [진입가·청산가·수량·보유기간·수익률·손익·승패].
   *   · Capri로 주문해 근거가 남은 매매엔 [기법·진입 체결강도]를 붙인다(외부 주문은 '기록 없음').
   *   · "강할 때 산 매매 vs 약할 때" 인사이트까지. 실주문/DRY_RUN 무관 — 실제 체결이 있으면 잡힌다.
   *   ⚠️ 읽기 전용(주문 발사 없음).
   */
  async tradeAnalysis(): Promise<{ cycles: TradeCycle[]; insights: TradeInsights; source: "live" | "cache" | "none" }> {
    // 리포트와 같은 방식으로 최신 체결을 저장본에 합친다(연결 없으면 저장본만).
    let source: "live" | "cache" | "none" = "cache";
    if (this.mode === "live") {
      try {
        // [v0.19.0 · 리뷰 MEDIUM] 리포트와 같은 75일 바닥으로 조회 → 60초 캐시를 공유(429 폭풍/캐시 무력화 방지).
        //   더 옛 매매는 이미 저장본(savedFills, 2년치 누적)에 있으므로 라이브는 최근만 top-up 하면 된다.
        const need = Date.now() - 75 * 86_400_000;
        const { fills, fetched } = await this.collectFills(need);
        this.absorbFills(fills);
        source = fetched ? "live" : "cache";
      } catch {
        /* 연결 없으면 저장본으로 */
      }
    }
    if (source !== "live" && this.syncKeyReady()) {
      try { await this.syncPullTrades(); } catch { /* 실패해도 저장본으로 */ }
    }
    const realized = matchFifo(this.savedFills, this.lastAvgCost);
    if (this.savedFills.length === 0) source = "none";

    // 진입정보 붙이기 — [v0.19.0 · 리뷰 HIGH] 오염 방지를 위해 엄격하게:
    //   ① **실거래(real) 기록만** 쓴다. DRY_RUN/연습(mock) 스냅샷은 진짜 진입이 아니므로 인사이트를 좌우하면 안 됨.
    //      → 실주문을 카프리로 내기 전엔 진입강도/기법이 안 붙는다(정직: 사이클·손익은 그대로, 강/약 비교만 비활성).
    //   ② **1:1 소비**: 한 체결강도/근거 기록은 사이클 하나에만 매칭(중복 카운트로 강/약 표본이 부풀지 않게).
    const near = (a: number, b: number) => b > 0 && Math.abs(a - b) / b < 0.005; // 0.5% 이내면 같은 진입으로 봄
    const realTrades = this.trades.filter((t) => t.mode === "real");
    const realRationales = this.rationales.filter((x) => x.dryRun !== true);
    const usedTrade = new Set<string>();
    const usedRat = new Set<string>();
    // 최신 청산이 위로 오도록 먼저 정렬한 뒤, 그 순서대로 1:1 매칭한다.
    const realizedSorted = [...realized].sort((a, b) => b.sellAtMs - a.sellAtMs);
    const enrichMap = new Map<RealizedTrade, { technique?: string; entryStrength: number | null; exitStrength: number | null }>();
    for (const r of realizedSorted) {
      const st = realTrades.find((t) => !usedTrade.has(t.id) && t.symbol === r.symbol && Number.isFinite(t.entryPrice) && near(t.entryPrice, r.buyAvg));
      const rat = realRationales.find((x) => !usedRat.has(x.clientOrderId) && x.symbol === r.symbol && x.entry != null && near(x.entry as number, r.buyAvg));
      if (st) usedTrade.add(st.id);
      if (rat) usedRat.add(rat.clientOrderId);
      // [v0.22.0] 진입/청산 체결강도: ① 주문 순간 스냅샷(있으면 우선) ② 없으면 자동 저장 시계열을
      //   진입·청산 '시각'으로 조회(strengthAt). ②가 조건주문 자동청산·다진입까지 견고하게 커버한다.
      const entryStrength = st?.entry?.strength ?? this.strengthAt(r.symbol, r.buyAtMs);
      const exitStrength = st?.exit?.strength ?? this.strengthAt(r.symbol, r.sellAtMs);
      const technique = rat?.technique;
      if (entryStrength != null || exitStrength != null || technique != null) enrichMap.set(r, { technique, entryStrength, exitStrength });
    }
    const enrich = (r: RealizedTrade) => enrichMap.get(r);

    const cycles = buildCycles(realizedSorted, enrich); // 이미 최신순 정렬됨
    const insights = analyzeTrades(cycles);
    return { cycles, insights, source };
  }

  /**
   * [v0.64.0 — 오너 실사용 보고 "매매기록 탭들이 실제 매매기록과 완벽하게 일치하지 않는다"]
   *   "자동매매기록"·"📑 자동매매 리포트"·"매매연구" 탭은 엔진이 사건(체결 확인·조건주문
   *   등록·발동)마다 스스로 적어 두는 부기(autoTradeHistory)를 보여준다 — "📊 매매 리포트"
   *   탭처럼 토스 '종료된 주문'에서 매번 다시 계산하는 게 아니다. 그래서 체결 확인을
   *   놓치거나(앱 재시작), 조건주문이 토스에서 사라지거나(v0.60.2), 보호주문 등록이
   *   실패하거나(v0.57.0/v0.62.0) 하면 이 부기가 실제 계좌 상태와 어긋날 수 있는데, 부기는
   *   자기 기록만 보므로 스스로는 어긋난 걸 알아챌 방법이 없다.
   *
   *   이 메서드는 report()/tradeAnalysis()와 똑같은 방식으로 토스 '종료된 주문'을 모아
   *   (collectFills+matchFifo) 실제 체결 매칭 결과를 만든 뒤, autoTradeHistory의 각 기록을
   *   lib/history-reconcile.ts(순수 함수)로 대조한다. 읽기 전용(주문 발사 없음) — 기존 기록을
   *   덮어쓰지 않고, 대조 결과만 별도로 돌려준다(화면이 "✅ 일치/⚠️ 불일치/❓ 확인 안 됨"
   *   배지로 보여준다). 연결이 없으면(모의/웹) 빈 결과를 돌려준다 — 확인 못 한 걸 "일치"로
   *   거짓 보고하지 않는다.
   */
  async reconcileAutoHistory(): Promise<{ results: Record<string, HistoryReconcileResult>; source: "live" | "cache" | "none" }> {
    let source: "live" | "cache" | "none" = "cache";
    if (this.mode === "live") {
      try {
        const need = Date.now() - 75 * 86_400_000; // report()/tradeAnalysis()와 같은 바닥(캐시 공유)
        const { fills, fetched } = await this.collectFills(need);
        this.absorbFills(fills);
        source = fetched ? "live" : "cache";
      } catch {
        /* 연결 없으면 저장본으로 */
      }
    }
    if (source !== "live" && this.syncKeyReady()) {
      try { await this.syncPullTrades(); } catch { /* 실패해도 저장본으로 */ }
    }
    if (this.savedFills.length === 0) source = "none";
    const realized = matchFifo(this.savedFills, this.lastAvgCost);

    const results: Record<string, HistoryReconcileResult> = {};
    for (const h of this.autoTradeHistory) {
      const enteredAtMs = enteredAtMsFromId(h.id);
      if (enteredAtMs == null) continue; // 형식이 깨진 옛 기록은 건너뜀(대조 불가)
      results[h.id] = reconcileHistoryEntry({ id: h.id, symbol: h.symbol, enteredAtMs, status: h.status, pnlUsd: h.pnlUsd, pnlPct: h.pnlPct }, realized);
    }
    return { results, source };
  }

  /**
   * [v0.9.6] collectFills — 토스 '종료된 주문'을 페이지 넘겨 모아 체결 목록으로 바꾼다.
   *   @param sinceMs 이 시각보다 오래된 체결이 나오면 그만 가져온다(무한정 안 부르게).
   */
  private async collectFills(sinceMs: number): Promise<{ fills: Fill[]; partial: boolean; fetched: boolean }> {
    // ① 최근에 모아 둔 게 있으면 그대로 쓴다(60초).
    //   [왜?] 기간 버튼(오늘/1주일/1개월)을 누를 때마다 수십 번 호출하면
    //   토스가 "요청 한도 초과(429)"로 막아 **리포트가 통째로 비어 버린다**(실제로 그랬다).
    //   [v0.10.1] 재사용 판단은 순수함수 shouldReuseCache 에 위임한다(A/B 리뷰가 잡은 회귀 반영):
    //   더 깊이 필요하고 캐시가 더 깊이 갈 수 있을 때만 재조회하고, 그 밖에는 60초간 재사용해
    //   잦은 매매자/오프라인에서 요청 한도(429) 난타가 나지 않게 한다.
    if (this.fillsCache && shouldReuseCache(this.fillsCache, sinceMs, Date.now())) {
      // [주의] 실패했던 결과를 '성공'으로 돌려주면 안 된다.
      //   그러면 연결이 끊긴 상태인데도 화면에 "최신"이라고 표시된다(실제로 그랬다).
      return { fills: this.fillsCache.fills, partial: this.fillsCache.partial, fetched: this.fillsCache.fetched };
    }

    const fills: Fill[] = [];
    let cursor: string | null | undefined = undefined;
    let partial = false; //  중간에 막혀서 일부만 가져왔는가
    let fetched = false; //  한 페이지라도 실제로 받아왔는가(연결 여부 판단용)
    let oldestSeen = Number.POSITIVE_INFINITY; // 이번 수집에서 본 가장 오래된 체결 시각
    let reachedEnd = false; //   더 받을 페이지가 없어 끝까지 다 받았다
    let reachedTarget = false; // 요청한 sinceMs 깊이에 도달했다

    // [v0.10.1] 페이지 상한을 8 → 40 으로 크게 올린다.
    //   진짜 멈춤 조건은 "sinceMs 깊이 도달"이고, 이 상한은 폭주 방지용 안전장치일 뿐이다.
    //   매매가 잦은 사람도 30일치가 160건(8페이지)을 훌쩍 넘길 수 있어, 그 경우 옛 매매가
    //   조용히 빠지던 것이 정확도 문제의 핵심이었다. 40페이지면 약 800건까지 커버한다.
    //   페이지 사이 250ms 간격 + 60초 캐시가 있어 요청 한도(429)에 걸릴 위험은 낮다.
    const MAX_PAGES = 40;
    let page = 0;
    for (; page < MAX_PAGES; page++) {
      let res: Awaited<ReturnType<typeof listOrdersRaw>>;
      try {
        res = await listOrdersRaw({ status: "CLOSED", ...(cursor ? { cursor } : {}) } as { status: string });
      } catch (e) {
        // ② 한도 초과 등으로 막히면 **지금까지 모은 것으로 계속 간다**(전체를 버리지 않는다).
        partial = true;
        this.addJournal({
          kind: "info",
          symbol: "-",
          summary: `체결내역 ${page}페이지까지만 조회됨(${String(e).includes("429") ? "토스 요청 한도" : "조회 오류"})`,
        });
        break;
      }

      fetched = true; // 여기까지 왔으면 토스와 실제로 통신됐다
      let oldest = Number.POSITIVE_INFINITY;
      for (const o of res.orders) {
        const ex = (o.execution ?? {}) as Record<string, unknown>;
        const qty = Number(ex.filledQuantity);
        const price = Number(ex.averageFilledPrice);
        const at = Date.parse(String(ex.filledAt ?? o.orderedAt ?? ""));
        if (!(qty > 0) || !Number.isFinite(price) || !Number.isFinite(at)) continue; // 취소·미체결 제외
        const side = String(o.side ?? o.orderSide ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
        fills.push({
          symbol: String(o.symbol ?? ""),
          side,
          qty,
          price,
          atMs: at,
          commission: Number(ex.commission) || 0,
          tax: Number(ex.tax) || 0,
          currency: String(o.currency ?? "USD"),
        });
        oldest = Math.min(oldest, at);
      }
      oldestSeen = Math.min(oldestSeen, oldest);

      cursor = res.nextCursor;
      if (!res.hasNext || !cursor) { reachedEnd = true; break; } // 끝까지 다 받았다
      if (Number.isFinite(oldest) && oldest < sinceMs) { reachedTarget = true; break; } // 필요한 기간까지 다 왔다

      // ③ 다음 페이지 전에 잠깐 쉰다(연속 호출로 한도에 걸리지 않게).
      await new Promise((r) => setTimeout(r, 250));
    }

    // [v0.10.1] 안전 상한(MAX_PAGES)까지 다 돌았는데도 목표·끝에 못 닿았으면 = 아직 더 옛 매매가 남았다.
    //   '일부만 가져옴(partial)'으로 표시한다. 단, 리포트는 '저장된 누적 이력(savedFills)'에서 그리므로
    //   실제로 그 기간이 빠지는지는 report()에서 저장본 커버리지까지 함께 보고 판정한다(여기선 단정하지 않음).
    if (fetched && !reachedEnd && !reachedTarget && page >= MAX_PAGES) {
      partial = true;
      this.addJournal({
        kind: "info",
        symbol: "-",
        summary: `체결내역이 매우 많아 이번엔 최근 ${MAX_PAGES}페이지까지 조회했습니다(저장된 기록은 그대로 유지됩니다)`,
      });
    }

    // 이번 수집이 '어느 시각까지' 확실히 커버했는지(순수 계산). 다음 요청이 더 깊으면 재수집을 유도한다.
    const covered = coveredSince({ reachedEnd, reachedTarget, sinceMs, oldestSeenMs: oldestSeen });
    // canDeepen: 목표 깊이에 닿아 '일찍 멈춘'(reachedTarget) 경우에만 재조회로 더 얻을 수 있다.
    //   끝까지 받았거나(reachedEnd)·상한에 걸렸거나(capped)·실패했으면 60초 안엔 더 못 얻으므로 false.
    const canDeepen = reachedTarget;
    // 실패(한 페이지도 못 받음)한 경우에는 짧게만 기억한다 — 연결이 돌아오면 곧 다시 시도하도록.
    this.fillsCache = { fills, atMs: fetched ? Date.now() : Date.now() - 50_000, partial, fetched, coveredSinceMs: covered, canDeepen };
    return { fills, partial, fetched };
  }



  /**
   * closeTradeManual — 토스 서버가 처리한 OCO/OTO 익절·손절은 앱이 관측 못 하므로,
   *   사용자가 분석 화면에서 확정가·구분(tp/sl/manual)을 넣어 트레이드를 수동 마감한다.
   */
  async closeTradeManual(id: string, exitPrice: number, kind: "tp" | "sl" | "manual"): Promise<StrengthTrade[]> {
    const t = this.trades.find((x) => x.id === id);
    if (t && t.outcome == null) {
      const snap = await this.snapshotStrength(t.symbol);
      const now = DateTime.now().setZone("Asia/Seoul");
      t.exitTs = now.toFormat("MM-dd HH:mm:ss");
      t.exitAtMs = now.toMillis(); // [v0.9.2] 기간 조회용 정확한 시각
      t.exitPrice = exitPrice;
      t.exit = snap;
      t.exitKind = kind;
      t.resultPct = Number.isFinite(exitPrice) && t.entryPrice ? Math.round(((exitPrice - t.entryPrice) / t.entryPrice) * 10000) / 100 : null;
      t.outcome = t.resultPct == null ? null : t.resultPct > 0 ? "win" : "loss";
      this.persistTrades();
      this.emit("trades", this.getTradeLog());
    }
    return this.getTradeLog();
  }

  /** 트레이드 한 건 삭제(잘못 기록된 것 정리용). */
  deleteTrade(id: string): StrengthTrade[] {
    this.trades = this.trades.filter((t) => t.id !== id);
    this.persistTrades();
    this.emit("trades", this.getTradeLog());
    return this.getTradeLog();
  }

  // --------------------------------------------------------------------------
  // [v0.6.0] 종목 스크리너(탐색) — 거래량 상위 60종목 온디맨드 스캔
  //   ⚠️ 읽기 전용(랭킹·캔들 조회만). 주문 로직과 완전히 분리. [스캔] 버튼으로만 실행.
  // --------------------------------------------------------------------------

  /**
   * scanScreener — 거래량 상위 종목을 훑어 조건 만족 후보를 찾는다.
   *   진행 상황은 "screener:progress" 이벤트로 화면에 실시간 전달하고, 최종 결과는 반환한다.
   *   [v0.11.0] 옵션 객체로 바뀜 — 몸통비율뿐 아니라 스캔 종목수·가격대(하한/상한)를 사용자가 조절.
   *   @param opts { bodyRatio(0.1~0.8), count(10~200), priceMin($), priceMax($) } — 전부 선택(기본값 있음).
   */
  async scanScreener(opts: ScreenOpts = {}): Promise<ScreenRun> {
    if (this.screenBusy) throw new Error("이미 스캔이 진행 중입니다. 끝날 때까지 기다려 주세요.");
    this.assertNotSystemPaused("스크리닝"); // [v0.44.0] 수동 스크리너 + 자동매매 스캔 공용 경로
    this.screenBusy = true;
    this.screenCancelRequested = false; // [v0.43.0] 새 스캔 시작 — 이전 취소 요청 잔재 제거
    // [v0.28.0] 상한 0.5→0.8로 확대(오너 지시) — 자동매매용 스크리너 화면에서 더 깐깐하지 않은
    //   (몸통이 커도 도지로 인정하는) 완화된 조건까지 선택할 수 있게 한다.
    const br = Math.min(0.8, Math.max(0.1, opts.bodyRatio ?? 0.3)); // 0.1~0.8로 안전 보정
    const count = Math.min(200, Math.max(10, Math.round(opts.count ?? 60))); // 10~200으로 안전 보정
    // 가격대: 하한이 상한보다 크면 자동 교정(사용자 실수 방어). 음수는 0으로.
    let priceMin = Math.max(0, opts.priceMin ?? 1);
    let priceMax = Math.max(0, opts.priceMax ?? 9);
    if (priceMin > priceMax) [priceMin, priceMax] = [priceMax, priceMin];
    // [v0.33.0 — 스크리닝 기준 탭] 나머지 조건도 전부 안전 보정. 아무것도 안 주면(메뉴얼
    //   스크리너처럼) 지금까지의 고정 동작과 완전히 같은 기본값이라 회귀가 없다.
    const emaTrendEnabled = opts.emaTrendEnabled ?? true;
    const emaPeriod = Math.min(300, Math.max(50, Math.round(opts.emaPeriod ?? 200)));
    const cloudEnabled = opts.cloudEnabled ?? true;
    const dojiWickMinRatio = Math.min(0.4, Math.max(0, opts.dojiWickMinRatio ?? WICK_MIN_RATIO));
    const dojiMaxAgeEnabled = opts.dojiMaxAgeEnabled ?? true;
    const dojiMaxAgeMinutes = Math.min(180, Math.max(10, Math.round(opts.dojiMaxAgeMinutes ?? DOJI_MAX_AGE_MINUTES)));
    const dojiMaxGapEnabled = opts.dojiMaxGapEnabled ?? true;
    const dojiMaxGapMinutes = Math.min(240, Math.max(5, Math.round(opts.dojiMaxGapMinutes ?? 30)));
    // [v0.63.0] 방어 필터(③④) — 안 넘기면 전부 꺼짐(과거 호출 호환)
    const defense = {
      emaMinGapEnabled: opts.emaMinGapEnabled ?? false,
      emaMinGapPct: Math.min(50, Math.max(0.5, opts.emaMinGapPct ?? 6)),
      emaSlopeEnabled: opts.emaSlopeEnabled ?? false,
      atrFilterEnabled: opts.atrFilterEnabled ?? false,
      atrMaxPct: Math.min(20, Math.max(0.5, opts.atrMaxPct ?? 3)),
    };
    const nextCandleConfirmEnabled = opts.nextCandleConfirmEnabled ?? true;
    const excludeEtf = opts.excludeEtf ?? true;
    try {
      await this.prepareBackend();

      // 1) 거래량 랭킹으로 스캔 대상 종목 확보
      this.emit("screener:progress", { phase: "ranking", done: 0, total: count, symbol: "" } as ScreenProgress);
      // [v0.61.4] 폰이 "지금 PC가 스캔 중"임을 바로 알 수 있게 — 시작 신호는 쓰로틀 없이 즉시 올린다.
      this.pushScanProgress({ phase: "ranking", done: 0, total: count, symbol: "", running: true, startedAtMs: Date.now() });
      const ranked = await getRankings(count);

      // 1-b) [v0.6.3] ETF·레버리지·인버스 배제 — 종목 메타(securityType)를 한 번에 조회해 걸러낸다.
      //   securityType이 "STOCK"인 일반 주식만 남긴다(ETF/ETN 등은 전부 제외). 메타 조회가 실패하면
      //   (안전하게) 전부 통과시킨다 — 필터 때문에 스캔 자체가 막히지 않도록.
      //   [v0.33.0] excludeEtf=false면 이 단계 자체를 건너뛴다(오너가 명시적으로 끈 경우).
      let rankings = ranked;
      let excludedEtf = 0;
      if (excludeEtf) {
        try {
          const metas = await getStocks(ranked.map((r) => r.symbol));
          const typeBySym = new Map(metas.map((m) => [m.symbol, m]));
          rankings = ranked.filter((r) => {
            const m = typeBySym.get(r.symbol);
            if (!m) return true; // 메타 없으면 통과(정보 부족을 이유로 배제하지 않음)
            const isStock = m.securityType === "STOCK"; // ETF/ETN 등은 제외
            if (!isStock) excludedEtf++;
            return isStock;
          });
        } catch {
          /* 메타 조회 실패 → 필터 생략(스캔은 계속) */
        }
      }
      const total = rankings.length;

      // 2) 현재 활성 장의 시작 시각(최고점 추적 기준). 장 마감 중이면 최근 8시간으로 폴백.
      const now = DateTime.now().setZone("Asia/Seoul");
      const sessionStart = getSessionStart(now);
      const sessionStartMs = sessionStart ? sessionStart.toMillis() : now.toMillis() - 8 * 3600_000;

      const results: ScreenResult[] = [];
      let done = 0;
      for (const rk of rankings) {
        // [v0.43.0] 종목마다(=네트워크 요청 하나씩) 확인 — 취소 요청이 있으면 다음 종목으로
        //   넘어가지 않고 여기서 멈춘다. 이미 처리하던 종목 하나는 끝까지 기다린 뒤 멈추므로
        //   "즉시 중단"은 아니지만, 종목당 몇 초 단위라 체감상 충분히 빠르게 멎는다.
        if (this.screenCancelRequested) {
          throw new Error("오너 요청으로 스크리닝을 취소했습니다.");
        }
        this.emit("screener:progress", { phase: "scanning", done, total, symbol: rk.symbol } as ScreenProgress);
        this.pushScanProgress({ phase: "scanning", done, total, symbol: rk.symbol, running: true, startedAtMs: this.scanProgressForMirror?.startedAtMs ?? Date.now() });
        try {
          // 1분봉을 과거로 당겨 확보한다.
          //   EMA200 에는 **완성된** 5분봉 200개(=1분봉 1000개)가 필요하다.
          //   그런데 바로 아래에서 '형성 중인 마지막 봉'을 하나 버리므로, 딱 1000개만 받으면
          //   199개가 되어 **멀쩡한 종목이 '데이터 부족'으로 튕기는** 일이 생긴다.
          //   (지금 시각이 5분 경계인지에 따라 됐다 안 됐다 해서 발견하기 어려웠다)
          //   그래서 여유분을 더 받는다.
          // [v0.69.0 — 오너 질문 "오늘 매매가 1건뿐인데 기준이 빡세졌나?"] 실제 스캔 기록을 보니 상위 54종목 중 36개가 가격대(~9) 밖이었다
          //   (거래량 순위 상위는 고가 종목이 많다). 어차피 탈락할 종목의 캔들을 종목당 6번씩 받느라 스캔 종목 수를 못 늘렸다 — 순위 목록에 있는
          //   현재가가 가격대에서 10% 이상 벗어난 종목은 캔들 조회 없이 "가격대 밖"으로 바로 처리한다(경계 근처는 그대로 정밀 판정). 그만큼 스캔
          //   종목 수를 크게 늘려도(예: 150~200) 요청 부담이 거의 늘지 않는다. 판정 결과는 예전과 동일(가격대 밖 → none).
          if (Number.isFinite(rk.lastPrice) && (rk.lastPrice < priceMin * 0.9 || rk.lastPrice > priceMax * 1.1)) {
            results.push({ ...this.insufficientResult(rk, 0, 0, priceMin, priceMax), status: "none", note: "가격대 밖(캔들 조회 생략)" });
            done++;
            continue;
          }
          const oneMin = await this.getCandles1mCached(rk.symbol); // [v0.65.0] 자동매매 스캔·매매연구소가 같은 1분봉을 2분간 공유(API 부하 절감)
          // [v0.6.2] 형성 중(미완성)인 마지막 5분봉은 판정에서 제외한다(완성된 봉만 사용).
          //   진행 중 봉으로 판정하면 봉 마감 후 음↔양이 뒤집혀 오판정이 난다(특히 HA).
          const raw5m: Candle[] = dropIncompleteBucket(aggregate1mTo5m(oneMin), now.toMillis());
          // 데이터 부족(EMA200 불가 = 완성된 5분봉 200개 미만)이면 건너뛴다
          if (raw5m.length < 200) {
            results.push(this.insufficientResult(rk, oneMin.length, raw5m.length, priceMin, priceMax));
            done++;
            continue;
          }

          // [v0.6.1] 도지·음봉·세션최고점·EMA200·이치모쿠를 '하이킨아시' 기준으로(사용자 차트와 일치).
          //   [v0.6.2] 위에서 미완성 봉을 뺀 '완성된' 5분봉만 HA로 변환 → 트리거 도지·다음 확정봉이 모두 완성봉.
          const candles5m = toHeikinAshi(raw5m); // 판정에 쓰는 캔들(HA, 완성봉만)
          const closes = candles5m.map((c) => c.close);

          const price = Number.isFinite(rk.lastPrice) ? rk.lastPrice : raw5m[raw5m.length - 1].close;
          const priceInBand = inPriceBand(price, priceMin, priceMax); // [v0.11.0] 사용자 지정 가격대
          const ema200 = ema(closes, emaPeriod); // [v0.33.0] 기간(기본 200) 조절 가능
          const cloud = ichimoku(candles5m);
          // [v0.25.0] now.toMillis()를 넘겨 "너무 오래된 도지"(기본 20분 초과)는 scanSessionPattern이
          //   스스로 status를 none으로 강제하게 한다(실 매매엔 불확실한 과거 데이터라는 오너 지적 반영).
          // [v0.33.0] 신선도 검사를 꺼 두면(dojiMaxAgeEnabled=false) 한도를 사실상 무한대로 줘서
          //   "너무 오래됐다"는 판정 자체가 절대 나오지 않게 한다(indicators.ts 쪽 로직은 안 건드림).
          // [v0.51.0 긴급 수정] nextCandleConfirmEnabled를 이제 여기서 직접 넘긴다 — 예전엔 이 값을
          //   안 넘겨서(항상 true로 동작) "다음봉 확인"을 꺼도 스캔 타이밍에 따라 여전히 탈락하는
          //   일이 있었다(자세한 이유는 scanSessionPattern 문서 참고 — 오너가 "필터를 꺼도 계속
          //   적용되는 것 같다"고 보고한 것의 실제 원인 중 하나).
          const pat = scanSessionPattern(
            candles5m,
            sessionStartMs,
            br,
            dojiWickMinRatio,
            now.toMillis(),
            dojiMaxAgeEnabled ? dojiMaxAgeMinutes : Number.POSITIVE_INFINITY,
            nextCandleConfirmEnabled,
            // [v0.62.1] 도지가 최고점 한참 뒤에 생긴 경우(RUBI 05:00 고점→08:55 도지) 배제
            dojiMaxGapEnabled ? dojiMaxGapMinutes : Number.POSITIVE_INFINITY,
          ); // HA 캔들로 패턴 판정

          // 화면에 보여줄 값(aboveEma/aboveCloud)은 실제 비교 결과 그대로 — 조건을 꺼도 "지표상
          // 실제로 위인지"는 정직하게 보여주고, 게이트로 쓸지만 별도로 결정한다.
          const aboveEma = ema200 != null && price > ema200;
          const aboveCloud = cloud != null && price > cloud.cloudTop;
          const emaGateOk = !emaTrendEnabled || aboveEma;
          const cloudGateOk = !cloudEnabled || aboveCloud;
          const gatedStatus = applyScreenGates(pat.status, { priceInBand, emaGateOk, cloudGateOk, nextCandleConfirmEnabled });
          // [v0.63.0 ②③④] 진입 시점 측정값 — 이격도는 삼분할 계산과 같은 "전봉종가"(원본 5분봉) 기준,
          //   ATR%는 원본 캔들(하이킨아시는 변동폭을 줄여 보이게 함), EMA 기울기는 판정과 같은 HA 종가 EMA.
          const prevCloseRaw = raw5m.length ? raw5m[raw5m.length - 1].close : null;
          const entryMetrics: EntryMetrics = {
            emaGapPct: emaGapPct(prevCloseRaw, ema200),
            atrPct: atrPct(raw5m),
            emaSlopePct: emaSlopePct(closes, emaPeriod),
          };
          const defenseEval = evaluateDefenseFilters(entryMetrics, defense);
          // 패턴이 후보(확정·관찰)인데 방어 필터에서 떨어지면 후보에서 뺀다(사유는 defenseReasons로 남겨 화면·통계에 표시).
          const statusAfterDefense = gatedStatus !== "none" && !defenseEval.ok ? "none" : gatedStatus;
          const proximityPct = pat.sessionHigh && Number.isFinite(price) ? ((price - pat.sessionHigh) / pat.sessionHigh) * 100 : null;
          // [v0.36.0] 워런트 의심 확인 — 확정/관찰 후보만(API 호출 절약, 어차피 나머지는 진입
          //   대상이 아니라 확인할 의미가 없다).
          // [v0.70.0 — 오너 지시 2026-10-09 "현재가보다 낮은 가격에 워런트 잡혀있을경우 워런트로
          //   종목선정 탈락"] v0.37.0까지는 추측 방식의 불확실성 때문에 코멘트만 붙이고 막지
          //   않았는데, 오너가 실사용 후 다시 명시적으로 차단을 요청해 이제는 applyWarrantGate가
          //   실제로 후보에서 뺀다(status→"none"). 코멘트(warrantWarning)는 그대로 남겨 두어
          //   missReasons/tallyMissReasons(App.tsx)가 "왜 탈락했는지"를 계속 보여줄 수 있게 한다.
          const warrantWarning =
            statusAfterDefense === "confirmed" || statusAfterDefense === "watch"
              ? await this.checkWarrantWarning(rk.symbol, price)
              : null;
          const status = applyWarrantGate(statusAfterDefense, warrantWarning);

          results.push({
            rank: rk.rank,
            symbol: rk.symbol,
            price,
            ema200,
            // [v0.16.0] 전봉종가 = 마지막으로 '완성된' 5분봉의 실제 종가. 탐색→계산기 자동입력에 쓴다.
            prevClose: raw5m.length ? raw5m[raw5m.length - 1].close : null,
            cloudTop: cloud?.cloudTop ?? null,
            priceInBand,
            aboveEma,
            aboveCloud,
            status,
            sessionHigh: pat.sessionHigh,
            proximityPct,
            n1m: oneMin.length,
            n5m: candles5m.length,
            evidence: this.buildEvidence(sessionStart, pat, { priceInBand, aboveEma, aboveCloud }),
            warrantWarning,
            entryMetrics, // [v0.63.0]
            defenseReasons: defenseEval.reasons,
          });
        } catch (err) {
          // 한 종목 실패가 전체 스캔을 죽이지 않게(개별 오류는 '데이터 부족'류로 표시)
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ ...this.insufficientResult(rk, 0, 0, priceMin, priceMax), note: `오류: ${msg}` });
        }
        done++;
      }

      this.emit("screener:progress", { phase: "done", done, total, symbol: "" } as ScreenProgress);
      // [v0.61.4] 완료 신호도 쓰로틀 없이 즉시 — 게이지가 꽉 찬 채로 안 멈추고 바로 사라지게.
      this.pushScanProgress({ phase: "done", done, total, symbol: "", running: false, startedAtMs: this.scanProgressForMirror?.startedAtMs ?? Date.now() });
      // 정렬: 확정(🔴) → 관찰(🟡) → 나머지. 같은 등급이면 랭킹 순.
      const order: Record<ScreenStatus, number> = { confirmed: 0, watch: 1, none: 2, insufficient: 3 };
      results.sort((a, b) => order[a.status] - order[b.status] || a.rank - b.rank);
      return {
        scannedAt: now.toFormat("MM-dd HH:mm:ss"),
        total,
        bodyRatio: br,
        priceMin,
        priceMax,
        excludedEtf,
        results,
        // [v0.47.0] 이번 스캔에 실제로 쓰인 나머지 기준값 — 화면이 "그때 뭐가 켜져 있었는지" 정확히 보여줄 수 있게.
        emaTrendEnabled,
        emaPeriod,
        cloudEnabled,
        dojiWickMinRatio,
        dojiMaxAgeEnabled,
        dojiMaxAgeMinutes,
        dojiMaxGapEnabled,
        dojiMaxGapMinutes,
        ...defense, // [v0.63.0] 이번 스캔에 실제로 쓰인 방어 필터 값
        nextCandleConfirmEnabled,
        excludeEtf,
      };
    } finally {
      this.screenBusy = false;
      // [v0.61.4] 취소·오류로 "done" 신호 없이 끝난 경우(위 try 블록 중간에 throw)도, 게이지가
      //   "진행 중"에 영원히 멈춰 있지 않도록 여기서 반드시 running:false로 마감한다.
      if (this.scanProgressForMirror?.running) {
        this.pushScanProgress({ ...this.scanProgressForMirror, running: false });
      }
    }
  }

  /**
   * [v0.43.0] 진행 중인 스크리닝 스캔을 취소한다(수동 스크리너·자동매매 5분 사이클 스캔 공용 —
   *  어차피 한 번에 하나만 돈다). 스캔 중이 아니면 조용히 "취소할 게 없다"고만 알린다. 즉시
   *  멈추는 게 아니라 "협조적 취소"라 지금 조회 중인 종목 하나는 끝까지 기다렸다가 멈춘다.
   */
  cancelScreenerScan(): { ok: boolean; message: string } {
    if (!this.screenBusy) return { ok: false, message: "지금 진행 중인 스크리닝이 없습니다." };
    this.screenCancelRequested = true;
    return { ok: true, message: "스크리닝 취소를 요청했습니다 — 지금 확인 중인 종목까지만 마치고 곧 멈춥니다." };
  }

  /**
   * [v0.36.0→v0.70.0] 워런트 의심 확인 — 흔한 접미사(W/.WS/-WT/WS)로 워런트 티커를 추측해
   *   실제로 시세가 있는지 조회하고, 있으면서 그 가격이 본주 현재가보다 낮으면 문구를 만든다.
   *   [v0.70.0] 호출부(scanScreener)가 이제 이 문구를 applyWarrantGate로 넘겨 실제 탈락
   *   처리까지 한다(예전엔 코멘트만 — lib/warrant.ts 상단 이력 참고) — 그래서 문구도 "확인
   *   필요"가 아니라 "탈락(제외)" 사실을 그대로 전달하도록 바꿨다. 추측이 틀릴 수 있다는
   *   한계는 여전하다. 실패(시세 없음)는 그냥 "워런트 없음/확인 안 됨"으로 조용히 넘어간다
   *   (에러 아님).
   */
  private async checkWarrantWarning(symbol: string, price: number): Promise<string | null> {
    if (!Number.isFinite(price)) return null;
    for (const guess of guessWarrantTickers(symbol)) {
      try {
        const wp = await getPrice(guess);
        if (Number.isFinite(wp.price) && wp.price < price) {
          return `⚠️ 워런트 탈락: ${guess} 시세가 $${wp.price}로 본주 현재가($${price})보다 낮아 종목선정에서 제외했습니다(추측 기반 — 실제 연계 워런트가 아닐 수도 있습니다. 확인해 보시고 오탐이면 알려주세요).`;
        }
        return null; // 워런트로 보이는 티커는 찾았지만 가격이 본주보다 낮지 않음 → 탈락 아님
      } catch {
        // 이 추측은 실존하는 종목이 아님 — 다음 추측 시도
      }
    }
    return null; // 어떤 추측도 안 맞음 — 워런트 없음/확인 불가(경고 없음)
  }

  /**
   * 데이터 부족(저유동성 등) 결과 한 줄을 만든다.
   * [묵혀뒀던 버그 수정 — 2026-09-04 작성돼 병합 안 된 채 남아있던 PR #1] priceMin/priceMax를
   *   못박지 않고 인자로 받는다 — 예전엔 항상 $1~9로 고정돼 있어, 스캔 가격대를 다르게 설정해도
   *   "데이터 부족" 종목만 엉뚱한 기준으로 판정됐다(화면에 안 보이는 값이라 티는 안 났지만,
   *   같은 스캔 안에서 종목마다 다른 기준을 쓰는 내부 불일치였다). 기본값을 안 둔 이유도 그대로
   *   유지 — 호출부가 늘어나도 컴파일 단계에서 빠뜨릴 수 없게 강제한다.
   */
  private insufficientResult(
    rk: { rank: number; symbol: string; lastPrice: number },
    n1m: number,
    n5m: number,
    priceMin: number,
    priceMax: number,
  ): ScreenResult {
    const price = Number.isFinite(rk.lastPrice) ? rk.lastPrice : null;
    return {
      rank: rk.rank,
      symbol: rk.symbol,
      price,
      ema200: null,
      cloudTop: null,
      priceInBand: inPriceBand(price, priceMin, priceMax),
      aboveEma: false,
      aboveCloud: false,
      status: "insufficient",
      sessionHigh: null,
      proximityPct: null,
      n1m,
      n5m,
      evidence: null,
      note: "데이터 부족(1분봉 부족)",
    };
  }

  /** 판정 근거(펼침용)를 만든다. 캔들은 하이킨아시 기준, 시각은 KST. */
  private buildEvidence(
    sessionStart: DateTime | null,
    pat: SessionPattern,
    gates: { priceInBand: boolean; aboveEma: boolean; aboveCloud: boolean },
  ): ScreenEvidence {
    const r = (n: number) => Math.round(n * 10000) / 10000; // 소수 4자리
    const hm = (ms: number) => DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat("HH:mm");
    const toEv = (c: Candle): EvidenceCandle => ({ time: hm(c.time), open: r(c.open), high: r(c.high), low: r(c.low), close: r(c.close), bearish: c.close < c.open });
    return {
      mode: "ha",
      sessionStart: sessionStart ? sessionStart.setZone("Asia/Seoul").toFormat("MM-dd HH:mm") : "(장 마감·최근 8h)",
      sessionHigh: pat.sessionHigh != null ? r(pat.sessionHigh) : null,
      sessionHighTime: pat.highTime != null ? hm(pat.highTime) : null,
      doji: pat.dojiCandle
        ? {
            ...toEv(pat.dojiCandle),
            bodyRatio: pat.dojiBodyRatio != null ? r(pat.dojiBodyRatio) : null,
            upperWickPct: pat.dojiUpperWickPct != null ? r(pat.dojiUpperWickPct) : null,
            lowerWickPct: pat.dojiLowerWickPct != null ? r(pat.dojiLowerWickPct) : null,
          }
        : null,
      next: pat.nextCandle ? toEv(pat.nextCandle) : null,
      filters: {
        priceBand: gates.priceInBand,
        aboveEma: gates.aboveEma,
        aboveCloud: gates.aboveCloud,
        firstDoji: pat.dojiIndex >= 0,
        bothWicks: pat.dojiUpperWickPct != null && pat.dojiLowerWickPct != null && pat.dojiUpperWickPct >= WICK_MIN_RATIO && pat.dojiLowerWickPct >= WICK_MIN_RATIO,
        nextBearish: pat.nextCandle ? pat.nextCandle.close < pat.nextCandle.open : false,
        recentDoji: !pat.tooOld,
        dojiNearHigh: !pat.tooFarFromHigh,
      },
      gapFromHighMinutes: pat.gapFromHighMinutes,
    };
  }

  /**
   * [v0.25.0] getScreenerChart — 탐색 결과 한 종목의 차트를 불러온다(온디맨드, 클릭 시에만).
   *   scanScreener가 판정할 때 쓴 것과 **완전히 같은 계산**(1분봉→5분봉→하이킨아시→EMA200·구름·
   *   세션패턴)을 그대로 재실행해 돌려준다 — 표에서 본 근거와 차트가 서로 다른 계산이면 안 되므로.
   *   ⚠️ 읽기 전용(시세·캔들 조회만). 주문과 무관. 버튼을 눌렀을 때만 호출된다(자동 폴링 없음).
   */
  async getScreenerChart(symbol: string): Promise<ScreenChart> {
    await this.prepareBackend();
    const sym = symbol.trim().toUpperCase();
    const now = DateTime.now().setZone("Asia/Seoul");
    const sessionStart = getSessionStart(now);
    const sessionStartMs = sessionStart ? sessionStart.toMillis() : now.toMillis() - 8 * 3600_000;

    const oneMin = await getCandles1mPaged(sym, 1100);
    const raw5m = dropIncompleteBucket(aggregate1mTo5m(oneMin), now.toMillis());
    if (raw5m.length === 0) throw new Error(`${sym}: 캔들 데이터를 받지 못했습니다(시장 휴장 또는 데이터 없음).`);
    const candles5m = toHeikinAshi(raw5m);
    const closes = candles5m.map((c) => c.close);
    const ema200 = ema(closes, 200);
    const cloud = ichimoku(candles5m);
    // [v0.62.1] 표(스캔)와 차트가 서로 다른 기준으로 판정되는 일이 없게, 저장된 스크리닝 기준을 그대로 쓴다
    //   (예전엔 몸통 0.3·꼬리 10%·신선도 40분 기본값 고정 → 설정을 바꾸면 표와 차트가 어긋날 수 있었다).
    const pat = scanSessionPattern(
      candles5m,
      sessionStartMs,
      this.autoScanBodyRatio,
      this.autoScanDojiWickMinRatio,
      now.toMillis(),
      this.autoScanDojiMaxAgeEnabled ? this.autoScanDojiMaxAgeMinutes : Number.POSITIVE_INFINITY,
      this.autoScanNextCandleConfirmEnabled,
      this.autoScanDojiMaxGapEnabled ? this.autoScanDojiMaxGapMinutes : Number.POSITIVE_INFINITY,
    );

    let price: number | null = null;
    try {
      price = (await getPrice(sym)).price;
    } catch {
      /* 시세 조회 실패해도 차트(과거 캔들)는 그대로 보여준다 */
    }

    const hm = (ms: number) => DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat("HH:mm");
    const MAX_CANDLES = 60; // 너무 많으면 빽빽해져 안 보인다 — 현재 세션의 최근 구간만.
    const shown = candles5m.filter((c) => c.time >= sessionStartMs).slice(-MAX_CANDLES);

    return {
      symbol: sym,
      candles: shown.map((c) => ({ time: hm(c.time), open: c.open, high: c.high, low: c.low, close: c.close })),
      ema200,
      cloudTop: cloud?.cloudTop ?? null,
      sessionHigh: pat.sessionHigh,
      sessionHighTime: pat.highTime != null ? hm(pat.highTime) : null,
      dojiTime: pat.dojiCandle ? hm(pat.dojiCandle.time) : null,
      nextTime: pat.nextCandle ? hm(pat.nextCandle.time) : null,
      price,
      patternStatus: pat.status,
    };
  }

  // ==========================================================================
  // [v0.26.0] 자동매매 — 오너가 명시적으로 켰을 때만, 이 앱이 켜져 있는 동안만 작동한다.
  //
  // [CLAUDE.md 원칙과의 관계 — 반드시 읽을 것]
  //   이 저장소의 CLAUDE.md에는 "자율 봇 아님(오너 결정) — 자동 루프·자율판단 금지"라고 적혀
  //   있다. 이 기능은 그 원칙에서 벗어나는 **오너의 명시적인 새 결정**이다(대화에서 "B(완전
  //   자동화) 진행할거야"라고 직접 지시함). CLAUDE.md는 이 결정을 반영해 함께 갱신했다.
  //   대신 아래 안전장치로 "무엇을 얼마나 자동으로 할지"는 여전히 오너가 정한다:
  //     ① 마스터 스위치(이 자체는 절대 저장 안 함 — 앱 켤 때마다 다시 켜야 함)
  //     ② 최대 종목 수·최대손실 한도·최대 투입 비율(전부 설정 탭에서 언제든 수정 가능)
  //     ③ 삼분할 매매기법의 1~2분할 중 오너가 고른 한 타점만 쓴다(공장값 1분할 — 가장
  //        얕게 눌렸을 때만, [v0.61.8] 설정 탭 "진입 타점"에서 선택 가능 — 오너 지시)
  //     ④ 신규 진입은 반드시 lib/auto-risk.ts의 canAutoEnter 게이트를 통과해야 나간다(우회 금지 —
  //        이 원칙은 CLAUDE.md의 옛 lib/risk.ts canPlaceOrder 규칙을 v2 방식으로 재구현한 것.
  //        조사해보니 실제 lib/risk.ts 파일은 이미 삭제되어 있었다 — 오너에게 보고함).
  //
  // [5분마다 무엇을 하나]
  //   ①기존 자동매매 포지션을 다시 확인한다(매수 체결→OCO 등록 완료됐는지, OCO가 익절/손절로
  //     "발동"돼 끝났는지). 끝난 자리는 즉시 빈자리가 된다("같은 5분 사이클 안에 빈자리를
  //     채운다"는 오너 지시를 만족하려면 이 확인이 스캔보다 먼저 끝나 있어야 한다).
  //   ②최대손실 한도(시드 대비 %)를 넘었으면 자동매매 자체를 끄고 끝낸다.
  //   ③빈자리가 있으면 스크리닝을 새로 돌려 "합격(confirmed)" 종목 중 지금 보유 중이 아니고
  //     이전에 같은 가격으로 이미 시도하지 않은 종목만 골라, 빈자리 수만큼 진입한다.
  //
  // [체결·발동 확인 방법 — 왜 이렇게 하나]
  //   토스 API는 실시간 알림이 없어(v0.25.1 조사 결과 재확인) 전부 "물어봐서" 안다. 매수 체결은
  //   기존 브라켓 기능(watchAndBracket)을 그대로 재사용하고, OCO(익절+손절)가 "발동"됐는지는
  //   5분 사이클마다 조건주문 단건 조회(getConditionalOrder)로 확인한다 — 이 정도 지연은
  //   "5분마다 도는 자동매매"의 취지에 맞고, 실시간성이 중요한 손절/익절 자체는 여전히
  //   토스 서버(OCO)가 즉시 처리한다(우리는 "끝났다는 사실"만 뒤늦게 확인할 뿐).
  // ==========================================================================

  /** 자동매매를 켠다. 이미 켜져 있으면 아무 일도 하지 않는다(타이머 중복 방지). */
  startAutoTrade(): AutoTradeStatus {
    if (this.autoTradeEnabled) return this.getAutoTradeStatus();
    this.autoTradeEnabled = true;
    this.autoTradeRealizedPnlUsd = 0; // "이번 실행" 누적손익만 초기화(손실한도 계산 기준)
    this.autoTradeSeedSnapshotUsd = null; // [v0.40.0] "이번 실행"의 시드를 새로 스냅샷 뜬다(resolveSeedUsd 참고)
    this.autoTradeWasPaused = false; // [v0.44.0] 이번 실행의 휴무 전환 감지를 새로 시작(지금 상태를 첫 틱이 다시 판정)
    // [v0.30.1 긴급수정] autoTradePositions/autoTradeUsedKeys는 더 이상 여기서 비우지 않는다.
    //   예전엔 "시작"을 누를 때마다 무조건 빈 목록으로 시작했는데, 그러면 재시작 후 파일에서
    //   복구해 온 "실제로 토스에 아직 살아있는 포지션"까지 함께 버려져 추적을 영영 잃어버렸다
    //   (오너가 실제로 겪은 사고: 껐다 켜거나 업데이트하면 기록이 사라지는데 실제 주문은 남아있음).
    //   이제 "시작"은 "이어서 감시"를 의미한다 — 아래에서 남아있던 포지션 수를 안내한다.
    const carried = this.autoTradePositions.length;
    this.autoTradeLastScan = null; // 지난번 실행의 스캔 결과가 화면에 남아 헷갈리지 않게 초기화
    this.autoTradeLastScanError = null; // [v0.45.0] 마찬가지로 지난번 실행의 실패 기록도 초기화
    this.saveAutoPositions(); // [v0.61.4] 초기화된 상태도 즉시 파일에 반영(재시작 시 옛 스캔이 되살아나지 않게)
    this.openAutoRun(carried); // [v0.62.1] 리포트용 실행 기록 시작
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary:
        `🤖 자동매매 시작 — 최대 ${this.autoTradeMaxPositions}종목 · 최대손실 한도 시드대비 ${this.autoTradeMaxLossPct}% · ` +
        `종목당 투입 시드대비 ${this.autoTradeMaxInvestPct}%(최대 동시 투입 합계 최대 ${(this.autoTradeMaxInvestPct * this.autoTradeMaxPositions).toFixed(0)}%) · ` +
        `미체결 자동취소 ${this.autoTradeWatchMinutes}분 · ` +
        `5분마다 탐색(삼분할 ${this.autoTradeEntryLevel}분할 타점만, 이 프로그램이 켜져 있는 동안만 작동)` +
        (carried > 0 ? ` · ⏪ 이전에 감시하던 ${carried}종목을 그대로 이어받아 감시합니다(재시작·업데이트에도 유지됨)` : ""),
    });
    this.runAutoTradeTick(); // 시작하자마자 한 번 즉시 돌리고(이어받은 포지션도 곧바로 재확인됨)
    this.autoTradeTimer = setInterval(() => this.runAutoTradeTick(), ToolEngine.AUTO_TRADE_INTERVAL_MS); // 이후 5분마다
    void this.pushLiveState(true); // [v0.61.0] "켜짐" 전환을 폰이 바로 볼 수 있게 즉시 올린다
    return this.getAutoTradeStatus();
  }

  /** 자동매매를 끈다. 타이머만 멈출 뿐, 이미 낸 진입·조건주문은 취소하지 않는다(취소는 사람 판단). */
  stopAutoTrade(reason?: string): AutoTradeStatus {
    this.autoTradeEnabled = false;
    if (this.autoTradeTimer) {
      clearInterval(this.autoTradeTimer);
      this.autoTradeTimer = null;
    }
    this.closeAutoRun(reason ?? "오너가 직접 중지"); // [v0.62.1] 리포트용 실행 기록 마감(종료 사유 포함)
    this.addJournal({
      kind: "info",
      symbol: "-",
      summary: `🤖 자동매매 중지${reason ? ` — ${reason}` : ""} (이미 낸 진입·조건주문은 그대로 있습니다. 필요하면 [주문현황]에서 직접 취소하세요.)`,
      // [v0.32.0] reason이 있을 때만 알림(=손실 한도 도달 등 프로그램이 스스로 멈춘 경우) —
      //   오너가 직접 [중지] 버튼을 누른 경우(reason 없음)까지 알리면 당연한 걸 또 알리는 셈이다.
      notify: !!reason,
      notifyTitle: "🚨 자동매매 자동 중지",
    });
    void this.pushLiveState(true); // [v0.61.0] "꺼짐" 전환을 폰이 바로 볼 수 있게 즉시 올린다
    return this.getAutoTradeStatus();
  }

  /**
   * [v0.86.0 — 오너 지시 "자동매매 중에도 업데이트 발생 시 재시작해서 자동매매 그대로 이어가도록"]
   *   main.ts가 electron-updater의 조용한 재시작(quitAndInstall)을 호출하기 **직전에만** 부른다.
   *   지금 자동매매가 켜져 있으면 "다음에 켜질 때 자동으로 다시 켜 달라"는 일회용 표시(플래그)를
   *   남긴다. 꺼져 있으면 아무것도 하지 않는다(재개할 것 자체가 없음 — 괜히 켜면 오너가 끈 걸
   *   되돌리는 셈이 된다). 이 메서드를 안 부르고 그냥 종료/재시작하면(오너가 직접 끄는 경우,
   *   예기치 못한 충돌 등) 플래그가 안 남으므로 "마스터 스위치는 저장 안 함" 원칙이 그대로
   *   적용된다 — 이건 업데이트 재시작 전용 통로다.
   */
  prepareForUpdateRestart(): void {
    if (!this.autoTradeEnabled) return;
    this.autoResumeAfterUpdatePending = true;
    this.persistEnv();
  }

  getAutoTradeStatus(): AutoTradeStatus {
    return {
      enabled: this.autoTradeEnabled,
      unprotected: this.autoUnprotected.map((u) => ({ ...u })),
      orderBlocks: this.orderBlocks.map((b) => ({ ...b })), // [v0.69.2] 주문 전 검증에서 막힌 주문(화면 붉은 경고)
      positions: this.autoTradePositions.map((p) => ({ ...p })),
      realizedPnlUsd: Math.round(this.autoTradeRealizedPnlUsd * 100) / 100,
      maxPositions: this.autoTradeMaxPositions,
      maxLossPct: this.autoTradeMaxLossPct,
      maxInvestPct: this.autoTradeMaxInvestPct,
      watchMinutes: this.autoTradeWatchMinutes, // [v0.42.0] 장기간 미체결 자동취소 기준(분)
      lastCycleAt: this.autoTradeLastCycleAt,
      lastScan: this.autoTradeLastScan,
      lastScanError: this.autoTradeLastScanError, // [v0.45.0]
      lastCycleSkipReason: this.autoTradeLastCycleSkipReason, // [v0.48.0]
      nextCycleAtMs:
        this.autoTradeEnabled && this.autoTradeLastCycleAtMs != null ? this.autoTradeLastCycleAtMs + ToolEngine.AUTO_TRADE_INTERVAL_MS : null,
      skipReasons: { ...this.autoTradeSkipReasons },
      seedUsdSnapshot: this.seedBasis === "auto" ? this.autoTradeSeedSnapshotUsd : this.seedFixedUsd,
    };
  }

  /**
   * [v0.45.0 — 오너 보고 "지금 감시 중인 자동매매 포지션이 실시간 연동 안 됨"] "익절/손절
   *   등록됨"이 실제로는 이미 팔렸는데도 계속 그대로 보이는 문제의 근본 원인: 포지션 상태
   *   (watching↔active↔청산)는 5분 사이클의 reconcileAutoPositions()만 갱신하는데, 화면은
   *   20초마다 getAutoTradeStatus()(그 사이클이 마지막으로 남긴 값을 그대로 돌려주는 스냅샷,
   *   그 자체로는 아무것도 다시 확인하지 않음)만 불렀다 — 그래서 최대 5분까지 옛 상태가 보일 수
   *   있었다. reconcileAutoPositions 자체는 보유 포지션 수만큼만 조회하므로(보통 3개 이하)
   *   가볍다 — 5분마다 최대 200종목을 훑는 스크리닝과는 비교가 안 될 정도로 저렴해, 더 자주
   *   불러도 안전하다. [자동매매 현황] 탭의 "🔄 지금 확인" 버튼과, 포지션이 있는 동안의 20초
   *   자동 갱신 둘 다 이제 이 메서드를 쓴다(아래 App.tsx 참고).
   */
  async reconcileAutoPositionsNow(): Promise<AutoTradeStatus> {
    // [주의] autoTradeEnabled를 조건으로 걸지 않는다 — 오너가 방금 자동매매를 껐어도 그 전에
    //   넣어둔 감시 포지션(watching/active)은 화면에 계속 남아 있고, 그 상태를 지금 바로
    //   확인하고 싶을 수 있다("지금 감시 중" 표는 enabled와 무관하게 positions만 보고 뜬다).
    //   마침 5분 사이클이 돌고 있을 때만(그 사이클이 이미 reconcile 중이므로) 겹쳐 부르지 않는다.
    if (!this.autoTradeTickBusy) {
      await this.reconcileAutoPositions();
      // [v0.98.0 — 오너 지시 "추가매수를... 카프리에 실시간 반영이 안되고있음"] 5분 사이클
      //   (autoTradeTick)에도 이미 걸어 뒀지만, 이 메서드는 20초마다(자동매매 꺼져 있어도)
      //   도는 "진짜 실시간" 통로다 — v0.74.0의 같은 이유(task #72)로 reconcileAutoPositions를
      //   여기로 끌어올렸던 것과 같은 논리. 가볍다(보유 조회 1번) — 더 자주 불러도 안전하다.
      await this.auditActivePositionQuantities().catch(() => 0);
    }
    void this.pushLiveState(true); // [v0.61.0] "지금 확인" 직후 바뀐 상태를 폰도 바로 볼 수 있게
    return this.getAutoTradeStatus();
  }

  /**
   * 시드 기준 금액(달러) — orderCapacity와 동일 규칙: auto=매수가능금액, fixed=오너가 정한 고정 금액.
   *
   * [v0.40.0 버그 수정 — 오너 실사용 보고 "투입 시드 비율에 맞지않게 적게 투입되고있음"]
   *   auto 모드는 예전엔 자동매매 사이클(5분)마다 매번 "지금 이 순간의 매수가능금액"을 새로
   *   조회했다. 그런데 자동매매 자신이 이미 진입해서 현금을 써버리면, 그 다음 사이클이 "종목당
   *   시드 대비 N%"를 계산할 때는 이미 줄어든 잔여 현금을 기준으로 다시 N%를 매기게 된다.
   *   `lib/auto-risk.ts`의 "종목 1개당 N%, 최대 종목수만큼 있으면 최대 N%×종목수까지"라는 설계
   *   (예: 30%×3종목=최대 90%)는 매 슬롯이 "같은 시드"를 기준으로 독립적으로 N%씩 배정된다는
   *   전제인데, 매 사이클 새로 조회하면 실제로는 (30% of 원금) + (30% of 원금-1차분) + (30% of
   *   원금-1,2차분) 식으로 갈수록 작아져 — 예를 들어 3종목이면 합계가 90%가 아니라 대략
   *   65~70% 선까지밖에 안 된다(1차 이후 슬롯일수록 더 적게 투입되는 게 오너가 겪은 증상).
   *   [수정] auto 모드는 "이번 자동매매 실행"(시작~정지) 동안 딱 한 번만 조회하고, 그 값을
   *   스냅샷(`autoTradeSeedSnapshotUsd`)으로 고정해 재사용한다 — 이제 모든 슬롯이 정말로 "같은
   *   시드"를 기준으로 계산되어 오너가 설정한 비율(N%×최대종목수)이 그대로 지켜진다. 오너가
   *   자동매매를 껐다 다시 켜면(startAutoTrade) 그때 새로 스냅샷을 뜬다 — 마스터 스위치 자체가
   *   재시작마다 다시 켜야 하는 것과 같은 "이번 실행" 단위 원칙. fixed 모드는 원래도 오너가
   *   직접 고정한 값이라 이 문제와 무관해 그대로 둔다.
   */
  /**
   * [v0.40.0] auto 모드는 "이번 자동매매 실행" 동안 시드를 고정 스냅샷으로 재사용한다 —
   *   자동매매 자신이 진입해서 현금을 써버려도(잔여 현금이 줄어도) 종목당 배정 비율(N%)의
   *   "기준"이 매 사이클 작아지지 않게 하기 위함이었다(자세한 배경은 docs/progress.md
   *   v0.40.0 참고).
   *
   * [v0.55.0 긴급 수정 — 오너 실사용 보고 "잔고 $33 있는데 1주도 못 산다고 리젝됨"]
   *   위 "고정"을 문자 그대로 "최초 조회값을 실행 내내 절대 안 바꿈"으로 구현했더니, 자동매매를
   *   켠 뒤에 새로 입금(또는 다른 방식으로 잔고가 늘어남)해도 그 늘어난 잔고를 영영 반영하지
   *   못하는 새 사고로 이어졌다 — 재시작(끄고 다시 켬)하기 전까지는 옛날의, 흔히 더 낮았던
   *   잔고로 계속 "1주도 못 산다"며 확정 종목을 계속 건너뛴다. v0.40.0이 막으려던 건
   *   "지출로 인한 감소"였지, "입금으로 인한 증가"가 아니었다 — 그런데 둘 다 똑같이 막아버린
   *   것이 이번 버그의 진짜 원인이다.
   *
   *   이제 매 사이클 실제 매수가능금액을 다시 조회하되, 스냅샷은 절대 "낮아지지"는 않고(지출로
   *   줄어든 실제 잔고가 스냅샷보다 낮으면 무시하고 스냅샷 유지 — v0.40.0의 원래 보호 그대로),
   *   실제 잔고가 스냅샷보다 "높아졌을" 때만(=입금 등으로 늘어난 경우) 스냅샷을 그 새 값으로
   *   올려 반영한다. 조회 자체가 실패하면(일시적 네트워크 오류) 기존 스냅샷을 그대로 쓴다(자가 복구).
   */
  private async resolveSeedUsd(): Promise<number | null> {
    if (this.seedBasis === "fixed") return this.seedFixedUsd;
    try {
      const bp = await getBuyingPower("USD");
      if (Number.isFinite(bp.buyingPowerUsd) && (this.autoTradeSeedSnapshotUsd == null || bp.buyingPowerUsd > this.autoTradeSeedSnapshotUsd)) {
        this.autoTradeSeedSnapshotUsd = bp.buyingPowerUsd; // 최초 조회거나, 잔고가 늘어난 경우만 갱신
      }
      return this.autoTradeSeedSnapshotUsd;
    } catch {
      return this.autoTradeSeedSnapshotUsd; // 조회 실패 — 기존 스냅샷이 있으면 그걸로, 없으면 null(다음 사이클에 재시도)
    }
  }

  /** 미국 시장 수수료율(참고용, 실패하면 0으로 계산 — orderCapacity와 동일 로직). */
  private async resolveCommissionRate(): Promise<number | null> {
    try {
      const raw = (await getCommissions()) as unknown;
      const arr = Array.isArray(raw) ? raw : [];
      const us = arr.find((x) => (x as Record<string, unknown>)?.marketCountry === "US") as Record<string, unknown> | undefined;
      const v = us ? Number(us.commissionRate) : NaN;
      return Number.isFinite(v) ? (v > 0.01 ? v / 100 : v) : null;
    } catch {
      return null;
    }
  }

  private autoTradeExpireDate(): string {
    return DateTime.now().setZone("Asia/Seoul").plus({ days: 30 }).toFormat("yyyy-MM-dd");
  }

  /**
   * [v0.60.0] COMPLETED로 확인된 조건주문 하나를 실제로 정리한다(자리 비움 + 손익 반영 +
   *   기록·저널). reconcileAutoPositions(5분 주기 자동 확인)와 cancelAutoPosition(오너가
   *   직접 취소 버튼을 눌렀는데 이미 끝나 있던 경우)이 이 로직을 그대로 공유한다 — 오너
   *   실사용 보고("체결 완료된 종목이 목록에 남고 취소도 무반응")의 두 번째 원인이 바로
   *   이것: 취소 버튼은 cancelConditional(살아있는 조건주문을 취소)만 시도했지, "이미
   *   끝나 있어서 취소할 게 없는" 경우는 전혀 처리하지 않아 매번 실패만 하고 있었다.
   */
  private async resolveCompletedConditional(pos: AutoPosition, resp: ConditionalOrderResponse): Promise<void> {
    const secondTriggered = resp.second?.triggeredOrderId != null;
    const firstTriggered = resp.first?.triggeredOrderId != null;
    if (firstTriggered || secondTriggered) {
      // 익절(first)/손절(second) 중 어느 쪽이 발동됐는지에 따라 우리가 등록해 둔 그 가격을 그대로 쓴다
      // (실제 체결가 조회 없이도 정확 — 조건주문 지정가로 나가므로).
      // [v0.63.0 ② 측정] 발동된 주문의 실제 평균 체결가를 토스에 물어본다. 손절 다리는 "감시가 1% 아래
      //   지정가"로 나가므로 급락 때는 그보다 더 나쁘게(또는 아예 안) 체결될 수 있다 — 예전엔 항상
      //   "목표가에 정확히 체결"로 가정해 실제 손실을 과소평가했을 수 있다. 조회 실패면 예전처럼 목표가 사용.
      const targetPrice = secondTriggered ? pos.sl : pos.tp;
      const triggeredOrderId = (secondTriggered ? resp.second?.triggeredOrderId : resp.first?.triggeredOrderId) ?? null;
      let exitFillPrice: number | null = null;
      let exitOrderUnfilled = false;
      if (triggeredOrderId) {
        try {
          const o = await getOrder(triggeredOrderId);
          if (o.avg_filled_price != null && o.avg_filled_price > 0) exitFillPrice = o.avg_filled_price;
          // [v0.69.1 긴급] 예전엔 "체결가가 조금이라도 있으면 전량 청산"으로 봤다 — CUPR 실사례(10-02): 손절 지정가가 1주만 체결되고
          //   나머지 23주는 37분 뒤에야 같은 가격에 체결됐는데, 앱은 발동 직후 "손절 완료"로 기록하고 끝냈다(그 사이 23주는 매도 대기 상태로 방치).
          //   이제 전량 체결(filled)이 아니면 모두 "미체결 잔량 있음"으로 취급한다.
          if (o.status !== "filled") exitOrderUnfilled = true;
        } catch {
          /* 조회 실패 — 목표가로 계산(예전 동작) */
        }
      }
      if (exitOrderUnfilled) {
        // 발동은 됐는데 매도가 아직 안 체결됨 = 급락으로 지정가 아래로 가격이 뚫고 내려간 상황일 수 있다.
        //   자동으로 시장가 매도까지 하지는 않는다(실주문 — 사람 판단). 대신 강하게 알린다.
        this.addJournal({
          kind: "info",
          symbol: pos.symbol,
          summary:
            `🚨 ${pos.symbol} ${secondTriggered ? "손절" : "익절"} 조건이 발동됐지만 매도 주문이 아직 체결되지 않았습니다 ` +
            `(급락으로 지정가 $${secondTriggered ? roundPrice(pos.sl * 0.99) : pos.tp}보다 아래로 내려갔을 수 있음). ` +
            `토스 앱/[주문현황]에서 직접 확인하고 필요하면 시장가로 정리하세요.`,
          notify: true,
          notifyTitle: `🚨 매도 미체결: ${pos.symbol}`,
        });
        // [v0.69.1 긴급] 손절 쪽만: 지정가가 안 닿는 채 방치하면 급락이 계속될 때 손절이 영영 안 된다. 걸려 있는 낡은 손절 지정가를 거두고(주식이
        //   매도 대기로 묶여 있으면 새 주문이 "매도 가능 수량 부족"으로 막히므로) 보호 가드에 넘긴다 — 가드는 가격이 아직 손절선 아래면 시장가로 정리하고,
        //   손절선 위로 되돌아왔으면 조건주문(익절/손절)을 다시 건다. 익절 쪽 미체결은 그대로 둔다(가격이 돌아오면 체결되는 정상 대기).
        if (secondTriggered && triggeredOrderId && !this.isDryRun()) {
          try { await cancelOrder(triggeredOrderId); } catch { /* 이미 끝났거나 취소 불가 — 가드가 보유 수량을 직접 확인한다 */ }
          this.registerUnprotected(pos, "손절 조건이 발동됐지만 매도 주문이 전량 체결되지 않음 — 남은 수량을 정리");
        }
      }
      const exitPrice = exitFillPrice ?? targetPrice;
      const slippagePct = exitFillPrice != null ? Math.round((exitFillPrice / targetPrice - 1) * 10000) / 100 : null;
      const costBasis = pos.fillPrice ?? pos.entry; // [v0.69.2] 실제 체결가가 있으면 그 기준으로 손익 계산
      // [v0.101.0] 손익은 "조건주문이 실제로 판 수량"으로 계산한다. 예전엔 pos.quantity(실계좌 보유
      //   기준 — v0.98.0부터 추가매수하면 늘어남)를 썼는데, OCO는 등록 당시 수량만 팔기 때문에
      //   추가매수분만큼 손익이 부풀려졌다. 우선순위: 토스가 알려 준 조건주문 수량 → 우리가 기억한
      //   보호 수량 → (둘 다 없으면) 예전처럼 보유 수량.
      const ocoQty = Number(resp.quantity);
      const soldQty = Number.isFinite(ocoQty) && ocoQty > 0 ? ocoQty : (pos.protectedQty ?? pos.quantity);
      const leftoverQty = Math.max(0, pos.quantity - soldQty); // 조건주문 밖에 있던 수량(= 토스에서 직접 추가매수한 분)
      const pnlUsd = (exitPrice - costBasis) * soldQty;
      const pnlPct = ((exitPrice - costBasis) / costBasis) * 100;
      this.autoTradeRealizedPnlUsd += pnlUsd;
      this.autoTradePositions = this.autoTradePositions.filter((p) => p !== pos);
      this.saveAutoPositions(); // [v0.30.1] 자리 비움을 즉시 파일에도 반영(재시작해도 정확)
      const kindKo = secondTriggered ? "손절" : "익절";
      this.addJournal({
        kind: "info",
        symbol: pos.symbol,
        summary:
          `🤖 자동매매 ${kindKo} 완료 ${pos.symbol}: 진입 $${pos.entry} → 청산 $${exitPrice} × ${soldQty}주 ` +
          `(이번 실행 누적손익 $${this.autoTradeRealizedPnlUsd.toFixed(2)}) — 빈자리는 다음 확인 때 채웁니다.`,
        notify: true,
        notifyTitle: `${kindKo === "손절" ? "🛑" : "✅"} ${kindKo} 완료: ${pos.symbol}`,
      });
      this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, {
        status: secondTriggered ? "closed_loss" : "closed_win",
        exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
        exitPrice,
        exitFillPrice,
        slippagePct,
        pnlUsd: Math.round(pnlUsd * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        quantity: soldQty, // [v0.101.0] 기록의 수량도 손익 계산에 쓴 "실제로 팔린 수량"과 맞춘다
        note:
          `${kindKo} 발동으로 자동 청산` +
          (exitFillPrice != null ? ` (실제 체결가 $${exitFillPrice}, 목표가 대비 ${slippagePct}%)` : " (체결가 조회 안 됨 — 목표가로 계산)") +
          (leftoverQty > 0 ? ` — 조건주문에 포함 안 된 추가매수분 ${leftoverQty}주는 별도 기록으로 이어서 관리` : ""),
      });
      // [v0.101.0 — 이번 점검의 핵심 구멍] 추가매수분이 조건주문 밖에 남은 경우.
      //   예전엔 여기서 끝이었다 — 위 기록이 "정상 청산(closed_win/closed_loss)"이 되면 독립 감사
      //   (auditUnprotectedHoldings)는 "정상 청산된 종목"이라며 이 종목을 건너뛰도록 돼 있어서,
      //   남은 추가매수분은 보호 없이 계좌에 영영 방치됐다(아무 감사에도 안 걸리는 사각지대).
      //   이제는 남은 수량을 "새 기록 한 줄"로 분리해 가드에 넘긴다. 새 기록으로 분리하는 이유:
      //   가드는 결과를 매매기록에 덮어쓰는데, 같은 기록(id)을 쓰면 방금 확정한 익절/손절 손익이
      //   지워져 버린다. 가드는 평소와 똑같이 움직인다 — 가격이 아직 익절/손절선 사이면 조건주문을
      //   다시 걸고, 이미 선 밖이면(지금 막 익절·손절이 났으니 대개 이쪽) 원래 포지션과 같은 방향으로
      //   시장가 정리한다. (손절 매도가 덜 체결된 경우는 위에서 이미 원래 포지션을 가드에 넘겼고,
      //   가드는 종목 단위로 실계좌 보유 전체를 처리하므로 여기서 중복으로 올리지 않는다.)
      const alreadyGuarded = this.autoUnprotected.some((u) => u.symbol === pos.symbol.toUpperCase());
      if (leftoverQty > 0 && !this.isDryRun() && !alreadyGuarded) {
        const rest: AutoPosition = {
          symbol: pos.symbol, entry: pos.entry, tp: pos.tp, sl: pos.sl, quantity: leftoverQty,
          // enteredAtMs를 지금 시각으로 — 기록 id(`종목@진입가@시각`)가 원래 포지션과 겹치지 않게 하는 게 목적
          enteredAtMs: Date.now(), status: "active", conditionalOrderId: null, fillPrice: pos.fillPrice ?? null,
        };
        this.addAutoTradeHistory(rest);
        this.updateAutoTradeHistory(rest.symbol, rest.entry, rest.enteredAtMs, {
          status: "oco_failed",
          note: `토스에서 직접 추가매수한 ${leftoverQty}주 — 원래 조건주문에 포함되지 않아 ${kindKo} 후에도 계좌에 남음(보호 가드가 이어서 처리)`,
        });
        const warn = `🚨 ${pos.symbol} ${kindKo}는 조건주문 수량(${soldQty}주)만 팔렸고, 추가매수분 ${leftoverQty}주는 보호 없이 계좌에 남아 있습니다.`;
        if (this.autoReprotectVanished) {
          this.registerUnprotected(rest, `${kindKo} 후 조건주문 밖 추가매수분 ${leftoverQty}주가 남음`);
        } else {
          // 오너가 설정에서 "사라진 보호 자동 복구"를 꺼 둔 경우 — 봇이 대신 주문하지 않고 강하게 알리기만 한다.
          this.addJournal({
            kind: "info", symbol: pos.symbol,
            summary: `${warn} 자동 보호 복구가 꺼져 있어 봇은 손대지 않습니다 — 토스에서 직접 정리하거나 익절/손절을 걸어 주세요.`,
            notify: true, notifyTitle: `🚨 무보호 수량 남음: ${pos.symbol}`,
          });
          void this.sendDiscordAlert(`${warn} 자동 보호 복구가 꺼져 있어 직접 처리가 필요합니다.`);
        }
      }
    } else {
      // 어느 다리도 발동 안 했는데 그룹이 COMPLETED = 사람이 [주문현황]에서 직접 취소한 경우
      // — 손익 반영 없이 자리만 비운다.
      // [v0.101.0] 이 분기는 "사람이 직접 취소했다"가 확실한 유일한 경로라, 가드가 바로 예전 가격으로
      //   다시 걸지 않고 오너가 새 조건주문을 거는 시간(OWNER_REREGISTER_GRACE_MS)을 기다려 준다.
      await this.clearAutoPositionWithoutPnl(
        pos,
        `자동매매 포지션의 조건주문이 취소돼 있어 감시를 멈춥니다: ${pos.symbol}`,
        "사람이 [주문현황]에서 조건주문을 직접 취소함(손익 미확정)",
        ToolEngine.OWNER_REREGISTER_GRACE_MS,
      );
    }
  }

  /**
   * [v0.60.1] 손익을 확정할 근거가 없는 상태로 자동매매 포지션 자리만 비운다(자리 비움
   *   + 저널 + 기록 갱신, 손익 반영 없음) — resolveCompletedConditional의 "발동 안 함"
   *   분기와 아래 reconcileAutoPositions의 "조건주문 자체가 더 이상 존재하지 않음(404)"
   *   분기가 이 메서드를 공유한다.
   */
  /**
   * [v0.61.8 긴급 보강 — 오너 지시 "왜 이런 종목들이 발생하지 않을 수 있을지 검토"]
   *   오너 실사용 사고(2026-10-01, CNTB): 손절 직전 조건주문을 직접 취소했는데("손절
   *   방지" 의도), 이 함수가 "조건주문이 사라짐 = 거래 종료"로만 처리해 자동매매 추적
   *   에서 빠지고 끝이었다 — 그런데 **주식 자체는 계좌에 그대로 남아 있을 수 있다**
   *   (조건주문 취소는 "보호장치 해제"일 뿐 "매도"가 아니므로). 보호장치 없이 방치된
   *   보유 종목을 오너가 모른 채 지나칠 수 있는 게 진짜 위험 — 이제 정리하기 전에
   *   실계좌를 다시 확인해, 아직 보유 중이면 훨씬 강하게(알림 포함) 경고한다.
   *   [한계] 이래도 "최대 종목 수" 계산(effectiveActivePositionCount)에는 이 종목이 다시
   *   안 잡힌다 — 그 부분까지 고치려면 "기보유 종목은 한도에 안 잡히게" 한 v0.39.0
   *   설계와 충돌해 범위가 커진다(docs/audit-2026-10-01.md 후속 논의 필요, 이번엔 보류).
   */
  private async clearAutoPositionWithoutPnl(pos: AutoPosition, journalSummary: string, historyNote: string, reprotectGraceMs = 0): Promise<void> {
    this.autoTradePositions = this.autoTradePositions.filter((p) => p !== pos);
    this.saveAutoPositions();
    const heldSymbols = await this.fetchRealHeldSymbols();
    const stillHeld = heldSymbols?.has(pos.symbol.toUpperCase()) ?? null;
    let finalSummary = journalSummary;
    let finalNote = historyNote;
    if (stillHeld) {
      finalSummary =
        `🚨 ${pos.symbol} — 조건주문(익절/손절 보호장치)은 사라졌는데 실계좌엔 아직 ${pos.quantity}주가 남아 있습니다! ` +
        `보호장치 없이 방치되고 있다는 뜻이니 [주문현황]이나 토스 앱에서 직접 익절/손절을 다시 걸어 주세요. (${journalSummary})`;
      finalNote = `⚠️ 조건주문만 사라지고 실계좌엔 ${pos.quantity}주가 그대로 남아있음(보호장치 없이 방치 — 직접 재확인 필요). ${historyNote}`;
    } else if (stillHeld === false) {
      finalNote = `실계좌 재확인 결과 보유 수량 0(실제로 매도된 것으로 보임, 손익 미확정). ${historyNote}`;
    }
    // stillHeld===null(실계좌 재확인 자체가 실패)이면 "확인 못 함"을 "괜찮음"으로 착각하지
    // 않게 원래 메시지 그대로 둔다(섣부른 안심 금지).
    this.addJournal({
      kind: "info",
      symbol: pos.symbol,
      summary: finalSummary,
      notify: !!stillHeld, // 아직 실제로 보유 중일 때만 강한 알림(Discord 포함) — 단순 정리면 기존처럼 조용히
      notifyTitle: stillHeld ? `🚨 보호장치 없이 보유 중: ${pos.symbol}` : undefined,
    });
    this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, {
      status: "closed_manual",
      exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
      note: finalNote,
    });
    // [v0.69.0] WHLR·NAUT 실사례 — 진입 6분 뒤 조건주문이 토스에서 사라졌는데 주식은 그대로. 경고만 하고 끝내지 않고 다시 보호한다.
    //   (기존 경고·기록을 모두 남긴 뒤에 가드 목록에 올린다)
    //   [v0.69.1] stillHeld===null(실계좌 재확인 실패)을 "괜찮음"으로 넘기지 않는다 — 가드가 자기 점검 때 보유를 다시 확인해 0이면 스스로 종료한다.
    if (stillHeld !== false && this.autoReprotectVanished) {
      this.registerUnprotected(
        pos,
        stillHeld ? "조건주문이 토스에서 사라졌는데 실계좌에 주식이 남아 있음" : "조건주문이 사라졌고 실계좌 보유 여부를 확인하지 못함(가드가 재확인)",
        reprotectGraceMs, // [v0.101.0] 오너가 직접 취소한 경우에만 0보다 크다(아래 resolveCompletedConditional 참고)
      );
    }
  }

  /**
   * [v0.60.1 긴급 — 오너 실사용 보고: SLND·VNDA·SDEV가 "조건주문 상태 확인 21회 연속
   *   실패(HTTP 404 conditional-order-not-found)"로 계속 남아 있음] v0.60.0에서 고친
   *   "재확인 실패"는 네트워크 순단처럼 재시도하면 나아질 수 있는 **모호한** 실패를
   *   염두에 뒀다(그래서 3회 연속까지는 조용히 기다렸다가 경고만 표시). 그런데 토스가
   *   404 conditional-order-not-found로 답하는 건 모호하지 않다 — "이 조건주문 ID는
   *   토스 쪽에 아예 없다"는 확정적인 신호라, 아무리 재시도해도 저절로 좋아지지 않는다
   *   (오너 실사용에서 21회, 약 7분을 반복 실패하고도 그대로였던 이유). 이 신호는 실패로
   *   세지 말고 그 자리에서 바로 자리를 비운다.
   */
  private isConditionalOrderGoneError(e: unknown): boolean {
    const s = String(e);
    return s.includes("HTTP 404") && s.includes("conditional-order-not-found");
  }

  /**
   * 기존 자동매매 포지션을 다시 확인한다("빈자리 채우기"가 늦지 않으려면 스캔보다 먼저 끝나야 함).
   *   - active(OCO 등록 완료) 상태는 조건주문이 "발동"됐는지 조회해, 발동됐으면 실현손익에 반영하고
   *     자리를 비운다.
   *   - [v0.30.1 긴급수정] watching(매수 체결 대기 중) 상태는 **보통은** watchAndBracket 자체의
   *     완료 콜백(onAutoBracketResolved, 1초~5초 간격 빠른 폴링)이 처리한다. 그런데 앱이 재시작
   *     되면(껐다 켬·자동 업데이트) 그 폴링 자체가 통째로 사라져 영영 아무도 확인 안 하게 된다
   *     (오너가 실제로 겪은 사고 — "watching" 상태 그대로 남겨진 채 앱만 재시작되면, 그 사이 실제로
   *     체결됐어도 보호주문(OCO)이 영원히 안 걸릴 수 있었다). 그래서 여기서도 **지금 이 프로세스가
   *     직접 감시 중이 아닌**(=autoTradeActiveWatches에 없는) watching 포지션은 5분마다 함께
   *     재확인한다 — 재시작 직후에도 최대 5분 안에 다시 붙잡힌다.
   */
  private async reconcileAutoPositions(): Promise<void> {
    const active = this.autoTradePositions.filter((p) => p.status === "active" && p.conditionalOrderId);
    for (const pos of active) {
      const posKey = `${pos.symbol}@${pos.entry}@${pos.enteredAtMs}`;
      let resp: ConditionalOrderResponse;
      try {
        resp = await getConditionalOrder(pos.conditionalOrderId as string);
      } catch (e) {
        // [v0.60.1 긴급 — SLND·VNDA·SDEV 실사용 사고] 404 conditional-order-not-found는
        // "재시도하면 나아질 수도 있는 모호한 실패"가 아니라 "토스에 이 ID 자체가 없다"는
        // 확정적 신호다 — 아래 재시도 카운트(3회부터 경고만)를 태우지 않고 바로 정리한다.
        if (this.isConditionalOrderGoneError(e)) {
          this.reconcileFailCounts.delete(posKey);
          await this.clearAutoPositionWithoutPnl(
            pos,
            `🤖 ${pos.symbol}의 조건주문을 토스에서 더 이상 찾을 수 없어(존재하지 않는 설정) 자동으로 정리했습니다 — ` +
              `실제 체결·손익 여부는 [주문현황]이나 토스 앱에서 직접 확인해 주세요.`,
            "토스에 조건주문이 더 이상 존재하지 않아 자동 정리(직접 취소했거나 만료된 것으로 보임 — 손익 미확정)",
          );
          continue;
        }
        // [v0.60.0 긴급 수정 — 오너 실사용 보고: "체결 완료된 종목이 목록에 계속 남는다"]
        //   예전엔 조회 실패를 조용히 삼키고 continue만 했다 — 원인이 네트워크 순단처럼
        //   "한 번 실패하고 다음엔 되는" 종류면 문제없지만, 같은 원인(예: 조건주문 ID가
        //   더는 조회되지 않음)이 매 사이클 똑같이 반복되면 이 포지션은 상태가 영원히
        //   안 바뀐 채(=취소 버튼을 눌러도 cancelAutoPosition이 같은 cancelConditional
        //   호출로 또 실패) 화면에 "익절/손절 등록됨"만 계속 보이는데, 왜 그런지 알
        //   방법이 전혀 없었다. 3회 연속(약 15분) 실패하면 포지션에 경고를 남겨 화면에
        //   보이게 하고, 저널에도 한 번 남긴다(반복 알림 방지 — 정확히 3회째에만).
        const failCount = (this.reconcileFailCounts.get(posKey) ?? 0) + 1;
        this.reconcileFailCounts.set(posKey, failCount);
        if (failCount >= 3) {
          const warning = `조건주문 상태 확인 ${failCount}회 연속 실패(${String(e).replace(/^Error:\s*/, "")}) — [주문현황]에서 실제 상태를 직접 확인해 주세요.`;
          const idx = this.autoTradePositions.findIndex((p) => p === pos);
          if (idx !== -1 && this.autoTradePositions[idx].syncWarning !== warning) {
            this.autoTradePositions[idx] = { ...this.autoTradePositions[idx], syncWarning: warning };
            this.saveAutoPositions();
          }
          if (failCount === 3) {
            this.addJournal({
              kind: "info", symbol: pos.symbol,
              summary: `⚠️ ${pos.symbol} 자동매매 포지션의 조건주문 상태 확인이 계속 실패합니다 — [주문현황]에서 직접 확인해 주세요.`,
              notify: true, notifyTitle: `⚠️ 상태 확인 실패: ${pos.symbol}`,
            });
          }
        }
        continue; // 다음 사이클에 재시도(포지션을 잃어버리지 않음)
      }
      // 조회 성공 — 실패 카운트·경고를 지운다(있었다면).
      this.reconcileFailCounts.delete(posKey);
      if (pos.syncWarning) {
        const idx = this.autoTradePositions.findIndex((p) => p === pos);
        if (idx !== -1) this.autoTradePositions[idx] = { ...this.autoTradePositions[idx], syncWarning: null };
      }
      // [v0.51.0 긴급 수정] 예전엔 실제로 존재하지 않는 값(status "TRIGGERED"/"CANCELED",
      //   triggeredLeg 필드)을 확인하고 있었다 — 실스펙은 그룹 status가 "WATCHING"(감시 중)
      //   /"COMPLETED"(끝남)뿐이고, 어느 다리가 발동됐는지는 그 다리의 triggeredOrderId가
      //   null이 아닌지로 판단해야 한다(lib/toss.ts의 ConditionalOrderResponse 주석 참고).
      //   이 불일치 때문에 실계좌에서는 이 분기가 절대 안 걸려, 이미 끝난 포지션이 영원히
      //   "감시 중"으로 남아있었다 — 오너가 반복 보고한 정합성 버그의 진짜 원인.
      if (resp.status === "COMPLETED") {
        await this.resolveCompletedConditional(pos, resp);
      }
      // WATCHING(그대로 감시 중)이면 할 일 없음.
    }

    // [v0.30.1 긴급수정] "이 프로세스가 직접 감시 중이 아닌" watching 포지션을 재확인한다 — 앱
    //   재시작 직후 복구된 포지션이 여기 해당한다(autoTradeActiveWatches에 없다는 게 그 신호).
    const orphanedWatching = this.autoTradePositions.filter(
      (p) => p.status === "watching" && !this.autoTradeActiveWatches.has(`${p.symbol}@${p.entry}@${p.enteredAtMs}`),
    );
    for (const pos of orphanedWatching) {
      if (!pos.buyOrderId) {
        // [v0.69.3] 주문번호를 못 적어 둔 포지션(접수 직후 앱이 꺼진 경우 등) — 예전엔 영원히 "감시 중"으로 남고 토스 주문은 방치됐다.
        //   토스의 미체결 목록에서 같은 종목·같은 가격의 봇 매수 주문을 찾아 이어받고, 못 찾으면 감시 시간이 지난 뒤 정리한다.
        const found = await this.findOpenAutoBuyOrder(pos).catch(() => null);
        if (found) {
          pos.buyOrderId = found;
          this.saveAutoPositions();
          this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, { buyOrderId: found });
        } else if (Date.now() - pos.enteredAtMs > (this.autoTradeWatchMinutes + 5) * 60_000) {
          await this.clearAutoPositionWithoutPnl(
            pos,
            `🤖 ${pos.symbol}: 매수 주문번호가 기록되지 않았고 토스 미체결 목록에도 없어 감시를 정리합니다.`,
            "주문번호 미기록 + 토스 미체결 목록에 없음(체결·취소 여부 미확정) — 보유 여부는 실계좌로 재확인함",
          );
          continue;
        }
        if (!pos.buyOrderId) continue;
      }
      let o: OrderResponse;
      try {
        o = await getOrder(pos.buyOrderId);
      } catch {
        continue; // 조회 실패는 다음 사이클에 재시도
      }
      if (o.status === "filled" || ((o.status === "cancelled" || o.status === "failed") && (o.filled_qty ?? 0) > 0)) {
        const qty = o.filled_qty && o.filled_qty > 0 ? o.filled_qty : pos.quantity;
        const result = await this.registerOcoForFilled(pos.symbol, qty, {
          price: pos.entry,
          autoPlan: this.currentAutoPlan(),
          strictPlan: false, // 재시작 복구: 저장된 가격이 그 뒤 바뀐 설정과 달라도 보호가 최우선 — 설정 일치 검사는 체결가 재계산이 일어났을 때만
          tpTrigger: pos.tp,
          tpPrice: pos.tp,
          slTrigger: pos.sl,
          slPrice: roundPrice(pos.sl * 0.99), // 신규 진입 경로(autoTradeTick)와 동일 규칙
          expireDate: this.autoTradeExpireDate(), // 재시작 시점 기준으로 새로 30일 계산
          rationale: { technique: "split3", source: "auto", level: 1, entry: pos.entry, tp: pos.tp, sl: pos.sl, priceAtOrder: null },
        }, o.avg_filled_price);
        const idx = this.autoTradePositions.findIndex((p) => p === pos);
        if (result.status === "oco_registered") {
          if (idx !== -1) {
            this.autoTradePositions[idx] = {
              ...pos, status: "active", conditionalOrderId: result.conditionalOrderId,
              ...(result.tp != null ? { tp: result.tp, sl: result.sl ?? pos.sl, fillPrice: result.fillPrice ?? null } : {}),
            };
          }
          if (result.tp != null) this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, { tp: result.tp, sl: result.sl ?? pos.sl, fillPrice: result.fillPrice ?? null });
          this.saveAutoPositions();
          this.addJournal({
            kind: "info", symbol: pos.symbol,
            summary: `🤖 재시작 후 감시 복구: ${pos.symbol}이 그 사이 체결된 걸 확인해 보호주문(익절/손절)을 지금 등록했습니다.`,
            notify: true,
            notifyTitle: `🛡 보호주문 등록: ${pos.symbol}`,
          });
          this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, {
            status: "active", note: "재시작 후 재확인 — 매수 체결을 뒤늦게 확인해 보호주문 등록",
            conditionalOrderId: result.conditionalOrderId,
          });
        } else if (result.status === "protected_by_market_sell") {
          // [v0.57.0] 여기도 위 onAutoBracketResolved와 같은 원칙 — 실패가 아니라 실제 청산이다.
          // [2차 검토 수정] 부분체결이었을 수 있어(qty = filled_qty ?? pos.quantity, 위 참고)
          // 손익은 pos.quantity가 아니라 실제로 보호매도한 수량(result.quantity)으로 계산해야 한다.
          if (idx !== -1) this.autoTradePositions.splice(idx, 1);
          this.saveAutoPositions();
          const pnlUsd = (result.exitPrice - pos.entry) * result.quantity;
          const pnlPct = ((result.exitPrice - pos.entry) / pos.entry) * 100;
          this.autoTradeRealizedPnlUsd += pnlUsd;
          this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, {
            status: pnlUsd >= 0 ? "closed_win" : "closed_loss",
            exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
            exitPrice: result.exitPrice,
            pnlUsd: Math.round(pnlUsd * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
            note: result.exitPriceIsEstimate
              ? "재시작 후 재확인 — 가격이 감시가를 이미 넘어서 OCO 등록이 불가능해, 즉시 시장가로 매도해 정리함(실제 체결가 조회 실패 — 매도 직전 추정가로 기록)"
              : "재시작 후 재확인 — 가격이 감시가를 이미 넘어서 OCO 등록이 불가능해, 즉시 시장가로 매도해 정리함",
          });
        } else {
          // OCO 등록 자체가 실패 — registerOcoForFilled가 이미 상세 사유를 저널에 남겼다.
          //   [v0.69.0] 자리만 비우고 끝내지 않고, 가드가 계속 보호를 시도하도록 목록에 올린다.
          this.registerUnprotected(pos, `재시작 후 보호주문 등록 실패: ${result.status === "oco_failed" ? result.error : ""}`);
          if (idx !== -1) this.autoTradePositions.splice(idx, 1);
          this.saveAutoPositions();
          this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, {
            status: "oco_failed", exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
            note: `재시작 후 재확인 — 체결은 됐지만 보호주문 등록 실패, 직접 확인 필요: ${result.status === "oco_failed" ? result.error : ""}`,
          });
        }
      } else if (o.status === "cancelled" || o.status === "failed") {
        this.autoTradePositions = this.autoTradePositions.filter((p) => p !== pos);
        this.saveAutoPositions();
        this.addJournal({
          kind: "info", symbol: pos.symbol,
          summary: `재시작 후 재확인: ${pos.symbol}의 매수 주문이 ${o.status === "cancelled" ? "취소" : "실패"} 상태로 확인돼 감시를 멈춥니다.`,
          notify: true,
          notifyTitle: `${o.status === "cancelled" ? "취소됨" : "⚠️ 실패"}: ${pos.symbol}`,
        });
        // [v0.84.1 — 오너 보고 "장기간 미체결 자동취소 디코로 안 옴"] 실사용 기록을 직접 확인한
        //   결과, 타임아웃 취소는 거의 전부 이 경로로 들어오고 있었다 — watchAndBracket(살아있는
        //   감시)이 취소를 요청한 바로 뒤에 앱이 재시작돼, 그 감시가 끝까지 못 보고 죽고,
        //   다음 틱에서 "재시작 후 재확인" 경로(여기)가 뒤늦게 "취소됨"을 발견하는 흐름이었다.
        //   v0.84.0은 "재시작 없이 살아있는 감시"(onAutoBracketResolved)만 고쳐서, 실제로 가장
        //   흔한 이 경로는 빠져 있었다 — 늦게라도 여기서 알린다. 감시시간을 이미 넘겼으면
        //   (아래 else-if와 같은 기준) 거의 확실히 타임아웃이 원인이라 그렇게 알리고, 아직 안
        //   지났는데 취소된 경우는(드묾 — 오너가 재시작 직전에 직접 취소했을 가능성) 원인을
        //   단정하지 않는다.
        if (o.status === "cancelled") {
          const likelyTimeout = Date.now() - pos.enteredAtMs > this.autoTradeWatchMinutes * 60_000;
          void this.sendDiscordAlert(
            likelyTimeout
              ? `⏱ **미체결 자동취소**: ${pos.symbol} — 감시시간(${this.autoTradeWatchMinutes}분)이 지나 매수 주문이 취소된 것을 뒤늦게(앱 재시작 중) 확인했습니다.`
              : `**매수 주문 취소 확인**: ${pos.symbol} — 앱 재시작 중 주문이 취소된 상태로 확인됐습니다(사유 불명확).`,
          );
        } else {
          void this.sendDiscordAlert(`⚠️ **매수 주문 실패**: ${pos.symbol} — 앱 재시작 중 확인한 결과 주문이 실패 상태였습니다.`);
        }
        this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, {
          status: "closed_manual",
          exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
          note: `재시작 후 재확인 — 매수 주문이 ${o.status === "cancelled" ? "취소" : "실패"}로 확인됨`,
        });
      } else if (!this.isDryRun() && Date.now() - pos.enteredAtMs > (this.autoTradeWatchMinutes + 2) * 60_000) {
        // [v0.69.3 긴급 — 오너 보고 "매수주문이 들어갔는데 봇 화면에선 사라지고 토스엔 취소 안 된 채 남아 있다(예전부터 종종)"]
        //   원인 ①: 감시시간(미체결 자동취소)을 지키는 코드는 앱이 켜져 있는 동안의 빠른 감시(watchAndBracket) 안에만 있었다. 앱이 재시작되면(자동 업데이트
        //   포함) 이 복구 경로가 이어받는데, 여기엔 "체결됐나/취소됐나" 확인만 있고 **시간이 지나면 취소하는 로직이 없어** 미체결 주문이 장 마감까지 남았다.
        //   → 감시시간(+2분)이 지났는데 아직 안 끝났으면 여기서 취소를 요청한다(취소 결과는 다음 사이클 확인이 filled·부분체결·cancelled 별로 처리).
        try {
          await this.inflight(`주문 취소 ${pos.symbol}`, () => cancelOrder(pos.buyOrderId as string));
          this.addJournal({
            kind: "info", symbol: pos.symbol,
            summary: `⏱ ${pos.symbol}: 감시시간(${this.autoTradeWatchMinutes}분)이 지나도 미체결인 매수 주문(앱 재시작 등으로 놓친 건)을 취소 요청했습니다 — 다음 확인 때 결과를 처리합니다.`,
            notify: true, notifyTitle: `⏱ 미체결 주문 취소 요청: ${pos.symbol}`,
          });
          // [v0.84.0] 이 분기는 조건 자체가 "감시시간을 넘겼다"(위 Date.now() 비교)라 늘 타임아웃
          //   사유다(사람이 직접 취소한 거면 이 재시작-복구 루프가 아니라 다른 경로로 끝났을 것).
          void this.sendDiscordAlert(`⏱ **미체결 자동취소**: ${pos.symbol} — 감시시간(${this.autoTradeWatchMinutes}분)이 지나도 체결되지 않아 취소를 요청했습니다(앱 재시작 중 놓쳤던 주문).`);
        } catch (e) {
          this.addJournal({
            kind: "info", symbol: pos.symbol,
            summary: `⚠️ ${pos.symbol} 감시시간이 지난 미체결 매수 주문의 취소 요청이 실패했습니다(${String(e).replace(/^Error:\s*/, "").slice(0, 100)}) — 다음 사이클에 다시 시도합니다. [주문현황]에서 직접 취소할 수도 있습니다.`,
            notify: true, notifyTitle: `⚠️ 미체결 주문 취소 실패: ${pos.symbol}`,
          });
        }
      }
      // pending/partial/unknown이면 다음 사이클(최대 5분 뒤)에 다시 확인한다.
    }
  }

  // ==========================================================================
  // [v0.69.0 긴급] 보호 가드 — "체결됐는데 익절·손절 주문이 안 걸린 종목"을 봇이 끝까지 책임진다
  //   [원인 분석 — 그룹 기록 실사례]
  //     · WETO(카일, 10-07): 체결 후 가격이 감시가 밖이라 즉시 시장가 매도를 시도했으나 "매도 가능 수량 부족(422)" → 1회 실패로 포기.
  //     · QTEX(카일, 10-06): OCO 등록이 "감시 가격은 0으로 설정할 수 없습니다(400)"로 거부 → 포기.
  //     · WHLR·NAUT(카일): 진입 6분 뒤 조건주문이 토스에서 사라졌는데 주식은 82·87주 그대로 → 경고만 남기고 추적 종료.
  //     · AIB 등 "자동 취소 시도 실패".
  //     공통 결함: 실패하면 포지션을 추적에서 지우고 사람에게 떠넘겼다(주식은 무보호로 계좌에 남음).
  //   [수정] 실패한 종목을 autoUnprotected에 올리고, 30초마다(그리고 5분 사이클마다) 아래 순서로 보호가 걸릴 때까지 반복한다:
  //     ① 실계좌 보유 수량 확인(0이면 이미 팔린 것 → 종료) ② 이미 걸린 조건주문이 있으면 보호 확인 → 종료
  //     ③ 실제 매도 가능 수량만큼으로 OCO 재등록(현재가가 감시가 안일 때) / 밴드 밖이면 시장가 매도.
  //   자동매매 켜짐 여부와 무관하게 돈다(이미 가진 주식을 지키는 일이므로).
  // ==========================================================================
  /**
   * [v0.101.0] 오너가 토스에서 조건주문을 "직접 취소"한 게 확실할 때, 가드가 새 주문을 내기 전에
   *   기다려 주는 시간(2분). 이유: 오너가 가격을 바꾸려고 "취소 → 새 가격으로 다시 등록"을 하는
   *   중일 수 있는데, 예전엔 가드가 취소를 알아챈 지 3초 만에 "예전 가격"으로 조건주문을 스스로
   *   다시 걸었다 — 오너가 토스 앱에서 새 가격을 입력하는 데 보통 그보다 오래 걸리므로, 결과적으로
   *   ① 같은 종목에 조건주문이 두 개 걸리거나 ② Capri는 봇이 건(오너가 원치 않은) 주문만 추적하게
   *   됐다. 2분 동안은 "오너가 새로 건 조건주문이 있나"만 확인하고(있으면 그대로 추적 복원),
   *   2분이 지나도 없으면 그때 예전처럼 가드가 보호한다. (조건주문이 원인 모르게 "사라진" 경우·
   *   OCO 등록 실패 등 다른 경로는 지금처럼 즉시 보호 — 그쪽은 오너가 손대는 중이 아니므로.)
   */
  static readonly OWNER_REREGISTER_GRACE_MS = 120_000;

  private registerUnprotected(pos: AutoPosition, reason: string, graceMs = 0): void {
    const sym = pos.symbol.toUpperCase();
    if (this.autoUnprotected.some((u) => u.symbol === sym)) return;
    if ((this.guardDismissed[sym] ?? 0) > Date.now()) return; // [v0.69.4] 오너가 직접 관리하겠다고 한 종목
    this.autoUnprotected.push({
      symbol: sym, entry: pos.entry, tp: pos.tp, sl: pos.sl, quantity: pos.quantity, enteredAtMs: pos.enteredAtMs, fillPrice: pos.fillPrice ?? null,
      reason, sinceMs: Date.now(), attempts: 0, lastAttemptMs: null, lastError: null,
      graceUntilMs: graceMs > 0 ? Date.now() + graceMs : null,
    });
    this.saveAutoPositions();
    // [v0.101.0] 유예가 있으면 안내 문구도 그에 맞게 — "바로 다시 건다"고 알려 놓고 2분 기다리면 오너가 헷갈린다.
    const graceMin = Math.round(graceMs / 60_000);
    const plan = graceMs > 0
      ? `토스에서 직접 다시 거시는 중이면 그 주문을 그대로 이어서 추적합니다. ${graceMin}분 안에 새 조건주문이 없으면 봇이 예전 가격으로 보호를 다시 겁니다.`
      : "봇이 보호가 걸릴 때까지 계속 다시 시도합니다.";
    this.addJournal({
      kind: "info", symbol: sym,
      summary: `🛡 ${sym}: 보호주문이 없는 채로 보유 중입니다(${reason}) — ${plan}`,
      notify: true, notifyTitle: `🛡 보호 복구 시작: ${sym}`,
    });
    // [v0.82.0] 최종 결과(runGuard의 done)뿐 아니라 "지금부터 재시도 시작"도 디스코드로 —
    //   오너가 앱을 안 보고 있어도 가장 이른 시점에 알 수 있게(OS 알림은 앱을 안 보면 못 봄).
    void this.sendDiscordAlert(`🛡️ **보호 필요**: ${sym} — 보호주문이 없는 채로 보유 중입니다(${reason}). ${plan}`);
    // 유예 중에도 3초 뒤 첫 점검은 그대로 돈다 — 오너가 이미 새 조건주문을 걸어 뒀으면 그걸 바로 찾아 복원하기 위해서다
    //   (유예는 "새 주문을 내지 않는다"는 뜻이지 "들여다보지도 않는다"는 뜻이 아니다).
    this.scheduleGuard(3000);
  }

  /**
   * [v0.69.4 — 오너 요청 "손절 조건주문을 직접 취소하고 익절 매도만 걸어 둘 때가 있는데, 보호 가드가 계속 조건주문을 시도한다 — 보호주문을 취소할 수 있는 버튼이 필요"]
   *   보호 대기 목록에서 종목을 빼고, 일정 시간(기본 12시간) 동안 가드·감사가 그 종목을 다시 올리지 않게 한다. 토스의 주문은 건드리지 않는다(봇의 재시도만 멈춤).
   */
  dismissUnprotected(symbol: string, hours = 12): { ok: boolean; message: string } {
    const sym = String(symbol).toUpperCase();
    const had = this.autoUnprotected.some((u) => u.symbol === sym);
    this.autoUnprotected = this.autoUnprotected.filter((u) => u.symbol !== sym);
    this.guardDismissed[sym] = Date.now() + Math.max(1, hours) * 3600_000;
    this.saveAutoPositions();
    this.addJournal({
      kind: "info", symbol: sym,
      summary: `🛡 ${sym} 보호 복구를 오너가 중단했습니다(직접 관리) — ${hours}시간 동안 봇이 이 종목에 보호주문을 다시 걸지 않습니다. 토스의 기존 주문은 그대로입니다.`,
    });
    void this.pushLiveState(true);
    return { ok: true, message: had ? `${sym} 보호 복구를 중단했습니다(${hours}시간).` : `${sym}은(는) 보호 대기 목록에 없었지만 ${hours}시간 동안 자동 보호 대상에서 제외했습니다.` };
  }

  /** 토스 미체결 목록에서 이 자동매매 포지션의 매수 주문(같은 종목·같은 지정가·봇이 낸 brk 주문)을 찾는다. */
  private async findOpenAutoBuyOrder(pos: AutoPosition): Promise<string | null> {
    const open = await this.openOrders();
    const hit = open.find(
      (o) =>
        o.side === "BUY" &&
        String(o.symbol ?? "").toUpperCase() === pos.symbol.toUpperCase() &&
        String(o.clientOrderId ?? "").startsWith(`brk${pos.symbol.toUpperCase()}`) &&
        Math.abs((o.price ?? 0) - pos.entry) < 1e-6,
    );
    return hit?.tossOrderId ?? null;
  }

  /**
   * [v0.69.3] 독립 감사 — 봇이 낸 매수 주문이 토스에 미체결로 남아 있는데 봇이 더 이상 추적하지 않는 "고아 주문"을 찾아 취소한다.
   *   봇의 주문임을 확인하는 법: 자동매매 기록(history)의 buyOrderId에 있는 번호(수동 브라켓 주문은 여기 없으므로 절대 건드리지 않는다).
   *   추적 중(autoTradePositions에 같은 buyOrderId)이면 건드리지 않는다. 어떤 경로로 고아가 생겼든 5분 안에 정리된다.
   */
  async auditOrphanBuyOrders(): Promise<number> {
    if (this.isDryRun() || this.killSwitch) return 0;
    let open: OrderResponse[];
    try {
      open = await this.openOrders();
    } catch {
      return 0;
    }
    const autoIds = new Set(this.autoTradeHistory.map((h) => h.buyOrderId).filter((x): x is string => !!x));
    const tracked = new Set(this.autoTradePositions.map((p) => p.buyOrderId).filter((x): x is string => !!x));
    let cancelled = 0;
    for (const o of open) {
      if (o.side !== "BUY" || !autoIds.has(o.tossOrderId) || tracked.has(o.tossOrderId)) continue;
      try {
        await this.inflight(`고아 주문 취소 ${o.symbol ?? ""}`, () => cancelOrder(o.tossOrderId));
        cancelled++;
        this.addJournal({
          kind: "cancel", symbol: o.symbol ?? "-",
          summary: `🧹 ${o.symbol ?? ""} 봇이 낸 매수 주문(${o.tossOrderId.slice(0, 8)}…)이 토스에 미체결로 남아 있는데 봇은 추적하지 않아 취소했습니다(고아 주문 정리).`,
          notify: true, notifyTitle: `🧹 고아 주문 취소: ${o.symbol ?? ""}`,
        });
      } catch (e) {
        this.addJournal({
          kind: "info", symbol: o.symbol ?? "-",
          summary: `⚠️ ${o.symbol ?? ""} 추적되지 않는 미체결 매수 주문의 취소가 실패했습니다(${String(e).replace(/^Error:\s*/, "").slice(0, 100)}) — [주문현황]에서 직접 취소해 주세요.`,
          notify: true, notifyTitle: `⚠️ 고아 주문 취소 실패: ${o.symbol ?? ""}`,
        });
      }
    }
    return cancelled;
  }

  /**
   * [v0.69.1 긴급 — 오너 지시 "매도 주문 안 거는 문제 전수 확인"] 보호 가드 입구가 몇 개 있어도(OCO 실패·조건주문 소멸…) 예상 못 한 틈이
   *   생기면 또 새어 나간다. 그래서 경로와 무관하게 "결과"를 직접 대조하는 독립 감사를 둔다:
   *     실계좌 보유 종목 중 ① 최근 3일 안에 이 봇이 진입한 기록이 있고 ② 지금 추적 중(감시·보호·가드 대기)이 아니며
   *     ③ 토스에 살아 있는 조건주문(OPEN)이 하나도 없는 종목 → 가드 대기 목록에 올린다.
   *   [안전장치] 봇이 산 적 없는 종목(수동 보유)은 절대 건드리지 않는다. 확인(보유·조건주문 조회)이 하나라도 실패하면 아무것도 안 한다.
   *   "조건주문이 사라진 보유 종목 자동 재보호" 설정을 끄면 이 감사도 함께 꺼진다(사람이 직접 보호를 풀어 둔 경우를 존중).
   *
   *   [v0.80.0 — 긴급 수정, 실계좌 오매도 사고] reflectUnknownHoldings(v0.78.0, "Capri가
   *   모르는 보유종목 참고용 기록")가 남긴 기록(reflectedOnly: true)을 "봇이 산 기록"으로
   *   착각해, Capri가 산 적도 없는 종목(국내종목 포함)을 보호 대상으로 올리고 runGuard가
   *   기본 손절%로 실제 매도까지 내보내는 사고가 있었다(2026-10-12, 하이닉스·필옵틱스·
   *   아이온큐). 아래 mine 조회에서 reflectedOnly 기록은 반드시 제외해야 한다 — 이게
   *   "수동 보유는 절대 건드리지 않는다"는 위 안전장치의 실제 구멍이었다.
   */
  async auditUnprotectedHoldings(): Promise<number> {
    if (!this.autoReprotectVanished || this.isDryRun()) return 0;
    let held: Array<[string, number]>;
    let openSyms: Set<string>;
    try {
      const h = (await getHoldings()) as Record<string, unknown>;
      held = [];
      for (const it of (h?.items as Array<Record<string, unknown>>) ?? []) {
        const q = Number(it.quantity);
        const sym = String(it.symbol ?? "").toUpperCase();
        if (sym && Number.isFinite(q) && q > 0) held.push([sym, q]);
      }
      const open = await listConditionalOrders("OPEN");
      openSyms = new Set(open.map((o) => String(o.symbol ?? "").toUpperCase()));
    } catch {
      return 0; // 확인 못 하면 손대지 않는다
    }
    const tracked = new Set<string>([...this.autoTradePositions.map((p) => p.symbol.toUpperCase()), ...this.autoUnprotected.map((u) => u.symbol)]);
    const cutoff = Date.now() - 3 * 24 * 3600_000;
    let added = 0;
    for (const [sym, qty] of held) {
      if (tracked.has(sym) || openSyms.has(sym)) continue;
      if ((this.guardDismissed[sym] ?? 0) > Date.now()) continue; // [v0.69.4] 오너가 직접 관리 중
      const mine = this.autoTradeHistory
        .filter((e) => e.symbol.toUpperCase() === sym && Number(e.id.split("@")[2]) >= cutoff && e.status !== "dryrun" && !e.reflectedOnly)
        .sort((a, b) => Number(b.id.split("@")[2]) - Number(a.id.split("@")[2]))[0];
      if (!mine) continue; // 봇이 산 적 없는 종목(reflectUnknownHoldings의 참고 기록 포함) — 수동 보유는 건드리지 않는다
      if (mine.status === "closed_win" || mine.status === "closed_loss") continue; // 정상 청산 기록이 있으면 그 이후 새로 산 게 아닌 한 대상 아님
      this.registerUnprotected(
        { symbol: sym, entry: mine.entry, tp: mine.tp, sl: mine.sl, quantity: qty, enteredAtMs: Number(mine.id.split("@")[2]), status: "active", conditionalOrderId: null },
        "감사: 실계좌에 보유 중인데 익절/손절 조건주문이 없음",
      );
      added++;
    }
    return added;
  }

  /**
   * [v0.98.0 — 오너 지시 "자동매매 종목에 추가매수를... 토스에서 직접 진행할 경우 카프리에
   *   실시간 반영이 안되고있음"] reconcileAutoPositions는 조건주문이 "살아있나/끝났나"만
   *   재확인하고, 보유 "수량"은 전혀 재확인하지 않았다 — 오너가 보호주문이 이미 걸린 종목에
   *   토스에서 직접 추가 매수하면, Capri의 기록(quantity)은 그대로 멈춰 있어 현황·기록 화면과
   *   실계좌가 어긋난다. 게다가 늘어난 수량은 "기존에 걸어 둔 OCO"에 애초에 포함돼 있지
   *   않으므로(OCO는 등록 당시 수량으로 고정) 실제로는 무보호 상태인데도, auditUnprotectedHoldings는
   *   이 종목이 이미 "추적 중 + 조건주문 있음"이라 건너뛴다(그게 그 함수의 정상 동작) — 그래서
   *   추가매수분은 어떤 감사에도 안 걸리는 완전한 사각지대였다.
   *   [범위] 이 함수는 "반영"(기록을 실계좌 기준으로 맞춤)까지만 한다. 늘어난 수량을 자동으로
   *   새 OCO에 편입하는 건 하지 않는다 — 조건주문 자체를 취소·재등록하는 일은 이미 걸려 있는
   *   보호를 순간적으로 벗기는 위험한 작업이라, 오너가 "실시간 반영"이라고 명시한 요청 범위를
   *   넘어선다(사람이 직접 토스에서 처리할 수 있게 강한 알림만 남긴다 — 안전 규칙: 신규 주문·
   *   조건주문 변경은 명시적 요청 없이 이 함수가 대신 결정하지 않는다).
   *   수량이 줄어든 경우(오너가 토스에서 직접 일부만 매도)는 위험 신호가 아니라 단순 반영이라
   *   조용한 수준의 알림만 남긴다.
   */
  async auditActivePositionQuantities(): Promise<number> {
    if (this.isDryRun()) return 0;
    const active = this.autoTradePositions.filter((p) => p.status === "active" && p.conditionalOrderId);
    if (active.length === 0) return 0;
    let held: Map<string, number>;
    try {
      const h = (await getHoldings()) as Record<string, unknown>;
      held = new Map<string, number>();
      for (const it of (h?.items as Array<Record<string, unknown>>) ?? []) {
        const q = Number(it.quantity);
        const sym = String(it.symbol ?? "").toUpperCase();
        if (sym && Number.isFinite(q)) held.set(sym, q);
      }
    } catch {
      return 0; // 확인 못 하면 손대지 않는다(섣부른 판단 금지 — 기존 감사 함수들과 같은 원칙)
    }
    let changed = 0;
    for (const pos of active) {
      const sym = pos.symbol.toUpperCase();
      const realQty = held.get(sym) ?? 0;
      // realQty<=0(보유가 통째로 사라짐)은 이 함수의 영역이 아니다 — reconcileAutoPositions가
      //   조건주문 발동/소멸 조회로 이어서 정확히 처리한다(여기서 손대면 그 경로와 중복·충돌).
      if (realQty <= 0 || realQty === pos.quantity) continue;
      const idx = this.autoTradePositions.findIndex((p) => p === pos);
      if (idx === -1) continue;
      const prevQty = pos.quantity;
      // [v0.101.0] 보유 수량만 바꾸고 "조건주문이 덮는 수량"(protectedQty)은 그대로 기억해 둔다 —
      //   예전엔 quantity 하나만 덮어써서, 익절/손절이 나간 뒤 "추가매수분이 남았다"는 사실 자체를
      //   알 방법이 없었다(남은 주식이 영영 무보호로 방치되던 원인). 줄어든 경우엔 보유보다 많이
      //   보호할 수는 없으니 보유 수량으로 낮춘다.
      const prevProtected = pos.protectedQty ?? prevQty;
      const protectedQty = Math.min(prevProtected, realQty);
      this.autoTradePositions[idx] = { ...pos, quantity: realQty, protectedQty };
      this.saveAutoPositions();
      const grew = realQty > prevQty;
      const note = grew
        ? `실계좌 보유 수량이 ${prevQty}주→${realQty}주로 늘었습니다(토스에서 직접 추가매수한 것으로 보임) — ⚠️ 늘어난 ${realQty - prevQty}주는 기존 익절/손절 조건주문에 포함돼 있지 않아 보호되지 않습니다. 보호하려면 토스에서 조건주문을 다시 걸어 주세요${this.autoReprotectVanished ? "(그대로 두면 익절/손절 후 남는 수량을 보호 가드가 이어서 처리합니다)" : ""}.`
        : `실계좌 보유 수량이 ${prevQty}주→${realQty}주로 줄었습니다(토스에서 직접 일부 매도한 것으로 보임) — 기록만 실계좌 기준으로 맞췄습니다.`;
      this.updateAutoTradeHistory(pos.symbol, pos.entry, pos.enteredAtMs, { quantity: realQty, note });
      this.addJournal({
        kind: "info", symbol: pos.symbol,
        summary: `🔁 ${pos.symbol} ${note}`,
        notify: true,
        notifyTitle: grew ? `⚠️ 추가매수 감지(무보호 수량 있음): ${pos.symbol}` : `🔁 보유 수량 변경 감지: ${pos.symbol}`,
      });
      if (grew) void this.sendDiscordAlert(`⚠️ **추가매수 감지**: ${pos.symbol} — ${note}`);
      changed++;
    }
    return changed;
  }

  // ==========================================================================
  // [v0.87.0] 자동 업데이트 재시작 정책 — 오너 확정(2026-10-13, 재논의 대상 아님): 자동매매·보유 포지션이 있어도 업데이트를 적용하고 재시작한다.
  //   미루는 순간은 딱 두 곳: ① 주문 전송 후 응답을 못 받은 구간(in-flight) ② 매수 체결 확인 ~ OCO 등록 완료 전(+가드가 주문 내는 중).
  //   (v0.86.0은 "자동매매 중에도 재시작 + 자동 재개"까지만 했고 이 두 구간을 구분하지 않았다 — 체결~OCO 등록 사이에 죽으면 보호 없는 포지션이 생길 수 있었다.)
  //   근거·규칙: lib/update-policy.ts, CLAUDE.md "업데이트 정책".
  // ==========================================================================
  private restartBlockers = new Map<number, RestartBlocker>();
  private restartBlockerSeq = 0;
  /** true면 새 주문 전송을 막는다(재시작 직전 몇 초) — 방금 확인한 "안전한 순간"에 새 주문이 끼어들지 못하게. */
  private restartFrozen = false;

  private addRestartBlocker(kind: RestartBlocker["kind"], label: string): number {
    const id = ++this.restartBlockerSeq;
    this.restartBlockers.set(id, { kind, label, sinceMs: Date.now() });
    return id;
  }
  private removeRestartBlocker(id: number): void {
    this.restartBlockers.delete(id);
  }

  /** 주문 전송(응답 받을 때까지)을 in-flight로 표시한다. 재시작 직전(frozen)이면 새 주문을 시작하지 않는다. */
  private async inflight<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.restartFrozen) throw new Error("앱 업데이트 재시작 직전이라 주문을 잠시 보류했습니다(몇 초 뒤 자동으로 다시 시도됩니다).");
    return this.windowGuard("inflight", label, fn);
  }
  private async windowGuard<T>(kind: RestartBlocker["kind"], label: string, fn: () => Promise<T>): Promise<T> {
    const id = this.addRestartBlocker(kind, label);
    try {
      return await fn();
    } finally {
      this.removeRestartBlocker(id);
    }
  }

  /** 지금 재시작해도 되는가(데스크톱 main이 호출). 막는 구간이 있으면 그 이름과 함께 돌려준다. */
  getRestartDecision(): ReturnType<typeof evaluateRestart> {
    return evaluateRestart([...this.restartBlockers.values()], Date.now());
  }
  setRestartFrozen(on: boolean): void {
    this.restartFrozen = on;
  }

  private restartMarkerPath(): string {
    return join(this.userDataDir, "kylebot-restart-record.json");
  }

  /**
   * [재시작 직전] main.ts의 tryApplyUpdate가 안전한 순간을 확인한 뒤 부른다.
   *   ① 자동매매 재개 표시(v0.86.0 prepareForUpdateRestart — 그대로 재사용) ② 포지션·기록·보호 대기를 디스크에 저장
   *   ③ "재시작 기록" 표식 저장(이전/새 버전·당시 포지션 — 재시작 후 기록과 대조에 쓴다) ④ 저널 + 디스코드에 기록(전송 완료까지 기다림).
   */
  async prepareForRestart(info: { toVersion?: string | null }): Promise<RestartMarker> {
    this.prepareForUpdateRestart();
    this.saveAutoPositions();
    this.persistAutoTradeHistory();
    const marker: RestartMarker = {
      atMs: Date.now(),
      fromVersion: this.appVersion ?? "?",
      toVersion: info.toVersion ?? null,
      autoTradeWasOn: this.autoTradeEnabled,
      positions: this.autoTradePositions.map((p) => ({ symbol: p.symbol, status: p.status, quantity: p.quantity })),
      unprotected: this.autoUnprotected.map((u) => u.symbol),
    };
    try {
      writeFileSync(this.restartMarkerPath(), JSON.stringify(marker, null, 2), "utf8");
    } catch {
      /* 표식 저장 실패 — 재시작은 계속(복구는 포지션 파일과 5분 사이클이 이어받는다) */
    }
    const line = `🔄 업데이트 적용을 위해 재시작합니다 — v${marker.fromVersion} → v${marker.toVersion ?? "새 버전"} · 자동매매 ${marker.autoTradeWasOn ? "켜짐(재시작 후 자동으로 다시 켭니다)" : "꺼짐"} · 보유/대기 ${marker.positions.length}종목${marker.positions.length ? " (" + marker.positions.map((p) => `${p.symbol} ${p.quantity}주 ${p.status === "active" ? "보호중" : "매수대기"}`).join(", ") + ")" : ""}`;
    this.addJournal({ kind: "info", symbol: "-", summary: line });
    await Promise.race([this.sendDiscordAlert(line), new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined);
    // [v0.90.0] 디바운스 중인 모든 저장(저널·포지션·기록 등)을 재시작 직전에 지금 당장 동기로 확정한다 —
    //   프로세스가 몇 초 뒤 죽으므로 300ms 디바운스 타이머가 돌 기회가 없을 수 있다.
    this.flushAllFileSavesSync();
    return marker;
  }

  /**
   * [재시작 직후] 표식이 있으면 한 번만: ①이전/새 버전 기록 ②실계좌 보유↔등록 OCO **대조(reconcile)** ③보호 없는 종목 즉시 재보호(독립 감사 + 가드)
   *   ④기록(저널 + 디스코드). 자동매매 자동 재개는 생성자(v0.86.0)가 이미 했다 — 여기선 그 결과를 확인해 기록한다.
   *   토스 연결이 아직이면 "pending"(호출부가 15초 뒤 다시 부른다).
   */
  async resumeAfterRestart(): Promise<"none" | "pending" | "done" | "expired"> {
    const path = this.restartMarkerPath();
    if (!existsSync(path)) return "none";
    let marker: RestartMarker;
    try {
      marker = JSON.parse(readFileSync(path, "utf8")) as RestartMarker;
    } catch {
      try { renameSync(path, path + ".bad"); } catch { /* 무시 */ }
      return "none";
    }
    const drop = () => { try { renameSync(path, path + ".done"); } catch { /* 무시 */ } };
    if (!isMarkerFresh(marker, Date.now())) {
      drop();
      this.addJournal({ kind: "info", symbol: "-", summary: "🔄 오래된 재시작 기록 표식을 무시했습니다(30분 초과)." });
      return "expired";
    }
    try {
      await this.prepareBackend();
      this.assertAccountReady();
      await getBuyingPower("USD"); // 토스 연결·인증 확인(실패하면 아직 준비 안 된 것)
    } catch {
      return "pending";
    }
    const line = describeRestart(marker, this.appVersion ?? "?");
    await this.reconcileAutoPositions().catch(() => undefined); // 실계좌 보유 ↔ 등록 OCO 대조
    await this.auditUnprotectedHoldings().catch(() => 0); // 보호 없는 종목 찾기
    await this.auditActivePositionQuantities().catch(() => 0); // [v0.98.0] 재시작으로 멈춰 있던 동안의 추가매수도 복구 시점에 반영
    if (this.autoUnprotected.length > 0) this.scheduleGuard(1000); // → 가드가 즉시 재보호
    drop();
    const resumed = marker.autoTradeWasOn && this.autoTradeEnabled;
    const tail = marker.autoTradeWasOn ? (resumed ? "자동매매가 다시 켜져 이어서 돌고 있습니다." : "⚠️ 자동매매가 켜져 있었는데 지금 꺼져 있습니다 — 확인해 주세요.") : "자동매매는 꺼져 있었으므로 그대로 둡니다.";
    const summary = `✅ 재시작 복구 완료 — ${tail} 실계좌↔조건주문 대조${this.autoUnprotected.length ? `, 보호 복구 중 ${this.autoUnprotected.length}종목(${this.autoUnprotected.map((u) => u.symbol).join(", ")})` : " 이상 없음"}.`;
    this.addJournal({ kind: "info", symbol: "-", summary: `${line}\n${summary}`, notify: true, notifyTitle: "🔄 업데이트 재시작 완료" });
    await Promise.race([this.sendDiscordAlert(`${line}\n${summary}`), new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined);
    return "done";
  }

  private scheduleGuard(delayMs: number): void {
    if (this.guardTimer || this.autoUnprotected.length === 0) return;
    // [v0.69.1] 점검 도중 예외(저장 실패 등)가 처리되지 않은 프라미스 거부로 새어 앱/테스트를 흔들지 않게 막고, 타이머가 프로세스 종료를 붙잡지 않게 한다.
    this.guardTimer = setTimeout(() => { this.guardTimer = null; void this.runGuard().catch(() => {}); }, delayMs);
    (this.guardTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 한 번의 가드 점검. 남은 종목이 있으면 다음 점검을 예약한다. */
  async runGuard(): Promise<void> {
    if (this.guardBusy || this.autoUnprotected.length === 0) return;
    this.guardBusy = true;
    const guardToken = this.addRestartBlocker("guard", "보호 가드 점검(보호주문·시장가 매도 가능)"); // [v0.70.0]
    try {
      if (this.isDryRun()) return; // 드라이런엔 실제 보유가 없다
      await this.prepareBackend();
      const held = new Map<string, number>();
      try {
        const h = (await getHoldings()) as Record<string, unknown>;
        for (const it of (h?.items as Array<Record<string, unknown>>) ?? []) {
          const q = Number(it.quantity);
          if (Number.isFinite(q)) held.set(String(it.symbol ?? "").toUpperCase(), q);
        }
      } catch {
        return; // 보유를 확인할 수 없으면 아무것도 하지 않는다(눈 감고 팔지 않음) — 다음 점검에서 재시도
      }
      let open: ConditionalOrderResponse[] | null = null;
      try { open = await listConditionalOrders("OPEN"); } catch { open = null; }
      // [v0.69.4] 오너가 손절을 빼고 익절 지정가 매도만 걸어 둔 경우 — 그 매도가 주식을 잡고 있어 OCO는 계속 "매도 가능 수량 부족"으로 실패한다.
      //   토스에 이 종목의 미체결 SELL 주문이 있으면 오너가 직접 관리하는 것으로 보고 보호 대기를 해제한다(손절이 없다는 경고는 저널에 남긴다).
      let openSellSyms: Set<string> | null = null;
      try {
        openSellSyms = new Set((await this.openOrders()).filter((o) => o.side === "SELL").map((o) => String(o.symbol ?? "").toUpperCase()));
      } catch {
        openSellSyms = null;
      }

      for (const u of [...this.autoUnprotected]) {
        // [v0.82.0 — 긴급, 오너 지적 "계속 매도하는데 디스코드 알림이 왜 안 오냐"] hist가
        //   있다는 건 실제로 뭔가 바뀌었다는 뜻(조건주문 재등록·시장가 매도·계좌에서 이미
        //   사라짐 확인 등) — 이런 결과는 OS 알림+디스코드로 반드시 즉시 알린다(오늘 사고
        //   때도 이 알림이 전혀 없어서 한참 뒤에야 알게 됐다). hist가 없는 경우("이미
        //   조건주문 걸려있음"/"오너가 직접 관리 중")는 아무 것도 안 바뀐 "확인만"이라
        //   조용히 넘어간다(알림 피로 방지).
        const done = (why: string, hist?: Partial<AutoTradeHistoryEntry>) => {
          this.autoUnprotected = this.autoUnprotected.filter((x) => x.symbol !== u.symbol);
          this.saveAutoPositions();
          this.addJournal({
            kind: "info", symbol: u.symbol, summary: `🛡 ${u.symbol} 보호 확인 — ${why}`,
            ...(hist ? { notify: true, notifyTitle: `🛡 보호 가드 결과: ${u.symbol}` } : {}),
          });
          if (hist) {
            this.updateAutoTradeHistory(u.symbol, u.entry, u.enteredAtMs, hist);
            void this.sendDiscordAlert(`🛡️ **보호 가드**: ${u.symbol} — ${why}`);
          }
        };
        const qtyHeld = held.get(u.symbol) ?? 0;
        if (qtyHeld <= 0) {
          // [v0.77.0 — task #111 "Capri가 모르는 매매 자동 반영"] 예전엔 추적만 지우고 매매기록은
          //   그대로 뒀다 — 오너가 토스 앱에서 이 종목을 직접 팔았을 수 있는데, 그러면 기록이
          //   "active"에 영원히 멈춰(손익도 영원히 null로 남아) 매매분석 통계를 왜곡한다. 실제
          //   체결가를 "추정"하려고 과거 매도 주문들을 뒤져 짜맞추는 건 엉뚱한 주문을 집어 잘못된
          //   손익을 지어낼 위험이 있어(이 API는 체결 시각을 안 줘 어느 매도가 이 포지션 건지
          //   확실히 구분할 길이 없음) — 숫자를 지어내는 대신, 최소한 "끝났다"는 사실만 정직하게
          //   기록해 통계에서 최소한 "아직 진행 중"으로 잘못 잡히는 것만 막는다(exitPrice/pnl은
          //   null로 남겨 "모른다"를 숨기지 않음 — 정확한 금액은 토스 앱에서 직접 확인).
          done("보유 수량이 없습니다(이미 매도됨) — 매매기록을 종료 처리합니다(정확한 체결가는 토스 앱에서 확인하세요)", {
            status: "closed_manual",
            exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
            exitPrice: null,
            pnlUsd: null,
            pnlPct: null,
            note: "보호 가드가 보유 수량 0을 확인 — 토스 앱 등에서 직접 매도된 것으로 보임(정확한 체결가·손익은 확인 불가, [주문현황]에서 직접 확인 가능)",
          });
          continue;
        }
        const alreadyOpen = open?.find((o) => String(o.symbol ?? "").toUpperCase() === u.symbol);
        if (alreadyOpen) {
          // [v0.98.0 — 오너 지시 "조건주문 취소하면 아예 빠져버리는데... 재주문 넣은거는 다시
          //   포함시켜야해, 로직 정확히해라"] 예전엔 여기서 done()을 hist 없이 불러 끝냈다 —
          //   보호 대기 목록(autoUnprotected)에서만 빠지고, autoTradePositions(현황판이 보는
          //   바로 그 배열)·매매기록 둘 다 끝까지 "closed_manual"에 머물렀다. 오너가 토스에서
          //   직접 조건주문을 다시 걸면(교체·재등록) 보호는 즉시 됐지만 Capri는 영원히 모른 채
          //   "자동매매 종목"에서 완전히 빠진 상태였다는 뜻 — 바로 아래 성공 분기(가드가 직접
          //   등록할 때, line ~9194)와 똑같은 방식으로, 발견한 그 주문을 그대로 받아 추적을
          //   복원한다. 수량은 기록이 아니라 지금 실계좌 보유(qtyHeld)를 그대로 쓴다 —
          //   "추가매수 후 재주문"처럼 그 사이 수량이 늘어 있었어도 그 늘어난 수량까지 정확히
          //   반영된다(이게 오너가 함께 지적한 추가매수 미반영 문제의 교차점).
          const legTp = alreadyOpen.first?.triggerPrice;
          const legSl = alreadyOpen.second?.triggerPrice;
          const tp = legTp != null && legTp > 0 ? legTp : u.tp;
          const sl = legSl != null && legSl > 0 ? legSl : u.sl;
          const qty = qtyHeld;
          // [v0.101.0] 보유 수량(qty)과 "그 조건주문이 실제로 덮는 수량"(ocoQty)을 따로 기록한다.
          //   오너가 일부 수량만 걸었으면 나머지는 무보호이고, 익절/손절 손익도 ocoQty로 계산해야 맞다.
          //   토스가 수량을 안 알려 주면(응답에 없음) 예전처럼 보유 수량 전체가 보호된다고 본다.
          const rawOcoQty = Number(alreadyOpen.quantity);
          const ocoQty = Number.isFinite(rawOcoQty) && rawOcoQty > 0 ? Math.min(rawOcoQty, qty) : qty;
          this.autoTradePositions.push({
            symbol: u.symbol, entry: u.entry, tp, sl, quantity: qty, enteredAtMs: u.enteredAtMs,
            status: "active", conditionalOrderId: alreadyOpen.conditionalOrderId,
            // [v0.101.0] 실제 체결가를 빠뜨리면 나중 손익이 주문가(entry) 기준으로 계산돼 어긋난다.
            fillPrice: u.fillPrice ?? null,
            protectedQty: ocoQty,
          });
          this.saveAutoPositions();
          const uncovered = qty - ocoQty;
          const coverNote = uncovered > 0 ? ` — ⚠️ 보유 ${qty}주 중 ${uncovered}주는 이 조건주문에 포함돼 있지 않아 보호되지 않습니다` : "";
          done(`오너가 토스에서 직접 건 익절/손절 조건주문을 발견해 자동매매 추적을 복원했습니다(보호 ${ocoQty}주, 익절 $${tp}/손절 $${sl})${coverNote}`, {
            status: "active", exitedAt: null, conditionalOrderId: alreadyOpen.conditionalOrderId, tp, sl, quantity: qty,
            note: `보호 가드가 오너가 토스에서 직접 등록(또는 교체)한 조건주문을 발견해 자동매매 추적을 복원함(보유 ${qty}주, 조건주문 ${ocoQty}주)${coverNote}`,
          });
          continue;
        }
        if (openSellSyms?.has(u.symbol)) {
          this.guardDismissed[u.symbol] = Date.now() + 12 * 3600_000;
          done("토스에 직접 건 매도 주문이 있어 오너가 관리 중인 것으로 보고 보호 대기를 해제합니다(손절 주문은 없으니 필요하면 직접 걸어 주세요)");
          continue;
        }
        // [v0.101.0] 오너가 조건주문을 직접 취소한 직후의 유예 시간 — 여기까지(보유 0 확인, 오너가 새로 건
        //   조건주문 발견, 직접 건 매도 주문 확인)는 그대로 하고, 새 주문을 내는 아래 단계만 미룬다.
        //   유예가 끝나면 다음 점검(30초 간격)에서 평소처럼 보호한다. 시도 횟수도 세지 않는다(실패가 아니므로).
        if (u.graceUntilMs != null && u.graceUntilMs > Date.now()) continue;

        u.attempts++;
        u.lastAttemptMs = Date.now();
        try {
          const sq = await this.sellableQty(u.symbol).catch(() => null);
          const qty = Math.floor(sq != null && Number.isFinite(sq) ? Math.min(qtyHeld, sq) : qtyHeld);
          if (qty <= 0) throw new Error("매도 가능 수량이 아직 0입니다(체결·정산 반영 대기)");
          const { price: cur } = await getPrice(u.symbol);
          // QTEX 실사례("감시 가격은 0으로 설정할 수 없습니다") — 기록된 감시가가 비정상(0 이하·역전)이면 진입가 기준 기본 익절/손절로 다시 계산한다.
          let tp = u.tp;
          let sl = u.sl;
          if (!(tp > 0 && sl > 0 && tp > sl)) {
            tp = roundPrice((u.fillPrice ?? u.entry) * (1 + this.defaultTpPct / 100));
            sl = roundPrice((u.fillPrice ?? u.entry) * (1 - this.defaultSlPct / 100));
            if (!(tp > 0 && sl > 0 && tp > sl)) throw new Error(`감시가를 계산할 수 없습니다(진입가 ${u.entry})`);
          }
          if (isWithinOcoBand(cur, tp, sl)) {
            const j = await this.placeOco({
              symbol: u.symbol, quantity: qty, tpTrigger: tp, tpPrice: tp, slTrigger: sl, slPrice: roundPrice(sl * 0.99),
              entry: u.fillPrice ?? u.entry, // [v0.69.2] 방향 검사만(가드는 보호가 최우선이라 설정 일치 검사는 하지 않는다)
              expireDate: this.autoTradeExpireDate(),
              rationale: { technique: "split3", source: "auto", level: 1, entry: u.entry, tp, sl, priceAtOrder: null },
            });
            const id = (j.detail as { conditionalOrderId?: string } | undefined)?.conditionalOrderId;
            if (!id) throw new Error("조건주문 번호를 확인할 수 없습니다.");
            // 다시 정상 추적(active)으로 올려 익절/손절 발동을 이어서 감시한다.
            // [v0.101.0] fillPrice(실제 체결가)·protectedQty(이 조건주문이 덮는 수량)도 함께 — 빠뜨리면 손익이 어긋난다.
            this.autoTradePositions.push({ symbol: u.symbol, entry: u.entry, tp, sl, quantity: qty, enteredAtMs: u.enteredAtMs, status: "active", conditionalOrderId: id, fillPrice: u.fillPrice ?? null, protectedQty: qty });
            done(`익절/손절 조건주문을 다시 등록했습니다(${qty}주)`, { status: "active", exitedAt: null, conditionalOrderId: id, note: "보호 가드가 익절/손절 조건주문을 복구 등록함" });
          } else {
            // 가격이 이미 감시가 밖 — 조건주문을 걸 수 없으니 지금 시장가로 정리한다.
            // [v0.75.0 — "애드밸류 감사" 중 발견: v0.73.0 AGRZ 수정(protectByMarketSell)과 같은
            //   부류의 버그가 이 경로에도 있었다] 시장가 주문 생성 응답은 체결가를 안 주는데,
            //   예전엔 "매도 직전 조회한 현재가(cur)"를 그대로 손익에 썼다 — AGRZ 때처럼 가격이
            //   급변하는 바로 그 상황(감시가 밖으로 튄 직후)이라 오차가 작지 않을 수 있다.
            //   protectByMarketSell과 똑같이 매도 주문번호로 실제 체결가를 직접 조회해 쓰고,
            //   못 받아오면 그때만 추정가로 폴백하며 그 사실을 기록에 남긴다. 손익 기준도
            //   u.entry(주문가)가 아니라 u.fillPrice(실제 체결가, 있으면)로 — line ~7694의
            //   costBasis 패턴과 통일.
            const sellEntry = await this.placeSell({ symbol: u.symbol, quantity: qty, orderType: "MARKET" });
            const sellOrderId = (sellEntry.detail as OrderResponse | undefined)?.tossOrderId ?? null;
            let exitPrice = cur;
            let exitPriceIsEstimate = true;
            if (sellOrderId) {
              for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, ToolEngine.BRACKET_FAST_POLL_MS));
                try {
                  const filled = await getOrder(sellOrderId);
                  if (filled.avg_filled_price != null && filled.avg_filled_price > 0) {
                    exitPrice = filled.avg_filled_price;
                    exitPriceIsEstimate = false;
                    break;
                  }
                } catch {
                  // 조회 실패는 다음 시도에서 재시도(아래 폴백이 있으므로 막지 않음)
                }
              }
            }
            const costBasis = u.fillPrice ?? u.entry;
            const pnlUsd = (exitPrice - costBasis) * qty;
            this.autoTradeRealizedPnlUsd += pnlUsd;
            done(`가격($${cur})이 감시가 밖이라 시장가로 매도했습니다(${qty}주)`, {
              status: pnlUsd >= 0 ? "closed_win" : "closed_loss", exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
              exitPrice, pnlUsd: Math.round(pnlUsd * 100) / 100, pnlPct: Math.round(((exitPrice - costBasis) / costBasis) * 10000) / 100,
              note: exitPriceIsEstimate
                ? "보호 가드가 시장가로 정리함(실제 체결가 조회 실패 — 매도 직전 조회한 추정가로 기록)"
                : "보호 가드가 시장가로 정리함(실제 체결가 확인 완료)",
            });
          }
        } catch (e) {
          u.lastError = String(e).replace(/^Error:\s*/, "");
          this.saveAutoPositions();
          // 알림은 1·5·20·50번째 실패에만(도배 방지)
          if ([1, 5, 20, 50].includes(u.attempts)) {
            this.addJournal({
              kind: "info", symbol: u.symbol,
              summary: `🚨 ${u.symbol} 보호 복구 ${u.attempts}번째 시도 실패: ${u.lastError} — 계속 시도합니다. 급하면 토스 앱에서 직접 익절/손절을 걸어 주세요.`,
              notify: true, notifyTitle: `🚨 보호 복구 실패(${u.attempts}회): ${u.symbol}`,
            });
          }
        }
      }
    } finally {
      this.removeRestartBlocker(guardToken);
      this.guardBusy = false;
      if (this.autoUnprotected.length > 0) this.scheduleGuard(this.guardIntervalMs);
      void this.pushLiveState(true);
    }
  }

  /** watchAndBracket이 끝난 뒤(체결→OCO등록/타임아웃/취소/실패) 자동매매 포지션 상태를 갱신한다. */
  private onAutoBracketResolved(symbol: string, entry: number, res: WatchAndBracketResult): void {
    const idx = this.autoTradePositions.findIndex((p) => p.symbol === symbol && p.entry === entry && p.status === "watching");
    if (idx === -1) return;
    const enteredAtMs = this.autoTradePositions[idx].enteredAtMs; // splice 전에 미리 꺼내 둔다(기록 갱신 키)
    // [v0.30.1] 이 감시가 끝났으니(성공이든 실패든) "지금 이 프로세스가 직접 감시 중" 표시를 지운다
    //   — reconcileAutoPositions의 재시작-복구 경로가 이미 끝난 걸 또 건드리지 않게(중복처리 방지).
    this.autoTradeActiveWatches.delete(`${symbol}@${entry}@${enteredAtMs}`);
    if (res.status === "oco_registered") {
      this.autoTradePositions[idx] = {
        ...this.autoTradePositions[idx], status: "active", conditionalOrderId: res.conditionalOrderId,
        ...(res.tp != null ? { tp: res.tp, sl: res.sl ?? this.autoTradePositions[idx].sl, fillPrice: res.fillPrice ?? null } : {}),
      };
      this.saveAutoPositions();
      this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
        status: "active", conditionalOrderId: res.conditionalOrderId,
        note: res.fillPrice != null ? `매수 체결 확인(실제 체결가 $${res.fillPrice}) — 익절/손절을 체결가 기준으로 다시 계산해 등록됨` : "매수 체결 확인 — 익절/손절(조건주문) 등록됨",
        ...(res.tp != null ? { tp: res.tp, sl: res.sl ?? this.autoTradePositions[idx].sl, fillPrice: res.fillPrice ?? null } : {}),
      });
      // [v0.32.0] 이 성공 경로는 그동안 저널에 한 줄도 안 남기고 있었다(실패 쪽만 남겼음) —
      //   "매수 체결 확인 → 보호주문 등록 완료"는 오너가 놓치면 안 되는 좋은 소식이라 추가한다.
      this.addJournal({
        kind: "info", symbol,
        summary: `🛡 ${symbol} 매수 체결 확인 — 익절/손절(조건주문) 등록 완료.`,
        notify: true,
        notifyTitle: `🛡 보호주문 등록: ${symbol}`,
      });
    } else if (res.status === "still_pending" || res.status === "timeout") {
      // [v0.69.1 긴급] "timeout"(자동 취소 요청 자체가 실패 — AIB 실사례)도 같은 취급: 주문이 토스에 살아 있어 나중에 체결될 수 있는데,
      //   예전엔 여기서 포지션을 지워 체결돼도 아무도 보호주문을 안 걸었다. 감시를 유지하면 reconcileAutoPositions(5분)가 이어받는다.
      // [v0.52.0] 취소가 아직 실제로 반영 안 된 상태(ALDX 실사례) — 절대 자리를 비우지 않는다.
      //   watchAndBracket 안에서 이미 저널·알림을 남겼으니 여기서는 아무것도 더 안 하고,
      //   포지션을 "watching" 그대로 둬서 다음 reconcileAutoPositions(5분 뒤)의
      //   orphanedWatching 경로가 buyOrderId로 다시 확인하게 넘긴다(autoTradeActiveWatches
      //   에서는 이미 빠졌으니 그 경로가 "재시작 후 복구"와 똑같이 집어 준다).
    } else {
      // 타임아웃/취소/실패/OCO등록실패 → 이 자리를 비운다(다음 사이클에 다시 채워질 수 있음).
      const droppedPos = this.autoTradePositions[idx];
      this.autoTradePositions.splice(idx, 1);
      // [v0.69.0 긴급] 체결은 됐는데 보호주문이 안 걸린 채 끝난 경우 — 자리만 비우고 잊어버리면 주식이 무보호로 남는다.
      //   가드 목록에 올려 보호가 걸릴 때까지 계속 다시 시도한다.
      if (res.status === "oco_failed") this.registerUnprotected(droppedPos, `보호주문 등록 실패: ${res.error}`);
      this.saveAutoPositions();
      const closedAt = DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss");
      if (res.status === "cancelled_by_timeout") {
        // [v0.29.0→v0.54.0] watchAndBracket이 스스로 감시시간 만료로 취소를 "요청했고 토스가
        //   실제로 CANCELED로 확인해 준" 경우만 — 진짜 "장시간 미체결" 사유.
        this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
          status: "cancelled", exitedAt: closedAt, note: "장시간 미체결로 자동 취소(다음 사이클에 새 후보로 대체)",
        });
        // [v0.84.0 — 오너 지시 "타임아웃 주문취소 시 해당 내용도 디코로 알림보내"] 이 분기는
        //   지금까지 OS 알림도 디스코드도 전혀 없는 완전한 공백이었다(매매기록을 직접 뒤지지
        //   않으면 알 방법이 없었음) — 보호 가드 알림(v0.82.0)과 같은 원칙으로 둘 다 추가한다.
        this.addJournal({
          kind: "info", symbol,
          summary: `⏱ ${symbol} 장시간 미체결로 매수 주문을 자동 취소했습니다(감시시간 ${this.autoTradeWatchMinutes}분 경과) — 다음 사이클에 새 후보로 대체될 수 있습니다.`,
          notify: true, notifyTitle: `⏱ 미체결 자동취소: ${symbol}`,
        });
        void this.sendDiscordAlert(`⏱ **미체결 자동취소**: ${symbol} — 감시시간(${this.autoTradeWatchMinutes}분) 동안 체결되지 않아 매수 주문을 취소했습니다.`);
      } else if (res.status === "cancelled") {
        // [v0.54.0 긴급 수정 — 오너 보고 "취소 시간 반영이 제대로 안 됨"] 감시 마감 전에 폴링
        //   도중 이미 취소/거부된 걸 발견한 경우 — 우리 타임아웃 로직이 취소한 게 아니라, 킬스위치·
        //   [주문현황]에서의 직접 취소 등 다른 경로로 먼저 끝난 것이다. 예전엔 이것도 "cancelled"로
        //   뭉뚱그려져 위와 똑같이 "장시간 미체결"로 잘못 기록됐다 — 이제 정직하게 구분해서 남긴다.
        this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
          status: "cancelled", exitedAt: closedAt,
          note: "설정한 감시시간이 되기 전에 이미 취소된 것을 확인했습니다(킬스위치 또는 [주문현황]에서 직접 취소했을 수 있음 — 장시간 미체결 자동취소가 아닙니다)",
        });
      } else if (res.status === "protected_by_market_sell") {
        // [v0.57.0] OCO 등록 자체가 불가능할 만큼 가격이 감시가를 넘어서 즉시 시장가로 정리한
        // 경우 — "실패"가 아니라 실제로 포지션이 청산된 것이므로 손익을 계산해 정확히 기록한다.
        // [2차 검토 수정] 부분체결이었을 수 있어 포지션의 원래 계획 수량이 아니라 실제로
        // 보호매도한 수량(res.quantity — watchAndBracket이 체결분만큼만 registerOcoForFilled에
        // 넘긴 값)으로 계산해야 한다.
        const pnlUsd = (res.exitPrice - entry) * res.quantity;
        const pnlPct = ((res.exitPrice - entry) / entry) * 100;
        this.autoTradeRealizedPnlUsd += pnlUsd;
        this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
          status: pnlUsd >= 0 ? "closed_win" : "closed_loss",
          exitedAt: closedAt,
          exitPrice: res.exitPrice,
          pnlUsd: Math.round(pnlUsd * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
          note: res.exitPriceIsEstimate
            ? "체결 직후 가격이 익절/손절 감시가를 이미 넘어서 OCO 등록이 불가능해, 즉시 시장가로 매도해 정리함(실제 체결가 조회 실패 — 매도 직전 추정가로 기록)"
            : "체결 직후 가격이 익절/손절 감시가를 이미 넘어서 OCO 등록이 불가능해, 즉시 시장가로 매도해 정리함",
        });
      } else if (res.status === "oco_failed") {
        this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
          status: "oco_failed", exitedAt: closedAt, note: `체결됐지만 보호주문 등록 실패 — 직접 확인 필요: ${res.error}`,
        });
      } else {
        // "failed"(주문 자체가 거부됨) — 사람이 취소한 건 아니지만 CANCELED와 성격이 같아(손익 미확정) closed_manual로 묶는다.
        this.updateAutoTradeHistory(symbol, entry, enteredAtMs, {
          status: "closed_manual", exitedAt: closedAt, note: "진입 주문이 실패로 처리됨",
        });
      }
    }
  }

  /**
   * [v0.32.0] 실계좌(토스) 보유 종목을 직접 조회해 "지금 실제로 몇 종목·어느 종목을 들고
   *   있는지"의 진실을 확인한다. `autoTradePositions`(로컬 파일)만 보고 판단하면, 오너가
   *   윈도우·맥북 등 **서로 다른 기기에서 각각 앱을 켜고 자동매매를 동시에 시작**했을 때
   *   각 기기가 서로의 존재를 몰라 같은 종목에 중복 진입하거나 설정한 최대 종목 수를 합쳐서
   *   넘어설 수 있다(각 기기의 로컬 파일은 자기 자신이 넣은 주문만 안다 — 매매기록 동기화는
   *   진입 "이후"에 15초 쓰로틀로 올라가므로, 두 기기가 같은 5분 사이클 안에서 거의 동시에
   *   판단하면 그 동기화조차 따라잡지 못한다). 반면 토스 보유 현황은 어느 기기에서 조회하든
   *   **하나의 실제 계좌 상태**이므로, 이걸 기준으로 삼으면 기기가 몇 대든 안전하다.
   *   조회 실패 시 null을 돌려주며, 호출부는 "확인 안 됨"을 "겹치는 게 없음"으로 착각하지
   *   않고 이번 사이클의 신규 진입을 보류한다(안전 우선 — 기존 포지션 재확인·청산은 계속됨).
   */
  private async fetchRealHeldSymbols(): Promise<Set<string> | null> {
    try {
      const h = (await getHoldings()) as Record<string, unknown>;
      const items = (h?.items as Array<Record<string, unknown>>) ?? [];
      const symbols = new Set<string>();
      for (const it of items) {
        const symbol = String(it.symbol ?? "").toUpperCase();
        const qty = Number(it.quantity);
        if (symbol && Number.isFinite(qty) && qty > 0) symbols.add(symbol);
      }
      return symbols;
    } catch {
      return null;
    }
  }

  /**
   * [v0.32.0→v0.39.0 버그 수정] "지금 자동매매 몫으로 채워진 자리 수".
   *   [v0.32.0 원안의 문제 — 오너 실사용 보고 2026-09-28 "거래를 아예 못하는중"] 예전엔 이 값을
   *   실계좌 전체 보유 종목 수(`realHeldSymbols.size`)로 계산했다 — "다른 기기가 넣은 종목도
   *   놓치지 않으려고" 넣은 값이었는데, 그 실계좌엔 자동매매와 전혀 상관없는 종목(오너가 예전에
   *   수동으로 사둔 것 등)도 섞여 있을 수 있다. 그런 기보유 종목까지 몽땅 "자동매매가 채운 자리"로
   *   잘못 세면, 오너의 최대 종목 수(기본 3) 설정을 실제 자동매매 진입 없이도 넘겨버려 `freeSlots`가
   *   영원히 0 이하가 되고 — 그러면 스캔조차 안 돌아 확정 종목이 계속 나와도 자동매매가 단 한 번도
   *   진입을 시도하지 못하는 채로 막혀버린다(오너가 겪은 증상 그대로).
   *   [수정] 이제 "자동매매 종목 수"는 오직 이 엔진이 직접 아는 자동매매 포지션(`autoTradePositions`
   *   — 이 기기가 넣었거나, 로그인 시 다른 기기의 기록을 받아온 것 포함, watching/active뿐)의
   *   개수만 센다. 기보유(자동매매와 무관한) 종목은 더 이상 최대 종목 수에 안 잡힌다.
   *   [남겨둔 안전장치] "이미 보유 중인 특정 종목에 또 진입하지 않기"(중복 매수 방지)는 여전히
   *   `autoTradeTick`의 `activeSymbols`(로컬 포지션 + 실계좌 보유)가 별도로 막는다 — 이건 "최대
   *   종목 수 한도"와는 다른 안전장치라 그대로 유지했다.
   */
  private effectiveActivePositionCount(): number {
    return this.autoTradePositions.length;
  }

  /**
   * [v0.45.0] autoTradeTick을 "발사 후 신경 안 씀"으로 돌리는 모든 자리(시작 즉시 1회, 5분 타이머)
   *   가 공용으로 쓴다 — 실행 중인 프라미스를 autoTradeTickPromise에 저장해 두면, 다른 경로
   *   (autoScanNow)가 "지금 마침 도는 중"을 만났을 때 그 자리에서 포기하지 않고 끝날 때까지
   *   기다렸다가 최신 결과를 돌려줄 수 있다(위 필드 주석 참고 — 이게 "시작 눌러도 스크리닝이
   *   안 도는 것처럼 보이던" 버그의 실제 원인이었다).
   */
  private runAutoTradeTick(): void {
    this.autoTradeTickPromise = this.autoTradeTick().finally(() => {
      this.autoTradeTickPromise = null;
    });
  }

  /**
   * 자동매매 한 사이클(시작 즉시 1회 + 이후 5분마다).
   *   [재진입 방지] 한 사이클이 오래 걸려도(스캔에 수십 초) 다음 타이머 틱과 겹치지 않게 막는다.
   *   [v0.60.0] forceScan=true는 오너가 [🔄 지금 새로고침]을 직접 눌렀을 때만 쓴다 — 자리가
   *   꽉 차 있어도 스캔 생략을 건너뛰고 실제로 다시 훑어 화면을 최신 상태로 갈아 끼운다(아래
   *   freeSlots 분기 주석 참고). 5분 정기 사이클은 항상 기본값(false)이라 기존 동작 그대로다.
   */
  private async autoTradeTick(forceScan = false): Promise<void> {
    if (!this.autoTradeEnabled || this.autoTradeTickBusy) return;
    this.autoTradeTickBusy = true;
    this.autoTradeLastCycleAt = DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss");
    this.autoTradeLastCycleAtMs = Date.now(); // [v0.29.0] 카운트다운은 문자열이 아니라 ms 기준으로 계산해야 정확함
    if (this.currentAutoRun) this.currentAutoRun.loopCount++; // [v0.62.1] 리포트: 사이클 실행 횟수
    try {
      await this.prepareBackend();
      await this.reconcileAutoPositions(); // ①빈자리 먼저 확인(같은 사이클 안에 채우기 위해) — 일시정지 중에도 계속
      await this.auditUnprotectedHoldings().catch(() => 0); // [v0.69.1] 경로와 무관하게 "보유인데 보호 없음"을 결과로 직접 대조
      await this.auditOrphanBuyOrders().catch(() => 0); // [v0.69.3] 봇이 낸 미체결 매수 주문이 추적에서 빠진 채 토스에 남는 고아 주문 정리
      await this.auditActivePositionQuantities().catch(() => 0); // [v0.98.0] 보호 중인 종목에 토스에서 직접 추가매수한 수량을 반영

      // [v0.44.0] 시스템 휴무 시간대(또는 휴장)면 신규 스캔·진입을 전부 건너뛴다. 기존에 이미
      //   체결된(익절/손절 등록된) 포지션은 위 reconcileAutoPositions가 계속 감시하므로 그대로 둔다
      //   — 이 검사는 오직 "새로 사는 것"만 막는다.
      const pauseStatus = this.getSystemPauseStatus();
      if (pauseStatus.paused) {
        if (!this.autoTradeWasPaused) {
          // 방금 막 일시정지 구간에 들어온 순간(전환 시점)에만: 아직 체결 안 된(watching) 자동매매
          //   진입 주문을 전량 취소한다("미체결 주문 전량 취소" 오너 요청). 이미 체결돼 익절/손절이
          //   걸린(active) 포지션은 절대 건드리지 않는다 — 보유 종목을 강제로 파는 게 아니다.
          const watching = this.autoTradePositions.filter((p) => p.status === "watching");
          let cancelled = 0;
          for (const p of watching) {
            const r = await this.cancelAutoPosition(p.symbol, p.entry, p.enteredAtMs).catch((e) => ({ ok: false, message: String(e) }));
            if (r.ok) cancelled++;
          }
          this.addJournal({
            kind: "info",
            symbol: "-",
            summary:
              `⏸ ${pauseStatus.reason} — 자동매매 신규 진입을 멈춥니다` +
              (cancelled > 0 ? ` (아직 체결 안 된 진입 주문 ${cancelled}건을 취소했습니다)` : "") +
              `. 이미 체결된 포지션의 익절/손절 감시는 계속됩니다.`,
            notify: true,
            notifyTitle: "⏸ 자동매매 일시정지",
          });
          this.autoTradeWasPaused = true;
        }
        this.autoTradeLastCycleSkipReason = { message: `${pauseStatus.reason} — 신규 진입만 멈춤(기존 포지션 감시는 계속)`, atMs: Date.now() };
        return;
      } else if (this.autoTradeWasPaused) {
        this.addJournal({ kind: "info", symbol: "-", summary: "▶ 휴무 시간대(또는 휴장)가 끝나 자동매매를 다시 정상 진행합니다." });
        this.autoTradeWasPaused = false;
      }

      // [v0.45.0 — 오너 요청 "매매진행할 장 선택"] 휴무 시간대와는 별도로, 오너가 스크리닝
      //   기준 탭에서 고른 세션(데이/프리/본장/애프터)에만 신규 진입을 시도한다. 이번 사이클이
      //   해당하는 세션이 꺼져 있으면 스캔·진입 없이 건너뛴다(기존 감시 포지션은 계속 지켜봄).
      const nowSession = getSession(DateTime.now().setZone("Asia/Seoul"));
      const sessionAllowed =
        nowSession === "day" ? this.autoScanDayEnabled
        : nowSession === "pre" ? this.autoScanPreEnabled
        : nowSession === "regular" ? this.autoScanRegularEnabled
        : nowSession === "after" ? this.autoScanAfterEnabled
        : false; // "closed"(장 시간 아님)는 애초에 거래 대상이 아님
      if (!sessionAllowed) {
        const sessionKo = { day: "데이마켓", pre: "프리마켓", regular: "정규장(본장)", after: "애프터마켓", closed: "장 마감 시간대" }[nowSession];
        this.addJournal({
          kind: "info",
          symbol: "-",
          summary: `🤖 자동매매: 지금은 ${sessionKo}인데 [스크리닝 기준]에서 이 장을 꺼 두어 이번 사이클은 건너뜁니다(기존 감시 포지션은 계속됩니다).`,
        });
        this.autoTradeLastCycleSkipReason = { message: `지금은 ${sessionKo}인데 [스크리닝 기준]에서 이 장이 꺼져 있어 건너뜀`, atMs: Date.now() };
        return;
      }
      // [v0.48.0] 위 두 관문(휴무 시간대·세션 선택)을 모두 통과해 실제로 스캔을 시도하는
      //   지점 — 여기까지 왔다는 건 "정상 스킵"이 아니라는 뜻이므로 지난 스킵 사유를 지운다.
      this.autoTradeLastCycleSkipReason = null;

      const seedUsd = await this.resolveSeedUsd();
      if (isLossLimitBreached(this.autoTradeRealizedPnlUsd, seedUsd, this.autoTradeMaxLossPct)) {
        this.stopAutoTrade(`최대손실 한도 도달 — 이번 실행 누적손익 $${this.autoTradeRealizedPnlUsd.toFixed(2)}(한도: 시드 대비 ${this.autoTradeMaxLossPct}%)`); // ②
        return;
      }

      // [v0.32.0 — 중복진입 점검] 신규 진입 전에 반드시 실계좌 보유 현황을 확인한다. 실패하면
      //   "다른 기기와 안 겹치는지"를 확인할 방법이 없다는 뜻이므로, 기존 포지션 재확인은
      //   이미 위에서 끝났고 신규 진입만 이번 사이클에 한해 보류한다(안전 우선).
      const realHeldSymbols = await this.fetchRealHeldSymbols();
      if (realHeldSymbols === null) {
        this.addJournal({
          kind: "info", symbol: "-",
          summary: "🤖 자동매매: 실계좌 보유 종목 확인에 실패해 이번 사이클은 신규 진입 없이 건너뜁니다(다른 기기와 겹칠 위험을 확인할 수 없어 안전을 위해 보류 — 기존 포지션 감시는 계속됩니다).",
        });
        return;
      }

      const freeSlots = this.autoTradeMaxPositions - this.effectiveActivePositionCount();
      // [v0.60.0 긴급수정 — 오너 실사용 보고: "스크리너에 종료·탈락 종목(SDEV, BIYA 등)이
      //   계속 남는다, 새로고침해도 실제 상태로 안 바뀐다"] freeSlots<=0이면 5분 정기
      //   사이클은 (아래처럼) 스캔 자체를 건너뛰는 게 맞다 — 어차피 못 들어가니 API 호출을
      //   아끼는 최적화다. 그런데 오너가 직접 [🔄 지금 새로고침]을 눌렀을 때(forceScan)도
      //   똑같이 건너뛰면, 화면엔 몇 사이클 전(심지어 몇 시간 전) 스캔의 "확정" 목록이 그대로
      //   박제된 채 남는다 — 그 사이 실제로는 추세가 무너져 탈락했거나(BIYA) 이미 종료된
      //   종목(SDEV, bug#3과 동일 원인 — 자리가 안 비어 freeSlots가 계속 0으로 막혀 있었음)도
      //   "확정"으로 계속 보였다. "새로고침"은 오너가 지금 당장 실제 상태를 보려고 누르는
      //   버튼이므로, 이때만은 꽉 차 있어도 실제로 다시 스캔해 lastScan을 통째로 새로 갈아
      //   끼운다(신규 진입 자체는 아래 루프의 canAutoEnter가 activePositionCount로 별도로
      //   다시 막으므로, 여기서 건너뛰지 않아도 최대 종목 수를 넘는 진입은 여전히 안 난다).
      if (freeSlots <= 0 && !forceScan) {
        // [v0.38.0 버그 수정] 꽉 차서 이번 사이클은 스캔 자체를 건너뛰면, 화면엔 "지난 스캔에서
        //   확정됐던 종목"이 그대로 남아 있는데 사유는 하나도 안 채워져 "확정인데 왜 안 들어가지?"
        //   처럼 보였다 — 최대 종목 수 도달이 이유임을 여기서도 채워 둔다(스캔을 새로 안 해도).
        if (this.autoTradeLastScan) {
          for (const r of this.autoTradeLastScan.results) {
            if (r.status === "confirmed") {
              this.autoTradeSkipReasons[r.symbol] = `최대 종목 수(${this.autoTradeMaxPositions}개)에 이미 도달해 이번 사이클은 새 스캔 없이 건너뛰었습니다.`;
            }
          }
        }
        return; // 꽉 찼으면 이번 사이클은 스캔 생략
      }

      let run: ScreenRun;
      try {
        // [v0.28.0→v0.33.0] 오너가 "스크리닝 기준" 탭에서 조절한 조건을 그대로 쓴다(전부).
        if (this.currentAutoRun) this.currentAutoRun.scanCount++; // [v0.62.1] 리포트: 실제로 스크리닝까지 돈 횟수
        run = await this.scanScreener(this.buildAutoScanOpts()); // ③빈자리를 "현재 스크리닝으로 탐색된 다른 종목"으로 채움
        this.autoTradeLastScan = run; // [v0.27.0] 버리지 않고 보관 → "스크리닝 결과" 탭이 그대로 보여줌
        this.autoTradeLastScanError = null; // [v0.45.0] 성공했으니 이전 실패 기록은 지운다
      } catch (e) {
        // [v0.43.0] 오너가 스크리닝 취소 버튼을 눌러 멈춘 경우는 "실패"가 아니라 요청한 결과다 —
        //   문구를 구분해 저널이 헷갈리지 않게 한다. 이번 사이클은 신규 진입 없이 건너뛴다(안전).
        const msg = String(e).replace(/^Error:\s*/, "");
        const isCancel = msg.includes("취소");
        if (!isCancel) this.autoTradeLastScanError = { message: msg, atMs: Date.now() }; // [v0.45.0]
        this.addJournal({
          kind: "info",
          symbol: "-",
          summary: isCancel
            ? "🤖 자동매매: 오너가 스크리닝을 취소해 이번 사이클은 신규 진입 없이 건너뜁니다(기존 포지션 감시는 계속됩니다)."
            : `🤖 자동매매: 이번 사이클 스크리닝 실패 — ${msg}`,
        });
        return;
      }

      // [v0.32.0] 로컬 기록(이 기기가 아는 것)과 실계좌 보유(다른 기기가 넣었을 수도 있는 것)를
      //   합쳐서 "이미 잡고 있는 종목"으로 취급 — 둘 중 하나만 보면 다른 기기가 방금 넣은 종목에
      //   또 진입할 수 있다.
      // [v0.85.0 — 오너 긴급 보고 "이미 진입되어있는 종목인데 관찰·확정이 또 뜨거든, 어제처럼
      //   물려있는 종목을 제멋대로 손절할 수 있잖아"] 아래로 옮겨서 알림(관찰/확정) 단계보다
      //   먼저 계산한다 — 예전엔 이 줄이 candidates 바로 위(알림을 다 보낸 "다음")에 있어서,
      //   이미 보유 중인 종목도 "확정" 디스코드·OS 알림이 매 사이클 그대로 나갔다(진입 자체는
      //   candidates에서 걸러져 실제로 안 나갔지만, 오너 눈에는 "이미 들고 있는 종목을 또
      //   건드리려는 것"처럼 보였다). 실제 매도/손절(auditUnprotectedHoldings→runGuard)은
      //   이 스캔 결과와 완전히 별개 경로(autoTradeHistory의 실제 매수 기록만 봄)라 지금도
      //   알림만으로 주문이 나가진 않지만, "이미 보유 중인데 왜 또 확정이라고 뜨나"는 오너가
      //   매번 직접 판단해야 하는 혼란이자 신뢰 문제라 — 알림 자체를 원천에서 막는다.
      const activeSymbols = new Set([...this.autoTradePositions.map((p) => p.symbol), ...realHeldSymbols]);

      // [v0.32.0 — 오너 요청: "종목 탐색 성공 시 관찰 확정 알림"] 이번 스캔에서 새로 "확정
      //   (confirmed)"이 된 종목만 골라 알린다(매 5분 스캔마다 여전히 확정 상태인 종목까지
      //   반복 알리면 알림 피로만 쌓이므로, 직전 스캔엔 없었는데 이번에 새로 나타난 것만).
      // [v0.85.0] 이미 보유 중(activeSymbols)인 종목은 애초에 "새로 확정"으로 치지 않는다 —
      //   다시 안 보유하게 되면(청산되면) 그때 비로소 "새로 확정"으로 알린다.
      const newlyConfirmed = newlyConfirmedSymbols(run.results, this.autoScanNotifiedConfirmed).filter((sym) => !activeSymbols.has(sym));
      for (const sym of newlyConfirmed) {
        const r = run.results.find((x) => x.symbol === sym);
        const priceTxt = r?.price != null ? `$${r.price}` : "확인 불가";
        this.addJournal({
          kind: "info",
          symbol: sym,
          summary: `🔍 스크리닝에서 ${sym}이 진입 조건을 모두 통과해 관찰이 확정됐습니다(현재가 ${priceTxt}).`,
          notify: true,
          notifyTitle: `🔍 관찰 확정: ${sym}`,
        });
        // [v0.72.0→v0.84.0] 디스코드 즉시 알림 — 위 OS 알림(notify)과 별개 통로(앱을 안 보고
        //   있어도 옴). [v0.84.0 — 오너 지시 "확정 시 확정사유"] "진입 조건을 모두 통과했다"는
        //   말만으로는 왜 하필 이 종목·이 시점인지 알 수 없었다 — summarizeConfirmEvidence로
        //   핵심 근거(세션 고점·도지 시각·몸통 비율·고점과의 간격)를 한 줄 덧붙인다.
        void this.sendDiscordAlert(
          `🔴 **확정**: ${sym} (현재가 ${priceTxt}) — 자동매매 스크리닝에서 진입 조건을 모두 통과했습니다.\n` +
          `└ 사유: ${summarizeConfirmEvidence(r?.evidence ?? null)}`,
        );
      }
      // 다음 비교 기준을 이번 스캔으로 교체(빠졌다가 나중에 재확정되면 그때 다시 알림).
      // [v0.85.0] activeSymbols는 애초에 이 집합에 안 넣는다 — 그래야 나중에 청산되고 나서도
      //   "이미 알렸던 종목"으로 착각해 새 알림을 또 막아버리지 않는다.
      this.autoScanNotifiedConfirmed = new Set(run.results.filter((r) => r.status === "confirmed" && !activeSymbols.has(r.symbol)).map((r) => r.symbol));

      // [v0.72.0 — 오너 지시 "관찰, 확정된 종목이 나오면 즉시 디스코드로 알림"] "확정"은 이미
      //   위에서(OS 알림+디스코드) 알리고 있었다 — "관찰(watch, 다음 봉 확인 대기 중)"도 같은
      //   원리로 새로 생긴 것만 디스코드로 알린다. 관찰은 아직 최종 신호가 아니라서(다음 봉
      //   확인 전) OS 알림(notify)까지는 안 울리던 자리였는데, 디스코드는 "지금 뭔가 움직이기
      //   시작했다"는 더 이른 신호로 의미가 있어 오너가 명시적으로 요청했다.
      // [v0.85.0] 확정과 같은 이유로 이미 보유 중인 종목은 "관찰"도 알리지 않는다.
      const newlyWatched = newlyWatchedSymbols(run.results, this.autoScanNotifiedWatch).filter((sym) => !activeSymbols.has(sym));
      for (const sym of newlyWatched) {
        const r = run.results.find((x) => x.symbol === sym);
        const priceTxt = r?.price != null ? `$${r.price}` : "확인 불가";
        void this.sendDiscordAlert(`🟡 **관찰**: ${sym} (현재가 ${priceTxt}) — 도지 패턴 발생, 다음 5분봉 확인 중입니다.`);
      }
      this.autoScanNotifiedWatch = new Set(run.results.filter((r) => r.status === "watch" && !activeSymbols.has(r.symbol)).map((r) => r.symbol));

      // [관찰종목 이력] 보유 여부와 무관하게 "패턴이 실제로 어떻게 됐는지"만 본다(activeSymbols로
      //   거르지 않음 — 이미 들고 있어도 확정은 확정, 탈락은 탈락이고, 그게 바로 스크리닝 기준
      //   자체를 재검토하려는 이 기록의 목적이다. 실제 진입 여부는 autoTradeHistory가 따로 맡는다).
      this.watchHistory = updateWatchHistory(this.watchHistory, run.results, run, Date.now());
      this.persistWatchHistory();

      const candidates = run.results.filter((r) => r.status === "confirmed" && !activeSymbols.has(r.symbol));
      const commissionRate = await this.resolveCommissionRate();
      // [오너 지시 2026-09-25 정정] "최대 투입 비율"은 종목 1개당 배정 시드 비율이다 — 종목 수로
      // 나누지 않는다(이전 버전은 나눠서 저가주에서 1주만 나오는 버그가 있었음).
      // [v0.72.0 — 오너 지시 "2번으로 진행"] 다만 그 비율 자체를 종목별 변동성(ATR)에 따라 다시
      // 깎을 수 있다 — ATR이 높을수록(위험할수록) 투입을 줄여 손절 한 번의 충격을 줄인다. 종목마다
      // ATR이 다르므로 더 이상 사이클당 하나의 상수가 아니라, 아래 루프 안에서 후보마다 계산한다.

      // [v0.35.0] 이번 사이클에 실제로 검토한 후보만 채운다 — 지난 사이클 사유가 남아 헷갈리지 않게.
      this.autoTradeSkipReasons = {};
      // [v0.38.0 버그 수정 — 오너 보고 "확정인데 사유 없이 미진입"(MEDS 사례)] 위 `candidates`는
      //   `activeSymbols`(로컬 포지션 + 실계좌 보유)에 이미 걸리는 확정 종목을 아예 걸러내고
      //   시작한다 — 그러면 아래 for(candidates) 루프에 그 종목이 한 번도 들어가지 않아
      //   autoTradeSkipReasons에 사유가 절대 안 남았다. 화면(자동 스크리너 탭)은 이 사유를 못
      //   찾으니 그냥 "— 미진입"만 보여줬다 — 실제로는 버그가 아니라 "이미 보유 중이라 중복
      //   진입 안 함"이 정상 동작이었는데, 그 이유가 어디에도 안 보였던 것. 특히 "로컬 추적엔
      //   없지만 실계좌엔 이미 보유 중"(수동 매수, 또는 다른 기기가 방금 넣은 진입)인 경우가
      //   가장 헷갈렸다. candidates를 거르기 전에 먼저 이유를 채워 둔다.
      for (const r of run.results) {
        if (r.status !== "confirmed" || !activeSymbols.has(r.symbol)) continue;
        const heldLocally = this.autoTradePositions.some((p) => p.symbol === r.symbol);
        this.autoTradeSkipReasons[r.symbol] = heldLocally
          ? "이미 이 종목을 자동매매로 보유(또는 매수 감시) 중이라 중복 진입하지 않습니다."
          : "실계좌에 이미 이 종목을 보유 중입니다(수동 매수 또는 다른 기기의 자동매매 진입으로 추정) — 중복 진입 방지를 위해 건너뜁니다.";
      }
      let placed = 0;
      for (const cand of candidates) {
        // [v0.84.0 — 오너 지시 "실패 시 실패사유"] 확정됐는데 결국 진입까지 못 간 모든 경로를
        //   한 곳으로 모은다 — "자리에 사유를 적는다"와 "디스코드로 알린다"를 분리해 따로
        //   호출하면 언젠가 한쪽만 고치고 잊어버릴 위험이 있어, 아예 하나의 호출로 묶었다
        //   (아래 각 continue 지점은 전부 이 함수만 부르면 됨 — 제어 흐름 자체는 그대로 둬서
        //   실계좌 진입 로직을 건드리는 위험을 최소화했다).
        const failCandidate = (reason: string) => {
          this.autoTradeSkipReasons[cand.symbol] = reason;
          void this.sendDiscordAlert(`⚠️ **진입 실패**: ${cand.symbol} — ${reason}`);
        };
        if (placed >= freeSlots) {
          failCandidate(`이번 사이클엔 빈 자리(${freeSlots}개)를 다른 후보가 먼저 채웠습니다 — 다음 사이클에 다시 시도됩니다.`);
          continue;
        }
        if (cand.ema200 == null || cand.prevClose == null) {
          failCandidate("가격 데이터 부족(EMA200 또는 전봉종가 확인 안 됨) — 다음 사이클에 다시 시도됩니다.");
          continue; // 1분할 계산 불가(데이터 부족)
        }

        let level1: SplitOrder;
        try {
          // [오너 지시 → v0.61.8 설정으로 노출] 삼분할 매매기법의 1~2분할 중 오너가 고른 한
          //   타점만 쓴다(설정 탭 "진입 타점" — 공장값 1분할, 가장 얕게 눌렸을 때). 변수명은
          //   과거 "항상 1분할"이던 시절 이름을 그대로 쓰지만, 실제로는 autoTradeEntryLevel이
          //   가리키는 분할이다(아래 전부 이 변수를 통해서만 타점가를 쓴다).
          level1 = calcSplit3Level(cand.prevClose, cand.ema200, this.defaultTpPct, this.defaultSlPct, this.autoTradeEntryLevel);
        } catch {
          failCandidate(
            `${this.autoTradeEntryLevel}분할 진입 조건 불성립(전봉종가가 EMA200 이하) — 삼분할 매매기법상 지금은 진입 대상이 아닙니다.`,
          );
          continue; // 진입 필터 불성립(전봉종가<=EMA200) — 이 종목은 건너뜀
        }

        // [v0.63.0 ① EMA 기준 손절] 손절가를 "진입가 −N%"(고정) 대신 "EMA200 아래 여유%"로 —
        //   매매 근거(EMA 지지)가 깨지면 바로 나가고, 그래도 고정 손절보다 깊어지지는 않게(둘 중 높은 쪽).
        if (this.autoTradeSlMode === "ema") {
          const sSl = structuralStopPrice(level1.entry, cand.ema200, this.autoTradeEmaStopBufferPct, level1.sl);
          if (sSl == null) {
            failCandidate(
              `EMA 기준 손절가(EMA $${cand.ema200.toFixed(4)} 아래 ${this.autoTradeEmaStopBufferPct}%)가 진입가 $${level1.entry} 이상이라 손절선을 둘 수 없어 건너뜁니다.`,
            );
            continue;
          }
          level1 = { ...level1, sl: roundPrice(sSl) };
        }

        // [v0.63.0 ⑤-a] 오늘(KST) 이미 손절된 종목이면 다시 들어가지 않는다(하락 추세 속 반등에 또 물리는 것 방지).
        if (this.autoTradeReentryBlockEnabled && isReentryBlocked(this.autoTradeHistory, cand.symbol, Date.now())) {
          failCandidate("오늘 이미 손절된 종목이라 재진입하지 않습니다(손절 종목 당일 재진입 금지 — 설정에서 끌 수 있음).");
          continue;
        }

        const usedKey = `${cand.symbol}@${level1.entry}`;
        if (this.autoTradeUsedKeys.has(usedKey)) {
          failCandidate(`이미 이 타점($${level1.entry})으로 진입을 완료한 적이 있습니다(동일종목 동일타점 재진입 방지).`);
          continue; // [오너 지시] 동일종목 동일타점 재진입 방지
        }

        // [v0.60.0 — 오너 실사용 보고: "1차 타점 3944 익절 후, 하락하다 일시 반등할 때
        //   2차 타점을 더 높은 3966으로 잡아 오발주"] 원인: level1은 그 사이클(run.results)의
        //   prevClose/ema200 스냅샷으로 계산될 뿐, 이전에 같은 종목에 넣었던 타점과는 전혀 비교
        //   하지 않는다 — 5분마다 새 스캔이 돌 때마다 그 순간의 캔들만 보고 독립적으로 타점을
        //   다시 계산하므로, 하락 추세 중 일시 반등이 오면 prevClose가 올라가 새 타점이 직전
        //   타점보다 **더 높게** 나올 수 있다(삼분할 기법은 "얕게 눌렸을 때 사는" 전략이라,
        //   같은 종목에 또 들어갈 땐 직전보다 같거나 낮은 가격이어야 논리적으로 맞다).
        //
        // [v0.61.8 긴급 수정 — 오너 지적, 2026-10-01: "타점 가격을 기준으로 생각해야지 과거
        //   매매이력을 기준으로 하면 진입할 종목도 막히게 되는 경우가 있음, 로직상 오류"]
        //   v0.60.0은 비교 대상을 "최근 24시간 안의 모든 기록(드라이런 제외)"으로 잡았는데,
        //   여기엔 **이미 완전히 청산된(익절·손절) 매매**까지 포함됐다. 문제: 오전에 어떤
        //   종목을 익절하고, 오후에 그 종목이 완전히 새로운(독립적인) 눌림목을 만들어 새
        //   타점이 형성돼도 — 그게 오전 진입가보다 조금이라도 비싸면 "방향 정합성 위반"으로
        //   막혔다. 하지만 이미 끝난 매매 사이클은 끝난 것이고, 새 스캔이 "지금 이 순간의
        //   캔들"로 계산한 새 타점은 그 자체로 독립적인 정당한 기회다 — 과거 이력이 아니라
        //   "지금 비교해야 할 대상이 있는가"(=아직 안 끝난 포지션)로 판단해야 한다는 지적이
        //   맞다. 이제 비교 대상을 좁힌다:
        //     ① 아직 안 끝난(watching/active) 포지션 — 언제 넣었든 항상 비교(그 포지션이
        //        살아있는 한 더 비싸게 또 사는 건 여전히 전략 모순이므로).
        //     ② 완전히 청산된 매매는 "방금(한 자동매매 사이클, 기본 5분) 진입했던" 것만 —
        //        v0.60.0 원래 사고(같은 사이클 직후 재평가에서 노이즈로 역전)는 여전히 막되,
        //        몇 시간~하루 전에 이미 끝난 매매가 전혀 다른 시점의 정당한 새 기회까지
        //        막는 일은 없앴다.
        const lastEntry = findDirectionConflict(this.autoTradeHistory, cand.symbol, Date.now(), ToolEngine.AUTO_TRADE_INTERVAL_MS);
        if (lastEntry && level1.entry > lastEntry.entry) {
          const reason =
            `직전 타점($${lastEntry.entry})보다 높은 가격($${level1.entry})으로 재진입하려 해 취소했습니다 ` +
            `(하락 추세 중 상향 재진입은 방향 정합성 위반 — 아직 살아있는 포지션이거나 방금 끝난 매매 기준).`;
          failCandidate(reason);
          // [v0.61.8] 예전엔 skipReasons에만 남아 다음 사이클에 덮어써졌다 — 실제로 몇 번이나
          //   발동했는지 사후에 확인할 방법이 없었다(오너 지적 검토 중 발견). 저널(최근 로그)에도
          //   남겨 history로 확인 가능하게 한다.
          this.addJournal({ kind: "info", symbol: cand.symbol, summary: `🤖 자동매매: ${cand.symbol} ${reason}` });
          continue;
        }

        // [v0.72.0] ATR(평균 변동폭) 기반 투입 비율 축소 — 설정이 꺼져 있으면 원래 비율 그대로.
        const perSlotPct = this.autoTradeVolScaledSizingEnabled
          ? volScaledInvestPct(this.autoTradeMaxInvestPct, cand.entryMetrics?.atrPct ?? null)
          : this.autoTradeMaxInvestPct;
        const qty = computeSeedQty(seedUsd, perSlotPct, level1.entry, commissionRate) ?? 0;
        const gate = canAutoEnter({
          limits: {
            enabled: this.autoTradeEnabled,
            maxPositions: this.autoTradeMaxPositions,
            maxLossPct: this.autoTradeMaxLossPct,
            maxInvestPct: this.autoTradeMaxInvestPct,
          },
          // [v0.39.0] 자동매매가 직접 아는 포지션 개수만(기보유 등 무관한 실계좌 종목은 제외).
          activePositionCount: this.effectiveActivePositionCount(),
          realizedPnlUsd: this.autoTradeRealizedPnlUsd,
          seedUsd,
          candidateQty: qty,
        });
        if (!gate.allow) {
          failCandidate(gate.reason ?? "안전 게이트에서 거부됨.");
          // 종목 수·손실 한도처럼 "이 사이클 전체"에 적용되는 사유면 더 시도할 필요가 없다.
          if (gate.reason?.includes("종목 수") || gate.reason?.includes("손실")) break;
          continue; // 그 외(예: 예산으로 1주도 못 사는 경우)는 이 종목만 건너뛰고 다음 후보 시도
        }

        // [v0.60.0 긴급 수정 — 오너 실사용 보고: "200 EMA 아래로 꺾인 하락 추세인데 진입이
        //   났다"] 원인 규명: level1(위 calcSplit3)은 이 스캔(run.results)이 만들어진 시점의
        //   스냅샷(cand.prevClose/cand.ema200)으로만 계산된다. candidates 루프는 이 스캔
        //   전체(최대 autoScanCount 종목, 종목마다 캔들 조회 필요)가 끝난 뒤에 도는 데다,
        //   후보가 여러 개면 앞 후보의 주문 접수(await placeBracketCore, 네트워크 왕복)를
        //   기다리는 동안 뒤 후보는 더 늦게 도달한다 — 스캔 당시엔 "EMA200 위(상승)"였어도
        //   실제 주문이 나가는 순간엔 그새 가격이 EMA200 아래로 꺾여 있을 수 있다(스크리너
        //   탈락 사유 통계에 "EMA200 아래"가 찍히는 건 그 *다음* 스캔이 그때는 정직하게
        //   걸러냈다는 뜻일 뿐, 이미 나간 주문을 막지는 못한다). 그래서 실제 매수 주문을
        //   내기 **바로 직전**에 현재가를 다시 조회해 EMA200 위인지 마지막으로 재확인한다
        //   — 스캔 때 통과했어도 이 순간 깨졌으면 진입하지 않는다(오너 지시 그대로).
        //   EMA200 자체는 5분봉 200개 평균이라 몇 분 사이 크게 안 움직이므로 스캔 시점 값을
        //   그대로 기준선으로 쓰고, 빠르게 변하는 현재가만 다시 확인하면 충분하다.
        let livePriceAtEntry: number;
        try {
          livePriceAtEntry = (await getPrice(cand.symbol)).price;
        } catch (e) {
          failCandidate(
            `주문 직전 현재가 재확인에 실패해(${String(e).replace(/^Error:\s*/, "")}) 안전하게 이번 사이클은 건너뜁니다.`,
          );
          continue;
        }
        if (!(livePriceAtEntry > cand.ema200)) {
          failCandidate(
            `스캔 때는 EMA200 위였지만 주문 직전 재확인 결과 현재가($${livePriceAtEntry})가 EMA200($${cand.ema200}) ` +
            `아래로 떨어져 진입을 취소했습니다(추세가 그 사이 무너짐 — 실계좌 보호를 위한 마지막 재확인).`,
          );
          continue;
        }

        // [v0.35.0 버그 수정] 예전엔 여기서(시도 직전에) usedKeys에 등록했다 — 그러면 진입이
        //   일시적 오류(네트워크 순단 등)로 실패해도 "이미 시도했다"고 영구 기록돼, 같은 타점이
        //   다음 사이클에도 계속 나타나는데 조용히 skip만 되고 다시는 재시도되지 않는 버그가
        //   있었다("확정인데 왜 계속 미진입이지?"의 실제 원인 중 하나). 이제는 아래 placeBracketCore가
        //   "성공"한 뒤에만(드라이런 포함) 기록해, 실패하면 다음 사이클에 자동으로 재시도된다.
        const posDraft: AutoPosition = {
          symbol: cand.symbol,
          entry: level1.entry,
          tp: level1.tp,
          sl: level1.sl,
          quantity: qty,
          enteredAtMs: Date.now(),
          status: "watching",
          conditionalOrderId: null,
        };
        this.autoTradePositions.push(posDraft);
        this.saveAutoPositions(); // [v0.30.1] 재시작해도 이 포지션을 잃어버리지 않게 즉시 저장
        // [v0.45.0] 이 매매가 실제로 어떤 설정으로 진입됐는지 스냅샷을 함께 남긴다(그룹 연구용 —
        //   위 AutoTradeHistoryEntry.criteriaSnapshot 주석 참고). nowSession은 위 "매매진행할 장"
        //   게이트에서 이미 계산해 둔 값을 그대로 재사용한다.
        this.addAutoTradeHistory(posDraft, {
          bodyRatio: this.autoScanBodyRatio,
          emaTrendEnabled: this.autoScanEmaTrendEnabled,
          emaPeriod: this.autoScanEmaPeriod,
          cloudEnabled: this.autoScanCloudEnabled,
          dojiWickMinRatio: this.autoScanDojiWickMinRatio,
          dojiMaxAgeEnabled: this.autoScanDojiMaxAgeEnabled,
          dojiMaxAgeMinutes: this.autoScanDojiMaxAgeMinutes,
          dojiMaxGapEnabled: this.autoScanDojiMaxGapEnabled,
          dojiMaxGapMinutes: this.autoScanDojiMaxGapMinutes,
          nextCandleConfirmEnabled: this.autoScanNextCandleConfirmEnabled,
          excludeEtf: this.autoScanExcludeEtf,
          session: nowSession,
          maxPositions: this.autoTradeMaxPositions,
          maxLossPct: this.autoTradeMaxLossPct,
          maxInvestPct: this.autoTradeMaxInvestPct,
          appliedInvestPct: perSlotPct, // [v0.72.0] ATR 연동 축소까지 반영된 실제 적용값
          watchMinutes: this.autoTradeWatchMinutes,
          entryLevel: this.autoTradeEntryLevel,
          emaMinGapEnabled: this.autoScanEmaMinGapEnabled, // [v0.63.0]
          emaMinGapPct: this.autoScanEmaMinGapPct,
          emaSlopeEnabled: this.autoScanEmaSlopeEnabled,
          atrFilterEnabled: this.autoScanAtrFilterEnabled,
          atrMaxPct: this.autoScanAtrMaxPct,
          slMode: this.autoTradeSlMode,
          emaStopBufferPct: this.autoTradeEmaStopBufferPct,
        }); // [v0.30.0] 자동매매기록 — 접수 즉시 한 줄 남김
        // [v0.63.0 ② 측정] 진입 당시 이격도·ATR%·EMA 기울기를 같은 줄에 남긴다(그룹 연구 데이터로도 올라감).
        if (cand.entryMetrics) this.updateAutoTradeHistory(cand.symbol, level1.entry, posDraft.enteredAtMs, { entryMetrics: cand.entryMetrics });

        try {
          const { entryJournal, watchPromise } = await this.placeBracketCore({
            symbol: cand.symbol,
            price: level1.entry,
            quantity: qty,
            tpTrigger: level1.tp,
            tpPrice: level1.tp,
            slTrigger: level1.sl,
            slPrice: roundPrice(level1.sl * 0.99), // OCO와 동일 규칙: 손절 지정가는 감시가 1% 아래
            expireDate: this.autoTradeExpireDate(),
            // [v0.29.0 — 오너 요청 "장시간 미체결 대책"] 자동매매만 짧은 감시시간+자동취소를 쓴다
            //  (수동 버튼은 기존 그대로 15분+취소안함 — 위 BracketSpec.cancelOnTimeout 주석 참고).
            //  [v0.42.0] 하드코딩 상수 대신 오너가 설정 가능한 인스턴스 필드를 쓴다.
            watchMinutes: this.autoTradeWatchMinutes,
            cancelOnTimeout: true,
            autoPlan: this.currentAutoPlan(), // [v0.69.2] 설정 대조 + 체결가 기준 재계산
            onOrderCreated: (id) => {
              // [v0.69.3] 주문 접수 즉시 번호를 포지션·기록 양쪽에 남긴다(예전엔 접수 뒤 여러 단계를 거친 다음에야 적었다).
              posDraft.buyOrderId = id;
              this.saveAutoPositions();
              this.updateAutoTradeHistory(cand.symbol, level1.entry, posDraft.enteredAtMs, { buyOrderId: id });
            },
            rationale: {
              technique: "split3",
              source: "auto", // [v0.30.0] 오너 요청 — 자동매매로 낸 주문임을 근거에도 남긴다
              level: 1,
              baseClose: cand.prevClose,
              ema200: cand.ema200,
              entry: level1.entry,
              tp: level1.tp,
              sl: level1.sl,
              priceAtOrder: null, // placeBracketCore가 실제 현재가로 덮어씀(saveRationale 참고)
            },
          });
          // [v0.35.0] 주문 접수가 여기까지 성공(예외 없이)해야만 "이미 시도했다"로 기록한다 —
          //   실패는 이 try 블록을 못 벗어나고 catch로 가므로 절대 여기 도달하지 않는다.
          this.autoTradeUsedKeys.add(usedKey);
          this.addJournal({
            kind: "info",
            symbol: cand.symbol,
            summary: `🤖 자동매매 진입 ${cand.symbol} $${level1.entry} × ${qty}주(삼분할 ${this.autoTradeEntryLevel}분할) — 체결되면 자동으로 익절 $${level1.tp} / 손절 $${level1.sl}을 등록합니다.`,
            notify: true,
            notifyTitle: `🤖 진입 접수: ${cand.symbol}`,
          });
          // [v0.84.0 — 오너 지시 "확정 다음 단계도 디코로"] "확정"만 디스코드로 가고 그 다음
          //   실제로 들어갔는지는 PC를 봐야만 알 수 있었다 — 결과(성공)도 같은 채널로 잇는다.
          void this.sendDiscordAlert(`🟢 **진입 접수**: ${cand.symbol} $${level1.entry} × ${qty}주 — 체결되면 익절 $${level1.tp} / 손절 $${level1.sl}을 자동 등록합니다.`);
          if (watchPromise) {
            // [v0.30.1] 매수 주문번호를 기록해 둔다 — 앱이 재시작돼 이 감시(watchPromise)가
            //   끊겨도, 이 번호로 reconcileAutoPositions가 나중에 다시 체결 여부를 물어볼 수 있다.
            const buyOrderId = (entryJournal.detail as { tossOrderId?: string } | undefined)?.tossOrderId ?? null;
            posDraft.buyOrderId = buyOrderId;
            this.saveAutoPositions();
            const watchKey = `${cand.symbol}@${level1.entry}@${posDraft.enteredAtMs}`;
            this.autoTradeActiveWatches.add(watchKey); // 이 프로세스가 지금 직접(빠른 폴링으로) 감시 중임을 표시
            watchPromise
              .then((res) => this.onAutoBracketResolved(cand.symbol, level1.entry, res))
              .catch(() => this.onAutoBracketResolved(cand.symbol, level1.entry, { status: "oco_failed", error: "확인 실패" }));
          } else {
            // 드라이런(실주문 잠금 상태) — 실제 체결이 없어 자리를 계속 점유할 이유가 없다.
            this.autoTradePositions = this.autoTradePositions.filter((p) => p !== posDraft);
            this.saveAutoPositions();
            this.updateAutoTradeHistory(cand.symbol, level1.entry, posDraft.enteredAtMs, {
              status: "dryrun",
              exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
              note: "[드라이런] 실제 주문 아님(연습) — 매수+익절+손절을 한 번에 시뮬레이션",
            });
          }
        } catch (e) {
          if (posDraft.buyOrderId) {
            // [v0.69.3] 주문은 이미 토스에 접수됐는데 그 뒤 처리에서 오류가 난 경우 — 예전엔 포지션을 지우고 "다음 사이클 재시도"로 넘겨
            //   토스에 주문이 남은 채 중복 주문까지 나갈 수 있었다. 이제 포지션을 유지해(5분 재확인·시간초과 취소가 이어받음) 재시도하지 않는다.
            this.autoTradeUsedKeys.add(usedKey);
            this.addJournal({
              kind: "info", symbol: cand.symbol,
              summary: `⚠️ ${cand.symbol} 진입 주문은 토스에 접수됐지만 이후 처리 중 오류(${String(e).replace(/^Error:\s*/, "")})가 났습니다 — 주문은 계속 감시하며, 중복 주문하지 않습니다.`,
              notify: true, notifyTitle: `⚠️ 진입 후 처리 오류: ${cand.symbol}`,
            });
            void this.sendDiscordAlert(`⚠️ **진입 후 처리 오류**: ${cand.symbol} — 주문은 토스에 접수됐지만 이후 처리 중 오류(${String(e).replace(/^Error:\s*/, "")})가 났습니다. 주문은 계속 감시 중입니다.`);
            placed++;
            continue;
          }
          this.autoTradePositions = this.autoTradePositions.filter((p) => p !== posDraft);
          this.saveAutoPositions();
          const errMsg = String(e).replace(/^Error:\s*/, "");
          // [v0.35.0] usedKeys에는 안 올렸으므로(위 성공 지점에서만 올림) 다음 사이클에 자동 재시도된다.
          failCandidate(`방금 진입을 시도했지만 실패했습니다(${errMsg}) — 다음 사이클에 다시 시도됩니다.`);
          this.addJournal({
            kind: "info", symbol: cand.symbol, summary: `🤖 자동매매 진입 실패 ${cand.symbol}: ${errMsg}`,
            notify: true, notifyTitle: `⚠️ 진입 실패: ${cand.symbol}`,
          });
          this.updateAutoTradeHistory(cand.symbol, level1.entry, posDraft.enteredAtMs, {
            status: "closed_manual",
            exitedAt: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
            note: `주문 접수 자체가 실패: ${errMsg}`,
          });
          continue;
        }
        placed++;
      }
    } catch (e) {
      if (this.currentAutoRun) this.currentAutoRun.errors.cycleErrors++; // [v0.62.1] 리포트: 사이클 예외 횟수
      // [안전장치] 이 사이클 안에서 예상 못 한 오류가 나도(네트워크 순단 등) 자동매매 전체가
      //   조용히 죽어버리면 안 된다(백그라운드 실행이라 사람이 못 봄 — void로 호출되므로 여기서
      //   막지 않으면 처리되지 않은 프라미스 거부가 된다). 저널에 남기고 다음 5분 사이클에서
      //   다시 시도한다 — 반복 실패는 지켜보다 사람이 직접 끄면 된다. 저널 기록 자체가 실패해도
      //   (예: 저장 공간 문제) 이 사이클을 죽이지 않는다.
      try {
        this.addJournal({ kind: "info", symbol: "-", summary: `🤖 자동매매: 이번 사이클 중 예상 못 한 오류 — ${String(e).replace(/^Error:\s*/, "")}` });
      } catch {
        /* 저널 기록조차 실패 — 조용히 넘어간다(다음 사이클에서 재시도) */
      }
    } finally {
      this.autoTradeTickBusy = false;
      if (this.autoUnprotected.length > 0) this.scheduleGuard(1000); // [v0.69.0] 5분 사이클마다 보호 대기 종목을 한 번 더 확인
      this.touchAutoRun(); // [v0.62.1] 마지막 활동 시각·오류 카운터·보유 포지션을 실행 기록에 반영(파일 저장 포함)
      // [v0.61.4] 사이클마다 최신 스캔·사이클 시각을 파일에도 반영한다(재시작해도 살아남게 —
      //   positions만 영속화돼 있고 lastScan은 메모리 전용이던 게 "재시작 직후 폰 화면이
      //   다시 비어 보이는" 문제의 근본 원인이었다. 자세한 배경은 saveAutoPositions 주석 참고).
      this.saveAutoPositions();
      // [v0.61.0] 사이클 끝마다 지금 상태(스캔 결과 포함)를 capri_live_state에 올린다
      //   (로그인돼 있으면) — 오너 지시 "스크리너 스캔이 끝날 때마다는 반드시 올려야
      //   한다"를 그대로 구현. force=true로 쓰로틀을 무시해 체결 없이 스캔만 돈 사이클도
      //   빠짐없이 반영된다.
      void this.pushLiveState(true);
    }
  }

  /**
   * [v0.2.10] 보유 포지션 + 실시간 손익.
   *   토스 holdings(보유 종목)에 ①우리가 기록한 매매 근거와 ②현재 시세를 붙여
   *   "매수가 대비 몇 %"인지 계산해 돌려준다. 조회 실패는 null로 두고 화면이 '조회 불가'로 표시.
   */
  async positions(): Promise<PositionView[]> {
    await this.prepareBackend();
    const out: PositionView[] = [];
    let items: Array<Record<string, unknown>> = [];
    try {
      const h = (await getHoldings()) as Record<string, unknown>;
      items = (h?.items as Array<Record<string, unknown>>) ?? [];
    } catch {
      return out; // 보유 조회 실패 → 빈 목록(화면이 안내)
    }

    for (const it of items) {
      const symbol = String(it.symbol ?? "").toUpperCase();
      if (!symbol) continue;
      const quantity = Number(it.quantity);
      // 평균매입가: 토스 응답 필드명이 문서마다 조금씩 달라 후보를 순서대로 본다.
      const avgRaw = it.averagePrice ?? it.avgPrice ?? it.averagePurchasePrice ?? it.purchasePrice;
      const avgPrice = Number.isFinite(Number(avgRaw)) ? Number(avgRaw) : null;

      // 현재가(실패해도 나머지는 보여준다).
      //   ⚠️ getPrice는 숫자가 아니라 {symbol, price, ...} 객체를 돌려준다. 분해해서 숫자만 꺼내야
      //   손익 계산이 된다(자체 검증에서 이 실수로 손익이 전부 '조회 불가'로 나왔다).
      let currentPrice: number | null = null;
      let currency = "USD";
      try {
        const q = await getPrice(symbol);
        if (Number.isFinite(q.price)) currentPrice = q.price;
        if (q.currency) currency = q.currency;
      } catch {
        /* 무시 */
      }

      // 이 종목의 가장 최근 '진입' 근거를 찾는다(없으면 조건주문 근거라도).
      const mine = this.rationales.filter((r) => r.symbol === symbol);
      const rationale = [...mine].reverse().find((r) => r.kind === "entry") ?? mine[mine.length - 1] ?? null;

      // 손익 기준가: 우리가 기록한 진입가가 1순위(내가 의도한 가격), 없으면 토스 평균매입가.
      const entryPrice = rationale?.entry ?? avgPrice ?? null;
      const entrySource: PositionView["entrySource"] = rationale?.entry ? "rationale" : avgPrice != null ? "toss" : "none";

      const pnlPct = entryPrice && currentPrice ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
      const pnlUsd = entryPrice && currentPrice && Number.isFinite(quantity) ? (currentPrice - entryPrice) * quantity : null;
      // "익절/손절까지 몇 %p" — 지금 가격에서 목표까지의 거리다(기준가가 아니라 현재가 대비).
      const toTpPct = rationale?.tp && currentPrice ? ((rationale.tp - currentPrice) / currentPrice) * 100 : null;
      const toSlPct = rationale?.sl && currentPrice ? ((rationale.sl - currentPrice) / currentPrice) * 100 : null;

      out.push({
        symbol,
        currency,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        avgPrice,
        entryPrice,
        entrySource,
        currentPrice,
        pnlPct,
        pnlUsd,
        toTpPct,
        toSlPct,
        rationale,
      });
    }
    return out;
  }

  // ==========================================================================
  // [v0.3.3] 주문 현황(토스 스타일) — 보유/일반주문/조건주문 리치 뷰 + 매도 주문
  //   전부 조회(GET)만. 실제 매도/취소/삭제는 사람이 버튼을 눌러야만 나간다.
  // ==========================================================================

  /** 문자열/숫자 무엇이 와도 안전하게 number|null 로. (토스는 금액을 전부 문자열로 준다) */
  private num(v: unknown): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** 이 종목의 가장 최근 매매 근거를 찾는다(진입 우선). 없으면 null. */
  private rationaleFor(symbol: string): TradeRationale | null {
    const mine = this.rationales.filter((r) => r.symbol === symbol.toUpperCase());
    return [...mine].reverse().find((r) => r.kind === "entry" || r.kind === "oto") ?? mine[mine.length - 1] ?? null;
  }

  /**
   * [v0.3.3] 보유 현황(요약 + 종목별) — holdings 응답을 빠짐없이 가공한다.
   *   ⚠️ 종목 현재가(lastPrice)가 holdings 안에 이미 들어 있으므로, 종목마다 시세를 또 부르지 않는다.
   */
  async holdingsView(): Promise<{ summary: HoldingsSummary; items: HoldingRow[] }> {
    const empty: HoldingsSummary = {
      marketValueUsd: null, marketValueKrw: null, pnlUsd: null, pnlKrw: null, pnlRate: null, dailyPnlUsd: null, dailyPnlKrw: null,
    };
    try {
      await this.prepareBackend();
    } catch {
      return { summary: empty, items: [] };
    }
    let h: Record<string, unknown>;
    try {
      h = (await getHoldings()) as Record<string, unknown>;
    } catch {
      return { summary: empty, items: [] };
    }
    // 최상위 요약(총평가·총손익·당일손익). 금액은 {krw,usd} 두 통화로 온다.
    const mv = h.marketValue as Record<string, unknown> | undefined;
    const mvAmt = mv?.amount as Record<string, unknown> | undefined;
    const pl = h.profitLoss as Record<string, unknown> | undefined;
    const plAmt = pl?.amount as Record<string, unknown> | undefined;
    const dpl = h.dailyProfitLoss as Record<string, unknown> | undefined;
    const dplAmt = dpl?.amount as Record<string, unknown> | undefined;
    const summary: HoldingsSummary = {
      marketValueUsd: this.num(mvAmt?.usd),
      marketValueKrw: this.num(mvAmt?.krw),
      pnlUsd: this.num(plAmt?.usd),
      pnlKrw: this.num(plAmt?.krw),
      pnlRate: pl?.rate != null ? (this.num(pl.rate) ?? 0) * 100 : null,
      dailyPnlUsd: this.num(dplAmt?.usd),
      dailyPnlKrw: this.num(dplAmt?.krw),
    };

    const items: HoldingRow[] = [];
    const rows = (h.items as Array<Record<string, unknown>>) ?? [];
    for (const it of rows) {
      const symbol = String(it.symbol ?? "").toUpperCase();
      if (!symbol) continue;
      const currency = String(it.currency ?? (String(it.marketCountry) === "KR" ? "KRW" : "USD"));
      const iMv = it.marketValue as Record<string, unknown> | undefined;
      const iPl = it.profitLoss as Record<string, unknown> | undefined;
      const iDpl = it.dailyProfitLoss as Record<string, unknown> | undefined;
      const cost = it.cost as Record<string, unknown> | undefined;
      items.push({
        symbol,
        name: (it.name as string) ?? null,
        marketCountry: (it.marketCountry as string) ?? null,
        currency,
        quantity: this.num(it.quantity) ?? 0,
        lastPrice: this.num(it.lastPrice),
        avgPrice: this.num(it.averagePurchasePrice ?? it.averagePrice),
        purchaseAmt: this.num(iMv?.purchaseAmount),
        marketValueAmt: this.num(iMv?.amount),
        pnlAmt: this.num(iPl?.amount),
        pnlRate: iPl?.rate != null ? (this.num(iPl.rate) ?? 0) * 100 : null,
        dailyPnlAmt: this.num(iDpl?.amount),
        dailyPnlRate: iDpl?.rate != null ? (this.num(iDpl.rate) ?? 0) * 100 : null,
        commission: this.num(cost?.commission),
        tax: this.num(cost?.tax),
        rationale: this.rationaleFor(symbol),
      });
    }
    return { summary, items };
  }

  /**
   * [v0.3.3] 일반 주문 목록(원본 필드 전부). status=OPEN(미체결)/CLOSED(종료).
   *   기존 openOrders는 몇 필드만 남겼는데, 이건 주문시각·수수료·평균체결가까지 다 담는다.
   */
  async ordersView(status: "OPEN" | "CLOSED"): Promise<OrderRow[]> {
    // [v0.9.8] 체결 목록을 보는 김에 **매매 이력도 저장**해 둔다.
    //   그래야 나중에 홈 PC 연결이 없는 곳(회사)에서도 리포트가 보인다.
    if (status === "CLOSED" && this.mode === "live") {
      void this.collectFills(Date.now() - 45 * 86_400_000)
        .then(({ fills }) => this.absorbFills(fills))
        .catch(() => {
          /* 실패해도 주문 현황 표시에는 지장 없다 */
        });
    }
    await this.prepareBackend();
    this.assertAccountReady();
    const raw = await listOrdersRaw({ status });
    return raw.orders.map((o) => {
      const ex = o.execution as Record<string, unknown> | undefined;
      const statusRaw = (o.status as string) ?? null;
      const statusStd = mapOrderStatus(statusRaw ?? "PENDING");
      return {
        orderId: String(o.orderId ?? ""),
        symbol: (o.symbol as string) ?? null,
        side: (o.side as "BUY" | "SELL") ?? null,
        orderType: (o.orderType as string) ?? null,
        statusRaw,
        statusStd,
        price: this.num(o.price),
        quantity: this.num(o.quantity),
        orderAmount: this.num(o.orderAmount),
        currency: (o.currency as string) ?? null,
        timeInForce: (o.timeInForce as string) ?? null,
        orderedAt: (o.orderedAt as string) ?? null,
        canceledAt: (o.canceledAt as string) ?? null,
        filledQty: this.num(ex?.filledQuantity),
        avgFilledPrice: this.num(ex?.averageFilledPrice),
        filledAmount: this.num(ex?.filledAmount),
        commission: this.num(ex?.commission),
        tax: this.num(ex?.tax),
        filledAt: (ex?.filledAt as string) ?? null,
        isOpen: status === "OPEN" && (statusStd === "submitted" || statusStd === "partial"),
      };
    });
  }

  /**
   * [v0.3.3] 조건주문 목록(원본 필드 전부). status=OPEN/CLOSED.
   *   ⚠️ 목록 응답에 orderSide 가 없어서 first/second 순서로 진입/청산을 구분한다.
   *   우리가 저장한 근거(clientOrderId=conditionalOrderId)를 붙여 함께 보여준다.
   */
  async condOrdersView(status: "OPEN" | "CLOSED"): Promise<CondOrderRow[]> {
    await this.prepareBackend();
    this.assertAccountReady();
    const raw = await listConditionalOrdersRaw(status);
    const leg = (v: unknown): CondLegView | null => {
      if (!v || typeof v !== "object") return null;
      const o = v as Record<string, unknown>;
      return {
        legType: (o.type as string) ?? null,
        status: (o.status as string) ?? null,
        triggerPrice: this.num(o.triggerPrice),
        orderPrice: this.num(o.orderPrice),
        triggeredOrderId: (o.triggeredOrderId as string) ?? null,
      };
    };
    return raw.map((c) => {
      const id = String(c.conditionalOrderId ?? c.id ?? "");
      const grpStatus = (c.status as string) ?? null;
      // 근거 매칭: 우리는 조건주문 등록 시 tossOrderId 에 conditionalOrderId 를 저장했다.
      const rationale = this.rationales.filter((r) => r.tossOrderId === id).slice(-1)[0] ?? null;
      return {
        conditionalOrderId: id,
        type: (c.type as string) ?? null,
        status: grpStatus,
        symbol: (c.symbol as string) ?? null,
        market: (c.market as string) ?? null,
        quantity: this.num(c.quantity),
        orderType: (c.orderType as string) ?? null,
        expireDate: (c.expireDate as string) ?? null,
        createdAt: (c.createdAt as string) ?? null,
        first: leg(c.first),
        second: leg(c.second),
        rationale,
        isOpen: grpStatus === "WATCHING",
      };
    });
  }

  /**
   * [v0.3.3] 매도 주문 — 보유 종목을 판다. 지정가(LIMIT)/시장가(MARKET) 선택.
   *   ⚠️ 사전차단 없음(전송 후 토스 판단). 실주문 잠금(드라이런)이면 모의 기록만.
   *   ❌ 에이전트가 자동으로 부르지 않는다 — 반드시 화면의 [매도] 버튼(사람)에서만 호출된다.
   */
  async placeSell(spec: {
    symbol: string;
    quantity: number;
    orderType: "LIMIT" | "MARKET";
    price?: number; // LIMIT일 때만
  }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    {
      const problems = checkSimpleOrder({ quantity: spec.quantity, orderType: spec.orderType, price: spec.price }); // [v0.69.2] 주문 전 검증 관문
      if (problems.length) this.blockOrder("매도", symbol, problems);
    }
    await this.prepareBackend();
    this.assertAccountReady();
    const clientOrderId = makeClientOrderId(`sell${symbol}${DateTime.now().toFormat("HHmmss")}`, 1, "sell");

    if (this.isDryRun()) {
      void this.recordExit(symbol, spec.price ?? null, "manual", this.currentMode()); // [v0.7.0] 청산 체결강도+결과 자동 기록
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 매도 ${spec.orderType === "MARKET" ? "시장가" : `지정가 $${spec.price}`} ${symbol} ${spec.quantity}주 (실주문 잠금 — 전송 안 함)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const o = await this.inflight(`매도 주문 전송 ${symbol}`, () => createOrder({
      symbol,
      side: "SELL",
      orderType: spec.orderType,
      price: spec.orderType === "LIMIT" ? spec.price : undefined,
      quantity: spec.quantity,
      clientOrderId,
    }));
    void this.recordExit(symbol, spec.price ?? null, "manual", this.currentMode()); // [v0.7.0] 청산 체결강도+결과 자동 기록
    return this.addJournal({
      kind: "entry",
      symbol,
      summary: `매도 접수 ${spec.orderType === "MARKET" ? "시장가" : `지정가 $${spec.price}`} ${symbol} ${spec.quantity}주 (주문번호 ${o.tossOrderId}, 상태 ${o.status})`,
      detail: o,
    });
  }

  getJournal(): JournalEntry[] {
    return this.journal.slice(-100); // 최근 100건만 화면으로
  }

  private loadJournal(): void {
    try {
      this.journal = existsSync(this.journalPath) ? (JSON.parse(readFileSync(this.journalPath, "utf8")) as JournalEntry[]) : [];
    } catch {
      this.journal = [];
    }
  }

  private addJournal(e: Omit<JournalEntry, "ts">): JournalEntry {
    const entry: JournalEntry = {
      ts: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"),
      ...e,
      category: e.category ?? classifyJournalEntry(e),
    };
    this.journal.push(entry);
    if (this.journal.length > 1000) this.journal.shift();
    // [v0.69.3] 저널 파일 저장 실패(디스크·폴더 문제)가 주문 감시 같은 핵심 흐름을 예외로 죽이지 않게 한다 — 메모리 저널과 알림은 그대로 동작.
    // [v0.90.0] 디바운스 저장(비동기) — 예전엔 매번 writeFileSync로 최대 1000건을 통째로 다시 썼다.
    try {
      this.scheduleFileSave("journal", this.journalPath, () => this.journal);
    } catch {
      /* 저장만 건너뛴다 */
    }
    this.emit("journal", entry);
    if (entry.notify) {
      const notifyEvent: NotifyEvent = {
        title: entry.notifyTitle ?? "Capri 자동매매",
        body: entry.summary,
        symbol: entry.symbol,
        ts: entry.ts,
      };
      this.emit("notify", notifyEvent);
    }
    return entry;
  }
}
