// =============================================================================
// tests/paper-bots.test.ts — [v0.103.0] 가상매매 봇 규칙 고정
//   가상 체결이 "보수적" 규칙대로 되는지, 기기 간 합치기가 데이터를 잃지 않는지, 대시보드 집계가 맞는지.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  advanceBot, placeEntries, mergeStores, freshSim, sanitizeConfig, defaultBotConfig, botStats, paperDashboard,
  emptyStore, storeFingerprint, cancelPending, screenKey, isPaperStore, paperStopPrice, exitLabel, classifyScanRow, summarizeScan, applyScanSummary,
  type PaperBot, type PaperBar, type PaperStore,
} from "../lib/paper-bots";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 14, 0, 0); // 임의의 기준 시각(정각)

function mkBot(over: Partial<PaperBot["config"]> = {}, id = "b1"): PaperBot {
  const config = sanitizeConfig({ ...defaultBotConfig(null, T0, "테스트"), seedUsd: 10_000, tpPct: 2, slPct: 5, ...over });
  return { id, config, sim: freshSim(1, T0, config.seedUsd) };
}
const bar = (t: number, o: number, h: number, l: number, c: number): PaperBar => ({ time: t, open: o, high: h, low: l, close: c });

/** 대기 주문 하나를 직접 넣은 봇(진입 10, 익절 10.2, 손절 9.5, 100주, 주문 T0+30초). */
function withPending(b: PaperBot): PaperBot {
  return {
    ...b,
    sim: {
      ...b.sim,
      pending: [{ id: "X@1", symbol: "XYZ", entry: 10, tp: 10.2, sl: 9.5, qty: 100, placedAtMs: T0 + 30_000, expiresAtMs: T0 + 30_000 + 10 * MIN, lastBarMs: 0 }],
      agg: { ...b.sim.agg, orders: 1 },
    },
  };
}

