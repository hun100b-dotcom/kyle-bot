// =============================================================================
// src/Tutorial.tsx — [v0.91.0→실시간 안내 보강] 튜토리얼 모드: 단계별 마법사 + 상시 체크리스트 알약
// -----------------------------------------------------------------------------
// [왜] 메뉴가 많아 처음 쓰는 사람은 "무엇부터 어떻게 설정하는지" 모른다. 첫 로그인 직후 한 번 마법사가 열려
//   토스 키 → 연결 테스트 → 연습/실서버 → 디스코드 → 자동매매 설정 살펴보기 → 스크리닝 → 시작 순으로 안내한다.
//   · 꺼도(실수로 닫아도) 화면 왼쪽 아래 🎓 알약·헤더 [🎓 튜토리얼]·설정 탭 항목으로 언제든 다시 켠다.
//   · 단계 완료는 실제 상태에서 자동 판정(lib/tutorial.ts) — 사용자가 체크하지 않는다. 자동 판정 조건은
//     각 단계 본문에 "▫️/✅ ..." 한 줄로 항상 적어 둔다(오너 지적 — "체크가 안 되는데 뭘 해야 되는지 안 나와 있다").
//   · [실시간 안내 보강] "그 화면으로 이동해서 보기"를 누르면 예전엔 파란 테두리가 8초만 반짝이고 사라졌다 —
//     이제는 실제 화면에 작은 안내 칩이 계속 떠 있고(guiding 상태), 테두리도 ① 사용자가 그 요소를 클릭하거나
//     ② "확인했어요"를 누르거나 ③ 그 단계가 실제로 완료될 때까지 안 사라진다(길어도 2분 뒤엔 스스로 정리 —
//     electron/../src/App.tsx의 tutorialGoTo 참고). 신규 팀원이 "지금 뭘 봐야 하는지"를 화면에서 바로 알 수 있게.
//   · 애니메이션은 CSS(@keyframes)만 쓰고, "동작 줄이기" 설정이면 꺼진다(App.css 참고).
// [연결] 다른 곳에서 여는 법: window.dispatchEvent(new CustomEvent("capri-tutorial-open", { detail: { step? } }))
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTutorialPatch,
  computeProgress,
  parseTutorialStored,
  shouldAutoOpen,
  tutorialStorageKey,
  type TutorialSnapshot,
  type TutorialStepId,
  type TutorialStored,
} from "../lib/tutorial";

export const TUTORIAL_OPEN_EVENT = "capri-tutorial-open";
/** 어디서든 튜토리얼을 연다(헤더 버튼·설정 탭 항목 공용). */
export function openTutorial(step?: TutorialStepId): void {
  window.dispatchEvent(new CustomEvent(TUTORIAL_OPEN_EVENT, { detail: { step } }));
}

/** [실시간 안내 보강] "그 화면으로 이동해서 보기"로 켠 화면 강조(data-tt)를 꺼 달라는 신호.
 *  App.tsx의 tutorialGoTo가 이 이벤트를 듣고 테두리를 지운다(마법사를 다시 열거나 "확인했어요"를 누르면 보낸다). */
export const TUTORIAL_SPOT_CLEAR_EVENT = "capri-tutorial-spot-clear";

export interface TutorialProps {
  isDesktop: boolean;
  email: string | null;
  loggedIn: boolean;
  accountStatus: string;
  settings: { hasClientId: boolean; hasClientSecret: boolean; mode: string; liveOrdersEnabled: boolean } | null;
  autoStatus: { enabled: boolean; lastScan: unknown | null; maxPositions?: number; maxLossPct?: number; maxInvestPct?: number; watchMinutes?: number } | null;
  /** 해당 탭으로 이동하고 target(data-tt)을 강조한다 */
  goToTab: (tab: string, target?: string) => void;
  /** 마법사에서 설정을 저장했을 때 앱 상태를 새로 읽게 한다 */
  onSettingsChanged: () => void;
  /** (테스트·미리보기용) 처음부터 이 단계로 마법사를 열어 둔다 */
  defaultOpenStep?: TutorialStepId;
}

// ── 애니메이션 장면(SVG + CSS) ─────────────────────────────────────────────────────────────

