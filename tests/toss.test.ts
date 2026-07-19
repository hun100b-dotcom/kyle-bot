// =============================================================================
// tests/toss.test.ts  —  토스 어댑터(lib/toss.ts) 순수 로직 검증
// -----------------------------------------------------------------------------
// 키(client secret) 없이도 확인 가능한 것들만 봅니다:
//   - 멱등키 생성 규칙 / 토큰 만료 판정 / 매수 가능 수량 계산
//   - 실제 토스 상태값(대문자) → 내부 표준(소문자) 번역(mapOrderStatus)
//   - 키가 없으면 API 함수가 안전하게 즉시 실패하는지
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  makeClientOrderId,
  isTokenExpired,
  calcMaxBuyQty,
  mapOrderStatus,
  getPrice,
  getAccounts,
  createOrder,
  clearTokenCache,
} from "../lib/toss";

describe("makeClientOrderId (멱등키 생성)", () => {
  const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  it("규칙 `{세션앞8자}-{level}-{role}` 대로 만든다", () => {
    expect(makeClientOrderId(sessionId, 1, "entry")).toBe("a1b2c3d4-1-entry");
    expect(makeClientOrderId(sessionId, 2, "take_profit")).toBe("a1b2c3d4-2-take_profit");
    expect(makeClientOrderId(sessionId, 3, "stop_loss")).toBe("a1b2c3d4-3-stop_loss");
  });

  it("36자 이내 + 영숫자/-/_ 만 사용한다", () => {
    const id = makeClientOrderId(sessionId, 2, "take_profit");
    expect(id.length).toBeLessThanOrEqual(36);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("허용되지 않는 문자는 제거한다", () => {
    const id = makeClientOrderId("ab cd@ef!12345", 1, "entry");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("isTokenExpired (토큰 재발급 타이밍)", () => {
  const MARGIN = 10 * 60 * 1000;

  it("만료까지 20분 남았으면 아직 유효(false)", () => {
    expect(isTokenExpired(20 * 60 * 1000, 0, MARGIN)).toBe(false);
  });
  it("만료 10분 전(마진 경계)에 도달하면 재발급 필요(true)", () => {
    expect(isTokenExpired(20 * 60 * 1000, 10 * 60 * 1000, MARGIN)).toBe(true);
  });
  it("이미 만료 지났으면 재발급 필요(true)", () => {
    expect(isTokenExpired(1000, 5000, MARGIN)).toBe(true);
  });
});

describe("calcMaxBuyQty (매수 가능 수량 사전검증)", () => {
  it("수수료를 포함한 1주 비용으로 최대 수량을 내림 계산", () => {
    expect(calcMaxBuyQty(1000, 2.11, 0.0025)).toBe(472);
  });
  it("가격이 0 이하이면 0을 반환", () => {
    expect(calcMaxBuyQty(1000, 0, 0.0025)).toBe(0);
  });
});

describe("mapOrderStatus (실제 토스 상태 → 내부 표준 번역)", () => {
  it("대문자 상태를 내부 소문자 표준으로 매핑한다", () => {
    expect(mapOrderStatus("PENDING")).toBe("submitted");
    expect(mapOrderStatus("PARTIAL_FILLED")).toBe("partial");
    expect(mapOrderStatus("FILLED")).toBe("filled");
    expect(mapOrderStatus("CANCELED")).toBe("cancelled");
    expect(mapOrderStatus("REJECTED")).toBe("failed");
  });
  it("만료·부분취소는 종료(cancelled) 계열로", () => {
    expect(mapOrderStatus("EXPIRED")).toBe("cancelled");
    expect(mapOrderStatus("PARTIAL_CANCELED")).toBe("cancelled");
  });
  it("모르는 상태는 'unknown'으로 드러낸다(진행 중으로 위장하지 않음)", () => {
    expect(mapOrderStatus("SOMETHING_NEW")).toBe("unknown");
  });
});

describe("키(환경변수)가 없으면 API 함수는 안전하게 즉시 실패한다", () => {
  beforeEach(() => {
    clearTokenCache();
    delete process.env.TOSS_MOCK;
    delete process.env.TOSS_BASE_URL;
    delete process.env.TOSS_CLIENT_ID;
    delete process.env.TOSS_CLIENT_SECRET;
    delete process.env.TOSS_ACCOUNT;
  });

  it("getPrice 는 '환경변수 없음' 에러로 실패", async () => {
    await expect(getPrice("AAPL")).rejects.toThrow(/환경변수/);
  });

  it("getAccounts 는 '환경변수 없음' 에러로 실패", async () => {
    await expect(getAccounts()).rejects.toThrow(/환경변수/);
  });

  it("createOrder 는 '환경변수 없음' 에러로 실패", async () => {
    await expect(
      createOrder({ symbol: "AAPL", side: "BUY", orderType: "LIMIT", price: 2.11, clientOrderId: "t-1-entry" }),
    ).rejects.toThrow(/환경변수/);
  });
});
