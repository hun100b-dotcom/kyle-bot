// =============================================================================
// tests/sync-all.test.ts — [v0.98.0] 윈도우·맥·폰 기록 연동("받기 → 합치기 → 올리기") 검증
// -----------------------------------------------------------------------------
// [오너 보고] "맥북에서 0.97 켰는데 윈도우·폰 기록이 전혀 연동 안 돼 있다."
//   원인: 클라우드에서 '받기'는 비밀번호 로그인 순간 1회뿐이었고, 주기 동작은 '올리기'만 했다(+ 올리기는 한 줄을 통째로 덮어씀).
// 여기서는 가짜 클라우드(메모리 DB) 하나를 두 엔진("윈도우"·"맥")이 공유하게 해 실제 시나리오를 재현한다.
// ⚠️ 실서버 안 건드림: Supabase 호출은 전부 가짜 fetch가 가로챈다.
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";
import { classifyPullResult } from "../lib/sync-all";
import { deriveDataKey, encryptJsonWithDataKey } from "../lib/keysync";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Row = { user_id: string; ciphertext: string; salt: string; iv: string; updated_at: string };

/** 메모리 클라우드: capri_* 테이블마다 이 계정의 한 줄. POST=upsert, GET=그 줄(또는 빈 배열). */
function installFakeCloud() {
  const tables = new Map<string, Row>();
  const posts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    const m = url.match(/\/rest\/v1\/(capri_[a-z_]+)/);
    if (!m) return json([]);
    const table = m[1];
    if (method === "POST") {
      if (table === "capri_trades" || table === "capri_auto_state" || table === "capri_splits") {
        tables.set(table, JSON.parse(String(init?.body ?? "{}")) as Row);
        posts.push(table);
      }
      return new Response(null, { status: 201 });
    }
    const row = tables.get(table);
    if (url.includes("select=updated_at")) return json(row ? [{ updated_at: row.updated_at }] : []);
    if (table === "capri_trades" || table === "capri_auto_state" || table === "capri_splits") return json(row ? [row] : []);
    return json([]); // 그룹 공유 등은 비어 있음
  }) as typeof fetch;
  return { tables, posts };
}

type Fill = { symbol: string; side: "BUY" | "SELL"; qty: number; price: number; atMs: number; commission: number; tax: number };
type Internals = {
  authAccessToken: string | null; authRefreshToken: string | null; authUserId: string | null; authEmail: string | null; authExpiresAtMs: number;
  authDataKey: string | null; savedFills: Fill[]; autoTradeEnabled: boolean; autoTradePositions: unknown[]; autoTradeHistory: unknown[];
  adoptPassword: (pw: string) => Promise<void>;
  cloudSyncTick: () => Promise<void>;
};

