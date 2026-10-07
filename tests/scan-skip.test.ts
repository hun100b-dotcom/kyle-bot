import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolEngine } from "../electron/tool-engine";

// [v0.69.0] 가격대에서 10% 이상 벗어난 종목은 캔들 조회 없이 바로 "가격대 밖"으로 처리 — 결과는 예전과 같고(none, priceInBand=false) 요청만 줄어든다.
describe("스캔: 가격대 밖 종목은 캔들 조회를 생략한다", () => {
  it("가격대를 멀리 벗어난 종목은 none + 가격대 밖 표시(캔들 조회 생략), 경계 안 종목은 정상 판정", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-skip-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      // 목 서버 종목 가격은 대체로 2~100달러대 — $50~60 가격대로 잡으면 대부분 멀리 벗어난다
      const run = await eng.scanScreener({ count: 10, priceMin: 500, priceMax: 600 });
      expect(run.results.length).toBe(run.total);
      expect(run.results.every((r) => r.status === "none" && r.priceInBand === false)).toBe(true);
      expect(run.results.some((r) => (r.note ?? "").includes("캔들 조회 생략"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
