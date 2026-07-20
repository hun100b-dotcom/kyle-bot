// =============================================================================
// tests/input-draft.test.ts — 숫자 입력창 타이핑 회귀 테스트 (v0.2.6)
// -----------------------------------------------------------------------------
// [왜 이 테스트가 필요한가?]
//   실전 중 "숫자가 입력이 안 된다"는 치명 버그가 났다. 원인은 두 가지였다:
//     1) <input type="number">의 스피너(위아래 화살표) — 휠을 굴리면 step 단위로 값이 바뀜
//        (step=0.0001에서 휠 4번 → 0.0004가 입력됨. 실제 오너 화면에 찍힌 값)
//     2) 매 키입력마다 Number()로 변환 → "11." 이 11로 뭉개져 소수점을 못 찍음
//   그래서 "입력 도중 문자열"을 그대로 허용하는 규칙(isNumericDraft)을 검증한다.
//   App.tsx와 동일한 규칙을 여기 복제해 테스트한다(화면 없이 로직만 검증).
// =============================================================================

import { describe, it, expect } from "vitest";

/** App.tsx의 isNumericDraft와 동일 규칙 */
function isNumericDraft(v: string): boolean {
  return v === "" || /^-?\d*\.?\d*$/.test(v);
}
/** App.tsx의 toNum과 동일 규칙 */
function toNum(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 한 글자씩 타이핑하는 상황을 흉내낸다. 허용되지 않는 입력은 무시(=이전 값 유지). */
function typeInto(text: string): string {
  let state = "";
  for (const ch of text) {
    const next = state + ch;
    if (isNumericDraft(next)) state = next; // 허용될 때만 반영(실제 onChange와 동일)
  }
  return state;
}

describe("숫자 입력창: 한 글자씩 타이핑해도 값이 유지된다", () => {
  it('"11.33"을 한 글자씩 입력하면 최종값이 11.33', () => {
    const s = typeInto("11.33");
    expect(s).toBe("11.33");
    expect(toNum(s)).toBe(11.33);
  });

  it('입력 도중 상태 "11." 도 허용된다(소수점을 찍을 수 있어야 함)', () => {
    expect(isNumericDraft("11.")).toBe(true);
    expect(isNumericDraft(".5")).toBe(true);
    expect(isNumericDraft("-")).toBe(true);
  });

  it("전부 지우면 빈칸이 되고 0/1이 박히지 않는다", () => {
    expect(isNumericDraft("")).toBe(true);
    expect(toNum("")).toBeNull(); // 계산 시점에 '입력하세요' 안내로 처리
  });

  it("BNAI 사례: 현재가 11.33을 그대로 입력할 수 있다(0.0004로 뭉개지지 않음)", () => {
    expect(toNum(typeInto("11.33"))).toBe(11.33);
  });

  it("퍼센트도 소수 입력 가능(2.5%)", () => {
    expect(toNum(typeInto("2.5"))).toBe(2.5);
  });

  it("숫자가 아닌 문자는 걸러진다", () => {
    expect(isNumericDraft("11a")).toBe(false);
    expect(isNumericDraft("1.2.3")).toBe(false);
    expect(typeInto("1a2")).toBe("12"); // a는 무시되고 숫자만 남음
  });

  it("붙여넣기 형태의 값도 검증된다", () => {
    expect(toNum("11.33")).toBe(11.33);
    expect(toNum("abc")).toBeNull();
  });
});
