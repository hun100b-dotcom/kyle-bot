// =============================================================================
// lib/history-reconcile.ts — 자동매매기록(엔진 자체 부기)을 토스 '실제 체결 내역'과 대조한다
//   (순수 계산, PC·폰 공통)
// -----------------------------------------------------------------------------
// [왜 필요한가 — 오너 실사용 보고 "매매기록 탭들이 실제 매매기록과 완벽하게 일치하지 않는다"]
//   카프리 안에는 매매 기록을 보여주는 방식이 사실 두 가지다:
//     ① "📊 매매 리포트" 탭 — lib/fills.ts의 matchFifo(토스 '종료된 주문'을 그대로 가져와
//        선입선출로 계산) 기반. 토스에 실제로 남은 체결 그대로라 **항상 정확**하다.
//     ② "자동매매기록"·"📑 자동매매 리포트"·"매매연구" 탭 — electron/tool-engine.ts가
//        진입 접수·체결 확인·조건주문 등록·발동 같은 **사건이 생길 때마다 스스로 적어 두는**
//        부기(autoTradeHistory, JSON)다. 체결 확인을 놓치거나(앱 재시작 등), 조건주문이
//        토스에서 사라지거나(v0.60.2), 보호주문 등록 자체가 실패하거나(v0.57.0/v0.62.0)
//        하면 이 부기는 실제 계좌 상태와 어긋날 수 있다 — 어긋나도 스스로는 알아챌 방법이
//        없다(자기 기록만 보고 있으므로).
//   그래서 ②가 보여주는 손익이 ①(=토스 실제)과 다르면, 오너 눈엔 "탭마다 숫자가 안 맞는다"로
//   보인다. 이 파일은 ②의 각 기록을 ①이 이미 갖고 있는 '실제 체결 매칭 결과'(RealizedTrade)와
//   대조해 "일치/불일치/확인 안 됨"을 판정한다 — 추측하지 않고, 실제로 매칭되는 체결이 있을
//   때만 숫자를 낸다.
// =============================================================================

import type { RealizedTrade } from "./fills";

/** 대조 대상이 되는 자동매매기록 한 건의 모양(엔진의 AutoTradeHistoryEntry 중 쓰는 것만). */
export interface ReconcilableEntry {
  id: string;
  symbol: string;
  /** 매수 주문을 접수한 시각(ms) — 보통 id의 세 번째 토막(`${symbol}@${entry}@${enteredAtMs}`)에서 뽑는다. */
  enteredAtMs: number;
  status: "watching" | "active" | "closed_win" | "closed_loss" | "closed_manual" | "cancelled" | "oco_failed" | "dryrun";
  pnlUsd: number | null;
  pnlPct: number | null;
}

export type HistoryReconcileStatus =
  | "matched" // 토스 체결과 맞아떨어짐(금액까지 일치)
  | "mismatch" // 토스에 체결은 있는데 기록한 손익과 다름
  | "enriched" // 기록엔 손익이 없었는데(손익 미확정) 토스 체결로 지금 확인됨
  | "not_found" // 이 창(window) 안에서 대응하는 토스 체결을 못 찾음
  | "not_applicable"; // 아직 진행 중(watching/active)이거나 연습(dryrun) — 대조 대상 아님

export interface HistoryReconcileResult {
  status: HistoryReconcileStatus;
  realBuyPrice?: number;
  realSellPrice?: number;
  realQty?: number;
  realPnlUsd?: number;
  realPnlPct?: number;
  realSellAtMs?: number;
}

const STATUSES_TO_CHECK = new Set<ReconcilableEntry["status"]>(["closed_win", "closed_loss", "closed_manual", "oco_failed", "cancelled"]);

/**
 * reconcileHistoryEntry — 자동매매기록 한 건을, 같은 종목·비슷한 시각의 실제 체결(매칭된
 *   매도 1건, RealizedTrade)과 대조한다.
 *
 * @param entry     대조할 자동매매기록 한 건
 * @param realized  lib/fills.ts의 matchFifo()가 만든 실제 체결 매칭 결과 전체(토스 종료된
 *                  주문 기반 — 기간을 넉넉히 넣어야 한다)
 * @param windowMs  매수 "접수" 시각과 실제 매수 "체결" 시각이 벌어질 수 있는 최대 폭.
 *                  자동매매 미체결 자동취소 상한이 60분이라, 넉넉히 90분을 기본값으로 둔다.
 * @param toleranceUsd 기록 손익과 실제 손익의 차이를 "같다"로 볼 허용 오차(반올림 오차 흡수)
 */
export function reconcileHistoryEntry(
  entry: ReconcilableEntry,
  realized: RealizedTrade[],
  windowMs = 90 * 60_000,
  toleranceUsd = 0.02,
): HistoryReconcileResult {
  if (!STATUSES_TO_CHECK.has(entry.status)) return { status: "not_applicable" };

  // 같은 종목 + 매수 체결 시각이 접수 시각과 windowMs 이내인 후보 중, 가장 가까운 것을 고른다.
  let best: RealizedTrade | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const r of realized) {
    if (r.symbol !== entry.symbol || r.buyAtMs == null) continue;
    const diff = Math.abs(r.buyAtMs - entry.enteredAtMs);
    if (diff <= windowMs && diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  if (!best) return { status: "not_found" };

  const base = {
    realBuyPrice: best.buyAvg,
    realSellPrice: best.sellPrice,
    realQty: best.qty,
    realPnlUsd: best.pnl,
    realPnlPct: best.pct,
    realSellAtMs: best.sellAtMs,
  };

  if (entry.pnlUsd == null) return { status: "enriched", ...base };

  const matches = Math.abs(entry.pnlUsd - best.pnl) <= toleranceUsd;
  return { status: matches ? "matched" : "mismatch", ...base };
}

/** id(`${symbol}@${entry}@${enteredAtMs}`)에서 enteredAtMs를 뽑는다. 형식이 깨졌으면 null. */
export function enteredAtMsFromId(id: string): number | null {
  const parts = id.split("@");
  if (parts.length < 3) return null;
  const ms = Number(parts[parts.length - 1]);
  return Number.isFinite(ms) ? ms : null;
}
