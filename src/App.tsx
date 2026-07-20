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

  // --- 설정 ---
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [formMode, setFormMode] = useState<"mock" | "live">("mock");
  const [formId, setFormId] = useState("");
  const [formSecret, setFormSecret] = useState("");
  const [formAccount, setFormAccount] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [guardPct, setGuardPct] = useState("15"); // 오입력 방지 한도(사용자 지정)
  // [v0.2.8] 조건주문 편집 창 — 계산값에 묶이지 않고 오너가 직접 고칠 수 있게 한다.
  const [ocoEdit, setOcoEdit] = useState<{ tp: string; sl: string; qty: string } | null>(null);
  // [v0.2.9] 토스에서 받아온 수량 정보(주문가능 최대 / 보유 / 매도가능). 표시용 참고값.
  const [cap, setCap] = useState<{
    buyingPowerUsd: number | null;
    commissionRate: number | null;
    maxBuyQty: number | null;
    heldQty: number | null;
    sellableQty: number | null;
  } | null>(null);

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

  async function loadQuote() {
    setBusy(true);
    try {
      const cur = await window.kyletool.quote(symbol.trim().toUpperCase());
      setCurPrice(cur);
      await loadFx(); // 시세 볼 때 환율도 함께(둘 다 표시용)
      await refreshCapacity(cur); // 주문가능 수량·보유 수량도 같이 갱신
      await refreshStatus();
    } catch (e) {
      // 원시 에러를 그대로 보여주지 않고, 사람이 조치할 수 있는 한국어 안내로.
      const raw = String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, "");
      alert(
        `시세 조회에 실패했어요.\n\n확인해 주세요:\n` +
          `· [설정] 탭에서 실서버 모드 + Client ID/Secret/계좌번호(보통 1)를 저장했는지\n` +
          `· 인터넷 연결 상태\n\n(자세한 메시지: ${raw})`,
      );
    } finally {
      setBusy(false);
    }
  }

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

  /** 계산 실행 — lib/calc.ts(사양서 M1 검증 함수)를 엔진 경유로 호출 */
  async function runCalc() {
    setCalcErr("");
    setResult(null);
    if (tech === "candle" && !candleYang) {
      setCalcErr("캔들 기법은 '전봉이 양봉'일 때만 씁니다. 확인 체크를 해 주세요.");
      return;
    }
    // [입력 검증] 계산 시점에만 숫자로 바꾸고, 비었거나 이상하면 한국어로 안내한다.
    const tpNum = toNum(tpPct);
    const slNum = toNum(slPct);
    if (tpNum === null || tpNum <= 0) {
      setCalcErr("익절 %를 0보다 큰 숫자로 입력하세요. (예: 2)");
      return;
    }
    if (slNum === null || slNum <= 0) {
      setCalcErr("손절 %를 0보다 큰 숫자로 입력하세요. (예: 10)");
      return;
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
      // 계산된 1분할 진입가 기준으로 "최대 몇 주" 다시 계산해 표시
      if (r.levels[0]) void refreshCapacity(r.levels[0].entry);
    } catch (e) {
      setCalcErr(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, ""));
    }
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
      send: () => window.kyletool.placeEntry({ symbol, price: lv.entry, quantity: q }),
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
    const lv = { level: 1, entry: 0, tp: tpv, sl: slv } as CalcLevel;
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

  async function loadOrders() {
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

      {/* ===== ① 계산기 ===== */}
      {tab === "calc" && (
        <main className="grid">
          <section className="card">
            <h2>1) 종목 · 시세 · 환율</h2>
            <div className="form-row">
              <label>
                종목 코드
                <input value={symbol} onChange={(e) => { setSymbol(e.target.value); setCap(null); setCurPrice(null); setResult(null); }} placeholder="예: AAPL" />
              </label>
              <button className="btn" disabled={busy} onClick={loadQuote}>
                시세·환율 조회
              </button>
              {curPrice != null && <span className="quote">현재가 {usdKrw(curPrice, fx)}</span>}
            </div>
            <div className="form-row">
              <span className="hint">
                환율:{" "}
                {fx
                  ? `1 USD = ₩${fx.toLocaleString()} (${fxSource === "toss" ? "토스 매매기준율 · 1분 갱신" : "수동 입력"})`
                  : "미조회 — [시세·환율 조회]를 누르세요"}
              </span>
              <span className="hint">
                💡 <b>원화(₩)는 참고용 환산</b>입니다. 환율은 1분마다 바뀌고 토스 화면과 조회 시점이 달라
                몇백 원 차이가 날 수 있어요. <b>실제 주문·체결은 달러 기준</b>입니다.
              </span>
              {fxFailed && (
                <>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="환율 수동 입력 (예: 1390)"
                    value={manualFx}
                    onChange={(e) => setManualFxInput(e.target.value)}
                  />
                  <button className="mini" onClick={applyManualFx}>
                    적용
                  </button>
                  <span className="hint danger">자동 조회 실패 — 수동으로 입력해 주세요</span>
                </>
              )}
            </div>
            {isMock && (
              <div className="form-row mock-box">
                <span className="hint">🎮 연습: 가짜 서버 현재가 바꾸기</span>
                <input type="text" inputMode="decimal" placeholder="새 가격" value={mockPrice} onChange={(e) => isNumericDraft(e.target.value) && setMockPrice(e.target.value)} />
                <button
                  className="mini"
                  onClick={async () => {
                    if (mockPrice) {
                      await window.kyletool.mockSetPrice(symbol.trim().toUpperCase(), Number(mockPrice));
                      loadQuote();
                    }
                  }}
                >
                  변경
                </button>
              </div>
            )}
          </section>

          <section className="card">
            <h2>2) 매매기법 선택 · 재료 입력</h2>
            <div className="form-row">
              {(["split3", "orderbook", "candle", "manual"] as Technique[]).map((t) => (
                <label className="radio" key={t}>
                  <input
                    type="radio"
                    checked={tech === t}
                    onChange={() => {
                      setTech(t);
                      setResult(null);
                      setCalcErr("");
                    }}
                  />
                  {TECH_LABEL[t]}
                </label>
              ))}
            </div>

            {tech === "split3" && (
              <div className="form-row">
                <label>
                  전봉 종가 $
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="예: 11.33"
                    value={baseClose}
                    onChange={(e) => isNumericDraft(e.target.value) && setBaseClose(e.target.value)}
                  />
                </label>
                <label>
                  EMA200 $
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="예: 11.33"
                    value={ema200}
                    onChange={(e) => isNumericDraft(e.target.value) && setEma200(e.target.value)}
                  />
                </label>
                <span className="hint">전봉종가~EMA200을 3등분해 1·2·3분할 산출 (전봉종가 &gt; EMA200 필수)</span>
              </div>
            )}
            {tech === "orderbook" && (
              <div className="form-row">
                <label>
                  매수벽 가격 $
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="예: 11.33"
                    value={wallPrice}
                    onChange={(e) => isNumericDraft(e.target.value) && setWallPrice(e.target.value)}
                  />
                </label>
                <span className="hint">진입 = 벽 + 1틱. 벽인지 판단은 사람 몫(정량 기준 미확정)</span>
              </div>
            )}
            {tech === "candle" && (
              <div className="form-row">
                <label>
                  현재봉 시가 $
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="예: 11.33"
                    value={barOpen}
                    onChange={(e) => isNumericDraft(e.target.value) && setBarOpen(e.target.value)}
                  />
                </label>
                <label className="radio">
                  <input type="checkbox" checked={candleYang} onChange={(e) => setCandleYang(e.target.checked)} />
                  전봉이 양봉(종가&gt;시가)임을 확인했습니다
                </label>
              </div>
            )}
            {tech === "manual" && (
              <div className="form-row">
                <label>
                  진입가 $
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="예: 11.33"
                    value={manualEntry}
                    onChange={(e) => isNumericDraft(e.target.value) && setManualEntry(e.target.value)}
                  />
                </label>
              </div>
            )}

            <div className="form-row">
              <label>
                익절 %
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="예: 2"
                  value={tpPct}
                  onChange={(e) => isNumericDraft(e.target.value) && setTpPct(e.target.value)}
                />
              </label>
              <label>
                손절 %
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="예: 10"
                  value={slPct}
                  onChange={(e) => isNumericDraft(e.target.value) && setSlPct(e.target.value)}
                />
              </label>
              <label>
                수량(주)
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="예: 1 (소수주 가능)"
                  value={qty}
                  onChange={(e) => isNumericDraft(e.target.value) && setQty(e.target.value)}
                />
              </label>
              {/* [v0.2.9] 토스에서 받아온 주문가능 수량 — 참고 표시이며 강제하지 않는다 */}
              <div className="cap-box">
                {cap ? (
                  <>
                    <span className="hint">
                      주문가능 최대{" "}
                      <b>{cap.maxBuyQty != null ? `${cap.maxBuyQty.toLocaleString()}주` : "—"}</b>
                      {cap.buyingPowerUsd != null && ` (매수가능 $${cap.buyingPowerUsd.toLocaleString()} 기준`}
                      {cap.commissionRate != null && `, 수수료 ${(cap.commissionRate * 100).toFixed(3)}%`}
                      {cap.buyingPowerUsd != null && ")"}
                    </span>
                    {cap.maxBuyQty != null && cap.maxBuyQty > 0 && (
                      <button className="mini" onClick={() => setQty(String(cap.maxBuyQty))}>
                        최대
                      </button>
                    )}
                    <span className="hint">
                      · 보유 <b>{cap.heldQty != null ? `${cap.heldQty}주` : "—"}</b>
                      {cap.sellableQty != null && ` (매도가능 ${cap.sellableQty}주)`}
                    </span>
                  </>
                ) : (
                  <span className="hint">주문가능 수량: [시세·환율 조회]를 누르면 표시됩니다</span>
                )}
              </div>
              <button className="btn btn-start" onClick={runCalc}>
                계산하기
              </button>
            </div>
            {calcErr && <p className="danger">⚠ {calcErr}</p>}
          </section>

          {result && (
            <section className="card wide">
              <h2>
                3) 계산 결과 — {TECH_LABEL[result.technique]} <span className="hint">{result.note}</span>
              </h2>
              <table>
                <thead>
                  <tr>
                    <th>분할</th>
                    <th>진입가</th>
                    <th>익절가 (+{tpPct}%)</th>
                    <th>손절가 (−{slPct}%)</th>
                    <th>투입액 ({qty || "?"}주){cap?.maxBuyQty != null && <span className="hint"> / 최대 {cap.maxBuyQty}주</span>}</th>
                    <th>주문 (확인 팝업 후 전송)</th>
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
                      <td>
                        <button className="mini" disabled={status.killSwitch} onClick={() => confirmEntry(lv)}>
                          진입 지정가
                        </button>{" "}
                        <button className="mini" disabled={status.killSwitch} onClick={() => openOcoEditor(lv)}>
                          조건주문(익절+손절)
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                💡 권장 순서: <b>진입 지정가</b>로 사고 → 체결 확인 후 <b>조건주문(익절+손절)</b> 등록.
                조건주문 감시는 토스 서버가 하므로 이 앱을 꺼도 작동합니다.
                {status.dryRun && " (현재 주문 잠금 — 전송 대신 모의 기록만 남습니다)"}
              </p>
            </section>
          )}
        </main>
      )}

      {/* ===== ② 주문 현황 ===== */}
      {tab === "orders" && (
        <main className="grid">
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
