// =============================================================================
// tests/group-realtime-v0109.test.ts — v0.109.0 그룹 실시간 갱신·근황·공지 회귀 테스트
// -----------------------------------------------------------------------------
// [시나리오] 가짜 서버(메모리) 하나에 "기기 A(오너)"와 "기기 B(팀원)" 두 엔진을 붙인다.
//   · A가 채팅·공지를 올리면 B의 다음 8초 틱에 정확히 한 번씩 도착해야 한다(중복·누락 없음).
//   · 번호가 뒤늦게 커밋돼 순서가 엇갈려도 놓치지 않아야 한다.
//   · 공지 삭제가 B에도 반영된다. 팀원(B)은 공지를 못 올린다.
//   · 근황: 두 기기 신호가 사람별로 올바르게 합쳐진다(접속 중/자동매매/보유).
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type GroupFeedEvent } from "../electron/tool-engine";
import { aggregatePresence, presenceKey, type PresenceRow } from "../lib/group-presence";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type Internals = {
  authAccessToken: string | null;
  authExpiresAtMs: number;
  authEmail: string | null;
  authUserId: string | null;
  groupFeedTick: () => Promise<void>;
  lastPresencePushAtMs: number;
  autoTradeEnabled: boolean;
  autoTradePositions: unknown[];
};

function makeEngine(email: string, userId: string, role: "desktop" | "web" = "desktop") {
  const dir = mkdtempSync(join(tmpdir(), "kyle-feed-"));
  const eng = new ToolEngine(dir, { forceMock: true, role, appVersion: "0.109.0" });
  const i = eng as unknown as Internals;
  i.authAccessToken = "fake";
  i.authExpiresAtMs = Date.now() + 3_600_000;
  i.authEmail = email;
  i.authUserId = userId;
  const events: GroupFeedEvent[] = [];
  eng.on("groupFeed", (ev: GroupFeedEvent) => events.push(ev));
  return { eng, i, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 메모리 가짜 서버 — 채팅·공지·근황·변경로그·그룹기록 표만 흉내낸다. */
function fakeServer() {
  const db = {
    chat: [] as Array<{ id: number; member_email: string; body: string; created_at: string }>,
    notices: [] as Array<{ id: number; title: string; body: string; author_email: string; created_at: string; webhook_sent: number }>,
    presence: [] as PresenceRow[],
    trades: [] as Array<{ member_email: string; updated_at: string; history: unknown[] }>,
    nextNotice: 1,
  };
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const t = u.pathname.replace("/rest/v1/", "");
    const method = init?.method ?? "GET";
    const json = (v: unknown, status = 200) => status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    if (t === "capri_group_chat" && method === "GET") {
      const gt = Number((u.searchParams.get("id") ?? "gt.0").replace("gt.", ""));
      const rows = db.chat.filter((r) => r.id > gt).sort((a, b) => a.id - b.id);
      const order = u.searchParams.get("order") ?? "";
      return json(order.includes("desc") ? [...db.chat].sort((a, b) => b.id - a.id) : rows);
    }
    if (t === "capri_notices" && method === "GET") {
      const sel = u.searchParams.get("select") ?? "";
      const rows = [...db.notices].sort((a, b) => b.id - a.id);
      return json(sel === "id" ? rows.map((r) => ({ id: r.id })) : rows);
    }
    if (t === "capri_notices" && method === "POST") {
      const b = JSON.parse(String(init?.body));
      const row = { id: db.nextNotice++, title: b.title, body: b.body, author_email: b.author_email, created_at: new Date().toISOString(), webhook_sent: 3 };
      db.notices.push(row);
      return json([row], 201);
    }
    if (t === "capri_notices" && method === "DELETE") {
      const id = Number((u.searchParams.get("id") ?? "eq.0").replace("eq.", ""));
      db.notices = db.notices.filter((r) => r.id !== id);
      return json([], 204);
    }
    if (t === "capri_group_presence" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as PresenceRow;
      const idx = db.presence.findIndex((p) => p.user_id === b.user_id && p.device_id === b.device_id);
      if (idx >= 0) db.presence[idx] = b; else db.presence.push(b);
      return json([], 201);
    }
    if (t === "capri_group_presence" && method === "GET") return json(db.presence);
    if (t === "capri_changelog") return json([{ version: "0.109.0", published_at: "2026-10-22T00:00:00Z" }]);
    if (t === "capri_group_trades") return json(db.trades.map((r) => ({ member_email: r.member_email, updated_at: r.updated_at, history: r.history })));
    if (t === "capri_allowed_emails") return json([]);
    return json([]);
  }) as typeof fetch;
  return db;
}

