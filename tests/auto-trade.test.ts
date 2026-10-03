// =============================================================================
// tests/auto-trade.test.ts — 자동매매 엔진 상태 관리 테스트 (v0.26.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나? / 왜 이만큼만?]
//   자동매매의 "판단 로직"(안전 게이트)은 lib/auto-risk.ts에서, "OCO 발동 감지"는
//   tests/conditional-fx.integration.test.ts에서, "진입→체결→OCO 등록"은 기존
//   tests/bracket.test.ts(placeBracketCore가 그대로 재사용됨)에서 각각 이미 검증된다.
//
//   이 파일은 그 외에 자동매매만의 새 동작 — ①시작/중지 상태 전환 ②한도 설정 저장이
//   재시작해도 유지되는지 ③"켜짐" 자체는 절대 저장되지 않는지(안전 원칙) — 를 검증한다.
//
//   [왜 실제 스캔(startAutoTrade → 5분 사이클)까지는 테스트하지 않나?]
//   scanScreener는 목 서버의 결정적이지만 매끈한(완만한 상승) 가상 캔들로 동작하는데,
//   "합격(confirmed)" 판정에 필요한 고점-도지 패턴은 그 캔들 모양에서 우연히도 거의
//   나오지 않는다(기존 tests/indicators.test.ts의 스캔 테스트도 같은 이유로 "합격" 여부가
//   아니라 데이터가 채워지는지만 확인한다). 그래서 "실제 진입까지" 시뮬레이션하는 테스트는
//   이 시점에서는 비결정적이라 만들지 않았다 — 대신 진입 로직 자체(계산·중복방지·게이트)는
//   이미 순수 함수/기존 테스트로 커버돼 있다.
// =============================================================================

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, DateTime } from "luxon";
import {
  ToolEngine, computeSeedQty, newlyConfirmedSymbols, applyScreenGates, findDirectionConflict,
  type AutoPosition, type JournalEntry, type NotifyEvent, type ScreenResult, type AutoTradeHistoryEntry,
} from "../electron/tool-engine";

/** [v0.30.1] OCO 등록 저널이 뜰 때까지 기다린다(bracket.test.ts의 waitForJournal과 동일 패턴). */
function waitForOcoJournal(eng: ToolEngine, timeoutMs = 5000): Promise<JournalEntry> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eng.off("journal", onEntry);
      reject(new Error(`시간 안에 OCO 저널이 나오지 않음(${timeoutMs}ms)`));
    }, timeoutMs);
    function onEntry(e: JournalEntry) {
      if (e.kind === "oco") {
        clearTimeout(timer);
        eng.off("journal", onEntry);
        resolve(e);
      }
    }
    eng.on("journal", onEntry);
  });
}

/** [v0.45.0] summary에 특정 문자열이 포함된 저널이 뜰 때까지 기다린다(세션 선택 테스트용). */
function waitForJournalContaining(eng: ToolEngine, needle: string, timeoutMs = 5000): Promise<JournalEntry> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eng.off("journal", onEntry);
      reject(new Error(`시간 안에 "${needle}" 포함 저널이 나오지 않음(${timeoutMs}ms)`));
    }, timeoutMs);
    function onEntry(e: JournalEntry) {
      if (e.summary.includes(needle)) {
        clearTimeout(timer);
        eng.off("journal", onEntry);
        resolve(e);
      }
    }
    eng.on("journal", onEntry);
  });
}

/** [v0.44.0/v0.45.0] 주어진 KST 시각으로 DateTime.now()가 고정되게 만든다(tests/system-pause.test.ts와 동일 패턴). */
function freezeKst(year: number, month: number, day: number, hour: number, minute = 0) {
  const target = DateTime.fromObject({ year, month, day, hour, minute }, { zone: "Asia/Seoul" }).toMillis();
  Settings.now = () => target;
}

afterEach(() => {
  Settings.now = () => Date.now(); // 항상 원상 복구(다른 테스트로 새지 않게)
});

