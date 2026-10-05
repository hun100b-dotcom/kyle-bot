// =============================================================================
// tests/defense.test.ts — [v0.63.0] 방어 전략(lib/defense.ts) + 엔진 연동
// =============================================================================
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import {
  atrPct,
  emaSlopePct,
  emaGapPct,
  evaluateDefenseFilters,
  structuralStopPrice,
  isReentryBlocked,
  trailingStopLossStreak,
  excursion,
  type DefenseFilterSettings,
} from "../lib/defense";
import type { Candle } from "../lib/indicators";
import { ToolEngine, type AutoTradeHistoryEntry } from "../electron/tool-engine";

const MIN = 60_000;
const c = (time: number, o: number, h: number, l: number, cl: number): Candle => ({ time, open: o, high: h, low: l, close: cl, volume: 100 });
const kstMs = (s: string) => DateTime.fromFormat(s, "yyyy-MM-dd HH:mm:ss", { zone: "Asia/Seoul" }).toMillis();
const fmt = (ms: number) => DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss");

const OFF: DefenseFilterSettings = { emaMinGapEnabled: false, emaMinGapPct: 6, emaSlopeEnabled: false, atrFilterEnabled: false, atrMaxPct: 3 };

describe("[v0.63.0] 측정값 계산", () => {
  it("emaGapPct = (전봉종가 ÷ EMA − 1) × 100, 계산 불가면 null", () => {
    expect(emaGapPct(10.6, 10)).toBe(6);
    expect(emaGapPct(9.5, 10)).toBe(-5);
    expect(emaGapPct(null, 10)).toBeNull();
    expect(emaGapPct(10, null)).toBeNull();
    expect(emaGapPct(10, 0)).toBeNull();
  });

  it("atrPct — 갭(봉 사이 점프)까지 포함한 실제 변동폭 평균 ÷ 마지막 종가", () => {
    // 15봉: 매 봉 고저폭 0.2, 종가 10 → ATR 0.2 → 2%
    const flat = Array.from({ length: 15 }, (_, i) => c(i * 5 * MIN, 10, 10.1, 9.9, 10));
    expect(atrPct(flat)).toBe(2);
    // 마지막 봉이 전봉 종가(10)에서 11로 갭 상승(고 11.1 저 11.0) → TR = |11.1−10| = 1.1 → 평균 (13×0.2 + 1.1)/14
    const gap = [...flat.slice(0, 14), c(14 * 5 * MIN, 11, 11.1, 11, 11)];
    expect(atrPct(gap)).toBeCloseTo(((13 * 0.2 + 1.1) / 14 / 11) * 100, 1);
    expect(atrPct(flat.slice(0, 10))).toBeNull(); // 봉 부족
  });

  it("emaSlopePct — 오르는 종가면 +, 내리는 종가면 −, 데이터 부족이면 null", () => {
    const up = Array.from({ length: 230 }, (_, i) => 10 + i * 0.01);
    const down = Array.from({ length: 230 }, (_, i) => 20 - i * 0.01);
    expect(emaSlopePct(up, 200)!).toBeGreaterThan(0);
    expect(emaSlopePct(down, 200)!).toBeLessThan(0);
    expect(emaSlopePct(up.slice(0, 205), 200)).toBeNull();
  });
});