describe("가상 체결(advanceBot)", () => {
  it("주문을 낸 그 분의 봉은 쓰지 않는다(주문 전 가격으로 체결된 착시 방지)", () => {
    const b = withPending(mkBot());
    const bars = new Map([["XYZ", [bar(T0, 10.1, 10.1, 9.0, 9.2)]]]); // T0 봉(주문은 T0+30초) — 저가가 한참 아래지만 무시
    const sim = advanceBot(b, bars, T0 + 2 * MIN, 0);
    expect(sim.pending.length).toBe(1);
    expect(sim.open.length).toBe(0);
  });

  it("가격에 딱 닿기만 하면 미체결, 뚫고 내려가야 체결", () => {
    const b = withPending(mkBot());
    const touch = new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 10.0, 10.05)]]]);
    expect(advanceBot(b, touch, T0 + 3 * MIN, 0).open.length).toBe(0);
    const through = new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 9.99, 10.05)]]]);
    const s2 = advanceBot(b, through, T0 + 3 * MIN, 0);
    expect(s2.open.length).toBe(1);
    expect(s2.open[0].fillPrice).toBe(10);
  });

  it("갭 하락으로 시작하면 시가(더 싼 값)에 체결", () => {
    const b = withPending(mkBot());
    const s = advanceBot(b, new Map([["XYZ", [bar(T0 + MIN, 9.8, 9.9, 9.7, 9.85)]]]), T0 + 3 * MIN, 0);
    expect(s.open[0].fillPrice).toBe(9.8);
  });

  it("같은 봉에서 익절·손절이 다 가능하면 손절 먼저", () => {
    const b = withPending(mkBot());
    const bars = new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 9.99, 10.05), bar(T0 + 2 * MIN, 10.0, 10.5, 9.4, 10.0)]]]);
    const s = advanceBot(b, bars, T0 + 5 * MIN, 0);
    expect(s.open.length).toBe(0);
    expect(s.trades.length).toBe(1);
    expect(s.trades[0].result).toBe("sl");
    expect(s.trades[0].exitPrice).toBe(9.5);
    expect(s.realizedUsd).toBeCloseTo(-50, 6); // (9.5-10)*100
    expect(s.agg.losses).toBe(1);
  });

  it("익절은 뚫고 올라가야 체결되고 수수료가 빠진다", () => {
    const b = withPending(mkBot());
    const bars = new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 9.99, 10.05), bar(T0 + 2 * MIN, 10.1, 10.2, 10.0, 10.1), bar(T0 + 3 * MIN, 10.1, 10.25, 10.0, 10.2)]]]);
    const s = advanceBot(b, bars, T0 + 6 * MIN, 0.2);
    expect(s.trades.length).toBe(1);
    expect(s.trades[0].result).toBe("tp");
    expect(s.trades[0].exitedAtMs).toBe(T0 + 4 * MIN); // 10.2에 딱 닿은 2번째 봉이 아니라 3번째 봉
    // 총이익 20 − 수수료 (10+10.2)*100*0.2/200 = 2.02 → 17.98
    expect(s.trades[0].pnlUsd).toBeCloseTo(17.98, 6);
    expect(s.agg.wins).toBe(1);
  });

  it("체결된 그 봉에서 손절선까지 찍으면 즉시 손절", () => {
    const b = withPending(mkBot());
    const s = advanceBot(b, new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 9.4, 9.6)]]]), T0 + 3 * MIN, 0);
    expect(s.open.length).toBe(0);
    expect(s.pending.length).toBe(0);
    expect(s.trades[0].result).toBe("sl");
  });

  it("유효시간 안에 안 닿으면 취소(미체결로 셈, 매매 아님)", () => {
    const b = withPending(mkBot());
    const s = advanceBot(b, new Map([["XYZ", [bar(T0 + MIN, 10.5, 10.6, 10.4, 10.5)]]]), T0 + 30 * MIN, 0);
    expect(s.pending.length).toBe(0);
    expect(s.agg.unfilled).toBe(1);
    expect(s.agg.n).toBe(0);
    expect(botStats({ ...b, sim: s }).fillRate).toBe(0);
  });

  it("아직 안 끝난 봉은 쓰지 않고, 같은 봉을 두 번 세지 않는다", () => {
    const b = withPending(mkBot());
    const bars = new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 9.99, 10.05), bar(T0 + 2 * MIN, 10.0, 10.0, 9.0, 9.1)]]]);
    const s1 = advanceBot(b, bars, T0 + 2 * MIN + 30_000, 0); // 두 번째 봉은 진행 중
    expect(s1.open.length).toBe(1);
    const s2 = advanceBot({ ...b, sim: s1 }, bars, T0 + 4 * MIN, 0);
    expect(s2.trades.length).toBe(1);
    const s3 = advanceBot({ ...b, sim: s2 }, bars, T0 + 5 * MIN, 0);
    expect(s3.trades.length).toBe(1); // 다시 돌려도 그대로
    expect(s3.realizedUsd).toBe(s2.realizedUsd);
  });

  it("입력 봇을 바꾸지 않는다(순수 함수)", () => {
    const b = withPending(mkBot());
    const before = JSON.stringify(b);
    advanceBot(b, new Map([["XYZ", [bar(T0 + MIN, 10.1, 10.1, 9.0, 9.1)]]]), T0 + 3 * MIN, 0);
    expect(JSON.stringify(b)).toBe(before);
  });

  it("중지 시 대기 주문만 거두고 보유는 남긴다", () => {
    const b = withPending(mkBot());
    const s = cancelPending({ ...b.sim, open: [{ ...b.sim.pending[0], id: "o", fillPrice: 10, filledAtMs: T0, lastPrice: 10 }] });
    expect(s.pending.length).toBe(0);
    expect(s.open.length).toBe(1);
  });
});