describe("자동매매 상태 관리 — v0.26.0", () => {
  it("엔진을 처음 만들면 자동매매는 꺼진 상태고 한도는 공장값(3종목/5%/30%)이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.getAutoTradeStatus();
      expect(s.enabled).toBe(false);
      expect(s.positions).toEqual([]);
      expect(s.realizedPnlUsd).toBe(0);
      expect(s.maxPositions).toBe(3);
      expect(s.maxLossPct).toBe(5);
      expect(s.maxInvestPct).toBe(30);
      // [v0.27.0] 스크리닝 결과 탭이 쓰는 필드 — 아직 한 번도 스캔 안 했으면 null이어야 한다.
      expect(s.lastScan).toBeNull();
      // [v0.35.0] "왜 미진입인지" 사유 맵 — 아직 한 사이클도 안 돌았으면 빈 객체.
      expect(s.skipReasons).toEqual({});
      // [v0.40.0] 시드 스냅샷 — 아직 계산 전이면 null.
      expect(s.seedUsdSnapshot).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.28.0] 자동매매 스크리너 조건의 공장값은 메뉴얼 스크리너 기본값과 같다(종목수 60·$1~$9·몸통 30%)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.getSettings();
      expect(s.autoScanCount).toBe(60);
      expect(s.autoScanPriceMin).toBe(1);
      expect(s.autoScanPriceMax).toBe(9);
      expect(s.autoScanBodyRatio).toBe(0.3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.28.0] saveAutoScanSettings는 4개 조건을 저장하고 재시작해도 유지된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const saved = eng.saveAutoScanSettings({ count: 120, priceMin: 2, priceMax: 15, bodyRatio: 0.6 });
      expect(saved.autoScanCount).toBe(120);
      expect(saved.autoScanPriceMin).toBe(2);
      expect(saved.autoScanPriceMax).toBe(15);
      expect(saved.autoScanBodyRatio).toBe(0.6);

      const eng2 = new ToolEngine(dir, { forceMock: true });
      const s2 = eng2.getSettings();
      expect(s2.autoScanCount).toBe(120);
      expect(s2.autoScanPriceMin).toBe(2);
      expect(s2.autoScanPriceMax).toBe(15);
      expect(s2.autoScanBodyRatio).toBe(0.6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.28.0] 도지 몸통비율은 0.1~0.8로 보정된다(오너 지시: 상한 80%까지)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.saveAutoScanSettings({ bodyRatio: 0.95 }).autoScanBodyRatio).toBe(0.8); // 상한 넘으면 0.8로
      expect(eng.saveAutoScanSettings({ bodyRatio: 0.8 }).autoScanBodyRatio).toBe(0.8); // 정확히 상한은 그대로
      expect(eng.saveAutoScanSettings({ bodyRatio: 0.05 }).autoScanBodyRatio).toBe(0.1); // 하한 밑이면 0.1로
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.28.0] 스캔 종목수는 10~200으로 보정되고, 0 이하·비정상 값은 무시한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.saveAutoScanSettings({ count: 500 }).autoScanCount).toBe(200);
      expect(eng.saveAutoScanSettings({ count: 1 }).autoScanCount).toBe(10);
      const before = eng.saveAutoScanSettings({ count: 50 });
      expect(before.autoScanCount).toBe(50);
      const after = eng.saveAutoScanSettings({ count: 0 });
      expect(after.autoScanCount).toBe(50); // 무시되고 이전값 유지
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.28.0] autoScanNow는 자동매매가 꺼져 있어도 스캔해서 lastScan을 채운다(진입 없이 미리보기)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoScanSettings({ count: 10 }); // 빠른 테스트를 위해 최소치로
      expect(eng.getAutoTradeStatus().enabled).toBe(false);
      const s = await eng.autoScanNow();
      expect(s.enabled).toBe(false); // 자동매매 자체는 켜지지 않는다(미리보기 전용)
      expect(s.lastScan).not.toBeNull();
      expect(Array.isArray(s.lastScan!.results)).toBe(true);
      expect(s.positions).toEqual([]); // 진입 시도를 안 했으므로 포지션도 그대로 없음
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // =============================================================================
  // [v0.61.4 긴급수정 — 오너가 운영 DB를 직접 SQL로 조회해 확정한 버그]
  //   "폰에서 지금 새로고침을 4번 눌러도 자동 스크리너가 빈 화면" 보고를 조사하며 capri_live_state를
  //   직접 조회한 결과: 자동매매가 꺼진 상태에서의 autoScanNow(미리보기 스캔)는 실제로 PC에서
  //   스캔이 성공했지만(lastScan이 PC 메모리엔 채워짐) **capri_live_state에 한 번도 올라간 적이
  //   없었다** — pushLiveState 호출 자체가 이 분기에 빠져 있었다. 게다가 lastScan/lastCycleAt은
  //   메모리 전용이라 PC가 재시작되면(자동 업데이트 등) 그 순간 사라지고, 재시작 직후의 포지션
  //   재확인(reconcileAutoPositionsNow)이 그 "방금 리셋된 null"을 그대로 클라우드에 올려 기존
  //   실제 스캔 결과를 덮어쓰기까지 했다 — 두 버그가 겹쳐 "폰에서 영원히 빈 화면"이 됐다.
  // =============================================================================
  it("[v0.61.4] autoScanNow(미리보기)는 lastScan을 파일에도 저장하고 상태 미러에도 올린다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
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
      engAny.authPassword = "pw";
      eng.saveAutoScanSettings({ count: 10 });

      let capturedBody: string | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        if (u.includes("capri_live_state") && method === "POST") {
          capturedBody = String(init?.body ?? "");
          return new Response(null, { status: 200 });
        }
        return originalFetch(url as never, init);
      }) as typeof fetch;

      try {
        const s = await eng.autoScanNow();
        expect(s.lastScan).not.toBeNull();
        // pushLiveState(true)가 autoScanNow의 "미리보기" 분기에서도 호출돼야 한다 — 호출은
        // fire-and-forget(void)이라 짧게 폴링해 기다린다(다른 push 테스트와 동일 패턴).
        for (let i = 0; i < 40 && capturedBody === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(capturedBody).not.toBeNull();
        const body = JSON.parse(capturedBody as unknown as string) as { payload: { status: { lastScan: unknown } } };
        expect(body.payload.status.lastScan).not.toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }

      // [핵심] "재시작"(같은 폴더로 새 엔진) 후에도 lastScan이 사라지지 않아야 한다 —
      // positions만 영속화돼 있고 lastScan은 메모리 전용이던 게 이번 버그의 근본 원인이었다.
      const eng2 = new ToolEngine(dir, { forceMock: true });
      const s2 = eng2.getAutoTradeStatus();
      expect(s2.lastScan).not.toBeNull();
      expect(s2.lastScan?.results.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // [v0.61.4 — 오너 지시 "스크리닝시 진행되는 사항들 게이지가 차는 사항이 안 보인다"] 스캔이
  //   끝나면 상태 미러의 scanProgress가 running:false·phase:"done"·done===total로 마감돼야
  //   폰 쪽 게이지가 "꽉 찬 채로 끝났다"를 알 수 있다(중간 진행 틱은 2초 쓰로틀이라 타이밍에
  //   의존하지 않는 "최종 상태"만 안정적으로 검증한다).
  it("[v0.61.4] 스캔이 끝나면 상태 미러의 scanProgress가 running:false로 마감된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
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
      engAny.authPassword = "pw";
      eng.saveAutoScanSettings({ count: 10 });

      // 여러 push가 겹쳐 들어올 수 있어(스캔 중 2초 쓰로틀 틱 + 완료 신호 + autoScanNow 자체의
      // 마무리 push) "가장 최근에 도착한 것"이 아니라 "running:false로 마감된 것이 한 번이라도
      // 왔는지"를 본다 — scanScreener가 끝난 시점엔 scanProgressForMirror가 이미 done으로
      // 확정돼 있으므로(동기 대입), 그 이후 발생하는 모든 push는 전부 이 마감 상태를 담는다.
      let sawDone: { running: boolean; phase: string; done: number; total: number } | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        if (u.includes("capri_live_state") && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { payload?: { scanProgress?: typeof sawDone } };
          if (body.payload?.scanProgress && body.payload.scanProgress.running === false && body.payload.scanProgress.phase === "done") {
            sawDone = body.payload.scanProgress;
          }
          return new Response(null, { status: 200 });
        }
        return originalFetch(url as never, init);
      }) as typeof fetch;

      try {
        await eng.autoScanNow();
        for (let i = 0; i < 40 && sawDone === null; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(sawDone).not.toBeNull();
      expect((sawDone as unknown as { done: number; total: number }).done).toBe((sawDone as unknown as { done: number; total: number }).total);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // [v0.27.0] autoTradeTick이 실제로 lastScan을 채우는지(기본 60종목 스캔)는 여기서 끝까지 기다리며
  //   검증하지 않는다 — 직접 재보니 목 서버라도 기본 스캔(count=60)이 끝나는 데 70초 넘게 걸려
  //   이 테스트 파일의 기존 방침(파일 상단 주석: 실제 스캔 완료까지 시뮬레이션하지 않음)과 같은
  //   이유로 비현실적이다. "구조가 맞는지"(필드 존재·초기값 null)는 위 테스트가 이미 검증하고,
  //   "autoTradeTick이 실제로 lastScan에 대입하는지"는 코드 리뷰 + 타입체크(autoTradeTick 안의
  //   `this.autoTradeLastScan = run;` 대입이 컴파일되려면 타입이 일치해야 함)로 커버한다.

  it("stopAutoTrade는 한 번도 시작하지 않았어도 안전하게 동작한다(꺼진 채 그대로)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.stopAutoTrade("테스트");
      expect(s.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("한도 설정(saveAutoTradeSettings)은 재시작(새 엔진)해도 유지된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const saved = eng.saveAutoTradeSettings({ maxPositions: 5, maxLossPct: 8, maxInvestPct: 50, watchMinutes: 20 });
      expect(saved.autoTradeMaxPositions).toBe(5);
      expect(saved.autoTradeMaxLossPct).toBe(8);
      expect(saved.autoTradeMaxInvestPct).toBe(50);
      expect(saved.autoTradeWatchMinutes).toBe(20);

      const eng2 = new ToolEngine(dir, { forceMock: true });
      const s2 = eng2.getSettings();
      expect(s2.autoTradeMaxPositions).toBe(5);
      expect(s2.autoTradeMaxLossPct).toBe(8);
      expect(s2.autoTradeMaxInvestPct).toBe(50);
      expect(s2.autoTradeWatchMinutes).toBe(20);
      // [안전 원칙] "켜짐" 자체는 절대 저장되지 않는다 — 재시작하면 항상 꺼진 채 시작.
      expect(s2.autoTradeEnabled).toBe(false);
      expect(eng2.getAutoTradeStatus().enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.42.0] 미체결 자동취소 기준(분) — 저장 시 1~60분으로 보정된다", () => {
    // ⚠️ process.env는 테스트 프로세스 전체가 공유하므로(persistEnv가 process.env[k]=v로 복원),
    //   "새 엔진의 공장값이 10분"이라고 단정하지 않는다(다른 테스트가 먼저 저장한 값이 새어 들어올
    //   수 있음 — 위 "재시작해도 유지된다" 테스트와 같은 이유). 대신 이 테스트 안에서 알려진 값을
    //   먼저 저장해 기준선을 만든 뒤 클램프 동작만 검증한다.
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.saveAutoTradeSettings({ watchMinutes: 15 }).autoTradeWatchMinutes).toBe(15);
      expect(eng.getAutoTradeStatus().watchMinutes).toBe(15);

      // 범위 밖 값은 1~60분으로 보정(0이나 음수는 무시해 이전값 유지, 너무 큰 값은 60분으로 클램프).
      expect(eng.saveAutoTradeSettings({ watchMinutes: 100 }).autoTradeWatchMinutes).toBe(60);
      expect(eng.saveAutoTradeSettings({ watchMinutes: 0 }).autoTradeWatchMinutes).toBe(60); // 무시 → 이전값 유지
      expect(eng.saveAutoTradeSettings({ watchMinutes: 25 }).autoTradeWatchMinutes).toBe(25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("0 이하·비정상 값은 무시하고 이전 값을 유지한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 4, maxLossPct: 6, maxInvestPct: 40 });
      const s = eng.saveAutoTradeSettings({ maxPositions: 0, maxLossPct: -1, maxInvestPct: NaN });
      expect(s.autoTradeMaxPositions).toBe(4);
      expect(s.autoTradeMaxLossPct).toBe(6);
      expect(s.autoTradeMaxInvestPct).toBe(40);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[2026-09-25 버그수정] 투입 비율은 종목 수로 나뉘지 않고 종목 1개당 그대로 적용된다", () => {
    // autoTradeTick 내부에서 실제로 쓰는 계산과 동일한 식 — perSlotPct = autoTradeMaxInvestPct
    // (옛 버그는 perSlotInvestPct(maxInvestPct, maxPositions) = maxInvestPct/maxPositions였다).
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 3, maxLossPct: 5, maxInvestPct: 30 });
      const seedUsd = 1000;
      const price = 9.2; // 저가주 예시(오너가 실계좌 테스트에서 1주만 나왔던 가격대)
      const commissionRate = 0;
      // 엔진의 autoTradeTick이 하는 것과 동일: perSlotPct = autoTradeMaxInvestPct(나누지 않음).
      const qty = computeSeedQty(seedUsd, 30, price, commissionRate);
      expect(qty).toBe(32); // 옛 버그(30/3=10%)였다면 10주에 그쳤을 것
      expect(qty).not.toBe(1); // 실계좌에서 관찰됐던 "1주만 매수" 증상이 재현되지 않음을 확인
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startAutoTrade는 켜짐 상태로 바꾸고, 곧바로 stopAutoTrade하면 다시 꺼진다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // [주의] startAutoTrade는 백그라운드에서 스캔(최대 60종목)을 즉시 1회 돌리기 시작한다
      // (fire-and-forget). 이 테스트는 그 스캔의 "완료"를 기다리지 않고 상태 전환만 본다.
      const s1 = eng.startAutoTrade();
      expect(s1.enabled).toBe(true);
      const s2 = eng.stopAutoTrade();
      expect(s2.enabled).toBe(false);
      // 백그라운드 스캔이 짧게라도 진행되다 끝나도 안전하게 무시되도록, 잠깐 양보한다.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("[v0.29.0] nextCycleAtMs는 꺼져 있으면 null, 켜면 약 5분 뒤 시각이 채워지고, 끄면 다시 null이 된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // [오너 요청 2026-09-25] "자동 스크리너 탭에 몇분 후 스크리닝 진행 표시 필요" — 화면의
      //   카운트다운이 읽는 필드가 상태 전환에 맞춰 정확히 채워지고/비워지는지 확인한다.
      expect(eng.getAutoTradeStatus().nextCycleAtMs).toBeNull();

      const before = Date.now();
      eng.startAutoTrade(); // fire-and-forget 백그라운드 스캔 — 상태 전환만 본다(위 테스트와 동일 패턴)
      const s = eng.getAutoTradeStatus();
      expect(s.nextCycleAtMs).not.toBeNull();
      // AUTO_TRADE_INTERVAL_MS(5분) 근방이어야 한다(오차 여유를 넉넉히 둠 — 테스트 실행 지연 대비).
      expect(s.nextCycleAtMs as number).toBeGreaterThan(before + 4 * 60_000);
      expect(s.nextCycleAtMs as number).toBeLessThan(before + 6 * 60_000);

      const stopped = eng.stopAutoTrade();
      expect(stopped.nextCycleAtMs).toBeNull();
      await new Promise((r) => setTimeout(r, 50)); // 백그라운드 스캔 잔여분 안전하게 흘려보냄
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("[v0.30.0] 자동매매기록(getAutoTradeHistory)은 처음엔 빈 배열이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.getAutoTradeHistory()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.30.0] 자동매매기록은 파일에 저장돼 재시작(새 엔진)해도 남아있고, 최신순으로 돌려준다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      // [왜 엔진 API로 안 쓰고 파일을 직접 쓰나?] addAutoTradeHistory/updateAutoTradeHistory는
      //   autoTradeTick 안에서만 호출되는 사설(private) 메서드이고, 실제 진입까지 가려면 목
      //   서버의 스크리닝 결과가 "합격"이어야 하는데 이 파일 맨 위 설명대로 그건 비결정적이라
      //   테스트로 못 쓴다. 대신 persistAutoTradeHistory가 실제로 만드는 것과 같은 모양의
      //   파일을 직접 써서, "저장된 걸 다시 읽어오는" 절반(load 쪽)을 확실히 검증한다.
      const historyPath = join(dir, "kylebot-auto-history.json");
      const seed = [
        {
          id: "AAPL@2.1@1000", symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 10,
          enteredAt: "09-26 10:00:00", status: "closed_win", exitedAt: "09-26 10:20:00",
          exitPrice: 2.5, pnlUsd: 4, pnlPct: 19.05, note: "익절 발동으로 자동 청산",
        },
        {
          id: "TSLA@5.0@2000", symbol: "TSLA", entry: 5.0, tp: 5.5, sl: 4.5, quantity: 5,
          enteredAt: "09-26 10:05:00", status: "watching", exitedAt: null,
          exitPrice: null, pnlUsd: null, pnlPct: null, note: "매수 주문 접수 — 체결 대기 중",
        },
      ];
      writeFileSync(historyPath, JSON.stringify(seed, null, 2), "utf8");

      const eng = new ToolEngine(dir, { forceMock: true });
      const hist = eng.getAutoTradeHistory();
      expect(hist.length).toBe(2);
      // getAutoTradeHistory는 최신(배열 뒤쪽)이 위로 오게 뒤집어 준다 — TSLA가 나중에 추가됐으므로 먼저 나와야 함.
      expect(hist[0].symbol).toBe("TSLA");
      expect(hist[0].status).toBe("watching");
      expect(hist[1].symbol).toBe("AAPL");
      expect(hist[1].status).toBe("closed_win");
      expect(hist[1].pnlUsd).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // [v0.30.1 긴급수정] 오너가 실제로 겪은 사고: "PC/폰을 껐다 켜거나 업데이트하면 자동매매로
  //   감시 중이던 포지션·기록이 전부 사라지는데, 실제 토스엔 그 주문이 그대로 남아있다."
  //   원인: autoTradePositions가 파일로 저장되지 않는 런타임 전용 값이었고, 게다가
  //   startAutoTrade()가 "시작"을 누를 때마다 그마저 무조건 비웠다. 아래 테스트들이 그 두 가지를
  //   구체적으로 고정한다 — "엔진 재시작 후에도 남아있는지" + "시작을 다시 눌러도 안 사라지는지".
  // ===========================================================================
  it("[v0.30.1] 자동매매 포지션(watching/active)은 파일에 저장돼 엔진을 재시작해도 그대로 남는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const positionsPath = join(dir, "kylebot-auto-positions.json");
      const seed = {
        positions: [
          { symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 10, enteredAtMs: 1000, status: "active", conditionalOrderId: "cond-1" },
          { symbol: "TSLA", entry: 5.0, tp: 5.5, sl: 4.5, quantity: 5, enteredAtMs: 2000, status: "watching", conditionalOrderId: null, buyOrderId: "buy-1" },
        ],
        usedKeys: ["AAPL@2.1", "TSLA@5"],
      };
      writeFileSync(positionsPath, JSON.stringify(seed, null, 2), "utf8");

      // [엔진 재시작 시뮬레이션] 같은 dir로 새 ToolEngine을 만드는 것 자체가 "앱을 껐다 켬"과
      //   동일하다(생성자에서 loadAutoPositions를 부르므로).
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.getAutoTradeStatus();
      expect(s.positions.length).toBe(2);
      const aapl = s.positions.find((p) => p.symbol === "AAPL");
      const tsla = s.positions.find((p) => p.symbol === "TSLA");
      expect(aapl?.status).toBe("active");
      expect(aapl?.conditionalOrderId).toBe("cond-1");
      expect(tsla?.status).toBe("watching");
      expect(tsla?.buyOrderId).toBe("buy-1"); // [v0.30.1] 재확인용 매수 주문번호도 함께 복구돼야 함
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.30.1] startAutoTrade()는 더 이상 기존 포지션을 비우지 않는다(재시작 후 '시작'을 다시 눌러도 유지)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const positionsPath = join(dir, "kylebot-auto-positions.json");
      const seed = {
        positions: [
          { symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 10, enteredAtMs: 1000, status: "active", conditionalOrderId: "cond-1" },
        ],
        usedKeys: ["AAPL@2.1"],
      };
      writeFileSync(positionsPath, JSON.stringify(seed, null, 2), "utf8");

      const eng = new ToolEngine(dir, { forceMock: true });
      // 재시작 직후(자동매매를 다시 켜기 전)에도 이미 보여야 한다 — 오너가 "시작"을 누르기 전에도
      //   "아직 감시 중이던 종목이 있었지" 하고 화면에서 바로 확인할 수 있어야 하므로.
      expect(eng.getAutoTradeStatus().positions.length).toBe(1);

      // [주의] startAutoTrade는 백그라운드 스캔을 fire-and-forget으로 시작한다 — 기존 테스트와
      //   같은 패턴으로 상태 전환만 확인하고 곧바로 정지시킨다.
      const started = eng.startAutoTrade();
      expect(started.positions.length).toBe(1); // 예전엔 여기서 0이 됐었다(버그) — 이제는 유지돼야 함
      expect(started.positions[0].symbol).toBe("AAPL");
      eng.stopAutoTrade();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("[v0.30.1] 재시작으로 감시가 끊긴 'watching' 포지션도 reconcileAutoPositions가 다시 체결을 확인해 보호주문(OCO)을 등록한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 1) 실제 매수 주문을 하나 낸다(AAPL 목서버 초기가 2.05 → 2.10에 걸면 즉시 체결 — bracket.test.ts와 동일 규칙).
      //    이걸로 "재시작 전에 이미 자동매매가 낸 매수 주문"을 재현한다.
      const entry = await eng.placeEntry({ symbol: "AAPL", price: 2.1, quantity: 3 });
      const buyOrderId = (entry.detail as { tossOrderId: string }).tossOrderId;

      // 2) "재시작 직후 파일에서 막 복구된, 이 프로세스는 아직 한 번도 감시한 적 없는 watching
      //    포지션"을 흉내낸다 — autoTradeActiveWatches에 없는 상태가 핵심(그래야 '고아' 취급됨).
      //    [private 접근에 대해] addAutoTradeHistory/reconcileAutoPositions 둘 다 private이라
      //    직접 부른다 — 이 흐름 자체가 "앱이 재시작된 뒤 5분 사이클이 도는 상황"을 그대로
      //    재현하는 유일한 방법이다(목 서버가 엔진 인스턴스마다 독립적이라 진짜로 앱을 두 번
      //    띄워서는 같은 주문을 재현할 수 없다).
      const engAny = eng as unknown as {
        autoTradePositions: AutoPosition[];
        autoTradeActiveWatches: Set<string>;
        reconcileAutoPositions: () => Promise<void>;
      };
      engAny.autoTradePositions.push({
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3,
        enteredAtMs: Date.now(), status: "watching", conditionalOrderId: null, buyOrderId,
      });
      expect(engAny.autoTradeActiveWatches.has(`AAPL@2.1@${engAny.autoTradePositions[0].enteredAtMs}`)).toBe(false);

      const ocoPromise = waitForOcoJournal(eng);
      await engAny.reconcileAutoPositions();
      await ocoPromise;

      const pos = eng.getAutoTradeStatus().positions.find((p) => p.symbol === "AAPL");
      expect(pos?.status).toBe("active"); // watching → active로 스스로 넘어갔어야 함
      expect(pos?.conditionalOrderId).not.toBeNull(); // 보호주문(OCO)이 실제로 등록됐어야 함
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.45.0] reconcileAutoPositionsNow — 오너 보고 '지금 감시 중 포지션이 실시간 연동 안 됨' — 자동매매가 꺼져 있어도(positions만 있으면) 즉시 재확인해 최신 상태를 준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const entry = await eng.placeEntry({ symbol: "AAPL", price: 2.1, quantity: 3 });
      const buyOrderId = (entry.detail as { tossOrderId: string }).tossOrderId;

      const engAny = eng as unknown as { autoTradePositions: AutoPosition[] };
      engAny.autoTradePositions.push({
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3,
        enteredAtMs: Date.now(), status: "watching", conditionalOrderId: null, buyOrderId,
      });

      // [핵심] autoTradeEnabled가 false인 상태(자동매매를 안 켰거나 이미 꺼진 상태)에서도
      // — 화면의 "지금 감시 중" 표는 enabled와 무관하게 positions만 있으면 뜨므로 — 이 메서드는
      // 여전히 동작해야 한다(이전 버그: enabled를 조건으로 걸어 두면 이 경우 조용히 아무 일도
      // 안 하는 채로 옛 상태를 그대로 돌려줬을 것이다).
      expect(eng.getAutoTradeStatus().enabled).toBe(false);

      const ocoPromise = waitForOcoJournal(eng);
      const status = await eng.reconcileAutoPositionsNow();
      await ocoPromise;

      const pos = status.positions.find((p) => p.symbol === "AAPL");
      expect(pos?.status).toBe("active");
      expect(pos?.conditionalOrderId).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.45.0] 매매진행할 장 선택 — 지금 세션의 토글을 꺼 두면 스캔·진입 없이 그 사이클만 건너뛴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 정규장(본장)만 끄고 나머지 3개(데이·프리·애프터)는 공장값(켜짐) 그대로 둔다.
      const saved = eng.saveAutoScanSettings({ regularEnabled: false });
      expect(saved.autoScanRegularEnabled).toBe(false);
      expect(saved.autoScanDayEnabled).toBe(true); // 다른 3개는 안 건드렸으니 그대로 켜짐

      freezeKst(2026, 7, 16, 23, 0); // 목요일 23:00 KST = 정규장(tests/session.test.ts와 동일 시각)

      const skipPromise = waitForJournalContaining(eng, "정규장(본장)");
      eng.startAutoTrade();
      const j = await skipPromise;
      expect(j.summary).toContain("건너뜁니다");

      // 실제로 스캔 자체가 안 돌았어야 한다(건너뛴 것이지, 스캔했는데 후보가 없던 게 아님).
      const status = eng.getAutoTradeStatus();
      expect(status.lastScan).toBeNull();
      // [v0.48.0] 오류가 아니라 "정상 스킵"이라는 사유가 화면에 보이도록 채워져야 한다
      // (오너 보고 "새로고침해도 반응 없어 보인다" — 저널에만 남고 화면엔 안 보이던 문제).
      expect(status.lastCycleSkipReason).not.toBeNull();
      expect(status.lastCycleSkipReason?.message).toContain("정규장(본장)");
      expect(status.lastScanError).toBeNull(); // 오류 배너와는 별개 — 동시에 뜨면 안 됨
      eng.stopAutoTrade();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.45.0] 매매진행할 장 선택 — 지금 세션이 켜져 있으면(공장값 전부 켜짐) 평소대로 스캔이 실제로 돈다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoScanSettings({ count: 10 }); // 스캔 대상을 최소치로 줄여 테스트를 빠르게
      freezeKst(2026, 7, 16, 23, 0); // 정규장 — 공장값은 4개 전부 켜짐이라 막히지 않아야 함

      eng.startAutoTrade();
      // autoScanNow()가 진행 중이던 첫 사이클의 완료를 실제로 기다렸다가 최신 상태를 주므로
      // (v0.45.0의 다른 버그 수정과 동일한 메커니즘), 이 반환값으로 "스캔이 끝났는지"를 확인한다.
      const status = await eng.autoScanNow();
      expect(status.lastScan).not.toBeNull(); // 세션 게이트에 막히지 않고 실제로 스캔까지 돌았다
      expect(status.lastCycleSkipReason).toBeNull(); // [v0.48.0] 실제로 스캔했으니 스킵 사유는 없어야 함
      eng.stopAutoTrade();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("[v0.30.1] 자동매매 포지션 파일이 없거나 깨져 있어도 엔진 생성이 죽지 않고 빈 목록으로 시작한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const positionsPath = join(dir, "kylebot-auto-positions.json");
      writeFileSync(positionsPath, "{ 이건 유효한 JSON이 아님 ", "utf8");
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.getAutoTradeStatus().positions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.45.0 버그 수정] 자동매매 시작 직후 '지금 새로고침' 경합 — 이제는 실제로 기다렸다가 최신 결과를 준다", () => {
  // [오너 보고] "자동매매 시작을 눌러도 자동 스크리너 스크리닝 진행안함, 새로고침 눌러도
  //   눌리기만 함". 원인: startAutoTrade()가 첫 사이클을 "발사 후 신경 안 씀"으로 돌리고 곧장
  //   반환하는데, 화면(toggleAutoTrade)이 그 직후 곧바로 autoScanNow()(=새로고침과 동일 함수)를
  //   또 부른다. 예전엔 "이미 진행 중"이면 그 자리에서 즉시 옛(텅 빈) 상태를 반환해버려 오너
  //   눈엔 "눌러도 아무 일도 안 일어남"으로 보였다. 이제는 진행 중인 사이클을 실제로 기다린다.
  it("startAutoTrade() 직후 autoScanNow()를 부르면, 첫 사이클이 끝날 때까지 기다렸다가 결과를 돌려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoScanSettings({ count: 10 }); // 스캔 대상을 최소치로 줄여 테스트를 빠르게
      eng.startAutoTrade(); // 내부에서 첫 사이클을 발사 후 신경 안 씀으로 시작(runAutoTradeTick)
      // 오너가 실제로 겪은 순서 그대로: 시작 직후 곧바로 "지금 새로고침"을 누른 것과 동일.
      const status = await eng.autoScanNow();
      expect(status.enabled).toBe(true);
      // autoScanNow()가 진짜로 첫 사이클의 완료까지 기다렸다면, 그 사이클 안의 스캔(scanScreener)도
      // 이미 끝나 있어야 한다 — screenBusy가 풀렸는지를 "취소할 스캔이 없다"는 응답으로 확인한다
      // (고치기 전이었다면 이 시점에도 여전히 스캔이 진행 중이었을 것 — ok:true가 나왔을 것이다).
      expect(eng.cancelScreenerScan().ok).toBe(false);
      eng.stopAutoTrade();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("[v0.32.0→v0.39.0] 중복진입 방지 — 여러 기기가 동시에 자동매매를 켰을 때의 안전장치", () => {
  // [왜 이 테스트가 필요한가] v0.30.1까지는 "지금 몇 종목 보유 중인가"를 이 프로세스의 로컬
  //   파일(autoTradePositions)만 보고 판단했다. 오너가 윈도우·맥북 등 서로 다른 기기에서 각각
  //   앱을 켜고 자동매매를 동시에 시작하면, 두 번째 기기는 첫 번째 기기가 이미 넣은 실제 주문을
  //   전혀 모른 채 같은 종목에 또 진입할 수 있었다. v0.32.0은 신규 진입 직전 실계좌 보유 현황
  //   (fetchRealHeldSymbols)을 직접 조회해 "이미 보유 중인 특정 종목엔 또 진입하지 않기"(심볼
  //   단위 중복 매수 방지, `activeSymbols` 필터)를 넣었다 — 이 부분은 지금도 유효하다.
  //   [v0.39.0에서 갈라낸 부분] 다만 v0.32.0은 "최대 종목 수" 자체도 같은 실계좌 전체 보유
  //   현황으로 셌는데(`effectiveActivePositionCount`), 그러면 자동매매와 전혀 무관한 기보유
  //   종목(수동 매수 등)까지 자동매매의 "자리"로 잘못 세어 최대 종목 수 한도를 자동매매가 진입
  //   하나도 안 했는데도 넘겨버릴 수 있었다 — 오너가 실사용에서 "거래를 아예 못하는중"으로
  //   겪은 그 버그. v0.39.0부터 "최대 종목 수"는 오직 이 엔진이 아는 자동매매 포지션만 센다
  //   (아래 관련 테스트 참고). 아래 테스트들은 목 서버 holdings가 AAPL 100주 보유로 고정돼
  //   있는 걸 이용해(mocks/toss-mock.ts) "실계좌엔 있는데 로컬 자동매매 기록엔 없는" 상황을
  //   일부러 재현한다.
  type EngineInternals = {
    autoTradeEnabled: boolean;
    autoTradePositions: AutoPosition[];
    autoTradeLastScan: unknown;
    fetchRealHeldSymbols: () => Promise<Set<string> | null>;
    effectiveActivePositionCount: () => number;
    autoTradeTick: () => Promise<void>;
  };

  it("fetchRealHeldSymbols는 실계좌(토스) 보유 종목을 그대로 돌려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      await (eng as unknown as { prepareBackend: () => Promise<void> }).prepareBackend();
      const held = await engAny.fetchRealHeldSymbols();
      expect(held).not.toBeNull();
      expect(held?.has("AAPL")).toBe(true); // 목 서버 고정 보유값
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // [v0.39.0 버그 수정 — 오너 실사용 보고 2026-09-28 "거래를 아예 못하는중, 심각"] 아래 두
  //   테스트는 예전(v0.32.0) 동작 — "최대 종목 수"를 실계좌 전체 보유 종목 수로 셈 — 을
  //   그대로 검증하고 있었다. 그런데 그 실계좌엔 자동매매와 무관한 기보유 종목(수동 매수 등)도
  //   섞여 있을 수 있어, 그런 종목까지 자동매매의 "자리"로 잘못 세면 `freeSlots`가 영원히
  //   0 이하가 되어 확정 종목이 계속 나와도 자동매매가 단 한 번도 진입을 시도 못 하게 막혀버릴
  //   수 있었다(오너가 겪은 증상 그대로). 오너 지시: "자동매매 섹션은 자동매매 항목만 카운트".
  //   이제 `effectiveActivePositionCount`는 이 엔진이 직접 아는 자동매매 포지션
  //   (`autoTradePositions`)만 세고, 실계좌 전체 보유 현황과는 무관하다.
  it("[v0.39.0] effectiveActivePositionCount는 실계좌 보유와 무관하게 자동매매가 직접 아는 포지션 개수만 센다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const mk = (symbol: string): AutoPosition => ({
        symbol, entry: 1, tp: 1.2, sl: 0.9, quantity: 1, enteredAtMs: Date.now(),
        status: "watching", conditionalOrderId: null,
      });
      expect(engAny.effectiveActivePositionCount()).toBe(0); // 아무것도 없으면 0(목 서버가 AAPL을 실계좌에 들고 있어도 무관)
      // AAPL은 목 서버 실계좌에도 항상 잡히지만(mocks/toss-mock.ts), 그건 이 카운트와 무관하다 —
      // 자동매매가 "아는" 포지션(로컬 autoTradePositions)만 세어야 한다.
      engAny.autoTradePositions.push(mk("AAPL"), mk("TSLA"));
      expect(engAny.effectiveActivePositionCount()).toBe(2); // 실계좌 보유 여부와 무관하게 둘 다 셈
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.39.0] 자동매매와 무관한 기보유 종목이 실계좌에 있어도(=이 엔진의 autoTradePositions는 비어 있음) 신규 스캔·진입은 막히지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 목 서버가 항상 AAPL 1종목을 실계좌 보유로 응답한다(자동매매와 무관한 기보유 상황을 흉내냄).
      // maxPositions는 여유 있게 둬서, "실계좌 AAPL 보유"가 이 한도를 잡아먹지 않는지를 검증한다.
      eng.saveAutoTradeSettings({ maxPositions: 3 });
      eng.saveAutoScanSettings({ count: 10 }); // 빠른 테스트를 위해 최소치로(파일 상단 autoScanNow 테스트와 동일 패턴)
      const engAny = eng as unknown as EngineInternals;
      expect(engAny.autoTradePositions).toEqual([]); // 이 엔진은 자동매매로 연 포지션이 하나도 없음(핵심 전제)

      engAny.autoTradeEnabled = true; // startAutoTrade()의 백그라운드 반복 없이 tick 한 번만 직접 검증
      await engAny.autoTradeTick();

      // freeSlots = maxPositions(3) - effectiveActivePositionCount(자동매매 포지션 0개) = 3 > 0
      //   → 실계좌에 AAPL을 보유 중이어도(기보유) 스캔은 정상적으로 돌아야 한다(예전엔 여기서
      //   조용히 막혔었다 — 그게 바로 이번에 고친 버그).
      expect(engAny.autoTradeLastScan).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // [v0.38.0 버그 수정 — 오너 실사용 보고: "스크리너 확정으로 나온 종목 주문이 안 들어가고 있음
  //   (사유도 안 보임)"] "freeSlots<=0이면 스캔 자체를 건너뛴다"는 안전 동작 자체는 문제가
  //   없었다 — 문제는 그 상태에서 화면에 남아있는 "지난 스캔의 확정 종목"에 왜 못 들어가는지
  //   사유가 전혀 안 채워진다는 것이었다(autoTradeSkipReasons가 스캔이 실제로 도는 경로에서만
  //   채워졌음). [v0.39.0] freeSlots<=0을 재현하는 방법이 "실계좌 보유"에서 "자동매매 자체
  //   포지션으로 자리를 채움"으로 바뀌었다(위 버그 수정과 일관되게) — 아래는 그 방식으로 다시
  //   재현·검증한다.
  it("[v0.38.0/v0.39.0] 자동매매 포지션으로 꽉 차서 스캔을 생략해도, 화면에 남아있던 지난 확정 종목엔 '왜 안 들어가는지' 사유가 채워진다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 1 });
      const engAny = eng as unknown as EngineInternals & { autoTradeLastScan: unknown };
      // 자동매매가 이미 진입해 감시 중인 종목 하나로 최대 종목 수(1개)를 채운다(실계좌 보유가 아님).
      engAny.autoTradePositions.push({
        symbol: "TSLA", entry: 5, tp: 5.5, sl: 4.5, quantity: 1, enteredAtMs: Date.now(),
        status: "watching", conditionalOrderId: null,
      });
      // "지금 새로고침" 또는 직전 사이클에서 확정으로 남아있던 스캔 결과를 흉내낸다.
      engAny.autoTradeLastScan = {
        scannedAt: "09-28 20:11:58", total: 1, priceMin: 1, priceMax: 9, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "MEDS", price: 3.83, ema200: 3, prevClose: 3.5, cloudTop: 2.9,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 4, proximityPct: -3, n1m: 300, n5m: 60, evidence: null,
        }],
      };
      engAny.autoTradeEnabled = true;
      await engAny.autoTradeTick();

      const s = eng.getAutoTradeStatus();
      expect(s.skipReasons.MEDS).toBeDefined();
      expect(s.skipReasons.MEDS).toContain("최대 종목 수"); // 왜 못 들어가는지 이유가 명확히 남아야 함
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // [v0.38.0 버그 수정 — 위와 같은 오너 보고의 또 다른 원인] freeSlots>0이라 스캔은 실제로
  //   도는데, 확정 종목이 "이미 로컬 또는 실계좌에 보유 중"이라는 이유로 candidates 필터에서
  //   아예 걸러지면, 그 종목은 진입 시도 for문에 한 번도 들어가지 않아 사유가 절대 안 남았다.
  //   목 서버는 AAPL을 항상 실계좌 보유로 고정 응답하므로(이 describe 상단 주석 참고), scanScreener만
  //   가짜로 바꿔 AAPL이 "확정"으로 나온 상황을 그대로 재현한다.
  it("[v0.38.0] 확정 종목이 이미 실계좌에 보유 중이라 후보 목록에서 걸러져도, '이미 보유 중' 사유가 남는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 3 }); // 여유 있게 — freeSlots>0이라 스캔은 실제로 돎
      const engAny = eng as unknown as EngineInternals & {
        scanScreener: (opts?: unknown) => Promise<unknown>;
      };
      engAny.scanScreener = async () => ({
        scannedAt: "09-28 20:11:58", total: 1, priceMin: 1, priceMax: 9, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "AAPL", price: 2.5, ema200: 2, prevClose: 2.1, cloudTop: 1.9,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 2.6, proximityPct: -3, n1m: 300, n5m: 60, evidence: null,
        }],
      });
      engAny.autoTradeEnabled = true;
      await engAny.autoTradeTick();

      const s = eng.getAutoTradeStatus();
      expect(s.positions.find((p) => p.symbol === "AAPL")).toBeUndefined(); // 새로 진입 시도를 안 함(이미 보유 중이므로 정상)
      expect(s.skipReasons.AAPL).toBeDefined();
      expect(s.skipReasons.AAPL).toContain("이미"); // "이미 보유 중" 계열 사유가 남아야 함
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // [v0.60.0 긴급수정 — 오너 실사용 보고: "스크리너에 종료·탈락 종목(SDEV, BIYA 등)이 계속
  //   남는다 — 새로고침해도 실제 상태로 안 바뀐다"] 원인: freeSlots<=0(자리가 꽉 참)이면
  //   autoTradeTick이 스캔 자체를 생략하고 화면엔 몇 사이클 전 lastScan이 그대로 남는다.
  //   이 최적화 자체는 5분 정기 사이클에선 맞지만, 오너가 [🔄 지금 새로고침]을 직접 눌렀을
  //   때(autoScanNow → forceScan)까지 똑같이 생략하면 "새로고침해도 안 바뀜"으로 보인다.
  //   이제 forceScan이면 자리가 꽉 차 있어도 실제로 다시 스캔해 lastScan을 통째로 새로 채운다
  //   (신규 진입 자체는 canAutoEnter가 activePositionCount로 별도로 계속 막으므로 안전).
  // ===========================================================================
  it("[v0.60.0] 자동매매 자리가 꽉 차 있어도, 수동 새로고침(autoScanNow)은 스캔을 생략하지 않고 lastScan을 최신으로 갈아 끼운다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 1 }); // 자리 1개뿐
      const engAny = eng as unknown as EngineInternals & {
        autoTradeLastScan: unknown;
        autoTradeEnabled: boolean;
        scanScreener: (opts?: unknown) => Promise<unknown>;
      };
      // 자리를 꽉 채운다(freeSlots = 1 - 1 = 0).
      engAny.autoTradePositions.push({
        symbol: "TSLA", entry: 5, tp: 5.5, sl: 4.5, quantity: 1, enteredAtMs: Date.now(),
        status: "watching", conditionalOrderId: null,
      });
      // 몇 사이클 전에 박제된 "확정" 스캔(오너가 본 SDEV/BIYA 같은 오래된 잔상)을 흉내낸다.
      engAny.autoTradeLastScan = {
        scannedAt: "09-28 09:00:00", total: 1, priceMin: 1, priceMax: 9, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "STALEX", price: 3, ema200: 2, prevClose: 2.5, cloudTop: 1.9,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 3.1, proximityPct: -3, n1m: 300, n5m: 60, evidence: null,
        }],
      };
      // 새로고침을 누르면 실제로 다시 훑을 것이므로, 그 결과를 빠르고 결정적으로 가짜 응답한다.
      engAny.scanScreener = async () => ({
        scannedAt: "09-30 21:50:00", total: 1, priceMin: 1, priceMax: 9, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "FRESH1", price: 4, ema200: 3, prevClose: 3.5, cloudTop: 2.9,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 4.1, proximityPct: -3, n1m: 300, n5m: 60, evidence: null,
        }],
      });
      engAny.autoTradeEnabled = true;

      const s = await eng.autoScanNow();
      expect(s.lastScan?.scannedAt).toBe("09-30 21:50:00"); // 스캔을 생략하지 않고 실제로 다시 돌았어야 함
      expect(s.lastScan?.results.some((r) => r.symbol === "STALEX")).toBe(false); // 옛 잔상이 사라져야 함
      expect(s.lastScan?.results.some((r) => r.symbol === "FRESH1")).toBe(true);
      // 자리는 여전히 꽉 차 있으므로(canAutoEnter가 별도로 막음) FRESH1으로 실제 진입은 안 났어야 한다.
      expect(s.positions.find((p) => p.symbol === "FRESH1")).toBeUndefined();
      expect(s.skipReasons.FRESH1).toBeDefined(); // 왜 못 들어갔는지 사유가 남아야 함(자리 없음 계열)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // [v0.60.0 긴급 수정 — 오너 실사용 보고: "200 EMA 아래로 꺾인 하락 추세인데 진입이 났다"]
  //   원인: level1 진입가는 스캔(run.results) 시점의 스냅샷(prevClose/ema200)으로만 계산되고,
  //   실제 매수 주문(placeBracketCore)은 스캔 전체가 끝난 뒤 한참 지나서 나갈 수 있는데, 그
  //   사이 현재가가 EMA200 아래로 떨어져도 재확인 없이 그대로 주문이 나갔다. 이제 주문 직전에
  //   현재가를 다시 조회해 EMA200 위인지 확인하고, 깨져 있으면 진입을 취소한다.
  it("[v0.60.0] 스캔 때는 EMA200 위였지만 주문 직전 재확인 때 현재가가 EMA200 아래로 떨어졌으면 진입하지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 3 });
      const engAny = eng as unknown as EngineInternals & {
        scanScreener: (opts?: unknown) => Promise<unknown>;
      };
      // 스캔 시점 스냅샷: TSLA가 confirmed, ema200=200 · prevClose=210(EMA200 위 — 정상 진입 조건).
      engAny.scanScreener = async () => ({
        scannedAt: "09-30 12:00:00", total: 1, priceMin: 1, priceMax: 9999, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "TSLA", price: 210, ema200: 200, prevClose: 210, cloudTop: 190,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 212, proximityPct: -1, n1m: 300, n5m: 60, evidence: null,
        }],
      });
      // 스캔이 끝난 뒤(=주문 직전 재확인 시점) 현재가가 EMA200(200) 아래로 떨어졌다고 가정
      // (스캔~집행 사이 시차 동안 추세가 무너진 실제 상황을 재현).
      await eng.mockSetPrice("TSLA", 190);

      engAny.autoTradeEnabled = true;
      await engAny.autoTradeTick();

      const s = eng.getAutoTradeStatus();
      expect(s.positions.find((p) => p.symbol === "TSLA")).toBeUndefined(); // 진입하지 않아야 한다(핵심)
      expect(s.skipReasons.TSLA).toBeDefined();
      expect(s.skipReasons.TSLA).toContain("재확인");
      expect(s.skipReasons.TSLA).toContain("EMA200");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.60.0] 반대로 주문 직전 재확인 때도 여전히 EMA200 위면(정상 케이스) 평소대로 진입한다(회귀 없음 확인)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 3 });
      const engAny = eng as unknown as EngineInternals & {
        scanScreener: (opts?: unknown) => Promise<unknown>;
      };
      engAny.scanScreener = async () => ({
        scannedAt: "09-30 12:00:00", total: 1, priceMin: 1, priceMax: 9999, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "TSLA", price: 210, ema200: 200, prevClose: 210, cloudTop: 190,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 212, proximityPct: -1, n1m: 300, n5m: 60, evidence: null,
        }],
      });
      // 주문 직전에도 여전히 EMA200(200) 위(205) — 재확인 통과해야 정상 진입.
      await eng.mockSetPrice("TSLA", 205);

      engAny.autoTradeEnabled = true;
      await engAny.autoTradeTick();

      const s = eng.getAutoTradeStatus();
      expect(s.positions.find((p) => p.symbol === "TSLA")).toBeDefined(); // 정상 진입돼야 한다
      expect(s.skipReasons.TSLA).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // [v0.60.0 긴급 수정 — 오너 실사용 보고: "1차 타점 3944 익절 후, 하락하다 일시 반등할 때 2차
  //   타점을 더 높은 3966으로 잡아 오발주(취소 처리함)"] 하락 추세에서 직전 타점보다 더 높은
  //   가격으로 재진입하는 건 삼분할 기법("얕게 눌렸을 때 사는" 전략)의 논리에 정면으로 어긋난다.
  it("[v0.60.0] 24시간 안에 같은 종목에 더 낮은 가격으로 넣었던 기록이 있는데, 새 타점이 그보다 높으면 재진입을 취소한다(방향 정합성)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 3 });
      const engAny = eng as unknown as EngineInternals & {
        scanScreener: (opts?: unknown) => Promise<unknown>;
        autoTradeHistory: AutoTradeHistoryEntry[];
      };
      // 1차 타점(3944)이 이미 익절로 종료된 기록으로 남아 있다(오너 사례 그대로).
      engAny.autoTradeHistory.push({
        id: `TSLA@3944@${Date.now() - 60_000}`,
        symbol: "TSLA", entry: 3944, tp: 4023, sl: 3549, quantity: 1,
        enteredAt: "09-30 12:00:00", status: "closed_win",
        exitedAt: "09-30 12:30:00", exitPrice: 4023, pnlUsd: 79, pnlPct: 2,
        note: "익절", conditionalOrderId: null, buyOrderId: null,
      });
      // 반등으로 prevClose가 올라가, 새 스캔의 1분할 타점이 1차(3944)보다 높게(약 3967) 나온다.
      engAny.scanScreener = async () => ({
        scannedAt: "09-30 13:00:00", total: 1, priceMin: 1, priceMax: 9999, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "TSLA", price: 4000, ema200: 3900, prevClose: 4000, cloudTop: 3800,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 4010, proximityPct: -1, n1m: 300, n5m: 60, evidence: null,
        }],
      });
      await eng.mockSetPrice("TSLA", 4000); // EMA200 재확인은 통과하게(이 테스트의 관심사가 아님)

      engAny.autoTradeEnabled = true;
      await engAny.autoTradeTick();

      const s = eng.getAutoTradeStatus();
      expect(s.positions.find((p) => p.symbol === "TSLA")).toBeUndefined(); // 재진입하지 않아야 한다(핵심)
      expect(s.skipReasons.TSLA).toBeDefined();
      expect(s.skipReasons.TSLA).toContain("직전 타점");
      expect(s.skipReasons.TSLA).toContain("3944");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.60.0] 반대로 새 타점이 직전 타점과 같거나 더 낮으면(정상적인 하락 재진입) 평소대로 진입한다(회귀 없음 확인)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 3 });
      const engAny = eng as unknown as EngineInternals & {
        scanScreener: (opts?: unknown) => Promise<unknown>;
        autoTradeHistory: AutoTradeHistoryEntry[];
      };
      // 1차 타점(4000)이 손절로 종료된 기록 — 그 뒤 더 하락해서 2차 타점이 더 낮게(3400대) 나온다.
      engAny.autoTradeHistory.push({
        id: `TSLA@4000@${Date.now() - 60_000}`,
        symbol: "TSLA", entry: 4000, tp: 4080, sl: 3600, quantity: 1,
        enteredAt: "09-30 12:00:00", status: "closed_loss",
        exitedAt: "09-30 12:20:00", exitPrice: 3600, pnlUsd: -400, pnlPct: -10,
        note: "손절", conditionalOrderId: null, buyOrderId: null,
      });
      engAny.scanScreener = async () => ({
        scannedAt: "09-30 13:00:00", total: 1, priceMin: 1, priceMax: 9999, excludedEtf: 0,
        results: [{
          rank: 1, symbol: "TSLA", price: 3500, ema200: 3400, prevClose: 3500, cloudTop: 3300,
          priceInBand: true, aboveEma: true, aboveCloud: true, status: "confirmed",
          sessionHigh: 3520, proximityPct: -1, n1m: 300, n5m: 60, evidence: null,
        }],
      });
      await eng.mockSetPrice("TSLA", 3500);

      engAny.autoTradeEnabled = true;
      await engAny.autoTradeTick();

      const s = eng.getAutoTradeStatus();
      expect(s.positions.find((p) => p.symbol === "TSLA")).toBeDefined(); // 정상 진입돼야 한다(더 낮은 재진입은 정상)
      expect(s.skipReasons.TSLA).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.32.0] 알림 — 스크리닝 관찰 확정 + 주문 이벤트", () => {
  function mkResult(symbol: string, status: ScreenResult["status"]): ScreenResult {
    return {
      rank: 1, symbol, price: 2.5, ema200: 2, prevClose: 2.1, cloudTop: 1.9,
      priceInBand: true, aboveEma: true, aboveCloud: true, status,
      sessionHigh: 2.6, proximityPct: -3, n1m: 300, n5m: 60, evidence: null,
    };
  }

  it("newlyConfirmedSymbols — 직전에 이미 확정이었던 종목은 제외하고, 새로 확정된 것만 돌려준다", () => {
    const results = [mkResult("AAPL", "confirmed"), mkResult("TSLA", "confirmed"), mkResult("MSFT", "watch")];
    // AAPL은 직전 스캔에서도 이미 확정이었음 → 이번엔 제외. TSLA는 새로 확정됨 → 포함.
    // MSFT는 confirmed가 아니므로(watch) 애초에 대상이 아님.
    const added = newlyConfirmedSymbols(results, new Set(["AAPL"]));
    expect(added).toEqual(["TSLA"]);
  });

  it("newlyConfirmedSymbols — 직전 스캔에 아무 것도 없었으면(첫 스캔) 지금 확정된 전부가 신규다", () => {
    const results = [mkResult("AAPL", "confirmed"), mkResult("TSLA", "none")];
    expect(newlyConfirmedSymbols(results, new Set())).toEqual(["AAPL"]);
  });

  it("stopAutoTrade — 이유가 있을 때만(손실 한도 등 프로그램이 스스로 멈춘 경우) 알림을 낸다, 오너가 직접 누른 중지는 알리지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const notifies: NotifyEvent[] = [];
      eng.on("notify", (n: NotifyEvent) => notifies.push(n));

      eng.stopAutoTrade(); // 오너가 직접 [중지] 버튼을 누른 경우 — 당연한 걸 또 알릴 필요 없음
      expect(notifies).toHaveLength(0);

      eng.stopAutoTrade("최대손실 한도 도달 — 테스트");
      expect(notifies).toHaveLength(1);
      expect(notifies[0].title).toContain("자동 중지");
      expect(notifies[0].body).toContain("최대손실 한도 도달");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.33.0] 스크리닝 기준 탭 — 조건별 켜짐/꺼짐 + 수치가 실제 저장·복원된다", () => {
  it("공장값은 지금까지의 고정 동작과 완전히 같다(EMA200 ON·구름 ON·꼬리비율 10%·신선도 40분 ON·다음봉확인 ON·ETF제외 ON)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const s = eng.getSettings();
      expect(s.autoScanEmaTrendEnabled).toBe(true);
      expect(s.autoScanEmaPeriod).toBe(200);
      expect(s.autoScanCloudEnabled).toBe(true);
      expect(s.autoScanDojiWickMinRatio).toBe(0.1);
      expect(s.autoScanDojiMaxAgeEnabled).toBe(true);
      expect(s.autoScanDojiMaxAgeMinutes).toBe(40);
      expect(s.autoScanNextCandleConfirmEnabled).toBe(true);
      expect(s.autoScanExcludeEtf).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("전부 바꿔 저장하면 재시작(새 엔진 인스턴스)해도 그대로 유지된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const saved = eng.saveAutoScanSettings({
        emaTrendEnabled: false,
        emaPeriod: 120,
        cloudEnabled: false,
        dojiWickMinRatio: 0.2,
        dojiMaxAgeEnabled: false,
        dojiMaxAgeMinutes: 90,
        nextCandleConfirmEnabled: false,
        excludeEtf: false,
      });
      expect(saved.autoScanEmaTrendEnabled).toBe(false);
      expect(saved.autoScanEmaPeriod).toBe(120);
      expect(saved.autoScanCloudEnabled).toBe(false);
      expect(saved.autoScanDojiWickMinRatio).toBe(0.2);
      expect(saved.autoScanDojiMaxAgeEnabled).toBe(false);
      expect(saved.autoScanDojiMaxAgeMinutes).toBe(90);
      expect(saved.autoScanNextCandleConfirmEnabled).toBe(false);
      expect(saved.autoScanExcludeEtf).toBe(false);

      const eng2 = new ToolEngine(dir, { forceMock: true });
      const s2 = eng2.getSettings();
      expect(s2.autoScanEmaTrendEnabled).toBe(false);
      expect(s2.autoScanEmaPeriod).toBe(120);
      expect(s2.autoScanCloudEnabled).toBe(false);
      expect(s2.autoScanDojiWickMinRatio).toBe(0.2);
      expect(s2.autoScanDojiMaxAgeEnabled).toBe(false);
      expect(s2.autoScanDojiMaxAgeMinutes).toBe(90);
      expect(s2.autoScanNextCandleConfirmEnabled).toBe(false);
      expect(s2.autoScanExcludeEtf).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("EMA 기간은 50~300으로, 도지 꼬리비율은 0~0.4로, 신선도는 10~180분으로 안전 보정된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.saveAutoScanSettings({ emaPeriod: 10 }).autoScanEmaPeriod).toBe(50);
      expect(eng.saveAutoScanSettings({ emaPeriod: 500 }).autoScanEmaPeriod).toBe(300);
      // 도지 꼬리비율: 범위 밖 값(0.9)은 상한(0.4)으로 "보정"되지만, 음수(-1)는 애초에 말이
      // 안 되는 입력이라 다른 항목(bodyRatio 등)과 같은 규칙으로 통째로 "거부"되어 직전 값이
      // 그대로 유지된다(보정이 아니라 거부) — 그래서 먼저 0.15로 기준값을 확실히 잡아둔 뒤,
      // -1을 보내도 그 0.15가 안 바뀌는지를 검증한다(테스트 시작 시 기본값 0.1에 기대는 대신).
      expect(eng.saveAutoScanSettings({ dojiWickMinRatio: 0.15 }).autoScanDojiWickMinRatio).toBe(0.15);
      expect(eng.saveAutoScanSettings({ dojiWickMinRatio: -1 }).autoScanDojiWickMinRatio).toBe(0.15);
      expect(eng.saveAutoScanSettings({ dojiWickMinRatio: 0.9 }).autoScanDojiWickMinRatio).toBe(0.4);
      expect(eng.saveAutoScanSettings({ dojiMaxAgeMinutes: 1 }).autoScanDojiMaxAgeMinutes).toBe(10);
      expect(eng.saveAutoScanSettings({ dojiMaxAgeMinutes: 999 }).autoScanDojiMaxAgeMinutes).toBe(180);
      // [v0.61.10] 최고점→도지 간격: 공장값 ON·30분, 5~240 범위로 보정, 껐다 켜도 저장 유지
      expect(eng.getSettings().autoScanDojiMaxGapEnabled).toBe(true);
      expect(eng.getSettings().autoScanDojiMaxGapMinutes).toBe(30);
      expect(eng.saveAutoScanSettings({ dojiMaxGapMinutes: 1 }).autoScanDojiMaxGapMinutes).toBe(5);
      expect(eng.saveAutoScanSettings({ dojiMaxGapMinutes: 999 }).autoScanDojiMaxGapMinutes).toBe(240);
      expect(eng.saveAutoScanSettings({ dojiMaxGapMinutes: 45, dojiMaxGapEnabled: false }).autoScanDojiMaxGapEnabled).toBe(false);
      const eng2 = new ToolEngine(dir, { forceMock: true });
      expect(eng2.getSettings().autoScanDojiMaxGapEnabled).toBe(false);
      expect(eng2.getSettings().autoScanDojiMaxGapMinutes).toBe(45);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildAutoScanOpts는 저장된 8개 항목 전부를 scanScreener 옵션으로 그대로 넘긴다(가장 중요한 연동 지점)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoScanSettings({
        count: 45, priceMin: 3, priceMax: 20, bodyRatio: 0.5,
        emaTrendEnabled: false, emaPeriod: 150, cloudEnabled: false,
        dojiWickMinRatio: 0.15, dojiMaxAgeEnabled: false, dojiMaxAgeMinutes: 77,
        dojiMaxGapEnabled: false, dojiMaxGapMinutes: 60,
        nextCandleConfirmEnabled: false, excludeEtf: false,
      });
      const opts = (eng as unknown as { buildAutoScanOpts: () => Record<string, unknown> }).buildAutoScanOpts();
      expect(opts).toEqual({
        count: 45, priceMin: 3, priceMax: 20, bodyRatio: 0.5,
        emaTrendEnabled: false, emaPeriod: 150, cloudEnabled: false,
        dojiWickMinRatio: 0.15, dojiMaxAgeEnabled: false, dojiMaxAgeMinutes: 77,
        dojiMaxGapEnabled: false, dojiMaxGapMinutes: 60,
        nextCandleConfirmEnabled: false, excludeEtf: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.33.0] applyScreenGates — 토글이 실제 최종 판정에 반영되는지(순수 함수)", () => {
  it("모든 게이트가 열려 있으면 도지 패턴 그대로 통과한다", () => {
    expect(applyScreenGates("confirmed", { priceInBand: true, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: true })).toBe("confirmed");
    expect(applyScreenGates("watch", { priceInBand: true, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: true })).toBe("watch");
    expect(applyScreenGates("none", { priceInBand: true, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: true })).toBe("none");
  });

  it("가격대·EMA·구름 중 하나라도 게이트가 막히면 패턴과 무관하게 none이다", () => {
    expect(applyScreenGates("confirmed", { priceInBand: false, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: true })).toBe("none");
    expect(applyScreenGates("confirmed", { priceInBand: true, emaGateOk: false, cloudGateOk: true, nextCandleConfirmEnabled: true })).toBe("none");
    expect(applyScreenGates("confirmed", { priceInBand: true, emaGateOk: true, cloudGateOk: false, nextCandleConfirmEnabled: true })).toBe("none");
  });

  it("다음 봉 확인을 꺼 두면(nextCandleConfirmEnabled=false) 'watch'가 곧바로 'confirmed'로 승격된다", () => {
    expect(applyScreenGates("watch", { priceInBand: true, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: false })).toBe("confirmed");
    // confirmed/none은 그대로 유지(승격 대상이 watch일 때만 의미 있음)
    expect(applyScreenGates("confirmed", { priceInBand: true, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: false })).toBe("confirmed");
    expect(applyScreenGates("none", { priceInBand: true, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: false })).toBe("none");
  });

  it("다음 봉 확인을 꺼도 하드 게이트(가격대 등)가 막혀 있으면 여전히 none이다", () => {
    expect(applyScreenGates("watch", { priceInBand: false, emaGateOk: true, cloudGateOk: true, nextCandleConfirmEnabled: false })).toBe("none");
  });
});

