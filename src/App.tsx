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

import { useEffect, useState } from "react";
import "./App.css";

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

/** 조건주문 만료일 기본값: (KST 기준) 오늘 + 30일.
 *   [주의] toISOString()은 UTC라, KST 새벽(00~09시)엔 하루 이르게 찍힌다.
 *   그래서 KST 오프셋(+9h)을 더한 뒤 날짜를 뽑아 KST 날짜와 일치시킨다. */
function defaultExpire(): string {
  const kstMs = Date.now() + 9 * 3600_000 + 30 * 86400_000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

// 주문 확인 팝업에 담기는 내용(무엇을 전송할지 사람이 최종 확인)
interface PendingOrder {
  kind: "entry" | "oco";
  title: string;
  lines: string[];
  send: () => Promise<JournalEntry>;
}

function App() {
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [tab, setTab] = useState<"calc" | "orders" | "journal" | "settings">("calc");
  const [journal, setJournal] = useState<JournalEntry[]>([]);

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

  // --- 주문 현황 ---
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [conds, setConds] = useState<CondOrder[]>([]);
  // [v0.2.10] 보유 포지션(손익 포함) + 매매 근거 기록
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [rationales, setRationales] = useState<TradeRationale[]>([]);
  const [posBusy, setPosBusy] = useState(false);
  const [posAt, setPosAt] = useState<string>(""); // 마지막 갱신 시각(표시용)
  const [autoRefresh, setAutoRefresh] = useState(false); // 30초 자동 갱신 켜기/끄기

  // --- 설정 ---
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [formMode, setFormMode] = useState<"mock" | "live">("mock");
  const [formId, setFormId] = useState("");
  const [formSecret, setFormSecret] = useState("");
  const [formAccount, setFormAccount] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [guardPct, setGuardPct] = useState("15"); // 오입력 방지 한도(사용자 지정)
  // [v0.3.0] 세션별 시드 비율 설정 입력칸(설정 탭). 문자열 보관(입력 중 뭉개짐 방지).
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
      // [v0.3.0] 실서버면 켜자마자 상단 바(예수금·손익)와 기본 종목 시세를 자동 로드한다.
      if (s.mode === "live") {
        void loadAccount();
        void autoLoad("AAPL");
      }
    });
    window.kyletool.appVersion?.().then(setAppVer).catch(() => {});
    const off = window.kyletool.onJournal((e) => setJournal((prev) => [...prev.slice(-99), e]));
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
      offUpd?.();
    };
  }, []);

  // [v0.2.10] 30초 자동 갱신. 기본은 꺼짐(자율 동작 최소화 원칙) — 오너가 켤 때만 돈다.
  //   주문 현황 탭에 있을 때만 돌려서 불필요한 조회를 줄인다.
  useEffect(() => {
    if (!autoRefresh || tab !== "orders") return;
    const id = setInterval(() => void loadPositions(), 30_000);
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
        if (tab === "orders") await loadOrders();
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
      if (tab === "orders") await loadOrders();
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, "");
      alert(`주문이 전송되지 않았습니다.

${msg}

(위 사유가 해결되면 다시 시도하세요. 돈은 나가지 않았습니다.)`);
    } finally {
      setBusy(false);
    }
  }

  /** [v0.2.10] 보유 포지션(손익)과 매매 근거를 다시 불러온다. 읽기 전용이라 언제 눌러도 안전. */
  async function loadPositions() {
    setPosBusy(true);
    try {
      const [pRes, rRes] = await Promise.allSettled([window.kyletool.positions(), window.kyletool.rationales()]);
      if (pRes.status === "fulfilled") setPositions(pRes.value);
      if (rRes.status === "fulfilled") setRationales(rRes.value);
      setPosAt(new Date().toLocaleTimeString());
    } finally {
      setPosBusy(false);
    }
  }

  async function loadOrders() {
    void loadPositions(); // 주문 목록을 볼 땐 포지션 손익도 같이 갱신
    setBusy(true);
    try {
      // [allSettled] 한쪽(일반/조건)이 실패해도 다른 쪽은 보여준다. 예전엔 Promise.all이라
      //   조건주문 조회가 한 번 실패하면 정상인 일반주문까지 화면에서 통째로 사라졌다.
      const [oRes, cRes] = await Promise.allSettled([window.kyletool.openOrders(), window.kyletool.conditionals()]);
      if (oRes.status === "fulfilled") setOpenOrders(oRes.value);
      if (cRes.status === "fulfilled") setConds(cRes.value);
      const fails: string[] = [];
      if (oRes.status === "rejected") fails.push("일반 주문");
      if (cRes.status === "rejected") fails.push("조건 주문");
      if (fails.length) {
        alert(`${fails.join("·")} 목록을 불러오지 못했어요. [설정] 탭에서 실서버 모드·키·계좌(보통 1)를 저장했는지 확인해 주세요.`);
      }
    } catch (e) {
      alert(`목록 조회 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
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
          <span className={`badge ${isMock ? "badge-mock" : "badge-live"}`}>
            {isMock ? "연습 모드 (가짜 서버)" : "실서버"}
          </span>
          {status.dryRun ? (
            <span className="badge badge-dry" title="실주문 잠금 상태입니다. 주문 버튼을 눌러도 모의 기록만 남습니다">
              🔒 주문 잠금 (드라이런)
            </span>
          ) : (
            <span className="badge badge-liveorder" title="실제 돈으로 주문이 전송되는 상태입니다">
              🔴 실주문 활성 — 실제 체결됩니다
            </span>
          )}
          <span className="badge">{SESSION_LABEL[status.session]} · 3개 장 모두 주문 가능</span>
          {status.orderFrozen && <span className="badge badge-dry">⚠ 마감 1분 전: 정정·취소 불가 구간</span>}
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
                if (tab === "orders") await loadOrders();
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
        {(["calc", "orders", "journal", "settings"] as const).map((t) => (
          <button
            key={t}
            className={tab === t ? "tab active" : "tab"}
            onClick={() => {
              setTab(t);
              if (t === "orders") loadOrders();
            }}
          >
            {{ calc: "계산기", orders: "주문 현황", journal: "기록", settings: "설정" }[t]}
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
              <b>{SESSION_LABEL[status.session]}</b>
              {cap && <span className="hint"> · 시드 {cap.sessionPct}%</span>}
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
                            <button className="mini btn-oco" disabled={status.killSwitch} onClick={() => openOcoEditor(lv)}>조건주문</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="hint">
                    💡 1·2·3분할은 <b>동등한 후보</b>입니다(어느 것도 추천 아님). 순서: 진입 지정가로 매수 → 체결 확인 → 조건주문(익절+손절) 등록. 조건주문 감시는 토스 서버가 하므로 앱을 꺼도 작동합니다.
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

      {/* ===== ② 주문 현황 ===== */}
      {tab === "orders" && (
        <main className="grid">
          {/* [v0.2.10] 보유 포지션 — 매수가 대비 손익 %와 매매 근거를 한 장의 카드로 */}
          <section className="card wide">
            <h2>
              보유 포지션 · 손익{" "}
              <button className="mini" disabled={posBusy} onClick={loadPositions}>
                새로고침
              </button>{" "}
              <label className="inline-check">
                <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> 30초마다 자동
              </label>
              {posAt && <span className="hint small"> (마지막 갱신 {posAt})</span>}
            </h2>
            {positions.length === 0 ? (
              <p className="hint">보유 중인 종목이 없거나 아직 조회하지 않았습니다. [새로고침]을 눌러 주세요.</p>
            ) : (
              <div className="poslist">
                {positions.map((p) => (
                  <div key={p.symbol} className="poscard">
                    <div className="posline1">
                      <b className="possym">{p.symbol}</b>
                      <span className="posqty">{p.quantity}주</span>
                      <span className={`posPnl ${pnlClass(p.pnlPct)}`}>
                        {p.pnlPct == null ? "손익 조회 불가" : `${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(2)}%`}
                      </span>
                      {p.pnlUsd != null && (
                        <span className={`small ${pnlClass(p.pnlUsd)}`}>
                          ({p.pnlUsd >= 0 ? "+" : ""}
                          {money(p.pnlUsd, p.currency, fx)})
                        </span>
                      )}
                    </div>
                    <div className="posline2 small">
                      기준가 {p.entryPrice != null ? money(p.entryPrice, p.currency, null) : "-"}
                      <span className="hint">
                        {p.entrySource === "rationale" ? " (내 기록 진입가)" : p.entrySource === "toss" ? " (토스 평균매입가)" : ""}
                      </span>
                      {" · "}현재가 {p.currentPrice != null ? money(p.currentPrice, p.currency, null) : "조회 불가"}
                      {p.avgPrice != null && p.entrySource === "rationale" && ` · 토스 평단 ${money(p.avgPrice, p.currency, null)}`}
                    </div>
                    {(p.toTpPct != null || p.toSlPct != null) && (
                      <div className="posline3 small">
                        {p.toTpPct != null && <span className="pnl-up">익절까지 {p.toTpPct >= 0 ? "+" : ""}{p.toTpPct.toFixed(2)}%p</span>}
                        {p.toTpPct != null && p.toSlPct != null && " / "}
                        {p.toSlPct != null && <span className="pnl-down">손절까지 {p.toSlPct.toFixed(2)}%p</span>}
                      </div>
                    )}
                    <div className="posrationale small">
                      {p.rationale ? (
                        <>
                          <span className="tag">근거</span> {rationaleLine(p.rationale)}{" "}
                          <span className="hint">({p.rationale.ts})</span>
                        </>
                      ) : (
                        <span className="hint">이 종목은 매매 근거 기록이 없습니다(v0.2.10 이전에 낸 주문).</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* [v0.2.10] 최근 주문의 매매 근거 목록 */}
          <section className="card wide">
            <h2>최근 주문 근거 (내가 왜 이 가격에 냈는가)</h2>
            {rationales.length === 0 ? (
              <p className="hint">
                아직 기록된 근거가 없습니다. v0.2.10부터 <b>새로 내는 주문</b>에 근거가 자동으로 남습니다.
              </p>
            ) : (
              <div className="ratlist">
                {rationales.slice(0, 30).map((r) => (
                  <div key={r.clientOrderId} className="ratcard">
                    <div>
                      <span className="tag">{r.kind === "entry" ? "진입" : "조건주문"}</span>
                      {r.dryRun && <span className="tag warn">모의</span>} <b>{r.symbol}</b> · {rationaleLine(r)}
                    </div>
                    <div className="hint small">
                      {r.ts} · 주문키 {r.clientOrderId}
                      {r.tossOrderId ? ` · 토스번호 ${r.tossOrderId}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card wide">
            <h2>
              미체결 일반 주문{" "}
              <button className="mini" disabled={busy} onClick={loadOrders}>
                새로고침
              </button>
            </h2>
            {openOrders.length === 0 ? (
              <p className="hint">미체결 주문이 없습니다.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>주문번호</th>
                    <th>종목</th>
                    <th>방향</th>
                    <th>가격</th>
                    <th>상태</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {openOrders.map((o) => (
                    <tr key={o.tossOrderId}>
                      <td className="mono">{o.tossOrderId}</td>
                      <td>{o.symbol}</td>
                      <td>{o.side === "BUY" ? "매수" : "매도"}</td>
                      <td>{o.price != null ? usdKrw(o.price, fx) : "-"}</td>
                      <td>{o.status}</td>
                      <td>
                        <button
                          className="mini"
                          disabled={status.killSwitch}
                          onClick={async () => {
                            await window.kyletool.cancelOrder(o.tossOrderId).catch((e) => alert(String(e)));
                            loadOrders();
                          }}
                        >
                          취소
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card wide">
            <h2>조건주문 (OCO 익절+손절 — 토스 서버가 감시 중)</h2>
            {conds.length === 0 ? (
              <p className="hint">등록된 조건주문이 없습니다.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>번호</th>
                    <th>종목</th>
                    <th>타입</th>
                    <th>1번 조건</th>
                    <th>2번 조건</th>
                    <th>수량</th>
                    <th>만료</th>
                    <th>상태</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {conds.map((c) => (
                    <tr key={c.conditionalOrderId}>
                      <td className="mono">{c.conditionalOrderId}</td>
                      <td>{c.symbol}</td>
                      <td>{c.type}</td>
                      <td>{c.first ? `${c.first.orderSide === "BUY" ? "매수" : "매도"} @$${c.first.triggerPrice}` : "-"}</td>
                      <td>{c.second ? `${c.second.orderSide === "BUY" ? "매수" : "매도"} @$${c.second.triggerPrice}` : "-"}</td>
                      <td>{c.quantity}</td>
                      <td className="small">{c.expireDate}</td>
                      <td>{c.status}</td>
                      <td>
                        <button
                          className="mini"
                          disabled={status.killSwitch}
                          onClick={async () => {
                            await window.kyletool.cancelConditional(c.conditionalOrderId).catch((e) => alert(String(e)));
                            loadOrders();
                          }}
                        >
                          취소
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
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
          </section>
        </main>
      )}

      {/* ===== [v0.2.8] 조건주문 편집 창 — 값은 오너가 자유롭게 고친다 ===== */}
      {ocoEdit && (
        <div className="modal-back">
          <div className="modal">
            <h2>조건주문(익절+손절) — {symbol.toUpperCase()}</h2>
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
