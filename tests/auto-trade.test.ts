// =============================================================================
// tests/auto-trade.test.ts — 자동매매 엔진 상태 관리 테스트 (v0.26.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나? / 왜 이만큼만?]
//   자동매매의 "판단 로직"(안전 게이트)은 lib/auto-risk.ts에서, "OCO 발동 감지"는
//   tests/conditional-fx.integration.test.ts에서, "진입→체결→OCO 등록"은 기존
//   tests/bracket.test.ts(placeBracketCore가 그대로 재사용됨)에서 각각 이미 검증된다.
//
//   이 파일은 그 외에 자동매매만의 새 동작 — ①시작/중지 상태 전환 ②한도 설정 저장이
//   재시작해도 유지되는지 ③"켜짐" 자체는 절대 저장되지 않는지(안전 원칙) — 를 검증한다.
//
//   [왜 실제 스캔(startAutoTrade → 5분 사이클)까지는 테스트하지 않나?]
//   scanScreener는 목 서버의 결정적이지만 매끈한(완만한 상승) 가상 캔들로 동작하는데,
//   "합격(confirmed)" 판정에 필요한 고점-도지 패턴은 그 캔들 모양에서 우연히도 거의
//   나오지 않는다(기존 tests/indicators.test.ts의 스캔 테스트도 같은 이유로 "합격" 여부가
//   아니라 데이터가 채워지는지만 확인한다). 그래서 "실제 진입까지" 시뮬레이션하는 테스트는
//   이 시점에서는 비결정적이라 만들지 않았다 — 대신 진입 로직 자체(계산·중복방지·게이트)는
//   이미 순수 함수/기존 테스트로 커버돼 있다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";

describe("자동매매 상태 관리 — v0.26.0", () => {
  it("엔진을 처음 만들면 자동매매는 꺼진 상태고 한도는 공장값(3종목/5%/30%)이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.getAutoTradeStatus();
      expect(s.enabled).toBe(false);
      expect(s.positions).toEqual([]);
      expect(s.realizedPnlUsd).toBe(0);
      expect(s.maxPositions).toBe(3);
      expect(s.maxLossPct).toBe(5);
      expect(s.maxInvestPct).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stopAutoTrade는 한 번도 시작하지 않았어도 안전하게 동작한다(꺼진 채 그대로)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.stopAutoTrade("테스트");
      expect(s.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("한도 설정(saveAutoTradeSettings)은 재시작(새 엔진)해도 유지된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const saved = eng.saveAutoTradeSettings({ maxPositions: 5, maxLossPct: 8, maxInvestPct: 50 });
      expect(saved.autoTradeMaxPositions).toBe(5);
      expect(saved.autoTradeMaxLossPct).toBe(8);
      expect(saved.autoTradeMaxInvestPct).toBe(50);

      const eng2 = new ToolEngine(dir, { forceMock: true });
      const s2 = eng2.getSettings();
      expect(s2.autoTradeMaxPositions).toBe(5);
      expect(s2.autoTradeMaxLossPct).toBe(8);
      expect(s2.autoTradeMaxInvestPct).toBe(50);
      // [안전 원칙] "켜짐" 자체는 절대 저장되지 않는다 — 재시작하면 항상 꺼진 채 시작.
      expect(s2.autoTradeEnabled).toBe(false);
      expect(eng2.getAutoTradeStatus().enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("0 이하·비정상 값은 무시하고 이전 값을 유지한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 4, maxLossPct: 6, maxInvestPct: 40 });
      const s = eng.saveAutoTradeSettings({ maxPositions: 0, maxLossPct: -1, maxInvestPct: NaN });
      expect(s.autoTradeMaxPositions).toBe(4);
      expect(s.autoTradeMaxLossPct).toBe(6);
      expect(s.autoTradeMaxInvestPct).toBe(40);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startAutoTrade는 켜짐 상태로 바꾸고, 곧바로 stopAutoTrade하면 다시 꺼진다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // [주의] startAutoTrade는 백그라운드에서 스캔(최대 60종목)을 즉시 1회 돌리기 시작한다
      // (fire-and-forget). 이 테스트는 그 스캔의 "완료"를 기다리지 않고 상태 전환만 본다.
      const s1 = eng.startAutoTrade();
      expect(s1.enabled).toBe(true);
      const s2 = eng.stopAutoTrade();
      expect(s2.enabled).toBe(false);
      // 백그라운드 스캔이 짧게라도 진행되다 끝나도 안전하게 무시되도록, 잠깐 양보한다.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
