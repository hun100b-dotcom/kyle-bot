// =============================================================================
// tests/session.test.ts  —  세션 스케줄(lib/session.ts) 검증
// -----------------------------------------------------------------------------
// 핵심 확인 목표:
//   1) 지금 시각으로 세션(day/pre/regular)을 맞게 구분하는가
//   2) 서머타임(여름)/겨울에 데이마켓 개장 시각이 09:00 / 10:00 으로 자동으로 바뀌는가
//   3) 서머타임 전환일(2026-03-08) 전후로 개장 시각이 실제로 달라지는가
// =============================================================================

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { getSession, getDayMarketOpen, isInDailyPauseWindow } from "../lib/session";

/** KST(한국시간) DateTime을 간편하게 만드는 헬퍼 */
function kst(year: number, month: number, day: number, hour = 0, minute = 0): DateTime {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: "Asia/Seoul" });
}

describe("getSession (현재 세션 판정)", () => {
  it("2026-07-16 10:00 KST → 'day' (서머, 개장 09:00 직후)", () => {
    expect(getSession(kst(2026, 7, 16, 10, 0))).toBe("day");
  });

  it("2026-07-16 23:00 KST → 'regular' (정규장)", () => {
    expect(getSession(kst(2026, 7, 16, 23, 0))).toBe("regular");
  });

  it("2026-07-16 18:00 KST → 'pre' (프리마켓)", () => {
    expect(getSession(kst(2026, 7, 16, 18, 0))).toBe("pre");
  });
});

describe("getDayMarketOpen (데이마켓 개장 시각, 서머타임 자동 처리)", () => {
  it("2026-01-15 (겨울) → 개장 10:00 KST", () => {
    const open = getDayMarketOpen(kst(2026, 1, 15));
    expect(open.hour).toBe(10);
    expect(open.minute).toBe(0);
  });

  it("2026-07-16 (서머) → 개장 09:00 KST", () => {
    const open = getDayMarketOpen(kst(2026, 7, 16));
    expect(open.hour).toBe(9);
    expect(open.minute).toBe(0);
  });

  it("서머타임 전환일(2026-03-08) 전후로 개장 시각이 바뀐다", () => {
    // 2026-03-08은 미국 서머타임 시작일(3월 둘째 일요일).
    // KST 3/8 개장 = 뉴욕 3/7 20:00(아직 표준시 EST) → 겨울 10:00
    // KST 3/9 개장 = 뉴욕 3/8 20:00(서머 EDT 시작 후) → 서머 09:00
    const beforeSwitch = getDayMarketOpen(kst(2026, 3, 8));
    const afterSwitch = getDayMarketOpen(kst(2026, 3, 9));
    expect(beforeSwitch.hour).toBe(10); // 전환 전: 겨울 시각
    expect(afterSwitch.hour).toBe(9); //  전환 후: 서머 시각
  });
});

describe("[v0.44.0] isInDailyPauseWindow (매일 반복 휴무 시간대, KST)", () => {
  it("05:00~17:00 구간: 경계값(05:00 포함, 17:00 미포함)과 구간 안/밖", () => {
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 4, 59), 5, 17)).toBe(false); // 직전
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 5, 0), 5, 17)).toBe(true); //   시작 포함
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 12, 0), 5, 17)).toBe(true); //  한가운데
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 16, 59), 5, 17)).toBe(true); // 직전
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 17, 0), 5, 17)).toBe(false); // 종료는 미포함(재개)
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 23, 0), 5, 17)).toBe(false); // 밤(오버나이트 허용구간)
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 0, 0), 5, 17)).toBe(false); //  자정
  });

  it("자정을 넘기는 구간(예: 22~06)도 올바르게 판정한다", () => {
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 23, 0), 22, 6)).toBe(true);
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 3, 0), 22, 6)).toBe(true);
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 12, 0), 22, 6)).toBe(false);
  });

  it("시작=종료면 휴무 구간이 없다(설정 실수 방어)", () => {
    expect(isInDailyPauseWindow(kst(2026, 7, 16, 12, 0), 5, 5)).toBe(false);
  });
});
