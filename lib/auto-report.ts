// =============================================================================
// lib/auto-report.ts — 자동매매 리포트(순수 함수, 파일·네트워크 없음)
// -----------------------------------------------------------------------------
// [왜 만들었나 — 오너 요청 v0.62.1]
//   자동매매를 한 번 돌리고 나면 "그래서 이번 운용이 어땠는지"를 한 장으로 보고 싶다는 요청.
//   ① 운용 개요 ② 수익·자산 ③ 매매 통계 ④ 포지션/시스템 4부분으로 만든다.
//
// [원칙]
//   · 엔진은 "실행(run) 기록"(시작·종료·루프 횟수·오류 카운트 등 숫자 몇 개)만 남기고,
//     손익·승률 등은 이미 있는 자동매매기록(AutoTradeHistoryEntry)에서 여기서 계산한다
//     → 계산이 순수 함수라 테스트가 쉽고, 기록 원본은 건드리지 않는다.
//   · "측정 못 하는 것"은 억지로 채우지 않고 null/설명으로 정직하게 표시한다
//     (예: 슬리피지는 체결가를 주문가로 가정해 저장하므로 측정 불가).
// =============================================================================

import { DateTime } from "luxon";

/** 한 번의 자동매매 실행(켬→끔) 동안 쌓는 오류 카운터. */
export interface AutoRunErrors {
  apiTimeouts: number; //  API 요청이 제한시간을 넘겨 끊긴 횟수
  apiRetries: number; //   401(토큰 갱신)·429(요청한도) 때문에 자동 재시도한 횟수
  apiFailures: number; //  네트워크 오류 등으로 요청 자체가 실패한 횟수(타임아웃 제외)
  cycleErrors: number; //  5분 사이클 도중 예외가 터진 횟수
}

export interface AutoRunPositionSnapshot {
  symbol: string;
  status: string; // watching(진입 대기) / active(보유 중, 익절·손절 등록)
  entry: number;
  quantity: number;
}

/** 실행 기록 — 앱 데이터 폴더에 JSON으로 보관(최근 30건). */
export interface AutoRunRecord {
  id: string;
  startedAtMs: number;
  lastActiveAtMs: number; //   마지막으로 사이클이 돈 시각(앱이 갑자기 꺼져도 "대략 언제까지 일했는지" 남김)
  endedAtMs: number | null; // 종료 전이면 null
  loopCount: number; //        5분 사이클 실행 횟수
  scanCount: number; //        그중 실제로 스크리닝(스캔)까지 돈 횟수
  endReason: string | null;
  startAssetsUsd: number | null; // 시작 시점 시드(매수가능 달러 스냅샷) — 못 구했으면 null
  commissionRate: number | null; // 수수료율(예: 0.0009). 못 구했으면 null → 수수료 추정 불가
  carriedPositions: number; //   시작할 때 이어받은(이미 감시 중이던) 포지션 수
  openPositions: AutoRunPositionSnapshot[]; // 마지막으로 확인된 보유·대기 포지션
  errors: AutoRunErrors;
}

/** 리포트 계산에 필요한 자동매매기록의 최소 필드(엔진의 AutoTradeHistoryEntry와 호환). */
export interface ReportHistoryEntry {
  id: string;
  symbol: string;
  entry: number;
  quantity: number;
  enteredAt: string; // KST "MM-dd HH:mm:ss"(연도 없음)
  status: string;
  exitedAt: string | null;
  exitPrice: number | null;
  pnlUsd: number | null;
}

