// =============================================================================
// tests/bracket.test.ts — 매수+익절+손절 동시 주문(브라켓) 기능 테스트 (v0.25.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나?]
//   토스 API는 매수+익절+손절 3다리를 한 번에 받지 않는다(OCO/OTO는 최대 2다리 — lib/toss.ts
//   주석 참고). 그래서 이 기능은 ①진입 매수를 접수하고 ②체결을 감시하다가 ③체결되면 자동으로
//   OCO(익절+손절)를 등록한다. 이 자동 연결 로직이 조용히 깨지면 "익절/손절 없이 포지션만
//   남는" 가장 위험한 사고로 이어지므로 세 갈래를 모두 고정한다.
//     ① 체결 즉시 → 자동 OCO 등록
//     ② 감시 시간 안에 체결 안 됨 → 조용히 멈추고 안내만 남김(OCO 등록 안 함)
//     ③ 감시 중 진입 주문이 취소됨 → 감시를 멈추고 안내만 남김(OCO 등록 안 함)
//   ⚠️ 실계좌 안 건드림(forceMock — 엔진 내장 가짜 토스 서버만 사용).
//   [테스트 전용 pollMs] 실제 기본 폴링 주기는 5000ms라 그대로면 테스트가 느려진다.
//   placeBracket spec에 pollMs(기본 5000)를 노출해 두었으므로 테스트에서만 짧게(20ms) 준다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type JournalEntry, type AutoPosition, type WatchAndBracketResult } from "../electron/tool-engine";

/** 폴링 루프가 만드는 저널 항목은 시점을 예측할 수 없어 이벤트로 기다린다. */
function waitForJournal(eng: ToolEngine, match: (e: JournalEntry) => boolean, timeoutMs = 3000): Promise<JournalEntry> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eng.off("journal", onEntry);
      reject(new Error(`시간 안에 기대한 저널이 나오지 않음(${timeoutMs}ms)`));
    }, timeoutMs);
    function onEntry(e: JournalEntry) {
      if (match(e)) {
        clearTimeout(timer);
        eng.off("journal", onEntry);
        resolve(e);
      }
    }
    eng.on("journal", onEntry);
  });
}

