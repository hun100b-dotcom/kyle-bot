// =============================================================================
// lib/lab.ts — [v0.65.0] 매매연구소: "연속 상승 캔들 매매기법" 신호 탐지 + 가상 매매 시뮬레이션 + 집계
// -----------------------------------------------------------------------------
// [무엇을 하는 파일인가]  (순수 함수 — 파일·네트워크 없음, 그래서 테스트로 규칙을 고정할 수 있다)
//   카일 제안 전략(도지 → 연속 양봉 돌파 → 4번째 캔들 고점 → 삼분할로 연계)을 **주문 없이** 검증한다.
//     1) detectRuns      : 5분봉(하이킨아시)에서 "도지 → 1·2·3·4번째 캔들" 패턴을 찾는다.
//     2) buildSignal     : 신호 한 건의 "로우 데이터"(캔들·지표·1분봉 경로)를 만든다.
//     3) findLinkage     : 캔들 상승 구간이 끝난 뒤, 기존 삼분할 패턴(고점→도지→음봉)이 이어졌는지 찾는다.
//     4) simulateSignal  : 로우 데이터만으로 "가상 매수→청산"을 여러 변형(매수 방식×손절×익절)으로 계산한다.
//     5) summarize*      : 변형별 승률·손익비·기대값, 조건별 분해, 연계 시나리오를 집계한다.
//
// [설계 원칙 — 오너 지시 "쓸데없는 데이터는 필요 없다, 로우를 쌓고 로우로 정리"]
//   · 저장하는 것은 "로우"(신호 당시 캔들·지표 + 이후 1분봉 경로)뿐이다. 가상 매매 결과는 저장하지 않고
//     로우에서 언제든 다시 계산한다 → 규칙(체결 가정·수수료 등)을 바꿔도 과거 데이터를 버릴 필요가 없다.
//   · 체결 가정은 일부러 보수적이다(지정가는 "호가를 뚫고 지나가야" 체결, 손절·익절이 같은 봉이면 손절 먼저,
//     손절은 갭이 나면 시가로 체결). 가상 성과가 실제보다 좋게 나오는 착시를 막기 위해서다.
// =============================================================================

import { roundPrice, getTick, calcSplit3 } from "./calc";
import { scanSessionPattern, toHeikinAshi as toHA, type Candle } from "./indicators";
import { structuralStopPrice, atrPct, emaSlopePct } from "./defense";

const MIN = 60_000;
const FIVE = 5 * MIN;

// ─────────────────────────────────────────────────────────────────────────────
// 1) 파라미터·상수
// ─────────────────────────────────────────────────────────────────────────────

/** 탐지·시뮬레이션 기준값. (오너·카일 합의: 도지 몸통 <15%, 신호 몸통 ≥60%, 거래량 직전5평균의 150%) */
export interface LabParams {
  dojiBodyMaxPct: number; //  도지 몸통 비율 상한(%, 색 무관) — 이미지 기준 15
  bodyMinPct: number; //      신호 캔들 몸통 비율 하한(%) — 60
  volRatioMin: number; //     신호 캔들 거래량 ÷ 직전 5개 평균 — 1.5
  volLookback: number; //     거래량 평균에 쓰는 직전 봉 수(신호 봉 제외) — 5
  fillWindowMin: number; //   신호 봉 마감 후 매수 주문이 유효한 시간(분) — 15(=3개 봉)
  linkFillWindowMin: number; // 삼분할 연계 매수 주문 유효 시간(분) — 10(자동매매 미체결 취소 기준과 동일)
  horizonMin: number; //      진입 후 최대 관찰 시간(분) — 180
  feeRoundTripPct: number; // 왕복 수수료 추정(%) — 0.2
  fixedSlPct: number; //      고정 손절 비율(%) — 10(현재 기본값)
  emaBufferPct: number; //    EMA 기준 손절의 EMA 아래 여유(%) — 1.5
}

export const LAB_PARAMS_DEFAULT: LabParams = {
  dojiBodyMaxPct: 15,
  bodyMinPct: 60,
  volRatioMin: 1.5,
  volLookback: 5,
  fillWindowMin: 15,
  linkFillWindowMin: 10,
  horizonMin: 180,
  feeRoundTripPct: 0.2,
  fixedSlPct: 10,
  emaBufferPct: 1.5,
};

/** 익절 목표(%) — 오너 지정 "1.3~2%" 범위를 3점으로 비교한다. */
export const LAB_TP_LIST = [1.3, 1.5, 2.0] as const;

export const LAB_ENTRY_MODES = ["A", "B", "C", "D"] as const;
export const LAB_STOP_MODES = ["A", "B", "C", "D"] as const;
export type LabEntryMode = (typeof LAB_ENTRY_MODES)[number];
export type LabStopMode = (typeof LAB_STOP_MODES)[number];

export const LAB_ENTRY_LABEL: Record<LabEntryMode, string> = {
  A: "신호봉 저가+3틱 지정가(원안)",
  B: "신호봉 종가 지정가",
  C: "신호봉 고가 돌파(+1틱) 시 진입",
  D: "신호봉 몸통 50% 되돌림 지정가",
};
export const LAB_STOP_LABEL: Record<LabStopMode, string> = {
  A: "고정 −10%",
  B: "EMA200 아래 1.5%",
  C: "신호봉 저가 −1틱",
  D: "C와 B 중 높은 쪽",
};

// ─────────────────────────────────────────────────────────────────────────────
// 2) 보조 계산
// ─────────────────────────────────────────────────────────────────────────────

/** EMA 전체 시계열(앞쪽 period−1개는 null). 기존 ema()와 같은 정의(앞 period개 SMA를 시드로). */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 몸통 비율(%) = |종가−시가| ÷ (고가−저가) × 100. 범위가 0이면 0. */
export function bodyPct(c: Candle): number {
  const range = c.high - c.low;
  return range > 0 ? (Math.abs(c.close - c.open) / range) * 100 : 0;
}

