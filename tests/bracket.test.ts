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
import { ToolEngine, type JournalEntry } from "../electron/tool-engine";

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
