// =============================================================================
// tests/split-inputs.test.ts — 삼분할 기록에 '계산기 입력값'을 함께 저장 (v0.9.0)
// -----------------------------------------------------------------------------
// [무엇을 지키는 테스트인가?]
//   사장님 요청: "기록해 둔 종목을 2차·3차 매수할 때 전봉 종가·EMA200 을 다시 치기 번거롭다.
//   저장할 때 입력값도 기억해 뒀다가 계산기로 불러올 수 있게 해 달라."
//
//   그래서 기록에 inputs(원본 입력값)를 함께 저장한다. 여기서 고정하는 규칙:
//     ① 준 입력값이 **한 글자도 바뀌지 않고** 그대로 저장·복원된다(문자열 그대로).
//     ② 앱을 껐다 켜도(파일에서 다시 읽어도) 남아 있다.
//     ③ **옛 기록과 호환**: 입력값을 안 주면 예전과 똑같은 모양으로 저장되고,
//        불러오기 버튼이 비활성으로 뜨도록 inputs 는 undefined 로 남는다.
//   ③번이 특히 중요하다 — 이 기능 때문에 기존 기록이 깨지면 안 되기 때문이다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine, type SplitInputs } from "../electron/tool-engine";

const LEVELS = [
  { level: 1, entry: 301.66, tp: 307.69, sl: 271.49 },
  { level: 2, entry: 298.33, tp: 304.29, sl: 268.49 },
  { level: 3, entry: 295, tp: 300.9, sl: 265.5 },
];

/** 계산기에서 사장님이 실제로 치는 값들(문자열 그대로 보관) */
const INPUTS: SplitInputs = {
  technique: "split3",
  symbol: "AAPL",
  tpPct: "2",
  slPct: "10",
  qty: "3",
  baseClose: "305.00",
  ema200: "295",
  wallPrice: "",
  barOpen: "",
  manualEntry: "",
  candleYang: false,
  gap: 10,
  curPrice: 303.6,
};

/** 임시 폴더에서 엔진을 돌린다(실계좌·실파일 안 건드림) */
function withEngine(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "capri-split-inputs-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("삼분할 기록 — 계산기 입력값 함께 저장", () => {
  it("입력값을 주면 그대로 저장된다(글자 하나 안 바뀜)", () => {
    withEngine((dir) => {
      const eng = new ToolEngine(dir, { forceMock: true });
      const list = eng.addSplit({
        symbol: "aapl",
        technique: "split3",
        levels: LEVELS,
        tpPct: 2,
        slPct: 10,
        qty: 3,
        memo: "2차 대기",
        inputs: INPUTS,
      });

      expect(list[0].inputs).toEqual(INPUTS);
      // 특히 재입력이 번거롭던 두 값이 정확히 남아야 한다.
      expect(list[0].inputs?.baseClose).toBe("305.00"); // 소수점 표기까지 그대로
      expect(list[0].inputs?.ema200).toBe("295");
    });
  });

  it("앱을 껐다 켜도(파일에서 다시 읽어도) 입력값이 남아 있다", () => {
    withEngine((dir) => {
      const eng1 = new ToolEngine(dir, { forceMock: true });
      eng1.addSplit({
        symbol: "AAPL",
        technique: "split3",
        levels: LEVELS,
        tpPct: 2,
        slPct: 10,
        qty: 3,
        inputs: INPUTS,
      });

      // 같은 폴더로 엔진을 새로 만든다 = 앱 재시작과 같은 상황
      eng1.flushAllFileSavesSync(); // [v0.90.0] 저장이 디바운스(비동기)로 바뀌어 새 엔진이 읽기 전에 지금 당장 확정한다
      const eng2 = new ToolEngine(dir, { forceMock: true });
      const again = eng2.getSplits();
      expect(again).toHaveLength(1);
      expect(again[0].inputs?.baseClose).toBe("305.00");
      expect(again[0].inputs?.ema200).toBe("295");
      expect(again[0].inputs?.technique).toBe("split3");
    });
  });

  it("[하위호환] 입력값을 안 주면 예전과 같은 모양으로 저장되고 inputs 는 없다", () => {
    withEngine((dir) => {
      const eng = new ToolEngine(dir, { forceMock: true });
      const list = eng.addSplit({
        symbol: "TSLA",
        technique: "orderbook",
        levels: [LEVELS[0]],
        tpPct: 2,
        slPct: 10,
        qty: 1,
      });

      // 옛 기록처럼 inputs 키 자체가 없어야 한다(있는데 비어 있으면 버튼이 잘못 활성화된다).
      expect(list[0].inputs).toBeUndefined();
      expect("inputs" in list[0]).toBe(false);
      // 나머지 기존 필드는 그대로 동작
      expect(list[0].symbol).toBe("TSLA");
      expect(list[0].levels).toHaveLength(1);
    });
  });

  it("기법별 재료가 달라도 그대로 보관된다(호가창·캔들)", () => {
    withEngine((dir) => {
      const eng = new ToolEngine(dir, { forceMock: true });
      const candle: SplitInputs = {
        ...INPUTS,
        technique: "candle",
        symbol: "NVDA",
        baseClose: "",
        ema200: "",
        barOpen: "231.20",
        candleYang: true,
        gap: null,
      };
      const list = eng.addSplit({
        symbol: "NVDA",
        technique: "candle",
        levels: [LEVELS[0]],
        tpPct: 2,
        slPct: 10,
        qty: 1,
        inputs: candle,
      });

      expect(list[0].inputs?.barOpen).toBe("231.20");
      expect(list[0].inputs?.candleYang).toBe(true);
      expect(list[0].inputs?.gap).toBeNull();
    });
  });

  it("여러 종목을 저장해도 각자의 입력값이 섞이지 않는다", () => {
    withEngine((dir) => {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.addSplit({ symbol: "AAPL", technique: "split3", levels: LEVELS, tpPct: 2, slPct: 10, qty: 3, inputs: INPUTS });
      eng.addSplit({
        symbol: "IONQ",
        technique: "split3",
        levels: LEVELS,
        tpPct: 3,
        slPct: 12,
        qty: 5,
        inputs: { ...INPUTS, symbol: "IONQ", baseClose: "45.10", ema200: "41.00", qty: "5" },
      });

      const list = eng.getSplits();
      const ionq = list.find((s) => s.symbol === "IONQ");
      const aapl = list.find((s) => s.symbol === "AAPL");
      expect(ionq?.inputs?.baseClose).toBe("45.10");
      expect(ionq?.inputs?.qty).toBe("5");
      expect(aapl?.inputs?.baseClose).toBe("305.00"); // 서로 영향 없음
    });
  });
});
