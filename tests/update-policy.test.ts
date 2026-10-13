// =============================================================================
// tests/update-policy.test.ts — [v0.87.0] 자동 업데이트 적용·재시작 정책 (오너 확정 2026-10-13)
// -----------------------------------------------------------------------------
// 자동매매·보유 포지션이 있어도 재시작한다. 미루는 건 ①주문 in-flight ②체결~OCO 등록 전 두 구간뿐.
// 재시작 직전 저장·기록, 직후 대조·재보호·기록을 고정한다(자동매매 자동 재개 자체는 v0.86.0 테스트가 고정 — tests/auto-trade.test.ts).
// ⚠️ 실계좌 안 건드림(forceMock).
// =============================================================================
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRestart, isMarkerFresh, describeRestart, BLOCKER_STALE_MS, RESUME_WINDOW_MS, type RestartMarker } from "../lib/update-policy";
import { ToolEngine, type AutoPosition } from "../electron/tool-engine";

describe("update-policy — 순수 판정", () => {
  const now = 1_000_000_000_000;
  it("막는 구간이 없으면 지금 재시작한다(자동매매·포지션 여부는 보지 않는다)", () => {
    expect(evaluateRestart([], now)).toEqual({ ok: true, active: [], stale: [] });
  });
  it("in-flight·OCO 등록 구간이 있으면 미룬다", () => {
    const d = evaluateRestart([{ kind: "inflight", label: "매수 주문 전송 AAA", sinceMs: now - 3000 }, { kind: "oco-window", label: "체결 확인 → OCO 등록 BBB", sinceMs: now - 1000 }], now);
    expect(d.ok).toBe(false);
    expect(d.active.map((b) => b.kind)).toEqual(["inflight", "oco-window"]);
  });
  it("너무 오래 붙은 표시는 꼬인 것으로 보고 무시한다(업데이트가 영영 막히지 않게)", () => {
    const d = evaluateRestart([{ kind: "inflight", label: "stuck", sinceMs: now - BLOCKER_STALE_MS - 1 }], now);
    expect(d.ok).toBe(true);
    expect(d.stale).toHaveLength(1);
  });
  it("표식은 30분 안에서만 유효하다", () => {
    const m: RestartMarker = { atMs: now, fromVersion: "0.86.0", toVersion: "0.87.0", autoTradeWasOn: true, positions: [], unprotected: [] };
    expect(isMarkerFresh(m, now + 60_000)).toBe(true);
    expect(isMarkerFresh(m, now + RESUME_WINDOW_MS + 1)).toBe(false);
  });
  it("기록 문장에 버전 전후·자동매매 상태·보유 포지션이 들어간다", () => {
    const line = describeRestart({ atMs: now, fromVersion: "0.86.0", toVersion: "0.87.0", autoTradeWasOn: true, positions: [{ symbol: "FFR", status: "active", quantity: 63 }], unprotected: [] }, "0.87.0");
    expect(line).toContain("v0.86.0 → v0.87.0");
    expect(line).toContain("FFR");
    expect(line).toContain("자동으로 다시 켭니다");
  });
});

type Internals = {
  autoTradePositions: AutoPosition[];
  autoTradeEnabled: boolean;
  inflight: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  registerOcoForFilled: (symbol: string, qty: number, spec: unknown, fill?: number | null) => Promise<unknown>;
  guardTimer: ReturnType<typeof setTimeout> | null;
};

function setup(version = "0.86.0") {
  const dir = mkdtempSync(join(tmpdir(), "kyle-upd-"));
  const eng = new ToolEngine(dir, { forceMock: true, appVersion: version });
  const x = eng as unknown as Internals;
  const cleanup = () => { if (x.guardTimer) clearTimeout(x.guardTimer); try { eng.stopAutoTrade("테스트 정리"); } catch { /* 무시 */ } rmSync(dir, { recursive: true, force: true }); };
  return { dir, eng, x, cleanup };
}

