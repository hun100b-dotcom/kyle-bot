// =============================================================================
// lib/session.ts  —  Capri 세션 스케줄 (설계서 M0 / M0-A)
// -----------------------------------------------------------------------------
// "지금이 어떤 장(세션)인가?", "오늘 언제 스캔/주문/청산해야 하나?"를 계산합니다.
//
// [가장 중요한 원칙: 서머타임을 하드코딩하지 말 것]
//   한국(KST)은 서머타임이 없지만, 미국은 3월~11월에 서머타임(DST)을 씁니다.
//   그래서 "미국 장이 열리는 한국 시각"이 여름/겨울에 1시간씩 달라집니다.
//     - 서머(DST): 데이마켓 개장 = 09:00 KST
//     - 겨울(표준): 데이마켓 개장 = 10:00 KST
//
//   이걸 if문으로 날짜를 하드코딩하면 매년 전환일이 바뀌어 틀립니다.
//   대신 luxon으로 '미국 동부 시각(America/New_York)'을 기준점으로 만들고
//   그걸 KST로 변환하면, 서머타임 여부를 luxon이 알아서 처리합니다.
//
// [핵심 통찰] 데이마켓 개장은 "미국 동부 저녁 20:00"에 고정되어 있습니다.
//   - 서머(EDT, UTC-4): 뉴욕 20:00 → KST 다음날 09:00
//   - 겨울(EST, UTC-5): 뉴욕 20:00 → KST 다음날 10:00
//   즉 뉴욕 20:00 하나만 앵커로 잡으면 나머지 세션 시각은 상대 오프셋으로 전부 계산됩니다.
// =============================================================================

import { DateTime } from "luxon";
import { getHolidayInfo, isUsTradingDay } from "./holidays";

/** 세션 종류 */
export type Session = "day" | "pre" | "regular" | "after" | "closed";

// -----------------------------------------------------------------------------
// 세션 오프셋 표 (데이마켓 개장 시각을 0으로 놓았을 때, 단위: 시간)
// -----------------------------------------------------------------------------
// 설계서 M0 시간표(KST)를 "개장 기준 상대 시간"으로 바꾼 것입니다.
// 이렇게 하면 서머/겨울에 상관없이 하나의 표로 모든 세션을 판정할 수 있습니다.
//
//   데이마켓 : 개장 +0h   ~ +8h      (예: 서머 09:00~17:00)
//   프리마켓 : 개장 +8h   ~ +13.5h   (예: 서머 17:00~22:30)
//   정규장   : 개장 +13.5h~ +20h     (예: 서머 22:30~다음날 05:00)
//   애프터   : 개장 +20h  ~ +23h50m  (예: 서머 05:00~08:50)
//   그 외    : closed
//
// [왜 KST는 오프셋을 그냥 더해도 되나?]
//   KST에는 서머타임이 없어 하루가 항상 24시간입니다. 그래서 개장(KST)에
//   시간을 더하면 벽시계 시각이 어긋나지 않습니다. (개장 앵커만 정확하면 끝)
const DAY_OPEN_HOURS = 8; // 데이마켓은 개장 후 8시간 동안 열림
const PRE_END_HOURS = 13.5; // 프리마켓 종료(개장 +13.5h)
const REGULAR_END_HOURS = 20; // 정규장 종료(개장 +20h = 다음날 05:00 서머)
const AFTER_END_HOURS = 23 + 50 / 60; // 애프터 종료(개장 +23h50m = 08:50 서머)

// [v0.8.4] 조기폐장일(추수감사절 다음날·크리스마스 이브 등)은 정규장이 뉴욕 13:00에 끝난다.
//   개장 앵커(뉴욕 전날 20:00) 기준으로 13:00은 +17h, 애프터 마감 17:00은 +21h이다.
const EARLY_REGULAR_END_HOURS = 17; // 조기폐장일 정규장 종료(뉴욕 13:00)
const EARLY_AFTER_END_HOURS = 21; //  조기폐장일 애프터 종료(뉴욕 17:00)

