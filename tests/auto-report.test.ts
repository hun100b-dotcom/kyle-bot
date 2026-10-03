// =============================================================================
// tests/auto-report.test.ts — 자동매매 리포트(lib/auto-report.ts) + 엔진의 실행(run) 기록
// =============================================================================
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import {
  buildAutoReport,
  parseKstNoYear,
  reportToMarkdown,
  reportAiPrompt,
  fmtDuration,
  type AutoRunRecord,
  type ReportHistoryEntry,
} from "../lib/auto-report";
import { ToolEngine } from "../electron/tool-engine";

const kstMs = (s: string) => DateTime.fromFormat(s, "yyyy-MM-dd HH:mm:ss", { zone: "Asia/Seoul" }).toMillis();
const fmt = (ms: number) => DateTime.fromMillis(ms).setZone("Asia/Seoul").toFormat("MM-dd HH:mm:ss");

function run(over: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    id: "run-1",
    startedAtMs: kstMs("2026-10-01 22:00:00"),
    lastActiveAtMs: kstMs("2026-10-02 02:00:00"),
    endedAtMs: kstMs("2026-10-02 02:00:00"),
    loopCount: 48,
    scanCount: 40,
    endReason: "오너가 직접 중지",
    startAssetsUsd: 1000,
    commissionRate: null,
    carriedPositions: 0,
    openPositions: [],
    errors: { apiTimeouts: 2, apiRetries: 3, apiFailures: 1, cycleErrors: 0 },
    ...over,
  };
}

/** 진입→청산 기록 하나 만들기(entry 22:10 접수, 지정 시각에 청산). */
function trade(sym: string, status: string, pnl: number, exitAt: string, enteredAt = "2026-10-01 22:10:00"): ReportHistoryEntry {
  return {
    id: `${sym}@1@${kstMs(enteredAt)}`,
    symbol: sym,
    entry: 10,
    quantity: 10,
    enteredAt: fmt(kstMs(enteredAt)),
    status,
    exitedAt: fmt(kstMs(exitAt)),
    exitPrice: 10 + pnl / 10,
    pnlUsd: pnl,
  };
}

const NOW = kstMs("2026-10-02 03:00:00");

