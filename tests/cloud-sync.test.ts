// =============================================================================
// tests/cloud-sync.test.ts — [v0.88.0] 폰 기록이 9월에서 멈춘 사고(2026-10-13) 재현·고정
// -----------------------------------------------------------------------------
// 원인: 암호화 동기화가 "비밀번호가 메모리에 있을 때만" 돌았다 → 앱 재시작(저장된 토큰으로 로그인 복원) 뒤엔 비밀번호가 없어 조용히 전부 건너뜀.
// 해결: 비밀번호에서 만든 데이터 키를 로컬에 보관(비밀번호 자체는 저장 안 함) → 재시작해도 계속 올림 + 상태 표시 + 잠금 해제.
// ⚠️ 실서버 안 건드림: Supabase 호출은 전부 가짜 fetch로 가로챈다.
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDataKey, encryptJsonWithDataKey, decryptJsonAuto, encryptJson, isDataKeyRecord } from "../lib/keysync";
import { ToolEngine } from "../electron/tool-engine";

describe("keysync — 데이터 키 방식", () => {
  it("같은 비밀번호·계정이면 어느 기기에서든 같은 키가 나오고, 다르면 다르다", async () => {
    const a = await deriveDataKey("password-1", "user-1");
    expect(await deriveDataKey("password-1", "user-1")).toBe(a);
    expect(await deriveDataKey("password-1", "user-2")).not.toBe(a);
    expect(await deriveDataKey("password-2", "user-1")).not.toBe(a);
  });

  it("PC(데이터 키만 보관)가 올린 걸 폰(비밀번호만 입력)이 풀 수 있다 — 서로 비밀번호·키를 몰라도 되는 방향", async () => {
    const dk = await deriveDataKey("password-1", "user-1");
    const rec = await encryptJsonWithDataKey({ fills: [1, 2, 3] }, dk);
    expect(isDataKeyRecord(rec)).toBe(true);
    // PC: 키로 푼다
    expect(await decryptJsonAuto(rec, { dataKey: dk })).toEqual({ fills: [1, 2, 3] });
    // 폰: 비밀번호 + 계정 id로 같은 키를 다시 만들어 푼다
    expect(await decryptJsonAuto(rec, { password: "password-1", userId: "user-1" })).toEqual({ fills: [1, 2, 3] });
    // 열쇠가 없거나 틀리면 실패(조용히 쓰레기값 아님)
    await expect(decryptJsonAuto(rec, {})).rejects.toThrow("NEED_KEY");
    await expect(decryptJsonAuto(rec, { password: "wrong-pass", userId: "user-1" })).rejects.toThrow(/복호화 실패/);
  });

  it("예전 방식(레코드별 솔트) 기록도 비밀번호가 있으면 그대로 풀리고, 없으면 NEED_KEY", async () => {
    const legacy = await encryptJson({ hello: "world" }, "password-1");
    expect(isDataKeyRecord(legacy)).toBe(false);
    expect(await decryptJsonAuto(legacy, { password: "password-1" })).toEqual({ hello: "world" });
    await expect(decryptJsonAuto(legacy, { dataKey: await deriveDataKey("password-1", "u") })).rejects.toThrow("NEED_KEY");
  });
});

type Posted = { url: string; body: Record<string, unknown> };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function installFakeSupabase(posted: Posted[], opts?: { userId?: string }) {
  const userId = opts?.userId ?? "user-1";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/auth/v1/token")) return json({ access_token: "tok", refresh_token: "ref", expires_in: 3600, user: { id: userId, email: "me@test.com" } });
    if (method === "POST" && url.includes("/rest/v1/capri_")) {
      posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(null, { status: 201 });
    }
    if (url.includes("select=updated_at")) return json([{ updated_at: new Date().toISOString() }]);
    return json([]);
  }) as typeof fetch;
}