/**
 * getDayMarketOpen — 주어진 시각(d)이 속한 날짜의 "데이마켓 개장 시각"을 KST로 반환.
 *
 * [계산 방식]
 *   1) d를 KST로 본 날짜(예: 2026-07-16)를 꺼낸다.
 *   2) 데이마켓 개장은 그 KST 아침 → 미국 동부로는 "전날 저녁 20:00"이다.
 *   3) 뉴욕 (그 날짜)일 20:00을 만들고 하루를 빼면 "전날 20:00"이 된다.
 *   4) 그걸 KST로 변환하면, 서머타임 여부에 따라 09:00 또는 10:00이 자동으로 나온다.
 *
 * [왜 이렇게까지?]
 *   "여름이면 9시, 겨울이면 10시" 같은 하드코딩을 피하기 위해서입니다.
 *   luxon이 뉴욕→KST 변환을 하면서 그 날짜의 DST 여부를 스스로 반영합니다.
 */
export function getDayMarketOpen(d: DateTime): DateTime {
  const kst = d.setZone("Asia/Seoul");

  // 뉴욕 시각으로 "(KST 날짜)일 20:00"을 만든 뒤 하루를 빼 "전날 20:00"으로.
  const nyPrevEvening = DateTime.fromObject(
    { year: kst.year, month: kst.month, day: kst.day, hour: 20, minute: 0, second: 0, millisecond: 0 },
    { zone: "America/New_York" },
  ).minus({ days: 1 });

  // 이 뉴욕 20:00을 KST로 변환 → 서머면 09:00, 겨울이면 10:00이 자동으로 나온다.
  return nyPrevEvening.setZone("Asia/Seoul");

  // [참고] 이 함수는 "그날 장이 열린다면 몇 시인가"만 계산한다.
  //        실제 개장 여부(주말·공휴일)는 lib/holidays.ts 가 판정하고,
  //        getSession/getMarketStatus 가 그 결과를 반영한다. [v0.8.4]
}

/** getScanTime — 종목 탐색(스캔) 시각 = 개장 +30분 */
export function getScanTime(d: DateTime): DateTime {
  return getDayMarketOpen(d).plus({ minutes: 30 });
}

/** getFirstOrderTime — 1차 주문 시각 = 개장 +90분 */
export function getFirstOrderTime(d: DateTime): DateTime {
  return getDayMarketOpen(d).plus({ minutes: 90 });
}

/** getSecondOrderTime — 2차 주문 시각 = 개장 +120분 */
export function getSecondOrderTime(d: DateTime): DateTime {
  return getDayMarketOpen(d).plus({ minutes: 120 });
}

/**
 * getCloseDeadline — 청산 시작 데드라인 = 데이마켓 마감 15분 전.
 *   데이마켓 마감 = 개장 +8시간. 그 15분 전부터 보유 물량을 정리하기 시작합니다.
 *
 * [왜 15분 전인가?]
 *   마감에 임박해서 팔면 못 팔고 다음 세션으로 넘어갈 위험이 큽니다.
 *   미리 청산을 시작해 마감 전에 확실히 정리하려는 안전장치입니다.
 */
export function getCloseDeadline(d: DateTime): DateTime {
  return getDayMarketOpen(d).plus({ hours: DAY_OPEN_HOURS }).minus({ minutes: 15 });
}

/**
 * isOrderFrozen — 지금(now)이 "정정·취소 불가" 구간인지 판정. (설계서 M0-A)
 *
 *   데이마켓 마감 1분 전부터 마감까지는 주문을 고치거나 취소할 수 없습니다.
 *   심지어 킬스위치(비상정지)도 이 구간에는 먹지 않습니다.
 *
 * [왜 중요한가?]
 *   봇이 "취소하면 되겠지" 하고 이 구간에 주문을 걸면, 취소가 막혀
 *   원치 않는 체결이 그대로 일어납니다. 이 구간을 피해서 주문/취소해야 합니다.
 */