describe("[v0.62.1] 자동매매 리포트 — 매매 통계·손익·MDD 계산", () => {
  const hist: ReportHistoryEntry[] = [
    trade("AAA", "closed_win", 30, "2026-10-01 23:10:00"), // +30
    trade("BBB", "closed_loss", -20, "2026-10-02 00:10:00"), // -20
    trade("CCC", "closed_loss", -10, "2026-10-02 01:10:00"), // -10
    trade("DDD", "closed_win", 50, "2026-10-02 01:40:00"), // +50
    trade("OLD", "closed_win", 999, "2026-09-20 10:00:00"), // 이 실행 이전 → 제외
    trade("LATE", "closed_win", 999, "2026-10-02 02:30:00"), // 이 실행 종료 이후 → 제외
    trade("CAN", "cancelled", 0, "2026-10-02 00:30:00"), // 취소는 매매가 아님
    { ...trade("OCO", "oco_failed", 0, "2026-10-02 00:40:00"), pnlUsd: null },
  ];

  it("기간 안에 청산된 매매만 집계하고, 승률·손익비·총손익이 맞다", () => {
    const r = buildAutoReport(run(), hist, NOW);
    expect(r.trades.total).toBe(4);
    expect(r.trades.wins).toBe(2);
    expect(r.trades.losses).toBe(2);
    expect(r.trades.winRatePct).toBe(50);
    expect(r.trades.grossProfitUsd).toBe(80);
    expect(r.trades.grossLossUsd).toBe(30);
    expect(r.trades.profitFactor).toBeCloseTo(2.67, 2); // 80/30
    expect(r.money.realizedGrossUsd).toBe(50);
    expect(r.money.realizedNetUsd).toBe(50); // 수수료율 모름 → 총=순
    expect(r.money.estFeesUsd).toBeNull();
    expect(r.money.startAssetsUsd).toBe(1000);
    expect(r.money.endAssetsUsd).toBe(1050);
    expect(r.money.returnPct).toBe(5);
    expect(r.trades.cancelled).toBe(1);
    expect(r.trades.ocoFailed).toBe(1);
  });

  it("MDD는 실현손익 누적 곡선의 고점 대비 최대 하락 — +30, -20, -10, +50 → 고점1030에서 1000까지 -30", () => {
    const r = buildAutoReport(run(), hist, NOW);
    expect(r.money.mddUsd).toBe(30);
    expect(r.money.mddPct).toBeCloseTo(2.91, 2); // 30 / 1030
  });

  it("평균 보유시간 = 진입 접수→청산 평균", () => {
    const r = buildAutoReport(run(), hist, NOW);
    // 22:10 접수 기준 청산까지: 1h, 2h, 3h, 3h30m → 평균 2h37.5m
    expect(r.trades.avgHoldMs).toBe(142.5 * 60_000); // (60+120+180+210)/4분
  });

  it("손실이 하나도 없으면 손익비는 null + '∞(손실 없음)' 표기", () => {
    const r = buildAutoReport(run(), [trade("AAA", "closed_win", 30, "2026-10-01 23:10:00")], NOW);
    expect(r.trades.profitFactor).toBeNull();
    expect(r.trades.profitFactorLabel).toBe("∞(손실 없음)");
    expect(r.trades.winRatePct).toBe(100);
  });

  it("매매가 없으면 승률·손익비·평균보유는 '—'(null)이고 손익 0", () => {
    const r = buildAutoReport(run(), [], NOW);
    expect(r.trades.total).toBe(0);
    expect(r.trades.winRatePct).toBeNull();
    expect(r.trades.avgHoldMs).toBeNull();
    expect(r.trades.profitFactorLabel).toBe("—");
    expect(r.money.realizedNetUsd).toBe(0);
    expect(r.money.mddUsd).toBe(0);
  });

  it("수수료율이 있으면 (매수금액+매도금액)×수수료율을 추정해 순손익에서 뺀다", () => {
    const r = buildAutoReport(run({ commissionRate: 0.001 }), [trade("AAA", "closed_win", 30, "2026-10-01 23:10:00")], NOW);
    // 진입 10×10=100, 청산 13×10=130 → (100+130)×0.001 = 0.23
    expect(r.money.estFeesUsd).toBe(0.23);
    expect(r.money.realizedNetUsd).toBe(29.77);
  });

  it("시작 자산을 모르면(null) 종료 자산·수익률·MDD%는 null — 억지로 채우지 않는다", () => {
    const r = buildAutoReport(run({ startAssetsUsd: null }), hist, NOW);
    expect(r.money.endAssetsUsd).toBeNull();
    expect(r.money.returnPct).toBeNull();
    expect(r.money.mddPct).toBeNull();
    expect(r.money.realizedNetUsd).toBe(50);
  });

  it("진행 중(endedAtMs=null)이면 live=true, 종료 사유는 '실행 중', 현재 시각까지의 매매를 포함", () => {
    const r = buildAutoReport(run({ endedAtMs: null, endReason: null }), hist, NOW);
    expect(r.live).toBe(true);
    expect(r.overview.endReason).toBe("실행 중");
    expect(r.trades.total).toBe(5); // LATE(02:30 청산)도 현재(03:00)까지엔 포함
  });

  it("운용 시간·사이클·오류 요약이 실행 기록 값 그대로 나온다", () => {
    const r = buildAutoReport(run(), hist, NOW);
    expect(r.overview.uptimeMs).toBe(4 * 3600_000);
    expect(r.overview.loopCount).toBe(48);
    expect(r.overview.scanCount).toBe(40);
    expect(r.system).toEqual({ apiTimeouts: 2, apiRetries: 3, apiFailures: 1, cycleErrors: 0 });
    expect(r.money.slippage).toBe("측정 불가");
  });

  it("마크다운·AI 프롬프트에 4개 섹션과 핵심 수치, 한계 설명이 들어간다", () => {
    const r = buildAutoReport(run(), hist, NOW);
    const md = reportToMarkdown(r);
    for (const h of ["① 운용 개요", "② 수익·자산", "③ 매매 통계", "④ 포지션·시스템", "계산 기준·한계"]) expect(md).toContain(h);
    expect(md).toContain("승률: 50%");
    expect(md).toContain("2.67");
    expect(md).toContain("종료 사유: 오너가 직접 중지");
    const prompt = reportAiPrompt(r);
    expect(prompt).toContain("분석해 주세요");
    expect(prompt).toContain(md);
  });

  it("해가 바뀌는 시점의 'MM-dd HH:mm:ss'도 기준 시각 근처의 해로 해석한다", () => {
    const ref = kstMs("2026-12-31 23:00:00");
    expect(parseKstNoYear("01-01 00:30:00", ref)).toBe(kstMs("2027-01-01 00:30:00"));
    expect(parseKstNoYear("12-31 23:30:00", ref)).toBe(kstMs("2026-12-31 23:30:00"));
    expect(parseKstNoYear("엉터리", ref)).toBeNull();
  });

  it("fmtDuration은 일·시간·분을 읽기 쉽게", () => {
    expect(fmtDuration(90 * 60_000)).toBe("1시간 30분");
    expect(fmtDuration(26 * 3600_000 + 5 * 60_000)).toBe("1일 2시간 5분");
    expect(fmtDuration(0)).toBe("0분");
  });
});

