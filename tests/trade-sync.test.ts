// =============================================================================
// tests/trade-sync.test.ts — 매매 이력 암호화 동기화 규칙 (v0.10.0)
// -----------------------------------------------------------------------------
// [무엇을 지키나]
//   집 PC가 매매 이력을 **암호화해서** 인터넷에 올려 두고, 폰이 같은 비밀번호로 풀어 봅니다.
//   여기서 절대 어겨지면 안 되는 것:
//     ① 올라가는 내용에 **토스 키·토큰·계좌번호가 절대 없어야** 한다(매매 결과만).
//     ② 비밀번호가 틀리면 **조용히 이상한 값을 주지 말고 실패**해야 한다.
//     ③ 파일 이름만으로는 누구 것인지 알 수 없어야 한다(비밀번호에서 만든 식별자).
//     ④ 받아 온 이력을 합칠 때 **중복이 쌓이지 않아야** 한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { encryptJson, decryptJson, deriveSyncId } from "../lib/keysync";
import { toSyncPayload, isSyncPayload, syncPath, syncReadUrl, type TradeSyncPayload } from "../lib/trade-sync";
import { mergeFills, type Fill } from "../lib/fills";

const PASS = "capri-비밀번호-테스트";

function fill(over: Partial<Fill> = {}): Fill {
  return {
    symbol: "XOS",
    side: "SELL",
    qty: 100,
    price: 4.4,
    atMs: Date.UTC(2026, 7, 19, 1),
    commission: 0.4,
    tax: 0.01,
    currency: "USD",
    ...over,
  };
}

describe("toSyncPayload — 올려도 되는 것만 담는다", () => {
  it("[보안] 체결에 민감한 값이 섞여 있어도 올라가지 않는다", () => {
    // 실수로 키 같은 게 붙어 있는 상황을 가정한다.
    const dirty = { ...fill(), clientSecret: "tssk_secret_xxx", account: "12345678", token: "eyJhbGciOi" } as unknown as Fill;
    const payload = toSyncPayload([dirty], 1_700_000_000_000);
    const text = JSON.stringify(payload);

    expect(text).not.toContain("tssk_secret_xxx");
    expect(text).not.toContain("12345678");
    expect(text).not.toContain("eyJhbGciOi");
    // 매매 결과는 그대로 담긴다
    expect(payload.fills[0].symbol).toBe("XOS");
    expect(payload.fills[0].price).toBe(4.4);
  });

  it("형식 검사기가 올바른/깨진 파일을 구분한다", () => {
    expect(isSyncPayload(toSyncPayload([fill()], 1))).toBe(true);
    expect(isSyncPayload({ v: 2, fills: [] })).toBe(false);
    expect(isSyncPayload(null)).toBe(false);
    expect(isSyncPayload({ v: 1, fills: "nope", pushedAtMs: 1 })).toBe(false);
  });
});

describe("암호화 왕복", () => {
  it("올린 그대로 복호화된다", async () => {
    const payload = toSyncPayload([fill(), fill({ side: "BUY", price: 4.26 })], 1_700_000_000_000);
    const rec = await encryptJson(payload, PASS);
    const back = await decryptJson<TradeSyncPayload>(rec, PASS);
    expect(back.fills).toHaveLength(2);
    expect(back.fills[0].price).toBe(4.4);
    expect(back.pushedAtMs).toBe(1_700_000_000_000);
  });

  it("[보안] 암호문에는 원문이 드러나지 않는다", async () => {
    const rec = await encryptJson(toSyncPayload([fill()], 1), PASS);
    expect(rec.ciphertext).not.toContain("XOS");
    expect(rec.ciphertext.length).toBeGreaterThan(20);
  });

  it("[보안] 비밀번호가 틀리면 실패한다(엉뚱한 값을 주지 않는다)", async () => {
    const rec = await encryptJson(toSyncPayload([fill()], 1), PASS);
    await expect(decryptJson(rec, PASS + "틀림")).rejects.toThrow();
  });

  it("너무 짧은 비밀번호는 거부한다", async () => {
    await expect(encryptJson({ a: 1 }, "12345")).rejects.toThrow();
  });
});

describe("파일 이름·주소", () => {
  it("같은 비밀번호는 같은 파일, 다른 비밀번호는 다른 파일", async () => {
    const a = await deriveSyncId(PASS);
    const b = await deriveSyncId(PASS);
    const c = await deriveSyncId(PASS + "2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("[보안] 파일 이름에 비밀번호가 드러나지 않는다", async () => {
    const id = await deriveSyncId(PASS);
    expect(id).not.toContain(PASS);
    expect(syncPath(id)).toBe(`t/${id}.json`);
    expect(syncReadUrl(id, false)).toContain(`/t/${id}.json`);
  });
});

describe("받아 온 이력 합치기", () => {
  it("같은 체결은 중복으로 쌓이지 않는다", () => {
    const mine = [fill({ atMs: 1000 })];
    const fromCloud = [fill({ atMs: 1000 }), fill({ atMs: 2000, symbol: "SLE" })];
    expect(mergeFills(mine, fromCloud)).toHaveLength(2);
  });

  it("내 기기에만 있던 매매도 사라지지 않는다", () => {
    const mine = [fill({ atMs: 500, symbol: "ONLY_MINE" })];
    const merged = mergeFills(mine, [fill({ atMs: 1000 })]);
    expect(merged.some((f) => f.symbol === "ONLY_MINE")).toBe(true);
  });
});
