// =============================================================================
// src/LabTabs.tsx — [v0.65.0] 🔬 매매연구소: 신호기록 현황 · 신호 로우 · 전략 비교·연계
// -----------------------------------------------------------------------------
// [목적] 오너·카일 합의: "연속 상승 캔들 → 삼분할 연계" 전략을 실매매에 붙이기 전에, 주문 없이(가상) 돌려
//   로우 데이터를 쌓고 그 로우로 "어떤 매수 방식·손절·익절이 가장 나은가"를 숫자로 결정한다.
//   이 화면은 그 데이터를 보여 주는 곳이다 — 이 화면 어디에도 주문 버튼은 없다.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import type { LabApi } from "./useLab";
import { DEFAULT_REF_KEY } from "./useLab";
import { LAB_ENTRY_LABEL, LAB_STOP_LABEL, LAB_TP_LIST, type LabEntryMode, type LabStopMode } from "../lib/lab";

const kst = (ms: number | null | undefined, fmt = "MM-dd HH:mm") => (ms == null ? "—" : DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat(fmt));
const num = (v: number | null | undefined, d = 2, suffix = "") => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${suffix}`);
const sgn = (v: number | null | undefined, d = 2, suffix = "%") => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${suffix}`);
const cls = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "pnl-up" : v < 0 ? "pnl-down" : "");

const STATUS_KO: Record<string, string> = {
  win: "✅ 익절", loss: "🛑 손절", time: "🏁 고점 정리", horizon: "⏱ 시간 종료", open: "… 진행 중", unfilled: "· 미체결", skipped: "— 불성립",
};
const SESSION_KO: Record<string, string> = { day: "데이", pre: "프리", regular: "본장", after: "애프터", closed: "장마감" };
const TP_LIST: number[] = [...LAB_TP_LIST];
const ENTRY_MODES = Object.keys(LAB_ENTRY_LABEL) as LabEntryMode[];
const STOP_MODES = Object.keys(LAB_STOP_LABEL) as LabStopMode[];

