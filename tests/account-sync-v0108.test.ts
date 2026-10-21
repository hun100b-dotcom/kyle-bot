// =============================================================================
// tests/account-sync-v0108.test.ts — [v0.108.0] "계정 기준 실시간 동기화" 두 기기(+폰) 시나리오 검증
// -----------------------------------------------------------------------------
// [오너 지시 2026-10-22] "PC에서 세팅한 값이 폰·다른 노트북에 동기화가 안 된다. 설정·자동매매 설정·스크리닝 기준·
//   매매기록·연구소·관찰 기록 … 로그인 계정 기준으로 전부 맞아야 한다. 더블 체크해라."
// 여기서는 실제 Supabase 대신 "메모리 가짜 클라우드" 하나를 두고, 윈도우 PC(A)·맥북(B)·폰(웹 W) 엔진이
//   그 클라우드를 함께 쓰게 해서 "A에서 저장 → B·폰에 그대로 보이는가"를 항목별로 확인한다.
//   가짜 클라우드는 실서버 함수(capri_sync_put)와 똑같은 규칙 — "(버전, 지문)이 더 클 때만 바꾼다" — 으로 동작한다.
// ⚠️ 실서버 안 건드림: Supabase 호출은 전부 가짜 fetch가 가로챈다.
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";

const realFetch = globalThis.fetch;
const dirs: string[] = [];
const engines: ToolEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) (e as unknown as { stopItemSync: () => void }).stopItemSync();
  globalThis.fetch = realFetch;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type ItemRow = {
  kind: string; item_id: string; rev: number; hash: string; sort_ms: number; deleted: boolean;
  payload: unknown; device_id: string | null; updated_at: string;
};

/** 테스트마다 다른 로그인 토큰 — 이전 테스트에서 남은 타이머가 이번 클라우드에 끼어들지 못하게(401로 막는다). */
let tokenSeq = 0;

/**
 * 메모리 가짜 클라우드 — 실제 Supabase(PostgREST)처럼 동작:
 *   · POST rpc/capri_sync_put      : 서버 함수와 같은 규칙((rev, hash)가 더 클 때만 반영) → { accepted: [...] }
 *   · POST rpc/capri_sync_versions : 종류별 마지막 변경 시각
 *   · GET  capri_sync_items         : kind=in.(..) · updated_at=gte. · order · limit/offset
 *   · DELETE capri_sync_items       : 오래된 줄 정리(sort_ms < X, 삭제 표식 아닌 것)
 *   · capri_live_state(snapshot)·capri_desktop_heartbeat GET/POST
 */
