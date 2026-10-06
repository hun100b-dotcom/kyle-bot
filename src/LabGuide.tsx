// =============================================================================
// src/LabGuide.tsx — [v0.66.0] 매매연구소 각 탭의 애니메이션 튜토리얼·가이드
// -----------------------------------------------------------------------------
// [오너 요청] "각 탭의 튜토리얼 및 가이드를 애니메이션 효과를 적용해서 구현"
// [구성]
//   · useGuide(tab)  : 탭을 처음 열면 가이드가 자동으로 뜨고(한 번만), [❓ 가이드] 버튼으로 언제든 다시 연다.
//   · GuideModal     : 하단에 떠 있는 안내 패널(화면을 가리지 않음) — 단계별 설명 + 움직이는 그림 + 실제 화면 요소 강조(맥박 테두리).
//   · 움직이는 그림(Scene): 패턴이 한 봉씩 그려지는 모습, 깔때기, 매수 방식 4가지, 손절선, 기대값 계산, 삼분할 연계 등.
//     타이머로 "프레임"을 올려 가며 보여 주는 방식이라 CSS가 단순하고, 시스템의 "동작 줄이기" 설정이면 애니메이션 없이 마지막 장면만 보여 준다.
// =============================================================================

import { useCallback, useEffect, useState, type ReactNode } from "react";

export type GuideTab = "result" | "live" | "signals" | "compare";

const KEY = (tab: string) => `capri-lab-guide-seen-${tab}`;

/** 탭 가이드 상태: 처음 방문이면 자동으로 열리고, 닫으면 다시 안 열린다(버튼으로는 언제든 다시 열기). */
export function useGuide(tab: GuideTab) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY(tab))) setOpen(true);
    } catch {
      /* 저장소를 못 쓰면 자동으로 열지 않는다 */
    }
  }, [tab]);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(KEY(tab), "1");
    } catch {
      /* 무시 */
    }
  }, [tab]);
  return { open, show, close };
}

export function GuideButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="mini gd-btn" onClick={onClick} title="이 탭 사용법을 애니메이션으로 보기">
      ❓ 가이드
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 프레임 타이머 (동작 줄이기 설정이면 마지막 프레임에 고정)
// ─────────────────────────────────────────────────────────────────────────────

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 0 … last 까지 stepMs마다 올라가고, 끝에서 잠깐 머문 뒤 처음으로 돌아간다. */
function useLoop(last: number, stepMs = 900, hold = 3): number {
  const [f, setF] = useState(reducedMotion() ? last : 0);
  useEffect(() => {
    if (reducedMotion()) { setF(last); return; }
    const id = setInterval(() => setF((x) => (x >= last + hold ? 0 : x + 1)), stepMs);
    return () => clearInterval(id);
  }, [last, stepMs, hold]);
  return Math.min(f, last);
}

// ─────────────────────────────────────────────────────────────────────────────
// 장면(그림) 모음 — 전부 SVG
// ─────────────────────────────────────────────────────────────────────────────

const G = "#3ddc97", R = "#ff6b81", B = "#4c82fb", Y = "#f7b955", T = "#f1f3f9", M = "#aeb4c7";

function Candle({ x, o, c, h, l, show, color, label, dy = 0 }: { x: number; o: number; c: number; h: number; l: number; show: boolean; color: string; label?: string; dy?: number }) {
  const top = Math.min(o, c), hgt = Math.max(2, Math.abs(o - c));
  return (
    <g className="gd-pop" style={{ opacity: show ? 1 : 0, transform: `translateY(${show ? 0 : 14}px)` }}>
      <line x1={x} x2={x} y1={h} y2={l} stroke={color} strokeWidth={2} />
      <rect x={x - 11} y={top} width={22} height={hgt} fill={color} rx={2} />
      {label && <text x={x} y={168 + dy} textAnchor="middle" fill={M} fontSize={12} fontWeight={700}>{label}</text>}
    </g>
  );
}