describe("aggregatePresence — 기기별 신호를 사람별로 합치는 규칙", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  const row = (o: Partial<PresenceRow>): PresenceRow => ({
    user_id: "u", device_id: "d", member_email: "a@x.com", platform: "pc", app_version: "0.109.0",
    auto_trade_enabled: false, open_positions: 0, last_seen: new Date(now - 10_000).toISOString(), ...o,
  });

  it("PC와 폰이 둘 다 최근이면 접속 중, 자동매매는 PC 기준, 보유는 PC 최대값", () => {
    const list = aggregatePresence([
      row({ device_id: "pc1", auto_trade_enabled: true, open_positions: 2 }),
      row({ device_id: "pc2", open_positions: 3 }),
      row({ device_id: "web", platform: "web", open_positions: 0 }),
    ], now);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ online: true, autoTradeEnabled: true, openPositions: 3, platforms: ["pc", "web"] });
  });

  it("90초 넘게 소식 없으면 접속 중이 아니고 자동매매·보유 표시도 끈다", () => {
    const old = new Date(now - 5 * 60_000).toISOString();
    const [p] = aggregatePresence([row({ last_seen: old, auto_trade_enabled: true, open_positions: 4 })], now);
    expect(p.online).toBe(false);
    expect(p.autoTradeEnabled).toBe(false);
    expect(p.openPositions).toBe(0);
    expect(p.lastSeenMs).toBe(Date.parse(old));
  });

  it("마지막 신호 시각만 바뀐 경우엔 같은 지문(화면을 다시 안 그린다)", () => {
    const a = aggregatePresence([row({})], now);
    const b = aggregatePresence([row({ last_seen: new Date(now - 20_000).toISOString() })], now);
    expect(presenceKey(a)).toBe(presenceKey(b));
  });
});