describe("[v0.62.1] 엔진 — 자동매매 켬/끔이 실행(run) 기록으로 남는다", () => {
  it("켜고 끄면 종료 사유가 담긴 실행 기록이 파일에 저장되고, 리포트로 조회된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-report-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoScanSettings({ count: 10 });
      eng.startAutoTrade();
      await eng.autoScanNow(); // 첫 사이클이 끝날 때까지 기다림
      eng.stopAutoTrade("테스트 종료");
      const file = join(dir, "kylebot-auto-runs.json");
      expect(existsSync(file)).toBe(true);
      const runs = JSON.parse(readFileSync(file, "utf8")) as AutoRunRecord[];
      expect(runs).toHaveLength(1);
      expect(runs[0].endReason).toBe("테스트 종료");
      expect(runs[0].endedAtMs).not.toBeNull();
      expect(runs[0].loopCount).toBeGreaterThanOrEqual(1);
      const res = await eng.getAutoReports();
      expect(res.reports).toHaveLength(1);
      expect(res.reports[0].live).toBe(false);
      expect(res.reports[0].overview.endReason).toBe("테스트 종료");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("사유 없이 끄면 '오너가 직접 중지'로 기록된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-report-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.startAutoTrade();
      eng.stopAutoTrade();
      const runs = JSON.parse(readFileSync(join(dir, "kylebot-auto-runs.json"), "utf8")) as AutoRunRecord[];
      expect(runs[0].endReason).toBe("오너가 직접 중지");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("끄지 못한 채 앱이 꺼진 실행은 다음에 열 때 '앱 종료'로 마감된다(마지막 활동 시각 기준)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-report-"));
    try {
      const stale = run({ endedAtMs: null, endReason: null, lastActiveAtMs: kstMs("2026-10-02 01:00:00") });
      writeFileSync(join(dir, "kylebot-auto-runs.json"), JSON.stringify([stale]), "utf8");
      new ToolEngine(dir, { forceMock: true }); // 생성자가 마감 처리
      const runs = JSON.parse(readFileSync(join(dir, "kylebot-auto-runs.json"), "utf8")) as AutoRunRecord[];
      expect(runs[0].endedAtMs).toBe(kstMs("2026-10-02 01:00:00"));
      expect(runs[0].endReason).toContain("앱 종료");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("실행 기록이 30건을 넘으면 오래된 것부터 정리한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-report-"));
    try {
      const many = Array.from({ length: 35 }, (_, i) => run({ id: `run-${i}` }));
      writeFileSync(join(dir, "kylebot-auto-runs.json"), JSON.stringify(many), "utf8");
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.startAutoTrade(); // 새 기록 추가 → 저장 시 상한 적용
      eng.stopAutoTrade();
      const runs = JSON.parse(readFileSync(join(dir, "kylebot-auto-runs.json"), "utf8")) as AutoRunRecord[];
      expect(runs.length).toBe(30);
      expect(runs[0].id).toBe("run-6"); // 앞쪽 6개(0~5)가 밀려남
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.62.1] 네트워크 오류 카운터(netStats) — 리포트 '오류 로그 요약'의 재료", () => {
  it("타임아웃·네트워크 실패를 각각 센다", async () => {
    const { fetchWithTimeout, netStats } = await import("../lib/fetch-timeout");
    const before = { ...netStats };
    const orig = globalThis.fetch;
    try {
      // 1) 신호(abort)를 받으면 AbortError로 끝나는 fetch → 타임아웃
      globalThis.fetch = ((_u: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as typeof fetch;
      await expect(fetchWithTimeout("http://x", {}, 10, "t")).rejects.toThrow("타임아웃");
      expect(netStats.timeouts).toBe(before.timeouts + 1);
      // 2) 연결 실패 → failures
      globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
      await expect(fetchWithTimeout("http://x", {}, 50, "t")).rejects.toThrow("ECONNREFUSED");
      expect(netStats.failures).toBe(before.failures + 1);
      expect(netStats.timeouts).toBe(before.timeouts + 1); // 타임아웃으로 이중 집계되지 않음
    } finally {
      globalThis.fetch = orig;
    }
  });
});