/** 패턴: 도지 → 1(관망) → 2(1차 신호) → 3(2차 신호) → 4(고점 차단) */
export function PatternScene() {
  const f = useLoop(7, 1000);
  const ema = "M10,120 C90,118 170,112 330,104";
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="패턴 애니메이션">
      <path d={ema} stroke={Y} strokeWidth={2} fill="none" opacity={0.8} />
      <text x={12} y={136} fill={Y} fontSize={11}>200 EMA</text>
      <Candle x={50} o={96} c={98} h={80} l={116} show={f >= 1} color={M} label="도지" />
      <Candle x={100} o={96} c={82} h={76} l={98} show={f >= 2} color={G} label="1 관망" />
      <Candle x={150} o={82} c={50} h={46} l={84} show={f >= 3} color={G} label="2 신호" />
      <Candle x={200} o={50} c={26} h={22} l={52} show={f >= 4} color={G} label="3 신호" />
      <Candle x={250} o={26} c={14} h={8} l={30} show={f >= 6} color={G} label="4 고점" />
      <g style={{ opacity: f >= 3 ? 1 : 0 }} className="gd-pop"><text x={150} y={36} textAnchor="middle" fill={B} fontSize={20}>↑</text><text x={150} y={28} textAnchor="middle" fill={B} fontSize={10}>1차 진입</text></g>
      <g style={{ opacity: f >= 5 ? 1 : 0 }} className="gd-pop"><text x={200} y={16} textAnchor="middle" fill={B} fontSize={10}>2차(수익권일 때만)</text></g>
      <g style={{ opacity: f >= 7 ? 1 : 0 }} className="gd-pop"><text x={290} y={22} fill={R} fontSize={22}>✋</text><text x={290} y={40} fill={R} fontSize={10}>추격 금지</text></g>
    </svg>
  );
}

/** 깔때기: 단계가 갈수록 줄어드는 막대 */
export function FunnelScene() {
  const f = useLoop(8, 650);
  const rows: Array<[string, number]> = [["도지 발견", 100], ["1번째 양봉", 46], ["2번째 양봉", 31], ["몸통 ≥ 60%", 12], ["거래량·크기 OK", 4], ["3번째 인정", 1.5]];
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="깔때기 애니메이션">
      {rows.map(([t, w], i) => (
        <g key={t}>
          <text x={8} y={24 + i * 28} fill={T} fontSize={12}>{t}</text>
          <rect x={110} y={12 + i * 28} width={215} height={14} rx={7} fill="rgba(255,255,255,0.07)" />
          <rect x={110} y={12 + i * 28} width={f > i ? Math.max(6, (w / 100) * 215) : 0} height={14} rx={7} fill={i >= 4 ? G : B} className="gd-grow" />
        </g>
      ))}
    </svg>
  );
}

/** 매수 방식 4가지: 신호 봉 위의 4개 가격선 */
export function EntryScene() {
  const f = useLoop(5, 1100);
  const lines: Array<[string, number, string, string]> = [
    ["C 고가 돌파", 30, B, "위로 더 가야 체결"],
    ["B 종가", 50, G, "바로 체결 (추격)"],
    ["D 몸통 50%", 82, Y, "조금 눌려야 체결"],
    ["A 저가+3틱", 128, R, "봉 전체를 되돌려야 → 잘 안 닿음"],
  ];
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="매수 방식 애니메이션">
      <line x1={46} x2={46} y1={20} y2={136} stroke={G} strokeWidth={2} />
      <rect x={34} y={46} width={24} height={86} fill={G} rx={2} />
      <text x={46} y={160} textAnchor="middle" fill={M} fontSize={11}>신호 봉(2번째)</text>
      {lines.map(([t, y, c, note], i) => (
        <g key={t} style={{ opacity: f > i ? 1 : 0 }} className="gd-pop">
          <line x1={64} x2={330} y1={y} y2={y} stroke={c} strokeDasharray="5 4" />
          <text x={70} y={y - 4} fill={c} fontSize={12} fontWeight={700}>{t}</text>
          <text x={330} y={y - 4} textAnchor="end" fill={M} fontSize={10}>{note}</text>
        </g>
      ))}
      <g style={{ opacity: f >= 5 ? 1 : 0 }} className="gd-pop"><text x={170} y={182} textAnchor="middle" fill={T} fontSize={11}>→ 어느 쪽이 실제로 이기는지는 데이터가 정합니다</text></g>
    </svg>
  );
}

