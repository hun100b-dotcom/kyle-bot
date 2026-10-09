// =============================================================================
// tests/warrant.test.ts — 워런트 의심 티커 추측 규칙(v0.36.0) + 탈락 게이트(v0.70.0) 고정
// -----------------------------------------------------------------------------
// [배경] 오너 지시(2026-10-09): "현재가보다 낮은 가격에 워런트 잡혀있을경우 워런트로
//   종목선정 탈락". v0.37.0까지는 코멘트만(차단 안 함)이었는데, 이제 실제로 후보에서
//   뺀다(electron/tool-engine.ts의 scanScreener → applyWarrantGate). 아래 두 번째
//   describe는 그 네트워크 연계(checkWarrantWarning, private)까지 mockSetPrice로 확인한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guessWarrantTickers, applyWarrantGate } from "../lib/warrant";
import { ToolEngine } from "../electron/tool-engine";

describe("guessWarrantTickers", () => {
  it("본주 심볼에 흔한 워런트 접미사 4종을 붙여 후보를 만든다", () => {
    expect(guessWarrantTickers("ABCD")).toEqual(["ABCDW", "ABCD.WS", "ABCD-WT", "ABCDWS"]);
  });

  it("소문자로 줘도 대문자로 정규화한다(토스 심볼 규칙)", () => {
    expect(guessWarrantTickers("abcd")).toEqual(["ABCDW", "ABCD.WS", "ABCD-WT", "ABCDWS"]);
  });

  it("빈 문자열이면 빈 배열(무의미한 API 호출 방지)", () => {
    expect(guessWarrantTickers("")).toEqual([]);
    expect(guessWarrantTickers("   ")).toEqual([]);
  });
});

describe("applyWarrantGate — 워런트 탈락 게이트(v0.70.0)", () => {
  it("워런트 경고가 있으면 상태가 무엇이었든 'none'(탈락)으로 덮어쓴다", () => {
    expect(applyWarrantGate("confirmed", "⚠️ 워런트 탈락: ...")).toBe("none");
    expect(applyWarrantGate("watch", "⚠️ 워런트 탈락: ...")).toBe("none");
  });

  it("워런트 경고가 없으면(null/undefined) 원래 상태를 그대로 돌려준다", () => {
    expect(applyWarrantGate("confirmed", null)).toBe("confirmed");
    expect(applyWarrantGate("watch", undefined)).toBe("watch");
    expect(applyWarrantGate("none", null)).toBe("none");
    expect(applyWarrantGate("insufficient", null)).toBe("insufficient");
  });

  it("빈 문자열(falsy)도 '경고 없음'으로 취급한다", () => {
    expect(applyWarrantGate("confirmed", "")).toBe("confirmed");
  });
});

describe("ToolEngine.checkWarrantWarning(private) — 추측 티커 시세 조회와 탈락 문구 연계", () => {
  async function withEngine(fn: (eng: ToolEngine, check: (symbol: string, price: number) => Promise<string | null>) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "kyle-warrant-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const check = (eng as unknown as { checkWarrantWarning: (symbol: string, price: number) => Promise<string | null> }).checkWarrantWarning.bind(eng);
      await fn(eng, check);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("추측 티커(심볼+W)가 본주 현재가보다 낮게 잡히면 탈락 문구를 돌려준다(티커·가격 포함)", async () => {
    await withEngine(async (eng, check) => {
      await eng.mockSetPrice("TSLAW", 1.2); // 추측 1순위(symbol+W)부터 바로 걸림
      const msg = await check("TSLA", 2.5);
      expect(msg).toContain("탈락");
      expect(msg).toContain("TSLAW");
      expect(msg).toContain("1.2");
      expect(msg).toContain("2.5");
    });
  });

  it("추측 티커 시세가 본주 현재가보다 낮지 않으면 null(탈락 아님)", async () => {
    await withEngine(async (eng, check) => {
      await eng.mockSetPrice("TSLAW", 5); // 본주(2.5)보다 높음 → 워런트로 보이긴 해도 탈락 사유 아님
      const msg = await check("TSLA", 2.5);
      expect(msg).toBeNull();
    });
  });

  it("가격이 숫자가 아니면(계산 불가) 조회 자체를 안 하고 null", async () => {
    await withEngine(async (_eng, check) => {
      const msg = await check("TSLA", NaN);
      expect(msg).toBeNull();
    });
  });
});