function installFakeCloud(token: string) {
  const items = new Map<string, ItemRow>();
  let clock = Date.now();
  const stamp = () => new Date(++clock).toISOString(); // 서버 시각(쓸 때마다 1ms씩 증가 — 순서가 항상 분명)
  const state: {
    snapshot: Record<string, unknown> | null;
    snapshotPosts: number;
    heartbeat: { device_id: string | null; last_seen: string; auto_trade_enabled: boolean } | null;
    commands: Array<{ id: string; type: string; payload: Record<string, unknown>; created_at: string; status: string }>;
  } = { snapshot: null, snapshotPosts: 0, heartbeat: null, commands: [] };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    if (auth !== `Bearer ${token}`) return json({ message: "JWT expired" }, 401);
    const path = url.pathname;
    if (path.endsWith("/rpc/capri_sync_put")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { p_kind: string; p_items: Array<{ id: string; rev: number; hash: string; sort?: number; deleted?: boolean; payload?: unknown; device?: string }> };
      const accepted: string[] = [];
      for (const it of body.p_items) {
        const key = `${body.p_kind}|${it.id}`;
        const cur = items.get(key);
        // 서버 규칙: (t.rev, t.hash) < (excluded.rev, excluded.hash) 일 때만 바꾼다
        const newer = !cur || cur.rev < it.rev || (cur.rev === it.rev && cur.hash < (it.hash ?? ""));
        if (!newer) continue;
        items.set(key, {
          kind: body.p_kind, item_id: it.id, rev: it.rev, hash: it.hash ?? "", sort_ms: it.sort ?? 0, deleted: !!it.deleted,
          payload: it.deleted ? null : JSON.parse(JSON.stringify(it.payload ?? null)), device_id: it.device ?? null, updated_at: stamp(),
        });
        accepted.push(it.id);
      }
      return json({ accepted });
    }
    if (path.endsWith("/rpc/capri_sync_versions")) {
      let max: string | null = null;
      for (const r of items.values()) if (!max || r.updated_at > max) max = r.updated_at;
      return json({ items: max, trades: null, autoState: null, splits: null, paper: null });
    }
    if (path.endsWith("/capri_sync_items")) {
      const kindQ = url.searchParams.get("kind") ?? "";
      if (method === "DELETE") {
        const kind = kindQ.replace(/^eq\./, "");
        const lt = Number((url.searchParams.get("sort_ms") ?? "lt.0").replace(/^lt\./, ""));
        for (const [k, r] of items) if (r.kind === kind && !r.deleted && r.sort_ms < lt) items.delete(k);
        return new Response(null, { status: 204 });
      }
      const kinds = kindQ.startsWith("in.(") ? kindQ.slice(4, -1).split(",") : null;
      const since = (url.searchParams.get("updated_at") ?? "").replace(/^gte\./, "") || null;
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const rows = [...items.values()]
        .filter((r) => (!kinds || kinds.includes(r.kind)) && (!since || r.updated_at >= since))
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.item_id < b.item_id ? -1 : 1))
        .slice(offset, offset + limit);
      return json(JSON.parse(JSON.stringify(rows)));
    }
    if (path.endsWith("/capri_live_state")) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { kind?: string };
        if (body.kind === "snapshot") state.snapshotPosts++;
        return new Response(null, { status: 201 });
      }
      if (url.searchParams.get("kind") === "eq.snapshot") {
        return json(state.snapshot ? [{ payload: { settings: state.snapshot }, updated_at: new Date().toISOString() }] : []);
      }
      return json([]);
    }
    if (path.endsWith("/capri_desktop_heartbeat")) {
      if (method === "POST") {
        const b = JSON.parse(String(init?.body ?? "{}")) as { device_id?: string; last_seen: string; auto_trade_enabled: boolean };
        state.heartbeat = { device_id: b.device_id ?? null, last_seen: b.last_seen, auto_trade_enabled: !!b.auto_trade_enabled };
        return new Response(null, { status: 201 });
      }
      return json(state.heartbeat ? [state.heartbeat] : []);
    }
    if (path.endsWith("/capri_commands")) {
      if (method === "PATCH") {
        const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
        const c = state.commands.find((x) => x.id === id);
        const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string };
        if (!c) return json([]);
        if (url.searchParams.get("status") === "eq.pending" && c.status !== "pending") return json([]);
        if (body.status) c.status = body.status;
        return json([c]);
      }
      return json(state.commands.filter((c) => c.status === "pending"));
    }
    return json([]);
  }) as typeof fetch;
  return { items, state };
}

type Internals = {
  authAccessToken: string | null; authRefreshToken: string | null; authUserId: string | null; authEmail: string | null; authExpiresAtMs: number;
  paperDeviceId: string;
  labSignals: Array<Record<string, unknown>>;
  watchHistory: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  autoRuns: Array<Record<string, unknown>>;
  currentAutoRun: Record<string, unknown> | null;
  rationales: Array<Record<string, unknown>>;
  autoTradeEnabled: boolean;
  remoteControlTimer: unknown;
  syncedSettings: () => Array<{ env: string; get: () => string }>;
  checkPrimary: (token: string) => Promise<boolean>;
  claimAndExecuteCommand: (token: string, row: { id: string; type: string; payload: Record<string, unknown>; created_at?: string }) => Promise<void>;
  liveSyncTick: () => Promise<void>;
  persistLab: () => void;
  persistWatchHistory: () => void;
  persistTrades: () => void;
  persistAutoRuns: () => void;
  stopItemSync: () => void;
};
const I = (e: ToolEngine) => e as unknown as Internals;

