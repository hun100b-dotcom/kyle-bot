// =============================================================================
// src/LabResult.tsx — [v0.66.0] 🏁 결과 요약: 매매연구소의 모든 데이터를 한 장으로 + 데이터 검증
// -----------------------------------------------------------------------------
// [오너 요청] "모든 데이터들의 결과를 이해하기 쉽고 가시성 있게 정리한 결과창" + "실제 데이터가 맞는지 검증"
// =============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import type { LabApi } from "./useLab";
import type { DimVerdict, Verdict, Confidence, Assessment, Gate } from "../lib/lab-verdict";
type LabFunnel = LabSummary["funnel"];
import { GuideButton, GuideModal, useGuide } from "./LabGuide";

const kst = (ms: number | null | undefined, fmt = "MM-dd HH:mm") => (ms == null ? "—" : DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat(fmt));
const num = (v: number | null | undefined, d = 2, suffix = "") => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${suffix}`);
const sgn = (v: number | null | undefined, d = 2, suffix = "%") => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${suffix}`);
const cls = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "pnl-up" : v < 0 ? "pnl-down" : "");

const CONF_KO: Record<Confidence, string> = { clear: "뚜렷", close: "비슷", thin: "자료 부족" };

/** 숫자가 바뀔 때 부드럽게 올라가는(세어 올라가는) 표시. 동작 줄이기 설정이면 즉시 표시. */
function CountUp({ value, decimals = 0, suffix = "", signed = false }: { value: number | null; decimals?: number; suffix?: string; signed?: boolean }) {
  const [shown, setShown] = useState<number | null>(value);
  const from = useRef<number>(value ?? 0);
  useEffect(() => {
    if (value == null) { setShown(null); return; }
    let reduce = false;
    try { reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { /* 무시 */ }
    if (reduce) { setShown(value); from.current = value; return; }
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      const e = 1 - Math.pow(1 - p, 3);
      const v = start + (value - start) * e;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  if (shown == null) return <>—</>;
  const v = shown;
  return <>{signed && v > 0 ? "+" : ""}{v.toFixed(decimals)}{suffix}</>;
}

/** 0을 가운데 둔 좌우 막대(오른쪽=이득, 왼쪽=손해). 마운트 후 길이가 늘어나는 애니메이션. */
function DivBar({ value, max }: { value: number | null; max: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  const w = value == null || max <= 0 ? 0 : Math.min(50, (Math.abs(value) / max) * 50);
  return (
    <span className="rs-bar" aria-hidden>
      <i className="rs-axis" />
      {value != null && (
        <i className={`rs-fill ${value >= 0 ? "pos" : "neg"}`} style={{ width: on ? `${w}%` : "0%", [value >= 0 ? "left" : "right"]: "50%" }} />
      )}
    </span>
  );
}

function DimBlock({ title, hint, v }: { title: string; hint: string; v: DimVerdict }) {
  const max = Math.max(0.3, ...v.rows.map((r) => Math.abs(r.expectancy ?? 0)));
  return (
    <div className="rs-dim">
      <div className="rs-dim-head">
        <b>{title}</b>
        <span className={`rs-conf ${v.confidence}`}>{CONF_KO[v.confidence]}</span>
      </div>
      <p className="hint small">{hint}</p>
      {v.rows.map((r) => {
        const win = v.winner?.key === r.key;
        return (
          <div key={r.key} className={`rs-row ${win ? "win" : ""}`}>
            <span className="rs-label">{win ? "👑 " : ""}{r.label}</span>
            <DivBar value={r.expectancy} max={max} />
            <b className={`rs-val ${cls(r.expectancy)}`}>{sgn(r.expectancy)}</b>
            <span className="rs-sub">체결률 {num(r.fillRate, 0, "%")} · 승률 {num(r.winRate, 0, "%")} · 체결 {r.filled}건</span>
          </div>
        );
      })}
      <p className="rs-note">{v.note}</p>
    </div>
  );
}

/** 수집 현황 띠 — "지금 업데이트되고 있는 건가?"에 바로 답한다(휴무 시간대엔 왜 안 늘어나는지, 속도는 어떤지). */
function CollectBar({ st, a, funnel }: { st: LabStatus; a: Assessment | null; funnel: LabFunnel }) {
  const c = st.collect;
  const pace = a?.pace;
  let head: string;
  let tone: "ok" | "pause" | "off";
  if (!st.enabled) { head = "⚪ 신호 기록이 꺼져 있습니다 — [신호기록 현황]에서 켜세요."; tone = "off"; }
  else if (c.paused) { head = `⏸ 지금은 수집 휴무 시간입니다 — ${c.pauseReason ?? "휴무"}. ${c.resumesAtMs ? `${kst(c.resumesAtMs, "MM-dd HH:mm")}에 자동으로 다시 시작합니다.` : ""} 이 시간엔 신호가 늘지 않는 게 정상입니다.`; tone = "pause"; }
  else { head = `🟢 수집 중 — 마지막 스캔 ${st.lastTickAtMs ? kst(st.lastTickAtMs, "HH:mm:ss") : "—"}${st.lastTickDurMs != null ? ` (${Math.round(st.lastTickDurMs / 1000)}초, ${st.lastScanned}종목)` : ""}${st.nextTickAtMs ? ` · 다음 스캔 약 ${kst(st.nextTickAtMs, "HH:mm")}` : ""}`; tone = "ok"; }
  const rate = funnel.dojis > 0 ? ((funnel.eligible / funnel.dojis) * 100).toFixed(2) : null;
  return (
    <div className={`rs-collect ${tone}`} data-guide="result-collect">
      <b>{head}</b>
      <span>
        지금까지 스캔 {c.scans}회 · 수집 활성 시간 {c.activeHours}시간
        {st.lastSkip && !c.paused ? ` · ⏸ ${st.lastSkip}` : ""}
        {rate != null && <> · 이 패턴은 원래 드뭅니다: 도지 {funnel.dojis.toLocaleString()}번 중 인정 신호 {funnel.eligible}번({rate}%)</>}
      </span>
      {pace && pace.formedSinceStart > 0 && (
        <span>
          기록 시작 뒤에 형성된 신호 {pace.formedSinceStart}건 중 <b>실시간 포착 {pace.caughtRealtime}건</b>, 나머지 {pace.lateDiscovered}건은 그 시점엔 거래량 순위권 밖이었다가 나중에 올라온 종목이라 "늦게 발견(백필)"로 분류했습니다(이런 종목은 실제 봇이 그때 볼 수 없었으므로 결론에서 제외).
        </span>
      )}
      {pace && (
        <span>
          실시간 인정 신호 <b>{a?.counts.realtimeEligible ?? 0}</b> / 목표 {pace.target}건 ·{" "}
          {pace.perHour != null ? <>현재 속도 활성 1시간당 <b>{pace.perHour}</b>건 → 목표까지 {pace.etaDays != null ? <>약 <b>{pace.etaDays >= 1 ? `${Math.round(pace.etaDays)}일` : "1일 미만"}</b> (하루 활성 12시간 기준)</> : "계산 불가(아직 0건)"}</> : "활성 1시간 이상 쌓이면 속도를 계산합니다"}
          {pace.etaDays != null && pace.etaDays > 14 && " · 💡 [신호기록 현황]에서 거래량 순위를 120~200위로 늘리면 속도가 2~3배로 빨라집니다(이제 스캔당 요청이 종목당 1회라 부담이 작아요)."}
        </span>
      )}
    </div>
  );
}

/** 자동 검증 상태 띠 — 스캔마다 재계산, 1시간마다 토스 대조. 실패하면 붉게. */
function VerifyBar({ s }: { s: LabStatus["verify"] }) {
  const bad = s.localOk === false || (s.tossRequested > 0 && s.tossMatched / s.tossRequested < 0.8);
  const never = s.localAt == null;
  return (
    <div className={`rs-vbar ${never ? "none" : bad ? "bad" : "ok"}`} data-guide="result-autover">
      <b>{never ? "⏳ 자동 검증 대기 중" : bad ? "🚨 데이터 검증 경고" : "✅ 자동 검증 정상"}</b>
      <span>
        {never
          ? "다음 스캔이 끝나면 저장된 로우를 자동으로 재계산합니다(이후 스캔마다, 토스 대조는 1시간마다)."
          : `로우 재계산 ${kst(s.localAt, "HH:mm:ss")} ${s.localOk ? "통과" : `실패 — ${s.localFailed.join(", ")}`}${s.tossAt ? ` · 토스 대조 ${kst(s.tossAt, "HH:mm")} ${s.tossMatched}/${s.tossRequested} 일치` : " · 토스 대조 아직 없음"}`}
      </span>
    </div>
  );
}

/** 허점 점검 5종 */
function Flaws({ a }: { a: Assessment }) {
  const ci = a.ci;
  const ho = a.holdout;
  const st = a.stress;
  const c = a.concentration;
  const lat = a.latency;
  const icon = (ok: boolean | null) => (ok === true ? "✅" : ok === false ? "⚠️" : "❔");
  const span = ci ? Math.max(Math.abs(ci.lo), Math.abs(ci.hi), 0.3) * 1.2 : 1;
  const pos = (v: number) => `${50 + (v / span) * 50}%`;
  return (
    <>
      <h3>🧪 허점 점검 <span className="hint">(1위 숫자를 그대로 믿지 않기 위한 5가지 검사)</span></h3>
      <div className="rs-checks">
        <div className="rs-check">
          <b>{icon(ci ? ci.lo > 0 : false)} ① 우연일 가능성 (신뢰구간)</b>
          {ci ? (
            <>
              <div className="rs-ci"><i className="rs-ci-zero" /><u style={{ left: pos(ci.lo), width: `calc(${pos(ci.hi)} - ${pos(ci.lo)})` }} className={ci.lo > 0 ? "pos" : "mix"} /><s style={{ left: pos(ci.mean) }} /></div>
              <p>1위 조합의 신호당 기대값 <b>{sgn(ci.mean)}</b>, 95% 범위 <b>{sgn(ci.lo)} ~ {sgn(ci.hi)}</b>. {ci.lo > 0 ? "범위 전체가 플러스라 우연일 가능성이 낮습니다." : "범위가 0을 걸치므로 우연일 수 있습니다."}</p>
            </>
          ) : <p>표본이 5건 미만이라 계산할 수 없습니다.</p>}
        </div>
        <div className="rs-check">
          <b>{icon(ho?.holds ?? null)} ② 처음 보는 데이터에서도? (시간 분할 검증)</b>
          {ho && ho.key ? (
            <p>앞쪽 60%({ho.trainN}건)로 고른 조합 <b>{ho.key}</b>이 뒤쪽 40%({ho.testN}건)에서 <b>{sgn(ho.trainExp)} → {sgn(ho.testExp)}</b>. {ho.holds == null ? "검증 구간 체결이 적어 판단 불가." : ho.holds ? "처음 보는 구간에서도 플러스." : "처음 보는 구간에서는 플러스가 아님 — 과거에만 맞았을 수 있습니다."}</p>
          ) : <p>신호가 10건 미만이라 나눌 수 없습니다.</p>}
        </div>
        <div className="rs-check">
          <b>{icon(st?.expectancy != null ? st.expectancy > 0 : null)} ③ 현실 비용을 더하면? (스트레스)</b>
          <p>1분봉으로는 알 수 없는 호가 차이·슬리피지를 체결 건마다 <b>{st?.pct ?? 0}%</b> 더 낸다고 가정하면 기대값은 <b className={cls(st?.expectancy)}>{sgn(st?.expectancy)}</b>.</p>
        </div>
        <div className="rs-check">
          <b>{icon(c.symbols >= 15 && (c.topShare ?? 1) <= 0.2 && c.days >= 10)} ④ 한쪽에 쏠리지 않았나? (집중도)</b>
          <p>인정 신호 {c.eligible}건이 <b>{c.symbols}종목 · {c.days}거래일</b>에 걸쳐 있고, 최다 종목 <b>{c.topSymbol ?? "—"}</b>이 {c.topShare != null ? Math.round(c.topShare * 100) : "—"}%. 같은 종목·같은 날의 신호는 서로 닮아서 실제 표본 수는 건수보다 적습니다.</p>
        </div>
        <div className="rs-check">
          <b>{icon(lat.n >= 10 && lat.medianMin != null ? lat.assumedMin >= lat.medianMin : null)} ⑤ 주문까지 걸리는 시간 (지연)</b>
          <p>가상 체결은 신호 봉 마감 <b>{lat.assumedMin}분 뒤</b>부터 시작한다고 가정합니다. 실시간 신호 {lat.n}건의 실측: 중앙값 <b>{lat.medianMin ?? "—"}분</b> · 90% <b>{lat.p90Min ?? "—"}분</b>. 실측이 가정보다 길면 실제 성과는 더 나쁩니다.</p>
        </div>
      </div>
    </>
  );
}

/** 실매매 전환 게이트 */
function GatePanel({ a }: { a: Assessment }) {
  const icon = (g: Gate) => (g.ok === true ? "✅" : g.ok === false ? "❌" : "❔");
  return (
    <>
      <h3>🚦 실매매 전환 게이트 <span className="hint">(전부 통과해야 다음 단계)</span></h3>
      <div className={`rs-ready ${a.readiness}`} data-guide="result-gates">
        <div className="rs-ready-title">{a.readinessText}</div>
        <div className="rs-gauge"><i style={{ width: `${(a.gatesPassed / a.gates.length) * 100}%` }} /></div>
        <ul className="rs-gates">
          {a.gates.map((g) => (
            <li key={g.id} className={g.ok === true ? "ok" : g.ok === false ? "no" : "na"}>
              <span>{icon(g)}</span>
              <div><b>{g.label}</b><small>{g.detail}</small></div>
            </li>
          ))}
        </ul>
        <details className="lab-rules">
          <summary>🛣 게이트를 모두 통과한 뒤의 순서 (바로 실계좌 자동매매로 가지 않습니다)</summary>
          <ol>
            <li><b>엔진 사전 작업</b>: 같은 종목 2회 진입(불타기) 허용 · 종목당 투입 한도(지금 30%) 개편 · 캔들 마감 직후 반응(지금 스캔은 5분 주기라 지연이 큼) · 캔들 포지션 청산 뒤에만 삼분할 전환 · 손절 종목 당일 재진입 금지 연동.</li>
            <li><b>드라이런(실주문 잠금) 1~2주</b>: 실제와 똑같이 신호를 내되 주문은 막고, 연구소 가상 결과와 일치하는지 확인.</li>
            <li><b>소액 실주문</b>: 종목당 투입을 매우 작게(시드의 몇 %) 시작, 체결가·슬리피지를 가상값과 비교. 최대 손실 한도·연속 손절 자동 중지 그대로 적용.</li>
            <li><b>점진 확대</b>: 실제 성과가 가상 성과의 범위 안일 때만 단계적으로. 범위를 벗어나면 즉시 중단하고 원인 분석.</li>
          </ol>
        </details>
      </div>
    </>
  );
}

function GradeBanner({ v }: { v: Verdict }) {
  const pct = Math.min(100, (v.eligible / 100) * 100);
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <div className={`rs-grade ${v.grade}`} data-guide="result-grade">
      <div className="rs-grade-title">{v.gradeTitle}</div>
      <div className="rs-gauge" title={`인정 신호 ${v.eligible}건 / 목표 100건`}>
        <i style={{ width: on ? `${pct}%` : "0%" }} />
        <u style={{ left: "30%" }}>30</u>
        <u style={{ left: "100%" }}>100</u>
      </div>
      <ul>{v.gradeReasons.map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  );
}

export function LabResultTab({ lab, initialAssessment }: { lab: LabApi; initialAssessment?: Assessment | null }) {
  const s = lab.summary;
  const guide = useGuide("result");
  // [v0.67.0] 결론은 서버(엔진)가 계산한 종합 평가를 쓴다 — 신뢰구간·시간 분할 검증·스트레스·집중도·게이트까지 포함.
  //   기본은 "실시간 신호만"(백필은 오늘 거래량 상위 종목만 골라 과거를 본 선택 편향이 있어 결론에서 제외).
  const [scope, setScope] = useState<"realtime" | "all">("realtime");
  const [assessLocal, setAssessLocal] = useState<Assessment | null>(initialAssessment ?? null);
  useEffect(() => {
    if (lab.isMirror) return;
    let alive = true;
    void window.kyletool.getLabAssessment?.(scope === "realtime").then((a) => alive && setAssessLocal(a ?? null));
    return () => { alive = false; };
  }, [lab.isMirror, scope, s?.updatedAtMs]);
  const assess: Assessment | null = lab.isMirror ? (s?.assessment ?? null) : assessLocal;
  const verdict: Verdict | null = assess?.verdict ?? null;
  const [ver, setVer] = useState<Awaited<ReturnType<NonNullable<typeof window.kyletool.verifyLab>>> | null>(null);
  const [verBusy, setVerBusy] = useState(false);
  const [verErr, setVerErr] = useState("");

  const runVerify = async () => {
    if (lab.isMirror) return;
    setVerBusy(true);
    setVerErr("");
    try {
      setVer((await window.kyletool.verifyLab?.(8)) ?? null);
    } catch (e) {
      setVerErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVerBusy(false);
    }
  };

  // 비인정 사유·수집 현황(요약 목록 기준)
  const quality = useMemo(() => {
    if (!s) return null;
    const rows = s.signals;
    const by = { volume: 0, range: 0, both: 0 };
    for (const r of rows) if (!r.eligible && r.whyIneligible) by[r.whyIneligible]++;
    const days = new Map<string, number>();
    for (const r of rows) if (r.eligible && !r.thinHours) { const k = kst(r.c2T, "MM-dd"); days.set(k, (days.get(k) ?? 0) + 1); }
    return { by, thin: rows.filter((r) => r.thinHours).length, backfilled: rows.filter((r) => r.backfilled).length, rows: rows.length, days: [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7) };
  }, [s]);

  if (!s || !verdict) {
    return (
      <main className="grid">
        <section className="card wide">
          <h2>🏁 결과 요약</h2>
          <p className="hint">{lab.isMirror ? "PC가 아직 연구소 데이터를 올리지 않았습니다(PC에서 신호 기록을 켜면 곧 나타납니다)." : "불러오는 중…"}</p>
        </section>
      </main>
    );
  }

  const b = verdict.best;
  const mirror = lab.isMirror;
  const linkBlock = s.linkage;
  const funnel = s.funnel;

  return (
    <main className="grid">
      <section className="card wide">
        <div className="rs-title">
          <h2>🏁 결과 요약 <span className="hint">(지금까지 모은 데이터의 결론 한 장)</span></h2>
          <GuideButton onClick={guide.show} />
        </div>
        {s.status.note && <p className="lab-note">ℹ️ {s.status.note}</p>}
        {mirror && <p className="hint">📱 폰에서는 PC가 올려 둔 요약(상위 변형)만 보입니다. 항목별 막대는 PC에서 더 정확합니다. (갱신 {kst(s.updatedAtMs, "MM-dd HH:mm:ss")})</p>}

        {!mirror && (
          <div className="rs-scope">
            <span className="hint">결론에 쓸 데이터:</span>
            <button className={scope === "realtime" ? "mini active" : "mini"} onClick={() => setScope("realtime")}>실시간 신호만 (권장)</button>
            <button className={scope === "all" ? "mini active" : "mini"} onClick={() => setScope("all")}>백필 포함 전체</button>
            {assess && <span className="hint small"> 실시간 인정 {assess.counts.realtimeEligible}건 · 백필 인정 {assess.counts.backfilledEligible}건</span>}
          </div>
        )}
        {scope === "all" && !mirror && (
          <p className="lab-note">⚠️ 백필 신호는 "오늘 거래량이 많은 종목"만 골라 과거를 본 것이라 선택 편향이 있어 성과가 좋게 나오기 쉽습니다. 결론은 실시간 신호로 내려야 합니다.</p>
        )}
        <CollectBar st={s.status} a={assess} funnel={s.funnel} />
        <VerifyBar s={s.status.verify} />
        <GradeBanner v={verdict} />

        <div className="rs-headline" data-guide="result-headline">
          <span className="rs-headline-tag">지금의 결론</span>
          <p>{verdict.headline}</p>
        </div>

        <div className="rs-kpis">
          <div className="rs-kpi"><b><CountUp value={s.counts.total} /></b><span>누적 신호(로우)</span></div>
          <div className="rs-kpi"><b><CountUp value={s.counts.eligible} /></b><span>인정 신호</span></div>
          <div className="rs-kpi"><b className={cls(b?.expectancyPerSignal)}><CountUp value={b?.expectancyPerSignal ?? null} decimals={2} suffix="%" signed /></b><span>1위 조합 신호당 기대값</span></div>
          <div className="rs-kpi"><b><CountUp value={b?.winRate ?? null} decimals={0} suffix="%" /></b><span>1위 조합 승률</span></div>
          <div className="rs-kpi"><b><CountUp value={b?.fillRate ?? null} decimals={0} suffix="%" /></b><span>1위 조합 체결률</span></div>
          <div className="rs-kpi"><b><CountUp value={linkBlock.linkRate} decimals={0} suffix="%" /></b><span>삼분할 연계율</span></div>
        </div>

        {b && (
          <div className="rs-best">
            🏆 1위 조합: <b>매수 {b.entryMode} · 손절 {b.stopMode} · 익절 +{b.tpPct}%</b>
            <span className="hint"> — 체결 {b.filled}/{b.signals}건 · 이익 {b.wins} · 손실 {b.losses} · 손익비 {num(b.profitFactor, 2)} · 평균 손절폭 {num(b.avgRiskPct, 1, "%")} · 평균 보유 {b.avgHoldMin != null ? `${Math.round(b.avgHoldMin)}분` : "—"}</span>
            {verdict.consistent === false && <div className="hint small">⚠️ 이 1위는 항목별 승자와 다릅니다 — 우연일 수 있으니 항목별 결과를 더 믿으세요.</div>}
          </div>
        )}

        <h3>매수 · 손절 · 익절, 무엇이 나은가 <span className="hint">(막대 = 신호당 기대값, 오른쪽 초록 = 이득)</span></h3>
        <div className="rs-dims" data-guide="result-dims">
          <DimBlock title="🛒 매수 방식" hint="신호 봉에서 어떻게 사는가 — 체결률과 기대값을 함께 봅니다." v={verdict.entry} />
          <DimBlock title="🛑 손절 방식" hint="어디에서 끊는가." v={verdict.stop} />
          <DimBlock title="🎯 익절 목표" hint="어디서 파는가." v={verdict.tp} />
        </div>
        <p className="hint small">각 선택지의 값은 다른 항목의 모든 조합을 평균낸 합산 기대값이라, 특정 조합이 우연히 좋았던 영향이 줄어듭니다.</p>

        <h3>캔들 상승 → 삼분할, 정말 이어지나 <span className="hint">(연계 흐름)</span></h3>
        <div className="rs-flow">
          <div className="rs-flow-box"><b><CountUp value={funnel.eligible} /></b><span>인정 신호</span></div>
          <i className="rs-arrow">➜</i>
          <div className="rs-flow-box"><b><CountUp value={funnel.second} /></b><span>2차 신호까지</span></div>
          <i className="rs-arrow">➜</i>
          <div className="rs-flow-box"><b><CountUp value={linkBlock.runsWithBlock} /></b><span>4번째 = 고점 차단</span></div>
          <i className="rs-arrow">➜</i>
          <div className="rs-flow-box hi"><b><CountUp value={linkBlock.linked} /></b><span>삼분할 이어짐 ({num(linkBlock.linkRate, 0, "%")})</span></div>
        </div>

        <h3>카일 질문 답변판 <span className="hint">(지금 데이터가 가리키는 답)</span></h3>
        <div className="rs-qa" data-guide="result-qa">
          {verdict.qa.map((q) => (
            <div key={q.q} className="rs-qa-card">
              <div className="rs-qa-q">{q.q}</div>
              <div className="rs-qa-a">{q.a}</div>
              <span className={`rs-conf ${q.confidence}`}>{CONF_KO[q.confidence]}</span>
              <p className="hint small">{q.basis}</p>
            </div>
          ))}
        </div>

        {assess && <div data-guide="result-flaws"><Flaws a={assess} /></div>}
        {assess && <GatePanel a={assess} />}

        <h3>다음에 할 일</h3>
        <ol className="rs-actions">
          {verdict.actions.map((a) => <li key={a}>{a}</li>)}
        </ol>

        {/* ── 데이터 검증 ── */}
        <h3>🔍 이 데이터, 실제로 맞나요? <span className="hint">(검증)</span></h3>
        <div className="rs-verify" data-guide="result-verify">
          {quality && (
            <p className="hint">
              현재 기록 {quality.rows}건 중 · 인정 {s.counts.eligible}건 · 비인정 {s.counts.total - s.counts.eligible}건
              (거래량 미달 {quality.by.volume} · 봉 크기 미달 {quality.by.range} · 둘 다 {quality.by.both}) · 05~17시(얇은 시세) {quality.thin}건 · 백필 {quality.backfilled}건
              {quality.days.length > 0 && <> · 일별 인정 신호: {quality.days.map(([d, n]) => `${d} ${n}건`).join(", ")}</>}
            </p>
          )}
          {!mirror ? (
            <>
              <button className="btn btn-start" disabled={verBusy} onClick={() => void runVerify()}>
                {verBusy ? "검증 중… (토스에 다시 물어보는 중)" : "🔍 데이터 검증 실행"}
              </button>
              <span className="hint small"> 저장된 로우를 규칙대로 다시 계산하고, 최근 신호 몇 건은 토스에서 지금 다시 받아 값이 같은지 대조합니다(읽기 전용).</span>
              {verErr && <p className="err">⚠️ {verErr}</p>}
              {ver && (
                <div className="rs-ver-result">
                  <p className={ver.local.allOk ? "ok" : "err"}>
                    {ver.local.allOk ? "✅ 저장된 로우 " : "⚠️ 저장된 로우 "}{ver.local.checked}건 검사 — {ver.local.allOk ? "모든 항목 통과" : "일부 항목 불일치(아래 표 확인)"}
                    <span className="hint"> · {ver.local.symbols}종목 · {ver.local.oldest ? `${kst(ver.local.oldest)} ~ ${kst(ver.local.newest)}` : "—"} ({kst(ver.at, "HH:mm:ss")} 실행)</span>
                  </p>
                  <table className="result-table">
                    <thead><tr><th>검사 항목</th><th>설명</th><th>통과</th><th>실패</th></tr></thead>
                    <tbody>
                      {ver.local.checks.map((c) => (
                        <tr key={c.id}>
                          <td>{c.failed === 0 ? "✅" : "⚠️"} {c.label}</td>
                          <td className="hint small">{c.desc}</td>
                          <td>{c.passed}</td>
                          <td className={c.failed ? "pnl-down" : ""}>{c.failed}{c.samples.length > 0 && <span className="hint small"> ({c.samples.slice(0, 2).join(", ")})</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {ver.toss && (
                    <>
                      <p className={ver.toss.error ? "hint" : ver.toss.matched === ver.toss.requested ? "ok" : "err"}>
                        {ver.toss.error
                          ? `ℹ️ 토스 대조 불가: ${ver.toss.error}`
                          : `🌐 토스 대조: 표본 ${ver.toss.requested}건 중 ${ver.toss.matched}건 일치(가격 차 0.05% 이내 · 거래량 차 5% 이내)`}
                      </p>
                      {ver.toss.rows.length > 0 && (
                        <table className="result-table">
                          <thead><tr><th>신호</th><th>저장값 (시/고/저/종 · 거래량)</th><th>토스 재조회</th><th>차이</th><th>판정</th></tr></thead>
                          <tbody>
                            {ver.toss.rows.map((r) => (
                              <tr key={r.id}>
                                <td><b>{r.symbol}</b> {kst(r.c2T)}</td>
                                <td className="hint small">{r.stored ? `${r.stored.o}/${r.stored.h}/${r.stored.l}/${r.stored.c} · ${r.stored.v}` : "—"}</td>
                                <td className="hint small">{r.fresh ? `${r.fresh.o}/${r.fresh.h}/${r.fresh.l}/${r.fresh.c} · ${r.fresh.v}` : "받지 못함"}</td>
                                <td className="hint small">{r.maxPriceDiffPct != null ? `가격 ${r.maxPriceDiffPct}% · 거래량 ${r.volDiffPct}%` : "—"}</td>
                                <td>{r.status === "match" ? "✅ 일치" : r.status === "diff" ? "⚠️ 차이" : "— 비교 불가"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="hint">데이터 검증은 PC 앱에서 실행하세요.</p>
          )}
        </div>
      </section>
      <GuideModal tab="result" open={guide.open} onClose={guide.close} />
    </main>
  );
}