type Internals = {
  authAccessToken: string | null; authRefreshToken: string | null; authUserId: string | null; authEmail: string | null; authExpiresAtMs: number;
  authDataKey: string | null; authPassword: string | null;
  savedFills: Array<{ symbol: string; side: "BUY" | "SELL"; qty: number; price: number; atMs: number; commission: number; tax: number }>;
  adoptPassword: (pw: string) => Promise<void>;
  cloudSyncTick: () => Promise<void>;
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kyle-cloud-"));
  const eng = new ToolEngine(dir, { forceMock: true, appVersion: "0.88.0" });
  const x = eng as unknown as Internals;
  // "토큰으로 복원된 로그인" 상태 — 비밀번호는 메모리에 없다(앱 재시작 직후와 같은 조건)
  x.authAccessToken = "tok"; x.authRefreshToken = "ref"; x.authUserId = "user-1"; x.authEmail = "me@test.com"; x.authExpiresAtMs = Date.now() + 3_600_000;
  x.savedFills = [{ symbol: "AAA", side: "BUY", qty: 1, price: 2, atMs: Date.now() - 1000, commission: 0, tax: 0 }];
  return { dir, eng, x, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("엔진 — 재시작 뒤(비밀번호 없음)에도 올라간다 / 열쇠가 없으면 크게 알린다", () => {
  it("[사고 재현] 비밀번호도 키도 없으면 업로드가 실패하고 '잠김'으로 드러난다(예전엔 조용히 건너뜀)", async () => {
    const posted: Posted[] = [];
    installFakeSupabase(posted);
    const { eng, cleanup } = setup();
    try {
      const r = await eng.syncPushTrades();
      expect(r.ok).toBe(false);
      expect(r.message).toContain("동기화 키");
      expect(posted).toHaveLength(0);
      const st = await eng.getSyncStatus();
      expect(st.locked).toBe(true);
      expect(st.summary).toContain("잠김");
      expect(st.channels.find((c) => c.key === "trades")!.lastError).toContain("동기화 키");
    } finally { cleanup(); }
  });

  it("[수정] 비밀번호를 한 번 받으면 데이터 키가 파일에 남고(비밀번호는 안 남음), 새 엔진(재시작)이 그 키로 바로 올린다", async () => {
    const posted: Posted[] = [];
    installFakeSupabase(posted);
    const { dir, x, cleanup } = setup();
    try {
      await x.adoptPassword("my-secret-password");
      const env = readFileSync(join(dir, ".env"), "utf8");
      expect(env).toContain("CAPRI_DATA_KEY=");
      expect(env).not.toContain("my-secret-password"); // 비밀번호 자체는 저장하지 않는다

      // ── 재시작: 같은 폴더의 새 엔진 — 토큰만 복원되고 비밀번호는 없다 ──
      const eng2 = new ToolEngine(dir, { forceMock: true, appVersion: "0.88.0" });
      const y = eng2 as unknown as Internals;
      expect(y.authPassword).toBeNull();
      expect(y.authDataKey).toBeTruthy();
      y.authAccessToken = "tok"; y.authUserId = "user-1"; y.authEmail = "me@test.com"; y.authExpiresAtMs = Date.now() + 3_600_000;
      y.savedFills = [{ symbol: "AAA", side: "BUY", qty: 1, price: 2, atMs: Date.now(), commission: 0, tax: 0 }];
      const r = await eng2.syncPushTrades();
      expect(r.ok).toBe(true);
      const post = posted.find((p) => p.url.includes("capri_trades"))!;
      expect(post.body.salt).toBe("k1"); // 데이터 키 방식
      // 폰(비밀번호만 입력)이 이 레코드를 풀 수 있다
      const plain = await decryptJsonAuto<{ fills: unknown[] }>(post.body as { ciphertext: string; salt: string; iv: string }, { password: "my-secret-password", userId: "user-1" });
      expect(plain.fills.length).toBe(1);
      const st = await eng2.getSyncStatus();
      expect(st.locked).toBe(false);
      expect(st.channels.find((c) => c.key === "trades")!.lastOkMs).not.toBeNull();
    } finally { cleanup(); }
  }, 30_000);

  it("주기 점검(cloudSyncTick)이 변경분을 올리고, 변화가 없으면 다시 올리지 않는다(1시간 전까지)", async () => {
    const posted: Posted[] = [];
    installFakeSupabase(posted);
    const { x, cleanup } = setup();
    try {
      await x.adoptPassword("my-secret-password");
      await x.cloudSyncTick();
      const first = posted.filter((p) => p.url.includes("capri_trades")).length;
      expect(first).toBe(1);
      await x.cloudSyncTick();
      expect(posted.filter((p) => p.url.includes("capri_trades")).length).toBe(1); // 변화 없음 → 재업로드 없음
      x.savedFills.push({ symbol: "BBB", side: "SELL", qty: 1, price: 3, atMs: Date.now() + 5, commission: 0, tax: 0 });
      await x.cloudSyncTick();
      expect(posted.filter((p) => p.url.includes("capri_trades")).length).toBe(2); // 새 체결 → 올림
    } finally { cleanup(); }
  }, 30_000);

  it("잠금 해제(unlockSync): 비밀번호로 로그인 검증 → 키 생성 → 밀린 기록을 전부 올린다", async () => {
    const posted: Posted[] = [];
    installFakeSupabase(posted);
    const { x, eng, cleanup } = setup();
    try {
      x.authDataKey = null;
      const r = await eng.unlockSync("my-secret-password");
      expect(r.ok).toBe(true);
      expect(x.authDataKey).toBeTruthy();
      expect(posted.some((p) => p.url.includes("capri_trades") && p.body.salt === "k1")).toBe(true);
    } finally { cleanup(); }
  }, 30_000);
});
