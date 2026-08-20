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
  /**
   * [v0.9.2] 청산 시각(밀리초). 기간 조회를 정확히 하기 위해 새로 남긴다.
   *   기존 exitTs 는 "MM-dd HH:mm:ss"(연도 없음)이라 1년 전 같은 날짜와 헷갈릴 수 있다.
   *   옛 기록에는 없으므로, 없으면 날짜 문자열로 비교한다(아래 inPeriod 참고).
   */
  exitAtMs?: number;
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

/** 조회 기간 종류 */
export type PeriodKind = "today" | "week" | "month" | "date";

/**
 * 조회 기간.
 *   keys  : 이 기간에 포함되는 날짜들("MM-dd") — 옛 기록(연도 없는 시각) 비교용
 *   fromMs/toMs : 정확한 시작·끝(밀리초) — 새 기록(exitAtMs) 비교용
 */
export interface Period {
  kind: PeriodKind;
  label: string; //   화면에 보여 줄 이름("2026-08-19", "최근 7일" 등)
  keys: string[];
  fromMs: number;
  toMs: number;
}

/** 오늘의 리포트 전체 */
export interface DailyReport {
  dateKey: string; //          기준 날짜("MM-dd") — 하위호환용(기간 조회면 시작일)
  periodLabel: string; //      [v0.9.2] 화면에 표시할 기간 이름
  periodKind: PeriodKind; //   [v0.9.2] 어떤 기간을 봤는지
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
  /**
   * [v0.9.8] 이 숫자가 어디서 왔는가.
   *   "live"  = 방금 토스에서 최신까지 받아 왔다
   *   "cache" = 연결이 없어 **기기에 저장된 기록**으로 보여 준다(과거 이력은 그대로 보인다)
   *   "none"  = 저장된 기록조차 없다
   */
  source?: "live" | "cache" | "none";
  /** 마지막으로 토스에서 받아 온 시각(밀리초). 저장된 기록으로 보여 줄 때 화면에 표시한다. */
  lastSyncMs?: number | null;
  /** 기기에 저장된 전체 매매(매도) 건수 — 기간 밖까지 포함. 빈 상태 문구를 정확히 쓰기 위함 */
  savedTotal?: number;
}

/** 거래 한 건의 실현 금액($). 수량을 모르면 null(추측하지 않는다). */
export function tradePnlUsd(t: ReportTrade): number | null {
  if (t.exitPrice == null || t.quantity == null || !Number.isFinite(t.quantity)) return null;
  const diff = (t.exitPrice - t.entryPrice) * t.quantity;
  return Math.round(diff * 100) / 100; // 센트 단위 정리
}

/**
 * makePeriod — 기간 하나를 만든다(오늘 / 최근 7일 / 최근 30일 / 특정 날짜).
 *
 * [기간 정의 — 화면 설명과 반드시 일치해야 한다]
 *   · today : 오늘 하루(한국 시각 00:00 ~ 23:59:59)
 *   · week  : **오늘 포함 최근 7일**
 *   · month : **오늘 포함 최근 30일**(달력상 '이번 달'이 아니라 최근 30일 — 매일 같은 길이라 비교가 쉽다)
 *   · date  : 고른 날짜 하루
 *
 * @param nowMs  지금 시각(밀리초)
 * @param tzOffsetMin 화면을 보는 사람의 시간대 보정(분). 한국이면 540(=UTC+9).
 * @param picked "yyyy-MM-dd" (kind가 date 일 때만)
 */