describe("매수+익절+손절 동시 주문(브라켓) — v0.25.0", () => {
  it("진입이 즉시 체결되면 자동으로 OCO(익절+손절)를 등록한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 연습용 AAPL 초기가 2.05 → 진입가를 2.10(현재가보다 위)으로 걸면
      // 지정가 매수가 "생성 즉시"(목 서버 규칙) 체결된다.
      const ocoPromise = waitForJournal(eng, (e) => e.kind === "oco");
      await eng.placeBracket({
        symbol: "AAPL",
        price: 2.1,
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 1,
        pollMs: 20, // 테스트 전용 — 실제 기본값은 5000ms
      });
      const ocoEntry = await ocoPromise;
      expect(ocoEntry.summary).toContain("OCO 등록 완료");
      expect(ocoEntry.summary).toContain("AAPL");

      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "entry")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("감시 시간 안에 체결되지 않으면 OCO 없이 조용히 감시만 멈춘다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 진입가를 현재가(2.05)보다 훨씬 아래로 걸면 지정가 매수가 절대 체결되지 않는다(연습 시세 고정).
      const timeoutPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("자동 감시를 멈췄습니다"));
      await eng.placeBracket({
        symbol: "AAPL",
        price: 1.0,
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 0.002, // 테스트 전용 초단시간 감시(약 120ms)
        pollMs: 20,
      });
      const info = await timeoutPromise;
      expect(info.summary).toContain("체결을 기다렸지만");

      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "oco")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("pollMs를 안 주면(실사용 기본값) 진입 직후엔 5초가 아니라 1초 간격으로 빠르게 확인한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 절대 체결 안 되는 가격 + 아주 짧은 감시시간(1.8초) → 감시 종료까지 걸리는 시간으로
      // "몇 초 간격으로 폴링했는지"를 역산한다. 느슨한 5초 간격이었다면 이 테스트 자체가
      // 감시시간(1.8초)보다 훨씬 오래 걸려야 하는데, 실제로는 빠르게(약 1초) 끝나야 한다.
      const startedAt = Date.now();
      const timeoutPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("자동 감시를 멈췄습니다"), 4000);
      await eng.placeBracket({
        symbol: "AAPL",
        price: 1.0,
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 0.03, // 약 1.8초
        // pollMs 생략 — 적응형(진입 직후 1초 간격) 기본값 검증
      });
      await timeoutPromise;
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(3000); // 5초 간격이었다면 이 시간 안에 못 끝남
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.30.0] rationale.source — 안 보내면 manual로 저장되고, 명시적으로 auto를 보내면 그대로 저장된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // getRationales()는 최신이 앞에 오게 뒤집어 준다 — 매번 "가장 최근 entry"를 보면 되므로
      // 같은 심볼(AAPL, 즉시체결 보장된 가격)을 두 번 써도 순서로 구분할 수 있다.
      const oco1 = waitForJournal(eng, (e) => e.kind === "oco");
      await eng.placeBracket({
        symbol: "AAPL", price: 2.1, quantity: 1, tpTrigger: 2.5, tpPrice: 2.5,
        slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30", watchMinutes: 1, pollMs: 20,
        // rationale 자체를 안 보냄 — 수동 버튼 대부분이 이렇게 부른다.
      });
      await oco1;
      const manualEntry = eng.getRationales().find((r) => r.kind === "entry");
      expect(manualEntry?.source).toBe("manual"); // [오너 요청] 자동매매가 아니면 식별 안 되게(수동 = manual)

      const oco2 = waitForJournal(eng, (e) => e.kind === "oco");
      await eng.placeBracket({
        symbol: "AAPL", price: 2.1, quantity: 1, tpTrigger: 2.5, tpPrice: 2.5,
        slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30", watchMinutes: 1, pollMs: 20,
        rationale: { technique: "split3", source: "auto", level: 1 }, // 자동매매가 부르는 방식
      });
      await oco2;
      const autoEntry = eng.getRationales().find((r) => r.kind === "entry");
      expect(autoEntry?.source).toBe("auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.29.0] cancelOnTimeout이 켜져 있으면(자동매매 경로) 시간초과 시 미체결 주문을 자동 취소한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 절대 체결 안 되는 가격 + cancelOnTimeout:true → 타임아웃 때 "자동 취소했습니다" 안내가 떠야 한다
      // (기존 "직접 [주문현황]에서 확인해 주세요" 안내가 아니라 — 오너 요청 "장시간 미체결 대책").
      const cancelledPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("자동 취소했습니다"));
      const entry = await eng.placeBracket({
        symbol: "AAPL",
        price: 1.0,
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 0.002, // 테스트 전용 초단시간 감시(약 120ms)
        pollMs: 20,
        cancelOnTimeout: true,
      });
      const info = await cancelledPromise;
      expect(info.summary).toContain("다음 자동매매 사이클");

      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "oco")).toBe(false);

      // 실제로 주문이 취소돼 더 이상 미체결(OPEN) 목록에 남아있지 않아야 한다(자리가 정말 비워짐).
      const tossOrderId = (entry.detail as { tossOrderId: string }).tossOrderId;
      const open = await eng.openOrders();
      expect(open.some((o) => o.tossOrderId === tossOrderId)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.52.0 긴급 수정] 취소 API가 예외 없이 끝나도 실제 응답이 CANCELED가 아니면 '취소됨'으로 단정하지 않는다(ALDX 실사례 회귀)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 목 서버를 먼저 깨워야 내부 mock 인스턴스가 생긴다(placeBracket 전에 스위치를 걸어 둬야 함).
      await eng.quote("AAPL");
      // 다음 취소 요청에 한해서만, 응답 상태를 "아직 안 끝남"(PENDING)으로 강제한다 —
      // 막판 체결과 취소가 경합해 실제로는 안 끝났는데 우리가 예외만 안 던졌다고 믿고
      // "취소 성공"으로 단정하던 옛 버그를 재현한다.
      (eng as unknown as { mock: { state: { cancelReturnsStatus: string | null } } }).mock.state.cancelReturnsStatus = "PENDING";

      const pendingPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("감시를 계속 유지"));
      const entry = await eng.placeBracket({
        symbol: "AAPL",
        price: 1.0,
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 0.002,
        pollMs: 20,
        cancelOnTimeout: true,
      });
      const info = await pendingPromise;
      // mock의 "PENDING"은 lib/toss.ts의 mapOrderStatus()를 거쳐 내부 표준값 "submitted"로 옮겨진다.
      expect(info.summary).toContain("submitted"); // 실제로 돌아온 상태를 그대로 보여줌
      expect(info.summary).not.toContain("다음 자동매매 사이클"); // 정상 취소 완료 문구가 아니어야 함

      // 절대 청산으로 단정하지 않았으므로, OCO(익절/손절) 등록도 시도하지 않는다.
      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "oco")).toBe(false);

      // [핵심] 우리가 "취소됐다"고 믿은 것과 달리, 실제 주문은 여전히 미체결(OPEN) 목록에 남아있다
      // — 이게 바로 오너가 "감시 리스트에서는 빠졌는데 주문만 덩그러니 남았다"고 본 증상의 정체.
      const tossOrderId = (entry.detail as { tossOrderId: string }).tossOrderId;
      const open = await eng.openOrders();
      expect(open.some((o) => o.tossOrderId === tossOrderId)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("감시 중 진입 주문이 취소되면 OCO 등록 없이 감시를 멈춘다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-brk-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const cancelledPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("취소돼 자동 감시를 멈췄습니다"));
      const entry = await eng.placeBracket({
        symbol: "AAPL",
        price: 1.0, // 체결 안 되게(대기 상태 유지)
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 1,
        pollMs: 20,
      });
      const tossOrderId = (entry.detail as { tossOrderId: string }).tossOrderId;
      await eng.cancelNormalOrder(tossOrderId);

      const info = await cancelledPromise;
      expect(info.summary).toContain("취소");

      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "oco")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("[v0.57.0 긴급 수정] registerOcoForFilled — 체결 후 보호주문 등록 실패 시 재시도 + 즉시 보호매도(BGIN/SMJF 실사례 회귀)", () => {
  // [배경] 오너가 실제 토스 응답 캡처 3장을 보고했다:
  //   ① BGIN $2.1×8주 — HTTP 422 insufficient-sellable-quantity "보유 수량이 없습니다"
  //   ② SMJF $2.61×10주 — HTTP 400 invalid-request "OCO 조건주문은 현재가가 두 감시가
  //      사이에 있어야 합니다"
  //   둘 다 "체결됐지만 보호주문 등록 실패"로 끝나 포지션이 무보호 상태로 남았다. 예전엔
  //   registerOcoForFilled가 한 번 실패하면 그대로 포기하고 저널 경고만 남겼다 — 이 테스트는
  //   ①류(일시적 경합)는 재시도로 스스로 회복되고, ②류(가격이 감시가를 결정적으로 넘어섬)는
  //   재시도 대신 즉시 시장가 매도로 포지션을 보호하는지 확인한다.
  type EngineInternals = { ocoRetryDelaysMs: number[] };

  it("①류: insufficient-sellable-quantity처럼 일시적인 실패는 잠깐 뒤 재시도해서 정상 등록된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oco-retry-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      await eng.quote("AAPL"); // 목 서버 인스턴스를 먼저 깨워야 아래 state 조작이 먹는다.
      (eng as unknown as EngineInternals).ocoRetryDelaysMs = [20, 20, 20]; // 테스트 전용 — 실제는 3초/5초/8초
      (eng as unknown as { mock: { state: { conditionalOrderRejectOnce: { httpStatus: number; code: string; message: string } | null } } }).mock.state.conditionalOrderRejectOnce = {
        httpStatus: 422,
        code: "insufficient-sellable-quantity",
        message: "보유 수량이 없습니다.",
      };

      const ocoPromise = waitForJournal(eng, (e) => e.kind === "oco");
      await eng.placeBracket({
        symbol: "AAPL",
        price: 2.1, // 현재가(2.05)보다 위 → 즉시 체결
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 1,
        pollMs: 20,
      });
      const ocoEntry = await ocoPromise;
      expect(ocoEntry.summary).toContain("OCO 등록 완료"); // 재시도 끝에 결국 성공
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("②류: 체결 직후 가격이 이미 익절 감시가 이상으로 올라가 있으면 OCO 대신 즉시 시장가로 매도해 보호한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oco-protect-tp-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      await eng.quote("AAPL");
      (eng as unknown as EngineInternals).ocoRetryDelaysMs = [20, 20, 20];
      // 현재가를 미리 익절 감시가(2.5)보다 높은 2.6으로 올려 둔다 — 매수 진입가(2.65)는
      // 그보다 더 위라 즉시 체결되지만, 체결된 순간부터 이미 "감시가 사이" 조건이 깨져 있다.
      await eng.mockSetPrice("AAPL", 2.6);

      const protectedPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("즉시 시장가로 매도해 포지션을 정리했습니다"));
      await eng.placeBracket({
        symbol: "AAPL",
        price: 2.65,
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 1,
        pollMs: 20,
      });
      const info = await protectedPromise;
      expect(info.summary).toContain("익절 감시가($2.5) 이상으로 이미 올라");

      // OCO는 등록되지 않았어야 한다(등록 자체가 불가능한 상황이었으므로).
      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "oco")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("②류: 체결 직후 가격이 이미 손절 감시가 이하로 내려가 있어도 즉시 시장가로 매도해 보호한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oco-protect-sl-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      await eng.quote("AAPL");
      (eng as unknown as EngineInternals).ocoRetryDelaysMs = [20, 20, 20];
      // 현재가를 손절 감시가(1.8)보다 낮은 1.5로 내려 둔다.
      await eng.mockSetPrice("AAPL", 1.5);

      const protectedPromise = waitForJournal(eng, (e) => e.kind === "info" && e.summary.includes("즉시 시장가로 매도해 포지션을 정리했습니다"));
      await eng.placeBracket({
        symbol: "AAPL",
        price: 1.6, // 현재가(1.5)보다 위 → 즉시 체결
        quantity: 1,
        tpTrigger: 2.5,
        tpPrice: 2.5,
        slTrigger: 1.8,
        slPrice: 1.79,
        expireDate: "2026-12-30",
        watchMinutes: 1,
        pollMs: 20,
      });
      const info = await protectedPromise;
      expect(info.summary).toContain("손절 감시가($1.8) 이하로 이미 내려가");

      const journal = eng.getJournal();
      expect(journal.some((j) => j.kind === "oco")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("[v0.54.0 긴급 수정] placeOto — '오입력 방지' 가격가드가 예약 매수+익절 경로도 실제로 검사한다(프로퓨사 실사례 회귀)", () => {
  // AAPL 목 서버 기본 현재가는 2.05 — 이 값 대비 터무니없이 먼 진입가/익절가를 넣어
  // 재현한다(오너 보고: 프로퓨사가 현재가와 동떨어진 가격에 조건주문이 걸림).
  it("오입력 방지가 켜져 있으면, 현재가와 너무 동떨어진 진입가를 넣었을 때 주문을 막는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oto-guard-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.setPriceGuard(true, 15); // ±15%까지만 허용
      await expect(
        eng.placeOto({
          symbol: "AAPL",
          quantity: 1,
          entryTrigger: 40, // 현재가 2.05의 약 20배 — 명백한 오입력
          entryPrice: 40,
          tpTrigger: 41,
          tpPrice: 41,
          expireDate: "2026-12-30",
        }),
      ).rejects.toThrow(/오입력 방지/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("오입력 방지가 켜져 있으면, 현재가와 너무 동떨어진 익절가만 벗어나도 막는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oto-guard2-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.setPriceGuard(true, 15);
      await expect(
        eng.placeOto({
          symbol: "AAPL",
          quantity: 1,
          entryTrigger: 2.0, // 진입가는 정상 범위
          entryPrice: 2.0,
          tpTrigger: 50, // 익절가만 터무니없이 높음
          tpPrice: 50,
          expireDate: "2026-12-30",
        }),
      ).rejects.toThrow(/오입력 방지/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("오입력 방지가 켜져 있어도, 현재가에 가까운 정상적인 가격은 그대로 통과한다(회귀 없음)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oto-guard3-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.setPriceGuard(true, 15);
      const j = await eng.placeOto({
        symbol: "AAPL",
        quantity: 1,
        entryTrigger: 2.0,
        entryPrice: 2.0,
        tpTrigger: 2.1,
        tpPrice: 2.1,
        expireDate: "2026-12-30",
      });
      expect(j.kind).toBe("oto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("오입력 방지가 꺼져 있으면(기본값) 동떨어진 가격도 그대로 전송한다(오너 결정 — 기본 동작 유지)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-oto-guard4-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // setPriceGuard를 호출하지 않음 — 기본값(꺼짐) 그대로.
      const j = await eng.placeOto({
        symbol: "AAPL",
        quantity: 1,
        entryTrigger: 40,
        entryPrice: 40,
        tpTrigger: 41,
        tpPrice: 41,
        expireDate: "2026-12-30",
      });
      expect(j.kind).toBe("oto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.54.0 긴급 수정] onAutoBracketResolved — '장시간 미체결 자동취소'와 '그 외 취소'를 서로 다른 사유로 기록한다", () => {
  // [배경] watchAndBracket()이 두 가지 서로 다른 상황("① 우리가 감시시간(watchMinutes)이 다 돼서
  //   직접 취소를 요청했고 토스가 실제로 CANCELED로 확인해 줌" vs "② 감시 마감 전에 폴링 도중
  //   토스가 이미 취소/거부 상태임을 발견함 — 킬스위치나 [주문현황]에서 직접 취소했을 수 있음")을
  //   예전엔 똑같이 `{status:"cancelled"}` 문자열 하나로 돌려줘서, onAutoBracketResolved가 ②까지도
  //   전부 "장시간 미체결로 자동 취소"라고 잘못 기록했다(오너 보고: "취소 시간 반영이 제대로 안
  //   됨" — 실제로는 타임아웃이 아니었는데 타임아웃이라고 적혔을 가능성). 이제 watchAndBracket이
  //   ①은 `cancelled_by_timeout`, ②는 그대로 `cancelled`로 서로 다르게 돌려주므로, 이 테스트는
  //   onAutoBracketResolved가 그 두 값을 받았을 때 실제로 다른 문구를 남기는지 직접 검증한다.
  //   (watchAndBracket 자체가 두 상황에서 각각 어느 값을 돌려주는지는 위 "감시 중 진입 주문이
  //   취소되면"/"cancelOnTimeout이 켜져 있으면" 테스트가 이미 커버한다 — 여기서는 그 결과를 받은
  //   뒤의 "기록 문구 분기"만 별도로 고정한다.)
  type EngineInternals = {
    autoTradePositions: AutoPosition[];
    addAutoTradeHistory: (pos: AutoPosition) => void;
    onAutoBracketResolved: (symbol: string, entry: number, res: WatchAndBracketResult) => void;
    autoTradeRealizedPnlUsd: number;
  };

  function pushWatchingPosition(eng: ToolEngine, symbol: string, entry: number, enteredAtMs: number, quantity = 1): void {
    const engAny = eng as unknown as EngineInternals;
    const pos: AutoPosition = {
      symbol, entry, tp: entry * 1.2, sl: entry * 0.9, quantity, enteredAtMs,
      status: "watching", conditionalOrderId: null,
    };
    engAny.autoTradePositions.push(pos);
    engAny.addAutoTradeHistory(pos); // getAutoTradeHistory가 찾을 수 있게 먼저 접수 기록을 남겨 둔다.
  }

  it("cancelled_by_timeout(진짜 타임아웃)이면 '장시간 미체결로 자동 취소'라고 기록한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-resolve-timeout-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const enteredAtMs = Date.now();
      pushWatchingPosition(eng, "TIMEOUTX", 10, enteredAtMs);

      engAny.onAutoBracketResolved("TIMEOUTX", 10, { status: "cancelled_by_timeout" });

      const h = eng.getAutoTradeHistory().find((e) => e.symbol === "TIMEOUTX");
      expect(h?.note).toContain("장시간 미체결로 자동 취소");
      expect(h?.note).not.toContain("설정한 감시시간이 되기 전");
      // 자리도 실제로 비워져야 한다(다음 사이클에 새 후보가 그 슬롯을 쓸 수 있게).
      expect(engAny.autoTradePositions.find((p) => p.symbol === "TIMEOUTX")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancelled(감시 마감 전 다른 경로로 취소됨)이면 '장시간 미체결'이 아니라고 정직하게 기록한다(오너 보고 회귀)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-resolve-cancel-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const enteredAtMs = Date.now();
      pushWatchingPosition(eng, "EARLYX", 10, enteredAtMs);

      engAny.onAutoBracketResolved("EARLYX", 10, { status: "cancelled" });

      const h = eng.getAutoTradeHistory().find((e) => e.symbol === "EARLYX");
      // [핵심] 예전엔 이 경우도 "장시간 미체결로 자동 취소"라고 똑같이 적혔다 — 이제는 구분된다.
      expect(h?.note).not.toContain("장시간 미체결로 자동 취소");
      expect(h?.note).toContain("설정한 감시시간이 되기 전");
      expect(engAny.autoTradePositions.find((p) => p.symbol === "EARLYX")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.57.0 긴급 수정] protected_by_market_sell이면 '실패'가 아니라 실제 청산으로 손익을 계산해 기록한다(BGIN/SMJF 회귀)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-resolve-protect-win-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const enteredAtMs = Date.now();
      // entry=$10, quantity=1(위 pushWatchingPosition 기본값) — exitPrice $12로 보호매도됐다고 가정(이익).
      pushWatchingPosition(eng, "PROTECTX", 10, enteredAtMs);
      engAny.autoTradeRealizedPnlUsd = 0;

      engAny.onAutoBracketResolved("PROTECTX", 10, { status: "protected_by_market_sell", exitPrice: 12, quantity: 1 });

      const h = eng.getAutoTradeHistory().find((e) => e.symbol === "PROTECTX");
      expect(h?.status).toBe("closed_win"); // "oco_failed"(실패)가 아니라 실제 청산 결과로 기록됨
      expect(h?.exitPrice).toBe(12);
      expect(h?.pnlUsd).toBe(2); // (12-10)*1주
      expect(h?.note).toContain("즉시 시장가로 매도해 정리함");
      expect(engAny.autoTradeRealizedPnlUsd).toBe(2); // 이번 실행 누적손익에도 반영됨
      expect(engAny.autoTradePositions.find((p) => p.symbol === "PROTECTX")).toBeUndefined(); // 자리도 비워짐
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.57.0] protected_by_market_sell로 손실 확정된 경우엔 closed_loss로 기록한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-resolve-protect-loss-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const enteredAtMs = Date.now();
      pushWatchingPosition(eng, "PROTECTY", 10, enteredAtMs); // entry $10, exitPrice $8 → 손실
      engAny.autoTradeRealizedPnlUsd = 0;

      engAny.onAutoBracketResolved("PROTECTY", 10, { status: "protected_by_market_sell", exitPrice: 8, quantity: 1 });

      const h = eng.getAutoTradeHistory().find((e) => e.symbol === "PROTECTY");
      expect(h?.status).toBe("closed_loss");
      expect(h?.pnlUsd).toBe(-2);
      expect(engAny.autoTradeRealizedPnlUsd).toBe(-2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[2차 검토에서 발견 — 긴급 수정] 부분체결로 실제 보호매도 수량이 원래 계획 수량과 다르면, 손익은 반드시 실제 매도 수량으로 계산한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-resolve-protect-partial-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const enteredAtMs = Date.now();
      // 원래 계획은 3주였지만(포지션 기록), 실제로는 2주만 체결돼 그 2주만 보호매도됐다고 가정
      // — registerOcoForFilled는 항상 "실제 체결된 수량"을 받아 처리하므로 res.quantity=2가 진실이다.
      pushWatchingPosition(eng, "PARTIALZ", 10, enteredAtMs, 3);
      engAny.autoTradeRealizedPnlUsd = 0;

      engAny.onAutoBracketResolved("PARTIALZ", 10, { status: "protected_by_market_sell", exitPrice: 12, quantity: 2 });

      const h = eng.getAutoTradeHistory().find((e) => e.symbol === "PARTIALZ");
      // [핵심] pos.quantity(3)이 아니라 res.quantity(2)로 계산해야 한다 — (12-10)*2=4.
      // 옛 코드(pos.quantity 사용)였다면 (12-10)*3=6으로 50% 과다 계상됐을 것이다.
      expect(h?.pnlUsd).toBe(4);
      expect(engAny.autoTradeRealizedPnlUsd).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// [v0.60.3 긴급 — 오너 실사용 보고: "자동 스크리닝 확정 종목의 매수 주문이 토스로
//   전송됐는데, 다음 스크리닝에서 그 종목이 카프리 추적 목록에서 갑자기 사라짐 — 토스
//   주문은 여전히 살아있는데 카프리 혼자 추적을 포기함"]
//
//   [원인] placeBracketCore가 createOrder(매수 요청) 뒤에도 saveRationale·addJournal·
//   watchAndBracket 호출까지 같은 try 블록 안에 있었다. 이 중 무엇 하나라도(특히
//   네트워크 순단으로 응답을 못 받는 경우) 예외를 던지면, autoTradeTick의 catch가
//   "주문 접수 자체가 실패"로 단정하고 posDraft(추적 기록)를 지워버렸다 — 그런데
//   createOrder 자체가 "요청은 갔는데 응답만 못 받은" 경우라면 실제로는 토스에 주문이
//   이미 접수돼 있을 수 있다. 이럴 때 카프리가 조용히 추적을 포기하면 그 주문은 익절/
//   손절 보호 없이 방치된다 — 가장 위험한 상태.
//
//   [수정] createOrder가 실패하면 clientOrderId(멱등키 — 실제로 접수됐다면 토스 쪽
//   주문에도 그대로 남아있다)로 실제 주문 목록을 직접 뒤져(findOrderByClientOrderId)
//   확인한다. 있으면 그 주문을 그대로 이어받아 정상 흐름을 계속하고, 정말 없으면
//   그제서야 실패로 처리한다.
//
//   [이 테스트가 검증하는 범위] createOrder 자체가 "요청은 갔지만 응답을 못 받는"
//   네트워크 상황을 목서버로 완벽히 재현하기는 어렵다(동기적 요청/응답 목서버라
//   "서버는 처리했지만 클라이언트가 응답을 못 받는" 상태를 만들 방법이 없음 — 이
//   프로젝트에 모듈 목(vi.mock) 관례도 없어 새로 들이지 않았다). 대신 새로 추가된
//   findOrderByClientOrderId 자체(이번 수정의 핵심 새 로직)가 실제 목서버에 대고
//   정확히 동작하는지 — 진짜 존재하는 주문은 찾고, 없는 주문은 null을 주는지 —
//   직접 검증한다.
// =============================================================================
describe("[v0.60.3] findOrderByClientOrderId — createOrder 응답을 못 받았을 때의 안전망", () => {
  type EngineInternals = {
    findOrderByClientOrderId: (clientOrderId: string, symbol: string) => Promise<{ tossOrderId: string; clientOrderId?: string } | null>;
  };

  it("실제로 접수된 주문은 clientOrderId로 정확히 찾아낸다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-findorder-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const entry = await eng.placeEntry({ symbol: "AAPL", price: 2.1, quantity: 3 });
      const detail = entry.detail as { tossOrderId: string; clientOrderId?: string };
      expect(detail.clientOrderId).toBeTruthy();

      const engAny = eng as unknown as EngineInternals;
      const found = await engAny.findOrderByClientOrderId(detail.clientOrderId as string, "AAPL");
      expect(found?.tossOrderId).toBe(detail.tossOrderId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("존재하지 않는 clientOrderId는 null(예외를 던지지 않음)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-findorder-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 목서버에 접속만 해 두고(실제 주문은 하나도 안 낸 상태) 조회를 시도한다.
      await eng.placeEntry({ symbol: "AAPL", price: 2.1, quantity: 1 }); // prepareBackend를 태우기 위한 최소 접속
      const engAny = eng as unknown as EngineInternals;
      const found = await engAny.findOrderByClientOrderId("never-existed-client-order-id", "AAPL");
      expect(found).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