/** 기기 하나 만들기(같은 계정으로 로그인한 상태). dir을 주면 같은 폴더로 "다시 켜기"를 재현한다. */
function device(token: string, opts?: { role?: "desktop" | "web"; dir?: string }): ToolEngine {
  const dir = opts?.dir ?? mkdtempSync(join(tmpdir(), "kb-acct-"));
  if (!opts?.dir) dirs.push(dir);
  const e = new ToolEngine(dir, { forceMock: true, role: opts?.role ?? "desktop" });
  const x = I(e);
  x.authAccessToken = token;
  x.authRefreshToken = "refresh";
  x.authUserId = "user-1";
  x.authEmail = "owner@example.com";
  x.authExpiresAtMs = Date.now() + 3_600_000;
  engines.push(e);
  return e;
}

const settingsOf = (e: ToolEngine) => Object.fromEntries(I(e).syncedSettings().map((s) => [s.env, s.get()]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sync = async (...es: ToolEngine[]) => {
  for (const e of es) {
    const r = await e.itemSyncNow();
    expect(r.ok, r.message).toBe(true);
  }
};

describe("[v0.108.0] 설정 — 자동매매·스크리닝·시드·가드 전부 계정 기준", () => {
  it("PC(A)에서 바꾼 설정이 노트북(B)·폰(W)에 그대로 — 동기화되는 모든 설정 칸이 세 기기에서 1:1 일치", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    await sync(A);
    A.saveAutoTradeSettings({ maxPositions: 7, maxLossPct: 4.5, maxInvestPct: 33, watchMinutes: 9, entryLevel: 1.5, slMode: "ema", lossStreakLimit: 4 });
    A.saveAutoScanSettings({ count: 150, priceMin: 1.5, priceMax: 42, bodyRatio: 0.3 } as Parameters<ToolEngine["saveAutoScanSettings"]>[0]);
    A.saveSystemPauseEnabled(false);
    await sync(A);

    const B = device(tok);
    const W = device(tok, { role: "web" });
    await sync(B, W);
    const s = A.getSettings();
    expect(s.autoTradeMaxPositions).toBe(7);
    for (const other of [B, W]) {
      const o = other.getSettings();
      expect(o.autoTradeMaxPositions).toBe(7);
      expect(o.autoTradeMaxLossPct).toBe(4.5);
      expect(o.autoTradeMaxInvestPct).toBe(33);
      expect(o.autoTradeWatchMinutes).toBe(9);
      expect(o.autoTradeEntryLevel).toBe(1.5);
      expect(o.autoTradeSlMode).toBe("ema");
      expect(o.autoScanCount).toBe(150);
      expect(o.autoScanPriceMax).toBe(42);
      // 더블 체크: 동기화 대상 설정 전부(약 50개)가 글자 하나까지 같다
      expect(settingsOf(other)).toEqual(settingsOf(A));
    }
    // 받은 값은 그 기기 .env에도 저장된다(다음 실행에도 유지)
    const envB = readFileSync(join((B as unknown as { userDataDir: string }).userDataDir, ".env"), "utf8");
    expect(envB).toMatch(/AUTO_MAX_POSITIONS=7|AUTO_TRADE_MAX_POSITIONS=7|MAX_POSITIONS=7/);
  });

  it("폰(W)에서 바꾼 스크리닝 기준이 PC(A)에 반영된다 (폰→PC 방향)", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const W = device(tok, { role: "web" });
    await sync(A, W);
    W.saveAutoScanSettings({ count: 77, priceMax: 19 } as Parameters<ToolEngine["saveAutoScanSettings"]>[0]);
    W.saveAutoTradeSettings({ maxPositions: 2 });
    await sync(W, A);
    expect(A.getSettings().autoScanCount).toBe(77);
    expect(A.getSettings().autoScanPriceMax).toBe(19);
    expect(A.getSettings().autoTradeMaxPositions).toBe(2);
    expect(settingsOf(A)).toEqual(settingsOf(W));
  });

  it("두 기기가 거의 동시에 같은 칸을 고치면 '나중에 고친 쪽'으로 모두 수렴(올리는 순서와 무관)", async () => {
    for (const order of ["AB", "BA"] as const) {
      const tok = `tok-${++tokenSeq}`;
      installFakeCloud(tok);
      const A = device(tok);
      const B = device(tok);
      await sync(A, B);
      A.saveAutoTradeSettings({ maxPositions: 4 }); // 먼저 고침
      await sleep(5);
      B.saveAutoTradeSettings({ maxPositions: 6 }); // 나중에 고침 → 이게 정답
      if (order === "AB") await sync(A, B, A);
      else await sync(B, A, B);
      expect(A.getSettings().autoTradeMaxPositions).toBe(6);
      expect(B.getSettings().autoTradeMaxPositions).toBe(6);
      expect(settingsOf(A)).toEqual(settingsOf(B));
    }
  });

  it("고친 직후(올리기 전)에 받기가 먼저 돌아도 방금 고친 값이 옛 값에 덮이지 않는다", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const B = device(tok);
    await sync(A, B);
    B.saveAutoTradeSettings({ maxPositions: 3 });
    await sync(B);
    await sleep(5);
    A.saveAutoTradeSettings({ maxPositions: 8 }); // A가 더 나중에 고쳤지만 아직 안 올림
    await sync(A); // A: 받기(B의 3) → 올리기 — A의 8이 이겨야 한다
    await sync(B);
    expect(A.getSettings().autoTradeMaxPositions).toBe(8);
    expect(B.getSettings().autoTradeMaxPositions).toBe(8);
  });

  it("[처음 맞추기] 직접 바꾼 값이 공장 기본값을 이긴다 — 기본값 기기가 먼저 올라가도", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const fresh = device(tok); // 기본값 그대로인 노트북
    const pcDir = mkdtempSync(join(tmpdir(), "kb-acct-"));
    dirs.push(pcDir);
    // 이 기능 이전부터 PC에서 쓰던 값(로그인 전 = 동기화 이전에 저장된 값)
    const pre = new ToolEngine(pcDir, { forceMock: true });
    pre.saveAutoTradeSettings({ maxPositions: 5, maxLossPct: 2.5 });
    const PC = device(tok, { dir: pcDir });
    expect(PC.getSettings().autoTradeMaxPositions).toBe(5);
    await sync(fresh); // 기본값(옛 버전 1)이 먼저 클라우드에
    await sync(PC); // 직접 바꾼 값(옛 버전 2)이 이긴다
    await sync(fresh);
    expect(fresh.getSettings().autoTradeMaxPositions).toBe(5);
    expect(fresh.getSettings().autoTradeMaxLossPct).toBe(2.5);
    expect(settingsOf(fresh)).toEqual(settingsOf(PC));
  });

  it("[처음 맞추기] 계정에 설정이 하나도 없으면 대표 PC가 올려 둔 상태 사진의 값을 이어받는다(폰이 먼저 업데이트돼도 PC 값 유지)", async () => {
    const tok = `tok-${++tokenSeq}`;
    const cloud = installFakeCloud(tok);
    // 대표 PC(옛 버전 앱)가 올려 둔 상태 사진 속 설정
    const ref = device(tok);
    ref.saveAutoTradeSettings({ maxPositions: 9, maxInvestPct: 44 });
    cloud.state.snapshot = ref.getSettings() as unknown as Record<string, unknown>;
    const W = device(tok, { role: "web" });
    await sync(W);
    expect(W.getSettings().autoTradeMaxPositions).toBe(9);
    expect(W.getSettings().autoTradeMaxInvestPct).toBe(44);
    const B = device(tok);
    await sync(B);
    expect(B.getSettings().autoTradeMaxPositions).toBe(9);
    expect(settingsOf(B)).toEqual(settingsOf(W));
  });

  it("오래 묵은 '설정 저장' 원격 명령은 실행하지 않는다(그 사이 다른 기기에서 고친 새 값을 되돌리지 않게) — 방금 보낸 명령은 실행", async () => {
    const tok = `tok-${++tokenSeq}`;
    const cloud = installFakeCloud(tok);
    const A = device(tok);
    await sync(A);
    A.saveAutoTradeSettings({ maxPositions: 6 });
    const old = { id: "c1", type: "saveAutoTradeSettings", payload: { maxPositions: 2 }, created_at: new Date(Date.now() - 10 * 60_000).toISOString(), status: "pending" };
    cloud.state.commands.push(old);
    await I(A).claimAndExecuteCommand(tok, old);
    expect(A.getSettings().autoTradeMaxPositions).toBe(6);
    const fresh = { id: "c2", type: "saveAutoTradeSettings", payload: { maxPositions: 3 }, created_at: new Date().toISOString(), status: "pending" };
    cloud.state.commands.push(fresh);
    await I(A).claimAndExecuteCommand(tok, fresh);
    expect(A.getSettings().autoTradeMaxPositions).toBe(3);
  });
});

