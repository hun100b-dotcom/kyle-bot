// =============================================================================
// tests/warrant.test.ts — 워런트 의심 티커 추측 규칙 고정 (v0.36.0)
// =============================================================================

import { describe, it, expect } from "vitest";
import { guessWarrantTickers } from "../lib/warrant";

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
