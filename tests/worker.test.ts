// =============================================================================
// tests/worker.test.ts  —  로컬 워커 루프(runOneTick) 검증
// -----------------------------------------------------------------------------
// 워커의 "조율" 동작을 확인합니다(실제 세션 전진 로직은 lifecycle 통합 테스트에서).
//   - 데이마켓이면 활성 세션들을 전진시킨다
//   - 데이마켓이 아니면 쉰다(idle)
//   - 한 세션 전진이 실패해도 나머지는 계속 전진한다(루프가 안 죽는다)
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { DateTime } from "luxon";
import { runOneTick, type WorkerDeps } from "../lib/worker";
import { createSession, type SessionRuntime } from "../lib/lifecycle";

function kst(y: number, mo: number, d: number, h: number, mi = 0): DateTime {
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi }, { zone: "Asia/Seoul" });
}

/** 테스트용 빈 세션(전진 로직은 목으로 대체하므로 포지션은 필요 없음) */
function dummySession(id: string): SessionRuntime {
  return createSession(id, "AAPL", "candle", []);
}

describe("runOneTick (워커 한 박동)", () => {
  it("데이마켓이면 활성 세션들을 전진시킨다(advanced)", async () => {
    const advance = vi.fn(async () => {});
    const deps: WorkerDeps = {
      getActiveSessions: () => [dummySession("s1"), dummySession("s2")],
      advance,
    };
    const result = await runOneTick(kst(2026, 7, 16, 10, 0), deps); // 서머 데이마켓

    expect(result.session).toBe("day");
    expect(result.action).toBe("advanced");
    expect(result.advanced).toBe(2);
    expect(result.errors).toBe(0);
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it("데이마켓이 아니면 쉬고, 세션 전진도 안 한다(idle)", async () => {
    const advance = vi.fn(async () => {});
    const deps: WorkerDeps = {
      getActiveSessions: () => [dummySession("s1")],
      advance,
    };
    const result = await runOneTick(kst(2026, 7, 16, 8, 0), deps); // 개장 전

    expect(result.session).not.toBe("day");
    expect(result.action).toBe("idle");
    expect(advance).not.toHaveBeenCalled();
  });

  it("한 세션 전진이 실패해도 나머지는 계속 전진한다", async () => {
    // 두 번째 세션에서만 오류를 던지게 한다.
    const advance = vi.fn(async (rt: SessionRuntime) => {
      if (rt.id === "boom") throw new Error("네트워크 오류");
    });
    const deps: WorkerDeps = {
      getActiveSessions: () => [dummySession("s1"), dummySession("boom"), dummySession("s3")],
      advance,
      log: () => {},
    };
    const result = await runOneTick(kst(2026, 7, 16, 10, 0), deps);

    expect(result.advanced).toBe(2); // s1, s3 성공
    expect(result.errors).toBe(1); // boom 실패
    expect(advance).toHaveBeenCalledTimes(3); // 실패에도 3개 모두 시도됨(루프 안 죽음)
  });

  it("이미 닫힌(closed) 세션은 전진 대상에서 제외한다", async () => {
    const advance = vi.fn(async () => {});
    const closed = dummySession("done");
    closed.status = "closed";
    const deps: WorkerDeps = {
      getActiveSessions: () => [closed, dummySession("s1")],
      advance,
    };
    const result = await runOneTick(kst(2026, 7, 16, 10, 0), deps);

    expect(result.advanced).toBe(1); // s1만
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
