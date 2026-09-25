// =============================================================================
// tests/keysync.test.ts — 키 동기화 클라이언트 암호화 검증 (v0.8.0 → v0.24.0)
// -----------------------------------------------------------------------------
// 핵심 보장:
//   1) 암호화→복호화 왕복이 원래 값을 정확히 복원한다.
//   2) 틀린 passphrase 로는 절대 복호화되지 않는다(조용한 오염 없이 '실패').
//   3) 암호문 안에 평문 키가 남아있지 않다(클라우드에 평문이 안 올라감을 코드 레벨로 보장).
//   [v0.24.0] sync_id(행 식별자를 passphrase에서 유도) 규칙은 삭제했다. 지금은 Supabase
//   RLS가 로그인 계정(user_id)으로 행을 이미 격리하므로 더 필요 없다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../lib/keysync";

const secret = { clientId: "tsck_ABC123", clientSecret: "tssk_SUPER_SECRET_VALUE_xyz", account: "1" };

describe("키 동기화 암호화", () => {
  it("암호화→복호화 왕복이 원래 값을 복원한다", async () => {
    const rec = await encryptSecret(secret, "my-master-pass");
    const back = await decryptSecret(rec, "my-master-pass");
    expect(back).toEqual(secret);
  });

  it("틀린 passphrase 로는 복호화가 실패한다(조용한 오염 없음)", async () => {
    const rec = await encryptSecret(secret, "correct-horse");
    await expect(decryptSecret(rec, "wrong-password")).rejects.toThrow(/비밀번호가 틀렸|복호화 실패/);
  });

  it("암호문 어디에도 평문 키가 남아있지 않다(클라우드 평문 0 보장)", async () => {
    const rec = await encryptSecret(secret, "pass1234");
    const blob = JSON.stringify(rec);
    expect(blob).not.toContain(secret.clientId);
    expect(blob).not.toContain(secret.clientSecret);
    expect(blob).not.toContain("tssk_"); // secret 접두어 흔적도 없어야
  });

  it("매번 다른 salt·iv 라서 같은 값이라도 암호문이 달라진다(패턴 노출 방지)", async () => {
    const r1 = await encryptSecret(secret, "pw123456");
    const r2 = await encryptSecret(secret, "pw123456");
    expect(r1.ciphertext).not.toBe(r2.ciphertext);
    expect(r1.salt).not.toBe(r2.salt);
    // 그래도 둘 다 올바르게 복호화된다
    expect(await decryptSecret(r1, "pw123456")).toEqual(secret);
    expect(await decryptSecret(r2, "pw123456")).toEqual(secret);
  });

  it("너무 짧은 마스터 비밀번호는 거부한다", async () => {
    await expect(encryptSecret(secret, "123")).rejects.toThrow(/6자 이상/);
  });
});