describe("신규 가상 주문(placeEntries)", () => {
  const cand = (symbol: string, prevClose = 10, ema200 = 9) => ({ symbol, status: "confirmed", price: prevClose, prevClose, ema200 });

  it("삼분할 1분할 타점·봇의 익절/손절 %·투입 비율로 수량을 정한다", () => {
    const b = mkBot({ trade: { ...mkBot().config.trade, entryLevel: 1, investPct: 30, maxPositions: 3, slMode: "fixed" } });
    const r = placeEntries(b, b.sim, [cand("AAA")], T0);
    expect(r.placed).toBe(1);
    const o = r.sim.pending[0];
    expect(o.entry).toBeGreaterThan(9);
    expect(o.entry).toBeLessThan(10);
    expect(o.tp).toBeCloseTo(o.entry * 1.02, 2);
    expect(Math.abs(o.sl - o.entry * 0.95)).toBeLessThan(0.011); // 호가 단위(틱) 반올림 차이만 허용
    expect(o.qty).toBe(Math.floor(3000 / o.entry));
    expect(o.expiresAtMs).toBe(T0 + b.config.trade.watchMinutes * MIN);
  });

  it("최대 종목 수·이미 보유·관찰(확정 아님)·EMA 아래는 건너뛴다", () => {
    const b = mkBot({ trade: { ...mkBot().config.trade, maxPositions: 2 } });
    const r = placeEntries(b, b.sim, [cand("AAA"), cand("AAA"), { ...cand("WWW"), status: "watch" }, cand("LOW", 8, 9), cand("BBB"), cand("CCC")], T0);
    expect(r.sim.pending.map((o) => o.symbol)).toEqual(["AAA", "BBB"]);
    expect(r.notes.some((n) => n.includes("LOW"))).toBe(true);
    expect(r.notes.some((n) => n.includes("CCC") && n.includes("최대 종목 수"))).toBe(true);
  });

  it("오늘 손절된 종목은 재진입하지 않는다(설정 켜짐일 때)", () => {
    const b = mkBot();
    const sim = { ...b.sim, trades: [{ id: "t", symbol: "AAA", fillPrice: 10, exitPrice: 9.5, qty: 1, tp: 10.2, sl: 9.5, result: "sl" as const, pnlUsd: -0.5, pnlPct: -5, filledAtMs: T0 - MIN, exitedAtMs: T0 - MIN }] };
    expect(placeEntries(b, sim, [cand("AAA")], T0).placed).toBe(0);
    const off = mkBot({ trade: { ...b.config.trade, reentryBlock: false } });
    expect(placeEntries(off, sim, [cand("AAA")], T0).placed).toBe(1);
  });

  it("가상 현금을 넘겨 사지 않는다", () => {
    const b = mkBot({ seedUsd: 1000, trade: { ...mkBot().config.trade, investPct: 100, maxPositions: 5 } });
    const r = placeEntries(b, b.sim, [cand("AAA"), cand("BBB")], T0);
    expect(r.placed).toBe(1);
    expect(r.notes.some((n) => n.includes("현금 부족"))).toBe(true);
  });
});