function Scene({ id }: { id: TutorialStepId }) {
  switch (id) {
    case "welcome":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <g className="tt-pop" style={{ animationDelay: "0s" }}><rect x="30" y="28" width="76" height="64" rx="12" className="tt-box" /><text x="68" y="68" textAnchor="middle" className="tt-ic">🧪</text><text x="68" y="106" textAnchor="middle" className="tt-cap">연습 모드</text></g>
          <g className="tt-pop" style={{ animationDelay: ".25s" }}><rect x="122" y="28" width="76" height="64" rx="12" className="tt-box" /><text x="160" y="68" textAnchor="middle" className="tt-ic">🔒</text><text x="160" y="106" textAnchor="middle" className="tt-cap">실주문 잠금</text></g>
          <g className="tt-pop" style={{ animationDelay: ".5s" }}><rect x="214" y="28" width="76" height="64" rx="12" className="tt-box tt-box-red" /><text x="252" y="68" textAnchor="middle" className="tt-ic">🛑</text><text x="252" y="106" textAnchor="middle" className="tt-cap">비상 정지</text></g>
        </svg>
      );
    case "account":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <text x="40" y="66" className="tt-ic">📝</text><line x1="80" y1="60" x2="140" y2="60" className="tt-flow" /><text x="150" y="66" className="tt-ic">✅</text><line x1="190" y1="60" x2="250" y2="60" className="tt-flow" /><text x="258" y="66" className="tt-ic">🏠</text>
          <text x="40" y="100" className="tt-cap">가입</text><text x="150" y="100" className="tt-cap">운영자 승인</text><text x="252" y="100" className="tt-cap">로그인</text>
        </svg>
      );
    case "keysPrep":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          {["Client ID", "Secret", "계좌", "허용 IP"].map((t, i) => (
            <g key={t} className="tt-slide" style={{ animationDelay: `${i * 0.2}s` }}>
              <rect x={14 + i * 76} y="34" width="68" height="52" rx="10" className="tt-box" />
              <text x={48 + i * 76} y="66" textAnchor="middle" className="tt-ic">{["🆔", "🔑", "💳", "🌐"][i]}</text>
              <text x={48 + i * 76} y="102" textAnchor="middle" className="tt-cap">{t}</text>
            </g>
          ))}
        </svg>
      );
    case "keysInput":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <text x="50" y="70" className="tt-ic">💻</text><line x1="100" y1="62" x2="220" y2="62" className="tt-flow" /><circle r="5" className="tt-dot" cx="100" cy="62" /><text x="236" y="70" className="tt-ic">🏦</text>
          <text x="46" y="102" className="tt-cap">카프리</text><text x="228" y="102" className="tt-cap">토스증권</text>
        </svg>
      );
    case "mode":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <rect x="90" y="40" width="140" height="40" rx="20" className="tt-box" /><circle cx="110" cy="60" r="16" className="tt-knob" />
          <text x="60" y="66" textAnchor="end" className="tt-cap">연습</text><text x="262" y="66" className="tt-cap">실서버</text>
          <text x="160" y="104" textAnchor="middle" className="tt-cap">실주문은 따로 잠겨 있어요 🔒</text>
        </svg>
      );
    case "discord":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <text x="60" y="72" className="tt-ic tt-ring">🔔</text>
          <g className="tt-bubble"><rect x="130" y="30" width="150" height="34" rx="10" className="tt-box" /><text x="205" y="52" textAnchor="middle" className="tt-cap">🟢 관찰 확정 신호가 왔어요</text></g>
          <g className="tt-bubble" style={{ animationDelay: ".6s" }}><rect x="130" y="72" width="150" height="34" rx="10" className="tt-box" /><text x="205" y="94" textAnchor="middle" className="tt-cap">🛡️ 보호 가드 결과</text></g>
        </svg>
      );
    case "autoSettings":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <g key={i}><rect x="40" y={26 + i * 28} width="240" height="8" rx="4" className="tt-track" /><circle cy={30 + i * 28} r="9" className={`tt-slider tt-slider-${i}`} cx="80" /></g>
          ))}
        </svg>
      );
    case "screening":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <path d="M60 20 H260 L190 70 V104 H130 V70 Z" className="tt-box" />
          {[0, 1, 2, 3].map((i) => <circle key={i} r="4" cx={90 + i * 40} cy="10" className="tt-fall" style={{ animationDelay: `${i * 0.35}s` }} />)}
        </svg>
      );
    case "launch":
      return (
        <svg viewBox="0 0 320 120" className="tt-scene" aria-hidden="true">
          <circle cx="160" cy="58" r="30" className="tt-play" /><polygon points="150,44 150,72 176,58" className="tt-tri" />
          <text x="160" y="106" textAnchor="middle" className="tt-cap">자동매매 시작 → 결과는 현황·기록·리포트에서</text>
        </svg>
      );
  }
}

/** 단계별 진행 링(애니메이션) */
function Ring({ done, total }: { done: number; total: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const off = c * (1 - (total ? done / total : 0));
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" className="tt-ringsvg" aria-hidden="true">
      <circle cx="20" cy="20" r={r} className="tt-ring-bg" />
      <circle cx="20" cy="20" r={r} className="tt-ring-fg" strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 20 20)" />
      <text x="20" y="24" textAnchor="middle" className="tt-ring-t">{done}/{total}</text>
    </svg>
  );
}

// ── 본체 ────────────────────────────────────────────────────────────────────────────────────

