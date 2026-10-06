// =============================================================================
// lib/lab-verdict.ts — [v0.66.0] 매매연구소 "결과 요약"의 결론 계산 + 데이터 검증 (순수 함수)
// -----------------------------------------------------------------------------
// [목적] 오너 요청: "모든 데이터들의 결과를 이해하기 쉽고 가시성 있게 정리한 결과창" +
//   "이게 실제 데이터가 맞는지 검증". 이 파일은 그 두 가지의 계산부다.
//     · buildVerdict : 변형 성적표(VariantRow[])에서 "매수 방식/손절/익절별 한 줄 결론", 신뢰도 등급, 다음 행동을 만든다.
//     · verifyLocal  : 저장된 로우(신호)를 다시 계산해 서로 맞는지(연속성·몸통·거래량·봉 크기·가격 정합성·경로) 검사한다.
// [원칙] 결론은 "표본이 충분한가"를 먼저 말하고, 자료가 부족하면 부족하다고 한다(단정 금지).
// =============================================================================

import { bodyPct, volRatioAt, simulateSignal, summarizeVariants, summarizeLinkage, passFilter, type LabParams, type LabSignal, type LabLinkage, type VariantRow, LAB_PARAMS_DEFAULT, LAB_ENTRY_LABEL, LAB_STOP_LABEL } from "./lab";
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
      // ② 몸통 — 저장된 가격은 소수 4자리로 반올림돼 있어, 고저폭이 호가 몇 틱뿐인 봉은 비율이 크게 흔들린다.
      //    그 반올림 오차만큼은 허용한다(허용폭 = 0.5%p + 반올림 오차 ÷ 고저폭). v0.66.0에는 이 허용이 없어 오탐이 났다.
      const hr = b2.hh - b2.hl;
      const tol = 0.5 + (hr > 0 ? (0.0002 / hr) * 100 : 100);
      mark("body", Math.abs(bodyPct(haOf(b2)) - s.body2) <= tol, s.id);
      // ③ 거래량 — 직전 5개 봉이 이어지지 않아 계산 불가(null)였던 신호는 "다시 계산해도 불가(null)"여야 일치다.
      if (i2 >= P.volLookback) {
        const ha = s.bars.slice(i2 - P.volLookback, i2 + 1).map(haOf);
        const vr = volRatioAt(ha, P.volLookback, P.volLookback);
        if (s.volRatio2 == null) mark("vol", vr == null, s.id);
        else mark("vol", vr != null && Math.abs(vr - s.volRatio2) < 0.05, s.id);
      } else mark("vol", s.volRatio2 == null, s.id);
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
    const startOk = p.length === 0 || p[0][0] - (s.c2T + FIVE) <= 30 * 60_000; // 신호 직후 몇 분간 거래가 없는 종목도 있다(그 구간은 단지 미체결로 계산됨)
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

// ─────────────────────────────────────────────────────────────────────────────
// 4) [v0.67.0] 종합 평가(허점 점검 + 실매매 전환 게이트)
// -----------------------------------------------------------------------------
// [왜 필요한가 — 오너 요청 "허점·리스크 검토, 완벽한 데이터 분석, 최종적으로는 베스트 방법으로 실매매"]
//   변형이 100개 넘게 비교되면 "우연히 좋아 보이는 1위"가 생기고(승자의 저주), 가상 체결은 현실보다 낙관적일 수 있으며,
//   과거 백필 데이터는 "오늘 거래량이 많은 종목"만 골라 본 것이라 편향이 있다. 그래서 1위 숫자를 그대로 믿지 않고
//   ① 부트스트랩 신뢰구간 ② 시간 분할 검증(앞 60%로 고르고 뒤 40%로 확인) ③ 스트레스 테스트(추가 비용)
//   ④ 종목·날짜 집중도 ⑤ 지연 가정 대비 실측 ⑥ 규칙 일관성 ⑦ 데이터 검증 최신성을 모두 통과해야 "실매매 검토 가능"으로 본다.
// =============================================================================