export function isOrderFrozen(now: DateTime): boolean {
  const kst = now.setZone("Asia/Seoul");
  const close = getDayMarketOpen(kst).plus({ hours: DAY_OPEN_HOURS });
  const frozenStart = close.minus({ minutes: 1 });
  // [마감 1분 전, 마감) 구간이면 true.
  return kst >= frozenStart && kst < close;

  // TODO(S2): 마감 10분 전 신규 주문은 "예약"으로 전환되어 다음 세션에서 체결된다.
  //           또한 미체결 주문은 다음 세션으로 자동 이월되므로, 봇이 명시적으로
  //           취소해야 한다(토스의 자동취소에 의존하지 말 것). 이 정책들은
  //           실주문 어댑터(S2)에서 주문 상태 관리 로직으로 구현한다.
}

/**
 * tradingDateOf — 개장 앵커(open)가 속한 "미국 거래일 날짜"를 돌려준다(내부용).
 *
 * [왜 필요한가?] 휴장일 판정은 반드시 '미국 날짜'로 해야 한다.
 *   데이마켓 개장(뉴욕 전날 20:00)부터 애프터 마감까지 한 덩어리(한 사이클)는
 *   **정규장이 열리는 그 미국 날짜** 하나에 속한다. 그리고 그 날짜는 계산해 보면
 *   개장 앵커를 KST로 봤을 때의 날짜와 같다(개장 = KST 그날 아침 9시/10시).
 *   예) KST 8/13 09:00 개장 → 뉴욕 8/12 20:00 → 정규장은 뉴욕 8/13 09:30 → 거래일 = 8/13.
 */
function tradingDateOf(open: DateTime): DateTime {
  const kst = open.setZone("Asia/Seoul");
  return DateTime.fromObject({ year: kst.year, month: kst.month, day: kst.day }, { zone: "America/New_York" });
}

/**
 * classifyByOffset — 특정 개장 앵커(open)를 기준으로 now가 어느 세션인지 판정(내부용).
 *   open으로부터 now까지 몇 시간 흘렀는지(offset)를 계산해 세션 표에 대입합니다.
 *   now가 open보다 이르거나(offset<0) 하루를 넘겼으면 이 앵커로는 'closed'.
 *
 * @param early 조기폐장일(오후 1시 마감)이면 true → 정규장·애프터 끝이 앞당겨진다.
 */
function classifyByOffset(now: DateTime, open: DateTime, early = false): Session {
  const offset = now.diff(open, "hours").hours; // 개장 이후 흐른 시간(시간 단위, 소수 가능)
  const regularEnd = early ? EARLY_REGULAR_END_HOURS : REGULAR_END_HOURS;
  const afterEnd = early ? EARLY_AFTER_END_HOURS : AFTER_END_HOURS;

  if (offset < 0) return "closed"; // 아직 개장 전(이 앵커 기준)
  if (offset < DAY_OPEN_HOURS) return "day"; //     +0h ~ +8h
  if (offset < PRE_END_HOURS) return "pre"; //      +8h ~ +13.5h
  if (offset < regularEnd) return "regular"; //     +13.5h ~ +20h(조기폐장 +17h)
  if (offset < afterEnd) return "after"; //         ~ +23h50m(조기폐장 +21h)
  return "closed"; //                               그 이후(다음 개장 전)
}

/**
 * getSession — 지금(now)이 어떤 세션인지 반환.
 *
 * [왜 개장 앵커를 2개(오늘/어제) 보나?]
 *   정규장·애프터는 KST 자정을 넘겨 새벽까지 이어집니다.
 *   예) KST 새벽 3시는 "어제 개장한 데이마켓의 정규장"입니다.
 *   그래서 오늘 개장과 어제 개장을 모두 후보로 놓고, now가 실제로 걸리는
 *   세션을 찾습니다. 어느 앵커에서도 'closed'면 최종 'closed'입니다.
 *
 * [v0.8.4] 주말·미국 공휴일이면 시각과 무관하게 'closed'.
 *   그 앵커가 속한 미국 거래일이 휴장이면 아예 후보에서 제외합니다.
 */