export default function Tutorial(p: TutorialProps) {
  const storeKey = tutorialStorageKey(p.email);
  const [stored, setStored] = useState<TutorialStored>(() => {
    try { return parseTutorialStored(localStorage.getItem(storeKey)); } catch { return parseTutorialStored(null); }
  });
  const [open, setOpen] = useState(!!p.defaultOpenStep);
  const [listOpen, setListOpen] = useState(false);
  const [stepId, setStepId] = useState<TutorialStepId>(p.defaultOpenStep ?? "welcome");
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [discordSaved, setDiscordSaved] = useState(false);
  // [실시간 안내 보강] "그 화면으로 이동해서 보기"를 누른 뒤 — 실제 화면에 계속 떠 있는 작은 안내 칩.
  //   예전엔 파란 테두리가 8초 만에 사라져서, 처음 쓰는 사람이 "어디를 봐야 하는지" 놓치기 쉬웠다.
  const [guiding, setGuiding] = useState(false);
  const storedRef = useRef(stored);
  storedRef.current = stored;

  // 이메일(계정)이 바뀌면 그 계정의 저장 상태를 다시 읽는다.
  useEffect(() => {
    try { setStored(parseTutorialStored(localStorage.getItem(storeKey))); } catch { /* 무시 */ }
  }, [storeKey]);

  // [v0.95.0][버그 수정] setStored에 "직접 계산한 값"이 아니라 "이전 상태 → 다음 상태" 함수를 넘긴다.
  //   React는 같은 핸들러 안에서 setState가 여러 번 불려도 함수형 업데이트는 항상 직전 결과를 이어받게
  //   보장한다 — 예전처럼 둘 다 storedRef.current(리렌더 전이라 둘 다 옛 값)를 기준으로 계산하면,
  //   go()의 markVisited(방문 체크 추가) 직후 lastStep 갱신이 그 방문 체크를 덮어써 사라지는 버그가 있었다.
  const patchStored = useCallback((patch: Partial<TutorialStored> | ((prev: TutorialStored) => Partial<TutorialStored>)) => {
    setStored((prev) => {
      const next = applyTutorialPatch(prev, patch);
      try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* 저장소를 못 써도 이번 화면은 동작 */ }
      return next;
    });
  }, [storeKey]);

  const refreshDiscord = useCallback(() => {
    if (!p.isDesktop) return;
    void window.kyletool.getMyNotifySettings?.().then((r) => setDiscordSaved(!!r?.discordWebhookUrl)).catch(() => undefined);
  }, [p.isDesktop]);
  useEffect(() => {
    if (!p.loggedIn) return;
    refreshDiscord();
    const id = setInterval(refreshDiscord, 15_000);
    return () => clearInterval(id);
  }, [p.loggedIn, refreshDiscord]);

  const snapshot: TutorialSnapshot = useMemo(() => ({
    isDesktop: p.isDesktop,
    loggedIn: p.loggedIn,
    approved: p.accountStatus === "approved" || p.accountStatus === "unknown",
    hasKeys: !!(p.settings?.hasClientId && p.settings?.hasClientSecret),
    connectionOk: stored.connectionOk,
    mode: p.settings?.mode === "live" ? "live" : "mock",
    liveOrders: !!p.settings?.liveOrdersEnabled,
    discordSaved,
    visited: stored.visited,
    scanRan: p.autoStatus?.lastScan != null,
    autoEnabled: !!p.autoStatus?.enabled,
  }), [p.isDesktop, p.loggedIn, p.accountStatus, p.settings, p.autoStatus, stored, discordSaved]);
  const progress = useMemo(() => computeProgress(snapshot), [snapshot]);

  // 처음 쓰는 사람: 로그인·승인 직후 한 번 자동으로 연다(닫아도 다시 안 열림 — 알약·헤더 버튼으로는 언제든).
  useEffect(() => {
    if (open) return;
    if (shouldAutoOpen({ loggedIn: snapshot.loggedIn, approved: snapshot.approved, hasKeys: snapshot.hasKeys }, stored)) {
      patchStored({ autoOpened: true });
      setStepId(progress.nextId ?? "welcome");
      setOpen(true);
    }
  }, [snapshot.loggedIn, snapshot.approved, snapshot.hasKeys, stored, open, patchStored, progress.nextId]);

  // 외부(헤더 버튼·설정 탭)에서 열기
  useEffect(() => {
    const h = (e: Event) => {
      const step = (e as CustomEvent<{ step?: TutorialStepId }>).detail?.step;
      patchStored({ pillHidden: false });
      setStepId(step ?? storedRef.current.lastStep ?? progress.nextId ?? "welcome");
      setListOpen(false);
      setOpen(true);
    };
    window.addEventListener(TUTORIAL_OPEN_EVENT, h);
    return () => window.removeEventListener(TUTORIAL_OPEN_EVENT, h);
  }, [patchStored, progress.nextId]);

  const steps = progress.steps;
  const idx = Math.max(0, steps.findIndex((s) => s.id === stepId));
  const cur = steps[idx] ?? steps[0];
  const markVisited = (id: TutorialStepId) => {
    patchStored((prev) => (prev.visited.includes(id) ? {} : { visited: [...prev.visited, id], lastStep: id }));
  };
  const go = (to: number) => {
    const t = Math.min(steps.length - 1, Math.max(0, to));
    setDir(t >= idx ? "fwd" : "back");
    markVisited(cur.id);
    setStepId(steps[t].id);
    patchStored({ lastStep: steps[t].id });
  };
  const close = () => { patchStored({ lastStep: cur.id }); setOpen(false); };
  const goTab = () => {
    if (!cur.tab) return;
    markVisited(cur.id);
    patchStored({ lastStep: cur.id });
    setOpen(false); // 화면을 가리지 않게 접고, 알약의 "이어하기"로 돌아온다
    setGuiding(true); // 실제 화면에 안내 칩을 띄운다(아래 "실시간 안내 칩" 참고)
    p.goToTab(cur.tab, cur.target);
  };
  /** 안내 칩을 끄고, 실제 화면의 파란 테두리도 같이 끄라고 App.tsx에 알린다. */
  const dismissGuiding = useCallback(() => {
    setGuiding(false);
    window.dispatchEvent(new CustomEvent(TUTORIAL_SPOT_CLEAR_EVENT));
  }, []);
  // 마법사를 다시 열면(어느 경로로든) 안내 칩·화면 테두리는 더 필요 없다 — 마법사 자체가 그 역할을 한다.
  useEffect(() => { if (open) dismissGuiding(); }, [open, dismissGuiding]);
  // 안내 중이던 단계가 실제로 완료되면(예: 연결 테스트 성공, 자동매매 켜짐) 안내 칩이 할 일을 다 한 것 — 스스로 끈다.
  useEffect(() => {
    if (guiding && progress.done[cur.id]) dismissGuiding();
  }, [guiding, progress.done, cur.id, dismissGuiding]);

  // Esc로 닫기, ←/→ 이동
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "Escape") close();
      else if ((tag !== "INPUT" && tag !== "TEXTAREA") && e.key === "ArrowRight") go(idx + 1);
      else if ((tag !== "INPUT" && tag !== "TEXTAREA") && e.key === "ArrowLeft") go(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idx]);

  if (!p.loggedIn) return null;

  const pillLabel = progress.allDone ? "🎓 시작 가이드 완료" : open ? "" : `🎓 시작 가이드 ${progress.doneCount}/${progress.total}`;

  return (
    <>
      {/* ── 상시 알약 + 체크리스트 + 실시간 안내 칩 ── */}
      {!open && (guiding || !stored.pillHidden) && (
        <div className="tt-pill-wrap" data-tt-pill>
          {/* [실시간 안내 보강] "그 화면으로 이동해서 보기"를 누르면 여기 뜬다. 알약을 숨겨 둔 사람에게도 보인다 —
              지금 막 특정 화면을 보라고 안내하는 중이라 상시 알약과는 다르게 취급한다(사라지는 조건도 다름). */}
          {guiding && (
            <div className="tt-guide-chip" role="status" aria-live="polite">
              <div className="tt-list-head"><b>{cur.icon} {cur.title}</b><button className="mini ghost" onClick={dismissGuiding} aria-label="닫기">✕</button></div>
              <p className="hint small">화면에 파란 테두리로 표시된 곳을 확인하세요. 할 일을 마치면 이 칩은 저절로 사라져요.</p>
              <div className="tt-list-foot">
                <button className="mini ghost" onClick={dismissGuiding}>✓ 확인했어요</button>
                <button className="mini active" onClick={() => setOpen(true)}>🎓 가이드로 돌아가기</button>
              </div>
            </div>
          )}
          {listOpen && !stored.pillHidden && (
            <div className="tt-list" role="dialog" aria-label="시작 가이드 체크리스트">
              <div className="tt-list-head"><b>시작 가이드</b><button className="mini ghost" onClick={() => setListOpen(false)} aria-label="닫기">✕</button></div>
              <ul>
                {steps.map((s, i) => (
                  <li key={s.id} className={progress.done[s.id] ? "done" : s.id === progress.nextId ? "next" : ""}>
                    <button onClick={() => { setStepId(s.id); setListOpen(false); setOpen(true); }}>
                      <span className="tt-check">{progress.done[s.id] ? "✓" : i + 1}</span>
                      <span>{s.icon} {s.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="tt-list-foot">
                <button className="mini active" onClick={() => { setStepId(progress.nextId ?? "welcome"); setListOpen(false); setOpen(true); }}>{progress.allDone ? "다시 보기" : "이어서 하기 →"}</button>
                <button className="mini ghost" title="알약만 숨깁니다. 헤더의 🎓 튜토리얼 버튼으로 언제든 다시 열 수 있어요." onClick={() => { patchStored({ pillHidden: true }); setListOpen(false); }}>알약 숨기기</button>
              </div>
            </div>
          )}
          {!stored.pillHidden && (
            <button className={progress.allDone ? "tt-pill all" : "tt-pill"} onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen}>
              <Ring done={progress.doneCount} total={progress.total} />
              <span>{pillLabel}</span>
            </button>
          )}
        </div>
      )}

      {/* ── 마법사 ── */}
      {open && (
        <div className="tt-overlay" role="dialog" aria-modal="true" aria-label="카프리 시작 가이드">
          <div className="tt-card">
            <aside className="tt-rail">
              <div className="tt-rail-head"><Ring done={progress.doneCount} total={progress.total} /><b>시작 가이드</b></div>
              <ol>
                {steps.map((s, i) => (
                  <li key={s.id} className={(s.id === cur.id ? "cur " : "") + (progress.done[s.id] ? "done" : "")}>
                    <button onClick={() => { setDir(i >= idx ? "fwd" : "back"); setStepId(s.id); }}>
                      <span className="tt-check">{progress.done[s.id] ? "✓" : i + 1}</span>
                      <span className="tt-rail-t">{s.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </aside>
            <section className="tt-main">
              <header className="tt-top">
                <span className="tt-stepno">{idx + 1} / {steps.length}</span>
                <span className="tt-bar"><i style={{ width: `${((idx + 1) / steps.length) * 100}%` }} /></span>
                <button className="mini ghost" onClick={close} aria-label="닫기">✕ 닫기 <span className="hint small">(나중에 🎓에서 이어서)</span></button>
              </header>
              <div key={cur.id} className={`tt-body tt-${dir}`}>
                <Scene id={cur.id} />
                <h3>{cur.icon} {cur.title}</h3>
                {!p.isDesktop && cur.platform === "desktop" ? (
                  <p className="tt-note">이 단계는 <b>PC 앱</b>에서 진행합니다(토스 키·디스코드는 PC에 저장돼요). 폰에서는 건너뛰어도 괜찮아요 — 폰은 로그인만 하면 PC가 올린 상태·기록을 볼 수 있어요.</p>
                ) : (
                  <StepBody id={cur.id} p={p} progress={progress} discordSaved={discordSaved} onDiscordChanged={refreshDiscord} onConnectionOk={() => patchStored({ connectionOk: true })} />
                )}
                {cur.tab && (p.isDesktop || cur.platform === "both") && (
                  <p><button className="btn" onClick={goTab}>👉 그 화면으로 이동해서 보기</button> <span className="hint small">(이동하면 가이드는 접히고, 왼쪽 아래 🎓에서 이어서 할 수 있어요)</span></p>
                )}
              </div>
              <footer className="tt-foot">
                <button className="mini" disabled={idx === 0} onClick={() => go(idx - 1)}>← 이전</button>
                <span className={progress.done[cur.id] ? "tt-state ok" : "tt-state"}>{progress.done[cur.id] ? "✓ 이 단계 완료" : "아직 완료 전"}</span>
                {idx < steps.length - 1
                  ? <button className="mini active" onClick={() => go(idx + 1)}>다음 →</button>
                  : <button className="mini active" onClick={() => { markVisited(cur.id); close(); }}>마치기 ✓</button>}
              </footer>
              {progress.allDone && <div className="tt-confetti" aria-hidden="true">{Array.from({ length: 18 }).map((_, i) => <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 6) * 0.12}s` }} />)}</div>}
            </section>
          </div>
        </div>
      )}
    </>
  );
}

// ── 단계 본문 ───────────────────────────────────────────────────────────────────────────────

function StepBody({ id, p, progress, discordSaved, onDiscordChanged, onConnectionOk }: {
  id: TutorialStepId; p: TutorialProps; progress: ReturnType<typeof computeProgress>; discordSaved: boolean; onDiscordChanged: () => void; onConnectionOk: () => void;
}) {
  const hasKeys = !!(p.settings?.hasClientId && p.settings?.hasClientSecret);
  switch (id) {
    case "welcome":
      return (
        <div className="tt-text">
          <p>카프리는 <b>토스증권 미국주식 계좌</b>와 연결해서, 정해 둔 규칙대로 <b>후보를 찾고(스크리닝) 주문까지 내 주는</b> 도구예요. 처음 쓰는 분을 위해 순서대로 안내할게요.</p>
          <ul className="tt-safe">
            <li><b>① 처음엔 연습 모드</b> — 앱 안의 <u>가짜 서버</u>로 돌아서 실제 돈과 무관해요. 마음껏 눌러 보세요.</li>
            <li><b>② 실서버 모드여도 실주문은 잠금</b> — 진짜 돈으로 주문이 나가려면 <u>별도 스위치</u>를 직접 켜야 해요(기본 꺼짐).</li>
            <li><b>③ 언제든 🛑 비상 정지</b> — 화면 위쪽 버튼. 신규 주문을 잠그고 미체결·조건주문을 취소해요.</li>
          </ul>
          <p className="hint">총 {progress.total}단계 · 10분 안팎. 중간에 닫아도 <b>왼쪽 아래 🎓</b>에서 이어서 할 수 있어요.</p>
          <p className="tt-status">{progress.done.welcome ? "✅ 확인했어요." : "▫️ 이 단계는 읽기만 하면 돼요 — 아래 [다음 →] 버튼을 누르면 완료로 표시돼요."}</p>
        </div>
      );
    case "account":
      return (
        <div className="tt-text">
          <p>카프리는 <b>로그인한 계정</b> 안에서 토스 키·매매 기록이 동기화돼요(다른 사람과 섞이지 않아요).</p>
          <ol><li>가입 → 2. <b>운영자 승인</b>(승인 전엔 "승인 대기" 화면) → 3. 로그인</li></ol>
          <p className="tt-status">{progress.done.account ? <>✅ 지금 <b>{p.email ?? "계정"}</b>으로 로그인돼 있고 승인도 확인됐어요.</> : <>⏳ 승인이 아직 확인되지 않았어요. 운영자에게 승인을 요청해 주세요.</>}</p>
        </div>
      );
    case "keysPrep":
      return (
        <div className="tt-text">
          <p>토스증권 <b>Open API(개발자센터)</b>에서 키를 발급받아요. 아래 4가지가 필요해요.</p>
          <ul className="tt-keys">
            <li><b>🆔 Client ID</b> — 앱 아이디</li>
            <li><b>🔑 Client Secret</b> — 비밀키(남에게 알려 주면 안 돼요)</li>
            <li><b>💳 계좌 번호</b> — 보통 <b>1</b>번, 계좌가 여러 개면 순서 번호</li>
            <li><b>🌐 허용 IP</b> — 토스 키에는 <u>'허용된 IP'</u> 설정이 있어서, <b>이 PC의 인터넷 주소(공인 IP)</b>가 등록돼 있어야 해요. 안 돼 있으면 "허용하지 않습니다" 오류가 나요(다음 단계의 연결 테스트가 알려 줘요).</li>
          </ul>
          <p className="hint">개발자센터 화면 구성은 토스 쪽에서 바뀔 수 있어요. 막히면 토스 안내를 따라 주세요. 내 공인 IP는 인터넷 검색창에 "내 IP"라고 검색하면 보여요.</p>
          <p className="tt-status">{progress.done.keysPrep ? "✅ 완료." : "▫️ 이 단계는 읽기만 하면 돼요 — 아래 [다음 →] 버튼을 누르거나(또는 다음 단계에서 키를 저장하면) 완료로 표시돼요."}</p>
        </div>
      );
    case "keysInput":
      return <KeysForm p={p} hasKeys={hasKeys} onConnectionOk={onConnectionOk} />;
    case "mode":
      return (
        <div className="tt-text">
          <p>지금 상태: <b>{p.settings?.mode === "live" ? "🟢 실서버 모드" : "🧪 연습 모드"}</b> · 실주문 <b>{p.settings?.liveOrdersEnabled ? "🔴 켜짐" : "🔒 꺼짐(안전)"}</b></p>
          <ul>
            <li><b>연습 모드</b> — 가짜 서버. 돈과 무관. 처음엔 여기서 눌러 보며 익히세요.</li>
            <li><b>실서버 모드</b> — 실제 시세·잔고를 보지만, <u>실주문은 별도로 잠겨 있어요</u>.</li>
            <li><b>실주문 켜기</b> — [설정 → 토스 연결]의 <u>"진짜 돈으로 주문 나가게 허용"</u>. 켤 때 한 번 더 확인해요. <b>충분히 연습한 뒤, 소액으로 먼저</b> 해 보세요.</li>
          </ul>
          <p className="hint">⚠️ 이 가이드는 <b>실주문을 대신 켜 주지 않아요</b> — 위치만 알려 드려요.</p>
          <p className="tt-status">{progress.done.mode ? "✅ 확인했어요." : "▫️ 이 단계는 읽기만 하면 돼요 — 아래 [다음 →] 버튼을 누르면 완료로 표시돼요."}</p>
        </div>
      );
    case "discord":
      return <DiscordForm saved={discordSaved} onChanged={onDiscordChanged} />;
    case "autoSettings": {
      const a = p.autoStatus;
      return (
        <div className="tt-text">
          <p>자동매매는 5분마다 후보를 찾아 <b>1분할 매수 → 체결되면 익절·손절을 자동 등록</b>해요. 정하는 값들이에요(<u>정해진 정답은 없고, 카프리가 숫자를 권하지 않아요</u>).</p>
          <ul>
            <li><b>최대 종목 수</b> — 동시에 들고 갈 종목 개수{a?.maxPositions != null && <> · 지금 <b>{a.maxPositions}</b></>}</li>
            <li><b>최대손실 한도</b>(시드 대비 %) — 이 손실에 닿으면 새 진입을 멈춰요{a?.maxLossPct != null && <> · 지금 <b>{a.maxLossPct}%</b></>}</li>
            <li><b>종목당 투입 비율</b>(시드 대비 %){a?.maxInvestPct != null && <> · 지금 <b>{a.maxInvestPct}%</b></>}</li>
            <li><b>미체결 자동취소</b>(분) — 안 사지면 이 시간 뒤 취소{a?.watchMinutes != null && <> · 지금 <b>{a.watchMinutes}분</b></>}</li>
            <li><b>진입 타점</b> — 1분할(얕은 눌림) · 1.5분할 · 2분할(더 깊이 눌렸을 때)</li>
            <li><b>익절·손절 %</b> — <u>[설정 → 주문 기본값]</u>에서 정해요(자동매매가 이 값을 써요)</li>
          </ul>
          <p className="tt-status">{progress.done.autoSettings ? "✅ 확인했어요." : "▫️ 이 단계는 읽기만 하면 돼요 — 아래 [다음 →] 버튼을 누르면 완료로 표시돼요."}</p>
        </div>
      );
    }
    case "screening":
      return (
        <div className="tt-text">
          <p><b>스크리닝</b>은 거래량 상위 종목 중 <b>정해 둔 모양</b>(도지 → 음봉 확인 등)이 나온 종목을 골라내는 일이에요.</p>
          <ul>
            <li><b>🧪 스크리닝 기준</b> 탭 — 어떤 모양을 후보로 칠지 조건을 정해요.</li>
            <li><b>자동 스크리너</b> 탭 — 5분마다 도는 결과와 <b>[🔄 지금 새로고침]</b>(바로 한 번 스캔)이 있어요. 후보마다 근거와 계획 타점이 보여요.</li>
          </ul>
          <p className="tt-status">{progress.done.screening ? "✅ 스캔이 한 번 이상 실행됐어요." : "▫️ 아직 스캔 결과가 없어요 — 자동매매를 켜거나 [지금 새로고침]을 눌러 보세요."}</p>
        </div>
      );
    case "launch":
      return (
        <div className="tt-text">
          <p><b>🤖 자동매매 현황</b> 탭의 <b>[시작]</b> 버튼으로 켜요(켜져 있는 동안만 돌고, 앱을 다시 켜면 다시 눌러야 해요 — 업데이트로 인한 자동 재시작은 예외로 알아서 이어져요).</p>
          <ul>
            <li><b>현황</b> — 지금 감시 중인 종목 · <b>자동매매기록</b> — 지나간 매매 · <b>리포트</b> — 성적 요약 · <b>🔬 매매연구소</b> — 신호를 기록하고 전략을 비교</li>
            <li><b>📱 폰</b> — 폰 브라우저에서 웹앱 주소(<code>hun100b-dotcom.github.io/capri-web</code>)로 같은 계정 로그인 → 상태 보기·원격 조종. (PC 앱이 켜져 있어야 명령이 실행돼요 — 위쪽 "🟢 PC 연결됨" 배지)</li>
            <li><b>업데이트</b>는 자동이에요. 새 버전이 나오면 알아서 받아 설치·재시작해요.</li>
          </ul>
          <p className="tt-status">{p.autoStatus?.enabled ? "✅ 자동매매가 켜져 있어요. 수고하셨어요!" : "▫️ 준비가 끝났다면 자동매매 현황 탭에서 시작해 보세요."}</p>
        </div>
      );
  }
}

// ── 키 입력 + 연결 테스트 ─────────────────────────────────────────────────────────────────────

function KeysForm({ p, hasKeys, onConnectionOk }: { p: TutorialProps; hasKeys: boolean; onConnectionOk: () => void }) {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [account, setAccount] = useState("1");
  // [버그 수정] 예전엔 두 갈래가 다 "live"라 저장된 모드가 "연습"이어도 이 칸은 항상 "실서버"로 시작했다
  //   — 그대로 [저장]을 누르면 모르는 새 연습 모드가 실서버로 바뀔 수 있어 위험했다. 지금 저장된 값을 그대로 따른다.
  const [mode, setMode] = useState<"mock" | "live">(p.settings?.mode === "live" ? "live" : "mock");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; action?: string; steps: Array<{ name: string; ok: boolean }> } | null>(null);

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      await window.kyletool.saveSettings({ mode, clientId: id || undefined, clientSecret: secret || undefined, account });
      setId("");
      setSecret("");
      setMsg("✅ 저장했어요. 이제 [연결 테스트]를 눌러 보세요.");
      p.onSettingsChanged();
    } catch (e) {
      setMsg("⚠️ 저장에 실패했어요: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const r = await window.kyletool.testTossConnection();
      setResult(r);
      if (r.ok) onConnectionOk();
    } catch (e) {
      setResult({ ok: false, message: "테스트 중 오류가 났어요.", action: e instanceof Error ? e.message : String(e), steps: [] });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tt-text">
      <p>발급받은 값을 넣고 저장해요. 키는 <b>이 컴퓨터 안에만</b> 저장되고, 저장하면 <b>화면에 다시 보이지 않아요</b>(보안).</p>
      <div className="tt-form">
        <label>Client ID<input type="password" value={id} onChange={(e) => setId(e.target.value)} placeholder={p.settings?.hasClientId ? "(저장됨 — 바꿀 때만 입력)" : ""} autoComplete="off" /></label>
        <label>Client Secret<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={p.settings?.hasClientSecret ? "(저장됨 — 바꿀 때만 입력)" : ""} autoComplete="off" /></label>
        <label>계좌 번호 <span className="hint">(보통 1)</span><input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="1" /></label>
        <div className="tt-radios">
          <label className="radio">
            <input type="radio" checked={mode === "live"} onChange={() => setMode("live")} />
            <span className="tt-radio-text"><b>실서버 모드</b><small className="hint">연결 테스트에 필요 · 실주문은 따로 잠겨 있어요</small></span>
          </label>
          <label className="radio">
            <input type="radio" checked={mode === "mock"} onChange={() => setMode("mock")} />
            <span className="tt-radio-text"><b>연습 모드</b><small className="hint">키 없이 가짜 서버</small></span>
          </label>
        </div>
      </div>
      <p className="tt-actions">
        <button className="btn btn-start" disabled={busy} onClick={() => void save()}>저장</button>
        <button className="btn" disabled={busy || !hasKeys} onClick={() => void test()}>🔌 연결 테스트</button>
        {busy && <span className="hint">처리 중…</span>}
      </p>
      {msg && <p className={msg.startsWith("✅") ? "ok" : "err"}>{msg}</p>}
      <p className="tt-status">
        {hasKeys ? "✅ 키가 저장돼 있어요." : "▫️ 아직 키가 저장되지 않았어요."}
        {" "}이 단계는 위 <b>[🔌 연결 테스트]</b>를 여기서 직접 눌러 <b>성공</b>해야 완료로 표시돼요 — 설정 탭에서 이미 테스트해 본 적이 있어도, 체크 표시를 위해서는 여기서 한 번 더 눌러야 해요.
      </p>
      {result && (
        <div className={result.ok ? "tt-result ok" : "tt-result bad"} role="status">
          <ul className="tt-steps">
            {["키 인증", "시세 조회", "계좌 조회"].map((n, i) => {
              const s = result.steps[i];
              return <li key={n} className={s ? (s.ok ? "ok" : "bad") : "wait"} style={{ animationDelay: `${i * 0.18}s` }}>{s ? (s.ok ? "✓" : "✕") : "·"} {n}</li>;
            })}
          </ul>
          <b>{result.message}</b>
          {result.action && <p className="hint">👉 {result.action}</p>}
        </div>
      )}
    </div>
  );
}

// ── 디스코드 ──────────────────────────────────────────────────────────────────────────────────

function DiscordForm({ saved, onChanged }: { saved: boolean; onChanged: () => void }) {
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await window.kyletool.saveMyNotifySettings(url);
      setMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) { setUrl(""); onChanged(); }
    } catch (e) {
      setMsg("⚠️ " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const r = await window.kyletool.sendMyDiscordTest();
      setMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
    } catch (e) {
      setMsg("⚠️ " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tt-text">
      <p>스크리닝 <b>관찰·확정 신호</b>와 <b>보호 가드 결과</b>를 <b>내 디스코드</b>로 받아요(선택 사항 — 건너뛰어도 돼요).</p>
      <ol className="tt-howto">
        <li>디스코드에서 알림 받을 <b>채널</b>의 ⚙️(채널 편집)을 열어요.</li>
        <li><b>연동 → 웹후크 → 새 웹후크</b>를 만들어요.</li>
        <li><b>웹후크 URL 복사</b>를 눌러 아래 칸에 붙여넣고 저장해요.</li>
      </ol>
      <div className="tt-form">
        <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={saved ? "(저장됨 — 바꿀 때만 입력)" : "https://discord.com/api/webhooks/…"} autoComplete="off" />
      </div>
      <p className="tt-actions">
        <button className="btn btn-start" disabled={busy || !url.trim()} onClick={() => void save()}>저장</button>
        <button className="btn" disabled={busy || !saved} onClick={() => void test()}>🔔 테스트 메시지 보내기</button>
        <span className={saved ? "ok" : "hint"}>{saved ? "✅ 등록됨" : "▫️ 아직 등록 안 됨"}</span>
      </p>
      {msg && <p className={msg.startsWith("✅") ? "ok" : "err"}>{msg}</p>}
    </div>
  );
}
