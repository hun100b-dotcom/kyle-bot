// =============================================================================
// tests/splits-sync.test.ts — 삼분할 타점 기록 기기 간 동기화 규칙 (v0.61.7)
// -----------------------------------------------------------------------------
// [무엇을 지키나] tests/trade-sync.test.ts와 같은 안전 원칙:
//   ① 올라가는 내용에 토스 키·토큰 등 민감한 값이 없어야 한다(기록 자체만).
//   ② 비밀번호가 틀리면 조용히 이상한 값을 주지 말고 실패해야 한다.
//   ③ [이 파일 고유] 같은 id(기록)가 두 기기에 있으면 더 최근(ts)에 손댄 쪽이 이겨야
//      한다 — 오래된 쪽이 최신 메모·체크 상태를 덮어쓰면 안 된다.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptJson, decryptJson } from "../lib/keysync";
import { toSplitsSyncPayload, isSplitsSyncPayload, mergeSplits, type SplitsSyncPayload } from "../lib/splits-sync";
import { ToolEngine, type SavedSplit } from "../electron/tool-engine";

const PASS = "capri-비밀번호-테스트";

function split(over: Partial<SavedSplit> = {}): SavedSplit {
  return {
    id: "1700000000000",
    ts: "09-26 10:00:00",
    symbol: "AAPL",
    technique: "split3",
    levels: [
      { level: 1, entry: 2.1, tp: 2.5, sl: 1.8, entered: false },
      { level: 2, entry: 2.0, tp: 2.5, sl: 1.8, entered: false },
      { level: 3, entry: 1.9, tp: 2.5, sl: 1.8, entered: false },
    ],
    tpPct: 20,
    slPct: 10,
    qty: 10,
    memo: "",
    ...over,
  };
}

describe("toSplitsSyncPayload/isSplitsSyncPayload — 형식", () => {
  it("[보안] 민감한 값이 섞여 있어도 그 항목 자체가 아니면 안 올라간다", () => {
    const dirty = { ...split(), clientSecret: "tssk_secret_xxx" } as unknown as SavedSplit;
    const payload = toSplitsSyncPayload([dirty], 1_700_000_000_000);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("tssk_secret_xxx");
    expect(payload.splits[0].symbol).toBe("AAPL");
  });

  it("형식 검사기가 올바른/깨진 파일을 구분한다", () => {
    expect(isSplitsSyncPayload(toSplitsSyncPayload([split()], 1))).toBe(true);
    expect(isSplitsSyncPayload({ v: 2, splits: [] })).toBe(false);
    expect(isSplitsSyncPayload(null)).toBe(false);
    expect(isSplitsSyncPayload({ v: 1, splits: "nope", pushedAtMs: 1 })).toBe(false);
  });
});

describe("암호화 왕복", () => {
  it("올린 그대로 복호화된다", async () => {
    const payload = toSplitsSyncPayload([split(), split({ id: "2", symbol: "TSLA" })], 1_700_000_000_000);
    const rec = await encryptJson(payload, PASS);
    const back = await decryptJson<SplitsSyncPayload>(rec, PASS);
    expect(back.splits).toHaveLength(2);
    expect(back.splits[0].symbol).toBe("AAPL");
  });

  it("[보안] 비밀번호가 틀리면 실패한다(엉뚱한 값을 주지 않는다)", async () => {
    const rec = await encryptJson(toSplitsSyncPayload([split()], 1), PASS);
    await expect(decryptJson(rec, PASS + "틀림")).rejects.toThrow();
  });
});

