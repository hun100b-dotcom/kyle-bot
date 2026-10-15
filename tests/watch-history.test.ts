// =============================================================================
// tests/watch-history.test.ts — [관찰종목 이력] 오너 요청: "관찰된 종목이 어떻게 탈락·확정됐는지
//   확인할 수 있는 곳이 필요 + 그에 대한 분석도" — 전부 순수 함수라 실제 스캔·ToolEngine 없이 검증한다.
// =============================================================================
import { describe, it, expect } from "vitest";
import {
  bucketMissReason,
  summarizeMissReasons,
  updateWatchHistory,
  WATCH_HISTORY_MAX,
  type ScreenResult,
  type ScreenRun,
  type WatchHistoryEntry,
} from "../electron/tool-engine";

type RunOpts = Pick<ScreenRun, "emaTrendEnabled" | "cloudEnabled" | "nextCandleConfirmEnabled" | "dojiMaxGapMinutes">;

const baseRun: RunOpts = { emaTrendEnabled: true, cloudEnabled: true, nextCandleConfirmEnabled: true, dojiMaxGapMinutes: 20 };

function mkResult(overrides: Partial<ScreenResult> = {}): ScreenResult {
  return {
    rank: 1,
    symbol: "AAAA",
    price: 5,
    ema200: 4,
    cloudTop: 4.2,
    priceInBand: true,
    aboveEma: true,
    aboveCloud: true,
    status: "watch",
    sessionHigh: 5.5,
    proximityPct: -9,
    n1m: 1200,
    n5m: 240,
    evidence: null,
    ...overrides,
  };
}

describe("summarizeMissReasons — 탈락 사유 문장 생성", () => {
  it("가격대를 벗어나면 현재가를 포함한 사유를 낸다", () => {
    const r = mkResult({ status: "none", priceInBand: false, price: 12.5 });
    expect(summarizeMissReasons(r, baseRun)).toEqual(["가격대 벗어남 (현재가 $12.50)"]);
  });

  it("EMA 필터가 꺼져 있으면 EMA 아래여도 사유에 안 들어간다(켜진 조건만 집계)", () => {
    const r = mkResult({ status: "none", aboveEma: false });
    expect(summarizeMissReasons(r, { ...baseRun, emaTrendEnabled: false })).not.toContain("EMA200 아래");
  });

  it("EMA 필터가 켜져 있고 아래면 사유에 들어간다", () => {
    const r = mkResult({ status: "none", aboveEma: false });
    expect(summarizeMissReasons(r, baseRun)).toContain("EMA200 아래");
  });

  it("구름 필터도 같은 원칙(꺼지면 집계 제외, 켜지면 집계)", () => {
    const r = mkResult({ status: "none", aboveCloud: false });
    expect(summarizeMissReasons(r, { ...baseRun, cloudEnabled: false })).not.toContain("이치모쿠 구름 아래/속");
    expect(summarizeMissReasons(r, baseRun)).toContain("이치모쿠 구름 아래/속");
  });

  it("도지 패턴 필터는 우선순위 순으로 하나만 낸다(firstDoji가 false면 그다음은 안 봄)", () => {
    const r = mkResult({
      status: "none",
      evidence: {
        mode: "ha", sessionStart: "22:30", sessionHigh: 5.5, sessionHighTime: "22:40",
        doji: null, next: null, gapFromHighMinutes: null,
        filters: { priceBand: true, aboveEma: true, aboveCloud: true, firstDoji: false, bothWicks: false, nextBearish: false, recentDoji: false, dojiNearHigh: false },
      },
    });
    const reasons = summarizeMissReasons(r, baseRun);
    expect(reasons).toEqual(["최고점 이후 음봉 도지 없음"]);
  });

  it("firstDoji는 통과했지만 다음 봉이 음봉이 아니면 그 사유만 낸다", () => {
    const r = mkResult({
      status: "none",
      evidence: {
        mode: "ha", sessionStart: "22:30", sessionHigh: 5.5, sessionHighTime: "22:40",
        doji: { time: "22:45", open: 5, high: 5.1, low: 4.9, close: 5, bearish: false, bodyRatio: 0.1, upperWickPct: 40, lowerWickPct: 40 },
        next: { time: "22:50", open: 5, high: 5.2, low: 4.95, close: 5.1, bearish: false },
        gapFromHighMinutes: 5,
        filters: { priceBand: true, aboveEma: true, aboveCloud: true, firstDoji: true, bothWicks: true, nextBearish: false, recentDoji: true, dojiNearHigh: true },
      },
    });
    expect(summarizeMissReasons(r, baseRun)).toEqual(["도지 다음 봉이 음봉 아님(패턴 미완성)"]);
  });

  it("방어 필터 사유(defenseReasons)와 워런트 경고는 그대로 덧붙는다", () => {
    const r = mkResult({ status: "none", defenseReasons: ["EMA 이격도 2.1% < 최소 3%"], warrantWarning: "워런트로 의심됨(저가)" });
    const reasons = summarizeMissReasons(r, baseRun);
    expect(reasons).toContain("EMA 이격도 2.1% < 최소 3%");
    expect(reasons).toContain("워런트로 의심됨(저가)");
  });
});

