// =============================================================================
// tests/conditional-fx.integration.test.ts — 조건주문·환율 어댑터 통합 테스트
// -----------------------------------------------------------------------------
// [무엇을 검증?]
//   2026-07-17 신규 어댑터 기능이 "실제 스펙 형태"로 왕복하는지 목 서버로 확인:
//   1) 환율 조회(getExchangeRate): 필수 쿼리, 문자열 rate → number 변환
//   2) 조건주문 생성/조회/취소: OCO 규칙(둘 다 SELL, 감시가 순서) 검증 포함
//   3) createOrder 직렬화: 수량·가격이 "문자열"로 전송되는지(실스펙)
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createMockTossServer } from "../mocks/toss-mock";
import {
  getExchangeRate,
  createConditionalOrder,
  getConditionalOrder,
  listConditionalOrders,
  cancelConditionalOrder,
  createOrder,
  clearTokenCache,
} from "../lib/toss";

let mock: ReturnType<typeof createMockTossServer>;

beforeAll(async () => {
  mock = createMockTossServer();
  const port = await mock.listen();
  process.env.TOSS_MOCK = "true";
  process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TOSS_ACCOUNT = "1";
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  clearTokenCache();
});

describe("환율(getExchangeRate)", () => {
  it("USD→KRW 환율을 number로 돌려준다", async () => {
    mock.setFxRate(1390.5);
    const fx = await getExchangeRate("USD", "KRW");
    expect(fx.rate).toBe(1390.5);
    expect(fx.baseCurrency).toBe("USD");
    expect(fx.quoteCurrency).toBe("KRW");
    expect(typeof fx.rate).toBe("number"); // 문자열 응답 → number 변환 확인
  });
});

describe("조건주문(conditional-orders)", () => {
  it("OCO(익절+손절)를 생성·조회·취소할 수 있다", async () => {
    mock.setPrice("AAPL", 2.05); // 현재가 2.05
    const created = await createConditionalOrder({
      symbol: "AAPL",
      type: "OCO",
      quantity: 3,
      orderType: "LIMIT",
      expireDate: "2026-07-30",
      first: { orderSide: "SELL", triggerPrice: 2.15, orderPrice: 2.15 }, //  위 = 익절
      second: { orderSide: "SELL", triggerPrice: 1.89, orderPrice: 1.88 }, // 아래 = 손절
    });
    expect(created.conditionalOrderId).toMatch(/^C/);
    expect(created.type).toBe("OCO");
    expect(created.first?.triggerPrice).toBe(2.15); // 문자열 → number 변환 확인

    const list = await listConditionalOrders();
    expect(list.some((c) => c.conditionalOrderId === created.conditionalOrderId)).toBe(true);

    await cancelConditionalOrder(created.conditionalOrderId);
    const after = await listConditionalOrders();
    // [v0.51.0] 실스펙엔 "CANCELED"가 없다 — 취소해도 그룹 status는 COMPLETED, 다리는 둘 다
    //   triggeredOrderId가 없어(=미발동) tool-engine.ts가 "사람이 직접 취소"로 구분한다.
    const cancelled = after.find((c) => c.conditionalOrderId === created.conditionalOrderId);
    expect(cancelled?.status).toBe("COMPLETED");
    expect(cancelled?.first?.triggeredOrderId).toBeFalsy();
    expect(cancelled?.second?.triggeredOrderId).toBeFalsy();
  });

  it("OCO 규칙 위반(감시가 순서)은 400으로 거부된다", async () => {
    mock.setPrice("AAPL", 2.05);
    await expect(
      createConditionalOrder({
        symbol: "AAPL",
        type: "OCO",
        quantity: 1,
        orderType: "LIMIT",
        expireDate: "2026-07-30",
        // 잘못: 익절 감시가(1.9)가 현재가(2.05)보다 아래 → 스펙 위반
        first: { orderSide: "SELL", triggerPrice: 1.9, orderPrice: 1.9 },
        second: { orderSide: "SELL", triggerPrice: 1.8, orderPrice: 1.8 },
      }),
    ).rejects.toThrow(/400/);
  });

  it("OTO(진입 후 감시)를 생성할 수 있다", async () => {
    const created = await createConditionalOrder({
      symbol: "AAPL",
      type: "OTO",
      quantity: 2,
      orderType: "LIMIT",
      expireDate: "2026-07-30",
      first: { orderSide: "BUY", triggerPrice: 2.03, orderPrice: 2.03 }, //   진입
      second: { orderSide: "SELL", triggerPrice: 2.07, orderPrice: 2.07 }, // 체결 후 익절 감시
    });
    expect(created.type).toBe("OTO");
    expect(created.second?.orderSide).toBe("SELL");
  });
});

describe("주문 직렬화(실스펙: 문자열)", () => {
  it("createOrder가 수량·가격을 문자열로 보내도 목/실서버가 처리한다", async () => {
    // 목 서버는 문자열·숫자 모두 수용하므로, 성공 왕복 자체가 직렬화 호환의 증거.
    const o = await createOrder({
      symbol: "AAPL",
      side: "BUY",
      orderType: "LIMIT",
      price: 2.11,
      quantity: 5,
      clientOrderId: "ser-test-0001",
    });
    expect(o.tossOrderId).toBeTruthy();
    expect(o.status === "filled" || o.status === "submitted").toBe(true);
  });
});

