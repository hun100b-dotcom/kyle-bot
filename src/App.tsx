// =============================================================================
// src/App.tsx — Capri 매매도구 화면 (v2: 계산기 + 온디맨드 주문)
// -----------------------------------------------------------------------------
// [v2 화면 철학]
//   자동으로 갱신되는 것이 거의 없다. 시세·환율·목록은 전부 "버튼을 눌러야" 1회
//   조회된다(자율판단 제거 컨셉과 일치). 주문은 반드시 확인 팝업을 거친다.
//
// [탭 구성]
//   ① 계산기: 기법 선택(삼분할/호가창/캔들/수동) → 재료 입력 → 진입/익절/손절
//              산출($와 ₩ 병기) → 주문 버튼(확인 팝업 → 전송)
//   ② 주문 현황: 미체결 일반주문 + 조건주문(OCO) 목록·취소
//   ③ 기록: 도구가 한 일(주문·드라이런·취소) 시간순 기록
//   ④ 설정: 연습/실서버 모드, 토스 API 키(값은 화면에 재표시 안 됨)
// =============================================================================

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import TodayReport from "./TodayReport"; // [v0.9.1] 오늘의 매매 리포트 화면
import { useTabOrder } from "./useTabOrder"; // [v0.9.2] 탭 순서 드래그로 변경
import { useLab } from "./useLab"; //                         [v0.65.0] 매매연구소 상태
import { LabLiveTab, LabSignalsTab, LabCompareTab } from "./LabTabs"; // [v0.65.0] 매매연구소 화면
import { LabResultTab } from "./LabResult"; //                         [v0.66.0] 결과 요약
import { restoreInputsFromSaved } from "../lib/split-restore"; // [v0.9.3] 옛 기록도 계산기로 불러오기
import { calcSplit3Level } from "../lib/calc"; // [v0.69.6] 후보별 계획 타점(1·1.5·2분할) 표시
import { reportToMarkdown, reportAiPrompt, fmtDuration } from "../lib/auto-report"; // [v0.62.1] 자동매매 리포트 표시·복사
import { getSession } from "../lib/session"; // [v0.48.1] 자동 스크리너 탭에 "지금 세션" 켜짐/꺼짐을 바로 보여주기 위함
import { DateTime } from "luxon";
import { summarizeAutoHistory, summarizeGroupHistory, summarizeByCriteria, autoHistoryToCsv, type RawHistoryRow } from "../lib/auto-research"; // [v0.33.0/v0.35.0/v0.49.0] 연구탭 통계(순수 함수)

/** 앱이 가진 모든 탭(리프 단위 — 실제 콘텐츠를 가리키는 값. paneTab 렌더 가드는 전부 이 id 기준). */
// [v0.12.0] 탭 통폐합 9→7: '매매분석'은 체결강도 탭 하위로, '기록(journal)'은 설정 탭 하위(고급/진단)로 이동.
// [v0.27.0] 상단 탭을 2단(그룹→서브탭) 구조로 재편 — 죽은 'trades' id 제거, 자동매매 컨트롤을
//   설정 탭에서 분리해 'autoControl'로, 자동매매 스크리닝 결과를 신설해 'autoScan'으로 뺐다.
//   리프 id 자체는 그대로라 paneTab 렌더 가드·activateTab·goToTab·isTabVisible은 손댈 필요 없다.
// [v0.30.0] 자동매매 그룹에 "자동매매기록"(autoHistory) 서브탭 신설 — 오너 요청: 자동매매가 낸
//   매매의 전체 이력(영속 로그)을 따로 볼 수 있게.
// [v0.33.0] 자동매매 그룹에 "스크리닝 기준"(screenCriteria) 서브탭 신설 — 오너 요청: 스크리닝
//   조건들의 활성/비활성·수치를 전부 메뉴얼로 조절하고, 조건별 설명도 펼쳐 볼 수 있게.
// [v0.33.0] 자동매매 그룹에 "매매연구"(research) 서브탭 신설 — 오너 요청: 자동매매기록을 취합해
//   승률·종목별/시간대별 성적 같은 매매연구를 할 수 있게.
// [v0.56.0] "그룹원 관리"(groupManage) 탭 신설 — 예전엔 [설정] 안에 가입 승인·이메일 직접 등록이
//   묻혀 있었다. 오너 요청("그룹원 관리 탭을 통해 승인·수기등록·근황 파악, 채팅까지")에 따라
//   독립 탭으로 빼고, 그룹원 근황 현황판·채팅을 새로 추가했다. 같은 이유로 "기록"(journal, 예전엔
//   설정 하위)도 "서버 로그"로 이름을 바꿔 독립 탭으로 뺐다(카테고리 토글 필터 추가, 아래 참고).
const ALL_TABS = ["calc", "report", "screener", "splits", "strength", "autoControl", "autoScan", "screenCriteria", "autoHistory", "autoReport", "research", "labResult", "labLive", "labSignals", "labCompare", "orders", "groupManage", "changelog", "journal", "settings"] as const;
type TabId = (typeof ALL_TABS)[number];

/** [v0.27.0] 상단 1단 — 매매방식·성격으로 묶은 그룹. 그룹 버튼을 누르면 하위 탭(2단)이 펼쳐진다. */
type TopGroupId = "manual" | "auto" | "lab" | "status" | "settings";
const TOP_GROUP_LABEL: Record<TopGroupId, string> = { manual: "메뉴얼", auto: "🤖 자동매매", lab: "🔬 매매연구소", status: "현황", settings: "설정" };
/** 그룹 순서(드래그로 바뀔 수 있는 기본값) + 그룹별 하위 탭 목록(이 순서로 서브탭이 뜬다). */
const GROUP_CHILDREN: Record<TopGroupId, TabId[]> = {
  manual: ["calc", "screener", "splits"],
  auto: ["autoControl", "autoScan", "screenCriteria", "autoHistory", "autoReport"],
  // [v0.65.0 — 오너 지시] 매매연구는 자동매매 하위 탭에서 대분류로 올려 비중을 높이고, 신호 기록 모드 탭들을 같은 그룹에 신설
  lab: ["labResult", "labLive", "labSignals", "labCompare", "research"], // [v0.66.0] 결과 요약을 맨 앞에
  status: ["report", "strength", "orders", "groupManage", "changelog", "journal"],
  settings: ["settings"],
};
const TOP_GROUPS: TopGroupId[] = ["manual", "auto", "lab", "status", "settings"];
/** 리프 탭 → 소속 그룹(역방향 조회용). */
const TAB_GROUP: Record<TabId, TopGroupId> = {
  calc: "manual", screener: "manual", splits: "manual",
  autoControl: "auto", autoScan: "auto", screenCriteria: "auto", autoHistory: "auto", autoReport: "auto", research: "lab", labResult: "lab", labLive: "lab", labSignals: "lab", labCompare: "lab",
  report: "status", strength: "status", orders: "status", groupManage: "status", changelog: "status", journal: "status",
  settings: "settings",
};

/** 탭에 보여 줄 이름 */
const TAB_LABEL: Record<TabId, string> = {
  calc: "계산기",
  report: "📊 매매 리포트",
  screener: "스크리너",
  splits: "내 삼분할 기록",
  strength: "매매분석",
  autoControl: "자동매매 현황",
  autoScan: "자동 스크리너",
  screenCriteria: "스크리닝 기준",
  autoHistory: "자동매매기록",
  autoReport: "📑 자동매매 리포트",
  labResult: "🏁 결과 요약",
  labLive: "🔬 신호기록 현황",
  labSignals: "🧾 신호 로우",
  labCompare: "⚖️ 전략 비교·연계",
  research: "매매연구",
  orders: "주문 현황",
  groupManage: "👥 그룹원 관리",
  changelog: "🆕 업데이트 내역",
  journal: "서버 로그",
  settings: "설정",
};

const SESSION_LABEL: Record<string, string> = {
  day: "데이마켓",
  pre: "프리마켓",
  regular: "본장(정규장)",
  after: "애프터마켓",
  closed: "장 마감",
};

const TECH_LABEL: Record<string, string> = {
  split3: "삼분할 (EMA200)",
  orderbook: "호가창 (매수벽+1틱)",
  candle: "캔들 (시가−3틱)",
  manual: "수동 입력",
};

/** [v0.30.0] "자동매매기록" 탭의 상태 배지 라벨. */
const AUTO_HIST_STATUS_LABEL: Record<AutoTradeHistoryEntry["status"], string> = {
  watching: "매수 체결 대기중",
  active: "보유 중(익절·손절 등록됨)",
  closed_win: "🟢 익절 종료",
  closed_loss: "🔴 손절 종료",
  closed_manual: "취소/실패",
  cancelled: "⏱ 장시간 미체결 자동취소",
  oco_failed: "⚠️ 보호주문 등록 실패",
  dryrun: "🧪 드라이런(연습)",
};

/** [v0.56.0] "서버 로그" 탭 카테고리 토글 순서 + 아이콘. */
const JOURNAL_CATEGORIES: JournalCategory[] = ["주문", "인증", "동기화", "자동매매", "시스템", "오류"];
const JOURNAL_CATEGORY_ICON: Record<JournalCategory, string> = {
  주문: "🧾", 인증: "🔐", 동기화: "☁️", 자동매매: "🤖", 시스템: "⚙️", 오류: "⚠️",
};

/**
 * [v0.2.6 입력 버그 수정] 숫자 입력 공통 처리.
 *
 * [무엇이 문제였나?]
 *  1) <input type="number"> 는 오른쪽에 위아래 화살표(스피너)를 띄우는데, 필드에 포커스를 둔 채
 *     마우스 휠을 굴리면 step 단위로 값이 제멋대로 바뀐다. step=0.0001 이었으므로 휠 4번이면
 *     0.0004 가 입력된다 — 오너 화면에 찍힌 그 값이다.
 *  2) 매 키입력마다 Number(...)로 바꿔 저장하면 "11." 같은 "입력 도중" 값이 11 로 뭉개져
 *     소수점을 찍을 수 없고, 다 지우면 0/1 이 박혀 지워지지도 않는다.
 *
 * [해결] 입력 중에는 "문자열 그대로" 담아두고(변환·보정 금지), 계산/주문 시점에만 숫자로 바꾼다.
 *   입력창은 type="text" + inputMode="decimal" 이라 스피너가 없고 휠로 값이 변하지 않는다.
 */
function isNumericDraft(v: string): boolean {
  // 빈칸, "-", "1.", ".5", "11.33" 처럼 "입력 도중" 형태를 모두 허용한다(마지막에 검증).
  return v === "" || /^-?\d*\.?\d*$/.test(v);
}

/** 문자열 입력값 → 숫자. 유효하지 않으면 null(계산/주문에서 안내 문구로 처리). */
function toNum(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * [v0.2.10] 매매 근거 한 줄 문장 만들기.
 *   예) "삼분할 2분할 · 전봉종가 $12.30 / EMA200 $11.10 · 진입 $11.90 · 익절 $12.14(+2%) · 손절 $10.71(-10%) · 3주"
 *   기법마다 보여줄 재료가 다르므로 있는 값만 골라 이어 붙인다.
 */
function rationaleLine(r: TradeRationale): string {
  const p: string[] = [];
  // [v0.30.0] 오너 요청 — 자동매매로 낸 주문은 근거 설명에도 식별 표시를 남긴다.
  if (r.source === "auto") p.push("🤖 자동매매");
  const t = TECH_LABEL[r.technique] ?? r.technique;
  p.push(r.technique === "split3" && r.level ? `${t.replace(/\s*\(.*\)/, "")} ${r.level}분할` : t.replace(/\s*\(.*\)/, ""));
  if (r.baseClose != null) p.push(`전봉종가 $${r.baseClose}`);
  if (r.ema200 != null) p.push(`EMA200 $${r.ema200}`);
  if (r.wallPrice != null) p.push(`매수벽 $${r.wallPrice}`);
  if (r.barOpen != null) p.push(`현재봉 시가 $${r.barOpen}`);
  if (r.entry) p.push(`진입 $${r.entry}`);
  if (r.tp) p.push(`익절 $${r.tp}${r.tpPct != null ? `(+${r.tpPct}%)` : ""}`);
  if (r.sl) p.push(`손절 $${r.sl}${r.slPct != null ? `(-${r.slPct}%)` : ""}`);
  p.push(`${r.quantity}주`);
  if (r.priceAtOrder != null) p.push(`당시가 $${r.priceAtOrder}`);
  return p.join(" · ");
}

/**
 * [v0.2.10] 통화에 맞는 금액 표기.
 *   실계좌에는 국내 종목(원화)도 섞여 있다. 원화 종목을 "$45,550"처럼 찍으면 금액을 완전히
 *   오해하게 되므로, 통화가 USD가 아니면 ₩로 표기하고 환산도 하지 않는다.
 */
function money(v: number | null, currency: string, fxRate: number | null): string {
  if (v == null) return "-";
  if (currency !== "USD") return `₩${Math.round(v).toLocaleString()}`;
  return usdKrw(v, fxRate);
}

/** 손익 % 를 색과 함께 보여주기 위한 클래스 이름(수익=초록, 손실=빨강) */
function pnlClass(v: number | null): string {
  if (v == null) return "";
  return v > 0 ? "pnl-up" : v < 0 ? "pnl-down" : "";
}

/** [v0.7.0] 체결강도 값 색상(100 기준). null(매수 일방)은 주황. */
function strClass(v: number | null | undefined): string {
  if (v == null) return "str-oneway";
  return v >= 100 ? "ok" : "danger";
}
/** 체결강도 값 표시. null(매도0=매수 일방)이면 ∞, 없으면 —. */
/** [v0.19.0] 보유기간(분)을 사람 말로: "45분" / "2시간 15분" / "3일 2시간". */
function fmtHoldMin(min: number): string {
  if (!Number.isFinite(min) || min < 0) return "—";
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h}시간 ${m}분` : `${h}시간`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}일 ${rh}시간` : `${d}일`;
}

/** [v0.49.0] Raw Data 탭 "CSV로 내보내기" — 문자열을 브라우저 표준 방식(Blob + 임시 <a> 클릭)으로
 *  이 기기에 저장한다. 서버로 아무것도 보내지 않는다 — 전부 오너 PC 안에서 끝난다. 맨 앞의
 *  BOM(﻿)은 엑셀에서 한글이 깨져 보이는 걸 막기 위한 것(엑셀은 BOM 없는 UTF-8 CSV를 종종
 *  다른 인코딩으로 오해한다). */
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** [v0.29.0] 밀리초 → "N분 N초"(자동 스크리너 탭의 "다음 스캔까지" 카운트다운 표시용). */
function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return `${m}분 ${String(s).padStart(2, "0")}초`;
}

/** [v0.3.3] 달러 금액 + (원화) 병기 — holdings가 준 실제 원화값이 있으면 그걸 쓰고, 없으면 fx로 환산 안 함. */
function dollarWon(usd: number | null, krw: number | null): string {
  if (usd == null && krw == null) return "—";
  const d = usd != null ? `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "";
  const w = krw != null ? `₩${Math.round(krw).toLocaleString()}` : "";
  return d && w ? `${d} (${w})` : d || w;
}

/** ISO 시각을 'MM-DD HH:mm'로 짧게. 파싱 실패하면 앞부분만. */
function fmtTime(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso.slice(0, 16);
}

/** 일반주문 상태(우리 표준 소문자)를 한국어로. */
function orderStatusKo(std: string, raw: string | null): string {
  const map: Record<string, string> = { submitted: "대기", partial: "일부체결", filled: "체결", cancelled: "취소·만료", failed: "거부", unknown: raw ?? "알수없음" };
  return map[std] ?? (raw ?? std);
}
/** 조건주문 그룹 상태 한국어. */
function condStatusKo(st: string | null): string {
  return st === "WATCHING" ? "감시중" : st === "COMPLETED" ? "완료" : (st ?? "—");
}
/** 조건주문 종류(OTO/OCO)를 초보용 한국어 라벨로. 영어 약어를 화면에 그대로 노출하지 않기 위함. */
function condTypeKo(type: string | null): string {
  return type === "OTO" ? "매수+익절" : type === "OCO" ? "익절+손절" : (type ?? "조건주문");
}
/** 조건주문 다리(leg) 상태 한국어 + 배지 색 클래스. */
function legStatusKo(st: string | null): string {
  return st === "WATCHING" ? "감시중" : st === "HOLDING" ? "대기" : st === "COMPLETED" ? "완료" : (st ?? "—");
}
function legBadge(st: string | null): string {
  return st === "WATCHING" ? "st-submitted" : st === "COMPLETED" ? "st-filled" : "st-hold";
}

/** 가격을 유효 틱으로 절삭($1↑ 2자리 / $1↓ 4자리). lib/calc.ts와 동일 규칙. */
function roundPrice(p: number): number {
  const s = p >= 1 ? 100 : 10000;
  return Math.floor(p * s + 1e-6) / s;
}

/** 달러 → "$x (₩y)" 병기 문자열. 환율 없으면 $만. */
function usdKrw(usd: number, fx: number | null): string {
  const dollar = `$${usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (!fx) return dollar;
  return `${dollar} (₩${Math.round(usd * fx).toLocaleString()})`;
}

/**
 * [v0.12.0 · 2단계] StrengthChart — 가격과 체결강도를 '겹쳐(위아래로)' 그려 다이버전스를 눈으로 보게 한다.
 *   정본(체결강도_분석 3장)의 그림을 그대로: 위=가격선, 아래=강도선(100 기준). 외부 라이브러리 0.
 *   마지막 점에 신호 마커: ▲(초록)=진입(바닥반전/다이버전스), ▼(빨강)=익절(정점꺾임).
 * [v0.27.0 고도화] 축 숫자 라벨·옅은 그리드라인 추가, 범례를 칩으로, 컨테이너 폭에 맞춰
 *   찌그러짐 없이 스케일(고정 height 대신 CSS aspect-ratio), 호버 시 그 시점 값 툴팁.
 */
function StrengthChart({ samples, signals }: { samples: StrengthSample[]; signals?: StrengthSignals }) {
  const W = 640, H = 170, PAD = 8, LBLW = 34; // LBLW: 오른쪽 축 숫자 라벨 공간
  const priceH = 62; //   위 패널(가격) 높이
  const gap = 14; //      두 패널 사이 라벨 공간
  const strTop = priceH + gap; //  아래 패널(강도) 시작 y
  const strH = H - strTop - PAD; // 아래 패널 높이
  const plotR = W - PAD - LBLW; // 그래프 오른쪽 끝(라벨 공간 제외)
  const n = samples.length;
  const strengths = samples.map((s) => s.strength).filter((v): v is number => v != null);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  if (n < 2 || strengths.length < 2) return null;
  const x = (i: number) => PAD + (i / (n - 1)) * (plotR - PAD);

  // 위 패널: 가격(있는 점만). 자기 범위로 정규화.
  const prices = samples.map((s) => s.price).filter((v): v is number => v != null);
  const pLo = prices.length ? Math.min(...prices) : 0;
  const pHi = prices.length ? Math.max(...prices) : 1;
  const pSpan = Math.max(pHi - pLo, 1e-9);
  const py = (v: number) => PAD + (1 - (v - pLo) / pSpan) * (priceH - PAD);
  let dp = "", penP = false;
  samples.forEach((s, i) => {
    if (s.price == null) { penP = false; return; }
    dp += `${penP ? "L" : "M"} ${x(i).toFixed(1)} ${py(s.price).toFixed(1)} `;
    penP = true;
  });

  // 아래 패널: 강도(100 기준선 포함 범위).
  const sLo = Math.min(100, ...strengths), sHi = Math.max(100, ...strengths);
  const sSpan = Math.max(sHi - sLo, 10);
  const sy = (v: number) => strTop + (1 - (v - sLo) / sSpan) * strH;
  let ds = "", penS = false;
  let lastX = 0, lastY = 0, lastV: number | null = null;
  samples.forEach((s, i) => {
    if (s.strength == null) { penS = false; return; }
    ds += `${penS ? "L" : "M"} ${x(i).toFixed(1)} ${sy(s.strength).toFixed(1)} `;
    penS = true; lastX = x(i); lastY = sy(s.strength); lastV = s.strength;
  });
  const y100 = sy(100);

  // 신호 마커(마지막 강도 점 위/아래). [B리뷰 #4] phase 우선순위로 구동 → ▲와 ▼가 동시에 찍히지 않는다.
  const up = signals?.phase === "진입";
  const down = signals?.phase === "익절";

  // [v0.27.0] 호버: svg 위 마우스 x좌표(뷰박스 단위)로 가장 가까운 샘플을 찾는다.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - vx); if (d < bestDist) { bestDist = d; best = i; } }
    setHover({ i: best, x: x(best) });
  };
  const hoverSample = hover ? samples[hover.i] : null;

  return (
    <div className="chart-wrap-rel">
      <svg
        className="str-chart" viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet"
        style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="가격·체결강도 겹쳐보기"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      >
        {/* [v0.27.0] 옅은 그리드라인(recessive — 데이터보다 눈에 덜 띄게) */}
        <line x1={PAD} y1={PAD} x2={plotR} y2={PAD} stroke="var(--chart-grid)" />
        <line x1={PAD} y1={priceH} x2={plotR} y2={priceH} stroke="var(--chart-grid)" />
        <line x1={PAD} y1={strTop} x2={plotR} y2={strTop} stroke="var(--chart-grid)" />
        <line x1={PAD} y1={H - PAD} x2={plotR} y2={H - PAD} stroke="var(--chart-grid)" />
        {/* 패널 라벨 + y축 숫자(최소·최대) */}
        <text x={PAD} y={12} fontSize="10" fill="currentColor" fillOpacity="0.55">가격</text>
        <text x={plotR + 4} y={PAD + 8} fontSize="9" fill="var(--chart-axis)">{pHi.toFixed(2)}</text>
        <text x={plotR + 4} y={priceH} fontSize="9" fill="var(--chart-axis)">{pLo.toFixed(2)}</text>
        <text x={PAD} y={strTop - 3} fontSize="10" fill="currentColor" fillOpacity="0.55">체결강도 (100 기준)</text>
        <text x={plotR + 4} y={strTop + 8} fontSize="9" fill="var(--chart-axis)">{sHi.toFixed(0)}</text>
        <text x={plotR + 4} y={H - PAD} fontSize="9" fill="var(--chart-axis)">{sLo.toFixed(0)}</text>
        {/* 가격선 */}
        <path d={dp.trim()} fill="none" stroke="#3987e5" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        {/* 강도 100 기준선 + 강도선 */}
        <line x1={PAD} y1={y100} x2={plotR} y2={y100} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="4 4" />
        <path d={ds.trim()} fill="none" stroke={lastV != null && lastV >= 100 ? "#34d399" : "#f87171"} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* 신호 마커 */}
        {up && lastV != null && (
          <g><circle cx={lastX} cy={lastY} r="4" fill="#34d399" /><text x={lastX} y={lastY - 8} fontSize="12" fill="#34d399" textAnchor="middle">▲</text></g>
        )}
        {down && lastV != null && (
          <g><circle cx={lastX} cy={lastY} r="4" fill="#f87171" /><text x={lastX} y={lastY + 16} fontSize="12" fill="#f87171" textAnchor="middle">▼</text></g>
        )}
        {/* [v0.27.0] 호버 크로스헤어(세로선 + 두 점) */}
        {hover && (
          <g>
            <line x1={hover.x} y1={PAD} x2={hover.x} y2={H - PAD} stroke="var(--chart-axis)" strokeDasharray="2 2" />
            {hoverSample?.price != null && <circle cx={hover.x} cy={py(hoverSample.price)} r="2.5" fill="#3987e5" />}
            {hoverSample?.strength != null && <circle cx={hover.x} cy={sy(hoverSample.strength)} r="2.5" fill={hoverSample.strength >= 100 ? "#34d399" : "#f87171"} />}
          </g>
        )}
      </svg>
      {hoverSample && (
        <div className="chart-tooltip" style={{ left: `${(hover!.x / W) * 100}%`, top: 0 }}>
          {hoverSample.ts} · {hoverSample.price != null ? `$${hoverSample.price.toFixed(2)}` : "가격 —"} ·
          {" "}강도 {hoverSample.strength != null ? hoverSample.strength.toFixed(1) : "—"}
        </div>
      )}
      <div className="chart-legend">
        <span className="chart-chip"><span className="swatch" style={{ background: "#3987e5" }} />가격</span>
        <span className="chart-chip"><span className="swatch" style={{ background: "#34d399" }} />강도(매수우세, ≥100)</span>
        <span className="chart-chip"><span className="swatch" style={{ background: "#f87171" }} />강도(매도우세, &lt;100)</span>
      </div>
    </div>
  );
}

/** [v0.12.0] 국면 배지 색/문구. */
function phaseBadge(phase: StrengthSignals["phase"]): { txt: string; cls: string } {
  switch (phase) {
    case "진입": return { txt: "🟢 진입 신호(바닥반전)", cls: "ok" };
    case "익절": return { txt: "🔴 익절 신호(정점꺾임)", cls: "danger" };
    case "보유": return { txt: "🔵 보유(매수 우세)", cls: "" };
    case "고점경고": return { txt: "🟠 고점 경고(꺾임 주의)", cls: "warn-txt" };
    case "하락중": return { txt: "⚪ 하락 중(대기)", cls: "" };
    default: return { txt: "· 중립/표본 부족", cls: "hint" };
  }
}

/**
 * [v0.6.1→v0.45.0] ScreenEvidenceView — 스크리너 판정 근거(펼침).
 *   기준 도지 캔들·다음 봉(하이킨아시 OHLC), 세션 최고점, 필터 통과/실패를 사람이 눈으로
 *   검증할 수 있게 보여준다. "이 도지를 기준으로 잡았고 다음 음봉이 이거"를 확인하는 화면.
 *
 *   [v0.45.0 버그 수정 — 오너 보고 "구름대 필터를 꺼도 근거에 구름대가 그대로 남아있음"]
 *   엔진(scanScreener)은 EMA·구름·도지신선도·다음봉확인 조건을 꺼도(오너가 "스크리닝 기준"
 *   탭에서 끔) 그 실제 지표값(위인지 아닌지)은 항상 정직하게 계산해 evidence에 담아준다
 *   (판정에는 안 쓰지만 참고용으로는 여전히 유용하다는 설계 — 값 자체는 버그가 아니다). 문제는
 *   화면이 이 칩들을 전부 "지금 판정에 쓰이는 합격/불합격 조건"처럼 초록/빨강으로 똑같이
 *   그려서, 꺼 둔 조건인지 켜진 조건인지 구분이 안 갔다는 것 — 오너 눈엔 "꺼도 여전히 걸리는
 *   것처럼" 보였다. 이제 disabled로 넘긴 항목은 회색 "off" 칩으로 구분해, 값은 그대로 보여주되
 *   "지금 이건 판정에 안 쓰입니다"가 한눈에 보이게 한다.
 */
function ScreenEvidenceView({
  ev,
  price,
  disabled,
  metrics,
  defenseReasons,
}: {
  ev: ScreenEvidence;
  price: number | null;
  /** [v0.63.0] 진입 시점 측정값(이격도·ATR%·EMA 기울기)과 방어 필터 탈락 사유 */
  metrics?: EntryMetrics;
  defenseReasons?: string[];
  /** 오너가 꺼 둔 조건 키(스크리닝 기준 탭 기준) — 넘긴 키는 통과/실패와 무관하게 회색 "off" 칩으로. */
  disabled?: Partial<Record<"aboveEma" | "aboveCloud" | "recentDoji" | "dojiNearHigh" | "nextBearish", boolean>>;
}) {
  const chip = (ok: boolean, label: string, key?: keyof NonNullable<typeof disabled>) => {
    const isOff = key != null && disabled?.[key];
    return (
      <span className={`evid-chip ${isOff ? "off" : ok ? "pass" : "fail"}`}>
        {ok ? "✓" : "✗"} {label}{isOff && " (꺼짐·참고용)"}
      </span>
    );
  };
  const candleLine = (c: EvidenceCandle | null) =>
    c ? `${c.time} · 시$${c.open} 고$${c.high} 저$${c.low} 종$${c.close} · ${c.bearish ? "음봉 ▼" : "양봉 ▲"}` : "(아직 없음)";
  return (
    <div className="evid-box">
      <div className="evid-note">※ 하이킨아시(平均足) 캔들 기준 · <b>완성된(마감된) 5분봉만 판정</b>(형성 중 봉 제외) · 시각 KST</div>
      <div className="evid-filters">
        {chip(ev.filters.priceBand, "현재가 $1~9")}
        {chip(ev.filters.aboveEma, "현재가>EMA200", "aboveEma")}
        {chip(ev.filters.aboveCloud, "현재가>구름top", "aboveCloud")}
        {chip(ev.filters.firstDoji, "최고점 후 첫 음봉 도지")}
        {chip(ev.filters.bothWicks, "위·아래 꼬리 둘 다(망치형 아님)")}
        {chip(ev.filters.recentDoji, "도지 발생 20분 이내", "recentDoji")}
        {chip(ev.filters.dojiNearHigh ?? true, "도지가 최고점 직후(간격 한도 이내)", "dojiNearHigh")}
        {chip(ev.filters.nextBearish, "다음 봉도 음봉", "nextBearish")}
      </div>
      <table className="evid-table">
        <tbody>
          <tr><td>현재가</td><td>{price != null ? `$${price}` : "—"}</td></tr>
          {metrics && (
            <tr>
              <td>방어 지표</td>
              <td>
                EMA 이격도(전봉종가) {metrics.emaGapPct != null ? `${metrics.emaGapPct}%` : "—"} ·
                {" "}변동성(5분봉 ATR) {metrics.atrPct != null ? `${metrics.atrPct}%` : "—"} ·
                {" "}EMA 1시간 변화 {metrics.emaSlopePct != null ? `${metrics.emaSlopePct > 0 ? "+" : ""}${metrics.emaSlopePct}%` : "—"}
                {defenseReasons && defenseReasons.length > 0 && <span className="err"> · ✗ {defenseReasons.join(" / ")}</span>}
              </td>
            </tr>
          )}
          <tr><td>현재 장 시작</td><td>{ev.sessionStart}</td></tr>
          <tr><td>세션 최고점(HA)</td><td>{ev.sessionHigh != null ? `$${ev.sessionHigh}${ev.sessionHighTime ? ` @ ${ev.sessionHighTime}` : ""}` : "—"}</td></tr>
          <tr>
            <td>기준 음봉 도지</td>
            <td>
              {candleLine(ev.doji)}
              {ev.doji?.bodyRatio != null && <span className="hint"> · 몸통 {(ev.doji.bodyRatio * 100).toFixed(1)}%</span>}
              {ev.doji?.upperWickPct != null && <span className="hint"> · 윗꼬리 {(ev.doji.upperWickPct * 100).toFixed(1)}%</span>}
              {ev.doji?.lowerWickPct != null && <span className="hint"> · 아래꼬리 {(ev.doji.lowerWickPct * 100).toFixed(1)}%</span>}
            </td>
          </tr>
          <tr><td>도지 다음 봉</td><td>{candleLine(ev.next)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * [v0.25.0] ScreenCandleChart — 탐색 결과 종목의 차트(하이킨아시 캔들 + EMA200·구름top·세션고점 겹쳐보기).
 *   외부 차트 라이브러리 없이 SVG로 직접 그린다(StrengthChart와 같은 방식). 표에서 본 근거(도지·다음봉)를
 *   차트 위에 노란/보라 테두리로 표시해 "이게 그 캔들이구나"를 눈으로 바로 확인할 수 있다.
 */
/**
 * [v0.25.0] ScreenCandleChart — 스크리너 결과 종목의 캔들차트(도지·EMA200·구름·세션고점 표시).
 * [v0.27.0 고도화] 가격 축 숫자·시간 축 라벨·옅은 그리드라인 추가, 범례를 칩으로, 컨테이너 폭에
 *   맞춰 찌그러짐 없이 스케일, 호버 시 그 봉의 OHLC 툴팁.
 *   [색상 정리] 예전엔 세션고점 참조선과 도지 강조 테두리가 똑같은 노란색(#facc15)을 써서 서로
 *   구분이 안 됐다. 참조선 3개(세션고점·EMA200·구름top)는 dataviz 팔레트의 검증된 카테고리컬
 *   3색(청록·파랑·주황, validate_palette.js --surface #0f131a --mode dark 통과)으로 고정 배정하고,
 *   도지·다음봉 강조는 그 3색과 절대 안 겹치는 별도 색(--chart-highlight, 중립 밝은색) 하나를
 *   "실선(도지)/파선(다음봉)"이라는 선모양(형태 채널)으로 구분한다 — 4번째 색을 더 쓰면
 *   참조선과의 전 쌍(all-pairs) 구분 검증이 깨진다는 게 팔레트 문서의 명시적 경고라, 색을
 *   늘리는 대신 형태로 구분했다.
 */
function ScreenCandleChart({ chart }: { chart: ScreenChart }) {
  const W = 640, H = 220, PAD = 10, LBLW = 40;
  const n = chart.candles.length;
  const [hover, setHover] = useState<number | null>(null);
  if (n === 0) return <div className="hint">표시할 캔들이 없습니다(데이터 부족).</div>;

  const highs = chart.candles.map((c) => c.high);
  const lows = chart.candles.map((c) => c.low);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  // 기준선(EMA200·구름top·세션고점)이 캔들 범위 밖이어도 잘리지 않게 범위에 포함시킨다.
  for (const v of [chart.ema200, chart.cloudTop, chart.sessionHigh]) {
    if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  const span = Math.max(hi - lo, 1e-9);
  const plotR = W - PAD - LBLW;
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const slot = (plotR - PAD) / n;
  const cx = (i: number) => PAD + slot * (i + 0.5);
  const bodyW = Math.max(1.5, slot * 0.6);
  const refLine = (v: number | null) => (v != null ? y(v) : null);
  const highY = refLine(chart.sessionHigh);
  const emaY = refLine(chart.ema200);
  const cloudY = refLine(chart.cloudTop);

  // [v0.27.0] 시간축 라벨: 봉이 많으면 다 못 넣으니 최대 4개만 고르게 뽑는다.
  const tickCount = Math.min(4, n);
  const tickIdx = Array.from({ length: tickCount }, (_, k) => Math.round((k / Math.max(1, tickCount - 1)) * (n - 1)));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.min(n - 1, Math.max(0, Math.round((vx - PAD) / slot - 0.5)));
    setHover(i);
  };
  const hc = hover != null ? chart.candles[hover] : null;

  return (
    <div className="screen-chart-wrap chart-wrap-rel">
      <svg
        className="screen-chart" viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet"
        style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label={`${chart.symbol} 캔들차트`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      >
        {/* 옅은 가격 그리드라인(recessive) + y축 숫자(최고·최저) */}
        <line x1={PAD} y1={PAD} x2={plotR} y2={PAD} stroke="var(--chart-grid)" />
        <line x1={PAD} y1={H / 2} x2={plotR} y2={H / 2} stroke="var(--chart-grid)" />
        <line x1={PAD} y1={H - PAD} x2={plotR} y2={H - PAD} stroke="var(--chart-grid)" />
        <text x={plotR + 4} y={PAD + 8} fontSize="9" fill="var(--chart-axis)">${hi.toFixed(2)}</text>
        <text x={plotR + 4} y={H - PAD} fontSize="9" fill="var(--chart-axis)">${lo.toFixed(2)}</text>
        {/* 시간축 라벨 */}
        {tickIdx.map((i) => (
          <text key={i} x={cx(i)} y={H - 1} fontSize="9" fill="var(--chart-axis)" textAnchor="middle">{chart.candles[i].time}</text>
        ))}
        {/* 참조선 3개 — 검증된 카테고리컬 3색 고정 배정(청록·파랑·주황) */}
        {highY != null && <line x1={PAD} y1={highY} x2={plotR} y2={highY} stroke="var(--chart-ref-3)" strokeDasharray="3 3" strokeOpacity="0.9" />}
        {emaY != null && <line x1={PAD} y1={emaY} x2={plotR} y2={emaY} stroke="var(--chart-ref-1)" strokeDasharray="5 3" strokeOpacity="0.9" />}
        {cloudY != null && <line x1={PAD} y1={cloudY} x2={plotR} y2={cloudY} stroke="var(--chart-ref-2)" strokeDasharray="5 3" strokeOpacity="0.9" />}
        {chart.candles.map((c, i) => {
          const up = c.close >= c.open;
          const color = up ? "#34d399" : "#f87171";
          const isDoji = c.time === chart.dojiTime;
          const isNext = c.time === chart.nextTime;
          const bodyTop = Math.min(y(c.open), y(c.close));
          const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
          return (
            <g key={`${c.time}-${i}`}>
              <line x1={cx(i)} y1={y(c.high)} x2={cx(i)} y2={y(c.low)} stroke={color} strokeWidth="1" />
              <rect
                x={cx(i) - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyH}
                fill={color}
                stroke={isDoji || isNext ? "var(--chart-highlight)" : "none"}
                strokeWidth={isDoji || isNext ? 2 : 0}
                strokeDasharray={isNext ? "3 2" : undefined}
              />
              {/* [형태 채널] 도지=◆, 다음봉=▸ — 색이 같아도 모양으로 구분(범례에 뜻풀이) */}
              {isDoji && <text x={cx(i)} y={bodyTop - 5} fontSize="9" fill="var(--chart-highlight)" textAnchor="middle">◆</text>}
              {isNext && <text x={cx(i)} y={bodyTop - 5} fontSize="9" fill="var(--chart-highlight)" textAnchor="middle">▸</text>}
              {hover === i && <rect x={cx(i) - slot / 2} y={PAD} width={slot} height={H - 2 * PAD} fill="var(--chart-axis)" fillOpacity="0.08" />}
            </g>
          );
        })}
      </svg>
      {hc && (
        <div className="chart-tooltip" style={{ left: `${(cx(hover!) / W) * 100}%`, top: 0 }}>
          {hc.time} · 시 ${hc.open.toFixed(2)} 고 ${hc.high.toFixed(2)} 저 ${hc.low.toFixed(2)} 종 ${hc.close.toFixed(2)}
        </div>
      )}
      <div className="chart-legend">
        <span className="hint small">현재가 {chart.price != null ? `$${chart.price.toFixed(2)}` : "—"}</span>
        {chart.sessionHigh != null && (
          <span className="chart-chip"><span className="swatch" style={{ background: "var(--chart-ref-3)" }} />세션고점 ${chart.sessionHigh.toFixed(2)}{chart.sessionHighTime ? ` @${chart.sessionHighTime}` : ""}</span>
        )}
        {chart.ema200 != null && (
          <span className="chart-chip"><span className="swatch" style={{ background: "var(--chart-ref-1)" }} />EMA200 ${chart.ema200.toFixed(2)}</span>
        )}
        {chart.cloudTop != null && (
          <span className="chart-chip"><span className="swatch" style={{ background: "var(--chart-ref-2)" }} />구름top ${chart.cloudTop.toFixed(2)}</span>
        )}
        {chart.dojiTime && <span className="chart-chip">◆ 도지 {chart.dojiTime}</span>}
        {chart.nextTime && <span className="chart-chip">▸ 다음봉 {chart.nextTime}</span>}
        {!chart.dojiTime && <span className="hint small">아직 도지 없음</span>}
      </div>
    </div>
  );
}

/** 조건주문 만료일 기본값: (KST 기준) 오늘 + 30일.
 *   [주의] toISOString()은 UTC라, KST 새벽(00~09시)엔 하루 이르게 찍힌다.
 *   그래서 KST 오프셋(+9h)을 더한 뒤 날짜를 뽑아 KST 날짜와 일치시킨다. */
function defaultExpire(): string {
  const kstMs = Date.now() + 9 * 3600_000 + 30 * 86400_000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

// 주문 확인 팝업에 담기는 내용(무엇을 전송할지 사람이 최종 확인)
interface PendingOrder {
  kind: "entry" | "oco" | "oto" | "bracket";
  title: string;
  lines: string[];
  send: () => Promise<JournalEntry>;
}

function App() {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [tab, setTab] = useState<TabId>("calc");
  /** 웹앱(폰)인가? — 데스크톱에만 있는 '폰 연결' 기능 유무로 구분한다 */
  const isWebApp = !window.kyletool.phoneStart;
  /** [v0.60.5 — 오너 실사용 보고 "감시 중 포지션에 '폰 연결이 안 돼 있습니다' 경고가 84회
   *  연속으로 쌓임"] 웹(폰)에서 QR 중계 연결이 안 돼 있으면 토스를 직접 호출하는 어떤
   *  폴링도(reconcileAutoPositionsNow 등) 절대 성공할 수 없는데, 예전엔 이 사실을 모르고
   *  20초마다 계속 시도해 실패만 쌓았다. 데스크톱(메서드 자체가 없음)이면 항상 true로
   *  간주해 기존 동작을 그대로 둔다. */
  const [hasTossRelay, setHasTossRelay] = useState(true);
  useEffect(() => {
    if (!isWebApp) return; // 데스크톱은 항상 true(기본값 유지) — 확인할 필요 없음
    void window.kyletool.hasTossRelay?.().then(setHasTossRelay).catch(() => setHasTossRelay(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 지금 이 세션이 토스를 직접(실시간) 호출해도 되는가 — 데스크톱은 항상, 웹은 중계 연결됐을 때만. */
  const canReconcileLive = !isWebApp || hasTossRelay;
  // [v0.9.2] 탭 순서(드래그로 변경, 이 기기에 저장)
  // [v0.27.0] 이제 드래그로 순서를 바꾸는 건 '그룹'(4개) — 리프 탭은 그룹 안에서 고정 순서.
  const { order: groupOrder, dragProps, isDragging } = useTabOrder(TOP_GROUPS);
  // [v0.9.1] 매매 리포트 + [v0.9.2] 기간 선택(오늘/1주일/1개월/날짜)
  const [report, setReport] = useState<DailyReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<PeriodKind>("today");
  const [reportDate, setReportDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  // [폰에서 쓰기] 집 PC 릴레이 + 터널 상태(데스크톱 앱에서만 동작 — 웹앱에는 이 기능이 없다)
  const [phone, setPhone] = useState<PhoneState | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  useEffect(() => {
    if (!window.kyletool.phoneStatus) return; // 웹앱에서는 이 기능이 없다
    void window.kyletool.phoneStatus().then(setPhone);
    return window.kyletool.onPhoneState?.(setPhone);
  }, []);

  /** [v0.9.1] 오늘의 리포트 불러오기(탭을 열 때마다 새로 계산 — 늘 최신) */
  const loadReport = useCallback(
    async (kind: PeriodKind = reportPeriod, picked: string = reportDate) => {
      setReportBusy(true);
      try {
        setReport(await window.kyletool.report(kind, picked));
      } catch (e) {
        console.error("리포트 조회 실패", e);
      } finally {
        setReportBusy(false);
      }
    },
    [reportPeriod, reportDate],
  );
  useEffect(() => {
    if (tab === "report") void loadReport();
  }, [tab, loadReport]);

  /** 기간 버튼/달력을 눌렀을 때 — 상태를 바꾸고 즉시 다시 집계한다 */
  function changeReportPeriod(kind: PeriodKind, picked?: string): void {
    setReportPeriod(kind);
    if (picked) setReportDate(picked);
    void loadReport(kind, picked ?? reportDate);
  }
  // [v0.7.0] 체결강도 자동 기록(매매 연동) — 트레이드 목록 + 요약.
  // [v0.19.0] 실제 체결이력 기반 매매 사이클 자동추적·분석
  const [analysis, setAnalysis] = useState<{ cycles: TradeCycle[]; insights: TradeInsights; source: "live" | "cache" | "none" } | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  // [v0.6.0] 종목 스크리너(탐색). 결과·진행률·스캔중 여부·도지 몸통비율 슬라이더.
  const [screenRun, setScreenRun] = useState<ScreenRun | null>(null);
  // [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST) — 켜져 있으면 배너로 항상 보여준다(탭 무관).
  const [systemPause, setSystemPause] = useState<{ paused: boolean; reason: string | null; resumesAtMs: number | null } | null>(null);
  // [v0.59.0] 폰 원격 조종 — PC 생존 신호(마지막으로 본 시각) + 최근 보낸 명령 목록.
  const [pcLastSeenMs, setPcLastSeenMs] = useState<number | null>(null);
  // [v0.60.4] PC가 실제로 보낸 "지금 자동매매 켜져 있나" — 폰(web)에서는 이 값이 진실.
  const [pcAutoTradeEnabled, setPcAutoTradeEnabled] = useState<boolean | null>(null);
  // [v0.61.2 — ② 전수조사에서 발견한 치명 버그 수정] PC가 실제로 보낸 "지금 비상 정지 중인가" —
  //   예전엔 상단 "🛑 비상 정지" 버튼이 웹(폰)에서도 로컬(의미 없는) 상태만 켜고 꺼서, 눌러도
  //   PC의 실제 매매는 전혀 안 멈추는데 화면만 "🔴 비상 정지 중"으로 바뀌는 게 가장 위험한
  //   종류의 거짓 안도감이었다. capri_live_state 미러로 PC의 진짜 값을 받는다.
  const [pcKillSwitch, setPcKillSwitch] = useState<boolean | null>(null);
  // [v0.61.4 — 오너 지시 "스크리닝시 진행되는 사항들 게이지가 차는 사항이 안 보인다"] PC가 지금
  //   스캔 중인지 + 진행률(상태 미러로 받음). canReconcileLive가 true인 세션(데스크톱·QR중계된
  //   폰)은 이미 로컬 이벤트(onScreenerProgress → autoScanProg)로 실시간 게이지가 뜨므로, 이
  //   필드는 그게 안 되는 "폰, 중계 없음" 세션 전용으로 쓴다(렌더링에서 분기).
  const [pcScanProgress, setPcScanProgress] = useState<LiveScanProgress | null>(null);
  // [v0.60.9] PC가 보낸 "지금 실행 중인 버전" — "자동매매가 켜져 있으면 재시작 안 함"
  //   안전장치 때문에 PC가 몇 시간째 옛 버전을 그대로 돌릴 수 있다(오너 실사용 보고 —
  //   "폰에서 시작을 눌러도 자동 스크리너에 진행 상황이 안 뜬다"의 진짜 원인이 이거였다).
  //   폰 화면에서 PC 버전과 이 세션(appVer) 버전을 바로 비교할 수 있게 보여준다.
  const [pcAppVersion, setPcAppVersion] = useState<string | null>(null);
  // [v0.60.4] 웹(폰)에서 자동매매 시작/중지를 원격 명령으로 보냈을 때의 결과 메시지.
  const [autoToggleMsg, setAutoToggleMsg] = useState("");
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenProg, setScreenProg] = useState<ScreenProgress | null>(null);
  // [v0.43.0] 스크리닝 취소 버튼 — 요청을 보냈으면 협조적 취소가 실제로 멈출 때까지(screenBusy가
  //   꺼질 때까지) 버튼을 다시 못 누르게 막는다(중복 클릭 방지).
  const [scanCancelRequested, setScanCancelRequested] = useState(false);
  const [bodyRatio, setBodyRatio] = useState(0.3);
  // [v0.11.0] 스크리너 필터 사용자 조절 — 스캔 종목수·가격대(하한/상한). 문자열로 들고 입력 편의 유지.
  const [scanCount, setScanCount] = useState("60");
  const [priceMin, setPriceMin] = useState("1");
  const [priceMax, setPriceMax] = useState("9");
  const [showMiss, setShowMiss] = useState(false); // '아쉽게 탈락(근접)' 펼침 여부
  // [v0.47.0 — 오너 요청 "탈락 사유 전체 조회, 폴드 형식으로"] 자동 스크리너 탭에서 이번
  //   스캔에 검토된 전체 종목(확정/관찰뿐 아니라 탈락·데이터부족까지) 목록의 펼침 여부.
  //   종목 수가 많으면(최대 200개) 화면이 지저분해지므로 기본은 접힘.
  const [showAllAutoScanResults, setShowAllAutoScanResults] = useState(false);
  // [v0.14.0] 손익 색 관습: false=미국식(이익 초록/손실 빨강, 기본), true=한국식(이익 빨강/손실 파랑).
  //   화면 전용 취향이라 이 기기에만 저장(localStorage). CSS 토큰(data-pnl) 한 곳만 바꾸면 전체가 뒤집힌다.
  const [pnlKr, setPnlKr] = useState<boolean>(() => {
    try { return localStorage.getItem("capri-pnl") === "kr"; } catch { return false; }
  });
  // [v0.15.0] 데스크톱 2컬럼(두 탭 나란히). 폰/좁은 화면은 기존 단일 컬럼 그대로(회귀 금지).
  //   twoCol: 사용자 선택(이 기기 저장). isWide: 화면이 넓은가(≥1024). 둘 다 참일 때만 2컬럼 렌더.
  const [twoCol, setTwoCol] = useState<boolean>(() => { try { return localStorage.getItem("capri-twocol") === "1"; } catch { return false; } });
  // 넓은 화면 판정은 matchMedia(레이아웃 뷰포트 기준)로 — innerWidth 보다 견고.
  const [isWide, setIsWide] = useState<boolean>(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)").matches : false));
  const [tabL, setTabL] = useState<TabId>("calc"); //   왼쪽 패널 탭
  const [tabR, setTabR] = useState<TabId>("strength"); // 오른쪽 패널 탭(기본: 신호 보며 매매)
  const showTwoCol = twoCol && isWide;
  // [v0.65.0] 매매연구소 탭이 화면에 떠 있을 때만(1컬럼은 현재 탭, 2컬럼은 좌/우 패널) 15초 자동 갱신을 돌린다.
  const [pcLab, setPcLab] = useState<LabMirror | null>(null); // [v0.65.0] PC의 매매연구소 요약(폰 표시용)
  const labTabIds: TabId[] = ["labResult", "labLive", "labSignals", "labCompare"];
  const labActive = labTabIds.some((t) => (showTwoCol ? tabL === t || tabR === t : tab === t));
  const lab = useLab(isWebApp, pcLab, labActive);
  const [openEvid, setOpenEvid] = useState<Set<string>>(new Set()); // 근거 펼친 종목들
  // [v0.25.0] 탐색 결과 종목의 차트 — 펼친 종목 집합 + 심볼별 캐시(재클릭 시 재조회 방지) + 로딩/에러.
  const [openChart, setOpenChart] = useState<Set<string>>(new Set());
  const [chartCache, setChartCache] = useState<Record<string, ScreenChart>>({});
  const [chartBusy, setChartBusy] = useState<Set<string>>(new Set());
  const [chartErr, setChartErr] = useState<Record<string, string>>({});
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  // [v0.56.0] "서버 로그" 탭 카테고리 토글 필터 — 빈 Set이면 "전체 보기"(필터 없음).
  const [journalCategoryFilter, setJournalCategoryFilter] = useState<Set<JournalCategory>>(new Set());
  // [v0.4.0] 내 삼분할 기록(여러 종목 동시 운용). 저장 목록 + 저장 시 메모 입력칸.
  const [splits, setSplits] = useState<SavedSplit[]>([]);
  const [splitMemo, setSplitMemo] = useState(""); // 계산기에서 [기록 저장] 누를 때 함께 남길 메모
  const [splitSaved, setSplitSaved] = useState(""); // 저장 직후 잠깐 뜨는 안내("저장됨 ✓")
  // [v0.5.1] 저장된 기록의 제목(메모) 인라인 편집 — 편집 중인 기록 id + 입력값.
  const [editSplitId, setEditSplitId] = useState<string | null>(null);
  const [editSplitText, setEditSplitText] = useState("");
  // [v0.5.0] 체결강도 기록. 대상 종목·간격 입력 + 현재 상태(현재값·시계열).
  const [strSym, setStrSym] = useState("AAPL"); //     현재 상세로 보는 종목(보유 목록에서 선택)
  const [strState, setStrState] = useState<StrengthState | null>(null); // 선택 종목의 실시간 상태
  // [v0.23.0] 보유 종목 체결강도 자동표시: 보유현황을 가져와 각 종목의 기록을 자동으로 켜고 보여준다.
  const [heldSyms, setHeldSyms] = useState<string[]>([]); //                보유 중인(달러) 종목들
  const [heldStates, setHeldStates] = useState<Record<string, StrengthState>>({}); // 종목별 최신 상태(목록 표시용)
  const [strLoading, setStrLoading] = useState(false); //                   보유현황 불러오는 중
  const [strErr, setStrErr] = useState<string | null>(null); //            연결/조회 오류(무음 실패 금지)
  const strFocusRef = useRef<string | null>(null); //  [리뷰 H2] '체결강도 보기'로 콕 집은 종목(2컬럼 이중호출에도 유실 방지)

  // --- 계산기 입력 상태 ---
  const [symbol, setSymbol] = useState("AAPL");
  const [curPrice, setCurPrice] = useState<number | null>(null);
  const [tech, setTech] = useState<Technique>("split3");
  const [tpPct, setTpPct] = useState("2"); // 문자열 보관(입력 중 뭉개짐 방지)
  const [slPct, setSlPct] = useState("10");
  const [qty, setQty] = useState("1");
  // 기법별 재료
  const [baseClose, setBaseClose] = useState("");
  const [ema200, setEma200] = useState("");
  const [wallPrice, setWallPrice] = useState("");
  const [barOpen, setBarOpen] = useState("");
  const [manualEntry, setManualEntry] = useState("");
  const [candleYang, setCandleYang] = useState(false); // 캔들: 전봉 양봉 확인 체크

  const [result, setResult] = useState<CalcResult | null>(null);
  const [calcErr, setCalcErr] = useState("");

  // --- 환율 ---
  const [fx, setFx] = useState<number | null>(null);
  const [fxSource, setFxSource] = useState<string | null>(null);
  const [manualFx, setManualFxInput] = useState("");
  const [fxFailed, setFxFailed] = useState(false);

  // --- 주문 확인 팝업 ---
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const [busy, setBusy] = useState(false);

  // --- 주문 현황(v0.3.3 토스 스타일) ---
  const [hold, setHold] = useState<{ summary: HoldingsSummary; items: HoldingRow[] } | null>(null);
  const [ordRows, setOrdRows] = useState<OrderRow[]>([]);
  const [condRows, setCondRows] = useState<CondOrderRow[]>([]);
  const [ordTab, setOrdTab] = useState<"all" | "normal" | "cond">("all"); // 필터: 전체/일반/조건
  const [ordStatus, setOrdStatus] = useState<"OPEN" | "CLOSED">("OPEN"); // 미체결/체결(종료)
  const [posBusy, setPosBusy] = useState(false);
  const [posAt, setPosAt] = useState<string>(""); // 마지막 갱신 시각(표시용)
  const [autoRefresh, setAutoRefresh] = useState(false); // 30초 자동 갱신 켜기/끄기
  // 매도 모달 / 근거 보기 모달
  const [sellModal, setSellModal] = useState<{ symbol: string; currency: string; heldQty: number; orderType: "LIMIT" | "MARKET"; qty: string; price: string } | null>(null);
  const [ratModal, setRatModal] = useState<TradeRationale | null>(null);
  // [v0.3.4] 카드별 "상세 펼침" 상태. id(종목/주문번호)를 담은 집합. 기본은 전부 접힘.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // --- 설정 ---
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [formMode, setFormMode] = useState<"mock" | "live">("mock");
  const [formId, setFormId] = useState("");
  const [formSecret, setFormSecret] = useState("");
  const [formAccount, setFormAccount] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [guardPct, setGuardPct] = useState("15"); // 오입력 방지 한도(사용자 지정)
  // [v0.24.0] 클라우드 동기화 상태 메시지 — 비밀번호는 로그인 비밀번호를 그대로 쓰므로 따로 안 둔다.
  const [syncMsg, setSyncMsg] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  // [v0.8.1] 로그인(멀티유저). 이메일/비번은 화면에서만, 서버 인증 후 세션은 엔진이 보관.
  const [authEmail, setAuthEmail] = useState("");
  const [authPw, setAuthPw] = useState("");
  const [authState, setAuthState] = useState<{
    email: string | null;
    loggedIn: boolean;
    isOwner: boolean;
    accountStatus: "pending" | "approved" | "rejected" | "unknown";
  }>({ email: null, loggedIn: false, isOwner: false, accountStatus: "unknown" });
  // [v0.59.0] 앱을 켜자마자 로그인 상태부터 확인하는 동안(첫 refreshAuth 완료 전) 보여줄 화면을
  //   가르는 값 — 이게 false인 동안은 로그인 화면도, 본 화면도 아닌 "확인 중" 화면만 보여줘서
  //   "이미 로그인된 사람에게 로그인 화면이 잠깐 번쩍였다 사라지는" 깜빡임을 막는다.
  const [authChecked, setAuthChecked] = useState(false);
  // [v0.59.0→v0.60.0] 소셜 로그인(구글만 — 카카오는 오너 요청으로 제거) 처리 중 표시.
  const [oauthBusy, setOauthBusy] = useState<"google" | null>(null);
  const [authMsg, setAuthMsg] = useState("");
  // [v0.24.0] 가입이 아직 승인 안 된 사람용 — "승인 요청 남기기" 버튼 노출 여부 + 처리 상태.
  const [canRequestAccess, setCanRequestAccess] = useState(false);
  const [reqBusy, setReqBusy] = useState(false);
  const [reqMsg, setReqMsg] = useState("");
  // [v0.24.0][운영자 전용] 대기 중인 가입 승인 요청 목록.
  const [accessRequests, setAccessRequests] = useState<Array<{ email: string; note: string | null; requestedAt: string }>>([]);
  const [reqActionBusy, setReqActionBusy] = useState<string | null>(null); // 처리 중인 이메일(버튼 개별 비활성용)
  // [v0.53.0 — 오너 요청 "내가 직접 허용 이메일을 등록할 수 있게"] 대기 목록에 없어도(요청이
  //   아예 안 남았거나, 미리 등록해 두고 싶을 때) 오너가 이메일을 바로 입력해 허용목록에
  //   추가할 수 있게 한다. approveAccessRequest()는 원래도 임의 이메일을 받아들이므로
  //   (대기 요청 존재 여부와 무관 — 있으면 그 요청도 함께 승인 처리됨), 새 엔진 함수 없이
  //   입력칸 하나만 더하면 된다.
  const [directAddEmail, setDirectAddEmail] = useState("");
  const [directAddBusy, setDirectAddBusy] = useState(false);
  const [directAddMsg, setDirectAddMsg] = useState("");
  // [v0.59.0][운영자 전용] 진짜 게이트(capri_accounts) 대기 계정 목록 — 가입은 항상 성공하고
  //   승인 전엔 여기 쌓인다(옛 capri_access_requests 대기 목록과는 별개).
  const [pendingAccounts, setPendingAccounts] = useState<Array<{ userId: string; email: string; requestedAt: string }>>([]);
  const [pendingActionBusy, setPendingActionBusy] = useState<string | null>(null); // 처리 중인 userId
  // [v0.59.0][운영자 전용] 디스코드 웹훅 알림 설정.
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [discordSaveBusy, setDiscordSaveBusy] = useState(false);
  const [discordMsg, setDiscordMsg] = useState("");
  // [v0.3.0] 세션별 시드 비율 설정 입력칸(설정 탭). 문자열 보관(입력 중 뭉개짐 방지).
  // [v0.8.3] 기본 손익비 설정 입력칸(설정 탭). 공장값 2/10, 저장하면 계산기 초기값이 됨.
  const [defForm, setDefForm] = useState<{ tp: string; sl: string }>({ tp: "2", sl: "10" });
  const [seedForm, setSeedForm] = useState<{ day: string; pre: string; regular: string; basis: "auto" | "fixed"; fixed: string }>({
    day: "90",
    pre: "50",
    regular: "50",
    basis: "auto",
    fixed: "",
  });
  // [v0.26.0] 자동매매 한도 입력칸(설정 탭) + 현재 현황(켜짐 여부·포지션·누적손익).
  const [autoForm, setAutoForm] = useState<{ maxPositions: string; maxLossPct: string; maxInvestPct: string; watchMinutes: string }>({
    maxPositions: "3",
    maxLossPct: "5",
    maxInvestPct: "30",
    watchMinutes: "10", // [v0.42.0] 장기간 미체결 자동취소 기준(분) — 기존 하드코딩값과 동일한 기본값
  });
  // [v0.61.8 — 오너 지시 "1타점으로 잡을지 2타점으로 잡을지 설정할 수 있도록"] 자동매매 진입
  //   타점 분할(1~2). 위 autoForm과 별도 상태로 둔 이유: 저게 전부 "숫자 입력칸(문자열)"인
  //   반면 이건 "둘 중 하나 고르는" 선택지라 모양이 달라 섞으면 폼 렌더 로직이 지저분해진다.
  const [autoEntryLevel, setAutoEntryLevel] = useState<1 | 1.5 | 2>(1);
  // [v0.63.0] 방어 전략 — 손절 방식·EMA 아래 여유%·손절 종목 당일 재진입 금지·연속 손절 자동중지
  const [defenseForm, setDefenseForm] = useState({ slMode: "fixed" as "fixed" | "ema", emaStopBufferPct: "1.5", reentryBlockEnabled: true, lossStreakLimit: "3", reprotectVanished: true });
  const [autoStatus, setAutoStatus] = useState<AutoTradeStatus | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  // [v0.61.0] 상태 미러(capri_live_state) — PC가 마지막으로 올린 시각(ms). canReconcileLive가
  //   false인 세션(=폰, 중계 미연결)이 getLiveState()로 받아올 때마다 갱신한다. 화면에
  //   "마지막 갱신 HH:MM:SS"로 보여줘, 멈춘 건지 원래 이 상태인지 구분할 수 있게 한다(오너 지시).
  const [liveStateUpdatedAtMs, setLiveStateUpdatedAtMs] = useState<number | null>(null);
  // [v0.70.0 — 오너 지시 "세팅값 수정 후 저장을 눌러도 이게 적용이되는건지 명확히 모르겠다"]
  //   PC가 상태 미러에 실어 올린 "지금 PC에 실제로 저장된 설정 전체". 폰 화면 입력칸(autoForm 등)과는
  //   별개의 읽기 전용 값이다 — 섞으면 폰이 "지금 타이핑 중인 값"이 PC가 올린 값으로 갑자기
  //   덮어써질 위험이 있어(20초마다 폴링) 일부러 분리했다. 저장 버튼 옆에 "PC 실제값"으로만 보여준다.
  const [pcSettings, setPcSettings] = useState<ToolSettings | null>(null);
  /** [v0.61.0] PC가 올려 둔 최신 상태(자동매매 현황 전체 + 최근 로그)를 받아와 화면에 반영한다.
   *  canReconcileLive가 false인 세션(=폰, 토스에 직접 못 붙음) 전용 — PC가 push한 그대로
   *  믿고 쓴다(과거엔 capri_auto_state에 lastScan/skipReasons를 끼워 넣어 받았는데, 이제
   *  capri_live_state 전용 통로로 교체됐다 — lib/auto-state-sync.ts 참고). */
  const refreshLiveState = useCallback(async (): Promise<AutoTradeStatus | null> => {
    const r = await window.kyletool.getLiveState?.().catch(() => null);
    if (r?.ok && r.status) {
      setAutoStatus(r.status);
      setLiveStateUpdatedAtMs(r.updatedAtMs);
      // [v0.61.2 — ② 전수조사에서 발견] "서버 로그" 탭은 이 세션의 로컬 저널만 보여줬는데,
      //   폰(웹)의 로컬 엔진은 실제로 아무 일도 안 하므로(실행은 전부 PC가 한다) 이 탭이
      //   사실상 항상 텅 비어 있었다 — PC의 최근 로그를 상태 미러에 함께 실어 보내므로
      //   (pushLiveState) 여기서 같이 반영한다.
      if (r.journal.length > 0) setJournal(r.journal);
      if (r.killSwitch != null) setPcKillSwitch(r.killSwitch);
      setPcScanProgress(r.scanProgress); // [v0.61.4] null도 의미 있다(= PC가 아직 한 번도 안 돈 것)
      setPcLab(r.lab ?? null); //          [v0.65.0]
      if (r.settings) setPcSettings(r.settings); // [v0.70.0] PC가 올려 둔 "실제 저장된 설정"
      return r.status;
    }
    return null;
  }, []);
  // PC 생존 신호 임계값: 데스크톱 루프 주기(8초)의 여유를 넉넉히 둬 90초로 잡는다(한 주기 놓쳐도 오탐 안 하게).
  const pcConnected = pcLastSeenMs != null && Date.now() - pcLastSeenMs < 90_000;
  // [v0.60.4 — 오너 실사용 보고 "원격으로 시작을 눌러도 진행되고 있는지 모르겠다"] 웹(폰)
  //   세션의 autoStatus.enabled는 이 브라우저 탭 자체의(의미 없는) 로컬 상태라, 웹에서는
  //   PC가 실제로 보낸 값(pcAutoTradeEnabled)을 대신 쓴다 — 아직 못 받아왔으면(null) 기존
  //   표시로 안전하게 대체.
  const effectiveAutoEnabled = isWebApp && pcAutoTradeEnabled != null ? pcAutoTradeEnabled : (autoStatus?.enabled ?? false);
  // [v0.61.2] 비상 정지도 같은 원칙 — 웹(폰)에서는 PC가 실제로 보낸 값(pcKillSwitch)이 진실.
  const effectiveKillSwitch = isWebApp && pcKillSwitch != null ? pcKillSwitch : (status?.killSwitch ?? false);
  // [v0.32.0] 자동매매 알림(관찰 확정·주문) — 브라우저/OS Notification 권한 상태.
  //   "unsupported"는 Notification API 자체가 없는 드문 환경(구형 브라우저 등).
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  async function requestNotifyPermission() {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setNotifyPermission(p);
  }
  // [v0.28.0] 자동매매용 스크리너 조건(메뉴얼 스크리너와 같은 4항목) + 수동 새로고침 상태.
  const [autoScanForm, setAutoScanForm] = useState<{ scanCount: string; priceMin: string; priceMax: string }>({
    scanCount: "60",
    priceMin: "1",
    priceMax: "9",
  });
  const [autoScanBodyRatio, setAutoScanBodyRatio] = useState(0.3);
  const [autoScanBusy, setAutoScanBusy] = useState(false); // "지금 새로고침" 버튼 눌러 응답 기다리는 중
  // [v0.33.0] "스크리닝 기준" 탭 — 추가 8개 조건(켜짐/꺼짐 + 수치)의 입력칸 상태.
  //   숫자는 문자열로 들고 있다가 저장 시점에 변환(다른 폼들과 동일한 패턴 — 입력 중 "0.1" 같은
  //   중간 상태가 Number()에 막히지 않게).
  const [screenCritForm, setScreenCritForm] = useState({
    emaTrendEnabled: true,
    emaPeriod: "200",
    cloudEnabled: true,
    dojiWickMinRatio: "0.1",
    dojiMaxAgeEnabled: true,
    dojiMaxAgeMinutes: "40",
    dojiMaxGapEnabled: true,
    dojiMaxGapMinutes: "30",
    emaMinGapEnabled: false, // [v0.63.0] 방어 필터 — 공장값 꺼짐
    emaMinGapPct: "6",
    emaSlopeEnabled: false,
    atrFilterEnabled: false,
    atrMaxPct: "3",
    nextCandleConfirmEnabled: true,
    excludeEtf: true,
    // [v0.45.0] "매매진행할 장" 선택 — 기본 4개 전부 켜짐(지금까지의 동작과 동일).
    dayEnabled: true,
    preEnabled: true,
    regularEnabled: true,
    afterEnabled: true,
  });
  // [v0.33.0] 조건별 "자세히" 펼침 상태 — 코멘트는 항상 보이고, 상세 설명만 펼쳐야 보인다.
  const [openCritDetail, setOpenCritDetail] = useState<Set<string>>(new Set());
  function toggleCritDetail(key: string) {
    setOpenCritDetail((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const [autoScanProg, setAutoScanProg] = useState<ScreenProgress | null>(null); // 스캔 진행률(수동/자동 사이클 공용)
  // [v0.61.4] 스캔 진행률 표시용 — canReconcileLive면 로컬 이벤트(onScreenerProgress)가 실시간으로
  //   채워주는 autoScanProg를 그대로 쓰고, 아니면(웹, 중계 없음) 상태 미러로 받은 pcScanProgress를 쓴다.
  const liveScanDisplay: ScreenProgress | null = canReconcileLive ? autoScanProg : pcScanProgress;
  // [v0.29.0] "다음 스캔까지 N분 N초" 카운트다운 표시용 — 1초마다 흘러가는 현재시각(서버 재조회 없이
  //   화면에서만 초 단위로 줄어들게 보여준다. 실제 값(nextCycleAtMs)은 20초 폴링으로 서버와 맞춘다).
  const [nowTick, setNowTick] = useState(Date.now());
  // [v0.30.0] 오너 요청 — "어떤 탭에서든" 자동매매 보유종목을 로테이션으로 보여주는 상단 고정
  //   위젯용. 수익률·평가손익은 보유(holdingsView)에서 가져온다(자동매매 엔진 자체는 진입가만
  //   알고 실시간 시세·손익 계산은 안 하므로 — 이미 있는 API를 재사용, 새 엔진 로직 불필요).
  const [autoPosHold, setAutoPosHold] = useState<HoldingRow[]>([]);
  const [tickerIdx, setTickerIdx] = useState(0);
  // [v0.30.0] "자동매매기록" 탭 — 자동매매가 낸 매매 전체 이력(영속 로그).
  const [autoHistory, setAutoHistory] = useState<AutoTradeHistoryEntry[]>([]);
  const [autoHistoryBusy, setAutoHistoryBusy] = useState(false);
  // [v0.64.0] 자동매매기록을 토스 실제 체결과 대조한 결과(id → 결과). 탭을 열 때는 안 불러오고
  //   "🔄 토스 체결과 대조" 버튼을 눌러야만 조회한다(매번 자동으로 부르면 토스 요청이 불필요하게
  //   늘어난다 — report()/tradeAnalysis()도 같은 원칙으로 버튼 눌러야만 동작).
  const [historyReconcile, setHistoryReconcile] = useState<Record<string, HistoryReconcileResult>>({});
  const [historyReconcileBusy, setHistoryReconcileBusy] = useState(false);
  const [historyReconcileMsg, setHistoryReconcileMsg] = useState<string | null>(null);
  // [v0.41.0 — 오너 요청] "지금 감시 중" 포지션을 직접 취소하는 버튼의 진행 상태(포지션 키 단위).
  const [autoCancelBusyKey, setAutoCancelBusyKey] = useState<string | null>(null);
  // [v0.60.0 긴급 수정 — 오너 실사용 보고: "취소 버튼을 눌러도 반응이 없다"] 원인 규명: 이
  //   버튼은 실제로는 항상 반응했다 — 다만 그 결과 메시지를 저 멀리 [설정] 탭 안의 syncMsg에만
  //   써서, 오너가 지금 보고 있는 이 탭(자동매매 컨트롤)에는 성공이든 실패든 아무 것도 안
  //   보였을 뿐이다("조용히 아무 일도 안 하는 것처럼 보인다"의 실제 정체). 이 버튼 바로 아래에
  //   뜨는 전용 메시지로 분리한다 — 실패하면 실패 사유가 바로 여기 보인다.
  const [autoCancelMsg, setAutoCancelMsg] = useState("");
  /** [v0.69.4] 보호 대기 종목의 [보호 중단] — 봇의 재시도만 멈춘다(토스 주문은 그대로). 폰이면 원격 명령 큐로. */
  async function doDismissUnprotected(symbol: string) {
    if (!confirm(`${symbol}에 봇이 보호주문(익절/손절)을 다시 거는 것을 12시간 동안 멈출까요?\n(토스에 이미 걸린 주문은 그대로 두고, 이 종목은 직접 관리하게 됩니다. 손절 주문이 없으면 급락 때 보호되지 않아요.)`)) return;
    try {
      const r = canReconcileLive
        ? await window.kyletool.dismissUnprotected(symbol)
        : await window.kyletool.sendCommand("dismissUnprotected", { symbol });
      setAutoCancelMsg(`${symbol}: ${r.ok ? "✅ " : "⚠️ "}${r.message}`);
      if (canReconcileLive) setAutoStatus(await window.kyletool.autoTradeStatus());
      else setTimeout(() => void refreshLiveState(), 10_000);
    } catch (e) {
      setAutoCancelMsg(`${symbol}: ⚠️ 요청이 실패했습니다(${e instanceof Error ? e.message : String(e)}).`);
    }
  }
  const [reconcileBusy, setReconcileBusy] = useState(false); // [v0.45.0] "🔄 지금 확인" 버튼 눌림 상태
  async function doCancelAutoPosition(p: AutoPosition) {
    const key = `${p.symbol}@${p.entry}@${p.enteredAtMs}`;
    if (!confirm(`${p.symbol} 자동매매 포지션을 취소할까요?\n(매수 체결 대기 중이면 매수 주문을, 이미 체결됐으면 익절/손절 조건주문을 취소합니다.)`)) return;
    setAutoCancelBusyKey(key);
    setAutoCancelMsg("");
    try {
      // [v0.61.0 — 오너 지시 "폰에서 조회만 되면 안 되고 조작도 돼야 한다"] 웹에서 토스 중계가
      //   없으면 cancelAutoPosition을 직접 불러봤자 이 세션엔 토스 연결이 없어 항상 실패한다
      //   — PC가 집어가 실행하는 원격 명령 큐로 보낸다(dispatchCommand의 cancelAutoPosition
      //   그대로 재사용). 결과는 PC가 몇 초 안에 처리하므로, 잠시 뒤 상태 미러를 다시 받아온다.
      if (!canReconcileLive) {
        const r = await window.kyletool.sendCommand("cancelAutoPosition", { symbol: p.symbol, entry: p.entry, enteredAtMs: p.enteredAtMs });
        setAutoCancelMsg(`${p.symbol}: ${r.ok ? "✅ 취소 명령을 PC로 보냈습니다. 잠시 후 반영됩니다." : `⚠️ ${r.message}`}`);
        setTimeout(() => void refreshLiveState(), 10_000);
        return;
      }
      const r = await window.kyletool.cancelAutoPosition(p.symbol, p.entry, p.enteredAtMs);
      setAutoCancelMsg(`${p.symbol}: ${r.ok ? "✅ " : "⚠️ "}${r.message}`);
      if (r.ok) setAutoStatus(await window.kyletool.autoTradeStatus());
    } catch (e) {
      // [v0.60.0] IPC 호출 자체가 예외를 던지는 경우(네트워크 끊김 등)까지 반드시 화면에 남긴다
      //   — 실패를 조용히 삼키는 경로를 하나도 남기지 않는다(오너 지시).
      setAutoCancelMsg(`${p.symbol}: ⚠️ 취소 요청 자체가 실패했습니다(${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setAutoCancelBusyKey(null);
    }
  }
  // [v0.35.0] 매매연구 탭 — "내 데이터"/"그룹 전체" 전환. 그룹 데이터는 볼 때만 받아온다(자동 로드 안 함).
  // [v0.49.0] "raw" = Raw Data 탭(criteriaSnapshot 필드별 성적 비교 + CSV 원본 내보내기).
  const [researchView, setResearchView] = useState<"mine" | "group" | "raw">("mine");
  const [groupMembers, setGroupMembers] = useState<{ email: string; history: AutoTradeHistoryEntry[] }[] | null>(null);
  const [groupResearchBusy, setGroupResearchBusy] = useState(false);
  const [groupResearchMsg, setGroupResearchMsg] = useState("");
  // [v0.56.0] 그룹 채팅 — [👥 그룹원 관리] 탭.
  const [groupChat, setGroupChat] = useState<GroupChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatErr, setChatErr] = useState("");
  // [v0.49.0] Raw Data 탭 안에서만 쓰는 원본 소스 선택("내 데이터"/"그룹 전체" 중 어느 쪽 원본을 볼지).
  //   위 researchView와 별도로 두는 이유: Raw Data를 보다가도 groupMembers는 그대로 유지돼야
  //   (다시 안 눌러도) 곧바로 전환할 수 있게.
  const [rawSource, setRawSource] = useState<"mine" | "group">("mine");
  async function loadGroupResearch() {
    if (groupResearchBusy) return;
    setGroupResearchBusy(true);
    try {
      const r = await window.kyletool.groupTradesPull();
      setGroupMembers(r.members);
      setGroupResearchMsg(r.ok ? r.message : `⚠️ ${r.message}`);
    } catch (e) {
      setGroupResearchMsg(`⚠️ 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGroupResearchBusy(false);
    }
  }

  // [v0.56.0] 그룹 채팅 — [👥 그룹원 관리] 탭에서 쓴다.
  async function loadGroupChat() {
    if (chatBusy) return;
    setChatBusy(true);
    try {
      const r = await window.kyletool.groupChatList();
      if (r.ok) setGroupChat(r.chat);
    } finally {
      setChatBusy(false);
    }
  }
  async function doSendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatBusy(true);
    try {
      const r = await window.kyletool.groupChatSend(text);
      if (r.ok) {
        setChatInput("");
        await loadGroupChat();
      } else {
        setChatErr(r.message);
      }
    } finally {
      setChatBusy(false);
    }
  }

  // [v0.61.9 — 오너 지시 "업데이트 내역 탭 신설 + 개발 보고를 동업자들과 공유"] 그룹 전원이
  //   함께 보는 공개 변경 로그. 로그인 직후 한 번 받아와서, 이 기기가 아직 못 본 최신
  //   버전이 있으면 팝업(unseenChangelog)으로 띄운다 — "폰 PC 모두" 띄우라는 지시대로
  //   기기(로컬)별로 "읽음" 상태를 따로 관리한다(markChangelogSeen).
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [changelogBusy, setChangelogBusy] = useState(false);
  // [v0.62.1] 자동매매 리포트 탭 — 최근 실행(켬→끔) 기록별 4부분 리포트 + 마크다운/AI 프롬프트 복사.
  const [autoReports, setAutoReports] = useState<AutoReport[]>([]);
  const [autoReportMsg, setAutoReportMsg] = useState("");
  const [autoReportBusy, setAutoReportBusy] = useState(false);
  const loadAutoReports = useCallback(async () => {
    setAutoReportBusy(true);
    try {
      const r = await window.kyletool.getAutoReports?.();
      setAutoReports(r?.reports ?? []);
      setAutoReportMsg(r ? (r.message ?? (r.source === "pc" ? "PC가 올려 둔 리포트입니다(폰에서 보는 중)." : "")) : "이 버전에서는 리포트를 지원하지 않습니다.");
    } catch (e) {
      setAutoReportMsg(`불러오기 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAutoReportBusy(false);
    }
  }, []);
  const copyReportText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setAutoReportMsg(`✅ ${what}을(를) 복사했습니다. 원하는 곳(예: Claude 대화창)에 붙여 넣으세요.`);
    } catch {
      setAutoReportMsg("⚠️ 복사에 실패했습니다(브라우저 권한). 아래 리포트 글자를 직접 선택해 복사해 주세요.");
    }
  };
  const [unseenChangelog, setUnseenChangelog] = useState<ChangelogEntry | null>(null);
  const loadChangelog = useCallback(async (checkPopup: boolean) => {
    setChangelogBusy(true);
    try {
      const r = await window.kyletool.getChangelog?.();
      if (!r?.ok) return;
      setChangelog(r.entries);
      if (checkPopup && r.entries.length > 0 && r.entries[0].version !== r.lastSeenVersion) {
        setUnseenChangelog(r.entries[0]);
      }
    } finally {
      setChangelogBusy(false);
    }
  }, []);
  function dismissChangelogPopup() {
    if (!unseenChangelog) return;
    void window.kyletool.markChangelogSeen?.(unseenChangelog.version);
    setUnseenChangelog(null);
  }
  /**
   * [v0.48.0 버그 수정 — 오너 보고 "자동매매기록 탭도 실시간 연동 안 됨, 새로고침해도 그대로"]
   *   예전엔 이 함수가 로컬에 이미 저장돼 있는 기록 파일만 다시 읽어왔다(`autoTradeHistory()`).
   *   그런데 기록의 상태(보유 중/익절/손절 등)는 오직 reconcileAutoPositions 계열 함수가 토스에
   *   실제로 물어봐야만 갱신되는데, 이 탭의 "새로고침" 버튼은 그 조회를 한 번도 부르지 않았다
   *   — 그래서 아무리 눌러도 "이미 저장된(어쩌면 오래된) 값"만 다시 보여줄 뿐이었다(코드
   *   리뷰·헤드리스 클릭 테스트로는 "버튼 자체는 정상 반응"이라 못 잡았던 진짜 원인 — 버튼은
   *   정상이었고, 그 버튼이 부르는 함수가 토스에 확인을 안 했던 것). 이제 로컬 기록을 다시
   *   읽기 전에 먼저 reconcileAutoPositionsNow()로 지금 감시 중인 포지션의 실제 토스 상태를
   *   한 번 확실히 확인한 뒤(그 결과가 updateAutoTradeHistory를 통해 기록 파일에도 반영됨),
   *   그 갱신된 기록을 불러온다 — 이제 이 버튼을 누르면 진짜로 "지금 토스 기준 최신 상태"가
   *   보인다.
   */
  async function loadAutoHistory() {
    setAutoHistoryBusy(true);
    try {
      // [v0.60.5] 웹에서 중계(QR) 연결이 없으면 reconcileAutoPositionsNow는 항상 실패하므로
      //   부르지 않는다 — 대신 PC가 올려 둔 최신 기록을 받아온다(autoStateSyncPull).
      if (canReconcileLive) {
        await window.kyletool.reconcileAutoPositionsNow().catch(() => {}); // 실패해도 기록 조회는 계속 진행
      } else {
        await window.kyletool.autoStateSyncPull().catch(() => {});
      }
      setAutoHistory(await window.kyletool.autoTradeHistory());
    } finally {
      setAutoHistoryBusy(false);
    }
  }

  /**
   * [v0.64.0 — 오너 실사용 보고 "매매기록 탭들이 실제 매매기록과 완벽하게 일치하지 않는다,
   *   토스데이터와 완벽연계해"] "자동매매기록" 탭의 각 줄을 토스 실제 체결(📊 매매 리포트
   *   탭과 같은 출처 — 토스 '종료된 주문')과 대조한다. report()처럼 토스 연결이 있는 기기
   *   (PC, 또는 QR 중계가 연결된 폰)에서만 의미가 있다 — 웹(중계 없음)에서는 이 버튼 자체를
   *   숨긴다(canReconcileLive, 아래 JSX 참고).
   */
  async function reconcileHistory() {
    setHistoryReconcileBusy(true);
    setHistoryReconcileMsg(null);
    try {
      const { results, source } = await window.kyletool.reconcileAutoHistory();
      setHistoryReconcile(results);
      const n = Object.keys(results).length;
      const mismatches = Object.values(results).filter((r) => r.status === "mismatch").length;
      const enriched = Object.values(results).filter((r) => r.status === "enriched").length;
      if (source === "none") {
        setHistoryReconcileMsg("대조할 토스 체결 내역이 없습니다(연결 안 됨 + 저장된 기록도 없음).");
      } else {
        setHistoryReconcileMsg(
          `${n}건 대조 완료(${source === "live" ? "방금 토스에서 확인" : "저장된 기록 기준"})` +
            `${mismatches > 0 ? ` — ⚠️ 불일치 ${mismatches}건` : ""}${enriched > 0 ? ` — 🆕 새로 확인된 손익 ${enriched}건` : ""}`,
        );
      }
    } catch (e) {
      setHistoryReconcileMsg(`대조 실패: ${String(e)}`);
    } finally {
      setHistoryReconcileBusy(false);
    }
  }
  // [v0.2.8] 조건주문 편집 창 — 계산값에 묶이지 않고 오너가 직접 고칠 수 있게 한다.
  const [ocoEdit, setOcoEdit] = useState<{ tp: string; sl: string; qty: string } | null>(null);
  // [v0.2.9] 토스에서 받아온 수량 정보(주문가능 최대 / 보유 / 매도가능). 표시용 참고값.
  // [v0.3.0] Capacity 타입: 주문가능/보유 + 세션 시드 제안(kyletool.d.ts 정의)
  const [cap, setCap] = useState<Capacity | null>(null);

  // [v0.3.0] 상단 상시 바용 계좌 요약(예수금 + 보유 총손익)
  const [acct, setAcct] = useState<{ buyingPowerUsd: number | null; totalPnlUsd: number | null; totalPnlRate: number | null } | null>(null);
  // [v0.3.0] "확정된" 종목. 한 글자 고칠 때마다 값이 날아가지 않도록, 엔터/포커스아웃 때만 확정한다.
  const [committedSymbol, setCommittedSymbol] = useState("AAPL");
  const [quoteErr, setQuoteErr] = useState(""); // 시세 조회 실패 시 인라인 안내(팝업 대신)

  // --- 연습 가격 조작 ---
  const [mockPrice, setMockPrice] = useState("");

  // --- 자동 업데이트 ---
  const [appVer, setAppVer] = useState("");
  const [update, setUpdate] = useState<{ version: string; notes: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null); // 다운로드 진행률 %
  const [updateReady, setUpdateReady] = useState(false); // 다운로드 완료 → 재시작 대기
  // [v0.32.3] macOS는 코드서명이 실행 중인 앱과 새 버전 사이에 맞아야만 자동 업데이트
  //   (Squirrel.Mac)가 적용된다 — 특히 아주 오래된(서명 방식이 다른) 버전에서 최신으로
  //   건너뛸 때 이 실패가 "재시작하고 적용" 버튼을 눌러도 조용히 아무 일도 안 일어나는
  //   것처럼 보이게 한다. 지금까지 이 오류(autoUpdater "error" 이벤트)가 화면에 전혀
  //   연결돼 있지 않아 원인을 알 수 없었다 — 이제 여기 보여준다.
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  // [v0.46.0] "재시작하고 적용"을 눌러도 반응이 없다는 오너 보고 재조사 — quitAndInstall이
  //   메인 프로세스에서 예외 없이 "접수됨"만 돌려주고(setImmediate로 실제 설치는 뒤에서
  //   진행), macOS 애드혹 서명(인증서 없이 서명 흉내만 낸 상태 — electron-builder.yml의
  //   identity: "-")에서는 Squirrel.Mac(맥 자동 업데이트 적용 엔진)이 옛 버전과 새 버전의
  //   서명이 안 맞으면 조용히 아무 것도 안 하고 끝나는 경우가 있다. 이때 JS 쪽엔 어떤
  //   오류 이벤트도 안 온다 — "버튼이 안 눌리는 것처럼 보인다"는 보고의 진짜 정체.
  //   실제로 설치가 성공하면 앱 프로세스 자체가 꺼지므로, 반대로 "몇 초가 지나도 앱이
  //   여전히 켜져 있다"는 사실 자체가 "조용히 실패했다"는 확실한 증거가 된다 — 이 신호를
  //   화면 타이머로 직접 감지해 안내한다.
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateInstallStuck, setUpdateInstallStuck] = useState(false);
  // [v0.58.0] macOS 차선책 — 직접 교체가 실패했을 때만 뜨는 "새 dmg 받아 놨어요" 안내.
  const [macDmg, setMacDmg] = useState<{ version: string; fileName: string } | null>(null);
  // [v0.60.0] macOS 직접 교체 자동업데이트 — 종료 시 자동 적용될 준비가 끝났다는 안내.
  const [macSwap, setMacSwap] = useState<{ version: string } | null>(null);
  const [macSwapBusy, setMacSwapBusy] = useState(false);

  useEffect(() => {
    refreshStatus();
    window.kyletool.journal().then(setJournal);
    void refreshSplits(); // [v0.4.0] 저장해 둔 삼분할 기록 불러오기(앱 켤 때 1회)
    window.kyletool.getSettings().then((s) => {
      setSettings(s);
      setFormMode(s.mode);
      setFormAccount(s.account);
      if (s.priceGuardPct) setGuardPct(String(s.priceGuardPct));
      // 시드 설정 입력칸 초기화(설정 탭)
      setSeedForm({
        day: String(s.seedDayPct),
        pre: String(s.seedPrePct),
        regular: String(s.seedRegularPct),
        basis: s.seedBasis,
        fixed: s.seedFixedUsd != null ? String(s.seedFixedUsd) : "",
      });
      // [v0.8.3] 저장된 기본 손익비를 계산기 익절/손절칸 초기값으로 로드(재시작해도 유지).
      if (s.defaultTpPct) setTpPct(String(s.defaultTpPct));
      if (s.defaultSlPct) setSlPct(String(s.defaultSlPct));
      setDefForm({ tp: String(s.defaultTpPct ?? 2), sl: String(s.defaultSlPct ?? 10) });
      // [v0.26.0] 저장된 자동매매 한도를 입력칸 초기값으로("켜짐" 자체는 저장 안 되므로 항상 꺼진 채 시작).
      setAutoForm({
        maxPositions: String(s.autoTradeMaxPositions ?? 3),
        maxLossPct: String(s.autoTradeMaxLossPct ?? 5),
        maxInvestPct: String(s.autoTradeMaxInvestPct ?? 30),
        watchMinutes: String(s.autoTradeWatchMinutes ?? 10),
      });
      setAutoEntryLevel(s.autoTradeEntryLevel === 2 ? 2 : s.autoTradeEntryLevel === 1.5 ? 1.5 : 1); // [v0.61.8]
      setDefenseForm({
        slMode: s.autoTradeSlMode === "ema" ? "ema" : "fixed",
        emaStopBufferPct: String(s.autoTradeEmaStopBufferPct ?? 1.5),
        reentryBlockEnabled: s.autoTradeReentryBlockEnabled ?? true,
        lossStreakLimit: String(s.autoTradeLossStreakLimit ?? 3),
        reprotectVanished: s.autoTradeReprotectVanished ?? true,
      });
      // [v0.28.0] 저장된 자동매매 스크리너 조건을 입력칸 초기값으로.
      setAutoScanForm({
        scanCount: String(s.autoScanCount ?? 60),
        priceMin: String(s.autoScanPriceMin ?? 1),
        priceMax: String(s.autoScanPriceMax ?? 9),
      });
      setAutoScanBodyRatio(s.autoScanBodyRatio ?? 0.3);
      // [v0.33.0] 저장된 "스크리닝 기준" 8개 조건을 입력칸 초기값으로.
      setScreenCritForm({
        emaTrendEnabled: s.autoScanEmaTrendEnabled ?? true,
        emaPeriod: String(s.autoScanEmaPeriod ?? 200),
        cloudEnabled: s.autoScanCloudEnabled ?? true,
        dojiWickMinRatio: String(s.autoScanDojiWickMinRatio ?? 0.1),
        dojiMaxAgeEnabled: s.autoScanDojiMaxAgeEnabled ?? true,
        dojiMaxAgeMinutes: String(s.autoScanDojiMaxAgeMinutes ?? 40),
        dojiMaxGapEnabled: s.autoScanDojiMaxGapEnabled ?? true,
        dojiMaxGapMinutes: String(s.autoScanDojiMaxGapMinutes ?? 30),
        emaMinGapEnabled: s.autoScanEmaMinGapEnabled ?? false,
        emaMinGapPct: String(s.autoScanEmaMinGapPct ?? 6),
        emaSlopeEnabled: s.autoScanEmaSlopeEnabled ?? false,
        atrFilterEnabled: s.autoScanAtrFilterEnabled ?? false,
        atrMaxPct: String(s.autoScanAtrMaxPct ?? 3),
        nextCandleConfirmEnabled: s.autoScanNextCandleConfirmEnabled ?? true,
        excludeEtf: s.autoScanExcludeEtf ?? true,
        dayEnabled: s.autoScanDayEnabled ?? true,
        preEnabled: s.autoScanPreEnabled ?? true,
        regularEnabled: s.autoScanRegularEnabled ?? true,
        afterEnabled: s.autoScanAfterEnabled ?? true,
      });
      // [v0.3.0] 실서버면 켜자마자 상단 바(예수금·손익)와 기본 종목 시세를 자동 로드한다.
      if (s.mode === "live") {
        void loadAccount();
        void autoLoad("AAPL");
      }
    });
    void window.kyletool.autoTradeStatus().then(setAutoStatus); // [v0.26.0] 자동매매 현재 상태(항상 꺼진 채 시작)
    window.kyletool.appVersion?.().then(setAppVer).catch(() => {});
    void refreshAuth(); // [v0.8.1] 로그인 상태 복원(+운영자면 승인 대기 목록도, v0.24.0)
    void loadAnalysis(); // [v0.19.0] 매매분석(실체결) 시작 시 로드
    const off = window.kyletool.onJournal((e) => setJournal((prev) => [...prev.slice(-99), e]));
    // [v0.32.0] 자동매매 관찰 확정·주문 알림 — 권한이 허용돼 있을 때만 실제로 띄운다(요청은
    //   오너가 버튼을 눌러야만 — 브라우저가 사용자 동작 없는 자동 요청을 막거나 무시할 수 있음).
    const offNotify = window.kyletool.onNotify?.((n) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      try {
        new Notification(n.title, { body: n.body, tag: `capri-${n.symbol}-${n.ts}` });
      } catch {
        /* 일부 환경(예: 알림 미지원 PWA 백그라운드)에서 생성 자체가 실패해도 앱은 계속 동작 */
      }
    });
    // [v0.5.0] 체결강도 실시간 갱신: 지금 화면에서 보고 있는 종목의 이벤트만 반영.
    const offStr = window.kyletool.onStrength?.((state) => {
      setStrState((prev) => (state.symbol === (prev?.symbol ?? state.symbol) ? state : prev));
      // [v0.23.0] 보유 목록에 있는 종목이면 그 카드 값도 실시간 갱신.
      setHeldStates((prev) => (prev[state.symbol] ? { ...prev, [state.symbol]: state } : prev));
    });
    // [v0.6.0] 스크리너 진행률 실시간 표시
    // [v0.28.0] 이 이벤트는 스캔이 메뉴얼 버튼이든 자동매매 5분 사이클이든 상관없이 온다 —
    //   두 화면(메뉴얼 스크리너·자동 스크리너) 모두 같은 진행률을 각자 보여줄 수 있게 둘 다 갱신.
    const offScr = window.kyletool.onScreenerProgress?.((p) => {
      setScreenProg(p);
      setAutoScanProg(p);
      // [v0.43.0] "ranking" = 이제 막 시작된 새 스캔(수동 버튼이든 자동 5분 사이클이든) — 지난
      //   스캔에서 눌렀던 취소 요청 표시가 새 스캔까지 넘어와 버튼이 계속 잠겨 있지 않게 지운다.
      if (p.phase === "ranking") setScanCancelRequested(false);
    });
    // [v0.7.0] 매매 시 자동 기록된 트레이드가 갱신되면 목록·요약 새로고침
    const offTrd = window.kyletool.onTrades?.(() => void loadAnalysis());
    // [v0.56.0] "그룹 전체 실시간 동기화" — 로그인 상태면 3분마다 자동으로 push+pull이 돈다
    //   (groupSyncEnsure는 이미 돌고 있으면 아무 일도 안 하므로 마운트 때 불러도 안전). 받아온
    //   최신 그룹 기록은 이벤트로 들어오는 대로 화면(매매연구·그룹원 관리 탭)에 바로 반영한다.
    void window.kyletool.groupSyncEnsure?.();
    const offGroupSync = window.kyletool.onGroupSync?.((members) => setGroupMembers(members));
    // 업데이트 이벤트 구독(있음/진행률/완료/오류).
    // [v0.32.3] 예전엔 오류를 "조용히 무시"했다(앱이 죽지 않는 건 맞지만, 그 대가로
    //   업데이트가 실패해도 오너가 원인을 전혀 알 수 없었다 — "버튼이 안 눌린다"는 보고의
    //   실제 원인). 이제 다운로드/설치 배경에서 나는 오류(autoUpdater가 emit하는 "error")도
    //   화면에 그대로 보여준다.
    const offUpd = window.kyletool.onUpdate?.({
      available: (info) => setUpdate(info),
      progress: (pct) => setUpdateProgress(pct),
      downloaded: () => {
        setUpdateReady(true);
        setUpdateProgress(100);
      },
      error: (msg) => setUpdateErr(String(msg)),
      // [v0.58.0] macOS 차선책 알림 — 새 dmg를 미리 받아 뒀다는 신호(직접 교체 실패 시만).
      macDmgReady: (info) => setMacDmg(info),
      // [v0.60.0] macOS 직접 교체 자동업데이트 — 종료 시 자동 적용될 준비가 끝났다는 신호.
      macSwapReady: (info) => setMacSwap(info),
    });
    return () => {
      off();
      offNotify?.();
      offStr?.();
      offScr?.();
      offTrd?.();
      offUpd?.();
      offGroupSync?.();
    };
  }, []);

  // [v0.14.0] 손익 색 관습을 화면 루트(data-pnl)에 반영 + 이 기기에 저장. 토큰만 바뀌어 전체가 일관되게 뒤집힌다.
  useEffect(() => {
    const root = document.documentElement;
    if (pnlKr) root.setAttribute("data-pnl", "kr");
    else root.removeAttribute("data-pnl");
    try { localStorage.setItem("capri-pnl", pnlKr ? "kr" : "us"); } catch { /* 저장 실패해도 화면은 동작 */ }
  }, [pnlKr]);

  // [v0.15.0] 화면 넓이 감지 — 넓을 때(≥1024)만 2컬럼이 가능. matchMedia 변화에 반응(폰은 항상 단일).
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia("(min-width: 1024px)");
    const on = () => setIsWide(m.matches);
    on();
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  // [v0.15.0] 2컬럼 on/off 선택을 이 기기에 저장.
  useEffect(() => { try { localStorage.setItem("capri-twocol", twoCol ? "1" : "0"); } catch { /* 저장 실패 무시 */ } }, [twoCol]);

  // [v0.15.0] 탭을 '열 때' 하던 지연 로딩을 한 곳으로 모은다(1컬럼 탭 클릭·2컬럼 패널 선택 공용).
  //   호출 시점(이벤트/커밋 후)엔 아래 로더들이 모두 초기화돼 있으므로 참조 안전.
  const activateTab = (t: TabId) => {
    if (t === "orders") refreshStatusTab();
    else if (t === "splits") refreshSplits();
    else if (t === "strength") { void loadHoldingsStrength(); void loadAnalysis(); }
    else if (t === "report") void loadReport();
    // [v0.27.0] 자동매매 현황/스크리닝 결과 탭을 열 때 최신 상태를 바로 받아온다(20초 폴링을 기다리지 않게).
    else if (t === "autoControl" || t === "autoScan") void window.kyletool.autoTradeStatus().then(setAutoStatus);
    // [v0.30.0] 자동매매기록 탭을 열 때 최신 기록을 불러온다.
    // [v0.33.0] 매매연구 탭도 같은 기록(autoHistory)을 재료로 통계를 내므로 똑같이 불러온다.
    else if (t === "autoHistory" || t === "research") void loadAutoHistory();
    // [v0.62.1] 자동매매 리포트 탭을 열 때 최신 실행 기록으로 리포트를 다시 만든다.
    else if (t === "autoReport") void loadAutoReports();
    // [v0.56.0] 그룹원 관리 탭을 열 때 근황(그룹 기록)·채팅을 바로 불러온다.
    else if (t === "groupManage") { void loadGroupResearch(); void loadGroupChat(); }
    // [v0.61.9] 업데이트 내역 탭을 열 때 최신 목록을 다시 받아온다(팝업은 이미 로그인 직후
    //   한 번 확인했으므로 여기선 다시 띄우지 않는다).
    else if (t === "changelog") void loadChangelog(false);
  };
  // [v0.15.0] 2컬럼이 켜지거나 좌/우 패널 탭이 바뀌면 그 탭들의 데이터를 로드한다(1컬럼과 동일한 지연 로딩).
  useEffect(() => {
    if (!showTwoCol) return;
    activateTab(tabL);
    activateTab(tabR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTwoCol, tabL, tabR]);

  // [v0.15.0] 콘텐츠 안의 버튼("계산기로 불러오기"·"체결강도 보기" 등)이 두 모드에서 다 동작하게.
  //   1컬럼: 그 탭으로 이동. 2컬럼: 이미 어느 패널에 떠 있으면 그대로, 아니면 왼쪽 패널에 띄운다(먹통 방지).
  const goToTab = (t: TabId) => {
    if (showTwoCol) { if (tabL !== t && tabR !== t) setTabL(t); }
    else setTab(t);
  };
  // [v0.15.0 · B리뷰 H1/H2] "그 탭이 지금 화면에 보이나?" — 1컬럼은 tab, 2컬럼은 좌/우 패널 중 하나.
  //   렌더 블록은 paneTab로 옮겼지만, 명령형 가드(자동계산·주문 후 새로고침·킬스위치)가 stale tab을 봐서
  //   2컬럼에서 계산기·주문현황이 갱신 안 되던 치명 버그를 이 헬퍼로 바로잡는다.
  const isTabVisible = (t: TabId) => (showTwoCol ? tabL === t || tabR === t : tab === t);

  // [v0.59.0] 디스코드 알림의 "지금 승인하기" 링크(#/approve)로 들어온 경우 — 오너 로그인이
  //   확인되는 즉시 [그룹원 관리] 탭으로 바로 이동한다. 아직 로그인 전이면(막 앱을 열어
  //   authChecked가 안 끝났거나, 로그인 화면에 있는 중) 대기하다가 authState가 오너로
  //   바뀌는 순간 실행된다. 데스크톱은 이 링크를 열 방법이 없어(알림은 웹/폰 전용) 사실상
  //   웹앱에서만 동작하지만, 조건이 같으니 굳이 플랫폼을 분기하지 않는다.
  useEffect(() => {
    if (typeof location === "undefined" || location.hash !== "#/approve") return;
    if (!authState.loggedIn || !authState.isOwner) return;
    goToTab("groupManage");
    activateTab("groupManage");
    history.replaceState(null, "", location.pathname + location.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState.loggedIn, authState.isOwner]);

  // [v0.61.9] 로그인이 확인되는 즉시 업데이트 내역을 한 번 받아와, 이 기기가 아직 못 본
  //   최신 버전이 있으면 팝업을 띄운다(오너 지시: "폰 PC 모두" — 탭을 열어보지 않아도 뜨게).
  useEffect(() => {
    if (!authState.loggedIn) return;
    void loadChangelog(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState.loggedIn]);

  // [v0.2.10→v0.60.6] 30초 자동 갱신. 기본은 꺼짐(자율 동작 최소화 원칙) — 오너가 켤 때만 돈다.
  //   주문 현황이 '보이는 동안'만 돈다. [v0.15.0] 2컬럼이면 좌/우 어느 패널에 있어도 인정.
  //   [v0.60.6] 웹에서 토스 중계(QR)가 없으면 holdingsView/ordersView/condOrdersView는 전부
  //   실제 토스 호출이라 항상 실패하고, 이 데이터는(스크리너·포지션과 달리) PC↔폰 동기화
  //   채널 자체가 없어 대신 받아올 방법도 없다 — 그래서 자동 갱신 자체를 돌리지 않는다
  //   (30초마다 실패 경고창이 뜨는 걸 막는다). 수동 버튼은 눌러서 바로 확인 가능하지만
  //   역시 연결이 없으면 실패 — 이건 애초에 PC를 거쳐야만 조회되는 데이터라 구조적 한계다.
  useEffect(() => {
    const ordersVisible = showTwoCol ? (tabL === "orders" || tabR === "orders") : tab === "orders";
    if (!autoRefresh || !ordersVisible || !canReconcileLive) return;
    const id = setInterval(() => void refreshStatusTab(), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, tab, showTwoCol, tabL, tabR, canReconcileLive]);

  // [v0.61.2 — ② 전수조사에서 발견한 치명 버그 수정] 상태 미러(capri_live_state)를
  //   조건 없이 항상 받아온다 — 특히 비상 정지 표시는 자동매매 상태·포지션
  //   유무와 무관하게 폰에서 "지금 PC가 실제로 멈춰 있는지"를 늘 정확히 보여줘야 한다
  //   (가장 안전 긴급한 표시). 같은 호출이 PC 최근 로그("서버 로그" 탭)도 함께 받아오므로
  //   더 이상 탭별로 따로 폴링을 걸 필요가 없다 — 아래 포지션/스캔 폴링의 웹 분기도 이제
  //   이 효과 하나로 통합됐다.
  // [v0.61.4 — 오너 지시 "스크리닝시 진행되는 사항들 게이지"] PC가 지금 스캔 중이면(
  //   pcScanProgress.running) 20초로는 게이지가 안 차 보인다 — 스캔 중에는 2초로 당기고,
  //   평소엔 20초로 되돌려 부하를 줄인다.
  useEffect(() => {
    if (!isWebApp) return;
    void refreshLiveState();
    const intervalMs = pcScanProgress?.running ? 2_000 : 20_000;
    const id = setInterval(() => void refreshLiveState(), intervalMs);
    return () => clearInterval(id);
  }, [isWebApp, refreshLiveState, pcScanProgress?.running]);

  // [v0.26.0→v0.45.0→v0.48.0] 현황(포지션·누적손익)을 20초마다 새로고침.
  //   [v0.48.0 긴급 수정 — 오너 보고 "익절/손절 완료된 종목이 계속 감시 중으로 남아있다,
  //   실시간 연동이 안 된다"] 예전엔 이 폴링 전체가 "자동매매 켜짐"(enabled)에 걸려 있었다.
  //   그런데 마스터 스위치는 앱을 새로 켤 때마다 항상 꺼진 채로 시작한다(설계 원칙 — CLAUDE.md
  //   "마스터 스위치는 절대 저장 안 함"). 그 사이에 감시 중이던 포지션이 실제로 토스에서
  //   익절/손절돼도, 오너가 자동매매를 다시 켜거나 [🔄 지금 확인] 버튼을 손으로 누르기
  //   전까지는 이 화면이 그 사실을 영원히 모른 채 옛 상태("익절/손절 등록됨")를 계속
  //   보여주고 있었다 — 이게 "실시간 연동이 안 된다"는 보고의 진짜 원인이었다. 익절/손절
  //   자체는 토스 서버의 조건주문이 마스터 스위치와 무관하게 항상 지켜주므로 실제 계좌는
  //   안전했지만, **화면이 그 사실을 반영 못 해 오너가 실제 상태를 믿을 수 없게 만든 것**이
  //   진짜 문제였다.
  //   이제 "감시할 포지션이 있으면" 마스터 스위치와 무관하게 계속 재확인한다
  //   (reconcileAutoPositionsNow는 새 주문을 내지 않는 순수 조회 함수라 상시 폴링해도
  //   안전 규칙에 위배되지 않는다 — 신규 진입 게이트는 이 폴링과 완전히 별개로 항상
  //   지켜진다). 포지션이 없고 자동매매도 꺼져 있으면 폴링할 이유가 없어 그대로 멈춘다.
  useEffect(() => {
    // [v0.61.0→v0.61.2] 웹에서 토스 중계(QR)가 없으면 reconcileAutoPositionsNow(실제 토스
    //   호출)는 절대 성공할 수 없다 — 이 경우는 위의 "상태 미러" 효과가 isWebApp이면 조건
    //   없이 항상 폴링해 처리하므로, 여기서는 중복으로 돌리지 않는다.
    if (!canReconcileLive) return;
    const hasPositions = (autoStatus?.positions?.length ?? 0) > 0;
    if (!autoStatus?.enabled && !hasPositions) return;
    const tick = () => {
      void (hasPositions ? window.kyletool.reconcileAutoPositionsNow() : window.kyletool.autoTradeStatus()).then(setAutoStatus);
    };
    tick(); // [v0.48.0] 20초를 기다리지 않고 이 탭에 들어오거나 상태가 바뀐 즉시 한 번 바로 확인
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, [autoStatus?.enabled, autoStatus?.positions?.length, canReconcileLive]);

  // [v0.29.0] 자동 스크리너 탭의 카운트다운용 — 자동매매가 켜져 있는 동안만 1초마다 화면을 흘려보낸다
  //   (오너 요청: "몇 분 후 스크리닝 진행 표시 필요" — 언제 다음 스캔이 도는지 눈에 보이게).
  useEffect(() => {
    if (!autoStatus?.enabled) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [autoStatus?.enabled]);

  // [v0.30.0] 상단 고정 로테이션 위젯용 보유현황 — 자동매매 포지션이 하나라도 있는 동안만,
  //   탭과 무관하게(이 효과는 어떤 tab이 보이는지 전혀 안 본다) 15초마다 손익을 새로 가져온다.
  useEffect(() => {
    if (!autoStatus?.enabled || autoStatus.positions.length === 0) { setAutoPosHold([]); return; }
    const poll = () => void window.kyletool.holdingsView().then((hv) => setAutoPosHold(hv.items)).catch(() => {});
    poll();
    const id = setInterval(poll, 15_000);
    return () => clearInterval(id);
  }, [autoStatus?.enabled, autoStatus?.positions.length]);

  // [v0.44.0] 시스템 휴무 시간대 배너용 — 탭·자동매매 켜짐 여부와 무관하게 항상 30초마다 확인한다
  //   (수동 도구도 이 시간대엔 막히므로, 자동매매가 꺼져 있어도 오너가 알고 있어야 한다).
  useEffect(() => {
    const poll = () => void window.kyletool.getSystemPauseStatus().then(setSystemPause).catch(() => {});
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, []);

  // [v0.59.0] PC 생존 신호 — 로그인 화면을 통과한 뒤부터 20초마다 확인(승인 대기/로그인 전엔
  //   당연히 의미 없으므로 이 지점 — 게이트 통과 이후 — 에 둔다). "PC 연결됨/꺼져 있음" 배지가
  //   이 값을 쓴다 — PC 꺼진 줄 모르고 원격 버튼을 눌러놓고 됐다고 착각하는 사고를 막는 핵심 표시.
  useEffect(() => {
    const poll = () =>
      void window.kyletool.getDesktopHeartbeat()
        .then((r) => { setPcLastSeenMs(r.lastSeenMs); setPcAutoTradeEnabled(r.autoTradeEnabled); setPcAppVersion(r.pcAppVersion); })
        .catch(() => {});
    poll();
    const id = setInterval(poll, 20_000);
    return () => clearInterval(id);
  }, []);

  // [v0.30.0] 로테이션 전환 — 포지션이 2개 이상일 때만 3.5초마다 다음 종목으로 넘긴다.
  useEffect(() => {
    const n = autoStatus?.positions.length ?? 0;
    if (n <= 1) { setTickerIdx(0); return; }
    const id = setInterval(() => setTickerIdx((i) => (i + 1) % n), 3500);
    return () => clearInterval(id);
  }, [autoStatus?.positions.length]);

  // [v0.3.0] 자동 계산 — 재료·익절/손절%·기법이 바뀌면 0.35초 뒤 조용히 다시 계산한다.
  //   [계산하기] 버튼을 없앤 대신 이 효과가 대신한다. 타이핑 중 잠깐 멈추면 결과가 갱신된다.
  //   0.35초 지연(디바운스)을 두는 이유: 한 글자마다 계산하면 낭비이므로 "멈추면 계산"으로.
  useEffect(() => {
    if (!isTabVisible("calc")) return; // [B리뷰 H1] 2컬럼에서도 계산기 패널이 보이면 자동계산 동작
    const id = setTimeout(() => void runCalc(true), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tech, baseClose, ema200, wallPrice, barOpen, manualEntry, tpPct, slPct, candleYang, committedSymbol, showTwoCol, tabL, tabR, tab]);

  /** [v0.58.0] 다운로드는 이제 새 버전이 감지되면 메인 프로세스가 알아서 자동으로 시작한다
   *  (autoDownload:true) — 이 함수는 그게 실패했을 때(updateErr) 배너의 "지금 다시 받기"
   *  버튼으로만 쓰인다. */
  async function startDownloadUpdate() {
    setUpdateProgress(0);
    const r = await window.kyletool.downloadUpdate();
    if (!r.ok) {
      setUpdateProgress(null);
      // [v0.27.1] 예전엔 실패 이유를 화면에서 감춰서(고정 문구만) 사장님도 저도 원인을 알
      // 방법이 없었다 — 실제 오류 메시지(r.error)를 그대로 덧붙여, 다음에 또 실패해도
      // 이 문구를 캡처해 보내주시면 바로 원인을 찾을 수 있게 한다.
      const detail = r.error ? `\n\n(자세히: ${r.error})` : "";
      alert(`업데이트 다운로드에 실패했습니다. 인터넷 연결을 확인하고 나중에 다시 시도하세요. (앱은 계속 사용 가능합니다)${detail}`);
    }
  }

  /** [v0.46.0] "재시작하고 적용" 버튼 — macOS 애드혹 서명 환경에서 조용히 실패하는 경우를
   *  감지하기 위한 타이머(watchdog)를 같이 건다. 실제로 설치·재시작이 성공하면 이 함수의
   *  나머지 코드가 실행될 새도 없이 앱 프로세스가 꺼지므로, 8초가 지나도 여전히 이 타이머
   *  콜백이 실행된다는 것 자체가 "조용한 실패"의 증거다(정상이면 그 전에 이미 꺼져 있어야
   *  한다). Windows는 이 문제가 없지만(서명 없이도 NSIS 원클릭 재설치가 항상 됨) 굳이
   *  분기하지 않는다 — 정상 재시작되는 플랫폼에선 8초 안에 이미 앱이 꺼져 있어 콜백 자체가
   *  실행되지 않으므로 아무 영향이 없다.
   */
  async function startInstallUpdate() {
    setUpdateInstalling(true);
    setUpdateInstallStuck(false);
    const watchdog = setTimeout(() => {
      setUpdateInstalling(false);
      setUpdateInstallStuck(true);
    }, 8000);
    const r = await window.kyletool.installUpdate();
    if (!r.ok) {
      clearTimeout(watchdog);
      setUpdateInstalling(false);
      // [v0.32.2] 예전엔 실패해도 화면에 아무 신호가 없어 "버튼이 안 눌린다"처럼
      // 보였다 — 다운로드 실패 처리(startDownloadUpdate)와 같은 방식으로 맞춘다.
      const detail = r.error ? `\n\n(자세히: ${r.error})` : "";
      alert(
        `재시작·적용에 실패했습니다. 앱은 계속 사용 가능합니다 — ` +
          `[주문현황] 등 기존 기능엔 영향 없습니다. 한 번 더 눌러보거나, 그래도 안 되면 ` +
          `설치 파일을 새로 받아 직접 설치해 주세요: https://github.com/hun100b-dotcom/kyle-bot-releases/releases${detail}`,
      );
    }
    // r.ok===true 인 경우: 위 watchdog이 판단을 대신한다(정상 성공이면 곧 앱이 꺼진다).
  }

  /** [v0.60.0] macOS 직접 교체 자동업데이트 — "지금 바로 재시작". 그냥 앱을 끄는 것뿐이고
   *  (Squirrel을 안 타므로 워치독이 따로 필요 없다), 종료 훅이 자동으로 번들을 교체하고
   *  다시 연다. 정상이면 곧 이 창 자체가 사라진다. */
  async function doInstallMacSwap() {
    setMacSwapBusy(true);
    const r = await window.kyletool.installMacSwap?.();
    if (!r?.ok) {
      setMacSwapBusy(false);
      alert(`재시작에 실패했습니다: ${r?.error ?? "알 수 없는 오류"}. 앱은 계속 사용 가능합니다 — 직접 종료 후 다시 켜도 적용됩니다.`);
    }
    // r.ok===true면 곧 앱이 꺼지므로 별도 처리 불필요.
  }

  async function refreshStatus() {
    setStatus(await window.kyletool.status());
  }

  /** [v0.3.0] 상단 바용 계좌 요약 로드(예수금+총손익). 실패해도 조용히 null. */
  async function loadAccount() {
    try {
      setAcct(await window.kyletool.accountSummary());
    } catch {
      setAcct(null);
    }
  }

  /**
   * [v0.3.0] 종목이 확정됐을 때 자동으로 시세·환율·주문가능수량·계좌를 한 번에 로드한다.
   *   버튼을 없앤 대신 이 함수가 그 일을 대신한다. 조용히(silent) 처리해 팝업을 띄우지 않고,
   *   실패하면 인라인 안내(quoteErr)만 남긴다.
   */
  async function autoLoad(sym: string) {
    if (!sym) return;
    setBusy(true);
    setQuoteErr("");
    try {
      const cur = await window.kyletool.quote(sym);
      setCurPrice(cur);
      await loadFx();
      await refreshCapacity(cur, sym); // [v0.16.0] 방금 고른 종목으로 수량 조회(state 반영 전이라 sym 전달)
      await loadAccount();
      await refreshStatus();
    } catch (e) {
      setCurPrice(null);
      setCap(null);
      setQuoteErr(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, ""));
    } finally {
      setBusy(false);
    }
  }

  /**
   * [v0.3.0] 종목 확정(엔터/포커스아웃). 실제로 종목이 바뀐 경우에만 값을 초기화하고 다시 로드한다.
   *   한 글자만 고쳐 같은 종목이면 아무것도 하지 않아 입력값(전봉종가 등)이 보존된다.
   */
  async function commitSymbol() {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    if (sym === committedSymbol && curPrice != null) return; // 안 바뀌었고 이미 로드됨 → 그대로
    setCommittedSymbol(sym);
    await autoLoad(sym);
  }

  // [v0.3.0] loadQuote(수동 조회 버튼)는 autoLoad(자동 로드)로 대체돼 제거됨.

  /** [v0.2.9] 토스에서 주문가능 수량·보유 수량을 받아와 화면에 표시(강제 아님, 참고용). */
  async function refreshCapacity(priceForCalc?: number, symOverride?: string) {
    try {
      // [v0.16.0] 종목을 인자로 받을 수 있게(symOverride). 탐색 행 클릭처럼 setSymbol 직후엔 state가
      //   아직 안 바뀌어 있어, 넘겨받은 종목으로 조회해야 '방금 고른 종목'의 수량이 정확히 나온다.
      const sym = (symOverride ?? symbol).trim().toUpperCase();
      const c = await window.kyletool.capacity(sym, priceForCalc);
      setCap(c);
    } catch {
      setCap(null); // 조회 실패해도 앱은 정상 동작(값만 "조회 불가")
    }
  }

  async function loadFx() {
    const r = await window.kyletool.fx();
    if (r) {
      setFx(r.rate);
      setFxSource(r.source);
      setFxFailed(false);
    } else {
      setFxFailed(true); // 화면에 수동 입력 폴백 표시
    }
  }

  async function applyManualFx() {
    const rate = Number(manualFx);
    if (rate > 0) {
      await window.kyletool.setManualFx(rate);
      setFx(rate);
      setFxSource("manual");
      setFxFailed(false);
    }
  }

  /**
   * 계산 실행 — lib/calc.ts(사양서 M1 검증 함수)를 엔진 경유로 호출.
   * [v0.3.0] silent=true(자동 계산)면 입력이 덜 됐을 때 빨간 에러를 띄우지 않고 조용히 결과만 비운다.
   *   (사람이 타이핑하는 중에 "값을 입력하세요" 경고가 번쩍이면 거슬리기 때문)
   */
  async function runCalc(silent = false) {
    setCalcErr("");
    setResult(null);
    if (tech === "candle" && !candleYang) {
      if (!silent) setCalcErr("캔들 기법은 '전봉이 양봉'일 때만 씁니다. 확인 체크를 해 주세요.");
      return;
    }
    // [입력 검증] 계산 시점에만 숫자로 바꾸고, 비었거나 이상하면 한국어로 안내한다.
    const tpNum = toNum(tpPct);
    const slNum = toNum(slPct);
    if (tpNum === null || tpNum <= 0) {
      if (!silent) setCalcErr("익절 %를 0보다 큰 숫자로 입력하세요. (예: 2)");
      return;
    }
    if (slNum === null || slNum <= 0) {
      if (!silent) setCalcErr("손절 %를 0보다 큰 숫자로 입력하세요. (예: 10)");
      return;
    }
    // [v0.3.0] 자동 계산은 기법별 필수 재료가 다 들어왔을 때만 엔진을 부른다.
    //   (빈 입력으로 엔진을 부르면 "값을 입력하세요" 예외가 매번 나 로그가 지저분해진다.)
    const ready =
      (tech === "split3" && toNum(baseClose) !== null && toNum(ema200) !== null) ||
      (tech === "orderbook" && toNum(wallPrice) !== null) ||
      (tech === "candle" && toNum(barOpen) !== null) ||
      (tech === "manual" && toNum(manualEntry) !== null);
    if (!ready) {
      if (!silent) setCalcErr("기법에 필요한 값을 입력하세요.");
      return; // 조용히 대기(결과는 비운 상태)
    }
    try {
      const r = await window.kyletool.calc({
        technique: tech,
        tpPct: tpNum,
        slPct: slNum,
        baseClose: baseClose ? Number(baseClose) : undefined,
        ema200: ema200 ? Number(ema200) : undefined,
        wallPrice: wallPrice ? Number(wallPrice) : undefined,
        barOpen: barOpen ? Number(barOpen) : undefined,
        entry: manualEntry ? Number(manualEntry) : undefined,
      });
      setResult(r);
      // [v0.3.0] 자동 계산 중엔 매 입력마다 수량 API를 다시 부르지 않는다(네트워크 절약).
      //   주문가능수량·시드는 종목 확정 시 현재가 기준으로 이미 로드돼 있다.
    } catch (e) {
      if (!silent) setCalcErr(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, ""));
    }
  }

  /**
   * [v0.2.10] 지금 화면에 입력된 값으로 "매매 근거"를 만든다.
   *   주문을 낼 때 이 스냅샷(그 순간의 사진)을 함께 보내 앱이 파일에 남긴다.
   *   토스는 기법 정보를 돌려주지 않으므로, 우리가 보내지 않으면 근거는 영원히 사라진다.
   */
  function buildRationale(lv: CalcLevel, override?: { tp?: number; sl?: number }): RationaleInput {
    return {
      technique: tech,
      level: lv.level, //          삼분할이면 1/2/3분할
      baseClose: toNum(baseClose) ?? undefined,
      ema200: toNum(ema200) ?? undefined,
      wallPrice: toNum(wallPrice) ?? undefined,
      barOpen: toNum(barOpen) ?? undefined,
      entry: lv.entry > 0 ? lv.entry : (toNum(manualEntry) ?? undefined),
      tp: override?.tp ?? lv.tp,
      sl: override?.sl ?? lv.sl,
      tpPct: toNum(tpPct) ?? undefined,
      slPct: toNum(slPct) ?? undefined,
      priceAtOrder: curPrice,
    };
  }

  // --- 주문 팝업 만들기(전송은 팝업의 확인 버튼에서만) ---

  function confirmEntry(lv: CalcLevel) {
    const q = toNum(qty);
    // [v0.2.9] 정수 강제 제거 — 토스는 소수주(예: 0.0655주)를 지원한다. 0보다 크기만 하면 보낸다.
    if (q === null || q <= 0) {
      alert("수량을 0보다 큰 숫자로 입력하세요. (예: 1 또는 0.5)");
      return;
    }
    const total = lv.entry * q;
    requestOrder({
      kind: "entry",
      title: `매수만 (지정가) — ${symbol.toUpperCase()}`,
      lines: [
        `진입가 ${usdKrw(lv.entry, fx)} × ${q}주`,
        `예상 투입액 ${usdKrw(total, fx)}`,
        `주문 유효기간: 당일만 — 오늘 안 체결되면 자동 취소`,
      ],
      send: () =>
        window.kyletool.placeEntry({
          symbol,
          price: lv.entry,
          quantity: q,
          rationale: buildRationale(lv), // 기법 근거 동봉(주문 성공 시 기록됨)
        }),
    });
  }

  /**
   * [v0.3.2] 진입+익절(OTO) — "사면서 익절까지 한 번에". 손절은 담지 않는다(오너 수동).
   *   진입가·익절가·수량으로 토스 OTO 조건주문 1건을 만들어 확인 팝업을 띄운다.
   *   미보유여도 OK: OTO의 first는 '매수'라 보유가 필요 없다(OCO와 다른 점).
   */
  function confirmOto(lv: CalcLevel) {
    const q = toNum(qty);
    if (q === null || q <= 0) {
      alert("수량을 0보다 큰 숫자로 입력하세요. (예: 1 또는 0.5)");
      return;
    }
    const expire = defaultExpire();
    requestOrder({
      kind: "oto",
      title: `매수+익절 자동 — ${symbol.toUpperCase()} · 손절은 직접`,
      lines: [
        `매수 ${usdKrw(lv.entry, fx)} × ${q}주`,
        `→ 체결되면 익절(매도) ${usdKrw(lv.tp, fx)} 자동 등록 (+${tpPct}%)`,
        `⚠️ 손절은 담기지 않습니다. 진입 체결 후 손절은 직접(수동) 걸어주세요.`,
        `만료일 ${expire} · 지정가 · 토스 서버가 감시(앱 꺼도 작동)`,
      ],
      send: () =>
        window.kyletool.placeOto({
          symbol,
          quantity: q,
          entryTrigger: lv.entry, // 진입 감시가 = 진입 지정가
          entryPrice: lv.entry,
          tpTrigger: lv.tp, //       익절 감시가 = 익절 지정가
          tpPrice: lv.tp,
          expireDate: expire,
          // 근거: 익절만 의미있으므로 손절(sl)은 근거에서 비운다.
          rationale: { ...buildRationale(lv, { tp: lv.tp }), sl: undefined },
        }),
    });
  }

  /** [v0.2.8] 조건주문 버튼 → 바로 전송하지 않고 "편집 창"을 연다(값 자유 수정). */
  async function openOcoEditor(lv: CalcLevel) {
    // 보유수량을 조회해 기본값으로. 실패하면 계산기 수량을 쓴다(막지 않음).
    // [v0.2.9] 창이 열릴 때 토스에서 보유·매도가능 수량을 자동 조회해 채운다.
    let defQty = qty;
    try {
      const c = await window.kyletool.capacity(symbol.trim().toUpperCase(), curPrice ?? undefined);
      setCap(c);
      const auto = c.sellableQty ?? c.heldQty; // 매도가능 우선, 없으면 보유수량
      if (auto != null && auto > 0) defQty = String(auto);
    } catch {
      /* 조회 실패해도 진행(직접 입력 가능) */
    }
    setOcoEdit({ tp: String(lv.tp), sl: String(lv.sl), qty: defQty });
  }

  /** 편집 창의 값으로 실제 조건주문 요청을 만든다. */
  function submitOcoFromEditor() {
    if (!ocoEdit) return;
    const tpv = toNum(ocoEdit.tp);
    const slv = toNum(ocoEdit.sl);
    const q = toNum(ocoEdit.qty);
    if (tpv === null || slv === null || q === null || q <= 0) {
      alert("익절가·손절가·수량을 숫자로 입력하세요.");
      return;
    }
    // 편집창에서 온 값이라 진입가가 없다 → 계산기 결과의 1분할 진입가를 근거로 함께 남긴다.
    const lv = { level: result?.levels[0]?.level ?? 1, entry: result?.levels[0]?.entry ?? 0, tp: tpv, sl: slv } as CalcLevel;
    setOcoEdit(null);
    confirmOco(lv, q);
  }

  function confirmOco(lv: CalcLevel, qOverride?: number) {
    const q = qOverride ?? toNum(qty);
    if (q === null || q <= 0) {
      alert("수량을 1 이상으로 입력하세요.");
      return;
    }
    const expire = defaultExpire();
    // 손절 지정가(orderPrice)는 감시가(trigger)보다 1% 아래로 둔다. 감시가=지정가면
    //   급락 시 지정가를 관통해 미체결될 수 있어, 아래로 벌려 즉시 체결 확률을 높인다.
    const slLimit = roundPrice(lv.sl * 0.99);
    requestOrder({
      kind: "oco",
      title: `익절+손절 걸기 — ${symbol.toUpperCase()} (보유 중일 때)`,
      lines: [
        `수량 ${q}주 / 익절 감시가 ${usdKrw(lv.tp, fx)} / 손절 감시가 ${usdKrw(lv.sl, fx)}`,
        `손절 지정가 ${usdKrw(slLimit, fx)} (감시가 1% 아래 — 급락 시 체결 확보)`,
        `한쪽이 발동되면 다른 쪽은 자동 취소됩니다 (토스 서버가 감시 — 앱 꺼도 작동)`,
        `만료일 ${expire} / 규칙: 익절 감시가 > 현재가 > 손절 감시가`,
      ],
      send: () =>
        window.kyletool.placeOco({
          symbol,
          quantity: q,
          tpTrigger: lv.tp,
          tpPrice: lv.tp,
          slTrigger: lv.sl,
          slPrice: slLimit,
          expireDate: expire,
          rationale: buildRationale(lv, { tp: lv.tp, sl: lv.sl }), // 기법 근거 동봉
        }),
    });
  }

  /**
   * [v0.25.0] 매수+익절+손절 한번에 — 진입 접수 후 체결되면 자동으로 OCO(익절+손절) 등록.
   *   토스 조건주문은 다리가 2개까지만 가능해 "한 번의 API 호출"로는 안 되지만, 이 버튼을 누르면
   *   진입→체결감시(최대 15분)→OCO 자동등록까지 이어서 처리한다(자세한 이유는 확인 팝업에 안내).
   */
  function confirmBracket(lv: CalcLevel) {
    const q = toNum(qty);
    if (q === null || q <= 0) {
      alert("수량을 0보다 큰 숫자로 입력하세요. (예: 1 또는 0.5)");
      return;
    }
    const expire = defaultExpire();
    const slLimit = roundPrice(lv.sl * 0.99); // OCO와 동일 규칙: 손절 지정가는 감시가 1% 아래
    const watchMinutes = 15;
    requestOrder({
      kind: "bracket",
      title: `매수+익절+손절 한번에 — ${symbol.toUpperCase()}`,
      lines: [
        `매수 ${usdKrw(lv.entry, fx)} × ${q}주`,
        `→ 체결 확인되면 자동으로: 익절 감시가 ${usdKrw(lv.tp, fx)} / 손절 감시가 ${usdKrw(lv.sl, fx)} (지정가 ${usdKrw(slLimit, fx)}) OCO 등록`,
        `⚠️ 토스 조건주문은 다리 2개까지만 가능해 "매수+익절+손절"을 한 번에 못 받습니다. 그래서 이 프로그램이`,
        `체결을 최대 ${watchMinutes}분 지켜보다가(첫 1분은 1초 간격, 이후 5초 간격 확인 — 토스가 체결을 먼저`,
        `알려주는 기능이 없어 계속 물어보는 방식입니다) 확인되는 대로 바로 OCO를 대신 걸어 드립니다.`,
        `⚠️ 이 감시는 앱이 켜져 있는 동안만 작동합니다 — ${watchMinutes}분 안에 체결이 안 되거나 그 사이 앱을 끄면`,
        `자동으로 안 걸리니, [주문현황]에서 체결 여부를 확인하고 직접 걸어 주세요.`,
        `만료일(OCO) ${expire} · 지정가 · 진입 주문 유효기간: 당일만`,
      ],
      send: () =>
        window.kyletool.placeBracket({
          symbol,
          price: lv.entry,
          quantity: q,
          tpTrigger: lv.tp,
          tpPrice: lv.tp,
          slTrigger: lv.sl,
          slPrice: slLimit,
          expireDate: expire,
          watchMinutes,
          rationale: buildRationale(lv, { tp: lv.tp, sl: lv.sl }),
        }),
    });
  }

  /** 확인 팝업을 띄우거나(기본), 설정에서 건너뛰기를 켰으면 곧바로 전송한다. */
  async function requestOrder(po: PendingOrder) {
    if (status?.skipOrderConfirm) {
      setBusy(true);
      try {
        await po.send();
        if (isTabVisible("orders")) await refreshStatusTab();
      } catch (e) {
        const msg = String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, "");
        alert(`주문이 전송되지 않았습니다.

${msg}

(위 사유가 해결되면 다시 시도하세요. 돈은 나가지 않았습니다.)`);
      } finally {
        setBusy(false);
      }
      return;
    }
    setPending(po);
  }

  async function sendPending() {
    if (!pending) return;
    setBusy(true);
    try {
      await pending.send();
      setPending(null);
      if (isTabVisible("orders")) await refreshStatusTab();
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, "");
      alert(`주문이 전송되지 않았습니다.

${msg}

(위 사유가 해결되면 다시 시도하세요. 돈은 나가지 않았습니다.)`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * [v0.3.3] 주문 현황 탭 전체 새로고침 — 보유·일반주문·조건주문을 한 번에 불러온다.
   *   전부 조회(읽기)만이라 언제 눌러도 안전. 한쪽이 실패해도 나머지는 보여준다(allSettled).
   *   status(미체결 OPEN / 체결 CLOSED)에 따라 주문/조건주문을 그 상태로 조회한다.
   */
  async function refreshStatusTab(statusOverride?: "OPEN" | "CLOSED") {
    const st = statusOverride ?? ordStatus;
    setPosBusy(true);
    try {
      const [hRes, oRes, cRes] = await Promise.allSettled([
        window.kyletool.holdingsView(),
        window.kyletool.ordersView(st),
        window.kyletool.condOrdersView(st),
      ]);
      if (hRes.status === "fulfilled") setHold(hRes.value);
      if (oRes.status === "fulfilled") setOrdRows(oRes.value);
      if (cRes.status === "fulfilled") setCondRows(cRes.value);
      setPosAt(new Date().toLocaleTimeString());
      const fails: string[] = [];
      if (hRes.status === "rejected") fails.push("보유");
      if (oRes.status === "rejected") fails.push("일반주문");
      if (cRes.status === "rejected") fails.push("조건주문");
      if (fails.length === 3) {
        alert(`${fails.join("·")} 조회 실패. [설정] 탭에서 실서버 모드·키·계좌를 확인해 주세요.`);
      }
    } finally {
      setPosBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // [v0.4.0] 내 삼분할 기록 — 저장/조회/삭제/진입완료 체크
  //   목적: A종목 삼분할을 저장해 두면, B·C·D를 새로 계산해도 A 타점이 안 사라진다.
  //   저장은 엔진(tool-engine)이 파일에 남기므로 앱을 껐다 켜도 유지된다.
  // -------------------------------------------------------------------------

  /** 저장 목록을 파일에서 다시 읽어 화면에 반영. */
  async function refreshSplits() {
    try {
      setSplits(await window.kyletool.splitsList());
    } catch (e) {
      console.error("삼분할 기록 조회 실패", e);
    }
  }

  /** 계산기의 [기록 저장] — 지금 계산 결과(타점 3개)를 종목·%·수량·메모와 함께 저장. */
  async function saveCurrentSplit() {
    if (!result) return; // 계산 결과가 없으면 저장할 게 없다
    try {
      const updated = await window.kyletool.splitsAdd({
        symbol: committedSymbol || symbol,
        technique: result.technique,
        levels: result.levels,
        tpPct: toNum(tpPct),
        slPct: toNum(slPct),
        qty: toNum(qty),
        memo: splitMemo,
        // [v0.9.0] 계산에 쓴 '재료'를 통째로 함께 저장한다.
        //   나중에 2·3차 매수할 때 전봉종가·EMA200 을 다시 치지 않고
        //   [계산기로 불러오기] 한 번으로 그대로 복원하기 위함이다.
        inputs: {
          technique: result.technique,
          symbol: committedSymbol || symbol,
          tpPct,
          slPct,
          qty,
          baseClose,
          ema200,
          wallPrice,
          barOpen,
          manualEntry,
          candleYang,
          // 참고값: 저장 당시 벌어짐(gap)과 현재가. 나중에 "그때와 지금" 비교에 쓸 수 있다.
          gap: toNum(baseClose) != null && toNum(ema200) != null ? toNum(baseClose)! - toNum(ema200)! : null,
          curPrice,
        },
      });
      setSplits(updated);
      setSplitMemo(""); // 메모칸 비우기
      setSplitSaved("저장됨 ✓ — [내 삼분할 기록] 탭에서 확인");
      setTimeout(() => setSplitSaved(""), 3000); // 3초 뒤 안내 사라짐
    } catch (e) {
      alert("기록 저장 실패: " + String(e));
    }
  }

  /**
   * [v0.9.0] 저장된 기록의 입력값을 계산기에 그대로 채워 넣고 계산기 탭으로 이동한다.
   *
   *   2차·3차 매수를 할 때 전봉 종가·EMA200 같은 재료를 다시 입력하지 않아도 되게 하는 기능.
   *   옛 기록(입력값이 없는 것)은 버튼이 비활성이라 여기로 들어오지 않는다.
   */
  function loadSplitIntoCalc(s: SavedSplit): void {
    // 저장된 입력값이 있으면 그대로, 없으면(옛 기록) **결과에서 거꾸로 되살려서** 쓴다.
    //   예전에는 여기서 그냥 return 해 버려 "버튼이 안 눌린다"는 인상을 줬다.
    const restored = s.inputs ? null : restoreInputsFromSaved(s);
    const i = s.inputs ?? restored;
    if (!i) {
      alert("이 기록은 계산기로 불러올 수 없습니다(저장된 값이 부족합니다).");
      return;
    }
    setTech(i.technique);
    setSymbol(i.symbol);
    setCommittedSymbol(i.symbol); // 종목 확정 상태로 둬야 시세·수량 조회가 바로 붙는다
    setTpPct(i.tpPct);
    setSlPct(i.slPct);
    setQty(i.qty);
    setBaseClose(i.baseClose);
    setEma200(i.ema200);
    setWallPrice(i.wallPrice);
    setBarOpen(i.barOpen);
    setManualEntry(i.manualEntry);
    setCandleYang(i.candleYang);
    goToTab("calc"); //             계산기 화면으로 이동(2컬럼이면 왼쪽 패널에)
    setSplitSaved(
      restored
        ? `${s.symbol} 불러옴 — 옛 기록이라 진입가에서 되살린 값입니다(1틱 정도 차이 가능). 수량만 바꿔 진행하세요`
        : `${s.symbol} 입력값을 계산기에 불러왔습니다 — 수량만 바꿔 2·3차 진행하세요`,
    );
    setTimeout(() => setSplitSaved(""), 4000);
  }

  /** 기록 한 건 삭제(휴지통). */
  async function deleteSplit(id: string) {
    if (!confirm("이 기록을 삭제할까요? (되돌릴 수 없습니다)")) return;
    try {
      setSplits(await window.kyletool.splitsDelete(id));
    } catch (e) {
      alert("삭제 실패: " + String(e));
    }
  }

  /** 특정 기록의 특정 분할에 [진입완료] 체크를 켜고/끈다. */
  async function toggleSplitEntered(id: string, level: number) {
    try {
      setSplits(await window.kyletool.splitsToggle(id, level));
    } catch (e) {
      alert("체크 반영 실패: " + String(e));
    }
  }

  /** [제목 수정] 시작 — 이 기록을 편집 모드로 바꾸고 현재 제목을 입력칸에 채운다. */
  function startEditSplit(id: string, currentMemo: string) {
    setEditSplitId(id);
    setEditSplitText(currentMemo);
  }

  /** 편집 취소(원래 표시로 되돌림). */
  function cancelEditSplit() {
    setEditSplitId(null);
    setEditSplitText("");
  }

  /** 편집 저장 — 새 제목을 파일에 반영(앱 재시작해도 유지)하고 편집 모드 종료. */
  async function saveEditSplit(id: string) {
    try {
      setSplits(await window.kyletool.splitsRename(id, editSplitText));
      setEditSplitId(null);
      setEditSplitText("");
    } catch (e) {
      alert("제목 수정 실패: " + String(e));
    }
  }

  // -------------------------------------------------------------------------
  // [v0.5.0] 체결강도 기록 — 시작/중지/조회
  //   엔진이 켜져 있는 동안 주기적으로 샘플링하고, 그 결과를 onStrength 이벤트로 보내온다.
  //   화면은 이벤트를 받아 현재값·시계열을 갱신한다(자율 아님 — 사용자가 켠 동안만).
  // -------------------------------------------------------------------------

  /** 저장된(또는 현재) 체결강도 상태를 불러와 화면에 반영. */
  async function loadStrength(symbol: string) {
    try {
      setStrState(await window.kyletool.strengthGet(symbol));
    } catch (e) {
      console.error("체결강도 조회 실패", e);
    }
  }

  // [v0.23.0] 수동 [기록 시작]/[중지]는 제거됨 — 보유 종목은 loadHoldingsStrength가 자동으로 켜고 보여준다.
  //   (엔진의 strengthStart/Stop IPC는 그대로 존재 — 자동 기록 로직이 계속 사용)

  /**
   * [v0.23.0] loadHoldingsStrength — 보유현황(주문현황 탭과 같은 소스)을 가져와,
   *   각 보유(달러) 종목의 체결강도 기록을 '자동으로' 켜고(auto=true → 수명 제한) 상태를 받아 온다.
   *   매매하면 이미 자동 기록되지만, 이 탭을 열면 '지금 보유 중인' 종목들의 강도를 한눈에 보여주려는 것.
   *   집 PC 릴레이 연결이 없으면 보유현황 조회가 실패하므로, 조용히 실패하지 않고 안내를 남긴다.
   */
  async function loadHoldingsStrength(focusSym?: string) {
    // [리뷰 H2] 콕 집은 종목은 ref로 받는다 — 2컬럼에서 이 함수가 focus 없이 한 번 더 호출돼도(effect 경합)
    //   두 호출 다 같은 focus를 동기적으로 집어 관찰 종목이 유실되지 않게 한다.
    const focus = (focusSym || strFocusRef.current || "").toUpperCase().trim();
    setStrLoading(true);
    setStrErr(null);
    try {
      const hv = await window.kyletool.holdingsView();
      // 달러 종목만(체결강도는 미국 주식 틱 기준). 수량 0 제외.
      let syms = hv.items
        .filter((it) => it.quantity > 0 && (it.currency || "USD").toUpperCase() === "USD")
        .map((it) => it.symbol.toUpperCase());
      // [리뷰 H1] holdingsView는 '연결 없음'이어도 throw가 아니라 빈 배열을 준다(엔진이 삼킴).
      //   그래서 보유가 비면 '진짜 0'인지 '연결 없음'인지 시세 한 번으로 확인한다(연결 없으면 quote가 throw).
      //   → 연결 없음을 "보유 종목 없음"으로 잘못 안내하던 회귀를 막는다(무음 실패 금지).
      if (syms.length === 0 && !focus) {
        try {
          await window.kyletool.quote("AAPL");
        } catch {
          setStrErr("연결이 없어 보유 종목을 불러오지 못했습니다.");
          setHeldSyms([]);
          setHeldStates({});
          return;
        }
      }
      // [삼분할 '체결강도 보기'처럼] 특정 종목을 콕 집어 보려 하면, 보유 목록에 없어도 맨 앞에 넣어 관찰한다.
      if (focus && !syms.includes(focus)) syms = [focus, ...syms];
      // [v0.23.0 · 리뷰 방어] 실시간 폴링은 최대 12종목만(10초마다 조회 → 종목이 너무 많으면 요청 폭주·429 방지).
      //   그 이상 보유해도 목록엔 다 보이되, 상한 밖 종목은 '저장된 값만'(strengthGet) 표시한다.
      const MAX_LIVE = 12;
      const states: Record<string, StrengthState> = {};
      for (let i = 0; i < syms.length; i++) {
        const s = syms[i];
        try {
          states[s] = i < MAX_LIVE
            ? await window.kyletool.strengthStart(s, 10, true) // 자동 기록 켜기(수명 제한) + 상태
            : await window.kyletool.strengthGet(s); //           상한 초과: 저장된 값만(폴링 안 켬)
        } catch {
          try { states[s] = await window.kyletool.strengthGet(s); } catch { /* 개별 실패 무시 */ }
        }
      }
      setHeldSyms(syms);
      setHeldStates(states);
      // 상세로 볼 종목: 콕 집은 게 있으면 그것, 아니면 기존 선택(보유 목록에 있을 때), 아니면 첫 종목.
      const pick = focus || (syms.includes(strSym) ? strSym : syms[0]);
      if (pick) { setStrSym(pick); void loadStrength(pick); }
    } catch (e) {
      // 보유현황 조회 실패 = 대개 집 PC 릴레이 연결 없음. 무음 실패 금지 — 안내 남김.
      setStrErr(String(e instanceof Error ? e.message : e));
      setHeldSyms([]);
      setHeldStates({});
    } finally {
      setStrLoading(false);
      // 콕 집은 종목은 한 번 소비했으면 비운다(focus는 함수 진입 시 동기적으로 이미 읽었으므로 경합 안전).
      if (strFocusRef.current === focus && focus) strFocusRef.current = null;
    }
  }

  // -------------------------------------------------------------------------
  // [v0.6.0] 종목 스크리너(탐색) — 온디맨드 스캔
  // -------------------------------------------------------------------------

  /** [스캔] — 거래량 상위 60종목을 훑어 조건 만족 후보를 찾는다(1~2분 소요). */
  async function runScan() {
    if (screenBusy) return;
    // [v0.11.0] 사용자 입력을 숫자로 해석(빈칸·이상값이면 기본값). 엔진 쪽에서도 안전 보정한다.
    const count = Math.min(200, Math.max(10, Math.round(toNum(scanCount) ?? 60)));
    const pMin = Math.max(0, toNum(priceMin) ?? 1);
    const pMax = Math.max(0, toNum(priceMax) ?? 9);
    setScreenBusy(true);
    setScanCancelRequested(false); // [v0.43.0] 새 스캔이니 이전 취소 요청 표시는 지운다
    setScreenProg({ phase: "ranking", done: 0, total: count, symbol: "" });
    try {
      const run = await window.kyletool.screenerScan({ bodyRatio, count, priceMin: pMin, priceMax: pMax });
      setScreenRun(run);
      setShowMiss(false); // 새 스캔이면 근접 목록은 접은 채로 시작
    } catch (e) {
      // [v0.43.0] 오너가 직접 취소를 눌러 멈춘 경우는 "실패"가 아니므로 경고창을 띄우지 않는다.
      if (!String(e).includes("취소")) alert("스캔 실패: " + String(e));
    } finally {
      setScreenBusy(false);
      setScreenProg(null);
      setScanCancelRequested(false);
    }
  }

  /** [v0.43.0] 진행 중인 스크리닝을 취소한다 — [메뉴얼 → 스크리너] 수동 스캔이든, [🤖 자동매매 →
   *  자동 스크리너] 화면에 보이는 자동 사이클(또는 그 수동 새로고침)의 스캔이든 상관없이 어차피
   *  엔진은 한 번에 하나만 스캔하므로 공용 버튼 하나로 처리한다. */
  async function doCancelScan() {
    if (scanCancelRequested) return;
    setScanCancelRequested(true);
    const r = await window.kyletool.cancelScreenerScan();
    if (!r.ok) setScanCancelRequested(false); // 취소할 스캔이 이미 없었다면 다시 누를 수 있게
  }

  /**
   * [v0.11.0→v0.60.3] 후보에 못 든 '아쉽게 탈락' 종목의 실패 사유를 사람 말로.
   *   하드 게이트(가격대·EMA·구름) 중 무엇을 놓쳤는지, 다 넘었으면 패턴(도지/다음봉) 중 무엇인지.
   *   반환: { passed: 넘은 하드게이트 수(0~3), reasons: 실패 사유 문자열 배열 }
   *
   *   [v0.60.3 긴급 수정 — 오너 실사용 보고: "구름 필터를 꺼 뒀는데 탈락 사유에 '구름 밑'이라고
   *   나온다 — 설정이 실제로 반영되는지 의심스럽다"] 전수조사 결과, 집계용 tallyMissReasons는
   *   이미 v0.51.0에서 "꺼진 조건은 사유로 안 셈"으로 고쳐져 있었지만, 이 함수(종목별 개별
   *   사유 — 스크리너 탭의 "근접 탈락" 목록, 자동 스크리너 탭의 "전체 종목 보기" 사유 칸 둘
   *   다에서 쓰인다)는 그 수정에서 빠져 있었다. r.aboveEma/r.aboveCloud는 electron/tool-engine.ts가
   *   "그 조건을 꺼도 지표상 실제로 어떤지는 정직하게 보여준다"는 원칙으로 넣어 둔 원본
   *   비교값이라(게이트로 쓸지는 별도 결정), 필터가 꺼져 있어도 그 종목이 실제로 EMA/구름
   *   아래면 이 값은 여전히 false다 — 이 함수가 그 원본값만 보고 무조건 "탈락 사유"로
   *   적었던 것이 실제 원인이다(그 필터는 꺼져 있어 탈락에 전혀 영향을 안 줬는데도).
   *   이제 그 스캔(run)에서 실제로 켜져 있던 조건만 사유에 넣는다 — tallyMissReasons와
   *   완전히 같은 원칙.
   */
  function missReasons(
    r: ScreenResult,
    run: { emaTrendEnabled: boolean; cloudEnabled: boolean; nextCandleConfirmEnabled: boolean; dojiMaxGapMinutes?: number },
  ): { passed: number; reasons: string[] } {
    const reasons: string[] = [];
    // ① 하드 게이트(가격대·EMA·구름) 중 놓친 것 — 꺼진 조건은 애초에 탈락 원인이 될 수 없다.
    if (!r.priceInBand) reasons.push(`가격대 벗어남 (현재가 ${r.price != null ? `$${r.price.toFixed(2)}` : "—"})`);
    if (run.emaTrendEnabled && !r.aboveEma) reasons.push("EMA200 아래");
    if (run.cloudEnabled && !r.aboveCloud) reasons.push("이치모쿠 구름 아래/속");
    // "넘은 하드게이트 수"도 꺼진 조건은 항상 통과로 친다(어차피 안 막으므로) — 정렬(근접순)에 쓰임.
    const passed =
      (r.priceInBand ? 1 : 0) + (!run.emaTrendEnabled || r.aboveEma ? 1 : 0) + (!run.cloudEnabled || r.aboveCloud ? 1 : 0);
    // ② 패턴(도지/다음봉)도 '항상' 함께 본다. [B 리뷰 반영]
    //   예전엔 하드게이트를 다 넘었을 때만 패턴을 봤는데, 그러면 "구름만 넘으면 될 것"처럼 오해를 준다.
    //   실제로는 패턴이 없으면 구름을 넘어도 후보가 안 되므로, 빠진 사유를 빠짐없이 보여 준다.
    if (r.evidence) {
      const f = r.evidence.filters;
      // 참고: 도지 판정(isBearishDoji)이 이미 위·아래 꼬리를 둘 다 강제하므로 firstDoji=true면 bothWicks도 true다
      //   (= !bothWicks 가지는 현재 도달 안 함). 기준이 나중에 갈릴 경우 대비해 방어적으로 남겨 둔다.
      if (!f.firstDoji) reasons.push("최고점 이후 음봉 도지 없음");
      else if (!f.bothWicks) reasons.push("도지에 꼬리가 한쪽만(망치형·유성형)");
      else if (f.dojiNearHigh === false) reasons.push(`도지가 최고점에서 너무 한참 뒤에 생김(${r.evidence.gapFromHighMinutes ?? "?"}분 간격 — ${run.dojiMaxGapMinutes}분 초과)`);
      else if (!f.recentDoji) reasons.push("도지 발생이 너무 오래전(20분 초과 — 신뢰 불가)");
      else if (run.nextCandleConfirmEnabled && !f.nextBearish) reasons.push("도지 다음 봉이 음봉 아님(패턴 미완성)");
    }
    // [v0.63.0] 방어 필터(이격도·기울기·변동성) 탈락 사유 — 엔진이 켜진 필터만 판정해 넣어 준다.
    for (const d of r.defenseReasons ?? []) reasons.push(d);
    // [v0.70.0] 워런트 탈락 — 패턴·하드게이트를 다 넘었어도(passed는 그대로 둠, 아래 defenseReasons와
    //   같은 원칙) 워런트 사유로 탈락했으면 그 이유를 보여준다(electron/tool-engine.ts의 applyWarrantGate).
    if (r.warrantWarning) reasons.push(r.warrantWarning);
    return { passed, reasons };
  }

  /**
   * [v0.29.0→v0.51.0] 스캔 전체에서 "none"(탈락) 종목들이 어느 조건에서 가장 많이 걸리는지 집계.
   *   [오너 지시 2026-09-25] "스크리닝 후보가 너무 안 나오는데 기준 재점검해보자 — 너무 엄격하면
   *   아예 거래가 없어". 감(느낌)으로 기준을 바꾸는 대신, 실제 스캔에서 어느 게이트가 병목인지
   *   숫자로 보여줘야 다음에 무엇을 완화할지 근거 있게 판단할 수 있다. missReasons()와 같은 판정
   *   순서(하드게이트는 각각 독립 집계, 패턴은 우선순위대로 하나만)를 그대로 재사용한다.
   *
   *   [v0.51.0 긴급 수정 — 오너 보고 "필터를 꺼도 탈락 사유 통계에 계속 잡힌다"]
   *   r.aboveEma/aboveCloud/evidence.filters.nextBearish는 electron/tool-engine.ts가 "그 조건을
   *   꺼도 지표상 실제로 어떤지는 정직하게 보여준다"는 원칙으로 넣어 둔 '원본 비교값'이다(게이트로
   *   쓸지는 별도 결정 — buildEvidence/scanScreener 주석 참고). 그런데 이 집계 함수는 그 원본값만
   *   보고 무조건 "탈락 사유"로 셌다 — 예를 들어 EMA200 필터를 꺼 둬도, 실제로는 그 조건 때문에
   *   떨어진 게 하나도 없는데 "EMA200 아래 24개"처럼 찍혀, 마치 꺼도 안 꺼진 것처럼 보이는 착시를
   *   만들었다. 이제 그 스캔(run)에서 실제로 켜져 있던 조건만 집계한다(꺼진 조건은 셀 대상에서
   *   아예 제외 — 어차피 탈락에 영향을 안 줬으므로).
   */
  function tallyMissReasons(
    results: ScreenResult[],
    run: { emaTrendEnabled: boolean; cloudEnabled: boolean; nextCandleConfirmEnabled: boolean; dojiMaxGapMinutes?: number },
  ): { label: string; count: number }[] {
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    for (const r of results) {
      if (r.status !== "none") continue;
      if (!r.priceInBand) bump("가격대 벗어남");
      if (run.emaTrendEnabled && !r.aboveEma) bump("EMA200 아래");
      if (run.cloudEnabled && !r.aboveCloud) bump("이치모쿠 구름 아래/속");
      if (r.evidence) {
        const f = r.evidence.filters;
        if (!f.firstDoji) bump("최고점 이후 음봉 도지 없음");
        else if (!f.bothWicks) bump("도지 꼬리 한쪽만(망치형 등)");
        else if (f.dojiNearHigh === false) bump(`도지가 최고점 한참 뒤(${run.dojiMaxGapMinutes}분 초과)`);
        else if (!f.recentDoji) bump("도지 발생 20분 초과(신선도 불합격)");
        else if (run.nextCandleConfirmEnabled && !f.nextBearish) bump("도지 다음 봉이 음봉 아님(패턴 미완성)");
      }
      // [v0.63.0] 방어 필터 사유는 숫자를 떼고 종류별로 집계
      for (const d of r.defenseReasons ?? []) {
        bump(d.startsWith("EMA 이격도") ? "EMA 이격도 미달" : d.startsWith("EMA가 상승") || d.startsWith("EMA 기울기") ? "EMA 상승 중 아님" : "변동성 과다/계산 불가");
      }
      // [v0.70.0] 워런트 탈락 사유도 통계에 잡는다(오너가 "어느 조건이 병목인지" 한눈에 보도록).
      if (r.warrantWarning) bump("워런트 저가 탈락");
    }
    return Object.entries(counts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }

  // -------------------------------------------------------------------------
  // [v0.7.0] 체결강도 자동 기록(매매 연동) — 목록/요약/수동청산/삭제
  // -------------------------------------------------------------------------

  /** 트레이드 목록 + 요약을 다시 읽어 화면 갱신. */
  /** [v0.19.0] 매매 사이클 자동추적·분석을 불러온다(실제 체결이력 기반). */
  async function loadAnalysis() {
    setAnalysisBusy(true);
    try {
      const a = await window.kyletool.tradeAnalysis();
      setAnalysis(a);
    } catch (e) {
      console.error("매매분석 로드 실패", e);
    } finally {
      setAnalysisBusy(false);
    }
  }

  /** 결과 행의 [근거] 펼치기/접기 토글. */
  function toggleEvid(symbol: string) {
    setOpenEvid((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  /** [v0.25.0] 결과 행의 [📈 차트] 펼치기/접기 — 처음 펼칠 때만 불러오고(온디맨드), 이후엔 캐시 재사용. */
  function toggleChart(symbol: string) {
    setOpenChart((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
    if (!chartCache[symbol] && !chartBusy.has(symbol)) void loadScreenChart(symbol);
  }

  /** 탐색 종목 차트를 불러온다(실패해도 표는 그대로 — 에러만 그 자리에 표시). */
  async function loadScreenChart(symbol: string) {
    setChartBusy((prev) => new Set(prev).add(symbol));
    setChartErr((prev) => { const { [symbol]: _drop, ...rest } = prev; return rest; });
    try {
      const chart = await window.kyletool.screenerChart(symbol);
      setChartCache((prev) => ({ ...prev, [symbol]: chart }));
    } catch (e) {
      setChartErr((prev) => ({ ...prev, [symbol]: String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, "") }));
    } finally {
      setChartBusy((prev) => { const next = new Set(prev); next.delete(symbol); return next; });
    }
  }

  /** 결과 행 클릭 → 계산기 탭에 그 종목 + [v0.16.0] 전봉종가·EMA200까지 자동으로 채운다(재입력 수고 제거).
   *   스크리너가 이미 계산에 쓴 값을 그대로 넘긴다. 값은 계산기에서 자유롭게 수정 가능. */
  function pickScreenSymbol(r: ScreenResult) {
    setSymbol(r.symbol);
    setCommittedSymbol(r.symbol);
    setTech("split3"); //             삼분할(전봉종가·EMA200 사용) 방식으로 맞춘다
    if (r.prevClose != null) setBaseClose(String(Math.round(r.prevClose * 10000) / 10000)); // 전봉종가 자동입력
    if (r.ema200 != null) setEma200(String(Math.round(r.ema200 * 10000) / 10000)); //          EMA200 자동입력
    goToTab("calc");
    void autoLoad(r.symbol); // 예수금·시세·수량 자동 로드
  }

  /** [내 삼분할 기록] 카드에서 "체결강도 보기"를 누르면 그 종목을 콕 집어 매매분석 탭에서 본다(보유 아니어도). */
  function openStrengthFor(symbol: string) {
    const sym = (symbol || "").toUpperCase().trim();
    strFocusRef.current = sym; // [리뷰 H2] 2컬럼 effect가 focus 없이 재호출해도 ref로 관찰 종목 유지
    setStrSym(sym);
    goToTab("strength");
    void loadHoldingsStrength(sym); // 보유 목록 + 이 종목(관찰)까지 자동 로드
  }

  /** 상태(미체결/체결) 필터를 바꾸면 그 상태로 주문·조건주문을 다시 불러온다. */
  async function changeOrdStatus(st: "OPEN" | "CLOSED") {
    setOrdStatus(st);
    await refreshStatusTab(st);
  }

  /** [v0.3.3] 보유 행의 [매도] — 매도 모달을 연다. 매도가능수량을 조회해 기본값으로. */
  async function openSell(row: HoldingRow) {
    let def = row.quantity;
    try {
      const q = await window.kyletool.sellable(row.symbol); // 매도가능 수량(1콜)
      if (q != null && q > 0) def = q;
    } catch {
      /* 실패해도 보유수량을 기본값으로 */
    }
    setSellModal({
      symbol: row.symbol,
      currency: row.currency,
      heldQty: def,
      orderType: "LIMIT",
      qty: String(def),
      price: row.lastPrice != null ? String(row.lastPrice) : "",
    });
  }

  /** 매도 모달 → 확인 팝업 → (사람이 눌러야) 전송. 에이전트가 자동 발사하지 않는다. */
  function submitSell() {
    if (!sellModal) return;
    const q = toNum(sellModal.qty);
    if (q === null || q <= 0) {
      alert("매도 수량을 0보다 큰 숫자로 입력하세요.");
      return;
    }
    const isLimit = sellModal.orderType === "LIMIT";
    const price = toNum(sellModal.price);
    if (isLimit && (price === null || price <= 0)) {
      alert("지정가 매도는 가격을 입력하세요. (시장가로 팔려면 '시장가'를 고르세요)");
      return;
    }
    const sym = sellModal.symbol;
    const cur = sellModal.currency;
    setSellModal(null);
    requestOrder({
      kind: "entry",
      title: `매도 — ${sym} (${isLimit ? "지정가" : "시장가"})`,
      lines: [
        `${sym} ${q}주 ${isLimit ? `지정가 ${money(price!, cur, fx)}` : "시장가"} 매도`,
        isLimit ? `그 가격 이상에서 체결됩니다.` : `현재 시세로 즉시 체결을 시도합니다(정규장).`,
        `⚠️ 실제 매도입니다. 수량·가격을 다시 확인하세요.`,
      ],
      send: () =>
        window.kyletool.placeSell({
          symbol: sym,
          quantity: q,
          orderType: sellModal.orderType,
          price: isLimit ? price! : undefined,
        }),
    });
  }

  /** [v0.3.3] 보유 행의 [익절/손절 걸기] — 이 종목으로 OCO 편집창을 연다(현재가 기준 tp/sl 제안). */
  async function openOcoForHolding(row: HoldingRow) {
    setSymbol(row.symbol);
    setCommittedSymbol(row.symbol);
    let cur = row.lastPrice;
    try {
      cur = await window.kyletool.quote(row.symbol);
      setCurPrice(cur);
      const c = await window.kyletool.capacity(row.symbol, cur ?? undefined);
      setCap(c);
    } catch {
      /* 조회 실패해도 진행 */
    }
    const t = toNum(tpPct) ?? 2;
    const l = toNum(slPct) ?? 10;
    const base = cur ?? row.lastPrice ?? 0;
    setOcoEdit({
      tp: String(roundPrice(base * (1 + t / 100))),
      sl: String(roundPrice(base * (1 - l / 100))),
      qty: String(row.quantity),
    });
  }

  /** [v0.3.0→v0.61.6] 상단 바의 실주문 토글. 켤 때만 경고 확인을 거친다(끄는 건 즉시). 상태는
   *  저장된다. [v0.61.6 — ③ 전수조사 중간-1, 오너 승인] 웹(폰)에서는 로컬(의미 없는) 엔진을
   *  직접 켜 봤자 PC의 실제 매매는 안 바뀐다 — 원격 명령으로 PC에 보낸다. */
  async function toggleLiveOrders(on: boolean) {
    if (on) {
      const ok = window.confirm(
        ["⚠️ 실주문을 활성화합니다.", "", "지금부터 주문 버튼을 누르면 실제 돈으로 주문이 전송됩니다.", "", "계속할까요?"].join("\n"),
      );
      if (!ok) return;
    }
    if (isWebApp) {
      // [v0.61.6] 결과(실제로 PC에 반영된 값)를 이 자리에서 바로 되읽어올 방법은 아직 없다
      // (saveAutoScanSettings 등과 같은 한계 — docs/progress.md v0.61.1 참고) — "보냈다"는
      // 메시지까지만 보여준다.
      const r = await window.kyletool.sendCommand("setLiveOrders", { on });
      setAutoToggleMsg(r.ok ? "✅ PC로 실주문 토글 명령을 보냈습니다." : `⚠️ ${r.message}`);
      return;
    }
    await window.kyletool.setLiveOrders(on);
    setSettings(await window.kyletool.getSettings());
    await refreshStatus();
  }

  /** [v0.3.0] 세션 시드 제안 수량을 수량칸에 넣는다(강제 아님 — 참고값을 채워줄 뿐). */
  function applySeedQty() {
    if (cap?.seedQty != null && cap.seedQty > 0) setQty(String(cap.seedQty));
  }

  /** [v0.3.0] 설정 탭에서 세션별 시드 비율/기준을 저장한다. */
  async function saveSeed() {
    const s = await window.kyletool.saveSeedSettings({
      seedDayPct: toNum(seedForm.day) ?? undefined,
      seedPrePct: toNum(seedForm.pre) ?? undefined,
      seedRegularPct: toNum(seedForm.regular) ?? undefined,
      seedBasis: seedForm.basis,
      seedFixedUsd: seedForm.basis === "fixed" ? (toNum(seedForm.fixed) ?? null) : null,
    });
    setSettings(s);
    setSavedMsg("매수 비율을 저장했습니다.");
    setTimeout(() => setSavedMsg(""), 4000);
    // 시드가 바뀌었으니 제안 수량도 즉시 갱신
    if (curPrice != null) void refreshCapacity(curPrice);
  }

  /** [v0.8.3] 기본 손익비 저장 + 계산기 익절/손절칸에 즉시 반영. */
  async function saveDefaults() {
    const tp = toNum(defForm.tp);
    const sl = toNum(defForm.sl);
    if (tp === null || tp <= 0 || sl === null || sl <= 0) {
      setSavedMsg("⚠️ 기본 익절/손절 %를 0보다 큰 숫자로 입력하세요.");
      setTimeout(() => setSavedMsg(""), 4000);
      return;
    }
    const s = await window.kyletool.saveDefaultRatio({ tpPct: tp, slPct: sl });
    setSettings(s);
    // 지금 계산기 입력칸에도 바로 반영(그때그때 수정은 여전히 가능)
    setTpPct(String(s.defaultTpPct));
    setSlPct(String(s.defaultSlPct));
    setSavedMsg(`기본 손익비 저장됨 — 익절 ${s.defaultTpPct}% / 손절 ${s.defaultSlPct}%`);
    setTimeout(() => setSavedMsg(""), 4000);
  }

  /** [v0.70.0] 자동매매 한도 설정값을 한 줄 문구로 — PC 로컬 저장 성공 메시지와, 폰에서 보는
   *  "PC 실제값" 표시가 같은 문구를 쓰게 해서(따로 두면 나중에 서로 달라질 위험) 하나로 합쳤다. */
  function describeAutoTradeLimits(s: Pick<ToolSettings,
    "autoTradeMaxPositions" | "autoTradeMaxLossPct" | "autoTradeMaxInvestPct" | "autoTradeWatchMinutes" |
    "autoTradeEntryLevel" | "autoTradeSlMode" | "autoTradeEmaStopBufferPct" | "autoTradeLossStreakLimit">): string {
    return (
      `최대 ${s.autoTradeMaxPositions}종목 · 손실한도 ${s.autoTradeMaxLossPct}% · ` +
      `투입한도 ${s.autoTradeMaxInvestPct}% · 미체결 자동취소 ${s.autoTradeWatchMinutes}분 · 진입 타점 ${s.autoTradeEntryLevel}분할 · ` +
      `손절 ${s.autoTradeSlMode === "ema" ? `EMA 기준(-${s.autoTradeEmaStopBufferPct}%)` : s.autoTradeSlMode === "fixed" ? "고정 %" : "확인 안 됨(구버전 PC)"} · ` +
      `연속손절 중지 ${s.autoTradeLossStreakLimit ? `${s.autoTradeLossStreakLimit}회` : s.autoTradeLossStreakLimit === 0 ? "끔" : "확인 안 됨(구버전 PC)"}`
    );
  }

  /** [v0.26.0→v0.42.0→v0.61.1] 자동매매 한도 4개(최대 종목 수·최대손실 한도·최대 투입
   *  비율·미체결 자동취소 기준) 저장.
   *  [v0.61.1 — ③ 전수조사에서 발견한 치명 버그 수정] 예전엔 웹(폰)에서도 이 버튼이
   *  `window.kyletool.saveAutoTradeSettings`를 **직접** 불렀다 — 폰의 로컬 엔진은
   *  PC와 완전히 별개 인스턴스라, 폰에서 "최대손실 한도를 더 엄격하게 줄였다"고 믿어도
   *  PC는 전혀 몰랐고 옛(더 느슨한) 한도로 계속 돌고 있었다. 실계좌 위험 한도라
   *  "저장됨"이라고 뜨는데 실제로 적용이 안 되는 건 치명적 — 원격 명령 큐로 보낸다. */
  async function saveAutoSettings() {
    const maxPositions = toNum(autoForm.maxPositions);
    const maxLossPct = toNum(autoForm.maxLossPct);
    const maxInvestPct = toNum(autoForm.maxInvestPct);
    const watchMinutes = toNum(autoForm.watchMinutes);
    // [v0.63.0] 방어 전략 값
    const emaStopBufferPct = toNum(defenseForm.emaStopBufferPct);
    const lossStreakLimit = toNum(defenseForm.lossStreakLimit);
    if (emaStopBufferPct === null || emaStopBufferPct < 0 || lossStreakLimit === null || lossStreakLimit < 0) {
      setSavedMsg("⚠️ EMA 손절 여유(%)와 연속 손절 횟수는 0 이상 숫자로 입력하세요(연속 손절 0 = 끔).");
      setTimeout(() => setSavedMsg(""), 4000);
      return;
    }
    const defense = { slMode: defenseForm.slMode, emaStopBufferPct, reentryBlockEnabled: defenseForm.reentryBlockEnabled, lossStreakLimit, reprotectVanished: defenseForm.reprotectVanished };
    if (
      maxPositions === null || maxPositions <= 0 ||
      maxLossPct === null || maxLossPct <= 0 ||
      maxInvestPct === null || maxInvestPct <= 0 ||
      watchMinutes === null || watchMinutes <= 0
    ) {
      setSavedMsg("⚠️ 자동매매 한도 4개 모두 0보다 큰 숫자로 입력하세요.");
      setTimeout(() => setSavedMsg(""), 4000);
      return;
    }
    if (isWebApp) {
      const r = await window.kyletool.sendCommand("saveAutoTradeSettings", { maxPositions, maxLossPct, maxInvestPct, watchMinutes, entryLevel: autoEntryLevel, ...defense });
      setSavedMsg(r.ok ? "✅ PC로 자동매매 한도 저장 명령을 보냈습니다(PC가 몇 초 안에 반영 — 아래 'PC 실제값'으로 확인하세요)." : `⚠️ ${r.message}`);
      setTimeout(() => setSavedMsg(""), 4000);
      // [v0.70.0] PC가 명령을 처리할 몇 초를 준 뒤 상태 미러를 다시 받아와 "PC 실제값"을 갱신한다
      //   (비상정지 버튼이 이미 쓰던 패턴과 동일 — 20초 정기 폴링까지 기다리지 않게).
      setTimeout(() => void refreshLiveState(), 2000);
      return;
    }
    const s = await window.kyletool.saveAutoTradeSettings({ maxPositions, maxLossPct, maxInvestPct, watchMinutes, entryLevel: autoEntryLevel, ...defense });
    setSettings(s);
    setSavedMsg(`자동매매 한도 저장됨 — ${describeAutoTradeLimits(s)}`);
    setTimeout(() => setSavedMsg(""), 4000);
  }

  // [v0.45.0] saveAutoScanSettingsUI (자동 스크리너 탭 전용 저장 버튼)는 제거했다 — 도지 몸통비율
  //   등 조건 편집은 이제 saveScreenCriteriaUI([스크리닝 기준] 탭) 한 곳으로만 한다(중복 UI 정리).

  /** [v0.70.0] "스크리닝 기준" 탭 조건 전체(약 20개)를 한 줄로 — 폰에서 "PC 실제값"을 보여줄 때 쓴다.
   *  (자동매매 한도의 describeAutoTradeLimits와 같은 목적 — PC가 지금 실제로 뭘 쓰는지 직접 확인.) */
  function describeScreenCriteria(s: ToolSettings): string {
    return (
      `스캔 ${s.autoScanCount}종목 · 가격대 $${s.autoScanPriceMin}~$${s.autoScanPriceMax} · 도지 몸통상한 ${Math.round(s.autoScanBodyRatio * 100)}% · ` +
      `EMA${s.autoScanEmaPeriod} 위 ${s.autoScanEmaTrendEnabled ? "켜짐" : "꺼짐"} · 구름 위 ${s.autoScanCloudEnabled ? "켜짐" : "꺼짐"} · ` +
      `도지 꼬리 ${(s.autoScanDojiWickMinRatio * 100).toFixed(0)}% · 신선도 ${s.autoScanDojiMaxAgeEnabled ? `${s.autoScanDojiMaxAgeMinutes}분` : "꺼짐"} · ` +
      `고점~도지 ${s.autoScanDojiMaxGapEnabled ? `${s.autoScanDojiMaxGapMinutes}분` : "꺼짐"} · ` +
      `EMA 이격도 ${s.autoScanEmaMinGapEnabled ? `${s.autoScanEmaMinGapPct}%` : "꺼짐"} · EMA 상승 ${s.autoScanEmaSlopeEnabled ? "켜짐" : "꺼짐"} · ` +
      `변동성상한 ${s.autoScanAtrFilterEnabled ? `${s.autoScanAtrMaxPct}%` : "꺼짐"} · 다음봉확인 ${s.autoScanNextCandleConfirmEnabled ? "켜짐" : "꺼짐"} · ` +
      `ETF제외 ${s.autoScanExcludeEtf ? "켜짐" : "꺼짐"} · 세션(데이/프리/본장/애프터) ` +
      `${s.autoScanDayEnabled ? "✓" : "✗"}/${s.autoScanPreEnabled ? "✓" : "✗"}/${s.autoScanRegularEnabled ? "✓" : "✗"}/${s.autoScanAfterEnabled ? "✓" : "✗"}`
    );
  }

  /** [v0.33.0] "스크리닝 기준" 탭 — 추가 8개 조건(켜짐/꺼짐 + 수치) 저장.
   *  Key Point(오너 요청): 여기서 저장한 값은 saveAutoScanSettings → autoScanEmaPeriod 등 필드로
   *  바로 들어가고, buildAutoScanOpts()가 그 필드들을 그대로 scanScreener 옵션으로 넘기므로
   *  "화면에서 끈 조건은 실제 스캔에서도 꺼진다"가 우회 경로 없이 보장된다(electron/tool-engine.ts). */
  /** [v0.37.1] 오너 지적("스크리닝 기준이 모든 항목이 없는 것 같은데") — 기존 4개(스캔종목수·
   *  가격대·도지몸통비율)도 이 탭에서 같이 저장한다(같은 state를 [자동 스크리너] 탭과 공유하므로
   *  구현은 하나, 저장 버튼만 두 군데). */
  async function saveScreenCriteriaUI() {
    const scanCount = toNum(autoScanForm.scanCount);
    const pMin = toNum(autoScanForm.priceMin);
    const pMax = toNum(autoScanForm.priceMax);
    const emaPeriod = toNum(screenCritForm.emaPeriod);
    const dojiWickMinRatio = toNum(screenCritForm.dojiWickMinRatio);
    const dojiMaxAgeMinutes = toNum(screenCritForm.dojiMaxAgeMinutes);
    const dojiMaxGapMinutes = toNum(screenCritForm.dojiMaxGapMinutes);
    const emaMinGapPct = toNum(screenCritForm.emaMinGapPct);
    const atrMaxPct = toNum(screenCritForm.atrMaxPct);
    if (
      scanCount === null || scanCount <= 0 || pMin === null || pMin < 0 || pMax === null || pMax < 0 ||
      emaPeriod === null || emaPeriod <= 0 || dojiWickMinRatio === null || dojiWickMinRatio < 0 || dojiMaxAgeMinutes === null || dojiMaxAgeMinutes <= 0 ||
      dojiMaxGapMinutes === null || dojiMaxGapMinutes <= 0 ||
      emaMinGapPct === null || emaMinGapPct <= 0 || atrMaxPct === null || atrMaxPct <= 0
    ) {
      setSavedMsg("⚠️ 스캔 종목수·가격대·EMA 기간·도지 꼬리비율·신선도(분)·고점~도지 간격(분)·이격도(%)·변동성 상한(%)을 올바른 숫자로 입력하세요.");
      setTimeout(() => setSavedMsg(""), 4000);
      return;
    }
    const criteria = {
      count: scanCount,
      priceMin: pMin,
      priceMax: pMax,
      bodyRatio: autoScanBodyRatio,
      emaTrendEnabled: screenCritForm.emaTrendEnabled,
      emaPeriod,
      cloudEnabled: screenCritForm.cloudEnabled,
      dojiWickMinRatio,
      dojiMaxAgeEnabled: screenCritForm.dojiMaxAgeEnabled,
      dojiMaxAgeMinutes,
      dojiMaxGapEnabled: screenCritForm.dojiMaxGapEnabled,
      dojiMaxGapMinutes,
      emaMinGapEnabled: screenCritForm.emaMinGapEnabled,
      emaMinGapPct,
      emaSlopeEnabled: screenCritForm.emaSlopeEnabled,
      atrFilterEnabled: screenCritForm.atrFilterEnabled,
      atrMaxPct,
      nextCandleConfirmEnabled: screenCritForm.nextCandleConfirmEnabled,
      excludeEtf: screenCritForm.excludeEtf,
      dayEnabled: screenCritForm.dayEnabled,
      preEnabled: screenCritForm.preEnabled,
      regularEnabled: screenCritForm.regularEnabled,
      afterEnabled: screenCritForm.afterEnabled,
    };
    // [v0.61.1 — ③ 전수조사에서 발견한 치명 버그 수정] 예전엔 웹(폰)에서도 이 버튼이
    //   `window.kyletool.saveAutoScanSettings`를 직접 불렀다 — 폰의 로컬 엔진에만 저장되고
    //   PC는 전혀 몰랐다(원격 명령 화이트리스트에 애초에 없었음 — 마이그레이션
    //   20261001110000으로 추가). "저장됨" 화면만 보고 실제 스캔 조건이 안 바뀐 걸
    //   믿게 만드는 상태 불일치였다. 폰 응답은 즉시 오지 않으므로(PC가 몇 초 뒤 처리)
    //   clamp된 값으로 입력칸을 되맞추는 건 PC 로컬에서만 한다.
    if (isWebApp) {
      const r = await window.kyletool.sendCommand("saveAutoScanSettings", criteria);
      setSavedMsg(r.ok ? "✅ PC로 스크리닝 기준 저장 명령을 보냈습니다(PC가 몇 초 안에 반영 — 아래 'PC 실제값'으로 확인하세요)." : `⚠️ ${r.message}`);
      setTimeout(() => setSavedMsg(""), 4000);
      // [v0.70.0] 비상정지 버튼과 같은 패턴 — PC가 처리할 몇 초를 준 뒤 상태 미러를 다시 받아온다.
      setTimeout(() => void refreshLiveState(), 2000);
      return;
    }
    const s = await window.kyletool.saveAutoScanSettings(criteria);
    setSettings(s);
    // 저장 직후 입력칸을 서버가 실제로 보정한 값(clamp 결과)으로 다시 맞춘다 — 예: 500분을
    // 넣었어도 서버가 180분으로 잘랐으면 화면도 180으로 보여야 헷갈리지 않는다.
    setAutoScanForm({ scanCount: String(s.autoScanCount), priceMin: String(s.autoScanPriceMin), priceMax: String(s.autoScanPriceMax) });
    setAutoScanBodyRatio(s.autoScanBodyRatio);
    setScreenCritForm({
      emaTrendEnabled: s.autoScanEmaTrendEnabled,
      emaPeriod: String(s.autoScanEmaPeriod),
      cloudEnabled: s.autoScanCloudEnabled,
      dojiWickMinRatio: String(s.autoScanDojiWickMinRatio),
      dojiMaxAgeEnabled: s.autoScanDojiMaxAgeEnabled,
      dojiMaxAgeMinutes: String(s.autoScanDojiMaxAgeMinutes),
      dojiMaxGapEnabled: s.autoScanDojiMaxGapEnabled ?? true,
      dojiMaxGapMinutes: String(s.autoScanDojiMaxGapMinutes ?? 30),
      emaMinGapEnabled: s.autoScanEmaMinGapEnabled ?? false,
      emaMinGapPct: String(s.autoScanEmaMinGapPct ?? 6),
      emaSlopeEnabled: s.autoScanEmaSlopeEnabled ?? false,
      atrFilterEnabled: s.autoScanAtrFilterEnabled ?? false,
      atrMaxPct: String(s.autoScanAtrMaxPct ?? 3),
      nextCandleConfirmEnabled: s.autoScanNextCandleConfirmEnabled,
      excludeEtf: s.autoScanExcludeEtf,
      dayEnabled: s.autoScanDayEnabled,
      preEnabled: s.autoScanPreEnabled,
      regularEnabled: s.autoScanRegularEnabled,
      afterEnabled: s.autoScanAfterEnabled,
    });
    setSavedMsg("스크리닝 기준 저장됨 — 다음 자동 스캔부터(또는 [자동 스크리너] 탭의 [🔄 지금 새로고침]으로 즉시) 반영돼요.");
    setTimeout(() => setSavedMsg(""), 4000);
  }

  /**
   * [v0.28.0→v0.39.0→v0.60.5→v0.60.6] 자동매매 스크리너 수동 새로고침 — 5분 사이클을
   *   기다리지 않고 지금 바로 훑는다. 자동매매가 켜져 있으면 실제 진입 시도까지 그대로
   *   도는 진짜 사이클이고(엔진의 autoScanNow 참고 — 5분 주기 자체는 유지, 기준 시각만
   *   지금으로 당김), 꺼져 있으면 예전 그대로 미리보기(스캔만, 진입 없음)다.
   *   [v0.60.5→v0.60.6] 웹에서 토스 중계(QR)가 없으면 autoScanNow가 직접 스캔(실제 토스
   *   호출)을 시도해 항상 실패한다 — 대신 PC에 "지금 스캔해" 원격 명령을 보내고, 결과가
   *   올라올 때까지 기다린다. [v0.60.6 긴급 수정] v0.60.5는 5초·15초 뒤 딱 두 번만
   *   확인하고 끝냈는데, 실제 스캔(기본 60종목)은 목서버 기준으로도 70초 넘게 걸린다 —
   *   너무 일찍 포기해 "눌러도 무반응"으로 보였다(게다가 pull 직후 재전송 순서 버그까지
   *   겹쳐 있었다 — syncPullAutoState 주석 참고, 둘 다 이번에 같이 고쳤다). 이제 "스캔
   *   시작 전 마지막 스캔 시각"과 다른(=새로운) scannedAt이 나타날 때까지 10초 간격으로
   *   최대 3분간 계속 확인하고, 그동안 화면에 "PC가 스캔 중…"을 계속 보여준다.
   */
  async function refreshAutoScanNow() {
    if (autoScanBusy) return;
    setAutoScanBusy(true);
    try {
      if (!canReconcileLive) {
        if (!pcConnected) { setAutoToggleMsg("⚠️ PC가 꺼져 있어 지금 스캔을 요청할 수 없습니다."); return; }
        const priorScannedAt = autoStatus?.lastScan?.scannedAt ?? null;
        await window.kyletool.sendCommand("autoScanNow").catch(() => {});
        const maxAttempts = 18; // 10초 × 18 = 최대 3분
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 10_000));
          const s = await refreshLiveState();
          if (s?.lastScan && s.lastScan.scannedAt !== priorScannedAt) return; // 새 스캔 결과 도착 — 완료
        }
        setAutoToggleMsg("⚠️ 3분 안에 새 스캔 결과를 못 받았습니다 — PC가 아직 스캔 중이거나 연결이 느릴 수 있습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setAutoStatus(await window.kyletool.autoScanNow());
    } finally {
      setAutoScanBusy(false);
    }
  }

  /**
   * [v0.26.0→v0.60.4] 자동매매 시작/중지 버튼. 시작은 확인 팝업으로 한 번 더 의사를 묻는다
   *   (실계좌라 신중하게).
   *   [v0.60.4 — 오너 실사용 보고 "폰에서 일반 버튼으로 쓰고 싶다, 원격 버튼 말고"] 웹(폰)
   *   세션에서는 이 버튼이 직접 토스를 호출하는 로컬 엔진(의미 없음 — 폰엔 토스 연결이
   *   없다)이 아니라, PC가 집어가 실행하는 원격 명령 큐로 보낸다(원격 조종 카드와 완전히
   *   같은 경로 — 예전엔 폰 전용 "원격" 카드를 따로 찾아 눌러야 했다). 결과는 즉시 알 수
   *   없고(PC가 몇 초 안에 실행) PC가 보낸 생존 신호(heartbeat)의 auto_trade_enabled로
   *   나중에 확인되므로, 보내고 나서 하트비트를 앞당겨 다시 확인한다.
   */
  async function toggleAutoTrade() {
    if (autoBusy) return;
    setAutoBusy(true);
    setAutoToggleMsg("");
    try {
      if (isWebApp) {
        const wantStop = effectiveAutoEnabled;
        if (!wantStop) {
          const ok = window.confirm(
            [
              "🤖 PC에 자동매매 시작 명령을 보냅니다.",
              "",
              `PC(데스크톱 앱)가 켜져 있는 동안, 5분마다 스스로 탐색해 합격 종목을 최대 ${autoForm.maxPositions}종목까지`,
              "삼분할 매매기법의 '1분할' 타점으로 자동 매수하고, 체결되면 익절/손절까지 자동으로 겁니다.",
              `최대손실 한도(시드 대비 ${autoForm.maxLossPct}%)에 닿으면 스스로 멈춥니다.`,
              "",
              "⚠️ PC를 끄면 자동매매도 함께 멈춥니다. 계속할까요?",
            ].join("\n"),
          );
          if (!ok) return;
        }
        const r = await window.kyletool.sendCommand(wantStop ? "autoTradeStop" : "autoTradeStart");
        setAutoToggleMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
        // PC 루프 주기(8초)보다 조금 넉넉하게 두 번 다시 확인해 "켜짐/꺼짐" 표시를 앞당긴다.
        for (const delayMs of [4000, 10000]) {
          setTimeout(() => {
            void window.kyletool.getDesktopHeartbeat()
              .then((hb) => { setPcLastSeenMs(hb.lastSeenMs); setPcAutoTradeEnabled(hb.autoTradeEnabled); setPcAppVersion(hb.pcAppVersion); })
              .catch(() => {});
          }, delayMs);
        }
        return;
      }
      if (autoStatus?.enabled) {
        setAutoStatus(await window.kyletool.autoTradeStop());
        return;
      }
      const ok = window.confirm(
        [
          "🤖 자동매매를 시작합니다.",
          "",
          `이 프로그램이 켜져 있는 동안, 5분마다 스스로 탐색해 합격 종목을 최대 ${autoForm.maxPositions}종목까지`,
          "삼분할 매매기법의 '1분할' 타점으로 자동 매수하고, 체결되면 익절/손절까지 자동으로 겁니다.",
          `최대손실 한도(시드 대비 ${autoForm.maxLossPct}%)에 닿으면 스스로 멈춥니다.`,
          "",
          "⚠️ 이 창(앱)을 끄면 자동매매도 함께 멈춥니다. 계속할까요?",
        ].join("\n"),
      );
      if (!ok) return;
      setAutoStatus(await window.kyletool.autoTradeStart());
      // [v0.32.5 — 오너 요청] "자동매매 시작"을 누르면 자동 스크리너 탭의 [🔄 지금 새로고침]도
      // 실제로 눌린 것처럼 바로 스캔이 돌아야 한다. 엔진 안에서도 시작 즉시 첫 스캔이 돌긴
      // 하지만(백그라운드 5분 사이클의 1회차), 화면(특히 자동 스크리너 탭)에 바로 "지금
      // 스캔 중"이 보이지 않으면 오너가 "진짜 도는 건가?"를 확인할 길이 없었다 — 같은 버튼이
      // 쓰는 함수를 그대로 재사용해 눌림 상태·진행률·결과가 즉시 화면에 반영되게 한다.
      void refreshAutoScanNow();
    } finally {
      setAutoBusy(false);
      void window.kyletool.journal().then(setJournal);
    }
  }

  /** [v0.8.1] 로그인 상태 새로고침. 운영자면 대기 중인 가입 승인 요청도 함께 불러온다. */
  async function refreshAuth() {
    try {
      const s = await window.kyletool.authStatus();
      setAuthState(s);
      if (s.isOwner) {
        void loadAccessRequests();
        void loadPendingAccounts(); // [v0.59.0] 진짜 게이트(capri_accounts) 대기 목록
        void loadNotifySettings();
      }
    } catch {
      /* 무시 — 아래 finally가 authChecked는 반드시 true로 만든다(무한 로딩 방지) */
    } finally {
      setAuthChecked(true);
    }
  }
  /** [v0.24.0][운영자 전용] 대기 중인 가입 승인 요청 목록을 다시 불러온다. */
  async function loadAccessRequests() {
    try {
      setAccessRequests(await window.kyletool.listAccessRequests());
    } catch {
      /* 무시 */
    }
  }
  async function doSignIn() {
    if (!authEmail || !authPw) { setAuthMsg("⚠️ 이메일과 비밀번호를 입력하세요."); return; }
    setSyncBusy(true); setAuthMsg("로그인 중…"); setCanRequestAccess(false); setReqMsg("");
    try {
      const r = await window.kyletool.authSignIn(authEmail, authPw);
      setAuthMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) { setAuthPw(""); await refreshAuth(); }
    } finally { setSyncBusy(false); }
  }
  async function doSignUp() {
    if (!authEmail || authPw.length < 6) { setAuthMsg("⚠️ 이메일과 6자 이상 비밀번호를 입력하세요."); return; }
    setSyncBusy(true); setAuthMsg("가입 요청 중…"); setCanRequestAccess(false); setReqMsg("");
    try {
      const r = await window.kyletool.authSignUp(authEmail, authPw);
      setAuthMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      setCanRequestAccess(!!r.canRequestAccess);
      if (r.ok && !r.needsConfirm) { setAuthPw(""); await refreshAuth(); }
    } finally { setSyncBusy(false); }
  }
  async function doSignOut() {
    await window.kyletool.authSignOut();
    setAuthMsg(""); setSyncMsg(""); setAccessRequests([]);
    await refreshAuth();
  }
  /** [v0.24.0] 가입이 막힌 사람이 "승인해 주세요" 요청을 접수한다(로그인 불필요). */
  async function doRequestAccess() {
    if (!authEmail) { setReqMsg("⚠️ 이메일을 먼저 입력하세요."); return; }
    setReqBusy(true); setReqMsg("신청 접수 중…");
    try {
      const r = await window.kyletool.requestAccess(authEmail);
      setReqMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) setCanRequestAccess(false); // 접수됐으면 버튼은 다시 안 보여도 됨
    } finally { setReqBusy(false); }
  }
  /** [v0.24.0][운영자 전용] 요청을 승인 — 허용목록에 추가되고 그 사람은 바로 가입할 수 있게 된다.
   *  [v0.60.0] 결과 메시지는 이 카드에 이미 있는 directAddMsg를 그대로 재사용한다(저 멀리
   *  [설정] 탭에만 보이던 syncMsg 대신 — "무반응처럼 보인다" 계열 버그 일괄 수정). */
  async function doApproveRequest(email: string) {
    setReqActionBusy(email);
    setDirectAddMsg("");
    try {
      const r = await window.kyletool.approveAccessRequest(email);
      setDirectAddMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) await loadAccessRequests();
    } catch (e) {
      setDirectAddMsg(`⚠️ 요청 자체가 실패했습니다(${e instanceof Error ? e.message : String(e)}).`);
    } finally { setReqActionBusy(null); }
  }
  /** [v0.24.0][운영자 전용] 요청 거절(허용목록에는 추가 안 함). */
  async function doRejectRequest(email: string) {
    setReqActionBusy(email);
    setDirectAddMsg("");
    try {
      const r = await window.kyletool.rejectAccessRequest(email);
      setDirectAddMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) await loadAccessRequests();
    } catch (e) {
      setDirectAddMsg(`⚠️ 요청 자체가 실패했습니다(${e instanceof Error ? e.message : String(e)}).`);
    } finally { setReqActionBusy(null); }
  }
  /** [v0.53.0][운영자 전용] 대기 목록에 없어도(요청이 아예 안 남았거나, 미리 등록해 두고
   *   싶을 때) 오너가 이메일을 직접 입력해 바로 허용목록에 추가한다. approveAccessRequest는
   *   원래도 임의 이메일을 받아들이므로(그 이메일로 남은 대기 요청이 있으면 함께 처리됨),
   *   엔진을 새로 건드릴 필요 없이 화면에 입력칸만 더한다. */
  async function doDirectAddEmail() {
    const e = directAddEmail.trim();
    if (!e || !e.includes("@")) { setDirectAddMsg("⚠️ 올바른 이메일을 입력하세요."); return; }
    setDirectAddBusy(true); setDirectAddMsg("등록 중…");
    try {
      const r = await window.kyletool.approveAccessRequest(e);
      setDirectAddMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) { setDirectAddEmail(""); await loadAccessRequests(); }
    } finally { setDirectAddBusy(false); }
  }

  // --------------------------------------------------------------------------
  // [v0.59.0] 로그인 게이트(capri_accounts) — 진짜 승인 대기 목록. 가입은 항상 성공하고,
  //   승인 전엔 여기 쌓인다. 승인/거절하면 DB 트리거가 capri_allowed_emails도 자동으로
  //   맞춰 주므로(그룹 채팅·근황 공유 계속 정상 동작), 화면은 이 두 함수만 부르면 된다.
  // --------------------------------------------------------------------------
  /** [운영자 전용] 대기 계정 목록을 다시 불러온다. */
  async function loadPendingAccounts() {
    try {
      setPendingAccounts(await window.kyletool.listPendingAccounts());
    } catch {
      /* 무시 */
    }
  }
  // [v0.60.0] 이 카드 전용 메시지(저 멀리 [설정] 탭에만 보이던 syncMsg 대신).
  const [pendingDecideMsg, setPendingDecideMsg] = useState("");
  async function doDecideAccount(userId: string, decision: "approved" | "rejected") {
    setPendingActionBusy(userId);
    setPendingDecideMsg("");
    try {
      const r = await window.kyletool.decideAccount(userId, decision);
      setPendingDecideMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) await loadPendingAccounts();
    } catch (e) {
      setPendingDecideMsg(`⚠️ 요청 자체가 실패했습니다(${e instanceof Error ? e.message : String(e)}).`);
    } finally { setPendingActionBusy(null); }
  }

  // --------------------------------------------------------------------------
  // [v0.59.0] 디스코드 알림 설정(운영자 전용) — 새 가입 대기가 생기면 이 주소로 DB가 직접 쏜다.
  // --------------------------------------------------------------------------
  async function loadNotifySettings() {
    try {
      const s = await window.kyletool.getNotifySettings();
      setDiscordWebhook(s.discordWebhookUrl ?? "");
    } catch {
      /* 무시 */
    }
  }
  async function doSaveDiscordWebhook() {
    setDiscordSaveBusy(true); setDiscordMsg("저장 중…");
    try {
      const r = await window.kyletool.saveNotifySettings(discordWebhook);
      setDiscordMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
    } finally { setDiscordSaveBusy(false); }
  }

  // --------------------------------------------------------------------------
  // [v0.59.0→v0.60.0] 소셜 로그인(구글만 — 카카오는 오너 요청으로 제거). Supabase에
  //   provider가 아직 안 켜져 있으면 오류 메시지가 그대로 뜬다(설정은 오너가 Supabase
  //   대시보드에서 해야 한다 — README 참고).
  // --------------------------------------------------------------------------
  async function doOAuth(provider: "google") {
    setOauthBusy(provider);
    setAuthMsg("구글 로그인 창을 여는 중…");
    try {
      const r = await window.kyletool.authOAuth(provider);
      setAuthMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) await refreshAuth();
    } finally {
      setOauthBusy(null);
    }
  }

  /**
   * [v0.24.0] 로그인 비밀번호로 클라우드에서 토스 키·매매 이력을 다시 받아온다.
   *   로그인하는 순간 이미 자동으로 한 번 실행되므로, 평소엔 이 버튼을 쓸 일이 없다.
   *   다른 기기에서 방금 키를 새로 저장했을 때 등, "지금 바로 반영하고 싶을 때"만 누른다.
   */
  async function doSyncNow() {
    setSyncBusy(true); setSyncMsg("클라우드에서 받아오는 중…");
    try {
      const rKeys = await window.kyletool.syncPullKeys();
      const rTrades = await window.kyletool.tradeSyncPull();
      // [v0.31.0] 자동매매 기록(포지션+이력)도 함께 — 다른 기기에서 진입한 것도 여기서 받아온다.
      const rAuto = await window.kyletool.autoStateSyncPull();
      // [v0.61.7 — ③ 전수조사 중간-2] 삼분할 타점 기록도 같이 받아온다.
      const rSplits = await window.kyletool.splitsSyncPull?.().catch(() => null);
      setSyncMsg([rKeys.message, rTrades.message, rAuto.message, rSplits?.message].filter(Boolean).join(" "));
      if (rKeys.ok) {
        const s = await window.kyletool.getSettings(); setSettings(s); setFormMode(s.mode); setFormAccount(s.account);
        await refreshStatus();
      }
      if (rTrades.ok) void loadReport();
      if (rAuto.ok) void window.kyletool.autoTradeStatus().then(setAutoStatus);
      if (rSplits?.ok) void refreshSplits();
    } finally { setSyncBusy(false); }
  }

  async function saveSettings() {
    const s = await window.kyletool.saveSettings({
      mode: formMode,
      clientId: formId || undefined,
      clientSecret: formSecret || undefined,
      account: formAccount,
    });
    setSettings(s);
    setFormId("");
    setFormSecret("");
    setSavedMsg("저장되었습니다.");
    setTimeout(() => setSavedMsg(""), 4000);
    await refreshStatus();
  }

  if (!status) return <div className="loading">Capri 매매도구를 불러오는 중…</div>;
  const isMock = status.mode === "mock";
  // [v0.56.0] "서버 로그" 탭 — 카테고리 토글이 비어 있으면 전체, 아니면 고른 것만(최신이 위).
  const filteredJournal = (journalCategoryFilter.size === 0 ? journal : journal.filter((j) => journalCategoryFilter.has(j.category ?? "시스템")))
    .slice()
    .reverse();

  // ===========================================================================
  // [v0.59.0] 로그인 게이트 — "카프리를 켜면 로그인 화면이 먼저 나온다" (오너 요청)
  // ---------------------------------------------------------------------------
  // 예전엔 로그인이 [설정] 탭 안에 묻힌 선택 사항이었다(안 해도 계산기 등 본 화면이
  // 그냥 떴다). 이제 로그인 여부·승인 상태를 앱을 켜자마자 확인해서, 그 결과에 따라
  // "확인 중" → "로그인/가입" → "승인 대기" → "본 화면" 순서로만 넘어간다.
  //
  // [화면 차단은 UX일 뿐 — 진짜 차단은 서버가 한다] accountStatus가 "unknown"이면
  // (오프라인 등으로 조회 실패) 절대 막지 않는다 — 이미 로그인된 사람을 네트워크
  // 문제로 잠그면 안 된다(실계좌 앱). 대신 마이그레이션(20260930120000)의 RLS가
  // 실제 데이터 접근을 서버에서 막으므로, 화면이 잘못 판단해도 안전은 그대로 유지된다.
  // ===========================================================================
  if (!authChecked) {
    return (
      <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <p className="hint">확인 중…</p>
      </div>
    );
  }

  if (!authState.loggedIn) {
    return (
      <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16 }}>
        <section className="card" style={{ maxWidth: 420, width: "100%" }}>
          <h2>🧮 Capri 로그인</h2>
          <p className="hint">
            로그인하면 바로 시작됩니다 — 토스 키·매매 이력은 로그인 즉시 자동으로 이 기기와 동기화돼요.
            처음이면 아래에서 가입하세요(운영자 승인 후 쓸 수 있습니다).
          </p>
          <div className="form-col">
            <label>이메일
              <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <label>비밀번호(6자+)
              <input
                type="password"
                value={authPw}
                onChange={(e) => setAuthPw(e.target.value)}
                placeholder="계정 비밀번호"
                onKeyDown={(e) => { if (e.key === "Enter") void doSignIn(); }}
              />
            </label>
          </div>
          <div className="form-row">
            <button className="btn btn-start" disabled={syncBusy} onClick={doSignIn}>로그인</button>
            <button className="btn" disabled={syncBusy} onClick={doSignUp}>가입(처음이면)</button>
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <button className="btn" disabled={oauthBusy !== null} onClick={() => void doOAuth("google")}>
              {oauthBusy === "google" ? "여는 중…" : "G 구글로 로그인"}
            </button>
          </div>
          {canRequestAccess && (
            <div className="form-row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={reqBusy} onClick={doRequestAccess}>📮 승인 요청 남기기</button>
            </div>
          )}
          {authMsg && <p className={authMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{authMsg}</p>}
          {reqMsg && <p className={reqMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{reqMsg}</p>}
          <p className="hint small">
            💡 가입하면 즉시 사용할 수 있는 건 아니에요 — 운영자 승인 후 바로 쓸 수 있게 됩니다.
          </p>
        </section>
      </div>
    );
  }

  if (!authState.isOwner && authState.accountStatus === "pending") {
    return (
      <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16 }}>
        <section className="card" style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
          <h2>⏳ 승인 대기 중</h2>
          <p className="hint">
            <b>{authState.email}</b> 계정으로 가입됐습니다. 운영자 승인 후 바로 쓸 수 있어요
            — 운영자에게는 이미 알림이 갔습니다.
          </p>
          <div className="form-row" style={{ justifyContent: "center" }}>
            <button className="btn" onClick={() => void refreshAuth()}>🔄 지금 확인</button>
            <button className="btn" onClick={doSignOut}>로그아웃</button>
          </div>
        </section>
      </div>
    );
  }

  if (!authState.isOwner && authState.accountStatus === "rejected") {
    return (
      <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 16 }}>
        <section className="card" style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
          <h2>🚫 사용이 거절되었습니다</h2>
          <p className="hint"><b>{authState.email}</b> 계정은 운영자가 사용을 거절했습니다.</p>
          <button className="btn" onClick={doSignOut}>로그아웃</button>
        </section>
      </div>
    );
  }

  return (
    <div className="app">
      {/* ===== 상단바 ===== */}
      <header className="topbar">
        <div className="brand">
          <span className="logo">🧮</span>
          <h1>Capri 매매도구</h1>
          {/* [v0.9.7] 웹앱(폰)에는 연습 서버가 없다 → '연습 모드'는 사실상 "키 없음"이다.
              그대로 두면 기능이 막힌 것처럼 보여서, 웹에서는 할 일을 알려 주는 표기로 바꾼다. */}
          <span className={`badge ${isMock ? "badge-dry" : "badge-live"}`}>
            {isMock ? (isWebApp ? "키 설정 필요" : "연습") : "실서버"}
            {isMock && !isWebApp && <span className="wide-only"> 모드 (가짜 서버)</span>}
            {isMock && isWebApp && <span className="wide-only"> — 설정 탭에서 키 불러오기</span>}
          </span>
          {status.dryRun ? (
            <span className="badge badge-dry" title="지금은 주문이 잠겨 있어요. 주문 버튼을 눌러도 실제로는 안 나가고 연습 기록만 남습니다.">
              🔒 주문 잠금<span className="wide-only"> (연습만)</span>
            </span>
          ) : (
            <span className="badge badge-liveorder" title="실제 돈으로 주문이 전송되는 상태입니다">
              🔴 실주문<span className="wide-only"> 활성 — 실제 체결됩니다</span>
            </span>
          )}
          {/* [v0.8.4] 장 상태 배지 — 휴장(주말·미국 공휴일)이면 이유와 다음 개장까지 알려 준다.
              (예전에는 시각만 보고 판정해서 일요일 새벽에도 "데이마켓"이라고 떴다) */}
          {status.closedReason ? (
            <span className="badge badge-dry">
              휴장 — {status.closedReason}
              {status.nextOpenNote && <span className="wide-only"> · 다음 개장 {status.nextOpenNote}</span>}
            </span>
          ) : (
            <span className="badge">
              {SESSION_LABEL[status.session]}
              <span className="wide-only"> · 3개 장 모두 주문 가능</span>
              {status.earlyClose && ` · ⚠ 조기폐장(${status.earlyClose})`}
            </span>
          )}
          {status.orderFrozen && (
            <span className="badge badge-dry">
              ⚠ 마감 1분 전<span className="wide-only">: 지금은 주문 정정·취소가 안 돼요</span>
            </span>
          )}
          {/* [v0.59.0] PC 생존 신호 — "항상 표시"(오너 지시). PC 꺼진 줄 모르고 원격 버튼을
              눌러놓고 됐다고 착각하는 사고를 막는 게 목적이라, 눈에 띄는 색으로 항상 띄운다. */}
          <span
            className={`badge ${pcConnected ? "badge-live" : "badge-dry"}`}
            title={pcConnected ? "PC(데스크톱 앱)가 켜져 있어 원격 명령이 실행됩니다." : "PC가 꺼져 있거나 로그인 전이라 원격 명령이 실행되지 않습니다."}
          >
            {pcConnected ? "🟢 PC 연결됨" : "🔴 PC 꺼져 있음"}
          </span>
          {/* [v0.60.9 — 오너 실사용 보고 "폰에서 시작을 눌러도 자동 스크리너가 안 뜸"의
              진짜 원인] "자동매매가 켜져 있으면 PC는 절대 재시작(=업데이트 적용) 안 함"
              안전장치 때문에, PC가 몇 시간째 옛 버전을 그대로 돌릴 수 있다 — 겉보기엔
              "연결됨"이라 다 됐나 싶지만 실제로는 새 기능이 아직 없는 옛 코드다. 폰에서
              PC 버전과 지금 이 화면(appVer) 버전을 바로 대조해, 다르면 바로 보이게 한다. */}
          {isWebApp && pcConnected && pcAppVersion && appVer && pcAppVersion !== appVer && (
            <span className="badge badge-dry" title="PC가 자동매매를 켜 둔 채라 재시작(업데이트 적용)을 못 하고 있을 수 있습니다 — 자동매매를 끄면 PC가 유휴 상태를 거쳐 스스로 최신 버전으로 업데이트합니다.">
              ⚠️ PC 버전 다름(PC: v{pcAppVersion} / 이 화면: v{appVer})
            </span>
          )}
          {/* [v0.61.0 — 오너 지시 "폰 화면에 마지막 갱신 시각을 표시해라"] 상태 미러
              (capri_live_state)에서 받은 값이 언제 적힌 건지 — 멈춘 건지 원래 이 상태인지
              구분할 수 있게. canReconcileLive(=토스 직접 연결)면 이 화면 자체가 실시간이라
              따로 보일 필요 없다. */}
          {!canReconcileLive && (
            <span
              className="badge badge-dry"
              title="PC가 capri_live_state에 마지막으로 상태를 올린 시각입니다. 너무 오래전이면 PC가 꺼져 있거나 멈췄을 수 있습니다."
            >
              {liveStateUpdatedAtMs != null
                ? `🕒 마지막 갱신 ${new Date(liveStateUpdatedAtMs).toLocaleTimeString("ko-KR", { hour12: false })}`
                : "🕒 아직 못 받음"}
            </span>
          )}
        </div>

        <div className="controls">
          {/* [v0.15.0] 2컬럼 토글 — 넓은 화면에서만 보인다. 켜면 좌/우 두 탭을 나란히 본다. */}
          {isWide && (
            <button
              className={`btn ${twoCol ? "twocol-on" : ""}`}
              title="넓은 화면에서 두 탭을 좌우로 나란히 봅니다(예: 계산기 + 체결강도)"
              onClick={() => { if (twoCol) setTab(tabL); /* 1컬럼으로 돌아갈 때 왼쪽 패널 탭을 이어서 본다(stale 방지) */ setTwoCol((v) => !v); }}
            >
              {twoCol ? "🔲 한 화면" : "🔳 두 화면"}
            </button>
          )}
          <button
            className={`btn btn-kill ${effectiveKillSwitch ? "kill-on" : ""}`}
            title={
              isWebApp
                ? "비상 정지 버튼이에요. PC에 원격 명령으로 전달돼 PC의 실제 매매를 멈춥니다(이 세션 자체엔 멈출 매매가 없어요)."
                : "비상 정지 버튼이에요. 켜면 새 주문이 막히고, 아직 안 나간 주문·조건주문을 모두 취소합니다(계산·조회는 그대로 됩니다)."
            }
            onClick={async () => {
              const turningOn = !effectiveKillSwitch;
              if (
                turningOn &&
                !window.confirm(
                  ["🛑 비상 정지를 켭니다.", "", "지금부터 새 주문이 막히고, 아직 체결 안 된 주문과 조건주문을 모두 취소합니다.", "", "계속할까요?"].join("\n"),
                )
              )
                return;
              setBusy(true);
              try {
                // [v0.61.2 — ② 전수조사에서 발견한 치명 버그 수정] 웹(폰)에서는 로컬 엔진을
                //   직접 켜 봤자 PC의 실제 매매에 아무 영향이 없다 — 원격 명령으로 PC에 보낸다
                //   (원격 조종 카드의 비상정지 버튼과 완전히 같은 경로로 통일).
                if (isWebApp) {
                  const r = await window.kyletool.sendCommand("setKillSwitch", { on: turningOn });
                  if (!r.ok) alert(`비상 정지 명령을 PC로 보내지 못했습니다: ${r.message}`);
                  setTimeout(() => void refreshLiveState(), 2000);
                } else {
                  await window.kyletool.setKillSwitch(turningOn);
                  if (isTabVisible("orders")) await refreshStatusTab();
                }
              } finally {
                setBusy(false);
              }
              refreshStatus();
            }}
          >
            {effectiveKillSwitch ? "🔴 비상 정지 중" : "🛑 비상 정지"}
          </button>
        </div>
      </header>

      {/* [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST, 또는 휴장) 배너 — 탭·자동매매 켜짐 여부와
          무관하게 항상 보인다(수동 도구도 이 시간대엔 막히므로 오너가 항상 알 수 있어야 함). */}
      {systemPause?.paused && (
        <div className="ticker-row">
          <div className="topbar-ticker pause-banner" title="이 시간대엔 스크리닝·수동 주문·자동매매 신규 진입이 모두 막힙니다(취소·조회는 그대로 됩니다).">
            <span className="tk-bot">⏸</span>
            <span>{systemPause.reason}</span>
            {systemPause.resumesAtMs != null && (
              <span className="tk-status">
                재개 {new Date(systemPause.resumesAtMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} KST
              </span>
            )}
          </div>
        </div>
      )}

      {/* [v0.30.0→v0.40.0] 오너 요청 — "어떤 탭에서든" 자동매매 보유종목의 수익률·금액·현황을
          로테이션으로. [v0.40.0] 예전엔 상단바(.topbar)의 브랜드 배지 줄과 킬스위치 버튼 사이에
          끼워 넣었는데, 데스크톱 창 너비에 따라 [비상 정지] 버튼과 겹쳐 보이는 문제가 있었다
          (좁은 화면 전용으로만 "자기 줄로 내리기"가 돼 있었음 — 오너 스크린샷으로 확인).
          아예 처음부터 상단바 전체 너비를 쓰는 별도 줄로 빼서, 창 너비와 무관하게 다른 요소와
          절대 안 겹치게 했다. */}
      {autoStatus?.enabled && autoStatus.positions.length > 0 && (() => {
        const positions = autoStatus.positions;
        const idx = tickerIdx % positions.length;
        const p = positions[idx];
        const hRow = autoPosHold.find((h) => h.symbol === p.symbol);
        const statusLabel = p.status === "active" ? "익절/손절 등록됨" : "매수 체결 대기중";
        return (
          <div className="ticker-row">
            <div className="topbar-ticker" title="자동매매로 보유 중인 종목을 돌아가며 보여줍니다(수익률·평가손익·상태)">
              <span className="tk-bot">🤖</span>
              <span className="tk-sym" key={p.symbol}>{p.symbol}</span>
              {hRow?.pnlRate != null ? (
                <span className={`tk-pnl ${pnlClass(hRow.pnlRate)}`}>
                  {hRow.pnlRate >= 0 ? "+" : ""}{hRow.pnlRate.toFixed(2)}%
                  {hRow.pnlAmt != null && <span className="tk-amt"> ({hRow.pnlAmt >= 0 ? "+" : ""}${hRow.pnlAmt.toFixed(2)})</span>}
                </span>
              ) : (
                <span className="tk-pnl hint">—</span>
              )}
              <span className="tk-status">{statusLabel}</span>
              {positions.length > 1 && (
                <span className="tk-dots">
                  {positions.map((_, i) => <i key={i} className={i === idx ? "on" : ""} />)}
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* ===== 탭 2단(2컬럼일 땐 숨김 — 각 패널의 드롭다운으로 탭을 고른다) =====
          [v0.27.0] 1단: 매매방식·성격으로 묶은 그룹 4개(메뉴얼/자동매매/현황/설정) — 드래그로 순서 변경.
          2단(서브탭): 지금 tab이 속한 그룹의 하위 탭이 2개 이상일 때만 뜬다(설정처럼 1개면 안 뜸). */}
      {!showTwoCol && (
      <>
      <nav className="tabs">
        {groupOrder.map((g) => (
          <button
            key={g}
            className={TAB_GROUP[tab] === g ? "tab active" : "tab"}
            title="좌우로 끌면 그룹 순서를 바꿀 수 있어요"
            {...dragProps(g)}
            onClick={() => {
              // 끌어서 순서를 바꾼 직후에는 탭 이동이 되지 않게 한다(의도치 않은 화면 전환 방지).
              if (isDragging()) return;
              const children = GROUP_CHILDREN[g];
              // 자식이 1개(설정)면 곧장 그리로, 2개 이상이면 이미 그 그룹 안에 있으면 유지(서브탭만 펼침),
              // 아니면 첫 자식으로 이동(그룹 버튼을 눌렀는데 아무 하위 탭도 안 보이는 상태 방지).
              if (children.length === 1) { setTab(children[0]); activateTab(children[0]); return; }
              if (TAB_GROUP[tab] !== g) { setTab(children[0]); activateTab(children[0]); }
            }}
          >
            {TOP_GROUP_LABEL[g]}
          </button>
        ))}
      </nav>
      {GROUP_CHILDREN[TAB_GROUP[tab]].length > 1 && (
        <nav className="subtabs">
          {GROUP_CHILDREN[TAB_GROUP[tab]].map((t) => (
            <button
              key={t}
              className={tab === t ? "subtab active" : "subtab"}
              onClick={() => { setTab(t); activateTab(t); }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
      )}
      </>
      )}

      {/* [v0.15.0] 본문: 1컬럼이면 현재 탭 1개, 2컬럼이면 좌/우 탭 2개를 나란히.
          콘텐츠 블록은 그대로 재사용하되 가드를 paneTab 으로 바꿔 패널마다 다른 탭을 그린다(회귀 0). */}
      <div className={`panes ${showTwoCol ? "twocol" : ""}`}>
        {(showTwoCol ? [tabL, tabR] : [tab]).map((paneTab, paneIdx) => (
          <div className="pane" key={paneIdx}>
            {showTwoCol && (
              <div className="pane-head">
                <span className="pane-tag">{paneIdx === 0 ? "왼쪽" : "오른쪽"}</span>
                <select
                  className="pane-select"
                  value={paneTab}
                  onChange={(e) => { const nt = e.target.value as TabId; (paneIdx === 0 ? setTabL : setTabR)(nt); /* 데이터 로드는 [tabL,tabR] effect가 처리(중복 호출 방지) */ }}
                >
                  {/* [v0.27.0] 2컬럼은 그룹 개념 없이 9개 리프 탭 중 아무거나 바로 고르되, optgroup으로
                      그룹별로 묶어 보여준다(1단 탭바와 같은 분류 — 찾기 쉽게). */}
                  {TOP_GROUPS.map((g) => (
                    <optgroup key={g} label={TOP_GROUP_LABEL[g]}>
                      {GROUP_CHILDREN[g].map((t) => <option key={t} value={t}>{TAB_LABEL[t]}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}

      {/* ===== 1) 계산기 (오더 티켓) ===== */}
      {paneTab === "calc" && (
        <main className="ticket">
          {/* --- 상단 상시 바: 실주문 토글 · 예수금 · 보유손익 · 세션 --- */}
          <div className="statusbar">
            <label className={`sb-live ${settings?.liveOrdersEnabled ? "on" : "off"}`}>
              <input
                type="checkbox"
                checked={!!settings?.liveOrdersEnabled}
                onChange={(e) => toggleLiveOrders(e.target.checked)}
              />
              <b>{settings?.liveOrdersEnabled ? "🔴 실주문 ON" : "🔒 실주문 OFF (연습)"}</b>
            </label>
            <div className="sb-item">
              <span className="sb-k">예수금</span>
              <b>{acct?.buyingPowerUsd != null ? usdKrw(acct.buyingPowerUsd, fx) : "—"}</b>
            </div>
            <div className="sb-item">
              <span className="sb-k">보유손익</span>
              <b className={pnlClass(acct?.totalPnlUsd ?? null)}>
                {acct?.totalPnlUsd != null
                  ? `${acct.totalPnlUsd >= 0 ? "+" : ""}${usdKrw(acct.totalPnlUsd, fx)}`
                  : "—"}
                {acct?.totalPnlRate != null && ` (${acct.totalPnlRate >= 0 ? "+" : ""}${acct.totalPnlRate.toFixed(2)}%)`}
              </b>
            </div>
            <div className="sb-item">
              <span className="sb-k">세션</span>
              {/* [v0.8.4] 휴장일에는 세션 이름 대신 "휴장(사유)"를 보여 준다 */}
              <b>{status.closedReason ? `휴장 · ${status.closedReason}` : SESSION_LABEL[status.session]}</b>
              {status.closedReason
                ? status.nextOpenNote && <span className="hint"> · 다음 개장 {status.nextOpenNote}</span>
                : cap && <span className="hint"> · 매수비율 {cap.sessionPct}%</span>}
            </div>
            <button className="mini" disabled={busy} onClick={() => autoLoad(committedSymbol)} title="예수금·시세·수량 다시 불러오기">
              ↻ 새로고침
            </button>
          </div>

          {/* --- 본문: 왼쪽 입력 / 오른쪽 결과·주문 (한 화면) --- */}
          <div className="ticket-grid">
            {/* 왼쪽: 입력 */}
            <section className="card">
              <div className="form-row sym-row">
                <label className="sym-label">
                  종목
                  <input
                    className="sym-input"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === "Enter") commitSymbol(); }}
                    onBlur={commitSymbol}
                    placeholder="예: AAPL"
                  />
                </label>
                <div className="cur-box">
                  {curPrice != null ? (
                    <>현재가 <b className="cur-price">{usdKrw(curPrice, fx)}</b></>
                  ) : busy ? (
                    <span className="hint">조회 중…</span>
                  ) : (
                    <span className="hint">종목 입력 후 Enter</span>
                  )}
                </div>
              </div>
              {quoteErr && <p className="danger small">⚠ 시세를 못 불러왔어요: {quoteErr} — [설정 → 토스 연결]에서 키·계좌를 확인하세요</p>}
              <div className="hint small">
                환율{" "}
                {fx
                  ? `1달러 = ₩${fx.toLocaleString()} (${fxSource === "toss" ? "참고용" : "직접 입력"})`
                  : "아직 안 불러옴"}
                {" · 원화는 참고용이고, 실제 주문·체결은 달러로 합니다"}
              </div>
              {fxFailed && (
                <div className="form-row">
                  <input type="text" inputMode="decimal" placeholder="환율 수동 입력 (예: 1390)" value={manualFx} onChange={(e) => setManualFxInput(e.target.value)} />
                  <button className="mini" onClick={applyManualFx}>적용</button>
                  <span className="hint danger">자동 조회 실패 — 수동 입력</span>
                </div>
              )}

              {/* 기법 선택 — [v0.17.0] 알약형 세그먼트 */}
              <div className="pill-seg tech-seg">
                {(["split3", "orderbook", "candle", "manual"] as Technique[]).map((t) => (
                  <button key={t} type="button" className={tech === t ? "on" : ""} onClick={() => { setTech(t); setCalcErr(""); }}>
                    {TECH_LABEL[t]}
                  </button>
                ))}
              </div>

              {/* 기법별 재료 */}
              {tech === "split3" && (
                <div className="form-row">
                  <label>전봉 종가 $
                    <input type="text" inputMode="decimal" placeholder="예: 11.33" value={baseClose} onChange={(e) => isNumericDraft(e.target.value) && setBaseClose(e.target.value)} />
                  </label>
                  <label>EMA200 $
                    <input type="text" inputMode="decimal" placeholder="예: 11.10" value={ema200} onChange={(e) => isNumericDraft(e.target.value) && setEma200(e.target.value)} />
                  </label>
                  <span className="hint">직전에 <b>마감된 봉의 종가</b>와 <b>EMA200</b>(가격 200개의 평균을 이은 선) 사이를 3등분해 <b>1·2·3차 매수가</b>를 냅니다. (전봉 종가가 EMA200보다 위여야 계산돼요.)</span>
                </div>
              )}
              {tech === "orderbook" && (
                <div className="form-row">
                  <label>매수벽 가격 $
                    <input type="text" inputMode="decimal" placeholder="예: 11.33" value={wallPrice} onChange={(e) => isNumericDraft(e.target.value) && setWallPrice(e.target.value)} />
                  </label>
                  <span className="hint"><b>매수벽</b>(사려는 주문이 두껍게 쌓인 가격)보다 <b>한 칸(1틱) 위</b>에서 삽니다. 어디가 벽인지는 호가창을 보고 직접 정하세요.</span>
                </div>
              )}
              {tech === "candle" && (
                <div className="form-row">
                  <label>현재봉 시가 $
                    <input type="text" inputMode="decimal" placeholder="예: 20.50" value={barOpen} onChange={(e) => isNumericDraft(e.target.value) && setBarOpen(e.target.value)} />
                  </label>
                  <label className="radio">
                    <input type="checkbox" checked={candleYang} onChange={(e) => setCandleYang(e.target.checked)} />
                    직전 봉이 <b>양봉</b>(마감가가 시작가보다 높음)인지 확인
                  </label>
                </div>
              )}
              {tech === "manual" && (
                <div className="form-row">
                  <label>진입가 $
                    <input type="text" inputMode="decimal" placeholder="예: 11.33" value={manualEntry} onChange={(e) => isNumericDraft(e.target.value) && setManualEntry(e.target.value)} />
                  </label>
                </div>
              )}

              {/* 익절/손절/수량 */}
              <div className="form-row">
                <label>익절 %
                  <input type="text" inputMode="decimal" placeholder="예: 2" value={tpPct} onChange={(e) => isNumericDraft(e.target.value) && setTpPct(e.target.value)} />
                </label>
                <label>손절 %
                  <input type="text" inputMode="decimal" placeholder="예: 10" value={slPct} onChange={(e) => isNumericDraft(e.target.value) && setSlPct(e.target.value)} />
                </label>
                <label>수량(주)
                  <input type="text" inputMode="decimal" placeholder="예: 1 (소수주 가능)" value={qty} onChange={(e) => isNumericDraft(e.target.value) && setQty(e.target.value)} />
                </label>
              </div>

              {/* 세션 시드 제안 + 주문가능/보유 */}
              <div className="seed-box">
                {cap ? (
                  <>
                    <div className="seed-line">
                      <span>
                        <span className="tag">{SESSION_LABEL[cap.session]}</span>
                        매수비율 <b>{cap.sessionPct}%</b> 적용 중 ·{" "}
                        {cap.seedQty != null ? <>제안 <b>{cap.seedQty.toLocaleString()}주</b></> : "제안 —"}
                        {cap.seedUsd != null && (
                          <span className="hint"> (기준금액 {usdKrw(cap.seedUsd, fx)} × {cap.sessionPct}% {cap.seedBasis === "fixed" ? "· 고정" : "· 예수금"})</span>
                        )}
                      </span>
                      {cap.seedQty != null && cap.seedQty > 0 && (
                        <button className="mini" onClick={applySeedQty}>적용</button>
                      )}
                    </div>
                    <div className="seed-line hint">
                      주문가능 최대 <b>{cap.maxBuyQty != null ? `${cap.maxBuyQty.toLocaleString()}주` : "—"}</b>
                      {cap.buyingPowerUsd != null && ` (매수가능 ${usdKrw(cap.buyingPowerUsd, fx)}`}
                      {cap.commissionRate != null && `, 수수료 ${(cap.commissionRate * 100).toFixed(3)}%`}
                      {cap.buyingPowerUsd != null && ")"}
                      {cap.maxBuyQty != null && cap.maxBuyQty > 0 && (
                        <button className="mini" onClick={() => setQty(String(cap.maxBuyQty))}>최대</button>
                      )}
                    </div>
                    <div className="seed-line hint">
                      보유 <b>{cap.heldQty != null ? `${cap.heldQty}주` : "—"}</b>
                      {cap.sellableQty != null && ` (매도가능 ${cap.sellableQty}주)`}
                    </div>
                  </>
                ) : (
                  <span className="hint">종목을 입력하면 매수비율 제안·주문가능·보유 수량이 자동으로 표시됩니다.</span>
                )}
              </div>
              {calcErr && <p className="danger">⚠ {calcErr}</p>}
              {isMock && (
                <div className="form-row mock-box">
                  <span className="hint">🎮 연습: 가짜 서버 현재가</span>
                  <input type="text" inputMode="decimal" placeholder="새 가격" value={mockPrice} onChange={(e) => isNumericDraft(e.target.value) && setMockPrice(e.target.value)} />
                  <button className="mini" onClick={async () => { if (mockPrice) { await window.kyletool.mockSetPrice(symbol.trim().toUpperCase(), Number(mockPrice)); autoLoad(symbol.trim().toUpperCase()); } }}>변경</button>
                </div>
              )}
            </section>

            {/* 오른쪽: 결과 + 주문 */}
            <section className="card">
              {result ? (
                <>
                  <div className="result-head">
                    <b>{TECH_LABEL[result.technique]}</b> <span className="hint">{result.note}</span>
                  </div>
                  {/* [v0.4.0] 기록 저장 — 지금 타점 3개를 '내 삼분할 기록'에 남겨, 종목을 바꿔도 안 사라지게. */}
                  <div className="split-save">
                    <input
                      type="text"
                      className="split-memo-input"
                      placeholder="메모(안 써도 됨): 예) 데이마켓에서 눌렸다 올라오는 자리"
                      value={splitMemo}
                      onChange={(e) => setSplitMemo(e.target.value)}
                    />
                    <button className="mini btn-save" onClick={() => void saveCurrentSplit()} title="이 종목의 1·2·3차 매수가를 기록으로 저장(앱을 껐다 켜도 유지)">
                      💾 기록 저장
                    </button>
                    {splitSaved && <span className="ok split-saved-msg">{splitSaved}</span>}
                  </div>
                  <table className="result-table">
                    <thead>
                      <tr>
                        <th>분할</th>
                        <th>진입가<span className="wide-only"> (매수)</span></th>
                        <th>익절 (+{tpPct}%)</th>
                        <th>손절 (−{slPct}%)</th>
                        <th>드는 돈 ({qty || "?"}주)</th>
                        <th>주문</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.levels.map((lv) => (
                        <tr key={lv.level}>
                          <td>{lv.level}분할</td>
                          <td>{usdKrw(lv.entry, fx)}</td>
                          <td className="ok">{usdKrw(lv.tp, fx)}</td>
                          <td className="danger">{usdKrw(lv.sl, fx)}</td>
                          <td>{usdKrw(lv.entry * (toNum(qty) ?? 0), fx)}</td>
                          <td className="order-cell">
                            <button className="mini btn-buy" disabled={status.killSwitch} onClick={() => confirmEntry(lv)} title="이 가격에 사기만 합니다(지정가 = 가격을 정해 두는 주문)">매수만 (지정가)</button>
                            <button className="mini btn-oto" disabled={status.killSwitch} onClick={() => confirmOto(lv)} title="사자마자 익절 주문까지 자동으로 걸립니다. 손절은 안 걸리니 직접 챙기세요.">매수+익절 자동</button>
                            <button className="mini btn-oco" disabled={status.killSwitch} onClick={() => openOcoEditor(lv)} title="이미 보유 중일 때, 익절과 손절을 동시에 걸어 둡니다(한쪽 체결되면 다른쪽 자동 취소)">익절+손절 걸기</button>
                            <button className="mini btn-bracket" disabled={status.killSwitch} onClick={() => confirmBracket(lv)} title="매수 후 체결이 확인되면 이 프로그램이 자동으로 익절+손절(OCO)까지 걸어 줍니다(최대 15분 감시, 앱이 켜져 있어야 함)">매수+익절+손절 한번에</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="hint">
                    💡 1·2·3차 매수가는 <b>어느 것이 낫다고 정해진 게 아닙니다</b>(취향껏 고르세요). 버튼 4개 뜻:
                    <br />· <b>매수만 (지정가)</b> = 이 가격에 사기만. · <b>매수+익절 자동</b> = 사자마자 익절까지 자동(<b>손절은 직접</b>). · <b>익절+손절 걸기</b> = <b>이미 갖고 있을 때</b> 익절·손절 동시.
                    <br />· <b>매수+익절+손절 한번에</b> = 매수 후 체결되면 이 프로그램이 자동으로 익절+손절을 걸어 줍니다(<b>앱이 켜져 있는 동안만</b>, 최대 15분 감시 — 토스 조건주문은 다리가 2개까지만 가능해 한 번의 API로는 3개를 못 받기 때문입니다).
                    <br />익절·손절 감시는 <b>토스 서버가 대신</b> 해줘서, 앱을 꺼 둬도 작동합니다.
                    {status.dryRun && " (지금은 주문 잠금 — 실제로 안 나가고 연습 기록만)"}
                  </p>
                </>
              ) : (
                <div className="result-empty hint">
                  왼쪽에 종목·필요한 값·익절/손절%를 넣으면 <b>자동으로 계산</b>돼 여기 표가 나타납니다.
                  <br />(계산·조회 버튼을 따로 누를 필요가 없어요.)
                </div>
              )}
            </section>
          </div>
        </main>
      )}

      {/* ===== ①-1) 탐색(스크리너) (v0.6.0) ===== */}
      {/* [v0.9.1] 오늘의 매매 리포트 — 큰 숫자·배지·막대 애니메이션(토스 스타일) */}
      {paneTab === "report" && (
        <TodayReport
          data={report}
          busy={reportBusy}
          fx={fx}
          onRefresh={() => void loadReport()}
          period={reportPeriod}
          pickedDate={reportDate}
          onPeriod={changeReportPeriod}
        />
      )}

      {paneTab === "screener" && (
        <main className="grid">
          <section className="card wide">
            <div className="split-list-head">
              <h2>탐색 <span className="hint">(거래량 많은 종목에서 매수 후보 자동 찾기)</span></h2>
              <button className="mini btn-start" disabled={screenBusy} onClick={() => void runScan()}>
                {screenBusy ? "스캔 중…" : "🔍 스캔"}
              </button>
            </div>
            <p className="hint">
              거래량 많은 종목을 훑어 <b>매수 후보</b>를 찾아 줍니다(ETF·레버리지·인버스는 제외). 아래 조건을 <b>모두</b> 만족하면 후보예요:
              <br />① 현재가가 <b>$1~$9</b>
              <br />② 현재가가 <b>EMA200</b>(가격 200개를 이은 평균선) <b>위</b>
              <br />③ 현재가가 <b>이치모쿠 구름</b>(추세를 보는 띠) <b>위</b>
              <br />④ 장 시작 뒤 최고점을 찍은 다음, <b>첫 '음봉 도지'</b> — 위·아래 꼬리가 <b>둘 다</b> 있고 몸통이 작은 봉(한쪽 꼬리만 있는 망치형은 제외)
              <br />⑤ 그 다음 봉도 <b>음봉</b>(내린 봉)
              <br /><span className="hint small">※ 도지 뒤에 다시 신고가가 나오면 무효. 캔들은 <b>하이킨아시</b>(노이즈를 줄여 추세를 매끈하게 보는 방식, 트레이딩뷰 'HA'와 같음)로 보고, <b>다 마감된 봉만</b> 판정합니다. 스캔에 1~2분 걸려요.</span>
              <br />🔴 <b>확정</b> = 도지 + 다음 음봉까지 나옴 · 🟡 <b>관찰</b> = 도지는 나왔고 다음 봉 대기 중. <b>▸ 근거</b>를 펼치면 기준 캔들을 볼 수 있고, 줄을 누르면 그 종목이 계산기에 채워집니다.
            </p>

            {/* [v0.11.0] 사용자 조절 필터: 종목수 · 가격대 · 도지 몸통비율 */}
            <div className="screen-controls">
              <label className="str-field" style={{ flex: 1, maxWidth: 360 }}>
                <span className="sb-k">도지로 인정할 <b>몸통 크기 상한</b>: <b>{(bodyRatio * 100).toFixed(0)}%</b> <span className="hint">(작을수록 깐깐하게)</span></span>
                <input type="range" min={0.1} max={0.5} step={0.05} value={bodyRatio} disabled={screenBusy}
                  onChange={(e) => setBodyRatio(Number(e.target.value))} />
              </label>
              <div className="screen-filters">
                <label className="str-field sf-num">
                  <span className="sb-k">스캔 종목수 <span className="hint">(10~200)</span></span>
                  <input type="text" inputMode="numeric" value={scanCount} disabled={screenBusy}
                    onChange={(e) => setScanCount(e.target.value)} onBlur={() => setScanCount(String(Math.min(200, Math.max(10, Math.round(toNum(scanCount) ?? 60)))))} />
                </label>
                <label className="str-field sf-num">
                  <span className="sb-k">가격 하한 $</span>
                  <input type="text" inputMode="decimal" value={priceMin} disabled={screenBusy}
                    onChange={(e) => setPriceMin(e.target.value)} />
                </label>
                <label className="str-field sf-num">
                  <span className="sb-k">가격 상한 $</span>
                  <input type="text" inputMode="decimal" value={priceMax} disabled={screenBusy}
                    onChange={(e) => setPriceMax(e.target.value)} />
                </label>
              </div>
              <p className="hint" style={{ margin: "4px 0 0" }}>
                거래량 상위 <b>{Math.min(200, Math.max(10, Math.round(toNum(scanCount) ?? 60)))}종목</b> 중
                {/* 하한>상한·음수로 잘못 넣어도 화면엔 실제 스캔 범위(0 이상·작은 값~큰 값)로 — 엔진과 동일하게 교정 */}
                현재가 <b>${Math.min(Math.max(0, toNum(priceMin) ?? 1), Math.max(0, toNum(priceMax) ?? 9))}~${Math.max(Math.max(0, toNum(priceMin) ?? 1), Math.max(0, toNum(priceMax) ?? 9))}</b> 범위를 스캔합니다.
                많이 스캔할수록 오래 걸립니다.
              </p>
            </div>

            {/* 진행률 바 */}
            {screenBusy && screenProg && (
              <div className="screen-prog">
                <div className="screen-prog-bar">
                  <div className="screen-prog-fill" style={{ width: `${screenProg.total ? Math.round((screenProg.done / screenProg.total) * 100) : 0}%` }} />
                </div>
                <div className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span>
                    {screenProg.phase === "ranking" ? "거래량 랭킹 불러오는 중…"
                      : screenProg.phase === "done" ? "정리 중…"
                      : `${screenProg.done}/${screenProg.total} · ${screenProg.symbol} 분석 중…`}
                  </span>
                  {/* [v0.43.0] 스크리닝 진행 중 취소 — 지금 조회 중인 종목 하나만 마치고 곧 멈춘다. */}
                  <button className="mini" disabled={scanCancelRequested} onClick={() => void doCancelScan()}>
                    {scanCancelRequested ? "취소 중…" : "✕ 취소"}
                  </button>
                </div>
              </div>
            )}

            {/* 결과 */}
            {screenRun && !screenBusy && (() => {
              const cand = screenRun.results.filter((r) => r.status === "confirmed" || r.status === "watch");
              const insufficient = screenRun.results.filter((r) => r.status === "insufficient").length;
              // [v0.11.0] '아쉽게 탈락(근접)' = none 중 하드게이트를 2개 이상 넘긴 종목(많이 넘긴 순).
              const near = screenRun.results
                .filter((r) => r.status === "none")
                .map((r) => ({ r, ...missReasons(r, screenRun) }))
                .filter((x) => x.passed >= 2)
                .sort((a, b) => b.passed - a.passed || a.r.rank - b.r.rank)
                .slice(0, 15);
              return (
                <>
                  <p className="hint">
                    {screenRun.scannedAt} 스캔 · {screenRun.total}종목(${screenRun.priceMin}~${screenRun.priceMax}) 중 <b className="ok">후보 {cand.length}개</b>
                    {near.length > 0 && <span> · 근접 {near.length}개</span>}
                    {screenRun.excludedEtf > 0 && <span> · ETF/레버리지 {screenRun.excludedEtf}개 제외</span>}
                    {insufficient > 0 && <span> · 데이터 부족 {insufficient}개 제외</span>}
                  </p>
                  {/* [v0.29.0] 탈락 사유 통계 — 어느 조건이 병목인지 숫자로(오너 요청: "기준 재점검") */}
                  {(() => {
                    const stats = tallyMissReasons(screenRun.results, screenRun);
                    if (stats.length === 0) return null;
                    return (
                      <p className="hint miss-stats">
                        탈락 사유 통계(참고용 — 후보가 안 나올 때 어느 조건을 완화할지 판단 근거):{" "}
                        {stats.map((s, i) => (
                          <Fragment key={s.label}>
                            {i > 0 && " · "}
                            {s.label} <b>{s.count}</b>
                          </Fragment>
                        ))}
                      </p>
                    );
                  })()}
                  {cand.length === 0 ? (
                    <div className="result-empty hint">조건에 맞는 후보가 없어요. (위 '몸통 크기 상한'을 조금 올리거나, 장이 열린 시간에 다시 눌러 보세요.)</div>
                  ) : (
                    <table className="result-table screen-table">
                      <thead>
                        <tr><th>근거</th><th>상태</th><th>순위</th><th>종목</th><th>현재가</th><th>EMA200</th><th>구름 위</th><th>장중 고점</th><th>근접도</th></tr>
                      </thead>
                      <tbody>
                        {cand.map((r) => {
                          const open = openEvid.has(r.symbol);
                          const chartOpen = openChart.has(r.symbol);
                          return (
                          <Fragment key={r.symbol}>
                            <tr className="screen-row" onClick={() => pickScreenSymbol(r)} title="클릭하면 계산기로 이동 + 이 종목의 전봉종가·EMA200이 자동 입력됩니다(수정 가능)">
                              <td>
                                <button className="mini btn-evid" onClick={(e) => { e.stopPropagation(); toggleEvid(r.symbol); }} title="판정 근거 펼치기/접기">
                                  {open ? "▾ 근거" : "▸ 근거"}
                                </button>
                                {" "}
                                <button className="mini btn-evid" onClick={(e) => { e.stopPropagation(); toggleChart(r.symbol); }} title="이 종목의 캔들차트 불러오기(도지·EMA200·구름·세션고점 표시)">
                                  {chartOpen ? "▾ 📈" : "▸ 📈"}
                                </button>
                              </td>
                              <td>{r.status === "confirmed" ? "🔴 확정" : "🟡 관찰"}</td>
                              <td>{r.rank}</td>
                              <td><b>{r.symbol}</b></td>
                              <td>{r.price != null ? usdKrw(r.price, fx) : "—"}</td>
                              <td>{r.ema200 != null ? `$${r.ema200.toFixed(2)}` : "—"}</td>
                              <td>{r.cloudTop != null ? `$${r.cloudTop.toFixed(2)}` : "—"}</td>
                              <td>{r.sessionHigh != null ? `$${r.sessionHigh.toFixed(2)}` : "—"}</td>
                              <td className={r.proximityPct != null && r.proximityPct >= 0 ? "ok" : "danger"}>
                                {r.proximityPct != null ? `${r.proximityPct >= 0 ? "+" : ""}${r.proximityPct.toFixed(2)}%` : "—"}
                              </td>
                            </tr>
                            {open && r.evidence && (
                              <tr className="evid-row">
                                <td colSpan={9}><ScreenEvidenceView ev={r.evidence} price={r.price} metrics={r.entryMetrics} defenseReasons={r.defenseReasons} /></td>
                              </tr>
                            )}
                            {chartOpen && (
                              <tr className="evid-row" onClick={(e) => e.stopPropagation()}>
                                <td colSpan={9}>
                                  {chartBusy.has(r.symbol) && <p className="hint">차트 불러오는 중…</p>}
                                  {chartErr[r.symbol] && (
                                    <p className="hint">
                                      ⚠️ 차트를 못 불러왔습니다: {chartErr[r.symbol]}
                                      {" "}<button className="mini" onClick={() => void loadScreenChart(r.symbol)}>다시 시도</button>
                                    </p>
                                  )}
                                  {chartCache[r.symbol] && <ScreenCandleChart chart={chartCache[r.symbol]} />}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}

                  {/* [v0.11.0] 아쉽게 탈락(근접) — 왜 후보가 안 됐는지 사유를 명확히 */}
                  {near.length > 0 && (
                    <div className="near-miss">
                      <button className="mini ghost" onClick={() => setShowMiss((v) => !v)}>
                        {showMiss ? "▾" : "▸"} 아쉽게 탈락한 종목 {near.length}개 (조건에 근접 — 왜 빠졌는지 보기)
                      </button>
                      {showMiss && (
                        <table className="result-table screen-table miss-table">
                          <thead>
                            <tr><th>통과</th><th>순위</th><th>종목</th><th>현재가</th><th>빠진 이유</th></tr>
                          </thead>
                          <tbody>
                            {near.map(({ r, passed, reasons }) => (
                              <tr key={r.symbol} className="screen-row" onClick={() => pickScreenSymbol(r)} title="클릭하면 계산기로 이동 + 이 종목의 전봉종가·EMA200이 자동 입력됩니다(수정 가능)">
                                <td title="꼭 통과해야 하는 3가지(가격대·EMA200 위·구름 위) 중 몇 개를 넘겼는지">{passed}/3</td>
                                <td>{r.rank}</td>
                                <td><b>{r.symbol}</b></td>
                                <td>{r.price != null ? usdKrw(r.price, fx) : "—"}</td>
                                <td className="miss-reasons">{reasons.join(" · ") || "패턴 미완성"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </>
              );
            })()}

            {!screenRun && !screenBusy && (
              <div className="result-empty hint">[🔍 스캔]을 누르면 정해 둔 종목 수·가격대로 훑어 매수 후보를 찾아 줍니다. (보기만 하는 기능 — 주문과는 무관해요)</div>
            )}
          </section>
        </main>
      )}

      {/* ===== ①-2) 내 삼분할 기록 (v0.4.0 — 여러 종목 동시 운용) ===== */}
      {paneTab === "splits" && (
        <main className="grid">
          <section className="card wide">
            <div className="split-list-head">
              <h2>내 삼분할 기록</h2>
              <button className="mini" onClick={() => void refreshSplits()}>↻ 새로고침</button>
            </div>
            <p className="hint">
              계산기에서 <b>💾 기록 저장</b>을 누르면 여기에 쌓입니다. 종목을 바꿔 계산해도 사라지지 않고,
              <b> 앱을 껐다 켜도 유지</b>됩니다. 여러 종목(A·B·C·D)의 삼분할 타점을 한눈에 관리하세요.
              <br />※ 이 기록은 <b>메모일 뿐</b>이며 실제 주문과는 무관합니다. 주문은 [계산기] 탭에서 냅니다.
            </p>

            {splits.length === 0 && (
              <div className="result-empty hint">
                아직 저장된 기록이 없습니다. [계산기] 탭에서 삼분할을 계산한 뒤 <b>💾 기록 저장</b>을 눌러 보세요.
              </div>
            )}

            {/* 저장된 종목들을 카드로 하나씩 — 최신이 위 */}
            {splits.map((s) => {
              const doneCount = s.levels.filter((lv) => lv.entered).length; // 진입완료 개수(진행도 표시)
              return (
                <div key={s.id} className="split-card">
                  <div className="split-card-head">
                    <div>
                      <b className="split-symbol">{s.symbol}</b>
                      <span className="hint"> · {TECH_LABEL[s.technique]}</span>
                      <span className="hint"> · 진입 {doneCount}/{s.levels.length}</span>
                    </div>
                    <div className="split-card-meta">
                      <span className="hint">{s.ts} 저장</span>
                      {/* [v0.9.0] 저장해 둔 입력값(전봉종가·EMA200 등)을 계산기에 그대로 복원 */}
                      <button
                        className="mini"
                        disabled={!s.inputs && !restoreInputsFromSaved(s)}
                        onClick={() => loadSplitIntoCalc(s)}
                        title={
                          s.inputs
                            ? "이 기록을 만들 때 쓴 입력값(전봉종가·EMA200 등)을 계산기에 그대로 불러옵니다"
                            : "옛 기록이라 진입가에서 되살린 값으로 불러옵니다(1틱 정도 차이 가능)"
                        }
                      >
                        {/* 폰에는 '마우스 올리기'가 없어 설명이 안 보이므로, 복원인 경우 버튼에 바로 표시한다 */}
                        ↩ 계산기로 불러오기{!s.inputs && " (복원)"}
                      </button>
                      <button className="mini btn-del" onClick={() => void deleteSplit(s.id)} title="이 기록 삭제">🗑 삭제</button>
                    </div>
                  </div>

                  <table className="result-table">
                    <thead>
                      <tr>
                        <th>분할</th>
                        <th>진입가</th>
                        <th>익절{s.tpPct != null ? ` (+${s.tpPct}%)` : ""}</th>
                        <th>손절{s.slPct != null ? ` (−${s.slPct}%)` : ""}</th>
                        <th>진입완료</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.levels.map((lv) => (
                        <tr key={lv.level} className={lv.entered ? "split-done" : ""}>
                          <td>{lv.level}분할</td>
                          <td>{usdKrw(lv.entry, fx)}</td>
                          <td className="ok">{usdKrw(lv.tp, fx)}</td>
                          <td className="danger">{usdKrw(lv.sl, fx)}</td>
                          <td>
                            <label className="split-check">
                              <input
                                type="checkbox"
                                checked={lv.entered}
                                onChange={() => void toggleSplitEntered(s.id, lv.level)}
                              />
                              <span>{lv.entered ? "진입함" : "대기"}</span>
                            </label>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="split-card-foot">
                    {s.qty != null && <span className="hint">계획 수량 {s.qty}주 · </span>}
                    {editSplitId === s.id ? (
                      // 편집 모드: 제목 입력칸 + 저장/취소 (Enter=저장, Esc=취소)
                      <span className="split-edit">
                        <input
                          type="text"
                          className="split-memo-input"
                          autoFocus
                          value={editSplitText}
                          placeholder="제목/메모 입력"
                          onChange={(e) => setEditSplitText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveEditSplit(s.id);
                            if (e.key === "Escape") cancelEditSplit();
                          }}
                        />
                        <button className="mini btn-save" onClick={() => void saveEditSplit(s.id)}>저장</button>
                        <button className="mini" onClick={cancelEditSplit}>취소</button>
                      </span>
                    ) : (
                      // 표시 모드: 제목 + [✏ 제목 수정]
                      <>
                        <span className="hint">{s.memo ? `📝 ${s.memo}` : "메모 없음"}</span>
                        <button className="mini btn-edit" onClick={() => startEditSplit(s.id, s.memo)} title="이 기록의 제목(메모) 수정">
                          ✏ 제목 수정
                        </button>
                      </>
                    )}
                    <button className="mini btn-str" onClick={() => openStrengthFor(s.symbol)} title="이 종목의 체결강도 기록 화면 열기">
                      📈 체결강도 보기
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        </main>
      )}

      {/* ===== ①-3) 체결강도 기록 (v0.5.0 — 온디맨드 시계열) ===== */}
      {paneTab === "strength" && (
        <main className="grid">
          <section className="card wide">
            {/* [v0.23.0] '체결강도 기록' → '보유 종목 체결강도'. 수동 [기록 시작] 제거하고,
                지금 보유 중인 종목들의 체결강도를 자동으로 가져와 칩으로 보여준다(종목 클릭 시 상세). */}
            <h2>보유 종목 체결강도 <span className="hint">(사려는 힘 vs 팔려는 힘)</span></h2>
            <p className="hint">
              <b>체결강도</b>는 방금 사고팔린 양을 비교해 <b>지금 어느 쪽 힘이 센지</b> 보는 숫자예요
              (매수 ÷ 매도 × 100 → <b>100보다 크면 사는 힘, 작으면 파는 힘 우세</b>).
              <br />✅ <b>매매하면 자동으로 기록됩니다.</b> 여기엔 <b>지금 보유 중인 종목</b>의 체결강도가 저절로 떠요 — 종목을 눌러 자세히 봅니다.
              <br /><span className="hint small">실시간 값은 <b>집 PC 연결</b>이 있어야 쌓입니다(폰이면 [폰에서 쓰기]). 연결이 없으면 아래에 안내가 떠요(조용히 실패하지 않아요).
              ※ 방향은 추정치예요(토스가 매수/매도를 직접 주지 않아, 오르며 체결=매수·내리며 체결=매도로 추정). 참고용.</span>
            </p>

            {/* --- 보유 종목 줄: 새로고침 + (있으면) 종목 칩 --- */}
            <div className="str-controls">
              <button className="mini" onClick={() => void loadHoldingsStrength()} disabled={strLoading}>↻ 새로고침</button>
              {strLoading && <span className="hint">보유 종목 불러오는 중…</span>}
              {!strLoading && !strErr && heldSyms.length > 0 && <span className="hint">보유 {heldSyms.length}종목 · 종목을 눌러 자세히</span>}
            </div>

            {/* 연결 없음(보유현황 조회 실패) 안내 — 무음 실패 금지 */}
            {strErr && (
              <div className="note red" style={{ fontSize: 13 }}>
                ⚠️ 보유 종목을 불러오지 못했어요. <b>집 PC 연결</b>(폰이면 PC에서 [설정 → 📱 폰에서 쓰기])이 켜져 있어야
                보유 종목과 실시간 체결강도가 자동으로 표시됩니다. <button className="mini" onClick={() => void loadHoldingsStrength()}>다시 시도</button>
              </div>
            )}

            {/* 연결은 됐는데 보유가 없음 */}
            {!strLoading && !strErr && heldSyms.length === 0 && (
              <div className="result-empty hint">보유 중인 (미국) 종목이 없어요. 매수하면 그 종목의 체결강도가 여기 자동으로 표시됩니다.</div>
            )}

            {/* 보유 종목 칩(현재 강도값·색 표시). 클릭하면 아래 상세가 그 종목으로 바뀐다. */}
            {heldSyms.length > 0 && (
              <div className="held-chips">
                {heldSyms.map((sym) => {
                  const st = heldStates[sym];
                  const v = st?.latest?.strength ?? null;
                  const oneWayBuy = v == null && !!st?.latest && st.latest.buyVol > 0; // 매도 0 = 초강세 매수(∞)
                  const cls = v == null ? (oneWayBuy ? "up" : "flat") : v >= 100 ? "up" : "down";
                  const valTxt = v != null ? v.toFixed(0) : (oneWayBuy ? "∞" : "—");
                  return (
                    <button key={sym} className={`chip-sym ${strSym === sym ? "on" : ""}`} onClick={() => { setStrSym(sym); void loadStrength(sym); }}>
                      <b className="min0">{sym}</b>
                      <span className={`chip-str ${cls}`}>{valTxt}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {strState?.lastError && heldSyms.length > 0 && (
              <div className="note red" style={{ fontSize: 13 }}>⚠️ {strSym} 조회 오류: {strState.lastError} (연결이 있으면 다음 주기에 다시 시도합니다)</div>
            )}

            {/* ===== 선택 종목 상세(현재값·신호·차트·표) — 보유가 있을 때만 ===== */}
            {heldSyms.length > 0 && strState && <div className="str-detail-head hint">▾ <b>{strSym}</b> 자세히</div>}

            {/* --- 현재값 --- */}
            {heldSyms.length > 0 && (() => {
              const latest = strState?.latest ?? null;
              const v = latest?.strength ?? null;
              const cls = v == null ? "str-oneway" : v >= 100 ? "ok" : "danger";
              const label = v == null ? (latest && latest.buyVol > 0 ? "매수 일방(∞)" : "—") : v.toFixed(1);
              // [v0.13.0] 틱 플래시: 새 표본(tsMs)이 올 때마다 key가 바뀌어 애니메이션이 다시 재생 →
              //   값이 '방금 갱신됐다'를 색으로 알린다(업비트식). 매수우세=초록, 매도우세=빨강 플래시.
              const flashCls = v == null ? "" : v >= 100 ? "flash-up" : "flash-down";
              return (
                <div className="str-now">
                  <div key={latest?.tsMs ?? "none"} className={`str-big ${cls} ${flashCls}`}>{label}</div>
                  <div className="str-meta">
                    <div>매수량 <b className="ok">{latest ? latest.buyVol.toLocaleString() : "—"}</b> · 매도량 <b className="danger">{latest ? latest.sellVol.toLocaleString() : "—"}</b></div>
                    <div className="hint">
                      {/* [v0.27.0] "틱개수 창"이 아니라 "최근 5분" 시간창 기준임을 항상 숫자 옆에 병기 —
                          종목마다 창의 실제 시간폭이 다르면 숫자를 비교할 수 없기 때문(체결강도 재설계 참고). */}
                      {latest
                        ? `최근 ${Math.round((strState?.windowSec ?? 300) / 60)}분 기준 (${latest.nTicks}건${latest.windowCapped ? "+, 상한도달" : ""}) · ${latest.session} · ${latest.ts}`
                        : "아직 표본이 없어요 — 집 PC에 연결돼 있으면 잠시 뒤 자동으로 채워집니다."}
                      {latest?.price != null && ` · 체결가 ${usdKrw(latest.price, fx)}`}
                    </div>
                    {latest?.windowCapped && (
                      <div className="hint" style={{ color: "var(--warn, #f59e0b)" }}>
                        ⚠️ 체결이 너무 잦아 서버 조회 상한(50건)에 걸렸어요 — 창 안 일부 체결을 놓쳤을 수 있어요(참고용 신뢰도 안내).
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* --- [v0.12.0] 국면 배지 + 신호(정본 3장) --- */}
            {heldSyms.length > 0 && strState && (() => {
              // [B리뷰 #2] 구버전 엔진 payload엔 signals가 없을 수 있다 → 안전 기본값으로 방어(크래시 방지).
              const sig = strState.signals ?? { bottomReversal: false, bullishDivergence: false, peakRollover: false, phase: "중립" as const, thinSample: true };
              const pb = phaseBadge(sig.phase);
              return (
                <div className="str-signals">
                  <span className={`phase-badge ${pb.cls}`}>{pb.txt}</span>
                  {/* [B리뷰 #4] 익절 국면이면 진입성 칩(다이버전스)을 함께 띄우지 않는다(모순 방지) */}
                  {sig.bottomReversal && <span className="sig-chip ok">▲ 바닥반전</span>}
                  {sig.bullishDivergence && !sig.peakRollover && <span className="sig-chip ok">✦ 강세 다이버전스</span>}
                  {sig.peakRollover && <span className="sig-chip danger">▼ 정점꺾임</span>}
                  {sig.thinSample && <span className="sig-chip hint">표본 얇음(신뢰 낮음)</span>}
                </div>
              );
            })()}

            {/* --- [v0.12.0] 가격·강도 겹쳐보기 차트(신호 마커). [B리뷰 #6] 신호와 같은 창(최근 30개)으로 정렬 --- */}
            {heldSyms.length > 0 && strState && strState.samples.length >= 2 && <StrengthChart samples={strState.samples.slice(-30)} signals={strState.signals} />}

            {/* --- 최근 값 표(최신이 위) --- */}
            {heldSyms.length > 0 && strState && strState.samples.length > 0 && (
              <table className="result-table str-table">
                <thead>
                  <tr><th>시각</th><th>체결강도</th><th>매수량</th><th>매도량</th><th>최근 5분 표본</th></tr>
                </thead>
                <tbody>
                  {[...strState.samples].slice(-12).reverse().map((s, i) => (
                    <tr key={s.tsMs + "-" + i}>
                      <td>{s.ts}</td>
                      <td className={s.strength == null ? "str-oneway" : s.strength >= 100 ? "ok" : "danger"}>
                        {s.strength == null ? (s.buyVol > 0 ? "∞" : "—") : s.strength.toFixed(1)}
                      </td>
                      <td>{s.buyVol.toLocaleString()}</td>
                      <td>{s.sellVol.toLocaleString()}</td>
                      <td>{s.nTicks}{s.windowCapped ? "+" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {heldSyms.length > 0 && (
              <p className="hint">
                💡 짧게 치고 빠질 때 참고: 내리던 중 <b>체결강도가 바닥에서 반등</b>하면 매수 참고,
                오르던 중 <b>고점에서 꺾이면</b> 익절 참고. 특히 <b>가격은 더 내렸는데 체결강도는 오히려 오르면</b>
                (＝사는 힘이 살아나는 신호) 반등이 가까울 수 있어요.
                <br/>⚠️ 이 값은 <b>참고용 보조 신호</b>일 뿐이에요(방향을 추정한 값). <b>이것만 보고 결정하지 말고</b> 가격·거래량·캔들과 함께 보세요.
              </p>
            )}
          </section>

          {/* ===== ①-4) 매매분석 — [v0.19.0] 실제 체결이력으로 진입→청산 자동추적·분석 =====
              [v0.21.0 B수정] 체결강도와 매매분석을 '한 .grid' 안에 나란히 둔다. 예전엔 두 블록이
              각각 className="grid"(flex:1; overflow-y:auto)라 화면이 위/아래로 갈라지고 스크롤바가
              2개처럼 보였다 → 페이지 스크롤을 하나로 통합해 자연스럽게 이어지게 한다. ===== */}
          <section className="card wide">
            <div className="split-list-head">
              <h2>매매분석 <span className="hint small">산 뒤 판 것까지 한 묶음으로 자동 정리</span></h2>
              <button className="mini" disabled={analysisBusy} onClick={() => void loadAnalysis()}>↻ 새로고침</button>
            </div>
            <p className="hint">
              토스에 남은 <b>실제 체결 내역</b>으로, 이미 판 매매를 <b>산 가격 → 판 가격 · 수량 · 며칠 들고 있었나 · 수익률 · 손익 금액 · 이겼나 졌나</b>까지 자동으로 정리해 줍니다.
              카프리로 주문해 기록이 남은 매매엔 <b>어떤 기법으로 샀는지·살 때 체결강도</b>도 함께 보여줘요.
            </p>

            {analysis?.source === "cache" && <div className="rp-source">💾 저장해 둔 기록으로 보는 중 · 집 PC에 연결되면 최신으로 갱신돼요</div>}
            {analysis?.source === "none" && (
              <div className="result-empty hint">아직 저장된 매매가 없어요. 집 PC에 연결된 상태(폰이면 [폰에서 쓰기])로 <b>주문현황·리포트</b>를 한 번 열면 체결 내역이 이 기기에 쌓입니다.</div>
            )}

            {analysis && analysis.cycles.length > 0 && (() => {
              const ins = analysis.insights;
              return (
                <>
                  {/* 인사이트 헤드라인(강할 때 vs 약할 때) */}
                  {ins.headline && <div className="insight-card">💡 {ins.headline}</div>}

                  {/* 요약 KPI */}
                  <div className="sum-cards" style={{ marginTop: 12 }}>
                    <div className="sum-card"><span className="sum-k">매매 수</span><b className="sum-v">{ins.n}건</b><span className="sum-sub">{ins.wins}승 {ins.losses}패</span></div>
                    <div className={`sum-card ${pnlClass(ins.winRate != null ? ins.winRate - 50 : null)}`}><span className="sum-k">승률</span><b className="sum-v">{ins.winRate != null ? `${ins.winRate}%` : "—"}</b></div>
                    <div className={`sum-card ${pnlClass(ins.totalPnl)}`}><span className="sum-k">총 실현손익</span><b className="sum-v">{ins.totalPnl >= 0 ? "+" : "−"}${Math.abs(ins.totalPnl).toFixed(2)}</b><span className="sum-sub">평균 {ins.avgPct != null ? `${ins.avgPct >= 0 ? "+" : ""}${ins.avgPct}%` : "—"}</span></div>
                    <div className="sum-card"><span className="sum-k">평균 보유</span><b className="sum-v">{ins.avgHoldMin != null ? fmtHoldMin(ins.avgHoldMin) : "—"}</b></div>
                  </div>

                  {/* 강함 vs 약함(진입 체결강도 아는 매매) */}
                  {ins.strengthKnown > 0 && (
                    <div className="strong-weak">
                      <div className="sw-col ok"><div className="sw-h">체결강도 강할 때(100↑)</div><div className="sw-v">{ins.strong.winRate != null ? `승률 ${ins.strong.winRate}%` : "—"}</div><div className="hint small">{ins.strong.n}건 · 평균 {ins.strong.avgPct != null ? `${ins.strong.avgPct}%` : "—"}</div></div>
                      <div className="sw-col danger"><div className="sw-h">약할 때(100↓)</div><div className="sw-v">{ins.weak.winRate != null ? `승률 ${ins.weak.winRate}%` : "—"}</div><div className="hint small">{ins.weak.n}건 · 평균 {ins.weak.avgPct != null ? `${ins.weak.avgPct}%` : "—"}</div></div>
                      <p className="hint small" style={{ gridColumn: "1 / -1", margin: "2px 0 0" }}>※ 진입 시 체결강도를 아는 매매 {ins.strengthKnown}건만 비교(카프리로 주문한 매매). 표본이 쌓일수록 정확해집니다.</p>
                    </div>
                  )}

                  {/* 사이클 목록(최신순) */}
                  <table className="result-table trade-table" style={{ marginTop: 12 }}>
                    <thead>
                      <tr><th>종목</th><th>진입→청산</th><th>수량</th><th>보유</th><th>수익률</th><th>손익</th><th>진입→청산 강도</th></tr>
                    </thead>
                    <tbody>
                      {analysis.cycles.slice(0, 100).map((c, i) => (
                        <tr key={c.symbol + c.sellAtMs + i} className={c.win ? "trade-win" : "trade-loss"}>
                          <td><b>{c.symbol}</b>{c.technique && <><br/><span className="hint small">{TECH_LABEL[c.technique] ?? c.technique}</span></>}</td>
                          <td>${c.entryPrice} → ${c.exitPrice}</td>
                          <td>{c.qty}</td>
                          <td>{c.holdMs != null ? fmtHoldMin(Math.round(c.holdMs / 60000)) : "—"}</td>
                          {/* [리뷰 LOW] 수익률·손익 색을 '실제 손익(win)' 기준으로 통일(행 색과 일치) */}
                          <td className={c.win ? "pnl-up" : "pnl-down"}>{c.pct >= 0 ? "+" : ""}{c.pct}%</td>
                          <td className={c.win ? "pnl-up" : "pnl-down"}>{c.pnl >= 0 ? "+" : "−"}${Math.abs(c.pnl).toFixed(2)}</td>
                          {/* [v0.22.0] 진입강도 → 청산강도(자동 기록 시계열로 확보). 값이 없으면 회색 — */}
                          <td className="tabular">
                            <span className={c.entryStrength != null ? strClass(c.entryStrength) : "hint"}>{c.entryStrength != null ? c.entryStrength.toFixed(0) : "—"}</span>
                            <span className="hint"> → </span>
                            <span className={c.exitStrength != null ? strClass(c.exitStrength) : "hint"}>{c.exitStrength != null ? c.exitStrength.toFixed(0) : "—"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </section>
        </main>
      )}

      {/* ===== 🤖 자동매매 현황 (v0.26.0 설정탭에서 이동, v0.27.0) — 오너가 명시적으로 켰을 때만,
          이 앱이 켜져 있는 동안만 작동 ===== */}
      {paneTab === "autoControl" && (
        <main className="grid">
          <section className="card wide">
            {/* [v0.69.0 긴급] 보호주문 없는 보유 종목 경보 — 봇이 보호가 걸릴 때까지 계속 시도 중인 종목을 숨기지 않고 보여 준다 */}
            {/* [v0.69.2] 주문 전 검증 관문이 막은 주문 — 조용히 넘어가지 않고 붉게 보여 준다 */}
            {(autoStatus?.orderBlocks?.length ?? 0) > 0 && (
              <div className="unprot-banner" role="alert">
                <b>🚫 주문 검증에서 막힌 주문 {autoStatus!.orderBlocks!.length}건 — 설정값과 계산된 주문 가격이 어긋나 보내지 않았습니다</b>
                <ul>
                  {autoStatus!.orderBlocks!.map((b, i) => (
                    <li key={i}>
                      <b>{b.symbol}</b> · {b.kind} · {b.ts} — {b.reasons.join(" / ")}
                    </li>
                  ))}
                </ul>
                <span className="hint small">설정(익절%·손절%)을 확인해 주세요. 손절%는 100 미만이어야 합니다.</span>
              </div>
            )}
            {(autoStatus?.unprotected?.length ?? 0) > 0 && (
              <div className="unprot-banner" role="alert">
                <b>🚨 보호주문(익절·손절)이 없는 보유 종목 {autoStatus!.unprotected!.length}개 — 봇이 보호가 걸릴 때까지 계속 시도 중입니다</b>
                <ul>
                  {autoStatus!.unprotected!.map((u) => (
                    <li key={u.symbol}>
                      <b>{u.symbol}</b> · {u.reason} · 시도 {u.attempts}회{u.lastError ? ` · 마지막 실패: ${u.lastError}` : ""}
                      <span className="hint small"> (진입 ${u.entry} → 익절 ${u.tp} / 손절 ${u.sl})</span>{" "}
                      <button className="mini" onClick={() => void doDismissUnprotected(u.symbol)} title="봇이 이 종목에 보호주문(익절/손절)을 다시 거는 걸 12시간 동안 멈춥니다. 토스의 기존 주문은 건드리지 않아요.">
                        ✋ 보호 중단(직접 관리)
                      </button>
                    </li>
                  ))}
                </ul>
                <span className="hint small">급하면 토스 앱에서 직접 익절/손절을 걸어도 됩니다 — 봇은 조건주문이 걸린 걸 확인하면 자동으로 멈춥니다.</span>
              </div>
            )}
            <h2>🤖 자동매매</h2>
            <p className="hint">
              5분마다 스스로 탐색해 <b>합격 종목을 삼분할 '1분할' 타점으로 자동 매수</b>하고, 체결되면 익절·손절까지
              자동으로 겁니다. <b>이 프로그램이 켜져 있는 동안만</b> 작동하고, 앱을 끄면 자동매매도 함께 멈춥니다
              (이미 낸 주문·조건주문은 토스에 그대로 남아 있어요 — 토스 서버가 계속 감시합니다).
              무엇을 스캔했는지는 <b>[🤖 자동매매 → 스크리닝 결과]</b> 탭에서 자세히 볼 수 있어요.
            </p>

            <div className="settings-block">
              <div className="form-row">
                <button
                  className={`btn ${effectiveAutoEnabled ? "btn-kill kill-on" : "btn-start"}`}
                  disabled={autoBusy || status?.killSwitch || (isWebApp && !pcConnected)}
                  onClick={toggleAutoTrade}
                >
                  {effectiveAutoEnabled ? "🔴 자동매매 중지" : "▶ 자동매매 시작"}
                </button>
                <span className="hint">
                  상태: <b>{effectiveAutoEnabled ? "켜짐" : "꺼짐"}</b>
                  {isWebApp && <> (PC 기준{pcConnected ? "" : " — PC 꺼짐, 값이 오래됐을 수 있음"})</>}
                  {autoStatus?.lastCycleAt && <> · 마지막 확인 {autoStatus.lastCycleAt}</>}
                  {autoStatus && <> · 이번 실행 누적손익 <b className={autoStatus.realizedPnlUsd < 0 ? "pnl-down" : "pnl-up"}>${autoStatus.realizedPnlUsd.toFixed(2)}</b></>}
                </span>
              </div>
              {isWebApp && !pcConnected && (
                <p className="hint small danger">⚠️ PC(데스크톱 앱)가 꺼져 있어 지금은 시작/중지를 눌러도 실행되지 않습니다 — PC를 켜 주세요.</p>
              )}
              {autoToggleMsg && (
                <p className={autoToggleMsg.includes("⚠️") ? "hint small danger" : "hint small ok"} style={{ whiteSpace: "pre-wrap" }}>
                  {autoToggleMsg}
                </p>
              )}
              {status?.killSwitch && <p className="hint small danger">킬 스위치(🛑 비상 정지)가 켜져 있어 자동매매를 시작할 수 없습니다.</p>}
              {/* [v0.40.0] "투입 시드 비율에 맞지 않게 적게 투입됨" 버그 이후 — 지금 실제로 몇 %를
                  계산하는지 화면에서 바로 확인할 수 있게 기준 시드 금액을 그대로 보여준다. */}
              {autoStatus?.enabled && (
                <p className="hint small">
                  {autoStatus.seedUsdSnapshot != null ? (
                    <>
                      💰 이번 실행 기준 시드: <b>${autoStatus.seedUsdSnapshot.toFixed(2)}</b>
                      (자동매매를 시작한 시점에 한 번만 조회해 고정 — 진입할 때마다 다시 줄어든
                      잔액을 기준으로 재계산하지 않습니다). 종목 1개당 예산 ≈ ${(autoStatus.seedUsdSnapshot * autoStatus.maxInvestPct / 100).toFixed(2)}
                      (시드의 {autoStatus.maxInvestPct}%).
                    </>
                  ) : (
                    "💰 이번 실행 기준 시드: 아직 계산 전(다음 사이클에 조회됩니다)."
                  )}
                </p>
              )}

              <h3>한도 설정 (전부 직접 수정 가능)</h3>
              <div className="form-row">
                <label>최대 보유 종목 수
                  <input type="text" inputMode="numeric" value={autoForm.maxPositions} onChange={(e) => isNumericDraft(e.target.value) && setAutoForm({ ...autoForm, maxPositions: e.target.value })} placeholder="3" />
                </label>
                <label>최대손실 한도 (시드 대비 %)
                  <input type="text" inputMode="decimal" value={autoForm.maxLossPct} onChange={(e) => isNumericDraft(e.target.value) && setAutoForm({ ...autoForm, maxLossPct: e.target.value })} placeholder="5" />
                </label>
                <label>최대 투입 비율 (시드 대비 %, 종목 1개당 배정 비율)
                  <input type="text" inputMode="decimal" value={autoForm.maxInvestPct} onChange={(e) => isNumericDraft(e.target.value) && setAutoForm({ ...autoForm, maxInvestPct: e.target.value })} placeholder="30" />
                </label>
                <label>장기간 미체결 자동취소 기준 (분)
                  <input type="text" inputMode="numeric" value={autoForm.watchMinutes} onChange={(e) => isNumericDraft(e.target.value) && setAutoForm({ ...autoForm, watchMinutes: e.target.value })} placeholder="10" />
                </label>
                {/* [v0.61.8 — 오너 지시 "1타점으로 잡을지 2타점으로 잡을지 설정"] */}
                <label>진입 타점 (삼분할 몇 분할 가격에 자동 매수할지)
                  <select value={autoEntryLevel} onChange={(e) => setAutoEntryLevel(Number(e.target.value) === 2 ? 2 : Number(e.target.value) === 1.5 ? 1.5 : 1)}>
                    <option value={1}>1분할(얕은 눌림 — 공장값)</option>
                    <option value={1.5}>1.5분할(1분할과 2분할의 한가운데 — 전봉종가에서 EMA200까지 거리의 절반만큼 눌렸을 때)</option>
                    <option value={2}>2분할(더 깊이 눌렸을 때만 — 보수적)</option>
                  </select>
                </label>
                {/* [v0.63.0] 방어 전략 */}
                <label>🛡 손절 방식
                  <select value={defenseForm.slMode} onChange={(e) => setDefenseForm({ ...defenseForm, slMode: e.target.value === "ema" ? "ema" : "fixed" })}>
                    <option value="fixed">고정 % (진입가 대비 — 기존 방식)</option>
                    <option value="ema">EMA 기준 (EMA200 아래로 깨지면 손절)</option>
                  </select>
                </label>
                <label>EMA 기준 손절 여유 (EMA 아래 %)
                  <input type="text" inputMode="decimal" value={defenseForm.emaStopBufferPct} disabled={defenseForm.slMode !== "ema"}
                    onChange={(e) => isNumericDraft(e.target.value) && setDefenseForm({ ...defenseForm, emaStopBufferPct: e.target.value })} placeholder="1.5" />
                </label>
                <label className="radio">
                  <input type="checkbox" checked={defenseForm.reentryBlockEnabled}
                    onChange={(e) => setDefenseForm({ ...defenseForm, reentryBlockEnabled: e.target.checked })} />
                  🛡 손절된 종목은 그날 재진입 금지
                </label>
                <label className="radio" title="체결 후 익절·손절 주문이 안 걸렸거나, 걸었던 조건주문이 토스에서 사라졌는데 주식이 계좌에 남아 있으면 봇이 다시 보호주문을 걸거나 정리합니다. (등록 실패한 경우는 이 설정과 무관하게 항상 복구)">
                  <input type="checkbox" checked={defenseForm.reprotectVanished}
                    onChange={(e) => setDefenseForm({ ...defenseForm, reprotectVanished: e.target.checked })} />
                  🛡 조건주문이 사라진 보유 종목 자동 재보호
                </label>
                <label>🛡 연속 손절 시 자동 중지 (회, 0=끔)
                  <input type="text" inputMode="numeric" value={defenseForm.lossStreakLimit}
                    onChange={(e) => isNumericDraft(e.target.value) && setDefenseForm({ ...defenseForm, lossStreakLimit: e.target.value })} placeholder="3" />
                </label>
                <button className="btn btn-start" onClick={saveAutoSettings}>한도 저장</button>
                {savedMsg && <span className={savedMsg.startsWith("⚠") ? "err" : "ok"}>{savedMsg}</span>}
              </div>
              {/* [v0.70.0 — 오너 지시 "세팅값 수정 후 저장을 눌러도 이게 적용이되는건지 명확히
                  모르겠다"] 폰(웹)에서는 "보냈다"는 메시지만으론 PC가 실제로 반영했는지 알 수
                  없었다 — PC가 상태 미러에 실어 올린 실제 저장값을 그대로 보여준다(위 입력칸은
                  오너가 "지금 입력 중인 값"이라 서로 다를 수 있음에 주의). */}
              {isWebApp && (
                <p className="hint small">
                  📡 PC 실제값:{" "}
                  {pcSettings ? (
                    <>
                      {describeAutoTradeLimits(pcSettings)}
                      {liveStateUpdatedAtMs != null && <> (PC 확인 {new Date(liveStateUpdatedAtMs).toLocaleTimeString("ko-KR", { hour12: false })})</>}
                      {" "}— 위 입력칸과 다르면 아직 PC에 반영 전입니다(몇 초 뒤 자동으로 다시 확인해요).
                    </>
                  ) : (
                    "아직 PC 상태를 못 받아왔습니다(PC가 켜져 있는지 확인하세요)."
                  )}
                </p>
              )}
              <p className="hint small">
                예) 최대 투입 30% → 종목 1개당 예산은 시드의 30%(종목 수로 나누지 않습니다 — 3종목이면 최대
                동시 투입 합계는 시드의 최대 90%까지 커질 수 있습니다). 손실 한도는 이번 자동매매 실행 동안
                누적된 실현손익(달러) 기준으로, 시드 대비 %를 넘으면 자동매매가 스스로 멈춥니다.
              </p>
              <p className="hint small">
                🛡 <b>EMA 기준 손절</b>이란: 손절가를 "진입가 −10%" 대신 "EMA200 × (1 − 여유%)"로 둡니다. 이 기법의 근거는
                "EMA200 위 눌림"이라, EMA가 깨지면 근거가 사라진 것이니 거기서 바로 나가자는 뜻입니다(지금 손절 사례들은
                EMA가 깨진 뒤에도 6% 가까이 더 버티다 −10%로 나갔습니다). 단, 기존 고정 손절선보다 더 깊어지지는
                않습니다(둘 중 더 빨리 끊는 쪽). 진입가가 EMA에 너무 붙어 손절선을 둘 수 없으면 그 종목은 건너뜁니다.
                연속 손절 자동중지는 "이번에 켠 이후" 손절이 연달아 N번 나오면 자동매매를 스스로 끕니다(익절이 끼면 0부터 다시).
              </p>
              <p className="hint small">
                ⏱ <b>장기간 미체결 자동취소 기준</b>이란: 자동매매가 진입 주문(매수)을 넣었는데 이 시간
                (기본 10분, 1~60분 사이로 조절 가능)이 지나도 체결이 안 되면, 아직 안 산 부분만
                자동으로 취소하고 그 자리를 다음 5분 사이클의 새 후보에게 넘겨줍니다(이미 일부라도
                체결됐다면 그 수량은 보호를 위해 익절/손절을 그대로 걸어 둡니다). 너무 짧게 잡으면
                조금만 기다리면 체결될 주문도 성급하게 취소될 수 있고, 너무 길게 잡으면(60분 근처)
                자리가 오래 묶여 다른 후보가 기회를 못 잡을 수 있습니다.
              </p>
              <p className="hint small">
                🔒 여러 기기에서 동시에 자동매매를 켜도(예: PC와 폰 양쪽에서 자동매매 시작, 또는
                PC 두 대) 안전합니다 — 신규 진입 직전 매번 <b>실계좌 보유 현황을 직접 조회</b>해
                최대 종목 수·중복 종목을 확인하므로(어느 기기의 로컬 기록이 아니라 토스 계좌 자체가
                기준), 한 기기가 모르는 사이 다른 기기가 이미 채운 자리에는 진입하지 않습니다.
              </p>

              <h3>🔔 알림</h3>
              <p className="hint small">
                화면을 안 보고 있어도 <b>관찰 확정</b>(스크리닝 통과)과 <b>주문 이벤트</b>(진입·체결·
                익절/손절·취소/실패)를 이 기기의 알림으로 받을 수 있습니다(이 앱/탭이 켜져 있는
                동안만 — 토스 자체 매수·매도 알림과는 별개로, 카프리가 자동매매에서 직접 보는
                내용을 알려줍니다).
              </p>
              {notifyPermission === "unsupported" && (
                <p className="hint small">이 브라우저는 알림 기능을 지원하지 않습니다.</p>
              )}
              {notifyPermission === "default" && (
                <button className="btn" onClick={requestNotifyPermission}>🔔 이 기기에서 알림 켜기</button>
              )}
              {notifyPermission === "granted" && <p className="hint small ok">🔔 알림 켜짐</p>}
              {notifyPermission === "denied" && (
                <p className="hint small danger">
                  알림이 차단돼 있습니다 — 브라우저(또는 시스템) 알림 설정에서 이 앱을 직접 허용해야
                  다시 켤 수 있습니다.
                </p>
              )}

              {autoStatus && autoStatus.positions.length > 0 && (
                <>
                  <div className="row" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                    <h3 style={{ margin: 0 }}>지금 감시 중인 자동매매 포지션</h3>
                    {/* [v0.45.0] 최대 5분(다음 자동 사이클)까지 기다리지 않고 지금 바로 체결·
                        익절/손절 발동 여부를 다시 확인한다(보유 종목이 보통 3개 이하라 가볍다). */}
                    <button
                      className="mini"
                      disabled={reconcileBusy}
                      onClick={async () => {
                        setReconcileBusy(true);
                        try {
                          // [v0.61.0] 웹에서 중계(QR) 연결이 없으면 이 버튼도 PC가 capri_live_state에
                          //   올려 둔 최신 상태를 받아오는 쪽으로(실제 토스 호출은 항상 실패하므로).
                          if (canReconcileLive) {
                            setAutoStatus(await window.kyletool.reconcileAutoPositionsNow());
                          } else {
                            await refreshLiveState();
                          }
                        } finally {
                          setReconcileBusy(false);
                        }
                      }}
                    >
                      {reconcileBusy ? "확인 중…" : canReconcileLive ? "🔄 지금 확인" : "🔄 PC 최신 기록 받기"}
                    </button>
                  </div>
                  {!canReconcileLive && (
                    <p className="hint small">
                      📱 이 세션은 토스에 직접 연결돼 있지 않아(QR 중계 미연결), 여기 보이는 상태는
                      PC가 올려 둔 최신 기록 기준입니다 — 실제 체결 여부의 최종 확인은 항상 PC나
                      토스 앱에서 하세요.
                    </p>
                  )}
                  <p className="hint">
                    이 기기에 저장돼 있어 앱을 껐다 켜거나 업데이트해도 그대로 남아요. 로그인
                    상태면 <b>다른 기기(PC↔폰)와도 자동으로 동기화</b>됩니다(로그인 직후, 그리고
                    [설정 → ☁️ 계정 → 지금 다시 동기화]로 언제든). 상태(매수 체결 대기중/익절·
                    손절 등록됨)는 20초마다 자동으로도 다시 확인하지만, 지금 바로 보고 싶으면
                    위 버튼을 누르세요. 그래도 실제 주문 여부의 최종 확인은 항상 [현황 → 주문
                    현황]에서 토스와 직접 하세요 — 그 화면은 이 목록과 무관하게 항상 정확합니다.
                  </p>
                  <table className="result-table">
                    <thead>
                      <tr><th>종목</th><th>진입가</th><th>익절가</th><th>손절가</th><th>수량</th><th>상태</th><th>취소</th></tr>
                    </thead>
                    <tbody>
                      {autoStatus.positions.map((p) => {
                        const key = `${p.symbol}@${p.entry}@${p.enteredAtMs}`;
                        return (
                        <tr key={key}>
                          <td>{p.symbol}</td>
                          <td>${p.entry}</td>
                          <td>${p.tp}</td>
                          <td>${p.sl}</td>
                          <td>{p.quantity}</td>
                          <td>
                            {p.status === "active" ? "익절/손절 등록됨" : "매수 체결 대기중"}
                            {/* [v0.60.0] 상태 확인이 반복 실패하면(원인은 대부분 이미 종료된 주문을
                                계속 조회하려는 것) 여기 바로 보이게 한다 — "왜 안 없어지지?"에
                                대한 답을 화면 자체가 준다. */}
                            {p.syncWarning && (
                              <div className="hint small danger" style={{ marginTop: 4 }}>⚠️ {p.syncWarning}</div>
                            )}
                          </td>
                          <td>
                            <button
                              className="mini"
                              disabled={autoCancelBusyKey === key || status?.killSwitch}
                              title="이 자동매매 포지션을 지금 바로 취소합니다(매수 대기 중이면 매수 주문을, 체결됐으면 익절/손절 조건주문을 취소)"
                              onClick={() => void doCancelAutoPosition(p)}
                            >
                              {autoCancelBusyKey === key ? "취소 중…" : "✕ 취소"}
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {autoCancelMsg && (
                    <p className={autoCancelMsg.includes("⚠️") ? "hint small danger" : "hint small ok"} style={{ whiteSpace: "pre-wrap" }}>
                      {autoCancelMsg}
                    </p>
                  )}
                </>
              )}
            </div>
          </section>

        </main>
      )}

      {/* ===== 🤖 자동매매 → 자동 스크리너 (v0.27.0 신규, v0.28.0 설정+수동새로고침 추가) =====
          [오너 지시] 자동매매를 켜면 스크리너에서 스크리닝을 진행하고, 그 결과를 여기서 볼 수 있어야
          한다 — 설정 탭에 컨트롤만 있고 "탐색→진입" 과정이 안 보이던 문제를 고친다. 메뉴얼 스크리너와의
          차별점: 여기서 조절하는 조건은 "자동매매가 실제로 쓰는 조건"이다(자동매매 5분 사이클이 이
          값을 그대로 읽어 감). 진입 관련 액션은 여전히 없다(자동매매가 스스로 판단·실행, 오너는
          조건만 정하고 지켜보는 구조 — 분리형 스크리너, 수동 진입용 스캔은 [메뉴얼 → 스크리너]에
          따로 있음). */}
      {paneTab === "autoScan" && (
        <main className="grid">
          <section className="card wide">
            <h2>자동 스크리너 <span className="hint">(자동매매가 실제로 쓰는 조건 — 5분마다 스스로 갱신)</span></h2>
            <p className="hint">
              자동매매가 켜져 있는 동안 여기서 정한 조건으로 5분마다 자동으로 스캔해요. 여기 뜨는 후보 중{" "}
              <b>진입 조건(빈 자리·중복 방지·안전 한도)</b>을 통과한 것만 실제로 매수됩니다 — 아래 배지로
              진입 여부를 바로 확인할 수 있어요. 조건을 바꾸면 다음 사이클(최대 5분)부터, 또는 아래{" "}
              <b>[지금 새로고침]</b>으로 바로 적용됩니다.
            </p>

            {/* [v0.29.0] 다음 스캔까지 카운트다운 — 오너 요청("몇분 후 스크리닝 진행 표시 필요") */}
            {autoStatus?.enabled && autoStatus.nextCycleAtMs != null && (
              <p className="hint">
                ⏱ 다음 자동 스캔까지 <b>{formatCountdown(Math.max(0, autoStatus.nextCycleAtMs - nowTick))}</b>
                {" "}(자동매매가 켜져 있는 동안 5분마다 자동으로 돕니다 — [🔄 지금 새로고침]으로 바로 당겨올 수도 있어요)
              </p>
            )}

            {/* [v0.45.0 — 오너 지적 "도지 몸통비율 설정이 두 탭에 중복돼 혼란"]
                예전엔 여기(자동 스크리너)와 [스크리닝 기준] 탭 양쪽에 스캔종목수·가격대·도지
                몸통비율 입력칸이 각각 있었다 — 같은 값을 공유하는 같은 설정인데 저장 버튼이
                두 개라, 어느 쪽에서 바꿨는지·저장했는지 헷갈리기 쉬웠다. 이제 조건 편집은
                [스크리닝 기준] 탭 한 곳으로 모으고, 여기는 "지금 적용된 값"을 읽기 전용으로
                보여주기만 한다(실제로 반영되는 값은 항상 settings에서 그대로 읽으므로 두 화면이
                서로 다른 값을 보여줄 일이 없다). */}
            {/* [v0.48.1 — 오너가 반복 보고한 "시작해도/새로고침해도 스크리너가 안 돈다"]
                v0.48.0의 lastCycleSkipReason 배너는 "사이클이 한 번 끝난 뒤에야" 사유를
                보여준다 — 그런데 사이클 자체가 몇 초~몇십 초 걸릴 수 있어, 그새 오너가
                "반응이 없다"고 판단해 버리면 그 배너를 보기도 전이다. 이제 사이클이 돌기도
                전에, 지금 이 순간 "무슨 세션이고 이 세션이 켜져 있는지"를 항상 미리 보여준다
                — [스크리닝 기준] 탭을 따로 열어보지 않아도 이 화면만 봐도 바로 알 수 있게. */}
            {settings && (() => {
              const nowSession = getSession(DateTime.fromMillis(nowTick).setZone("Asia/Seoul"));
              const sessionKo = { day: "데이마켓", pre: "프리마켓", regular: "정규장(본장)", after: "애프터마켓", closed: "장 마감 시간대" }[nowSession];
              const sessionEnabled =
                nowSession === "day" ? settings.autoScanDayEnabled
                : nowSession === "pre" ? settings.autoScanPreEnabled
                : nowSession === "regular" ? settings.autoScanRegularEnabled
                : nowSession === "after" ? settings.autoScanAfterEnabled
                : null; // closed는 애초에 거래 대상 아님 — on/off 의미 없음
              return (
                <p className={`hint small ${sessionEnabled === false ? "danger" : ""}`}>
                  지금은 <b>{sessionKo}</b> 시간대입니다 —{" "}
                  {sessionEnabled == null ? (
                    "장 시간이 아니라 자동매매 신규 진입 대상이 아니에요."
                  ) : sessionEnabled ? (
                    <>이 장의 신규 진입 <b>켜짐</b> ✔ (정상적으로 스캔·진입을 시도합니다)</>
                  ) : (
                    <>
                      이 장의 신규 진입이 <b>꺼져 있어요</b> ✘ — 그래서 지금 스캔·새로고침을 해도
                      새 후보가 안 나옵니다(오류 아님, 기존 감시 포지션은 계속 지켜봅니다).{" "}
                      <button className="mini ghost" onClick={() => goToTab("screenCriteria")}>[스크리닝 기준]에서 켜기</button>
                    </>
                  )}
                </p>
              );
            })()}

            {settings && (
              <p className="hint">
                지금 조건: 상위 <b>{settings.autoScanCount}종목</b> · <b>${settings.autoScanPriceMin}~${settings.autoScanPriceMax}</b> ·
                도지 몸통상한 <b>{Math.round(settings.autoScanBodyRatio * 100)}%</b> 외 EMA·구름·꼬리비율 등{" "}
                <button className="mini ghost" onClick={() => goToTab("screenCriteria")}>[스크리닝 기준] 탭에서 전부 확인·수정</button>
              </p>
            )}
            <div className="form-row">
              <button className="mini" disabled={autoScanBusy} onClick={() => void refreshAutoScanNow()}>
                {autoScanBusy ? "새로고침 중…" : "🔄 지금 새로고침"}
              </button>
              {savedMsg && <span className={savedMsg.startsWith("⚠") ? "err" : "ok"}>{savedMsg}</span>}
            </div>

            {/* [v0.28.0→v0.61.4] 진행률 바 — 자동 사이클이든 수동 새로고침이든 스캔이 도는 동안
                똑같이 보여준다. canReconcileLive면 로컬 이벤트(실시간), 웹·중계없음이면 상태
                미러(pcScanProgress, 최대 2초 지연)로 PC가 지금 스캔 중임을 그대로 보여준다. */}
            {liveScanDisplay && liveScanDisplay.phase !== "done" && (
              <div className="screen-prog">
                <div className="screen-prog-bar">
                  <div className="screen-prog-fill" style={{ width: `${liveScanDisplay.total ? Math.round((liveScanDisplay.done / liveScanDisplay.total) * 100) : 0}%` }} />
                </div>
                <div className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span>
                    {liveScanDisplay.phase === "ranking" ? "거래량 랭킹 불러오는 중…" : `${liveScanDisplay.done}/${liveScanDisplay.total} · ${liveScanDisplay.symbol} 분석 중…`}
                    {!canReconcileLive && " (PC에서)"}
                  </span>
                  {/* [v0.43.0] 자동 사이클이 지금 돌리는 스캔도 여기서 바로 취소할 수 있다(다음
                      5분 사이클이 알아서 다시 시도하므로, 이번 한 번만 건너뛰는 셈). 웹·중계없음은
                      취소를 로컬에서 직접 못 걸 수 있어(PC가 도는 스캔) 이 버튼을 숨긴다 — 필요하면
                      [원격 조종] 카드를 쓴다. */}
                  {canReconcileLive && (
                    <button className="mini" disabled={scanCancelRequested} onClick={() => void doCancelScan()}>
                      {scanCancelRequested ? "취소 중…" : "✕ 취소"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* [v0.45.0 — 오너 보고 "간헐적으로 스크리닝이 안 도는데 이유를 모르겠다"] 예전엔 스캔
                실패가 저널(기본 접힘)에만 조용히 남아, 이 화면은 그냥 계속 비어 보이기만 했다.
                이제 가장 최근 실패를 여기 바로 보여준다(성공하면 즉시 사라짐). */}
            {autoStatus?.lastScanError && (
              <p className="hint small danger">
                ⚠️ 가장 최근 스크리닝 시도({new Date(autoStatus.lastScanError.atMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} KST)가
                실패했습니다 — {autoStatus.lastScanError.message}
                {autoStatus?.enabled && " (다음 5분 사이클에 자동으로 다시 시도합니다 — 계속 실패하면 이 메시지를 그대로 알려주세요.)"}
              </p>
            )}

            {/* [v0.48.0 — 오너 보고 "자동매매 시작해도/새로고침해도 반응이 없어 보인다"] 휴무
                시간대·세션 미활성처럼 "오류는 아니지만 이번엔 의도적으로 스캔을 건너뜀"인
                경우가 지금까지는 화면 어디에도 안 보였다(저널에만 조용히 남음) — 그래서
                실제로는 정상 동작 중이어도 "눌러도 반응이 없다"처럼 보였다. 이제 정확한
                사유를 여기 바로 보여준다(오류색이 아니라 안내색 — 문제가 아니라 설계대로
                건너뛴 것이므로). 실제로 스캔이 한 번이라도 진행되면 즉시 사라진다. */}
            {autoStatus?.lastCycleSkipReason && !autoStatus?.lastScanError && (
              <p className="hint small">
                ℹ️ 방금 사이클({new Date(autoStatus.lastCycleSkipReason.atMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} KST)은
                건너뛰었습니다 — {autoStatus.lastCycleSkipReason.message}. (오류가 아닙니다 — 다음 사이클에 조건이 바뀌면 정상적으로 스캔합니다.)
              </p>
            )}

            {/* [v0.61.4 — 오너 지시 "화면을 구분해서 표시해라"] 예전엔 "자동매매 꺼짐"
                한 가지 문구만 있어서, 오너가 분명 켰다고 생각하는데도 화면이 "자동매매를
                시작하면..."이라고 떠 혼란을 줬다(PC가 꺼져 있어서 켠 게 반영 안 됐을
                뿐이었는데 원인을 구분해 보여주지 못했다). 이제 ①PC 꺼짐 ②자동매매 꺼짐
                ③첫 스캔 대기 세 가지를 구분한다(스캔 중엔 위 게이지가 이미 보이므로 이
                빈 화면 문구 자체를 숨긴다). */}
            {!autoStatus?.lastScan && !(liveScanDisplay && liveScanDisplay.phase !== "done") && (
              <div className="result-empty hint">
                {isWebApp && !pcConnected ? (
                  <>🔴 PC가 꺼져 있어요 — 집 PC에서 Capri 앱을 켜야 스캔이 돌아갑니다.</>
                ) : !effectiveAutoEnabled ? (
                  <>
                    자동매매가 꺼져 있어요 — 켜야 5분마다 스스로 스캔합니다.{" "}
                    <button className="mini" disabled={autoBusy} onClick={() => void toggleAutoTrade()}>▶ 지금 켜기</button>
                  </>
                ) : (
                  <>자동매매가 켜져 있어요 — 첫 스캔 결과가 곧 여기 뜹니다(최대 5분, [🔄 지금 새로고침]으로 바로 당길 수 있어요).</>
                )}
              </div>
            )}

            {autoStatus?.lastScan && (() => {
              const run = autoStatus.lastScan;
              const activeSymbols = new Set(autoStatus.positions.map((p) => p.symbol));
              const cand = run.results.filter((r) => r.status === "confirmed" || r.status === "watch");
              return (
                <>
                  <p className="hint">
                    {run.scannedAt} 스캔 · {run.total}종목(${run.priceMin}~${run.priceMax}) 중 <b className="ok">후보 {cand.length}개</b>
                    {run.excludedEtf > 0 && <span> · ETF/레버리지 {run.excludedEtf}개 제외</span>}
                  </p>
                  {/* [v0.29.0] 탈락 사유 통계 — 어느 조건이 병목인지 숫자로(오너 요청: "기준 재점검") */}
                  {(() => {
                    const stats = tallyMissReasons(run.results, run);
                    if (stats.length === 0) return null;
                    return (
                      <p className="hint miss-stats">
                        탈락 사유 통계(참고용):{" "}
                        {stats.map((s, i) => (
                          <Fragment key={s.label}>
                            {i > 0 && " · "}
                            {s.label} <b>{s.count}</b>
                          </Fragment>
                        ))}
                      </p>
                    );
                  })()}
                  {cand.length === 0 ? (
                    <div className="result-empty hint">이번 스캔에서는 조건에 맞는 후보가 없었어요(다음 사이클에 다시 훑습니다).</div>
                  ) : (
                    <table className="result-table screen-table">
                      <thead>
                        <tr><th>근거</th><th>상태</th><th>종목</th><th>현재가</th><th>자동매매</th></tr>
                      </thead>
                      <tbody>
                        {cand.map((r) => {
                          const open = openEvid.has(r.symbol);
                          const chartOpen = openChart.has(r.symbol);
                          const entered = activeSymbols.has(r.symbol);
                          return (
                            <Fragment key={r.symbol}>
                              <tr className="screen-row">
                                <td>
                                  <button className="mini btn-evid" onClick={() => toggleEvid(r.symbol)} title="판정 근거 펼치기/접기">
                                    {open ? "▾ 근거" : "▸ 근거"}
                                  </button>
                                  {" "}
                                  <button className="mini btn-evid" onClick={() => toggleChart(r.symbol)} title="이 종목의 캔들차트 불러오기">
                                    {chartOpen ? "▾ 📈" : "▸ 📈"}
                                  </button>
                                </td>
                                <td>{r.status === "confirmed" ? "🔴 확정" : "🟡 관찰"}</td>
                                <td><b>{r.symbol}</b></td>
                                <td>{r.price != null ? usdKrw(r.price, fx) : "—"}</td>
                                <td>
                                  {entered ? (
                                    <span className="ok">✅ 진입됨</span>
                                  ) : (
                                    <span className="hint">
                                      — 미진입
                                      {r.status === "confirmed" && (
                                        <>
                                          <br />
                                          <span className="hint small">
                                            {autoStatus?.skipReasons?.[r.symbol] ??
                                              "아직 이유가 안 잡혔습니다 — 다음 자동 사이클(최대 5분 이내)에서 다시 판단합니다."}
                                          </span>
                                        </>
                                      )}
                                    </span>
                                  )}
                                </td>
                              </tr>
                              {/* [v0.69.6] 이 후보의 계획 타점을 1·1.5·2분할 전부 보여 주고, 지금 설정으로 실제 주문이 나갈 자리를 표시한다(검증용) */}
                              {r.status === "confirmed" && r.prevClose != null && r.ema200 != null && r.prevClose > r.ema200 && settings && (() => {
                                const tp = settings.defaultTpPct, sl = settings.defaultSlPct;
                                const sel = settings.autoTradeEntryLevel;
                                const lv = ([1, 1.5, 2] as const).map((l) => ({ l, e: calcSplit3Level(r.prevClose as number, r.ema200 as number, tp, sl, l).entry }));
                                return (
                                  <tr className="evid-row">
                                    <td colSpan={5}>
                                      <p className="hint small" style={{ margin: 0 }}>
                                        계획 타점(전봉종가 ${r.prevClose} · EMA200 ${Math.round((r.ema200 as number) * 10000) / 10000}):{" "}
                                        {lv.map((x, i) => (
                                          <span key={x.l}>{i > 0 ? " · " : ""}{x.l === sel ? <b className="ok">▶ {x.l}분할 ${x.e}</b> : <>{x.l}분할 ${x.e}</>}</span>
                                        ))}
                                        {" "}— 실제 주문은 ▶ 표시된 타점으로 나갑니다.
                                      </p>
                                    </td>
                                  </tr>
                                );
                              })()}
                              {open && r.evidence && (
                                <tr className="evid-row">
                                  <td colSpan={5}>
                                    <ScreenEvidenceView
                                      ev={r.evidence}
                                      price={r.price}
                                      metrics={r.entryMetrics}
                                      defenseReasons={r.defenseReasons}
                                      disabled={{
                                        aboveEma: settings ? !settings.autoScanEmaTrendEnabled : false,
                                        aboveCloud: settings ? !settings.autoScanCloudEnabled : false,
                                        recentDoji: settings ? !settings.autoScanDojiMaxAgeEnabled : false,
                                        dojiNearHigh: settings ? !(settings.autoScanDojiMaxGapEnabled ?? true) : false,
                                        nextBearish: settings ? !settings.autoScanNextCandleConfirmEnabled : false,
                                      }}
                                    />
                                  </td>
                                </tr>
                              )}
                              {chartOpen && (
                                <tr className="evid-row">
                                  <td colSpan={5}>
                                    {chartBusy.has(r.symbol) && <p className="hint">차트 불러오는 중…</p>}
                                    {chartErr[r.symbol] && (
                                      <p className="hint">
                                        ⚠️ 차트를 못 불러왔습니다: {chartErr[r.symbol]}
                                        {" "}<button className="mini" onClick={() => void loadScreenChart(r.symbol)}>다시 시도</button>
                                      </p>
                                    )}
                                    {chartCache[r.symbol] && <ScreenCandleChart chart={chartCache[r.symbol]} />}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}

                  {/* [v0.47.0 — 오너 요청 "필터 다 껐는데 하나도 안 나와 의심스럽다 — 스크리닝
                      검토된 모든 종목을 어떤 필터로 어떤 사유로 탈락했는지 조회 가능하게, 폴드
                      형식으로"] 확정/관찰(후보)만 보여주던 위 표와 달리, 이번 스캔에서 실제로
                      검토된 전체 종목(탈락·데이터부족 포함)을 하나도 빠짐없이 보여준다. 종목
                      수가 많을 수 있어(최대 200개) 기본은 접어 두고 버튼으로 펼친다. */}
                  <div className="near-miss" style={{ marginTop: 16 }}>
                    <button className="mini ghost" onClick={() => setShowAllAutoScanResults((v) => !v)}>
                      {showAllAutoScanResults ? "▾" : "▸"} 이번 스캔에서 검토한 전체 종목 보기 ({run.results.length}개 — 적용된 필터·탈락 사유 포함)
                    </button>
                    {showAllAutoScanResults && (
                      <>
                        <p className="hint" style={{ marginTop: 8 }}>
                          이번 스캔에 실제로 적용된 필터 — 가격대 <b>${run.priceMin}~${run.priceMax}</b> ·
                          도지 몸통상한 <b>{Math.round(run.bodyRatio * 100)}%</b> ·
                          EMA{run.emaPeriod} 위 <b>{run.emaTrendEnabled ? "켜짐" : "꺼짐"}</b> ·
                          이치모쿠 구름 위 <b>{run.cloudEnabled ? "켜짐" : "꺼짐"}</b> ·
                          도지 신선도(최대 {run.dojiMaxAgeMinutes}분) <b>{run.dojiMaxAgeEnabled ? "켜짐" : "꺼짐"}</b> ·
                          고점~도지 간격(최대 {run.dojiMaxGapMinutes ?? 30}분) <b>{(run.dojiMaxGapEnabled ?? true) ? "켜짐" : "꺼짐"}</b> ·
                          EMA 이격도(≥{run.emaMinGapPct ?? 6}%) <b>{run.emaMinGapEnabled ? "켜짐" : "꺼짐"}</b> ·
                          EMA 상승 <b>{run.emaSlopeEnabled ? "켜짐" : "꺼짐"}</b> ·
                          변동성 상한(≤{run.atrMaxPct ?? 3}%) <b>{run.atrFilterEnabled ? "켜짐" : "꺼짐"}</b> ·
                          다음봉 음봉 확인 <b>{run.nextCandleConfirmEnabled ? "켜짐" : "꺼짐"}</b> ·
                          ETF/레버리지 제외 <b>{run.excludeEtf ? "켜짐" : "꺼짐"}</b>
                          {" — "}<button className="mini ghost" onClick={() => goToTab("screenCriteria")}>[스크리닝 기준]에서 수정</button>
                        </p>
                        <table className="result-table screen-table miss-table">
                          <thead>
                            <tr><th>순위</th><th>종목</th><th>상태</th><th>현재가</th><th>사유</th></tr>
                          </thead>
                          <tbody>
                            {run.results.map((r) => {
                              const label =
                                r.status === "confirmed" ? "🔴 확정"
                                : r.status === "watch" ? "🟡 관찰"
                                : r.status === "insufficient" ? "⚪ 데이터 부족"
                                : "⚫ 탈락";
                              const reason =
                                r.status === "confirmed" || r.status === "watch" ? "조건 전부 통과"
                                : r.status === "insufficient" ? (r.note ?? "데이터 부족")
                                : (missReasons(r, run).reasons.join(" · ") || "패턴 미완성");
                              return (
                                <tr key={r.symbol} className="screen-row" onClick={() => pickScreenSymbol(r)} title="클릭하면 계산기로 이동 + 이 종목의 전봉종가·EMA200이 자동 입력됩니다(수정 가능)">
                                  <td>{r.rank}</td>
                                  <td><b>{r.symbol}</b></td>
                                  <td>{label}</td>
                                  <td>{r.price != null ? usdKrw(r.price, fx) : "—"}</td>
                                  <td className="miss-reasons">{reason}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                </>
              );
            })()}
          </section>
        </main>
      )}

      {/* ===== 🤖 자동매매 → 스크리닝 기준 (v0.33.0 신규) =====
          [오너 지시 2026-09-28] "스크리닝 기준 조건들의 수치 및 활성/비활성을 모두 메뉴얼로 설정할 수
          있도록 하고, 각 조건별 코멘트 + 펼치면 상세 설명도 보이게 해라. 가장 중요한 건 활성/비활성·
          수치가 실 스크리닝에 완벽히 연동되는 것" — 여기서 저장한 값은 electron/tool-engine.ts의
          saveAutoScanSettings → buildAutoScanOpts() → scanScreener()로 그대로 이어져(우회 경로 없음),
          자동매매의 실제 5분 사이클 스캔과 [자동 스크리너] 탭의 [🔄 지금 새로고침]에 곧바로 반영된다. */}
      {paneTab === "screenCriteria" && (
        <main className="grid">
          <section className="card wide">
            <h2>스크리닝 기준 <span className="hint">(조건 전부를 한 곳에서 켜고 끄거나 수치 조절)</span></h2>
            <p className="hint">
              여기서 끈 조건은 스캔할 때 아예 검사하지 않고(항상 통과 취급), 켠 조건은 옆 수치를
              기준으로 실제로 걸러냅니다. 조건마다 짧은 설명이 붙어 있고, <b>[자세히]</b>를 누르면
              더 상세한 설명을 볼 수 있어요. 아래 [저장] 버튼 하나로 이 탭의 조건 전부(14개)가
              저장됩니다 — 자동매매 스크리닝 조건 편집은 <b>이 탭 하나</b>에서만 합니다
              ([자동 스크리너] 탭은 이제 결과를 보는 화면이라, 지금 적용된 값을 읽기 전용으로만
              보여줘요 — 헷갈리지 않게 저장 버튼을 한 곳으로 모았습니다).
            </p>

            {/* ⓪ 스캔 범위(기존 4개 — v0.28.0부터 있던 조건, 항상 켜짐) */}
            <div className="crit-card">
              <div className="crit-head"><b>스캔 범위(항상 켜짐)</b></div>
              <p className="hint">몇 종목을 훑을지, 어떤 가격대만 볼지, 도지로 인정할 몸통 크기 상한을 정해요.</p>
              <div className="screen-filters" style={{ marginTop: 8 }}>
                <label className="str-field sf-num">
                  <span className="sb-k">스캔 종목수 <span className="hint">(10~200)</span></span>
                  <input type="text" inputMode="numeric" value={autoScanForm.scanCount}
                    onChange={(e) => setAutoScanForm({ ...autoScanForm, scanCount: e.target.value })} />
                </label>
                <label className="str-field sf-num">
                  <span className="sb-k">가격 하한 $</span>
                  <input type="text" inputMode="decimal" value={autoScanForm.priceMin}
                    onChange={(e) => setAutoScanForm({ ...autoScanForm, priceMin: e.target.value })} />
                </label>
                <label className="str-field sf-num">
                  <span className="sb-k">가격 상한 $</span>
                  <input type="text" inputMode="decimal" value={autoScanForm.priceMax}
                    onChange={(e) => setAutoScanForm({ ...autoScanForm, priceMax: e.target.value })} />
                </label>
              </div>
              <label className="str-field" style={{ marginTop: 8 }}>
                <span className="sb-k">도지로 인정할 <b>몸통 크기 상한</b>: <b>{(autoScanBodyRatio * 100).toFixed(0)}%</b> <span className="hint">(작을수록 깐깐하게, 최대 80%)</span></span>
                <input type="range" min={0.1} max={0.8} step={0.05} value={autoScanBodyRatio}
                  onChange={(e) => setAutoScanBodyRatio(Number(e.target.value))} />
              </label>
            </div>

            {/* [v0.45.0 — 오너 요청 "매매진행할 장 선택"] 자동매매가 신규 진입을 시도할 세션을
                직접 고른다. [🤖 자동매매 → 자동매매 현황]의 "시스템 휴무 시간대(05:00~17:00 KST)"
                와는 별개의 조건 — 둘 다 켜져 있으면 둘 다 통과해야 진입한다. */}
            <div className="crit-card">
              <div className="crit-head"><b>매매진행할 장(세션) 선택</b></div>
              <p className="hint">
                자동매매가 <b>어느 장에서만 신규 진입을 시도할지</b> 고릅니다. 기존 포지션 감시(익절/
                손절)는 이 설정과 무관하게 항상 계속됩니다. [자동매매 현황]의 "시스템 휴무 시간대
                (05:00~17:00 KST)"가 켜져 있으면 그 시간대는 여기서 뭘 켜 두든 항상 멈춰요 — 둘은
                서로 다른 조건이라 <b>동시에 통과해야</b> 진입합니다.
              </p>
              <div className="screen-filters" style={{ marginTop: 8 }}>
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.dayEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, dayEnabled: e.target.checked })} />
                  데이마켓 <span className="hint">(서머 09:00~17:00 KST)</span>
                </label>
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.preEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, preEnabled: e.target.checked })} />
                  프리마켓 <span className="hint">(서머 17:00~22:30 KST)</span>
                </label>
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.regularEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, regularEnabled: e.target.checked })} />
                  정규장(본장) <span className="hint">(서머 22:30~다음날 05:00 KST)</span>
                </label>
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.afterEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, afterEnabled: e.target.checked })} />
                  애프터마켓 <span className="hint">(서머 05:00~08:50 KST)</span>
                </label>
              </div>
              {!screenCritForm.dayEnabled && !screenCritForm.preEnabled && !screenCritForm.regularEnabled && !screenCritForm.afterEnabled && (
                <p className="hint small danger">⚠️ 전부 꺼져 있으면 자동매매가 어떤 장에서도 신규 진입을 하지 않습니다(기존 포지션 감시만 계속됩니다).</p>
              )}
            </div>

            {/* ① EMA 추세 필터 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.emaTrendEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, emaTrendEnabled: e.target.checked })} />
                  <b>EMA 추세 필터</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("ema")}>{openCritDetail.has("ema") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">주가가 장기 이동평균선(EMA) 위에 있을 때만 후보로 인정해요(상승 추세 확인용).</p>
              {openCritDetail.has("ema") && (
                <p className="hint crit-detail">
                  EMA(지수이동평균, Exponential Moving Average)는 최근 가격에 더 큰 가중치를 주는
                  이동평균선이에요. 주가가 EMA 위에 있으면 "최근 흐름이 상승 쪽"이라고 볼 수 있어서,
                  하락 추세 중에 나온 도지(반전 신호 후보)를 걸러내는 데 씁니다. 기간(N)을 늘리면
                  더 긴 흐름(느긋한 대세 추세)을, 줄이면 더 짧은 흐름(민감한 최근 추세)을 봅니다.
                  <b> 꺼두면 이 조건 자체를 검사하지 않고</b>(추세와 무관하게 도지 패턴만으로 판단),
                  하락 추세 중 반등 시도까지 후보에 포함되어 후보 수는 늘지만 다소 위험할 수 있어요.
                </p>
              )}
              <label className="str-field sf-num" style={{ maxWidth: 200, marginTop: 8 }}>
                <span className="sb-k">EMA 기간(봉 개수) <span className="hint">(50~300, 기본 200)</span></span>
                <input type="text" inputMode="numeric" value={screenCritForm.emaPeriod}
                  disabled={!screenCritForm.emaTrendEnabled}
                  onChange={(e) => setScreenCritForm({ ...screenCritForm, emaPeriod: e.target.value })} />
              </label>
            </div>

            {/* ② 일목균형표 구름대 필터 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.cloudEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, cloudEnabled: e.target.checked })} />
                  <b>구름대(일목균형표) 필터</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("cloud")}>{openCritDetail.has("cloud") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">주가가 일목균형표의 구름(선행스팬) 위에 있을 때만 후보로 인정해요(추세 이중 확인).</p>
              {openCritDetail.has("cloud") && (
                <p className="hint crit-detail">
                  일목균형표의 "구름"은 미래 시점에 미리 그려두는 지지/저항대예요. 주가가 구름 위에
                  있으면 상승 추세, 구름 안이나 아래면 애매하거나 하락 추세로 봅니다. EMA 필터와
                  같은 목적(하락 추세에서의 섣부른 반전 신호 배제)이지만 계산 방식이 달라서, 둘 다
                  켜두면 "이중 확인"이 되어 더 신중해지고(후보 수는 줄어듦), 하나만 켜두면 그만큼
                  덜 깐깐해집니다. <b>꺼두면 구름 위치와 무관하게</b> 통과시킵니다.
                </p>
              )}
            </div>

            {/* ③ 도지 꼬리 비율 */}
            <div className="crit-card">
              <div className="crit-head"><b>도지 꼬리 비율(항상 켜짐)</b></div>
              <p className="hint">도지 캔들의 위/아래 꼬리가 몸통 대비 최소 이 비율 이상이어야 인정해요.</p>
              <button className="mini" onClick={() => toggleCritDetail("wick")}>{openCritDetail.has("wick") ? "▾ 자세히" : "▸ 자세히"}</button>
              {openCritDetail.has("wick") && (
                <p className="hint crit-detail">
                  "도지"는 시가와 종가가 거의 같아 몸통이 작은 캔들을 뜻하는데, 몸통만 작다고 다
                  의미 있는 반전 신호는 아니에요 — 위아래로 삐죽 나온 "꼬리"(고가/저가가 시가·종가에서
                  얼마나 멀리 갔다 왔는지)가 충분히 길어야 "한번 크게 흔들렸다가 원위치로 돌아왔다"는
                  의미 있는 신호가 됩니다. 이 비율을 높이면(예: 30%) 꼬리가 더 긴, 더 확실한 도지만
                  인정하고(후보는 줄지만 신뢰도↑), 낮추면(예: 5%) 웬만한 몸통 작은 캔들도 다 인정해서
                  후보는 늘지만 애매한 신호도 섞입니다. 이 조건은 도지 판정의 핵심이라 끌 수는 없고
                  비율만 조절할 수 있어요.
                </p>
              )}
              <label className="str-field sf-num" style={{ maxWidth: 200, marginTop: 8 }}>
                <span className="sb-k">최소 꼬리 비율 <span className="hint">(0~40%, 기본 10%)</span></span>
                <input type="text" inputMode="decimal" value={screenCritForm.dojiWickMinRatio}
                  onChange={(e) => setScreenCritForm({ ...screenCritForm, dojiWickMinRatio: e.target.value })} />
              </label>
            </div>

            {/* ④ 도지 신선도(유효 시간) */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.dojiMaxAgeEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, dojiMaxAgeEnabled: e.target.checked })} />
                  <b>도지 신선도(유효 시간) 제한</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("freshness")}>{openCritDetail.has("freshness") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">도지가 나타난 뒤 이 시간(분) 안에만 "아직 유효한" 신호로 인정해요.</p>
              {openCritDetail.has("freshness") && (
                <p className="hint crit-detail">
                  도지는 나타난 직후에는 "반전 시도"라는 의미가 있지만, 시간이 많이 지나면 이미 다른
                  흐름으로 넘어갔을 수 있어 뒤늦게 진입하는 게 위험해질 수 있어요. 이 값(분)을 넘긴
                  도지는 "너무 오래돼 이미 늦은 신호"로 보고 후보에서 제외합니다. 값을 늘리면 오래된
                  도지도 계속 유효하다고 보고(후보 수↑, 다만 뒤늦은 진입 위험도 같이 커짐), 줄이면
                  아주 갓 나온 도지만 인정합니다(후보 수↓, 더 신선한 신호만). <b>꺼두면 시간 제한 없이</b>
                  아무리 오래된 도지도 계속 유효한 것으로 봅니다.
                </p>
              )}
              <label className="str-field sf-num" style={{ maxWidth: 200, marginTop: 8 }}>
                <span className="sb-k">유효 시간(분) <span className="hint">(10~180분, 기본 40분)</span></span>
                <input type="text" inputMode="numeric" value={screenCritForm.dojiMaxAgeMinutes}
                  disabled={!screenCritForm.dojiMaxAgeEnabled}
                  onChange={(e) => setScreenCritForm({ ...screenCritForm, dojiMaxAgeMinutes: e.target.value })} />
              </label>
            </div>

            {/* ④-2 [v0.62.1] 최고점→도지 간격 제한 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.dojiMaxGapEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, dojiMaxGapEnabled: e.target.checked })} />
                  <b>최고점 → 도지 간격 제한</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("gap")}>{openCritDetail.has("gap") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">도지가 세션 최고점 "직후" 이 시간(분) 안에 나온 것만 인정해요(고점 후 첫 꺾임).</p>
              {openCritDetail.has("gap") && (
                <p className="hint crit-detail">
                  이 전략은 "급등해서 최고점을 찍은 직후 처음 꺾이는 도지"를 노립니다. 그런데 최고점에서 몇 시간이
                  지난 뒤 우연히 생긴 큰 도지(예: 05:00 고점 → 08:55 도지)는 "고점 후 첫 꺾임"이 아니라 오래
                  눌려 있던 종목의 흔한 잡음 봉이라 매수 근거가 못 돼요. 값을 줄이면 고점 바로 뒤의 도지만,
                  늘리면 더 늦게 나온 도지도 인정합니다. <b>꺼두면 간격 제한 없이</b> 예전처럼 동작합니다.
                </p>
              )}
              <label className="str-field sf-num" style={{ maxWidth: 200, marginTop: 8 }}>
                <span className="sb-k">최대 간격(분) <span className="hint">(5~240분, 기본 30분)</span></span>
                <input type="text" inputMode="numeric" value={screenCritForm.dojiMaxGapMinutes}
                  disabled={!screenCritForm.dojiMaxGapEnabled}
                  onChange={(e) => setScreenCritForm({ ...screenCritForm, dojiMaxGapMinutes: e.target.value })} />
              </label>
            </div>

            {/* [v0.63.0] 방어 필터 ① EMA 최소 이격도 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.emaMinGapEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, emaMinGapEnabled: e.target.checked })} />
                  <b>🛡 EMA 최소 이격도 (방어)</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("emaGap")}>{openCritDetail.has("emaGap") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">전봉 종가가 EMA200보다 이 % 이상 위에 있는 종목만 후보로(카일 제안 6%).</p>
              {openCritDetail.has("emaGap") && (
                <p className="hint crit-detail">
                  EMA200에 바짝 붙어 있는 종목은 조금만 밀려도 EMA 아래로 떨어지기 쉬워요. 이격도는 삼분할 계산과 같은
                  "전봉 종가" 기준입니다. 참고로 1분할 진입가는 전봉 종가~EMA 거리의 1/3 아래라서, 이격도 6%면 실제
                  진입가는 EMA 위 약 4%, 2분할이면 약 2%입니다. 값을 올리면 더 안전한 자리만 남지만 후보 수가 줄어요.
                </p>
              )}
              <label className="str-field sf-num" style={{ maxWidth: 200, marginTop: 8 }}>
                <span className="sb-k">최소 이격도(%) <span className="hint">(0.5~50, 기본 6)</span></span>
                <input type="text" inputMode="decimal" value={screenCritForm.emaMinGapPct}
                  disabled={!screenCritForm.emaMinGapEnabled}
                  onChange={(e) => setScreenCritForm({ ...screenCritForm, emaMinGapPct: e.target.value })} />
              </label>
            </div>

            {/* [v0.63.0] 방어 필터 ② EMA 상승 중 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.emaSlopeEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, emaSlopeEnabled: e.target.checked })} />
                  <b>🛡 EMA200이 상승 중일 것 (방어)</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("emaSlope")}>{openCritDetail.has("emaSlope") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">지금 EMA200이 1시간 전보다 높은(위로 기울어진) 종목만 후보로.</p>
              {openCritDetail.has("emaSlope") && (
                <p className="hint crit-detail">
                  평평하거나 아래로 꺾인 EMA는 "받쳐 주는 힘"이 약해 눌림이 지지되지 않고 그대로 뚫리기 쉬워요.
                  EMA가 아직 올라가고 있는 종목만 고르면 추세가 살아 있는 자리만 남습니다.
                </p>
              )}
            </div>

            {/* [v0.63.0] 방어 필터 ③ 변동성 상한 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.atrFilterEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, atrFilterEnabled: e.target.checked })} />
                  <b>🛡 변동성 상한 (방어)</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("atr")}>{openCritDetail.has("atr") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">5분봉 하나가 평균적으로 이 %보다 크게 출렁이는 종목은 제외.</p>
              {openCritDetail.has("atr") && (
                <p className="hint crit-detail">
                  익절 목표가 1.5% 안팎인데 5분봉 하나가 평균 3~5%씩 움직이는 종목이면, 익절은 잡음 수준이고
                  −10% 급락도 흔한 일이 됩니다(실제 손절 사례는 진입 후 평균 8분 만에 −10%가 난 급락형이었어요).
                  이 %(ATR — 평균 실제 변동폭 ÷ 가격)를 넘는 종목은 후보에서 뺍니다.
                </p>
              )}
              <label className="str-field sf-num" style={{ maxWidth: 200, marginTop: 8 }}>
                <span className="sb-k">최대 변동성(%) <span className="hint">(0.5~20, 기본 3)</span></span>
                <input type="text" inputMode="decimal" value={screenCritForm.atrMaxPct}
                  disabled={!screenCritForm.atrFilterEnabled}
                  onChange={(e) => setScreenCritForm({ ...screenCritForm, atrMaxPct: e.target.value })} />
              </label>
            </div>

            {/* ⑤ 다음봉 확인 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.nextCandleConfirmEnabled}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, nextCandleConfirmEnabled: e.target.checked })} />
                  <b>다음봉 확인 후 확정</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("nextCandle")}>{openCritDetail.has("nextCandle") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">도지 다음 5분봉까지 확인한 뒤에야 "확정"으로 인정해요(성급한 진입 방지).</p>
              {openCritDetail.has("nextCandle") && (
                <p className="hint crit-detail">
                  도지가 나타난 바로 그 순간엔 아직 "관찰(🟡)" 단계일 뿐이에요. 다음 5분봉이 마감될
                  때까지 기다려서, 그 다음 봉이 실제로 반전 방향으로 움직였는지까지 확인한 뒤에야
                  "확정(🔴)"으로 승격시킵니다 — 헛다리(가짜 신호)에 진입하는 걸 줄이는 안전장치예요.
                  <b> 꺼두면 관찰 단계를 곧바로 확정으로 승격</b>시켜, 다음 봉을 기다리지 않고 더 빠르게
                  진입 후보가 되지만, 그만큼 다음 봉의 확인 없이 진입하므로 성급할 수 있어요.
                </p>
              )}
            </div>

            {/* ⑥ ETF/레버리지 제외 */}
            <div className="crit-card">
              <div className="crit-head">
                <label className="radio">
                  <input type="checkbox" checked={screenCritForm.excludeEtf}
                    onChange={(e) => setScreenCritForm({ ...screenCritForm, excludeEtf: e.target.checked })} />
                  <b>ETF·레버리지 상품 제외</b>
                </label>
                <button className="mini" onClick={() => toggleCritDetail("etf")}>{openCritDetail.has("etf") ? "▾ 자세히" : "▸ 자세히"}</button>
              </div>
              <p className="hint">ETF·레버리지 상품은 스크리닝 후보에서 아예 제외해요(개별 종목 위주로 스크리닝).</p>
              {openCritDetail.has("etf") && (
                <p className="hint crit-detail">
                  ETF(상장지수펀드)·레버리지/인버스 상품은 여러 종목을 묶어 추종하거나 배율까지 곱해
                  움직이기 때문에, 개별 종목 하나의 실제 수급(도지·거래량 등)을 보는 이 스크리닝
                  기법과 성격이 달라요. 켜두면 이런 상품들을 후보에서 빼고 순수 개별 종목만 남깁니다.
                  <b> 꺼두면 ETF·레버리지 상품도 다른 종목과 똑같이 스크리닝 대상에 포함</b>됩니다.
                </p>
              )}
            </div>

            <div className="form-row" style={{ marginTop: 12 }}>
              <button className="btn btn-start" onClick={saveScreenCriteriaUI}>스크리닝 기준 저장</button>
              {savedMsg && <span className={savedMsg.startsWith("⚠") ? "err" : "ok"}>{savedMsg}</span>}
            </div>
            {/* [v0.70.0] 자동매매 현황 탭의 "PC 실제값"과 같은 목적 — 폰에서 저장 명령을 보낸 뒤
                "진짜 PC에 반영됐는지"를 PC가 올린 실제값으로 직접 확인한다. */}
            {isWebApp && (
              <p className="hint small">
                📡 PC 실제값:{" "}
                {pcSettings ? (
                  <>
                    {describeScreenCriteria(pcSettings)}
                    {liveStateUpdatedAtMs != null && <> (PC 확인 {new Date(liveStateUpdatedAtMs).toLocaleTimeString("ko-KR", { hour12: false })})</>}
                    {" "}— 위 조건들과 다르면 아직 PC에 반영 전입니다(몇 초 뒤 자동으로 다시 확인해요).
                  </>
                ) : (
                  "아직 PC 상태를 못 받아왔습니다(PC가 켜져 있는지 확인하세요)."
                )}
              </p>
            )}
          </section>
        </main>
      )}

      {/* ===== 🤖 자동매매 → 자동매매기록 (v0.30.0 신규) =====
          [오너 지시 2026-09-26] "자동매매 탭에 자동매매기록 하위탭도 추가" — 자동매매가 낸 매매를
          전부 영속 로그로 남겨(엔진의 autoTradeHistory), 진입→체결확인→청산/취소까지 전체
          생애주기를 한 화면에서 복기할 수 있게 한다(엔진 재시작해도, 포지션이 이미 청산돼
          '지금 감시 중' 목록에서 사라져도 여기 기록은 남는다). */}
      {paneTab === "autoHistory" && (
        <main className="grid">
          <section className="card wide">
            <h2>자동매매기록 <span className="hint">(자동매매가 낸 매매의 전체 이력 — 청산돼도 여기 남습니다)</span></h2>
            <p className="hint">
              진입 접수부터 체결 확인·익절/손절·취소까지, 자동매매가 스스로 낸 매매를 전부 기록해
              둡니다. 위 [자동매매 현황]의 "지금 감시 중" 목록은 끝나면 지워지지만, 여기는 지워지지
              않아요 — 나중에 복기·통계에 쓰세요.
            </p>
            <div className="form-row">
              <button className="mini" disabled={autoHistoryBusy} onClick={() => void loadAutoHistory()}>
                {autoHistoryBusy ? "불러오는 중…" : "↻ 새로고침"}
              </button>
              {/* [v0.64.0] 웹(토스 중계 없음)에서는 숨김 — 대조할 방법 자체가 없다. */}
              {canReconcileLive && (
                <button className="mini" disabled={historyReconcileBusy} onClick={() => void reconcileHistory()}>
                  {historyReconcileBusy ? "토스와 대조 중…" : "🔄 토스 체결과 대조"}
                </button>
              )}
            </div>
            {historyReconcileMsg && <p className="hint">{historyReconcileMsg}</p>}

            {autoHistory.length === 0 ? (
              <div className="result-empty hint">
                {autoHistoryBusy ? "불러오는 중…" : "아직 기록이 없어요. 자동매매를 한 번이라도 켜서 진입이 나가면 여기 쌓입니다."}
              </div>
            ) : (() => {
              const closed = autoHistory.filter((h) => h.status === "closed_win" || h.status === "closed_loss");
              const wins = closed.filter((h) => h.status === "closed_win");
              const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
              // [v0.64.0] "🔄 토스 체결과 대조"로 실제 체결 손익을 확인한 건은 그 값을 우선
              //   쓴다(기록값보다 더 정확하므로) — 아직 대조 안 했거나 토스에서 못 찾은 건은
              //   기존처럼 기록값(h.pnlUsd) 그대로 쓴다(추측하지 않는다).
              const reconciledUsd = closed.some((h) => historyReconcile[h.id]?.realPnlUsd != null);
              const realizedUsd = closed.reduce((sum, h) => sum + (historyReconcile[h.id]?.realPnlUsd ?? h.pnlUsd ?? 0), 0);
              const cancelled = autoHistory.filter((h) => h.status === "cancelled" || h.status === "closed_manual" || h.status === "oco_failed").length;
              const dryrun = autoHistory.filter((h) => h.status === "dryrun").length;
              return (
                <>
                  {/* [v0.30.0] 요약 통계 — 표를 하나하나 세지 않아도 한눈에. */}
                  <div className="sum-cards">
                    <div className="sum-card">
                      <span className="sum-k">총 기록</span>
                      <b className="sum-v">{autoHistory.length}건</b>
                      <span className="sum-sub">청산완료 {closed.length} · 취소/실패 {cancelled}{dryrun > 0 ? ` · 드라이런 ${dryrun}` : ""}</span>
                    </div>
                    <div className="sum-card">
                      <span className="sum-k">승률(청산완료 기준)</span>
                      <b className="sum-v">{winRate != null ? `${winRate.toFixed(1)}%` : "—"}</b>
                      <span className="sum-sub">익절 {wins.length} · 손절 {closed.length - wins.length}</span>
                    </div>
                    <div className={`sum-card ${pnlClass(closed.length ? realizedUsd : null)}`}>
                      <span className="sum-k">누적 실현손익</span>
                      <b className="sum-v">{closed.length ? `${realizedUsd >= 0 ? "+" : ""}$${realizedUsd.toFixed(2)}` : "—"}</b>
                      <span className="sum-sub">
                        익절/손절로 청산된 것만 합산(취소·드라이런 제외)
                        {reconciledUsd && " · 🔄 토스 확인된 건은 실제 체결가 기준"}
                      </span>
                    </div>
                  </div>

                  <table className="result-table screen-table">
                    <thead>
                      <tr><th>진입시각</th><th>종목</th><th>진입가→청산가</th><th>수량</th><th>손익</th><th>상태</th><th>토스 대조</th><th>사유</th><th>진입 당시 설정</th><th>측정(이격·변동성·최대역행/순행·슬리피지)</th></tr>
                    </thead>
                    <tbody>
                      {autoHistory.map((h) => (
                        <tr key={h.id} className="screen-row">
                          <td>{h.enteredAt}{h.exitedAt && <><br /><span className="hint">→ {h.exitedAt}</span></>}</td>
                          <td><b>{h.symbol}</b></td>
                          <td>${h.entry}{h.exitPrice != null && ` → $${h.exitPrice}`}</td>
                          <td>{h.quantity}</td>
                          <td className={pnlClass(h.pnlUsd)}>
                            {h.pnlUsd != null
                              ? `${h.pnlUsd >= 0 ? "+" : ""}$${h.pnlUsd.toFixed(2)}${h.pnlPct != null ? ` (${h.pnlPct >= 0 ? "+" : ""}${h.pnlPct.toFixed(2)}%)` : ""}`
                              : "—"}
                          </td>
                          <td>{AUTO_HIST_STATUS_LABEL[h.status]}</td>
                          {/* [v0.64.0] "🔄 토스 체결과 대조"를 눌러야만 채워진다(안 눌렀으면 "—"). */}
                          <td className="hint small">
                            {(() => {
                              const r = historyReconcile[h.id];
                              if (!r || r.status === "not_applicable") return "—";
                              if (r.status === "matched") return <span className="evid-chip pass">✅ 일치</span>;
                              if (r.status === "enriched")
                                return (
                                  <span className="evid-chip pass" title={`토스 체결: $${r.realPnlUsd?.toFixed(2)} (${r.realPnlPct?.toFixed(2)}%)`}>
                                    🆕 확인됨: {r.realPnlUsd != null ? `${r.realPnlUsd >= 0 ? "+" : ""}$${r.realPnlUsd.toFixed(2)}` : "—"}
                                  </span>
                                );
                              if (r.status === "mismatch")
                                return (
                                  <span className="evid-chip fail" title={`기록 $${h.pnlUsd?.toFixed(2)} vs 토스 $${r.realPnlUsd?.toFixed(2)}`}>
                                    ⚠️ 불일치: 토스 {r.realPnlUsd != null ? `${r.realPnlUsd >= 0 ? "+" : ""}$${r.realPnlUsd.toFixed(2)}` : "—"}
                                  </span>
                                );
                              return <span className="hint">❓ 토스에서 못 찾음</span>; // not_found
                            })()}
                          </td>
                          <td className="hint">{h.note}</td>
                          {/* [v0.45.0 — 오너 요청 "각자 어떤 기준으로 진행했는지도 연구 데이터에"]
                              이 매매가 실제로 어떤 설정으로 들어갔는지 한눈에. 이 필드가 생기기
                              전(v0.45.0 이전)의 옛 기록은 undefined라 "—"로 보인다(정상). */}
                          <td className="hint small">
                            {h.criteriaSnapshot ? (
                              <>
                                {{ day: "데이", pre: "프리", regular: "본장", after: "애프터", closed: "장마감" }[h.criteriaSnapshot.session]} ·
                                {" "}몸통{Math.round(h.criteriaSnapshot.bodyRatio * 100)}% ·
                                {" "}EMA{h.criteriaSnapshot.emaTrendEnabled ? h.criteriaSnapshot.emaPeriod : "끔"} ·
                                {" "}구름{h.criteriaSnapshot.cloudEnabled ? "켬" : "끔"} ·
                                {" "}투입{h.criteriaSnapshot.maxInvestPct}%
                                {h.criteriaSnapshot.slMode === "ema" && <>{" "}· 손절EMA-{h.criteriaSnapshot.emaStopBufferPct}%</>}
                              </>
                            ) : "—"}
                          </td>
                          {/* [v0.63.0 ② 측정] 손절 원인 분석용 — 이 값들이 쌓여야 방어 필터 효과를 숫자로 검증할 수 있다. */}
                          <td className="hint small">
                            {h.entryMetrics || h.maePct != null || h.slippagePct != null ? (
                              <>
                                {h.entryMetrics?.emaGapPct != null && <>이격 {h.entryMetrics.emaGapPct}% · </>}
                                {h.entryMetrics?.atrPct != null && <>ATR {h.entryMetrics.atrPct}% · </>}
                                {h.maePct != null && <>최대역행 {h.maePct}% · </>}
                                {h.mfePct != null && <>최대순행 +{h.mfePct}% · </>}
                                {h.slippagePct != null && <>슬리피지 {h.slippagePct}%</>}
                              </>
                            ) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </section>
        </main>
      )}

      {/* ===== 🤖 자동매매 → 매매연구 (v0.33.0 신규) =====
          [오너 지시 2026-09-28] "자동매매기록을 통한 연구탭을 만들어 데이터를 취합하여 매매연구를
          진행하려고 한다. 기본적으로 나의 계정에 대한 데이터를 토대로." — 자동매매기록(autoHistory,
          위 탭과 같은 원본 데이터)을 lib/auto-research.ts의 순수 함수 summarizeAutoHistory로
          집계해 승률·종목별/시간대별 성적을 보여준다(오너 개인 계정 데이터 기준, 기기 로컬 계산 —
          다른 사용자 데이터는 전혀 안 섞임). */}
      {paneTab === "labResult" && <LabResultTab lab={lab} />}
      {paneTab === "labLive" && <LabLiveTab lab={lab} />}
      {paneTab === "labSignals" && <LabSignalsTab lab={lab} />}
      {paneTab === "labCompare" && <LabCompareTab lab={lab} />}

      {paneTab === "research" && (
        <main className="grid">
          <section className="card wide">
            <h2>매매연구 <span className="hint">(자동매매기록을 모아 승률·종목별/시간대별 성적 분석)</span></h2>
            <p className="hint">
              [자동매매기록] 탭의 데이터를 그대로 모아 계산합니다(새 데이터를 따로 쌓지 않음 — 원본은
              하나).
            </p>
            {/* [v0.35.0] 오너 지시(2026-09-28) — 비공개 그룹(공동개발자·동업자, 가입 자체가 동의 전제)
                전원의 기록을 실명으로 함께 볼 수 있게. 비식별화 없음: 이메일 그대로 노출. */}
            <div className="form-row">
              <button className={researchView === "mine" ? "mini active" : "mini"} onClick={() => setResearchView("mine")}>내 데이터</button>
              <button
                className={researchView === "group" ? "mini active" : "mini"}
                onClick={() => { setResearchView("group"); if (groupMembers === null) void loadGroupResearch(); }}
              >
                그룹 전체
              </button>
              {/* [v0.49.0] Raw Data — 원본을 그대로(가공 없이) 보고 CSV로 꺼내가는 탭.
                  전환할 때 rawSource가 이미 "group"이면 groupMembers도 같이 채워 둔다. */}
              <button
                className={researchView === "raw" ? "mini active" : "mini"}
                onClick={() => { setResearchView("raw"); if (rawSource === "group" && groupMembers === null) void loadGroupResearch(); }}
              >
                Raw Data
              </button>
            </div>

            {researchView === "mine" && (
              <div className="form-row">
                <button className="mini" disabled={autoHistoryBusy} onClick={() => void loadAutoHistory()}>
                  {autoHistoryBusy ? "불러오는 중…" : "↻ 새로고침"}
                </button>
              </div>
            )}

            {/* ===== Raw Data (v0.49.0 신규) =====
                [오너 지시 2026-09-29] "criteriaSnapshot 필드별로 그룹화한 성적 집계" +
                "원본 데이터를 플랫 테이블로 + CSV 내보내기(앱 안에서 상관관계·회귀 분석까지
                시도하지 말 것)". 표본이 매우 적은 비공개 그룹이라, 아래 경고 문구는 절대
                빼지 않는다 — "N%p 높인다" 식 확정적 인과 결론은 여기서 보여주지 않는다,
                "참고용 경향"이라고만 말한다. */}
            {researchView === "raw" ? (
              <>
                <div className="warn-box">
                  ⚠️ <b>통계적 유의성 경고</b> — 카프리는 비공개 소규모 그룹(개발자 3명 내외로
                  알려짐)이라 아래 숫자는 전부 표본이 매우 적습니다. "설정별 성적 비교"는
                  참고용 경향일 뿐, <b>"이 설정이 승률을 몇 %p 높인다" 같은 확정적 인과
                  결론이 아닙니다.</b> 표본이 한두 건만 바뀌어도 숫자가 크게 흔들릴 수 있어요
                  — 진짜 통계 분석(상관관계·회귀 등)이 필요하면 아래 CSV를 받아 Excel·
                  Sheets·Python에서 직접 해 보세요(이 화면은 집계만 보여줍니다).
                </div>

                <div className="form-row">
                  <button className={rawSource === "mine" ? "mini active" : "mini"} onClick={() => setRawSource("mine")}>내 데이터 원본</button>
                  <button
                    className={rawSource === "group" ? "mini active" : "mini"}
                    onClick={() => { setRawSource("group"); if (groupMembers === null) void loadGroupResearch(); }}
                  >
                    그룹 전체 원본
                  </button>
                  {rawSource === "mine" ? (
                    <button className="mini" disabled={autoHistoryBusy} onClick={() => void loadAutoHistory()}>
                      {autoHistoryBusy ? "불러오는 중…" : "↻ 새로고침"}
                    </button>
                  ) : (
                    <button className="mini" disabled={groupResearchBusy} onClick={() => void loadGroupResearch()}>
                      {groupResearchBusy ? "불러오는 중…" : "↻ 그룹 데이터 새로고침"}
                    </button>
                  )}
                </div>

                {(() => {
                  const rows: RawHistoryRow[] = rawSource === "mine"
                    ? autoHistory.map((entry) => ({ entry }))
                    : (groupMembers ?? []).flatMap((m) => m.history.map((entry) => ({ email: m.email, entry })));
                  const busy = rawSource === "mine" ? autoHistoryBusy : groupResearchBusy;

                  if (rows.length === 0) {
                    return (
                      <div className="result-empty hint">
                        {busy ? "불러오는 중…" : "아직 원본 데이터가 없어요."}
                      </div>
                    );
                  }

                  const criteria = summarizeByCriteria(rows.map((r) => r.entry));

                  return (
                    <>
                      <div className="form-row">
                        <button
                          className="mini"
                          onClick={() => downloadCsv(
                            `capri_autotrade_${rawSource}_${new Date().toISOString().slice(0, 10)}.csv`,
                            autoHistoryToCsv(rows),
                          )}
                        >
                          ⬇ CSV로 내보내기 ({rows.length}행)
                        </button>
                      </div>

                      <h3>설정별 성적 비교 <span className="hint">(참고용 경향 · 승/패로 마감된 매매 {criteria.sampleSize}건 기준)</span></h3>
                      {criteria.sampleSize === 0 ? (
                        <div className="result-empty hint">아직 승/패로 마감됐고 진입 당시 설정이 남아있는 매매가 없어요(v0.45.0 이전 기록은 설정이 없습니다).</div>
                      ) : (
                        <div className="criteria-breakdowns">
                          {criteria.breakdowns.map((b) => (
                            <div key={b.field} className="criteria-breakdown">
                              <h4>{b.title}</h4>
                              <table className="result-table screen-table">
                                <thead><tr><th>설정값</th><th>건수</th><th>승률</th><th>누적손익</th><th>평균수익률</th></tr></thead>
                                <tbody>
                                  {b.groups.map((g) => (
                                    <tr key={g.label} className="screen-row">
                                      <td>{g.label}</td>
                                      <td>{g.n}건 ({g.wins}승 {g.losses}패)</td>
                                      <td>{g.winRate != null ? `${g.winRate}%` : "—"}</td>
                                      <td className={pnlClass(g.totalPnlUsd)}>{g.totalPnlUsd >= 0 ? "+" : ""}${g.totalPnlUsd}</td>
                                      <td>{g.avgPnlPct != null ? `${g.avgPnlPct >= 0 ? "+" : ""}${g.avgPnlPct}%` : "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ))}
                        </div>
                      )}

                      <h3>원본 데이터 <span className="hint">({rows.length}행 — 진입 당시 설정 포함, 취소·드라이런 포함 전체)</span></h3>
                      <div className="raw-table-scroll">
                        <table className="result-table screen-table raw-table">
                          <thead>
                            <tr>
                              {rawSource === "group" && <th>회원</th>}
                              <th>진입시각</th><th>종목</th><th>상태</th><th>손익</th><th>세션</th>
                              <th>구름</th><th>EMA</th><th>도지유효</th><th>캔들확인</th><th>ETF제외</th>
                              <th>최대종목</th><th>최대손실%</th><th>최대투입%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(({ email, entry: h }) => {
                              const c = h.criteriaSnapshot;
                              return (
                                <tr key={`${email ?? ""}:${h.id}`} className="screen-row">
                                  {rawSource === "group" && <td className="hint small">{email}</td>}
                                  <td>{h.enteredAt}</td>
                                  <td><b>{h.symbol}</b></td>
                                  <td>{AUTO_HIST_STATUS_LABEL[h.status]}</td>
                                  <td className={pnlClass(h.pnlUsd)}>{h.pnlUsd != null ? `${h.pnlUsd >= 0 ? "+" : ""}$${h.pnlUsd.toFixed(2)}` : "—"}</td>
                                  <td>{c ? { day: "데이", pre: "프리", regular: "본장", after: "애프터", closed: "장마감" }[c.session] : "—"}</td>
                                  <td>{c ? (c.cloudEnabled ? "켬" : "끔") : "—"}</td>
                                  <td>{c ? (c.emaTrendEnabled ? `켬(${c.emaPeriod})` : "끔") : "—"}</td>
                                  <td>{c ? (c.dojiMaxAgeEnabled ? `켬(${c.dojiMaxAgeMinutes}분)` : "끔") : "—"}</td>
                                  <td>{c ? (c.nextCandleConfirmEnabled ? "켬" : "끔") : "—"}</td>
                                  <td>{c ? (c.excludeEtf ? "켬" : "끔") : "—"}</td>
                                  <td>{c?.maxPositions ?? "—"}</td>
                                  <td>{c?.maxLossPct ?? "—"}</td>
                                  <td>{c?.maxInvestPct ?? "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </>
            ) : researchView === "group" ? (
              <>
                <div className="form-row">
                  <button className="mini" disabled={groupResearchBusy} onClick={() => void loadGroupResearch()}>
                    {groupResearchBusy ? "불러오는 중…" : "↻ 그룹 데이터 새로고침"}
                  </button>
                  {groupResearchMsg && <span className={groupResearchMsg.startsWith("⚠") ? "err" : "hint"}>{groupResearchMsg}</span>}
                </div>
                {groupMembers === null || groupMembers.length === 0 ? (
                  <div className="result-empty hint">
                    {groupResearchBusy
                      ? "불러오는 중…"
                      : "아직 그룹에 공유된 기록이 없어요(각자 로그인해서 자동매매를 한 번이라도 돌리면 자동으로 모입니다)."}
                  </div>
                ) : (() => {
                  const g = summarizeGroupHistory(groupMembers);
                  return (
                    <>
                      <p className="hint">
                        그룹 {g.memberCount}명의 기록을 실명(로그인 이메일) 그대로 모았습니다 — 비공개 그룹
                        전원 동의 전제, 비식별화하지 않습니다.
                      </p>
                      {g.headline && (
                        <p className="hint" style={{ fontSize: 14 }}>💡 <b>{g.headline}</b></p>
                      )}
                      {g.overall.n < 10 && (
                        <p className="hint">⚠️ 그룹 전체 승/패 표본이 {g.overall.n}건뿐이에요 — 아직 참고용으로만 보세요.</p>
                      )}
                      <div className="sum-cards">
                        <div className="sum-card">
                          <span className="sum-k">그룹 승/패 표본</span>
                          <b className="sum-v">{g.overall.n}건</b>
                          <span className="sum-sub">회원 {g.memberCount}명</span>
                        </div>
                        <div className="sum-card">
                          <span className="sum-k">그룹 승률</span>
                          <b className="sum-v">{g.overall.winRate != null ? `${g.overall.winRate}%` : "—"}</b>
                          <span className="sum-sub">익절 {g.overall.wins} · 손절 {g.overall.losses}</span>
                        </div>
                        <div className={`sum-card ${pnlClass(g.overall.n ? g.overall.totalPnlUsd : null)}`}>
                          <span className="sum-k">그룹 누적 실현손익</span>
                          <b className="sum-v">{g.overall.n ? `${g.overall.totalPnlUsd >= 0 ? "+" : ""}$${g.overall.totalPnlUsd}` : "—"}</b>
                        </div>
                      </div>

                      <h3>회원별 리더보드 <span className="hint">(누적손익 큰 순, 실명)</span></h3>
                      <table className="result-table screen-table">
                        <thead><tr><th>회원(이메일)</th><th>건수</th><th>승률</th><th>누적손익</th><th>평균수익률</th></tr></thead>
                        <tbody>
                          {g.byMember.map((m) => (
                            <tr key={m.email} className="screen-row">
                              <td><b>{m.email}</b></td>
                              <td>{m.n}건 ({m.wins}승 {m.losses}패) <span className="hint small">전체기록 {m.totalEntries}건</span></td>
                              <td>{m.winRate != null ? `${m.winRate}%` : "—"}</td>
                              <td className={pnlClass(m.totalPnlUsd)}>{m.totalPnlUsd >= 0 ? "+" : ""}${m.totalPnlUsd}</td>
                              <td>{m.avgPnlPct != null ? `${m.avgPnlPct >= 0 ? "+" : ""}${m.avgPnlPct}%` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  );
                })()}
              </>
            ) : autoHistory.length === 0 ? (
              <div className="result-empty hint">
                {autoHistoryBusy ? "불러오는 중…" : "아직 자동매매기록이 없어요. 자동매매를 한 번이라도 켜서 매매가 나가면 여기서 연구할 수 있습니다."}
              </div>
            ) : (() => {
              const r = summarizeAutoHistory(autoHistory);
              return (
                <>
                  {r.headline && (
                    <p className="hint" style={{ fontSize: 14 }}>💡 <b>{r.headline}</b></p>
                  )}
                  {r.overall.n < 10 && (
                    <p className="hint">
                      ⚠️ 아직 승/패로 마감된 매매가 {r.overall.n}건뿐이에요. 표본이 10건 미만이면
                      우연에 좌우되는 폭이 커서, 종목별·시간대별 차이가 커 보여도 아직 "진짜 경향"인지
                      확신하기 이릅니다 — 참고용으로만 보세요.
                    </p>
                  )}

                  <div className="sum-cards">
                    <div className="sum-card">
                      <span className="sum-k">승/패 표본</span>
                      <b className="sum-v">{r.overall.n}건</b>
                      <span className="sum-sub">수동청산 {r.manualCloses} · 취소/실패/드라이런 {r.cancelledCount}(표본 제외)</span>
                    </div>
                    <div className="sum-card">
                      <span className="sum-k">승률</span>
                      <b className="sum-v">{r.overall.winRate != null ? `${r.overall.winRate}%` : "—"}</b>
                      <span className="sum-sub">익절 {r.overall.wins} · 손절 {r.overall.losses}</span>
                    </div>
                    <div className={`sum-card ${pnlClass(r.overall.n ? r.overall.totalPnlUsd : null)}`}>
                      <span className="sum-k">누적 실현손익</span>
                      <b className="sum-v">{r.overall.n ? `${r.overall.totalPnlUsd >= 0 ? "+" : ""}$${r.overall.totalPnlUsd}` : "—"}</b>
                      <span className="sum-sub">평균 {r.overall.avgPnlPct != null ? `${r.overall.avgPnlPct >= 0 ? "+" : ""}${r.overall.avgPnlPct}%` : "—"} · 평균 보유 {r.avgHoldMin != null ? `${r.avgHoldMin}분` : "—"}</span>
                    </div>
                  </div>

                  {(r.best || r.worst) && (
                    <p className="hint">
                      {r.best && <>🏆 최고 매매: <b>{r.best.symbol}</b> {r.best.pnlUsd != null && `+$${r.best.pnlUsd.toFixed(2)}`} ({r.best.enteredAt})</>}
                      {r.best && r.worst && " · "}
                      {r.worst && <>💥 최악 매매: <b>{r.worst.symbol}</b> {r.worst.pnlUsd != null && `${r.worst.pnlUsd >= 0 ? "+" : ""}$${r.worst.pnlUsd.toFixed(2)}`} ({r.worst.enteredAt})</>}
                    </p>
                  )}

                  <h3>종목별 성적 <span className="hint">(손익 합계 큰 순)</span></h3>
                  {r.bySymbol.length === 0 ? (
                    <div className="result-empty hint">아직 승/패로 마감된 매매가 없어요.</div>
                  ) : (
                    <table className="result-table screen-table">
                      <thead><tr><th>종목</th><th>건수</th><th>승률</th><th>누적손익</th><th>평균수익률</th></tr></thead>
                      <tbody>
                        {r.bySymbol.map((s) => (
                          <tr key={s.symbol} className="screen-row">
                            <td><b>{s.symbol}</b></td>
                            <td>{s.n}건 ({s.wins}승 {s.losses}패)</td>
                            <td>{s.winRate != null ? `${s.winRate}%` : "—"}</td>
                            <td className={pnlClass(s.totalPnlUsd)}>{s.totalPnlUsd >= 0 ? "+" : ""}${s.totalPnlUsd}</td>
                            <td>{s.avgPnlPct != null ? `${s.avgPnlPct >= 0 ? "+" : ""}${s.avgPnlPct}%` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  <h3>진입 시각대별 성적 <span className="hint">(KST 기준, 시 단위)</span></h3>
                  {r.byHour.length === 0 ? (
                    <div className="result-empty hint">아직 승/패로 마감된 매매가 없어요.</div>
                  ) : (
                    <table className="result-table screen-table">
                      <thead><tr><th>시각</th><th>건수</th><th>승률</th><th>누적손익</th></tr></thead>
                      <tbody>
                        {r.byHour.map((h) => (
                          <tr key={h.hour} className="screen-row">
                            <td>{String(h.hour).padStart(2, "0")}시</td>
                            <td>{h.n}건 ({h.wins}승 {h.losses}패)</td>
                            <td>{h.winRate != null ? `${h.winRate}%` : "—"}</td>
                            <td className={pnlClass(h.totalPnlUsd)}>{h.totalPnlUsd >= 0 ? "+" : ""}${h.totalPnlUsd}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              );
            })()}
          </section>
        </main>
      )}

      {/* ===== ② 주문 현황 (v0.3.3 토스 스타일) ===== */}
      {paneTab === "orders" && (
        <main className="statusmain">
          {/* --- 공통 도구줄: 새로고침 · 자동갱신 · 상태(미체결/체결) --- */}
          <div className="statusbar">
            <button className="mini" disabled={posBusy || !canReconcileLive} onClick={() => refreshStatusTab()}>↻ 새로고침</button>
            <label className="inline-check" title={canReconcileLive ? undefined : "이 세션은 토스에 직접 연결돼 있지 않아(QR 중계 미연결) 이 탭의 실시간 조회를 쓸 수 없습니다."}>
              <input type="checkbox" checked={autoRefresh} disabled={!canReconcileLive} onChange={(e) => setAutoRefresh(e.target.checked)} /> 30초마다 자동
            </label>
            {posAt && <span className="hint small">마지막 갱신 {posAt}</span>}
            {!canReconcileLive && (
              <span className="hint small danger">
                ⚠️ 이 세션은 토스에 직접 연결돼 있지 않아(QR 중계 미연결) 여기는 조회할 수 없습니다 — PC에서 직접 확인하세요.
              </span>
            )}
            <span className="sb-sep" />
            <span className="sb-k">상태</span>
            <div className="seg">
              <button className={ordStatus === "OPEN" ? "on" : ""} onClick={() => changeOrdStatus("OPEN")}>미체결</button>
              <button className={ordStatus === "CLOSED" ? "on" : ""} onClick={() => changeOrdStatus("CLOSED")}>체결·종료</button>
            </div>
          </div>

          {/* ── 상단 요약: 카드 3개(총평가 / 평가손익 / 당일) ── */}
          {hold?.summary && (
            <div className="sum-cards">
              <div className="sum-card">
                <span className="sum-k">총 평가금액</span>
                <b className="sum-v">{dollarWon(hold.summary.marketValueUsd, hold.summary.marketValueKrw)}</b>
              </div>
              <div className={`sum-card ${pnlClass(hold.summary.pnlUsd)}`}>
                <span className="sum-k">평가손익</span>
                <b className="sum-v">
                  {hold.summary.pnlRate != null ? `${hold.summary.pnlRate >= 0 ? "+" : ""}${hold.summary.pnlRate.toFixed(2)}%` : "—"}
                </b>
                <span className="sum-sub">
                  {hold.summary.pnlUsd != null ? `${hold.summary.pnlUsd >= 0 ? "+" : ""}${dollarWon(hold.summary.pnlUsd, hold.summary.pnlKrw)}` : ""}
                </span>
              </div>
              <div className={`sum-card ${pnlClass(hold.summary.dailyPnlUsd)}`}>
                <span className="sum-k">당일 손익</span>
                <b className="sum-v">
                  {hold.summary.dailyPnlUsd != null ? `${hold.summary.dailyPnlUsd >= 0 ? "+" : ""}${dollarWon(hold.summary.dailyPnlUsd, hold.summary.dailyPnlKrw)}` : "—"}
                </b>
              </div>
            </div>
          )}

          {/* ── 보유 현황(접힘 기본: 손익%·손익액·현재가 3개만) ── */}
          <section className="card wide">
            <h2>보유 현황 <span className="hint small">{hold?.items.length ? `${hold.items.length}종목` : ""}</span></h2>
            {!hold || hold.items.length === 0 ? (
              <p className="hint">보유 종목이 없거나 아직 조회 전입니다. [↻ 새로고침]을 눌러 주세요.</p>
            ) : (
              <div className="hold-list">
                {hold.items.map((h) => {
                  const open = expanded.has(h.symbol);
                  return (
                    <div key={h.symbol} className="hcard">
                      {/* 1행: 종목명 ... 손익%(큼) */}
                      <div className="hcard-r1">
                        <div className="hcard-name min0">
                          <b className="hcard-title">
                            {h.name ?? h.symbol}
                            {/* [v0.30.0] 오너 요청 — 자동매매로 진입된 종목은 접힌 상태에서도 바로 식별되게 */}
                            {h.rationale?.source === "auto" && <span className="badge-auto" title="자동매매가 낸 주문입니다">🤖 자동</span>}
                          </b>
                          <span className="hcard-sub">{h.symbol} · {h.marketCountry === "KR" ? "🇰🇷" : "🇺🇸"}</span>
                        </div>
                        <b className={`hcard-pct ${pnlClass(h.pnlRate)}`}>
                          {h.pnlRate != null ? `${h.pnlRate >= 0 ? "+" : ""}${h.pnlRate.toFixed(2)}%` : "—"}
                        </b>
                      </div>
                      {/* 2행: 수량·현재가 ... 손익액(중간, 색) */}
                      <div className="hcard-r2">
                        <span className="muted">{h.quantity}주 · 현재가 {h.lastPrice != null ? money(h.lastPrice, h.currency, h.currency === "USD" ? fx : null) : "—"}</span>
                        <span className={`hcard-amt ${pnlClass(h.pnlAmt)}`}>
                          {h.pnlAmt != null ? `${h.pnlAmt >= 0 ? "+" : ""}${money(h.pnlAmt, h.currency, h.currency === "USD" ? fx : null)}` : ""}
                        </span>
                      </div>
                      {/* 액션 + 상세 토글 */}
                      <div className="hcard-actions">
                        <button className="mini btn-sell" disabled={status.killSwitch} onClick={() => openSell(h)}>매도</button>
                        <button className="mini btn-oco" disabled={status.killSwitch} onClick={() => openOcoForHolding(h)}>익절/손절</button>
                        <span className="grow" />
                        <button className="mini ghost" onClick={() => toggleExpand(h.symbol)}>{open ? "접기 ▴" : "상세 ▾"}</button>
                      </div>
                      {/* 펼침: 나머지 정보 2열 정의목록 */}
                      {open && (
                        <dl className="hcard-detail">
                          <div><dt>평균매입가</dt><dd>{h.avgPrice != null ? money(h.avgPrice, h.currency, null) : "—"}</dd></div>
                          <div><dt>평가금액</dt><dd>{h.marketValueAmt != null ? money(h.marketValueAmt, h.currency, h.currency === "USD" ? fx : null) : "—"}</dd></div>
                          <div><dt>매입원가</dt><dd>{h.purchaseAmt != null ? money(h.purchaseAmt, h.currency, h.currency === "USD" ? fx : null) : "—"}</dd></div>
                          <div><dt>당일손익</dt><dd className={pnlClass(h.dailyPnlAmt)}>{h.dailyPnlAmt != null ? `${h.dailyPnlAmt >= 0 ? "+" : ""}${money(h.dailyPnlAmt, h.currency, null)}${h.dailyPnlRate != null ? ` (${h.dailyPnlRate.toFixed(2)}%)` : ""}` : "—"}</dd></div>
                          <div><dt>수수료</dt><dd>{h.commission ?? "—"}</dd></div>
                          <div><dt>세금</dt><dd>{h.tax ?? "—"}</dd></div>
                          {h.rationale && (
                            <div className="dl-wide"><dt>매매근거</dt><dd>{rationaleLine(h.rationale)}</dd></div>
                          )}
                        </dl>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* --- 필터 탭 --- */}
          <div className="seg seg-wide">
            <button className={ordTab === "all" ? "on" : ""} onClick={() => setOrdTab("all")}>전체</button>
            <button className={ordTab === "normal" ? "on" : ""} onClick={() => setOrdTab("normal")}>일반주문</button>
            <button className={ordTab === "cond" ? "on" : ""} onClick={() => setOrdTab("cond")}>조건주문</button>
          </div>

          {/* ── 일반 주문 ── */}
          {ordTab !== "cond" && (
            <section className="card wide">
              <h2>일반 주문 <span className="hint">({ordStatus === "OPEN" ? "미체결" : "체결·종료"})</span></h2>
              {ordRows.length === 0 ? (
                <p className="hint">{ordStatus === "OPEN" ? "미체결 주문이 없습니다." : "체결·종료된 주문이 없습니다."}</p>
              ) : (
                <div className="ord-list">
                  {ordRows.map((o) => {
                    const cur = o.currency ?? "USD";
                    const open = expanded.has(o.orderId);
                    return (
                      <div key={o.orderId} className="ord-row">
                        {/* 기본: 방향·종목·상태 ... 핵심(가격·수량) */}
                        <div className="or-line1">
                          <span className={`chip ${o.side === "SELL" ? "chip-sell" : "chip-buy"}`}>{o.side === "SELL" ? "매도" : "매수"}</span>
                          <b className="min0">{o.symbol}</b>
                          <span className={`stbadge st-${o.statusStd}`}>{orderStatusKo(o.statusStd, o.statusRaw)}</span>
                          <span className="grow" />
                          <span className="muted small">{o.orderType === "MARKET" ? "시장가" : (o.price != null ? money(o.price, cur, null) : "—")} · {o.quantity ?? "—"}주</span>
                          {o.isOpen && (
                            <button className="mini" disabled={status.killSwitch} onClick={async () => { await window.kyletool.cancelOrder(o.orderId).catch((e) => alert(`취소하지 못했어요: ${String(e)}`)); refreshStatusTab(); }}>취소</button>
                          )}
                          <button className="mini ghost" onClick={() => toggleExpand(o.orderId)}>{open ? "▴" : "상세 ▾"}</button>
                        </div>
                        {open && (
                          <dl className="ord-detail">
                            {o.orderAmount != null && <div><dt>주문금액</dt><dd>{money(o.orderAmount, cur, cur === "USD" ? fx : null)}</dd></div>}
                            {o.filledQty != null && o.filledQty > 0 && <div><dt>체결</dt><dd>{o.filledQty}주{o.avgFilledPrice != null ? ` @ ${money(o.avgFilledPrice, cur, null)}` : ""}</dd></div>}
                            {(o.commission != null || o.tax != null) && <div><dt>수수료·세금</dt><dd>{o.commission ?? 0}{o.tax != null ? ` · ${o.tax}` : ""}</dd></div>}
                            {o.orderedAt && <div><dt>주문시각</dt><dd>{fmtTime(o.orderedAt)}</dd></div>}
                            {o.filledAt && <div><dt>체결시각</dt><dd>{fmtTime(o.filledAt)}</dd></div>}
                            <div><dt>유형</dt><dd>{o.orderType === "MARKET" ? "시장가" : "지정가"} · {o.timeInForce && o.timeInForce !== "DAY" ? o.timeInForce : "당일만"}</dd></div>
                          </dl>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ── 조건 주문 (OTO/OCO) ── */}
          {ordTab !== "normal" && (
            <section className="card wide">
              <h2>조건 주문 <span className="hint">(정해 둔 가격에 닿으면 자동 실행 · 토스 서버가 대신 감시)</span></h2>
              <p className="hint small">
                <b>매수+익절</b> = 사면서 익절 주문까지 자동 · <b>익절+손절</b> = 갖고 있을 때 둘을 동시에 걸어 둠.
                용어: <b>감시가</b>(이 값에 닿으면 발동) · <b>지정가</b>(실제로 낼 가격).
              </p>
              {condRows.length === 0 ? (
                <p className="hint">{ordStatus === "OPEN" ? "진행 중인 조건주문이 없습니다." : "종료된 조건주문이 없습니다."}</p>
              ) : (
                <div className="cond-list">
                  {condRows.map((c) => {
                    const open = expanded.has(c.conditionalOrderId);
                    return (
                      <div key={c.conditionalOrderId} className="cond-card">
                        {/* 기본: 타입·종목·상태 ... 만료 */}
                        <div className="cc-head">
                          <span className="chip chip-type" title={`토스 주문 종류: ${c.type ?? "조건주문"}`}>{condTypeKo(c.type)}</span>
                          <b className="min0">{c.symbol}</b>
                          <span className="muted small">{c.quantity ?? "—"}주</span>
                          <span className={`stbadge ${c.status === "WATCHING" ? "st-submitted" : "st-filled"}`}>{condStatusKo(c.status)}</span>
                          <span className="grow" />
                          {c.expireDate && <span className="muted small">만료 {c.expireDate}</span>}
                          {c.isOpen && (
                            <button className="mini" disabled={status.killSwitch} onClick={async () => { await window.kyletool.cancelConditional(c.conditionalOrderId).catch((e) => alert(`취소하지 못했어요: ${String(e)}`)); refreshStatusTab(); }}>취소</button>
                          )}
                          <button className="mini ghost" onClick={() => toggleExpand(c.conditionalOrderId)}>{open ? "▴" : "상세 ▾"}</button>
                        </div>
                        {/* 기본: ① 진입 → ② 익절 2단(라벨 + 상태배지만) */}
                        <div className="cc-steps">
                          {c.first && (
                            <span className="step">① {c.type === "OTO" ? "진입" : "감시1"} <span className={`stbadge ${legBadge(c.first.status)}`}>{legStatusKo(c.first.status)}</span></span>
                          )}
                          <span className="step-arrow">→</span>
                          {c.second && (
                            <span className="step">② {c.type === "OTO" ? "익절" : "감시2"} <span className={`stbadge ${legBadge(c.second.status)}`}>{legStatusKo(c.second.status)}</span></span>
                          )}
                        </div>
                        {/* 펼침: 감시가·지정가·근거 */}
                        {open && (
                          <dl className="ord-detail">
                            {c.first && <div className="dl-wide"><dt>① {c.type === "OTO" ? "진입" : "감시1"}</dt><dd>감시가 {c.first.triggerPrice != null ? money(c.first.triggerPrice, "USD", null) : "—"}{c.first.orderPrice != null ? ` · 지정가 ${money(c.first.orderPrice, "USD", null)}` : ""}</dd></div>}
                            {c.second && <div className="dl-wide"><dt>② {c.type === "OTO" ? "익절" : "감시2"}</dt><dd>감시가 {c.second.triggerPrice != null ? money(c.second.triggerPrice, "USD", null) : "—"}{c.second.orderPrice != null ? ` · 지정가 ${money(c.second.orderPrice, "USD", null)}` : ""}</dd></div>}
                            <div><dt>수량</dt><dd>{c.quantity ?? "—"}주</dd></div>
                            <div><dt>유형</dt><dd>{c.orderType === "MARKET" ? "시장가" : "지정가"}</dd></div>
                            {c.rationale && <div className="dl-wide"><dt>매매근거</dt><dd>{rationaleLine(c.rationale)}</dd></div>}
                          </dl>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </main>
      )}

      {/* ===== ④ 설정 (기록 탭은 v0.12.0에서 이 탭 하위 '고급·진단'으로 이동) ===== */}
      {paneTab === "settings" && settings && (
        <main className="grid">
          {/* ══════════════════════════════════════════════════════════════
              [v0.20.0 #4 설정 재정비] 설정 탭을 '자주 쓰는 것 위 / 진단은 아래·접기'
              6그룹으로 재배치했다. 각 기능의 로직·핸들러·저장 방식은 그대로 두고,
              카드 순서·그룹 헤더·일부 라벨/안내문(직관화)만 손질했다.
              순서(위→아래): ① 폰에서 쓰기 → ② 토스 연결 → ③ 동기화 → ④ 화면 표시
                            → ⑤ 주문 기본값·안전 옵션 → ⑥ 고급·진단(접힘)
              === '동기화'는 예전엔 두 곳(매매이력·토스키)에 흩어져 '동기화'라는 말이
                  두 번 나와 헷갈렸다 → ③ 한 카드 안에 ①매매이력 ②토스키 로 나눠 통합. ═══ */}

          {/* [v0.60.0 — 오너 요청 "배포 버전을 앱에서 확인 가능하게"] 화면 오른쪽 아래 구석에
              아주 작고 흐리게(opacity 0.35) 떠 있는 버전 표시가 있긴 했지만, 눈에 띄지 않아
              오너가 못 찾았다 — [설정] 탭 맨 위에 크고 분명하게 하나 더 둔다. */}
          {appVer && (
            <section className="card wide">
              <h2>ℹ️ 버전 정보</h2>
              <p>지금 실행 중인 버전: <b style={{ fontSize: 18 }}>v{appVer}</b></p>
            </section>
          )}

          {/* ── ① 폰에서 쓰기 (데스크톱 앱에서만 보임 — 웹앱엔 이 기능 없음) ── */}
          {window.kyletool.phoneStart && (
            <section className="card wide">
              <h2>📱 폰에서 쓰기</h2>
              <p className="hint">
                이 PC를 <b>중계소</b> 삼아 폰에서도 카프리를 씁니다. 토스는 <b>등록된 인터넷 주소에서만</b> 열려서,
                이 PC(주소가 이미 허용됨)를 거쳐 가는 방식이에요.
                <br />
                아래 [폰 연결 켜기]를 누르고 <b>폰 카메라로 QR을 찍으면</b> 끝 — 폰에서도 시세·주문까지 다 됩니다.
              </p>
              <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="btn"
                  disabled={phoneBusy}
                  onClick={async () => {
                    setPhoneBusy(true);
                    try {
                      setPhone(phone?.url ? await window.kyletool.phoneStop!() : await window.kyletool.phoneStart!());
                    } finally {
                      setPhoneBusy(false);
                    }
                  }}
                >
                  {phoneBusy ? "준비 중…" : phone?.url ? "폰 연결 끄기" : "폰 연결 켜기"}
                </button>
                <span className="hint">상태: {phone?.status ?? "꺼짐"}</span>
              </div>
              {phone?.error && <p className="err">⚠ {phone.error}</p>}
              {phone?.qr && (
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
                  <img src={phone.qr} alt="폰 접속 QR" width={200} height={200} style={{ borderRadius: 8 }} />
                  <div style={{ minWidth: 0 }}>
                    <p className="hint" style={{ margin: "0 0 6px" }}>
                      폰 카메라로 QR을 찍으세요. (또는 아래 주소를 폰 인터넷 창에 붙여넣기)
                    </p>
                    <input readOnly value={phone.url ?? ""} onFocus={(e) => e.currentTarget.select()} style={{ width: "100%" }} />
                    <button
                      className="mini"
                      style={{ marginTop: 6 }}
                      onClick={() => navigator.clipboard.writeText(phone.url ?? "")}
                    >
                      주소 복사
                    </button>
                    <p className="hint" style={{ marginTop: 8 }}>
                      ⚠️ <b>이 앱을 끄거나 PC가 꺼지면</b> 폰에서 조회·주문이 멈춥니다. 주소는 켤 때마다 새로 만들어집니다.
                    </p>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ── ② 토스 연결 (모드 · 실주문 · 토스 키 · 계좌) ──
              이 4가지는 '토스에 연결하고, 진짜 주문을 낼지'를 정하는 한 덩어리다.
              모드·키·계좌는 아래 [연결 정보 저장] 한 버튼으로 함께 저장(saveSettings),
              실주문 켜기는 즉시 저장(독립)이라 위치만 같이 두고 로직은 그대로. */}
          <section className="card wide">
            <h2>🔑 토스 연결</h2>
            <p className="hint">
              토스 증권에 연결하는 부분이에요. <b>토스 키를 넣어야</b> 시세·잔고·주문이 됩니다.
            </p>
            <div className="settings-block">
              <h3>모드 (연습 / 실서버)</h3>
              <label className="radio">
                <input type="radio" checked={formMode === "mock"} onChange={() => setFormMode("mock")} />
                <b>연습 모드</b> — 앱 안의 <b>가짜 서버</b>로 돕니다. 실제 돈과 무관, 주문 넣는 연습까지 마음껏.
              </label>
              <label className="radio">
                <input type="radio" checked={formMode === "live"} onChange={() => setFormMode("live")} />
                <b>실서버 모드</b> — 실제 시세·잔고·환율을 봅니다. 단 <b>주문은 아직 잠금</b>(연습만 되고 실제로는
                안 나감). 소액(1주) 테스트를 사람이 직접 통과시킨 뒤 다음 버전에서 풀립니다.
              </label>
            </div>
            <div className="settings-block">
              <h3>실주문 켜기 {settings.liveOrdersEnabled ? "🔴 켜짐" : "🔒 꺼짐(안전)"}</h3>
              <p className="hint">
                꺼져 있으면 주문 버튼을 눌러도 <b>실제 주문은 안 나가고 연습 기록만</b> 남습니다.
                켜면 <b>진짜 돈으로 주문이 나갑니다.</b> (연습 모드에서는 이 설정과 상관없이 늘 가짜 서버로만 갑니다.)
              </p>
              <label className="radio">
                <input
                  type="checkbox"
                  checked={settings.liveOrdersEnabled}
                  onChange={(e) => void toggleLiveOrders(e.target.checked)}
                />
                <b>진짜 돈으로 주문 나가게 허용</b> — 켤 때 한 번 더 확인을 거칩니다
              </label>
            </div>
            <div className="settings-block">
              <h3>토스 키 {settings.hasClientId && settings.hasClientSecret ? "✅ 저장됨" : "❌ 아직 없음"}</h3>
              <p className="hint">
                토스 개발자센터에서 받은 키를 넣는 곳이에요. 키는 <b>이 컴퓨터 안에만</b> 저장되고(본인만 읽기),
                한 번 저장하면 <b>화면에 다시 보이지 않습니다</b>(보안). 바꿀 때만 다시 입력하세요.
              </p>
              <div className="form-col">
                <label>
                  Client ID (앱 아이디)
                  <input
                    type="password"
                    value={formId}
                    onChange={(e) => setFormId(e.target.value)}
                    placeholder={settings.hasClientId ? "(저장됨 — 바꿀 때만 입력)" : ""}
                  />
                </label>
                <label>
                  Client Secret (앱 비밀키)
                  <input
                    type="password"
                    value={formSecret}
                    onChange={(e) => setFormSecret(e.target.value)}
                    placeholder={settings.hasClientSecret ? "(저장됨 — 바꿀 때만 입력)" : ""}
                  />
                </label>
                <label>
                  계좌 번호 <span className="hint">(보통 1번 — 여러 계좌면 순서 번호)</span>
                  <input value={formAccount} onChange={(e) => setFormAccount(e.target.value)} placeholder="예: 1" />
                </label>
              </div>
            </div>
            <div className="form-row">
              <button className="btn btn-start" onClick={saveSettings}>
                연결 정보 저장 (모드·키·계좌)
              </button>
              {savedMsg && <span className="ok">{savedMsg}</span>}
            </div>
          </section>

          {/* ── ③ 계정 ──
              [v0.59.0] 로그인은 이제 앱을 켜자마자 뜨는 첫 화면에서 끝난다(이 탭에 오는
              순간 이미 로그인·승인된 상태다) — 그래서 로그인 폼은 없애고 상태·동기화
              버튼만 남긴다. 로그인 화면 자체는 App() 맨 앞의 "로그인 게이트" 참고. */}
          <section className="card wide">
            <h2>☁️ 계정</h2>
            <p className="hint">
              토스 키와 매매 이력은 로그인 즉시 이 계정 안에서 자동으로 동기화됩니다.
              다른 사람의 키·매매 이력은 서로 <b>절대 볼 수 없어요</b>.
            </p>
            <div className="form-row">
              <span className="ok">✅ 로그인됨: <b>{authState.email}</b></span>
              <button className="mini" disabled={syncBusy} onClick={doSignOut}>로그아웃</button>
              <button className="btn" disabled={syncBusy} onClick={doSyncNow}>지금 다시 동기화</button>
            </div>
            {authMsg && <p className={authMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{authMsg}</p>}
            {syncMsg && <p className="hint" style={{ whiteSpace: "pre-wrap" }}>{syncMsg}</p>}
            {authState.isOwner && (
              <p className="hint small">📋 가입 승인·디스코드 알림 설정은 [현황 → 👥 그룹원 관리] 탭에서 할 수 있어요.</p>
            )}
          </section>

          {/* ── ④ 화면 표시 — 손익 색 관습(미국식/한국식) ── */}
          <section className="card wide">
            <h2>🎨 화면 표시</h2>
            <label className="radio" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={pnlKr} onChange={(e) => setPnlKr(e.target.checked)} />
              <span>손익 색 <b>한국식</b>으로 (이익 = <b style={{ color: "#f87171" }}>빨강</b> · 손실 = <b style={{ color: "#5b9dff" }}>파랑</b>)</span>
            </label>
            <p className="hint">
              끄면 미국식(이익 = 초록 · 손실 = 빨강, 기본). 색과 함께 <b>부호(+/−)</b>도 늘 표시되어 헷갈리지 않습니다.
              이 설정은 <b>이 기기</b>에만 저장됩니다(폰·PC 각각).
            </p>
          </section>

          {/* ── ⑤ 주문 기본값 · 안전 옵션 ──
              한 번 정해 두면 잘 안 바꾸는 값들 + 원할 때만 켜는 보조 안전장치. 아래쪽에 모음. */}
          <section className="card wide">
            <h2>⚙️ 주문 기본값 · 안전 옵션</h2>
            <p className="hint">한 번 정해 두면 자주 안 바꾸는 값들이에요. 원할 때만 손보세요.</p>

            {/* [v0.8.3] 기본 손익비 설정 */}
            <div className="settings-block">
              <h3>기본 익절% / 손절% (계산기 시작값)</h3>
              <p className="hint">
                계산기 <b>익절%·손절% 칸에 처음 채워질 값</b>을 정해 둡니다. 앱을 껐다 켜거나 종목을 바꿔도 유지돼요
                (계산할 때 그때그때 고치는 건 여전히 가능). 지금 값: <b>익절 {settings.defaultTpPct ?? 2}% / 손절 {settings.defaultSlPct ?? 10}%</b>
              </p>
              <div className="form-row">
                <label>기본 익절 %
                  <input type="text" inputMode="decimal" value={defForm.tp} onChange={(e) => isNumericDraft(e.target.value) && setDefForm({ ...defForm, tp: e.target.value })} placeholder="예: 2" />
                </label>
                <label>기본 손절 %
                  <input type="text" inputMode="decimal" value={defForm.sl} onChange={(e) => isNumericDraft(e.target.value) && setDefForm({ ...defForm, sl: e.target.value })} placeholder="예: 10" />
                </label>
                <button className="btn btn-start" onClick={saveDefaults}>기본 손익비 저장</button>
                {savedMsg && <span className={savedMsg.startsWith("⚠") ? "err" : "ok"}>{savedMsg}</span>}
              </div>
              <p className="hint small">처음 값은 익절 2% / 손절 10%. 소수점(예: 2.5)도 되고, 0 이하는 저장 안 됩니다.</p>
            </div>

            {/* [v0.3.0] 세션별 시드 비율 설정 */}
            <div className="settings-block">
              <h3>장별 매수 비율 (진입 수량 자동 제안)</h3>
              <p className="hint">
                장(프리마켓·데이마켓·본장)마다 <b>가진 돈의 몇 %로 살지</b> 정해 둡니다. 계산기가 지금이 어느 장인지
                자동으로 보고 <b>살 수량을 제안</b>해요(강제 아님 — 다른 수량을 넣어도 그대로 나갑니다).
              </p>
              <div className="form-row">
                <label>데이마켓 %
                  <input type="text" inputMode="decimal" value={seedForm.day} onChange={(e) => isNumericDraft(e.target.value) && setSeedForm({ ...seedForm, day: e.target.value })} placeholder="90" />
                </label>
                <label>프리마켓 %
                  <input type="text" inputMode="decimal" value={seedForm.pre} onChange={(e) => isNumericDraft(e.target.value) && setSeedForm({ ...seedForm, pre: e.target.value })} placeholder="50" />
                </label>
                <label>정규장(본장) %
                  <input type="text" inputMode="decimal" value={seedForm.regular} onChange={(e) => isNumericDraft(e.target.value) && setSeedForm({ ...seedForm, regular: e.target.value })} placeholder="50" />
                </label>
              </div>
              <p className="hint">몇 %의 '기준 금액'을 무엇으로 볼지:</p>
              <label className="radio">
                <input type="radio" checked={seedForm.basis === "auto"} onChange={() => setSeedForm({ ...seedForm, basis: "auto" })} />
                <b>계좌의 살 수 있는 돈(예수금)으로 자동</b> — 지금 계좌 달러 잔고 기준 (기본)
              </label>
              <label className="radio">
                <input type="radio" checked={seedForm.basis === "fixed"} onChange={() => setSeedForm({ ...seedForm, basis: "fixed" })} />
                <b>고정 금액 직접 입력</b> — 아래 달러 금액을 기준으로 사용
              </label>
              {seedForm.basis === "fixed" && (
                <div className="form-row">
                  <label>고정 기준 금액 $
                    <input type="text" inputMode="decimal" value={seedForm.fixed} onChange={(e) => isNumericDraft(e.target.value) && setSeedForm({ ...seedForm, fixed: e.target.value })} placeholder="예: 1000" />
                  </label>
                </div>
              )}
              <div className="form-row">
                <button className="btn btn-start" onClick={saveSeed}>매수 비율 저장</button>
                {savedMsg && <span className={savedMsg.startsWith("⚠") ? "err" : "ok"}>{savedMsg}</span>}
                <span className="hint">예) 데이 90%, 기준 $1,000, 현재가 $10 → 제안 약 90주</span>
              </div>
            </div>

            {/* [v0.20.0] 주문 편의·안전 옵션 — 원할 때만 켜는 보조 기능 */}
            <div className="settings-block">
              <h3>보조 안전 옵션 (원할 때만 켜기)</h3>
              <p className="hint">
                평소엔 <b>앱이 주문을 막지 않습니다.</b> 아래는 실수를 줄이려고 <b>원할 때만</b> 켜는 보조 기능이에요.
              </p>
              <label className="radio">
                <input
                  type="checkbox"
                  checked={settings.priceGuardEnabled}
                  onChange={async (e) => {
                    await window.kyletool.setPriceGuard(e.target.checked, toNum(guardPct) ?? undefined);
                    setSettings(await window.kyletool.getSettings());
                  }}
                />
                <b>오입력 방지</b> — 현재가에서 <b>너무 동떨어진 가격</b>이면 경고하고 막기
              </label>
              <div className="form-row">
                <label>
                  허용 차이 (%)
                  <input
                    type="text"
                    inputMode="decimal"
                    value={guardPct}
                    onChange={(e) => isNumericDraft(e.target.value) && setGuardPct(e.target.value)}
                    placeholder="예: 15"
                  />
                </label>
                <button
                  className="mini"
                  onClick={async () => {
                    await window.kyletool.setPriceGuard(settings.priceGuardEnabled, toNum(guardPct) ?? undefined);
                    setSettings(await window.kyletool.getSettings());
                    setSavedMsg("오입력 방지 한도를 저장했습니다.");
                    setTimeout(() => setSavedMsg(""), 3000);
                  }}
                >
                  한도 저장
                </button>
                {savedMsg && <span className={savedMsg.startsWith("⚠") ? "err" : "ok"}>{savedMsg}</span>}
                <span className="hint">현재: {settings.priceGuardEnabled ? `켜짐 (±${settings.priceGuardPct}%)` : "꺼짐 (막지 않음)"}</span>
              </div>
              <label className="radio">
                <input
                  type="checkbox"
                  checked={settings.skipOrderConfirm}
                  onChange={async (e) => {
                    await window.kyletool.setSkipConfirm(e.target.checked);
                    setSettings(await window.kyletool.getSettings());
                    await refreshStatus();
                  }}
                />
                <b>주문 확인 팝업 건너뛰기</b> — 버튼을 누르면 <b>바로 전송</b>(실수 주문 위험 ↑, 권장 안 함)
              </label>
              {/* [v0.44.0] 시스템 휴무 시간대(05:00~17:00 KST) — 스크리닝·수동주문·자동매매 신규
                  진입을 전부 막는 오너 결정. 기본 켜짐, 여기서만 끌 수 있다. */}
              <label className="radio">
                <input
                  type="checkbox"
                  checked={settings.systemPauseEnabled}
                  onChange={async (e) => {
                    // [v0.61.6 — ③ 전수조사 중간-1, 오너 승인] 웹(폰)에서는 로컬(의미 없는) 엔진의
                    //   플래그만 바뀌어 PC의 실제 스캔·주문 차단 여부는 그대로였다 — 원격 명령으로
                    //   보낸다(결과를 바로 되읽어올 방법은 아직 없어 "보냈다" 메시지까지만).
                    if (isWebApp) {
                      const r = await window.kyletool.sendCommand("saveSystemPauseEnabled", { enabled: e.target.checked });
                      setAutoToggleMsg(r.ok ? "✅ PC로 휴무 시간대 설정 명령을 보냈습니다." : `⚠️ ${r.message}`);
                      return;
                    }
                    setSettings(await window.kyletool.saveSystemPauseEnabled(e.target.checked));
                    setSystemPause(await window.kyletool.getSystemPauseStatus());
                  }}
                />
                <b>시스템 휴무 시간대(05:00~17:00 KST)</b> — 이 시간엔 스크리닝·수동 주문·자동매매
                신규 진입을 전부 막습니다(토스 데이마켓 합성시세 구간을 피하기 위함, 17:00 프리마켓
                시작과 동시에 자동 재개). 취소·조회·기존 포지션 감시는 이 시간에도 그대로 됩니다.
                켜져 있으면 휴장일(주말·미국 공휴일)에도 똑같이 자동으로 멈춥니다.
              </label>
            </div>
          </section>
        </main>
      )}

      {/* [v0.56.0] "서버 로그" — 예전엔 [설정] 안에 접혀 있던 "고급·도구 기록"을 독립 탭으로
          뺐다. 카테고리 토글(오너 지시 "카테고리화 토글로 원하는 데이터를 식별")을 추가해
          문제 확인이 쉽도록 고도화했다. */}
      {paneTab === "journal" && (
        <main className="pane">
          <section className="card wide">
            <h2>🛠 서버 로그 (문제 확인용 상세 기록)</h2>
            <p className="hint">
              카프리가 실제로 한 일(주문·인증·동기화·자동매매·오류 등)을 시간순으로 전부 남깁니다.
              아래 카테고리 토글로 원하는 것만 골라 볼 수 있어요(전부 꺼짐 = 전체 표시).
            </p>
            <div className="form-row" style={{ flexWrap: "wrap", gap: 10 }}>
              {JOURNAL_CATEGORIES.map((c) => (
                <label key={c} className="cat-chip">
                  <input
                    type="checkbox"
                    checked={journalCategoryFilter.has(c)}
                    onChange={(e) => {
                      setJournalCategoryFilter((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(c); else next.delete(c);
                        return next;
                      });
                    }}
                  />
                  <span>{JOURNAL_CATEGORY_ICON[c]} {c}</span>
                </label>
              ))}
              {journalCategoryFilter.size > 0 && (
                <button className="mini" onClick={() => setJournalCategoryFilter(new Set())}>전체 보기(필터 해제)</button>
              )}
            </div>
            <div className="logbox tall" style={{ marginTop: 8 }}>
              {filteredJournal.length === 0 && <div className="logline hint">해당하는 기록이 없습니다.</div>}
              {filteredJournal.map((j, i) => (
                <div key={i} className="logline">
                  <span className="log-ts">{j.ts}</span>{" "}
                  <span className="hint small">[{JOURNAL_CATEGORY_ICON[j.category ?? "시스템"]} {j.category ?? "시스템"}]</span>{" "}
                  {j.summary}
                </div>
              ))}
            </div>
          </section>
        </main>
      )}

      {/* [v0.56.0] "그룹원 관리" — 가입 승인·이메일 직접 등록(예전엔 설정 안에 있었음)을
          독립 탭으로 빼고, 그룹원 근황 현황판·그룹 채팅을 새로 추가했다(오너 요청). */}
      {paneTab === "groupManage" && (
        <main className="pane">
          {authState.isOwner && (
            <section className="card wide">
              <h2>📋 가입 승인 대기 ({pendingAccounts.length}건)</h2>
              <p className="hint">
                가입하면 바로 여기 쌓입니다(계정은 이미 만들어졌고 승인 전엔 아무 데이터도 못 봅니다).
                PC가 꺼져 있어도, 폰으로 로그인만 하면 이 화면에서 바로 처리할 수 있어요. 디스코드
                웹훅을 아래에 설정해 두면 새 신청이 올 때마다 알림도 옵니다.
              </p>
              <button className="mini" onClick={() => void loadPendingAccounts()}>🔄 새로고침</button>
              {pendingAccounts.length === 0 ? (
                <p className="hint">대기 중인 계정이 없습니다.</p>
              ) : (
                pendingAccounts.map((a) => (
                  <div key={a.userId} className="form-row">
                    <span>{a.email} <span className="hint small">({DateTime.fromISO(a.requestedAt).setZone("Asia/Seoul").toFormat("MM-dd HH:mm")})</span></span>
                    <button className="btn btn-start" disabled={pendingActionBusy === a.userId} onClick={() => void doDecideAccount(a.userId, "approved")}>✅ 승인</button>
                    <button className="mini" disabled={pendingActionBusy === a.userId} onClick={() => void doDecideAccount(a.userId, "rejected")}>거절</button>
                  </div>
                ))
              )}
              {pendingDecideMsg && (
                <p className={pendingDecideMsg.includes("⚠️") ? "hint small danger" : "hint small ok"} style={{ whiteSpace: "pre-wrap" }}>
                  {pendingDecideMsg}
                </p>
              )}
            </section>
          )}

          {authState.isOwner && (
            <section className="card wide">
              <h2>🔔 디스코드 알림</h2>
              <p className="hint">
                새 가입 신청이 오면 이 주소로 디스코드 알림이 갑니다(앱이 꺼져 있어도 — 서버(DB)가
                직접 보냅니다). 디스코드 채널 설정 → 연동 → 웹후크 만들기에서 주소를 복사해 붙여넣으세요.
              </p>
              <div className="form-row">
                <input
                  type="text"
                  style={{ flex: 1 }}
                  placeholder="https://discord.com/api/webhooks/…"
                  value={discordWebhook}
                  disabled={discordSaveBusy}
                  onChange={(e) => setDiscordWebhook(e.target.value)}
                />
                <button className="btn btn-start" disabled={discordSaveBusy} onClick={() => void doSaveDiscordWebhook()}>
                  {discordSaveBusy ? "저장 중…" : "저장"}
                </button>
              </div>
              {discordMsg && <p className={discordMsg.startsWith("✅") ? "ok" : "hint"}>{discordMsg}</p>}
            </section>
          )}

          {/* [v0.59.0] 예전 승인 요청함(capri_access_requests) — 가입 자체가 막히던 옛 모델의
              흔적. 지금은 가입이 항상 성공해 위 "가입 승인 대기"가 진짜 목록이지만, 이메일을
              미리 등록해 두고 싶을 때(아직 가입 전인 사람) 쓰는 보조 경로로 그대로 남겨 둔다. */}
          {authState.isOwner && (
            <section className="card wide">
              <h2>📮 이메일 미리 등록 ({accessRequests.length}건 대기)</h2>
              <p className="hint small">
                아직 가입 전인 사람의 이메일을 미리 허용 목록에 넣어 두고 싶을 때 씁니다(선택 사항 —
                위 목록만으로도 충분합니다. 가입하면 자동으로 대기 목록에 올라갑니다).
              </p>
              <button className="mini" onClick={loadAccessRequests}>🔄 새로고침</button>
              {accessRequests.length > 0 &&
                accessRequests.map((r) => (
                  <div key={r.email} className="form-row">
                    <span>{r.email}</span>
                    <button className="btn btn-start" disabled={reqActionBusy === r.email} onClick={() => doApproveRequest(r.email)}>✅ 승인</button>
                    <button className="mini" disabled={reqActionBusy === r.email} onClick={() => doRejectRequest(r.email)}>거절</button>
                  </div>
                ))}
              <div className="form-row">
                <input
                  type="email"
                  placeholder="example@gmail.com"
                  value={directAddEmail}
                  disabled={directAddBusy}
                  onChange={(e) => setDirectAddEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void doDirectAddEmail(); }}
                />
                <button className="btn btn-start" disabled={directAddBusy} onClick={() => void doDirectAddEmail()}>
                  {directAddBusy ? "등록 중…" : "➕ 이메일 등록"}
                </button>
              </div>
              {directAddMsg && <p className={directAddMsg.startsWith("✅") ? "ok" : "hint"}>{directAddMsg}</p>}
            </section>
          )}

          <section className="card wide">
            <h2>👥 그룹원 근황</h2>
            <p className="hint">
              그룹 전체 자동매매기록을 3분마다 자동으로 서로 주고받습니다(로그인 상태일 때만).
              로그인만 하고 아직 매매 기록을 한 번도 안 올린 그룹원은 "아직 기록 없음"으로 보여요.
            </p>
            <button className="mini" disabled={groupResearchBusy} onClick={() => void loadGroupResearch()}>🔄 지금 새로고침</button>
            {groupMembers === null ? (
              <p className="hint">아직 안 받아왔습니다 — 위 새로고침을 눌러 주세요(로그인 필요).</p>
            ) : groupMembers.length === 0 ? (
              <p className="hint">그룹원 기록이 아직 없습니다.</p>
            ) : (
              <table className="result-table">
                <thead>
                  <tr><th>이메일</th><th>기록 건수</th><th>마지막 매매</th></tr>
                </thead>
                <tbody>
                  {groupMembers.map((m) => {
                    const last = m.history[0]; // getAutoTradeHistory와 동일 관례: 최신이 앞
                    return (
                      <tr key={m.email}>
                        <td>{m.email}</td>
                        <td>{m.history.length}건</td>
                        <td>{last ? `${last.symbol} · ${last.enteredAt}` : "아직 기록 없음"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="card wide">
            <h2>💬 그룹 채팅</h2>
            <p className="hint">가입 허용목록에 있는 그룹원 전원이 실명으로 함께 보는 대화방입니다.</p>
            <button className="mini" disabled={chatBusy} onClick={() => void loadGroupChat()}>🔄 새로고침</button>
            <div className="logbox tall" style={{ marginTop: 8 }}>
              {groupChat.length === 0 && <div className="logline hint">아직 메시지가 없습니다.</div>}
              {groupChat.map((m) => (
                <div key={m.id} className="logline">
                  <span className="log-ts">{DateTime.fromISO(m.createdAt).setZone("Asia/Seoul").toFormat("MM-dd HH:mm")}</span>{" "}
                  <b>{m.email}</b>: {m.body}
                </div>
              ))}
            </div>
            <div className="form-row" style={{ marginTop: 8 }}>
              <input
                style={{ flex: 1 }}
                placeholder="메시지 입력…"
                value={chatInput}
                disabled={chatBusy}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void doSendChat(); }}
              />
              <button className="btn btn-start" disabled={chatBusy || !chatInput.trim()} onClick={() => void doSendChat()}>전송</button>
            </div>
            {chatErr && <p className="hint">⚠️ {chatErr}</p>}
          </section>
        </main>
      )}

      {/* [v0.61.9 — 오너 지시 "업데이트 내역 탭 신설"] 그룹 전원이 함께 보는 공개 변경 로그.
          제가(Claude) 매 버전마다 "오너에게 보고하는 것처럼" 고민·원인·수정 내용을 민감사항
          (실제 종목명·손익 금액·계좌 세부사항)만 뺀 채 적어 둔다 — 쓰기는 오너 계정만 가능
          (서버에서 직접, 이 화면엔 글쓰기 버튼이 없다). */}
      {paneTab === "autoReport" && (
        <main className="pane">
          <section className="card wide">
            <h2>📑 자동매매 리포트</h2>
            <p className="hint">
              자동매매를 켠 뒤 끌 때까지(또는 앱이 꺼질 때까지)를 "한 번의 운용"으로 보고, 그 동안의 성적을 한 장으로 정리합니다.
              ① 운용 개요 ② 수익·자산 ③ 매매 통계 ④ 포지션·시스템. 맨 위가 가장 최근 운용이며, 진행 중이면 "현재까지" 기준입니다.
            </p>
            <button className="mini" disabled={autoReportBusy} onClick={() => void loadAutoReports()}>
              {autoReportBusy ? "불러오는 중…" : "🔄 새로고침"}
            </button>
            {autoReportMsg && <p className="hint">{autoReportMsg}</p>}
            {autoReports.length === 0 && !autoReportBusy && (
              <p className="hint">아직 운용 기록이 없습니다. 자동매매를 한 번 켰다 끄면 이곳에 리포트가 생겨요.</p>
            )}
            {autoReports.map((r, ri) => (
              <details key={r.runId} className="changelog-entry" open={ri === 0}>
                <summary style={{ cursor: "pointer", fontWeight: 700, padding: "6px 0" }}>
                  {DateTime.fromMillis(r.overview.startedAtMs).setZone("Asia/Seoul").toFormat("MM-dd HH:mm")} 시작
                  {r.live ? " · 🟢 진행 중(현재까지)" : ` · 종료: ${r.overview.endReason}`}
                  {r.trades ? ` · 매매 ${r.trades.total}건` : ""}
                </summary>
                <div className="hist-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "6px 0" }}>
                  <button className="mini" onClick={() => void copyReportText(reportToMarkdown(r), "리포트(마크다운)")}>📋 리포트 복사</button>
                  <button className="mini" onClick={() => void copyReportText(reportAiPrompt(r), "AI 분석용 프롬프트+리포트")}>🤖 AI 분석용으로 복사</button>
                </div>
                <table className="result-table">
                  <tbody>
                    <tr><th colSpan={2}>① 운용 개요</th></tr>
                    <tr><td>운용 시간</td><td>{DateTime.fromMillis(r.overview.startedAtMs).setZone("Asia/Seoul").toFormat("yyyy-MM-dd HH:mm")} ~ {r.live ? "진행 중" : DateTime.fromMillis(r.overview.endedAtMs).setZone("Asia/Seoul").toFormat("yyyy-MM-dd HH:mm")} (총 {fmtDuration(r.overview.uptimeMs)})</td></tr>
                    <tr><td>사이클·스크리닝 횟수</td><td>{r.overview.loopCount}회 중 스크리닝 {r.overview.scanCount}회</td></tr>
                    <tr><td>종료 사유</td><td>{r.overview.endReason}</td></tr>
                    <tr><th colSpan={2}>② 수익·자산</th></tr>
                    <tr><td>시작 → 종료 자산(추정)</td><td>{r.money.startAssetsUsd != null ? `$${r.money.startAssetsUsd.toFixed(2)}` : "—"} → {r.money.endAssetsUsd != null ? `$${r.money.endAssetsUsd.toFixed(2)}` : "—"}</td></tr>
                    <tr><td>실현 손익(총 / 수수료 추정 / 순)</td><td className={pnlClass(r.money.realizedNetUsd)}>{r.money.realizedGrossUsd >= 0 ? "+" : ""}${r.money.realizedGrossUsd.toFixed(2)} / {r.money.estFeesUsd != null ? `$${r.money.estFeesUsd.toFixed(2)}` : "추정 불가"} / <b>{r.money.realizedNetUsd >= 0 ? "+" : ""}${r.money.realizedNetUsd.toFixed(2)}{r.money.returnPct != null ? ` (${r.money.returnPct}%)` : ""}</b></td></tr>
                    <tr><td>최대 낙폭(MDD)</td><td>${r.money.mddUsd.toFixed(2)}{r.money.mddPct != null ? ` (${r.money.mddPct}%)` : ""}</td></tr>
                    <tr><td>슬리피지</td><td>{r.money.slippage}</td></tr>
                    <tr><th colSpan={2}>③ 매매 통계</th></tr>
                    <tr><td>총 매매(청산 완료)</td><td>{r.trades.total}건 (이익 {r.trades.wins} / 손실 {r.trades.losses})</td></tr>
                    <tr><td>승률</td><td>{r.trades.winRatePct != null ? `${r.trades.winRatePct}%` : "—"}</td></tr>
                    <tr><td>손익비(총이익÷총손실)</td><td>{r.trades.profitFactorLabel} <span className="hint">(이익 ${r.trades.grossProfitUsd.toFixed(2)} / 손실 ${r.trades.grossLossUsd.toFixed(2)})</span></td></tr>
                    <tr><td>평균 보유 시간</td><td>{r.trades.avgHoldMs != null ? fmtDuration(r.trades.avgHoldMs) : "—"}</td></tr>
                    <tr><th colSpan={2}>④ 포지션·시스템</th></tr>
                    <tr><td>종료 시점 보유·대기</td><td>{r.positions.openAtEnd.length === 0 ? "없음" : r.positions.openAtEnd.map((p) => `${p.symbol}(${p.status === "active" ? "보유" : "대기"} $${p.entry}×${p.quantity})`).join(", ")}</td></tr>
                    <tr><td>오류 로그 요약</td><td>타임아웃 {r.system.apiTimeouts} · 자동 재시도 {r.system.apiRetries} · 요청 실패 {r.system.apiFailures} · 사이클 예외 {r.system.cycleErrors}</td></tr>
                  </tbody>
                </table>
                <details>
                  <summary className="hint">계산 기준·한계 보기</summary>
                  <ul className="hint">
                    {r.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                </details>
              </details>
            ))}
          </section>
        </main>
      )}

      {paneTab === "changelog" && (
        <main className="pane">
          <section className="card wide">
            <h2>🆕 업데이트 내역</h2>
            <p className="hint">
              버전이 올라갈 때마다 무엇을 왜 고쳤는지, Claude가 어떻게 원인을 찾고 고민했는지를
              여기 남깁니다 — 그룹원 전원이 함께 봅니다(민감사항은 뺐습니다).
            </p>
            <button className="mini" disabled={changelogBusy} onClick={() => void loadChangelog(false)}>
              {changelogBusy ? "불러오는 중…" : "🔄 새로고침"}
            </button>
            {changelog.length === 0 ? (
              <p className="hint">{changelogBusy ? "불러오는 중…" : "아직 등록된 업데이트 내역이 없습니다."}</p>
            ) : (
              changelog.map((c) => (
                // [v0.62.3] 제목+날짜만 한 줄씩 보이고, 누르면 본문이 펼쳐지는 아코디언(기본 접힘) — 목록 가시성용.
                <details key={c.version} className="cl-item">
                  <summary>
                    <span className="cl-ver">v{c.version}</span>
                    <span className="cl-title">{c.title}</span>
                    <span className="cl-date">
                      {DateTime.fromISO(c.publishedAt).setZone("Asia/Seoul").toFormat("yyyy-MM-dd HH:mm")} KST
                    </span>
                  </summary>
                  <div className="changelog-body">{c.body}</div>
                </details>
              ))
            )}
          </section>
        </main>
      )}
          </div>
        ))}
      </div>

      {/* [v0.61.9] 로그인 직후 아직 못 본 최신 업데이트가 있으면 뜨는 팝업(폰·PC 둘 다). */}
      {unseenChangelog && (
        <div className="modal-back" onClick={dismissChangelogPopup}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>🆕 새 업데이트 — v{unseenChangelog.version}</h2>
            <p><b>{unseenChangelog.title}</b></p>
            <div className="changelog-body">{unseenChangelog.body}</div>
            <div className="form-row">
              <button className="btn btn-start" onClick={dismissChangelogPopup}>확인했어요</button>
              <button
                className="mini"
                onClick={() => {
                  dismissChangelogPopup();
                  goToTab("changelog");
                  activateTab("changelog");
                }}
              >
                업데이트 내역 전체 보기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== [v0.2.8] 조건주문 편집 창 — 값은 오너가 자유롭게 고친다 ===== */}
      {ocoEdit && (
        <div className="modal-back">
          <div className="modal">
            <h2>익절+손절 걸기 — {symbol.toUpperCase()}</h2>
            {/* [v0.3.1] 보유 0주 안내 — 익절/손절은 '매도'라 보유분이 있어야 등록된다.
                막지는 않고(원하면 그대로 전송), 이번 같은 422(insufficient-sellable-quantity)를
                누르기 전에 이해하도록 친절히 알려준다. */}
            {cap && (cap.sellableQty ?? cap.heldQty) === 0 && (
              <div className="warn-box">
                ⚠️ 이 종목은 <b>보유 0주</b>입니다. 익절·손절은 <b>매도</b>라 보유분이 있어야 토스에 등록돼요.
                <br />
                먼저 <b>[매수만 (지정가)]로 사서 체결된 걸 확인</b>한 뒤 걸어 주세요. (그래도 보내면 토스가 "보유 수량 없음"으로 거부해요)
              </div>
            )}
            <p className="hint">
              계산한 값을 참고로 채워 뒀어요. <b>원하는 값으로 자유롭게 고치세요.</b> 앱이 값을 막지 않고 그대로 토스에
              보내며, 토스가 거부하면 그 이유를 화면에 보여드립니다.
              {curPrice != null && <> 현재가 <b>{usdKrw(curPrice, fx)}</b></>}
              {cap && (
                <>
                  {" · "}보유 <b>{cap.heldQty != null ? `${cap.heldQty}주` : "—"}</b>
                  {cap.sellableQty != null && <> (매도가능 <b>{cap.sellableQty}주</b>)</>}
                </>
              )}
            </p>
            <div className="form-row">
              <label>
                익절가 $
                <input
                  type="text"
                  inputMode="decimal"
                  value={ocoEdit.tp}
                  onChange={(e) => isNumericDraft(e.target.value) && setOcoEdit({ ...ocoEdit, tp: e.target.value })}
                />
              </label>
              <label>
                손절가 $
                <input
                  type="text"
                  inputMode="decimal"
                  value={ocoEdit.sl}
                  onChange={(e) => isNumericDraft(e.target.value) && setOcoEdit({ ...ocoEdit, sl: e.target.value })}
                />
              </label>
              <label>
                수량(주)
                <input
                  type="text"
                  inputMode="decimal"
                  value={ocoEdit.qty}
                  onChange={(e) => isNumericDraft(e.target.value) && setOcoEdit({ ...ocoEdit, qty: e.target.value })}
                />
              </label>
            </div>
            <div className="form-row">
              <button
                className="mini"
                onClick={async () => {
                  // [현재가 기준으로 다시 계산] 지금 시세를 다시 읽어 익절/손절을 현재가 기준으로 잡는다.
                  try {
                    const cur = await window.kyletool.quote(symbol.trim().toUpperCase());
                    setCurPrice(cur);
                    const t = toNum(tpPct) ?? 2;
                    const l = toNum(slPct) ?? 10;
                    setOcoEdit({
                      ...ocoEdit,
                      tp: String(roundPrice(cur * (1 + t / 100))),
                      sl: String(roundPrice(cur * (1 - l / 100))),
                    });
                  } catch (e) {
                    alert(`시세를 가져오지 못했습니다: ${String(e)}`);
                  }
                }}
              >
                ↻ 현재가 기준으로 다시 계산 (익절 +{tpPct}% / 손절 −{slPct}%)
              </button>
              <button
                className="mini"
                onClick={async () => {
                  const c = await window.kyletool.capacity(symbol.trim().toUpperCase(), curPrice ?? undefined);
                  setCap(c);
                  const auto = c.sellableQty ?? c.heldQty;
                  if (auto != null && auto > 0) setOcoEdit({ ...ocoEdit, qty: String(auto) });
                  else alert("보유수량이 0이거나 조회하지 못했습니다. 직접 입력하세요.");
                }}
              >
                ↻ 보유수량 다시 불러오기
              </button>
            </div>
            <p className="hint">
              💡 토스 규칙: <b>익절가 &gt; 현재가 &gt; 손절가</b> 순서여야 등록돼요(익절은 위, 손절은 아래).
              순서가 어긋나면 토스가 거부할 수 있습니다.
            </p>
            <div className="form-row">
              <button className="btn btn-start" disabled={busy} onClick={submitOcoFromEditor}>
                조건주문 보내기
              </button>
              <button className="btn" disabled={busy} onClick={() => setOcoEdit(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== [v0.58.0] 자동 업데이트 안내 — 작은 배너(화면을 막지 않음, 누르지 않아도 된다) =====
          [바뀐 점] 예전엔 이 자리가 전체 화면을 가리는 팝업이었고, "지금 업데이트"→"재시작하고
          적용"을 사람이 직접 두 번 눌러야만 새 버전이 반영됐다. 이제 다운로드는 새 버전이
          보이는 즉시 메인 프로세스가 알아서 시작하고(electron/main.ts의 autoDownload), 다
          받으면 "자동매매가 꺼져 있고 사람이 10분 이상 자리를 비운" 순간에 스스로 조용히
          재시작해 적용한다. 이 배너는 그 진행 상황을 참고로만 보여주는 것이라, 안 누르고
          그냥 둬도 알아서 끝난다 — "지금 바로 재시작"은 급할 때만 쓰는 선택 버튼이다. */}
      {update && (
        <div className="update-banner">
          <span>
            🎉 v{update.version} {updateReady ? "— 받기 완료(유휴 시 자동 적용)" : updateProgress != null ? `— 받는 중 ${updateProgress}%` : "감지됨"}
          </span>
          {updateReady && (
            <button className="btn" onClick={startInstallUpdate} disabled={updateInstalling}>
              {updateInstalling ? "적용 확인 중…" : "↻ 지금 바로 재시작"}
            </button>
          )}
          <button className="btn" onClick={() => setUpdate(null)}>
            닫기
          </button>
          {updateErr && (
            <p className="hint small danger">
              ⚠️ 자동 업데이트 중 오류(자세히: {updateErr}) —{" "}
              <button className="btn" onClick={startDownloadUpdate}>
                지금 다시 받기
              </button>
              . 계속 안 되면{" "}
              <a href="https://github.com/hun100b-dotcom/kyle-bot-releases/releases" target="_blank" rel="noreferrer">
                릴리스 페이지
              </a>
              에서 설치 파일을 새로 받아 직접 설치해 주세요(기존 설정·기록은 그대로 남습니다).
            </p>
          )}
          {updateInstallStuck && (
            <p className="hint small danger">
              ⚠️ 자동 재시작이 정상적으로 이어지지 않았습니다 — macOS는(유료 애플 개발자 인증서가
              없는 간이 서명 상태라) 이 방식의 자동 적용이 구조적으로 실패할 수 있습니다(앱 자체엔
              문제 없음). 아래 "맥용 새 버전이 준비됐어요"(자동 적용) 또는 "dmg를 받아 놨어요"
              (직접 설치) 안내 중 뜨는 쪽으로 받아 주세요.
            </p>
          )}
        </div>
      )}

      {/* ===== [v0.60.0] macOS 직접 교체 자동업데이트 준비 완료 배너 — "지금 바로 재시작"을
          누르면 앱이 꺼지고, 종료 훅이 번들을 교체한 뒤 알아서 다시 연다. 안 눌러도 다음에
          어차피 앱을 껐다 켤 때 자동으로 적용된다(자동매매 중이어도 안전 — 이건 화면(UI)
          교체가 아니라 앱 자체 재시작이 필요한 드문 경우라 자동 재시작은 하지 않는다). */}
      {macSwap && (
        <div className="update-banner" style={update ? { top: 64 } : undefined}>
          <span>🍎 새 버전(v{macSwap.version})이 준비됐어요 — 앱을 껐다 켜면 자동으로 적용돼요.</span>
          <button className="btn" onClick={doInstallMacSwap} disabled={macSwapBusy}>
            {macSwapBusy ? "적용 중…" : "↻ 지금 바로 재시작"}
          </button>
          <button className="btn" onClick={() => setMacSwap(null)}>
            닫기
          </button>
        </div>
      )}

      {/* ===== [v0.58.0] macOS 차선책 배너 — 직접 교체(위 배너)가 어떤 이유로든 준비되지
          못했을 때만 뜬다(대부분은 위 macSwap 배너로 충분해 이 배너는 안 뜬다). */}
      {macDmg && (
        <div className="update-banner" style={update ? { top: 64 } : undefined}>
          <span>🍎 맥용 새 버전(v{macDmg.version}) dmg를 받아 놨어요 — {macDmg.fileName}</span>
          <button className="btn" onClick={() => void window.kyletool.openMacDmg?.()}>
            폴더 열기
          </button>
          <button className="btn" onClick={() => setMacDmg(null)}>
            닫기
          </button>
        </div>
      )}

      {/* [v0.58.0] 지금 실행 중인 앱 버전 — 항상 작게 표시(디버깅·원격 화면 갱신 확인용). */}
      {appVer && (
        <div
          style={{
            position: "fixed",
            right: 8,
            bottom: 4,
            fontSize: 11,
            opacity: 0.35,
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          v{appVer}
        </div>
      )}

      {/* ===== [v0.3.3] 매도 모달 (보유 행의 [매도]) — 사람이 확인해야 전송 ===== */}
      {sellModal && (
        <div className="modal-back">
          <div className="modal">
            <h2>매도 — {sellModal.symbol}</h2>
            <p className="hint">
              팔 수 있는 수량 <b>{sellModal.heldQty}주</b>. 원하는 수량·방식으로 파세요. 입력한 대로 토스에 그대로 보냅니다.
            </p>
            <div className="form-row">
              <label className="radio">
                <input type="radio" checked={sellModal.orderType === "LIMIT"} onChange={() => setSellModal({ ...sellModal, orderType: "LIMIT" })} />
                지정가(가격 지정)
              </label>
              <label className="radio">
                <input type="radio" checked={sellModal.orderType === "MARKET"} onChange={() => setSellModal({ ...sellModal, orderType: "MARKET" })} />
                시장가(현재 시세로 즉시)
              </label>
            </div>
            <div className="form-row">
              <label>수량(주)
                <input type="text" inputMode="decimal" value={sellModal.qty} onChange={(e) => isNumericDraft(e.target.value) && setSellModal({ ...sellModal, qty: e.target.value })} />
              </label>
              <button className="mini" onClick={() => setSellModal({ ...sellModal, qty: String(sellModal.heldQty) })}>전량</button>
              {sellModal.orderType === "LIMIT" && (
                <label>매도가 $
                  <input type="text" inputMode="decimal" value={sellModal.price} onChange={(e) => isNumericDraft(e.target.value) && setSellModal({ ...sellModal, price: e.target.value })} />
                </label>
              )}
            </div>
            <div className="form-row">
              <button className="btn btn-start btn-sell" disabled={busy} onClick={submitSell}>매도 주문</button>
              <button className="btn" disabled={busy} onClick={() => setSellModal(null)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== [v0.3.3] 근거 보기 모달 ===== */}
      {ratModal && (
        <div className="modal-back" onClick={() => setRatModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>매매 근거 — {ratModal.symbol}</h2>
            <p>{rationaleLine(ratModal)}</p>
            <p className="hint small">
              {ratModal.kind === "entry" ? "매수(진입)" : ratModal.kind === "oco" ? "익절+손절" : "매수+익절 자동"} · {ratModal.ts}
              {ratModal.tossOrderId ? ` · 토스번호 ${ratModal.tossOrderId}` : ""}
              {ratModal.dryRun ? " · (연습)" : ""}
            </p>
            <div className="form-row">
              <button className="btn" onClick={() => setRatModal(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 주문 확인 팝업 (사람이 눌러야만 전송) ===== */}
      {pending && (
        <div className="modal-back">
          <div className="modal">
            <h2>{pending.title}</h2>
            {pending.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            {status.dryRun ? (
              <p className="hint">
                🔒 지금은 <b>주문 잠금(연습)</b> 상태예요 — 아래 버튼을 눌러도 실제 주문은 안 나가고 연습 기록만 남습니다.
              </p>
            ) : (
              <div className="live-confirm">
                <p className="danger" style={{ fontSize: 15, fontWeight: 800 }}>
                  ⚠ 실제 돈으로 주문이 전송됩니다
                </p>
                <div className="live-confirm-box">
                  <div>
                    <span>종목</span>
                    <b>{symbol.toUpperCase()}</b>
                  </div>
                  <div>
                    <span>수량</span>
                    <b>{qty || "?"}주</b>
                  </div>
                </div>
                <p className="hint">아래 내용을 다시 확인한 뒤 전송하세요. 취소하려면 [취소]를 누르세요.</p>
              </div>
            )}
            <div className="form-row">
              <button className="btn btn-start" disabled={busy} onClick={sendPending}>
                {status.dryRun ? "연습으로 보내기(기록만)" : "주문 전송"}
              </button>
              <button className="btn" disabled={busy} onClick={() => setPending(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