describe("기기 간 합치기(mergeStores)", () => {
  const store = (bots: PaperBot[], deleted: Record<string, number> = {}): PaperStore => ({ v: 1, bots, deleted });

  it("설정은 나중에 고친 쪽, 진행 기록은 (판 번호, 시각)이 큰 쪽이 따로 이긴다", () => {
    const base = mkBot();
    // 폰: 익절 3%로 고침(설정 최신) / PC: 결과를 쌓음(진행 최신)
    const phone = { ...base, config: { ...base.config, tpPct: 3, updatedAtMs: T0 + 100 } };
    const pc = { ...base, sim: { ...base.sim, realizedUsd: 42, updatedAtMs: T0 + 50 } };
    const m = mergeStores(store([phone]), store([pc]), T0 + 1000);
    expect(m.bots[0].config.tpPct).toBe(3);
    expect(m.bots[0].sim.realizedUsd).toBe(42);
    // 순서를 바꿔도 같은 결과(어느 기기에서 합쳐도 같다)
    expect(storeFingerprint(mergeStores(store([pc]), store([phone]), T0 + 1000), T0 + 1000)).toBe(storeFingerprint(m, T0 + 1000));
  });

  it("초기화(판 번호+1)는 더 늦게 쌓인 옛 판 기록보다 이긴다", () => {
    const base = mkBot();
    const reset = { ...base, sim: freshSim(2, T0 + 10, base.config.seedUsd) };
    const oldButLater = { ...base, sim: { ...base.sim, realizedUsd: 99, updatedAtMs: T0 + 999 } };
    expect(mergeStores(store([oldButLater]), store([reset]), T0 + 2000).bots[0].sim.epoch).toBe(2);
  });

  it("지운 봇은 다른 기기가 다시 올려도 되살아나지 않는다", () => {
    const b = mkBot();
    const m = mergeStores(store([], { [b.id]: T0 + 5 }), store([b]), T0 + 10);
    expect(m.bots.length).toBe(0);
    expect(m.deleted[b.id]).toBe(T0 + 5);
  });

  it("양쪽에만 있는 봇은 모두 남고 만든 순서로 정렬", () => {
    const a = mkBot({ createdAtMs: T0 + 2 }, "a");
    const c = mkBot({ createdAtMs: T0 + 1 }, "c");
    expect(mergeStores(store([a]), store([c]), T0).bots.map((x) => x.id)).toEqual(["c", "a"]);
  });

  it("형식 검사", () => {
    expect(isPaperStore(emptyStore())).toBe(true);
    expect(isPaperStore({ v: 2, bots: [], deleted: {} })).toBe(false);
    expect(isPaperStore(null)).toBe(false);
  });
});

describe("설정 보정·스캔 공유 열쇠", () => {
  it("범위를 벗어난 값은 안전 범위로", () => {
    const c = sanitizeConfig({ seedUsd: -5, tpPct: 0, slPct: 500, screen: { priceMin: 9, priceMax: 1, count: 9999 } });
    expect(c.seedUsd).toBe(100);
    expect(c.tpPct).toBe(0.1);
    expect(c.slPct).toBe(100);
    expect(c.screen.priceMin).toBe(1);
    expect(c.screen.priceMax).toBe(9);
    expect(c.screen.count).toBe(200);
  });

  it("스크리닝 기준이 같으면 같은 열쇠(스캔 한 번을 나눠 씀)", () => {
    const a = mkBot({ slPct: 3 });
    const b = mkBot({ slPct: 7 });
    expect(screenKey(a.config.screen)).toBe(screenKey(b.config.screen));
    const c = mkBot({ screen: { ...a.config.screen, count: 30 } });
    expect(screenKey(c.config.screen)).not.toBe(screenKey(a.config.screen));
  });
});

describe("대시보드", () => {
  function botWith(id: string, sl: number, pnls: number[]): PaperBot {
    const b = mkBot({ slPct: sl, name: `봇${id}` }, id);
    const trades = pnls.map((p, i) => ({ id: `${id}${i}`, symbol: "Z", fillPrice: 10, exitPrice: 10, qty: 1, tp: 1, sl: 1, result: (p > 0 ? "tp" : "sl") as "tp" | "sl", pnlUsd: p, pnlPct: p / 100, filledAtMs: T0, exitedAtMs: T0 }));
    const realized = pnls.reduce((s, x) => s + x, 0);
    const wins = pnls.filter((x) => x > 0);
    return {
      ...b,
      sim: {
        ...b.sim,
        trades,
        realizedUsd: realized,
        agg: { ...b.sim.agg, n: pnls.length, wins: wins.length, losses: pnls.length - wins.length, grossWinUsd: wins.reduce((s, x) => s + x, 0), grossLossUsd: -pnls.filter((x) => x <= 0).reduce((s, x) => s + x, 0), sumPnlPct: pnls.reduce((s, x) => s + x / 100, 0) },
      },
    };
  }

  it("수익률 순위와 손절값별 최고를 고른다(표본 부족은 최고에서 제외)", () => {
    const many = (v: number, n: number) => Array.from({ length: n }, () => v);
    const bots = [botWith("a", 3, many(10, 20)), botWith("b", 5, many(30, 20)), botWith("c", 7, many(500, 3))];
    const d = paperDashboard(bots);
    expect(d.ranking[0].name).toBe("봇c"); // 수익률은 1위지만
    expect(d.best.bot).toBe("봇b"); //        표본(20건) 기준 최고는 b
    expect(d.best.sl).toBe(5);
    expect(d.bySl.map((r) => r.value)).toEqual([3, 5, 7]);
    expect(d.bySl.find((r) => r.value === 7)!.enough).toBe(false);
    const s = botStats(bots[1]);
    expect(s.returnPct).toBe(6); // 600 / 10000
    expect(s.winRate).toBe(100);
  });
});

