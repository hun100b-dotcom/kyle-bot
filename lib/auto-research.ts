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

// =============================================================================
// [v0.35.0] 그룹(공동개발자·동업자) 전체 연구 — 여러 회원의 기록을 실명으로 함께 본다
// -----------------------------------------------------------------------------
// [오너 지시 2026-09-28] "카프리는 비공개 그룹(동의 전제) — 투자조언·연구 목적 둘 다 유지,
//   비식별화(익명화)는 하지 않는다. 어떤 그룹원의 어떤 스타일·성향·지속성이 어떤 영향을
//   미치는지 연구해야 하기 때문." → 회원별 성적을 실명(이메일) 그대로 드러내는 리더보드와
//   그룹 전체 합산 통계를 만든다. 회원 한 명 한 명의 통계는 summarizeAutoHistory를 그대로
//   재사용한다(계산 규칙이 "나만 볼 때"와 "그룹으로 볼 때"가 절대 어긋나지 않게).
// =============================================================================

/** 회원 한 명의 원본 입력(전자우편 = 실명 식별자, 오너 지시대로 비식별화하지 않는다). */
export interface GroupMemberInput {
  email: string;
  history: AutoTradeHistoryEntry[];
}

/** 회원 한 명의 리더보드 행. */
export interface GroupMemberStat extends ResearchBucket {
  email: string;
  totalEntries: number; // 이 회원의 기록 전체 개수(취소·수동청산 포함)
  headline: string | null; // 이 회원 개인 헤드라인(표본 10건 미만이면 null)
}

/** 그룹 연구탭 전체 결과. */
export interface GroupResearchSummary {
  memberCount: number;
  overall: ResearchBucket; // 전원의 결정적(승/패) 매매를 하나로 합친 그룹 전체 성적
  byMember: GroupMemberStat[]; // 누적손익 큰 순(리더보드)
  headline: string | null;
}

/** 회원별 기록 배열을 받아 그룹 전체 리더보드 + 합산 통계를 낸다(실명 유지, 비식별화 없음). */
export function summarizeGroupHistory(members: GroupMemberInput[]): GroupResearchSummary {
  const byMember: GroupMemberStat[] = members
    .map((m) => {
      const s = summarizeAutoHistory(m.history);
      return { email: m.email, totalEntries: s.totalEntries, headline: s.headline, ...s.overall };
    })
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  const overall = summarizeAutoHistory(members.flatMap((m) => m.history)).overall;

  let headline: string | null = null;
  if (overall.n >= MIN_SAMPLE_FOR_HEADLINE && overall.winRate != null) {
    const top = byMember.find((m) => m.n >= 3);
    headline = `그룹 전체 ${overall.n}건 중 승률 ${overall.winRate}%, 누적손익 ${overall.totalPnlUsd >= 0 ? "+" : ""}$${overall.totalPnlUsd}` +
      (top ? ` · 가장 성적 좋은 회원은 ${top.email}(${top.n}건, 승률 ${top.winRate}%)` : "");
  }

  return { memberCount: members.length, overall, byMember, headline };
}

// =============================================================================
// [v0.49.0] "Raw Data" 탭 — criteriaSnapshot 필드별 성적 비교 + CSV 원본 내보내기
// -----------------------------------------------------------------------------
// [오너 지시 2026-09-29] "criteriaSnapshot 필드별로 그룹화한 성적 집계를 제공(cloudEnabled
//   on/off, session별, maxInvestPct 구간별 등)" + "원본 데이터를 CSV로 내보내는 버튼(앱
//   안에서 상관관계·회귀 분석까지 시도하지 말 것 — Excel/Sheets/Python에서 하도록 유도)".
//
// [통계적 유의성 경고 — 왜 여기서부터 강조하는가] 카프리는 비공개 그룹(개발자 3명 내외로
//   알려짐)이라 어느 필드로 쪼개도 표본이 금방 한 자릿수로 줄어든다. 이 함수 자체는 그냥
//   집계일 뿐 "유의미하다/아니다"를 판단하지 않는다 — 그 판단(및 "확정적 인과 결론 금지"
//   문구 표시)은 반드시 화면(App.tsx의 Raw Data 탭)이 sampleSize를 보고 매번 함께 보여줘야
//   한다. summarizeAutoHistory의 MIN_SAMPLE_FOR_HEADLINE(10건)과 같은 기준을 그대로 쓴다.
// =============================================================================

type CriteriaSnapshot = NonNullable<AutoTradeHistoryEntry["criteriaSnapshot"]>;

