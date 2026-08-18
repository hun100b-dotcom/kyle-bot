// =============================================================================
// src/TodayReport.tsx — "오늘의 매매 리포트" 화면 (토스 스타일 + 부드러운 애니메이션)
// -----------------------------------------------------------------------------
// [사장님 요청] "오늘 매매를 한눈에. 익절/손절 몇 번, 오늘의 1등 종목,
//   얼마나 어떻게 먹었는지 — 가시성 좋게, 애니메이션 섞어서 토스 형식으로."
//
// [무엇을 보여 주나 — 위에서부터]
//   ① 오늘 실현 손익(가장 큰 숫자, 0에서부터 올라가는 카운트업)
//   ② 익절 / 손절 / 수동정리 / 승률 배지
//   ③ 👑 오늘의 1등 종목(가장 잘 먹은 한 방)
//   ④ 종목별 성적(막대가 스르륵 자라남, 이익 초록 / 손실 빨강)
//
// [숫자 계산은 여기서 하지 않는다] 집계는 lib/report.ts(순수 함수)가 하고,
//   이 파일은 '보여 주기'만 한다 → PC와 폰이 같은 숫자를 보게 된다.
// =============================================================================

import { useEffect, useRef, useState } from "react";

/**
 * useCountUp — 0에서 목표값까지 스르륵 올라가는 숫자 효과(토스 앱 느낌).
 *
 *   [왜 직접 만들었나?] 애니메이션 라이브러리를 새로 넣지 않기 위해서입니다
 *   (실계좌를 다루는 앱이라 외부 코드를 최소로 유지합니다).
 *   화면 주사율에 맞춰 그리고(requestAnimationFrame), 마지막에는 **정확한 값**으로 맞춥니다.
 */
function useCountUp(target: number | null, ms = 900): number {
  const [v, setV] = useState(0);
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (target == null) {
      setV(0);
      return;
    }

    // [안전장치 ①] 움직임을 줄이는 설정이거나 화면이 숨겨져 있으면 **바로 정확한 값**을 보여 준다.
    //   화면이 안 보일 때 브라우저는 애니메이션 타이머를 멈춰 버린다. 그때 0에 머물면
    //   "오늘 +$0.00 벌었다"처럼 **틀린 금액**이 보인다 — 돈을 다루는 화면에서는 절대 안 된다.
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || document.visibilityState !== "visible") {
      setV(target);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3); // 처음 빠르게 → 끝에서 부드럽게
      setV(target * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setV(target); // 끝은 정확히
    };
    raf.current = requestAnimationFrame(tick);

    // [안전장치 ②] 혹시 애니메이션 타이머가 한 번도 안 돌아도, 시간이 지나면 정확한 값으로 맞춘다.
    const failSafe = setTimeout(() => setV(target), ms + 300);

    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      clearTimeout(failSafe);
    };
  }, [target, ms]);

  return v;
}

