// =============================================================================
// lib/report.ts — "오늘의 매매 리포트" 집계 (순수 계산, PC·폰 공통)
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   그동안 쌓인 매매 기록에서 **오늘 청산(정리)된 거래만** 골라,
//   한눈에 볼 숫자로 요약합니다: 얼마 벌었나 / 익절·손절 몇 번 / 오늘의 1등 종목 / 종목별 성적.
//
// [왜 별도 파일인가?]
//   화면(React)이나 저장소(파일·브라우저)와 섞이지 않은 **순수 계산**이라
//   PC 앱과 폰 웹앱이 똑같이 쓰고, 테스트로 규칙을 못 박아 둘 수 있습니다.
//
// [중요한 규칙 두 가지]
//   ① **실제 체결만 셉니다.** 연습(mock)·드라이런(dryrun) 기록은 제외합니다.
//      모의 기록이 섞이면 "오늘 얼마 벌었나"가 거짓이 되기 때문입니다.
//   ② **오늘 '청산된' 거래**만 셉니다. 아직 들고 있는 종목은 손익이 확정되지 않았으므로
//      리포트의 실현손익에 넣지 않습니다(대신 '진행 중' 개수로만 보여 줍니다).
// =============================================================================

/** 리포트가 필요로 하는 거래 한 건의 모양(엔진의 StrengthTrade 중 쓰는 것만). */
export interface ReportTrade {
  symbol: string;
  mode: "mock" | "dryrun" | "real";
  entryTs: string; //            "MM-dd HH:mm:ss"
  entryPrice: number;
  exitTs: string | null; //      청산 시각(미청산이면 null)
  exitPrice: number | null;
  exitKind: "tp" | "sl" | "manual" | null;
  resultPct: number | null;
  outcome: "win" | "loss" | null;
  quantity?: number; //          수량(없을 수 있음 — 옛 기록은 금액 계산 불가)
}

/** 종목 한 줄 요약(오늘 그 종목으로 얼마를 어떻게 먹었나) */
export interface ReportRow {
  symbol: string;
  trades: number; //          오늘 청산한 횟수
  wins: number; //            그중 이익
  losses: number; //          그중 손실
  pnlUsd: number | null; //   실현 손익 금액(수량을 아는 거래만 합산). 전부 모르면 null
  pctAvg: number; //          평균 수익률(%)
  pctBest: number; //         그 종목에서 가장 잘 먹은 한 방(%)
  hasAmount: boolean; //      금액을 계산할 수 있었는지(수량이 있었는지)
}

/** 오늘의 리포트 전체 */
export interface DailyReport {
  dateKey: string; //          기준 날짜("MM-dd")
  closed: number; //           오늘 청산한 거래 수
  openNow: number; //          아직 들고 있는(미청산) 거래 수 — 참고용
  tpCount: number; //          익절 횟수
  slCount: number; //          손절 횟수
  manualCount: number; //      수동 청산 횟수
  wins: number;
  losses: number;
  winRate: number | null; //   승률 %(청산 기준). 청산이 없으면 null
  totalPnlUsd: number | null; // 오늘 실현 손익 합계($). 수량을 아는 게 하나도 없으면 null
  avgPct: number | null; //    평균 수익률 %
  best: ReportRow | null; //   오늘의 1등 종목(수익률 기준)
  rows: ReportRow[]; //        종목별 요약(잘 번 순서)
}

/** 거래 한 건의 실현 금액($). 수량을 모르면 null(추측하지 않는다). */
export function tradePnlUsd(t: ReportTrade): number | null {
  if (t.exitPrice == null || t.quantity == null || !Number.isFinite(t.quantity)) return null;
  const diff = (t.exitPrice - t.entryPrice) * t.quantity;
  return Math.round(diff * 100) / 100; // 센트 단위 정리
}

/**
 * buildDailyReport — 오늘 청산된 실제 거래만 모아 리포트를 만든다.
 *
 * @param trades  전체 거래 기록
 * @param dateKey 오늘 날짜 "MM-dd" (한국 시각 기준. 기록의 시각 형식과 맞춘다)
 *
 * [왜 "MM-dd" 로 비교하나?] 기록의 시각이 "08-18 22:10:03" 형식(연도 없음)이라
 *   같은 형식으로 앞부분만 비교하는 것이 가장 확실합니다.
 */
export function buildDailyReport(trades: ReportTrade[], dateKey: string): DailyReport {
  // ① 실제 체결(real) + 오늘 청산된 것만
  const todays = trades.filter(
    (t) => t.mode === "real" && t.exitTs != null && t.exitTs.startsWith(dateKey) && t.resultPct != null,
  );

  // 참고: 지금 들고 있는(미청산) 실거래 수 — 오늘 것이 아니어도 '진행 중'으로 보여 준다.
  const openNow = trades.filter((t) => t.mode === "real" && t.outcome == null).length;

  const tpCount = todays.filter((t) => t.exitKind === "tp").length;
  const slCount = todays.filter((t) => t.exitKind === "sl").length;
  const manualCount = todays.filter((t) => t.exitKind === "manual").length;
  const wins = todays.filter((t) => t.outcome === "win").length;
  const losses = todays.filter((t) => t.outcome === "loss").length;

  // ② 종목별로 묶기
  const bySymbol = new Map<string, ReportTrade[]>();
  for (const t of todays) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  const rows: ReportRow[] = [...bySymbol.entries()].map(([symbol, list]) => {
    const pcts = list.map((t) => t.resultPct as number);
    const amounts = list.map(tradePnlUsd).filter((v): v is number => v != null);
    return {
      symbol,
      trades: list.length,
      wins: list.filter((t) => t.outcome === "win").length,
      losses: list.filter((t) => t.outcome === "loss").length,
      pnlUsd: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      pctAvg: Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100,
      pctBest: Math.round(Math.max(...pcts) * 100) / 100,
      hasAmount: amounts.length > 0,
    };
  });

  // ③ 잘 번 순서로 정렬(수익률 기준 — 금액은 수량을 모를 수 있어 기준으로 삼지 않는다)
  rows.sort((a, b) => b.pctAvg - a.pctAvg);

  const allAmounts = todays.map(tradePnlUsd).filter((v): v is number => v != null);
  const allPcts = todays.map((t) => t.resultPct as number);

  return {
    dateKey,
    closed: todays.length,
    openNow,
    tpCount,
    slCount,
    manualCount,
    wins,
    losses,
    winRate: todays.length ? Math.round((wins / todays.length) * 1000) / 10 : null,
    totalPnlUsd: allAmounts.length ? Math.round(allAmounts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    avgPct: allPcts.length ? Math.round((allPcts.reduce((a, b) => a + b, 0) / allPcts.length) * 100) / 100 : null,
    // 1등은 '가장 잘 먹은 한 방'이 큰 종목(사장님이 보고 싶어 하는 건 최고 성적)
    best: rows.length ? [...rows].sort((a, b) => b.pctBest - a.pctBest)[0] : null,
    rows,
  };
}