describe("엔진 — 재시작 판정: 자동매매·포지션이 있어도 허용, 두 구간만 보류", () => {
  it("자동매매가 켜져 있고 포지션이 있어도 재시작을 막지 않는다", () => {
    const { eng, x, cleanup } = setup();
    try {
      x.autoTradeEnabled = true;
      x.autoTradePositions.push({ symbol: "AAA", entry: 2, tp: 2.05, sl: 1.8, quantity: 10, enteredAtMs: Date.now(), status: "active", conditionalOrderId: "c1" });
      expect(eng.getRestartDecision().ok).toBe(true);
    } finally { x.autoTradeEnabled = false; cleanup(); }
  });

  it("주문 전송(in-flight) 중에는 보류하고, 끝나면 풀린다", async () => {
    const { eng, x, cleanup } = setup();
    try {
      let during: ReturnType<ToolEngine["getRestartDecision"]> | null = null;
      await x.inflight("매수 주문 전송 TEST", async () => { during = eng.getRestartDecision(); });
      expect(during!.ok).toBe(false);
      expect(during!.active[0].kind).toBe("inflight");
      expect(eng.getRestartDecision().ok).toBe(true);
    } finally { cleanup(); }
  });

  it("체결 확인 ~ OCO 등록 구간(registerOcoForFilled) 동안 보류하고, 끝나면 풀린다", async () => {
    const { eng, x, cleanup } = setup();
    try {
      await eng.quote("AAPL");
      const p = x.registerOcoForFilled("AAPL", 1, { tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30" });
      const during = eng.getRestartDecision(); // 구간은 호출 즉시(동기적으로) 열려 있다
      await p;
      expect(during.ok).toBe(false);
      expect(during.active.some((b) => b.kind === "oco-window")).toBe(true);
      expect(eng.getRestartDecision().ok).toBe(true);
    } finally { cleanup(); }
  }, 20_000);

  it("재시작 직전 동결 상태에서는 새 주문 전송이 시작되지 않는다(방금 확인한 안전한 순간을 지킴)", async () => {
    const { eng, x, cleanup } = setup();
    try {
      eng.setRestartFrozen(true);
      await expect(x.inflight("매수 주문 전송 TEST", async () => 1)).rejects.toThrow(/재시작 직전/);
      eng.setRestartFrozen(false);
      await expect(x.inflight("매수 주문 전송 TEST", async () => 1)).resolves.toBe(1);
    } finally { cleanup(); }
  });
});

describe("엔진 — 재시작 직전 저장·기록 + 직후 대조·기록", () => {
  it("prepareForRestart는 포지션·자동매매 상태를 기록 표식으로 남기고(+ v0.86.0 재개 표시), 직후 resumeAfterRestart가 한 번만 기록한다", async () => {
    const { dir, eng, x, cleanup } = setup("0.86.0");
    try {
      x.autoTradeEnabled = true; // 켜진 상태 표시(타이머 없이)
      x.autoTradePositions.push({ symbol: "AAA", entry: 2, tp: 2.05, sl: 1.8, quantity: 10, enteredAtMs: Date.now(), status: "active", conditionalOrderId: "c1" });
      const m = await eng.prepareForRestart({ toVersion: "0.87.0" });
      expect(m.autoTradeWasOn).toBe(true);
      expect(m.positions).toEqual([{ symbol: "AAA", status: "active", quantity: 10 }]);
      expect(existsSync(join(dir, "kylebot-restart-record.json"))).toBe(true);
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("AUTO_RESUME_AFTER_UPDATE=true"); // 자동매매 재개 표시(v0.86.0 통로) 그대로 사용
      x.autoTradeEnabled = false;

      // 같은 폴더의 "새 버전" 엔진(forceMock이라 생성자의 자동 재개는 건너뜀 — 그건 v0.86.0 테스트가 고정)
      const eng2 = new ToolEngine(dir, { forceMock: true, appVersion: "0.87.0" });
      await eng2.quote("AAPL"); // 목 서버 준비
      expect(await eng2.resumeAfterRestart()).toBe("done");
      const rec = eng2.getJournal().find((j) => j.summary.includes("v0.86.0 → v0.87.0"));
      expect(rec).toBeDefined(); // 이전/새 버전 기록
      expect(rec!.summary).toContain("AAA"); // 당시 보유 포지션
      expect(existsSync(join(dir, "kylebot-restart-record.json"))).toBe(false); // 한 번 쓰고 치움
      expect(await eng2.resumeAfterRestart()).toBe("none");
    } finally { cleanup(); }
  }, 30_000);

  it("30분이 지난 표식은 무시한다", async () => {
    const { dir, eng, cleanup } = setup();
    try {
      const old: RestartMarker = { atMs: Date.now() - RESUME_WINDOW_MS - 60_000, fromVersion: "0.86.0", toVersion: "0.87.0", autoTradeWasOn: true, positions: [], unprotected: [] };
      writeFileSync(join(dir, "kylebot-restart-record.json"), JSON.stringify(old), "utf8");
      expect(await eng.resumeAfterRestart()).toBe("expired");
      expect(readFileSync(join(dir, "kylebot-restart-record.json.done"), "utf8")).toContain("0.86.0");
    } finally { cleanup(); }
  }, 20_000);
});
