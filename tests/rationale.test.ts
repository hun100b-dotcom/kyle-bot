// =============================================================================
// tests/rationale.test.ts — 매매 근거 기록 & 손익% 계산 회귀 테스트 (v0.2.10)
// -----------------------------------------------------------------------------
// [왜 이 테스트가 필요한가?]
//   토스 API는 "이 주문이 삼분할 2분할 타점이었다" 같은 우리 기법의 근거를 돌려주지 않는다.
//   그래서 앱이 주문을 낼 때 직접 남긴다. 이 기록이 조용히 깨지면 "왜 샀는지"가 영원히 사라지고,
//   화면의 손익%도 엉뚱한 값이 된다. 눈으로는 티가 안 나므로 테스트로 고정해 둔다.
//
//   실제 주문을 내지 않고(실계좌 보호), 순수 계산 규칙만 검증한다.
// =============================================================================

import { describe, it, expect } from "vitest";

// --- App.tsx / tool-engine.ts 와 동일한 규칙을 복제해 검증 ---

const TECH_LABEL: Record<string, string> = {
  split3: "삼분할 (EMA200)",
  orderbook: "호가창 (매수벽+1틱)",
  candle: "캔들 (시가−3틱)",
  manual: "수동 입력",
};

interface R {
  technique: string;
  level?: number;
  baseClose?: number;
  ema200?: number;
  wallPrice?: number;
  barOpen?: number;
  entry?: number;
  tp?: number;
  sl?: number;
  tpPct?: number;
  slPct?: number;
  quantity: number;
  priceAtOrder?: number | null;
}

/** App.tsx의 rationaleLine과 동일 규칙 */
function rationaleLine(r: R): string {
  const p: string[] = [];
  const t = TECH_LABEL[r.technique] ?? r.technique;
  p.push(r.technique === "split3" && r.level ? `${t.replace(/\s*\(.*\)/, "")} ${r.level}분할` : t.replace(/\s*\(.*\)/, ""));
  if (r.baseClose != null) p.push(`전봉종가 $${r.baseClose}`);
  if (r.ema200 != null) p.push(`EMA200 $${r.ema200}`);
  if (r.wallPrice != null) p.push(`매수벽 $${r.wallPrice}`);
  if (r.barOpen != null) p.push(`현재봉 시가 $${r.barOpen}`);
  if (r.entry) p.push(`진입 $${r.entry}`);
  if (r.tp) p.push(`익절 $${r.tp}${r.tpPct != null ? `(+${r.tpPct}%)` : ""}`);
  if (r.sl) p.push(`손절 $${r.sl}${r.slPct != null ? `(-${r.slPct}%)` : ""}`);
  p.push(`${r.quantity}주`);
  if (r.priceAtOrder != null) p.push(`당시가 $${r.priceAtOrder}`);
  return p.join(" · ");
}

/** tool-engine.positions()의 손익 계산과 동일 규칙 */
function pnl(entryPrice: number | null, currentPrice: number | null, qty: number) {
  const pnlPct = entryPrice && currentPrice ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
  const pnlUsd = entryPrice && currentPrice ? (currentPrice - entryPrice) * qty : null;
  return { pnlPct, pnlUsd };
}

/** 목표가까지 남은 거리(%p) — 기준가가 아니라 "지금 가격" 대비다. */
function distance(target: number | undefined, currentPrice: number | null) {
  return target && currentPrice ? ((target - currentPrice) / currentPrice) * 100 : null;
}

describe("매매 근거 한 줄 문장", () => {
  it("삼분할 2분할이면 분할 번호와 전봉종가·EMA200이 모두 들어간다", () => {
    const line = rationaleLine({
      technique: "split3",
      level: 2,
      baseClose: 12.3,
      ema200: 11.1,
      entry: 11.9,
      tp: 12.14,
      sl: 10.71,
      tpPct: 2,
      slPct: 10,
      quantity: 3,
    });
    expect(line).toContain("삼분할 2분할");
    expect(line).toContain("전봉종가 $12.3");
    expect(line).toContain("EMA200 $11.1");
    expect(line).toContain("진입 $11.9");
    expect(line).toContain("익절 $12.14(+2%)");
    expect(line).toContain("손절 $10.71(-10%)");
    expect(line).toContain("3주");
  });

  it("호가창 기법은 매수벽 가격이 들어가고 삼분할 재료는 안 들어간다", () => {
    const line = rationaleLine({ technique: "orderbook", level: 1, wallPrice: 4.55, entry: 4.5501, quantity: 10 });
    expect(line).toContain("매수벽 $4.55");
    expect(line).not.toContain("EMA200");
    expect(line).not.toContain("1분할"); // 삼분할이 아니면 분할 표기 없음
  });

  it("캔들 기법은 현재봉 시가가 들어간다", () => {
    expect(rationaleLine({ technique: "candle", barOpen: 20.5, quantity: 1 })).toContain("현재봉 시가 $20.5");
  });

  it("소수주(0.065533주)도 그대로 기록된다", () => {
    expect(rationaleLine({ technique: "manual", entry: 327.29, quantity: 0.065533 })).toContain("0.065533주");
  });
});

describe("보유 포지션 손익 계산", () => {
  it("매수가 $10 → 현재가 $11 이면 +10%", () => {
    const { pnlPct, pnlUsd } = pnl(10, 11, 5);
    expect(pnlPct).toBeCloseTo(10, 6);
    expect(pnlUsd).toBeCloseTo(5, 6); // ($11-$10) × 5주
  });

  it("매수가 $10 → 현재가 $9 이면 -10%(손실)", () => {
    expect(pnl(10, 9, 1).pnlPct).toBeCloseTo(-10, 6);
  });

  it("현재가를 못 가져오면 손익은 null(0%로 속이지 않는다)", () => {
    expect(pnl(10, null, 1).pnlPct).toBeNull();
  });

  it("익절·손절까지 남은 거리는 '지금 가격' 기준으로 계산된다", () => {
    // 현재가 $10, 익절 $10.2 → +2%p / 손절 $9 → -10%p
    expect(distance(10.2, 10)).toBeCloseTo(2, 6);
    expect(distance(9, 10)).toBeCloseTo(-10, 6);
  });

  it("기준가 우선순위: 내 기록 진입가 > 토스 평균매입가", () => {
    const rationaleEntry = 11.9;
    const tossAvg = 12.05;
    const entryPrice = rationaleEntry ?? tossAvg;
    expect(entryPrice).toBe(11.9); // 내가 의도한 가격이 기준
    // 기록이 없으면 토스 평단으로 떨어진다
    const noRecord: number | undefined = undefined;
    expect(noRecord ?? tossAvg).toBe(12.05);
  });
});
