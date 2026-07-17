// =============================================================================
// src/App.tsx — 카일 매매도구 화면 (v2: 계산기 + 온디맨드 주문)
// -----------------------------------------------------------------------------
// [v2 화면 철학]
//   자동으로 갱신되는 것이 거의 없다. 시세·환율·목록은 전부 "버튼을 눌러야" 1회
//   조회된다(자율판단 제거 컨셉과 일치). 주문은 반드시 확인 팝업을 거친다.
//
// [탭 구성]
//   ① 계산기: 기법 선택(삼분할/호가창/캔들/수동) → 재료 입력 → 진입/익절/손절
//              산출($와 ₩ 병기) → 주문 버튼(확인 팝업 → 전송)
//   ② 주문 현황: 미체결 일반주문 + 조건주문(OCO/OTO) 목록·취소
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

/** 달러 → "$x (₩y)" 병기 문자열. 환율 없으면 $만. */
function usdKrw(usd: number, fx: number | null): string {
  const dollar = `$${usd.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (!fx) return dollar;
  return `${dollar} (₩${Math.round(usd * fx).toLocaleString()})`;
}

/** 조건주문 만료일 기본값: 오늘 + 30일 (팝업에 표시해 사람이 인지) */
function defaultExpire(): string {
  const d = new Date(Date.now() + 30 * 86400_000);
  return d.toISOString().slice(0, 10);
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
  const [tab, setTab] = useState<"calc" | "orders" | "journal" | "settings">("calc");
  const [journal, setJournal] = useState<JournalEntry[]>([]);

  // --- 계산기 입력 상태 ---
  const [symbol, setSymbol] = useState("AAPL");
  const [curPrice, setCurPrice] = useState<number | null>(null);
  const [tech, setTech] = useState<Technique>("split3");
  const [tpPct, setTpPct] = useState(2);
  const [slPct, setSlPct] = useState(10);
  const [qty, setQty] = useState(1);
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

  // --- 연습 가격 조작 ---
  const [mockPrice, setMockPrice] = useState("");

  useEffect(() => {
    refreshStatus();
    window.kyletool.journal().then(setJournal);
    window.kyletool.getSettings().then((s) => {
      setSettings(s);
      setFormMode(s.mode);
      setFormAccount(s.account);
    });
    const off = window.kyletool.onJournal((e) => setJournal((prev) => [...prev.slice(-99), e]));
    return off;
  }, []);

  async function refreshStatus() {
    setStatus(await window.kyletool.status());
  }

  async function loadQuote() {
    setBusy(true);
    try {
      setCurPrice(await window.kyletool.quote(symbol.trim().toUpperCase()));
      await loadFx(); // 시세 볼 때 환율도 함께(둘 다 표시용)
      await refreshStatus();
    } catch (e) {
      alert(`시세 조회 실패: ${String(e)}`);
    } finally {
      setBusy(false);
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
    try {
      const r = await window.kyletool.calc({
        technique: tech,
        tpPct,
        slPct,
        baseClose: baseClose ? Number(baseClose) : undefined,
        ema200: ema200 ? Number(ema200) : undefined,
        wallPrice: wallPrice ? Number(wallPrice) : undefined,
        barOpen: barOpen ? Number(barOpen) : undefined,
        entry: manualEntry ? Number(manualEntry) : undefined,
      });
      setResult(r);
    } catch (e) {
      setCalcErr(String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, ""));
    }
  }

  // --- 주문 팝업 만들기(전송은 팝업의 확인 버튼에서만) ---

  function confirmEntry(lv: CalcLevel) {
    const total = lv.entry * qty;
    setPending({
      kind: "entry",
      title: `진입 지정가 매수 — ${symbol.toUpperCase()}`,
      lines: [
        `진입가 ${usdKrw(lv.entry, fx)} × ${qty}주`,
        `예상 투입액 ${usdKrw(total, fx)}`,
        `주문 유효기간: 당일(DAY) — 미체결분은 자동 취소`,
      ],
      send: () => window.kyletool.placeEntry({ symbol, price: lv.entry, quantity: qty }),
    });
  }

  function confirmOco(lv: CalcLevel) {
    const expire = defaultExpire();
    setPending({
      kind: "oco",
      title: `OCO 익절+손절 동시 등록 — ${symbol.toUpperCase()} (보유 중일 때)`,
      lines: [
        `수량 ${qty}주 / 익절 감시가 ${usdKrw(lv.tp, fx)} / 손절 감시가 ${usdKrw(lv.sl, fx)}`,
        `한쪽이 발동되면 다른 쪽은 자동 취소됩니다 (토스 서버가 감시 — 앱 꺼도 작동)`,
        `만료일 ${expire} / 규칙: 익절 감시가 > 현재가 > 손절 감시가`,
      ],
      send: () =>
        window.kyletool.placeOco({
          symbol,
          quantity: qty,
          tpTrigger: lv.tp,
          tpPrice: lv.tp,
          slTrigger: lv.sl,
          slPrice: lv.sl,
          expireDate: expire,
        }),
    });
  }

  function confirmOto(lv: CalcLevel) {
    const expire = defaultExpire();
    setPending({
      kind: "oto",
      title: `OTO 진입→익절 원스톱 — ${symbol.toUpperCase()}`,
      lines: [
        `진입 감시가 ${usdKrw(lv.entry, fx)} × ${qty}주 (체결되면 익절 감시 시작)`,
        `익절 감시가 ${usdKrw(lv.tp, fx)} / 만료일 ${expire}`,
        `⚠ 손절은 포함되지 않습니다(토스 OTO 스펙). 진입 체결 후 OCO로 바꿔 거는 것을 권장.`,
      ],
      send: () =>
        window.kyletool.placeOto({
          symbol,
          quantity: qty,
          entryTrigger: lv.entry,
          entryPrice: lv.entry,
          exitTrigger: lv.tp,
          exitPrice: lv.tp,
          expireDate: expire,
        }),
    });
  }

  async function sendPending() {
    if (!pending) return;
    setBusy(true);
    try {
      await pending.send();
      setPending(null);
      if (tab === "orders") await loadOrders();
    } catch (e) {
      alert(`전송 실패: ${String(e).replace(/^Error:\s*(Error invoking remote method '[^']+':\s*Error:\s*)?/, "")}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadOrders() {
    setBusy(true);
    try {
      const [o, c] = await Promise.all([window.kyletool.openOrders(), window.kyletool.conditionals()]);
      setOpenOrders(o);
      setConds(c);
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

  if (!status) return <div className="loading">카일 매매도구를 불러오는 중…</div>;
  const isMock = status.mode === "mock";

  return (
    <div className="app">
      {/* ===== 상단바 ===== */}
      <header className="topbar">
        <div className="brand">
          <span className="logo">🧮</span>
          <h1>카일 매매도구</h1>
          <span className={`badge ${isMock ? "badge-mock" : "badge-live"}`}>
            {isMock ? "연습 모드 (가짜 서버)" : "실서버"}
          </span>
          {status.dryRun && (
            <span className="badge badge-dry" title="소액(1주) 테스트를 사람이 통과시키기 전까지 실주문은 전송되지 않습니다">
              주문 잠금 (드라이런)
            </span>
          )}
          <span className="badge">{SESSION_LABEL[status.session]} · 3개 장 모두 주문 가능</span>
          {status.orderFrozen && <span className="badge badge-dry">⚠ 마감 1분 전: 정정·취소 불가 구간</span>}
        </div>
        <div className="controls">
          <button
            className={`btn btn-kill ${status.killSwitch ? "kill-on" : ""}`}
            title="켜면 모든 주문 버튼이 잠깁니다(계산·조회는 가능)"
            onClick={async () => {
              await window.kyletool.setKillSwitch(!status.killSwitch);
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
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="예: AAPL" />
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
                  ? `1 USD = ₩${fx.toLocaleString()} (${fxSource === "toss" ? "토스 자동 · 1분 갱신 참고용" : "수동 입력"})`
                  : "미조회 — [시세·환율 조회]를 누르세요"}
              </span>
              {fxFailed && (
                <>
                  <input
                    type="number"
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
                <input type="number" step="0.01" placeholder="새 가격" value={mockPrice} onChange={(e) => setMockPrice(e.target.value)} />
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
                  <input type="number" step="0.0001" value={baseClose} onChange={(e) => setBaseClose(e.target.value)} />
                </label>
                <label>
                  EMA200 $
                  <input type="number" step="0.0001" value={ema200} onChange={(e) => setEma200(e.target.value)} />
                </label>
                <span className="hint">전봉종가~EMA200을 3등분해 1·2·3분할 산출 (전봉종가 &gt; EMA200 필수)</span>
              </div>
            )}
            {tech === "orderbook" && (
              <div className="form-row">
                <label>
                  매수벽 가격 $
                  <input type="number" step="0.0001" value={wallPrice} onChange={(e) => setWallPrice(e.target.value)} />
                </label>
                <span className="hint">진입 = 벽 + 1틱. 벽인지 판단은 사람 몫(정량 기준 미확정)</span>
              </div>
            )}
            {tech === "candle" && (
              <div className="form-row">
                <label>
                  현재봉 시가 $
                  <input type="number" step="0.0001" value={barOpen} onChange={(e) => setBarOpen(e.target.value)} />
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
                  <input type="number" step="0.0001" value={manualEntry} onChange={(e) => setManualEntry(e.target.value)} />
                </label>
              </div>
            )}

            <div className="form-row">
              <label>
                익절 %
                <input type="number" step="0.1" value={tpPct} onChange={(e) => setTpPct(Number(e.target.value))} />
              </label>
              <label>
                손절 %
                <input type="number" step="0.1" value={slPct} onChange={(e) => setSlPct(Number(e.target.value))} />
              </label>
              <label>
                수량(주)
                <input type="number" min="1" value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
              </label>
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
                    <th>투입액 ({qty}주)</th>
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
                      <td>{usdKrw(lv.entry * qty, fx)}</td>
                      <td>
                        <button className="mini" disabled={status.killSwitch} onClick={() => confirmEntry(lv)}>
                          진입 지정가
                        </button>{" "}
                        <button className="mini" disabled={status.killSwitch} onClick={() => confirmOco(lv)}>
                          OCO 익절/손절
                        </button>{" "}
                        <button className="mini" disabled={status.killSwitch} onClick={() => confirmOto(lv)}>
                          OTO 진입→익절
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">
                💡 권장 순서: <b>진입 지정가</b>로 사고 → 체결 확인 후 <b>OCO 익절/손절</b> 등록. OCO/OTO 감시는 토스
                서버가 하므로 이 앱을 꺼도 작동합니다.
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
            <h2>조건주문 (OCO/OTO — 토스 서버가 감시 중)</h2>
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
              <p className="danger">
                <b>⚠ 실제 주문이 전송됩니다.</b> 가격·수량을 다시 확인하세요.
              </p>
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
