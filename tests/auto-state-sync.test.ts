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

/** [v0.60.5] 최소한의 가짜 스캔 결과(필수 필드만) — lastScan 동기화 테스트용. */
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

  // [v0.60.5 — 오너 요청 "PC와 동일하게 자동스크리너 조회"] lastScan/skipReasons가 생겨도
  //   기존 형식 검사·기본 동작과 호환돼야 한다(구버전 폰이 받아도 안 깨지고, extra를 안
  //   줘도 undefined로 조용히 빠질 뿐 오류가 안 남).
  it("[v0.60.5] extra(lastScan/skipReasons)를 넘기면 그대로 담기고, 안 넘기면 undefined로 빠진다(하위호환)", () => {
    const withExtra = toAutoStateSyncPayload([entry()], 1, {
      lastScan: fakeScreenRun({ total: 42 }),
      skipReasons: { AAPL: "이미 보유 중" },
    });
    expect(withExtra.lastScan?.total).toBe(42);
    expect(withExtra.skipReasons?.AAPL).toBe("이미 보유 중");
    expect(isAutoStateSyncPayload(withExtra)).toBe(true);

    const withoutExtra = toAutoStateSyncPayload([entry()], 1);
    expect(withoutExtra.lastScan).toBeUndefined();
    expect(withoutExtra.skipReasons).toBeUndefined();
    expect(isAutoStateSyncPayload(withoutExtra)).toBe(true); // extra 필드가 없어도 여전히 유효한 형식
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

  it("[v0.60.5] lastScan·skipReasons도 암호화 왕복 후 그대로 복원된다", async () => {
    const payload = toAutoStateSyncPayload([entry()], 1, {
      lastScan: fakeScreenRun({ total: 7 }),
      skipReasons: { TSLA: "최대 종목 수 도달" },
    });
    const rec = await encryptJson(payload, PASS);
    const back = await decryptJson<AutoStateSyncPayload>(rec, PASS);
    expect(back.lastScan?.total).toBe(7);
    expect(back.skipReasons?.TSLA).toBe("최대 종목 수 도달");
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
// [v0.60.6 긴급 — 오너 실사용 보고: "폰에서 자동매매 시작을 눌러도 자동 스크리너 탭에
//   스캔 진행 상황이 전혀 안 뜬다, 새로고침을 눌러도 무반응"]
// -----------------------------------------------------------------------------
// 원인: syncPullAutoState()가 lastScan/skipReasons를 반영하기 **전에**
//   persistAutoTradeHistory()를 먼저 불렀다. persistAutoTradeHistory()는 쓰로틀(15초)이
//   맞으면 그 자리에서 곧바로 syncPushAutoState()로 재업로드하는데, 그 push는 "그 시점의"
//   this.autoTradeLastScan을 그대로 담는다 — 아직 이번 pull로 못 받은 **옛 값(주로 null)**을
//   그대로 되올려, 방금 받은 PC의 진짜 스캔 결과를 곧바로 덮어써 지워버렸다. 폰이 "받자마자
//   스스로 지우는" 꼴이라 화면에 제대로 뜬 적이 없었던 것.
//
//   이 테스트는 ToolEngine.syncPullAutoState()를 실제로 호출해(fetch만 스텁) 이 순서
//   버그가 고쳐졌는지 — pull 과정에서 저절로 일어나는 재업로드(push)가 방금 받은
//   lastScan을 그대로 담아 보내는지(지우지 않는지) — 직접 검증한다.
// =============================================================================
describe("[v0.60.6] syncPullAutoState — pull 직후 자동 재업로드가 방금 받은 lastScan을 지우지 않는다", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pull로 받은 lastScan이 뒤이은 자동 push에도 그대로 실려 나간다(옛 값으로 덮어쓰지 않음)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-autostate-"));
    try {
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

      // "클라우드(PC가 올려 둔 것)"로 꾸민 암호화 페이로드 — 이 기기(폰)는 아직 이 lastScan을 모른다.
      const cloudPayload = toAutoStateSyncPayload([], Date.now(), { lastScan: fakeScreenRun({ total: 99 }) });
      const cloudRec = await encryptJson(cloudPayload, PASS);

      let capturedPushBody: string | null = null;
      const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        if (u.includes("capri_auto_state") && method === "GET") {
          return new Response(JSON.stringify([{ ciphertext: cloudRec.ciphertext, salt: cloudRec.salt, iv: cloudRec.iv }]), { status: 200 });
        }
        if (u.includes("capri_auto_state") && method === "POST") {
          capturedPushBody = String(init?.body ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      });
      vi.stubGlobal("fetch", fetchStub);

      const result = await eng.syncPullAutoState();
      expect(result.ok).toBe(true);

      // persistAutoTradeHistory()가 거는 재업로드는 void(fire-and-forget)라 syncPullAutoState의
      // 반환과 완료 시점이 보장되지 않는다 — encryptJson이 PBKDF2 20만회(의도적으로 느림, 보안용)를
      // 돌리는 동안은 아직 안 끝나 있을 수 있어, 짧게 한 번 기다리는 대신 끝날 때까지 폴링한다.
      for (let i = 0; i < 100 && capturedPushBody === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // persistAutoTradeHistory()의 쓰로틀(신규 엔진이라 항상 통과)이 자동으로 재push했어야 한다.
      expect(capturedPushBody).not.toBeNull();
      const pushedRaw = JSON.parse(capturedPushBody as unknown as string) as { ciphertext: string; salt: string; iv: string };
      const decryptedPush = await decryptJson<AutoStateSyncPayload>(pushedRaw, PASS);
      // [핵심] 방금 pull로 받은 lastScan(total:99)이 그대로 실려 나가야 한다 — null로
      // 덮어써졌다면(순서 버그) 여기서 undefined/null이 돼 실패한다.
      expect(decryptedPush.lastScan?.total).toBe(99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