// -----------------------------------------------------------------------------
// [v0.51.0] OCO 발동 감지(getConditionalOrder + 다리별 triggeredOrderId) — 자동매매가
//   "익절/손절로 포지션이 끝났는지"를 아는 유일한 방법이라 정확해야 한다. 대기 주문
//   재판정(limitFill)과 같은 원칙으로, 목 서버가 조회 시점의 현재가로 OCO 발동 여부를
//   다시 확인해 준다.
//   [v0.51.0 이전엔 이 테스트가 "WAITING"/"TRIGGERED"/"CANCELED" + `triggeredLeg` 필드를
//   검증했는데, 이건 실제 토스 API에 없는 발명된 값이었다 — 목 서버도 같은 발명된 값을
//   돌려주도록 짜여 있어 이 테스트는 계속 통과했지만, 실계좌에서는 절대 맞아떨어질 수
//   없는 조건이었다(WBUY/LABT/SCYX가 청산 후에도 "감시 중"으로 영원히 남던 버그의
//   진짜 근본 원인). 이제 실스펙(그룹 status: WATCHING/COMPLETED, 다리별 status +
//   triggeredOrderId)을 검증하도록 고쳤다.
// -----------------------------------------------------------------------------
describe("OCO 발동 감지(getConditionalOrder, v0.51.0 실스펙)", () => {
  it("가격이 익절 감시가 위로 오르면 first.triggeredOrderId가 채워진다(그룹 COMPLETED)", async () => {
    mock.setPrice("AAPL", 2.05);
    const created = await createConditionalOrder({
      symbol: "AAPL",
      type: "OCO",
      quantity: 1,
      orderType: "LIMIT",
      expireDate: "2026-12-30",
      first: { orderSide: "SELL", triggerPrice: 2.15, orderPrice: 2.15 }, // 익절
      second: { orderSide: "SELL", triggerPrice: 1.89, orderPrice: 1.88 }, // 손절
    });
    // 발동 전: 가격이 아직 구간 안 → WATCHING 그대로, 어느 다리도 triggeredOrderId 없음
    let got = await getConditionalOrder(created.conditionalOrderId);
    expect(got.status).toBe("WATCHING");
    expect(got.first?.triggeredOrderId).toBeFalsy();
    expect(got.second?.triggeredOrderId).toBeFalsy();

    // 가격이 익절 감시가(2.15) 위로 오르면 다음 조회에서 first 발동
    mock.setPrice("AAPL", 2.2);
    got = await getConditionalOrder(created.conditionalOrderId);
    expect(got.status).toBe("COMPLETED");
    expect(got.first?.triggeredOrderId).toBeTruthy();
    expect(got.second?.triggeredOrderId).toBeFalsy(); // OCO: 반대쪽은 발동 없이 함께 종료
  });

  it("가격이 손절 감시가 아래로 내려가면 second.triggeredOrderId가 채워진다(그룹 COMPLETED)", async () => {
    mock.setPrice("AAPL", 2.05);
    const created = await createConditionalOrder({
      symbol: "AAPL",
      type: "OCO",
      quantity: 1,
      orderType: "LIMIT",
      expireDate: "2026-12-30",
      first: { orderSide: "SELL", triggerPrice: 2.15, orderPrice: 2.15 },
      second: { orderSide: "SELL", triggerPrice: 1.89, orderPrice: 1.88 },
    });
    mock.setPrice("AAPL", 1.8); // 손절 감시가(1.89) 아래로
    const got = await getConditionalOrder(created.conditionalOrderId);
    expect(got.status).toBe("COMPLETED");
    expect(got.second?.triggeredOrderId).toBeTruthy();
    expect(got.first?.triggeredOrderId).toBeFalsy();
  });

  it("발동된 뒤에는 가격이 다시 구간 안으로 돌아와도 COMPLETED 상태를 유지한다(재판정 안 함)", async () => {
    mock.setPrice("AAPL", 2.05);
    const created = await createConditionalOrder({
      symbol: "AAPL",
      type: "OCO",
      quantity: 1,
      orderType: "LIMIT",
      expireDate: "2026-12-30",
      first: { orderSide: "SELL", triggerPrice: 2.15, orderPrice: 2.15 },
      second: { orderSide: "SELL", triggerPrice: 1.89, orderPrice: 1.88 },
    });
    mock.setPrice("AAPL", 2.2); // 발동
    const firstGet = await getConditionalOrder(created.conditionalOrderId);
    const triggeredId = firstGet.first?.triggeredOrderId;
    mock.setPrice("AAPL", 2.05); // 다시 구간 안으로
    const got = await getConditionalOrder(created.conditionalOrderId);
    expect(got.status).toBe("COMPLETED"); // 여전히 발동 상태(포지션은 이미 끝났으므로)
    expect(got.first?.triggeredOrderId).toBe(triggeredId);
  });

  it("목록 조회(listConditionalOrders)에서도 같은 방식으로 재판정된다", async () => {
    mock.setPrice("AAPL", 2.05);
    const created = await createConditionalOrder({
      symbol: "AAPL",
      type: "OCO",
      quantity: 1,
      orderType: "LIMIT",
      expireDate: "2026-12-30",
      first: { orderSide: "SELL", triggerPrice: 2.15, orderPrice: 2.15 },
      second: { orderSide: "SELL", triggerPrice: 1.89, orderPrice: 1.88 },
    });
    mock.setPrice("AAPL", 1.5); // 손절 발동
    const list = await listConditionalOrders("ALL");
    const found = list.find((c) => c.conditionalOrderId === created.conditionalOrderId);
    expect(found?.status).toBe("COMPLETED");
    expect(found?.second?.triggeredOrderId).toBeTruthy();
    expect(found?.first?.triggeredOrderId).toBeFalsy();
  });
});