/** 손절선: EMA와 4가지 손절 위치 + 가격이 떨어져 손절되는 모습 */
export function StopScene() {
  const f = useLoop(6, 1000);
  const dropY = f >= 5 ? 128 : 60;
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="손절 애니메이션">
      <path d="M10,92 L330,92" stroke={Y} strokeWidth={2} />
      <text x={12} y={86} fill={Y} fontSize={11}>200 EMA</text>
      <circle cx={70} cy={60} r={5} fill={B} />
      <text x={80} y={56} fill={B} fontSize={11}>진입</text>
      {[["C 신호봉 저가 아래", 76, G], ["B EMA 아래 1.5%", 100, Y], ["A 고정 −10%", 150, R]].map(([t, y, c], i) => (
        <g key={String(t)} style={{ opacity: f > i ? 1 : 0 }} className="gd-pop">
          <line x1={110} x2={330} y1={Number(y)} y2={Number(y)} stroke={String(c)} strokeDasharray="4 4" />
          <text x={116} y={Number(y) - 4} fill={String(c)} fontSize={11}>{String(t)}</text>
        </g>
      ))}
      <g style={{ opacity: f >= 4 ? 1 : 0 }} className="gd-pop"><text x={170} y={178} fill={T} fontSize={11}>D = C와 B 중 높은 쪽 → 근거가 깨지면 바로 나감</text></g>
      <circle cx={300} cy={dropY} r={6} fill={f >= 5 ? R : B} className="gd-move" />
      {f >= 5 && <text x={258} y={dropY + 20} fill={R} fontSize={11}>손절!</text>}
    </svg>
  );
}

/** 기대값: 10번의 신호가 체결·익절·손절·미체결로 나뉘고 평균이 나오는 과정 */
export function ExpectScene() {
  const f = useLoop(11, 450);
  const kinds = ["win", "win", "none", "win", "loss", "none", "win", "none", "win", "loss"] as const;
  const col = { win: G, loss: R, none: "rgba(255,255,255,0.18)" } as const;
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="기대값 애니메이션">
      {kinds.map((k, i) => (
        <g key={i} style={{ opacity: f > i ? 1 : 0.12 }} className="gd-pop">
          <circle cx={30 + i * 31} cy={40} r={11} fill={col[k]} />
          <text x={30 + i * 31} y={44} textAnchor="middle" fontSize={11} fill="#0c0e13" fontWeight={700}>{k === "win" ? "+" : k === "loss" ? "−" : "·"}</text>
        </g>
      ))}
      <text x={30} y={76} fill={M} fontSize={11}>신호 10번 → 체결 7번(미체결 3번은 0으로 계산)</text>
      <g style={{ opacity: f >= 10 ? 1 : 0 }} className="gd-pop">
        <text x={30} y={104} fill={G} fontSize={12}>익절 5번 × (+1.2%) = +6.0%</text>
        <text x={30} y={124} fill={R} fontSize={12}>손절 2번 × (−4.9%) = −9.8%</text>
        <text x={30} y={150} fill={T} fontSize={13} fontWeight={700}>합계 −3.8% ÷ 신호 10번 = 신호당 −0.38%</text>
        <text x={30} y={172} fill={M} fontSize={11}>승률 71%여도 손실이 크면 기대값은 마이너스!</text>
      </g>
    </svg>
  );
}

