// =============================================================================
// lib/defense.ts — [v0.63.0] "방어 전략" 순수 함수 모음 (파일·네트워크 없음 → 테스트 쉬움)
// -----------------------------------------------------------------------------
// [왜 만들었나 — 오너·카일 요청 2026-10-06]
//   그룹 실매매 기록 분석 결과: 승률 86%인데 순손익은 마이너스였다. 익절 ≈ +1.5%, 손절 ≈ −10%
//   라서 손절 한 번이 익절 약 6~7번을 지운다(본전 승률 ≈ 87%). 그리고 손절은 대부분 "EMA200
//   하방 이탈 후에도 6% 가까이 더 버티다" 나왔다 — 매매 근거(EMA 지지)가 깨진 뒤에도 계속
//   들고 있었던 셈. 아래 다섯 가지 방어 장치를 추가한다(모두 설정에서 켜고 끌 수 있음).
//     ① EMA 기준 손절(구조적 손절)      — structuralStopPrice
//     ③ 변동성(ATR%) 상한 필터          — evaluateDefenseFilters
//     ④ EMA 최소 이격도 + EMA 기울기    — evaluateDefenseFilters
//     ⑤ 손절 종목 당일 재진입 금지       — isReentryBlocked
//        연속 손절 시 자동매매 자동 중지  — trailingStopLossStreak
//   ② 측정(이격도·ATR%·기울기·보유 중 최저/최고가·실제 체결가)은 엔진이 기록한다.
// =============================================================================

import { DateTime } from "luxon";
import type { Candle } from "./indicators";
import { ema } from "./indicators";

/** EMA 기울기를 잴 때 비교하는 과거 봉 수(5분봉 12개 = 1시간 전 EMA와 비교). */
export const EMA_SLOPE_LOOKBACK_BARS = 12;

/** 진입 시점 측정값(기록·필터 공용). 계산 불가면 null. */
export interface EntryMetrics {
  emaGapPct: number | null; //   전봉종가가 EMA보다 몇 % 위인가 = (전봉종가 ÷ EMA − 1) × 100
  atrPct: number | null; //      최근 5분봉 평균 실제 변동폭(ATR) ÷ 종가 × 100 — 한 봉이 보통 몇 % 움직이나
  emaSlopePct: number | null; // 지금 EMA가 1시간 전 EMA보다 몇 % 높은가(+면 상승 중, −면 하락 중)
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * atrPct — 평균 실제 변동폭(ATR, 기본 14봉)을 마지막 종가 대비 %로.
 *   실제 변동폭(TR) = max(고가−저가, |고가−전봉종가|, |저가−전봉종가|) — 갭(봉 사이 점프)까지 포함.
 *   원본(일반) 캔들을 넣어야 한다(하이킨아시는 평균값이라 실제 변동폭을 줄여 보이게 한다).
 */
export function atrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  const last = candles[candles.length - 1].close;
  return last > 0 ? r2((sum / period / last) * 100) : null;
}

/** emaSlopePct — EMA(period)의 지금 값 vs lookback봉 전 값의 변화율(%). */
export function emaSlopePct(closes: number[], period: number, lookback = EMA_SLOPE_LOOKBACK_BARS): number | null {
  if (closes.length < period + lookback) return null;
  const now = ema(closes, period);
  const before = ema(closes.slice(0, closes.length - lookback), period);
  if (now == null || before == null || before <= 0) return null;
  return r2((now / before - 1) * 100);
}

/** emaGapPct — 전봉종가가 EMA보다 몇 % 위인지(아래면 음수). */
export function emaGapPct(prevClose: number | null, emaValue: number | null): number | null {
  if (prevClose == null || emaValue == null || !(emaValue > 0)) return null;
  return r2((prevClose / emaValue - 1) * 100);
}

export interface DefenseFilterSettings {
  emaMinGapEnabled: boolean;
  emaMinGapPct: number; //     기본 6(카일 제안)
  emaSlopeEnabled: boolean; // 켜면 EMA가 1시간 전보다 높아야(상승 중) 통과
  atrFilterEnabled: boolean;
  atrMaxPct: number; //        기본 3 — 한 봉 평균 변동이 이보다 크면 "너무 출렁이는 종목"으로 배제
}

export interface DefenseFilterResult {
  emaGapOk: boolean;
  emaSlopeOk: boolean;
  atrOk: boolean;
  ok: boolean; // 셋 다 통과
  reasons: string[]; // 탈락 사유(화면·통계용)
}

/**
 * evaluateDefenseFilters — ③④ 필터 판정. 꺼진 필터는 항상 통과.
 *   [측정값이 null(계산 불가)이면?] 켜져 있는 필터는 "모르면 탈락"으로 처리한다 — 방어 필터의
 *   목적상 확인 못 한 걸 통과시키는 쪽이 더 위험하다(실계좌).
 */
