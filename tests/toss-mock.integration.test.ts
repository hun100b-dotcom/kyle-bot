// =============================================================================
// tests/toss-mock.integration.test.ts  —  어댑터 ↔ 목 서버 통합 리허설
// -----------------------------------------------------------------------------
// 목 서버가 "실제 토스 스펙 형태"({result} 래핑, 문자열 숫자, 대문자 상태)로 응답하고,
// 어댑터가 그것을 우리 내부 표준(가격 number, 상태 소문자)으로 잘 "번역"하는지까지
// 실제 HTTP 왕복으로 검증합니다.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createMockTossServer } from "../mocks/toss-mock";
import {
  getPrice,
  createOrder,
  getOrder,
  cancelOrder,
  listOrders,
  preflightBuyCheck,
  makeClientOrderId,
  clearTokenCache,
} from "../lib/toss";
import { calcSplit3 } from "../lib/calc";

let mock: ReturnType<typeof createMockTossServer>;

beforeAll(async () => {
  mock = createMockTossServer();
  const port = await mock.listen();
  process.env.TOSS_MOCK = "true";
  process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TOSS_ACCOUNT = "1"; // accountSeq
});

afterAll(async () => {
  await mock.close();
  delete process.env.TOSS_MOCK;
  delete process.env.TOSS_BASE_URL;
  delete process.env.TOSS_ACCOUNT;
  delete process.env.TOSS_TIMEOUT_MS;
});

beforeEach(() => {
  clearTokenCache();
  mock.setPrice("AAPL", 2.05);
});

describe("① 토큰 발급 → 캐싱 → 재발급 + 응답 번역", () => {
  it("처음엔 발급, 두 번째는 캐시 재사용, 캐시 비우면 재발급", async () => {
    const before = mock.state.tokenIssueCount;

    clearTokenCache();
    await getPrice("AAPL");
    const after1 = mock.state.tokenIssueCount;
    expect(after1).toBe(before + 1);

    await getPrice("AAPL"); // 캐시 재사용
    expect(mock.state.tokenIssueCount).toBe(after1);

    clearTokenCache();
    await getPrice("AAPL"); // 재발급
    expect(mock.state.tokenIssueCount).toBe(after1 + 1);
  });

  it("실제 스펙의 문자열 가격(lastPrice)을 number로 번역해 돌려준다", async () => {
    const p = await getPrice("AAPL");
    expect(p.price).toBe(2.05); // "2.05"(문자열) → 2.05(숫자)
    expect(typeof p.price).toBe("number");
    expect(p.currency).toBe("USD");
  });
});

describe("② 삼분할 진입 3개 생성 → 하나만 체결(first_only)", () => {
  it("현재가 2.05에서 1분할(2.11)만 체결, 2·3분할은 미체결 → 나머지 취소", async () => {
    const sessionId = "split3aa-1111-2222-3333-444455556666";
    const { splits } = calcSplit3(2.2, 1.93, 2, 10);

    // 실제 스펙: 생성 응답에는 orderId만 있고 상태는 없다 → 단건 조회로 확인.
    const created = [];
    for (const s of splits) {
      created.push(
        await createOrder({
          symbol: "AAPL",
          side: "BUY",
          orderType: "LIMIT",
          price: s.entry,
          quantity: 10,
          clientOrderId: makeClientOrderId(sessionId, s.level, "entry"),
        }),
      );
    }

    const statuses = [];
    for (const c of created) statuses.push((await getOrder(c.tossOrderId)).status);
    expect(statuses[0]).toBe("filled"); //   1분할 2.11: 2.05<=2.11 체결
    expect(statuses[1]).toBe("submitted"); // 2분할 2.02: 미체결
    expect(statuses[2]).toBe("submitted"); // 3분할 1.93: 미체결

    // first_only: 1분할 체결 확인 → 나머지 취소.
    expect((await cancelOrder(created[1].tossOrderId)).status).toBe("cancelled");
    expect((await cancelOrder(created[2].tossOrderId)).status).toBe("cancelled");
  });
});