/** 연계: 상승 → 고점 → 눌림 → 삼분할 매수 */
export function LinkScene() {
  const f = useLoop(6, 1000);
  const len = 520;
  const prog = [0, 0.3, 0.55, 0.75, 1, 1, 1][f] ?? 1;
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="연계 애니메이션">
      <path d="M10,150 L330,150" stroke={Y} strokeWidth={1.5} opacity={0.7} />
      <text x={12} y={166} fill={Y} fontSize={11}>200 EMA</text>
      <polyline points="20,140 70,128 110,70 150,40 190,22 230,70 270,96 300,110" fill="none" stroke={T} strokeWidth={2.5} strokeDasharray={len} strokeDashoffset={len * (1 - prog)} className="gd-draw" />
      <g style={{ opacity: f >= 2 ? 1 : 0 }} className="gd-pop"><text x={110} y={62} fill={G} fontSize={11}>캔들 매매(상승)</text></g>
      <g style={{ opacity: f >= 3 ? 1 : 0 }} className="gd-pop"><circle cx={190} cy={22} r={5} fill={R} /><text x={198} y={18} fill={R} fontSize={11}>4번째 = 고점</text></g>
      <g style={{ opacity: f >= 4 ? 1 : 0 }} className="gd-pop"><text x={226} y={60} fill={M} fontSize={10}>도지·음봉 확인</text></g>
      <g style={{ opacity: f >= 5 ? 1 : 0 }} className="gd-pop">
        <circle cx={270} cy={96} r={5} fill={B} /><circle cx={300} cy={110} r={5} fill={B} />
        <text x={236} y={134} fill={B} fontSize={11}>삼분할 1·2분할 매수</text>
      </g>
    </svg>
  );
}

/** 표 읽기: 줄 → 칸이 차례로 강조 */
export function ReadScene({ cols }: { cols: string[] }) {
  const f = useLoop(cols.length, 1100);
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="표 읽는 법 애니메이션">
      {cols.map((c, i) => {
        const w = 340 / cols.length;
        return (
          <g key={c}>
            <rect x={i * w + 2} y={18} width={w - 4} height={30} rx={6} fill={f === i + 1 ? B : "rgba(255,255,255,0.08)"} className="gd-fade" />
            <text x={i * w + w / 2} y={37} textAnchor="middle" fill={f === i + 1 ? "#fff" : T} fontSize={11} fontWeight={700}>{c}</text>
            <rect x={i * w + 2} y={58} width={w - 4} height={26} rx={6} fill="rgba(255,255,255,0.05)" />
            <rect x={i * w + 2} y={90} width={w - 4} height={26} rx={6} fill="rgba(255,255,255,0.05)" />
          </g>
        );
      })}
      <text x={170} y={156} textAnchor="middle" fill={M} fontSize={12}>{f >= 1 && f <= cols.length ? `▲ ${cols[f - 1]} 칸을 보세요` : "한 칸씩 살펴봅니다"}</text>
    </svg>
  );
}

/** 스위치 + 5분 스캔 맥박 */
export function ToggleScene() {
  const f = useLoop(5, 1000);
  const on = f >= 2;
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="켜기 애니메이션">
      <rect x={30} y={30} width={86} height={40} rx={20} fill={on ? G : "rgba(255,255,255,0.15)"} className="gd-fade" />
      <circle cx={on ? 96 : 50} cy={50} r={16} fill="#fff" className="gd-move" />
      <text x={130} y={56} fill={on ? G : M} fontSize={14} fontWeight={700}>{on ? "🟢 기록 중" : "⚪ 꺼짐"}</text>
      {[0, 1, 2].map((i) => (
        <g key={i} style={{ opacity: on && f >= 3 + (i === 2 ? 1 : 0) ? 1 : 0.1 }} className="gd-pop">
          <circle cx={60 + i * 90} cy={130} r={on && f % 2 ? 20 : 14} fill="none" stroke={B} strokeWidth={2} className="gd-move" />
          <text x={60 + i * 90} y={135} textAnchor="middle" fill={T} fontSize={12}>{["순위 훑기", "패턴 찾기", "로우 저장"][i]}</text>
        </g>
      ))}
      <text x={170} y={178} textAnchor="middle" fill={M} fontSize={11}>켜 두면 5분마다 자동 · 주문은 전혀 내지 않음</text>
    </svg>
  );
}

/** 검증 체크리스트가 하나씩 체크되는 모습 */
export function VerifyScene() {
  const f = useLoop(5, 800);
  const items = ["봉이 5분 간격으로 이어짐", "몸통·거래량 다시 계산해 일치", "가격이 정상(고≥시·종≥저)", "토스에서 다시 받아 대조"];
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="검증 애니메이션">
      {items.map((t, i) => (
        <g key={t}>
          <circle cx={26} cy={34 + i * 34} r={11} fill={f > i ? G : "rgba(255,255,255,0.12)"} className="gd-fade" />
          <text x={26} y={39 + i * 34} textAnchor="middle" fill="#0c0e13" fontSize={13} fontWeight={800}>{f > i ? "✓" : ""}</text>
          <text x={48} y={39 + i * 34} fill={f > i ? T : M} fontSize={13}>{t}</text>
        </g>
      ))}
    </svg>
  );
}