export function makePeriod(kind: PeriodKind, nowMs: number, tzOffsetMin = 540, picked?: string): Period {
  const DAY = 86_400_000;
  const MIN = 60_000;

  /** 그 시간대 기준으로 '그 날 00:00'의 밀리초 */
  const startOfLocalDay = (ms: number): number => {
    const shifted = ms + tzOffsetMin * MIN; // 그 시간대의 벽시계로 옮긴 뒤
    return Math.floor(shifted / DAY) * DAY - tzOffsetMin * MIN; // 날짜 경계로 자르고 되돌린다
  };
  /** 밀리초 → "MM-dd"(그 시간대 기준) */
  const keyOf = (ms: number): string => {
    const d = new Date(ms + tzOffsetMin * MIN);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };

  let fromMs: number;
  let toMs: number;
  let label: string;

  if (kind === "date" && picked) {
    // "2026-08-15" → 그 날 00:00 ~ 23:59:59.999 (그 시간대 기준)
    const [y, m, d] = picked.split("-").map(Number);
    fromMs = Date.UTC(y, m - 1, d) - tzOffsetMin * MIN;
    toMs = fromMs + DAY - 1;
    label = picked;
  } else if (kind === "week") {
    toMs = startOfLocalDay(nowMs) + DAY - 1;
    fromMs = startOfLocalDay(nowMs) - 6 * DAY; // 오늘 포함 7일
    label = "최근 7일";
  } else if (kind === "month") {
    toMs = startOfLocalDay(nowMs) + DAY - 1;
    fromMs = startOfLocalDay(nowMs) - 29 * DAY; // 오늘 포함 30일
    label = "최근 30일";
  } else {
    fromMs = startOfLocalDay(nowMs);
    toMs = fromMs + DAY - 1;
    label = "오늘";
  }

  // 이 기간에 들어가는 날짜 목록("MM-dd") — 연도가 없는 옛 기록을 걸러내는 데 쓴다.
  const keys: string[] = [];
  for (let t = startOfLocalDay(fromMs); t <= toMs; t += DAY) keys.push(keyOf(t));

  return { kind, label, keys, fromMs, toMs };
}

/** 거래 한 건이 그 기간에 들어가나? */
function inPeriod(t: ReportTrade, p: Period): boolean {
  // 새 기록은 정확한 시각(밀리초)이 있으므로 그것으로 판단한다(연도까지 정확).
  if (typeof t.exitAtMs === "number") return t.exitAtMs >= p.fromMs && t.exitAtMs <= p.toMs;
  // 옛 기록은 "MM-dd" 만 있으므로 날짜 목록으로 비교한다.
  //   (1년 전 같은 날짜가 섞일 수 있지만, 기록은 최근 1000건만 보관하므로 실사용에선 사실상 없다)
  return t.exitTs != null && p.keys.includes(t.exitTs.slice(0, 5));
}

/**
 * buildReport — 고른 기간의 '실제 체결'만 모아 요약한다.
 *
 * [변하지 않는 규칙]
 *   ① 연습(mock)·드라이런은 절대 넣지 않는다(번 적 없는 돈이 보이면 안 된다).
 *   ② 청산(판 것)만 넣는다. 아직 들고 있는 건 '진행 중' 개수로만 보여 준다.
 */