describe("[v0.63.0] 방어 필터 판정(evaluateDefenseFilters)", () => {
  const m = { emaGapPct: 4.1, atrPct: 2.5, emaSlopePct: 0.3 };

  it("전부 꺼져 있으면 무엇이든 통과(과거 동작 그대로)", () => {
    expect(evaluateDefenseFilters({ emaGapPct: null, atrPct: null, emaSlopePct: null }, OFF).ok).toBe(true);
  });

  it("이격도: 6% 미만 탈락, 정확히 6%는 통과", () => {
    const s = { ...OFF, emaMinGapEnabled: true };
    const r = evaluateDefenseFilters(m, s);
    expect(r.ok).toBe(false);
    expect(r.emaGapOk).toBe(false);
    expect(r.reasons[0]).toContain("4.1% < 6%");
    expect(evaluateDefenseFilters({ ...m, emaGapPct: 6 }, s).ok).toBe(true);
  });

  it("EMA 기울기: 0 이하면 탈락(평평해도 탈락)", () => {
    const s = { ...OFF, emaSlopeEnabled: true };
    expect(evaluateDefenseFilters(m, s).ok).toBe(true);
    expect(evaluateDefenseFilters({ ...m, emaSlopePct: 0 }, s).ok).toBe(false);
    expect(evaluateDefenseFilters({ ...m, emaSlopePct: -0.2 }, s).reasons[0]).toContain("상승 중 아님");
  });

  it("변동성: 상한 초과 탈락, 같으면 통과", () => {
    const s = { ...OFF, atrFilterEnabled: true, atrMaxPct: 2.5 };
    expect(evaluateDefenseFilters(m, s).ok).toBe(true);
    expect(evaluateDefenseFilters({ ...m, atrPct: 4 }, s).reasons[0]).toContain("변동성 과다");
  });

  it("켜진 필터의 측정값이 null(계산 불가)이면 '모르면 탈락'(실계좌 방어 원칙)", () => {
    const s = { emaMinGapEnabled: true, emaMinGapPct: 6, emaSlopeEnabled: true, atrFilterEnabled: true, atrMaxPct: 3 };
    const r = evaluateDefenseFilters({ emaGapPct: null, atrPct: null, emaSlopePct: null }, s);
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(3);
  });
});

describe("[v0.63.0] ① EMA 기준 손절가(structuralStopPrice)", () => {
  it("EMA 아래 여유%가 고정 손절보다 높으면 그걸 쓴다(더 빨리 끊음)", () => {
    // 진입 10.4, EMA 10, 여유 1.5% → 9.85 / 고정 −10% → 9.36 → 9.85
    expect(structuralStopPrice(10.4, 10, 1.5, 9.36)).toBeCloseTo(9.85, 6);
  });
  it("EMA 기준이 고정 손절보다 더 깊으면 고정 손절을 유지(손실 상한은 절대 안 넓어짐)", () => {
    // 진입 12, EMA 10 → 9.85 / 고정 −10% → 10.8 → 10.8
    expect(structuralStopPrice(12, 10, 1.5, 10.8)).toBe(10.8);
  });
  it("EMA 기준 손절가가 진입가 이상이면 null(손절선을 둘 수 없음 → 진입 안 함)", () => {
    expect(structuralStopPrice(9.8, 10, 1.5, 8.82)).toBeNull();
  });
});

describe("[v0.63.0] ⑤ 재진입 금지·연속 손절", () => {
  const now = kstMs("2026-10-06 23:00:00");
  const row = (symbol: string, status: string, exit: string) => ({ symbol, status, exitedAt: fmt(kstMs(exit)) });

  it("오늘(KST) 손절된 종목만 막는다 — 어제 손절·오늘 익절은 막지 않음", () => {
    const h = [row("BIYA", "closed_loss", "2026-10-06 22:10:00"), row("BGIN", "closed_loss", "2026-10-05 23:00:00"), row("AAA", "closed_win", "2026-10-06 22:00:00")];
    expect(isReentryBlocked(h, "biya", now)).toBe(true);
    expect(isReentryBlocked(h, "BGIN", now)).toBe(false);
    expect(isReentryBlocked(h, "AAA", now)).toBe(false);
  });

  it("연속 손절은 최근부터 거꾸로 세고, 익절이 끼면 끊긴다(취소 등은 무시)", () => {
    const h = [
      row("A", "closed_loss", "2026-10-06 20:00:00"),
      row("B", "closed_win", "2026-10-06 21:00:00"),
      row("C", "closed_loss", "2026-10-06 22:00:00"),
      row("D", "cancelled", "2026-10-06 22:10:00"),
      row("E", "closed_loss", "2026-10-06 22:30:00"),
    ];
    expect(trailingStopLossStreak(h)).toBe(2);
    // 이번 실행 시작(22:15) 이후만 세면 1
    expect(trailingStopLossStreak(h, kstMs("2026-10-06 22:15:00"), now)).toBe(1);
    expect(trailingStopLossStreak([])).toBe(0);
  });
});