describe("③ 부분 체결 → filled_qty 누적", () => {
  it("첫 조회는 절반(partial), 두 번째 조회에 전량(filled)으로 누적", async () => {
    const created = await createOrder({
      symbol: "PARTIAL",
      side: "BUY",
      orderType: "LIMIT",
      price: 2.1,
      quantity: 10,
      clientOrderId: makeClientOrderId("partialx-aaaa-bbbb", 1, "entry"),
    });

    const first = await getOrder(created.tossOrderId); // 1회차 조회
    expect(first.status).toBe("partial"); // PARTIAL_FILLED → partial 번역
    expect(first.filled_qty).toBe(5);

    const second = await getOrder(created.tossOrderId); // 2회차 조회 → 나머지 체결
    expect(second.status).toBe("filled");
    expect(second.filled_qty).toBe(10);
  });
});

describe("④ 멱등키 중복 요청 → 이중 주문 안 됨", () => {
  it("같은 clientOrderId로 두 번 보내도 주문은 하나만 생긴다", async () => {
    const clientOrderId = makeClientOrderId("idemxxxx-cccc-dddd", 1, "entry");
    const req = {
      symbol: "AAPL",
      side: "BUY" as const,
      orderType: "LIMIT" as const,
      price: 2.11,
      quantity: 10,
      clientOrderId,
    };

    const first = await createOrder(req);
    const second = await createOrder(req); // 재시도(같은 멱등키)
    expect(second.tossOrderId).toBe(first.tossOrderId); // 같은 주문 반환

    const list = await listOrders({ status: "ALL" });
    expect(list.orders.filter((o) => o.clientOrderId === clientOrderId)).toHaveLength(1);
  });
});

describe("⑤ 주문 취소 경로 (실제 스펙: POST /orders/{id}/cancel)", () => {
  it("미체결 주문(2.02)을 취소하면 상태가 cancelled", async () => {
    const created = await createOrder({
      symbol: "AAPL",
      side: "BUY",
      orderType: "LIMIT",
      price: 2.02, // 현재가 2.05보다 낮아 미체결
      quantity: 10,
      clientOrderId: makeClientOrderId("cancelxx-eeee-ffff", 2, "entry"),
    });
    expect((await getOrder(created.tossOrderId)).status).toBe("submitted");
    expect((await cancelOrder(created.tossOrderId)).status).toBe("cancelled");
  });
});

describe("⑥ 거부/타임아웃 시 어댑터가 안전하게 에러 처리", () => {
  it("잔고 부족(REJECT 심볼)은 에러로 던져진다", async () => {
    await expect(
      createOrder({
        symbol: "REJECT",
        side: "BUY",
        orderType: "LIMIT",
        price: 2.05,
        quantity: 10,
        clientOrderId: makeClientOrderId("rejectxx-0000-1111", 1, "entry"),
      }),
    ).rejects.toThrow(/402/);
  });

  it("응답이 늦으면(SLOW 심볼) 타임아웃 에러로 끊는다", async () => {
    process.env.TOSS_TIMEOUT_MS = "200";
    await expect(getPrice("SLOW")).rejects.toThrow(/타임아웃/);
    delete process.env.TOSS_TIMEOUT_MS;
  });
});

describe("⑦ 주문 전 사전검증(preflightBuyCheck)", () => {
  it("매수가능금액(currency=USD, 계좌헤더)으로 최대 수량을 계산한다", async () => {
    // 매수가능금액 10000(문자열 "10000" → 번역), 수수료 0(TODO: 실제 요율 파싱), 가격 2.05
    // 10000 / 2.05 = 4878.04… → floor 4878
    const pf = await preflightBuyCheck(2.05);
    expect(pf.buyingPowerUsd).toBe(10000);
    expect(pf.commissionRate).toBe(0);
    expect(pf.maxQty).toBe(4878);
  });
});