export function buildReport(trades: ReportTrade[], period: Period): DailyReport {
  const picked = trades.filter((t) => t.mode === "real" && t.resultPct != null && inPeriod(t, period));

  // 지금 들고 있는(미청산) 실거래 수 — 기간과 무관하게 '진행 중'으로 보여 준다.
  const openNow = trades.filter((t) => t.mode === "real" && t.outcome == null).length;

  const tpCount = picked.filter((t) => t.exitKind === "tp").length;
  const slCount = picked.filter((t) => t.exitKind === "sl").length;
  const manualCount = picked.filter((t) => t.exitKind === "manual").length;
  const wins = picked.filter((t) => t.outcome === "win").length;
  const losses = picked.filter((t) => t.outcome === "loss").length;

  // 종목별로 묶기
  const bySymbol = new Map<string, ReportTrade[]>();
  for (const t of picked) {
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

  // 잘 번 순서(수익률 기준 — 금액은 수량을 모를 수 있어 기준으로 삼지 않는다)
  rows.sort((a, b) => b.pctAvg - a.pctAvg);

  const allAmounts = picked.map(tradePnlUsd).filter((v): v is number => v != null);
  const allPcts = picked.map((t) => t.resultPct as number);

  return {
    dateKey: period.keys[0] ?? "",
    periodLabel: period.label,
    periodKind: period.kind,
    closed: picked.length,
    openNow,
    tpCount,
    slCount,
    manualCount,
    wins,
    losses,
    winRate: picked.length ? Math.round((wins / picked.length) * 1000) / 10 : null,
    totalPnlUsd: allAmounts.length ? Math.round(allAmounts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    avgPct: allPcts.length ? Math.round((allPcts.reduce((a, b) => a + b, 0) / allPcts.length) * 100) / 100 : null,
    // 1등 = '가장 잘 먹은 한 방'이 큰 종목
    best: rows.length ? [...rows].sort((a, b) => b.pctBest - a.pctBest)[0] : null,
    rows,
  };
}

/**
 * buildReportFromRealized — [v0.9.6] **토스 실제 체결내역**으로 만든 리포트.
 *
 *   기존 buildReport 는 앱이 남긴 기록(직접 [매도]를 눌렀을 때만 생김)을 봤다.
 *   조건주문 자동체결·토스앱 매도는 앱이 알 수 없어 **리포트가 늘 비어 있었다.**
 *   이제는 토스에 남은 체결 내역으로 만들기 때문에 **어디서 팔았든 전부 잡힌다.**
 *
 *   익절/손절 구분: 토스 주문내역만으로는 '익절 주문이었는지'를 알 수 없다.
 *   그래서 **이익이 난 매도 = 익절, 손실이 난 매도 = 손절**로 센다(사장님이 보고 싶어 하는 의미와 같다).
 */
export function buildReportFromRealized(
  trades: { symbol: string; sellAtMs: number; qty: number; pnl: number; pct: number }[],
  period: Period,
  openNow = 0,
): DailyReport {
  const picked = trades.filter((t) => t.sellAtMs >= period.fromMs && t.sellAtMs <= period.toMs);

  const wins = picked.filter((t) => t.pnl >= 0).length;
  const losses = picked.length - wins;

  const bySymbol = new Map<string, typeof picked>();
  for (const t of picked) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  const rows: ReportRow[] = [...bySymbol.entries()].map(([symbol, list]) => ({
    symbol,
    trades: list.length,
    wins: list.filter((t) => t.pnl >= 0).length,
    losses: list.filter((t) => t.pnl < 0).length,
    pnlUsd: Math.round(list.reduce((a, b) => a + b.pnl, 0) * 100) / 100,
    pctAvg: Math.round((list.reduce((a, b) => a + b.pct, 0) / list.length) * 100) / 100,
    pctBest: Math.round(Math.max(...list.map((t) => t.pct)) * 100) / 100,
    hasAmount: true,
  }));
  rows.sort((a, b) => b.pctAvg - a.pctAvg);

  return {
    dateKey: period.keys[0] ?? "",
    periodLabel: period.label,
    periodKind: period.kind,
    closed: picked.length,
    openNow,
    tpCount: wins, //     이익 매도 = 익절
    slCount: losses, //   손실 매도 = 손절
    manualCount: 0, //    토스 내역만으로는 구분 불가(그래서 0으로 두고 화면에서도 숨긴다)
    wins,
    losses,
    winRate: picked.length ? Math.round((wins / picked.length) * 1000) / 10 : null,
    totalPnlUsd: picked.length ? Math.round(picked.reduce((a, b) => a + b.pnl, 0) * 100) / 100 : null,
    avgPct: picked.length ? Math.round((picked.reduce((a, b) => a + b.pct, 0) / picked.length) * 100) / 100 : null,
    best: rows.length ? [...rows].sort((a, b) => b.pctBest - a.pctBest)[0] : null,
    rows,
  };
}

/**
 * buildDailyReport — (하위호환) 하루치 리포트. 내부적으로 buildReport 를 쓴다.
 *   기존 호출부·테스트가 그대로 동작하도록 남겨 둔다.
 */
export function buildDailyReport(trades: ReportTrade[], dateKey: string): DailyReport {
  const period: Period = {
    kind: "today",
    label: dateKey,
    keys: [dateKey],
    fromMs: -Infinity, // 옛 방식 그대로 "MM-dd" 문자열로만 비교하도록
    toMs: Infinity,
  };
  // 정확한 시각(exitAtMs)이 있는 기록도 날짜 문자열로 비교되게 keys 만 쓰는 경로를 태운다.
  const onlyKeys = trades.map((t) => ({ ...t, exitAtMs: undefined }));
  return buildReport(onlyKeys, period);
}
