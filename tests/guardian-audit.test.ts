// =============================================================================
// tests/guardian-audit.test.ts — [v0.69.1 긴급] 보호 구멍 메우기: 독립 감사 + 취소 실패 시 감시 유지
// -----------------------------------------------------------------------------
// [배경] 오너 지시 "매도 주문 안 거는 문제 전수 확인". v0.69.0 가드는 '실패가 눈에 보이는 입구'(OCO 등록 실패·조건주문 소멸)만 막았다.
//   코드를 전수 점검해 찾은 틈:
//     ① 자동 취소 API 자체가 실패("timeout")하면 포지션을 지워 버려, 그 주문이 나중에 체결돼도 아무도 보호를 안 걸었다(AIB 실사례).
//     ② 어떤 경로로든 추적에서 빠진 "봇이 산 보유 종목 + 조건주문 없음"을 결과로 직접 대조하는 장치가 없었다.
//   ⚠️ 실계좌 안 건드림(forceMock — 엔진 내장 가짜 토스 서버. 가짜 계좌는 AAPL 100주를 보유).
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type AutoPosition, type AutoTradeHistoryEntry, type UnprotectedPos } from "../electron/tool-engine";

type Internals = {
  autoUnprotected: UnprotectedPos[];
  autoTradePositions: AutoPosition[];
  autoTradeHistory: AutoTradeHistoryEntry[];
  onAutoBracketResolved: (symbol: string, entry: number, res: { status: "timeout" }) => void;
  guardTimer: ReturnType<typeof setTimeout> | null;
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kyle-audit-"));
  const eng = new ToolEngine(dir, { forceMock: true });
  await eng.quote("AAPL"); // 목 서버를 먼저 깨운다
  const x = eng as unknown as Internals;
  const stopTimer = () => { if (x.guardTimer) { clearTimeout(x.guardTimer); x.guardTimer = null; } };
  return { dir, eng, x, stopTimer };
}

const histEntry = (over: Partial<AutoTradeHistoryEntry> = {}): AutoTradeHistoryEntry => {
  const ms = Date.now() - 3600_000;
  return {
    id: `AAPL@2.1@${ms}`, symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 100, enteredAt: "10-07 22:00:00",
    status: "closed_manual", exitedAt: "10-07 22:06:00", exitPrice: null, pnlUsd: null, pnlPct: null, note: "테스트", ...over,
  };
};

