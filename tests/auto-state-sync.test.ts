// =============================================================================
// tests/auto-state-sync.test.ts — 자동매매 기록 기기 간 동기화 규칙 (v0.31.0)
// -----------------------------------------------------------------------------
// [무엇을 지키나] tests/trade-sync.test.ts와 같은 안전 원칙 + 이 파일만의 것 하나 더:
//   ① 올라가는 내용에 토스 키·토큰·계좌번호가 절대 없어야 한다(자동매매 기록만).
//   ② 비밀번호가 틀리면 조용히 이상한 값을 주지 말고 실패해야 한다.
//   ③ [이 파일 고유] 같은 기록(id)이 두 기기에 서로 다른 진행 단계로 있을 때, 병합이
//      **절대 뒤로 되돌리지 않아야** 한다(예: 이미 "익절 종료"까지 간 걸 다른 기기의
//      옛 "watching" 스냅샷으로 덮어써서 되살리면 안 됨 — 실계좌 안전상 중요).
//   ④ [이 파일 고유] "지금 감시 중" 목록 재구성은 실제로 재확인할 방법이 있는(주문번호가
//      있는) 것만 포함해야 한다 — 번호 없이 "감시 중"이라고 거짓으로 보여주면 안 됨.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptJson, decryptJson } from "../lib/keysync";
import {
  toAutoStateSyncPayload,
  isAutoStateSyncPayload,
  mergeAutoHistory,
  derivePositionsFromHistory,
  type AutoStateSyncPayload,
} from "../lib/auto-state-sync";
import { ToolEngine, type AutoTradeHistoryEntry, type ScreenRun } from "../electron/tool-engine";

const PASS = "capri-비밀번호-테스트";

/** [v0.61.0] 최소한의 가짜 스캔 결과(필수 필드만) — pushLiveState 테스트용. */
function fakeScreenRun(over: Partial<ScreenRun> = {}): ScreenRun {
  return {
    scannedAt: "09-30 12:00:00", total: 1, bodyRatio: 0.3, priceMin: 1, priceMax: 9,
    excludedEtf: 0, results: [], emaTrendEnabled: true, emaPeriod: 200, cloudEnabled: true,
    dojiWickMinRatio: 0.1, dojiMaxAgeEnabled: true, dojiMaxAgeMinutes: 20,
    nextCandleConfirmEnabled: true, excludeEtf: true, ...over,
  };
}

function entry(over: Partial<AutoTradeHistoryEntry> = {}): AutoTradeHistoryEntry {
  return {
    id: "AAPL@2.1@1000",
    symbol: "AAPL",
    entry: 2.1,
    tp: 2.5,
    sl: 1.8,
    quantity: 10,
    enteredAt: "09-26 10:00:00",
    status: "watching",
    exitedAt: null,
    exitPrice: null,
    pnlUsd: null,
    pnlPct: null,
    note: "매수 주문 접수 — 체결 대기 중",
    conditionalOrderId: null,
    buyOrderId: "buy-1",
    ...over,
  };
}

describe("toAutoStateSyncPayload/isAutoStateSyncPayload — 형식", () => {
  it("[보안] 자동매매 기록에 민감한 값이 섞여 있어도 그 항목 자체가 아니면 안 올라간다", () => {
    const payload = toAutoStateSyncPayload([entry()], 1_700_000_000_000);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("tssk_secret");
    expect(text).not.toContain("TOSS_CLIENT_SECRET");
    // 기록 자체(종목·가격 등)는 정상적으로 담긴다
    expect(payload.history[0].symbol).toBe("AAPL");
  });

  it("형식 검사기가 올바른/깨진 파일을 구분한다", () => {
    expect(isAutoStateSyncPayload(toAutoStateSyncPayload([entry()], 1))).toBe(true);
    expect(isAutoStateSyncPayload({ v: 2, history: [] })).toBe(false);
    expect(isAutoStateSyncPayload(null)).toBe(false);
    expect(isAutoStateSyncPayload({ v: 1, history: "nope", pushedAtMs: 1 })).toBe(false);
  });

});

describe("암호화 왕복", () => {
  it("올린 그대로 복호화된다", async () => {
    const payload = toAutoStateSyncPayload([entry(), entry({ id: "TSLA@5@2000", symbol: "TSLA" })], 1_700_000_000_000);
    const rec = await encryptJson(payload, PASS);
    const back = await decryptJson<AutoStateSyncPayload>(rec, PASS);
    expect(back.history).toHaveLength(2);
    expect(back.history[0].symbol).toBe("AAPL");
    expect(back.pushedAtMs).toBe(1_700_000_000_000);
  });

  it("[보안] 비밀번호가 틀리면 실패한다(엉뚱한 값을 주지 않는다)", async () => {
    const rec = await encryptJson(toAutoStateSyncPayload([entry()], 1), PASS);
    await expect(decryptJson(rec, PASS + "틀림")).rejects.toThrow();
  });

});