/** criteriaSnapshot 필드 하나를 쪼갠 그룹 하나의 성적(라벨 + 공통 통계). */
export interface CriteriaGroupStat extends ResearchBucket {
  label: string; // 예: "켬" / "끔" / "데이" / "10~20%"
}

/** criteriaSnapshot 필드 하나를 기준으로 나눈 성적 비교표. */
export interface CriteriaBreakdown {
  field: string; // criteriaSnapshot의 실제 필드명(예: "cloudEnabled") — 화면 key·디버그용
  title: string; // 화면에 보여줄 한글 제목
  groups: CriteriaGroupStat[];
}

/** Raw Data 탭 "설정별 성적 비교" 섹션 전체 결과. */
export interface CriteriaResearchSummary {
  sampleSize: number; // 승/패로 마감 + criteriaSnapshot이 있는 표본 수(신뢰도 판단 기준)
  breakdowns: CriteriaBreakdown[];
}

const SESSION_ORDER: Record<CriteriaSnapshot["session"], number> = { day: 0, pre: 1, regular: 2, after: 3, closed: 4 };
const SESSION_LABEL: Record<CriteriaSnapshot["session"], string> = { day: "데이", pre: "프리", regular: "본장", after: "애프터", closed: "장마감" };

type Acc = { n: number; wins: number; losses: number; totalPnlUsd: number; pctSum: number; pctN: number };
function newAcc(): Acc {
  return { n: 0, wins: 0, losses: 0, totalPnlUsd: 0, pctSum: 0, pctN: 0 };
}

/** 그룹 라벨 + 정렬 순서(작을수록 앞). 불리언은 "켬"이 먼저, 구간은 낮은 구간이 먼저 오도록. */
interface GroupKey {
  label: string;
  sortKey: number;
}

function boolKey(v: boolean): GroupKey {
  return v ? { label: "켬", sortKey: 0 } : { label: "끔", sortKey: 1 };
}

/** 퍼센트 값을 오름차순 경계(edges)로 구간화. 예: edges=[10,20,30,50] →
 *  "10% 미만" / "10~20%" / "20~30%" / "30~50%" / "50% 이상". */
function bucketPct(v: number, edges: number[]): GroupKey {
  for (let i = 0; i < edges.length; i++) {
    if (v < edges[i]) {
      const lo = i === 0 ? null : edges[i - 1];
      return { label: lo == null ? `${edges[i]}% 미만` : `${lo}~${edges[i]}%`, sortKey: i };
    }
  }
  return { label: `${edges[edges.length - 1]}% 이상`, sortKey: edges.length };
}

/** 값 그대로가 이해하기 쉬운 정수 필드(최대 종목 수 등)는 구간 없이 값 그대로 그룹핑. */
function exactCountKey(v: number, unit: string): GroupKey {
  return { label: `${v}${unit}`, sortKey: v };
}

/** decisive(승/패로 마감된) 기록만으로 하나의 필드를 기준 그룹핑한다. criteriaSnapshot이 없는
 *  기록(v0.45.0 이전 옛 기록·수동 매매)은 이 집계에서 조용히 제외한다. */
function buildBreakdown(decisive: AutoTradeHistoryEntry[], field: string, title: string, keyFn: (c: CriteriaSnapshot) => GroupKey): CriteriaBreakdown {
  const acc = new Map<string, Acc & { sortKey: number }>();
  for (const e of decisive) {
    if (!e.criteriaSnapshot) continue;
    const { label, sortKey } = keyFn(e.criteriaSnapshot);
    const a = acc.get(label) ?? { ...newAcc(), sortKey };
    a.n++;
    if (e.status === "closed_win") a.wins++; else a.losses++;
    if (e.pnlUsd != null) a.totalPnlUsd += e.pnlUsd;
    if (e.pnlPct != null) { a.pctSum += e.pnlPct; a.pctN++; }
    acc.set(label, a);
  }
  const groups: CriteriaGroupStat[] = [...acc.entries()]
    .sort((x, y) => x[1].sortKey - y[1].sortKey)
    .map(([label, a]) => ({ label, ...finalize(a) }));
  return { field, title, groups };
}

/** 자동매매기록을 criteriaSnapshot 필드별(구름대 필터·EMA·세션·투입비율 등)로 쪼개 승률·손익을
 *  비교한다. 승/패로 마감된 매매만 대상(수동청산·취소·드라이런은 애초에 승패가 없어 제외 —
 *  summarizeAutoHistory의 decisive 정의와 동일). 여러 회원 기록을 합쳐 넘겨도(그룹 전체 보기)
 *  그대로 동작한다 — 이 함수는 "누가 냈는지"를 보지 않고 설정값만 본다. */
