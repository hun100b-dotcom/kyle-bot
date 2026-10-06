// =============================================================================
// tests/lab-engine.test.ts — [v0.65.0] 매매연구소 엔진 연동(설정·저장·스캔·요약·내보내기)
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Settings } from "luxon";
import { ToolEngine } from "../electron/tool-engine";
import { aggregate1mTo5m, dropIncompleteBucket, type Candle } from "../lib/indicators";
import { buildSeries, detectRuns, LAB_PARAMS_DEFAULT } from "../lib/lab";

const MIN = 60_000;
const FIVE = 5 * MIN;

afterEach(() => {
  Settings.now = () => Date.now();
  // 엔진은 설정을 process.env에도 반영하므로(persistEnv) 테스트끼리 새지 않게 비운다.
  for (const k of Object.keys(process.env)) if (k.startsWith("LAB_") || k.startsWith("AUTO_SCAN_")) delete process.env[k];
});

function freezeKst(year: number, month: number, day: number, hour: number, minute = 0) {
  const target = DateTime.fromObject({ year, month, day, hour, minute }, { zone: "Asia/Seoul" }).toMillis();
  Settings.now = () => target;
}

type Raw = { o: number; h: number; l: number; c: number; v: number };

/** 5분봉 한 개를 1분봉 5개로 풀어낸다(합치면 정확히 같은 5분봉이 되게). */
function explode(t: number, r: Raw): Candle[] {
  const q = r.v / 5;
  return [
    { time: t, open: r.o, high: r.o, low: r.o, close: r.o, volume: q },
    { time: t + MIN, open: r.o, high: r.h, low: r.o, close: r.h, volume: q },
    { time: t + 2 * MIN, open: r.h, high: r.h, low: r.l, close: r.l, volume: q },
    { time: t + 3 * MIN, open: r.l, high: r.l, low: r.l, close: r.l, volume: q },
    { time: t + 4 * MIN, open: r.l, high: Math.max(r.l, r.c), low: Math.min(r.l, r.c), close: r.c, volume: q },
  ];
}

/**
 * 합성 시장: 완만한 상승 횡보(앞 250봉, 거의 도지 모양) 뒤에 "큰 양봉 연속"을 붙인다.
 *   앞 구간은 아주 천천히 오르고(드리프트) 고저폭이 넓어 몸통이 작은(도지) 하이킨아시 봉이 된다.
 */
function craft(): { oneMin: Candle[]; lastClose: number; tEnd: number } {
  const n = 250;
  // 신호 2번째 봉이 KST 22:00(정규장·휴무 시간대 밖)이 되도록 시작 시각을 고정 — 테스트가 실행 시각에 좌우되지 않게
  const c2Kst = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 22, minute: 0 }, { zone: "Asia/Seoul" }).toMillis();
  const tStart = c2Kst - (n + 1) * FIVE;
  const raws: Raw[] = [];
  let p = 5;
  for (let i = 0; i < n; i++) {
    const o = p;
    p += 0.0004; // 천천히 상승 → 종가가 EMA200 위
    raws.push({ o, h: o + 0.02, l: o - 0.02, c: p, v: 1000 });
  }
  const base = p;
  // 패턴: 1번째(강한 양봉) → 2번째(거래량 3배) → 3번째(거래량 3배) → 4번째 양봉
  raws.push({ o: base, h: base + 0.2, l: base, c: base + 0.2, v: 1000 }); //             1번째
  raws.push({ o: base + 0.2, h: base + 0.45, l: base + 0.2, c: base + 0.45, v: 3200 }); // 2번째
  raws.push({ o: base + 0.45, h: base + 0.7, l: base + 0.45, c: base + 0.7, v: 3600 }); // 3번째
  raws.push({ o: base + 0.7, h: base + 0.85, l: base + 0.7, c: base + 0.85, v: 1500 }); // 4번째
  const oneMin: Candle[] = [];
  raws.forEach((r, i) => oneMin.push(...explode(tStart + i * FIVE, r)));
  // 이후 1분봉(관찰 구간): 완만히 눌렸다 오르는 흐름
  const tEnd = tStart + raws.length * FIVE;
  return { oneMin, lastClose: base + 0.85, tEnd };
}

describe("[v0.65.0] 합성 데이터 점검 — 만든 시장이 실제로 신호를 만든다(테스트 자체의 전제)", () => {
  it("합성 시장에서 detectRuns가 인정 신호(stage 3, 거래량 OK)를 찾는다", () => {
    const { oneMin, tEnd } = craft();
    const raw5m = dropIncompleteBucket(aggregate1mTo5m(oneMin), tEnd + 60 * MIN);
    const s = buildSeries(raw5m, 200);
    const runs = detectRuns(s.ha, s.emaS, LAB_PARAMS_DEFAULT).filter((r) => r.stage >= 3);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[runs.length - 1].volOk2).toBe(true);
  });
});

