// =============================================================================
// tests/guardian.test.ts — [v0.69.0 긴급] 보호 가드: "체결됐는데 익절·손절 주문이 안 걸린 종목"을 봇이 끝까지 책임진다
// -----------------------------------------------------------------------------
// [배경] 카일 실사용 보고: "매도(익절·손절) 주문이 자동으로 안 들어가는 종목이 있어 수동으로 팔았다."
//   그룹 기록 원인: WETO(보호 시장가 매도가 '매도 가능 수량 부족 422'로 1회 실패 후 포기), QTEX(OCO 등록 '감시가 0' 400 후 포기),
//   WHLR·NAUT(진입 6분 뒤 조건주문이 사라졌는데 주식 82·87주가 그대로 — 경고만 남기고 추적 종료).
//   공통 결함 = 실패하면 포지션을 추적에서 지우고 사람에게 떠넘김. 아래 테스트는 "그런 종목은 보호가 걸릴 때까지 계속 시도한다"를 고정한다.
//   ⚠️ 실계좌 안 건드림(forceMock — 엔진 내장 가짜 토스 서버. 가짜 계좌는 AAPL 100주를 보유).
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type AutoPosition, type UnprotectedPos } from "../electron/tool-engine";

type Internals = {
  autoUnprotected: UnprotectedPos[];
  autoTradePositions: AutoPosition[];
  autoReprotectVanished: boolean;
  marketSellRetryDelaysMs: number[];
  registerUnprotected: (p: AutoPosition, reason: string) => void;
  onAutoBracketResolved: (symbol: string, entry: number, res: { status: "oco_failed"; error: string }) => void;
  clearAutoPositionWithoutPnl: (pos: AutoPosition, summary: string, note: string) => Promise<void>;
  protectByMarketSell: (symbol: string, quantity: number, cur: number, spec: { tpTrigger: number; slTrigger: number }) => Promise<{ status: string }>;
  guardTimer: ReturnType<typeof setTimeout> | null;
  mock: { state: { conditionalOrderAlwaysRejectBand: boolean } };
};