const dirs: string[] = [];
function device(name: string, fills: Fill[]) {
  const dir = mkdtempSync(join(tmpdir(), `kyle-syncall-${name}-`));
  dirs.push(dir);
  const eng = new ToolEngine(dir, { forceMock: true, appVersion: "0.98.0" });
  const x = eng as unknown as Internals;
  x.authAccessToken = "tok"; x.authRefreshToken = "ref"; x.authUserId = "user-1"; x.authEmail = "me@test.com"; x.authExpiresAtMs = Date.now() + 3_600_000;
  x.savedFills = fills;
  return { eng, x };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fill = (symbol: string, atMs: number): Fill => ({ symbol, side: "BUY", qty: 1, price: 2, atMs, commission: 0, tax: 0 });

describe("classifyPullResult — 받기 결과 분류(올려도 되는지의 기준)", () => {
  it("성공은 ok", () => expect(classifyPullResult({ ok: true, message: "받았습니다" })).toBe("ok"));
  it("클라우드에 아직 없음은 empty(첫 업로드를 막으면 안 된다)", () => {
    expect(classifyPullResult({ ok: false, message: "내 계정에 저장된 매매 이력이 없습니다." })).toBe("empty");
    expect(classifyPullResult({ ok: false, message: "내 계정에 저장된 암호화 자동매매 기록이 없습니다 — 대신 그룹 공유 기록에서 0건을 보강했습니다." })).toBe("empty");
  });
  it("복호화·네트워크 실패는 fail(이때 올리면 다른 기기 기록을 덮어쓴다)", () => {
    expect(classifyPullResult({ ok: false, message: "받기 실패: 복호화 실패" })).toBe("fail");
    expect(classifyPullResult({ ok: false, message: "클라우드 조회 실패(HTTP 500)." })).toBe("fail");
  });
});

describe("윈도우 ↔ 맥 연동 (가짜 클라우드 공유)", () => {
  it("[사고 재현·수정] 맥이 전체 동기화를 누르면 윈도우 기록을 받고, 합친 결과를 올려 윈도우 기록도 지워지지 않는다", async () => {
    installFakeCloud();
    const win = device("win", [fill("WIN", 1000)]);
    const mac = device("mac", [fill("MAC", 2000)]);
    await win.x.adoptPassword("pw-1234");
    await mac.x.adoptPassword("pw-1234");

    await win.eng.syncPushAll(); // 윈도우가 먼저 올림(클라우드 = WIN)
    const r = await mac.eng.syncAllNow(); // 맥: 받기(WIN 합침) → 올리기(WIN+MAC)
    expect(r.ok).toBe(true);
    expect(mac.x.savedFills.map((f) => f.symbol).sort()).toEqual(["MAC", "WIN"]);

    // 윈도우는 수동 버튼 없이 '자동 주기'만으로 MAC 기록을 받는다
    await win.x.cloudSyncTick();
    expect(win.x.savedFills.map((f) => f.symbol).sort()).toEqual(["MAC", "WIN"]);
  }, 60_000);

  it("받기가 진짜 실패(다른 키로 잠긴 클라우드 기록)면 그 채널은 올리지 않는다 — 클라우드 기록 보존", async () => {
    const cloud = installFakeCloud();
    const mac = device("mac2", [fill("MAC", 2000)]);
    await mac.x.adoptPassword("pw-1234");
    // 다른 비밀번호에서 만든 키로 암호화된 기록이 이미 클라우드에 있음 → 이 기기 키로는 못 푼다
    const otherKey = await deriveDataKey("other-password", "user-1");
    const rec = await encryptJsonWithDataKey({ v: 1, pushedAtMs: 1, fills: [] }, otherKey);
    cloud.tables.set("capri_trades", { user_id: "user-1", ...(rec as { ciphertext: string; salt: string; iv: string }), updated_at: "2026-10-01T00:00:00.000Z" });

    const r = await mac.eng.syncAllNow();
    expect(r.ok).toBe(false);
    expect(cloud.posts).not.toContain("capri_trades"); // 덮어쓰지 않았다
    expect(cloud.tables.get("capri_trades")!.updated_at).toBe("2026-10-01T00:00:00.000Z");
    expect(r.lines.join("\n")).toContain("보류");
  }, 60_000);

  it("키가 없으면(구글 로그인 등) locked:true 로 알리고 아무것도 올리지 않는다", async () => {
    const cloud = installFakeCloud();
    const mac = device("mac3", [fill("MAC", 2000)]);
    const r = await mac.eng.syncAllNow();
    expect(r.locked).toBe(true);
    expect(r.ok).toBe(false);
    expect(cloud.posts).toHaveLength(0);
  }, 30_000);

  it("클라우드가 비어 있는 첫 동기화(빈 채널)는 막히지 않고 그대로 올라간다", async () => {
    const cloud = installFakeCloud();
    const mac = device("mac4", [fill("MAC", 2000)]);
    await mac.x.adoptPassword("pw-1234");
    const r = await mac.eng.syncAllNow();
    expect(r.ok).toBe(true);
    expect(cloud.posts).toContain("capri_trades");
  }, 30_000);
});

describe("자동매매 중인 기기 보호", () => {
  it("자동매매가 켜져 있으면 주기 받기가 '지금 감시 중' 목록을 다시 만들지 않는다(실거래 포지션 보호)", async () => {
    const cloud = installFakeCloud();
    const win = device("win5", []);
    const mac = device("mac5", []);
    await win.x.adoptPassword("pw-1234");
    await mac.x.adoptPassword("pw-1234");
    // 윈도우가 '감시 중' 기록을 올려 둠
    win.x.autoTradeHistory = [{ id: "AAA@10@1000", symbol: "AAA", entry: 10, tp: 11, sl: 9, quantity: 1, enteredAt: "2026-10-18 10:00:00", status: "active", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "", conditionalOrderId: "c1", buyOrderId: "b1" }];
    await win.eng.syncPushAll();
    expect(cloud.posts).toContain("capri_auto_state");

    const sentinel = { symbol: "KEEP" };
    mac.x.autoTradeEnabled = true; // 맥은 자동매매 가동 중
    mac.x.autoTradePositions = [sentinel];
    await mac.x.cloudSyncTick();
    expect(mac.x.autoTradeHistory).toHaveLength(1); // 기록은 합쳐지지만
    expect(mac.x.autoTradePositions).toEqual([sentinel]); // 감시 목록은 그대로
  }, 60_000);
});
