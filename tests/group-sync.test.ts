// =============================================================================
// tests/group-sync.test.ts — v0.56.0 그룹 실시간 동기화·채팅·서버 로그 카테고리 회귀 테스트
// -----------------------------------------------------------------------------
// [배경] 오너 지시: "매매연구 탭에 그룹원(카일)의 데이터가 안 불러와짐" + "그룹 전체 실시간
//   연동 동기화 철저히" + "그룹원 관리 탭에 CHAT 기능" + "서버 로그 카테고리화 토글".
//   조사 결과 카일은 이번 세션에 처음으로 "본인 전용" 계정으로 가입해 아직 로컬 자동매매
//   기록이 없을 뿐이라 코드 버그는 아니었지만, 그 과정에서 실제 버그 하나를 발견했다:
//   capri_group_trades는 user_id 기준 "행 전체"를 덮어쓰는 업서트라, 같은 로그인을 여러
//   기기에서 같이 쓰면(과거 "로그인 하나로 통합" 시절) 마지막에 올린 기기가 다른 기기의
//   기록을 통째로 지울 수 있었다 — 이번에 병합 후 올리도록 고쳤다(아래 첫 번째 describe).
//   나머지는 이번에 새로 만든 기능(실시간 동기화 루프·채팅·로그 카테고리 분류)의 최소 동작
//   보증이다.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, classifyJournalEntry } from "../electron/tool-engine";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type EngineInternals = {
  authAccessToken: string | null;
  authExpiresAtMs: number;
  authEmail: string | null;
  authUserId: string | null;
  autoTradeHistory: unknown[];
  groupSyncTimer: ReturnType<typeof setInterval> | null;
  protectionAuditTimer: ReturnType<typeof setInterval> | null;
  positionSyncTimer: ReturnType<typeof setInterval> | null;
};

/** 네트워크 호출 없이 "로그인된 상태"를 흉내낸다 — ensureAccessToken이 즉시 이 토큰을 돌려준다. */
function logInFake(eng: ToolEngine, email = "member@example.com", userId = "11111111-1111-1111-1111-111111111111"): void {
  const engAny = eng as unknown as EngineInternals;
  engAny.authAccessToken = "fake-token";
  engAny.authExpiresAtMs = Date.now() + 60 * 60_000;
  engAny.authEmail = email;
  engAny.authUserId = userId;
}

