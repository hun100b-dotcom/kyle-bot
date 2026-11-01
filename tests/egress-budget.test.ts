import { describe, expect, it } from "vitest";
import { EgressBudget } from "../lib/egress-budget";

// 하루 예산 계산기 테스트 — 예산을 쓸수록 폴링 배수가 단계적으로 늘고, 날짜가 바뀌면 초기화되는지 확인한다.
describe("EgressBudget", () => {
  const T = new Date(2026, 10, 1, 12, 0, 0).getTime();

  it("예산 50% 미만이면 배수 1, 이후 2·4·8로 늘어난다", () => {
    const b = new EgressBudget(1000);
    expect(b.multiplier(T)).toBe(1);
    b.record(100, T); // 100+400=500 → 50%
    expect(b.multiplier(T)).toBe(2);
    b.record(100, T); // 1000 → 100%
    expect(b.multiplier(T)).toBe(8);
  });

  it("content-length를 모르면 어림값을 쓴다", () => {
    const b = new EgressBudget(1_000_000);
    b.record(null, T);
    expect(b.snapshot(T).bytes).toBeGreaterThan(2000);
  });

  it("배수 N이면 N번에 한 번만 실행한다", () => {
    const b = new EgressBudget(1000);
    b.record(100, T); // 배수 2
    expect([b.shouldRun("x", T), b.shouldRun("x", T), b.shouldRun("x", T), b.shouldRun("x", T)]).toEqual([false, true, false, true]);
  });

  it("다음 날이 되면 사용량이 초기화된다", () => {
    const b = new EgressBudget(1000);
    b.record(5000, T);
    expect(b.multiplier(T)).toBe(8);
    expect(b.multiplier(T + 24 * 3600_000)).toBe(1);
  });
});
