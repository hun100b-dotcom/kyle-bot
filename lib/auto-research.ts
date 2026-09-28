// =============================================================================
// lib/auto-research.ts — "자동매매기록 → 연구" 탭이 쓰는 순수 통계 함수
// -----------------------------------------------------------------------------
// [오너 요구 2026-09-28] "자동매매기록을 통한 연구탭을 만들어 데이터를 취합하여 매매연구를
//   진행하려고 한다. 기본적으로 나의 계정에 대한 데이터를 토대로."
//
//   자동매매가 낸 매매는 electron/tool-engine.ts의 AutoTradeHistoryEntry로 전부 영속 저장되고
//   있다(진입가·청산가·손익·시각·상태). 이미 손익이 계산돼 있어(FIFO 재계산 불필요) 이 기록만
//   가지고도 승률·평균손익·종목별/시간대별 성적 같은 "연구"에 바로 쓸 수 있다.
//
// [순수 함수인 이유] lib/trade-analysis.ts(전체 매매 분석)와 같은 이유 — 화면·네트워크와
//   분리해야 PC/폰 양쪽에서 똑같이 계산되고, 테스트로 계산 규칙을 고정할 수 있다.
// =============================================================================

import { DateTime } from "luxon";
// [주의] electron/tool-engine.ts에서 타입을 import하지 않는다 — 그 파일은 node 전용 API(process 등)를
// 쓰고 있어서, src(브라우저 빌드 tsconfig)가 이 파일을 따라 들어가면 타입체크가 깨진다.
// src/kyletool.d.ts에 이미 같은 모양의 AutoTradeHistoryEntry가 전역(ambient) 타입으로 선언돼
// 있으므로(App.tsx도 import 없이 그대로 쓴다), 이 파일도 아래에서 그 전역 이름을 그대로 쓴다
// (electron/tool-engine.ts의 실제 export 타입과 필드가 어긋나면 tests/auto-research.test.ts가
// 잡아준다 — 그 테스트는 electron/tool-engine.ts의 진짜 타입을 직접 import해 쓴다).

/** 승/패/평균 같은 묶음 통계(종목별·시간대별 등에 재사용). */
export interface ResearchBucket {
  n: number; //        표본 수(승+패, 수동청산 제외)
  wins: number;
  losses: number;
  winRate: number | null; // % — n===0이면 null(아직 통계 낼 표본이 없음)
  totalPnlUsd: number;
  avgPnlPct: number | null;
}

/** 종목 하나의 성적. */
export interface AutoSymbolStat extends ResearchBucket {
  symbol: string;
}

/** 진입 시각(시 단위, 0~23, KST)별 성적. */
export interface AutoHourStat extends ResearchBucket {
  hour: number;
}

/** 연구탭 전체 결과. */
export interface AutoResearchSummary {
  totalEntries: number; //   기록 전체 개수(진입 시도 전부 — 취소·모의 포함)
  cancelledCount: number; // 실제로 체결까지 못 간 것(취소·OCO등록실패·모의전송) — 통계 표본 밖
  overall: ResearchBucket; // 승/패로 마감된 전체 성적(closed_manual은 승패 어느 쪽도 아니라 제외)
  manualCloses: number; //   사람이 손으로 정리해 승패가 애매한 건수(참고용으로만 표시)
  avgHoldMin: number | null; // 평균 보유 시간(분) — 진입~청산을 아는 건만
  best: AutoTradeHistoryEntry | null; // 가장 크게 번 매매
  worst: AutoTradeHistoryEntry | null; // 가장 크게 잃은 매매
  bySymbol: AutoSymbolStat[]; // 손익 합계 큰 순
  byHour: AutoHourStat[]; //   시각(0~23) 순
  /** 표본이 최소 10건 이상일 때만 채워지는 한 줄 요약(너무 적은 표본으로 성급한 결론 내는 것 방지). */
  headline: string | null;
}

const MIN_SAMPLE_FOR_HEADLINE = 10;

/** "MM-dd HH:mm:ss"(KST, 연도 없음) 문자열 → 오늘 기준 DateTime. 보유시간 계산용(자정 넘는 매매는 근사치). */
function parseKstNoYear(s: string): DateTime | null {
  const dt = DateTime.fromFormat(s, "MM-dd HH:mm:ss");
  return dt.isValid ? dt : null;
}

function finalize(b: { n: number; wins: number; losses: number; totalPnlUsd: number; pctSum: number; pctN: number }): ResearchBucket {
  return {
    n: b.n,
    wins: b.wins,
    losses: b.losses,
    winRate: b.n > 0 ? Math.round((b.wins / b.n) * 1000) / 10 : null,
    totalPnlUsd: Math.round(b.totalPnlUsd * 100) / 100,
    avgPnlPct: b.pctN > 0 ? Math.round((b.pctSum / b.pctN) * 100) / 100 : null,
  };
}