export interface Concentration {
  eligible: number;
  symbols: number;
  days: number;
  topSymbol: string | null;
  topShare: number | null; // 최다 종목이 인정 신호에서 차지하는 비율(0~1)
}

export interface Ci {
  n: number;
  mean: number;
  lo: number;
  hi: number;
}

export interface Holdout {
  key: string | null;
  trainN: number;
  testN: number;
  trainExp: number | null;
  testExp: number | null;
  testFilled: number;
  holds: boolean | null; // 검증 구간에서도 플러스였는가(표본 부족이면 null)
}

export interface Gate {
  id: string;
  label: string;
  ok: boolean | null; // null = 확인 불가(자료 없음)
  detail: string;
}

export interface VerifyState {
  localOk: boolean | null;
  localAt: number | null;
  tossRate: number | null; // 최근 토스 대조 일치율(0~1)
  tossAt: number | null;
}

export interface Assessment {
  scope: "realtime" | "all";
  asOf: number;
  counts: { realtimeEligible: number; allEligible: number; backfilledEligible: number; total: number; complete: number; open: number };
  verdict: Verdict;
  ci: Ci | null;
  holdout: Holdout | null;
  stress: { pct: number; expectancy: number | null } | null;
  concentration: Concentration;
  latency: { n: number; medianMin: number | null; p90Min: number | null; assumedMin: number };
  ruleVersions: number;
  /** [v0.68.0] 수집 속도 — "실시간 인정 신호 100건까지 얼마나 걸리나"를 현재 속도로 환산 */
  pace: {
    activeHours: number; scans: number; perHour: number | null; etaDays: number | null; target: number;
    /** 기록을 시작한 뒤에 형성된 신호(인정 여부 무관) 중 실시간 포착 수와 늦게 발견된 수 — 늦게 발견된 건 "그 시점엔 거래량 순위권 밖이었다가 나중에 올라온" 종목이라 선택 편향이 있다 */
    formedSinceStart: number; caughtRealtime: number; lateDiscovered: number;
  };
  gates: Gate[];
  gatesPassed: number;
  readiness: "no" | "close" | "ready";
  readinessText: string;
  topVariants: VariantRow[];
}

/** 결정적 난수(테스트 재현성) — mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);

/** 한 변형의 "신호당 기여값" 벡터: 체결·청산된 신호는 순손익, 미체결은 0, 성립 불가·진행 중은 제외. */
export function contributionVector(signals: LabSignal[], key: string, P: LabParams): number[] {
  const out: number[] = [];
  for (const s of signals) {
    const t = simulateSignal(s, P).find((x) => x.key === key);
    if (!t || t.status === "skipped") continue;
    if (t.fillPx == null) { out.push(0); continue; }
    if (t.status === "open") continue;
    out.push(t.netPct as number);
  }
  return out;
}

/** 부트스트랩 95% 신뢰구간(신호를 복원추출). 신호 수가 너무 적으면 null. */
export function bootstrapCi(values: number[], iters = 1000, seed = 1): Ci | null {
  const n = values.length;
  if (n < 5) return null;
  const rand = rng(seed);
  const means: number[] = [];
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
    means.push(sum / n);
  }
  means.sort((a, c) => a - c);
  const mean = values.reduce((s, x) => s + x, 0) / n;
  return { n, mean: r2(mean), lo: r2(means[Math.floor(iters * 0.025)]), hi: r2(means[Math.floor(iters * 0.975)]) };
}

