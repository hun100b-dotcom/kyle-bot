// =============================================================================
// tests/strength.test.ts — 체결강도(틱룰) 계산 회귀 테스트 (v0.5.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나?]
//   토스 체결(틱)에는 매수/매도 방향이 없어, 틱룰(Lee&Ready)로 추정한다:
//   업틱=매수, 다운틱=매도, 동일가=직전 방향 승계. 그 뒤 체결강도=(매수/매도)×100.
//   이 규칙이 조용히 틀리면 화면 숫자가 통째로 엉터리가 되므로 테스트로 고정한다.
//
//   ① 순수 함수(lib/strength.ts): 분류·강도·seed 승계·경계값(매도0 등)
//   ② 엔진 왕복(연습 모드 + 임시폴더): 시작→샘플→파일 저장→재시작 재로딩→중지
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTicks, computeStrength, strengthFromTicks, type Tick } from "../lib/strength";
import { ToolEngine, type StrengthState } from "../electron/tool-engine";

// 시각 문자열 도우미(오름차순 보장용)
const T = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();

describe("틱룰 분류(classifyTicks)", () => {
  it("업틱=매수, 다운틱=매도로 분류한다", () => {
    const ticks: Tick[] = [
      { price: 10.0, volume: 1, timestamp: T(0) },
      { price: 10.1, volume: 1, timestamp: T(1) }, // 업틱 → buy
      { price: 10.0, volume: 1, timestamp: T(2) }, // 다운틱 → sell
    ];
    // 첫 틱은 seed(기본 buy). 이후 비교.
    const { classified } = classifyTicks(ticks);
    expect(classified.map((c) => c.side)).toEqual(["buy", "buy", "sell"]);
  });

  it("동일가(제로틱)는 직전 방향을 승계한다", () => {
    const ticks: Tick[] = [
      { price: 10.0, volume: 1, timestamp: T(0) },
      { price: 9.9, volume: 1, timestamp: T(1) }, // 다운틱 → sell
      { price: 9.9, volume: 1, timestamp: T(2) }, // 동일가 → 직전(sell) 승계
      { price: 9.9, volume: 1, timestamp: T(3) }, // 동일가 → sell
    ];
    const { classified } = classifyTicks(ticks);
    expect(classified.map((c) => c.side)).toEqual(["buy", "sell", "sell", "sell"]);
  });

  it("순서가 뒤섞여 들어와도 시각순으로 정렬해 분류한다", () => {
    const ticks: Tick[] = [
      { price: 10.2, volume: 1, timestamp: T(2) },
      { price: 10.0, volume: 1, timestamp: T(0) },
      { price: 10.1, volume: 1, timestamp: T(1) },
    ];
    const { classified, lastPrice } = classifyTicks(ticks);
    // 정렬 후 10.0 → 10.1(up) → 10.2(up)
    expect(classified.map((c) => c.price)).toEqual([10.0, 10.1, 10.2]);
    expect(classified.map((c) => c.side)).toEqual(["buy", "buy", "buy"]);
    expect(lastPrice).toBe(10.2);
  });

  it("직전 폴링 상태(prevPrice/prevSide)를 이어받아 첫 틱을 판정한다", () => {
    // 직전가 10.5에서 이어짐 → 첫 틱 10.4는 다운틱(sell)
    const { classified } = classifyTicks([{ price: 10.4, volume: 1, timestamp: T(0) }], 10.5, "buy");
    expect(classified[0].side).toBe("sell");
  });
});

describe("체결강도 계산(computeStrength)", () => {
  it("매수 6000·매도 4000 → 150.0", () => {
    const r = computeStrength([
      { price: 1, volume: 6000, timestamp: T(0), side: "buy" },
      { price: 1, volume: 4000, timestamp: T(1), side: "sell" },
    ]);
    expect(r.buyVol).toBe(6000);
    expect(r.sellVol).toBe(4000);
    expect(r.strength).toBe(150);
  });

  it("매수·매도 같으면 100(균형)", () => {
    const r = computeStrength([
      { price: 1, volume: 500, timestamp: T(0), side: "buy" },
      { price: 1, volume: 500, timestamp: T(1), side: "sell" },
    ]);
    expect(r.strength).toBe(100);
  });

  it("매도량이 0이면(전부 매수) strength=null('매수 일방')", () => {
    const r = computeStrength([{ price: 1, volume: 300, timestamp: T(0), side: "buy" }]);
    expect(r.sellVol).toBe(0);
    expect(r.strength).toBeNull();
  });

  it("매수량이 0이면 strength=0(완전 매도우세)", () => {
    const r = computeStrength([{ price: 1, volume: 300, timestamp: T(0), side: "sell" }]);
    expect(r.strength).toBe(0);
  });

  it("틱이 하나도 없으면 100(균형)으로 둔다", () => {
    expect(computeStrength([]).strength).toBe(100);
  });
});

describe("strengthFromTicks — 분류+계산 묶음", () => {
  it("2업틱·1다운틱(각 볼륨 동일)이면 매수2:매도1 → 200", () => {
    const ticks: Tick[] = [
      { price: 10.0, volume: 10, timestamp: T(0) }, // seed buy
      { price: 10.1, volume: 10, timestamp: T(1) }, // up buy
      { price: 10.0, volume: 10, timestamp: T(2) }, // down sell
    ];
    // buy=20, sell=10 → 200
    const { result } = strengthFromTicks(ticks);
    expect(result.strength).toBe(200);
  });
});

describe("엔진 왕복 — 체결강도 시작/샘플/저장/재시작(연습 모드)", () => {
  it("startStrength가 즉시 1회 샘플링해 파일에 저장하고, 재시작 후에도 남는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-str-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true }); // 실계좌 안 건드림

      // 이벤트로 첫 샘플이 오길 기다린다(즉시 1회 샘플링됨)
      const first = await new Promise<StrengthState>((resolve) => {
        eng.on("strength", (s: StrengthState) => resolve(s));
        eng.startStrength("AAPL", 10);
      });

      expect(first.symbol).toBe("AAPL");
      expect(first.running).toBe(true);
      expect(first.latest).not.toBeNull();
      // 목 서버는 매수 우세 지그재그를 주므로 강도 > 100 이어야 한다(또는 매수일방 null).
      const s = first.latest!;
      expect(s.nTicks).toBeGreaterThan(0);
      expect(s.strength === null || s.strength > 100).toBe(true);

      // 파일 저장 확인
      expect(existsSync(join(dir, "kylebot-strength.json"))).toBe(true);
      const saved = JSON.parse(readFileSync(join(dir, "kylebot-strength.json"), "utf8"));
      expect(saved.AAPL.length).toBeGreaterThan(0);

      // 중지(타이머 정리)
      const stopped = eng.stopStrength("AAPL");
      expect(stopped.running).toBe(false);
      eng.stopAllStrength();

      // 새 엔진으로 같은 폴더를 읽으면(앱 재시작) 시계열이 유지된다
      const eng2 = new ToolEngine(dir, { forceMock: true });
      const st = eng2.getStrengthState("AAPL");
      expect(st.samples.length).toBeGreaterThan(0);
      expect(st.running).toBe(false); // 재시작 시 자동 재개하지 않음(온디맨드 원칙)
      eng2.stopAllStrength();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
