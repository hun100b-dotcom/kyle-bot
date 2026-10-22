// =============================================================================
// tests/announce.test.ts — 오너 공지 → 팀원 디스코드 웹훅 (v0.109.0)
// -----------------------------------------------------------------------------
// 발송 자체는 서버(Supabase 함수)가 하므로, 여기서는 앱 쪽 약속만 검증한다:
//   ①로그인 전엔 보내지 않는다 ②빈 제목/내용·길이 초과는 서버에 묻기 전에 막는다
//   ③올바른 서버 함수(rpc)와 인자로 부른다 ④서버 오류 문장을 그대로 사용자에게 보여 준다
//   ⑤결과 조회 응답을 화면용 모양으로 바꾼다 ⑥어느 응답에도 웹훅 주소가 섞이지 않는다.
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";

const engines: ToolEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) {
    e.stopAllStrength();
    await e.stopMock();
  }
});

function mk(dir: string): ToolEngine {
  const e = new ToolEngine(dir, { forceMock: true } as never);
  engines.push(e);
  return e;
}
function logIn(eng: ToolEngine): void {
  const a = eng as unknown as { authAccessToken: string | null; authExpiresAtMs: number; authUserId: string | null };
  a.authAccessToken = "test-access-token";
  a.authExpiresAtMs = Date.now() + 3_600_000;
  a.authUserId = "owner-id";
}
async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    return url.includes("/rest/v1/rpc/capri_announce") ? handler(url, init) : original(u as never, init);
  }) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}

describe("[v0.109.0] 공지 → 팀원 웹훅", () => {
  it("로그인 전에는 보내지 않고 안내 문장을 준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ann1-"));
    try {
      const r = await mk(dir).sendAnnouncement("제목", "내용");
      expect(r.ok).toBe(false);
      expect(r.message).toContain("로그인");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("빈 제목/내용·길이 초과는 서버에 묻기 전에 막는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ann2-"));
    try {
      const eng = mk(dir); logIn(eng);
      let called = 0;
      await withFetch(() => { called++; return new Response("1", { status: 200 }); }, async () => {
        expect((await eng.sendAnnouncement("  ", "내용")).ok).toBe(false);
        expect((await eng.sendAnnouncement("제목", "")).ok).toBe(false);
        expect((await eng.sendAnnouncement("가".repeat(101), "내용")).ok).toBe(false);
        expect((await eng.sendAnnouncement("제목", "가".repeat(1701))).ok).toBe(false);
      });
      expect(called).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("올바른 서버 함수·인자로 부르고 공지 번호를 돌려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ann3-"));
    try {
      const eng = mk(dir); logIn(eng);
      let seen: { url: string; body: unknown } | null = null;
      const r = await withFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return new Response("42", { status: 200 });
      }, () => eng.sendAnnouncement(" 점검 안내 ", " 내일 새벽 업데이트 "));
      expect(r).toMatchObject({ ok: true, id: 42 });
      expect(seen!.url).toContain("/rest/v1/rpc/capri_announce_send");
      expect(seen!.body).toEqual({ p_title: "점검 안내", p_body: "내일 새벽 업데이트" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("서버가 거절하면(오너 아님 등) 서버의 한국어 문장을 그대로 보여 준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ann4-"));
    try {
      const eng = mk(dir); logIn(eng);
      const r = await withFetch(
        () => new Response(JSON.stringify({ message: "공지는 운영자만 보낼 수 있습니다." }), { status: 400 }),
        () => eng.sendAnnouncement("제목", "내용"),
      );
      expect(r.ok).toBe(false);
      expect(r.message).toBe("공지는 운영자만 보낼 수 있습니다.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("결과 조회·목록 응답을 화면용 모양으로 바꾼다(웹훅 주소 필드는 애초에 없다)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ann5-"));
    try {
      const eng = mk(dir); logIn(eng);
      const status = await withFetch(
        () => new Response(JSON.stringify([
          { member_email: "a@x.com", status: "sent", attempts: 1, http_status: 204, error: null },
          { member_email: "b@x.com", status: "failed", attempts: 3, http_status: 404, error: "웹훅이 삭제됐거나 주소가 틀림" },
        ]), { status: 200 }),
        () => eng.getAnnouncementStatus(7),
      );
      expect(status).toEqual([
        { email: "a@x.com", status: "sent", attempts: 1, httpStatus: 204, error: null },
        { email: "b@x.com", status: "failed", attempts: 3, httpStatus: 404, error: "웹훅이 삭제됐거나 주소가 틀림" },
      ]);
      expect(JSON.stringify(status)).not.toContain("discord.com");

      const list = await withFetch(
        () => new Response(JSON.stringify([{ id: 7, title: "t", body: "b", created_at: "2026-10-22T00:00:00Z", sent: 1, failed: 1, pending: 0, no_webhook: 2 }]), { status: 200 }),
        () => eng.listAnnouncements(),
      );
      expect(list[0]).toMatchObject({ id: 7, sent: 1, failed: 1, noWebhook: 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("다시 보내기: 대상 수를 알려 준다 / 서버 오류는 빈 목록·실패 메시지로 안전하게 처리한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-ann6-"));
    try {
      const eng = mk(dir); logIn(eng);
      expect((await withFetch(() => new Response("3", { status: 200 }), () => eng.retryAnnouncement(7))).message).toContain("3명");
      expect((await withFetch(() => new Response("0", { status: 200 }), () => eng.retryAnnouncement(7))).message).toContain("없습니다");
      expect(await withFetch(() => new Response("{}", { status: 500 }), () => eng.getAnnouncementStatus(7))).toEqual([]);
      expect(await withFetch(() => new Response("{}", { status: 500 }), () => eng.listAnnouncements())).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