/** 시간 분할 검증: 앞 60%의 신호로 1위 조합을 고르고, 뒤 40%에서 같은 조합이 여전히 플러스인지 본다. */
export function holdoutCheck(signals: LabSignal[], P: LabParams, minFilled = 5): Holdout {
  const sorted = [...signals].sort((a, b) => a.c2T - b.c2T);
  const cut = Math.floor(sorted.length * 0.6);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const f = { includeThin: true, includeBackfilled: true, includeIneligible: true };
  const trainRows = summarizeVariants(train, f, P).filter((v) => v.kind === "candle" && v.entryIdx === 1 && v.filled >= Math.max(3, Math.floor(minFilled / 2)));
  const pick = [...trainRows].sort((a, b) => (b.expectancyPerSignal ?? -999) - (a.expectancyPerSignal ?? -999))[0];
  if (!pick || test.length < 5) return { key: pick?.key ?? null, trainN: train.length, testN: test.length, trainExp: pick?.expectancyPerSignal ?? null, testExp: null, testFilled: 0, holds: null };
  const testRow = summarizeVariants(test, f, P).find((v) => v.key === pick.key);
  const testExp = testRow?.expectancyPerSignal ?? null;
  const testFilled = testRow?.filled ?? 0;
  return { key: pick.key, trainN: train.length, testN: test.length, trainExp: pick.expectancyPerSignal, testExp, testFilled, holds: testFilled >= 5 && testExp != null ? testExp > 0 : null };
}

const kstDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