// [v0.104.0] 200EMA 이탈 청산 옵션 — 손절 %만 / 손절 % + 200EMA 이탈 / 200EMA 이탈만
describe("청산 방식(200EMA 이탈)", () => {
  const cand = (symbol: string, prevClose = 10, ema200 = 9) => ({ symbol, status: "confirmed", price: prevClose, prevClose, ema200 });
  const mode = (slMode: "fixed" | "ema" | "emaOnly", slPct = 5, buf = 1.5) => mkBot({ slPct, trade: { ...mkBot().config.trade, entryLevel: 1, slMode, emaStopBufferPct: buf } });

  it("손절가 계산: 둘 다 = 더 높은 쪽, EMA만 = EMA×(1−여유), 진입가 위면 null", () => {
    expect(paperStopPrice("fixed", 10, 9, 1.5, 9.5)).toBe(9.5);
    expect(paperStopPrice("ema", 10, 9, 1.5, 9.5)).toBe(9.5); //            EMA 손절(8.865)보다 고정(9.5)이 높음
    expect(paperStopPrice("ema", 10, 9.8, 1, 9.5)).toBeCloseTo(9.702, 6); // EMA 손절(9.702)이 더 높음
    expect(paperStopPrice("emaOnly", 10, 9, 1.5, 9.5)).toBeCloseTo(8.865, 6); // 고정 손절 무시
    expect(paperStopPrice("emaOnly", 10, 10.2, 1, 9.5)).toBeNull(); //      EMA 손절가가 진입가 위
    expect(paperStopPrice("ema", 10, 10.2, 1, 9.5)).toBeNull();
  });

  it("200EMA 이탈만이면 손절 %와 상관없이 EMA 아래 여유%에 손절가를 건다", () => {
    const a = placeEntries(mode("emaOnly", 3), mode("emaOnly", 3).sim, [cand("AAA")], T0).sim.pending[0];
    const b = placeEntries(mode("emaOnly", 20), mode("emaOnly", 20).sim, [cand("AAA")], T0).sim.pending[0];
    expect(a.sl).toBeCloseTo(9 * 0.985, 1);
    expect(b.sl).toBe(a.sl); // 손절 %(3 vs 20)가 달라도 같다
    expect(a.sl).toBeLessThan(a.entry);
  });

  it("손절 % + 200EMA 이탈은 둘 중 먼저 닿는(높은) 손절가", () => {
    const tight = placeEntries(mode("ema", 1), mode("ema", 1).sim, [cand("AAA")], T0).sim.pending[0];
    expect(Math.abs(tight.sl - tight.entry * 0.99)).toBeLessThan(0.011); // 고정 1%가 EMA보다 높음
    const wide = placeEntries(mode("ema", 30), mode("ema", 30).sim, [cand("AAA")], T0).sim.pending[0];
    expect(wide.sl).toBeCloseTo(9 * 0.985, 1); //                          EMA 이탈이 더 높음
  });

  it("옛 값·모르는 값은 보정: ema·emaOnly는 유지, 그 외는 고정 %", () => {
    const t = mkBot().config.trade;
    expect(sanitizeConfig({ ...mkBot().config, trade: { ...t, slMode: "emaOnly" } }).trade.slMode).toBe("emaOnly");
    expect(sanitizeConfig({ ...mkBot().config, trade: { ...t, slMode: "ema" } }).trade.slMode).toBe("ema");
    expect(sanitizeConfig({ ...mkBot().config, trade: { ...t, slMode: "weird" as never } }).trade.slMode).toBe("fixed");
    expect(exitLabel({ slMode: "emaOnly", emaStopBufferPct: 1.5 }, 5)).toBe("200EMA 이탈만(여유 1.5%)");
    expect(exitLabel({ slMode: "ema", emaStopBufferPct: 1.5 }, 5)).toBe("손절 5% + 200EMA 이탈(여유 1.5%)");
    expect(exitLabel({ slMode: "fixed", emaStopBufferPct: 1.5 }, 5)).toBe("손절 5%");
  });

  it("대시보드: 청산 방식별로 따로 묶고, EMA만 봇은 손절값별 비교에서 뺀다", () => {
    const withTrades = (b: PaperBot, pnl: number, n: number): PaperBot => ({
      ...b,
      sim: { ...b.sim, realizedUsd: pnl * n, agg: { ...b.sim.agg, n, wins: pnl > 0 ? n : 0, losses: pnl > 0 ? 0 : n, sumPnlPct: (pnl / 100) * n } },
    });
    const bots = [
      withTrades({ ...mode("fixed", 5), id: "f" }, 10, 20),
      withTrades({ ...mode("ema", 5), id: "e" }, 20, 20),
      withTrades({ ...mode("emaOnly", 5), id: "o" }, 30, 20),
    ];
    const d = paperDashboard(bots);
    expect(d.byExit.map((r) => r.label)).toEqual(["고정 손절 %만", "손절 % + 200EMA 이탈(여유 1.5%)", "200EMA 이탈만(여유 1.5%)"]);
    expect(d.best.exit).toBe("200EMA 이탈만(여유 1.5%)");
    expect(d.bySl).toHaveLength(1); //     손절 5% 묶음엔 고정·둘 다 봇만(EMA만 봇 제외)
    expect(d.bySl[0].bots).toBe(2);
    expect(d.byCombo).toHaveLength(3); //  익절이 같아도 청산 방식이 다르면 다른 조합
    expect(d.best.combo).toBe("익절 2% · 200EMA 이탈만(여유 1.5%)");
    expect(d.ranking[0].exit).toBe("200EMA 이탈만(여유 1.5%)");
  });
});