export function getSession(now: DateTime): Session {
  return getMarketStatus(now).session;
}

/**
 * [v0.6.0] getSessionStart — 지금(now)이 속한 "현재 활성 장(場)의 시작 시각"을 반환한다.
 *   스크리너의 "장 시작 이후 최고점" 추적 기준으로 쓴다. 장이 닫혀 있으면 null.
 *
 *   세션 시작 오프셋(개장 기준): 데이 +0h · 프리 +8h · 정규장 +13.5h · 애프터 +20h.
 *   getSession과 같은 앵커(오늘/어제 개장)를 보고, now가 걸린 세션의 '시작점'을 돌려준다.
 *   [v0.8.4] 휴장일(주말·공휴일) 앵커는 건너뛴다.
 */
export function getSessionStart(now: DateTime): DateTime | null {
  const kst = now.setZone("Asia/Seoul");

  for (const open of [getDayMarketOpen(kst), getDayMarketOpen(kst.minus({ days: 1 }))]) {
    const info = getHolidayInfo(tradingDateOf(open));
    if (info.closed) continue; // 휴장일 사이클은 통째로 제외
    const early = info.earlyClose !== null;
    const s = classifyByOffset(kst, open, early);
    if (s === "closed") continue;
    if (s === "day") return open; //                                    데이 시작 = 개장
    if (s === "pre") return open.plus({ hours: DAY_OPEN_HOURS }); //     프리 시작 = 개장+8h
    if (s === "regular") return open.plus({ hours: PRE_END_HOURS }); //  정규장 시작 = 개장+13.5h
    return open.plus({ hours: early ? EARLY_REGULAR_END_HOURS : REGULAR_END_HOURS }); // 애프터 시작
  }
  return null; // 어느 앵커에서도 세션에 안 걸림 = 장 닫힘
}

/** [v0.8.4] 지금 장 상태 한 묶음 — 화면 배지·안내 문구에 쓴다. */
export interface MarketStatus {
  /** 지금 세션(휴장이면 "closed") */
  session: Session;
  /** 이 사이클이 속한 미국 거래일(yyyy-MM-dd, 뉴욕 기준). 휴장이면 가장 가까운 후보 날짜 */
  tradingDate: string;
  /** 닫혀 있는 이유(예: "주말(일요일)", "추수감사절", "장 시간 아님"). 열려 있으면 null */
  closedReason: string | null;
  /** 오늘이 조기폐장일이면 그 이름(예: "크리스마스 이브"), 아니면 null */
  earlyClose: string | null;
  /** 다음 데이마켓 개장 시각(KST). 못 찾으면 null(정상적으로는 항상 찾음) */
  nextOpen: DateTime | null;
}

/**
 * getMarketStatus — "지금 장이 열렸나? 아니면 왜 닫혔나? 다음엔 언제 열리나?"를 한 번에.
 *
 * [왜 만들었나?]
 *   예전에는 getSession이 시각만 보고 판정해서 **일요일 새벽에도 "데이마켓"**이라고 떴습니다.
 *   사람이 그걸 믿고 종목을 준비하거나(헛수고), 세션별 시드 비율이 엉뚱하게 적용됐습니다.
 *   이제는 휴장이면 그 이유(주말/공휴일 이름)와 다음 개장 시각까지 알려 줍니다.
 */