describe("[v0.63.0] ② 최대 역행·순행(excursion)", () => {
  it("보유 구간 1분봉의 최저·최고로 MAE(−)·MFE(+) %를 계산", () => {
    const t0 = kstMs("2026-10-06 22:00:00");
    const candles = [c(t0 - 10 * MIN, 1, 5, 0.1, 1), c(t0, 10, 10.2, 9.5, 10), c(t0 + MIN, 10, 10.3, 9.8, 10.1), c(t0 + 20 * MIN, 1, 99, 0.1, 1)];
    const ex = excursion(candles, 10, t0, t0 + 5 * MIN)!;
    expect(ex.maePct).toBe(-5); // 9.5
    expect(ex.mfePct).toBe(3); // 10.3
    expect(excursion([], 10, t0, t0 + MIN)).toBeNull();
  });
});

describe("[v0.63.0] 엔진 — 설정 저장·복원 + 연속 손절 자동중지", () => {
  it("방어 설정 공장값: 필터 3종 꺼짐·손절 고정%·재진입 금지 켬·연속손절 3회, 저장하면 재시작 후에도 유지", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-def-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s0 = eng.getSettings();
      expect(s0.autoScanEmaMinGapEnabled).toBe(false);
      expect(s0.autoScanEmaMinGapPct).toBe(6);
      expect(s0.autoScanEmaSlopeEnabled).toBe(false);
      expect(s0.autoScanAtrFilterEnabled).toBe(false);
      expect(s0.autoTradeSlMode).toBe("fixed");
      expect(s0.autoTradeReentryBlockEnabled).toBe(true);
      expect(s0.autoTradeLossStreakLimit).toBe(3);

      eng.saveAutoScanSettings({ emaMinGapEnabled: true, emaMinGapPct: 999, emaSlopeEnabled: true, atrFilterEnabled: true, atrMaxPct: 0.01 });
      eng.saveAutoTradeSettings({ slMode: "ema", emaStopBufferPct: 2, reentryBlockEnabled: false, lossStreakLimit: 2 });
      const s1 = new ToolEngine(dir, { forceMock: true }).getSettings();
      expect(s1.autoScanEmaMinGapEnabled).toBe(true);
      expect(s1.autoScanEmaMinGapPct).toBe(50); // 상한 보정
      expect(s1.autoScanEmaSlopeEnabled).toBe(true);
      expect(s1.autoScanAtrFilterEnabled).toBe(true);
      expect(s1.autoScanAtrMaxPct).toBe(0.5); // 하한 보정
      expect(s1.autoTradeSlMode).toBe("ema");
      expect(s1.autoTradeEmaStopBufferPct).toBe(2);
      expect(s1.autoTradeReentryBlockEnabled).toBe(false);
      expect(s1.autoTradeLossStreakLimit).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("이번 실행에서 연속 손절이 한도(2)에 닿는 순간 자동매매가 스스로 꺼진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-def-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ lossStreakLimit: 2 });
      type Internals = {
        autoTradeHistory: AutoTradeHistoryEntry[];
        updateAutoTradeHistory: (s: string, e: number, t: number, p: Partial<AutoTradeHistoryEntry>) => void;
        autoTradeTimer: unknown;
      };
      const x = eng as unknown as Internals;
      eng.startAutoTrade();
      const base = Date.now();
      const mk = (sym: string, t: number): AutoTradeHistoryEntry => ({
        id: `${sym}@1@${t}`, symbol: sym, entry: 1, tp: 1.02, sl: 0.9, quantity: 1, enteredAt: fmt(t),
        status: "active", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "",
      });
      x.autoTradeHistory.push(mk("AAA", base), mk("BBB", base + 1));
      x.updateAutoTradeHistory("AAA", 1, base, { status: "closed_loss", exitedAt: fmt(Date.now()), pnlUsd: -0.1 });
      expect(eng.getAutoTradeStatus().enabled).toBe(true); // 1회 — 아직
      x.updateAutoTradeHistory("BBB", 1, base + 1, { status: "closed_loss", exitedAt: fmt(Date.now() + 1000), pnlUsd: -0.1 });
      expect(eng.getAutoTradeStatus().enabled).toBe(false); // 2회 — 자동 중지
      const j = eng.getJournal().map((e) => e.summary).join("\n");
      expect(j).toContain("연속 손절 2회");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