const pos = (over: Partial<AutoPosition> = {}): AutoPosition => ({
  symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 1, enteredAtMs: Date.now() - 60_000, status: "watching", conditionalOrderId: null, ...over,
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kyle-guard-"));
  const eng = new ToolEngine(dir, { forceMock: true });
  await eng.quote("AAPL"); // 목 서버를 먼저 깨운다
  const x = eng as unknown as Internals;
  const stopTimer = () => { if (x.guardTimer) { clearTimeout(x.guardTimer); x.guardTimer = null; } };
  return { dir, eng, x, stopTimer };
}

describe("[v0.69.0] 보호 가드 — 보호주문 없는 보유 종목을 끝까지 책임진다", () => {
  it("보호 대기 종목에 익절/손절 조건주문을 다시 걸고, 정상 추적(active)으로 되돌린다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.registerUnprotected(pos(), "테스트: 보호주문 등록 실패");
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(1);
      await eng.runGuard();
      expect(x.autoUnprotected).toHaveLength(0); // 보호가 걸려 목록에서 빠짐
      const active = x.autoTradePositions.find((p) => p.symbol === "AAPL");
      expect(active?.status).toBe("active");
      expect(active?.conditionalOrderId).toBeTruthy();
      expect((await eng.conditionals()).length).toBe(1); // 토스(목)에 실제로 조건주문이 생김
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("이미 조건주문이 걸려 있으면 중복으로 또 걸지 않고 '보호 확인'으로 끝낸다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      await eng.placeOco({ symbol: "AAPL", quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30" });
      x.registerUnprotected(pos(), "테스트");
      stopTimer();
      await eng.runGuard();
      expect(x.autoUnprotected).toHaveLength(0);
      expect((await eng.conditionals()).length).toBe(1); // 늘지 않음
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("실계좌에 보유가 없으면(이미 팔림) 아무 주문도 내지 않고 목록에서 뺀다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.registerUnprotected(pos({ symbol: "ZZZZ" }), "테스트");
      stopTimer();
      await eng.runGuard();
      expect(x.autoUnprotected).toHaveLength(0);
      expect((await eng.conditionals()).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("가격이 이미 감시가 밖이면 OCO 대신 시장가로 정리한다(현재가 2.05 > 익절 2.0)", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.registerUnprotected(pos({ tp: 2.0, sl: 1.0 }), "테스트");
      stopTimer();
      await eng.runGuard();
      expect(x.autoUnprotected).toHaveLength(0);
      expect((await eng.conditionals()).length).toBe(0); // 조건주문은 안 걸고
      expect(eng.getJournal().some((j) => j.summary.includes("시장가로 매도했습니다"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("등록이 계속 거부되면 목록에 남아 시도 횟수·사유가 쌓이고, 원인이 풀리면 다음 점검에서 성공한다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.mock.state.conditionalOrderAlwaysRejectBand = true; // 토스가 매번 거부하는 상황
      x.registerUnprotected(pos(), "테스트");
      stopTimer();
      await eng.runGuard();
      expect(x.guardTimer).not.toBeNull(); // 다음 점검이 예약됨(지우기 전에 확인)
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(1); // 포기하지 않고 남음
      expect(x.autoUnprotected[0].attempts).toBe(1);
      expect(x.autoUnprotected[0].lastError).toBeTruthy();
      expect(eng.getAutoTradeStatus().unprotected).toHaveLength(1); // 화면에도 노출
      x.mock.state.conditionalOrderAlwaysRejectBand = false; // 원인이 풀림
      await eng.runGuard();
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(0);
      expect(x.autoTradePositions.some((p) => p.symbol === "AAPL" && p.status === "active")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("체결 후 보호주문 등록 실패(oco_failed)로 끝나면 포지션을 지우고 잊지 않고 보호 대기 목록에 올린다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradePositions.push(pos());
      x.onAutoBracketResolved("AAPL", 2.1, { status: "oco_failed", error: "토스 API 실패: insufficient-sellable-quantity" });
      stopTimer();
      expect(x.autoTradePositions.some((p) => p.symbol === "AAPL")).toBe(false); // 자리는 비우되
      expect(x.autoUnprotected).toHaveLength(1); //                              보호 대기로 이어짐
      expect(x.autoUnprotected[0].reason).toContain("insufficient-sellable-quantity");
      expect(eng.getAutoTradeStatus().unprotected[0].symbol).toBe("AAPL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("조건주문이 사라졌는데 주식이 남아 있으면(WHLR·NAUT형) 자동 재보호 대상으로 올린다 — 설정으로 끌 수 있다", async () => {
    const a = await setup();
    try {
      await a.x.clearAutoPositionWithoutPnl(pos(), "테스트", "조건주문 사라짐");
      a.stopTimer();
      expect(a.x.autoUnprotected.map((u) => u.symbol)).toEqual(["AAPL"]); // 목 계좌에 AAPL 100주 보유 → 아직 보유 중
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
    const b = await setup();
    try {
      b.x.autoReprotectVanished = false;
      await b.x.clearAutoPositionWithoutPnl(pos(), "테스트", "조건주문 사라짐");
      b.stopTimer();
      expect(b.x.autoUnprotected).toHaveLength(0); // 끄면 예전처럼 경고만
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("보호 대기 목록은 파일에 저장되어 앱을 껐다 켜도 이어진다", async () => {
    const { dir, x, stopTimer } = await setup();
    try {
      x.registerUnprotected(pos(), "테스트");
      stopTimer();
      const saved = JSON.parse(readFileSync(join(dir, "kylebot-auto-positions.json"), "utf8")) as { unprotected: UnprotectedPos[] };
      expect(saved.unprotected).toHaveLength(1);
      expect(saved.unprotected[0].symbol).toBe("AAPL");
      const again = new ToolEngine(dir, { forceMock: true });
      expect(again.getAutoTradeStatus().unprotected).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("보호 시장가 매도는 한 번 실패해도 포기하지 않고 재시도한다(WETO: 매도 가능 수량 부족 422)", async () => {
    const { dir, eng, x } = await setup();
    try {
      x.marketSellRetryDelaysMs = [10, 10, 10];
      let calls = 0;
      (eng as unknown as { placeSell: (s: unknown) => Promise<unknown> }).placeSell = async () => {
        calls++;
        if (calls < 3) throw new Error("토스 API 실패 [POST /api/v1/orders]: HTTP 422 insufficient-sellable-quantity 매도 가능 수량이 부족합니다.");
        return { kind: "entry" };
      };
      const r = await x.protectByMarketSell("AAPL", 1, 2.6, { tpTrigger: 2.5, slTrigger: 1.8 });
      expect(r.status).toBe("protected_by_market_sell");
      expect(calls).toBe(3); // 두 번 실패 뒤 세 번째에 성공
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("재시도를 모두 소진해도 실패하면 oco_failed로 돌려줘(→ 가드가 이어받는다) 조용히 사라지지 않는다", async () => {
    const { dir, eng, x } = await setup();
    try {
      x.marketSellRetryDelaysMs = [5, 5];
      (eng as unknown as { placeSell: () => Promise<unknown> }).placeSell = async () => { throw new Error("HTTP 422 insufficient-sellable-quantity"); };
      const r = await x.protectByMarketSell("AAPL", 1, 2.6, { tpTrigger: 2.5, slTrigger: 1.8 });
      expect(r.status).toBe("oco_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
  it("기록된 감시가가 비정상(0)이어도(QTEX 실사례) 진입가 기준 기본 익절/손절로 다시 계산해 보호를 건다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.registerUnprotected(pos({ tp: 0, sl: 0 }), "테스트: 감시가 0");
      stopTimer();
      await eng.runGuard();
      expect(x.autoUnprotected).toHaveLength(0);
      const p = x.autoTradePositions.find((q) => q.symbol === "AAPL");
      expect(p?.tp).toBeGreaterThan(p?.sl ?? 0);
      expect(p?.sl).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