const isBull = (c: Candle) => c.close > c.open;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** 거래량 배수 = 이 봉 거래량 ÷ 직전 lookback개 평균(자기 자신 제외). 평균이 0이거나 봉이 모자라면 null. */
export function volRatioAt(ha: Candle[], idx: number, lookback: number): number | null {
  if (idx < lookback) return null;
  let sum = 0;
  for (let i = idx - lookback; i < idx; i++) sum += ha[i].volume;
  const avg = sum / lookback;
  return avg > 0 ? ha[idx].volume / avg : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 패턴 탐지: 도지 → 1(관망) → 2(1차 신호) → 3(2차 신호) → 4(고점 차단)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 탐지 결과 한 건. stage = 이 도지에서 출발한 패턴이 어디까지 갔는가.
 *   0: 도지(200 EMA 위) / 1: +1번째 양봉 / 2: +2번째 양봉 / 3: 2번째 몸통≥기준 → **신호 성립**(거래량은 volOk2로 따로)
 */
export interface DetectedRun {
  dojiIdx: number;
  stage: 0 | 1 | 2 | 3;
  volOk2: boolean | null; //  2번째 캔들 거래량 조건 충족 여부(stage 3 이상에서만 의미)
  c3: { idx: number; bull: boolean; bodyOk: boolean; volOk: boolean; qualified: boolean } | null;
  c4: { idx: number; block: boolean } | null; // 4번째 캔들(양봉이면 block=고점 차단)
  endIdx: number; //          패턴이 마지막으로 관여한 캔들 인덱스
}

/**
 * detectRuns — 하이킨아시 5분봉 전체를 훑어 패턴을 찾는다(여러 번 불러도 같은 결과 — 멱등).
 *
 *   규칙(오너·카일 답변 반영):
 *     · 도지: 몸통 < dojiBodyMaxPct%, 색(양·음) 무관, 종가가 200 EMA 위(글로벌 필터).
 *     · 1번째: 도지 **바로 다음** 봉이 양봉(음봉·도지가 끼면 무효 — Q6-A 엄격 연속). 진입 없이 관망.
 *     · 2번째: 양봉 + 몸통 ≥ bodyMinPct → 신호 성립(거래량은 volOk2에 기록). 몸통 미달이면 패턴 무효.
 *       거래량이 모자라면(volOk2=false) "비인정 신호"로 기록은 하되(문턱값 연구용) 3번째 이후는 보지 않는다.
 *     · 3번째: 2번째와 같은 조건(양봉+몸통+거래량)이면 2차 신호. 미달이면 거기서 패턴 종료(Q6-A).
 *     · 4번째: 3번째가 인정된 뒤 양봉이 또 나오면 "단기 고점" → block(추격 금지). 아니면 자연 종료.
 *     · 모든 캔들 종가는 200 EMA 위여야 한다(깨지면 거기서 종료).
 *   신호가 성립한 패턴 구간(도지~endIdx) 안에서는 새 도지 출발을 겹쳐 세지 않는다.
 */
export function detectRuns(ha: Candle[], emaS: (number | null)[], P: LabParams = LAB_PARAMS_DEFAULT): DetectedRun[] {
  const runs: DetectedRun[] = [];
  const n = ha.length;
  let blockedUntil = -1;
  const above = (i: number) => emaS[i] != null && ha[i].close > (emaS[i] as number);

  for (let i = 0; i < n; i++) {
    if (i <= blockedUntil) continue;
    const d = ha[i];
    if (!(d.high - d.low > 0) || bodyPct(d) >= P.dojiBodyMaxPct || !above(i)) continue;
    const run: DetectedRun = { dojiIdx: i, stage: 0, volOk2: null, c3: null, c4: null, endIdx: i };

    const i1 = i + 1;
    if (i1 < n && isBull(ha[i1]) && above(i1)) {
      run.stage = 1;
      run.endIdx = i1;
      const i2 = i + 2;
      if (i2 < n && isBull(ha[i2]) && above(i2)) {
        run.stage = 2;
        run.endIdx = i2;
        if (bodyPct(ha[i2]) >= P.bodyMinPct) {
          run.stage = 3;
          const vr2 = volRatioAt(ha, i2, P.volLookback);
          run.volOk2 = vr2 != null && vr2 >= P.volRatioMin;
          if (run.volOk2) {
            const i3 = i + 3;
            if (i3 < n) {
              const bull3 = isBull(ha[i3]) && above(i3);
              const bodyOk3 = bodyPct(ha[i3]) >= P.bodyMinPct;
              const vr3 = volRatioAt(ha, i3, P.volLookback);
              const volOk3 = vr3 != null && vr3 >= P.volRatioMin;
              run.c3 = { idx: i3, bull: bull3, bodyOk: bodyOk3, volOk: volOk3, qualified: bull3 && bodyOk3 && volOk3 };
              run.endIdx = i3;
              if (run.c3.qualified) {
                const i4 = i + 4;
                if (i4 < n) {
                  run.c4 = { idx: i4, block: isBull(ha[i4]) && above(i4) };
                  run.endIdx = i4;
                }
              }
            }
          }
        }
      }
    }
    runs.push(run);
    if (run.stage >= 3) blockedUntil = run.endIdx;
  }
  return runs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 로우 데이터(신호 한 건) 구조
// ─────────────────────────────────────────────────────────────────────────────

/** 5분봉 한 개: 원본(o/h/l/c) + 하이킨아시(ho/hh/hl/hc) + 거래량 + 그 시점 EMA200. */
export interface LabBar5 {
  t: number;
  o: number; h: number; l: number; c: number; v: number;
  ho: number; hh: number; hl: number; hc: number;
  e: number | null;
}

export type LabPath1m = Array<[number, number, number, number, number, number]>; // [t,o,h,l,c,v]

export interface LabLinkage {
  confirmT: number; //  삼분할 패턴이 확정된 캔들(음봉 확인봉)의 시작 시각
  dojiT: number;
  highT: number;
  highPx: number;
  prevClose: number; // 확정 시점 전봉 종가(원본)
  ema: number; //       그 시점 EMA200
  emaGapPct: number; // 전봉종가 EMA 이격도(%)
  splits: Array<{ level: number; entry: number; tp: number; sl: number }>;
}

export interface LabSignal {
  id: string; //                 `${symbol}:${dojiT}`
  symbol: string;
  rank: number;
  detectedAtMs: number;
  backfilled: boolean; //        신호 봉 마감보다 10분 넘게 늦게 발견(앱을 껐거나 백필) — 실시간성 구분용
  thinHours: boolean; //         05:00~17:00 KST(시세가 얇은 휴무 시간대)에 발생
  session: string; //            day/pre/regular/after/closed
  eligible: boolean; //          2번째 캔들이 몸통·거래량 모두 충족(실투입 인정 신호)
  dojiT: number;
  c2T: number;
  volRatio2: number | null;
  body2: number;
  second: { t: number; qualified: boolean; body: number; volRatio: number | null } | null;
  c4: { t: number; block: boolean } | null;
  runEndT: number;
  metrics: {
    price: number; //            신호 봉 종가(원본)
    ema: number | null;
    emaGapPct: number | null; //  신호 봉 종가의 EMA 이격도
    lowVsEmaPct: number | null; // 신호 봉 저가의 EMA 이격도(양수=EMA 위)
    dojiEmaDistPct: number | null; // 도지 종가의 EMA 이격도
    dojiBodyPct: number;
    atrPct: number | null;
    emaSlopePct: number | null;
    runRangePct: number | null; // 도지 저가~신호 봉 고가 상승폭(%)
  };
  bars: LabBar5[]; //            도지 6봉 전 ~ 관찰 종료까지의 5분봉(차트·연계 재현용)
  path1m: LabPath1m; //          신호 봉 마감 이후 1분봉(가상 체결 시뮬레이션의 원천)
  linkage: LabLinkage | null;
  linkageDone: boolean; //       더 찾을 필요 없음(찾았거나 관찰 시간이 끝남)
  complete: boolean; //          관찰 종료(horizon 경과)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) 삼분할 연계 탐지 (캔들 상승 구간 이후, 기존 삼분할 패턴이 이어졌는가)
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkageOpts {
  sessionStartMs: number;
  bodyRatio: number; //      삼분할 도지 몸통 상한(0~1) — 자동 스크리너 설정과 동일
  wickMin: number;
  maxAgeMin: number;
  maxGapMin: number;
  tpPct: number; //          calcSplit3 기준 익절%(기본 2)
  slPct: number; //          calcSplit3 기준 손절%(기본 10)
  emaPeriod: number;
}

/**
 * findLinkage — 캔들 상승 구간 끝(runEndIdx) 이후 5분봉을 하나씩 늘려 가며 **기존 자동매매와 같은**
 *   scanSessionPattern을 돌려, 처음 "확정(confirmed)"이 나오는 시점을 찾는다.
 *   조건: 그 패턴의 세션 최고점이 캔들 상승 구간(신호 2번째 캔들 이후)에서 만들어졌어야 "연계"로 본다
 *   (그 전의 더 높은 옛 고점에서 나온 패턴은 이 상승과 무관).
 *   반환 null = 아직 없음(관찰 중이거나 끝까지 없음).
 */
export function findLinkage(
  ha: Candle[],
  raw: Candle[],
  runEndIdx: number,
  c2Idx: number,
  o: LinkageOpts,
): LabLinkage | null {
  const closes = ha.map((c) => c.close);
  const emaS = emaSeries(closes, o.emaPeriod);
  for (let idx = runEndIdx + 1; idx < ha.length; idx++) {
    const nowMs = ha[idx].time + FIVE; // 이 봉이 마감된 시각
    const pat = scanSessionPattern(ha.slice(0, idx + 1), o.sessionStartMs, o.bodyRatio, o.wickMin, nowMs, o.maxAgeMin, true, o.maxGapMin);
    if (pat.status !== "confirmed" || pat.highTime == null || pat.sessionHigh == null || !pat.dojiCandle) continue;
    if (pat.highTime < ha[c2Idx].time) continue; // 이 상승과 무관한 옛 고점
    const e = emaS[idx];
    const prevClose = raw[idx].close;
    if (e == null || !(prevClose > e)) continue; // 삼분할은 전봉종가가 EMA 위일 때만 성립
    try {
      const { splits } = calcSplit3(prevClose, e, o.tpPct, o.slPct);
      return {
        confirmT: ha[idx].time,
        dojiT: pat.dojiCandle.time,
        highT: pat.highTime,
        highPx: pat.sessionHigh,
        prevClose,
        ema: e,
        emaGapPct: r2((prevClose / e - 1) * 100),
        splits: splits.map((s) => ({ level: s.level, entry: s.entry, tp: s.tp, sl: s.sl })),
      };
    } catch {
      continue;
    }
  }
  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// 4-b) 신호 로우 만들기·갱신 (순수 — 엔진이 시리즈를 넘겨 준다)
// ─────────────────────────────────────────────────────────────────────────────

/** 한 종목의 5분봉 시리즈(완성된 봉만, 원본·하이킨아시·EMA가 같은 인덱스로 정렬). */
export interface LabSeries {
  raw: Candle[];
  ha: Candle[];
  emaS: (number | null)[];
}

export function buildSeries(raw: Candle[], emaPeriod = 200): LabSeries {
  const ha = toHA(raw);
  return { raw, ha, emaS: emaSeries(ha.map((c) => c.close), emaPeriod) };
}

/** 이 신호를 끝까지 평가하는 데 필요한 1분봉의 마지막 시각(ms). 연계가 잡히면 그만큼 더 길어진다. */
export function requiredPathEndMs(sig: Pick<LabSignal, "c2T" | "linkage">, P: LabParams = LAB_PARAMS_DEFAULT): number {
  const c2Close = sig.c2T + FIVE;
  const candleEnd = c2Close + (P.fillWindowMin + P.horizonMin + 10) * MIN;
  if (!sig.linkage) return candleEnd;
  const linkEnd = sig.linkage.confirmT + FIVE + (P.linkFillWindowMin + P.horizonMin + 10) * MIN;
  return Math.max(candleEnd, linkEnd);
}

export interface UpdateCtx {
  series: LabSeries;
  oneMin: Candle[]; //     원본 1분봉(오름차순)
  nowMs: number;
  link: LinkageOpts;
  P?: LabParams;
}

/**
 * updateSignal — 로우 신호의 "시간이 지나며 늘어나는 부분"(5분봉 창·1분봉 경로·연계·완료 여부)을 갱신한다.
 *   멱등: 같은 입력으로 여러 번 불러도 같은 결과.
 */
export function updateSignal(sig: LabSignal, ctx: UpdateCtx): LabSignal {
  const P = ctx.P ?? LAB_PARAMS_DEFAULT;
  const { raw, ha, emaS } = ctx.series;
  const dojiIdx = ha.findIndex((c) => c.time === sig.dojiT);
  const c2Idx = ha.findIndex((c) => c.time === sig.c2T);
  if (dojiIdx < 0 || c2Idx < 0) return sig; // 시리즈가 이 신호 구간을 더 이상 포함하지 않음(너무 오래됨) — 그대로 둔다
  const runEndIdx = ha.findIndex((c) => c.time === sig.runEndT);

  // 연계 탐색(아직 못 찾았고, 탐색 시간이 안 끝났을 때만)
  let linkage = sig.linkage;
  let linkageDone = sig.linkageDone;
  const searchEndMs = sig.runEndT + FIVE + P.horizonMin * MIN;
  if (!linkage && !linkageDone && runEndIdx >= 0) {
    linkage = findLinkage(ha, raw, runEndIdx, c2Idx, ctx.link);
    if (linkage) linkageDone = true;
    else if (ctx.nowMs >= searchEndMs) linkageDone = true;
  }

  const next: LabSignal = { ...sig, linkage, linkageDone };
  // 5분봉 창: 도지 6봉 전 ~ (도지 + 4 + 관찰시간/5 + 여유)
  const from = Math.max(0, dojiIdx - 6);
  const to = Math.min(ha.length, dojiIdx + 6 + Math.ceil((P.horizonMin + 30) / 5)); // 상승 구간 + 연계 탐색 시간(≈관찰 시간)까지
  next.bars = [];
  for (let i = from; i < to; i++) {
    next.bars.push({
      t: ha[i].time,
      o: r4(raw[i].open), h: r4(raw[i].high), l: r4(raw[i].low), c: r4(raw[i].close), v: Math.round(raw[i].volume),
      ho: r4(ha[i].open), hh: r4(ha[i].high), hl: r4(ha[i].low), hc: r4(ha[i].close),
      e: emaS[i] != null ? r4(emaS[i] as number) : null,
    });
  }
  // 1분봉 경로: 신호 봉 마감 ~ 필요 종료 시각
  const pathFrom = sig.c2T + FIVE;
  const pathTo = requiredPathEndMs(next, P);
  next.path1m = ctx.oneMin
    .filter((c) => c.time >= pathFrom && c.time < pathTo)
    .map((c) => [c.time, r4(c.open), r4(c.high), r4(c.low), r4(c.close), Math.round(c.volume)] as [number, number, number, number, number, number]);
  // 완료: 필요한 구간이 모두 지났고(경로가 다 채워짐) 연계 탐색도 끝남
  next.complete = ctx.nowMs >= pathTo && linkageDone;
  return next;
}

/**
 * buildSignal — 탐지된 패턴(DetectedRun, stage≥3)에서 신호 로우 한 건을 만든다.
 *   session/thinHours/backfilled 같은 "시각 문맥"은 엔진이 계산해 넘긴다(순수 유지).
 */
export function buildSignal(a: {
  symbol: string;
  rank: number;
  run: DetectedRun;
  series: LabSeries;
  oneMin: Candle[];
  nowMs: number;
  session: string;
  thinHours: boolean;
  link: LinkageOpts;
  P?: LabParams;
}): LabSignal {
  const P = a.P ?? LAB_PARAMS_DEFAULT;
  const { raw, ha, emaS } = a.series;
  const r = a.run;
  const i2 = r.dojiIdx + 2;
  const c2Close = ha[i2].time + FIVE;
  const e2 = emaS[i2];
  const vr2 = volRatioAt(ha, i2, P.volLookback);
  const closesToC2 = raw.slice(0, i2 + 1);
  const hi = Math.max(...raw.slice(r.dojiIdx, r.endIdx + 1).map((c) => c.high));
  const lo = Math.min(...raw.slice(r.dojiIdx, r.endIdx + 1).map((c) => c.low));
  const closesHa = ha.map((c) => c.close).slice(0, i2 + 1);
  const sig: LabSignal = {
    id: `${a.symbol}:${ha[r.dojiIdx].time}`,
    symbol: a.symbol,
    rank: a.rank,
    detectedAtMs: a.nowMs,
    backfilled: a.nowMs - c2Close > 10 * MIN,
    thinHours: a.thinHours,
    session: a.session,
    eligible: r.volOk2 === true,
    dojiT: ha[r.dojiIdx].time,
    c2T: ha[i2].time,
    volRatio2: vr2 != null ? r2(vr2) : null,
    body2: r2(bodyPct(ha[i2])),
    second: r.c3 ? { t: ha[r.c3.idx].time, qualified: r.c3.qualified, body: r2(bodyPct(ha[r.c3.idx])), volRatio: volRatioAt(ha, r.c3.idx, P.volLookback) != null ? r2(volRatioAt(ha, r.c3.idx, P.volLookback) as number) : null } : null,
    c4: r.c4 ? { t: ha[r.c4.idx].time, block: r.c4.block } : null,
    runEndT: ha[r.endIdx].time,
    metrics: {
      price: r4(raw[i2].close),
      ema: e2 != null ? r4(e2) : null,
      emaGapPct: e2 != null ? r2((raw[i2].close / e2 - 1) * 100) : null,
      lowVsEmaPct: e2 != null ? r2((raw[i2].low / e2 - 1) * 100) : null,
      dojiEmaDistPct: emaS[r.dojiIdx] != null ? r2((raw[r.dojiIdx].close / (emaS[r.dojiIdx] as number) - 1) * 100) : null,
      dojiBodyPct: r2(bodyPct(ha[r.dojiIdx])),
      atrPct: atrPct(closesToC2),
      emaSlopePct: emaSlopePct(closesHa, 200),
      runRangePct: lo > 0 ? r2((hi / lo - 1) * 100) : null,
    },
    bars: [],
    path1m: [],
    linkage: null,
    linkageDone: false,
    complete: false,
  };
  return updateSignal(sig, { series: a.series, oneMin: a.oneMin, nowMs: a.nowMs, link: a.link, P });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) 가상 매매 시뮬레이션 (로우 → 변형별 결과)
// ─────────────────────────────────────────────────────────────────────────────

export type TradeStatus = "unfilled" | "skipped" | "win" | "loss" | "time" | "horizon" | "open";

export interface SimTrade {
  key: string; //            `${entryMode}${stopMode}-${tp}-e${entryIdx}` (연계는 `L${level}${stopMode}-${tp}`)
  kind: "candle" | "link";
  entryIdx: number; //       1=2번째 캔들 신호, 2=3번째 캔들 신호(연계는 level)
  entryMode: string;
  stopMode: string;
  tpPct: number;
  status: TradeStatus;
  note?: string; //          skipped·unfilled 사유
  entryT?: number;
  fillPx?: number;
  stopPx?: number;
  tpPx?: number;
  riskPct?: number; //       손절까지 거리(%)
  exitT?: number;
  exitPx?: number;
  exitReason?: string;
  grossPct?: number; //      수수료 전 손익(%)
  netPct?: number; //        왕복 수수료 추정 차감
  maePct?: number; //        보유 중 최대 역행(%, 음수)
  mfePct?: number; //        보유 중 최대 순행(%)
  holdMin?: number;
}

type FillRes = { i: number; px: number } | null;

/** 매수 체결 탐색. limit: 가격이 지정가 밑으로 "한 틱 이상 뚫고" 내려가야 체결(시가가 이미 아래면 시가에 체결). */
function scanFill(path: LabPath1m, fromMs: number, toMs: number, level: number, kind: "limit" | "stop"): FillRes {
  const tick = getTick(level);
  for (let i = 0; i < path.length; i++) {
    const [t, o, h, l] = path[i];
    if (t < fromMs) continue;
    if (t >= toMs) break;
    if (kind === "limit") {
      if (o <= level) return { i, px: o };
      if (l <= level - tick) return { i, px: level };
    } else {
      if (o >= level) return { i, px: o };
      if (h >= level + tick) return { i, px: level };
    }
  }
  return null;
}

interface ExitArgs {
  path: LabPath1m;
  fillIdx: number;
  fillPx: number;
  stopPx: number;
  tpPx: number;
  timeExitMs: number | null; //  4번째 캔들 확정 시 잔량 정리 시각(null이면 없음)
  endMs: number; //              관찰 종료 시각
  final: boolean; //             true면 데이터가 이미 끝난 신호(complete) — 경로 끝에서 정리한다(장 마감 등으로 관찰 시간을 못 채운 경우)
}

function scanExit(a: ExitArgs): Pick<SimTrade, "status" | "exitT" | "exitPx" | "exitReason" | "maePct" | "mfePct"> {
  const { path, fillIdx, fillPx, stopPx, tpPx, timeExitMs, endMs, final } = a;
  const tick = getTick(tpPx);
  let low = Infinity;
  let high = -Infinity;
  let lastIdx = fillIdx;
  for (let j = fillIdx; j < path.length; j++) {
    const [t, o, h, l] = path[j];
    if (t >= endMs) break;
    lastIdx = j;
    low = Math.min(low, l);
    if (j > fillIdx) high = Math.max(high, h);
    const mk = (status: TradeStatus, px: number, why: string, tt: number) => ({
      status,
      exitT: tt,
      exitPx: px,
      exitReason: why,
      maePct: r2((Math.min(low, px) / fillPx - 1) * 100),
      mfePct: r2((Math.max(high === -Infinity ? fillPx : high, px) / fillPx - 1) * 100),
    });
    // 1) 4번째 캔들 확정 정리(시각이 되면 그 봉 시가로)
    if (timeExitMs != null && t >= timeExitMs && j > fillIdx) return mk("time", o, "4번째 캔들 확정 정리", t);
    // 2) 손절 먼저(같은 봉에서 손절·익절이 둘 다 닿으면 손절로 — 보수적). 갭이면 시가 체결.
    if (l <= stopPx) return mk("loss", Math.min(stopPx, o), "손절", t);
    // 3) 익절(체결 봉에서는 보지 않는다 — 봉 안 순서를 알 수 없으므로). 한 틱 이상 뚫어야 체결.
    if (j > fillIdx && h >= tpPx + tick) return mk("win", Math.max(tpPx, o), "익절", t);
  }
  // 관찰 종료: 마지막 봉 종가로 정리(데이터가 아직 horizon까지 안 왔으면 "open")
  const lastBar = path[lastIdx];
  const closedByTime = lastBar[0] + MIN >= endMs || final;
  const px = lastBar[4];
  return {
    status: closedByTime ? "horizon" : "open",
    exitT: lastBar[0] + MIN,
    exitPx: px,
    exitReason: closedByTime ? (lastBar[0] + MIN >= endMs ? "관찰 시간 종료(종가 정리)" : "장 종료·데이터 끝(종가 정리)") : "진행 중(미실현)",
    maePct: r2((Math.min(low, px) / fillPx - 1) * 100),
    mfePct: r2((Math.max(high === -Infinity ? fillPx : high, px) / fillPx - 1) * 100),
  };
}

function finishTrade(base: SimTrade, fillPx: number, ex: ReturnType<typeof scanExit>, P: LabParams, entryT: number): SimTrade {
  const gross = ((ex.exitPx as number) / fillPx - 1) * 100;
  return {
    ...base,
    ...ex,
    entryT,
    fillPx: r4(fillPx),
    grossPct: r2(gross),
    netPct: r2(gross - P.feeRoundTripPct),
    holdMin: Math.max(0, Math.round(((ex.exitT as number) - entryT) / MIN)),
  };
}

function barAt(sig: LabSignal, t: number): LabBar5 | undefined {
  return sig.bars.find((b) => b.t === t);
}

/** 손절가 계산. 계산 불가(손절선이 진입가 이상)면 null. */
function stopFor(mode: LabStopMode, fillPx: number, bar: LabBar5, P: LabParams): number | null {
  const fixed = roundPrice(fillPx * (1 - P.fixedSlPct / 100));
  const sigLow = bar.l - getTick(bar.l);
  const emaStop = bar.e != null ? bar.e * (1 - P.emaBufferPct / 100) : null;
  let s: number | null;
  if (mode === "A") s = fixed;
  else if (mode === "B") s = emaStop;
  else if (mode === "C") s = sigLow;
  else s = emaStop != null ? Math.max(sigLow, emaStop) : sigLow;
  if (s == null) return null;
  s = roundPrice(s);
  return s < fillPx ? s : null;
}

function entryLevel(mode: LabEntryMode, bar: LabBar5): { level: number; kind: "limit" | "stop" } {
  if (mode === "A") return { level: roundPrice(bar.l + 3 * getTick(bar.l)), kind: "limit" };
  if (mode === "B") return { level: roundPrice(bar.c), kind: "limit" };
  if (mode === "C") return { level: roundPrice(bar.h + getTick(bar.h)), kind: "stop" };
  return { level: roundPrice((bar.o + bar.c) / 2), kind: "limit" };
}

/**
 * simulateSignal — 신호 한 건(로우)을 모든 변형으로 가상 매매한다.
 *   candle: 매수 방식(A~D) × 손절(A~D) × 익절(1.3/1.5/2.0) × 진입 순번(1=2번째 캔들, 2=3번째 캔들)
 *   link  : 삼분할 연계(레벨 1·2 × 손절 A·B × 익절 3종) — 캔들 상승 뒤 삼분할 패턴이 실제로 이어진 경우만
 *   2차 진입(3번째 캔들)은 "1차가 체결됐고 아직 보유 중이며 지금 수익권"일 때만(Q5-B).
 */
export function simulateSignal(sig: LabSignal, P: LabParams = LAB_PARAMS_DEFAULT): SimTrade[] {
  const out: SimTrade[] = [];
  const endCap = (from: number) => from + P.horizonMin * MIN;
  const bar2 = barAt(sig, sig.c2T);
  const bar3 = sig.second ? barAt(sig, sig.second.t) : undefined;
  const timeExitMs = sig.c4?.block ? sig.c4.t + FIVE : null;

  for (const em of LAB_ENTRY_MODES) {
    for (const sm of LAB_STOP_MODES) {
      for (const tp of LAB_TP_LIST) {
        const mk = (idx: number): SimTrade => ({ key: `${em}${sm}-${tp}-e${idx}`, kind: "candle", entryIdx: idx, entryMode: em, stopMode: sm, tpPct: tp, status: "unfilled" });
        // ── 1차(2번째 캔들) ──
        let t1: SimTrade = mk(1);
        if (!bar2) {
          t1 = { ...t1, status: "skipped", note: "신호봉 데이터 없음" };
        } else {
          const from = sig.c2T + FIVE;
          const { level, kind } = entryLevel(em, bar2);
          const fill = scanFill(sig.path1m, from, from + P.fillWindowMin * MIN, level, kind);
          if (!fill) {
            t1 = { ...t1, note: `${P.fillWindowMin}분 안에 체결 안 됨` };
          } else {
            const stop = stopFor(sm, fill.px, bar2, P);
            if (stop == null) {
              t1 = { ...t1, status: "skipped", note: "손절선이 진입가 이상(계산 불가)" };
            } else {
              const tpPx = roundPrice(fill.px * (1 + tp / 100));
              const ex = scanExit({ path: sig.path1m, fillIdx: fill.i, fillPx: fill.px, stopPx: stop, tpPx, timeExitMs, endMs: endCap(sig.path1m[fill.i][0]), final: sig.complete });
              t1 = finishTrade({ ...t1, stopPx: stop, tpPx, riskPct: r2((1 - stop / fill.px) * 100) }, fill.px, ex, P, sig.path1m[fill.i][0]);
            }
          }
        }
        out.push(t1);

        // ── 2차(3번째 캔들): 인정 신호 + 1차 체결·보유 중·수익권일 때만 ──
        if (sig.second?.qualified && bar3) {
          let t2: SimTrade = mk(2);
          const s3Close = sig.second.t + FIVE;
          const heldOk = t1.fillPx != null && t1.entryT != null && t1.entryT <= s3Close && (t1.exitT == null || t1.exitT > s3Close);
          if (!heldOk) t2 = { ...t2, status: "skipped", note: "1차가 체결·보유 중이 아님" };
          else if (!(bar3.c > (t1.fillPx as number))) t2 = { ...t2, status: "skipped", note: "1차가 수익권이 아님(손실 중 추가 금지)" };
          else {
            const { level, kind } = entryLevel(em, bar3);
            const fill = scanFill(sig.path1m, s3Close, s3Close + P.fillWindowMin * MIN, level, kind);
            if (!fill) t2 = { ...t2, note: `${P.fillWindowMin}분 안에 체결 안 됨` };
            else {
              const stop = stopFor(sm, fill.px, bar3, P);
              if (stop == null) t2 = { ...t2, status: "skipped", note: "손절선이 진입가 이상(계산 불가)" };
              else {
                const tpPx = roundPrice(fill.px * (1 + tp / 100));
                const ex = scanExit({ path: sig.path1m, fillIdx: fill.i, fillPx: fill.px, stopPx: stop, tpPx, timeExitMs, endMs: endCap(sig.path1m[fill.i][0]), final: sig.complete });
                t2 = finishTrade({ ...t2, stopPx: stop, tpPx, riskPct: r2((1 - stop / fill.px) * 100) }, fill.px, ex, P, sig.path1m[fill.i][0]);
              }
            }
          }
          out.push(t2);
        }
      }
    }
  }

  // ── 삼분할 연계 ──
  if (sig.linkage) {
    const lk = sig.linkage;
    const from = lk.confirmT + FIVE;
    for (const sp of lk.splits.filter((s) => s.level <= 2)) {
      for (const sm of ["A", "B"] as const) {
        for (const tp of LAB_TP_LIST) {
          const base: SimTrade = { key: `L${sp.level}${sm}-${tp}`, kind: "link", entryIdx: sp.level, entryMode: `삼분할${sp.level}`, stopMode: sm, tpPct: tp, status: "unfilled" };
          const fill = scanFill(sig.path1m, from, from + P.linkFillWindowMin * MIN, sp.entry, "limit");
          if (!fill) { out.push({ ...base, note: `${P.linkFillWindowMin}분 안에 체결 안 됨` }); continue; }
          const fixed = roundPrice(fill.px * (1 - P.fixedSlPct / 100));
          const stop =
            sm === "A"
              ? fixed
              : structuralStopPrice(fill.px, lk.ema, P.emaBufferPct, fixed);
          if (stop == null || !(stop < fill.px)) { out.push({ ...base, status: "skipped", note: "손절선이 진입가 이상(계산 불가)" }); continue; }
          const tpPx = roundPrice(fill.px * (1 + tp / 100));
          const ex = scanExit({ path: sig.path1m, fillIdx: fill.i, fillPx: fill.px, stopPx: roundPrice(stop), tpPx, timeExitMs: null, endMs: sig.path1m[fill.i][0] + P.horizonMin * MIN, final: sig.complete });
          out.push(finishTrade({ ...base, stopPx: roundPrice(stop), tpPx, riskPct: r2((1 - roundPrice(stop) / fill.px) * 100) }, fill.px, ex, P, sig.path1m[fill.i][0]));
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7) 집계
// ─────────────────────────────────────────────────────────────────────────────

export interface LabFilter {
  includeIneligible?: boolean; //  거래량 미달 비인정 신호 포함
  includeThin?: boolean; //        05~17시(얇은 시세) 신호 포함
  includeBackfilled?: boolean; //  늦게 발견된(백필) 신호 포함
  sinceMs?: number;
  session?: string;
}

export function passFilter(s: LabSignal, f: LabFilter): boolean {
  if (!f.includeIneligible && !s.eligible) return false;
  if (!f.includeThin && s.thinHours) return false;
  if (f.includeBackfilled === false && s.backfilled) return false;
  if (f.sinceMs != null && s.c2T < f.sinceMs) return false;
  if (f.session && s.session !== f.session) return false;
  return true;
}

export interface VariantRow {
  key: string;
  kind: "candle" | "link";
  entryIdx: number;
  entryMode: string;
  stopMode: string;
  tpPct: number;
  signals: number; //      이 변형이 평가된 신호 수(skipped·open 제외한 "시도" 수)
  filled: number;
  fillRate: number | null; // 체결 수 ÷ 시도 수(%)
  closed: number; //        청산 완료(익절·손절·시간정리·관찰종료)
  wins: number; //          net > 0
  losses: number;
  winRate: number | null;
  avgNetPct: number | null; //  체결 건당 평균 순손익(%)
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
  expectancyPerSignal: number | null; // (체결건 순손익 합) ÷ 시도 수 — 미체결은 0으로 쳐서 "신호 하나당 기대값"
  totalNetPct: number;
  avgMaePct: number | null;
  avgRiskPct: number | null;
  avgHoldMin: number | null;
}

const mean = (a: number[]) => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);

function aggregateTrades(key: string, trades: SimTrade[], attempts: number): VariantRow {
  const t0 = trades[0];
  const filled = trades.filter((t) => t.fillPx != null);
  const closed = filled.filter((t) => t.status !== "open");
  const nets = closed.map((t) => t.netPct as number);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const gp = wins.reduce((s, x) => s + x, 0);
  const gl = Math.abs(losses.reduce((s, x) => s + x, 0));
  const total = nets.reduce((s, x) => s + x, 0);
  return {
    key,
    kind: t0?.kind ?? "candle",
    entryIdx: t0?.entryIdx ?? 1,
    entryMode: t0?.entryMode ?? "",
    stopMode: t0?.stopMode ?? "",
    tpPct: t0?.tpPct ?? 0,
    signals: attempts,
    filled: filled.length,
    fillRate: attempts > 0 ? r2((filled.length / attempts) * 100) : null,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? r2((wins.length / closed.length) * 100) : null,
    avgNetPct: mean(nets),
    avgWinPct: mean(wins),
    avgLossPct: mean(losses),
    profitFactor: gl > 0 ? r2(gp / gl) : null,
    expectancyPerSignal: attempts > 0 ? r2(total / attempts) : null,
    totalNetPct: r2(total),
    avgMaePct: mean(closed.map((t) => t.maePct ?? 0)),
    avgRiskPct: mean(filled.map((t) => t.riskPct ?? 0)),
    avgHoldMin: mean(closed.map((t) => t.holdMin ?? 0)),
  };
}

/** 변형별 성적표. 신호마다 시뮬레이션을 돌려 key별로 모은다(skipped는 "시도"에서 제외 — 그 변형이 성립 못 한 신호). */
export function summarizeVariants(signals: LabSignal[], f: LabFilter = {}, P: LabParams = LAB_PARAMS_DEFAULT): VariantRow[] {
  const groups = new Map<string, SimTrade[]>();
  const attempts = new Map<string, number>();
  for (const s of signals) {
    if (!passFilter(s, f)) continue;
    for (const t of simulateSignal(s, P)) {
      if (t.status === "skipped") continue;
      if (!groups.has(t.key)) groups.set(t.key, []);
      groups.get(t.key)!.push(t);
      attempts.set(t.key, (attempts.get(t.key) ?? 0) + 1);
    }
  }
  return [...groups.entries()].map(([k, v]) => aggregateTrades(k, v, attempts.get(k) ?? 0));
}

export interface BreakdownRow {
  label: string;
  n: number; //          이 구간 신호 중 체결된 건수
  winRate: number | null;
  avgNetPct: number | null;
  totalNetPct: number;
}

export type BreakdownDim = "session" | "hour" | "rank" | "volRatio" | "emaGap" | "atr" | "price" | "runRange";

/** 한 변형(key)을 기준으로, 신호의 특성(세션·시간대·순위·거래량배수·이격도·변동성…)별 성적을 나눠 본다. */
export function breakdownBy(signals: LabSignal[], key: string, dim: BreakdownDim, f: LabFilter = {}, P: LabParams = LAB_PARAMS_DEFAULT): BreakdownRow[] {
  const buckets = new Map<string, number[]>();
  const bucket = (s: LabSignal): string => {
    const m = s.metrics;
    const range = (v: number | null, edges: number[], unit: string) => {
      if (v == null) return "—";
      for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i === 0 ? `<${edges[0]}${unit}` : `${edges[i - 1]}~${edges[i]}${unit}`;
      return `≥${edges[edges.length - 1]}${unit}`;
    };
    switch (dim) {
      case "session": return s.session;
      case "hour": return `${String(new Date(s.c2T + 9 * 3600_000).getUTCHours()).padStart(2, "0")}시(KST)`;
      case "rank": return s.rank <= 10 ? "1~10위" : s.rank <= 30 ? "11~30위" : s.rank <= 60 ? "31~60위" : "61위~";
      case "volRatio": return range(s.volRatio2, [2, 3, 5], "배");
      case "emaGap": return range(m.emaGapPct, [3, 6, 10], "%");
      case "atr": return range(m.atrPct, [1, 2, 3], "%");
      case "price": return range(m.price, [2, 3, 5, 7], "$");
      case "runRange": return range(m.runRangePct, [2, 4, 8], "%");
    }
  };
  for (const s of signals) {
    if (!passFilter(s, f)) continue;
    const t = simulateSignal(s, P).find((x) => x.key === key);
    if (!t || t.fillPx == null || t.status === "open") continue;
    const b = bucket(s);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(t.netPct as number);
  }
  return [...buckets.entries()]
    .map(([label, nets]) => ({
      label,
      n: nets.length,
      winRate: nets.length ? r2((nets.filter((x) => x > 0).length / nets.length) * 100) : null,
      avgNetPct: mean(nets),
      totalNetPct: r2(nets.reduce((s, x) => s + x, 0)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** 신호 깔때기(단계별 통과 수). attempts: 도지 id → 도달 단계(0~3, 인정 신호는 4). */
export interface Funnel {
  dojis: number;
  c1: number;
  c2Bull: number;
  c2Body: number;
  eligible: number;
  second: number;
  block4: number;
  linked: number;
}

export function buildFunnel(attempts: Record<string, number>, signals: LabSignal[]): Funnel {
  const v = Object.values(attempts);
  return {
    dojis: v.length,
    c1: v.filter((x) => x >= 1).length,
    c2Bull: v.filter((x) => x >= 2).length,
    c2Body: v.filter((x) => x >= 3).length,
    eligible: signals.filter((s) => s.eligible).length,
    second: signals.filter((s) => s.second?.qualified).length,
    block4: signals.filter((s) => s.c4?.block).length,
    linked: signals.filter((s) => s.linkage != null).length,
  };
}

export interface LinkageSummary {
  runsWithBlock: number; //   4번째 캔들 고점 차단까지 간 신호 수
  linked: number; //          그중 삼분할 패턴이 이어진 수
  linkRate: number | null;
  avgGapMin: number | null; // 상승 구간 끝 → 삼분할 확정까지 평균 분
  avgEmaGapPct: number | null;
  linkedAnyEligible: number; // 4번째 차단 여부와 무관하게 연계가 잡힌 인정 신호 수
}

export function summarizeLinkage(signals: LabSignal[], f: LabFilter = {}): LinkageSummary {
  const pool = signals.filter((s) => passFilter(s, f));
  const blocked = pool.filter((s) => s.c4?.block);
  const linkedB = blocked.filter((s) => s.linkage);
  const all = pool.filter((s) => s.linkage);
  const gaps = all.map((s) => ((s.linkage as LabLinkage).confirmT - s.runEndT) / MIN);
  return {
    runsWithBlock: blocked.length,
    linked: linkedB.length,
    linkRate: blocked.length ? r2((linkedB.length / blocked.length) * 100) : null,
    avgGapMin: mean(gaps),
    avgEmaGapPct: mean(all.map((s) => (s.linkage as LabLinkage).emaGapPct)),
    linkedAnyEligible: all.length,
  };
}

export interface CombinedResult {
  n: number; //             연계 시나리오가 성립한 신호 수
  candleOnlyAvg: number | null; // 그 신호들의 캔들 매매만의 평균 순손익(%)
  linkOnlyAvg: number | null; //   삼분할만의 평균
  combinedAvg: number | null; //   캔들 + 삼분할을 이어서 한 합계 평균
  combinedTotal: number;
  skippedByLoss: number; //        캔들 매매가 손절이라 삼분할을 건너뛴 수(Q9-A)
  skippedByOverlap: number; //     캔들 포지션이 아직 안 끝나 삼분할이 시작 못 한 수(Q4-A)
}

/**
 * combinedScenario — "캔들 매매(변형 V) → 끝난 뒤 삼분할(변형 W)" 연계 시나리오의 성과.
 *   성립 조건(오너 답변): 캔들 포지션이 **완전히 청산된 뒤**에만 삼분할 진입(Q4-A),
 *   캔들 매매가 **손절로 끝났으면 그날 삼분할 금지**(Q9-A).
 */
export function combinedScenario(signals: LabSignal[], candleKey: string, linkKey: string, f: LabFilter = {}, P: LabParams = LAB_PARAMS_DEFAULT): CombinedResult {
  let n = 0, skippedByLoss = 0, skippedByOverlap = 0;
  const cOnly: number[] = [], lOnly: number[] = [], comb: number[] = [];
  for (const s of signals) {
    if (!passFilter(s, f) || !s.linkage) continue;
    const sims = simulateSignal(s, P);
    const c = sims.find((x) => x.key === candleKey);
    const l = sims.find((x) => x.key === linkKey);
    if (!c || !l || c.fillPx == null || l.fillPx == null || c.status === "open" || l.status === "open") continue;
    if (c.status === "loss") { skippedByLoss++; continue; }
    if ((c.exitT as number) > (l.entryT as number)) { skippedByOverlap++; continue; }
    n++;
    cOnly.push(c.netPct as number);
    lOnly.push(l.netPct as number);
    comb.push((c.netPct as number) + (l.netPct as number));
  }
  return {
    n,
    candleOnlyAvg: mean(cOnly),
    linkOnlyAvg: mean(lOnly),
    combinedAvg: mean(comb),
    combinedTotal: r2(comb.reduce((s, x) => s + x, 0)),
    skippedByLoss,
    skippedByOverlap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8) 내보내기 (CSV — 외부 분석용 로우)
// ─────────────────────────────────────────────────────────────────────────────

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 신호 로우 CSV: 신호당 1행(핵심 로우 필드). */
export function signalsToCsv(signals: LabSignal[]): string {
  const h = [
    "id", "symbol", "rank", "session", "thinHours", "backfilled", "eligible", "dojiT", "c2T", "volRatio2", "body2",
    "second_t", "second_qualified", "second_body", "second_volRatio", "c4_t", "c4_block", "runEndT",
    "price", "ema", "emaGapPct", "lowVsEmaPct", "dojiEmaDistPct", "dojiBodyPct", "atrPct", "emaSlopePct", "runRangePct",
    "linked", "link_confirmT", "link_emaGapPct", "complete",
  ];
  const rows = signals.map((s) =>
    [
      s.id, s.symbol, s.rank, s.session, s.thinHours, s.backfilled, s.eligible, s.dojiT, s.c2T, s.volRatio2, s.body2,
      s.second?.t, s.second?.qualified, s.second?.body, s.second?.volRatio, s.c4?.t, s.c4?.block, s.runEndT,
      s.metrics.price, s.metrics.ema, s.metrics.emaGapPct, s.metrics.lowVsEmaPct, s.metrics.dojiEmaDistPct, s.metrics.dojiBodyPct,
      s.metrics.atrPct, s.metrics.emaSlopePct, s.metrics.runRangePct,
      s.linkage != null, s.linkage?.confirmT, s.linkage?.emaGapPct, s.complete,
    ].map(csvCell).join(","),
  );
  return [h.join(","), ...rows].join("\n");
}

/** 가상 매매 CSV(롱 포맷): 신호 × 변형당 1행. */
export function tradesToCsv(signals: LabSignal[], P: LabParams = LAB_PARAMS_DEFAULT): string {
  const h = ["signalId", "symbol", "kind", "key", "entryIdx", "entryMode", "stopMode", "tpPct", "status", "note", "entryT", "fillPx", "stopPx", "tpPx", "riskPct", "exitT", "exitPx", "exitReason", "grossPct", "netPct", "maePct", "mfePct", "holdMin"];
  const rows: string[] = [];
  for (const s of signals) {
    for (const t of simulateSignal(s, P)) {
      rows.push([s.id, s.symbol, t.kind, t.key, t.entryIdx, t.entryMode, t.stopMode, t.tpPct, t.status, t.note, t.entryT, t.fillPx, t.stopPx, t.tpPx, t.riskPct, t.exitT, t.exitPx, t.exitReason, t.grossPct, t.netPct, t.maePct, t.mfePct, t.holdMin].map(csvCell).join(","));
    }
  }
  return [h.join(","), ...rows].join("\n");
}

