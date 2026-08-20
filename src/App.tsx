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

import { Fragment, useCallback, useEffect, useState } from "react";
import "./App.css";
import TodayReport from "./TodayReport"; // [v0.9.1] 오늘의 매매 리포트 화면
import { useTabOrder } from "./useTabOrder"; // [v0.9.2] 탭 순서 드래그로 변경
import { restoreInputsFromSaved } from "../lib/split-restore"; // [v0.9.3] 옛 기록도 계산기로 불러오기

/** 앱이 가진 모든 탭(기본 순서). 순서는 사장님이 드래그로 바꿀 수 있다. */
const ALL_TABS = ["calc", "report", "screener", "splits", "strength", "trades", "orders", "journal", "settings"] as const;
type TabId = (typeof ALL_TABS)[number];

/** 탭에 보여 줄 이름 */
const TAB_LABEL: Record<TabId, string> = {
  calc: "계산기",
  report: "📊 매매 리포트",
  screener: "탐색",
  splits: "내 삼분할 기록",
  strength: "체결강도",
  trades: "매매분석",
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
function fmtStr(v: number | null | undefined): string {
  if (v === null) return "∞";
  if (v === undefined) return "—";
  return v.toFixed(1);
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
 * [v0.5.0] Sparkline — 체결강도 시계열을 외부 라이브러리 없이 SVG로 그리는 미니 차트.
 *   가로=시간(오래된→최신), 세로=체결강도. 100 기준선을 회색 점선으로 그려
 *   위(매수우세)/아래(매도우세)를 한눈에 보게 한다. 값이 null(매수 일방)인 점은 이어 그리지 않는다.
 */
function Sparkline({ samples }: { samples: StrengthSample[] }) {
  const W = 640, H = 90, PAD = 6;
  const vals = samples.map((s) => s.strength).filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  // 세로 범위: 실제 값 + 100(기준선)을 포함하도록. 너무 납작하지 않게 최소 폭 부여.
  const lo = Math.min(100, ...vals), hi = Math.max(100, ...vals);
  const span = Math.max(hi - lo, 10);
  const x = (i: number) => PAD + (i / (samples.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  // 값이 있는 점만 선으로 잇는다. null(매수 일방) 구간에서는 선을 끊고, 다음 값에서 새로 시작(M).
  let d = "";
  let penDown = false; // 직전 점이 유효해서 선을 잇는 중인지
  samples.forEach((s, i) => {
    if (s.strength == null) { penDown = false; return; }
    d += `${penDown ? "L" : "M"} ${x(i).toFixed(1)} ${y(s.strength).toFixed(1)} `;
    penDown = true;
  });
  const y100 = y(100);
  return (
    <svg className="str-spark" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="체결강도 추세">
      {/* 100 기준선 */}
      <line x1={PAD} y1={y100} x2={W - PAD} y2={y100} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="4 4" />
      <path d={d.trim()} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
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

/** 조건주문 만료일 기본값: (KST 기준) 오늘 + 30일.
 *   [주의] toISOString()은 UTC라, KST 새벽(00~09시)엔 하루 이르게 찍힌다.
 *   그래서 KST 오프셋(+9h)을 더한 뒤 날짜를 뽑아 KST 날짜와 일치시킨다. */
function defaultExpire(): string {
  const kstMs = Date.now() + 9 * 3600_000 + 30 * 86400_000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

// 주문 확인 팝업에 담기는 내용(무엇을 전송할지 사람이 최종 확인)
interface PendingOrder {
  kind: "entry" | "oco" | "oto";
  title: string;
  lines: string[];
  send: () => Promise<JournalEntry>;
}

function App() {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [tab, setTab] = useState<TabId>("calc");
  /** 웹앱(폰)인가? — 데스크톱에만 있는 '폰 연결' 기능 유무로 구분한다 */
  const isWebApp = !window.kyletool.phoneStart;
  // [v0.10.0] 매매 이력 동기화(암호화) — PC가 올리고 폰이 받는다
  const [syncTradePass, setSyncTradePass] = useState("");
  const [syncTradeMsg, setSyncTradeMsg] = useState("");
  const [syncTradeBusy, setSyncTradeBusy] = useState(false);
  useEffect(() => {
    void window.kyletool.tradeSyncPass?.().then((v) => {
      if (typeof v === "string" && v) setSyncTradePass(v);
    });
  }, []);
  // [v0.9.2] 탭 순서(드래그로 변경, 이 기기에 저장)
  const { order: tabOrder, dragProps, isDragging } = useTabOrder(ALL_TABS);
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
  const [trades, setTrades] = useState<StrengthTrade[]>([]);
  const [tradeStats, setTradeStats] = useState<TradeStats | null>(null);
  // [v0.6.0] 종목 스크리너(탐색). 결과·진행률·스캔중 여부·도지 몸통비율 슬라이더.
  const [screenRun, setScreenRun] = useState<ScreenRun | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenProg, setScreenProg] = useState<ScreenProgress | null>(null);
  const [bodyRatio, setBodyRatio] = useState(0.3);
  const [openEvid, setOpenEvid] = useState<Set<string>>(new Set()); // 근거 펼친 종목들
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  // [v0.4.0] 내 삼분할 기록(여러 종목 동시 운용). 저장 목록 + 저장 시 메모 입력칸.
  const [splits, setSplits] = useState<SavedSplit[]>([]);
  const [splitMemo, setSplitMemo] = useState(""); // 계산기에서 [기록 저장] 누를 때 함께 남길 메모
  const [splitSaved, setSplitSaved] = useState(""); // 저장 직후 잠깐 뜨는 안내("저장됨 ✓")
  // [v0.5.1] 저장된 기록의 제목(메모) 인라인 편집 — 편집 중인 기록 id + 입력값.
  const [editSplitId, setEditSplitId] = useState<string | null>(null);
  const [editSplitText, setEditSplitText] = useState("");
  // [v0.5.0] 체결강도 기록. 대상 종목·간격 입력 + 현재 상태(현재값·시계열).
  const [strSym, setStrSym] = useState("AAPL"); //     기록 대상 종목
  const [strIv, setStrIv] = useState("10"); //         폴링 간격(초) 선택값
  const [strState, setStrState] = useState<StrengthState | null>(null); // 엔진이 주는 현재 상태

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
  // [v0.8.0] 키 클라우드 동기화: 마스터 비밀번호(저장 안 함, 세션 중에만 메모리) + 상태 메시지
  const [syncPass, setSyncPass] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  // [v0.8.1] 로그인(멀티유저). 이메일/비번은 화면에서만, 서버 인증 후 세션은 엔진이 보관.
  const [authEmail, setAuthEmail] = useState("");
  const [authPw, setAuthPw] = useState("");
  const [authState, setAuthState] = useState<{ email: string | null; loggedIn: boolean }>({ email: null, loggedIn: false });
  const [authMsg, setAuthMsg] = useState("");
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
    window.kyletool.authStatus?.().then(setAuthState).catch(() => {}); // [v0.8.1] 로그인 상태 복원
    const off = window.kyletool.onJournal((e) => setJournal((prev) => [...prev.slice(-99), e]));
    // [v0.5.0] 체결강도 실시간 갱신: 지금 화면에서 보고 있는 종목의 이벤트만 반영.
    const offStr = window.kyletool.onStrength?.((state) => {
      setStrState((prev) => (state.symbol === (prev?.symbol ?? state.symbol) ? state : prev));
    });
    // [v0.6.0] 스크리너 진행률 실시간 표시
    const offScr = window.kyletool.onScreenerProgress?.((p) => setScreenProg(p));
    // [v0.7.0] 매매 시 자동 기록된 트레이드가 갱신되면 목록·요약 새로고침
    const offTrd = window.kyletool.onTrades?.(() => void refreshTrades());
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

  // [v0.2.10] 30초 자동 갱신. 기본은 꺼짐(자율 동작 최소화 원칙) — 오너가 켤 때만 돈다.
  //   주문 현황 탭에 있을 때만 돌려서 불필요한 조회를 줄인다.
  useEffect(() => {
    if (!autoRefresh || tab !== "orders") return;
    const id = setInterval(() => void refreshStatusTab(), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, tab]);

  // [v0.3.0] 자동 계산 — 재료·익절/손절%·기법이 바뀌면 0.35초 뒤 조용히 다시 계산한다.
  //   [계산하기] 버튼을 없앤 대신 이 효과가 대신한다. 타이핑 중 잠깐 멈추면 결과가 갱신된다.
  //   0.35초 지연(디바운스)을 두는 이유: 한 글자마다 계산하면 낭비이므로 "멈추면 계산"으로.
  useEffect(() => {
    if (tab !== "calc") return;
    const id = setTimeout(() => void runCalc(true), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tech, baseClose, ema200, wallPrice, barOpen, manualEntry, tpPct, slPct, candleYang, committedSymbol]);

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
      await refreshCapacity(cur);
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
  async function refreshCapacity(priceForCalc?: number) {
    try {
      const c = await window.kyletool.capacity(symbol.trim().toUpperCase(), priceForCalc);
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
      title: `진입 지정가 매수 — ${symbol.toUpperCase()}`,
      lines: [
        `진입가 ${usdKrw(lv.entry, fx)} × ${q}주`,
        `예상 투입액 ${usdKrw(total, fx)}`,
        `주문 유효기간: 당일(DAY) — 미체결분은 자동 취소`,
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
      title: `진입+익절 (OTO) — ${symbol.toUpperCase()} · 손절 미포함`,
      lines: [
        `진입(매수) ${usdKrw(lv.entry, fx)} × ${q}주`,
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
      title: `조건주문(익절+손절 동시) 등록 — ${symbol.toUpperCase()} (보유 중일 때)`,
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

  /** 확인 팝업을 띄우거나(기본), 설정에서 건너뛰기를 켰으면 곧바로 전송한다. */
  async function requestOrder(po: PendingOrder) {
    if (status?.skipOrderConfirm) {
      setBusy(true);
      try {
        await po.send();
        if (tab === "orders") await refreshStatusTab();
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
      if (tab === "orders") await refreshStatusTab();
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
    setTab("calc"); //             계산기 화면으로 이동
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

  /** [기록 시작] — 이 종목의 체결강도 폴링을 시작. */
  async function startStrength() {
    const sym = (strSym || "").toUpperCase().trim();
    if (!sym) { alert("종목 코드를 입력하세요."); return; }
    try {
      setStrState(await window.kyletool.strengthStart(sym, toNum(strIv) ?? 10));
    } catch (e) {
      alert("기록 시작 실패: " + String(e));
    }
  }

  /** [중지] — 이 종목의 폴링을 멈춘다(저장된 시계열은 남는다). */
  async function stopStrength() {
    const sym = (strSym || "").toUpperCase().trim();
    try {
      setStrState(await window.kyletool.strengthStop(sym));
    } catch (e) {
      alert("중지 실패: " + String(e));
    }
  }

  // -------------------------------------------------------------------------
  // [v0.6.0] 종목 스크리너(탐색) — 온디맨드 스캔
  // -------------------------------------------------------------------------

  /** [스캔] — 거래량 상위 60종목을 훑어 조건 만족 후보를 찾는다(1~2분 소요). */
  async function runScan() {
    if (screenBusy) return;
    setScreenBusy(true);
    setScreenProg({ phase: "ranking", done: 0, total: 60, symbol: "" });
    try {
      const run = await window.kyletool.screenerScan(bodyRatio);
      setScreenRun(run);
    } catch (e) {
      alert("스캔 실패: " + String(e));
    } finally {
      setScreenBusy(false);
      setScreenProg(null);
    }
  }

  // -------------------------------------------------------------------------
  // [v0.7.0] 체결강도 자동 기록(매매 연동) — 목록/요약/수동청산/삭제
  // -------------------------------------------------------------------------

  /** 트레이드 목록 + 요약을 다시 읽어 화면 갱신. */
  async function refreshTrades() {
    try {
      const [list, stats] = await Promise.all([window.kyletool.tradesList(), window.kyletool.tradesStats()]);
      setTrades(list);
      setTradeStats(stats);
    } catch (e) {
      console.error("트레이드 조회 실패", e);
    }
  }

  /** 미청산 트레이드 수동 청산 — 확정가·구분(익절/손절/수동)을 받아 마감. */
  async function closeTrade(t: StrengthTrade) {
    const priceStr = prompt(`청산가를 입력하세요 (${t.symbol}, 진입 $${t.entryPrice})`, String(t.entryPrice));
    if (priceStr == null) return;
    const px = toNum(priceStr);
    if (px == null || px <= 0) { alert("청산가를 숫자로 입력하세요."); return; }
    const k = prompt("구분: tp(익절) / sl(손절) / manual(수동) 중 하나", "manual");
    const kind = k === "tp" || k === "sl" ? k : "manual";
    try {
      await window.kyletool.tradesClose(t.id, px, kind);
      await refreshTrades();
    } catch (e) {
      alert("청산 기록 실패: " + String(e));
    }
  }

  /** 트레이드 삭제(잘못 기록된 것 정리). */
  async function deleteTrade(id: string) {
    if (!confirm("이 트레이드 기록을 삭제할까요?")) return;
    try {
      await window.kyletool.tradesDelete(id);
      await refreshTrades();
    } catch (e) {
      alert("삭제 실패: " + String(e));
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

  /** 결과 행 클릭 → 계산기 탭에 그 종목을 자동으로 채운다(삼분할 타점 계산으로 이어지게). */
  function pickScreenSymbol(symbol: string) {
    setSymbol(symbol);
    setCommittedSymbol(symbol);
    setTab("calc");
    void autoLoad(symbol); // 예수금·시세·수량 자동 로드
  }

  /** [내 삼분할 기록] 카드에서 "체결강도 보기"를 누르면 이 종목으로 체결강도 탭 열기. */
  function openStrengthFor(symbol: string) {
    setStrSym(symbol);
    setTab("strength");
    void loadStrength(symbol);
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
    setSavedMsg("시드 설정을 저장했습니다.");
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

  /** [v0.8.1] 로그인 상태 새로고침. */
  async function refreshAuth() {
    try {
      setAuthState(await window.kyletool.authStatus());
    } catch {
      /* 무시 */
    }
  }
  async function doSignIn() {
    if (!authEmail || !authPw) { setAuthMsg("⚠️ 이메일과 비밀번호를 입력하세요."); return; }
    setSyncBusy(true); setAuthMsg("로그인 중…");
    try {
      const r = await window.kyletool.authSignIn(authEmail, authPw);
      setAuthMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) { setAuthPw(""); await refreshAuth(); }
    } finally { setSyncBusy(false); }
  }
  async function doSignUp() {
    if (!authEmail || authPw.length < 6) { setAuthMsg("⚠️ 이메일과 6자 이상 비밀번호를 입력하세요."); return; }
    setSyncBusy(true); setAuthMsg("가입 요청 중…");
    try {
      const r = await window.kyletool.authSignUp(authEmail, authPw);
      setAuthMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok && !r.needsConfirm) { setAuthPw(""); await refreshAuth(); }
    } finally { setSyncBusy(false); }
  }
  async function doSignOut() {
    await window.kyletool.authSignOut();
    setAuthMsg(""); setSyncMsg("");
    await refreshAuth();
  }

  /** [v0.8.0] 이 기기 키를 마스터 비밀번호로 암호화해 클라우드에 저장. */
  async function doSyncPush() {
    if (syncPass.length < 6) { setSyncMsg("⚠️ 마스터 비밀번호를 6자 이상 입력하세요."); return; }
    setSyncBusy(true); setSyncMsg("암호화해서 저장 중…");
    try {
      const r = await window.kyletool.syncPushKeys(syncPass);
      setSyncMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
    } finally { setSyncBusy(false); }
  }
  /** [v0.8.0] 클라우드에서 키를 받아 복호화해 이 기기에 적용(재입력 불필요). */
  async function doSyncPull() {
    if (syncPass.length < 6) { setSyncMsg("⚠️ 마스터 비밀번호를 6자 이상 입력하세요."); return; }
    setSyncBusy(true); setSyncMsg("클라우드에서 불러와 복호화 중…");
    try {
      const r = await window.kyletool.syncPullKeys(syncPass);
      setSyncMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) {
        const s = await window.kyletool.getSettings(); setSettings(s); setFormMode(s.mode); setFormAccount(s.account);
        await refreshStatus();
      }
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
            <span className="badge badge-dry" title="실주문 잠금 상태입니다. 주문 버튼을 눌러도 모의 기록만 남습니다">
              🔒 주문 잠금<span className="wide-only"> (드라이런)</span>
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
              ⚠ 마감 1분 전<span className="wide-only">: 정정·취소 불가 구간</span>
            </span>
          )}
        </div>
        <div className="controls">
          <button
            className={`btn btn-kill ${status.killSwitch ? "kill-on" : ""}`}
            title="켜면 신규 주문이 잠기고, 미체결 주문·조건주문을 전량 취소합니다(계산·조회는 가능)"
            onClick={async () => {
              const turningOn = !status.killSwitch;
              if (
                turningOn &&
                !window.confirm(
                  ["킬 스위치를 켭니다.", "", "신규 주문이 잠기고, 미체결 주문·조건주문을 전량 취소합니다.", "계속할까요?"].join("\n"),
                )
              )
                return;
              setBusy(true);
              try {
                await window.kyletool.setKillSwitch(turningOn);
                if (tab === "orders") await refreshStatusTab();
              } finally {
                setBusy(false);
              }
              refreshStatus();
            }}
          >
            {status.killSwitch ? "🔴 주문 잠금 중" : "⭘ 킬 스위치"}
          </button>
        </div>
      </header>

      {/* ===== 탭 ===== */}
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
              if (t === "strength") void loadStrength(strSym); // 저장된 시계열 불러오기
              if (t === "trades") void refreshTrades(); // 자동 기록 트레이드 불러오기
            }}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>

      {/* ===== 1) 계산기 (오더 티켓) ===== */}
      {tab === "calc" && (
        <main className="ticket">
          {/* --- 상단 상시 바: 실주문 토글 · 예수금 · 보유손익 · 세션 --- */}
          <div className="statusbar">
            <label className={`sb-live ${settings?.liveOrdersEnabled ? "on" : "off"}`}>
              <input
                type="checkbox"
                checked={!!settings?.liveOrdersEnabled}
                onChange={(e) => toggleLiveOrders(e.target.checked)}
              />
              <b>{settings?.liveOrdersEnabled ? "🔴 실주문 ON" : "🔒 실주문 OFF (모의)"}</b>
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
                : cap && <span className="hint"> · 시드 {cap.sessionPct}%</span>}
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
              {quoteErr && <p className="danger small">⚠ 시세 조회 실패: {quoteErr} — [설정]에서 키·계좌 확인</p>}
              <div className="hint small">
                환율{" "}
                {fx
                  ? `1 USD = ₩${fx.toLocaleString()} (${fxSource === "toss" ? "매매기준율·참고용" : "수동"})`
                  : "미조회"}
                {" · 원화는 참고 환산이며 실제 주문·체결은 달러 기준"}
              </div>
              {fxFailed && (
                <div className="form-row">
                  <input type="text" inputMode="decimal" placeholder="환율 수동 입력 (예: 1390)" value={manualFx} onChange={(e) => setManualFxInput(e.target.value)} />
                  <button className="mini" onClick={applyManualFx}>적용</button>
                  <span className="hint danger">자동 조회 실패 — 수동 입력</span>
                </div>
              )}

              {/* 기법 선택 */}
              <div className="form-row tech-row">
                {(["split3", "orderbook", "candle", "manual"] as Technique[]).map((t) => (
                  <label className="radio" key={t}>
                    <input type="radio" checked={tech === t} onChange={() => { setTech(t); setCalcErr(""); }} />
                    {TECH_LABEL[t]}
                  </label>
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
                  <span className="hint">전봉종가~EMA200을 3등분해 1·2·3분할 산출 (전봉종가 &gt; EMA200 필수)</span>
                </div>
              )}
              {tech === "orderbook" && (
                <div className="form-row">
                  <label>매수벽 가격 $
                    <input type="text" inputMode="decimal" placeholder="예: 11.33" value={wallPrice} onChange={(e) => isNumericDraft(e.target.value) && setWallPrice(e.target.value)} />
                  </label>
                  <span className="hint">진입 = 벽 + 1틱. 벽 판단은 사람 몫</span>
                </div>
              )}
              {tech === "candle" && (
                <div className="form-row">
                  <label>현재봉 시가 $
                    <input type="text" inputMode="decimal" placeholder="예: 20.50" value={barOpen} onChange={(e) => isNumericDraft(e.target.value) && setBarOpen(e.target.value)} />
                  </label>
                  <label className="radio">
                    <input type="checkbox" checked={candleYang} onChange={(e) => setCandleYang(e.target.checked)} />
                    전봉이 양봉(종가&gt;시가)임을 확인
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
                        시드 <b>{cap.sessionPct}%</b> 설정 중 ·{" "}
                        {cap.seedQty != null ? <>제안 <b>{cap.seedQty.toLocaleString()}주</b></> : "제안 —"}
                        {cap.seedUsd != null && (
                          <span className="hint"> (시드 {usdKrw(cap.seedUsd, fx)} × {cap.sessionPct}% {cap.seedBasis === "fixed" ? "· 고정" : "· 예수금"})</span>
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
                  <span className="hint">종목을 입력하면 세션 시드·주문가능·보유 수량이 자동 표시됩니다.</span>
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
                      placeholder="메모(선택): 예) 데이마켓 눌림목 후보"
                      value={splitMemo}
                      onChange={(e) => setSplitMemo(e.target.value)}
                    />
                    <button className="mini btn-save" onClick={() => void saveCurrentSplit()} title="이 종목의 3개 타점을 기록으로 저장(앱을 껐다 켜도 유지)">
                      💾 기록 저장
                    </button>
                    {splitSaved && <span className="ok split-saved-msg">{splitSaved}</span>}
                  </div>
                  <table className="result-table">
                    <thead>
                      <tr>
                        <th>분할</th>
                        <th>진입가</th>
                        <th>익절 (+{tpPct}%)</th>
                        <th>손절 (−{slPct}%)</th>
                        <th>투입액 ({qty || "?"}주)</th>
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
                            <button className="mini btn-buy" disabled={status.killSwitch} onClick={() => confirmEntry(lv)}>진입 지정가</button>
                            <button className="mini btn-oto" disabled={status.killSwitch} onClick={() => confirmOto(lv)} title="사면서 익절까지 한 번에(손절 미포함)">진입+익절(OTO)</button>
                            <button className="mini btn-oco" disabled={status.killSwitch} onClick={() => openOcoEditor(lv)} title="이미 보유 중일 때 익절+손절 동시">조건주문(익절+손절)</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="hint">
                    💡 1·2·3분할은 <b>동등한 후보</b>입니다(어느 것도 추천 아님). 주문 3종:
                    <br />· <b>진입 지정가</b> = 매수만. · <b>진입+익절(OTO)</b> = 사면서 익절까지 한 번에(<b>손절은 수동</b>). · <b>조건주문(익절+손절)</b> = <b>이미 보유 중</b>일 때 익절·손절 동시.
                    <br />모든 감시는 토스 서버가 하므로 앱을 꺼도 작동합니다.
                    {status.dryRun && " (현재 주문 잠금 — 전송 대신 모의 기록만)"}
                  </p>
                </>
              ) : (
                <div className="result-empty hint">
                  왼쪽에 종목·재료·익절/손절%를 입력하면 <b>자동으로 계산</b>되어 여기 표가 나타납니다.
                  <br />(계산·조회 버튼을 따로 누를 필요가 없습니다.)
                </div>
              )}
            </section>
          </div>
        </main>
      )}

      {/* ===== ①-1) 탐색(스크리너) (v0.6.0) ===== */}
      {/* [v0.9.1] 오늘의 매매 리포트 — 큰 숫자·배지·막대 애니메이션(토스 스타일) */}
      {tab === "report" && (
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

      {tab === "screener" && (
        <main className="grid">
          <section className="card wide">
            <div className="split-list-head">
              <h2>탐색 <span className="hint">(거래량 상위 60종목 스캔)</span></h2>
              <button className="mini btn-start" disabled={screenBusy} onClick={() => void runScan()}>
                {screenBusy ? "스캔 중…" : "🔍 스캔"}
              </button>
            </div>
            <p className="hint">
              거래량 상위 60종목(<b>ETF·레버리지·인버스 제외</b>)을 훑어 <b>①현재가 $1~$9</b>, <b>②현재가&gt;EMA200</b>, <b>③현재가&gt;이치모쿠 구름 위</b>,
              <b> ④장 시작 이후 최고점 뒤 첫 음봉 도지(위·아래 꼬리 둘 다 있는 것 — 망치형 배제)</b>, <b>⑤그 다음 봉도 음봉</b>이면 후보로 잡습니다.
              도지 이후 <b>신고가가 다시 나오면 무효</b>(말아올린 종목 제외).
              판정은 <b>하이킨아시(平均足) 캔들 기준</b>입니다(트레이딩뷰 HA 차트와 일치 — EMA200·이치모쿠·도지·음봉 모두 HA).
              <b>형성 중인 마지막 5분봉은 제외</b>하고 <b>완성된(마감된) 봉만</b> 판정합니다(봉 마감 후 음↔양 뒤집힘 방지).
              1분봉을 과거로 당겨 5분봉→HA로 변환해 계산합니다. <b>1~2분</b> 걸립니다.
              <br/>🔴 <b>확정</b>(도지+다음 음봉) · 🟡 <b>관찰</b>(첫 음봉 도지, 다음 봉 대기). <b>▸ 근거</b>를 펼치면 기준 캔들을 확인할 수 있고, 다른 곳을 누르면 계산기에 종목이 채워집니다.
            </p>

            {/* 도지 몸통비율 슬라이더 */}
            <div className="screen-controls">
              <label className="str-field" style={{ flex: 1, maxWidth: 360 }}>
                <span className="sb-k">음봉 도지 몸통비율 상한: <b>{(bodyRatio * 100).toFixed(0)}%</b> (작을수록 엄격)</span>
                <input type="range" min={0.1} max={0.5} step={0.05} value={bodyRatio} disabled={screenBusy}
                  onChange={(e) => setBodyRatio(Number(e.target.value))} />
              </label>
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
              return (
                <>
                  <p className="hint">
                    {screenRun.scannedAt} 스캔 · {screenRun.total}종목 중 <b className="ok">후보 {cand.length}개</b>
                    {screenRun.excludedEtf > 0 && <span> · ETF/레버리지 {screenRun.excludedEtf}개 제외</span>}
                    {insufficient > 0 && <span> · 데이터 부족 {insufficient}개 제외</span>}
                  </p>
                  {cand.length === 0 ? (
                    <div className="result-empty hint">조건을 만족하는 후보가 없습니다. (몸통비율을 높이거나 장중에 다시 시도해 보세요.)</div>
                  ) : (
                    <table className="result-table screen-table">
                      <thead>
                        <tr><th>근거</th><th>상태</th><th>순위</th><th>종목</th><th>현재가</th><th>EMA200</th><th>구름top</th><th>세션고점</th><th>근접도</th></tr>
                      </thead>
                      <tbody>
                        {cand.map((r) => {
                          const open = openEvid.has(r.symbol);
                          return (
                          <Fragment key={r.symbol}>
                            <tr className="screen-row" onClick={() => pickScreenSymbol(r.symbol)} title="클릭하면 계산기에 이 종목이 채워집니다">
                              <td>
                                <button className="mini btn-evid" onClick={(e) => { e.stopPropagation(); toggleEvid(r.symbol); }} title="판정 근거 펼치기/접기">
                                  {open ? "▾ 근거" : "▸ 근거"}
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
                          </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              );
            })()}

            {!screenRun && !screenBusy && (
              <div className="result-empty hint">[🔍 스캔]을 누르면 거래량 상위 60종목을 훑어 후보를 찾습니다. (읽기 전용 — 주문과 무관)</div>
            )}
          </section>
        </main>
      )}

      {/* ===== ①-2) 내 삼분할 기록 (v0.4.0 — 여러 종목 동시 운용) ===== */}
      {tab === "splits" && (
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
      {tab === "strength" && (
        <main className="grid">
          <section className="card wide">
            <h2>체결강도 기록 <span className="hint">(매수체결량 ÷ 매도체결량 × 100)</span></h2>
            <p className="hint">
              종목을 정하고 <b>[기록 시작]</b>을 누르면, 켜져 있는 동안 <b>주기적으로 체결(틱)</b>을 받아
              <b> 틱룰(업틱=매수·다운틱=매도)</b>로 체결강도를 계산해 시계열로 저장합니다(앱을 껐다 켜도 유지).
              <b> 100 위=매수 우세, 아래=매도 우세.</b> ※ 방향은 <b>추정치</b>입니다(토스가 매수/매도 방향을 직접 주지 않음).
            </p>

            {/* --- 조작줄: 종목 · 간격 · 시작/중지 --- */}
            <div className="str-controls">
              <label className="str-field">
                <span className="sb-k">종목</span>
                <input
                  type="text"
                  className="str-sym-input"
                  value={strSym}
                  disabled={!!strState?.running}
                  onChange={(e) => setStrSym(e.target.value.toUpperCase())}
                  onBlur={() => void loadStrength(strSym)}
                />
              </label>
              <label className="str-field">
                <span className="sb-k">간격</span>
                <select className="str-iv" value={strIv} disabled={!!strState?.running} onChange={(e) => setStrIv(e.target.value)}>
                  <option value="5">5초</option>
                  <option value="10">10초</option>
                  <option value="15">15초</option>
                </select>
              </label>
              {strState?.running ? (
                <button className="mini btn-stop" onClick={() => void stopStrength()}>■ 기록 중지</button>
              ) : (
                <button className="mini btn-start" onClick={() => void startStrength()}>● 기록 시작</button>
              )}
              {strState?.running && <span className="ok str-live">● 기록 중 ({strState.intervalSec}초 간격)</span>}
            </div>

            {strState?.lastError && (
              <div className="note red" style={{ fontSize: 13 }}>⚠️ 조회 오류: {strState.lastError} (다음 주기에 다시 시도합니다)</div>
            )}

            {/* --- 현재값 --- */}
            {(() => {
              const latest = strState?.latest ?? null;
              const v = latest?.strength ?? null;
              const cls = v == null ? "str-oneway" : v >= 100 ? "ok" : "danger";
              const label = v == null ? (latest && latest.buyVol > 0 ? "매수 일방(∞)" : "—") : v.toFixed(1);
              return (
                <div className="str-now">
                  <div className={`str-big ${cls}`}>{label}</div>
                  <div className="str-meta">
                    <div>매수량 <b className="ok">{latest ? latest.buyVol.toLocaleString() : "—"}</b> · 매도량 <b className="danger">{latest ? latest.sellVol.toLocaleString() : "—"}</b></div>
                    <div className="hint">
                      {latest ? `표본 ${latest.nTicks}틱 · ${latest.session} · ${latest.ts}` : "아직 표본 없음 — [기록 시작]을 눌러 주세요."}
                      {latest?.price != null && ` · 체결가 ${usdKrw(latest.price, fx)}`}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* --- 스파크라인(100 기준선) --- */}
            {strState && strState.samples.length >= 2 && <Sparkline samples={strState.samples} />}

            {/* --- 최근 값 표(최신이 위) --- */}
            {strState && strState.samples.length > 0 && (
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

            <p className="hint">
              💡 스캘핑 참고: 하락 중 <b>체결강도 바닥 반전</b>=삼분할 진입 근거, 반등 후 <b>정점 꺾임</b>=익절 근거.
              단독 판단 금지 — 가격·거래량·캔들과 함께 보세요. (자세한 방법론: docs/체결강도_분석 문서)
            </p>
          </section>
        </main>
      )}

      {/* ===== ①-4) 매매분석 (v0.7.0 — 체결강도 자동 기록) ===== */}
      {tab === "trades" && (
        <main className="grid">
          <section className="card wide">
            <div className="split-list-head">
              <h2>매매분석 <span className="hint">(카프리로 주문할 때 진입·청산 체결강도 자동 기록)</span></h2>
              <button className="mini" onClick={() => void refreshTrades()}>↻ 새로고침</button>
            </div>
            <p className="hint">
              계산기·탐색에서 <b>진입 주문</b>을 내면 그 순간의 체결강도가 <b>자동 스냅샷</b>되고, <b>매도</b>하면 청산 체결강도+결과(%)가 기록됩니다.
              지금은 <b>드라이런/모의</b>라 <b>페이퍼(모의) 데이터</b>로 쌓이고, <b>실주문을 켜면 그대로 실데이터</b>로 이어집니다.
              <br/>※ 토스 서버가 처리하는 OCO/OTO 익절·손절은 앱이 체결을 직접 못 보므로, 아래 <b>[청산 기록]</b>으로 확정가를 넣어 마감하세요.
            </p>

            {/* 요약 카드 */}
            {tradeStats && (
              <div className="trade-stats">
                <div className="tstat"><span className="sb-k">전체/청산</span><b>{tradeStats.total} / {tradeStats.closed}</b></div>
                <div className="tstat"><span className="sb-k">승률</span><b>{tradeStats.winRate != null ? `${tradeStats.winRate}% (${tradeStats.wins}승 ${tradeStats.losses}패)` : "—"}</b></div>
                <div className="tstat"><span className="sb-k">평균 결과</span><b className={pnlClass(tradeStats.avgResultPct)}>{tradeStats.avgResultPct != null ? `${tradeStats.avgResultPct >= 0 ? "+" : ""}${tradeStats.avgResultPct}%` : "—"}</b></div>
                <div className="tstat highlight"><span className="sb-k">진입 시 평균 체결강도 — 수익</span><b className="ok">{tradeStats.avgEntryStrengthWin ?? "—"}</b></div>
                <div className="tstat highlight"><span className="sb-k">진입 시 평균 체결강도 — 손실</span><b className="danger">{tradeStats.avgEntryStrengthLoss ?? "—"}</b></div>
              </div>
            )}
            {tradeStats && tradeStats.avgEntryStrengthWin != null && tradeStats.avgEntryStrengthLoss != null && (
              <p className="hint">
                💡 수익 트레이드의 진입 시 평균 체결강도가 손실보다 <b>{tradeStats.avgEntryStrengthWin > tradeStats.avgEntryStrengthLoss ? "높습니다" : "낮습니다"}</b>
                {" "}({tradeStats.avgEntryStrengthWin} vs {tradeStats.avgEntryStrengthLoss}). 표본이 쌓일수록 신뢰도가 올라갑니다.
              </p>
            )}

            {trades.length === 0 ? (
              <div className="result-empty hint">아직 기록된 트레이드가 없습니다. 계산기/탐색에서 진입 주문을 내보세요(드라이런도 기록됩니다).</div>
            ) : (
              <table className="result-table trade-table">
                <thead>
                  <tr><th>모드</th><th>종목</th><th>진입</th><th>진입 강도</th><th>청산</th><th>청산 강도</th><th>결과</th><th></th></tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className={t.outcome === "win" ? "trade-win" : t.outcome === "loss" ? "trade-loss" : ""}>
                      <td><span className={`mode-tag mode-${t.mode}`}>{ { mock: "모의", dryrun: "드라이런", real: "실거래" }[t.mode] }</span></td>
                      <td><b>{t.symbol}</b></td>
                      <td>{t.entryTs}<br/><span className="hint">${t.entryPrice}</span></td>
                      <td className={strClass(t.entry?.strength)}>{fmtStr(t.entry?.strength)}</td>
                      <td>{t.exitTs ? <>{t.exitTs}<br/><span className="hint">${t.exitPrice} · { { tp: "익절", sl: "손절", manual: "수동" }[t.exitKind ?? "manual"] }</span></> : <span className="warn-txt">미청산</span>}</td>
                      <td className={strClass(t.exit?.strength)}>{fmtStr(t.exit?.strength)}</td>
                      <td className={t.resultPct == null ? "" : t.resultPct >= 0 ? "ok" : "danger"}>{t.resultPct != null ? `${t.resultPct >= 0 ? "+" : ""}${t.resultPct}%` : "—"}</td>
                      <td className="order-cell">
                        {t.outcome == null && <button className="mini btn-start" onClick={() => void closeTrade(t)}>청산 기록</button>}
                        <button className="mini btn-del" onClick={() => void deleteTrade(t.id)}>🗑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </main>
      )}

      {/* ===== ② 주문 현황 (v0.3.3 토스 스타일) ===== */}
      {tab === "orders" && (
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
                            <button className="mini" disabled={status.killSwitch} onClick={async () => { await window.kyletool.cancelOrder(o.orderId).catch((e) => alert(String(e))); refreshStatusTab(); }}>취소</button>
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
                            <div><dt>유형</dt><dd>{o.orderType === "MARKET" ? "시장가" : "지정가"} · {o.timeInForce ?? "DAY"}</dd></div>
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
              <h2>조건 주문 <span className="hint">(OTO 진입+익절 / OCO 익절+손절 · 토스 서버 감시)</span></h2>
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
                          <span className="chip chip-type">{c.type}</span>
                          <b className="min0">{c.symbol}</b>
                          <span className="muted small">{c.quantity ?? "—"}주</span>
                          <span className={`stbadge ${c.status === "WATCHING" ? "st-submitted" : "st-filled"}`}>{condStatusKo(c.status)}</span>
                          <span className="grow" />
                          {c.expireDate && <span className="muted small">만료 {c.expireDate}</span>}
                          {c.isOpen && (
                            <button className="mini" disabled={status.killSwitch} onClick={async () => { await window.kyletool.cancelConditional(c.conditionalOrderId).catch((e) => alert(String(e))); refreshStatusTab(); }}>삭제</button>
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
                            <div><dt>유형</dt><dd>{c.orderType ?? "LIMIT"}</dd></div>
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

      {/* ===== ③ 기록 ===== */}
      {tab === "journal" && (
        <main className="grid">
          <section className="card wide">
            <h2>도구 기록 (주문·드라이런·취소)</h2>
            <div className="logbox tall">
              {journal.length === 0 && <div className="logline hint">아직 기록이 없습니다.</div>}
              {[...journal].reverse().map((j, i) => (
                <div key={i} className="logline">
                  <span className="log-ts">{j.ts}</span> {j.summary}
                </div>
              ))}
            </div>
          </section>
        </main>
      )}

      {/* ===== ④ 설정 ===== */}
      {tab === "settings" && settings && (
        <main className="grid">
          {/* [v0.10.0] 매매 이력 동기화 — PC가 암호화해 올리고, 폰이 받아서 본다 */}
          <section className="card wide">
            <h2>☁️ 매매 이력 동기화</h2>
            <p className="hint">
              집 PC가 <b>매매 이력을 자물쇠로 잠가</b> 인터넷에 올려 두면, 폰이 같은 비밀번호로 풀어서 봅니다.
              <br />
              → <b>집 PC가 꺼져 있어도, 회사에서도</b> 매매 리포트가 보입니다.
              <br />
              <b>토스 키·계좌번호·비밀번호는 절대 올라가지 않습니다</b>(매매 결과만, 그것도 암호문으로).
            </p>
            <div className="row">
              <label>동기화 비밀번호 (6자 이상 · PC와 폰에 같은 값을 넣으세요)</label>
              <input
                type="password"
                value={syncTradePass}
                onChange={(e) => setSyncTradePass(e.target.value)}
                placeholder="예: 나만 아는 문장"
                autoComplete="off"
              />
            </div>
            <div className="row" style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {!isWebApp && (
                <button
                  className="btn"
                  disabled={syncTradeBusy || syncTradePass.length < 6}
                  onClick={async () => {
                    setSyncTradeBusy(true);
                    try {
                      await window.kyletool.tradeSyncPass?.(syncTradePass); // 다음부터 자동 업로드
                      const r = await window.kyletool.tradeSyncPush(syncTradePass);
                      setSyncTradeMsg(r.message);
                    } finally {
                      setSyncTradeBusy(false);
                    }
                  }}
                >
                  ⬆ 지금 올리기 (이 PC)
                </button>
              )}
              <button
                className="btn"
                disabled={syncTradeBusy || syncTradePass.length < 6}
                onClick={async () => {
                  setSyncTradeBusy(true);
                  try {
                    await window.kyletool.tradeSyncPass?.(syncTradePass); // 다음부터 자동으로 받아온다
                    const r = await window.kyletool.tradeSyncPull(syncTradePass);
                    setSyncTradeMsg(r.message);
                    if (r.ok) void loadReport();
                  } finally {
                    setSyncTradeBusy(false);
                  }
                }}
              >
                ⬇ 지금 받기 {isWebApp ? "(이 폰)" : ""}
              </button>
            </div>
            {syncTradeMsg && <p className="hint">{syncTradeMsg}</p>}
            <p className="hint">
              한 번 넣어 두면 다음부터는 <b>자동</b>입니다 — PC는 새 매매가 생길 때 올리고, 폰은 리포트를 열 때 받아옵니다.
            </p>
          </section>

          {/* [폰에서 쓰기] 데스크톱 앱에서만 보인다(웹앱에는 이 기능이 없음) */}
          {window.kyletool.phoneStart && (
            <section className="card wide">
              <h2>📱 폰에서 쓰기</h2>
              <p className="hint">
                토스 키는 <b>등록된 인터넷 주소(IP)에서만</b> 쓸 수 있어, 클라우드 서버로는 막힙니다.
                이 PC의 주소는 이미 허용돼 있으므로, <b>이 앱이 켜져 있는 동안 이 PC가 폰의 중계소</b>가 됩니다.
                아래 [폰 연결 켜기]를 누르고 폰 카메라로 QR을 찍으면 폰에서도 전 기능을 쓸 수 있습니다.
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
                      폰 카메라로 QR을 찍으세요. (또는 아래 주소를 폰 사파리에 붙여넣기)
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

          <section className="card wide">
            <h2>설정</h2>
            <div className="settings-block">
              <h3>모드</h3>
              <label className="radio">
                <input type="radio" checked={formMode === "mock"} onChange={() => setFormMode("mock")} />
                <b>연습 모드</b> — 앱 안의 가짜 토스 서버. 실제 돈과 무관, 주문 흐름까지 연습 가능.
              </label>
              <label className="radio">
                <input type="radio" checked={formMode === "live"} onChange={() => setFormMode("live")} />
                <b>실서버 모드</b> — 실제 시세·잔고·환율 조회. <b>주문은 잠금(드라이런)</b>: 소액(1주) 테스트를 사람이
                직접 통과시킨 뒤 별도 버전에서 해금됩니다.
              </label>
            </div>
            <div className="settings-block">
              <h3>실주문 활성화 {settings.liveOrdersEnabled ? "🔴 켜짐" : "🔒 꺼짐(안전)"}</h3>
              <p className="hint">
                꺼져 있으면 주문 버튼을 눌러도 <b>실제 주문이 나가지 않고 모의 기록만</b> 남습니다.
                켜면 <b>실제 돈으로 주문이 전송</b>됩니다. 연습 모드에서는 이 설정과 무관하게 가짜 서버로만 갑니다.
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
                <b>실제 주문 전송 허용</b> — 켜기 전에 경고 확인을 거칩니다
              </label>
            </div>

            <div className="settings-block">
              <h3>주문 편의·안전 옵션 (전부 선택)</h3>
              <p className="hint">
                기본 상태에서 <b>앱은 주문을 막지 않습니다.</b> 아래는 원할 때만 켜는 보조 기능입니다.
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
                <b>오입력 방지</b> — 현재가에서 크게 벗어난 가격이면 경고하고 막기
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
                <b>주문 확인 팝업 건너뛰기</b> — 버튼을 누르면 바로 전송(오발주 위험 ↑)
              </label>
            </div>

            {/* [v0.8.3] 기본 손익비 설정 */}
            <div className="settings-block">
              <h3>기본 손익비 (익절% / 손절%)</h3>
              <p className="hint">
                계산기 <b>익절%·손절% 칸의 시작값</b>을 정해 둡니다. 앱을 껐다 켜거나 종목을 바꿔도 이 값이 유지됩니다
                (계산할 때 그때그때 수정은 여전히 가능). 현재 기본값: <b>익절 {settings.defaultTpPct ?? 2}% / 손절 {settings.defaultSlPct ?? 10}%</b>
              </p>
              <div className="form-row">
                <label>기본 익절 %
                  <input type="text" inputMode="decimal" value={defForm.tp} onChange={(e) => isNumericDraft(e.target.value) && setDefForm({ ...defForm, tp: e.target.value })} placeholder="예: 2" />
                </label>
                <label>기본 손절 %
                  <input type="text" inputMode="decimal" value={defForm.sl} onChange={(e) => isNumericDraft(e.target.value) && setDefForm({ ...defForm, sl: e.target.value })} placeholder="예: 10" />
                </label>
                <button className="btn btn-start" onClick={saveDefaults}>기본 손익비 저장</button>
              </div>
              <p className="hint small">공장 초기값은 익절 2% / 손절 10%입니다. 소수점(예: 2.5) 입력 가능, 0 이하는 저장되지 않습니다.</p>
            </div>

            {/* [v0.3.0] 세션별 시드 비율 설정 */}
            <div className="settings-block">
              <h3>세션별 시드 비율 (진입 수량 제안)</h3>
              <p className="hint">
                장(세션)마다 <b>시드의 몇 %로 진입</b>할지 정합니다. 계산기 화면이 현재 세션을 자동 판정해
                <b> 제안 수량</b>을 보여줍니다(강제 아님 — 다른 수량을 넣어도 그대로 전송).
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
              <p className="hint">시드 기준(무엇의 몇 %인지):</p>
              <label className="radio">
                <input type="radio" checked={seedForm.basis === "auto"} onChange={() => setSeedForm({ ...seedForm, basis: "auto" })} />
                <b>매수가능금액 자동 사용</b> — 지금 계좌의 예수금(달러)을 시드로 (기본)
              </label>
              <label className="radio">
                <input type="radio" checked={seedForm.basis === "fixed"} onChange={() => setSeedForm({ ...seedForm, basis: "fixed" })} />
                <b>고정 시드 금액 직접 입력</b> — 아래 달러 금액을 시드로 사용
              </label>
              {seedForm.basis === "fixed" && (
                <div className="form-row">
                  <label>고정 시드 $
                    <input type="text" inputMode="decimal" value={seedForm.fixed} onChange={(e) => isNumericDraft(e.target.value) && setSeedForm({ ...seedForm, fixed: e.target.value })} placeholder="예: 1000" />
                  </label>
                </div>
              )}
              <div className="form-row">
                <button className="btn btn-start" onClick={saveSeed}>시드 설정 저장</button>
                <span className="hint">예) 데이 90%, 시드 $1,000, 현재가 $10 → 제안 약 90주</span>
              </div>
            </div>

            <div className="settings-block">
              <h3>토스 API 키 {settings.hasClientId && settings.hasClientSecret ? "✅ 저장됨" : "❌ 미등록"}</h3>
              <p className="hint">키는 이 컴퓨터의 앱 데이터 폴더(.env, 본인만 읽기)에만 저장되고 화면에 다시 표시되지 않습니다.</p>
              <div className="form-col">
                <label>
                  Client ID
                  <input
                    type="password"
                    value={formId}
                    onChange={(e) => setFormId(e.target.value)}
                    placeholder={settings.hasClientId ? "(저장됨 — 변경 시에만)" : ""}
                  />
                </label>
                <label>
                  Client Secret
                  <input
                    type="password"
                    value={formSecret}
                    onChange={(e) => setFormSecret(e.target.value)}
                    placeholder={settings.hasClientSecret ? "(저장됨 — 변경 시에만)" : ""}
                  />
                </label>
                <label>
                  계좌 번호(accountSeq)
                  <input value={formAccount} onChange={(e) => setFormAccount(e.target.value)} placeholder="예: 1" />
                </label>
              </div>
            </div>
            <div className="form-row">
              <button className="btn btn-start" onClick={saveSettings}>
                설정 저장
              </button>
              {savedMsg && <span className="ok">{savedMsg}</span>}
            </div>

            {/* [v0.8.1] 키 클라우드 동기화 (멀티유저) — 로그인 → 키+마스터비번 → 완료 */}
            <div className="settings-block">
              <h3>🔐 키 클라우드 동기화 (여러 기기 · 사용자별 격리)</h3>
              <p className="hint">
                <b>사람마다 자기 계정</b>에 <b>자기 토스 키</b>를 두고, 자기 기기들끼리만 공유합니다. 다른 사람의 키는
                서로 <b>절대 볼 수 없습니다</b>. 키는 <b>마스터 비밀번호로 암호화</b>돼 <b>암호문만</b> 올라가므로,
                운영자조차 남의 평문 키를 못 봅니다.
              </p>

              {/* STEP 1: 로그인 */}
              <div className="step-box">
                <div className="step-title">1단계 · 로그인</div>
                {authState.loggedIn ? (
                  <div className="form-row">
                    <span className="ok">✅ 로그인됨: <b>{authState.email}</b></span>
                    <button className="mini" disabled={syncBusy} onClick={doSignOut}>로그아웃</button>
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
                  </>
                )}
                {authMsg && <p className={authMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{authMsg}</p>}
              </div>

              {/* STEP 2: 키 + 마스터 비밀번호 (로그인 후에만) */}
              <div className={`step-box ${authState.loggedIn ? "" : "step-disabled"}`}>
                <div className="step-title">2단계 · 마스터 비밀번호로 키 저장/불러오기</div>
                <p className="hint small">
                  위 [토스 API 키]에 내 키를 저장해 둔 뒤, 마스터 비밀번호(암호화용, 로그인 비번과 별개)를 정해
                  <b> ①로 클라우드에 저장</b>하세요. 다른 기기에선 같은 계정 로그인 + 같은 마스터 비밀번호로 <b>②만</b> 누르면 끝.
                </p>
                <div className="form-row">
                  <label style={{ flex: 1 }}>마스터 비밀번호(암호화용, 6자+)
                    <input type="password" value={syncPass} onChange={(e) => setSyncPass(e.target.value)} placeholder="나만 아는 암호화 비밀번호" disabled={!authState.loggedIn} />
                  </label>
                </div>
                <div className="form-row">
                  <button className="btn" disabled={syncBusy || !authState.loggedIn} onClick={doSyncPush}>① 내 키를 클라우드에 저장(암호화)</button>
                  <button className="btn btn-start" disabled={syncBusy || !authState.loggedIn} onClick={doSyncPull}>② 클라우드에서 불러오기</button>
                </div>
                {syncMsg && <p className={syncMsg.startsWith("✅") ? "ok" : "hint"} style={{ whiteSpace: "pre-wrap" }}>{syncMsg}</p>}
              </div>

              <p className="hint small">
                💡 <b>종훈(2기기)</b>: 맥에서 로그인+키+마스터비번 저장(①) → 윈도우에선 같은 계정 로그인 + 마스터비번으로 ②. 재발급 시 한 기기서 ①만.
                <br />💡 <b>카일(신규)</b>: 설치 → 가입/로그인 → [토스 API 키]에 <b>자기 키</b> 입력·저장 → 마스터비번 정해 ① → 끝. 자기 다른 기기선 로그인+②.
                <br />동기화를 안 쓰면 기존처럼 이 기기 로컬(.env)에만 저장됩니다.
              </p>
            </div>
          </section>
        </main>
      )}

      {/* ===== [v0.2.8] 조건주문 편집 창 — 값은 오너가 자유롭게 고친다 ===== */}
      {ocoEdit && (
        <div className="modal-back">
          <div className="modal">
            <h2>조건주문(익절+손절) — {symbol.toUpperCase()}</h2>
            {/* [v0.3.1] 보유 0주 안내 — 익절/손절은 '매도'라 보유분이 있어야 등록된다.
                막지는 않고(원하면 그대로 전송), 이번 같은 422(insufficient-sellable-quantity)를
                누르기 전에 이해하도록 친절히 알려준다. */}
            {cap && (cap.sellableQty ?? cap.heldQty) === 0 && (
              <div className="warn-box">
                ⚠️ 이 종목은 <b>보유 0주</b>입니다. 익절·손절은 <b>매도</b>라 보유분이 있어야 토스에 등록돼요.
                <br />
                먼저 <b>[진입 지정가]로 매수 → 체결 확인</b> 후 걸어주세요. (그래도 보내면 토스가 "보유 수량 없음"으로 거부합니다)
              </div>
            )}
            <p className="hint">
              계산값을 참고로 채워뒀습니다. <b>원하는 값으로 자유롭게 고치세요.</b> 앱은 막지 않고 그대로 토스에
              보냅니다(토스가 거부하면 그 응답을 보여드립니다).
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
              💡 토스 규칙: <b>익절가 &gt; 현재가 &gt; 손절가</b> 여야 등록됩니다. 어긋나면 토스가 거부할 수 있어요
              (앱은 막지 않고 보냅니다).
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
              보유(매도가능) <b>{sellModal.heldQty}주</b>. 원하는 수량·방식으로 파세요. 앱은 막지 않고 그대로 토스에 보냅니다.
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
              {ratModal.kind === "entry" ? "진입" : ratModal.kind === "oco" ? "조건주문" : "진입+익절(OTO)"} · {ratModal.ts}
              {ratModal.tossOrderId ? ` · 토스번호 ${ratModal.tossOrderId}` : ""}
              {ratModal.dryRun ? " · (모의)" : ""}
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
                🔒 현재 <b>주문 잠금(드라이런)</b> — 아래 버튼을 눌러도 실제 주문은 나가지 않고 모의 기록만 남습니다.
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
                {status.dryRun ? "모의 전송(기록만)" : "주문 전송"}
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
