// =============================================================================
// tests/auth-signup.test.ts — 가입 실패 시 승인요청 자동접수 회귀 테스트 (v0.53.0)
// -----------------------------------------------------------------------------
// [배경] 실제 Supabase 프로젝트의 auth 로그를 직접 조회해 확인한 실사고: 동료(카일)가
//   가입을 시도하면 허용목록 게이트(capri_auth_gate 트리거)가 CAPRI_NOT_ALLOWED 예외를
//   HTTP 500으로 감싸 정상적으로 돌려주는데, authSignUp()이 그 응답에서 이유를 못 알아채
//   승인 요청(requestAccess)을 단 한 번도 안 보냈다(edge_logs로 확인 — 뒤이은
//   /rest/v1/capri_access_requests 호출 자체가 없었음). 원인은 응답 필드명을 `data.msg`
//   하나만 보고 있었던 것 — 실제 GoTrue 버전에 따라 `message` 필드로 올 수도 있다.
//
// [무엇을 검증하나] authSignUp이 실제 네트워크(Supabase)를 안 쓰고도 이 경로를 확인할 수
//   있게, global fetch를 이 테스트 안에서만 스텁한다. authSignUp()이 호출하는
//   /auth/v1/signup, /rest/v1/capri_access_requests 두 엔드포인트만 흉내 낸다.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("[v0.53.0 긴급 수정] authSignUp — 가입 실패 시 승인요청 자동접수(실사고 회귀)", () => {
  it("서버 응답이 msg가 아니라 message 필드로 와도(실제로 있었던 케이스) 자동으로 승인 요청을 접수한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-signup-"));
    try {
      const eng = new ToolEngine(dir);
      let sawAccessRequestPost = false;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/auth/v1/signup")) {
          // 실제 Supabase 로그에서 확인한 그대로: msg가 아니라 message 필드 + error_code.
          return new Response(
            JSON.stringify({ code: 500, error_code: "unexpected_failure", message: "Database error saving new user" }),
            { status: 500 },
          );
        }
        if (u.includes("/rest/v1/capri_access_requests") && init?.method === "POST") {
          sawAccessRequestPost = true;
          return new Response(null, { status: 201 });
        }
        throw new Error(`예상 못한 호출: ${u}`);
      }) as typeof fetch;

      const r = await eng.authSignUp("kyle-test@example.com", "testpass123");
      expect(r.ok).toBe(false);
      expect(sawAccessRequestPost).toBe(true); // [핵심] 예전엔 이게 false였다(자동 접수 자체가 안 됨).
      expect(r.message).toContain("승인 요청을 자동으로 접수했습니다");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("500이지만 문구를 전혀 못 알아봐도(둘 다 매치 실패) 오너 지시대로 일단 승인 요청부터 접수한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-signup2-"));
    try {
      const eng = new ToolEngine(dir);
      let sawAccessRequestPost = false;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/auth/v1/signup")) {
          // 어떤 필드에도 유용한 단서가 없는 극단적 케이스 — 그래도 500이면 접수한다.
          return new Response(JSON.stringify({}), { status: 500 });
        }
        if (u.includes("/rest/v1/capri_access_requests") && init?.method === "POST") {
          sawAccessRequestPost = true;
          return new Response(null, { status: 201 });
        }
        throw new Error(`예상 못한 호출: ${u}`);
      }) as typeof fetch;

      const r = await eng.authSignUp("kyle-test2@example.com", "testpass123");
      expect(r.ok).toBe(false);
      expect(sawAccessRequestPost).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("400(비밀번호 형식 오류 등 진짜 사용자 잘못)이면 승인 요청을 접수하지 않는다(과도한 접수 방지)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-signup3-"));
    try {
      const eng = new ToolEngine(dir);
      let sawAccessRequestPost = false;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/auth/v1/signup")) {
          return new Response(JSON.stringify({ msg: "Password should be at least 6 characters" }), { status: 400 });
        }
        if (u.includes("/rest/v1/capri_access_requests") && init?.method === "POST") {
          sawAccessRequestPost = true;
          return new Response(null, { status: 201 });
        }
        throw new Error(`예상 못한 호출: ${u}`);
      }) as typeof fetch;

      const r = await eng.authSignUp("kyle-test3@example.com", "12345");
      expect(r.ok).toBe(false);
      expect(sawAccessRequestPost).toBe(false);
      expect(r.message).toContain("Password should be at least 6 characters");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
