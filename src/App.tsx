// =============================================================================
// src/App.tsx  —  카일봇 대시보드 화면 (React)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   데스크톱 앱의 눈에 보이는 부분 전부입니다. 봇의 실제 판단·주문은 전부
//   메인 프로세스의 엔진(electron/bot-engine.ts)이 하고, 이 화면은
//   window.kylebot 창구(preload.cjs)를 통해 ① 상태를 받아 그리고 ② 버튼 입력을
//   엔진에 전달만 합니다. (화면이 죽어도 봇 로직과 분리돼 있어 안전)
//
// [화면 구성]
//   상단바: 모드 배지(연습/실서버) · 드라이런 배지 · 봇 시작/정지 · 킬 스위치
//   탭 1 대시보드: 장 상태 카드 / 새 매매 계획 폼 / 진행 세션 / 매매일지 / 실시간 로그
//   탭 2 설정: 연습·실서버 모드, 토스 API 키(값은 화면에 다시 안 보임), 확인 간격
// =============================================================================

import { useEffect, useRef, useState } from "react";
import "./App.css";

/** 장 세션 코드 → 한국어 라벨 */
const SESSION_LABEL: Record<string, string> = {
  day: "데이마켓 (거래 시간)",
  pre: "프리마켓",
  regular: "정규장",
  after: "애프터마켓",
  closed: "장 마감",
};

/** 포지션 상태 → 한국어 라벨 */
const POS_LABEL: Record<string, string> = {
  pending_entry: "진입 대기",
  entered: "보유 중",
  closed: "청산 완료",
  skipped: "건너뜀(차단/드라이런)",
};

/** 청산 사유 → 한국어 라벨 */
const EXIT_LABEL: Record<string, string> = {
  take_profit: "익절",
  stop_loss: "손절",
  eod_close: "장마감 청산",
  cancelled: "취소",
};