describe("bucketMissReason — 병목 집계용 정규화", () => {
  it("가격이 섞인 상세 문장도 같은 분류명으로 묶인다", () => {
    expect(bucketMissReason("가격대 벗어남 (현재가 $3.42)")).toBe("가격대 벗어남");
    expect(bucketMissReason("가격대 벗어남 (현재가 $11.00)")).toBe("가격대 벗어남");
  });
  it("EMA 이격도·기울기·ATR·워런트를 각각 분류한다", () => {
    expect(bucketMissReason("EMA 이격도 1.2% < 최소 3%")).toBe("EMA 이격도 미달");
    expect(bucketMissReason("EMA가 상승 중이 아님")).toBe("EMA 상승 중 아님");
    expect(bucketMissReason("ATR 9.1% > 상한 8%")).toBe("변동성 과다/계산 불가");
    expect(bucketMissReason("워런트로 의심됨(저가)")).toBe("워런트 저가 탈락");
  });
  it("이미 고정 문구인 사유는 그대로 돌려준다", () => {
    expect(bucketMissReason("EMA200 아래")).toBe("EMA200 아래");
  });
});

describe("updateWatchHistory — 관찰 생애주기 갱신", () => {
  const T0 = 1_000_000;

  it("새로 관찰(watch)로 잡힌 종목은 'watching' 항목으로 시작한다", () => {
    const next = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch", price: 3.5 })], baseRun, T0);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ symbol: "ABCD", outcome: "watching", watchedAtMs: T0, watchedPrice: 3.5, resolvedAtMs: null, reasons: [], reasonBuckets: [] });
  });

  it("같은 스캔에 두 번 watch로 잡혀도 중복 항목을 만들지 않는다", () => {
    const first = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0);
    const second = updateWatchHistory(first, [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0 + 300_000);
    expect(second.filter((h) => h.symbol === "ABCD")).toHaveLength(1);
    expect(second[0].lastSeenAtMs).toBe(T0 + 300_000); // 최신 시각으로 갱신됨
    expect(second[0].outcome).toBe("watching"); // 여전히 관찰 중
  });

  it("watch → confirmed로 바뀌면 'confirmed'로 종료되고 근거가 남는다", () => {
    const watching = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0);
    const resolved = updateWatchHistory(
      watching,
      [mkResult({
        symbol: "ABCD", status: "confirmed",
        evidence: {
          mode: "ha", sessionStart: "22:30", sessionHigh: 5.5, sessionHighTime: "22:40",
          doji: { time: "22:45", open: 5, high: 5.1, low: 4.9, close: 5, bearish: false, bodyRatio: 0.1, upperWickPct: 40, lowerWickPct: 40 },
          next: { time: "22:50", open: 4.9, high: 4.95, low: 4.7, close: 4.75, bearish: true },
          gapFromHighMinutes: 5,
          filters: { priceBand: true, aboveEma: true, aboveCloud: true, firstDoji: true, bothWicks: true, nextBearish: true, recentDoji: true, dojiNearHigh: true },
        },
      })],
      baseRun,
      T0 + 300_000,
    );
    expect(resolved[0].outcome).toBe("confirmed");
    expect(resolved[0].resolvedAtMs).toBe(T0 + 300_000);
    expect(resolved[0].reasons[0]).toContain("세션고점");
    expect(resolved[0].reasonBuckets).toEqual([]); // confirmed는 병목 집계 대상이 아님
  });

  it("watch → none(스캔엔 남음)이면 'disqualified'로 종료되고 사유·버킷이 남는다", () => {
    const watching = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0);
    const resolved = updateWatchHistory(
      watching,
      [mkResult({ symbol: "ABCD", status: "none", aboveEma: false })],
      baseRun,
      T0 + 300_000,
    );
    expect(resolved[0].outcome).toBe("disqualified");
    expect(resolved[0].reasons).toContain("EMA200 아래");
    expect(resolved[0].reasonBuckets).toContain("EMA200 아래");
  });

  it("watch였던 종목이 이번 스캔 결과에 아예 없으면 'dropped_from_scan'(정직하게 사유 불명)으로 종료한다", () => {
    const watching = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0);
    const resolved = updateWatchHistory(watching, [], baseRun, T0 + 300_000);
    expect(resolved[0].outcome).toBe("dropped_from_scan");
    expect(resolved[0].resolvedAtMs).toBe(T0 + 300_000);
    expect(resolved[0].reasons[0]).toContain("순위 밖으로 벗어난 것으로 추정");
  });

  it("이미 끝난 기록은 다시 계산되지 않는다(그 순간의 사유를 영구 보존)", () => {
    const watching = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0);
    const resolved = updateWatchHistory(watching, [mkResult({ symbol: "ABCD", status: "none", aboveEma: false })], baseRun, T0 + 300_000);
    // 그다음 스캔에 ABCD가 다시 watch로 전혀 안 뜨더라도, 이미 끝난 첫 기록은 그대로다.
    const again = updateWatchHistory(resolved, [], baseRun, T0 + 600_000);
    expect(again.filter((h) => h.symbol === "ABCD")).toHaveLength(1);
    expect(again[0]).toEqual(resolved[0]);
  });

  it("탈락했던 종목이 나중에 다시 관찰되면 별개의 새 기록을 만든다(과거 기록을 안 건드림)", () => {
    const watching = updateWatchHistory([], [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0);
    const resolved = updateWatchHistory(watching, [mkResult({ symbol: "ABCD", status: "none", aboveEma: false })], baseRun, T0 + 300_000);
    const reWatched = updateWatchHistory(resolved, [mkResult({ symbol: "ABCD", status: "watch" })], baseRun, T0 + 900_000);
    const rows = reWatched.filter((h) => h.symbol === "ABCD");
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe("disqualified"); // 옛 기록 그대로
    expect(rows[1]).toMatchObject({ outcome: "watching", watchedAtMs: T0 + 900_000 });
  });

  it("상한을 넘으면 관찰 중인 건 전부 보존하고 끝난 기록 중 오래된 것부터 자른다", () => {
    let history: WatchHistoryEntry[] = [];
    // 상한보다 10개 더 많은 "확정 종료" 기록을 서로 다른 시각으로 쌓는다.
    const over = 10;
    for (let i = 0; i < WATCH_HISTORY_MAX + over; i++) {
      const t = T0 + i * 1000;
      history = updateWatchHistory(history, [mkResult({ symbol: `S${i}`, status: "watch" })], baseRun, t);
      history = updateWatchHistory(history, [mkResult({ symbol: `S${i}`, status: "none", aboveEma: false })], baseRun, t + 500);
    }
    // 마지막으로 하나는 관찰 중인 채로 남겨 둔다.
    history = updateWatchHistory(history, [mkResult({ symbol: "STILL", status: "watch" })], baseRun, T0 + 999_000);
    expect(history.length).toBeLessThanOrEqual(WATCH_HISTORY_MAX);
    expect(history.some((h) => h.symbol === "STILL" && h.outcome === "watching")).toBe(true); // 관찰 중인 건 안 잘림
    expect(history.some((h) => h.symbol === "S0")).toBe(false); // 가장 오래된 종료 기록부터 잘림
  });
});