describe("[v0.108.0] 기록 — 연구소·관찰·트레이드·매매근거·실행 기록·화면 설정", () => {
  const sig = (id: string, c2T: number, extra: Record<string, unknown> = {}) => ({ id, symbol: id.split(":")[0], rank: 1, detectedAtMs: c2T, backfilled: false, c2T, linkageDone: false, complete: false, ...extra });

  it("매매연구소 신호: A 수집분이 B·폰에 / A에서 갱신(확정)도 반영 / 초기화하면 모든 기기에서 지워지고 되살아나지 않는다", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const B = device(tok);
    const W = device(tok, { role: "web" });
    await sync(A, B);
    const t = Date.now();
    I(A).labSignals = [sig("AAPL:1", t - 3000), sig("TSLA:2", t - 2000), sig("NVDA:3", t - 1000)];
    I(A).persistLab();
    await sync(A, B);
    expect(I(B).labSignals.map((s) => s.id)).toEqual(["AAPL:1", "TSLA:2", "NVDA:3"]);
    // 폰은 연구소 화면을 열 때 받는다
    W.getLabSummary();
    await sleep(50);
    await sync(W);
    expect(I(W).labSignals.map((s) => s.id).sort()).toEqual(["AAPL:1", "NVDA:3", "TSLA:2"]);
    // 갱신: 관찰 종료(complete)
    I(A).labSignals = I(A).labSignals.map((s) => (s.id === "TSLA:2" ? { ...s, linkageDone: true, complete: true } : s));
    I(A).persistLab();
    await sync(A, B, W);
    expect(I(B).labSignals.find((s) => s.id === "TSLA:2")?.complete).toBe(true);
    expect(I(W).labSignals.find((s) => s.id === "TSLA:2")?.complete).toBe(true);
    // 초기화
    A.labReset();
    await sync(A, B, W, B, A);
    expect(I(A).labSignals).toEqual([]);
    expect(I(B).labSignals).toEqual([]);
    expect(I(W).labSignals).toEqual([]);
  });

  it("관찰 기록: PC(A)의 관찰 이력이 폰(W) 관찰기록 탭에 보인다 + 결말(확정) 갱신도 반영", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const W = device(tok, { role: "web" });
    await sync(A, W);
    const t = Date.now();
    const h = (sym: string, at: number, outcome: string) => ({ id: `${sym}:${at}`, symbol: sym, watchedAtMs: at, watchedPrice: 1, lastSeenAtMs: at, resolvedAtMs: outcome === "watching" ? null : at, outcome, reasons: [], reasonBuckets: [] });
    I(A).watchHistory = [h("AAA", t - 2000, "watching"), h("BBB", t - 1000, "disqualified")];
    I(A).persistWatchHistory();
    await sync(A, W);
    expect(W.getWatchHistory().map((x) => x.symbol).sort()).toEqual(["AAA", "BBB"]);
    I(A).watchHistory = I(A).watchHistory.map((x) => (x.symbol === "AAA" ? { ...x, outcome: "confirmed", resolvedAtMs: t } : x));
    I(A).persistWatchHistory();
    await sync(A, W);
    expect(W.getWatchHistory().find((x) => x.symbol === "AAA")?.outcome).toBe("confirmed");
  });

  it("트레이드 기록: 추가는 양쪽에 합쳐지고(합집합), 한 기기에서 지우면 다른 기기에서도 지워진 채 유지", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const B = device(tok);
    await sync(A, B);
    const tr = (id: string, at: number) => ({ id, symbol: "AAPL", mode: "dryrun", entryTs: "10-21 10:00:00", entryPrice: 10, entry: null, exitTs: null, exitPrice: null, exit: null, exitKind: null, resultPct: null, outcome: null, entryAtMs: at });
    I(A).trades = [tr("t1", Date.now() - 2000)];
    I(A).persistTrades();
    I(B).trades = [tr("t2", Date.now() - 1000)];
    I(B).persistTrades();
    await sync(A, B, A);
    expect(A.getTradeLog().map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(B.getTradeLog().map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    B.deleteTrade("t1");
    await sync(B, A, B, A);
    expect(A.getTradeLog().map((t) => t.id)).toEqual(["t2"]);
    expect(B.getTradeLog().map((t) => t.id)).toEqual(["t2"]);
  });

  it("자동매매 실행 기록: A가 진행 중인 실행이 B에 보이고, B를 껐다 켜도 B가 A의 실행을 '앱 종료'로 닫지 않는다", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const bDir = mkdtempSync(join(tmpdir(), "kb-acct-"));
    dirs.push(bDir);
    const B = device(tok, { dir: bDir });
    await sync(A, B);
    const now = Date.now();
    const run = { id: "run-A", deviceId: I(A).paperDeviceId, startedAtMs: now - 60_000, lastActiveAtMs: now, endedAtMs: null, loopCount: 3, scanCount: 2, endReason: null, startAssetsUsd: null, commissionRate: null, carriedPositions: 0, openPositions: [], errors: {} };
    I(A).autoRuns = [run];
    I(A).currentAutoRun = run;
    I(A).persistAutoRuns();
    await sync(A, B);
    expect(I(B).autoRuns.map((r) => r.id)).toEqual(["run-A"]);
    B.flushAllFileSavesSync();
    const B2 = device(tok, { dir: bDir }); // B 재시작
    expect(I(B2).autoRuns.find((r) => r.id === "run-A")?.endedAtMs).toBeNull();
  });

  it("매매 근거·화면 설정(탭 순서)도 계정 기준으로 맞춰진다", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const W = device(tok, { role: "web" });
    await sync(A, W);
    I(A).rationales = [{ clientOrderId: "co-1", ts: "10-21 10:00:00", kind: "entry", symbol: "AAPL", technique: "split", atMs: Date.now() }];
    // 근거는 saveRationale 경로에서 markDirty — 여기서는 동기화 버튼(itemSyncNow)이 바뀐 것을 찾아 올리는지 확인
    A.setUiPref("tab:mainTabs", JSON.stringify(["auto", "lab", "calc"]));
    await sync(A, W);
    expect(I(W).rationales.map((r) => r.clientOrderId)).toEqual(["co-1"]);
    expect(W.getUiPref("tab:mainTabs")).toBe(JSON.stringify(["auto", "lab", "calc"]));
  });
});