function App() {
  // --- 엔진에서 받아 오는 상태들 ---
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [logs, setLogs] = useState<UiLogEntry[]>([]);
  const [settings, setSettings] = useState<UiSettings | null>(null);
  const [tab, setTab] = useState<"dash" | "settings">("dash");

  // --- 새 매매 계획 폼 입력값 ---
  const [symbol, setSymbol] = useState("AAPL");
  const [plan, setPlan] = useState<{ price: number; entry: number; tp: number; sl: number } | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false); // 버튼 연타 방지

  // --- 연습 모드 가격 조작 입력값 ---
  const [mockPrice, setMockPrice] = useState("");

  // --- 설정 폼 입력값(키는 입력했을 때만 전송) ---
  const [formMode, setFormMode] = useState<"mock" | "live">("mock");
  const [formClientId, setFormClientId] = useState("");
  const [formClientSecret, setFormClientSecret] = useState("");
  const [formAccount, setFormAccount] = useState("");
  const [formTick, setFormTick] = useState(5);
  const [savedMsg, setSavedMsg] = useState("");

  const logEndRef = useRef<HTMLDivElement>(null);

  // 첫 로드: 상태·로그·설정을 가져오고, 실시간 이벤트를 구독한다.
  useEffect(() => {
    window.kylebot.getStatus().then(setStatus);
    window.kylebot.getLogs().then(setLogs);
    window.kylebot.getSettings().then((s) => {
      setSettings(s);
      setFormMode(s.mode);
      setFormAccount(s.account);
      setFormTick(s.tickSeconds);
    });
    // 엔진이 밀어 주는 실시간 갱신(틱마다 상태, 이벤트마다 로그 한 줄).
    const offStatus = window.kylebot.onStatus(setStatus);
    const offLog = window.kylebot.onLog((entry) => setLogs((prev) => [...prev.slice(-499), entry]));
    // 보조 폴링(2초): 이벤트를 놓쳐도 화면이 오래 낡지 않게.
    const poll = setInterval(() => window.kylebot.getStatus().then(setStatus), 2000);
    return () => {
      offStatus();
      offLog();
      clearInterval(poll);
    };
  }, []);

  // 로그가 추가되면 로그 창을 맨 아래로 스크롤.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // --- 버튼 동작들 ---

  /** 시세를 불러와 기본 매매 계획(진입 -0.5%/익절 +2%/손절 -10%)을 채운다 */
  async function loadPlan() {
    setBusy(true);
    try {
      const p = await window.kylebot.planFromQuote(symbol.trim().toUpperCase());
      setPlan({ price: p.price, entry: p.entry, tp: p.tp, sl: p.sl });
    } catch (e) {
      alert(`시세 조회 실패: ${String(e)}\n(봇이 켜져 있어야 연습 서버에 연결됩니다)`);
    } finally {
      setBusy(false);
    }
  }

  /** 계획 확정 → 세션 생성·장전(진입 지정가 등록) */
  async function submitSession() {
    if (!plan) return;
    setBusy(true);
    try {
      await window.kylebot.createSession({
        symbol: symbol.trim().toUpperCase(),
        entry: plan.entry,
        tp: plan.tp,
        sl: plan.sl,
        quantity: qty,
      });
      setPlan(null); // 폼 초기화
    } catch (e) {
      alert(`세션 생성 실패: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /** 설정 저장(키는 입력한 경우에만 전송 — 빈 칸이면 기존 키 유지) */
  async function saveSettings() {
    const saved = await window.kylebot.saveSettings({
      mode: formMode,
      clientId: formClientId || undefined,
      clientSecret: formClientSecret || undefined,
      account: formAccount,
      tickSeconds: formTick,
    });
    setSettings(saved);
    setFormClientId(""); // 입력칸 비움(키를 화면에 남기지 않음)
    setFormClientSecret("");
    setSavedMsg("저장되었습니다. (키는 이 컴퓨터의 앱 데이터 폴더에만 저장됩니다)");
    setTimeout(() => setSavedMsg(""), 4000);
  }

  if (!status) return <div className="loading">카일봇을 불러오는 중…</div>;

  const isMock = status.mode === "mock";

  return (
    <div className="app">
      {/* ===== 상단바 ===== */}
      <header className="topbar">
        <div className="brand">
          <span className="logo">🤖</span>
          <h1>카일봇</h1>
          <span className={`badge ${isMock ? "badge-mock" : "badge-live"}`}>
            {isMock ? "연습 모드 (가짜 서버)" : "실서버 (읽기 전용)"}
          </span>
          <span className="badge badge-dry" title="이 버전은 실주문이 코드에서 차단되어 있습니다">
            드라이런 · 실주문 잠금
          </span>
        </div>
        <div className="controls">
          <button
            className={`btn ${status.running ? "btn-stop" : "btn-start"}`}
            onClick={() => (status.running ? window.kylebot.stop() : window.kylebot.start())}
          >
            {status.running ? "■ 봇 정지" : "▶ 봇 시작"}
          </button>
          <button
            className={`btn btn-kill ${status.killSwitch ? "kill-on" : ""}`}
            title="비상정지: 켜면 신규 진입 주문이 전부 차단됩니다(청산은 허용)"
            onClick={() => window.kylebot.setKillSwitch(!status.killSwitch)}
          >
            {status.killSwitch ? "🔴 킬 스위치 ON" : "⭘ 킬 스위치"}
          </button>
        </div>
      </header>

      {/* ===== 탭 ===== */}
      <nav className="tabs">
        <button className={tab === "dash" ? "tab active" : "tab"} onClick={() => setTab("dash")}>
          대시보드
        </button>
        <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
          설정
        </button>
      </nav>

      {tab === "dash" && (
        <main className="grid">
          {/* --- 장 상태 카드 --- */}
          <section className="card">
            <h2>장 상태</h2>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-label">현재 세션</span>
                <span className={`stat-value ${status.session === "day" ? "ok" : ""}`}>
                  {SESSION_LABEL[status.session]}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">시각</span>
                <span className="stat-value small">{status.clockNote}</span>
              </div>
              <div className="stat">
                <span className="stat-label">데이마켓 개장</span>
                <span className="stat-value">{status.nextDayOpen} KST</span>
              </div>
              <div className="stat">
                <span className="stat-label">청산 데드라인</span>
                <span className="stat-value">{status.closeDeadline} KST</span>
              </div>
              <div className="stat">
                <span className="stat-label">마지막 확인</span>
                <span className="stat-value">{status.lastTickAt ?? "—"}</span>
              </div>
              <div className="stat">
                <span className="stat-label">매수 가능</span>
                <span className="stat-value">
                  {status.buyingPowerUsd != null ? `$${status.buyingPowerUsd.toLocaleString()}` : "—"}{" "}
                  <button className="mini" onClick={() => window.kylebot.refreshBuyingPower()}>
                    새로고침
                  </button>
                </span>
              </div>
            </div>
            {/* 오늘의 안전장치 현황 */}
            {status.riskState && (
              <div className="risk-row">
                <span>오늘 실현 손익 {status.riskState.realized_pnl_pct.toFixed(2)}%</span>
                <span>주문 {status.riskState.order_count}건</span>
                <span>연속 손절 {status.riskState.consecutive_losses}회</span>
                {status.riskState.halted && <span className="danger">⛔ 거래 정지: {status.riskState.halt_reason}</span>}
              </div>
            )}
          </section>

          {/* --- 새 매매 계획 --- */}
          <section className="card">
            <h2>새 매매 계획</h2>
            <p className="hint">
              봇을 켠 뒤 종목을 정하고 시세를 불러오면 기본 계획(진입 −0.5% / 익절 +2% / 손절 −10%)을
              계산해 줍니다. 수치는 직접 고칠 수 있습니다.
            </p>
            <div className="form-row">
              <label>
                종목 코드
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="예: AAPL" />
              </label>
              <button className="btn" disabled={busy || !status.running} onClick={loadPlan}>
                시세 불러오기
              </button>
              {!status.running && <span className="hint">← 먼저 봇을 시작하세요</span>}
            </div>
            {plan && (
              <>
                <div className="form-row">
                  <span className="quote">현재가 ${plan.price}</span>
                  <label>
                    진입가 $
                    <input
                      type="number"
                      step="0.01"
                      value={plan.entry}
                      onChange={(e) => setPlan({ ...plan, entry: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    익절가 $
                    <input
                      type="number"
                      step="0.01"
                      value={plan.tp}
                      onChange={(e) => setPlan({ ...plan, tp: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    손절가 $
                    <input
                      type="number"
                      step="0.01"
                      value={plan.sl}
                      onChange={(e) => setPlan({ ...plan, sl: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    수량(주)
                    <input type="number" min="1" value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} />
                  </label>
                </div>
                <div className="form-row">
                  <button className="btn btn-start" disabled={busy} onClick={submitSession}>
                    이 계획으로 세션 시작
                  </button>
                  <span className="hint">진입 주문은 안전장치 게이트를 통과해야만 등록됩니다.</span>
                </div>
              </>
            )}
            {/* 연습 모드 전용: 시장 가격 조작(교육용) */}
            {isMock && status.running && (
              <div className="form-row mock-box">
                <span className="hint">🎮 연습: 시장 가격을 직접 움직여 익절/손절을 재현해 보세요.</span>
                <input
                  type="number"
                  step="0.01"
                  placeholder="새 가격"
                  value={mockPrice}
                  onChange={(e) => setMockPrice(e.target.value)}
                />
                <button
                  className="mini"
                  onClick={() => mockPrice && window.kylebot.mockSetPrice(symbol.trim().toUpperCase(), Number(mockPrice))}
                >
                  가격 변경
                </button>
              </div>
            )}
          </section>

          {/* --- 진행 중 세션 --- */}
          <section className="card wide">
            <h2>매매 세션 ({status.sessions.length})</h2>
            {status.sessions.length === 0 ? (
              <p className="hint">아직 세션이 없습니다. 위에서 새 매매 계획을 만들어 보세요.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>세션</th>
                    <th>종목</th>
                    <th>상태</th>
                    <th>진입가</th>
                    <th>익절가</th>
                    <th>손절가</th>
                    <th>수량</th>
                    <th>포지션</th>
                  </tr>
                </thead>
                <tbody>
                  {status.sessions.flatMap((s) =>
                    s.positions.map((p) => (
                      <tr key={`${s.id}-${p.level}`}>
                        <td className="mono">{s.id}</td>
                        <td>{s.symbol}</td>
                        <td>{s.status}</td>
                        <td>${p.entryPrice}</td>
                        <td className="ok">${p.tpPrice}</td>
                        <td className="danger">${p.slPrice}</td>
                        <td>{p.quantity}</td>
                        <td>
                          {POS_LABEL[p.state]}
                          {p.exitReason ? ` · ${EXIT_LABEL[p.exitReason] ?? p.exitReason}` : ""}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            )}
          </section>

          {/* --- 매매일지 --- */}
          <section className="card wide">
            <h2>매매일지 (최근 {status.tradeLogs.length}건)</h2>
            {status.tradeLogs.length === 0 ? (
              <p className="hint">청산이 완료되면 여기 기록됩니다. (승률·손익의 재료)</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>진입</th>
                    <th>청산</th>
                    <th>손익 %</th>
                    <th>손익 $</th>
                    <th>사유</th>
                    <th>시각</th>
                  </tr>
                </thead>
                <tbody>
                  {[...status.tradeLogs].reverse().map((t, i) => (
                    <tr key={i}>
                      <td>{t.symbol}</td>
                      <td>${t.entryPrice}</td>
                      <td>${t.exitPrice}</td>
                      <td className={t.pnlPct >= 0 ? "ok" : "danger"}>{t.pnlPct.toFixed(2)}%</td>
                      <td className={t.pnlUsd >= 0 ? "ok" : "danger"}>${t.pnlUsd.toFixed(2)}</td>
                      <td>{EXIT_LABEL[t.exitReason] ?? t.exitReason}</td>
                      <td className="mono small">{t.exitedAt?.slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* --- 실시간 로그 --- */}
          <section className="card wide">
            <h2>실시간 로그</h2>
            <div className="logbox">
              {logs.map((l, i) => (
                <div key={i} className="logline">
                  <span className="log-ts">{l.ts}</span> {l.msg}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </section>
        </main>
      )}

      {tab === "settings" && settings && (
        <main className="grid">
          <section className="card wide">
            <h2>설정</h2>
            <div className="settings-block">
              <h3>실행 모드</h3>
              <label className="radio">
                <input type="radio" checked={formMode === "mock"} onChange={() => setFormMode("mock")} />
                <b>연습 모드</b> — 앱 안의 가짜 토스 서버 사용. 실제 돈·계좌와 완전히 무관. 키 불필요.
              </label>
              <label className="radio">
                <input type="radio" checked={formMode === "live"} onChange={() => setFormMode("live")} />
                <b>실서버 모드</b> — 실제 토스 서버에서 시세·잔고를 읽음.{" "}
                <b>이 버전은 실주문이 잠겨 있어(드라이런 강제) 주문은 절대 나가지 않습니다.</b>
              </label>
            </div>

            <div className="settings-block">
              <h3>토스 API 키 {settings.hasClientId && settings.hasClientSecret ? "✅ 저장됨" : "❌ 미등록"}</h3>
              <p className="hint">
                키는 이 컴퓨터의 앱 데이터 폴더(.env, 본인만 읽기 가능)에만 저장되며, 화면·로그 어디에도
                다시 표시되지 않습니다. 변경할 때만 새로 입력하세요.
              </p>
              <div className="form-col">
                <label>
                  Client ID
                  <input
                    type="password"
                    value={formClientId}
                    onChange={(e) => setFormClientId(e.target.value)}
                    placeholder={settings.hasClientId ? "(저장됨 — 변경 시에만 입력)" : "토스 개발자센터에서 발급"}
                  />
                </label>
                <label>
                  Client Secret
                  <input
                    type="password"
                    value={formClientSecret}
                    onChange={(e) => setFormClientSecret(e.target.value)}
                    placeholder={settings.hasClientSecret ? "(저장됨 — 변경 시에만 입력)" : "토스 개발자센터에서 발급"}
                  />
                </label>
                <label>
                  계좌 번호(accountSeq)
                  <input value={formAccount} onChange={(e) => setFormAccount(e.target.value)} placeholder="예: 1" />
                </label>
                <label>
                  시장 확인 간격(초)
                  <input
                    type="number"
                    min="2"
                    value={formTick}
                    onChange={(e) => setFormTick(Math.max(2, Number(e.target.value)))}
                  />
                </label>
              </div>
            </div>

            <div className="form-row">
              <button className="btn btn-start" onClick={saveSettings}>
                설정 저장
              </button>
              {savedMsg && <span className="ok">{savedMsg}</span>}
            </div>

            <div className="settings-block">
              <h3>안전 안내</h3>
              <ul className="hint">
                <li>이 버전(v0.1)은 <b>실주문 기능이 코드 차원에서 잠겨</b> 있습니다. 설정으로도 풀 수 없습니다.</li>
                <li>이유: 토스 주문 API의 필수 항목(주문 유효기간 등) 확정이 아직 안 끝났습니다(진행 문서 참고).</li>
                <li>실주문 해금은 "스펙 확정 → 소액 검증" 후 별도 버전으로 배포됩니다.</li>
              </ul>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
