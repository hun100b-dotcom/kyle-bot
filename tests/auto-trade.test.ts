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

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolEngine, computeSeedQty, newlyConfirmedSymbols, applyScreenGates,
  type AutoPosition, type JournalEntry, type NotifyEvent, type ScreenResult,
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
      const saved = eng.saveAutoTradeSettings({ maxPositions: 5, maxLossPct: 8, maxInvestPct: 50 });
      expect(saved.autoTradeMaxPositions).toBe(5);
      expect(saved.autoTradeMaxLossPct).toBe(8);
      expect(saved.autoTradeMaxInvestPct).toBe(50);

      const eng2 = new ToolEngine(dir, { forceMock: true });
      const s2 = eng2.getSettings();
      expect(s2.autoTradeMaxPositions).toBe(5);
      expect(s2.autoTradeMaxLossPct).toBe(8);
      expect(s2.autoTradeMaxInvestPct).toBe(50);
      // [안전 원칙] "켜짐" 자체는 절대 저장되지 않는다 — 재시작하면 항상 꺼진 채 시작.
      expect(s2.autoTradeEnabled).toBe(false);
      expect(eng2.getAutoTradeStatus().enabled).toBe(false);
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

describe("[v0.32.0] 중복진입 방지 — 여러 기기가 동시에 자동매매를 켰을 때의 안전장치", () => {
  // [왜 이 테스트가 필요한가] v0.30.1까지는 "지금 몇 종목 보유 중인가"를 이 프로세스의 로컬
  //   파일(autoTradePositions)만 보고 판단했다. 오너가 윈도우·맥북 등 서로 다른 기기에서 각각
  //   앱을 켜고 자동매매를 동시에 시작하면, 두 번째 기기는 첫 번째 기기가 이미 넣은 실제 주문을
  //   전혀 모른 채 같은 종목에 또 진입하거나 최대 종목 수를 합쳐서 넘어설 수 있었다. v0.32.0은
  //   신규 진입 직전 실계좌 보유 현황(fetchRealHeldSymbols)을 직접 조회해 이 로컬 파일의 착시를
  //   깨는 게 핵심이라, 아래 테스트들은 "로컬 기록은 비어 있는데 실계좌엔 이미 있는" 상황을
  //   일부러 재현한다(목 서버 holdings는 AAPL 100주 보유로 고정돼 있어 이 상황을 그대로 흉내낼
  //   수 있음 — mocks/toss-mock.ts 참고).
  type EngineInternals = {
    autoTradeEnabled: boolean;
    autoTradePositions: AutoPosition[];
    autoTradeLastScan: unknown;
    fetchRealHeldSymbols: () => Promise<Set<string> | null>;
    effectiveActivePositionCount: (realHeldSymbols: Set<string>) => number;
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

  it("effectiveActivePositionCount는 실계좌 보유 + 아직 실계좌엔 안 잡히는 로컬 watching만 더하고, 같은 종목은 중복으로 세지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const engAny = eng as unknown as EngineInternals;
      const mk = (symbol: string): AutoPosition => ({
        symbol, entry: 1, tp: 1.2, sl: 0.9, quantity: 1, enteredAtMs: Date.now(),
        status: "watching", conditionalOrderId: null,
      });
      // AAPL은 실계좌에도 있고 로컬에도 있음(같은 것) → 1개로만 셈. TSLA는 로컬에만 있는
      // "아직 체결 전" 주문 → 별도로 1개 더함.
      engAny.autoTradePositions.push(mk("AAPL"), mk("TSLA"));
      const count = engAny.effectiveActivePositionCount(new Set(["AAPL"]));
      expect(count).toBe(2); // AAPL(중복 제외, 실계좌 기준 1개) + TSLA(로컬 전용 1개)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("로컬 기록이 텅 비어 있어도(=다른 기기가 넣은 걸 이 기기가 모름) 실계좌 보유가 이미 최대 종목 수만큼 있으면 이번 사이클은 신규 스캔·진입을 건너뛴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-auto-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveAutoTradeSettings({ maxPositions: 1 }); // 목 서버가 항상 AAPL 1종목을 보유 중이라고 답하므로 이미 꽉 참
      const engAny = eng as unknown as EngineInternals;
      expect(engAny.autoTradePositions).toEqual([]); // 이 기기의 로컬 기록은 완전히 비어 있음(핵심 전제)

      engAny.autoTradeEnabled = true; // startAutoTrade()의 백그라운드 반복 없이 tick 한 번만 직접 검증
      await engAny.autoTradeTick();

      // freeSlots = maxPositions(1) - effectiveActivePositionCount(실계좌 AAPL 1개) = 0 → 스캔 자체를 생략해야 함
      expect(engAny.autoTradeLastScan).toBeNull();
      expect(eng.getAutoTradeStatus().positions).toEqual([]); // 이 기기가 새로 진입 기록을 남기지 않았어야 함
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
        nextCandleConfirmEnabled: false, excludeEtf: false,
      });
      const opts = (eng as unknown as { buildAutoScanOpts: () => Record<string, unknown> }).buildAutoScanOpts();
      expect(opts).toEqual({
        count: 45, priceMin: 3, priceMax: 20, bodyRatio: 0.5,
        emaTrendEnabled: false, emaPeriod: 150, cloudEnabled: false,
        dojiWickMinRatio: 0.15, dojiMaxAgeEnabled: false, dojiMaxAgeMinutes: 77,
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
