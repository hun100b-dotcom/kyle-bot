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
import { join } from "node:path";
import { DateTime } from "luxon";
import { getSession, getSessionStart, isOrderFrozen, type Session } from "../lib/session";
import { calcSplit3, calcOrderbook, calcCandle, roundPrice, getTick, type SplitOrder } from "../lib/calc";
import { encryptSecret, decryptSecret, deriveSyncId } from "../lib/keysync"; // [v0.8.0] 키 기기 간 동기화(클라이언트 암호화)
import { strengthFromTicks, type Side } from "../lib/strength";
import { aggregate1mTo5m, dropIncompleteBucket, toHeikinAshi, inPriceBand, ema, ichimoku, scanSessionPattern, type Candle, type SessionPattern } from "../lib/indicators";
import {
  getPrice,
  getTrades,
  getRankings,
  getStocks,
  getCandles1mPaged,
  getAccounts,
  getBuyingPower,
  getSellable,
  getHoldings,
  getCommissions,
  getExchangeRate,
  createOrder,
  createConditionalOrder,
  listOrders,
  listConditionalOrders,
  listOrdersRaw,
  listConditionalOrdersRaw,
  mapOrderStatus,
  cancelOrder,
  cancelConditionalOrder,
  clearTokenCache,
  makeClientOrderId,
  type ConditionalOrderResponse,
  type OrderResponse,
} from "../lib/toss";
import { createMockTossServer } from "../mocks/toss-mock";

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

/** 주문/기록 저널 한 줄(파일로 영속) */
export interface JournalEntry {
  ts: string;
  kind: "entry" | "oco" | "oto" | "cancel" | "dryrun" | "info";
  symbol: string;
  summary: string; // 사람이 읽는 한 줄 요약
  detail?: unknown;
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
  buyVol: number; //         이 창에서 매수로 분류된 체결량
  sellVol: number; //        이 창에서 매도로 분류된 체결량
  strength: number | null; // (매수/매도)×100. 매도 0이면 null("매수 일방")
  nTicks: number; //         표본 틱 수(신뢰도 참고)
  session: string; //        데이/프리/본장 등(국면 표시)
}

/** 화면에 돌려주는 체결강도 상태(현재값 + 최근 시계열) */
export interface StrengthState {
  symbol: string;
  running: boolean; //       지금 기록 중인가
  intervalSec: number; //    폴링 간격(초)
  latest: StrengthSample | null; // 가장 최근 샘플
  samples: StrengthSample[]; //     최근 시계열(오래된→최신)
  lastError: string | null; //      마지막 샘플링 오류(있으면 화면에 안내)
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
  };
}

/** 스크리너 결과 한 종목 */
export interface ScreenResult {
  rank: number; //           거래량 순위
  symbol: string;
  price: number | null; //   현재가
  ema200: number | null; //  5분봉 EMA200(하이킨아시 종가 기준)
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
}

/** 스캔 진행 상황(진행률 바) */
export interface ScreenProgress {
  phase: "ranking" | "scanning" | "done";
  done: number; //  처리한 종목 수
  total: number; // 전체 종목 수
  symbol: string; // 지금 처리 중인 종목
}