export function getMarketStatus(now: DateTime): MarketStatus {
  const kst = now.setZone("Asia/Seoul");
  const anchors = [getDayMarketOpen(kst), getDayMarketOpen(kst.minus({ days: 1 }))];

  // 1) 열려 있는 사이클이 있는지 먼저 찾는다(오늘 개장 → 어제 개장 순).
  for (const open of anchors) {
    const info = getHolidayInfo(tradingDateOf(open));
    if (info.closed) continue;
    const s = classifyByOffset(kst, open, info.earlyClose !== null);
    if (s !== "closed") {
      return {
        session: s,
        tradingDate: tradingDateOf(open).toFormat("yyyy-MM-dd"),
        closedReason: null,
        earlyClose: info.earlyClose,
        nextOpen: findNextOpen(kst),
      };
    }
  }

  // 2) 닫혀 있다 → 이유를 설명한다.
  //    "지금 시각이 어느 사이클에 걸리기는 하는데 그 날이 휴장"이면 그 이름을,
  //    아니면 단순히 장 시간이 아닌 것(예: KST 오후 = 미국 새벽)이다.
  let reason = "장 시간 아님";
  let tradingDate = tradingDateOf(anchors[0]).toFormat("yyyy-MM-dd");
  for (const open of anchors) {
    const info = getHolidayInfo(tradingDateOf(open));
    // 이 앵커가 '열렸다면' 지금이 세션 구간이었을 경우에만 휴장 사유로 채택한다.
    if (info.closed && classifyByOffset(kst, open, false) !== "closed") {
      reason = info.closed;
      tradingDate = tradingDateOf(open).toFormat("yyyy-MM-dd");
      break;
    }
  }

  return { session: "closed", tradingDate, closedReason: reason, earlyClose: null, nextOpen: findNextOpen(kst) };
}

/**
 * [v0.44.0] isInDailyPauseWindow — 지금(now)이 오너가 지정한 "매일 반복되는 휴무 시간대"
 *   (KST, 예: 05:00~17:00)에 들어 있는지만 순수하게 판정한다(휴장일·세션과 무관 — 그냥 시계
 *   기준 매일 구간).
 *
 * [왜 필요한가 — 오너 결정]
 *   05:00~17:00 KST는 정확히 "애프터마켓(05:00~08:50 서머) + 데이마켓(09:00~17:00)"을
 *   덮는다. 반대로 재개 시각 17:00은 프리마켓 시작과 정확히 일치한다. 즉 오너는 시세가
 *   토스 자체 합성(indicative)인 데이마켓 구간은 완전히 피하고, 실제 미국 정규장 유동성이
 *   걸리는 프리마켓~정규장(오버나이트, KST 17:00~다음날 05:00)에만 거래하기로 결정했다
 *   (수동 도구까지 포함 — 유혹을 원천 차단하려는 의도로 이해된다).
 *
 * @param startHour, endHour  KST 0~23시. startHour < endHour면 당일 구간(예 5~17),
 *   startHour > endHour면 자정을 넘기는 구간(예 22~6)도 지원(향후 다른 값으로 바뀌어도
 *   안전하게 동작하도록).
 */
export function isInDailyPauseWindow(now: DateTime, startHour: number, endHour: number): boolean {
  const kst = now.setZone("Asia/Seoul");
  const h = kst.hour + kst.minute / 60 + kst.second / 3600;
  if (startHour === endHour) return false; // 구간 길이 0 = 휴무 없음(설정 실수 방어)
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour; // 자정을 넘기는 구간
}

/**
 * findNextOpen — 지금 이후 가장 가까운 "데이마켓 개장 시각"(KST). 휴장일은 건너뛴다.
 *   최대 10일까지만 앞을 본다(연휴가 아무리 길어도 그 안에는 열린다).
 */
export function findNextOpen(now: DateTime): DateTime | null {
  const kst = now.setZone("Asia/Seoul");
  for (let i = 0; i <= 10; i++) {
    const open = getDayMarketOpen(kst.plus({ days: i }));
    if (open <= kst) continue; //                       이미 지난 개장은 건너뛴다
    if (!isUsTradingDay(tradingDateOf(open))) continue; // 휴장일은 건너뛴다
    return open;
  }
  return null;
}
