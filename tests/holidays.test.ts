// =============================================================================
// tests/holidays.test.ts  —  미국 증시 휴장일/조기폐장 + 세션 반영 검증 [v0.8.4]
// -----------------------------------------------------------------------------
// 확인 목표:
//   1) 휴장일을 '규칙'으로 계산하는가(연도 하드코딩 없이 2026·2027 둘 다 맞는가)
//   2) 주말·공휴일에는 세션이 'closed'로 뜨는가(예전엔 일요일에도 "데이마켓"이었다)
//   3) 조기폐장일에는 정규장이 일찍 끝나는가
//   4) 휴장 사유와 '다음 개장 시각'을 사람이 읽을 수 있게 주는가
// =============================================================================

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { getHolidayInfo, isUsTradingDay } from "../lib/holidays";
import { getSession, getMarketStatus, findNextOpen, getSessionStart } from "../lib/session";

/** 뉴욕 날짜 헬퍼(휴장일 판정은 항상 미국 날짜 기준) */
function ny(year: number, month: number, day: number): DateTime {
  return DateTime.fromObject({ year, month, day }, { zone: "America/New_York" });
}
/** KST 시각 헬퍼(세션 판정은 한국 시각 기준) */
function kst(year: number, month: number, day: number, hour = 0, minute = 0): DateTime {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: "Asia/Seoul" });
}

describe("getHolidayInfo — 규칙으로 계산하는 미국 증시 휴장일", () => {
  it("2026년 고정 휴일: 신정(1/1)·준틴스(6/19)", () => {
    expect(getHolidayInfo(ny(2026, 1, 1)).closed).toBe("신정");
    expect(getHolidayInfo(ny(2026, 6, 19)).closed).toBe("준틴스");
  });

  it("2026년 요일 규칙 휴일: MLK(1/19)·대통령의 날(2/16)·메모리얼(5/25)·노동절(9/7)·추수감사절(11/26)", () => {
    expect(getHolidayInfo(ny(2026, 1, 19)).closed).toBe("마틴 루터 킹 데이");
    expect(getHolidayInfo(ny(2026, 2, 16)).closed).toBe("대통령의 날");
    expect(getHolidayInfo(ny(2026, 5, 25)).closed).toBe("메모리얼 데이");
    expect(getHolidayInfo(ny(2026, 9, 7)).closed).toBe("노동절");
    expect(getHolidayInfo(ny(2026, 11, 26)).closed).toBe("추수감사절");
  });

  it("성금요일은 부활절 이틀 전 — 2026-04-03, 2027-03-26", () => {
    expect(getHolidayInfo(ny(2026, 4, 3)).closed).toBe("성금요일");
    expect(getHolidayInfo(ny(2027, 3, 26)).closed).toBe("성금요일");
  });

  it("주말에 걸린 휴일은 대체휴일로 옮긴다 — 2026 독립기념일(7/4 토) → 7/3(금) 휴장", () => {
    expect(ny(2026, 7, 4).weekday).toBe(6); //          토요일 확인
    expect(getHolidayInfo(ny(2026, 7, 3)).closed).toBe("독립기념일");
  });

  it("신정 예외: 1월 1일이 토요일이면 앞당겨 쉬지 않는다 — 2028-01-01(토)", () => {
    expect(ny(2028, 1, 1).weekday).toBe(6);
    expect(getHolidayInfo(ny(2027, 12, 31)).closed).toBeNull(); // 전날 금요일은 정상 개장
  });

  it("평일이고 휴일이 아니면 열린다", () => {
    expect(isUsTradingDay(ny(2026, 8, 13))).toBe(true); // 목요일, 아무 날
    expect(isUsTradingDay(ny(2026, 11, 26))).toBe(false); // 추수감사절
  });

  it("주말은 언제나 휴장", () => {
    expect(getHolidayInfo(ny(2026, 8, 15)).closed).toBe("주말(토요일)");
    expect(getHolidayInfo(ny(2026, 8, 16)).closed).toBe("주말(일요일)");
  });

  it("조기폐장: 추수감사절 다음날(2026-11-27)·크리스마스 이브(2026-12-24)", () => {
    expect(getHolidayInfo(ny(2026, 11, 27)).earlyClose).toBe("추수감사절 다음 날");
    expect(getHolidayInfo(ny(2026, 12, 24)).earlyClose).toBe("크리스마스 이브");
  });
});

describe("getSession — 주말·공휴일이면 시각과 무관하게 closed [핵심 회귀]", () => {
  it("일요일 새벽(예전 버그: '데이마켓'으로 표시) → closed", () => {
    // KST 2026-08-16(일) 11:00 = 미국 8/16(일). 예전 코드는 개장 +2h라 'day'로 판정했다.
    expect(getSession(kst(2026, 8, 16, 11, 0))).toBe("closed");
  });

  it("추수감사절(미국 11/26) 정규장 시간대 → closed + 사유 표시", () => {
    // KST 11/26 23:30 = 뉴욕 11/26 09:30(정규장 개장 시각) → 휴장이라 안 열린다.
    const st = getMarketStatus(kst(2026, 11, 26, 23, 30));
    expect(st.session).toBe("closed");
    expect(st.closedReason).toBe("추수감사절");
  });

  it("평일 정규장 시간대는 그대로 regular", () => {
    expect(getSession(kst(2026, 8, 13, 23, 30))).toBe("regular"); // 목요일
  });

  it("휴장일에는 getSessionStart도 null(스크리너 기준 시각 오염 방지)", () => {
    expect(getSessionStart(kst(2026, 8, 16, 11, 0))).toBeNull();
  });
});

describe("조기폐장일 — 정규장이 뉴욕 13:00에 끝난다", () => {
  it("2026-11-27(추수감사절 다음날) 뉴욕 12:30은 regular, 13:30은 after", () => {
    // 겨울(EST)이라 뉴욕 12:30 = KST 다음날 02:30, 13:30 = KST 03:30.
    expect(getSession(kst(2026, 11, 28, 2, 30))).toBe("regular");
    expect(getSession(kst(2026, 11, 28, 3, 30))).toBe("after");
  });

  it("조기폐장이면 상태에 그 이름이 담긴다", () => {
    expect(getMarketStatus(kst(2026, 11, 28, 2, 30)).earlyClose).toBe("추수감사절 다음 날");
  });
});

describe("getMarketStatus / findNextOpen — 다음 개장 안내", () => {
  it("토요일에는 다음 개장이 '월요일 개장'으로 나온다", () => {
    // KST 2026-08-15(토) 12:00 → 미국 8/15(토) 휴장. 다음 사이클은 KST 8/17(월) 개장.
    const st = getMarketStatus(kst(2026, 8, 15, 12, 0));
    expect(st.session).toBe("closed");
    const next = st.nextOpen!;
    expect(next.toFormat("yyyy-MM-dd")).toBe("2026-08-17");
    expect(next.hour).toBe(9); // 서머라 09:00 KST
  });

  it("연휴(추수감사절)에는 그 다음 거래일 개장으로 건너뛴다", () => {
    // KST 11/26(목) 12:00 → 미국 11/26 추수감사절 휴장. 다음 개장은 KST 11/27(금).
    const next = findNextOpen(kst(2026, 11, 26, 12, 0))!;
    expect(next.toFormat("yyyy-MM-dd")).toBe("2026-11-27");
  });

  it("장이 열려 있으면 closedReason은 null", () => {
    const st = getMarketStatus(kst(2026, 8, 13, 23, 30));
    expect(st.closedReason).toBeNull();
    expect(st.tradingDate).toBe("2026-08-13");
  });
});