describe("스크리닝 기준(v0.106.0 오너 정정: 봇 자기 기준이 기본)", () => {
  it("값이 없던 옛 봇은 끔(=봇 자기 기준), 켠 값만 켬", () => {
    const c = mkBot().config;
    const { followAutoScreen: _drop, ...old } = c;
    void _drop;
    expect(sanitizeConfig(old).followAutoScreen).toBe(false);
    expect(sanitizeConfig({ ...c, followAutoScreen: true }).followAutoScreen).toBe(true);
    expect(defaultBotConfig(null, T0, "x").followAutoScreen).toBe(false);
  });
});

describe("옛 버전이 저장한 봇 읽기(v0.105.1)", () => {
  it("followAutoScreen 칸이 없는 저장본도 합치면 '끔'으로 채워지고 봇 기준은 그대로, 보정은 멱등", () => {
    const b = mkBot();
    const { followAutoScreen: _x, ...rawConfig } = b.config;
    void _x;
    const oldStore: PaperStore = { v: 1, bots: [{ ...b, config: rawConfig as PaperBot["config"] }], deleted: {} };
    const m = mergeStores(oldStore, emptyStore(), T0);
    expect(m.bots[0].config.followAutoScreen).toBe(false);
    expect(m.bots[0].config.screen).toEqual(b.config.screen); // 봇이 정한 스크리닝 기준은 덮어쓰지 않음
    expect(mergeStores(m, emptyStore(), T0)).toEqual(m);
    expect(storeFingerprint(oldStore, T0)).toBe(storeFingerprint(m, T0)); // 칸 하나 없다고 "달라짐"으로 보고 쓰기를 반복하지 않음
  });
});