describe("[v0.56.0 긴급 수정] syncPushGroupTrades — 여러 기기가 같은 로그인을 써도 서로의 기록을 지우지 않는다", () => {
  it("서버에 이미 있던(다른 기기가 남긴) 기록을 이 기기가 모르더라도 올릴 때 함께 살려서 보낸다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-groupsync-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      (eng as unknown as EngineInternals).autoTradeHistory = [
        { id: "AAPL@2@1000", symbol: "AAPL", entry: 2, tp: 2.2, sl: 1.8, quantity: 1, enteredAt: "x", status: "watching", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "" },
      ];

      let sentBody: { history: Array<{ id: string }> } | null = null;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/rest/v1/capri_group_trades") && (!init || init.method === undefined)) {
          // GET(병합용 조회) — 다른 기기가 남긴 기록 하나를 이미 서버가 갖고 있다고 흉내낸다.
          return new Response(
            JSON.stringify([{ history: [{ id: "TSLA@5@2000", symbol: "TSLA", entry: 5, tp: 5.5, sl: 4.5, quantity: 2, enteredAt: "y", status: "active", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "" }] }]),
            { status: 200 },
          );
        }
        if (u.includes("/rest/v1/capri_group_trades") && init?.method === "POST") {
          sentBody = JSON.parse(String(init.body));
          return new Response(null, { status: 201 });
        }
        throw new Error(`예상 못한 호출: ${u} ${init?.method}`);
      }) as typeof fetch;

      const r = await eng.syncPushGroupTrades();
      expect(r.ok).toBe(true);
      expect(r.count).toBe(2); // 이 기기의 AAPL + 서버에 있던 TSLA
      const ids = (sentBody as unknown as { history: Array<{ id: string }> }).history.map((h) => h.id);
      expect(ids).toContain("AAPL@2@1000"); // 이 기기가 아는 것
      expect(ids).toContain("TSLA@5@2000"); // 다른 기기가 남긴 것(예전엔 여기서 사라졌다)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("같은 id가 겹치는데 이 기기 쪽이 '더 진행된 상태'면 그 상태를 지켜 보낸다(뒤로 안 돌아감)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-groupsync2-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      (eng as unknown as EngineInternals).autoTradeHistory = [
        { id: "AAPL@2@1000", symbol: "AAPL", entry: 2, tp: 2.2, sl: 1.8, quantity: 1, enteredAt: "x", status: "closed_win", exitedAt: "z", exitPrice: 2.2, pnlUsd: 0.2, pnlPct: 10, note: "익절" },
      ];
      let sentBody: { history: Array<{ id: string; status: string }> } | null = null;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/rest/v1/capri_group_trades") && init?.method === "POST") {
          sentBody = JSON.parse(String(init.body));
          return new Response(null, { status: 201 });
        }
        // GET — 서버는 아직 "watching"으로만 알고 있던 옛 상태.
        return new Response(
          JSON.stringify([{ history: [{ id: "AAPL@2@1000", symbol: "AAPL", entry: 2, tp: 2.2, sl: 1.8, quantity: 1, enteredAt: "x", status: "watching", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "" }] }]),
          { status: 200 },
        );
      }) as typeof fetch;

      const r = await eng.syncPushGroupTrades();
      expect(r.ok).toBe(true);
      expect(r.count).toBe(1); // 중복 없이 하나로 병합됨
      expect((sentBody as unknown as { history: Array<{ status: string }> }).history[0].status).toBe("closed_win"); // 더 진행된 상태를 지킴
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[2차 검토에서 발견] 이 기기가 아직 옛 상태(watching)만 알고 있는데 다른 기기가 이미 끝냈다면(closed), 그 끝난 상태를 되돌리지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-groupsync2b-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      // 이 기기는 아직 이 매매가 체결 대기 중(watching)인 줄로만 안다 — 다른 기기(진짜로 이
      // 포지션을 감시하던 쪽)가 먼저 청산까지 끝내고 그룹 표에 올려 둔 상황을 흉내낸다.
      (eng as unknown as EngineInternals).autoTradeHistory = [
        { id: "AAPL@2@1000", symbol: "AAPL", entry: 2, tp: 2.2, sl: 1.8, quantity: 1, enteredAt: "x", status: "watching", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "" },
      ];
      let sentBody: { history: Array<{ id: string; status: string }> } | null = null;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/rest/v1/capri_group_trades") && init?.method === "POST") {
          sentBody = JSON.parse(String(init.body));
          return new Response(null, { status: 201 });
        }
        return new Response(
          JSON.stringify([{ history: [{ id: "AAPL@2@1000", symbol: "AAPL", entry: 2, tp: 2.2, sl: 1.8, quantity: 1, enteredAt: "x", status: "closed_win", exitedAt: "z", exitPrice: 2.2, pnlUsd: 0.2, pnlPct: 10, note: "익절" }] }]),
          { status: 200 },
        );
      }) as typeof fetch;

      const r = await eng.syncPushGroupTrades();
      expect(r.ok).toBe(true);
      // [핵심] 이 기기의 옛 "watching"으로 덮어써서 다른 기기가 이미 확정한 청산 결과를
      // 되돌리면 안 된다 — 단순 "이 기기가 무조건 최신" 규칙이었다면 여기서 실패했을 것.
      expect((sentBody as unknown as { history: Array<{ status: string }> }).history[0].status).toBe("closed_win");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.56.0] 그룹 전체 실시간 동기화 — startGroupSyncLoop/stopGroupSyncLoop", () => {
  it("로그인 안 돼 있으면 시작하지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-groupsync3-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.startGroupSyncLoop();
      expect((eng as unknown as EngineInternals).groupSyncTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로그인해 있으면 타이머를 시작하고, stopGroupSyncLoop로 멈출 수 있다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-groupsync4-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      global.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

      eng.startGroupSyncLoop();
      expect((eng as unknown as EngineInternals).groupSyncTimer).not.toBeNull();
      eng.stopGroupSyncLoop();
      expect((eng as unknown as EngineInternals).groupSyncTimer).toBeNull();
      // 즉시 실행된 첫 tick(비동기)이 끝날 시간을 잠깐 준다 — 남은 프라미스가 테스트 이후로 새지 않게.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로그아웃(authSignOut)하면 자동으로 멈춘다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-groupsync5-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      global.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;
      eng.startGroupSyncLoop();
      expect((eng as unknown as EngineInternals).groupSyncTimer).not.toBeNull();
      eng.authSignOut();
      expect((eng as unknown as EngineInternals).groupSyncTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.71.0 — LPCN 37시간 무방비 사례 조사] 보호 감사 루프 — startProtectionAuditLoop/stopProtectionAuditLoop", () => {
  it("로그인 안 돼 있으면 시작하지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-protaudit1-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.startProtectionAuditLoop();
      expect((eng as unknown as EngineInternals).protectionAuditTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로그인해 있으면 자동매매 켜짐 여부와 무관하게 타이머를 시작하고, stopProtectionAuditLoop로 멈출 수 있다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-protaudit2-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      // [핵심] 자동매매는 꺼진 채로 둔다 — autoTradeTick 안에서만 돌던 예전 방식이었다면
      //   이 상태에서는 보호 감사가 절대 안 돌았다(LPCN 사례의 원인).
      expect((eng as unknown as { autoTradeEnabled: boolean }).autoTradeEnabled).toBe(false);

      eng.startProtectionAuditLoop();
      expect((eng as unknown as EngineInternals).protectionAuditTimer).not.toBeNull();
      eng.stopProtectionAuditLoop();
      expect((eng as unknown as EngineInternals).protectionAuditTimer).toBeNull();
      // 즉시 실행된 첫 점검(비동기, catch로 감싸져 있음)이 끝날 시간을 잠깐 준다.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.78.0] 이 루프가 reflectUnknownHoldings도 같은 주기로 함께 돈다(Capri가 모르는 보유 종목 자동 반영)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-protaudit5-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      eng.startProtectionAuditLoop(); // 즉시 첫 점검 1회 실행(비동기)
      await new Promise((r) => setTimeout(r, 50)); // 비동기 점검이 끝날 시간을 준다
      eng.stopProtectionAuditLoop();
      const history = (eng as unknown as EngineInternals).autoTradeHistory as Array<{ symbol: string; note: string }>;
      expect(history.some((h) => h.symbol === "AAPL" && h.note.includes("[자동반영]"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로그아웃(authSignOut)하면 자동으로 멈춘다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-protaudit3-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      eng.startProtectionAuditLoop();
      expect((eng as unknown as EngineInternals).protectionAuditTimer).not.toBeNull();
      eng.authSignOut();
      expect((eng as unknown as EngineInternals).protectionAuditTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("이미 돌고 있으면 다시 불러도 타이머를 중복으로 만들지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-protaudit4-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      eng.startProtectionAuditLoop();
      const first = (eng as unknown as EngineInternals).protectionAuditTimer;
      eng.startProtectionAuditLoop();
      expect((eng as unknown as EngineInternals).protectionAuditTimer).toBe(first);
      eng.stopProtectionAuditLoop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.74.0 — task #72 '토스 증권과의 실시간 양방향 동기화'] 포지션 동기화 루프 — startPositionSyncLoop/stopPositionSyncLoop", () => {
  it("로그인 안 돼 있으면 시작하지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-possync1-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.startPositionSyncLoop();
      expect((eng as unknown as EngineInternals).positionSyncTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로그인해 있으면 자동매매 켜짐 여부와 무관하게 타이머를 시작하고, stopPositionSyncLoop로 멈출 수 있다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-possync2-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      // [핵심] 자동매매는 꺼진 채로 둔다 — 예전엔 화면 탭이 열려 있거나(20초 렌더러 타이머)
      //   자동매매가 켜져 있을 때(5분 사이클)만 포지션이 다시 확인됐다. 둘 다 아닌 이 상태에서도
      //   돌아야 "화면을 안 보고 있어도 실시간 반영된다"는 오너 지시를 지킨 것이다.
      expect((eng as unknown as { autoTradeEnabled: boolean }).autoTradeEnabled).toBe(false);

      eng.startPositionSyncLoop();
      expect((eng as unknown as EngineInternals).positionSyncTimer).not.toBeNull();
      eng.stopPositionSyncLoop();
      expect((eng as unknown as EngineInternals).positionSyncTimer).toBeNull();
      // 즉시 실행된 첫 확인(비동기, catch로 감싸져 있음)이 끝날 시간을 잠깐 준다.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로그아웃(authSignOut)하면 자동으로 멈춘다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-possync3-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      eng.startPositionSyncLoop();
      expect((eng as unknown as EngineInternals).positionSyncTimer).not.toBeNull();
      eng.authSignOut();
      expect((eng as unknown as EngineInternals).positionSyncTimer).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("이미 돌고 있으면 다시 불러도 타이머를 중복으로 만들지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-possync4-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      eng.startPositionSyncLoop();
      const first = (eng as unknown as EngineInternals).positionSyncTimer;
      eng.startPositionSyncLoop();
      expect((eng as unknown as EngineInternals).positionSyncTimer).toBe(first);
      eng.stopPositionSyncLoop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.56.0] 그룹 채팅 — sendGroupChatMessage / getGroupChatMessages", () => {
  it("로그인 안 했으면 전송을 거부한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-chat1-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const r = await eng.sendGroupChatMessage("안녕하세요");
      expect(r.ok).toBe(false);
      expect(r.message).toContain("로그인");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("빈 메시지는 네트워크 호출 없이 거부한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-chat2-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng);
      global.fetch = vi.fn(async () => {
        throw new Error("호출되면 안 됨");
      }) as typeof fetch;
      const r = await eng.sendGroupChatMessage("   ");
      expect(r.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("정상 메시지를 보내고, 목록 조회는 오래된순으로 정렬해 돌려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-chat3-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      logInFake(eng, "kyle@example.com");
      let posted: { body: string; member_email: string } | null = null;
      global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/rest/v1/capri_group_chat") && init?.method === "POST") {
          posted = JSON.parse(String(init.body));
          return new Response(null, { status: 201 });
        }
        if (u.includes("/rest/v1/capri_group_chat")) {
          // 서버는 최신순(desc)으로 준다 — 엔진이 화면 표시용으로 뒤집어야 한다.
          return new Response(
            JSON.stringify([
              { id: 2, member_email: "kyle@example.com", body: "두번째", created_at: "2026-09-29T16:05:00Z" },
              { id: 1, member_email: "kyle@example.com", body: "첫번째", created_at: "2026-09-29T16:00:00Z" },
            ]),
            { status: 200 },
          );
        }
        throw new Error(`예상 못한 호출: ${u}`);
      }) as typeof fetch;

      const sendR = await eng.sendGroupChatMessage("두번째");
      expect(sendR.ok).toBe(true);
      expect((posted as unknown as { body: string }).body).toBe("두번째");
      expect((posted as unknown as { member_email: string }).member_email).toBe("kyle@example.com");

      const listR = await eng.getGroupChatMessages();
      expect(listR.ok).toBe(true);
      expect(listR.chat.map((m) => m.body)).toEqual(["첫번째", "두번째"]); // 오래된 것이 먼저
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.56.0] classifyJournalEntry — '서버 로그' 탭 카테고리 자동 분류", () => {
  it("주문 관련 kind는 '주문'으로 분류한다", () => {
    expect(classifyJournalEntry({ kind: "entry", summary: "매수 접수" })).toBe("주문");
    expect(classifyJournalEntry({ kind: "oco", summary: "OCO 등록 완료" })).toBe("주문");
  });

  it("⚠️나 '실패' 문구가 있으면 kind와 무관하게 '오류'가 최우선이다", () => {
    expect(classifyJournalEntry({ kind: "entry", summary: "⚠️ 주문 취소 실패" })).toBe("오류");
  });

  it("로그인·가입 관련 문구는 '인증'으로 분류한다", () => {
    expect(classifyJournalEntry({ kind: "info", summary: "로그인되었습니다(a@b.com)." })).toBe("인증");
  });

  it("동기화·그룹 공유 문구는 '동기화'로 분류한다", () => {
    expect(classifyJournalEntry({ kind: "info", summary: "그룹에 자동매매 기록 3건을 공유했습니다." })).toBe("동기화");
  });

  it("자동매매·스크리닝 문구는 '자동매매'로 분류한다", () => {
    expect(classifyJournalEntry({ kind: "info", summary: "🔍 스크리닝에서 AAPL이 진입 조건을 모두 통과" })).toBe("자동매매");
  });

  it("'실패' 문구가 섞인 자동매매 로그는 '오류'가 우선한다(의도된 우선순위)", () => {
    expect(classifyJournalEntry({ kind: "info", summary: "🤖 자동매매: 이번 사이클 스크리닝 실패" })).toBe("오류");
  });

  it("아무 키워드에도 안 걸리면 '시스템'으로 분류한다", () => {
    expect(classifyJournalEntry({ kind: "info", summary: "설정 저장 (모드: 연습)" })).toBe("시스템");
  });
});