describe("[v0.108.0] 실시간 반영·대표 PC", () => {
  it("10초 신호 확인(liveSyncTick): 다른 기기가 바꾸면 다음 확인에서 바로 받아 온다", async () => {
    const tok = `tok-${++tokenSeq}`;
    installFakeCloud(tok);
    const A = device(tok);
    const B = device(tok);
    await sync(A, B);
    await I(B).liveSyncTick(); // 기준 시각만 기억
    A.saveAutoTradeSettings({ maxPositions: 5 });
    await sync(A);
    await I(B).liveSyncTick();
    expect(B.getSettings().autoTradeMaxPositions).toBe(5);
  });

  it("PC 두 대: 대표 PC(자동매매 중)만 상태 사진을 올리고, 다른 PC·폰은 올리지 않는다(폰 화면이 오락가락하지 않게)", async () => {
    const tok = `tok-${++tokenSeq}`;
    const cloud = installFakeCloud(tok);
    const A = device(tok);
    const B = device(tok);
    const W = device(tok, { role: "web" });
    I(A).autoTradeEnabled = true;
    expect(await I(A).checkPrimary(tok)).toBe(true);
    cloud.state.heartbeat = { device_id: I(A).paperDeviceId, last_seen: new Date().toISOString(), auto_trade_enabled: true };
    expect(await I(B).checkPrimary(tok)).toBe(false);
    I(A).remoteControlTimer = 1;
    I(B).remoteControlTimer = 1;
    await A.pushLiveState(true);
    const afterA = cloud.state.snapshotPosts;
    expect(afterA).toBe(1);
    await B.pushLiveState(true);
    await W.pushLiveState(true);
    expect(cloud.state.snapshotPosts).toBe(afterA);
    // 대표 PC가 꺼져 45초 넘게 소식이 없으면 B가 이어받는다
    cloud.state.heartbeat = { device_id: I(A).paperDeviceId, last_seen: new Date(Date.now() - 60_000).toISOString(), auto_trade_enabled: true };
    expect(await I(B).checkPrimary(tok)).toBe(true);
    I(A).remoteControlTimer = null;
    I(B).remoteControlTimer = null;
  });
});
