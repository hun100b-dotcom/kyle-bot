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
import { classifyTicks, computeStrength, strengthFromTicks, updateStrengthWindow, isWindowCapped, type Tick, type WindowBufferEntry } from "../lib/strength";
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

describe("updateStrengthWindow — [v0.27.0] 틱개수창→시간창(최근 N분) 전환", () => {
  const WINDOW_MS = 5 * 60_000; // 5분
  const cls = (side: "buy" | "sell", volume: number, timestamp: string) => ({ price: 1, volume, timestamp, side }) as const;

  it("(a) 창 안(5분 이내)의 신규 틱만 강도 계산에 반영된다", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0); // 12:00:00
    const t1 = new Date(now - 60_000).toISOString(); // 11:59:00 (1분 전, 창 안)
    const r = updateStrengthWindow([], [cls("buy", 100, t1)], now, WINDOW_MS);
    expect(r.nTicks).toBe(1);
    expect(r.buyVol).toBe(100);
    expect(r.sellVol).toBe(0);
    expect(r.strength).toBeNull(); // 매도 0 → "매수 일방"
  });

  it("(b) 5분 넘은 과거 틱은 다음 폴링에서 버퍼에서 잘려나간다", () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    // 1차 폴링: t0 시각에 매도 100 하나를 버퍼에 넣는다.
    const first = updateStrengthWindow([], [cls("sell", 100, new Date(t0).toISOString())], t0, WINDOW_MS);
    expect(first.nTicks).toBe(1);
    expect(first.sellVol).toBe(100);

    // 2차 폴링: 5분 10초 후, 신규 틱 없이(빈 배열) 다시 계산하면 옛 틱이 창 밖으로 밀려난다.
    const t1 = t0 + 5 * 60_000 + 10_000;
    const second = updateStrengthWindow(first.buffer, [], t1, WINDOW_MS);
    expect(second.nTicks).toBe(0);
    expect(second.sellVol).toBe(0);
    expect(second.buffer).toEqual([]);
  });

  it("버퍼는 여러 폴링에 걸쳐 창 안에서는 계속 누적된다(순수 롤링, 진짜 무한누적 아님)", () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const first = updateStrengthWindow([], [cls("buy", 60, new Date(t0).toISOString())], t0, WINDOW_MS);
    // 1분 뒤 폴링: 매도 40 추가 — 아직 5분 안 지났으니 첫 틱도 유지된다.
    const t1 = t0 + 60_000;
    const second = updateStrengthWindow(first.buffer, [cls("sell", 40, new Date(t1).toISOString())], t1, WINDOW_MS);
    expect(second.nTicks).toBe(2);
    expect(second.buyVol).toBe(60);
    expect(second.sellVol).toBe(40);
    expect(second.strength).toBe(150); // (60/40)*100
  });

  it("이번 폴링에서 새로 넣은 틱은 오래된 순으로 정렬되어 버퍼에 쌓인다(시각 뒤섞여 들어와도)", () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const prev: WindowBufferEntry[] = [{ tsMs: t0 - 30_000, volume: 10, side: "buy" }];
    // 신규 틱이 시간 역순으로 들어와도(정렬 안 된 상태) 결과 버퍼는 오름차순이어야 한다.
    const unordered = [cls("sell", 5, new Date(t0).toISOString()), cls("buy", 3, new Date(t0 - 10_000).toISOString())];
    const r = updateStrengthWindow(prev, unordered, t0, WINDOW_MS);
    expect(r.buffer.map((b) => b.tsMs)).toEqual([t0 - 30_000, t0 - 10_000, t0]);
  });
});

describe("isWindowCapped — (c) 서버 50건 상한 도달 시 '일부 놓쳤을 수 있음' 플래그", () => {
  it("50건 받았고 전부 신규(직전 폴링과 하나도 안 겹침)면 상한도달로 본다", () => {
    expect(isWindowCapped(50, 50)).toBe(true);
  });
  it("50건 받았어도 일부가 직전 폴링과 겹치면(신규가 50건보다 적으면) 상한도달 아님", () => {
    expect(isWindowCapped(50, 12)).toBe(false);
  });
  it("애초에 50건 미만만 받았으면(유동성이 낮아 상한에 안 닿음) 상한도달 아님", () => {
    expect(isWindowCapped(9, 9)).toBe(false);
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

      // [v0.90.0] 저장이 디바운스(비동기)로 바뀌어 디스크 반영은 300ms 뒤다 — 확인 전에 강제로 확정시킨다.
      eng.flushAllFileSavesSync();
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
