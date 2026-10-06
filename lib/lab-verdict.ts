// =============================================================================
// lib/lab-verdict.ts — [v0.66.0] 매매연구소 "결과 요약"의 결론 계산 + 데이터 검증 (순수 함수)
// -----------------------------------------------------------------------------
// [목적] 오너 요청: "모든 데이터들의 결과를 이해하기 쉽고 가시성 있게 정리한 결과창" +
//   "이게 실제 데이터가 맞는지 검증". 이 파일은 그 두 가지의 계산부다.
//     · buildVerdict : 변형 성적표(VariantRow[])에서 "매수 방식/손절/익절별 한 줄 결론", 신뢰도 등급, 다음 행동을 만든다.
//     · verifyLocal  : 저장된 로우(신호)를 다시 계산해 서로 맞는지(연속성·몸통·거래량·봉 크기·가격 정합성·경로) 검사한다.
// [원칙] 결론은 "표본이 충분한가"를 먼저 말하고, 자료가 부족하면 부족하다고 한다(단정 금지).
// =============================================================================

import { bodyPct, volRatioAt, type LabParams, type LabSignal, type LabLinkage, type VariantRow, LAB_PARAMS_DEFAULT, LAB_ENTRY_LABEL, LAB_STOP_LABEL } from "./lab";
import type { Candle } from "./indicators";

const FIVE = 5 * 60_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// 1) 결론
// ─────────────────────────────────────────────────────────────────────────────

export type Grade = "red" | "yellow" | "green";
export type Confidence = "clear" | "close" | "thin";

export interface DimRow {
  key: string; //            A/B/C/D 또는 익절 %
  label: string;
  variants: number; //       이 선택지를 쓴 변형 수(합산 대상)
  attempts: number; //       시도(신호×변형)
  filled: number;
  fillRate: number | null;
  winRate: number | null;
  expectancy: number | null; // 합산 기대값(신호당 평균 순손익 %) — 다른 선택지를 가리지 않고 모두 평균낸 값이라 "운 좋은 조합"에 덜 흔들린다
  totalNetPct: number;
}

export interface DimVerdict {
  rows: DimRow[];
  winner: DimRow | null;
  confidence: Confidence;
  note: string;
}

export interface Verdict {
  grade: Grade;
  gradeTitle: string;
  gradeReasons: string[];
  headline: string;
  eligible: number;
  best: VariantRow | null;
  profitable: boolean | null; // 최고 조합이 손실이면 false, 자료 부족이면 null
  entry: DimVerdict;
  stop: DimVerdict;
  tp: DimVerdict;
  consistent: boolean | null; // 최고 조합이 세 항목의 승자와 일치하는가
  qa: Array<{ q: string; a: string; confidence: Confidence; basis: string }>;
  actions: string[];
}

