// =============================================================================
// src/PaperBots.tsx — [v0.103.0] 🧪 가상매매 봇 탭 (매매연구소 그룹)
// -----------------------------------------------------------------------------
// [오너 요청 2026-10-19]
//   1. 이 탭 안에서 봇을 원하는 만큼 "행 추가"하듯 추가한다.
//   2. 봇마다 시작 시드·자동매매 기준·스크리닝 기준·익절%·손절%를 정하고 시작/중지 버튼이 있다.
//      설정은 서랍(접고 펴기)으로 열고 닫는다.
//   3. 각 봇의 현황(수익률·승률 등)을 그 행에서 바로 본다.
//   4. 대시보드로 어떤 봇이 가장 수익률이 높은지, 어떤 설정값(손절·익절)이 최고의 선택인지 본다.
//
// [중요] 이 화면 어디에도 실제 주문 버튼은 없다. 봇은 토스에 주문을 절대 내지 않고,
//   실제 시세(1분봉)만 보고 "그때 샀다면/팔았다면"을 계산한다(규칙: lib/paper-bots.ts 맨 위 주석).
// [PC vs 폰]
//   · 봇을 "실제로 돌리는"(5분마다 스크리닝·체결 판정) 건 켜져 있는 PC(데스크톱 앱)뿐이다.
//   · 폰은 같은 클라우드 데이터를 받아 보여 주고, 봇 추가·설정·시작/중지를 할 수 있다(PC가 이어받아 돌림).
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { defaultBotConfig, exitLabel, sanitizeConfig, PAPER_DROP_LABEL, type PaperDropKey, type PaperBotConfig, type PaperGroupRow, type PaperSlMode } from "../lib/paper-bots";

type View = PaperBotsView;
type BotRow = View["bots"][number];

const kst = (ms: number | null | undefined, fmt = "MM-dd HH:mm") => (ms == null ? "—" : DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat(fmt));
const usd = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const sgn = (v: number | null | undefined, d = 2, suffix = "%") => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${suffix}`);
const pct = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}%`);
const cls = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "pnl-up" : v < 0 ? "pnl-down" : "");

/** 손절 비교 세트 기본값 — 오너가 가장 고민하는 구간(얕은 손절 ~ 지금 기본값 근처)을 고르게. */
const SL_SET_DEFAULT = "3, 5, 7, 10";

/** [v0.104.0] 청산 방식 비교 세트에 쓰는 3가지 방식과 짧은 이름(봇 이름 꼬리표). */
const EXIT_MODES: Array<{ mode: PaperSlMode; tag: string }> = [
  { mode: "fixed", tag: "손절%만" },
  { mode: "ema", tag: "손절%+EMA" },
  { mode: "emaOnly", tag: "EMA이탈만" },
];

/**
 * 기준 설정에서 청산 방식만 바꾼 봇 설정을 만든다(나머지는 전부 같음 → 청산 방식만 공정하게 비교).
 * 이름 뒤 꼬리표(" · 손절%만" 등)는 기존 꼬리표를 지우고 새로 붙여 이름이 길어지지 않게 한다.
 */
function withExitMode(base: PaperBotConfig, mode: PaperSlMode, tag: string): PaperBotConfig {
  const stem = base.name.replace(/\s*·\s*(손절%만|손절%\+EMA|EMA이탈만)$/, "");
  return { ...base, name: `${stem} · ${tag}`.slice(0, 30), trade: { ...base.trade, slMode: mode } };
}