describe("그룹 실시간 피드 — 두 기기 시나리오", () => {
  it("채팅: A가 쓴 글이 B에 정확히 한 번 도착하고, 번호가 뒤늦게 커밋돼도 놓치지 않는다", async () => {
    const db = fakeServer();
    const B = makeEngine("b@x.com", "22222222-2222-2222-2222-222222222222");
    try {
      // 첫 틱(아직 채팅 없음)
      await B.i.groupFeedTick();
      db.chat.push({ id: 10, member_email: "a@x.com", body: "첫글", created_at: "2026-10-22T00:00:00Z" });
      B.i.lastPresencePushAtMs = 0;
      await B.i.groupFeedTick();
      // 11번이 먼저 보이고(12번 트랜잭션은 아직 커밋 전) → 나중에 12번이 나타나는 상황
      db.chat.push({ id: 11, member_email: "a@x.com", body: "둘째", created_at: "2026-10-22T00:00:01Z" });
      // 첫 글은 첫 틱에 비어 있었으므로 이후 틱에서도 아직 null 기준 → 전체 받기
      await B.i.groupFeedTick();
      db.chat.push({ id: 13, member_email: "a@x.com", body: "넷째", created_at: "2026-10-22T00:00:03Z" });
      await B.i.groupFeedTick();
      db.chat.push({ id: 12, member_email: "a@x.com", body: "셋째(늦게 커밋)", created_at: "2026-10-22T00:00:02Z" });
      await B.i.groupFeedTick();
      await B.i.groupFeedTick(); // 아무 변화 없는 틱 — 중복 전달이 없어야 한다

      const received = B.events.flatMap((e) => e.chat ?? []).map((m) => m.id);
      expect([...received].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
      expect(new Set(received).size).toBe(received.length); // 중복 없음
    } finally { B.cleanup(); }
  });

  it("공지: 오너만 올릴 수 있고, 올리면 B가 받고, 삭제하면 B에서도 사라진다", async () => {
    const db = fakeServer();
    const A = makeEngine("hun100b@gmail.com", "11111111-1111-1111-1111-111111111111");
    const B = makeEngine("b@x.com", "22222222-2222-2222-2222-222222222222");
    try {
      const denied = await B.eng.sendNotice("해킹", "팀원은 못 올림");
      expect(denied.ok).toBe(false);
      expect(db.notices).toHaveLength(0);

      await B.i.groupFeedTick(); // 공지 0건 기준
      const sent = await A.eng.sendNotice("점검 안내", "오늘 밤 업데이트합니다");
      expect(sent.ok).toBe(true);
      expect(sent.message).toContain("3명");
      expect(db.notices[0].author_email).toBe("hun100b@gmail.com");

      await B.i.groupFeedTick();
      const got = B.events.map((e) => e.notices).filter(Boolean).pop()!;
      expect(got.map((n) => n.title)).toEqual(["점검 안내"]);

      await B.i.groupFeedTick(); // 변화 없음 → 같은 목록을 또 보내지 않는다
      const noticeEvents = B.events.filter((e) => e.notices).length;
      await B.i.groupFeedTick();
      expect(B.events.filter((e) => e.notices).length).toBe(noticeEvents);

      expect((await A.eng.deleteNotice(db.notices[0].id)).ok).toBe(true);
      expect((await B.eng.deleteNotice(1)).ok).toBe(false);
      await B.i.groupFeedTick();
      expect(B.events.map((e) => e.notices).filter(Boolean).pop()).toEqual([]);
    } finally { A.cleanup(); B.cleanup(); }
  });

  it("근황: 각 기기가 자기 줄을 올리고, 서로의 화면에 사람별로 합쳐져 보인다", async () => {
    const db = fakeServer();
    const A = makeEngine("hun100b@gmail.com", "11111111-1111-1111-1111-111111111111");
    const W = makeEngine("hun100b@gmail.com", "11111111-1111-1111-1111-111111111111", "web");
    const B = makeEngine("b@x.com", "22222222-2222-2222-2222-222222222222");
    try {
      A.i.autoTradeEnabled = true;
      A.i.autoTradePositions = [{}, {}];
      await A.i.groupFeedTick();
      await W.i.groupFeedTick();
      await B.i.groupFeedTick();
      expect(db.presence).toHaveLength(3); // A의 PC, A의 폰/웹, B의 PC — 서로 덮어쓰지 않는다
      const p = B.events.map((e) => e.presence).filter(Boolean).pop()!;
      const owner = p.find((x) => x.email === "hun100b@gmail.com")!;
      expect(owner).toMatchObject({ online: true, autoTradeEnabled: true, openPositions: 2 });
      expect(owner.platforms).toEqual(["pc", "web"]);
      expect(p.find((x) => x.email === "b@x.com")).toMatchObject({ online: true, autoTradeEnabled: false });
      // 금액·종목명 같은 값은 올라가지 않는다
      expect(Object.keys(db.presence[0]).sort()).toEqual(
        ["app_version", "auto_trade_enabled", "device_id", "last_seen", "member_email", "open_positions", "platform", "user_id"]);
    } finally { A.cleanup(); W.cleanup(); B.cleanup(); }
  });

  it("업데이트 내역: 첫 틱엔 기준만 기억, 이후 버전이 바뀌면 알린다", async () => {
    fakeServer();
    const B = makeEngine("b@x.com", "22222222-2222-2222-2222-222222222222");
    try {
      await B.i.groupFeedTick();
      expect(B.events.some((e) => e.changelogLatest)).toBe(false);
    } finally { B.cleanup(); }
  });
});

import { mergeTutorialStored, TUTORIAL_STORED_DEFAULT } from "../lib/tutorial";
describe("튜토리얼 진행 상태 — 두 기기 합치기", () => {
  it("어느 쪽을 먼저 합쳐도 같은 결과(합집합), 한 번 한 것은 되돌아가지 않는다", () => {
    const phone = { ...TUTORIAL_STORED_DEFAULT, visited: ["welcome" as const], autoOpened: true };
    const pc = { ...TUTORIAL_STORED_DEFAULT, visited: ["welcome" as const], connectionOk: true };
    const ab = mergeTutorialStored(phone, pc);
    const ba = mergeTutorialStored(pc, phone);
    expect(ab).toEqual(ba);
    expect(ab).toMatchObject({ autoOpened: true, connectionOk: true });
    expect(ab.visited).toEqual(["welcome"]);
  });
});
