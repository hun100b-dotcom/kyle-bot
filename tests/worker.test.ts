// =============================================================================
// tests/worker.test.ts  —  로컬 워커 한 틱(runOneTick) 검증
// -----------------------------------------------------------------------------
// 워커가 "상시 실행" 구조로 도는지 그 최소 단위(한 박동)를 확인합니다.
//   - 데이마켓이면: 시세를 폴링한다(polled)
//   - 데이마켓이 아니면: 쉰다(idle) — 불필요한 호출/위험 방지
// 실제 시간·네트워크 대신 now(시각)와 deps(시세조회)를 주입해 결정적으로 테스트합니다.
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { DateTime } from "luxon";
import { runOneTick } from "../lib/worker";

/** KST 시각 헬퍼 */
function kst(y: number, mo: number, d: number, h: number, mi = 0): DateTime {
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi }, { zone: "Asia/Seoul" });
}

describe("runOneTick (워커 한 박동)", () => {
  it("데이마켓 시간이면 시세를 폴링한다(polled)", async () => {
    const getPrice = vi.fn(async () => ({ price: 2.05 }));
    const now = kst(2026, 7, 16, 10, 0); // 서머 데이마켓(09:00~17:00) 안 → 'day'

    const result = await runOneTick(now, { symbol: "AAPL" }, { getPrice });

    expect(result.session).toBe("day");
    expect(result.action).toBe("polled");
    expect(result.price).toBe(2.05);
    expect(getPrice).toHaveBeenCalledOnce(); // 실제로 시세를 불렀다
  });

  it("데이마켓이 아니면 쉬고, 시세 조회도 안 한다(idle)", async () => {
    const getPrice = vi.fn(async () => ({ price: 2.05 }));
    const now = kst(2026, 7, 16, 8, 0); // 개장(09:00) 전 → 'day' 아님

    const result = await runOneTick(now, { symbol: "AAPL" }, { getPrice });

    expect(result.session).not.toBe("day");
    expect(result.action).toBe("idle");
    expect(getPrice).not.toHaveBeenCalled(); // 장이 아니면 호출 안 함(불필요한 요청 방지)
  });
});