export default function PaperBotsTab({ isWebApp, active, baseSettings }: { isWebApp: boolean; active: boolean; baseSettings: ToolSettings | null }) {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [openSettings, setOpenSettings] = useState<Record<string, boolean>>({}); // 봇별 설정 서랍 열림 여부
  const [openTrades, setOpenTrades] = useState<Record<string, boolean>>({}); //   봇별 매매 내역 서랍 열림 여부
  const [slSet, setSlSet] = useState(SL_SET_DEFAULT);
  const api = window.kyletool;
  const supported = typeof api.paperList === "function";

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 6000);
  };

  // 화면이 열려 있는 동안: 처음 + 주기적으로 클라우드와 맞춘다(폰 15초, PC 30초 — PC는 1분마다 스스로도 맞춤).
  //   그 사이 PC 화면은 엔진 메모리를 5초마다 바로 읽어(네트워크 없음) 진행 상황이 끊김 없이 보이게 한다.
  const refresh = useCallback(async (withSync: boolean) => {
    if (!supported) return;
    try {
      const v = withSync ? await api.paperRefresh!() : await api.paperList!();
      setView(v);
    } catch (e) {
      flash(`⚠️ 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [api, supported]);

  useEffect(() => {
    if (!active || !supported) return;
    void refresh(true);
    const sync = setInterval(() => void refresh(true), isWebApp ? 15_000 : 30_000);
    const local = isWebApp ? null : setInterval(() => void refresh(false), 5_000);
    return () => {
      clearInterval(sync);
      if (local) clearInterval(local);
    };
  }, [active, supported, isWebApp, refresh]);

  /** 버튼 공통 — 실행 중 중복 클릭 막기 + 결과 반영 + 실패 안내. */
  const act = async (label: string, fn: () => Promise<View>) => {
    setBusy(true);
    try {
      setView(await fn());
      flash(`✅ ${label}`);
    } catch (e) {
      flash(`⚠️ ${label} 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 새 봇의 기본 설정 = "지금 내 자동매매 설정 그대로"(폰은 PC가 올려 둔 설정을 쓴다). */
  const baseConfig = useCallback(
    (name?: string) => defaultBotConfig(baseSettings as unknown as Record<string, unknown>, Date.now(), name ?? `가상봇 ${(view?.bots.length ?? 0) + 1}`),
    [baseSettings, view?.bots.length],
  );

  if (!supported) {
    return (
      <main className="grid">
        <section className="card wide">
          <h2>🧪 가상매매 봇</h2>
          <p className="hint">이 기능은 새 버전에서 쓸 수 있습니다. 앱을 최신 버전으로 업데이트해 주세요.</p>
        </section>
      </main>
    );
  }

  const bots = view?.bots ?? [];
  const runningCount = bots.filter((b) => b.config.running).length;

  return (
    <main className="grid">
      <section className="card wide">
        <h2>🧪 가상매매 봇 <span className="hint">(주문 없음 · 실제 시세로 모의 체결 · 설정별 성적 비교)</span></h2>
        <details className="explain">
          <summary>❓ 어떻게 동작하나요?</summary>
          <ul className="hint pb-ul">
            <li><b>봇 = 설정 한 묶음</b>입니다(시드·익절%·손절%·자동매매 기준·스크리닝 기준). 설정만 다르게 여러 개 만들어 동시에 돌리면, 같은 시장에서 어떤 설정이 더 벌었는지 <b>데이터로</b> 비교됩니다.</li>
            <li>켜 두면 <b>5분마다</b> 실제 자동매매와 <b>똑같은 규칙</b>으로 스크리닝 → "확정" 종목에 삼분할 타점으로 <b>가상 지정가 매수</b> → 이후 1분봉으로 익절/손절을 판정합니다. 토스에 주문은 <b>절대</b> 나가지 않습니다.</li>
            <li>체결 판정은 일부러 <b>보수적</b>입니다: 가격이 주문가를 "뚫고" 지나가야 체결, 같은 1분봉에서 익절·손절이 다 가능하면 <b>손절 먼저</b>, 수수료 차감. 그래서 실제보다 좋게 나오는 착시가 적습니다.</li>
            <li>봇을 실제로 돌리는 건 <b>켜져 있는 PC(데스크톱 앱)</b>입니다. 폰에서도 추가·설정·시작/중지가 되고, PC가 이어받아 돌립니다. 결과는 PC·폰 어디서나 똑같이 보입니다.</li>
            <li>중지하면 새 매수는 멈추고, 이미 가상으로 산 종목은 <b>익절/손절이 날 때까지</b> 계속 지켜봐 결과가 허공에 뜨지 않게 합니다.</li>
          </ul>
        </details>

        <div className="lab-status">
          <span className={`lab-pill ${runningCount ? "on" : "off"}`}>{runningCount ? `🟢 실행 중 ${runningCount}개` : "⚪ 실행 중인 봇 없음"}</span>
          {view?.busy && <span className="lab-pill busy">⏳ 진행 중</span>}
          {view?.canRun ? (
            <span className="hint">
              이 PC가 봇을 돌립니다 · 마지막 실행 {kst(view.lastTickMs, "MM-dd HH:mm:ss")}
              {view.nextTickMs ? ` · 다음 실행 약 ${kst(view.nextTickMs, "HH:mm")}` : ""}
            </span>
          ) : (
            <span className="hint">📱 폰에서는 보기·설정만 됩니다 — 봇 실행은 켜져 있는 PC(데스크톱 앱)가 맡습니다.</span>
          )}
          <span className="hint">
            ☁️ {view?.syncError ? <span className="err">동기화 문제: {view.syncError}</span> : `동기화 ${kst(view?.lastSyncMs ?? null, "HH:mm:ss")}`}
          </span>
          {view?.lastError && <span className="err">⚠️ {view.lastError}</span>}
        </div>

        <div className="form-row">
          <button className="btn btn-start" disabled={busy} onClick={() => void act("봇을 추가했습니다", () => api.paperAdd!(baseConfig()))}>＋ 봇 추가</button>
          <label>
            손절 비교 세트(손절 %, 쉼표로)
            <input value={slSet} onChange={(e) => setSlSet(e.target.value)} style={{ width: 150 }} />
          </label>
          <button
            className="mini"
            disabled={busy}
            title="손절%만 다르고 나머지는 '지금 내 자동매매 설정'과 같은 봇을 한 번에 여러 개 만듭니다. 만든 뒤 각 행에서 시작을 누르세요."
            onClick={() => {
              const list = slSet.split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
              if (!list.length) return flash("⚠️ 손절 % 값을 쉼표로 적어 주세요(예: 3, 5, 7, 10).");
              void act(`손절 ${list.join("·")}% 비교 봇 ${list.length}개를 만들었습니다`, async () => {
                let v: View | null = null;
                for (const sl of list) v = await api.paperAdd!({ ...baseConfig(`손절비교 · 손절 ${sl}%`), slPct: sl });
                return v!;
              });
            }}
          >
            ⚖️ 손절 비교 세트 만들기
          </button>
          <button
            className="mini"
            disabled={busy}
            title="청산 방식만 다른 봇 3개(손절 %만 / 손절 % + 200EMA 이탈 / 200EMA 이탈만)를 '지금 내 자동매매 설정' 기준으로 한 번에 만듭니다."
            onClick={() =>
              void act("청산 방식 비교 봇 3개를 만들었습니다", async () => {
                let v: View | null = null;
                for (const x of EXIT_MODES) v = await api.paperAdd!(withExitMode(baseConfig("청산비교"), x.mode, x.tag));
                return v!;
              })
            }
          >
            🚪 청산 방식 비교 세트 만들기
          </button>
          {view?.canRun && (
            <button className="mini" disabled={busy || view.busy} onClick={() => void act("지금 한 번 실행했습니다", () => api.paperRunNow!())} title="5분을 기다리지 않고 지금 바로 스크리닝·체결 판정을 한 번 돌립니다.">
              ▶ 지금 한 번 실행
            </button>
          )}
          <button className="mini" disabled={busy} onClick={() => void refresh(true)}>🔄 새로고침</button>
        </div>
        {msg && <p className="hint">{msg}</p>}
      </section>

      <section className="card wide">
        <h2>🤖 봇 목록 <span className="hint">(행마다 결과 · ⚙️ 설정 서랍 · 시작/중지)</span></h2>
        {bots.length === 0 && <p className="hint">아직 봇이 없습니다. 위의 [＋ 봇 추가] 또는 [⚖️ 손절 비교 세트 만들기]로 시작하세요.</p>}
        <div className="pb-list">
          {bots.map((b) => (
            <BotRowView
              key={b.id}
              b={b}
              busy={busy}
              settingsOpen={!!openSettings[b.id]}
              tradesOpen={!!openTrades[b.id]}
              onToggleSettings={() => setOpenSettings((o) => ({ ...o, [b.id]: !o[b.id] }))}
              onToggleTrades={() => setOpenTrades((o) => ({ ...o, [b.id]: !o[b.id] }))}
              act={act}
            />
          ))}
        </div>
      </section>

      <Dashboard view={view} />
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 봇 한 행
// ─────────────────────────────────────────────────────────────────────────────

function BotRowView({ b, busy, settingsOpen, tradesOpen, onToggleSettings, onToggleTrades, act }: {
  b: BotRow;
  busy: boolean;
  settingsOpen: boolean;
  tradesOpen: boolean;
  onToggleSettings: () => void;
  onToggleTrades: () => void;
  act: (label: string, fn: () => Promise<View>) => Promise<void>;
}) {
  const api = window.kyletool;
  const c = b.config;
  const s = b.stats;
  const holding = b.sim.open.length + b.sim.pending.length;
  const status = c.running
    ? c.runnerDeviceId == null ? { t: "🟡 PC 대기", k: "busy", tip: "폰에서 켰습니다 — 켜져 있는 PC가 곧 가져가 돌립니다." }
    : { t: b.runnerIsMe ? "🟢 실행 중(이 PC)" : "🟢 실행 중", k: "on", tip: "" }
    : holding ? { t: "🟠 정리 중", k: "busy", tip: "중지했지만 이미 산 종목의 익절/손절을 끝까지 지켜보는 중입니다." }
    : { t: "⚪ 중지", k: "off", tip: "" };

  return (
    <div className={`pb-row ${c.running ? "pb-on" : ""}`}>
      <div className="pb-head">
        <div className="pb-name">
          <b>{c.name}</b>
          <span className={`lab-pill ${status.k}`} title={status.tip}>{status.t}</span>
        </div>
        <div className="pb-actions">
          {c.running ? (
            <button className="btn btn-stop" disabled={busy} onClick={() => void act(`${c.name} 중지`, () => api.paperStop!(b.id))}>■ 중지</button>
          ) : (
            <button className="btn btn-start" disabled={busy} onClick={() => void act(`${c.name} 시작`, () => api.paperStart!(b.id))}>▶ 시작</button>
          )}
          <button className={`mini ${settingsOpen ? "twocol-on" : ""}`} onClick={onToggleSettings}>⚙️ 설정 {settingsOpen ? "▲" : "▼"}</button>
          <button className={`mini ${tradesOpen ? "twocol-on" : ""}`} onClick={onToggleTrades}>📋 매매 내역 {tradesOpen ? "▲" : "▼"}</button>
        </div>
      </div>

      <div className="pb-sub hint">
        시드 {usd(c.seedUsd, 0)} · 익절 {c.tpPct}% · {exitLabel(c.trade, c.slPct)} · {c.trade.entryLevel}분할 타점 · 최대 {c.trade.maxPositions}종목 · 종목당 {c.trade.investPct}%
      </div>

      {/* [v0.106.0 오너 요청] 관찰·확정·진입 건수를 실시간으로 — 봇 기준 스크리닝에서 몇 건이 나왔는지 바로 보이게. */}
      <div className="pb-metrics">
        <Metric label="🟡 관찰" value={`${b.sim.funnel?.watch ?? 0}건`} sub={`스캔 ${b.sim.funnel?.scans ?? 0}회`} />
        <Metric label="🔴 확정" value={`${b.sim.funnel?.confirmed ?? 0}건`} />
        <Metric label="🛒 진입(가상 매수)" value={`${b.sim.agg.orders}건`} sub={`체결 ${Math.max(0, b.sim.agg.orders - b.sim.agg.unfilled - s.pendingCount)}건`} />
      </div>
      <ScanSummaryView b={b} />
      <div className="pb-metrics">
        <Metric label="수익률(실현)" value={sgn(s.returnPct)} tone={s.returnPct} />
        <Metric label="실현 손익" value={usd(s.realizedUsd)} tone={s.realizedUsd} />
        <Metric label="평가금" value={usd(s.equityUsd)} />
        <Metric label="매매 수" value={`${s.n}건`} sub={`이익 ${s.wins} · 손실 ${s.losses}`} />
        <Metric label="승률" value={pct(s.winRate)} />
        <Metric label="1건 평균" value={sgn(s.avgPnlPct)} tone={s.avgPnlPct} />
        <Metric label="손익비(PF)" value={s.profitFactor == null ? "—" : s.profitFactor.toFixed(2)} sub="총이익÷총손실" />
        <Metric label="최대 낙폭" value={s.maxDdPct ? `-${s.maxDdPct.toFixed(2)}%` : "0%"} />
        <Metric label="보유 · 대기" value={`${s.openCount} · ${s.pendingCount}`} sub={s.openCount ? `평가 ${usd(s.unrealizedUsd)}` : undefined} />
        <Metric label="체결률" value={pct(s.fillRate)} sub={`미체결 취소 ${b.sim.agg.unfilled}건`} />
      </div>
      {b.sim.lastNote && <div className="hint pb-note">🗒 {kst(b.sim.lastTickMs)} — {b.sim.lastNote}</div>}

      {settingsOpen && <SettingsDrawer b={b} busy={busy} act={act} onClose={onToggleSettings} />}
      {tradesOpen && <TradesDrawer b={b} />}
    </div>
  );
}

/**
 * [v0.106.0] 마지막 스캔 요약 — 봇 기준으로 몇 종목을 훑었고, 어느 단계에서 몇 개가 떨어졌는지,
 *   같은 무렵 자동매매가 확정한 종목이 이 봇 기준에선 왜 안 잡혔는지를 보여 준다.
 *   ("0건이 정말 조건에 맞는 종목이 없어서인지" 오너가 직접 확인할 수 있게.)
 */
function ScanSummaryView({ b }: { b: BotRow }) {
  const ls = b.sim.lastScan;
  if (!ls) return <div className="hint pb-note">🔎 아직 이 봇 기준으로 본 스캔이 없습니다(봇을 켜 두면 5분마다 스캔합니다).</div>;
  const drops = (Object.entries(ls.drops) as Array<[PaperDropKey, number]>).filter(([, n]) => n > 0).sort((a, z) => z[1] - a[1]);
  return (
    <div className="hint pb-note">
      🔎 마지막 스캔 {ls.scannedAt}: 훑은 {ls.total ?? "—"}종목 → 관찰 {ls.watch.length}{ls.watch.length ? `(${ls.watch.join(", ")})` : ""} · 확정 {ls.confirmed.length}
      {ls.confirmed.length ? `(${ls.confirmed.join(", ")})` : ""}
      {drops.length > 0 && <> · 탈락: {drops.map(([k, n]) => `${PAPER_DROP_LABEL[k]} ${n}`).join(" · ")}</>}
      {ls.autoMissed.length > 0 && (
        <div>⚖️ 같은 무렵 자동매매 확정 → 이 봇 기준에선: {ls.autoMissed.map((m) => `${m.symbol}(${m.reason})`).join(" · ")}</div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number | null }) {
  return (
    <div className="pb-metric">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls(tone)}`}>{value}</span>
      {sub && <span className="pb-msub">{sub}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 설정 서랍 — 숫자 입력은 "글자" 그대로 들고 있다가 저장할 때만 숫자로 바꾼다
//   (입력 중 "0." 같은 미완성 값이 강제로 바뀌는 문제 방지 — App.tsx v0.2.6과 같은 이유).
// ─────────────────────────────────────────────────────────────────────────────

type Draft = Record<string, string | boolean>;

function toDraft(c: PaperBotConfig): Draft {
  const d: Draft = { name: c.name, seedUsd: String(c.seedUsd), tpPct: String(c.tpPct), slPct: String(c.slPct), followAutoScreen: c.followAutoScreen };
  for (const [k, v] of Object.entries(c.trade)) {
    if (k === "sessions") continue;
    d[`t.${k}`] = typeof v === "boolean" ? v : String(v);
  }
  for (const [k, v] of Object.entries(c.trade.sessions)) d[`ss.${k}`] = v;
  for (const [k, v] of Object.entries(c.screen)) d[`s.${k}`] = typeof v === "boolean" ? v : String(v);
  return d;
}

function fromDraft(d: Draft, base: PaperBotConfig): PaperBotConfig {
  const n = (k: string) => {
    const x = Number(d[k]);
    return Number.isFinite(x) ? x : undefined;
  };
  const trade: Record<string, unknown> = { ...base.trade };
  const screen: Record<string, unknown> = { ...base.screen };
  for (const k of Object.keys(base.trade)) {
    if (k === "sessions") continue;
    const v = d[`t.${k}`];
    trade[k] = typeof v === "boolean" ? v : k === "slMode" ? v : n(`t.${k}`);
  }
  trade.sessions = { day: !!d["ss.day"], pre: !!d["ss.pre"], regular: !!d["ss.regular"], after: !!d["ss.after"] };
  for (const k of Object.keys(base.screen)) {
    const v = d[`s.${k}`];
    screen[k] = typeof v === "boolean" ? v : n(`s.${k}`);
  }
  return sanitizeConfig({ ...base, name: String(d.name), followAutoScreen: !!d.followAutoScreen, seedUsd: n("seedUsd"), tpPct: n("tpPct"), slPct: n("slPct"), trade: trade as unknown as PaperBotConfig["trade"], screen: screen as unknown as PaperBotConfig["screen"] });
}

function SettingsDrawer({ b, busy, act, onClose }: { b: BotRow; busy: boolean; act: (label: string, fn: () => Promise<View>) => Promise<void>; onClose: () => void }) {
  const api = window.kyletool;
  const [d, setD] = useState<Draft>(() => toDraft(b.config));
  const [confirm, setConfirm] = useState<"" | "reset" | "delete">("");
  // 다른 기기에서 설정이 바뀌어 들어오면(버전이 달라지면) 서랍 내용도 새로 채운다.
  useEffect(() => setD(toDraft(b.config)), [b.config.updatedAtMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (k: string, label: string, hint?: string, w = 110) => (
    <label title={hint}>
      {label}
      <input inputMode="decimal" value={String(d[k] ?? "")} onChange={(e) => setD({ ...d, [k]: e.target.value })} style={{ width: w }} />
    </label>
  );
  const chk = (k: string, label: string, hint?: string) => (
    <label className="radio" title={hint}>
      <input type="checkbox" checked={!!d[k]} onChange={(e) => setD({ ...d, [k]: e.target.checked })} style={{ width: "auto" }} />
      {label}
    </label>
  );
  const preview = useMemo(() => fromDraft(d, b.config), [d, b.config]);

  return (
    <div className="pb-drawer">
      <h4>기본</h4>
      <div className="form-row">
        <label>
          봇 이름
          <input value={String(d.name)} onChange={(e) => setD({ ...d, name: e.target.value })} style={{ width: 180 }} />
        </label>
        {num("seedUsd", "시작 시드($)", "가상 계좌의 시작 금액입니다. 바꾸면 수익률 계산 기준도 바뀌니, 깨끗한 비교를 원하면 저장 후 [결과 초기화]를 누르세요.")}
        {num("tpPct", "익절 %")}
        {num("slPct", "손절 %", "손절 방식이 'EMA 기준'이면 이 %는 '최소한 이보다 깊게는 안 간다'는 바닥선으로 쓰입니다.")}
      </div>

      <h4>자동매매 기준</h4>
      <div className="form-row">
        <label>
          진입 타점
          <select value={String(d["t.entryLevel"])} onChange={(e) => setD({ ...d, "t.entryLevel": e.target.value })}>
            <option value="1">1분할(얕은 눌림)</option>
            <option value="1.5">1.5분할</option>
            <option value="2">2분할(깊은 눌림)</option>
          </select>
        </label>
        {num("t.maxPositions", "최대 종목 수", "동시에 들고 있거나 매수 대기 중인 종목 수 한도")}
        {num("t.investPct", "종목당 투입 %", "현재 가상 평가금 대비, 종목 1개에 넣는 비율")}
        {num("t.watchMinutes", "미체결 취소(분)", "지정가가 이 시간 안에 안 닿으면 가상 주문을 취소")}
        <label>
          손절 방식
          {/* [v0.104.0] 청산 방식 3가지 — 손절 %만 / 손절 %와 200EMA 이탈 함께 / 200EMA 이탈만.
              "EMA 이탈" 손절가 = 진입 시점 5분봉 200EMA × (1 − 여유%) — 자동매매의 "EMA 기준 손절"과 같은 정의. */}
          <select
            value={String(d["t.slMode"])}
            onChange={(e) => setD({ ...d, "t.slMode": e.target.value })}
            title="손절 %만: 진입가 −N%에서 손절 · 둘 다: 손절 %와 200EMA 이탈 중 먼저 닿는 쪽 · 200EMA 이탈만: 손절 %는 무시하고 200EMA 아래 여유%에서 손절"
          >
            <option value="fixed">손절 %만</option>
            <option value="ema">손절 % + 200EMA 이탈(먼저 닿는 쪽)</option>
            <option value="emaOnly">200EMA 이탈만</option>
          </select>
        </label>
        {d["t.slMode"] !== "fixed" && num("t.emaStopBufferPct", "200EMA 아래 여유 %", "200EMA보다 이만큼 더 내려가야 이탈로 봅니다(자동매매 기본 1.5%)")}
      </div>
      <div className="form-row">
        {chk("t.reentryBlock", "오늘 손절된 종목 재진입 금지")}
        <span className="hint">매매할 장:</span>
        {chk("ss.day", "데이")}
        {chk("ss.pre", "프리")}
        {chk("ss.regular", "본장")}
        {chk("ss.after", "애프터")}
      </div>

      <h4>스크리닝 기준</h4>
      {/* [v0.106.0 오너 정정] 봇은 항상 아래 "봇 자기 기준"으로 스크리닝한다(자동매매 기준 따라가기 칸은 뺌). */}
      <div className="form-row">
        {num("s.count", "거래량 상위 몇 종목", undefined, 90)}
        {num("s.priceMin", "가격 하한($)", undefined, 90)}
        {num("s.priceMax", "가격 상한($)", undefined, 90)}
        {num("s.bodyRatio", "도지 몸통 상한(0.1~0.8)", undefined, 90)}
        {num("s.dojiWickMinRatio", "도지 꼬리 최소(0~0.4)", undefined, 90)}
        {num("s.emaPeriod", "EMA 기간", undefined, 90)}
      </div>
      <div className="form-row">
        {chk("s.emaTrendEnabled", "현재가 > EMA")}
        {chk("s.cloudEnabled", "현재가 > 구름 상단")}
        {chk("s.nextCandleConfirmEnabled", "도지 다음 봉 음봉 확인")}
        {chk("s.excludeEtf", "ETF 제외")}
      </div>
      <div className="form-row">
        {chk("s.dojiMaxAgeEnabled", "도지 신선도")}
        {d["s.dojiMaxAgeEnabled"] && num("s.dojiMaxAgeMinutes", "신선도(분)", undefined, 80)}
        {chk("s.dojiMaxGapEnabled", "고점→도지 간격")}
        {d["s.dojiMaxGapEnabled"] && num("s.dojiMaxGapMinutes", "간격(분)", undefined, 80)}
      </div>
      <div className="form-row">
        {chk("s.emaMinGapEnabled", "EMA 최소 이격도")}
        {d["s.emaMinGapEnabled"] && num("s.emaMinGapPct", "이격도 %", undefined, 80)}
        {chk("s.emaSlopeEnabled", "EMA 상승 중")}
        {chk("s.atrFilterEnabled", "변동성 상한")}
        {d["s.atrFilterEnabled"] && num("s.atrMaxPct", "변동성 상한 %", undefined, 80)}
      </div>

      <p className="hint">
        저장될 값: 익절 {preview.tpPct}% · 손절 {preview.slPct}% · 시드 {usd(preview.seedUsd, 0)} · 가격 ${preview.screen.priceMin}~${preview.screen.priceMax}
        {" "}(범위를 벗어난 값은 안전한 범위로 자동 보정됩니다)
      </p>
      <div className="form-row">
        <button className="btn btn-start" disabled={busy} onClick={() => void act(`${preview.name} 설정 저장`, () => api.paperUpdate!(b.id, preview))}>💾 설정 저장</button>
        <button className="mini" disabled={busy} onClick={() => setD(toDraft(b.config))}>되돌리기</button>
        <button className="mini" disabled={busy} onClick={() => void act(`${b.config.name} 복제`, () => api.paperDuplicate!(b.id))}>📄 복제</button>
        <button
          className="mini"
          disabled={busy}
          title="이 봇 설정을 기준으로, 손절%만 다른 봇을 여러 개 만듭니다(3·5·7·10%)."
          onClick={() => void act("손절 비교 세트(이 봇 기준)", () => api.paperAddSlSet!(b.id, [3, 5, 7, 10].filter((x) => x !== b.config.slPct)))}
        >
          ⚖️ 이 봇 기준 손절 비교 세트
        </button>
        <button
          className="mini"
          disabled={busy}
          title="이 봇 설정을 기준으로, 청산 방식만 다른 봇을 만듭니다(이 봇에 없는 나머지 방식들)."
          onClick={() =>
            void act("청산 방식 비교 세트(이 봇 기준)", async () => {
              let v: View | null = null;
              for (const x of EXIT_MODES.filter((m) => m.mode !== b.config.trade.slMode)) v = await api.paperAdd!(withExitMode(b.config, x.mode, x.tag));
              return v!;
            })
          }
        >
          🚪 이 봇 기준 청산 방식 비교
        </button>
        {confirm === "" && <button className="mini" disabled={busy} onClick={() => setConfirm("reset")}>🧹 결과 초기화</button>}
        {confirm === "" && <button className="mini btn-kill" disabled={busy} onClick={() => setConfirm("delete")}>🗑 삭제</button>}
        {confirm === "reset" && (
          <>
            <span className="hint">이 봇의 매매 결과를 모두 지우고 처음부터 다시 쌓을까요?</span>
            <button className="mini btn-kill" onClick={() => { setConfirm(""); void act(`${b.config.name} 결과 초기화`, () => api.paperReset!(b.id)); }}>네, 초기화</button>
            <button className="mini" onClick={() => setConfirm("")}>취소</button>
          </>
        )}
        {confirm === "delete" && (
          <>
            <span className="hint">이 봇과 결과를 모든 기기에서 삭제할까요? (되돌릴 수 없음)</span>
            <button className="mini btn-kill" onClick={() => { setConfirm(""); onClose(); void act(`${b.config.name} 삭제`, () => api.paperDelete!(b.id)); }}>네, 삭제</button>
            <button className="mini" onClick={() => setConfirm("")}>취소</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 매매 내역 서랍 — 보유·대기 + 최근 끝난 매매(최신 위)
// ─────────────────────────────────────────────────────────────────────────────

function TradesDrawer({ b }: { b: BotRow }) {
  const trades = [...b.sim.trades].reverse().slice(0, 50);
  return (
    <div className="pb-drawer">
      {(b.sim.open.length > 0 || b.sim.pending.length > 0) && (
        <>
          <h4>보유 · 매수 대기</h4>
          <div className="lab-scroll">
            <table className="result-table lab-table">
              <thead><tr><th>종목</th><th>상태</th><th>매수가</th><th>현재(1분봉)</th><th>익절</th><th>손절</th><th>수량</th><th>시각</th></tr></thead>
              <tbody>
                {b.sim.open.map((p) => (
                  <tr key={p.id}>
                    <td>{p.symbol}</td><td>보유</td><td>${p.fillPrice}</td>
                    <td className={cls(p.lastPrice != null ? p.lastPrice - p.fillPrice : null)}>{p.lastPrice != null ? `$${p.lastPrice}` : "—"}</td>
                    <td>${p.tp}</td><td>${p.sl}</td><td>{p.qty}</td><td>{kst(p.filledAtMs)} 체결</td>
                  </tr>
                ))}
                {b.sim.pending.map((o) => (
                  <tr key={o.id} className="lab-dim">
                    <td>{o.symbol}</td><td>매수 대기</td><td>${o.entry}(지정가)</td><td>—</td><td>${o.tp}</td><td>${o.sl}</td><td>{o.qty}</td><td>{kst(o.expiresAtMs, "HH:mm")}까지</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>끝난 매매 <span className="hint">(최근 50건 · 성적 숫자는 전체 기간 기준)</span></h4>
      {trades.length === 0 ? (
        <p className="hint">아직 끝난 가상 매매가 없습니다.</p>
      ) : (
        <div className="lab-scroll">
          <table className="result-table lab-table">
            <thead><tr><th>종목</th><th>결과</th><th>매수가</th><th>청산가</th><th>수량</th><th>순손익</th><th>%</th><th>매수</th><th>청산</th></tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={`${t.id}:${t.exitedAtMs}`}>
                  <td>{t.symbol}</td>
                  <td>{t.result === "tp" ? "✅ 익절" : "🛑 손절"}</td>
                  <td>${t.fillPrice}</td>
                  <td>${t.exitPrice}</td>
                  <td>{t.qty}</td>
                  <td className={cls(t.pnlUsd)}>{usd(t.pnlUsd)}</td>
                  <td className={cls(t.pnlPct)}>{sgn(t.pnlPct)}</td>
                  <td>{kst(t.filledAtMs)}</td>
                  <td>{kst(t.exitedAtMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 대시보드 — 어떤 봇이 가장 잘 벌었나, 어떤 손절·익절 값이 최선인가
// ─────────────────────────────────────────────────────────────────────────────

function Dashboard({ view }: { view: View | null }) {
  const d = view?.dashboard;
  if (!d || d.ranking.length === 0) return null;
  const maxAbs = Math.max(1, ...d.ranking.map((r) => Math.abs(r.returnPct)));
  return (
    <section className="card wide">
      <h2>📊 대시보드 <span className="hint">(봇 순위 · 설정값별 비교)</span></h2>
      <div className="lab-cards">
        <div className="lab-card"><span>🔎 전체 봇 합계</span><b>관찰 {d.funnel.watch} · 확정 {d.funnel.confirmed} · 진입 {d.funnel.entries}</b><span>스캔 {d.funnel.scans}회(봇별 합)</span></div>
        <div className="lab-card"><span>🏆 수익률 1위 봇</span><b className="pb-best">{d.best.bot ?? "아직 판단 불가"}</b><span>매매 {d.minTrades}건 이상 쌓인 봇 중</span></div>
        <div className="lab-card"><span>🛑 최고 손절값</span><b>{d.best.sl != null ? `${d.best.sl}%` : "아직 판단 불가"}</b><span>같은 손절값 봇들의 평균 수익률 기준</span></div>
        <div className="lab-card"><span>✅ 최고 익절값</span><b>{d.best.tp != null ? `${d.best.tp}%` : "아직 판단 불가"}</b><span>같은 익절값 봇들의 평균 수익률 기준</span></div>
        <div className="lab-card"><span>🚪 최고 청산 방식</span><b className="pb-best">{d.best.exit ?? "아직 판단 불가"}</b><span>손절 % / 200EMA 이탈 방식별 평균 수익률 기준</span></div>
        <div className="lab-card"><span>🎯 최고 조합</span><b className="pb-best">{d.best.combo ?? "아직 판단 불가"}</b><span>익절×청산 조합별 평균 수익률 기준</span></div>
      </div>
      <p className="hint">
        "아직 판단 불가" = 비교할 값이 2개 이상이고 각각 매매가 충분히 쌓여야 고릅니다.{" "}
        ⚠️ 매매가 <b>{d.minTrades}건</b> 이상 쌓이기 전에는 "최고"라고 부르지 않습니다 — 몇 번의 운으로 결론을 내리면 실제 매매에서 반대로 나올 수 있어요.
        정확한 비교를 하려면 <b>같은 시각에 시작</b>하고, 손절%처럼 <b>한 가지만 다르게</b> 두세요([⚖️ 손절 비교 세트]가 그렇게 만들어 줍니다).
      </p>

      <h3>봇 순위 (실현 수익률)</h3>
      <div className="pb-rank">
        {d.ranking.map((r, i) => (
          <div key={r.id} className={`pb-rank-row ${r.enough ? "" : "lab-dim"}`}>
            <span className="pb-rank-no">{i + 1}</span>
            <span className="pb-rank-name" title={`익절 ${r.tpPct}% · ${r.exit}`}>
              {r.name}{r.running ? " 🟢" : ""}
              <span className="pb-msub"> 익절 {r.tpPct}% · {r.exit} · {r.trades}건 · 승률 {pct(r.winRate)}{r.enough ? "" : " · 표본 부족"}</span>
            </span>
            <span className="pb-bar"><i className={r.returnPct >= 0 ? "up" : "down"} style={{ width: `${(Math.abs(r.returnPct) / maxAbs) * 100}%` }} /></span>
            <span className={`pb-rank-v ${cls(r.returnPct)}`}>{sgn(r.returnPct)}</span>
          </div>
        ))}
      </div>

      <GroupTable title="청산 방식별 비교 (손절 % / 200EMA 이탈)" rows={d.byExit} bestLabel={d.best.exit} />
      {d.bySl.length > 0 && <GroupTable title="손절값별 비교 (200EMA 이탈만 쓰는 봇은 제외)" rows={d.bySl} best={d.best.sl} />}
      <GroupTable title="익절값별 비교" rows={d.byTp} best={d.best.tp} />
      {d.byCombo.length > 1 && <GroupTable title="익절 × 청산 조합별 비교" rows={d.byCombo} bestLabel={d.best.combo} />}
    </section>
  );
}

function GroupTable({ title, rows, best, bestLabel }: { title: string; rows: PaperGroupRow[]; best?: number | null; bestLabel?: string | null }) {
  return (
    <>
      <h3>{title}</h3>
      <div className="lab-scroll">
        <table className="result-table lab-table">
          <thead><tr><th>설정값</th><th>봇 수</th><th>매매 수</th><th>승률</th><th>1건 평균</th><th>평균 수익률</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const isBest = (best != null && r.value === best) || (bestLabel != null && r.label === bestLabel);
              return (
                <tr key={r.label} className={isBest ? "lab-sel" : r.enough ? "" : "lab-dim"}>
                  <td>{r.label}</td>
                  <td>{r.bots}</td>
                  <td>{r.trades}</td>
                  <td>{pct(r.winRate)}</td>
                  <td className={cls(r.avgPnlPct)}>{sgn(r.avgPnlPct)}</td>
                  <td className={cls(r.avgReturnPct)}><b>{sgn(r.avgReturnPct)}</b></td>
                  <td>{isBest ? "🏆 최고" : r.enough ? "" : "표본 부족"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