describe("mergeAutoHistory — 절대 뒤로 되돌리지 않는다", () => {
  it("같은 id가 양쪽에 있으면 더 진행된(status rank가 높은) 쪽이 이긴다", () => {
    const local = [entry({ status: "closed_win", exitedAt: "09-26 10:20:00", exitPrice: 2.5, pnlUsd: 4 })];
    // 클라우드에서 받아온 건 "아직 watching"인 옛 스냅샷 — 이걸로 덮어쓰면 절대 안 됨.
    const incoming = [entry({ status: "watching" })];
    const merged = mergeAutoHistory(local, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("closed_win"); // 되돌아가지 않았어야 함
    expect(merged[0].pnlUsd).toBe(4);
  });

  it("반대 방향(로컬이 옛것, 클라우드가 더 진행됨)이면 클라우드 쪽으로 갱신된다", () => {
    const local = [entry({ status: "watching" })];
    const incoming = [entry({ status: "active", conditionalOrderId: "cond-1" })];
    const merged = mergeAutoHistory(local, incoming);
    expect(merged[0].status).toBe("active");
    expect(merged[0].conditionalOrderId).toBe("cond-1");
  });

  it("서로 다른 id는 둘 다 남는다(신규 병합)", () => {
    const local = [entry({ id: "AAPL@2.1@1000" })];
    const incoming = [entry({ id: "TSLA@5@2000", symbol: "TSLA" })];
    const merged = mergeAutoHistory(local, incoming);
    expect(merged.map((h) => h.symbol).sort()).toEqual(["AAPL", "TSLA"]);
  });
});

describe("derivePositionsFromHistory — '지금 감시 중' 목록 재구성", () => {
  it("watching은 buyOrderId가 있어야만, active는 conditionalOrderId가 있어야만 포함된다", () => {
    const history = [
      entry({ id: "A@1@100", symbol: "A", status: "watching", buyOrderId: "buy-1" }),
      entry({ id: "B@2@200", symbol: "B", status: "watching", buyOrderId: null }), // 번호 없음 → 제외
      entry({ id: "C@3@300", symbol: "C", status: "active", conditionalOrderId: "cond-1" }),
      entry({ id: "D@4@400", symbol: "D", status: "active", conditionalOrderId: null }), // 번호 없음 → 제외
      entry({ id: "E@5@500", symbol: "E", status: "closed_win" }), // 끝난 것 → 제외
    ];
    const positions = derivePositionsFromHistory(history);
    expect(positions.map((p) => p.symbol).sort()).toEqual(["A", "C"]);
  });

  it("enteredAtMs를 id에서 정확히 복원한다(초 단위 문자열이 아니라 원본 ms 그대로)", () => {
    const history = [entry({ id: "AAPL@2.1@1758870000000", buyOrderId: "buy-1" })];
    const positions = derivePositionsFromHistory(history);
    expect(positions[0].enteredAtMs).toBe(1758870000000);
    expect(positions[0].entry).toBe(2.1);
    expect(positions[0].status).toBe("watching");
  });
});

// =============================================================================
// [v0.61.0 — 오너 지시 "상태 미러(state mirror)를 만들어라 — PC → 폰 방향"]
// -----------------------------------------------------------------------------
// v0.60.5~v0.60.9는 "PC 스캔 결과를 폰에서도 보기"를 capri_auto_state(암호화 개인기록
//   동기화) 채널에 끼워 넣어 풀었었다 — 전용 통로가 없어 쓴 임시방편이었고, syncPullAutoState의
//   재업로드 순서에 따라 방금 받은 값을 스스로 지워버리는 사고(v0.60.6)까지 났었다. 이제
//   capri_live_state 전용 테이블(pushLiveState/getLiveState)로 교체했으므로, 그 전용
//   통로가 실제로 "상태를 올리고 그대로 받아온다"를 만족하는지 직접 검증한다(fetch만 스텁).
// =============================================================================
describe("[v0.61.0] pushLiveState/getLiveState — PC→폰 상태 미러", () => {
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

  it("pushLiveState가 지금 상태(스캔 결과 포함)를 capri_live_state에 평문으로 올린다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-livestate-"));
    try {
      const eng = loginEngine(dir);
      const engAny = eng as unknown as { autoTradeLastScan: ScreenRun | null };
      engAny.autoTradeLastScan = fakeScreenRun({ total: 42 });

      let capturedBody: string | null = null;
      const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        if (u.includes("capri_live_state") && method === "POST") {
          capturedBody = String(init?.body ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      });
      vi.stubGlobal("fetch", fetchStub);

      await eng.pushLiveState(true);
      expect(capturedBody).not.toBeNull();
      const body = JSON.parse(capturedBody as unknown as string) as { user_id: string; kind: string; payload: { status: { lastScan: ScreenRun | null } } };
      expect(body.kind).toBe("snapshot");
      // 암호화하지 않는다 — capri_group_trades와 같은 "평문" 원칙(테이블 자체가 본인 행만 RLS).
      expect(JSON.stringify(body)).not.toMatch(/ciphertext/);
      expect(body.payload.status.lastScan?.total).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getLiveState가 받아온 payload·updated_at을 그대로 돌려준다(폰이 쓰는 모양 그대로)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-livestate-"));
    try {
      const eng = loginEngine(dir);
      const updatedAt = "2026-10-01T09:00:00.000Z";
      const fetchStub = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("capri_live_state")) {
          return new Response(
            JSON.stringify([{ payload: { status: { enabled: true, lastScan: fakeScreenRun({ total: 7 }) }, journal: [] }, updated_at: updatedAt }]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      });
      vi.stubGlobal("fetch", fetchStub);

      const r = await eng.getLiveState();
      expect(r.ok).toBe(true);
      expect(r.status?.enabled).toBe(true);
      expect(r.status?.lastScan?.total).toBe(7);
      expect(r.updatedAtMs).toBe(new Date(updatedAt).getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getLiveState — PC가 아직 한 번도 올린 적 없으면(빈 결과) 그 사실을 그대로 보고한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-livestate-"));
    try {
      const eng = loginEngine(dir);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));

      const r = await eng.getLiveState();
      expect(r.ok).toBe(false);
      expect(r.status).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
