// =============================================================================
// tests/fills-cache.test.ts — 매매 이력을 기기에 쌓아 '연결 없이도' 리포트가 보이게 (v0.9.8)
// -----------------------------------------------------------------------------
// [배경 — 실제 사고]
//   리포트가 매번 토스에서 **실시간으로** 체결내역을 불러오게 만들었더니,
//   사장님이 **회사에서** 폰으로 열었을 때 조회가 안 돼 리포트가 통째로 비어 보였다.
//   (홈 PC를 거쳐야만 토스가 열리는 구조이기 때문)
//
//   그래서 한 번 받아 온 체결은 기기에 **누적 저장**하고, 연결이 없으면 그 기록으로 그린다.
//   이 파일은 그 저장·병합 규칙을 고정한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mergeFills, fillKey, matchFifo, type Fill } from "../lib/fills";
import { buildReportFromRealized, makePeriod } from "../lib/report";

const KST = 540;
function ms(d: number, hh = 10): number {
  return Date.UTC(2026, 7, d, hh) - KST * 60_000; // 2026-08-dd
}
function f(over: Partial<Fill> = {}): Fill {
  return { symbol: "XOS", side: "BUY", qty: 10, price: 4, atMs: ms(18), commission: 0, tax: 0, ...over };
}

describe("mergeFills — 저장본과 새로 받은 것 합치기", () => {
  it("같은 체결은 두 번 쌓이지 않는다(중복 제거)", () => {
    const a = f({ atMs: ms(18) });
    const merged = mergeFills([a], [a, f({ atMs: ms(19) })]);
    expect(merged).toHaveLength(2);
  });

  it("시간순으로 정렬된다(선입선출 계산의 전제)", () => {
    const merged = mergeFills([f({ atMs: ms(19) })], [f({ atMs: ms(17) }), f({ atMs: ms(18) })]);
    expect(merged.map((x) => x.atMs)).toEqual([ms(17), ms(18), ms(19)]);
  });

  it("저장본이 비어 있어도 새 것만으로 채워진다", () => {
    expect(mergeFills([], [f()])).toHaveLength(1);
  });

  it("새로 받은 게 없으면 저장본이 그대로 남는다(연결 없을 때 지워지면 안 된다)", () => {
    const saved = [f({ atMs: ms(15) }), f({ atMs: ms(16) })];
    expect(mergeFills(saved, [])).toHaveLength(2);
  });

  it("열쇠는 종목·방향·시각·수량·가격으로 만든다", () => {
    expect(fillKey(f())).toBe(fillKey(f()));
    expect(fillKey(f())).not.toBe(fillKey(f({ qty: 11 })));
  });
});

describe("저장된 이력만으로 기간별 리포트가 나온다(연결 없음 가정)", () => {
  // 홈에서 한 번 받아 저장해 둔 이력이라고 가정
  const saved: Fill[] = [
    f({ symbol: "XOS", side: "BUY", qty: 100, price: 4.0, atMs: ms(13, 9) }),
    f({ symbol: "XOS", side: "SELL", qty: 100, price: 4.4, atMs: ms(13, 10) }), // 8/13 +40
    f({ symbol: "SLE", side: "BUY", qty: 50, price: 10, atMs: ms(17, 9) }),
    f({ symbol: "SLE", side: "SELL", qty: 50, price: 11.5, atMs: ms(17, 10) }), // 8/17 +75 (+15% — 1등)
    f({ symbol: "BTCT", side: "BUY", qty: 10, price: 20, atMs: ms(19, 9) }),
    f({ symbol: "BTCT", side: "SELL", qty: 10, price: 21, atMs: ms(19, 10) }), // 8/19 +10
  ];
  const realized = matchFifo(saved, {});
  const NOW = ms(19, 15);

  it("오늘", () => {
    const r = buildReportFromRealized(realized, makePeriod("today", NOW, KST));
    expect(r.closed).toBe(1);
    expect(r.totalPnlUsd).toBeCloseTo(10, 2);
  });

  it("최근 7일 — 저장된 과거 매매까지 전부", () => {
    const r = buildReportFromRealized(realized, makePeriod("week", NOW, KST));
    expect(r.closed).toBe(3);
    expect(r.totalPnlUsd).toBeCloseTo(125, 2); // 40 + 75 + 10
    expect(r.best?.symbol).toBe("SLE"); // +15% 로 가장 높다(다른 종목은 +10%)
  });

  it("특정 과거 날짜도 볼 수 있다", () => {
    const r = buildReportFromRealized(realized, makePeriod("date", NOW, KST, "2026-08-13"));
    expect(r.closed).toBe(1);
    expect(r.rows[0].symbol).toBe("XOS");
  });

  it("저장된 이력이 하나도 없으면 0건(빈 상태)", () => {
    const r = buildReportFromRealized([], makePeriod("month", NOW, KST));
    expect(r.closed).toBe(0);
    expect(r.best).toBeNull();
  });
});