export function concentrationOf(signals: LabSignal[]): Concentration {
  const sym = new Map<string, number>();
  const days = new Set<string>();
  for (const s of signals) {
    sym.set(s.symbol, (sym.get(s.symbol) ?? 0) + 1);
    days.add(kstDay(s.c2T));
  }
  const top = [...sym.entries()].sort((a, b) => b[1] - a[1])[0];
  return { eligible: signals.length, symbols: sym.size, days: days.size, topSymbol: top?.[0] ?? null, topShare: top && signals.length ? r2(top[1] / signals.length) : null };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export const GATE_THRESHOLDS = {
  realtimeEligible: 100,
  days: 10,
  symbols: 15,
  topShareMax: 0.2,
  bestFilled: 30,
  profitFactorMin: 1.2,
  minLosses: 3,
  maxDrawdownPct: 15,
  verifyFreshMs: 24 * 3600_000,
  tossRateMin: 0.8,
};

/**
 * buildAssessment — 결과 요약의 결론 + 허점 점검 + 실매매 전환 게이트를 한꺼번에 계산한다.
 *   @param realtimeOnly true면 "신호 봉이 마감된 직후 실시간으로 발견한 신호"만으로 결론을 낸다(권장 — 백필은
 *     오늘 거래량 상위 종목만 골라 과거를 본 것이라 선택 편향이 있다). false면 백필 포함.
 */
export function buildAssessment(
  signals: LabSignal[],
  P: LabParams,
  opts: { realtimeOnly: boolean; minFilled?: number; nowMs?: number; verify?: VerifyState | null; collect?: { activeMs: number; scans: number; startedAtMs?: number | null } | null },
): Assessment {
  const nowMs = opts.nowMs ?? Date.now();
  const minFilled = opts.minFilled ?? 5;
  const scopeFilter = { includeBackfilled: !opts.realtimeOnly, includeThin: false, includeIneligible: false };
  const scoped = signals.filter((s) => !(opts.realtimeOnly && s.backfilled));
  const elig = signals.filter((s) => passFilter(s, { includeBackfilled: true, includeThin: false, includeIneligible: false }));
  const scopedElig = scoped.filter((s) => passFilter(s, scopeFilter));

  const variants = summarizeVariants(signals, scopeFilter, P);
  const linkage = summarizeLinkage(signals, scopeFilter);
  const counts = {
    realtimeEligible: elig.filter((s) => !s.backfilled).length,
    allEligible: elig.length,
    backfilledEligible: elig.filter((s) => s.backfilled).length,
    total: scoped.length,
    complete: scoped.filter((s) => s.complete).length,
    open: scoped.filter((s) => !s.complete).length,
  };
  const verdict = buildVerdict(variants, { total: counts.total, eligible: scopedElig.length, complete: counts.complete, open: counts.open }, linkage, minFilled);
  const best = verdict.best;

  // ① 신뢰구간 ② 시간 분할 ③ 스트레스
  const ci = best ? bootstrapCi(contributionVector(scopedElig, best.key, P), 1000, hash(best.key)) : null;
  const holdout = scopedElig.length >= 10 ? holdoutCheck(scopedElig, P, minFilled) : null;
  const stress = best ? { pct: P.stressPct ?? 0, expectancy: best.stressExpectancy } : null;

  // ④ 집중도
  const concentration = concentrationOf(scopedElig);

  // ⑤ 지연: 실시간 신호의 (발견 시각 − 신호 봉 마감) 실측
  const lat = signals.filter((s) => !s.backfilled).map((s) => (s.detectedAtMs - (s.c2T + FIVE)) / 60_000).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const latency = { n: lat.length, medianMin: percentile(lat, 0.5) != null ? r2(percentile(lat, 0.5) as number) : null, p90Min: percentile(lat, 0.9) != null ? r2(percentile(lat, 0.9) as number) : null, assumedMin: P.latencyMin ?? 0 };

  // 수집 속도(활성 시간당 실시간 인정 신호) → 목표까지 예상 기간. 활성 시간은 하루 약 12시간(17:00~05:00 KST).
  const activeHours = (opts.collect?.activeMs ?? 0) / 3_600_000;
  const perHour = activeHours >= 1 ? r2(counts.realtimeEligible / activeHours) : null;
  const remaining = Math.max(0, GATE_THRESHOLDS.realtimeEligible - counts.realtimeEligible);
  const pace = {
    activeHours: r2(activeHours),
    scans: opts.collect?.scans ?? 0,
    perHour,
    etaDays: perHour != null && perHour > 0 ? r2(remaining / (perHour * 12)) : null,
    target: GATE_THRESHOLDS.realtimeEligible,
    ...(() => {
      const st = opts.collect?.startedAtMs;
      const formed = st != null ? signals.filter((s) => s.c2T >= st) : [];
      const caught = formed.filter((s) => !s.backfilled).length;
      return { formedSinceStart: formed.length, caughtRealtime: caught, lateDiscovered: formed.length - caught };
    })(),
  };

  // ⑥ 규칙 일관성
  const ruleVersions = new Set(signals.filter((s) => s.rule).map((s) => JSON.stringify(s.rule))).size;

  // ── 게이트 ──
  const T = GATE_THRESHOLDS;
  const v = opts.verify ?? null;
  const fresh = (t: number | null) => t != null && nowMs - t <= T.verifyFreshMs;
  const gates: Gate[] = [
    { id: "realtime", label: `실시간 인정 신호 ${T.realtimeEligible}건 이상`, ok: counts.realtimeEligible >= T.realtimeEligible, detail: `${counts.realtimeEligible}건 (백필 ${counts.backfilledEligible}건은 선택 편향이 있어 세지 않음)` },
    { id: "days", label: `서로 다른 거래일 ${T.days}일 이상`, ok: concentration.days >= T.days, detail: `${concentration.days}일 — 하루·이틀의 장세에 우연히 맞았을 수 있어요` },
    { id: "symbols", label: `종목 ${T.symbols}개 이상 + 한 종목 비중 ${T.topShareMax * 100}% 이하`, ok: concentration.symbols >= T.symbols && (concentration.topShare ?? 1) <= T.topShareMax, detail: `${concentration.symbols}종목 · 최다 ${concentration.topSymbol ?? "—"} ${concentration.topShare != null ? Math.round(concentration.topShare * 100) : "—"}%` },
    { id: "filled", label: `1위 조합 체결 ${T.bestFilled}건 이상`, ok: best ? best.filled >= T.bestFilled : false, detail: best ? `${best.filled}건` : "비교할 조합 없음" },
    { id: "ci", label: "기대값 95% 신뢰구간의 하한이 0보다 큼", ok: ci ? ci.lo > 0 : false, detail: ci ? `${sgnPct(ci.lo)} ~ ${sgnPct(ci.hi)} (평균 ${sgnPct(ci.mean)}, n=${ci.n})` : "표본 부족(5건 미만)" },
    { id: "stress", label: `스트레스(추가 비용 ${P.stressPct ?? 0}%) 후에도 기대값 플러스`, ok: stress?.expectancy != null ? stress.expectancy > 0 : false, detail: stress?.expectancy != null ? `${sgnPct(stress.expectancy)}` : "—" },
    { id: "holdout", label: "시간 분할 검증(앞 60%로 선택 → 뒤 40%)에서도 플러스", ok: holdout?.holds ?? null, detail: holdout ? (holdout.holds == null ? `검증 구간 체결 ${holdout.testFilled}건 — 표본 부족` : `선택 ${holdout.key} · 앞 ${sgnPct(holdout.trainExp)} → 뒤 ${sgnPct(holdout.testExp)} (체결 ${holdout.testFilled}건)`) : "신호 10건 미만" },
    { id: "pf", label: `손익비 ${T.profitFactorMin} 이상 + 손실 ${T.minLosses}건 이상 경험`, ok: best ? (best.profitFactor ?? 0) >= T.profitFactorMin && best.losses >= T.minLosses : false, detail: best ? `손익비 ${best.profitFactor ?? "—"} · 손실 ${best.losses}건 (손실이 안 나온 표본은 위험이 가려져 있어요)` : "—" },
    { id: "mdd", label: `최대 낙폭 ${T.maxDrawdownPct}%p 이하`, ok: best?.maxDrawdownPct != null ? best.maxDrawdownPct <= T.maxDrawdownPct : false, detail: best?.maxDrawdownPct != null ? `${best.maxDrawdownPct}%p · 최악 한 번 ${best.worstNetPct ?? "—"}%` : "—" },
    { id: "latency", label: "지연 가정(주문까지 걸리는 시간)이 실측 중앙값 이상", ok: latency.n >= 10 && latency.medianMin != null ? latency.assumedMin >= latency.medianMin : null, detail: latency.n ? `가정 ${latency.assumedMin}분 · 실측 중앙값 ${latency.medianMin}분 · 90% ${latency.p90Min}분 (n=${latency.n})` : "실시간 신호가 아직 없음" },
    { id: "verify", label: "최근 24시간 안의 데이터 검증 통과(재계산 전부 + 토스 대조 80% 이상)", ok: v && v.localAt != null ? fresh(v.localAt) && v.localOk === true && (v.tossRate == null || (fresh(v.tossAt) && v.tossRate >= T.tossRateMin)) : null, detail: v && v.localAt != null ? `재계산 ${v.localOk ? "통과" : "실패"}${v.tossRate != null ? ` · 토스 대조 ${Math.round(v.tossRate * 100)}%` : " · 토스 대조 아직 없음"}` : "검증 기록 없음" },
    { id: "rule", label: "기록 도중 판정 기준이 바뀌지 않음", ok: ruleVersions <= 1, detail: ruleVersions <= 1 ? "일관" : `서로 다른 기준 ${ruleVersions}종이 섞여 있어요` },
  ];
  const passed = gates.filter((g) => g.ok === true).length;
  const critical = ["ci", "stress", "holdout", "verify"].some((id) => gates.find((g) => g.id === id)?.ok === false);
  const readiness: Assessment["readiness"] = passed === gates.length ? "ready" : passed >= Math.ceil(gates.length * 0.75) && !critical ? "close" : "no";
  const readinessText =
    readiness === "ready"
      ? "🟢 모든 게이트 통과 — 소액·드라이런(실주문 잠금) 검증 단계로 넘어갈 수 있습니다. 바로 실계좌 자동매매로 가면 안 됩니다."
      : readiness === "close"
        ? `🟡 ${passed}/${gates.length} 통과 — 거의 왔지만 남은 게이트를 채우기 전엔 실매매 금지.`
        : `🔴 ${passed}/${gates.length} 통과 — 아직 실매매를 검토할 단계가 아닙니다(데이터를 더 쌓으세요).`;

  const topVariants = variants
    .filter((x) => x.kind === "candle" && x.entryIdx === 1 && x.filled >= minFilled)
    .sort((a, b) => (b.expectancyPerSignal ?? -999) - (a.expectancyPerSignal ?? -999))
    .slice(0, 12);

  return { scope: opts.realtimeOnly ? "realtime" : "all", asOf: nowMs, counts, verdict, ci, holdout, stress, concentration, latency, ruleVersions, pace, gates, gatesPassed: passed, readiness, readinessText, topVariants };
}

function sgnPct(v: number | null | undefined): string {
  return v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