describe("관찰·확정·진입 카운트와 스캔 요약(v0.106.0)", () => {
  const scr = mkBot().config.screen; // 기본: EMA 켬, 구름 켬, 신선도·간격 켬
  const ok = { aboveEma: true, aboveCloud: true, firstDoji: true, recentDoji: true, dojiNearHigh: true };
  const row = (symbol: string, over: Record<string, unknown> = {}, f: Record<string, boolean> = {}) => ({
    symbol, status: "none", priceInBand: true, evidence: { filters: { ...ok, ...f } }, ...over,
  });
  it("앞 단계부터 처음 걸린 곳으로 분류(꺼 둔 조건은 사유로 안 침)", () => {
    expect(classifyScanRow(row("A", { priceInBand: false, evidence: null }), scr)).toBe("price");
    expect(classifyScanRow(row("B", { status: "insufficient" }), scr)).toBe("data");
    expect(classifyScanRow(row("C", {}, { aboveEma: false }), scr)).toBe("ema");
    expect(classifyScanRow(row("C2", {}, { aboveEma: false }), { ...scr, emaTrendEnabled: false })).toBe("other");
    expect(classifyScanRow(row("D", { defenseReasons: ["변동성 7% > 6%"] }), scr)).toBe("defense");
    expect(classifyScanRow(row("E", {}, { firstDoji: false }), scr)).toBe("noDoji");
    expect(classifyScanRow(row("F", {}, { dojiNearHigh: false }), scr)).toBe("farDoji");
    expect(classifyScanRow(row("G", {}, { recentDoji: false }), scr)).toBe("oldDoji");
    expect(classifyScanRow(row("H", { status: "watch" }), scr)).toBe("watch");
    expect(classifyScanRow(row("I", { status: "confirmed" }), scr)).toBe("confirmed");
  });
  it("요약: 단계별 탈락 수 + 자동매매 확정인데 봇은 아닌 종목과 그 이유", () => {
    const run = { scannedAt: "10-21 01:07:35", total: 4, results: [row("A", { priceInBand: false }), row("M", { defenseReasons: ["변동성 7% > 6%"] }), row("W", { status: "watch" }), row("K", { status: "confirmed" })] };
    const s1 = summarizeScan(run, scr, T0, ["M", "K", "ZZ"]);
    expect(s1.drops).toEqual({ price: 1, defense: 1 });
    expect(s1.watch).toEqual(["W"]);
    expect(s1.confirmed).toEqual(["K"]);
    expect(s1.autoMissed).toEqual([
      { symbol: "M", reason: "방어 필터 — 변동성 7% > 6%" },
      { symbol: "ZZ", reason: "이 봇의 스캔 대상(거래량 순위·가격대)에 없음" },
    ]);
  });
  it("누적 카운트: 새로 나온 것만 세고, 같은 스캔을 두 번 받아도 다시 안 셈", () => {
    const sum = (at: string, watch: string[], confirmed: string[]) => ({ scannedAt: at, atMs: T0, total: 10, watch, confirmed, drops: {}, autoMissed: [] });
    let sim = mkBot().sim;
    sim = applyScanSummary(sim, sum("t1", ["A"], []));
    sim = applyScanSummary(sim, sum("t1", ["A"], [])); //   같은 스캔 → 그대로
    sim = applyScanSummary(sim, sum("t2", ["A", "B"], ["A"])); // A는 이미 관찰 중 → B만 새 관찰, A 확정
    sim = applyScanSummary(sim, sum("t3", [], ["A"])); //    A 확정 계속 → 안 셈
    expect(sim.funnel).toEqual({ scans: 3, watch: 2, confirmed: 1 });
    const d = paperDashboard([{ ...mkBot(), sim: { ...sim, agg: { ...sim.agg, orders: 1 } } }]);
    expect(d.funnel).toEqual({ watch: 2, confirmed: 1, entries: 1, scans: 3 });
  });
});