export function evaluateDefenseFilters(m: EntryMetrics, s: DefenseFilterSettings): DefenseFilterResult {
  const reasons: string[] = [];
  const emaGapOk = !s.emaMinGapEnabled || (m.emaGapPct != null && m.emaGapPct >= s.emaMinGapPct);
  if (!emaGapOk) {
    reasons.push(m.emaGapPct == null ? "EMA 이격도 계산 불가" : `EMA 이격도 ${m.emaGapPct}% < ${s.emaMinGapPct}%`);
  }
  const emaSlopeOk = !s.emaSlopeEnabled || (m.emaSlopePct != null && m.emaSlopePct > 0);
  if (!emaSlopeOk) {
    reasons.push(m.emaSlopePct == null ? "EMA 기울기 계산 불가" : `EMA가 상승 중 아님(1시간 변화 ${m.emaSlopePct}%)`);
  }
  const atrOk = !s.atrFilterEnabled || (m.atrPct != null && m.atrPct <= s.atrMaxPct);
  if (!atrOk) {
    reasons.push(m.atrPct == null ? "변동성(ATR) 계산 불가" : `변동성 과다(5분봉 평균 ${m.atrPct}% > ${s.atrMaxPct}%)`);
  }
  return { emaGapOk, emaSlopeOk, atrOk, ok: emaGapOk && emaSlopeOk && atrOk, reasons };
}

/**
 * ① structuralStopPrice — "EMA 기준 손절" 손절가.
 *   EMA × (1 − 여유%)를 손절가로 쓰되, 기존 고정 손절가(진입가 −N%)보다 **낮아지지는 않게** 한다
 *   (= 둘 중 더 높은 = 더 빨리 끊는 쪽). 이유: EMA 기준이 고정 손절보다 아래라면 고정 손절이
 *   이미 더 타이트하므로 그대로 둔다 — 손실 상한(−N%)은 어떤 경우에도 넘지 않는다.
 *   [null 반환] EMA 기준 손절가가 진입가 이상이면(진입가가 EMA에 바짝 붙어 여유가 없는 경우)
 *   손절선을 진입가 위에 둘 수 없으므로 null → 호출부가 "진입 안 함"으로 처리한다.
 */
export function structuralStopPrice(entry: number, emaValue: number, bufferPct: number, fixedSl: number): number | null {
  const emaStop = emaValue * (1 - bufferPct / 100);
  if (!(emaStop < entry)) return null;
  return Math.max(fixedSl, emaStop);
}

/** 손절 기록 한 줄(재진입 금지·연속 손절 판단에 필요한 최소 필드). */
export interface StopHistoryRow {
  symbol: string;
  status: string;
  exitedAt: string | null; // KST "MM-dd HH:mm:ss"
}

/**
 * ⑤-a isReentryBlocked — 이 종목이 "오늘(KST)" 손절된 적이 있으면 true.
 *   손절 직후 같은 종목이 다시 신호를 내는 건 대개 하락 추세 속 반등이라 같은 손실을 반복하기 쉽다
 *   (실데이터: BIYA가 1분 간격으로 두 번 진입해 둘 다 손절).
 */
export function isReentryBlocked(history: StopHistoryRow[], symbol: string, nowMs: number): boolean {
  const today = DateTime.fromMillis(nowMs).setZone("Asia/Seoul").toFormat("MM-dd");
  const sym = symbol.toUpperCase();
  return history.some((h) => h.status === "closed_loss" && h.symbol.toUpperCase() === sym && (h.exitedAt ?? "").startsWith(today));
}

/**
 * ⑤-b trailingStopLossStreak — 가장 최근 청산부터 거꾸로 세어 "연속 손절"이 몇 번인지.
 *   익절이 하나라도 끼면 거기서 끊긴다. 취소·실패 등(매매 아님)은 건너뛴다.
 *   history는 시간 순서(오래된 → 최신)로 들어온다고 가정하되, 청산 시각 문자열로 다시 정렬한다.
 */
export function trailingStopLossStreak(history: StopHistoryRow[], sinceMs?: number, refMs?: number): number {
  const closed = history
    .filter((h) => (h.status === "closed_loss" || h.status === "closed_win") && h.exitedAt)
    .filter((h) => {
      if (sinceMs == null) return true;
      const year = DateTime.fromMillis(refMs ?? sinceMs).setZone("Asia/Seoul").year;
      const t = DateTime.fromFormat(`${year} ${h.exitedAt}`, "yyyy MM-dd HH:mm:ss", { zone: "Asia/Seoul" }).toMillis();
      // 청산 시각 문자열은 초 단위라, 기준 시각도 초 단위로 내려서 비교(같은 초에 끝난 매매가 빠지지 않게).
      return Number.isFinite(t) && t >= Math.floor(sinceMs / 1000) * 1000;
    })
    .sort((a, b) => (a.exitedAt! < b.exitedAt! ? -1 : a.exitedAt! > b.exitedAt! ? 1 : 0));
  let n = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i].status === "closed_loss") n++;
    else break;
  }
  return n;
}

/**
 * ② excursion — 보유 기간 동안의 최저·최고가로 "최대 역행(MAE)·최대 순행(MFE)"을 % 로.
 *   MAE: 진입 후 가장 많이 불리했던 순간(음수 %), MFE: 가장 유리했던 순간(양수 %).
 *   이 값이 쌓이면 "EMA 기준 손절이었다면 이긴 매매 중 몇 개가 손절됐을지"를 사후에 계산할 수 있다.
 */
export function excursion(candles: Candle[], entry: number, fromMs: number, toMs: number): { maePct: number; mfePct: number; lowest: number; highest: number } | null {
  const inside = candles.filter((c) => c.time >= fromMs - 60_000 && c.time <= toMs);
  if (inside.length === 0 || !(entry > 0)) return null;
  const lowest = Math.min(...inside.map((c) => c.low));
  const highest = Math.max(...inside.map((c) => c.high));
  return { maePct: r2((lowest / entry - 1) * 100), mfePct: r2((highest / entry - 1) * 100), lowest, highest };
}