describe("[v0.65.0] 엔진 — 설정·스캔·요약·내보내기", () => {
  it("공장값 꺼짐, 저장하면 범위 보정 + 재시작 후에도 유지, 켜면 타이머가 돌고 끄면 멈춘다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s0 = eng.getLabStatus();
      expect(s0.enabled).toBe(false);
      expect(s0.rankCount).toBe(120); // v0.68.0: 기본 120위(스캔당 요청이 종목당 1회로 줄어 넓힘)
      expect(s0.dojiBodyMaxPct).toBe(15);
      expect(s0.bodyMinPct).toBe(60);
      expect(s0.volRatioMin).toBe(1.5);
      const s1 = eng.saveLabSettings({ rankCount: 9999, dojiBodyMaxPct: 1, bodyMinPct: 99, volRatioMin: 0.1 });
      expect(s1.rankCount).toBe(200);
      expect(s1.dojiBodyMaxPct).toBe(5);
      expect(s1.bodyMinPct).toBe(90);
      expect(s1.volRatioMin).toBe(1);
      const re = new ToolEngine(dir, { forceMock: true }).getLabStatus();
      expect(re.rankCount).toBe(200);
      expect(re.volRatioMin).toBe(1);
      eng.saveLabSettings({ enabled: true });
      expect((eng as unknown as { labTimer: unknown }).labTimer).not.toBeNull();
      eng.saveLabSettings({ enabled: false });
      expect((eng as unknown as { labTimer: unknown }).labTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("목 서버로 한 번 스캔: 오류 없이 끝나고 상태·파일·요약이 채워진다(신호가 없어도 정상)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      freezeKst(2026, 7, 16, 23, 0); // 정규장
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveLabSettings({ rankCount: 10 });
      const st = await eng.labScanNow();
      expect(st.lastError).toBeNull();
      expect(st.lastScanned).toBeGreaterThan(0);
      expect(st.lastTickAtMs).not.toBeNull();
      expect(existsSync(join(dir, "kylebot-lab.json"))).toBe(true);
      const sum = eng.getLabSummary();
      expect(sum.funnel.dojis).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(sum.variants)).toBe(true);
      expect(sum.status.totalSignals).toBe(sum.counts.total);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("합성 시장 E2E: 엔진이 패턴을 찾아 로우 신호로 저장하고, 요약·상세·내보내기·초기화가 동작한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const { oneMin, tEnd } = craft();
      type Internals = {
        labFetch1m: (s: string, deep?: boolean) => Promise<Candle[]>;
        labProcessSymbol: (s: string, rank: number, price: number | null, nowMs: number) => Promise<void>;
        persistLab: () => void;
        labTrim: () => void;
        labVersion: number;
      };
      const x = eng as unknown as Internals;
      x.labFetch1m = async () => oneMin;
      await x.labProcessSymbol("SYNT", 7, 5.9, tEnd + 90 * MIN);
      x.labVersion++;
      const sum = eng.getLabSummary();
      expect(sum.counts.total).toBeGreaterThanOrEqual(1);
      expect(sum.funnel.dojis).toBeGreaterThan(10); // 합성 횡보는 도지 투성이
      expect(sum.funnel.eligible).toBeGreaterThanOrEqual(1);
      const row = sum.signals[0];
      expect(row.symbol).toBe("SYNT");
      expect(row.rank).toBe(7);
      expect(row.eligible).toBe(true);
      expect(row.backfilled).toBe(true); // 신호 봉 마감보다 한참 늦게 발견
      expect(row.ref).not.toBeNull();
      // 변형 성적표: 98개 안팎(4×4×3 × 진입 순번 + 연계)
      expect(sum.variants.length).toBeGreaterThanOrEqual(48);
      // 상세 + 변형 결과
      const detail = eng.getLabSignal(row.id)!;
      expect(detail.signal.bars.length).toBeGreaterThan(8);
      expect(detail.trades.length).toBeGreaterThanOrEqual(48);
      // 같은 데이터를 다시 스캔해도 신호가 중복으로 쌓이지 않는다(멱등)
      await x.labProcessSymbol("SYNT", 7, 5.9, tEnd + 90 * MIN);
      expect(eng.getLabSummary().counts.total).toBe(sum.counts.total);
      // 내보내기
      const csv = eng.exportLab("signals-csv");
      expect(csv.filename).toMatch(/^capri-lab-signals-.*\.csv$/);
      expect(csv.text.split("\n")[0]).toContain("symbol");
      expect(eng.exportLab("trades-csv").text.split("\n").length).toBeGreaterThan(48);
      const raw = JSON.parse(eng.exportLab("json").text) as { signals: unknown[]; attempts: Record<string, number> };
      expect(raw.signals.length).toBe(sum.counts.total);
      // 파일에 저장되고 재시작 후 복원된다
      x.persistLab();
      const again = new ToolEngine(dir, { forceMock: true });
      expect(again.getLabStatus().totalSignals).toBe(sum.counts.total);
      // 초기화
      eng.labReset();
      expect(eng.getLabStatus().totalSignals).toBe(0);
      expect(eng.getLabSummary().signals).toHaveLength(0);
      void readFileSync;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("가격대($1~9)를 벗어난 종목의 신호는 기록하지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoScanSettings({ priceMin: 20, priceMax: 30 });
      const { oneMin, tEnd } = craft(); // 합성 가격 ≈ 5달러
      const x = eng as unknown as {
        labFetch1m: (s: string, deep?: boolean) => Promise<Candle[]>;
        labProcessSymbol: (s: string, rank: number, price: number | null, nowMs: number) => Promise<void>;
      };
      x.labFetch1m = async () => oneMin;
      await x.labProcessSymbol("OUT", 1, 5.9, tEnd + 90 * MIN);
      expect(eng.getLabStatus().totalSignals).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("[v0.65.1] 규칙 오류가 섞인 1판(v1) 데이터는 폐기하고 새로 쌓는다", () => {
  it("v1 파일을 열면 신호가 비워지고 안내가 뜨며, 파일은 v2로 다시 저장된다", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      writeFileSync(join(dir, "kylebot-lab.json"), JSON.stringify({ v: 1, startedAtMs: 1, attempts: { a: 3 }, signals: [{ id: "X:1" }, { id: "Y:2" }] }), "utf8");
      const eng = new ToolEngine(dir, { forceMock: true });
      const st = eng.getLabStatus();
      expect(st.totalSignals).toBe(0);
      expect(st.note).toContain("폐기");
      expect(st.note).toContain("2건");
      const saved = JSON.parse(readFileSync(join(dir, "kylebot-lab.json"), "utf8")) as { v: number; signals: unknown[] };
      expect(saved.v).toBe(2);
      expect(saved.signals).toHaveLength(0);
      // 같은 폴더를 다시 열면(이미 v2) 안내가 반복되지 않는다
      expect(new ToolEngine(dir, { forceMock: true }).getLabStatus().note).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("최소 봉 크기 설정은 0~5로 보정되고 저장·복원된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.getLabStatus().minRangePct).toBe(0.5);
      expect(eng.saveLabSettings({ minRangePct: 99 }).minRangePct).toBe(5);
      expect(eng.saveLabSettings({ minRangePct: 0 }).minRangePct).toBe(0);
      expect(new ToolEngine(dir, { forceMock: true }).getLabStatus().minRangePct).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.68.0] 연구소 1분봉 저장소 — 처음엔 통으로, 이후엔 새 분만 이어 붙인다", () => {
  it("저장된 봉 뒤에 새로 생긴 분만 합쳐지고(중복 없음·오름차순), 오래된 봉은 보존된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      type I = { labStore: Map<string, { candles: Candle[]; deep: boolean }>; labFetch1m: (s: string, d: boolean) => Promise<Candle[]>; prepareBackend: () => Promise<void> };
      const x = eng as unknown as I;
      await x.prepareBackend();
      const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
      // 이미 받아 둔 과거 봉(깊은 조회를 마친 상태) — 마지막 봉이 10분 전
      const old: Candle[] = Array.from({ length: 300 }, (_, i) => ({ time: nowMin - (310 - i) * 60_000, open: 5, high: 5.1, low: 4.9, close: 5, volume: 100 }));
      x.labStore.set("AAPL", { candles: old, deep: true });
      const merged = await x.labFetch1m("AAPL", true);
      const times = merged.map((c) => c.time);
      expect(new Set(times).size).toBe(times.length); // 중복 없음
      expect([...times].sort((a, b) => a - b)).toEqual(times); // 오름차순
      expect(times[0]).toBe(old[0].time); // 오래된 봉 보존
      expect(merged.length).toBeGreaterThan(old.length); // 새 분이 붙음
      expect(x.labStore.get("AAPL")?.deep).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("스캔을 마치면 누적 스캔 횟수·활성 시간이 늘고 파일에 저장된다(수집 속도 계산용)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-lab-"));
    try {
      freezeKst(2026, 7, 16, 23, 0);
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveLabSettings({ rankCount: 10 });
      expect(eng.getLabStatus().collect.scans).toBe(0);
      await eng.labScanNow();
      const c = eng.getLabStatus().collect;
      expect(c.scans).toBe(1);
      expect(c.activeHours).toBeGreaterThanOrEqual(0);
      const saved = JSON.parse(readFileSync(join(dir, "kylebot-lab.json"), "utf8")) as { scans: number };
      expect(saved.scans).toBe(1);
      expect(new ToolEngine(dir, { forceMock: true }).getLabStatus().collect.scans).toBe(1); // 재시작 후 복원
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
