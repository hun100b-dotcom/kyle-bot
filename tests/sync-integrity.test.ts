// =============================================================================
// tests/sync-integrity.test.ts — [v0.102.0] 맥·윈도우·폰 동기화 "데이터 오차 0" 검증
// -----------------------------------------------------------------------------
// [오너 지시] "맥·윈도우·폰이 같은 계정으로 데이터를 동기화한다 — 데이터 오차가 생기면 안 된다."
// 이 파일은 실제로 오차가 날 수 있었던 경로를 하나씩 재현하고, 고친 뒤에는 절대 안 생기는지 확인한다.
//   ① 지운 기록이 다른 기기에서 다시 살아남(삭제 부활)            → 삭제 표식(tombstone)
//   ② 옛 버전 앱이 클라우드의 삭제 표식을 지워 버려도 부활하지 않음  → 기기마다 표식을 따로 보관
//   ③ 전부 지운 상태도 다른 기기로 전달됨                          → 0건이어도 표식이 있으면 올림
//   ④ 메모 수정·진입완료 체크가 다른 기기로 넘어감                  → updatedAtMs(마지막 수정 시각)
//   ⑤ 두 기기가 '동시에' 저장해도 한쪽 기록이 사라지지 않음          → 버전 확인 후 저장(compare-and-swap)
//   ⑥ 자동매매 기록의 같은 상태 안 수정(수량·체결가 등)이 넘어감     → updatedAtMs
//   ⑦ 연말→연초를 넘어도 기록 순서·보관 한도가 꼬이지 않음           → 연도 포함 시각으로 정렬
// ⚠️ 실서버 안 건드림: Supabase 호출은 전부 메모리 가짜 클라우드가 가로챈다. 실주문 없음(forceMock).
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type AutoTradeHistoryEntry, type SavedSplit } from "../electron/tool-engine";
import { deriveDataKey, encryptJsonWithDataKey, decryptJsonAuto } from "../lib/keysync";
import { mergeTombstones, mergeSplits, TOMBSTONE_KEEP_MS } from "../lib/splits-sync";
import { mergeAutoHistory } from "../lib/auto-state-sync";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Row = { user_id: string; ciphertext: string; salt: string; iv: string; updated_at: string };
const PW = "pw-1234";
const UID = "user-1";

/** 실제 Supabase(PostgREST)처럼 동작하는 메모리 클라우드(tests/sync-all.test.ts와 같은 규칙 + 동시 저장 끼어들기 훅). */
function installFakeCloud() {
  const tables = new Map<string, Row>();
  const hooks: { beforeWrite: ((table: string) => void) | null } = { beforeWrite: null };
  let writes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    const m = url.match(/\/rest\/v1\/(capri_[a-z_]+)/);
    if (!m) return json([]);
    const table = m[1];
    const isPriv = table === "capri_trades" || table === "capri_auto_state" || table === "capri_splits";
    if (!isPriv) return method === "GET" ? json([]) : new Response(null, { status: 201 });
    if (method === "POST") {
      hooks.beforeWrite?.(table);
      const body = JSON.parse(String(init?.body ?? "{}")) as Row;
      if (tables.has(table)) return json([]); // ignore-duplicates: 이미 있으면 거절
      tables.set(table, body);
      writes++;
      return json([body], 201);
    }
    if (method === "PATCH") {
      hooks.beforeWrite?.(table);
      const row = tables.get(table);
      const ver = new URL(url).searchParams.get("updated_at");
      if (!row || (ver && ver !== `eq.${row.updated_at}`)) return json([]); // 버전 불일치 → 0줄(거절)
      const next = { ...row, ...(JSON.parse(String(init?.body ?? "{}")) as Partial<Row>) };
      tables.set(table, next);
      writes++;
      return json([next]);
    }
    const row = tables.get(table);
    if (url.includes("select=updated_at")) return json(row ? [{ updated_at: row.updated_at }] : []);
    return json(row ? [row] : []);
  }) as typeof fetch;
  return { tables, hooks, writes: () => writes };
}

/** 클라우드 줄을 직접 풀어 본다(테스트 확인용). */
async function cloudPayload<T>(cloud: ReturnType<typeof installFakeCloud>, table: string): Promise<T> {
  const row = cloud.tables.get(table)!;
  return decryptJsonAuto<T>(row, { password: PW, dataKey: await deriveDataKey(PW, UID), userId: UID });
}
/** 옛 버전 앱(또는 다른 기기)이 올린 것처럼 클라우드 줄을 직접 만든다. */
async function putCloud(cloud: ReturnType<typeof installFakeCloud>, table: string, payload: unknown, updatedAt: string) {
  const rec = (await encryptJsonWithDataKey(payload, await deriveDataKey(PW, UID))) as { ciphertext: string; salt: string; iv: string };
  cloud.tables.set(table, { user_id: UID, ...rec, updated_at: updatedAt });
}