// =============================================================================
// [v0.40.0 버그 수정 → v0.55.0 재수정] "투입 시드 비율에 맞지않게 적게 투입되고있음"
// -----------------------------------------------------------------------------
//   auto 모드(seedBasis="auto")는 예전엔 5분 사이클마다 매번 "지금 이 순간의 매수가능금액"을
//   새로 조회했다. 자동매매 자신이 이미 진입해서 현금을 써버리면, 다음 사이클의 "종목당 시드
//   대비 N%" 계산은 이미 줄어든 잔여 현금을 기준으로 다시 N%를 매기게 돼, 슬롯을 거듭할수록
//   실제 투입액이 오너가 설정한 비율보다 작아졌다(예: 30%×3종목=최대 90% 의도였는데 실제로는
//   65~70%선). v0.40.0은 이걸 "이번 자동매매 실행 동안 딱 한 번만 조회하고 그 값을 스냅샷으로
//   고정"으로 막았다.
//
//   [v0.55.0] 그런데 "고정"을 문자 그대로 구현해서, 자동매매를 켠 뒤에 새로 입금해도(잔고가
//   늘어도) 그 늘어난 잔고를 재시작 전까지 영영 반영 못 하는 새 버그가 생겼다(오너 실사용 보고:
//   "잔고 $33 있는데 1주도 못 산다고 리젝됨" — 실제로는 자동매매를 켠 시점의 더 낮았던 잔고로
//   계속 계산 중이었다). 이제 매 사이클 다시 조회하되, 스냅샷보다 "낮아지면" 무시(v0.40.0 취지
//   유지), "높아지면"(입금 등)만 갱신한다. 목 서버(mocks/toss-mock.ts)는 매수가능금액을 항상
//   고정값($10000)으로 응답하므로, "낮은 스냅샷은 절대 안 내려간다"/"낮게 시작하면 올라간다"
//   두 방향을 스냅샷을 직접 다른 값으로 미리 세팅해 두고 검증한다.
// =============================================================================
describe("[v0.40.0→v0.55.0] auto 모드 시드 스냅샷 — 지출로는 안 줄고, 입금으로는 늘어난다", () => {
  type EngineInternals = {
    autoTradeSeedSnapshotUsd: number | null;
    resolveSeedUsd: () => Promise<number | null>;
    prepareBackend: () => Promise<void>;
  };

  it("처음 호출하면 실계좌 매수가능금액을 조회해 스냅샷으로 저장한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      await engAny.prepareBackend();
      expect(engAny.autoTradeSeedSnapshotUsd).toBeNull(); // 아직 한 번도 조회 안 함
      const seed = await engAny.resolveSeedUsd();
      expect(seed).toBe(10000); // 목 서버 고정 매수가능금액
      expect(engAny.autoTradeSeedSnapshotUsd).toBe(10000); // 스냅샷에 저장됨
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("스냅샷보다 실제 잔고가 낮으면(지출로 줄어든 상황을 흉내) 스냅샷을 그대로 유지한다(v0.40.0 보호 유지)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      await engAny.prepareBackend();
      await engAny.resolveSeedUsd(); // 첫 호출 — 스냅샷 $10000으로 채워짐

      // 목 서버는 항상 $10000을 응답 — 스냅샷을 그보다 "높게" 미리 세팅해 두면(예: 이미
      // 더 큰 시드로 실행 중이었다고 가정), 다시 조회해도 $10000(더 낮음)으로 깎이면 안 된다.
      engAny.autoTradeSeedSnapshotUsd = 54321;
      const seed2 = await engAny.resolveSeedUsd();
      expect(seed2).toBe(54321); // 실제 조회값(10000)보다 낮아지지 않음
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[v0.55.0 긴급 수정 — 오너 보고 회귀] 스냅샷보다 실제 잔고가 높아지면(입금) 다음 사이클에 새 값으로 갱신한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      await engAny.prepareBackend();

      // 자동매매를 켠 시점엔 잔고가 낮았다고 가정(예: 아직 입금 전, $33보다도 한참 적은 $5).
      engAny.autoTradeSeedSnapshotUsd = 5;
      const seed = await engAny.resolveSeedUsd();
      // 목 서버 실제 조회값($10000)이 옛 스냅샷($5)보다 높으므로 이제는 갱신돼야 한다
      // — v0.40.0 당시엔 이 경우도 무조건 옛 값(5)을 그대로 돌려줘 "1주도 못 산다"는 오사고로 이어졌다.
      expect(seed).toBe(10000);
      expect(engAny.autoTradeSeedSnapshotUsd).toBe(10000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startAutoTrade()는 스냅샷을 초기화해 '이번 실행'에 새로 조회하게 한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      await engAny.prepareBackend();
      await engAny.resolveSeedUsd();
      expect(engAny.autoTradeSeedSnapshotUsd).toBe(10000);

      eng.startAutoTrade(); // 상태 전환 자체만 확인(백그라운드 스캔은 fire-and-forget, 기존 패턴과 동일)
      expect(engAny.autoTradeSeedSnapshotUsd).toBeNull(); // 새 실행을 위해 초기화됐어야 함
      eng.stopAutoTrade();
      await new Promise((r) => setTimeout(r, 50)); // 백그라운드 스캔 잔여분 안전하게 흘려보냄
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("getAutoTradeStatus().seedUsdSnapshot는 auto 모드에서 스냅샷 값을, fixed 모드에서 고정값을 그대로 보여준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      await engAny.prepareBackend();
      await engAny.resolveSeedUsd();
      expect(eng.getAutoTradeStatus().seedUsdSnapshot).toBe(10000);

      eng.saveSeedSettings({ seedBasis: "fixed", seedFixedUsd: 777 });
      expect(eng.getAutoTradeStatus().seedUsdSnapshot).toBe(777); // fixed 모드는 스냅샷과 무관하게 고정값 그대로
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// [v0.41.0 — 오너 요청] "자동매매 주문건에 대해 취소 할 수 있는 버튼 추가"
// =============================================================================
describe("[v0.41.0] cancelAutoPosition — 지금 감시 중인 포지션을 사람이 즉시 직접 취소", () => {
  type EngineInternals = {
    autoTradePositions: AutoPosition[];
    addAutoTradeHistory: (pos: AutoPosition) => void;
  };

  it("watching 포지션은 매수 주문 자체를 취소하고 목록·기록에서 즉시 정리한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      // 목 서버 AAPL 현재가(2.05)보다 낮게 걸어 즉시 체결되지 않게(watching 유지) 한다.
      const entryJournal = await eng.placeEntry({ symbol: "AAPL", price: 1.5, quantity: 3 });
      const buyOrderId = (entryJournal.detail as { tossOrderId: string }).tossOrderId;
      const enteredAtMs = Date.now();
      const pos: AutoPosition = {
        symbol: "AAPL", entry: 1.5, tp: 1.8, sl: 1.2, quantity: 3, enteredAtMs,
        status: "watching", conditionalOrderId: null, buyOrderId,
      };
      engAny.autoTradePositions.push(pos);
      engAny.addAutoTradeHistory(pos); // 실제 흐름(autoTradeTick)처럼 기록도 함께 남겨 둔다

      const res = await eng.cancelAutoPosition("AAPL", 1.5, enteredAtMs);
      expect(res.ok).toBe(true);
      expect(eng.getAutoTradeStatus().positions).toEqual([]); // 감시 목록에서 즉시 빠짐(5분 재확인 안 기다림)

      const rec = eng.getAutoTradeHistory().find((h) => h.id === `AAPL@1.5@${enteredAtMs}`);
      expect(rec?.status).toBe("closed_manual");
      expect(rec?.note).toContain("직접 취소");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("이미 사라진(존재하지 않는) 포지션을 취소하려 하면 실패로 알려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const res = await eng.cancelAutoPosition("GHOST", 1, Date.now());
      expect(res.ok).toBe(false);
      expect(res.message).toContain("사라진");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // [v0.60.0 긴급수정 — 오너 실사용 보고: "체결 완료된 종목(SLND·VNDA·SDEV)이 목록에
  //   남고 취소 버튼도 무반응"] active 포지션의 조건주문이 이미 익절/손절로 끝나 있는데
  //   (=Toss 쪽엔 더는 "취소할 살아있는 주문"이 없는데) 취소 버튼을 누르면, 예전엔
  //   cancelConditional 실패만 보고 끝이었다. 이제는 실패 직후 getConditionalOrder로
  //   실제 상태를 한 번 더 물어 COMPLETED면 "취소"가 아니라 "정리"로 처리해야 한다.
  // ===========================================================================
  it("[v0.60.0] 취소 시도 중 조건주문이 이미 COMPLETED(익절/손절로 종료)인 걸 확인하면, 실패 대신 '정리'로 처리해 목록에서 뺀다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 1) 실제 매수 체결 → OCO(조건주문) 등록까지 실제 흐름 그대로 태워 진짜 conditionalOrderId를 얻는다.
      const entry = await eng.placeEntry({ symbol: "AAPL", price: 2.1, quantity: 3 });
      const buyOrderId = (entry.detail as { tossOrderId: string }).tossOrderId;
      const enteredAtMs = Date.now();
      const engAny = eng as unknown as {
        autoTradePositions: AutoPosition[];
        reconcileAutoPositions: () => Promise<void>;
        cancelConditional: (id: string) => Promise<unknown>;
        addAutoTradeHistory: (pos: AutoPosition) => void;
      };
      const watchingPos: AutoPosition = {
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3,
        enteredAtMs, status: "watching", conditionalOrderId: null, buyOrderId,
      };
      engAny.autoTradePositions.push(watchingPos);
      engAny.addAutoTradeHistory(watchingPos); // 실제 흐름(autoTradeTick)처럼 기록도 함께 남겨 둔다
      const ocoPromise = waitForOcoJournal(eng);
      await engAny.reconcileAutoPositions(); // watching → active + 실제 OCO 등록
      await ocoPromise;

      // 2) 목 서버 현재가를 익절가(2.5) 위로 올려 조건주문을 실제로 COMPLETED시킨다(reevaluateOco).
      await eng.mockSetPrice("AAPL", 2.6);

      // 3) "취소 버튼을 눌렀는데 cancelConditional 자체가 실패하는" 상황만 강제로 재현한다
      //    (예: 취소 요청이 서버에 닿기 전 네트워크 오류 등) — 이미 끝난 주문이라 실패하는
      //    실제 사례는 목 서버가 DELETE를 항상 성공시켜 그대로 재현할 수 없어, 이 한 지점만
      //    오버라이드한다. 그 뒤의 재확인(getConditionalOrder)은 실제 네트워크·실제 목 서버
      //    상태(COMPLETED) 그대로 탄다.
      engAny.cancelConditional = async () => { throw new Error("네트워크 오류(모의)"); };

      const res = await eng.cancelAutoPosition("AAPL", 2.1, enteredAtMs);
      expect(res.ok).toBe(true);
      expect(res.message).toContain("이미 종료된 주문");
      expect(eng.getAutoTradeStatus().positions.find((p) => p.symbol === "AAPL")).toBeUndefined();

      const rec = eng.getAutoTradeHistory().find((h) => h.id === `AAPL@2.1@${enteredAtMs}`);
      expect(rec?.status).toBe("closed_win"); // 익절가(2.5) 돌파로 발동됐으므로
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  // ===========================================================================
  // [v0.60.1 긴급 — 오너 실사용 사고: SLND·VNDA·SDEV가 "조건주문 상태 확인 21회 연속
  //   실패(HTTP 404 conditional-order-not-found)"로 [자동매매 현황]에 계속 남고, 취소
  //   버튼도 같은 404로 실패만 반복했다] v0.60.0의 COMPLETED 재확인 로직은 "조건주문이
  //   살아있지만 이미 끝난(COMPLETED)" 경우만 다뤘다 — 이번엔 조건주문 ID 자체가 토스에
  //   더는 존재하지 않는(404) 경우로, 재시도해도 절대 좋아지지 않는다. 목서버의
  //   404 응답을 실서버와 같은 모양(error.code="conditional-order-not-found")으로
  //   고쳐서, 그 상황을 실제로 재현해 검증한다.
  // ===========================================================================
  it("[v0.60.1] 취소 시도 중 조건주문 자체가 토스에 없음(404 conditional-order-not-found)을 확인하면, 재확인 없이 바로 '정리'로 처리한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // [단순화] watching→active 부트스트랩(reconcile의 "재시작 후 복구" 경로, registerOcoForFilled
      // 재시도 로직까지 거침)을 타지 않고, placeOco로 직접 진짜 conditionalOrderId를 발급받아
      // "active" 포지션을 곧바로 구성한다 — 이 테스트가 실제로 검증하려는 건 reconcile/cancel의
      // "active" 분기(404 처리)뿐이라, 무관한 경로를 거칠수록 다른 원인의 흔들림(flakiness)만 늘어난다.
      const ocoEntry = await eng.placeOco({
        symbol: "AAPL", quantity: 3, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30",
      });
      const condId = (ocoEntry.detail as { conditionalOrderId: string }).conditionalOrderId;
      expect(condId).toBeTruthy();
      const enteredAtMs = Date.now();
      const engAny = eng as unknown as {
        autoTradePositions: AutoPosition[];
        addAutoTradeHistory: (pos: AutoPosition) => void;
        mock: { state: { conditionals: Map<string, unknown> } } | null;
      };
      const activePos: AutoPosition = {
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3,
        enteredAtMs, status: "active", conditionalOrderId: condId, buyOrderId: null,
      };
      engAny.autoTradePositions.push(activePos);
      engAny.addAutoTradeHistory(activePos);
      // 토스 쪽에서 이 조건주문이 통째로 사라진 상황을 그대로 재현한다(목서버 저장소에서 직접 삭제).
      engAny.mock?.state.conditionals.delete(condId);

      const res = await eng.cancelAutoPosition("AAPL", 2.1, enteredAtMs);
      expect(res.ok).toBe(true);
      expect(res.message).toContain("존재하지 않는");
      expect(eng.getAutoTradeStatus().positions.find((p) => p.symbol === "AAPL")).toBeUndefined();

      const rec = eng.getAutoTradeHistory().find((h) => h.id === `AAPL@2.1@${enteredAtMs}`);
      expect(rec?.status).toBe("closed_manual");
      expect(rec?.note).toContain("이미 없었음");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("[v0.60.1] reconcileAutoPositions 정기 재확인 때도 조건주문 404(not-found)를 만나면, 3회를 기다리지 않고 즉시 자리를 비운다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const ocoEntry = await eng.placeOco({
        symbol: "AAPL", quantity: 3, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30",
      });
      const condId = (ocoEntry.detail as { conditionalOrderId: string }).conditionalOrderId;
      const enteredAtMs = Date.now();
      const engAny = eng as unknown as {
        autoTradePositions: AutoPosition[];
        reconcileAutoPositions: () => Promise<void>;
        addAutoTradeHistory: (pos: AutoPosition) => void;
        mock: { state: { conditionals: Map<string, unknown> } } | null;
      };
      const activePos: AutoPosition = {
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3,
        enteredAtMs, status: "active", conditionalOrderId: condId, buyOrderId: null,
      };
      engAny.autoTradePositions.push(activePos);
      engAny.addAutoTradeHistory(activePos);
      engAny.mock?.state.conditionals.delete(condId);

      // 정기 재확인을 딱 한 번만 돌려도(3회를 기다리지 않고) 바로 정리돼야 한다 — v0.60.0의
      // "3회 연속 실패해야 경고" 로직은 모호한 실패용이라, 확정적인 404는 그 카운트를 안 태운다.
      await engAny.reconcileAutoPositions();

      expect(engAny.autoTradePositions.find((p) => p.symbol === "AAPL")).toBeUndefined();
      const rec = eng.getAutoTradeHistory().find((h) => h.id === `AAPL@2.1@${enteredAtMs}`);
      expect(rec?.status).toBe("closed_manual");
      expect(rec?.note).toContain("존재하지 않아");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  // ===========================================================================
  // [v0.61.8 긴급 보강 — 오너 실사용 사고 분석, 2026-10-01: CNTB] 손절 직전 조건주문을
  //   직접 취소했는데(의도는 "손절 방지"), 예전엔 이 경우 "조건주문이 사라짐 = 거래
  //   종료"로만 처리해 끝이었다 — 실제로는 주식이 계좌에 그대로 남아 보호장치 없이
  //   방치될 수 있는데 그 사실을 오너가 알 길이 없었다. 이제 정리 전에 실계좌를 다시
  //   확인해, 아직 보유 중이면 강하게 경고한다(목 서버는 AAPL을 항상 100주 보유 중으로
  //   응답하므로, 이 테스트의 기본 설정 자체가 "아직 보유 중" 시나리오를 재현한다).
  // ===========================================================================
  it("[v0.61.8] 조건주문이 사라졌는데 실계좌엔 여전히 보유 중이면 강한 경고(알림 포함)를 남긴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const ocoEntry = await eng.placeOco({
        symbol: "AAPL", quantity: 3, tpTrigger: 2.5, tpPrice: 2.5, slTrigger: 1.8, slPrice: 1.79, expireDate: "2026-12-30",
      });
      const condId = (ocoEntry.detail as { conditionalOrderId: string }).conditionalOrderId;
      const enteredAtMs = Date.now();
      const engAny = eng as unknown as {
        autoTradePositions: AutoPosition[];
        reconcileAutoPositions: () => Promise<void>;
        addAutoTradeHistory: (pos: AutoPosition) => void;
        mock: { state: { conditionals: Map<string, unknown> } } | null;
      };
      const activePos: AutoPosition = {
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3,
        enteredAtMs, status: "active", conditionalOrderId: condId, buyOrderId: null,
      };
      engAny.autoTradePositions.push(activePos);
      engAny.addAutoTradeHistory(activePos);
      engAny.mock?.state.conditionals.delete(condId); // 사람이 조건주문만 직접 취소한 상황 재현

      const notifyPromise = new Promise<NotifyEvent>((resolve) => eng.once("notify", resolve));
      await engAny.reconcileAutoPositions();

      expect(engAny.autoTradePositions.find((p) => p.symbol === "AAPL")).toBeUndefined();
      const rec = eng.getAutoTradeHistory().find((h) => h.id === `AAPL@2.1@${enteredAtMs}`);
      expect(rec?.note).toContain("보호장치 없이 방치");
      expect(rec?.note).toContain("직접 재확인 필요");

      // [핵심] "확인 못 함"과 구분되는 강한 알림이 실제로 떴는지(Discord 알림 경로와 동일하게 탄다).
      const notified = await notifyPromise;
      expect(notified.title).toContain("보호장치 없이 보유 중");
      expect(notified.symbol).toBe("AAPL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

// =============================================================================
// [v0.45.0 — 오너 요청] "각 사용자가 어떤 기준·필터로 자동매매를 진행했는지도 연구탭 데이터에
//   모이게" — capri_group_trades로 그룹 전체가 함께 보는 AutoTradeHistoryEntry에 진입 시점
//   스크리닝·리스크 설정 스냅샷(criteriaSnapshot)을 함께 남긴다.
// =============================================================================
describe("[v0.45.0] AutoTradeHistoryEntry.criteriaSnapshot — 진입 시점 설정 스냅샷", () => {
  type EngineInternals = {
    autoTradePositions: AutoPosition[];
    addAutoTradeHistory: (pos: AutoPosition, criteriaSnapshot?: Record<string, unknown>) => void;
  };

  it("addAutoTradeHistory에 넘긴 스냅샷이 getAutoTradeHistory()에 그대로 저장된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const enteredAtMs = Date.now();
      const pos: AutoPosition = {
        symbol: "AAPL", entry: 2.1, tp: 2.5, sl: 1.8, quantity: 3, enteredAtMs,
        status: "watching", conditionalOrderId: null,
      };
      engAny.autoTradePositions.push(pos);
      engAny.addAutoTradeHistory(pos, {
        bodyRatio: 0.3,
        emaTrendEnabled: true,
        emaPeriod: 200,
        cloudEnabled: false, // 이 매매는 구름 필터를 끈 상태로 진입했다는 걸 기록에서 알 수 있어야 함
        dojiWickMinRatio: 0.1,
        dojiMaxAgeEnabled: true,
        dojiMaxAgeMinutes: 40,
        nextCandleConfirmEnabled: true,
        excludeEtf: true,
        session: "regular",
        maxPositions: 3,
        maxLossPct: 5,
        maxInvestPct: 30,
        watchMinutes: 10,
      });

      const rec = eng.getAutoTradeHistory().find((h) => h.id === `AAPL@2.1@${enteredAtMs}`);
      expect(rec?.criteriaSnapshot?.cloudEnabled).toBe(false);
      expect(rec?.criteriaSnapshot?.session).toBe("regular");
      expect(rec?.criteriaSnapshot?.maxInvestPct).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // [참고] 실제 autoTradeTick(스캔→확정→진입) 경로 전체를 통해 스냅샷이 채워지는지까지는 여기서
  //   시뮬레이션하지 않는다 — 이 파일 맨 위 설명대로, 목 서버 캔들 모양상 "확정" 판정이 결정적으로
  //   나오지 않아 그런 테스트는 비결정적이다. 대신 electron/tool-engine.ts의 autoTradeTick 호출부가
  //   이 함수에 정확히 무엇을 넘기는지는 타입 체크(AutoTradeHistoryEntry["criteriaSnapshot"])가
  //   보장하고, addAutoTradeHistory 자체의 동작(넘긴 값을 그대로 저장하는지)은 위에서 직접 검증했다.
});

// =============================================================================
// [v0.61.8] 진입 타점 분할(1~2) 설정 — 오너 지시 "1타점으로 잡을지 2타점으로 잡을지 설정"
// =============================================================================
describe("[v0.61.8] 진입 타점 분할 설정(autoTradeEntryLevel)", () => {
  it("공장값은 1분할이고, saveAutoTradeSettings로 2분할을 저장하면 재시작해도 유지된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.getSettings().autoTradeEntryLevel).toBe(1);

      const saved = eng.saveAutoTradeSettings({ entryLevel: 2 });
      expect(saved.autoTradeEntryLevel).toBe(2);

      const eng2 = new ToolEngine(dir, { forceMock: true });
      expect(eng2.getSettings().autoTradeEntryLevel).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entryLevel을 안 주거나 1/2가 아닌 값을 주면 이전 값을 그대로 유지한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ entryLevel: 2 });
      // @ts-expect-error — 런타임 방어(원격 명령 등 외부 입력이 잘못된 값을 보낼 수 있음) 검증
      const after = eng.saveAutoTradeSettings({ entryLevel: 3, maxPositions: 5 });
      expect(after.autoTradeEntryLevel).toBe(2); // 잘못된 값은 무시되고 이전 값(2) 유지
      expect(after.autoTradeMaxPositions).toBe(5); // 다른 필드는 정상 저장
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// [v0.61.8 긴급 수정 — 오너 지적, 2026-10-01] "방향 정합성" 재진입 체크(findDirectionConflict)
// -----------------------------------------------------------------------------
// 오너 보고 원문: "한번이라도 거래한 종목에 대하여 더 높은 타점에서 재진입 하지 못하도록
//   시스템상에서 막고있는데... 타점 가격을 기준으로 생각해야지 과거 매매이력을 기준으로
//   하면 진입할 종목도 막히게 되는 경우가 있음." — 코드를 읽어보니 v0.60.0이 "최근 24시간
//   내 모든 기록(완전히 청산된 것 포함)"을 비교 대상으로 삼고 있어 오너 지적이 맞았다.
//   이제 ①아직 안 끝난 포지션은 항상 ②완료된 매매는 "최근(한 사이클)" 것만 비교한다.
// =============================================================================
describe("[v0.61.8] findDirectionConflict — 방향 정합성 재진입 체크", () => {
  function histEntry(over: Partial<AutoTradeHistoryEntry> = {}): AutoTradeHistoryEntry {
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
      note: "",
      ...over,
    };
  }

  it("몇 시간 전에 이미 완전히 청산된(closed_win) 매매는 비교 대상에서 제외된다(오너 지적 핵심)", () => {
    const now = 1_700_000_000_000;
    const history = [
      histEntry({ id: `AAPL@2.1@${now - 6 * 3600_000}`, status: "closed_win", entry: 2.1 }), // 6시간 전 익절, 완전히 끝남
    ];
    // 새 타점(2.3)이 6시간 전 진입가(2.1)보다 높아도, 이미 끝난 지 오래된 매매라 막히면 안 된다.
    const conflict = findDirectionConflict(history, "AAPL", now, 5 * 60_000);
    expect(conflict).toBeNull();
  });

  it("아직 안 끝난(watching) 포지션은 진입 시각과 무관하게 항상 비교 대상이다", () => {
    const now = 1_700_000_000_000;
    const history = [
      histEntry({ id: `AAPL@2.1@${now - 6 * 3600_000}`, status: "watching", entry: 2.1 }), // 6시간 전 진입, 아직 살아있음
    ];
    const conflict = findDirectionConflict(history, "AAPL", now, 5 * 60_000);
    expect(conflict?.entry).toBe(2.1); // 여전히 비교 대상 — 더 비싼 재진입은 막혀야 함
  });

  it("방금(한 사이클 이내) 청산된 매매는 여전히 비교 대상이다(v0.60.0 원래 사고 재현 방지)", () => {
    const now = 1_700_000_000_000;
    const history = [
      histEntry({ id: `AAPL@2.1@${now - 2 * 60_000}`, status: "closed_win", entry: 2.1 }), // 2분 전 익절
    ];
    const conflict = findDirectionConflict(history, "AAPL", now, 5 * 60_000); // 5분 윈도우
    expect(conflict?.entry).toBe(2.1);
  });

  it("드라이런 기록은 비교 대상에서 제외된다", () => {
    const now = 1_700_000_000_000;
    const history = [histEntry({ id: `AAPL@2.1@${now - 60_000}`, status: "dryrun", entry: 2.1 })];
    expect(findDirectionConflict(history, "AAPL", now, 5 * 60_000)).toBeNull();
  });

  it("다른 종목의 기록은 비교 대상에서 제외된다", () => {
    const now = 1_700_000_000_000;
    const history = [histEntry({ id: `TSLA@2.1@${now - 60_000}`, symbol: "TSLA", status: "watching", entry: 2.1 })];
    expect(findDirectionConflict(history, "AAPL", now, 5 * 60_000)).toBeNull();
  });
});
