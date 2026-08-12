// =============================================================================
// lib/holidays.ts  —  미국 증시(NYSE·나스닥) 휴장일 / 조기폐장일 계산
// -----------------------------------------------------------------------------
// [왜 필요한가?]
//   lib/session.ts 는 "지금이 몇 시인가"만 보고 세션(데이/프리/정규/애프터)을 판정했습니다.
//   그래서 **토요일·일요일·미국 공휴일(추수감사절 등)에도 "데이마켓 진행 중"**이라고
//   화면에 떴습니다. 사람이 그 표시를 믿고 주문을 준비하면 헛수고이고,
//   세션별 시드 비율(데이 90% / 프리·본장 50%)도 엉뚱하게 적용됩니다.
//
// [왜 연도별 날짜 목록을 하드코딩하지 않는가?]
//   이 레포의 큰 교훈("서머타임을 if문으로 하드코딩하지 말 것")과 같은 이유입니다.
//   목록을 박아 두면 2027년이 되는 순간 조용히 틀립니다. 미국 증시 휴장일은
//   전부 **규칙**(예: "1월 셋째 월요일")으로 정의돼 있으니 규칙 그대로 계산합니다.
//   유일한 예외가 성금요일(부활절 이틀 전)인데, 부활절도 표준 계산식(computus)이 있습니다.
//
// [입력은 항상 '미국 동부(New York) 날짜'입니다]
//   한국 날짜로 판정하면 안 됩니다. 예를 들어 한국 시각 목요일 새벽 3시는
//   미국 동부로는 수요일 오후 2시(정규장)입니다. 어느 '미국 거래일'에 속한
//   시간인지는 lib/session.ts 가 계산해서 이 모듈에 넘겨 줍니다.
// =============================================================================

import { DateTime } from "luxon";

/** 휴장/조기폐장 판정 결과(사람에게 보여줄 한국어 이름 포함) */
export interface HolidayInfo {
  /** 전일 휴장이면 그 이름(예: "추수감사절"), 아니면 null */
  closed: string | null;
  /** 조기폐장(오후 1시 마감)이면 그 이름(예: "크리스마스 이브"), 아니면 null */
  earlyClose: string | null;
}

// -----------------------------------------------------------------------------
// 작은 도우미들 — "n번째 요일", "마지막 요일", "대체휴일"
// -----------------------------------------------------------------------------

/** 그 달의 n번째 특정 요일(weekday: 1=월 … 7=일). 예: nth(2026, 1, 1, 3) = 1월 셋째 월요일 */
function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone: "America/New_York" });
  // 그 달 1일에서 원하는 요일까지 며칠 더 가야 하는지(0~6)
  const delta = (weekday - first.weekday + 7) % 7;
  return first.plus({ days: delta + (n - 1) * 7 });
}

/** 그 달의 '마지막' 특정 요일. 예: 5월 마지막 월요일(메모리얼 데이) */
function lastWeekday(year: number, month: number, weekday: number): DateTime {
  const last = DateTime.fromObject({ year, month, day: 1 }, { zone: "America/New_York" }).endOf("month").startOf("day");
  const delta = (last.weekday - weekday + 7) % 7;
  return last.minus({ days: delta });
}

/**
 * observed — 날짜가 주말에 걸릴 때 실제로 쉬는 날(대체휴일)로 옮긴다.
 *   미국 증시 규칙: 토요일 → 앞의 금요일 / 일요일 → 뒤의 월요일.
 *   (신정만 예외라서 그 처리는 호출부에서 따로 한다.)
 */
function observed(d: DateTime): DateTime {
  if (d.weekday === 6) return d.minus({ days: 1 }); // 토 → 금
  if (d.weekday === 7) return d.plus({ days: 1 }); //  일 → 월
  return d;
}

/**
 * easterSunday — 부활절(그레고리력) 계산. 이른바 '익명 그레고리 계산법(computus)'.
 *   부활절은 "춘분 후 첫 보름달 다음 일요일"이라 달의 주기가 얽혀 있어 이런 식이 필요합니다.
 *   이 식은 수백 년간 검증된 표준 알고리즘이라 그대로 씁니다(직접 유도할 필요 없음).
 */
function easterSunday(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=3월, 4=4월
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.fromObject({ year, month, day }, { zone: "America/New_York" });
}

/** yyyy-MM-dd 문자열(뉴욕 기준)로 바꿔 비교용 열쇠로 쓴다. */
function key(d: DateTime): string {
  return d.setZone("America/New_York").toFormat("yyyy-MM-dd");
}