type Internals = {
  authAccessToken: string | null; authRefreshToken: string | null; authUserId: string | null; authEmail: string | null; authExpiresAtMs: number;
  savedFills: Array<{ symbol: string; side: "BUY" | "SELL"; qty: number; price: number; atMs: number; commission: number; tax: number }>;
  autoTradeHistory: AutoTradeHistoryEntry[];
  splitsDeleted: Record<string, number>;
  syncPushTimers: Record<string, unknown>;
  adoptPassword: (pw: string) => Promise<void>;
  cloudSyncTick: () => Promise<void>;
  updateAutoTradeHistory: (symbol: string, entry: number, enteredAtMs: number, patch: Partial<AutoTradeHistoryEntry>) => void;
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function device(name: string, dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), `kyle-integrity-${name}-`));
  if (!dir) dirs.push(d);
  const eng = new ToolEngine(d, { forceMock: true, appVersion: "0.102.0" });
  const x = eng as unknown as Internals;
  x.authAccessToken = "tok"; x.authRefreshToken = "ref"; x.authUserId = UID; x.authEmail = "me@test.com"; x.authExpiresAtMs = Date.now() + 3_600_000;
  await x.adoptPassword(PW);
  return { eng, x, dir: d };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function addSplit(eng: ToolEngine, symbol: string): Promise<string> {
  await sleep(3); // id가 저장 시각(ms)이라 같은 ms에 두 개를 만들지 않게
  const list = eng.addSplit({ symbol, technique: "split3", levels: [{ level: 1, entry: 2, tp: 2.5, sl: 1.8 }], tpPct: 20, slPct: 10, qty: 1 });
  return list[0].id;
}
const symbols = (list: SavedSplit[]) => list.map((s) => s.symbol).sort();

describe("① 삭제 부활 방지 — 한 기기에서 지운 기록은 어느 기기에서도 다시 나타나지 않는다", () => {
  it("[사고 재현·수정] 맥에서 지운 기록을 아직 갖고 있는 윈도우가 동기화해도 되살아나지 않는다", async () => {
    const cloud = installFakeCloud();
    const win = await device("win");
    const mac = await device("mac");
    const a = await addSplit(win.eng, "AAA");
    await addSplit(win.eng, "BBB");
    await win.eng.syncAllNow();
    await mac.eng.syncAllNow();
    expect(symbols(mac.eng.getSplits())).toEqual(["AAA", "BBB"]);

    mac.eng.deleteSplit(a); // 맥에서 AAA 삭제
    await mac.eng.syncAllNow();
    await win.x.cloudSyncTick(); // 윈도우는 아직 AAA를 갖고 있었다 — 예전엔 여기서 AAA를 다시 올렸다
    await mac.x.cloudSyncTick();

    expect(symbols(win.eng.getSplits())).toEqual(["BBB"]);
    expect(symbols(mac.eng.getSplits())).toEqual(["BBB"]);
    const p = await cloudPayload<{ splits: SavedSplit[]; deleted: Record<string, number> }>(cloud, "capri_splits");
    expect(symbols(p.splits)).toEqual(["BBB"]);
    expect(p.deleted[a]).toBeTypeOf("number");
  }, 60_000);

  it("② 옛 버전 앱이 삭제 표식 없이 지운 기록을 다시 올려도, 표식을 기억하는 기기가 다시 지우고 표식을 되살린다", async () => {
    const cloud = installFakeCloud();
    const mac = await device("mac2");
    const a = await addSplit(mac.eng, "AAA");
    await addSplit(mac.eng, "BBB");
    await mac.eng.syncAllNow();
    const full = mac.eng.getSplits().map((s) => ({ ...s }));
    mac.eng.deleteSplit(a);
    await mac.eng.syncAllNow();
    // 옛 버전(삭제 표식을 모르는 앱)이 AAA·BBB를 표식 없이 올렸다고 가정
    await putCloud(cloud, "capri_splits", { v: 1, pushedAtMs: Date.now(), splits: full }, new Date(Date.now() + 1000).toISOString());

    await mac.x.cloudSyncTick();
    expect(symbols(mac.eng.getSplits())).toEqual(["BBB"]);
    const p = await cloudPayload<{ splits: SavedSplit[]; deleted?: Record<string, number> }>(cloud, "capri_splits");
    expect(symbols(p.splits)).toEqual(["BBB"]); // 클라우드도 바로잡혔다
    expect(p.deleted?.[a]).toBeTypeOf("number");
  }, 60_000);

  it("③ 기록을 전부 지운 상태도 다른 기기에 전달된다(예전엔 '올릴 기록 없음'으로 건너뜀)", async () => {
    installFakeCloud();
    const win = await device("win3");
    const mac = await device("mac3");
    const a = await addSplit(win.eng, "AAA");
    await win.eng.syncAllNow();
    await mac.eng.syncAllNow();
    win.eng.deleteSplit(a);
    expect(win.eng.getSplits()).toHaveLength(0);
    const r = await win.eng.syncAllNow();
    expect(r.ok).toBe(true);
    await mac.x.cloudSyncTick();
    expect(mac.eng.getSplits()).toHaveLength(0);
  }, 60_000);

  it("삭제 표식은 앱을 껐다 켜도(재시작) 남아 있다", async () => {
    installFakeCloud();
    const mac = await device("mac-restart");
    const a = await addSplit(mac.eng, "AAA");
    mac.eng.deleteSplit(a);
    await sleep(500); // 파일 저장 디바운스(300ms) 대기
    const again = await device("mac-restart-2", mac.dir);
    expect(again.x.splitsDeleted[a]).toBeTypeOf("number");
  }, 30_000);
});

