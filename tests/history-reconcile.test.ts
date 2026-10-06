// =============================================================================
// tests/history-reconcile.test.ts — 자동매매기록 ↔ 토스 실제 체결 대조 규칙 고정 (v0.64.0)
// -----------------------------------------------------------------------------
// [배경] 오너 실사용 보고: "매매기록 탭들에 실제 매매기록이 완벽하게 일치하지 않는다.
//   전수조사 진행 후 토스데이터와 완벽연계해 — 자동매매 거래현황파악에 치명적이다."
//   electron/tool-engine.ts의 reconcileHistoryEntry는 autoTradeHistory(엔진 자체 부기)
//   한 건을 lib/fills.ts의 matchFifo가 만든 '실제 체결' 결과와 대조한다. 이 테스트는
//   그 판정 규칙(matched/mismatch/enriched/not_found/not_applicable)을 고정한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchFifo, type Fill } from "../lib/fills";
import { reconcileHistoryEntry, enteredAtMsFromId, type ReconcilableEntry } from "../lib/history-reconcile";
import { ToolEngine } from "../electron/tool-engine";

const base = 1_700_000_000_000;
const MIN = 60_000;

function f(o: Partial<Fill>): Fill {
  return { symbol: "AAPL", side: "BUY", qty: 10, price: 100, atMs: base, commission: 0, tax: 0, ...o };
}

function entry(o: Partial<ReconcilableEntry>): ReconcilableEntry {
  return { id: "AAPL@100@" + base, symbol: "AAPL", enteredAtMs: base, status: "closed_win", pnlUsd: 10, pnlPct: 1, ...o };
}

describe("enteredAtMsFromId — id에서 진입 시각(ms) 추출", () => {
  it("정상 id에서 세 번째 토막을 숫자로 뽑는다", () => {
    expect(enteredAtMsFromId("AAPL@2.5@1700000000000")).toBe(1700000000000);
  });
  it("토막이 부족하거나 숫자가 아니면 null", () => {
    expect(enteredAtMsFromId("AAPL@2.5")).toBeNull();
    expect(enteredAtMsFromId("AAPL@2.5@not-a-number")).toBeNull();
  });
});

describe("reconcileHistoryEntry — 대조 판정", () => {
  it("watching/active/dryrun은 대조 대상이 아니다(not_applicable)", () => {
    for (const status of ["watching", "active", "dryrun"] as const) {
      expect(reconcileHistoryEntry(entry({ status }), []).status).toBe("not_applicable");
    }
  });

  it("매수 체결이 접수 시각 근처(기본 90분 이내)에서 안 잡히면 not_found", () => {
    const realized = matchFifo([
      f({ side: "BUY", atMs: base + 200 * MIN }), // 200분 뒤 — 기본 창(90분) 밖
      f({ side: "SELL", atMs: base + 210 * MIN, price: 110 }),
    ]);
    expect(reconcileHistoryEntry(entry({}), realized).status).toBe("not_found");
  });

  it("기록된 손익과 실제 체결 손익이 같으면 matched", () => {
    const realized = matchFifo([
      f({ side: "BUY", atMs: base + 5 * MIN, price: 100 }), // 접수 5분 뒤 체결(흔한 지연)
      f({ side: "SELL", atMs: base + 20 * MIN, price: 101 }),
    ]);
    // 10주 × ($101-$100) = $10 실현손익 — matchFifo 결과와 정확히 같은 값으로 기록해 둔다.
    const r = reconcileHistoryEntry(entry({ pnlUsd: 10 }), realized);
    expect(r.status).toBe("matched");
    expect(r.realPnlUsd).toBe(10);
    expect(r.realBuyPrice).toBe(100);
    expect(r.realSellPrice).toBe(101);
  });

  it("기록된 손익과 실제 체결 손익이 다르면 mismatch(허용오차 밖)", () => {
    const realized = matchFifo([
      f({ side: "BUY", atMs: base + 5 * MIN, price: 100 }),
      f({ side: "SELL", atMs: base + 20 * MIN, price: 101 }), // 실제 손익 $10
    ]);
    const r = reconcileHistoryEntry(entry({ pnlUsd: 7 }), realized); // 기록은 $7(부기 오류 상황 재현)
    expect(r.status).toBe("mismatch");
    expect(r.realPnlUsd).toBe(10);
  });

  it("허용오차(기본 2센트) 이내 차이는 matched로 본다(반올림 오차 흡수)", () => {
    const realized = matchFifo([
      f({ side: "BUY", atMs: base + 5 * MIN, price: 100 }),
      f({ side: "SELL", atMs: base + 20 * MIN, price: 101 }), // $10.00
    ]);
    const r = reconcileHistoryEntry(entry({ pnlUsd: 10.01 }), realized);
    expect(r.status).toBe("matched");
  });

  it("[핵심] 기록상 손익 미확정(closed_manual 등 pnlUsd=null)인데 실제 체결은 있으면 enriched로 지금 확인된다", () => {
    // 실사용 사례(v0.63.0 보고): 조건주문이 토스에서 사라져 '손익 미확정'으로 남은 기록 —
    //   토스 체결내역 자체엔 실제 매도가 남아있을 수 있다. 이 경우 포기하지 않고 실제 손익을 찾아낸다.
    const realized = matchFifo([
      f({ side: "BUY", atMs: base + 2 * MIN, price: 2.1 }),
      f({ side: "SELL", atMs: base + 40 * MIN, price: 1.9 }), // 손절
    ]);
    const r = reconcileHistoryEntry(entry({ status: "closed_manual", pnlUsd: null, pnlPct: null }), realized);
    expect(r.status).toBe("enriched");
    expect(r.realPnlUsd).toBeLessThan(0);
  });

  it("같은 종목에 여러 매수가 있으면 접수 시각에 가장 가까운 것으로 매칭한다", () => {
    const realized = matchFifo([
      f({ side: "BUY", atMs: base - 3 * 86_400_000, price: 90 }), // 3일 전 매수(다른 매매)
      f({ side: "SELL", atMs: base - 3 * 86_400_000 + 10 * MIN, price: 92 }),
      f({ side: "BUY", atMs: base + 4 * MIN, price: 100 }), // 이번 매매(접수 4분 뒤 체결)
      f({ side: "SELL", atMs: base + 15 * MIN, price: 103 }),
    ]);
    const r = reconcileHistoryEntry(entry({ pnlUsd: 30 }), realized); // 10주×($103-$100)=$30
    expect(r.status).toBe("matched");
    expect(r.realBuyPrice).toBe(100);
  });

  it("창 경계(90분) 바로 안쪽은 찾고, 바로 바깥쪽은 not_found", () => {
    const inside = matchFifo([f({ side: "BUY", atMs: base + 89 * MIN, price: 100 }), f({ side: "SELL", atMs: base + 95 * MIN, price: 101 })]);
    expect(reconcileHistoryEntry(entry({ pnlUsd: 10 }), inside).status).toBe("matched");

    const outside = matchFifo([f({ side: "BUY", atMs: base + 91 * MIN, price: 100 }), f({ side: "SELL", atMs: base + 95 * MIN, price: 101 })]);
    expect(reconcileHistoryEntry(entry({ pnlUsd: 10 }), outside).status).toBe("not_found");
  });
});

describe("ToolEngine.reconcileAutoHistory — 배선 스모크 테스트", () => {
  it("연결 없음(mode=mock)이면 빈 결과를 정직하게 돌려준다(확인 못 한 걸 '일치'로 거짓 보고하지 않음)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-history-reconcile-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const { results, source } = await eng.reconcileAutoHistory();
      expect(results).toEqual({});
      expect(source).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