describe("[v0.69.1] 독립 감사 — 봇이 산 보유 종목인데 보호 조건주문이 없으면 가드에 올린다", () => {
  it("추적에서 빠진 봇 종목(보유 100주·조건주문 없음)을 찾아 가드 대기 목록에 올린다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      const added = await eng.auditUnprotectedHoldings();
      stopTimer();
      expect(added).toBe(1);
      expect(x.autoUnprotected.map((u) => u.symbol)).toEqual(["AAPL"]);
      expect(x.autoUnprotected[0].quantity).toBe(100); // 기록의 수량이 아니라 실계좌 보유 수량 기준
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("봇이 산 적 없는 종목(수동 보유)은 절대 건드리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const added = await eng.auditUnprotectedHoldings(); // 기록 없음
      stopTimer();
      expect(added).toBe(0);
      expect(x.autoUnprotected).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("[v0.80.0 긴급] reflectUnknownHoldings의 참고용 기록(reflectedOnly)은 '봇이 산 기록'으로 착각하지 않는다 — 하이닉스·필옵틱스·아이온큐 오매도 사고 재발 방지", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      // reflectUnknownHoldings가 실제로 남기는 모양 그대로: status="active", tp=sl=entry, reflectedOnly=true.
      x.autoTradeHistory.push(histEntry({ status: "active", exitedAt: null, tp: 2.1, sl: 2.1, reflectedOnly: true }));
      const added = await eng.auditUnprotectedHoldings();
      stopTimer();
      expect(added).toBe(0); // reflectedOnly 기록만으로는 절대 보호 대상에 올리지 않는다
      expect(x.autoUnprotected).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("이미 토스에 조건주문이 걸려 있으면 올리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      await eng.placeOco({ symbol: "AAPL", quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30" });
      expect(await eng.auditUnprotectedHoldings()).toBe(0);
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("지금 추적 중인(감시·보호) 종목은 건너뛴다 — 체결 직후 OCO 등록 중인 종목을 가로채지 않게", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      x.autoTradePositions.push({ symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 100, enteredAtMs: Date.now(), status: "watching", conditionalOrderId: null });
      expect(await eng.auditUnprotectedHoldings()).toBe(0);
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("정상 청산(closed_win) 기록뿐이면 올리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry({ status: "closed_win" }));
      expect(await eng.auditUnprotectedHoldings()).toBe(0);
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("[v0.69.1] 자동 취소 API 실패(timeout) — 포지션을 지우지 않고 감시를 이어 간다", () => {
  it("timeout이면 watching 포지션이 그대로 남아 5분 재확인 경로가 이어받는다", async () => {
    const { dir, x } = await setup();
    try {
      const p: AutoPosition = { symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 10, enteredAtMs: Date.now(), status: "watching", conditionalOrderId: null, buyOrderId: "X" };
      x.autoTradePositions.push(p);
      x.onAutoBracketResolved("AAPL", 2.1, { status: "timeout" });
      expect(x.autoTradePositions).toHaveLength(1);
      expect(x.autoTradePositions[0].status).toBe("watching");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("[v0.69.4] 보호 중단(직접 관리) — 오너가 손절을 빼고 익절 매도만 걸어 둔 종목에 봇이 계속 보호주문을 시도하지 않는다", () => {
  it("dismissUnprotected: 목록에서 빠지고, 이후 가드·감사가 같은 종목을 다시 올리지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      expect(await eng.auditUnprotectedHoldings()).toBe(1);
      stopTimer();
      const r = eng.dismissUnprotected("AAPL");
      expect(r.ok).toBe(true);
      expect(x.autoUnprotected).toHaveLength(0);
      expect(await eng.auditUnprotectedHoldings()).toBe(0); // 12시간 동안 다시 올리지 않음
      stopTimer();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("토스에 직접 건 매도 주문이 있으면 가드는 OCO를 계속 시도하지 않고 보호 대기를 해제한다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry());
      expect(await eng.auditUnprotectedHoldings()).toBe(1);
      stopTimer();
      await eng.placeSell({ symbol: "AAPL", quantity: 100, orderType: "LIMIT", price: 9 }); // 익절 지정가 매도만 걸어 둔 상태(체결 안 되는 높은 가격)
      await eng.runGuard();
      expect(x.autoUnprotected).toHaveLength(0); // 해제됨
      expect((await eng.conditionals()).length).toBe(0); // 조건주문을 새로 걸지 않았다
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// =============================================================================
// [v0.75.0 — "애드밸류" 감사에서 발견: v0.73.0 AGRZ 수정(protectByMarketSell)과 같은 부류의
//   버그가 runGuard()의 시장가 정리 분기에도 있었다] 가격이 감시가(tp/sl) 밖으로 나가 OCO를
//   걸 수 없어 즉시 시장가로 정리하는 경우, 예전엔 "매도 직전 조회한 현재가(cur)"를 그대로
//   exitPrice로 기록했다 — AGRZ 실사례처럼 그 사이 가격이 더 움직이면 실제 손익과 다르게
//   기록된다. tests/guardian.test.ts의 AGRZ 테스트와 같은 원리로, "매도 직전 조회값"과
//   "실제 체결 시점 가격"을 일부러 다르게 만들어 검증한다.
// =============================================================================
describe("[v0.75.0 — AGRZ와 같은 부류] runGuard 시장가 정리 분기도 추정가 대신 실제 체결가를 기록한다", () => {
  it("매도 직전 조회가(cur)와 실제 체결가가 다르면, 기록되는 exitPrice는 실제 체결가다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry({ tp: 2.5, sl: 1.8 })); // 감시 밴드: $1.8~$2.5
      await eng.mockSetPrice("AAPL", 2.6); // 감시가(2.5) 밖 — "매도 직전 조회가"(cur)로 읽힘
      expect(await eng.auditUnprotectedHoldings()).toBe(1);
      stopTimer();
      // placeSell 호출 시점(=실제 시장가 체결 시점)에 가격이 한 번 더 움직였다고 흉내 —
      // cur(2.6)과 실제 체결가(2.75)가 달라야 버그(옛 동작)와 수정(새 동작)을 구분할 수 있다.
      const realPlaceSell = eng.placeSell.bind(eng);
      (eng as unknown as { placeSell: (s: unknown) => Promise<unknown> }).placeSell = async (s: unknown) => {
        await eng.mockSetPrice("AAPL", 2.75);
        return realPlaceSell(s as Parameters<typeof eng.placeSell>[0]);
      };
      await eng.runGuard();
      const rec = eng.getAutoTradeHistory().find((h) => h.symbol === "AAPL");
      expect(rec?.status).toBe("closed_win");
      expect(rec?.exitPrice).toBe(2.75); // 추정가(2.6)가 아니라 실제 체결가(2.75)
      expect(rec?.note).toContain("실제 체결가 확인 완료");
      expect(rec?.pnlUsd).toBe(65); // (2.75 - 2.1) × 100주
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("[v0.82.0 긴급] 보호 가드가 실제로 매도/재등록했으면(hist 있음) OS 알림(notify)이 켜진다 — 오너 지적: '계속 매도하는데 알림이 안 온다'", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry({ tp: 2.5, sl: 1.8 }));
      await eng.mockSetPrice("AAPL", 2.6); // 감시가 밖 — 시장가 정리 분기를 탄다
      expect(await eng.auditUnprotectedHoldings()).toBe(1);
      stopTimer();
      await eng.runGuard();
      const j = eng.getJournal().find((e) => e.symbol === "AAPL" && e.summary.includes("보호 확인"));
      expect(j?.notify).toBe(true); // 결과가 실제로 바뀌었으니(시장가 매도) 반드시 알려야 한다
      expect(j?.notifyTitle).toContain("보호 가드 결과");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("[v0.82.0→v0.98.0 수정] 보호 가드가 '이미 조건주문 걸려있음'을 발견하면 — 추적을 복원하는 실제 변화이므로 이제는 알린다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      // [v0.98.0] 이 테스트는 원래(v0.82.0) "이미 조건주문이 걸려 있으면 아무 것도 안 바뀌니
      //   알리지 않는다"를 검증했다. 그런데 바로 그 경로가 "조건주문 취소하면 아예 빠져버리는데
      //   재주문 넣은거는 다시 포함시켜야해" 버그의 정체였다 — autoUnprotected에서만 빠지고
      //   autoTradePositions·매매기록은 영원히 closed_manual에 머물렀다(완전한 무음 방치).
      //   이제는 발견한 조건주문으로 추적을 "active"로 복원하는 실제 변화가 있으므로, 알리는
      //   것이 맞다(알림 피로 방지 원칙은 진짜 무변화 경로 — 바로 아래 "직접 건 매도 주문" 테스트
      //   — 에 그대로 남아 있다).
      x.autoTradeHistory.push(histEntry());
      expect(await eng.auditUnprotectedHoldings()).toBe(1);
      stopTimer();
      await eng.placeOco({ symbol: "AAPL", quantity: 1, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30" });
      await eng.runGuard();
      const j = eng.getJournal().find((e) => e.symbol === "AAPL" && e.summary.includes("보호 확인"));
      expect(j?.notify).toBe(true);
      expect(j?.notifyTitle).toContain("보호 가드 결과");
      const hist = eng.getAutoTradeHistory().find((h) => h.symbol === "AAPL");
      expect(hist?.status).toBe("active"); // closed_manual에 영원히 안 머문다(이번 수정의 핵심)
      expect(x.autoTradePositions.find((p) => p.symbol === "AAPL")?.status).toBe("active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("실제 체결가 조회가 끝내 안 되면(주문번호 없음) 추정가로 폴백하되 그 사실을 정직하게 남긴다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradeHistory.push(histEntry({ tp: 2.5, sl: 1.8 }));
      await eng.mockSetPrice("AAPL", 2.6);
      expect(await eng.auditUnprotectedHoldings()).toBe(1);
      stopTimer();
      // placeSell이 주문번호 없는 응답을 돌려주는 상황(예: 드라이런이 아닌데 detail이 비정상)을
      // 흉내 — 실제 체결가를 조회할 길이 없어 옛 방식(추정가)으로 폴백해야 한다.
      (eng as unknown as { placeSell: (s: unknown) => Promise<unknown> }).placeSell = async () => ({ kind: "entry" });
      await eng.runGuard();
      const rec = eng.getAutoTradeHistory().find((h) => h.symbol === "AAPL");
      expect(rec?.exitPrice).toBe(2.6); // 폴백: 매도 직전 조회가
      expect(rec?.note).toContain("실제 체결가 조회 실패");
      expect(rec?.note).toContain("추정가");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// =============================================================================
// [v0.78.0→v0.81.0] "Capri가 모르는 보유 종목을 참고용으로 자동 반영"하던 reflectUnknownHoldings
//   기능은 완전히 제거됐다 — 그 기록을 auditUnprotectedHoldings가 "Capri 포지션"으로 오인해
//   실제로 매도까지 나간 사고(2026-10-11, 하이닉스·필옵틱스·아이온큐) 때문이다. 재발 방지
//   테스트는 위 "[v0.80.0 긴급]" 테스트(reflectedOnly 플래그 단독 검증)로 충분히 남아 있다.
// =============================================================================

// =============================================================================
// [v0.77.0 — task #111 "토스 실시간 동기화 2단계: Capri가 모르는 매매 자동 반영"] 가드가
//   "보호 대기 중"(autoUnprotected)인 종목의 실계좌 보유가 0으로 사라진 걸 발견하면(오너가 토스
//   앱에서 직접 팔았을 수 있음), 예전엔 추적만 지우고 매매기록은 그대로 뒀다 — "active"에 영원히
//   멈춰(손익도 null로 영구 미확정) 매매분석 통계를 왜곡했다. 이제는 최소한 "끝났다"는 사실은
//   정직하게 기록한다(정확한 체결가는 이 API로 믿을 수 있게 복원할 길이 없어 지어내지 않음).
// =============================================================================
describe("[v0.77.0 — task #111] 보호 가드가 보유 수량 0을 발견하면 매매기록도 함께 종료 처리한다", () => {
  it("오너가 토스 앱에서 직접 팔아 보유가 사라지면, 매매기록이 'active'에 영원히 안 남고 종료 처리된다(손익은 모른다고 정직하게 null)", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const enteredAtMs = Date.now() - 3600_000;
      // GHOST는 목 서버 홀딩 목록에 없는 심볼이라 held.get("GHOST")는 항상 0 — "보유 수량 0"을
      // 자연스럽게 재현한다(discovery 단계인 auditUnprotectedHoldings는 건너뛰고, runGuard가
      // "이미 추적 중인" 종목을 처리하는 동작만 직접 검증).
      x.autoTradeHistory.push(histEntry({ id: `GHOST@5@${enteredAtMs}`, symbol: "GHOST", entry: 5, quantity: 10, status: "active", exitedAt: null }));
      x.autoUnprotected.push({
        symbol: "GHOST", entry: 5, fillPrice: null, tp: 5.5, sl: 4.5, quantity: 10, enteredAtMs,
        reason: "테스트: 체결 후 OCO 등록 전", sinceMs: Date.now(), attempts: 0, lastAttemptMs: null, lastError: null,
      });
      await eng.runGuard();
      stopTimer();
      expect(x.autoUnprotected).toHaveLength(0); // 추적은 지워짐(옛 동작과 동일)
      const rec = eng.getAutoTradeHistory().find((h) => h.symbol === "GHOST");
      expect(rec?.status).toBe("closed_manual"); // "active"에 영원히 안 남음(이번 수정의 핵심)
      expect(rec?.exitPrice).toBeNull(); // 모르는 걸 숫자로 지어내지 않음
      expect(rec?.pnlUsd).toBeNull();
      expect(rec?.note).toContain("직접 매도된 것으로 보임");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// =============================================================================
// [v0.98.0 — 오너 지시 "자동매매 종목에 추가매수... 토스에서 직접 진행할 경우 카프리에 실시간
//   반영이 안되고있음"] 보호주문(OCO)이 이미 걸려 추적 중인(active) 포지션은 조건주문 상태만
//   재확인됐지, 보유 "수량"은 전혀 재확인되지 않았다 — 토스에서 직접 추가매수하면 Capri 기록만
//   그대로 멈춰 실계좌와 어긋난다. auditActivePositionQuantities가 결과(실계좌 수량)를 직접
//   대조해 반영한다. ⚠️ 실계좌 안 건드림(forceMock — 가짜 계좌는 AAPL 100주를 보유).
// =============================================================================
describe("[v0.98.0] 독립 감사 — 보호 중인(active) 포지션의 실계좌 보유 수량 변화를 반영한다", () => {
  const activePos = (over: Partial<AutoPosition> = {}): AutoPosition => ({
    symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 60, enteredAtMs: Date.now() - 3600_000,
    status: "active", conditionalOrderId: "cond-existing-1", ...over,
  });

  it("추가매수로 실계좌 수량이 늘면(기록 60주 vs 실계좌 100주) 기록을 실계좌 기준으로 갈아 끼우고 '무보호 수량 있음'을 강하게 알린다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = activePos({ quantity: 60 });
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histEntry({ id: `${p.symbol}@${p.entry}@${p.enteredAtMs}`, quantity: 60, status: "active", exitedAt: null }));
      const changed = await eng.auditActivePositionQuantities();
      stopTimer();
      expect(changed).toBe(1);
      expect(x.autoTradePositions.find((q) => q.symbol === "AAPL")?.quantity).toBe(100); // 목 계좌 보유(100주) 기준으로 갈아 끼움
      const hist = eng.getAutoTradeHistory().find((h) => h.symbol === "AAPL");
      expect(hist?.quantity).toBe(100);
      expect(hist?.note).toContain("60주→100주");
      expect(hist?.note).toContain("추가매수");
      const j = eng.getJournal().find((e) => e.symbol === "AAPL" && e.summary.includes("추가매수"));
      expect(j?.notify).toBe(true); // 늘어난 수량은 무보호라 반드시 강하게 알려야 한다
      expect(j?.notifyTitle).toContain("추가매수 감지");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("오너가 직접 일부 매도해 수량이 줄면(기록 150주 vs 실계좌 100주) 기록만 조용히 실계좌 기준으로 맞춘다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = activePos({ quantity: 150 });
      x.autoTradePositions.push(p);
      x.autoTradeHistory.push(histEntry({ id: `${p.symbol}@${p.entry}@${p.enteredAtMs}`, quantity: 150, status: "active", exitedAt: null }));
      const changed = await eng.auditActivePositionQuantities();
      stopTimer();
      expect(changed).toBe(1);
      expect(x.autoTradePositions.find((q) => q.symbol === "AAPL")?.quantity).toBe(100);
      const hist = eng.getAutoTradeHistory().find((h) => h.symbol === "AAPL");
      expect(hist?.note).toContain("150주→100주");
      expect(hist?.note).toContain("일부 매도");
      const j = eng.getJournal().find((e) => e.symbol === "AAPL" && e.summary.includes("줄었습니다"));
      expect(j?.notifyTitle).toContain("보유 수량 변경 감지"); // 무보호 경고(⚠️ 추가매수 감지)와는 다른, 덜 급한 제목
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("기록과 실계좌 수량이 이미 같으면 아무것도 바꾸지 않는다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = activePos({ quantity: 100 });
      x.autoTradePositions.push(p);
      const changed = await eng.auditActivePositionQuantities();
      stopTimer();
      expect(changed).toBe(0);
      expect(x.autoTradePositions.find((q) => q.symbol === "AAPL")?.quantity).toBe(100);
      expect(eng.getJournal().some((e) => e.symbol === "AAPL")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("실계좌에 전혀 없는 종목(보유 0)은 건드리지 않는다 — 조건주문 발동/소멸 조회(reconcileAutoPositions)의 영역", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      const p = activePos({ symbol: "GHOST", quantity: 10 });
      x.autoTradePositions.push(p);
      const changed = await eng.auditActivePositionQuantities();
      stopTimer();
      expect(changed).toBe(0);
      expect(x.autoTradePositions.find((q) => q.symbol === "GHOST")?.quantity).toBe(10); // 그대로
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("watching(아직 체결 대기) 포지션이나 조건주문 번호가 없는 포지션은 대상이 아니다", async () => {
    const { dir, eng, x, stopTimer } = await setup();
    try {
      x.autoTradePositions.push(activePos({ status: "watching", conditionalOrderId: null, quantity: 1 }));
      const changed = await eng.auditActivePositionQuantities();
      stopTimer();
      expect(changed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