/** 자동매매기록 전체를 훑어 연구탭에 필요한 통계를 한 번에 뽑는다. */
export function summarizeAutoHistory(entries: AutoTradeHistoryEntry[]): AutoResearchSummary {
  const cancelledCount = entries.filter((e) => e.status === "cancelled" || e.status === "oco_failed" || e.status === "dryrun").length;
  const manualCloses = entries.filter((e) => e.status === "closed_manual").length;
  // 승/패 표본 = 자동매매가 스스로 익절/손절까지 완결한 매매만(수동 개입 없이 순수 자동 결과).
  const decisive = entries.filter((e) => e.status === "closed_win" || e.status === "closed_loss");

  const overallAcc = { n: 0, wins: 0, losses: 0, totalPnlUsd: 0, pctSum: 0, pctN: 0 };
  const bySymbolAcc = new Map<string, typeof overallAcc>();
  const byHourAcc = new Map<number, typeof overallAcc>();
  let holdSumMin = 0;
  let holdN = 0;
  let best: AutoTradeHistoryEntry | null = null;
  let worst: AutoTradeHistoryEntry | null = null;

  for (const e of decisive) {
    const win = e.status === "closed_win";
    overallAcc.n++;
    if (win) overallAcc.wins++; else overallAcc.losses++;
    if (e.pnlUsd != null) overallAcc.totalPnlUsd += e.pnlUsd;
    if (e.pnlPct != null) { overallAcc.pctSum += e.pnlPct; overallAcc.pctN++; }

    const sym = bySymbolAcc.get(e.symbol) ?? { n: 0, wins: 0, losses: 0, totalPnlUsd: 0, pctSum: 0, pctN: 0 };
    sym.n++;
    if (win) sym.wins++; else sym.losses++;
    if (e.pnlUsd != null) sym.totalPnlUsd += e.pnlUsd;
    if (e.pnlPct != null) { sym.pctSum += e.pnlPct; sym.pctN++; }
    bySymbolAcc.set(e.symbol, sym);

    const entryDt = parseKstNoYear(e.enteredAt);
    if (entryDt) {
      const hour = entryDt.hour;
      const hr = byHourAcc.get(hour) ?? { n: 0, wins: 0, losses: 0, totalPnlUsd: 0, pctSum: 0, pctN: 0 };
      hr.n++;
      if (win) hr.wins++; else hr.losses++;
      if (e.pnlUsd != null) hr.totalPnlUsd += e.pnlUsd;
      if (e.pnlPct != null) { hr.pctSum += e.pnlPct; hr.pctN++; }
      byHourAcc.set(hour, hr);
    }

    if (e.exitedAt) {
      const exitDt = parseKstNoYear(e.exitedAt);
      if (entryDt && exitDt) {
        const mins = exitDt.diff(entryDt, "minutes").minutes;
        if (mins >= 0) { holdSumMin += mins; holdN++; } // 음수(날짜 경계 근사 오차)는 표본에서 제외
      }
    }

    if (e.pnlUsd != null) {
      if (best === null || (best.pnlUsd ?? -Infinity) < e.pnlUsd) best = e;
      if (worst === null || (worst.pnlUsd ?? Infinity) > e.pnlUsd) worst = e;
    }
  }

  const overall = finalize(overallAcc);
  const bySymbol: AutoSymbolStat[] = [...bySymbolAcc.entries()]
    .map(([symbol, acc]) => ({ symbol, ...finalize(acc) }))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  const byHour: AutoHourStat[] = [...byHourAcc.entries()]
    .map(([hour, acc]) => ({ hour, ...finalize(acc) }))
    .sort((a, b) => a.hour - b.hour);

  let headline: string | null = null;
  if (overall.n >= MIN_SAMPLE_FOR_HEADLINE && overall.winRate != null) {
    const best5 = bySymbol.filter((s) => s.n >= 3).slice(0, 1)[0];
    headline = `지금까지 자동매매 ${overall.n}건 중 승률 ${overall.winRate}%, 누적손익 ${overall.totalPnlUsd >= 0 ? "+" : ""}$${overall.totalPnlUsd}` +
      (best5 ? ` · 가장 성적 좋은 종목은 ${best5.symbol}(${best5.n}건, 승률 ${best5.winRate}%)` : "");
  }

  return {
    totalEntries: entries.length,
    cancelledCount,
    overall,
    manualCloses,
    avgHoldMin: holdN > 0 ? Math.round((holdSumMin / holdN) * 10) / 10 : null,
    best,
    worst,
    bySymbol,
    byHour,
    headline,
  };
}