/** 신뢰도 게이지 */
export function GaugeScene() {
  const f = useLoop(5, 900);
  const v = [0, 12, 30, 60, 100, 100][f] ?? 100;
  const color = v < 30 ? R : v < 100 ? Y : G;
  return (
    <svg viewBox="0 0 340 190" className="gd-scene" role="img" aria-label="신뢰도 게이지 애니메이션">
      <rect x={20} y={60} width={300} height={22} rx={11} fill="rgba(255,255,255,0.08)" />
      <rect x={20} y={60} width={(v / 100) * 300} height={22} rx={11} fill={color} className="gd-grow" />
      <line x1={20 + 0.3 * 300} x2={20 + 0.3 * 300} y1={50} y2={92} stroke={T} strokeDasharray="3 3" />
      <text x={20 + 0.3 * 300} y={44} textAnchor="middle" fill={M} fontSize={10}>30건</text>
      <text x={320} y={44} textAnchor="end" fill={M} fontSize={10}>100건</text>
      <text x={170} y={128} textAnchor="middle" fill={color} fontSize={18} fontWeight={800}>{v < 30 ? "🔴 표본 부족" : v < 100 ? "🟡 참고용" : "🟢 판단 가능"}</text>
      <text x={170} y={156} textAnchor="middle" fill={M} fontSize={11}>인정 신호가 쌓일수록 결론을 믿을 수 있어요</text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 단계 정의
// ─────────────────────────────────────────────────────────────────────────────

interface Step {
  title: string;
  body: ReactNode;
  scene: ReactNode;
  target?: string; //  data-guide 값 — 실제 화면 요소를 맥박 테두리로 강조
}

function stepsFor(tab: GuideTab): Step[] {
  if (tab === "result")
    return [
      { title: "① 이 화면은 '결론'만 모아 둔 곳이에요", body: <>다른 탭의 숫자를 한 장으로 요약했습니다. 맨 위 <b>신호등</b>은 "지금 결론을 믿어도 되는가"를 알려 줘요. 🔴 표본 부족 → 🟡 참고용 → 🟢 판단 가능 순서이고, 인정 신호가 30건·100건이 되면 단계가 올라갑니다.</>, scene: <GaugeScene />, target: "result-grade" },
      { title: "② 한 줄 결론과 핵심 숫자", body: <>노란 카드의 문장이 지금 시점의 결론이고, 아래 큰 숫자 카드는 <b>누적 신호 · 인정 신호 · 1위 조합의 기대값 · 승률 · 체결률</b>이에요. 숫자는 새로 쌓일 때마다 움직입니다.</>, scene: <ExpectScene />, target: "result-headline" },
      { title: "③ 매수·손절·익절, 뭐가 나은가", body: <>세 묶음의 막대가 <b>선택지별 신호당 기대값</b>입니다. 오른쪽(초록)으로 길수록 평균적으로 이득, 왼쪽(빨강)이면 손해예요. 👑는 현재 1등, 옆 배지는 확신도(뚜렷/비슷/자료 부족)입니다. "비슷"이면 우열을 가리지 마세요.</>, scene: <EntryScene />, target: "result-dims" },
      { title: "④ 카일 질문 답변판 · 연계 흐름", body: <>카일에게 물어야 했던 4가지 질문에 <b>지금 데이터가 가리키는 답</b>을 적어 두었어요. 아래 흐름도는 "캔들 상승 → 고점 → 삼분할"이 실제로 얼마나 이어지는지 보여 줍니다.</>, scene: <LinkScene />, target: "result-qa" },
      { title: "⑤ 이 데이터, 진짜 맞나요? — 검증 버튼", body: <><b>데이터 검증</b>을 누르면 ① 저장된 로우를 규칙대로 다시 계산해 맞는지 ② 표본 신호를 토스에서 지금 다시 받아 값이 같은지 확인해요. 의심스러울 때, 또 정기적으로 눌러 보세요.</>, scene: <VerifyScene />, target: "result-verify" },
    ];
  if (tab === "live")
    return [
      { title: "① 어떤 전략을 기록하나요?", body: <>도지가 나온 뒤 <b>양봉이 연속</b>되는 패턴을 찾습니다. 1번째는 관망, 2·3번째가 조건(몸통 ≥60% + 거래량 ≥150% + 일정 크기)을 채우면 진입 신호, 4번째 양봉은 단기 고점이라 추격 금지예요. 이후 삼분할이 이어받는지도 봅니다.</>, scene: <PatternScene /> },
      { title: "② 켜기만 하면 알아서 모읍니다", body: <><b>신호 기록 켜기</b>를 누르면 이 앱이 켜져 있는 동안 5분마다 거래량 순위를 훑고 패턴을 저장해요. <b>주문은 절대 내지 않습니다.</b> "지금 스캔"은 과거 데이터까지 한꺼번에 채웁니다.</>, scene: <ToggleScene />, target: "live-toggle" },
      { title: "③ 탐색 설정", body: <>거래량 순위를 몇 위까지 볼지, 도지 몸통·신호 몸통·거래량 배수·최소 봉 크기 기준을 바꿀 수 있어요. 바꿔도 이미 쌓인 데이터는 그대로 두고 새 신호부터 새 기준으로 판정합니다.</>, scene: <ReadScene cols={["순위", "도지", "몸통", "거래량", "봉 크기"]} />, target: "live-settings" },
      { title: "④ 깔때기로 병목 찾기", body: <>도지가 많이 보여도 끝까지 살아남는 건 극소수예요. 막대가 어디서 급격히 줄어드는지 보면 <b>어떤 조건이 가장 까다로운지</b> 알 수 있습니다. 인정 신호 수는 아래 데이터 현황에서 확인하세요.</>, scene: <FunnelScene />, target: "live-funnel" },
      { title: "⑤ 내보내기와 검증", body: <>CSV·JSON으로 내려받아 엑셀 등에서 따로 분석할 수 있어요. 데이터가 의심스러우면 [🏁 결과 요약] 탭의 <b>데이터 검증</b>을 눌러 보세요.</>, scene: <VerifyScene />, target: "live-export" },
    ];
  if (tab === "signals")
    return [
      { title: "① 한 줄 = 신호 한 건", body: <>시각·종목·순위·세션, 그리고 신호 봉의 <b>몸통·봉 크기·거래량 배수·EMA 이격</b>이 보여요. 빨간 ✗는 인정 기준에 못 미친 칸입니다(그래서 흐리게 표시).</>, scene: <ReadScene cols={["시각", "종목", "몸통", "거래량", "결과"]} />, target: "signals-table" },
      { title: "② 기준 변형으로 결과 보기", body: <>맨 오른쪽 결과는 <b>"기준 변형"</b>(매수 방식·손절·익절 조합)으로 가상 매매했을 때의 결과예요. 위의 세 선택칸을 바꾸면 모든 줄이 그 조합으로 다시 계산됩니다.</>, scene: <EntryScene />, target: "signals-ref" },
      { title: "③ 줄을 눌러 차트로 확인", body: <>줄을 누르면 캔들 차트가 열려요. 회색 띠가 패턴 구간, 노란선이 EMA200, 파란 점이 체결, 점선이 체결가·손절·익절입니다. 정말 규칙대로 잡혔는지 눈으로 확인할 수 있어요.</>, scene: <PatternScene /> },
      { title: "④ 모든 변형의 개별 결과", body: <>차트 아래 표에는 이 신호 하나에 대한 약 100가지 변형의 결과가 있어요. 행을 누르면 차트에 그 변형의 체결·손절·익절선이 그려집니다. "체결된 것만" 체크로 미체결은 숨길 수 있어요.</>, scene: <StopScene /> },
    ];
  return [
    { title: "① 기대값이 가장 중요한 숫자", body: <><b>신호당 기대값</b> = 신호 하나가 나왔을 때 평균적으로 남기는 순손익(%)이에요. 체결 안 된 신호는 0으로 계산하므로, 승률만 높고 체결이 안 되는 방식은 낮게 나옵니다.</>, scene: <ExpectScene /> },
    { title: "② 매수 × 손절 매트릭스", body: <>세로는 매수 방식, 가로는 손절 방식이에요. 칸의 큰 숫자가 기대값, 아래 글자는 체결 수·승률입니다. 초록 칸이 많은 줄/열이 안정적으로 좋은 선택이에요. 흐린 칸은 체결이 적어 믿기 어렵습니다.</>, scene: <EntryScene />, target: "compare-matrix" },
    { title: "③ 손절선은 어디가 좋은가", body: <>고정 −10%는 근거가 깨져도 오래 버티고, EMA 기준은 근거가 깨지면 바로 나갑니다. 순위표에서 <b>평균 손절폭</b>과 기대값을 같이 보세요 — 손절폭이 작으면서 기대값이 높은 조합이 이상적이에요.</>, scene: <StopScene />, target: "compare-table" },
    { title: "④ 캔들 → 삼분할 연계", body: <>아래쪽 연계 카드는 캔들 상승이 끝난 뒤 삼분할 패턴이 실제로 이어진 비율이에요. 이어진 경우 "캔들 매매 → 삼분할"을 연달아 했을 때의 합계도 계산할 수 있습니다(캔들이 손절이면 삼분할 건너뜀).</>, scene: <LinkScene />, target: "compare-link" },
    { title: "⑤ 숫자를 믿는 법", body: <>변형이 100개가 넘으면 우연히 좋아 보이는 조합이 생겨요. <b>1위와 2~3위 차이가 작으면 단정하지 마세요.</b> 표본이 적을 땐(인정 신호 30건 미만) 참고만 하고, 결과 요약 탭의 신호등을 먼저 확인하세요.</>, scene: <GaugeScene /> },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 가이드 패널
// ─────────────────────────────────────────────────────────────────────────────

export function GuideModal({ tab, open, onClose }: { tab: GuideTab; open: boolean; onClose: () => void }) {
  const steps = stepsFor(tab);
  const [i, setI] = useState(0);
  const cur = steps[Math.min(i, steps.length - 1)];

  // 열릴 때마다 처음부터
  useEffect(() => { if (open) setI(0); }, [open, tab]);

  // 실제 화면 요소 강조(맥박 테두리) + 부드럽게 스크롤
  useEffect(() => {
    if (!open || !cur.target) return;
    const el = document.querySelector<HTMLElement>(`[data-guide="${cur.target}"]`);
    if (!el) return;
    el.classList.add("gd-spot");
    try { el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" }); } catch { /* 무시 */ }
    return () => el.classList.remove("gd-spot");
  }, [open, cur.target, i]);

  // Esc로 닫기, ←/→로 이동
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((x) => Math.min(steps.length - 1, x + 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, steps.length]);

  if (!open) return null;
  const last = i >= steps.length - 1;
  return (
    <div className="gd-panel" role="dialog" aria-label="매매연구소 가이드">
      <div className="gd-head">
        <b>🎓 가이드 {i + 1}/{steps.length}</b>
        <button className="mini ghost" onClick={onClose} aria-label="닫기">✕ 닫기</button>
      </div>
      <div className="gd-scene-wrap" key={i}>{cur.scene}</div>
      <h4 className="gd-title">{cur.title}</h4>
      <p className="gd-body">{cur.body}</p>
      <div className="gd-foot">
        <span className="gd-dots">
          {steps.map((_, k) => (
            <button key={k} className={k === i ? "gd-dot on" : "gd-dot"} onClick={() => setI(k)} aria-label={`${k + 1}단계로`} />
          ))}
        </span>
        <span className="gd-nav">
          <button className="mini" disabled={i === 0} onClick={() => setI(i - 1)}>← 이전</button>
          {last ? <button className="mini active" onClick={onClose}>완료 ✓</button> : <button className="mini active" onClick={() => setI(i + 1)}>다음 →</button>}
        </span>
      </div>
    </div>
  );
}