function pool(rows: VariantRow[], pick: (r: VariantRow) => string, labelOf: (k: string) => string): DimRow[] {
  const g = new Map<string, VariantRow[]>();
  for (const r of rows) {
    const k = pick(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(r);
  }
  return [...g.entries()]
    .map(([key, vs]) => {
      const attempts = vs.reduce((s, v) => s + v.signals, 0);
      const filled = vs.reduce((s, v) => s + v.filled, 0);
      const closed = vs.reduce((s, v) => s + v.closed, 0);
      const wins = vs.reduce((s, v) => s + v.wins, 0);
      const total = vs.reduce((s, v) => s + v.totalNetPct, 0);
      return {
        key,
        label: labelOf(key),
        variants: vs.length,
        attempts,
        filled,
        fillRate: attempts > 0 ? r2((filled / attempts) * 100) : null,
        winRate: closed > 0 ? r2((wins / closed) * 100) : null,
        expectancy: attempts > 0 ? r2(total / attempts) : null,
        totalNetPct: r2(total),
      } satisfies DimRow;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function judge(rows: DimRow[], minFilled: number, unit: string): DimVerdict {
  const usable = rows.filter((r) => r.filled >= minFilled && r.expectancy != null);
  const ranked = [...usable].sort((a, b) => (b.expectancy as number) - (a.expectancy as number));
  if (ranked.length === 0) return { rows, winner: null, confidence: "thin", note: `체결이 ${minFilled}건 이상인 ${unit}이(가) 아직 없어 비교할 수 없습니다.` };
  const w = ranked[0];
  const second = ranked[1];
  const gap = second ? (w.expectancy as number) - (second.expectancy as number) : Infinity;
  const confidence: Confidence = gap >= 0.15 ? "clear" : "close";
  const note =
    confidence === "clear"
      ? `${w.label}이(가) 신호당 ${sgn(w.expectancy)}로 다음 선택지보다 ${r2(gap)}%p 앞섭니다.`
      : `${w.label}이(가) 근소하게 앞서지만 차이(${r2(gap)}%p)가 작아 사실상 비슷합니다 — 단정하지 마세요.`;
  return { rows, winner: w, confidence, note };
}

const sgn = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);

/**
 * buildVerdict — 변형 성적표와 카운트로 결과창의 결론을 만든다.
 *   @param variants   summarizeVariants 결과(캔들·연계 모두 들어 있어도 됨)
 *   @param counts     신호 수(전체·인정·완료·진행)
 *   @param linkage    연계 요약
 *   @param minFilled  변형을 비교에 쓰는 최소 체결 수(기본 5)
 */
export function buildVerdict(
  variants: VariantRow[],
  counts: { total: number; eligible: number; complete: number; open: number },
  linkage: { runsWithBlock: number; linked: number; linkRate: number | null; linkedAnyEligible: number },
  minFilled = 5,
): Verdict {
  const candle = variants.filter((v) => v.kind === "candle" && v.entryIdx === 1);
  const link = variants.filter((v) => v.kind === "link");
  const entry = judge(pool(candle, (r) => r.entryMode, (k) => `매수 ${k}(${LAB_ENTRY_LABEL[k as keyof typeof LAB_ENTRY_LABEL] ?? k})`), minFilled, "매수 방식");
  const stop = judge(pool(candle, (r) => r.stopMode, (k) => `손절 ${k}(${LAB_STOP_LABEL[k as keyof typeof LAB_STOP_LABEL] ?? k})`), minFilled, "손절 방식");
  const tp = judge(pool(candle, (r) => String(r.tpPct), (k) => `익절 +${k}%`), minFilled, "익절 목표");

  const usable = candle.filter((v) => v.filled >= minFilled && v.expectancyPerSignal != null);
  const best = [...usable].sort((a, b) => (b.expectancyPerSignal as number) - (a.expectancyPerSignal as number))[0] ?? null;
  const profitable = best ? (best.expectancyPerSignal as number) > 0 && (best.profitFactor == null || best.profitFactor > 1) : null;

  const winnersMatch = best && entry.winner && stop.winner && tp.winner
    ? best.entryMode === entry.winner.key && best.stopMode === stop.winner.key && String(best.tpPct) === tp.winner.key
    : null;

  // ── 신뢰도 등급 ──
  const reasons: string[] = [];
  let grade: Grade = "green";
  if (counts.eligible < 30) { grade = "red"; reasons.push(`인정 신호가 ${counts.eligible}건뿐입니다(30건 미만) — 우연이 결과를 좌우하는 수준입니다.`); }
  else if (counts.eligible < 100) { grade = "yellow"; reasons.push(`인정 신호 ${counts.eligible}건 — 경향은 볼 수 있지만 100건 이상 쌓일 때까지는 참고용입니다.`); }
  if (!best) { if (grade === "green") grade = "yellow"; reasons.push(`체결 ${minFilled}건 이상인 변형이 아직 없습니다.`); }
  else if (best.filled < 30) { if (grade === "green") grade = "yellow"; reasons.push(`1위 조합의 체결이 ${best.filled}건(30건 미만)이라 그 숫자 자체가 불안정합니다.`); }
  if (counts.open > counts.complete && counts.total > 0) reasons.push("관찰이 끝나지 않은 신호가 더 많아 최근 신호의 결과는 아직 확정되지 않았습니다.");
  if (grade === "green") reasons.push("표본이 충분한 편입니다. 그래도 변형이 많아 1위가 우연일 수 있으니 2~3위와의 차이를 꼭 확인하세요.");
  const gradeTitle = grade === "green" ? "🟢 판단 근거로 쓸 수 있는 수준" : grade === "yellow" ? "🟡 참고용 (아직 결론 금지)" : "🔴 표본 부족 (결론 내릴 수 없음)";

  // ── 한 줄 결론 ──
  let headline: string;
  if (!best) headline = "아직 비교할 만큼 체결된 가상 매매가 없습니다. 신호가 더 쌓이면 여기에 결론이 나타납니다.";
  else if (!profitable) headline = `지금까지 가장 나은 조합도 신호당 ${sgn(best.expectancyPerSignal)}로 수익 구조가 확인되지 않았습니다 — 전략·조건을 다시 봐야 합니다.`;
  else headline = `현재 1위는 [매수 ${best.entryMode} · 손절 ${best.stopMode} · +${best.tpPct}%] — 신호당 ${sgn(best.expectancyPerSignal)}, 승률 ${best.winRate ?? "—"}%, 체결 ${best.filled}/${best.signals}건.`;

  // ── 카일 질문 답변판 ──
  const qa: Verdict["qa"] = [
    {
      q: "Q1. 매수는 어떻게 하는가?",
      a: entry.winner ? entry.winner.label : "자료 부족",
      confidence: entry.confidence,
      basis: entry.note + (entry.winner ? ` (체결률 ${entry.winner.fillRate ?? "—"}%)` : ""),
    },
    {
      q: "Q2. 손절은 어디에 두는가?",
      a: stop.winner ? stop.winner.label : "자료 부족",
      confidence: stop.confidence,
      basis: stop.note,
    },
    {
      q: "Q3. 익절은 어디서 하는가?",
      a: tp.winner ? tp.winner.label : "자료 부족",
      confidence: tp.confidence,
      basis: tp.note,
    },
    {
      q: "Q4. 캔들 상승 뒤 삼분할이 실제로 이어지는가?",
      a:
        linkage.runsWithBlock === 0
          ? "자료 부족"
          : (linkage.linkRate ?? 0) >= 50
            ? `자주 이어짐 (${linkage.linkRate}%)`
            : (linkage.linkRate ?? 0) >= 20
              ? `가끔 이어짐 (${linkage.linkRate}%)`
              : `거의 안 이어짐 (${linkage.linkRate}%)`,
      confidence: linkage.runsWithBlock >= 20 ? "clear" : "thin",
      basis: `4번째 캔들까지 간 ${linkage.runsWithBlock}건 중 ${linkage.linked}건에서 삼분할 패턴이 이어졌습니다.` + (link.length ? "" : " (연계 가상 매수 결과는 아직 없음)"),
    },
  ];

  // ── 다음 행동 ──
  const actions: string[] = [];
  if (counts.eligible < 100) actions.push(`신호 기록을 계속 켜 두세요 — 인정 신호 ${counts.eligible}건 → 목표 100건(이후 변형 비교를 판단에 사용).`);
  if (best && !profitable) actions.push("모든 조합이 손실이면 매수 방식·손절을 바꿔도 소용없을 수 있습니다. 전략 전제(도지→돌파 후 상승)가 이 시장에서 성립하는지부터 의심하세요.");
  if (best && profitable && (best.filled < 30)) actions.push("1위 조합의 체결이 30건에 못 미칩니다 — 더 쌓인 뒤 다시 확인하세요.");
  if (best && profitable && winnersMatch === false) actions.push("1위 조합이 항목별 승자(매수·손절·익절)와 다릅니다 — 특정 조합이 우연히 좋았을 수 있으니 항목별 승자 쪽을 더 믿으세요.");
  if (best && profitable && grade !== "red") actions.push("실매수 전 단계: 소액·드라이런으로 1~2주 실제 체결을 확인하세요(가상 체결은 호가 큐를 반영하지 못합니다).");
  actions.push("[데이터 검증]을 실행해 저장된 로우가 규칙과 토스 실제 데이터에 맞는지 정기적으로 확인하세요.");

  return { grade, gradeTitle, gradeReasons: reasons, headline, eligible: counts.eligible, best, profitable, entry, stop, tp, consistent: winnersMatch, qa, actions };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 저장된 로우 자체 검증
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckResult {
  id: string;
  label: string;
  desc: string;
  passed: number;
  failed: number;
  samples: string[]; // 실패한 신호 id 일부
}

export interface LocalVerify {
  checked: number;
  allOk: boolean;
  checks: CheckResult[];
  symbols: number;
  spanHours: number | null; // 신호가 걸친 시간 폭
  oldest: number | null;
  newest: number | null;
}

/**
 * verifyLocal — 저장된 신호 로우를 "다시 계산해서" 규칙과 맞는지 검사한다(외부 호출 없음).
 *   데이터가 부풀거나 어긋났는지 의심될 때 사람이 직접 눈으로 확인하는 대신 쓰는 자동 점검이다.
 */
export function verifyLocal(signals: LabSignal[], P: LabParams = LAB_PARAMS_DEFAULT, nowMs = Date.now()): LocalVerify {
  const defs: Array<[string, string, string]> = [
    ["contig", "봉이 이웃으로 이어짐", "도지→1→2번째 봉이 정확히 5분 간격(빠진 봉·장 사이 공백으로 이어 붙이지 않았는가)"],
    ["body", "몸통 비율 재계산 일치", "저장된 하이킨아시 봉으로 몸통 비율을 다시 계산해 기록값과 비교"],
    ["vol", "거래량 배수 재계산 일치", "신호 봉 직전 5개 봉의 거래량 평균으로 배수를 다시 계산해 기록값과 비교"],
    ["ohlc", "가격 정합성", "모든 봉이 고가 ≥ 시가·종가 ≥ 저가 > 0 인지"],
    ["above", "200 EMA 위", "패턴 봉(도지~신호 봉)의 하이킨아시 종가가 EMA200 위인지"],
    ["rule", "인정 기준 일치", "인정(eligible) 표시가 몸통·거래량·봉 크기 기준과 모순되지 않는지"],
    ["age", "최신성", "신호 봉이 발견 시점으로부터 72시간 이내인지(거래 드문 종목의 오래된 봉 방지)"],
    ["path", "1분봉 경로 정상", "신호 봉 마감 직후부터 시작하고 시간 순서·가격이 정상인지"],
    ["link", "연계 시간 상한", "삼분할 연계가 상승 구간 끝 + 관찰 시간 이내인지(무한정 탐색 방지)"],
  ];
  const res = new Map<string, CheckResult>(defs.map(([id, label, desc]) => [id, { id, label, desc, passed: 0, failed: 0, samples: [] }]));
  const mark = (id: string, ok: boolean, sig: string) => {
    const r = res.get(id)!;
    if (ok) r.passed++;
    else {
      r.failed++;
      if (r.samples.length < 5) r.samples.push(sig);
    }
  };

  for (const s of signals) {
    const bi = (t: number) => s.bars.findIndex((b) => b.t === t);
    const iD = bi(s.dojiT);
    const i2 = bi(s.c2T);
    const haOf = (b: (typeof s.bars)[number]): Candle => ({ time: b.t, open: b.ho, high: b.hh, low: b.hl, close: b.hc, volume: b.v });

    // ① 연속성
    mark("contig", iD >= 0 && i2 === iD + 2 && s.bars[iD + 1]?.t === s.dojiT + FIVE && s.c2T === s.dojiT + 2 * FIVE, s.id);

    if (i2 >= 0) {
      const b2 = s.bars[i2];
      // ② 몸통
      mark("body", Math.abs(bodyPct(haOf(b2)) - s.body2) < 0.5, s.id);
      // ③ 거래량
      if (i2 >= P.volLookback) {
        const ha = s.bars.slice(i2 - P.volLookback, i2 + 1).map(haOf);
        const vr = volRatioAt(ha, P.volLookback, P.volLookback);
        mark("vol", vr != null && s.volRatio2 != null && Math.abs(vr - s.volRatio2) < 0.05, s.id);
      } else mark("vol", false, s.id);
    } else {
      mark("body", false, s.id);
      mark("vol", false, s.id);
    }

    // ④ 가격 정합성
    mark("ohlc", s.bars.every((b) => b.o > 0 && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c) && b.h >= b.l && b.hh >= b.hl), s.id);

    // ⑤ EMA 위
    if (iD >= 0 && i2 >= iD) {
      mark("above", s.bars.slice(iD, i2 + 1).every((b) => b.e != null && b.hc > (b.e as number)), s.id);
    } else mark("above", false, s.id);

    // ⑥ 인정 기준 일치
    const bodyOk = s.body2 >= P.bodyMinPct - 0.01;
    const volOk = s.volRatio2 != null && s.volRatio2 >= P.volRatioMin - 0.001;
    const rangeOk = P.minRangePct <= 0 || (s.rangePct2 != null && s.rangePct2 >= P.minRangePct - 0.001);
    mark("rule", s.eligible === (bodyOk && volOk && rangeOk) || (s.eligible === false && !(bodyOk && volOk && rangeOk)), s.id);

    // ⑦ 최신성
    mark("age", s.detectedAtMs - s.c2T <= P.maxSignalAgeHours * 3600_000 + FIVE * 2 || nowMs - s.c2T <= P.maxSignalAgeHours * 3600_000, s.id);

    // ⑧ 경로
    const p = s.path1m;
    const startOk = p.length === 0 || p[0][0] - (s.c2T + FIVE) <= 10 * 60_000;
    let order = true;
    for (let i = 1; i < p.length; i++) if (p[i][0] <= p[i - 1][0]) order = false;
    const priceOk = p.every((c) => c[2] >= Math.max(c[1], c[4]) && c[3] <= Math.min(c[1], c[4]) && c[3] > 0);
    mark("path", startOk && order && priceOk, s.id);

    // ⑨ 연계 상한
    if (s.linkage) {
      const lk: LabLinkage = s.linkage;
      mark("link", lk.confirmT >= s.runEndT && lk.confirmT - s.runEndT <= P.horizonMin * 60_000 + FIVE, s.id);
    }
  }

  const checks = [...res.values()].filter((c) => c.passed + c.failed > 0);
  const times = signals.map((s) => s.c2T);
  return {
    checked: signals.length,
    allOk: checks.every((c) => c.failed === 0),
    checks,
    symbols: new Set(signals.map((s) => s.symbol)).size,
    spanHours: times.length ? r2((Math.max(...times) - Math.min(...times)) / 3600_000) : null,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 토스 실데이터 대조 (엔진이 최신 1분봉을 받아 넘겨 주면 비교만 한다)
// ─────────────────────────────────────────────────────────────────────────────

export interface TossCompareRow {
  id: string;
  symbol: string;
  c2T: number;
  status: "match" | "diff" | "missing";
  stored?: { o: number; h: number; l: number; c: number; v: number };
  fresh?: { o: number; h: number; l: number; c: number; v: number };
  maxPriceDiffPct?: number;
  volDiffPct?: number;
}

/** 저장된 신호 봉(원본 5분봉)과 토스에서 방금 다시 받은 5분봉을 비교한다. 가격은 0.05% 이내, 거래량은 5% 이내면 일치. */
export function compareWithFresh(sig: LabSignal, fresh5m: Candle[]): TossCompareRow {
  const b = sig.bars.find((x) => x.t === sig.c2T);
  const f = fresh5m.find((x) => x.time === sig.c2T);
  if (!b) return { id: sig.id, symbol: sig.symbol, c2T: sig.c2T, status: "missing" };
  const stored = { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
  if (!f) return { id: sig.id, symbol: sig.symbol, c2T: sig.c2T, status: "missing", stored };
  const fresh = { o: f.open, h: f.high, l: f.low, c: f.close, v: Math.round(f.volume) };
  const pd = (a: number, c: number) => (a > 0 ? Math.abs(c / a - 1) * 100 : 0);
  const maxPriceDiffPct = r2(Math.max(pd(stored.o, fresh.o), pd(stored.h, fresh.h), pd(stored.l, fresh.l), pd(stored.c, fresh.c)));
  const volDiffPct = r2(pd(stored.v, fresh.v));
  return { id: sig.id, symbol: sig.symbol, c2T: sig.c2T, status: maxPriceDiffPct <= 0.05 && volDiffPct <= 5 ? "match" : "diff", stored, fresh, maxPriceDiffPct, volDiffPct };
}
