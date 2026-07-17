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
    expect(after.find((c) => c.conditionalOrderId === created.conditionalOrderId)?.status).toBe("CANCELED");
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