/** 연구소 화면 공통 머리말: 데이터가 없을 때/폰 미러일 때 안내. */
function LabNotice({ lab }: { lab: LabApi }) {
  const s = lab.summary;
  return (
    <>
      {lab.isMirror && (
        <p className="hint">
          📱 폰에서는 <b>PC가 올려 둔 요약</b>만 보입니다(최근 갱신 {s ? kst(s.updatedAtMs, "MM-dd HH:mm:ss") : "—"}). 상세 로우·내보내기·초기화는 PC 앱에서 하세요.
          켜기/끄기와 설정은 여기서 PC로 명령을 보낼 수 있어요.
        </p>
      )}
      {!s && <p className="hint">{lab.isMirror ? "PC가 아직 연구소 데이터를 올리지 않았습니다(PC에서 신호 기록을 켜면 곧 나타납니다)." : "불러오는 중…"}</p>}
      {lab.msg && <p className={lab.msg.startsWith("⚠") ? "err" : "ok"}>{lab.msg}</p>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 신호기록 현황
// ─────────────────────────────────────────────────────────────────────────────

export function LabLiveTab({ lab }: { lab: LabApi }) {
  const s = lab.summary;
  const st = s?.status;
  const [form, setForm] = useState({ rankCount: "60", dojiBodyMaxPct: "15", bodyMinPct: "60", volRatioMin: "1.5" });
  const [dirty, setDirty] = useState(false);

  // 저장된 값으로 입력칸을 맞춘다(사용자가 고치는 중이면 덮어쓰지 않음)
  useEffect(() => {
    if (!st || dirty) return;
    setForm({ rankCount: String(st.rankCount), dojiBodyMaxPct: String(st.dojiBodyMaxPct), bodyMinPct: String(st.bodyMinPct), volRatioMin: String(st.volRatioMin) });
  }, [st, dirty]);

  const save = () => {
    const rankCount = Number(form.rankCount);
    const dojiBodyMaxPct = Number(form.dojiBodyMaxPct);
    const bodyMinPct = Number(form.bodyMinPct);
    const volRatioMin = Number(form.volRatioMin);
    if (![rankCount, dojiBodyMaxPct, bodyMinPct, volRatioMin].every((v) => Number.isFinite(v) && v > 0)) {
      lab.setMsg("⚠️ 네 칸 모두 0보다 큰 숫자로 입력하세요.");
      return;
    }
    void lab.saveSettings({ rankCount, dojiBodyMaxPct, bodyMinPct, volRatioMin });
    setDirty(false);
  };

  const f = s?.funnel;
  const steps: Array<[string, number, string]> = f
    ? [
        ["① 도지 발견 (200 EMA 위)", f.dojis, "몸통이 작은 봉(색 무관)"],
        ["② 바로 다음이 양봉 (1번째·관망)", f.c1, "음봉·도지가 끼면 탈락"],
        ["③ 그다음도 양봉 (2번째)", f.c2Bull, ""],
        ["④ 2번째 몸통 ≥ 기준", f.c2Body, "신호 성립(거래량은 별도)"],
        ["⑤ 거래량도 충족 = 인정 신호", f.eligible, "여기부터 실투입 후보"],
        ["⑥ 3번째도 인정 (2차 진입 후보)", f.second, "1차가 수익권일 때만 2차"],
        ["⑦ 4번째 양봉 = 단기 고점 차단", f.block4, "추격 매수 금지 구간"],
        ["⑧ 이후 삼분할 패턴 연계", f.linked, "고점→도지→음봉이 이어짐"],
      ]
    : [];
  const maxStep = steps.length ? Math.max(...steps.map((x) => x[1]), 1) : 1;

  return (
    <main className="grid">
      <section className="card wide">
        <h2>🔬 신호 기록 모드 <span className="hint">(주문 없음 · 읽기 전용 연구)</span></h2>
        <p className="hint">
          카일이 제안한 "도지 → 연속 양봉 돌파 → 4번째 고점 → 삼분할 연계" 전략을 <b>실제 시장에서 주문 없이</b> 돌려 봅니다.
          5분마다(이 앱이 켜져 있는 동안) 토스 거래량 순위 상위 종목을 훑어 패턴을 찾고, 찾을 때마다 <b>가상 매수 → 로직대로 가상 매매 → 결과</b>까지
          전부 <b>로우 데이터</b>로 쌓습니다. 이 데이터로 매수 방식·손절·익절을 실제 숫자로 정한 뒤에야 실매수에 연결합니다.
        </p>
        <LabNotice lab={lab} />

        {st && (
          <div className="lab-status">
            <span className={`lab-pill ${st.enabled ? "on" : "off"}`}>{st.enabled ? "🟢 기록 중" : "⚪ 꺼짐"}</span>
            {st.scanning && <span className="lab-pill busy">⏳ 스캔 중</span>}
            <span className="hint">
              마지막 스캔 {st.lastTickAtMs ? kst(st.lastTickAtMs, "MM-dd HH:mm:ss") : "—"}
              {st.lastTickDurMs != null && ` (${Math.round(st.lastTickDurMs / 1000)}초, ${st.lastScanned}종목)`}
              {st.enabled && st.nextTickAtMs && ` · 다음 스캔 약 ${kst(st.nextTickAtMs, "HH:mm")}`}
            </span>
            {st.lastSkip && <span className="hint">⏸ 건너뜀: {st.lastSkip}</span>}
            {st.lastError && <span className="err">⚠️ {st.lastError}</span>}
          </div>
        )}

        <div className="form-row">
          <button className={st?.enabled ? "btn btn-stop" : "btn btn-start"} disabled={lab.busy || !st} onClick={() => void lab.saveSettings({ enabled: !st?.enabled })}>
            {st?.enabled ? "신호 기록 끄기" : "신호 기록 켜기"}
          </button>
          {!lab.isMirror && (
            <button className="mini" disabled={lab.busy} onClick={() => void lab.scanNow()} title="켜짐 여부와 무관하게 지금 한 번 훑습니다. 종목마다 처음 한 번은 1분봉을 깊게(약 2400개) 받아, 받을 수 있는 과거 구간(보통 하루 반 안팎)의 신호까지 한꺼번에 채웁니다.">
              🔎 지금 스캔(과거 백필 포함)
            </button>
          )}
        </div>

        <h3>탐색 설정</h3>
        <div className="form-row">
          <label>거래량 순위 몇 위까지 탐색
            <input type="text" inputMode="numeric" value={form.rankCount} onChange={(e) => { setForm({ ...form, rankCount: e.target.value }); setDirty(true); }} />
          </label>
          <label>도지 몸통 상한(%)
            <input type="text" inputMode="decimal" value={form.dojiBodyMaxPct} onChange={(e) => { setForm({ ...form, dojiBodyMaxPct: e.target.value }); setDirty(true); }} />
          </label>
          <label>신호 캔들 몸통 하한(%)
            <input type="text" inputMode="decimal" value={form.bodyMinPct} onChange={(e) => { setForm({ ...form, bodyMinPct: e.target.value }); setDirty(true); }} />
          </label>
          <label>거래량 배수(직전 5개 평균 대비)
            <input type="text" inputMode="decimal" value={form.volRatioMin} onChange={(e) => { setForm({ ...form, volRatioMin: e.target.value }); setDirty(true); }} />
          </label>
          <button className="btn btn-start" disabled={lab.busy || !dirty} onClick={save}>설정 저장</button>
        </div>
        <p className="hint small">
          거래량 순위: 10~200위(기본 60). 도지 몸통 5~30%(기본 15), 신호 몸통 40~90%(기본 60), 거래량 배수 1~5배(기본 1.5 = 150%).
          가격대는 [스크리닝 기준]의 가격대($1~9 기본)를 그대로 씁니다. 기준은 신호가 기록될 때의 값으로 판정되며, 나중에 바꿔도 이미 쌓인 로우는 그대로입니다.
        </p>

        {s && (
          <>
            <h3>데이터 현황</h3>
            <div className="lab-cards">
              <div className="lab-card"><b>{s.counts.total}</b><span>누적 신호(로우)</span></div>
              <div className="lab-card"><b>{s.counts.eligible}</b><span>인정 신호(거래량 충족)</span></div>
              <div className="lab-card"><b>{s.counts.complete}</b><span>관찰 완료</span></div>
              <div className="lab-card"><b>{s.counts.open}</b><span>관찰 중</span></div>
            </div>
            <p className="hint small">
              {s.counts.eligible < 30
                ? "⚠️ 인정 신호가 30건 미만이라 통계로 결론 내기엔 이릅니다. 변형별 승률·기대값은 \"참고\"로만 보세요(권장: 100건 이상)."
                : s.counts.eligible < 100
                  ? "ℹ️ 인정 신호 30건 이상 — 경향은 볼 수 있지만 변형 간 차이가 작으면 아직 우연일 수 있어요(권장: 100건 이상)."
                  : "✅ 인정 신호 100건 이상 — 변형 비교를 판단 근거로 쓸 수 있는 수준입니다."}
            </p>

            <h3>신호 깔때기 <span className="hint">(어느 단계에서 많이 떨어지는가)</span></h3>
            <div className="lab-funnel">
              {steps.map(([label, n, note]) => (
                <div key={label} className="lab-funnel-row">
                  <span className="lab-funnel-label">{label}</span>
                  <span className="lab-funnel-bar"><i style={{ width: `${Math.max(2, (n / maxStep) * 100)}%` }} /></span>
                  <b className="lab-funnel-n">{n}</b>
                  <span className="hint small">{note}</span>
                </div>
              ))}
            </div>
            <p className="hint small">① ~ ④는 시도 횟수(비인정 포함), ⑤ ~ ⑧은 기록된 신호 기준입니다.</p>
          </>
        )}

        <details className="lab-rules">
          <summary>📐 기록 규칙·가상 체결 가정 보기 (이 숫자들이 어떻게 만들어지는지)</summary>
          <ul>
            <li><b>패턴</b>: 도지(몸통 &lt; 기준, 색 무관, 200 EMA 위) → 1번째 양봉(관망) → 2번째 양봉(몸통 ≥ 기준 + 거래량 ≥ 직전 5개 평균 × 배수) = <b>1차 신호</b> → 3번째도 같은 조건이면 <b>2차 신호</b> → 4번째 양봉이면 <b>단기 고점(진입 금지)</b>. 중간에 음봉·도지가 끼거나 조건이 모자라면 그 자리에서 패턴 종료.</li>
            <li><b>캔들 종류</b>: 몸통·도지·거래량 판정은 하이킨아시, 가격(체결·손절·익절)은 실제 5분·1분봉.</li>
            <li><b>가상 매수 4가지</b>를 동시에 계산: A 신호봉 저가+3틱 지정가 / B 신호봉 종가 지정가 / C 신호봉 고가 돌파(+1틱) 시 진입 / D 신호봉 몸통 50% 되돌림 지정가. 신호봉 마감 후 15분 안에 체결 안 되면 미체결.</li>
            <li><b>손절 4가지</b>: A 고정 −10% / B EMA200 아래 1.5% / C 신호봉 저가 −1틱 / D C와 B 중 높은 쪽. <b>익절 3가지</b>: +1.3% / +1.5% / +2.0%. 4번째 양봉(고점 차단)이 확정되면 남은 물량은 그 봉 마감 때 시가로 정리.</li>
            <li><b>2차 진입</b>은 1차가 체결·보유 중이고 3번째 봉 마감 시점에 수익권일 때만(손실 중 추가 금지).</li>
            <li><b>보수적 체결</b>: 지정가는 가격이 한 틱 이상 "뚫고" 지나가야 체결, 같은 1분봉에서 손절·익절이 둘 다 닿으면 손절 먼저, 갭이 나면 시가로 체결, 체결된 봉에서는 익절을 보지 않음. 왕복 수수료 0.2%를 뺀 값을 "순손익"으로 씁니다. 실제보다 좋게 나오는 착시를 막기 위한 가정입니다.</li>
            <li><b>삼분할 연계</b>: 상승 구간이 끝난 뒤 3시간 안에, 기존 자동매매와 <b>같은 기준</b>(스크리닝 기준 탭의 도지·신선도·간격)으로 "고점→도지→음봉" 패턴이 이어졌는지 찾고, 그 1·2분할 타점에 가상 매수합니다(미체결 10분 후 취소).</li>
            <li><b>제외</b>: 05:00~17:00 KST(시세가 얇은 시간대)와 거래량 미달 신호는 기본 통계에서 빠집니다(필터로 포함 가능). 신호 봉 마감보다 10분 넘게 늦게 발견된 신호는 "백필"로 표시됩니다(과거 데이터에서 규칙대로 뽑은 것).</li>
          </ul>
        </details>

        {!lab.isMirror && (
          <>
            <h3>데이터 내보내기·초기화</h3>
            <div className="form-row">
              <button className="mini" onClick={() => void lab.download("signals-csv")}>📄 신호 로우 CSV</button>
              <button className="mini" onClick={() => void lab.download("trades-csv")}>📄 가상 매매 CSV(신호×변형)</button>
              <button className="mini" onClick={() => void lab.download("json")}>🗂 원본 JSON(전체 로우+1분봉 경로)</button>
              <button
                className="mini ghost"
                onClick={() => {
                  if (window.confirm("연구소에 쌓인 모든 신호 데이터를 지웁니다. 되돌릴 수 없어요. 계속할까요?")) void lab.reset();
                }}
              >
                🗑 데이터 초기화
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 캔들 차트(SVG) — 신호 한 건의 로우 + 선택한 가상 매매
// ─────────────────────────────────────────────────────────────────────────────

export function CandleChart({ sig, trade, ha }: { sig: LabSignalFull; trade: LabTrade | null; ha: boolean }) {
  const FIVE = 300_000;
  const lastT = Math.max(
    sig.c2T + 5 * FIVE,
    sig.runEndT + 2 * FIVE,
    trade?.exitT ?? 0,
    sig.linkage ? sig.linkage.confirmT + 3 * FIVE : 0,
  );
  const bars = sig.bars.filter((b) => b.t <= lastT + 2 * FIVE).slice(0, 64);
  if (bars.length === 0) return <p className="hint">차트 데이터 없음</p>;
  const W = 820, H = 320, padL = 8, padR = 56, padT = 18, padB = 22;
  const px = (b: LabBar5) => (ha ? { o: b.ho, h: b.hh, l: b.hl, c: b.hc } : { o: b.o, h: b.h, l: b.l, c: b.c });
  const vals: number[] = [];
  for (const b of bars) {
    const p = px(b);
    vals.push(p.h, p.l);
    if (b.e != null) vals.push(b.e);
  }
  if (trade?.stopPx) vals.push(trade.stopPx);
  if (trade?.tpPx) vals.push(trade.tpPx);
  if (trade?.fillPx) vals.push(trade.fillPx);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const span = Math.max(hi - lo, 1e-6);
  const y = (v: number) => padT + ((hi - v) / span) * (H - padT - padB);
  const t0 = bars[0].t;
  const slot = (W - padL - padR) / bars.length;
  const xAt = (t: number) => padL + ((t - t0) / FIVE) * slot + slot / 2;
  const cw = Math.max(3, slot * 0.62);
  const markers: Array<[number, string]> = [[sig.dojiT, "도지"], [sig.dojiT + FIVE, "1"], [sig.c2T, "2"]];
  if (sig.second) markers.push([sig.second.t, "3"]);
  if (sig.c4) markers.push([sig.c4.t, sig.c4.block ? "4▲" : "4"]);
  const emaPts = bars.filter((b) => b.e != null).map((b) => `${xAt(b.t)},${y(b.e as number)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="lab-chart" role="img" aria-label="신호 캔들 차트">
      {/* 신호 구간 배경 */}
      <rect x={xAt(sig.dojiT) - slot / 2} y={padT - 14} width={Math.max(slot, xAt(sig.runEndT) - xAt(sig.dojiT) + slot)} height={H - padT - padB + 14} className="lab-run-bg" />
      {/* 가격 눈금 */}
      {[0, 0.25, 0.5, 0.75, 1].map((r) => {
        const v = hi - r * span;
        return (
          <g key={r}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="lab-grid" />
            <text x={W - padR + 4} y={y(v) + 3} className="lab-axis">{v.toFixed(v < 1 ? 4 : 2)}</text>
          </g>
        );
      })}
      {emaPts && <polyline points={emaPts} className="lab-ema" fill="none" />}
      {bars.map((b) => {
        const p = px(b);
        const up = p.c >= p.o;
        const x = xAt(b.t);
        return (
          <g key={b.t} className={up ? "lab-up" : "lab-dn"}>
            <line x1={x} x2={x} y1={y(p.h)} y2={y(p.l)} />
            <rect x={x - cw / 2} y={y(Math.max(p.o, p.c))} width={cw} height={Math.max(1, Math.abs(y(p.o) - y(p.c)))} />
          </g>
        );
      })}
      {markers.map(([t, label]) => (
        <text key={t} x={xAt(t)} y={11} className="lab-marker" textAnchor="middle">{label}</text>
      ))}
      {sig.linkage && sig.bars.some((b) => b.t === sig.linkage!.confirmT) && bars.some((b) => b.t === sig.linkage!.confirmT) && (
        <g>
          <line x1={xAt(sig.linkage.confirmT)} x2={xAt(sig.linkage.confirmT)} y1={padT} y2={H - padB} className="lab-link-line" />
          <text x={xAt(sig.linkage.confirmT)} y={H - 6} className="lab-marker" textAnchor="middle">삼분할 확정</text>
        </g>
      )}
      {trade?.fillPx != null && trade.entryT != null && (
        <g>
          <line x1={xAt(trade.entryT)} x2={xAt(trade.exitT ?? lastT)} y1={y(trade.fillPx)} y2={y(trade.fillPx)} className="lab-line-entry" />
          {trade.stopPx != null && <line x1={xAt(trade.entryT)} x2={xAt(trade.exitT ?? lastT)} y1={y(trade.stopPx)} y2={y(trade.stopPx)} className="lab-line-stop" />}
          {trade.tpPx != null && <line x1={xAt(trade.entryT)} x2={xAt(trade.exitT ?? lastT)} y1={y(trade.tpPx)} y2={y(trade.tpPx)} className="lab-line-tp" />}
          {trade.exitT != null && trade.exitPx != null && <circle cx={xAt(trade.exitT)} cy={y(trade.exitPx)} r={4} className="lab-exit" />}
          <circle cx={xAt(trade.entryT)} cy={y(trade.fillPx)} r={4} className="lab-fill" />
        </g>
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 신호 로우
// ─────────────────────────────────────────────────────────────────────────────

function parseKey(key: string): { em: LabEntryMode; sm: LabStopMode; tp: string } {
  const m = /^([A-D])([A-D])-([0-9.]+)-e1$/.exec(key);
  return m ? { em: m[1] as LabEntryMode, sm: m[2] as LabStopMode, tp: m[3] } : { em: "D", sm: "D", tp: "1.5" };
}

export function LabSignalsTab({ lab }: { lab: LabApi }) {
  const s = lab.summary;
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ signal: LabSignalFull; trades: LabTrade[] } | null>(null);
  const [tradeKey, setTradeKey] = useState<string | null>(null);
  const [useHa, setUseHa] = useState(false);
  const [onlyFilled, setOnlyFilled] = useState(true);
  const ref = parseKey(lab.filter.refKey || DEFAULT_REF_KEY);

  const setRef = (patch: Partial<{ em: LabEntryMode; sm: LabStopMode; tp: string }>) => {
    const n = { ...ref, ...patch };
    lab.setFilter({ ...lab.filter, refKey: `${n.em}${n.sm}-${n.tp}-e1` });
  };

  useEffect(() => {
    if (!sel || lab.isMirror) { setDetail(null); return; }
    let alive = true;
    void window.kyletool.getLabSignal?.(sel).then((d) => {
      if (!alive) return;
      setDetail(d ?? null);
      setTradeKey(lab.filter.refKey || DEFAULT_REF_KEY);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, lab.isMirror]);

  const trade = useMemo(() => detail?.trades.find((t) => t.key === tradeKey) ?? null, [detail, tradeKey]);
  const shownTrades = useMemo(
    () => (detail?.trades ?? []).filter((t) => !onlyFilled || t.fillPx != null),
    [detail, onlyFilled],
  );

  return (
    <main className="grid">
      <section className="card wide">
        <h2>🧾 신호 로우 <span className="hint">(찾은 신호를 한 건씩, 가상 매매 결과까지)</span></h2>
        <p className="hint">
          한 줄 = 패턴이 인정된 신호 한 건(2번째 캔들 마감 시점). 아래 "기준 변형"으로 가상 매매했을 때의 결과를 줄마다 보여 줍니다.
          줄을 누르면 그 신호의 <b>캔들 차트와 모든 변형(최대 약 100가지)의 개별 결과</b>가 열립니다.
        </p>
        <LabNotice lab={lab} />

        <div className="form-row lab-filters">
          <label className="radio"><input type="checkbox" checked={!!lab.filter.includeIneligible} onChange={(e) => lab.setFilter({ ...lab.filter, includeIneligible: e.target.checked })} /> 거래량 미달(비인정) 포함</label>
          <label className="radio"><input type="checkbox" checked={!!lab.filter.includeThin} onChange={(e) => lab.setFilter({ ...lab.filter, includeThin: e.target.checked })} /> 05~17시(얇은 시세) 포함</label>
          <label className="radio"><input type="checkbox" checked={lab.filter.includeBackfilled !== false} onChange={(e) => lab.setFilter({ ...lab.filter, includeBackfilled: e.target.checked })} /> 백필(늦게 발견) 포함</label>
        </div>
        <div className="form-row lab-filters">
          <span className="hint">기준 변형 →</span>
          <label>매수
            <select value={ref.em} onChange={(e) => setRef({ em: e.target.value as LabEntryMode })}>
              {ENTRY_MODES.map((m) => <option key={m} value={m}>{m}. {LAB_ENTRY_LABEL[m]}</option>)}
            </select>
          </label>
          <label>손절
            <select value={ref.sm} onChange={(e) => setRef({ sm: e.target.value as LabStopMode })}>
              {STOP_MODES.map((m) => <option key={m} value={m}>{m}. {LAB_STOP_LABEL[m]}</option>)}
            </select>
          </label>
          <label>익절
            <select value={ref.tp} onChange={(e) => setRef({ tp: e.target.value })}>
              {TP_LIST.map((t) => <option key={t} value={String(t)}>+{t}%</option>)}
            </select>
          </label>
        </div>

        {s && s.signals.length === 0 && <p className="hint">아직 기록된 신호가 없습니다. [신호기록 현황]에서 기록을 켜고 "지금 스캔"을 눌러 보세요.</p>}
        {s && s.signals.length > 0 && (
          <div className="lab-scroll">
            <table className="result-table screen-table lab-table">
              <thead>
                <tr>
                  <th>신호 시각(KST)</th><th>종목</th><th>순위</th><th>세션</th><th>몸통</th><th>거래량배수</th><th>EMA 이격</th><th>ATR</th>
                  <th>2차</th><th>4번째</th><th>삼분할</th><th>기준 변형 결과</th><th>상태</th>
                </tr>
              </thead>
              <tbody>
                {s.signals.map((r) => (
                  <tr key={r.id} className={`screen-row ${sel === r.id ? "lab-sel" : ""} ${r.eligible ? "" : "lab-dim"}`} onClick={() => !lab.isMirror && setSel(sel === r.id ? null : r.id)}>
                    <td>{kst(r.c2T)}{r.backfilled && <span className="lab-tag" title="늦게 발견(과거 데이터에서 규칙대로 뽑음)">백필</span>}{r.thinHours && <span className="lab-tag" title="05~17시 얇은 시세">얇음</span>}</td>
                    <td><b>{r.symbol}</b> <span className="hint small">${num(r.price)}</span></td>
                    <td>{r.rank}</td>
                    <td>{SESSION_KO[r.session] ?? r.session}</td>
                    <td>{num(r.body2, 0, "%")}</td>
                    <td className={r.eligible ? "" : "pnl-down"}>{num(r.volRatio2, 1, "×")}{!r.eligible && " ✗"}</td>
                    <td>{num(r.emaGapPct, 1, "%")}</td>
                    <td>{num(r.atrPct, 1, "%")}</td>
                    <td>{r.secondQualified ? "✔" : "—"}</td>
                    <td>{r.c4Block == null ? "—" : r.c4Block ? "▲ 차단" : "종료"}</td>
                    <td>{r.linked ? "🔗" : "—"}</td>
                    <td className={cls(r.ref?.netPct)}>
                      {r.ref ? <>{STATUS_KO[r.ref.status] ?? r.ref.status} {r.ref.netPct != null && sgn(r.ref.netPct)}</> : "—"}
                    </td>
                    <td>{r.complete ? "완료" : "관찰 중"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detail && (
          <div className="lab-detail">
            <h3>{detail.signal.symbol} · 신호 {kst(detail.signal.c2T, "MM-dd HH:mm")}
              <span className="hint"> (순위 {detail.signal.rank}위 · {SESSION_KO[detail.signal.session] ?? detail.signal.session}{detail.signal.backfilled ? " · 백필" : ""})</span>
            </h3>
            <div className="form-row">
              <label className="radio"><input type="checkbox" checked={useHa} onChange={(e) => setUseHa(e.target.checked)} /> 하이킨아시로 보기(판정 기준)</label>
              <button className="mini" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(detail.signal))}>📋 이 신호 로우(JSON) 복사</button>
            </div>
            <CandleChart sig={detail.signal} trade={trade} ha={useHa} />
            <p className="hint small">
              회색 띠 = 패턴 구간 · 초록/빨강 = 양봉/음봉 · 노란선 = EMA200 · 파란 점 = 체결 · 점선(파랑 체결가 / 빨강 손절 / 초록 익절). 위 글자: 도지·1·2·3·4번째 캔들(4▲ = 고점 차단).
            </p>
            <table className="evid-table">
              <tbody>
                <tr><td>도지</td><td>몸통 {num(detail.signal.metrics.dojiBodyPct, 1, "%")} · EMA 대비 {num(detail.signal.metrics.dojiEmaDistPct, 1, "%")}</td></tr>
                <tr><td>2번째(1차 신호)</td><td>몸통 {num(detail.signal.body2, 0, "%")} · 거래량 {num(detail.signal.volRatio2, 2, "배")} · 종가 ${num(detail.signal.metrics.price, 4)} · EMA 이격 {num(detail.signal.metrics.emaGapPct, 2, "%")} (저가는 EMA {num(detail.signal.metrics.lowVsEmaPct, 2, "%")} 위)</td></tr>
                <tr><td>3번째(2차 신호)</td><td>{detail.signal.second ? `${detail.signal.second.qualified ? "인정" : "미달"} · 몸통 ${num(detail.signal.second.body, 0, "%")} · 거래량 ${num(detail.signal.second.volRatio, 2, "배")}` : "없음"}</td></tr>
                <tr><td>4번째</td><td>{detail.signal.c4 ? (detail.signal.c4.block ? "양봉 → 단기 고점(진입 금지)" : "양봉 아님 → 자연 종료") : "없음"}</td></tr>
                <tr><td>변동성·기울기·상승폭</td><td>ATR {num(detail.signal.metrics.atrPct, 2, "%")} · EMA 1시간 변화 {num(detail.signal.metrics.emaSlopePct, 2, "%")} · 도지 저가→고점 {num(detail.signal.metrics.runRangePct, 2, "%")}</td></tr>
                <tr><td>삼분할 연계</td><td>{detail.signal.linkage
                  ? `${kst(detail.signal.linkage.confirmT)} 확정 · 고점 $${detail.signal.linkage.highPx} · 전봉종가 EMA 이격 ${num(detail.signal.linkage.emaGapPct, 1, "%")} · 1분할 $${detail.signal.linkage.splits[0]?.entry} / 2분할 $${detail.signal.linkage.splits[1]?.entry}`
                  : detail.signal.linkageDone ? "이어지지 않음" : "탐색 중"}</td></tr>
              </tbody>
            </table>
            <h4>이 신호의 변형별 가상 매매 <span className="hint">(행을 누르면 위 차트에 표시)</span></h4>
            <label className="radio"><input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} /> 체결된 것만</label>
            <div className="lab-scroll">
              <table className="result-table lab-table">
                <thead><tr><th>변형</th><th>결과</th><th>체결가</th><th>손절/익절가</th><th>청산</th><th>순손익</th><th>최대역행</th><th>보유</th><th>비고</th></tr></thead>
                <tbody>
                  {shownTrades.map((t) => (
                    <tr key={t.key} className={`screen-row ${tradeKey === t.key ? "lab-sel" : ""}`} onClick={() => setTradeKey(t.key)}>
                      <td>{t.kind === "link" ? `삼분할${t.entryIdx}분할·손절${t.stopMode}` : `매수${t.entryMode}·손절${t.stopMode}·${t.entryIdx === 2 ? "2차" : "1차"}`} +{t.tpPct}%</td>
                      <td>{STATUS_KO[t.status] ?? t.status}</td>
                      <td>{t.fillPx != null ? `$${t.fillPx} @${kst(t.entryT, "HH:mm")}` : "—"}</td>
                      <td>{t.stopPx != null ? `$${t.stopPx} / $${t.tpPx}` : "—"}</td>
                      <td>{t.exitPx != null ? `$${t.exitPx} @${kst(t.exitT, "HH:mm")} (${t.exitReason})` : "—"}</td>
                      <td className={cls(t.netPct)}>{sgn(t.netPct)}</td>
                      <td>{sgn(t.maePct)}</td>
                      <td>{t.holdMin != null ? `${t.holdMin}분` : "—"}</td>
                      <td className="hint small">{t.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 전략 비교·연계
// ─────────────────────────────────────────────────────────────────────────────

type CompareKind = "c1" | "c2" | "link";
const DIM_LABEL: Record<LabBreakdownDim, string> = {
  session: "세션", hour: "시간대(KST)", rank: "거래량 순위", volRatio: "거래량 배수", emaGap: "EMA 이격도", atr: "변동성(ATR)", price: "주가대", runRange: "상승폭",
};

export function LabCompareTab({ lab }: { lab: LabApi }) {
  const s = lab.summary;
  const [kind, setKind] = useState<CompareKind>("c1");
  const [tp, setTp] = useState("1.5");
  const [minFilled, setMinFilled] = useState("5");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [dim, setDim] = useState<LabBreakdownDim>("session");
  const [bd, setBd] = useState<LabBreakdownRow[] | null>(null);
  const [linkKey, setLinkKey] = useState("L1A-1.5");
  const [combined, setCombined] = useState<LabCombined | null>(null);
  const minN = Math.max(1, Math.round(Number(minFilled) || 5));

  const rows = useMemo(() => (s?.variants ?? []).filter((v) => (kind === "link" ? v.kind === "link" : v.kind === "candle" && v.entryIdx === (kind === "c1" ? 1 : 2))), [s, kind]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (a.filled >= minN ? 0 : 1) - (b.filled >= minN ? 0 : 1) || (b.expectancyPerSignal ?? -999) - (a.expectancyPerSignal ?? -999)),
    [rows, minN],
  );
  const best = sorted.find((r) => r.filled >= minN) ?? null;
  const sel = selKey ? (byKey.get(selKey) ?? null) : null;

  // 선택한 변형의 조건별 분해(PC 전용 — 폰은 로우가 없음)
  useEffect(() => {
    if (!selKey || lab.isMirror || selKey.startsWith("L")) { setBd(null); return; }
    let alive = true;
    void window.kyletool.getLabBreakdown?.(selKey, dim, lab.filter).then((r) => alive && setBd(r ?? null));
    return () => { alive = false; };
  }, [selKey, dim, lab.filter, lab.isMirror, s?.updatedAtMs]);

  useEffect(() => {
    if (lab.isMirror || !selKey || selKey.startsWith("L") || !selKey.endsWith("-e1")) { setCombined(null); return; }
    let alive = true;
    void window.kyletool.getLabCombined?.(selKey, linkKey, lab.filter).then((r) => alive && setCombined(r ?? null));
    return () => { alive = false; };
  }, [selKey, linkKey, lab.filter, lab.isMirror, s?.updatedAtMs]);

  const cell = (key: string) => {
    const r = byKey.get(key);
    if (!r || r.signals === 0) return <td className="lab-cell">—</td>;
    const e = r.expectancyPerSignal;
    const weak = r.filled < minN;
    return (
      <td className={`lab-cell ${e == null ? "" : e > 0 ? "pos-bg" : "neg-bg"} ${weak ? "weak" : ""} ${selKey === key ? "lab-sel" : ""}`} onClick={() => setSelKey(key)} title={`체결 ${r.filled}/${r.signals} · 승률 ${num(r.winRate, 0, "%")} · 손익비 ${num(r.profitFactor, 2)}`}>
        <b className={cls(e)}>{sgn(e, 2, "")}</b>
        <small>체결 {r.filled}/{r.signals}{r.winRate != null && ` · 승 ${r.winRate.toFixed(0)}%`}</small>
      </td>
    );
  };

  const linkRows = useMemo(() => (s?.variants ?? []).filter((v) => v.kind === "link"), [s]);

  return (
    <main className="grid">
      <section className="card wide">
        <h2>⚖️ 전략 비교·연계 <span className="hint">(어떤 매수 방식·손절·익절이 나은가 — 로우에서 계산한 실제 숫자)</span></h2>
        <p className="hint">
          같은 신호들을 변형별로 가상 매매한 결과를 비교합니다. <b>기대값</b> = 신호 하나당 평균 순손익(%)이며, 미체결은 0으로 칩니다 — 체결이 잘 안 되는 방식은
          승률이 높아 보여도 기대값이 낮게 나오므로 "정말 쓸 만한가"를 가장 정직하게 보여 주는 숫자예요.
        </p>
        <LabNotice lab={lab} />

        {s && (
          <>
            <div className="form-row">
              <button className={kind === "c1" ? "mini active" : "mini"} onClick={() => { setKind("c1"); setSelKey(null); }}>캔들 1차 진입(2번째 캔들)</button>
              <button className={kind === "c2" ? "mini active" : "mini"} onClick={() => { setKind("c2"); setSelKey(null); }}>캔들 2차 진입(3번째 캔들)</button>
              <button className={kind === "link" ? "mini active" : "mini"} onClick={() => { setKind("link"); setSelKey(null); }}>삼분할 연계 진입</button>
              <label>최소 체결 수(이보다 적으면 흐리게)
                <input type="text" inputMode="numeric" value={minFilled} style={{ width: 60 }} onChange={(e) => setMinFilled(e.target.value)} />
              </label>
            </div>

            {best ? (
              <div className="lab-best">
                🏆 현재 기대값 1위: <b>{variantName(best)}</b> — 신호당 <b className={cls(best.expectancyPerSignal)}>{sgn(best.expectancyPerSignal)}</b>
                (체결 {best.filled}/{best.signals}건 · 승률 {num(best.winRate, 0, "%")} · 손익비 {num(best.profitFactor, 2)} · 평균 손절폭 {num(best.avgRiskPct, 1, "%")})
                <br />
                <span className="hint small">
                  {s.counts.eligible < 30 ? "⚠️ 표본이 적어(인정 신호 30건 미만) 우연일 가능성이 큽니다." : "※ 변형을 많이 비교하면 우연히 좋아 보이는 조합이 생깁니다. 1위와 2~3위 차이가 작으면 단정하지 마세요."}
                </span>
              </div>
            ) : (
              <p className="hint">체결 {minN}건 이상인 변형이 아직 없습니다 — 신호가 더 쌓이면 표시됩니다.</p>
            )}

            {kind !== "link" && !lab.isMirror && (
              <>
                <h3>매수 방식 × 손절 방식 <span className="hint">(칸 = 신호당 기대값 %, 아래 글자 = 체결/시도 · 승률)</span></h3>
                <div className="form-row">
                  <label>익절
                    <select value={tp} onChange={(e) => setTp(e.target.value)}>
                      {TP_LIST.map((t) => <option key={t} value={String(t)}>+{t}%</option>)}
                    </select>
                  </label>
                </div>
                <div className="lab-scroll">
                  <table className="result-table lab-matrix">
                    <thead>
                      <tr><th>매수 ＼ 손절</th>{STOP_MODES.map((m) => <th key={m}>{m}. {LAB_STOP_LABEL[m]}</th>)}</tr>
                    </thead>
                    <tbody>
                      {ENTRY_MODES.map((em) => (
                        <tr key={em}>
                          <th>{em}. {LAB_ENTRY_LABEL[em]}</th>
                          {STOP_MODES.map((sm) => <FragmentCell key={sm}>{cell(`${em}${sm}-${tp}-e${kind === "c1" ? 1 : 2}`)}</FragmentCell>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <h3>전체 변형 순위 <span className="hint">(기대값 순 · 행을 누르면 아래에 상세)</span></h3>
            <div className="lab-scroll">
              <table className="result-table lab-table">
                <thead>
                  <tr><th>변형</th><th>시도</th><th>체결</th><th>체결률</th><th>승률</th><th>평균 순손익</th><th>손익비</th><th>신호당 기대값</th><th>평균 손절폭</th><th>평균 최대역행</th><th>평균 보유</th></tr>
                </thead>
                <tbody>
                  {sorted.slice(0, 60).map((r) => (
                    <tr key={r.key} className={`screen-row ${selKey === r.key ? "lab-sel" : ""} ${r.filled < minN ? "lab-dim" : ""}`} onClick={() => setSelKey(r.key)}>
                      <td>{variantName(r)}</td>
                      <td>{r.signals}</td>
                      <td>{r.filled}</td>
                      <td>{num(r.fillRate, 0, "%")}</td>
                      <td>{num(r.winRate, 0, "%")}</td>
                      <td className={cls(r.avgNetPct)}>{sgn(r.avgNetPct)}</td>
                      <td>{num(r.profitFactor, 2)}</td>
                      <td className={cls(r.expectancyPerSignal)}><b>{sgn(r.expectancyPerSignal)}</b></td>
                      <td>{num(r.avgRiskPct, 1, "%")}</td>
                      <td>{sgn(r.avgMaePct)}</td>
                      <td>{r.avgHoldMin != null ? `${Math.round(r.avgHoldMin)}분` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lab.isMirror && <p className="hint small">📱 폰에는 PC가 올린 상위 변형만 보입니다. 전체 비교표·분해는 PC에서 확인하세요.</p>}

            {sel && (
              <div className="lab-detail">
                <h3>선택: {variantName(sel)}</h3>
                <p className="hint">
                  시도 {sel.signals} · 체결 {sel.filled}({num(sel.fillRate, 0, "%")}) · 익절/이익 {sel.wins} · 손실 {sel.losses} · 평균 이익 {sgn(sel.avgWinPct)} · 평균 손실 {sgn(sel.avgLossPct)} · 합계 {sgn(sel.totalNetPct)}
                </p>
                {!lab.isMirror && !sel.key.startsWith("L") && (
                  <>
                    <div className="form-row">
                      <label>조건별로 나눠 보기
                        <select value={dim} onChange={(e) => setDim(e.target.value as LabBreakdownDim)}>
                          {(Object.keys(DIM_LABEL) as LabBreakdownDim[]).map((d) => <option key={d} value={d}>{DIM_LABEL[d]}</option>)}
                        </select>
                      </label>
                    </div>
                    {bd && bd.length > 0 ? (
                      <table className="result-table">
                        <thead><tr><th>{DIM_LABEL[dim]}</th><th>체결 건수</th><th>승률</th><th>평균 순손익</th><th>합계</th></tr></thead>
                        <tbody>
                          {bd.map((r) => (
                            <tr key={r.label}><td>{r.label}</td><td>{r.n}</td><td>{num(r.winRate, 0, "%")}</td><td className={cls(r.avgNetPct)}>{sgn(r.avgNetPct)}</td><td className={cls(r.totalNetPct)}>{sgn(r.totalNetPct)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <p className="hint">나눌 체결 데이터가 없습니다.</p>}
                    <p className="hint small">구간별 건수가 적으면(5건 미만) 해석하지 마세요. "어떤 조건에서 특히 약한가"를 찾아 필터로 만들 때 쓰는 표입니다.</p>
                  </>
                )}
              </div>
            )}

            <h3>🔗 캔들 → 삼분할 연계</h3>
            <div className="lab-cards">
              <div className="lab-card"><b>{s.linkage.runsWithBlock}</b><span>4번째 캔들까지 간(고점 차단) 신호</span></div>
              <div className="lab-card"><b>{s.linkage.linked}</b><span>그중 삼분할 패턴이 이어진 수</span></div>
              <div className="lab-card"><b>{num(s.linkage.linkRate, 0, "%")}</b><span>연계율</span></div>
              <div className="lab-card"><b>{s.linkage.avgGapMin != null ? `${Math.round(s.linkage.avgGapMin)}분` : "—"}</b><span>상승 끝 → 삼분할 확정까지</span></div>
              <div className="lab-card"><b>{num(s.linkage.avgEmaGapPct, 1, "%")}</b><span>그때 전봉종가 EMA 이격</span></div>
            </div>
            <p className="hint small">
              연계율이 낮으면 "캔들 상승 뒤에 삼분할이 자연스럽게 이어진다"는 전제가 약하다는 뜻입니다. 이어진 경우의 삼분할 매수 성적은 위에서 [삼분할 연계 진입]을 눌러 보세요.
              ({s.linkage.linkedAnyEligible}건은 4번째 차단 여부와 무관하게 연계가 잡힘)
            </p>

            {!lab.isMirror && (
              <>
                <h4>이어서 한 시나리오: 캔들 매매 → 끝난 뒤 삼분할</h4>
                <p className="hint small">
                  위 순위표에서 <b>캔들 1차 진입</b> 변형을 하나 고르면, 그 변형 뒤에 아래 삼분할 변형을 이어서 한 합계를 계산합니다.
                  규칙(오너·카일 답변): 캔들 포지션이 <b>완전히 청산된 뒤에만</b> 삼분할 진입, 캔들 매매가 <b>손절로 끝났으면 그날 삼분할 금지</b>.
                </p>
                <div className="form-row">
                  <label>삼분할 변형
                    <select value={linkKey} onChange={(e) => setLinkKey(e.target.value)}>
                      {linkRows.map((r) => <option key={r.key} value={r.key}>{variantName(r)}</option>)}
                      {linkRows.length === 0 && <option value="L1A-1.5">삼분할1분할·손절A +1.5%</option>}
                    </select>
                  </label>
                  <span className="hint">선택된 캔들 변형: {selKey && selKey.endsWith("-e1") && !selKey.startsWith("L") ? selKey : "(위 표에서 캔들 1차 변형을 고르세요)"}</span>
                </div>
                {combined && (
                  <table className="result-table">
                    <tbody>
                      <tr><td>시나리오가 성립한 신호</td><td>{combined.n}건</td></tr>
                      <tr><td>캔들 매매만의 평균 순손익</td><td className={cls(combined.candleOnlyAvg)}>{sgn(combined.candleOnlyAvg)}</td></tr>
                      <tr><td>삼분할만의 평균 순손익</td><td className={cls(combined.linkOnlyAvg)}>{sgn(combined.linkOnlyAvg)}</td></tr>
                      <tr><td><b>이어서 한 합계 평균</b></td><td className={cls(combined.combinedAvg)}><b>{sgn(combined.combinedAvg)}</b> (총 {sgn(combined.combinedTotal)})</td></tr>
                      <tr><td>캔들이 손절이라 삼분할 건너뜀</td><td>{combined.skippedByLoss}건</td></tr>
                      <tr><td>캔들 포지션이 안 끝나 삼분할 못 함</td><td>{combined.skippedByOverlap}건</td></tr>
                    </tbody>
                  </table>
                )}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function variantName(r: LabVariantRow): string {
  if (r.kind === "link") return `삼분할 ${r.entryIdx}분할 · 손절 ${r.stopMode}(${r.stopMode === "A" ? "고정 −10%" : "EMA 기준"}) · +${r.tpPct}%`;
  return `매수 ${r.entryMode}(${LAB_ENTRY_LABEL[r.entryMode as LabEntryMode] ?? r.entryMode}) · 손절 ${r.stopMode}(${LAB_STOP_LABEL[r.stopMode as LabStopMode] ?? r.stopMode}) · +${r.tpPct}% · ${r.entryIdx === 2 ? "2차" : "1차"}`;
}

/** <tr> 안에서 <td>를 그대로 렌더하기 위한 얇은 래퍼(키 전달용). */
function FragmentCell({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