export interface AutoReport {
  runId: string;
  generatedAtMs: number;
  live: boolean; // 아직 실행 중(종료 전)인 리포트인지
  overview: {
    startedAtMs: number;
    endedAtMs: number; //  종료 전이면 지금(또는 마지막 활동) 시각
    uptimeMs: number;
    loopCount: number;
    scanCount: number;
    endReason: string; //  실행 중이면 "실행 중"
  };
  money: {
    startAssetsUsd: number | null;
    endAssetsUsd: number | null; //   = 시작 + 실현 순손익(미실현 제외)
    realizedGrossUsd: number; //      수수료 전 실현손익
    estFeesUsd: number | null; //     수수료 추정(수수료율×(매수금액+매도금액)). 수수료율 모르면 null
    realizedNetUsd: number; //        수수료 추정까지 뺀 순손익(수수료율 모르면 gross와 동일)
    returnPct: number | null; //      순손익 ÷ 시작자산
    mddUsd: number; //                실현손익 곡선 기준 최대 낙폭(달러)
    mddPct: number | null; //         최대 낙폭 ÷ (그 시점까지의 최고 자산)
    slippage: "측정 불가"; //         체결가를 주문가로 기록해 실제 슬리피지는 알 수 없음
  };
  trades: {
    total: number; //            청산 완료 매매 수(익절·손절·수동)
    wins: number;
    losses: number;
    winRatePct: number | null;
    grossProfitUsd: number;
    grossLossUsd: number; //     양수로 표기(손실 총액)
    profitFactor: number | null; // 총이익 ÷ 총손실 (손실이 0이면 null)
    profitFactorLabel: string; //   화면 표기용("1.85" / "∞(손실 없음)" / "—")
    avgHoldMs: number | null; //    진입 접수 → 청산 평균 시간
    cancelled: number; //           미체결 취소(매매 아님)
    ocoFailed: number; //           익절·손절 등록 실패 기록
  };
  positions: { openAtEnd: AutoRunPositionSnapshot[] };
  system: AutoRunErrors;
  notes: string[]; // 가정·한계 설명(리포트에 항상 같이 보여 오해 방지)
}