describe("쓸데없는 반복 업로드 없음", () => {
  it("두 기기가 이미 같아진 뒤에는 주기 점검이 클라우드에 아무것도 다시 쓰지 않는다(핑퐁 없음)", async () => {
    const cloud = installFakeCloud();
    const win = await device("win-quiet");
    const mac = await device("mac-quiet");
    await addSplit(win.eng, "AAA");
    await addSplit(mac.eng, "BBB");
    win.x.savedFills = [{ symbol: "WIN", side: "BUY", qty: 1, price: 2, atMs: 1000, commission: 0, tax: 0 }];
    mac.x.savedFills = [{ symbol: "MAC", side: "BUY", qty: 1, price: 2, atMs: 2000, commission: 0, tax: 0 }];
    for (let i = 0; i < 2; i++) {
      await win.x.cloudSyncTick();
      await mac.x.cloudSyncTick();
    }
    expect(symbols(win.eng.getSplits())).toEqual(["AAA", "BBB"]);
    expect(symbols(mac.eng.getSplits())).toEqual(["AAA", "BBB"]);
    expect(mac.x.savedFills.map((f) => f.symbol).sort()).toEqual(["MAC", "WIN"]);
    const before = cloud.writes();
    await win.x.cloudSyncTick();
    await mac.x.cloudSyncTick();
    expect(cloud.writes()).toBe(before);
  }, 60_000);
});

describe("④ 수정 전파 — 메모·진입완료 체크가 다른 기기로 넘어간다", () => {
  it("윈도우에서 고친 제목·체크가 맥에 반영되고, 맥의 옛 값이 되돌리지 않는다", async () => {
    installFakeCloud();
    const win = await device("win4");
    const mac = await device("mac4");
    const a = await addSplit(win.eng, "AAA");
    await win.eng.syncAllNow();
    await mac.eng.syncAllNow();
    await sleep(3);
    win.eng.renameSplit(a, "윈도우에서 고친 제목");
    win.eng.toggleSplitEntered(a, 1);
    await win.eng.syncAllNow();
    await mac.eng.syncAllNow(); // 맥은 옛 값을 갖고 있다 — 예전엔 같은 ts라 무시돼 영영 안 바뀌었다
    const m = mac.eng.getSplits().find((s) => s.id === a)!;
    expect(m.memo).toBe("윈도우에서 고친 제목");
    expect(m.levels[0].entered).toBe(true);
    await win.x.cloudSyncTick();
    expect(win.eng.getSplits().find((s) => s.id === a)!.memo).toBe("윈도우에서 고친 제목");
  }, 60_000);

  it("15초 안에 두 번 고쳐도 두 번째 변경을 버리지 않고 올리기를 예약한다", async () => {
    installFakeCloud();
    const mac = await device("mac-throttle");
    const a = await addSplit(mac.eng, "AAA"); // 첫 변경 → 바로 올림
    await mac.eng.syncPushSplits();
    mac.eng.renameSplit(a, "곧바로 또 수정"); // 15초 안 → 예전엔 그냥 건너뜀
    expect(mac.x.syncPushTimers.splits).toBeTruthy();
  }, 30_000);
});

