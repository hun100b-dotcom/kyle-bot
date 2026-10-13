// =============================================================================
// tests/splits.test.ts — 삼분할 타점 "기록" 저장 기능 테스트 (v0.4.0)
// -----------------------------------------------------------------------------
// [왜 이 테스트가 필요한가?]
//   계산기는 한 번에 한 종목만 보여준다. A종목 삼분할을 진입하다가 B를 새로 계산하면
//   A의 3개 타점이 사라져, 여러 종목을 동시에 굴릴 수 없었다. 그래서 계산 결과를
//   파일에 저장해 두는 '기록' 기능을 넣었다. 이 저장/삭제/체크가 조용히 깨지면
//   오너의 타점 메모가 날아가므로, 규칙을 테스트로 고정한다.
//
//   ① 순수 함수(시간·파일 없이 로직만): buildSavedLevels / toggleSavedLevel / removeSavedSplit
//   ② 엔진 왕복(실제 파일에 저장→다시 읽기): addSplit → getSplits → toggle → delete
//      ⚠️ 실계좌를 건드리지 않도록 forceMock + 임시 폴더로만 돈다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolEngine,
  buildSavedLevels,
  toggleSavedLevel,
  removeSavedSplit,
  renameSavedSplit,
  type SavedSplit,
} from "../electron/tool-engine";

// 계산 결과 타점 예시(삼분할 1/2/3): entry/tp/sl 세 값씩
const LEVELS = [
  { level: 1, entry: 11.9, tp: 12.14, sl: 10.71 },
  { level: 2, entry: 11.5, tp: 11.73, sl: 10.35 },
  { level: 3, entry: 11.1, tp: 11.32, sl: 9.99 },
];

describe("순수 함수 — 저장용 타점 만들기(buildSavedLevels)", () => {
  it("계산 타점을 저장용으로 바꾸면 진입완료(entered)는 전부 false로 시작한다", () => {
    const out = buildSavedLevels(LEVELS);
    expect(out).toHaveLength(3);
    expect(out.every((lv) => lv.entered === false)).toBe(true);
    // 가격 값은 그대로 보존
    expect(out[0]).toMatchObject({ level: 1, entry: 11.9, tp: 12.14, sl: 10.71 });
  });
});

describe("순수 함수 — 진입완료 체크 토글(toggleSavedLevel)", () => {
  const list: SavedSplit[] = [
    { id: "A", ts: "07-24 10:00:00", symbol: "AAPL", technique: "split3", levels: buildSavedLevels(LEVELS), tpPct: 2, slPct: 10, qty: 3, memo: "" },
    { id: "B", ts: "07-24 10:01:00", symbol: "NVDA", technique: "split3", levels: buildSavedLevels(LEVELS), tpPct: 2, slPct: 10, qty: 1, memo: "" },
  ];

  it("A기록의 2분할만 체크되고, 다른 분할·다른 종목은 그대로다", () => {
    const next = toggleSavedLevel(list, "A", 2);
    const a = next.find((r) => r.id === "A")!;
    expect(a.levels.find((lv) => lv.level === 2)!.entered).toBe(true); // 켜짐
    expect(a.levels.find((lv) => lv.level === 1)!.entered).toBe(false); // 옆 분할은 그대로
    expect(next.find((r) => r.id === "B")!.levels.every((lv) => !lv.entered)).toBe(true); // 다른 종목 무관
  });

  it("같은 곳을 두 번 누르면 원래대로 꺼진다(토글)", () => {
    const once = toggleSavedLevel(list, "A", 1);
    const twice = toggleSavedLevel(once, "A", 1);
    expect(twice.find((r) => r.id === "A")!.levels.find((lv) => lv.level === 1)!.entered).toBe(false);
  });

  it("원본 배열을 바꾸지 않는다(불변성 — React 상태 안전)", () => {
    toggleSavedLevel(list, "A", 1);
    expect(list.find((r) => r.id === "A")!.levels.find((lv) => lv.level === 1)!.entered).toBe(false);
  });
});

describe("순수 함수 — 기록 삭제(removeSavedSplit)", () => {
  it("지정한 id만 빠지고 나머지는 남는다", () => {
    const list: SavedSplit[] = [
      { id: "A", ts: "", symbol: "AAPL", technique: "split3", levels: [], tpPct: null, slPct: null, qty: null, memo: "" },
      { id: "B", ts: "", symbol: "NVDA", technique: "split3", levels: [], tpPct: null, slPct: null, qty: null, memo: "" },
    ];
    const out = removeSavedSplit(list, "A");
    expect(out.map((r) => r.id)).toEqual(["B"]);
  });
});