/** "MM-dd HH:mm:ss"(KST, 연도 없음) → ms. 기준 시각(refMs) 근처의 해로 해석(연말·연초 걸침 보정). */
export function parseKstNoYear(text: string, refMs: number): number | null {
  const refYear = DateTime.fromMillis(refMs).setZone("Asia/Seoul").year;
  for (const year of [refYear, refYear - 1, refYear + 1]) {
    const dt = DateTime.fromFormat(`${year} ${text}`, "yyyy MM-dd HH:mm:ss", { zone: "Asia/Seoul" });
    if (!dt.isValid) continue;
    // 기준 시각에서 ±180일 안쪽인 해를 채택
    if (Math.abs(dt.toMillis() - refMs) < 180 * 86_400_000) return dt.toMillis();
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildAutoReport(
  run: AutoRunRecord,
  history: ReportHistoryEntry[],
  nowMs: number,
): AutoReport {
  const live = run.endedAtMs == null;
  const endMs = run.endedAtMs ?? Math.max(run.lastActiveAtMs, run.startedAtMs);
  // 실행 중 리포트는 "지금"까지의 매매를 포함해야 하므로 상한을 현재 시각으로 둔다.
  const windowEnd = live ? nowMs : endMs + 60_000; // 종료 직후 기록 지연 1분 여유

  // ── 이 실행 기간에 청산된 매매만 골라낸다(청산 시각 기준) ──
  type T = { exitMs: number; holdMs: number | null; pnl: number; fee: number | null };
  const trades: T[] = [];
  let cancelled = 0;
  let ocoFailed = 0;
  for (const h of history) {
    const exitMs = h.exitedAt ? parseKstNoYear(h.exitedAt, run.startedAtMs) : null;
    if (exitMs == null || exitMs < run.startedAtMs || exitMs > windowEnd) continue;
    if (h.status === "cancelled") { cancelled++; continue; }
    if (h.status === "oco_failed") { ocoFailed++; continue; }
    if (h.status !== "closed_win" && h.status !== "closed_loss" && h.status !== "closed_manual") continue;
    if (h.pnlUsd == null || !Number.isFinite(h.pnlUsd)) continue;
    // 진입 접수 시각: id 끝의 `@ms`가 가장 정확하고, 없으면 문자열로 해석한다.
    const idMs = Number(h.id.split("@").pop());
    const enteredMs = Number.isFinite(idMs) && idMs > 1e12 ? idMs : parseKstNoYear(h.enteredAt, run.startedAtMs);
    const fee =
      run.commissionRate != null ? run.commissionRate * (h.entry * h.quantity + (h.exitPrice ?? h.entry) * h.quantity) : null;
    trades.push({ exitMs, holdMs: enteredMs != null ? Math.max(0, exitMs - enteredMs) : null, pnl: h.pnlUsd, fee });
  }
  trades.sort((a, b) => a.exitMs - b.exitMs);

  // ── 수익 ──
  const gross = trades.reduce((s, t) => s + t.pnl, 0);
  const estFees = run.commissionRate != null ? trades.reduce((s, t) => s + (t.fee ?? 0), 0) : null;
  const net = gross - (estFees ?? 0);
  const start = run.startAssetsUsd;
  const endAssets = start != null ? start + net : null;

  // ── MDD: 실현손익 누적 곡선(순손익 기준)에서 고점 대비 최대 하락 ──
  let eq = start ?? 0;
  let peak = eq;
  let mddUsd = 0;
  let mddBase = peak;
  for (const t of trades) {
    eq += t.pnl - (t.fee ?? 0);
    if (eq > peak) peak = eq;
    if (peak - eq > mddUsd) { mddUsd = peak - eq; mddBase = peak; }
  }
  const mddPct = start != null && mddBase > 0 ? (mddUsd / mddBase) * 100 : null;

  // ── 매매 통계 ──
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const decided = wins.length + losses.length;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : null;
  const pfLabel = pf != null ? pf.toFixed(2) : grossProfit > 0 ? "∞(손실 없음)" : "—";
  const holds = trades.map((t) => t.holdMs).filter((x): x is number => x != null);

  const notes = [
    "손익은 '진입가→익절/손절가' 기준 실현손익입니다(보유 중인 종목의 평가손익은 제외).",
    "최대 낙폭(MDD)도 청산이 끝난 매매의 실현손익 곡선 기준이라, 보유 중 일시적으로 더 깊게 내려갔던 구간은 반영되지 않습니다.",
    run.commissionRate != null
      ? `수수료는 수수료율(${(run.commissionRate * 100).toFixed(3)}%)×(매수금액+매도금액)으로 추정한 값입니다(실제 청구액과 다를 수 있음).`
      : "수수료율을 조회하지 못해 수수료는 계산에 넣지 못했습니다(순손익=총손익).",
    "슬리피지는 체결가를 주문가로 기록하므로 측정할 수 없습니다.",
    "종료 시점 자산은 '시작 시드 + 실현 순손익'이며 계좌 실제 잔고 조회값이 아닙니다.",
  ];

  return {
    runId: run.id,
    generatedAtMs: nowMs,
    live,
    overview: {
      startedAtMs: run.startedAtMs,
      endedAtMs: live ? nowMs : endMs,
      uptimeMs: Math.max(0, (live ? nowMs : endMs) - run.startedAtMs),
      loopCount: run.loopCount,
      scanCount: run.scanCount,
      endReason: live ? "실행 중" : run.endReason ?? "알 수 없음",
    },
    money: {
      startAssetsUsd: start != null ? round2(start) : null,
      endAssetsUsd: endAssets != null ? round2(endAssets) : null,
      realizedGrossUsd: round2(gross),
      estFeesUsd: estFees != null ? round2(estFees) : null,
      realizedNetUsd: round2(net),
      returnPct: start != null && start > 0 ? round2((net / start) * 100) : null,
      mddUsd: round2(mddUsd),
      mddPct: mddPct != null ? round2(mddPct) : null,
      slippage: "측정 불가",
    },
    trades: {
      total: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: decided > 0 ? round2((wins.length / decided) * 100) : null,
      grossProfitUsd: round2(grossProfit),
      grossLossUsd: round2(grossLoss),
      profitFactor: pf != null ? round2(pf) : null,
      profitFactorLabel: pf != null ? pf.toFixed(2) : pfLabel,
      avgHoldMs: holds.length > 0 ? Math.round(holds.reduce((s, x) => s + x, 0) / holds.length) : null,
      cancelled,
      ocoFailed,
    },
    positions: { openAtEnd: run.openPositions.map((p) => ({ ...p })) },
    system: { ...run.errors },
    notes,
  };
}

// ── 표시용 포맷터 ─────────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d > 0 ? `${d}일` : "", h > 0 ? `${h}시간` : "", `${m}분`].filter(Boolean).join(" ");
}

const kst = (ms: number) => DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat("yyyy-MM-dd HH:mm");
const usd = (n: number | null, sign = false) =>
  n == null ? "—" : `${sign && n > 0 ? "+" : n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

/** 리포트를 사람이 읽는(그리고 복사해 AI에 붙여 넣는) 마크다운으로. */
export function reportToMarkdown(r: AutoReport): string {
  const o = r.overview;
  const m = r.money;
  const t = r.trades;
  const lines: string[] = [];
  lines.push(`# 자동매매 리포트${r.live ? " (진행 중 — 현재까지)" : ""}`);
  lines.push("");
  lines.push("## ① 운용 개요");
  lines.push(`- 운용 시간: ${kst(o.startedAtMs)} ~ ${r.live ? "진행 중" : kst(o.endedAtMs)} (총 ${fmtDuration(o.uptimeMs)})`);
  lines.push(`- 5분 사이클 실행: ${o.loopCount}회 (그중 스크리닝 ${o.scanCount}회)`);
  lines.push(`- 종료 사유: ${o.endReason}`);
  lines.push("");
  lines.push("## ② 수익·자산");
  lines.push(`- 시작 자산(시드): ${usd(m.startAssetsUsd)} → 종료 자산(추정): ${usd(m.endAssetsUsd)}`);
  lines.push(`- 실현 손익(총): ${usd(m.realizedGrossUsd, true)} / 수수료 추정: ${usd(m.estFeesUsd)} / 순손익: ${usd(m.realizedNetUsd, true)}${m.returnPct != null ? ` (${m.returnPct >= 0 ? "+" : ""}${m.returnPct}%)` : ""}`);
  lines.push(`- 최대 낙폭(MDD): ${usd(m.mddUsd)}${m.mddPct != null ? ` (${m.mddPct}%)` : ""}`);
  lines.push(`- 슬리피지: ${m.slippage}`);
  lines.push("");
  lines.push("## ③ 매매 통계");
  lines.push(`- 총 매매(청산 완료): ${t.total}건 (익절·이익 ${t.wins} / 손절·손실 ${t.losses})`);
  lines.push(`- 승률: ${t.winRatePct != null ? `${t.winRatePct}%` : "—"}`);
  lines.push(`- 손익비(Profit Factor = 총이익 ÷ 총손실): ${t.profitFactorLabel} (총이익 ${usd(t.grossProfitUsd)} / 총손실 ${usd(t.grossLossUsd)})`);
  lines.push(`- 평균 보유 시간(진입 접수→청산): ${t.avgHoldMs != null ? fmtDuration(t.avgHoldMs) : "—"}`);
  lines.push(`- 참고: 미체결 취소 ${t.cancelled}건 · 보호주문(익절·손절) 등록 실패 기록 ${t.ocoFailed}건`);
  lines.push("");
  lines.push("## ④ 포지션·시스템");
  if (r.positions.openAtEnd.length === 0) lines.push("- 종료 시점 보유·대기 포지션: 없음");
  else {
    lines.push(`- 종료 시점 보유·대기 포지션: ${r.positions.openAtEnd.length}종목`);
    for (const p of r.positions.openAtEnd) {
      lines.push(`  - ${p.symbol} · ${p.status === "active" ? "보유 중(익절·손절 등록)" : "진입 대기"} · 진입가 $${p.entry} × ${p.quantity}주`);
    }
  }
  const e = r.system;
  lines.push(`- 오류 로그 요약: API 타임아웃 ${e.apiTimeouts}회 · 자동 재시도 ${e.apiRetries}회 · 요청 실패 ${e.apiFailures}회 · 사이클 예외 ${e.cycleErrors}회`);
  lines.push("");
  lines.push("### 계산 기준·한계");
  for (const n of r.notes) lines.push(`- ${n}`);
  return lines.join("\n");
}

/** AI(예: Claude)에게 이 리포트를 분석시킬 때 앞에 붙이는 프롬프트 + 리포트 본문. */
export function reportAiPrompt(r: AutoReport): string {
  return [
    "아래는 미국 주식 자동매매 봇의 한 번의 운용 결과 리포트입니다.",
    "다음을 비전공자도 이해하도록 쉬운 한국어로 분석해 주세요.",
    "1) 이번 운용을 한 줄로 총평",
    "2) 승률·손익비·최대 낙폭을 함께 보았을 때 전략의 강점과 약점",
    "3) 오류 로그(타임아웃·재시도)가 운용에 영향을 줬을 가능성",
    "4) 다음 운용 전에 바꿔볼 만한 설정/기준 제안 (근거 데이터가 부족하면 부족하다고 말해 주세요)",
    "※ 리포트 하단 '계산 기준·한계'를 반드시 고려하고, 표본(매매 건수)이 적으면 결론을 단정하지 마세요.",
    "",
    "-----",
    reportToMarkdown(r),
  ].join("\n");
}