describe("⑤ 동시 저장 — 두 기기가 거의 같은 순간에 올려도 어느 쪽 기록도 사라지지 않는다", () => {
  it("클라우드가 비어 있을 때 동시에 '처음 저장'해도 둘 다 남는다", async () => {
    const cloud = installFakeCloud();
    const mac = await device("mac5");
    mac.x.savedFills = [{ symbol: "MAC", side: "BUY", qty: 1, price: 2, atMs: 2000, commission: 0, tax: 0 }];
    let fired = false;
    cloud.hooks.beforeWrite = (t) => {
      if (t !== "capri_trades" || fired) return;
      fired = true; // 맥이 저장하기 직전, 윈도우가 먼저 저장했다
      void 0;
    };
    // 윈도우가 먼저 저장한 줄을 미리 만들어 두고, 훅에서 끼워 넣는다
    const winRec = (await encryptJsonWithDataKey({ v: 1, pushedAtMs: 1, fills: [{ symbol: "WIN", side: "BUY", qty: 1, price: 2, atMs: 1000, commission: 0, tax: 0 }] }, await deriveDataKey(PW, UID))) as { ciphertext: string; salt: string; iv: string };
    cloud.hooks.beforeWrite = (t) => {
      if (t !== "capri_trades" || fired) return;
      fired = true;
      cloud.tables.set("capri_trades", { user_id: UID, ...winRec, updated_at: "2026-10-18T00:00:00.000Z" });
    };
    const r = await mac.eng.syncPushTrades();
    expect(r.ok).toBe(true);
    const p = await cloudPayload<{ fills: Array<{ symbol: string }> }>(cloud, "capri_trades");
    expect(p.fills.map((f) => f.symbol).sort()).toEqual(["MAC", "WIN"]); // 예전(통째로 덮어쓰기)이면 하나가 사라졌다
  }, 30_000);

  it("이미 줄이 있을 때, 읽은 뒤 저장 전에 다른 기기가 끼어들면 거절되고 다시 합쳐서 저장한다", async () => {
    const cloud = installFakeCloud();
    const key = await deriveDataKey(PW, UID);
    const enc = async (syms: string[]) => (await encryptJsonWithDataKey({ v: 1, pushedAtMs: 1, fills: syms.map((s, i) => ({ symbol: s, side: "BUY", qty: 1, price: 2, atMs: 1000 + i, commission: 0, tax: 0 })) }, key)) as { ciphertext: string; salt: string; iv: string };
    cloud.tables.set("capri_trades", { user_id: UID, ...(await enc(["WIN"])), updated_at: "2026-10-18T00:00:00.000Z" });
    const v2 = await enc(["WIN", "PHONE"]);
    const mac = await device("mac6");
    mac.x.savedFills = [{ symbol: "MAC", side: "BUY", qty: 1, price: 2, atMs: 5000, commission: 0, tax: 0 }];
    let fired = false;
    cloud.hooks.beforeWrite = (t) => {
      if (t !== "capri_trades" || fired) return;
      fired = true; // 맥이 v1을 읽은 뒤, 저장 직전에 폰이 v2(PHONE 추가)를 저장
      cloud.tables.set("capri_trades", { user_id: UID, ...v2, updated_at: "2026-10-18T00:00:05.000Z" });
    };
    const r = await mac.eng.syncPushTrades();
    expect(r.ok).toBe(true);
    const p = await cloudPayload<{ fills: Array<{ symbol: string }> }>(cloud, "capri_trades");
    expect(p.fills.map((f) => f.symbol).sort()).toEqual(["MAC", "PHONE", "WIN"]); // 폰 기록이 덮여 사라지지 않았다
    expect(Date.parse(cloud.tables.get("capri_trades")!.updated_at)).toBeGreaterThan(Date.parse("2026-10-18T00:00:05.000Z"));
  }, 30_000);

  it("클라우드 기록을 풀 수 없으면(다른 키) 올리기 자체를 하지 않는다 — 모르는 기록을 덮어쓰지 않음", async () => {
    const cloud = installFakeCloud();
    const other = (await encryptJsonWithDataKey({ v: 1, pushedAtMs: 1, fills: [] }, await deriveDataKey("other-password", UID))) as { ciphertext: string; salt: string; iv: string };
    cloud.tables.set("capri_trades", { user_id: UID, ...other, updated_at: "2026-10-01T00:00:00.000Z" });
    const mac = await device("mac7");
    mac.x.savedFills = [{ symbol: "MAC", side: "BUY", qty: 1, price: 2, atMs: 5000, commission: 0, tax: 0 }];
    const r = await mac.eng.syncPushTrades();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("보류");
    expect(cloud.tables.get("capri_trades")!.updated_at).toBe("2026-10-01T00:00:00.000Z");
  }, 30_000);
});