// -----------------------------------------------------------------------------
// 그 해의 휴장일 표를 규칙으로 생성 (연도마다 1회 계산 후 캐시)
// -----------------------------------------------------------------------------
const holidayCache = new Map<number, Map<string, string>>(); // year → (yyyy-MM-dd → 이름)
const earlyCache = new Map<number, Map<string, string>>();

function buildHolidays(year: number): Map<string, string> {
  const map = new Map<string, string>();
  const add = (d: DateTime, name: string) => map.set(key(d), name);

  // ① 신정(1/1). 예외 규칙: 1월 1일이 '토요일'이면 앞당겨 쉬지 않는다(전년 12/31 금요일은 정상 개장).
  const jan1 = DateTime.fromObject({ year, month: 1, day: 1 }, { zone: "America/New_York" });
  if (jan1.weekday === 7) add(jan1.plus({ days: 1 }), "신정(대체)"); // 일요일 → 월요일 휴장
  else if (jan1.weekday !== 6) add(jan1, "신정"); //                    평일이면 그날 휴장

  add(nthWeekday(year, 1, 1, 3), "마틴 루터 킹 데이"); //   1월 셋째 월요일
  add(nthWeekday(year, 2, 1, 3), "대통령의 날"); //         2월 셋째 월요일
  add(easterSunday(year).minus({ days: 2 }), "성금요일"); // 부활절 이틀 전 금요일
  add(lastWeekday(year, 5, 1), "메모리얼 데이"); //          5월 마지막 월요일
  add(observed(DateTime.fromObject({ year, month: 6, day: 19 }, { zone: "America/New_York" })), "준틴스");
  add(observed(DateTime.fromObject({ year, month: 7, day: 4 }, { zone: "America/New_York" })), "독립기념일");
  add(nthWeekday(year, 9, 1, 1), "노동절"); //               9월 첫째 월요일
  add(nthWeekday(year, 11, 4, 4), "추수감사절"); //          11월 넷째 목요일
  add(observed(DateTime.fromObject({ year, month: 12, day: 25 }, { zone: "America/New_York" })), "크리스마스");

  return map;
}

function buildEarlyCloses(year: number): Map<string, string> {
  const map = new Map<string, string>();
  const holidays = getHolidayMap(year);
  const add = (d: DateTime, name: string) => {
    // 주말이거나 이미 휴장일이면 조기폐장이 아니다(그냥 안 연다).
    if (d.weekday >= 6) return;
    if (holidays.has(key(d))) return;
    map.set(key(d), name);
  };

  // ① 독립기념일 전날(7/3) — 7/4가 실제로 쉬는 날일 때만.
  add(DateTime.fromObject({ year, month: 7, day: 3 }, { zone: "America/New_York" }), "독립기념일 전날");

  // ② 추수감사절 다음 날(금요일) — 이른바 블랙프라이데이.
  add(nthWeekday(year, 11, 4, 4).plus({ days: 1 }), "추수감사절 다음 날");

  // ③ 크리스마스 이브(12/24) — 평일일 때만(금요일이면 정상 마감이지만, 최근 규칙은 평일이면 조기폐장).
  add(DateTime.fromObject({ year, month: 12, day: 24 }, { zone: "America/New_York" }), "크리스마스 이브");

  return map;
}

function getHolidayMap(year: number): Map<string, string> {
  let m = holidayCache.get(year);
  if (!m) {
    m = buildHolidays(year);
    holidayCache.set(year, m);
  }
  return m;
}

function getEarlyMap(year: number): Map<string, string> {
  let m = earlyCache.get(year);
  if (!m) {
    m = buildEarlyCloses(year);
    earlyCache.set(year, m);
  }
  return m;
}

// -----------------------------------------------------------------------------
// 공개 함수
// -----------------------------------------------------------------------------

/**
 * getHolidayInfo — 주어진 '미국 거래일 날짜'가 휴장인지/조기폐장인지 알려준다.
 *   @param nyDate 미국 동부 기준 날짜(시각은 무시하고 날짜만 본다)
 */
export function getHolidayInfo(nyDate: DateTime): HolidayInfo {
  const d = nyDate.setZone("America/New_York").startOf("day");

  // 주말은 공휴일과 별개로 항상 휴장.
  if (d.weekday === 6) return { closed: "주말(토요일)", earlyClose: null };
  if (d.weekday === 7) return { closed: "주말(일요일)", earlyClose: null };

  const k = key(d);
  const holiday = getHolidayMap(d.year).get(k) ?? null;
  if (holiday) return { closed: holiday, earlyClose: null };

  return { closed: null, earlyClose: getEarlyMap(d.year).get(k) ?? null };
}

/** isUsTradingDay — 그 날 미국 증시가 (조기폐장이라도) 열리는가? */
export function isUsTradingDay(nyDate: DateTime): boolean {
  return getHolidayInfo(nyDate).closed === null;
}
