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

  // TODO(S2): 주말/미국 휴장일(공휴일)에는 장이 열리지 않는다.
  //           이 함수는 "그날 장이 열린다면 몇 시인가"만 계산한다.
  //           실제 개장 여부는 별도의 휴장일 캘린더로 판정해야 한다.
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
 * classifyByOffset — 특정 개장 앵커(open)를 기준으로 now가 어느 세션인지 판정(내부용).
 *   open으로부터 now까지 몇 시간 흘렀는지(offset)를 계산해 세션 표에 대입합니다.
 *   now가 open보다 이르거나(offset<0) 하루를 넘겼으면 이 앵커로는 'closed'.
 */
function classifyByOffset(now: DateTime, open: DateTime): Session {
  const offset = now.diff(open, "hours").hours; // 개장 이후 흐른 시간(시간 단위, 소수 가능)

  if (offset < 0) return "closed"; // 아직 개장 전(이 앵커 기준)
  if (offset < DAY_OPEN_HOURS) return "day"; //     +0h ~ +8h
  if (offset < PRE_END_HOURS) return "pre"; //      +8h ~ +13.5h
  if (offset < REGULAR_END_HOURS) return "regular"; // +13.5h ~ +20h
  if (offset < AFTER_END_HOURS) return "after"; //  +20h ~ +23h50m
  return "closed"; //                               +23h50m 이후(다음 개장 전)
}

/**
 * getSession — 지금(now)이 어떤 세션인지 반환.
 *
 * [왜 개장 앵커를 2개(오늘/어제) 보나?]
 *   정규장·애프터는 KST 자정을 넘겨 새벽까지 이어집니다.
 *   예) KST 새벽 3시는 "어제 개장한 데이마켓의 정규장"입니다.
 *   그래서 오늘 개장과 어제 개장을 모두 후보로 놓고, now가 실제로 걸리는
 *   세션을 찾습니다. 어느 앵커에서도 'closed'면 최종 'closed'입니다.
 */
export function getSession(now: DateTime): Session {
  const kst = now.setZone("Asia/Seoul");

  const todayOpen = getDayMarketOpen(kst);
  const yesterdayOpen = getDayMarketOpen(kst.minus({ days: 1 }));

  for (const open of [todayOpen, yesterdayOpen]) {
    const s = classifyByOffset(kst, open);
    if (s !== "closed") return s;
  }
  return "closed";

  // TODO(S2): 주말·미국 휴장일에는 실제로 장이 안 열린다. 이 함수는 시각만으로
  //           세션 구간을 판정하므로, 휴장일이면 'closed'로 덮어쓰는 캘린더 검사를
  //           앞단에 추가해야 한다. (겨울 상대시각/애프터 매매 여부도 S2에서 확정)
}