describe("⑥ 자동매매 기록 — 상태가 같아도 최신 수정이 넘어간다", () => {
  const entry = (over: Partial<AutoTradeHistoryEntry> = {}): AutoTradeHistoryEntry => ({
    id: "AAA@10@1760000000000", symbol: "AAA", entry: 10, tp: 11, sl: 9, quantity: 1, enteredAt: "10-18 10:00:00",
    status: "active", exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "", conditionalOrderId: "c1", buyOrderId: "b1", ...over,
  });

  it("윈도우에서 추가매수로 바뀐 수량이 맥에 반영되고, 맥의 옛 수량이 되돌리지 않는다", async () => {
    const cloud = installFakeCloud();
    const win = await device("win8");
    const mac = await device("mac8");
    win.x.autoTradeHistory = [entry({ updatedAtMs: 100 })];
    await win.eng.syncPushAutoState();
    await mac.eng.syncPullAutoState();
    expect(mac.x.autoTradeHistory[0].quantity).toBe(1);

    win.x.updateAutoTradeHistory("AAA", 10, 1760000000000, { quantity: 3, fillPrice: 9.95 });
    await win.eng.syncPushAutoState();
    await mac.eng.syncPushAutoState(); // 맥이 옛 값(수량 1)을 들고 올려도
    await mac.eng.syncPullAutoState();
    expect(mac.x.autoTradeHistory[0].quantity).toBe(3);
    const p = await cloudPayload<{ history: AutoTradeHistoryEntry[] }>(cloud, "capri_auto_state");
    expect(p.history[0].quantity).toBe(3); // 클라우드도 최신 유지
  }, 60_000);

  it("상태는 절대 뒤로 가지 않는다 — 수정 시각이 더 늦어도 '감시 중'이 '청산'을 이기지 못한다", () => {
    const closed = entry({ status: "closed_win", updatedAtMs: 100 });
    const laterActive = entry({ status: "active", updatedAtMs: 999 });
    expect(mergeAutoHistory([closed], [laterActive])[0].status).toBe("closed_win");
    expect(mergeAutoHistory([laterActive], [closed])[0].status).toBe("closed_win");
  });
});

describe("⑦ 연말→연초", () => {
  it("자동매매 기록은 연도까지 포함한 진입 시각으로 정렬된다(12월 기록이 1월보다 앞)", () => {
    const dec = { id: "A@1@" + Date.parse("2026-12-31T14:00:00Z"), enteredAt: "12-31 23:00:00" };
    const jan = { id: "B@1@" + Date.parse("2027-01-01T01:00:00Z"), enteredAt: "01-01 10:00:00" };
    const base = { symbol: "A", entry: 1, tp: 1, sl: 1, quantity: 1, status: "closed_win" as const, exitedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, note: "" };
    const merged = mergeAutoHistory([{ ...base, ...jan }], [{ ...base, ...dec }]);
    expect(merged.map((h) => h.id)).toEqual([dec.id, jan.id]); // 예전(문자열 정렬)이면 1월이 앞으로 가서 한도 정리 때 먼저 잘렸다
  });

  it("삼분할 기록도 연도까지 포함한 시각(id)으로 최신이 위", () => {
    const s = (id: string, ts: string) => ({ id, ts, symbol: id, technique: "split3", levels: [], tpPct: null, slPct: null, qty: null, memo: "" }) as unknown as SavedSplit;
    const dec = s(String(Date.parse("2026-12-31T14:00:00Z")), "12-31 23:00:00");
    const jan = s(String(Date.parse("2027-01-01T01:00:00Z")), "01-01 10:00:00");
    expect(mergeSplits([dec], [jan])[0].id).toBe(jan.id);
  });
});

describe("삭제 표식 합치기 규칙(순수 함수)", () => {
  it("어느 순서로 합쳐도 결과가 같고, 같은 id면 더 늦은 시각이 남는다", () => {
    const now = 1_800_000_000_000;
    const a = { x: now - 10, y: now - 5 };
    const b = { x: now - 1, z: now - 3 };
    expect(mergeTombstones(a, b, now)).toEqual(mergeTombstones(b, a, now));
    expect(mergeTombstones(a, b, now).x).toBe(now - 1);
  });
  it("아주 오래된 표식(보관 기간 초과)과 깨진 값은 정리된다", () => {
    const now = 1_800_000_000_000;
    const r = mergeTombstones({ old: now - TOMBSTONE_KEEP_MS - 1, ok: now, bad: Number.NaN }, undefined, now);
    expect(Object.keys(r)).toEqual(["ok"]);
  });
});