export function summarizeByCriteria(entries: AutoTradeHistoryEntry[]): CriteriaResearchSummary {
  const decisive = entries.filter((e) => (e.status === "closed_win" || e.status === "closed_loss") && e.criteriaSnapshot);
  const breakdowns: CriteriaBreakdown[] = [
    buildBreakdown(decisive, "cloudEnabled", "구름대 필터", (c) => boolKey(c.cloudEnabled)),
    buildBreakdown(decisive, "emaTrendEnabled", "EMA 추세 필터", (c) => boolKey(c.emaTrendEnabled)),
    buildBreakdown(decisive, "dojiMaxAgeEnabled", "도지 유효시간 제한", (c) => boolKey(c.dojiMaxAgeEnabled)),
    buildBreakdown(decisive, "nextCandleConfirmEnabled", "다음 캔들 확인", (c) => boolKey(c.nextCandleConfirmEnabled)),
    buildBreakdown(decisive, "excludeEtf", "ETF 제외", (c) => boolKey(c.excludeEtf)),
    buildBreakdown(decisive, "session", "매매 세션", (c) => ({ label: SESSION_LABEL[c.session], sortKey: SESSION_ORDER[c.session] })),
    buildBreakdown(decisive, "maxInvestPct", "최대 투입 비율(시드 대비)", (c) => bucketPct(c.maxInvestPct, [10, 20, 30, 50])),
    buildBreakdown(decisive, "maxLossPct", "최대 손실 한도(시드 대비)", (c) => bucketPct(c.maxLossPct, [5, 10, 20])),
    buildBreakdown(decisive, "maxPositions", "최대 종목 수", (c) => exactCountKey(c.maxPositions, "개")),
  ];
  return { sampleSize: decisive.length, breakdowns };
}

/** Raw Data 탭 한 행. 그룹 전체 보기일 때만 email이 채워진다(내 데이터 보기는 undefined). */
export interface RawHistoryRow {
  email?: string;
  entry: AutoTradeHistoryEntry;
}

/** CSV 한 줄에 안전하게 넣기 위한 이스케이프(쉼표·줄바꿈·큰따옴표 포함 시 큰따옴표로 감싸기). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** [오너 지시 2026-09-29] "앱 안에서 상관관계·회귀 분석까지 시도하지 말 것" — 이 함수는
 *  criteriaSnapshot까지 펼친 평평한(flat) 표를 CSV 문자열로만 만들어 준다. 실제 통계 분석
 *  (상관관계·회귀 등)은 오너가 Excel/Sheets/Python에서 직접 한다는 전제. */
export function autoHistoryToCsv(rows: RawHistoryRow[]): string {
  const headers = [
    "email", "id", "symbol", "status", "enteredAt", "exitedAt", "entry", "exitPrice", "quantity",
    "pnlUsd", "pnlPct", "note",
    "bodyRatio", "emaTrendEnabled", "emaPeriod", "cloudEnabled", "dojiWickMinRatio",
    "dojiMaxAgeEnabled", "dojiMaxAgeMinutes", "nextCandleConfirmEnabled", "excludeEtf", "session",
    "maxPositions", "maxLossPct", "maxInvestPct", "watchMinutes",
  ];
  const lines = [headers.join(",")];
  for (const { email, entry: e } of rows) {
    const c = e.criteriaSnapshot;
    lines.push([
      email ?? "", e.id, e.symbol, e.status, e.enteredAt, e.exitedAt ?? "", e.entry, e.exitPrice ?? "", e.quantity,
      e.pnlUsd ?? "", e.pnlPct ?? "", e.note,
      c?.bodyRatio ?? "", c?.emaTrendEnabled ?? "", c?.emaPeriod ?? "", c?.cloudEnabled ?? "", c?.dojiWickMinRatio ?? "",
      c?.dojiMaxAgeEnabled ?? "", c?.dojiMaxAgeMinutes ?? "", c?.nextCandleConfirmEnabled ?? "", c?.excludeEtf ?? "", c?.session ?? "",
      c?.maxPositions ?? "", c?.maxLossPct ?? "", c?.maxInvestPct ?? "", c?.watchMinutes ?? "",
    ].map(csvCell).join(","));
  }
  return lines.join("\n");
}