describe("순수 함수 — 제목(메모) 수정(renameSavedSplit)", () => {
  const list: SavedSplit[] = [
    { id: "A", ts: "", symbol: "AAPL", technique: "split3", levels: [], tpPct: null, slPct: null, qty: null, memo: "원래 제목" },
    { id: "B", ts: "", symbol: "NVDA", technique: "split3", levels: [], tpPct: null, slPct: null, qty: null, memo: "엔비디아" },
  ];
  it("지정한 id의 제목만 바뀌고 다른 기록은 그대로다", () => {
    const out = renameSavedSplit(list, "A", "눌림목 1차");
    expect(out.find((r) => r.id === "A")!.memo).toBe("눌림목 1차");
    expect(out.find((r) => r.id === "B")!.memo).toBe("엔비디아");
  });
  it("앞뒤 공백은 정리한다", () => {
    expect(renameSavedSplit(list, "A", "  공백정리  ").find((r) => r.id === "A")!.memo).toBe("공백정리");
  });
  it("원본 배열을 바꾸지 않는다(불변성)", () => {
    renameSavedSplit(list, "A", "바뀜");
    expect(list.find((r) => r.id === "A")!.memo).toBe("원래 제목");
  });
});

describe("엔진 왕복 — 실제 파일에 저장하고 다시 읽는다(연습 모드)", () => {
  it("addSplit → getSplits → toggle → delete 가 파일까지 반영된다", () => {
    // 임시 폴더로만 동작(실계좌·실파일 절대 안 건드림), forceMock으로 연습 모드 강제
    const dir = mkdtempSync(join(tmpdir(), "kyle-splits-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });

      // 1) 저장 — 종목 AAPL 3개 타점
      let list = eng.addSplit({ symbol: "aapl", technique: "split3", levels: LEVELS, tpPct: 2, slPct: 10, qty: 3, memo: "눌림목 후보" });
      expect(list).toHaveLength(1);
      expect(list[0].symbol).toBe("AAPL"); // 대문자로 정규화
      expect(list[0].memo).toBe("눌림목 후보");
      expect(list[0].levels).toHaveLength(3);
      const id = list[0].id;
      // [v0.90.0] 저장이 디바운스(비동기)로 바뀌어 디스크 반영은 300ms 뒤다 — 확인 전에 강제로 확정시킨다.
      eng.flushAllFileSavesSync();
      // 파일이 실제로 생겼는지
      expect(existsSync(join(dir, "kylebot-splits.json"))).toBe(true);

      // 2) 두 번째 종목 추가 — 최신이 맨 위
      list = eng.addSplit({ symbol: "NVDA", technique: "split3", levels: LEVELS, tpPct: 2, slPct: 10, qty: 1, memo: "" });
      expect(list).toHaveLength(2);
      expect(list[0].symbol).toBe("NVDA"); // 방금 추가한 게 위

      // 3) 진입완료 체크 — AAPL 1분할
      list = eng.toggleSplitEntered(id, 1);
      const aapl = list.find((r) => r.id === id)!;
      expect(aapl.levels.find((lv) => lv.level === 1)!.entered).toBe(true);

      // 4) 제목(메모) 수정 — 파일에 반영되어야 한다
      list = eng.renameSplit(id, "  1차 눌림목  ");
      expect(list.find((r) => r.id === id)!.memo).toBe("1차 눌림목"); // 공백 정리됨

      // 5) 새 엔진으로 같은 폴더를 읽어도(=앱 재시작) 저장 내용이 유지된다(체크 + 수정한 제목)
      eng.flushAllFileSavesSync(); // [v0.90.0] 저장이 디바운스(비동기)로 바뀌어 새 엔진이 읽기 전에 지금 당장 확정한다
      const eng2 = new ToolEngine(dir, { forceMock: true });
      const reloaded = eng2.getSplits();
      expect(reloaded).toHaveLength(2);
      expect(reloaded.find((r) => r.id === id)!.levels.find((lv) => lv.level === 1)!.entered).toBe(true);
      expect(reloaded.find((r) => r.id === id)!.memo).toBe("1차 눌림목"); // 수정한 제목 유지

      // 6) 삭제
      const afterDel = eng2.deleteSplit(id);
      expect(afterDel).toHaveLength(1);
      expect(afterDel.find((r) => r.id === id)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true }); // 임시 폴더 정리
    }
  });
});