describe("mergeSplits — 더 최근(ts)에 손댄 쪽이 이긴다", () => {
  it("같은 id가 양쪽에 있으면 ts가 더 최근인 쪽(메모·체크 상태)이 남는다", () => {
    const local = [split({ memo: "옛 메모", ts: "09-26 10:00:00" })];
    const incoming = [split({ memo: "새 메모(다른 기기에서 수정)", ts: "09-26 12:00:00" })];
    const merged = mergeSplits(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].memo).toBe("새 메모(다른 기기에서 수정)");
  });

  it("반대 방향(로컬이 더 최근)이면 로컬 쪽이 유지된다", () => {
    const local = [split({ memo: "로컬에서 방금 수정", ts: "09-26 15:00:00" })];
    const incoming = [split({ memo: "클라우드의 옛 값", ts: "09-26 10:00:00" })];
    const merged = mergeSplits(local, incoming);
    expect(merged[0].memo).toBe("로컬에서 방금 수정");
  });

  it("서로 다른 id는 둘 다 남는다(신규 병합)", () => {
    const local = [split({ id: "1" })];
    const incoming = [split({ id: "2", symbol: "TSLA" })];
    const merged = mergeSplits(local, incoming);
    expect(merged.map((s) => s.symbol).sort()).toEqual(["AAPL", "TSLA"]);
  });

  it("최신(ts)이 맨 위로 정렬된다(기존 화면 정렬과 동일)", () => {
    const local = [split({ id: "1", ts: "09-26 10:00:00" })];
    const incoming = [split({ id: "2", symbol: "TSLA", ts: "09-26 12:00:00" })];
    const merged = mergeSplits(local, incoming);
    expect(merged[0].symbol).toBe("TSLA");
  });
});

// =============================================================================
// [v0.61.7] ToolEngine.syncPushSplits/syncPullSplits — 새 capri_splits 테이블 배선 검증
//   (fetch만 스텁 — 실제 Supabase는 안 쓴다, auto-state-sync.test.ts와 동일 패턴).
// =============================================================================
describe("[v0.61.7] ToolEngine.syncPushSplits/syncPullSplits — capri_splits 배선", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function loginEngine(dir: string): ToolEngine {
    const eng = new ToolEngine(dir, { forceMock: true });
    const engAny = eng as unknown as {
      authAccessToken: string | null;
      authExpiresAtMs: number;
      authUserId: string | null;
      authPassword: string | null;
    };
    engAny.authAccessToken = "test-access-token";
    engAny.authExpiresAtMs = Date.now() + 3_600_000;
    engAny.authUserId = "test-user-id";
    engAny.authPassword = PASS;
    return eng;
  }

  it("syncPushSplits가 capri_splits에 암호화해 올린다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-splitssync-"));
    try {
      const eng = loginEngine(dir);
      eng.addSplit({ symbol: "AAPL", technique: "split3", levels: [{ level: 1, entry: 2, tp: 2.5, sl: 1.8 }], tpPct: 20, slPct: 10, qty: 10 });

      let capturedUrl = "";
      let capturedBody: string | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          const u = String(url);
          const method = init?.method ?? "GET";
          if (u.includes("capri_splits") && method === "POST") {
            capturedUrl = u;
            capturedBody = String(init?.body ?? "");
            return new Response(null, { status: 200 });
          }
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }),
      );

      const r = await eng.syncPushSplits();
      expect(r.ok).toBe(true);
      expect(capturedUrl).toContain("capri_splits?on_conflict=user_id");
      expect(capturedBody).not.toBeNull();
      const body = JSON.parse(capturedBody as unknown as string) as { ciphertext: string };
      expect(JSON.stringify(body)).not.toMatch(/AAPL/); // 암호화됐으니 평문 종목코드가 그대로 보이면 안 됨
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncPullSplits가 받아온 걸 복호화해 병합한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-splitssync-"));
    try {
      const eng = loginEngine(dir);
      const cloudPayload = toSplitsSyncPayload([split({ id: "cloud-1", symbol: "MSFT" })], Date.now());
      const cloudRec = await encryptJson(cloudPayload, PASS);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const u = String(url);
          if (u.includes("capri_splits")) {
            return new Response(JSON.stringify([{ ciphertext: cloudRec.ciphertext, salt: cloudRec.salt, iv: cloudRec.iv }]), { status: 200 });
          }
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }),
      );

      const r = await eng.syncPullSplits();
      expect(r.ok).toBe(true);
      expect(eng.getSplits().some((s) => s.symbol === "MSFT")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