/** 스캔 최종 결과 */
export interface ScreenRun {
  scannedAt: string; //  스캔 시각(KST)
  total: number; //      실제 스캔한 종목 수(ETF 제외 후)
  bodyRatio: number; //  사용한 도지 몸통비율
  excludedEtf: number; // [v0.6.3] ETF·레버리지·인버스로 제외한 종목 수
  results: ScreenResult[]; // 후보(confirmed·watch) + 참고 목록
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
// 엔진 본체
// -----------------------------------------------------------------------------

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
  /** [v0.5.0] 체결강도 시계열 파일 경로 + 종목별 시계열(메모리 캐시). */
  private strengthPath: string;
  private strengthSeries: Record<string, StrengthSample[]> = {};
  /** [v0.5.0] 현재 '기록 중'인 종목들의 타이머·연속 상태(틱룰 seed·중복제거·간격·오류). */
  private strengthRuns = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; intervalSec: number; lastPrice?: number; lastSide: Side; seen: Set<string>; lastError: string | null }
  >();
  private static readonly STRENGTH_MAX_SAMPLES = 500; // 종목당 보관 상한(오래된 것부터 정리)
  /** [v0.6.0] 스크리너 중복 실행 방지(스캔 중 또 누르면 무시). */
  private screenBusy = false;
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

  private mock: ReturnType<typeof createMockTossServer> | null = null;
  private mockPort = 0;

  // 환율 캐시(토스 스펙: 1분 갱신이므로 60초 캐시)
  private fxCache: { rate: number; atMs: number; source: "toss" | "manual" } | null = null;
  private buyingPowerUsd: number | null = null;

  constructor(
    private userDataDir: string,
    opts?: { forceMock?: boolean },
  ) {
    super();
    mkdirSync(userDataDir, { recursive: true });
    this.envPath = join(userDataDir, ".env");
    this.journalPath = join(userDataDir, "kylebot-journal.json");
    this.rationalePath = join(userDataDir, "kylebot-rationale.json");
    this.splitsPath = join(userDataDir, "kylebot-splits.json"); // [v0.4.0] 삼분할 기록 파일
    this.strengthPath = join(userDataDir, "kylebot-strength.json"); // [v0.5.0] 체결강도 시계열
    this.tradesPath = join(userDataDir, "kylebot-trades.json"); // [v0.7.0] 자동 기록 트레이드
    this.loadEnv();
    // [개발 검증용] E2E 등 자동 검증은 절대 실서버를 건드리면 안 되므로 연습 모드 강제.
    if (opts?.forceMock) this.mode = "mock";
    this.loadJournal();
    this.loadRationales();
    this.loadSplits();
    this.loadStrength();
    this.loadTrades();
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
    };
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
      "",
    ].join("\n");
    // 환경변수에도 반영(다음 loadEnv 없이도 일관되게)
    process.env.LIVE_ORDERS = this.liveOrdersEnabled ? "true" : "false";
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
    return this.getSettings();
  }

  // --------------------------------------------------------------------------
  // [v0.8.0] 토스 키 기기 간 동기화 — Supabase에 "암호문만" 저장/복원
  //   ⚠️ 평문 키는 절대 클라우드에 올리지 않는다. 오너의 마스터 비밀번호(passphrase)로
  //   기기에서 암호화한 뒤 암호문만 저장한다. passphrase 는 어디에도 저장하지 않는다.
  // --------------------------------------------------------------------------
  //  아래 두 값은 "공개용(publishable) anon 키/URL"이라 앱에 넣어도 안전하다.
  //  (실제 보호는 RLS + 클라이언트 암호화가 한다. 토스 실키와는 무관하다.)
  private static readonly SUPABASE_URL = "https://hmjxrqhcwjyfkvlcejfc.supabase.co";
  private static readonly SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhtanhycWhjd2p5Zmt2bGNlamZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNTEwNTMsImV4cCI6MjA4ODYyNzA1M30.gr9poC-5808qHRoYc-5WH3dTqXupEEJpDdztv2fddog";

  private supabaseHeaders(): Record<string, string> {
    return {
      apikey: ToolEngine.SUPABASE_ANON,
      Authorization: `Bearer ${ToolEngine.SUPABASE_ANON}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * [v0.8.0] 지금 이 기기의 토스 키를 마스터 비밀번호로 암호화해 클라우드에 올린다(다른 기기가 받도록).
   *   ❌ 주문과 무관한 저장 작업이다. 평문은 올라가지 않는다.
   */
  async syncPushKeys(passphrase: string): Promise<{ ok: boolean; message: string }> {
    const clientId = process.env.TOSS_CLIENT_ID ?? "";
    const clientSecret = process.env.TOSS_CLIENT_SECRET ?? "";
    const account = process.env.TOSS_ACCOUNT ?? "";
    if (!clientId || !clientSecret) {
      return { ok: false, message: "먼저 [설정]에서 Client ID/Secret을 입력·저장한 뒤 동기화하세요." };
    }
    try {
      const rec = await encryptSecret({ clientId, clientSecret, account }, passphrase);
      // upsert: 같은 sync_id면 갱신, 없으면 삽입 (PostgREST merge-duplicates)
      const res = await fetch(`${ToolEngine.SUPABASE_URL}/rest/v1/capri_secrets?on_conflict=sync_id`, {
        method: "POST",
        headers: { ...this.supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ sync_id: rec.syncId, ciphertext: rec.ciphertext, salt: rec.salt, iv: rec.iv, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) return { ok: false, message: `클라우드 저장 실패(HTTP ${res.status}). 잠시 후 다시 시도하세요.` };
      this.addJournal({ kind: "info", symbol: "-", summary: "🔐 토스 키를 암호화해 클라우드에 저장(다른 기기에서 같은 비밀번호로 불러올 수 있음)" });
      return { ok: true, message: "클라우드에 암호화 저장했습니다. 다른 기기에서 같은 마스터 비밀번호로 [불러오기] 하세요." };
    } catch (e) {
      return { ok: false, message: String(e).replace(/^Error:\s*/, "") };
    }
  }

  /**
   * [v0.8.0] 클라우드에서 암호문을 받아 마스터 비밀번호로 복호화해 이 기기에 적용한다.
   *   복호화 성공 시 saveSettings로 로컬 .env에도 저장하고 토큰을 재발급한다(즉시 사용 가능).
   */
  async syncPullKeys(passphrase: string): Promise<{ ok: boolean; message: string }> {
    try {
      const syncId = await deriveSyncId(passphrase);
      const url = `${ToolEngine.SUPABASE_URL}/rest/v1/capri_secrets?sync_id=eq.${encodeURIComponent(syncId)}&select=ciphertext,salt,iv`;
      const res = await fetch(url, { headers: this.supabaseHeaders() });
      if (!res.ok) return { ok: false, message: `클라우드 조회 실패(HTTP ${res.status}).` };
      const rows = (await res.json()) as Array<{ ciphertext: string; salt: string; iv: string }>;
      if (!rows || rows.length === 0) {
        return { ok: false, message: "이 마스터 비밀번호로 저장된 키가 없습니다. 다른 기기에서 먼저 [클라우드에 저장]했는지, 비밀번호가 맞는지 확인하세요." };
      }
      const payload = await decryptSecret(rows[0], passphrase); // 틀린 비번이면 여기서 실패
      // 복호화된 키를 이 기기에 적용·저장(로컬 .env). 토큰 캐시도 자동 갱신됨.
      await this.saveSettings({ mode: "live", clientId: payload.clientId, clientSecret: payload.clientSecret, account: payload.account });
      this.addJournal({ kind: "info", symbol: "-", summary: "🔓 클라우드에서 토스 키를 복호화해 이 기기에 적용(재입력 불필요)" });
      return { ok: true, message: "클라우드에서 키를 불러와 적용했습니다. 이제 이 기기에서 바로 조회·주문이 됩니다." };
    } catch (e) {
      // decryptSecret 실패(비번 오류) 등은 여기로
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
    const symbol = spec.symbol.toUpperCase();
    const cur = await this.orderGate(symbol, [spec.price]);
    // [B4] 매수 가능 금액 초과면 여기서 막는다(실서버에서만 검사).
    await this.assertAffordable(spec.price, spec.quantity);

    // 주문번호(clientOrderId)를 **미리** 만든다. 근거 기록의 열쇠로 써야 하므로
    //   createOrder 호출 안에서 즉석 생성하면 우리가 그 값을 알 수 없다.
    const clientOrderId = makeClientOrderId(`tool${DateTime.now().toFormat("HHmmss")}`, 1, "entry");

    if (this.isDryRun()) {
      this.saveRationale(spec.rationale, {
        clientOrderId,
        kind: "entry",
        symbol,
        quantity: spec.quantity,
        priceAtOrder: cur,
        dryRun: true,
      });
      void this.recordEntry(symbol, spec.price, this.currentMode()); // [v0.7.0] 진입 체결강도 자동 스냅샷(주문과 무관)
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 진입 지정가 매수 ${symbol} $${spec.price} × ${spec.quantity}주 (실주문 잠금 — 실제 전송 안 함)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const o = await createOrder({
      symbol,
      side: "BUY",
      orderType: "LIMIT",
      price: spec.price,
      quantity: spec.quantity,
      clientOrderId,
    });
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
    void this.recordEntry(symbol, spec.price, this.currentMode()); // [v0.7.0] 진입 체결강도 자동 스냅샷(주문과 무관)
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
  }): Promise<JournalEntry> {
    const symbol = spec.symbol.toUpperCase();
    const cur = await this.orderGate(symbol); // 익절/손절 감시가는 ±검사 대신 아래 OCO 규칙으로 검증
    // 스펙 규칙 사전 검증(서버 400 전에 친절한 한국어로)
    if (!(spec.tpTrigger > cur && cur > spec.slTrigger)) {
      // [v0.2.8 — 막지 않는다] 토스 스펙상 OCO는 "익절>현재가>손절"을 요구하지만 그 판단은 토스가 한다.
      //   우리가 미리 막으면 시세가 움직이는 순간 오너가 기회를 놓친다. 경고만 남기고 그대로 전송.
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ 참고: 토스 OCO 규칙(익절 $${spec.tpTrigger} > 현재가 $${cur} > 손절 $${spec.slTrigger})과 어긋납니다. 그래도 전송합니다 — 거부되면 토스 응답을 보여드립니다.`,
      });
    }

    // 근거 기록의 열쇠. 미리 만들어 두고 주문·기록에 같은 값을 쓴다(멱등키 겸용).
    const clientOrderId = makeClientOrderId(`oco${DateTime.now().toFormat("HHmmss")}`, 1, "oco");

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
    const c = await createConditionalOrder({
      symbol,
      type: "OCO",
      quantity: spec.quantity,
      orderType: "LIMIT",
      expireDate: spec.expireDate,
      first: { orderSide: "SELL", triggerPrice: spec.tpTrigger, orderPrice: spec.tpPrice },
      second: { orderSide: "SELL", triggerPrice: spec.slTrigger, orderPrice: spec.slPrice },
      // [B5] 멱등키: 네트워크 재시도로 조건주문이 두 번 등록되는 걸 막는다(진입 주문과 동일 원칙).
      clientOrderId,
    });
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
    const cur = await this.orderGate(symbol); // 사전차단용 아님(막지 않음) — 현재가 참고·경고용
    // [막지 않는다] 통상 진입가는 현재가 이하, 익절가는 진입가 위다. 어긋나도 전송하고 토스 판단에 맡긴다.
    if (!(spec.tpTrigger > spec.entryTrigger)) {
      this.addJournal({
        kind: "info",
        symbol,
        summary: `⚠️ 참고: 익절가 $${spec.tpTrigger} 가 진입가 $${spec.entryTrigger} 보다 높지 않습니다. 그래도 전송합니다 — 거부되면 토스 응답을 보여드립니다.`,
      });
    }

    // 근거 기록 열쇠 겸 멱등키(중복 전송 방지). 미리 만들어 주문·기록에 같은 값을 쓴다.
    const clientOrderId = makeClientOrderId(`oto${DateTime.now().toFormat("HHmmss")}`, 1, "oto");

    if (this.isDryRun()) {
      this.saveRationale(spec.rationale, {
        clientOrderId,
        kind: "oto",
        symbol,
        quantity: spec.quantity,
        priceAtOrder: cur,
        dryRun: true,
      });
      void this.recordEntry(symbol, spec.entryPrice, this.currentMode()); // [v0.7.0] 진입(OTO) 체결강도 자동 스냅샷
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] OTO 등록 ${symbol} ${spec.quantity}주: 진입 $${spec.entryPrice} → 익절 $${spec.tpPrice} (손절 미포함·실주문 잠금)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const c = await createConditionalOrder({
      symbol,
      type: "OTO",
      quantity: spec.quantity,
      orderType: "LIMIT",
      expireDate: spec.expireDate,
      first: { orderSide: "BUY", triggerPrice: spec.entryTrigger, orderPrice: spec.entryPrice },
      second: { orderSide: "SELL", triggerPrice: spec.tpTrigger, orderPrice: spec.tpPrice },
      clientOrderId,
    });
    this.saveRationale(spec.rationale, {
      clientOrderId,
      kind: "oto",
      symbol,
      quantity: spec.quantity,
      priceAtOrder: cur,
      dryRun: false,
      tossOrderId: c.conditionalOrderId,
    });
    void this.recordEntry(symbol, spec.entryPrice, this.currentMode()); // [v0.7.0] 진입(OTO) 체결강도 자동 스냅샷
    return this.addJournal({
      kind: "oto",
      symbol,
      summary: `OTO 등록 완료 ${symbol} ${spec.quantity}주: 진입 $${spec.entryPrice} 체결 시 → 익절 $${spec.tpPrice} 자동 매도 (번호 ${c.conditionalOrderId}) — 손절 미포함, 토스 서버가 감시`,
      detail: c,
    });
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
    const o = await cancelOrder(orderId);
    return this.addJournal({ kind: "cancel", symbol: o.symbol ?? "-", summary: `주문 취소 ${orderId} → ${o.status}` });
  }

  async cancelConditional(id: string): Promise<JournalEntry> {
    if (this.killSwitch) throw new Error("킬 스위치가 켜져 있습니다.");
    await this.prepareBackend(); // 접속 상태 단일 진실 소스 유지
    if (this.isDryRun()) {
      return this.addJournal({ kind: "dryrun", symbol: "-", summary: `[드라이런] 조건주문 취소 ${id} (실제 전송 안 함)` });
    }
    await cancelConditionalOrder(id);
    return this.addJournal({ kind: "cancel", symbol: "-", summary: `조건주문 취소 ${id}` });
  }

  // --------------------------------------------------------------------------
  // 상태·저널
  // --------------------------------------------------------------------------
  getStatus(): ToolStatus {
    const now = DateTime.now().setZone("Asia/Seoul");
    return {
      mode: this.mode,
      dryRun: this.isDryRun(),
      liveOrdersEnabled: this.liveOrdersEnabled,
      skipOrderConfirm: this.skipOrderConfirm,
      killSwitch: this.killSwitch,
      session: getSession(now),
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
        ...input,
        ...fixed,
      };
      this.rationales.push(rec);
      if (this.rationales.length > 2000) this.rationales.shift(); // 오래된 것부터 정리
      const tmp = this.rationalePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.rationales, null, 2), "utf8");
      renameSync(tmp, this.rationalePath); // 원자적 교체(쓰다 만 파일 방지)
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
  }

  /** 메모리의 기록 목록을 파일에 원자적으로 저장(쓰다 만 파일 방지). */
  private persistSplits(): void {
    const tmp = this.splitsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.splits, null, 2), "utf8");
    renameSync(tmp, this.splitsPath);
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
    this.persistSplits();
    return this.getSplits();
  }

  /** 특정 기록의 특정 분할에 대해 [진입완료] 체크를 뒤집는다. */
  toggleSplitEntered(id: string, level: number): SavedSplit[] {
    this.splits = toggleSavedLevel(this.splits, id, level);
    this.persistSplits();
    return this.getSplits();
  }

  /** 기록의 제목(메모)을 수정한다(연필 → 인라인 편집). 파일에 반영, 앱 재시작해도 유지. */
  renameSplit(id: string, memo: string): SavedSplit[] {
    this.splits = renameSavedSplit(this.splits, id, memo);
    this.persistSplits();
    return this.getSplits();
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

  /** 시계열을 파일에 원자적으로 저장. */
  private persistStrength(): void {
    const tmp = this.strengthPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.strengthSeries, null, 2), "utf8");
    renameSync(tmp, this.strengthPath);
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
  startStrength(symbol: string, intervalSec = 10): StrengthState {
    const sym = (symbol || "").toUpperCase().trim();
    if (!sym) throw new Error("종목 코드를 입력하세요.");
    const iv = Math.min(60, Math.max(3, Math.floor(intervalSec) || 10)); // 3~60초로 안전 보정
    if (this.strengthRuns.has(sym)) return this.getStrengthState(sym); // 중복 시작 방지

    // 연속 상태 초기화: 틱룰 seed(직전가/방향)와 중복제거 집합.
    const run = { timer: setInterval(() => void this.sampleStrengthOnce(sym), iv * 1000), intervalSec: iv, lastSide: "buy" as Side, seen: new Set<string>(), lastError: null as string | null };
    this.strengthRuns.set(sym, run);
    void this.sampleStrengthOnce(sym); // 시작 즉시 1회(기다리지 않게)
    this.addJournal({ kind: "info", symbol: sym, summary: `체결강도 기록 시작 (${iv}초 간격)` });
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
      latest: samples.length ? samples[samples.length - 1] : null,
      samples: samples.slice(-120), // 최근 120개만 화면으로(스파크라인·표에 충분)
      lastError: run?.lastError ?? null,
    };
  }

  /**
   * sampleStrengthOnce — 체결강도 한 점을 수집한다(타이머가 부르는 실제 작업).
   *   ① trades(최근 ~50틱) 조회 → ② 숫자로 정규화 + 중복 제거 → ③ 틱룰 분류·강도 계산
   *   → ④ 샘플 한 줄 저장 → ⑤ 화면에 이벤트로 알림. 오류는 삼켜서(다음 주기 재시도) 앱을 지킨다.
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
      //   단, 창 전체가 이미 다 본 틱이면(=신규 0) 강도는 직전 값을 유지하는 셈이 되므로,
      //   표시용으로는 '이번 창 전체'로 계산하되 seed 연속성은 유지한다(HTS식 롤링 강도).
      const fresh = ticks.filter((t) => !run.seen.has(`${t.timestamp}|${t.price}|${t.volume}`));
      for (const t of ticks) run.seen.add(`${t.timestamp}|${t.price}|${t.volume}`);
      if (run.seen.size > 5000) run.seen = new Set([...run.seen].slice(-2000)); // 메모리 상한

      // 강도 계산: '이번에 받은 창(최근 50틱)' 기준(롤링). seed로 직전가·방향을 이어 붙인다.
      const { result, lastPrice, lastSide } = strengthFromTicks(ticks, run.lastPrice, run.lastSide);
      run.lastPrice = lastPrice;
      run.lastSide = lastSide;
      run.lastError = null;

      const now = DateTime.now().setZone("Asia/Seoul");
      const sample: StrengthSample = {
        ts: now.toFormat("MM-dd HH:mm:ss"),
        tsMs: now.toMillis(),
        price: lastPrice ?? null,
        buyVol: result.buyVol,
        sellVol: result.sellVol,
        strength: result.strength,
        nTicks: result.nTicks,
        session: getSession(now),
      };
      void fresh; // (참고: 신규 틱 수는 향후 연구용. MVP 표시는 롤링 창 기준.)

      const arr = this.strengthSeries[sym] ?? (this.strengthSeries[sym] = []);
      arr.push(sample);
      if (arr.length > ToolEngine.STRENGTH_MAX_SAMPLES) arr.shift();
      this.persistStrength();
      this.emit("strength", this.getStrengthState(sym)); // 화면 실시간 갱신
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (run) run.lastError = msg;
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
    const tmp = this.tradesPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.trades, null, 2), "utf8");
    renameSync(tmp, this.tradesPath);
  }

  /** 지금 모드가 페이퍼(mock/dryrun)인지 실거래(real)인지 태그. */
  private currentMode(): "mock" | "dryrun" | "real" {
    if (this.mode === "mock") return "mock";
    return this.isDryRun() ? "dryrun" : "real";
  }

  /** 체결강도 스냅샷(읽기 전용). 실패해도 null만 돌려주고 절대 예외를 위로 던지지 않는다. */
  private async snapshotStrength(symbol: string): Promise<TradeSnapshot | null> {
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
  private async recordEntry(symbol: string, price: number, mode: "mock" | "dryrun" | "real"): Promise<void> {
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
      };
      this.trades.push(trade);
      if (this.trades.length > 1000) this.trades.shift();
      this.persistTrades();
      this.emit("trades", this.getTradeLog());
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
      t.exitPrice = px;
      t.exit = snap;
      t.exitKind = kind;
      t.resultPct = px != null && t.entryPrice ? Math.round(((px - t.entryPrice) / t.entryPrice) * 10000) / 100 : null;
      t.outcome = t.resultPct == null ? null : t.resultPct > 0 ? "win" : "loss";
      this.persistTrades();
      this.emit("trades", this.getTradeLog());
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
   * closeTradeManual — 토스 서버가 처리한 OCO/OTO 익절·손절은 앱이 관측 못 하므로,
   *   사용자가 분석 화면에서 확정가·구분(tp/sl/manual)을 넣어 트레이드를 수동 마감한다.
   */
  async closeTradeManual(id: string, exitPrice: number, kind: "tp" | "sl" | "manual"): Promise<StrengthTrade[]> {
    const t = this.trades.find((x) => x.id === id);
    if (t && t.outcome == null) {
      const snap = await this.snapshotStrength(t.symbol);
      const now = DateTime.now().setZone("Asia/Seoul");
      t.exitTs = now.toFormat("MM-dd HH:mm:ss");
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
   *   @param bodyRatio 도지 몸통비율 상한(0.1~0.5, 기본 0.3). 화면 슬라이더로 조절.
   *   @param count 스캔할 상위 종목 수(기본 60).
   */
  async scanScreener(bodyRatio = 0.3, count = 60): Promise<ScreenRun> {
    if (this.screenBusy) throw new Error("이미 스캔이 진행 중입니다. 끝날 때까지 기다려 주세요.");
    this.screenBusy = true;
    const br = Math.min(0.5, Math.max(0.1, bodyRatio)); // 0.1~0.5로 안전 보정
    try {
      await this.prepareBackend();

      // 1) 거래량 랭킹으로 스캔 대상 종목 확보
      this.emit("screener:progress", { phase: "ranking", done: 0, total: count, symbol: "" } as ScreenProgress);
      const ranked = await getRankings(count);

      // 1-b) [v0.6.3] ETF·레버리지·인버스 배제 — 종목 메타(securityType)를 한 번에 조회해 걸러낸다.
      //   securityType이 "STOCK"인 일반 주식만 남긴다(ETF/ETN 등은 전부 제외). 메타 조회가 실패하면
      //   (안전하게) 전부 통과시킨다 — 필터 때문에 스캔 자체가 막히지 않도록.
      let rankings = ranked;
      let excludedEtf = 0;
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
      const total = rankings.length;

      // 2) 현재 활성 장의 시작 시각(최고점 추적 기준). 장 마감 중이면 최근 8시간으로 폴백.
      const now = DateTime.now().setZone("Asia/Seoul");
      const sessionStart = getSessionStart(now);
      const sessionStartMs = sessionStart ? sessionStart.toMillis() : now.toMillis() - 8 * 3600_000;

      const results: ScreenResult[] = [];
      let done = 0;
      for (const rk of rankings) {
        this.emit("screener:progress", { phase: "scanning", done, total, symbol: rk.symbol } as ScreenProgress);
        try {
          // 1분봉을 과거로 당겨 ~1000개 이상 확보(EMA200엔 5분봉 200개=1분봉 1000개 필요)
          const oneMin = await getCandles1mPaged(rk.symbol, 1000);
          // [v0.6.2] 형성 중(미완성)인 마지막 5분봉은 판정에서 제외한다(완성된 봉만 사용).
          //   진행 중 봉으로 판정하면 봉 마감 후 음↔양이 뒤집혀 오판정이 난다(특히 HA).
          const raw5m: Candle[] = dropIncompleteBucket(aggregate1mTo5m(oneMin), now.toMillis());
          // 데이터 부족(EMA200 불가 = 완성된 5분봉 200개 미만)이면 건너뛴다
          if (raw5m.length < 200) {
            results.push(this.insufficientResult(rk, oneMin.length, raw5m.length));
            done++;
            continue;
          }

          // [v0.6.1] 도지·음봉·세션최고점·EMA200·이치모쿠를 '하이킨아시' 기준으로(사용자 차트와 일치).
          //   [v0.6.2] 위에서 미완성 봉을 뺀 '완성된' 5분봉만 HA로 변환 → 트리거 도지·다음 확정봉이 모두 완성봉.
          const candles5m = toHeikinAshi(raw5m); // 판정에 쓰는 캔들(HA, 완성봉만)
          const closes = candles5m.map((c) => c.close);

          const price = Number.isFinite(rk.lastPrice) ? rk.lastPrice : raw5m[raw5m.length - 1].close;
          const priceInBand = inPriceBand(price, 1, 9); // [v0.6.1] 가격 필터 $1~$9
          const ema200 = ema(closes, 200);
          const cloud = ichimoku(candles5m);
          const pat = scanSessionPattern(candles5m, sessionStartMs, br); // HA 캔들로 패턴 판정

          const aboveEma = ema200 != null && price > ema200;
          const aboveCloud = cloud != null && price > cloud.cloudTop;
          // 하드 게이트(가격대·EMA·구름)를 못 넘으면 패턴이 있어도 후보 아님 → none
          const status: ScreenStatus = priceInBand && aboveEma && aboveCloud ? pat.status : "none";
          const proximityPct = pat.sessionHigh && Number.isFinite(price) ? ((price - pat.sessionHigh) / pat.sessionHigh) * 100 : null;

          results.push({
            rank: rk.rank,
            symbol: rk.symbol,
            price,
            ema200,
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
          });
        } catch (err) {
          // 한 종목 실패가 전체 스캔을 죽이지 않게(개별 오류는 '데이터 부족'류로 표시)
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ ...this.insufficientResult(rk, 0, 0), note: `오류: ${msg}` });
        }
        done++;
      }

      this.emit("screener:progress", { phase: "done", done, total, symbol: "" } as ScreenProgress);
      // 정렬: 확정(🔴) → 관찰(🟡) → 나머지. 같은 등급이면 랭킹 순.
      const order: Record<ScreenStatus, number> = { confirmed: 0, watch: 1, none: 2, insufficient: 3 };
      results.sort((a, b) => order[a.status] - order[b.status] || a.rank - b.rank);
      return { scannedAt: now.toFormat("MM-dd HH:mm:ss"), total, bodyRatio: br, excludedEtf, results };
    } finally {
      this.screenBusy = false;
    }
  }

  /** 데이터 부족(저유동성 등) 결과 한 줄을 만든다. */
  private insufficientResult(rk: { rank: number; symbol: string; lastPrice: number }, n1m: number, n5m: number): ScreenResult {
    const price = Number.isFinite(rk.lastPrice) ? rk.lastPrice : null;
    return {
      rank: rk.rank,
      symbol: rk.symbol,
      price,
      ema200: null,
      cloudTop: null,
      priceInBand: inPriceBand(price, 1, 9),
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
        bothWicks: pat.dojiUpperWickPct != null && pat.dojiLowerWickPct != null && pat.dojiUpperWickPct >= 0.1 && pat.dojiLowerWickPct >= 0.1,
        nextBearish: pat.nextCandle ? pat.nextCandle.close < pat.nextCandle.open : false,
      },
    };
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
    await this.prepareBackend();
    this.assertAccountReady();
    const clientOrderId = makeClientOrderId(`sell${DateTime.now().toFormat("HHmmss")}`, 1, "sell");

    if (this.isDryRun()) {
      void this.recordExit(symbol, spec.price ?? null, "manual", this.currentMode()); // [v0.7.0] 청산 체결강도+결과 자동 기록
      return this.addJournal({
        kind: "dryrun",
        symbol,
        summary: `[드라이런] 매도 ${spec.orderType === "MARKET" ? "시장가" : `지정가 $${spec.price}`} ${symbol} ${spec.quantity}주 (실주문 잠금 — 전송 안 함)`,
        detail: { ...spec, clientOrderId },
      });
    }
    const o = await createOrder({
      symbol,
      side: "SELL",
      orderType: spec.orderType,
      price: spec.orderType === "LIMIT" ? spec.price : undefined,
      quantity: spec.quantity,
      clientOrderId,
    });
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
    const entry: JournalEntry = { ts: DateTime.now().setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss"), ...e };
    this.journal.push(entry);
    if (this.journal.length > 1000) this.journal.shift();
    // 원자적 저장(임시 파일 → 교체): 쓰다 만 파일 방지
    const tmp = this.journalPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.journal, null, 2), "utf8");
    renameSync(tmp, this.journalPath);
    this.emit("journal", entry);
    return entry;
  }
}
