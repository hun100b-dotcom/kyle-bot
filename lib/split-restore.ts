// =============================================================================
// lib/split-restore.ts — 옛 삼분할 기록에서 '계산기 입력값'을 되살린다
// -----------------------------------------------------------------------------
// [왜 필요한가 — 실제로 겪은 문제]
//   v0.9.0에서 [계산기로 불러오기] 를 넣으면서, 저장할 때 계산 재료(전봉종가·EMA200 등)를
//   함께 담기 시작했습니다. 그런데 **그 전에 저장한 기록에는 재료가 없어서** 버튼이
//   회색(비활성)으로만 보였고, 사장님 눈에는 "버튼이 안 눌린다"로 보였습니다.
//
// [해결 아이디어]
//   재료가 없어도 **결과(진입가 3개)로부터 거꾸로 계산**할 수 있습니다.
//   삼분할 계산식이 정해져 있기 때문입니다:
//       gap  = 전봉종가 − EMA200
//       1분할 = 전봉종가 − gap/3,  2분할 = 전봉종가 − gap×2/3,  3분할 = EMA200
//   여기서 3분할 진입가가 곧 EMA200이고, 1분할 진입가를 이용해 전봉종가를 되살립니다:
//       전봉종가 = (3 × 1분할가 − EMA200) ÷ 2
//
// [정확도] 저장된 진입가는 호가 단위로 잘려 있어, 되살린 값이 **1틱 정도 다를 수 있습니다.**
//   그래서 화면에서는 "복원값"이라고 표시해 사장님이 알고 쓰시게 합니다.
// =============================================================================

import { getTick, roundPrice } from "./calc";

/** 저장된 기록 중 되살리기에 필요한 부분만 */
export interface RestorableSplit {
  symbol: string;
  technique: "split3" | "orderbook" | "candle" | "manual";
  levels: { level: number; entry: number }[];
  tpPct: number | null;
  slPct: number | null;
  qty: number | null;
}

/** 계산기 폼에 넣을 값(문자열 — 입력칸이 문자열을 쓰기 때문) */
export interface RestoredInputs {
  technique: RestorableSplit["technique"];
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

/** 숫자를 입력칸 문자열로(불필요한 소수점 0 제거) */
function str(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "";
  return String(Math.round(v * 10000) / 10000);
}

/**
 * restoreInputsFromSaved — 옛 기록에서 계산기 입력값을 되살린다.
 *   되살릴 수 없으면 null(그때는 버튼을 비활성으로 둔다).
 */
export function restoreInputsFromSaved(s: RestorableSplit): RestoredInputs | null {
  const base: Omit<RestoredInputs, "baseClose" | "ema200" | "wallPrice" | "barOpen" | "manualEntry" | "gap"> = {
    technique: s.technique,
    symbol: s.symbol,
    tpPct: str(s.tpPct),
    slPct: str(s.slPct),
    qty: str(s.qty),
    candleYang: false,
    curPrice: null,
  };
  const empty = { baseClose: "", ema200: "", wallPrice: "", barOpen: "", manualEntry: "" };

  if (s.technique === "split3") {
    // 3분할이 EMA200, 1분할로부터 전봉종가를 되살린다.
    const lv1 = s.levels.find((l) => l.level === 1)?.entry;
    const lv3 = s.levels.find((l) => l.level === 3)?.entry;
    if (lv1 == null || lv3 == null || !Number.isFinite(lv1) || !Number.isFinite(lv3)) return null;
    const ema200 = lv3;
    const baseClose = roundPrice((3 * lv1 - ema200) / 2);
    if (!(baseClose > ema200)) return null; // 되살린 값이 이상하면(전봉종가 ≤ EMA200) 포기
    return { ...base, ...empty, baseClose: str(baseClose), ema200: str(ema200), gap: roundPrice(baseClose - ema200) };
  }

  const only = s.levels[0]?.entry;
  if (only == null || !Number.isFinite(only)) return null;

  if (s.technique === "orderbook") {
    // 진입 = 매수벽 + 1틱  →  매수벽 = 진입 − 1틱
    const tick = getTick(only);
    return { ...base, ...empty, wallPrice: str(roundPrice(only - tick)), gap: null };
  }
  if (s.technique === "candle") {
    // 진입 = 현재봉 시가 − 3틱  →  시가 = 진입 + 3틱
    const tick = getTick(only);
    return { ...base, ...empty, barOpen: str(roundPrice(only + 3 * tick)), gap: null };
  }
  // 수동 입력: 진입가가 곧 입력값
  return { ...base, ...empty, manualEntry: str(only), gap: null };
}
