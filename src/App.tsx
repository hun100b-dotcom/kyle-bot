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
import { restoreInputsFromSaved } from "../lib/split-restore"; // [v0.9.3] 옛 기록도 계산기로 불러오기

/** 앱이 가진 모든 탭(기본 순서). 순서는 사장님이 드래그로 바꿀 수 있다. */
// [v0.12.0] 탭 통폐합 9→7: '매매분석'은 체결강도 탭 하위로, '기록(journal)'은 설정 탭 하위(고급/진단)로 이동.
//   두 항목은 여전히 코드로 존재하되(TabId), 상단 탭 버튼에서만 빠진다(TOP_TABS).
const ALL_TABS = ["calc", "report", "screener", "splits", "strength", "trades", "orders", "journal", "settings"] as const;
type TabId = (typeof ALL_TABS)[number];
/** 상단에 실제로 보이는 탭(7개) — trades·journal 은 다른 탭에 흡수돼 상단에서 뺀다. */
const TOP_TABS: TabId[] = ["calc", "report", "screener", "splits", "strength", "orders", "settings"];

/** 탭에 보여 줄 이름 */
const TAB_LABEL: Record<TabId, string> = {
  calc: "계산기",
  report: "📊 매매 리포트",
  screener: "탐색",
  splits: "내 삼분할 기록",
  strength: "매매분석",
  trades: "매매분석(구)",
  orders: "주문 현황",
  journal: "기록",
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
 */
function StrengthChart({ samples, signals }: { samples: StrengthSample[]; signals?: StrengthSignals }) {
  const W = 640, H = 170, PAD = 8;
  const priceH = 62; //   위 패널(가격) 높이
  const gap = 14; //      두 패널 사이 라벨 공간
  const strTop = priceH + gap; //  아래 패널(강도) 시작 y
  const strH = H - strTop - PAD; // 아래 패널 높이
  const n = samples.length;
  const strengths = samples.map((s) => s.strength).filter((v): v is number => v != null);
  if (n < 2 || strengths.length < 2) return null;
  const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);

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

  return (
    <svg className="str-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="가격·체결강도 겹쳐보기">
      {/* 패널 라벨 */}
      <text x={PAD} y={12} fontSize="10" fill="currentColor" fillOpacity="0.55">가격</text>
      <text x={PAD} y={strTop - 3} fontSize="10" fill="currentColor" fillOpacity="0.55">체결강도 (100 기준)</text>
      {/* 가격선 */}
      <path d={dp.trim()} fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      {/* 강도 100 기준선 + 강도선 */}
      <line x1={PAD} y1={y100} x2={W - PAD} y2={y100} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="4 4" />
      <path d={ds.trim()} fill="none" stroke={lastV != null && lastV >= 100 ? "#34d399" : "#f87171"} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {/* 신호 마커 */}
      {up && lastV != null && (
        <g><circle cx={lastX} cy={lastY} r="4" fill="#34d399" /><text x={lastX} y={lastY - 8} fontSize="12" fill="#34d399" textAnchor="middle">▲</text></g>
      )}
      {down && lastV != null && (
        <g><circle cx={lastX} cy={lastY} r="4" fill="#f87171" /><text x={lastX} y={lastY + 16} fontSize="12" fill="#f87171" textAnchor="middle">▼</text></g>
      )}
    </svg>
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
 * [v0.6.1] ScreenEvidenceView — 스크리너 판정 근거(펼침).
 *   기준 도지 캔들·다음 봉(하이킨아시 OHLC), 세션 최고점, 5개 필터 통과/실패를 사람이 눈으로
 *   검증할 수 있게 보여준다. "이 도지를 기준으로 잡았고 다음 음봉이 이거"를 확인하는 화면.
 */
function ScreenEvidenceView({ ev, price }: { ev: ScreenEvidence; price: number | null }) {
  const chip = (ok: boolean, label: string) => (
    <span className={`evid-chip ${ok ? "pass" : "fail"}`}>{ok ? "✓" : "✗"} {label}</span>
  );
  const candleLine = (c: EvidenceCandle | null) =>
    c ? `${c.time} · 시$${c.open} 고$${c.high} 저$${c.low} 종$${c.close} · ${c.bearish ? "음봉 ▼" : "양봉 ▲"}` : "(아직 없음)";
  return (
    <div className="evid-box">
      <div className="evid-note">※ 하이킨아시(平均足) 캔들 기준 · <b>완성된(마감된) 5분봉만 판정</b>(형성 중 봉 제외) · 시각 KST</div>
      <div className="evid-filters">
        {chip(ev.filters.priceBand, "현재가 $1~9")}
        {chip(ev.filters.aboveEma, "현재가>EMA200")}
        {chip(ev.filters.aboveCloud, "현재가>구름top")}
        {chip(ev.filters.firstDoji, "최고점 후 첫 음봉 도지")}
        {chip(ev.filters.bothWicks, "위·아래 꼬리 둘 다(망치형 아님)")}
        {chip(ev.filters.recentDoji, "도지 발생 20분 이내")}
        {chip(ev.filters.nextBearish, "다음 봉도 음봉")}
      </div>
      <table className="evid-table">
        <tbody>
          <tr><td>현재가</td><td>{price != null ? `$${price}` : "—"}</td></tr>
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
function ScreenCandleChart({ chart }: { chart: ScreenChart }) {
  const W = 640, H = 220, PAD = 10;
  const n = chart.candles.length;
  if (n === 0) return <div className="hint">표시할 캔들이 없습니다(데이터 부족).</div>;

  const highs = chart.candles.map((c) => c.high);
  const lows = chart.candles.map((c) => c.low);
  let lo = Math.min(...lows), hi = Math.max(...highs);
  // 기준선(EMA200·구름top·세션고점)이 캔들 범위 밖이어도 잘리지 않게 범위에 포함시킨다.
  for (const v of [chart.ema200, chart.cloudTop, chart.sessionHigh]) {
    if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  const span = Math.max(hi - lo, 1e-9);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const slot = (W - 2 * PAD) / n;
  const cx = (i: number) => PAD + slot * (i + 0.5);
  const bodyW = Math.max(1.5, slot * 0.6);
  const refLine = (v: number | null) => (v != null ? y(v) : null);
  const highY = refLine(chart.sessionHigh);
  const emaY = refLine(chart.ema200);
  const cloudY = refLine(chart.cloudTop);

  return (
    <div className="screen-chart-wrap">
      <svg className="screen-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`${chart.symbol} 캔들차트`}>
        {highY != null && <line x1={PAD} y1={highY} x2={W - PAD} y2={highY} stroke="#facc15" strokeDasharray="3 3" strokeOpacity="0.8" />}
        {emaY != null && <line x1={PAD} y1={emaY} x2={W - PAD} y2={emaY} stroke="#60a5fa" strokeDasharray="5 3" strokeOpacity="0.8" />}
        {cloudY != null && <line x1={PAD} y1={cloudY} x2={W - PAD} y2={cloudY} stroke="#fb923c" strokeDasharray="5 3" strokeOpacity="0.8" />}
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
                stroke={isDoji ? "#facc15" : isNext ? "#a78bfa" : "none"}
                strokeWidth={isDoji || isNext ? 2 : 0}
              />
            </g>
          );
        })}
      </svg>
      <div className="screen-chart-legend hint small">
        현재가 {chart.price != null ? `$${chart.price.toFixed(2)}` : "—"}
        {chart.sessionHigh != null && <span> · 🟡 세션고점 ${chart.sessionHigh.toFixed(2)}{chart.sessionHighTime ? ` @${chart.sessionHighTime}` : ""}</span>}
        {chart.ema200 != null && <span> · 🔵 EMA200 ${chart.ema200.toFixed(2)}</span>}
        {chart.cloudTop != null && <span> · 🟠 구름top ${chart.cloudTop.toFixed(2)}</span>}
        {chart.dojiTime && <span> · 🟨 도지 {chart.dojiTime}</span>}
        {chart.nextTime && <span> · 🟪 다음봉 {chart.nextTime}</span>}
        {!chart.dojiTime && <span> · 아직 도지 없음</span>}
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
  // [v0.9.2] 탭 순서(드래그로 변경, 이 기기에 저장)
  const { order: tabOrder, dragProps, isDragging } = useTabOrder(TOP_TABS); // [v0.12.0] 상단은 7개만(trades·journal 흡수)
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
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenProg, setScreenProg] = useState<ScreenProgress | null>(null);
  const [bodyRatio, setBodyRatio] = useState(0.3);
  // [v0.11.0] 스크리너 필터 사용자 조절 — 스캔 종목수·가격대(하한/상한). 문자열로 들고 입력 편의 유지.
  const [scanCount, setScanCount] = useState("60");
  const [priceMin, setPriceMin] = useState("1");
  const [priceMax, setPriceMax] = useState("9");
  const [showMiss, setShowMiss] = useState(false); // '아쉽게 탈락(근접)' 펼침 여부
  const [showJournal, setShowJournal] = useState(false); // [v0.12.0] 설정 하위 '고급·진단' 기록 펼침
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
  const [openEvid, setOpenEvid] = useState<Set<string>>(new Set()); // 근거 펼친 종목들
  // [v0.25.0] 탐색 결과 종목의 차트 — 펼친 종목 집합 + 심볼별 캐시(재클릭 시 재조회 방지) + 로딩/에러.
  const [openChart, setOpenChart] = useState<Set<string>>(new Set());
  const [chartCache, setChartCache] = useState<Record<string, ScreenChart>>({});
  const [chartBusy, setChartBusy] = useState<Set<string>>(new Set());
  const [chartErr, setChartErr] = useState<Record<string, string>>({});
  const [journal, setJournal] = useState<JournalEntry[]>([]);
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
  const [authState, setAuthState] = useState<{ email: string | null; loggedIn: boolean; isOwner: boolean }>({ email: null, loggedIn: false, isOwner: false });
  const [authMsg, setAuthMsg] = useState("");
  // [v0.24.0] 가입이 아직 승인 안 된 사람용 — "승인 요청 남기기" 버튼 노출 여부 + 처리 상태.
  const [canRequestAccess, setCanRequestAccess] = useState(false);
  const [reqBusy, setReqBusy] = useState(false);
  const [reqMsg, setReqMsg] = useState("");
  // [v0.24.0][운영자 전용] 대기 중인 가입 승인 요청 목록.
  const [accessRequests, setAccessRequests] = useState<Array<{ email: string; note: string | null; requestedAt: string }>>([]);
  const [reqActionBusy, setReqActionBusy] = useState<string | null>(null); // 처리 중인 이메일(버튼 개별 비활성용)
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
      // [v0.3.0] 실서버면 켜자마자 상단 바(예수금·손익)와 기본 종목 시세를 자동 로드한다.
      if (s.mode === "live") {
        void loadAccount();
        void autoLoad("AAPL");
      }
    });
    window.kyletool.appVersion?.().then(setAppVer).catch(() => {});
    void refreshAuth(); // [v0.8.1] 로그인 상태 복원(+운영자면 승인 대기 목록도, v0.24.0)
    void loadAnalysis(); // [v0.19.0] 매매분석(실체결) 시작 시 로드
    const off = window.kyletool.onJournal((e) => setJournal((prev) => [...prev.slice(-99), e]));
    // [v0.5.0] 체결강도 실시간 갱신: 지금 화면에서 보고 있는 종목의 이벤트만 반영.
    const offStr = window.kyletool.onStrength?.((state) => {
      setStrState((prev) => (state.symbol === (prev?.symbol ?? state.symbol) ? state : prev));
      // [v0.23.0] 보유 목록에 있는 종목이면 그 카드 값도 실시간 갱신.
      setHeldStates((prev) => (prev[state.symbol] ? { ...prev, [state.symbol]: state } : prev));
    });
    // [v0.6.0] 스크리너 진행률 실시간 표시
    const offScr = window.kyletool.onScreenerProgress?.((p) => setScreenProg(p));
    // [v0.7.0] 매매 시 자동 기록된 트레이드가 갱신되면 목록·요약 새로고침
    const offTrd = window.kyletool.onTrades?.(() => void loadAnalysis());
    // 업데이트 이벤트 구독(있음/진행률/완료). 오류는 조용히 무시(앱 정상 동작 우선).
    const offUpd = window.kyletool.onUpdate?.({
      available: (info) => setUpdate(info),
      progress: (pct) => setUpdateProgress(pct),
      downloaded: () => {
        setUpdateReady(true);
        setUpdateProgress(100);
      },
    });
    return () => {
      off();
      offStr?.();
      offScr?.();
      offTrd?.();
      offUpd?.();
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

  // [v0.2.10] 30초 자동 갱신. 기본은 꺼짐(자율 동작 최소화 원칙) — 오너가 켤 때만 돈다.
  //   주문 현황이 '보이는 동안'만 돈다. [v0.15.0] 2컬럼이면 좌/우 어느 패널에 있어도 인정.
  useEffect(() => {
    const ordersVisible = showTwoCol ? (tabL === "orders" || tabR === "orders") : tab === "orders";
    if (!autoRefresh || !ordersVisible) return;
    const id = setInterval(() => void refreshStatusTab(), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, tab, showTwoCol, tabL, tabR]);

  // [v0.3.0] 자동 계산 — 재료·익절/손절%·기법이 바뀌면 0.35초 뒤 조용히 다시 계산한다.
  //   [계산하기] 버튼을 없앤 대신 이 효과가 대신한다. 타이핑 중 잠깐 멈추면 결과가 갱신된다.
  //   0.35초 지연(디바운스)을 두는 이유: 한 글자마다 계산하면 낭비이므로 "멈추면 계산"으로.
  useEffect(() => {
    if (!isTabVisible("calc")) return; // [B리뷰 H1] 2컬럼에서도 계산기 패널이 보이면 자동계산 동작
    const id = setTimeout(() => void runCalc(true), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tech, baseClose, ema200, wallPrice, barOpen, manualEntry, tpPct, slPct, candleYang, committedSymbol, showTwoCol, tabL, tabR, tab]);

  async function startDownloadUpdate() {
    setUpdateProgress(0);
    const r = await window.kyletool.downloadUpdate();
    if (!r.ok) {
      setUpdateProgress(null);
      alert("업데이트 다운로드에 실패했습니다. 인터넷 연결을 확인하고 나중에 다시 시도하세요. (앱은 계속 사용 가능합니다)");
    }
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
        `체결을 최대 ${watchMinutes}분 지켜보다가 확인되는 즉시 OCO를 대신 걸어 드립니다.`,
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
    setScreenProg({ phase: "ranking", done: 0, total: count, symbol: "" });
    try {
      const run = await window.kyletool.screenerScan({ bodyRatio, count, priceMin: pMin, priceMax: pMax });
      setScreenRun(run);
      setShowMiss(false); // 새 스캔이면 근접 목록은 접은 채로 시작
    } catch (e) {
      alert("스캔 실패: " + String(e));
    } finally {
      setScreenBusy(false);
      setScreenProg(null);
    }
  }

  /**
   * [v0.11.0] 후보에 못 든 '아쉽게 탈락' 종목의 실패 사유를 사람 말로.
   *   하드 게이트(가격대·EMA·구름) 중 무엇을 놓쳤는지, 다 넘었으면 패턴(도지/다음봉) 중 무엇인지.
   *   반환: { passed: 넘은 하드게이트 수(0~3), reasons: 실패 사유 문자열 배열 }
   */
  function missReasons(r: ScreenResult): { passed: number; reasons: string[] } {
    const reasons: string[] = [];
    // ① 하드 게이트(가격대·EMA·구름) 중 놓친 것
    if (!r.priceInBand) reasons.push(`가격대 벗어남 (현재가 ${r.price != null ? `$${r.price.toFixed(2)}` : "—"})`);
    if (!r.aboveEma) reasons.push("EMA200 아래");
    if (!r.aboveCloud) reasons.push("이치모쿠 구름 아래/속");
    const passed = (r.priceInBand ? 1 : 0) + (r.aboveEma ? 1 : 0) + (r.aboveCloud ? 1 : 0);
    // ② 패턴(도지/다음봉)도 '항상' 함께 본다. [B 리뷰 반영]
    //   예전엔 하드게이트를 다 넘었을 때만 패턴을 봤는데, 그러면 "구름만 넘으면 될 것"처럼 오해를 준다.
    //   실제로는 패턴이 없으면 구름을 넘어도 후보가 안 되므로, 빠진 사유를 빠짐없이 보여 준다.
    if (r.evidence) {
      const f = r.evidence.filters;
      // 참고: 도지 판정(isBearishDoji)이 이미 위·아래 꼬리를 둘 다 강제하므로 firstDoji=true면 bothWicks도 true다
      //   (= !bothWicks 가지는 현재 도달 안 함). 기준이 나중에 갈릴 경우 대비해 방어적으로 남겨 둔다.
      if (!f.firstDoji) reasons.push("최고점 이후 음봉 도지 없음");
      else if (!f.bothWicks) reasons.push("도지에 꼬리가 한쪽만(망치형·유성형)");
      else if (!f.recentDoji) reasons.push("도지 발생이 너무 오래전(20분 초과 — 신뢰 불가)");
      else if (!f.nextBearish) reasons.push("도지 다음 봉이 음봉 아님(패턴 미완성)");
    }
    return { passed, reasons };
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

  /** [v0.3.0] 상단 바의 실주문 토글. 켤 때만 경고 확인을 거친다(끄는 건 즉시). 상태는 저장된다. */
  async function toggleLiveOrders(on: boolean) {
    if (on) {
      const ok = window.confirm(
        ["⚠️ 실주문을 활성화합니다.", "", "지금부터 주문 버튼을 누르면 실제 돈으로 주문이 전송됩니다.", "", "계속할까요?"].join("\n"),
      );
      if (!ok) return;
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

  /** [v0.8.1] 로그인 상태 새로고침. 운영자면 대기 중인 가입 승인 요청도 함께 불러온다. */
  async function refreshAuth() {
    try {
      const s = await window.kyletool.authStatus();
      setAuthState(s);
      if (s.isOwner) void loadAccessRequests();
    } catch {
      /* 무시 */
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
  /** [v0.24.0][운영자 전용] 요청을 승인 — 허용목록에 추가되고 그 사람은 바로 가입할 수 있게 된다. */
  async function doApproveRequest(email: string) {
    setReqActionBusy(email);
    try {
      const r = await window.kyletool.approveAccessRequest(email);
      setSyncMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) await loadAccessRequests();
    } finally { setReqActionBusy(null); }
  }
  /** [v0.24.0][운영자 전용] 요청 거절(허용목록에는 추가 안 함). */
  async function doRejectRequest(email: string) {
    setReqActionBusy(email);
    try {
      const r = await window.kyletool.rejectAccessRequest(email);
      setSyncMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) await loadAccessRequests();
    } finally { setReqActionBusy(null); }
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
      setSyncMsg([rKeys.message, rTrades.message].filter(Boolean).join(" "));
      if (rKeys.ok) {
        const s = await window.kyletool.getSettings(); setSettings(s); setFormMode(s.mode); setFormAccount(s.account);
        await refreshStatus();
      }
      if (rTrades.ok) void loadReport();
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
            className={`btn btn-kill ${status.killSwitch ? "kill-on" : ""}`}
            title="비상 정지 버튼이에요. 켜면 새 주문이 막히고, 아직 안 나간 주문·조건주문을 모두 취소합니다(계산·조회는 그대로 됩니다)."
            onClick={async () => {
              const turningOn = !status.killSwitch;
              if (
                turningOn &&
                !window.confirm(
                  ["🛑 비상 정지를 켭니다.", "", "지금부터 새 주문이 막히고, 아직 체결 안 된 주문과 조건주문을 모두 취소합니다.", "", "계속할까요?"].join("\n"),
                )
              )
                return;
              setBusy(true);
              try {
                await window.kyletool.setKillSwitch(turningOn);
                if (isTabVisible("orders")) await refreshStatusTab();
              } finally {
                setBusy(false);
              }
              refreshStatus();
            }}
          >
            {status.killSwitch ? "🔴 비상 정지 중" : "🛑 비상 정지"}
          </button>
        </div>
      </header>

      {/* ===== 탭 (2컬럼일 땐 숨김 — 각 패널의 드롭다운으로 탭을 고른다) ===== */}
      {!showTwoCol && (
      <nav className="tabs">
        {tabOrder.map((t) => (
          <button
            key={t}
            className={tab === t ? "tab active" : "tab"}
            title="좌우로 끌면 탭 순서를 바꿀 수 있어요"
            {...dragProps(t)}
            onClick={() => {
              // 끌어서 순서를 바꾼 직후에는 탭 이동이 되지 않게 한다(의도치 않은 화면 전환 방지).
              if (isDragging()) return;
              setTab(t);
              if (t === "orders") refreshStatusTab();
              if (t === "splits") refreshSplits(); // 탭 열 때 최신 목록 다시 읽기
              if (t === "strength") { void loadHoldingsStrength(); void loadAnalysis(); } // [v0.23.0] 매매분석 탭: 보유 종목 체결강도 자동표시 + 진입/청산 분석
            }}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
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
                  {TOP_TABS.map((t) => <option key={t} value={t}>{TAB_LABEL[t]}</option>)}
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
                <div className="hint">
                  {screenProg.phase === "ranking" ? "거래량 랭킹 불러오는 중…"
                    : screenProg.phase === "done" ? "정리 중…"
                    : `${screenProg.done}/${screenProg.total} · ${screenProg.symbol} 분석 중…`}
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
                .map((r) => ({ r, ...missReasons(r) }))
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
                                <td colSpan={9}><ScreenEvidenceView ev={r.evidence} price={r.price} /></td>
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
                      {latest ? `표본 ${latest.nTicks}틱 · ${latest.session} · ${latest.ts}` : "아직 표본이 없어요 — 집 PC에 연결돼 있으면 잠시 뒤 자동으로 채워집니다."}
                      {latest?.price != null && ` · 체결가 ${usdKrw(latest.price, fx)}`}
                    </div>
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
                  <tr><th>시각</th><th>체결강도</th><th>매수량</th><th>매도량</th><th>표본</th></tr>
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
                      <td>{s.nTicks}</td>
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

      {/* ===== ② 주문 현황 (v0.3.3 토스 스타일) ===== */}
      {paneTab === "orders" && (
        <main className="statusmain">
          {/* --- 공통 도구줄: 새로고침 · 자동갱신 · 상태(미체결/체결) --- */}
          <div className="statusbar">
            <button className="mini" disabled={posBusy} onClick={() => refreshStatusTab()}>↻ 새로고침</button>
            <label className="inline-check">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> 30초마다 자동
            </label>
            {posAt && <span className="hint small">마지막 갱신 {posAt}</span>}
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
                          <b className="hcard-title">{h.name ?? h.symbol}</b>
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
                  onChange={async (e) => {
                    const on = e.target.checked;
                    if (on) {
                      const ok = window.confirm(
                        [
                          "⚠️ 실주문을 활성화합니다.",
                          "",
                          "지금부터 주문 버튼을 누르면 실제 돈으로 주문이 전송되어 체결될 수 있습니다.",
                          "",
                          "계속할까요?",
                        ].join("\n"),
                      );
                      if (!ok) return;
                    }
                    await window.kyletool.setLiveOrders(on);
                    setSettings(await window.kyletool.getSettings());
                    await refreshStatus();
                  }}
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

          {/* ── ③ 계정 (로그인 하나로 끝) ──
              [v0.24.0] 예전엔 비밀번호가 3개(로그인·키 잠금·매매이력 동기화)라 너무 복잡했다.
              → 로그인 비밀번호 하나로 통일. 로그인하면 토스 키·매매 이력이 전부 자동으로
              이 계정 안에서 동기화된다(따로 버튼을 누를 일이 거의 없다). */}
          <section className="card wide">
            <h2>☁️ 계정 (로그인하면 자동으로 동기화)</h2>
            <p className="hint">
              누구나 <b>자기 계정</b>으로 로그인해 <b>자기 토스 키</b>를 연결하면 바로 쓸 수 있습니다.
              다른 사람의 키·매매 이력은 서로 <b>절대 볼 수 없어요</b>. 가입은 <b>운영자가 승인한
              이메일만</b> 됩니다(사용 인원은 운영자가 정합니다) — 아직 승인 전이면 운영자에게
              사용 신청을 해주세요.
            </p>
            <p className="hint">
              로그인하면 <b>토스 키</b>와 <b>매매 이력</b>이 자동으로 이 기기와 동기화됩니다.
              외울 비밀번호는 <b>로그인 비밀번호 하나</b>뿐입니다(따로 "동기화 비밀번호"가 없습니다).
            </p>

            {authState.loggedIn ? (
              <div className="form-row">
                <span className="ok">✅ 로그인됨: <b>{authState.email}</b></span>
                <button className="mini" disabled={syncBusy} onClick={doSignOut}>로그아웃</button>
                <button className="btn" disabled={syncBusy} onClick={doSyncNow}>지금 다시 동기화</button>
              </div>
            ) : (
              <>
                <div className="form-row">
                  <label style={{ flex: 1 }}>이메일
                    <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="you@example.com" />
                  </label>
                  <label style={{ flex: 1 }}>비밀번호(6자+)
                    <input type="password" value={authPw} onChange={(e) => setAuthPw(e.target.value)} placeholder="계정 비밀번호" />
                  </label>
                </div>
                <div className="form-row">
                  <button className="btn btn-start" disabled={syncBusy} onClick={doSignIn}>로그인</button>
                  <button className="btn" disabled={syncBusy} onClick={doSignUp}>가입(처음이면)</button>
                  <span className="hint small">가입하면 바로 로그인됩니다(확인 메일 클릭 불필요).</span>
                </div>
                {/* [v0.24.0] 아직 승인 안 된 이메일로 가입을 시도했을 때만 나타난다 */}
                {canRequestAccess && (
                  <div className="form-row">
                    <button className="btn" disabled={reqBusy} onClick={doRequestAccess}>📮 승인 요청 남기기</button>
                    <span className="hint small">운영자가 앱에서 승인하면 바로 가입할 수 있어요.</span>
                  </div>
                )}
                {reqMsg && <p className={reqMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{reqMsg}</p>}
              </>
            )}
            {authMsg && <p className={authMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{authMsg}</p>}
            {syncMsg && <p className="hint" style={{ whiteSpace: "pre-wrap" }}>{syncMsg}</p>}
            <p className="hint small">
              💡 [설정]에 키를 입력·저장하면 로그인 상태에서 자동으로 클라우드에도 올라갑니다.
              다른 기기에서는 같은 계정으로 <b>로그인만</b> 하면 키와 매매 이력을 자동으로 받습니다.
              로그인을 안 쓰면 기존처럼 이 기기 안에만 저장됩니다.
            </p>

            {/* [v0.24.0][운영자 전용] 로그인한 이메일이 운영자일 때만 보인다(서버도 RLS로 한 번 더 확인). */}
            {authState.isOwner && (
              <div className="settings-block">
                <h3>📋 가입 승인 대기 ({accessRequests.length}건)</h3>
                <p className="hint small">
                  사용 신청이 들어오면 여기 쌓입니다. PC가 꺼져 있어도, 폰으로 로그인만 하면 이 화면에서 바로 처리할 수 있어요.
                </p>
                <button className="mini" onClick={loadAccessRequests}>🔄 새로고침</button>
                {accessRequests.length === 0 ? (
                  <p className="hint">대기 중인 요청이 없습니다.</p>
                ) : (
                  accessRequests.map((r) => (
                    <div key={r.email} className="form-row">
                      <span>{r.email}</span>
                      <button className="btn btn-start" disabled={reqActionBusy === r.email} onClick={() => doApproveRequest(r.email)}>✅ 승인</button>
                      <button className="mini" disabled={reqActionBusy === r.email} onClick={() => doRejectRequest(r.email)}>거절</button>
                    </div>
                  ))
                )}
              </div>
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
            </div>
          </section>

          {/* ── ⑥ 고급 · 진단 (도구 기록) — 문제 생겼을 때만 보는 진단 로그. 기본 접힘. ── */}
          <section className="card wide">
            <button className="mini ghost" onClick={() => setShowJournal((v) => !v)}>
              {showJournal ? "▾" : "▸"} 🛠 고급 · 도구 기록 (문제 확인용 상세 기록)
            </button>
            {showJournal && (
              <div className="logbox tall" style={{ marginTop: 8 }}>
                {journal.length === 0 && <div className="logline hint">아직 기록이 없습니다.</div>}
                {[...journal].reverse().map((j, i) => (
                  <div key={i} className="logline">
                    <span className="log-ts">{j.ts}</span> {j.summary}
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      )}
          </div>
        ))}
      </div>

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

      {/* ===== 자동 업데이트 팝업 ===== */}
      {update && (
        <div className="modal-back">
          <div className="modal">
            <h2>🎉 새 버전이 있습니다 — v{update.version}</h2>
            {appVer && <p className="hint">현재 설치된 버전: v{appVer}</p>}
            {update.notes ? (
              <div className="update-notes">
                <b>변경 사항</b>
                <pre>{update.notes}</pre>
              </div>
            ) : (
              <p className="hint">이번 버전의 개선 사항이 적용됩니다.</p>
            )}

            {updateProgress != null && !updateReady && (
              <div className="progress-wrap">
                <div className="progress-bar" style={{ width: `${updateProgress}%` }} />
                <span className="progress-txt">다운로드 중… {updateProgress}%</span>
              </div>
            )}

            <div className="form-row">
              {updateReady ? (
                <button className="btn btn-start" onClick={() => window.kyletool.installUpdate()}>
                  ↻ 재시작하고 적용
                </button>
              ) : updateProgress != null ? (
                <button className="btn" disabled>
                  다운로드 중…
                </button>
              ) : (
                <button className="btn btn-start" onClick={startDownloadUpdate}>
                  지금 업데이트
                </button>
              )}
              {!updateReady && (
                <button className="btn" onClick={() => setUpdate(null)}>
                  나중에
                </button>
              )}
            </div>
            <p className="hint">
              💡 업데이트는 언제 해도 됩니다. "나중에"를 눌러도 앱은 그대로 사용할 수 있고, 다음에 켤 때 다시 안내합니다.
            </p>
          </div>
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
