// =============================================================================
// tests/toss-mock.integration.test.ts  —  어댑터 ↔ 목 서버 통합 리허설 (설계서 S4)
// -----------------------------------------------------------------------------
// [무엇을 하나?]
//   가짜 토스 서버(mocks/toss-mock.ts)를 실제 포트로 띄우고, 우리 어댑터(lib/toss.ts)가
//   진짜 네트워크로 요청을 주고받게 합니다. "키만 꽂으면 실전으로 바뀌는" 상태인지
//   전체 흐름(토큰→시세→주문→체결→취소)을 실제로 리허설합니다.
//
// [핵심 세팅]
//   TOSS_MOCK=true + TOSS_BASE_URL=목서버주소 로 두면, 어댑터가 실제 키 없이 목 서버를
//   바라봅니다. 서버는 beforeAll에서 켜고 afterAll에서 끕니다.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createMockTossServer } from "../mocks/toss-mock";
import {
  getPrice,
  createOrder,
  cancelOrder,
  getOrder,
  listOrders,
  preflightBuyCheck,
  makeClientOrderId,
  clearTokenCache,
} from "../lib/toss";
import { calcSplit3 } from "../lib/calc";

// 목 서버 핸들
let mock: ReturnType<typeof createMockTossServer>;

beforeAll(async () => {
  mock = createMockTossServer();
  const port = await mock.listen(); // 랜덤 빈 포트로 실제 서버 오픈
  // 어댑터가 목 서버를 바라보게 환경변수 설정.
  process.env.TOSS_MOCK = "true";
  process.env.TOSS_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TOSS_ACCOUNT = "mock-account";
});

afterAll(async () => {
  await mock.close();
  delete process.env.TOSS_MOCK;
  delete process.env.TOSS_BASE_URL;
  delete process.env.TOSS_ACCOUNT;
  delete process.env.TOSS_TIMEOUT_MS;
});

beforeEach(() => {
  clearTokenCache(); // 각 테스트는 토큰 캐시 초기 상태에서 시작
});

describe("① 토큰 발급 → 캐싱 → 재발급", () => {
  it("처음엔 발급, 두 번째는 캐시 재사용, 캐시 비우면 재발급", async () => {
    const before = mock.state.tokenIssueCount;

    clearTokenCache();
    await getPrice("AAPL"); // 토큰 새로 발급됨
    const after1 = mock.state.tokenIssueCount;
    expect(after1).toBe(before + 1); // +1 발급

    await getPrice("AAPL"); // 캐시된 토큰 재사용(발급 안 함)
    expect(mock.state.tokenIssueCount).toBe(after1); // 그대로

    clearTokenCache(); // 만료됐다고 가정하고 캐시 비움
    await getPrice("AAPL"); // 다시 발급
    expect(mock.state.tokenIssueCount).toBe(after1 + 1); // 또 +1
  });
});

describe("② 삼분할 진입 3개 생성 → 하나만 체결(first_only)", () => {
  it("현재가 2.05에서 1분할(2.11)만 체결, 2·3분할은 미체결 → 나머지 취소", async () => {
    const sessionId = "split3aa-1111-2222-3333-444455556666";
    const { splits } = calcSplit3(2.2, 1.93, 2, 10); // 진입가 2.11 / 2.02 / 1.93

    // 삼분할 3개를 각각 독립 주문으로 생성(각 레벨=독립 한 판).
    const results = [];
    for (const s of splits) {
      const clientOrderId = makeClientOrderId(sessionId, s.level, "entry");
      results.push(
        await createOrder({
          symbol: "AAPL",
          side: "BUY",
          orderType: "LIMIT",
          price: s.entry,
          quantity: 10,
          clientOrderId,
        }),
      );
    }

    // 현재가 2.05 → 지정가 2.11(1분할)은 체결, 2.02/1.93은 미체결.
    expect(results[0].status).toBe("filled");
    expect(results[1].status).toBe("submitted");
    expect(results[2].status).toBe("submitted");

    // split_fill_policy=first_only: 1분할 체결을 확인했으니 나머지 2·3분할은 취소.
    const c2 = await cancelOrder(results[1].tossOrderId);
    const c3 = await cancelOrder(results[2].tossOrderId);
    expect(c2.status).toBe("cancelled");
    expect(c3.status).toBe("cancelled");
  });
});