/** 달러 표기(부호 분리 — 색과 함께 크게 보여 주기 위해) */
function money(v: number): string {
  return `$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TodayReport({
  data,
  busy,
  fx,
  onRefresh,
  period,
  pickedDate,
  onPeriod,
}: {
  data: DailyReport | null;
  busy: boolean;
  fx: number | null;
  onRefresh: () => void;
  period: PeriodKind; //     지금 보고 있는 기간
  pickedDate: string; //     날짜 선택일 때의 날짜(yyyy-MM-dd)
  onPeriod: (kind: PeriodKind, picked?: string) => void; // 기간 바꾸기
}) {
  const pnl = data?.totalPnlUsd ?? null;
  const shownPnl = useCountUp(pnl);
  const shownPct = useCountUp(data?.avgPct ?? null);
  const positive = (pnl ?? data?.avgPct ?? 0) >= 0;

  /** 기간 고르는 줄(오늘 / 1주일 / 1개월 / 날짜) — 빈 상태에서도 보여야 하므로 함수로 뺀다 */
  const periodBar = (
    <section className="card wide report-period">
      <div className="rp-tabs">
        {([
          ["today", "오늘"],
          ["week", "1주일"],
          ["month", "1개월"],
        ] as const).map(([k, label]) => (
          <button key={k} className={period === k ? "on" : ""} onClick={() => onPeriod(k)} disabled={busy}>
            {label}
          </button>
        ))}
        <button className={period === "date" ? "on" : ""} onClick={() => onPeriod("date", pickedDate)} disabled={busy}>
          날짜 선택
        </button>
      </div>
      {period === "date" && (
        <input
          className="rp-date"
          type="date"
          value={pickedDate}
          max={new Date().toISOString().slice(0, 10)} // 미래 날짜는 고를 수 없다(아직 없는 기록)
          onChange={(e) => onPeriod("date", e.target.value)}
        />
      )}
      <div className="rp-label">
        조회 기간: <b>{data?.periodLabel ?? "오늘"}</b>
      </div>
    </section>
  );

  // ── 빈 상태: 고른 기간에 판 거래가 없음 ────────────────────────
  if (!busy && (!data || data.closed === 0)) {
    return (
      <main className="grid report">
        {periodBar}
        <section className="card wide report-empty">
          <div className="report-empty-emoji">🌤️</div>
          <h2>{data?.periodLabel ?? "오늘"} 정리된 거래가 없어요</h2>
          <p className="hint">
            익절·손절이나 매도가 이루어지면, 여기에 <b>오늘 얼마를 어떻게 벌었는지</b> 한눈에 정리해 드립니다.
            {data && data.openNow > 0 && (
              <>
                <br />
                지금 <b>{data.openNow}건</b>을 들고 계세요 — 파는 순간 이 화면에 기록됩니다.
              </>
            )}
          </p>
          <button className="mini" onClick={onRefresh} disabled={busy}>
            ↻ 새로고침
          </button>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="grid">
        <section className="card wide">
          <p className="hint">불러오는 중…</p>
        </section>
      </main>
    );
  }

  // 막대 길이 기준(가장 큰 수익률을 100%로 잡는다)
  const maxPct = Math.max(...data.rows.map((r) => Math.abs(r.pctAvg)), 1);

  return (
    <main className="grid report">
      {periodBar}

      {/* ① 번 돈 — 가장 크게 */}
      <section className="card wide report-hero">
        <div className="report-hero-label">{data.periodLabel} 실현 손익</div>
        <div className={`report-hero-num ${positive ? "up" : "down"}`}>
          {pnl != null
            ? `${pnl >= 0 ? "+" : "−"}${money(shownPnl)}`
            : `${shownPct >= 0 ? "+" : "−"}${Math.abs(shownPct).toFixed(2)}%`}
        </div>
        <div className="report-hero-sub">
          {pnl != null && fx != null && (
            <span className="won">
              {pnl >= 0 ? "+" : "−"}₩{Math.abs(Math.round(pnl * fx)).toLocaleString("ko-KR")} ·{" "}
            </span>
          )}
          평균 수익률{" "}
          <b className={positive ? "up" : "down"}>
            {data.avgPct != null ? `${data.avgPct >= 0 ? "+" : ""}${data.avgPct}%` : "—"}
          </b>
          {pnl == null && <span className="hint"> · 수량 정보가 없는 옛 기록이라 금액은 생략</span>}
        </div>
        <button className="mini report-refresh" onClick={onRefresh} disabled={busy}>
          ↻ 새로고침
        </button>
      </section>

      {/* ② 익절 / 손절 / 수동 / 승률 */}
      <section className="card wide report-badges">
        <div className="report-badge win">
          <div className="rb-num">{data.tpCount}</div>
          <div className="rb-label">익절</div>
        </div>
        <div className="report-badge loss">
          <div className="rb-num">{data.slCount}</div>
          <div className="rb-label">손절</div>
        </div>
        <div className="report-badge">
          <div className="rb-num">{data.manualCount}</div>
          <div className="rb-label">수동 정리</div>
        </div>
        <div className="report-badge">
          <div className="rb-num">{data.winRate != null ? `${data.winRate}%` : "—"}</div>
          <div className="rb-label">
            승률 ({data.wins}승 {data.losses}패)
          </div>
        </div>
      </section>

      {/* ③ 오늘의 1등 */}
      {data.best && (
        <section className="card wide report-best">
          <div className="report-best-crown">👑 오늘의 1등</div>
          <div className="report-best-row">
            <b className="report-best-sym">{data.best.symbol}</b>
            <span className={`report-best-pct ${data.best.pctBest >= 0 ? "up" : "down"}`}>
              {data.best.pctBest >= 0 ? "+" : ""}
              {data.best.pctBest}%
            </span>
          </div>
          <div className="hint">
            {data.best.trades}회 매매 · {data.best.wins}승 {data.best.losses}패
            {data.best.pnlUsd != null &&
              ` · 실현 ${data.best.pnlUsd >= 0 ? "+" : "−"}${money(data.best.pnlUsd)}`}
          </div>
        </section>
      )}

      {/* ④ 종목별로 얼마 어떻게 먹었나 */}
      <section className="card wide">
        <h2>종목별 성적</h2>
        <div className="report-rows">
          {data.rows.map((r, i) => (
            // animationDelay: 한 줄씩 차례로 나타나게(계단식 등장)
            <div className="report-row" key={r.symbol} style={{ animationDelay: `${i * 70}ms` }}>
              <div className="rr-head">
                <b>{r.symbol}</b>
                <span className={`rr-pct ${r.pctAvg >= 0 ? "up" : "down"}`}>
                  {r.pctAvg >= 0 ? "+" : ""}
                  {r.pctAvg}%
                </span>
              </div>
              <div className="rr-bar-wrap">
                <div
                  className={`rr-bar ${r.pctAvg >= 0 ? "up" : "down"}`}
                  style={{ width: `${(Math.abs(r.pctAvg) / maxPct) * 100}%` }}
                />
              </div>
              <div className="rr-meta hint">
                {r.trades}회 · {r.wins}승 {r.losses}패
                {r.pnlUsd != null ? ` · ${r.pnlUsd >= 0 ? "+" : "−"}${money(r.pnlUsd)}` : " · 금액 정보 없음"}
                {r.trades > 1 && ` · 최고 ${r.pctBest >= 0 ? "+" : ""}${r.pctBest}%`}
              </div>
            </div>
          ))}
        </div>
        <p className="hint report-note">
          <b>{data.periodLabel}</b> 동안 <b>실제로 판 거래</b>만 셉니다(연습·모의 기록 제외).
          아직 들고 있는 {data.openNow}건은 판 뒤에 반영됩니다.
          {data.periodKind === "week" && " · 1주일 = 오늘 포함 최근 7일"}
          {data.periodKind === "month" && " · 1개월 = 오늘 포함 최근 30일"}
        </p>
      </section>
    </main>
  );
}
