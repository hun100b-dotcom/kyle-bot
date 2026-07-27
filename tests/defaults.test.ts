// =============================================================================
// tests/defaults.test.ts — 기본 손익비 저장·로드·우선순위·검증 (v0.8.3)
// -----------------------------------------------------------------------------
// 보장:
//   1) 아무것도 저장 안 하면 공장값(익절 2 / 손절 10).
//   2) 저장하면 그 값이 우선. 새 엔진(=앱 재시작)으로 다시 읽어도 유지.
//   3) 0 이하·비정상 값은 무시(이전값 유지) — 잘못 눌러도 기본이 망가지지 않음.
//   4) 소수점 허용.
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "capri-def-"));
}

describe("기본 손익비", () => {
  // 각 테스트가 TOSS_* 환경변수를 남기지 않도록 초기화(다른 테스트 오염 방지)
  beforeEach(() => {
    for (const k of ["DEFAULT_TP_PCT", "DEFAULT_SL_PCT"]) delete process.env[k];
  });

  it("저장 전엔 공장값 2 / 10", () => {
    const e = new ToolEngine(freshDir(), { forceMock: true });
    const s = e.getSettings();
    expect(s.defaultTpPct).toBe(2);
    expect(s.defaultSlPct).toBe(10);
  });

  it("저장하면 그 값이 반환된다", () => {
    const e = new ToolEngine(freshDir(), { forceMock: true });
    const s = e.saveDefaultRatio({ tpPct: 3, slPct: 15 });
    expect(s.defaultTpPct).toBe(3);
    expect(s.defaultSlPct).toBe(15);
  });

  it("앱 재시작(새 엔진, 같은 폴더)에도 유지된다", () => {
    const dir = freshDir();
    new ToolEngine(dir, { forceMock: true }).saveDefaultRatio({ tpPct: 4, slPct: 12 });
    // 같은 userData 폴더로 새 엔진 생성 = 앱 재시작
    const s = new ToolEngine(dir, { forceMock: true }).getSettings();
    expect(s.defaultTpPct).toBe(4);
    expect(s.defaultSlPct).toBe(12);
  });

  it("0 이하·비정상 값은 무시하고 이전값을 지킨다", () => {
    const e = new ToolEngine(freshDir(), { forceMock: true });
    e.saveDefaultRatio({ tpPct: 3, slPct: 15 });
    const s = e.saveDefaultRatio({ tpPct: 0, slPct: -5 }); // 둘 다 무시돼야
    expect(s.defaultTpPct).toBe(3);
    expect(s.defaultSlPct).toBe(15);
  });

  it("소수점 손익비도 저장된다", () => {
    const e = new ToolEngine(freshDir(), { forceMock: true });
    const s = e.saveDefaultRatio({ tpPct: 2.5, slPct: 7.5 });
    expect(s.defaultTpPct).toBe(2.5);
    expect(s.defaultSlPct).toBe(7.5);
  });

  it("한쪽만 유효하면 그쪽만 바뀌고 다른 쪽은 유지된다", () => {
    const e = new ToolEngine(freshDir(), { forceMock: true });
    e.saveDefaultRatio({ tpPct: 3, slPct: 15 });
    const s = e.saveDefaultRatio({ tpPct: 5, slPct: NaN });
    expect(s.defaultTpPct).toBe(5);
    expect(s.defaultSlPct).toBe(15);
  });
});