describe("③ 부분 체결 → filled_qty 누적", () => {
  it("처음엔 절반 체결(partial), 다시 조회하면 전량 체결(filled)", async () => {
    const clientOrderId = makeClientOrderId("partialx-aaaa-bbbb", 1, "entry");
    const created = await createOrder({
      symbol: "PARTIAL",
      side: "BUY",
      orderType: "LIMIT",
      price: 2.1,
      quantity: 10,
      clientOrderId,
    });
    expect(created.status).toBe("partial");
    expect(created.filled_qty).toBe(5); // 10주 중 5주 체결

    // 단건 조회 → 남은 5주가 마저 체결되어 누적.
    const polled = await getOrder(created.tossOrderId);
    expect(polled.status).toBe("filled");
    expect(polled.filled_qty).toBe(10);
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
    const second = await createOrder(req); // 재시도 흉내(같은 멱등키)

    expect(second.idempotentHit).toBe(true); // 목 서버가 "기존 주문 반환"이라고 표시
    expect(second.tossOrderId).toBe(first.tossOrderId); // 같은 주문

    // 목록에 이 멱등키 주문은 딱 1건.
    const list = await listOrders();
    const sameId = list.orders.filter((o) => o.clientOrderId === clientOrderId);
    expect(sameId.length).toBe(1);
  });
});

describe("⑤ 주문 취소 경로", () => {
  it("미체결 주문(2.02)을 취소하면 상태가 cancelled", async () => {
    const clientOrderId = makeClientOrderId("cancelxx-eeee-ffff", 2, "entry");
    const created = await createOrder({
      symbol: "AAPL",
      side: "BUY",
      orderType: "LIMIT",
      price: 2.02, // 현재가 2.05보다 낮아 미체결
      quantity: 10,
      clientOrderId,
    });
    expect(created.status).toBe("submitted");

    const cancelled = await cancelOrder(created.tossOrderId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("⑥ 거부/타임아웃 시 어댑터가 안전하게 에러 처리", () => {
  it("잔고 부족(REJECT 심볼)은 에러로 던져진다", async () => {
    const clientOrderId = makeClientOrderId("rejectxx-0000-1111", 1, "entry");
    await expect(
      createOrder({
        symbol: "REJECT",
        side: "BUY",
        orderType: "LIMIT",
        price: 2.05,
        quantity: 10,
        clientOrderId,
      }),
    ).rejects.toThrow(/402/); // HTTP 402 insufficient_funds
  });

  it("응답이 늦으면(SLOW 심볼) 타임아웃 에러로 끊는다", async () => {
    process.env.TOSS_TIMEOUT_MS = "200"; // 200ms 안에 응답 없으면 중단
    await expect(getPrice("SLOW")).rejects.toThrow(/타임아웃/); // 목은 500ms 지연
    delete process.env.TOSS_TIMEOUT_MS;
  });
});

describe("⑦ 주문 전 사전검증(preflightBuyCheck)", () => {
  it("매수가능금액·수수료로 최대 매수 수량을 계산한다", async () => {
    // 매수가능금액 10000, 수수료 0.25%, 가격 2.05
    // 1주 비용 = 2.05 * 1.0025 = 2.0551 → 10000/2.0551 = 4865.9... → floor 4865
    const pf = await preflightBuyCheck(2.05);
    expect(pf.buyingPowerUsd).toBe(10000);
    expect(pf.commissionRate).toBe(0.0025);
    expect(pf.maxQty).toBe(4865);
  });
});
