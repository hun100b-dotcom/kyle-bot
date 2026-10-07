// =============================================================================
// tests/entry-level-1_5.test.ts — [v0.69.5] 1.5분할 진입 타점(1분할과 2분할의 한가운데)
// =============================================================================
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calcSplit3, calcSplit3Level } from "../lib/calc";
import { ToolEngine } from "../electron/tool-engine";

describe("calcSplit3Level — 1.5분할", () => {
  it("1분할과 2분할의 한가운데(전봉종가 − gap/2)에 진입가가 잡히고, 익절/손절은 진입가 기준 %다", () => {
    const { splits } = calcSplit3(2.62, 2.0144, 2, 10);
    const l15 = calcSplit3Level(2.62, 2.0144, 2, 10, 1.5);
    expect(splits[0].entry).toBe(2.41);
    expect(splits[1].entry).toBe(2.21);
    expect(l15.entry).toBe(2.31); // (2.41 + 2.21) / 2
    expect(l15.entry).toBeLessThan(splits[0].entry);
    expect(l15.entry).toBeGreaterThan(splits[1].entry);
    expect(l15.level).toBe(1.5);
    expect(l15.tp).toBe(2.35); // 2.31 × 1.02 = 2.3562 → 2.35
    expect(l15.sl).toBe(2.07); // 2.31 × 0.9 = 2.079 → 2.07
  });

  it("1·2분할은 기존 calcSplit3 결과 그대로이고, 전봉종가가 EMA200 이하면 1.5분할도 던진다", () => {
    expect(calcSplit3Level(2.62, 2.0144, 2, 10, 1)).toEqual(calcSplit3(2.62, 2.0144, 2, 10).splits[0]);
    expect(calcSplit3Level(2.62, 2.0144, 2, 10, 2)).toEqual(calcSplit3(2.62, 2.0144, 2, 10).splits[1]);
    expect(() => calcSplit3Level(2.0, 2.1, 2, 10, 1.5)).toThrow();
  });
});

describe("자동매매 설정 — 진입 타점 1.5 저장", () => {
  it("1.5를 저장하면 그대로 유지되고, 이상한 값은 무시한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lvl-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.saveAutoTradeSettings({ entryLevel: 1.5 }).autoTradeEntryLevel).toBe(1.5);
      expect(eng.saveAutoTradeSettings({ entryLevel: 3 as never }).autoTradeEntryLevel).toBe(1.5);
      expect(eng.saveAutoTradeSettings({ entryLevel: 2 }).autoTradeEntryLevel).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
