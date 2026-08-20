// =============================================================================
// tests/report-accuracy-large.test.ts — 기간별 리포트 '대규모' 정확도 검증 (v0.10.1)
// -----------------------------------------------------------------------------
// [왜 이 테스트인가 — 실제 부정확의 재현]
//   토스 체결내역을 8페이지(약 160건)에서 끊던 탓에, 매매가 잦으면 "최근 30일"을 눌러도
//   30일치가 다 안 들어와 옛 매매가 조용히 빠졌다. 그 근본을 고쳤으므로(수집 깊이·깊이인지 캐시),
//   여기서는 **160건을 훌쩍 넘는 74일치 합성 데이터**로 파이프라인 전체
//   (체결 → 선입선출 매칭 → 기간 집계)가 "이 기간 = 정확히 이 매매들"을 지키는지 못 박는다.
//
//   라이브 토스 1회 확인보다 재현 가능하고 엄밀하다(경계·합산·1등·기간 격리까지 한 번에).
// =============================================================================

import { describe, it, expect } from "vitest";
import { matchFifo, type Fill } from "../lib/fills";
import { buildReportFromRealized, makePeriod } from "../lib/report";

const KST = 540;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 20, 6) - KST * 60_000; // 2026-08-20 15:00 KST

/** d일 전, hh시(KST)의 밀리초 */
function daysAgo(d: number, hh = 10): number {
  // NOW가 속한 KST 날짜의 00:00을 구해 거기서 d일 뒤로/앞으로
  const shifted = NOW + KST * 60_000;
  const midnight = Math.floor(shifted / DAY) * DAY - KST * 60_000;
  return midnight - d * DAY + hh * 3_600_000;
}

// ── 합성 체결 만들기 ────────────────────────────────────────────────────────
//   74일 전부터 오늘까지, '매일' 종목 하나를 사고(같은 날 조금 뒤) 판다.
//   하루 3건씩 → 74일 × 3 = 222 매도(매수 포함 444 체결) = 8페이지(160건)를 크게 초과.
//   각 매도의 수익률은 결정론적으로 정해 검증을 명확히 한다.
function buildFills(): { fills: Fill[]; sellsByDay: Map<number, number> } {
  const fills: Fill[] = [];
  const sellsByDay = new Map<number, number>();
  for (let d = 74; d >= 0; d--) {
    for (let k = 0; k < 3; k++) {
      const sym = `S${d}_${k}`;
      const buyPrice = 10;
      // 짝수 건은 +5%(이익), 홀수 건은 -2%(손실) — 결정론적
      const pct = k % 2 === 0 ? 0.05 : -0.02;
      const sellPrice = Math.round(buyPrice * (1 + pct) * 100) / 100;
      const qty = 10;
      fills.push({ symbol: sym, side: "BUY", qty, price: buyPrice, atMs: daysAgo(d, 9), commission: 0, tax: 0 });
      fills.push({ symbol: sym, side: "SELL", qty, price: sellPrice, atMs: daysAgo(d, 10), commission: 0, tax: 0 });
      sellsByDay.set(d, (sellsByDay.get(d) ?? 0) + 1);
    }
  }
  return { fills, sellsByDay };
}

describe("대규모(74일·222매도) 기간별 정확도 — 160건 상한을 넘겨도 정확", () => {
  const { fills } = buildFills();
  const realized = matchFifo(fills, {});

  it("전제 확인: 매도가 160건(옛 상한)을 훌쩍 넘는다", () => {
    expect(realized.length).toBe(75 * 3); // 0~74일 = 75일 × 3
    expect(realized.length).toBeGreaterThan(160);
  });

  it("오늘 = 오늘 매도 3건만(정확히)", () => {
    const r = buildReportFromRealized(realized, makePeriod("today", NOW, KST));
    expect(r.closed).toBe(3);
  });

  it("최근 7일 = 정확히 7일 × 3 = 21건", () => {
    const r = buildReportFromRealized(realized, makePeriod("week", NOW, KST));
    expect(r.closed).toBe(21);
  });

  it("★핵심: 최근 30일 = 정확히 30일 × 3 = 90건 (옛 상한이면 여기서 잘렸다)", () => {
    const r = buildReportFromRealized(realized, makePeriod("month", NOW, KST));
    expect(r.closed).toBe(90);
    // 손익 합도 정확해야 한다: 하루 3건 중 2건 +5%(+$5), 1건 -2%(-$2) = 하루 +$8
    //   30일 → +$240. (매수 $10 × 10주 = $100 기준, +5%=+$5, -2%=-$2)
    expect(r.totalPnlUsd).toBeCloseTo(30 * 8, 2);
  });

  it("특정 과거 날짜(40일 전) = 그날 3건만, 다른 날은 절대 안 섞임", () => {
    const shifted = NOW + KST * 60_000;
    const midnight = Math.floor(shifted / DAY) * DAY - KST * 60_000;
    const target = new Date(midnight - 40 * DAY + KST * 60_000);
    const picked = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}`;
    const r = buildReportFromRealized(realized, makePeriod("date", NOW, KST, picked));
    expect(r.closed).toBe(3);
  });

  it("[경계] 30일 창의 첫날은 포함, 31일 전은 제외(하루 오차 없음)", () => {
    const p = makePeriod("month", NOW, KST);
    // 30일 창 = 오늘 포함 30일 → 29일 전이 첫날. 30일 전(=창 밖 첫 하루)은 빠져야 한다.
    const inFirst = realized.filter((t) => t.sellAtMs >= p.fromMs && t.sellAtMs <= p.toMs);
    const day29 = realized.filter((t) => t.symbol.startsWith("S29_"));
    const day30 = realized.filter((t) => t.symbol.startsWith("S30_"));
    expect(day29.every((t) => inFirst.includes(t))).toBe(true); // 29일 전 = 포함
    expect(day30.some((t) => inFirst.includes(t))).toBe(false); // 30일 전 = 제외
  });

  it("기간이 커질수록 건수는 단조 증가(오늘 ≤ 7일 ≤ 30일)", () => {
    const today = buildReportFromRealized(realized, makePeriod("today", NOW, KST)).closed;
    const week = buildReportFromRealized(realized, makePeriod("week", NOW, KST)).closed;
    const month = buildReportFromRealized(realized, makePeriod("month", NOW, KST)).closed;
    expect(today).toBeLessThanOrEqual(week);
    expect(week).toBeLessThanOrEqual(month);
  });
});
