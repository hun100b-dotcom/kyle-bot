// =============================================================================
// tests/system-pause.test.ts — 시스템 휴무 시간대(05:00~17:00 KST) 검증 (v0.44.0)
// -----------------------------------------------------------------------------
// [무엇을 검증하나?]
//   ① 켜짐/꺼짐 상태가 재시작(새 엔진)해도 유지되는지.
//   ② 꺼져 있으면 시각과 무관하게 항상 통과(paused:false)하는지.
//   ③ 켜져 있을 때 실제 시각에 따라 휴무 시간대(05:00~17:00 KST)/휴장일/평소 시간대를
//      올바르게 구분하는지(luxon Settings.now를 임시로 덮어써 "지금 시각"을 통제한다).
//   ④ 휴무 시간대엔 placeEntry·scanScreener가 실제로 막히는지(주문 게이트 관통 확인).
//
// [왜 Settings.now를 쓰나?]
//   getSystemPauseStatus()는 내부에서 DateTime.now()(실제 벽시계)를 읽는다. 테스트에서
//   "지금이 05:00~17:00 KST"인 상황을 재현하려면 실제 시각을 통제해야 하는데, luxon은
//   전역 Settings.now 훅으로 이를 지원한다(표준적인 방법). 각 테스트 끝에서 반드시
//   원래대로 복원해 다른 테스트로 새지 않게 한다.
//
// [왜 forceMock 엔진은 공장값이 꺼짐(false)인가?]
//   실제 앱(오너가 쓰는 앱)은 이 기능이 기본 켜짐(true)이다 — 그게 오너가 명시적으로 요청한
//   기본값이다. 그런데 forceMock으로 만든 "테스트 전용" 엔진은 생성자에서 이 값을 강제로
//   꺼 둔다(electron/tool-engine.ts 생성자 참고) — 이 기능이 실제 벽시계 시각을 보는데, 테스트가
//   하루 중 언제 돌지 알 수 없어서(예: 낮 12시에 CI가 돌면 이 기능과 무관한 다른 테스트까지
//   전부 막혀버린다) 켜져 있으면 스위트 전체가 시각에 따라 흔들린다(flaky). 그래서 이 기능
//   자체를 검증하는 아래 테스트들은 매번 saveSystemPauseEnabled(true)로 명시적으로 다시 켠
//   뒤 시각까지 얼려서(freezeKst) 검증한다 — "테스트 엔진의 공장값"이 아니라 "오너가 이 기능을
//   켰을 때의 동작"을 확인하는 것이 목적이므로 이 순서가 맞다.
// =============================================================================

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, DateTime } from "luxon";
import { ToolEngine } from "../electron/tool-engine";

/** 주어진 KST 시각으로 DateTime.now()가 고정되게 만든다. */
function freezeKst(year: number, month: number, day: number, hour: number, minute = 0) {
  const target = DateTime.fromObject({ year, month, day, hour, minute }, { zone: "Asia/Seoul" }).toMillis();
  Settings.now = () => target;
}

afterEach(() => {
  Settings.now = () => Date.now(); // 항상 원상 복구(다른 테스트로 새지 않게)
});

describe("[v0.44.0] 시스템 휴무 시간대 — 켜짐/꺼짐 상태 저장", () => {
  it("테스트 엔진의 공장값은 꺼짐(위 설명 참고) — 저장한 값은 .env 파일에 실제로 기록된다", () => {
    // [주의] 여기서는 "새 엔진을 다시 만들어서 getSettings()로 확인"하지 않는다 — forceMock 엔진은
    //   생성자에서 이 값을 항상 강제로 끄기 때문에(위 tool-engine.ts 생성자 설명 참고), 그 방식
    //   으로는 영속화 자체를 검증할 수 없다. 대신 실제 저장 파일(.env)의 내용을 직접 읽어,
    //   persistEnv()가 이 토글을 올바른 문자열로 실제로 써 내려갔는지 확인한다 — 이게 "재시작해도
    //   유지되는지"의 진짜 증거다(다른 수십 개 설정 항목도 같은 .env 파일에 같은 방식으로 저장
    //   되고 이미 각자 테스트로 검증돼 있음 — 여기서는 이 항목 하나만 같은 메커니즘을 타는지 확인).
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      expect(eng.getSettings().systemPauseEnabled).toBe(false); // 테스트 전용 공장값(위 설명 참고)

      const saved = eng.saveSystemPauseEnabled(true);
      expect(saved.systemPauseEnabled).toBe(true);
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("SYSTEM_PAUSE_ENABLED=true");

      const saved2 = eng.saveSystemPauseEnabled(false);
      expect(saved2.systemPauseEnabled).toBe(false);
      expect(readFileSync(join(dir, ".env"), "utf8")).toContain("SYSTEM_PAUSE_ENABLED=false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("꺼져 있으면 05:00~17:00 KST 한복판이어도 절대 막지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(false);
      freezeKst(2026, 7, 16, 12, 0); // 목요일 낮 12시(전형적 휴무 시간대 한복판)
      const st = eng.getSystemPauseStatus();
      expect(st.paused).toBe(false);
      expect(st.reason).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.44.0] 시스템 휴무 시간대 — 시각별 판정(켜짐 상태, 공장값)", () => {
  it("평일 05:00~17:00 KST 안이면 '지정된 휴무 시간대'로 막힌다(경계 포함/미포함 확인)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다

      freezeKst(2026, 7, 16, 5, 0); // 시작 경계(포함)
      expect(eng.getSystemPauseStatus().paused).toBe(true);

      freezeKst(2026, 7, 16, 12, 0); // 한복판
      const mid = eng.getSystemPauseStatus();
      expect(mid.paused).toBe(true);
      expect(mid.reason).toContain("휴무 시간대");
      expect(mid.resumesAtMs).not.toBeNull();
      // 재개 시각은 "오늘 17:00 KST"여야 한다.
      const resumesAt = DateTime.fromMillis(mid.resumesAtMs!).setZone("Asia/Seoul");
      expect(resumesAt.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-16 17:00");

      freezeKst(2026, 7, 16, 16, 59); // 종료 직전
      expect(eng.getSystemPauseStatus().paused).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("17:00 KST(재개 시각)부터는 더 이상 휴무 시간대가 아니다(평일 저녁, 시장은 열려 있음)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      freezeKst(2026, 7, 16, 17, 0); // 목요일 17:00 = 프리마켓 시작
      const st = eng.getSystemPauseStatus();
      expect(st.paused).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("평일 밤(정규장 시간)은 휴무 시간대가 아니다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      freezeKst(2026, 7, 16, 23, 0); // 목요일 23:00 KST = 정규장
      const st = eng.getSystemPauseStatus();
      expect(st.paused).toBe(false);
      expect(st.reason).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("주말(05:00~17:00 시간대 바깥인데도 시장이 닫혀 있으면) '휴장'으로 막힌다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      // 토요일 밤 20시(KST) — 05:00~17:00 밖이지만, 금요일 밤 정규장(오버나이트로 토요일
      // 새벽까지 이어짐)도 이미 끝난 뒤라 다음 개장(월요일 09:00)까지는 완전히 장이 닫혀 있다.
      //   [주의] 토요일 새벽(예 02:00)은 이 밖처럼 보여도 실은 "금요일 정규장"이 아직 진행
      //   중이라(정규장이 자정을 넘겨 토요일 05:00까지 이어짐) 열려 있다 — 그래서 확실히 닫힌
      //   시각(오버나이트 사이클이 완전히 끝난 뒤)으로 20시를 골랐다.
      freezeKst(2026, 7, 18, 20, 0); // 2026-07-18은 토요일
      const st = eng.getSystemPauseStatus();
      expect(st.paused).toBe(true);
      expect(st.reason).toContain("휴장");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("금요일 저녁(17:00 이후, 아직 주말 시작 전)은 정상적으로 거래 가능하다", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      freezeKst(2026, 7, 17, 20, 0); // 금요일 20:00 KST = 정규장(2026-07-17은 금요일)
      const st = eng.getSystemPauseStatus();
      expect(st.paused).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[v0.44.0] 시스템 휴무 시간대 — 실제로 주문·스크리닝을 막는지", () => {
  it("휴무 시간대엔 placeEntry가 거부된다(주문이 실제로 안 나간다)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      freezeKst(2026, 7, 16, 12, 0);
      await expect(eng.placeEntry({ symbol: "AAPL", price: 2.05, quantity: 1 })).rejects.toThrow(/휴무 시간대/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("휴무 시간대엔 scanScreener가 거부된다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      freezeKst(2026, 7, 16, 12, 0);
      await expect(eng.scanScreener({ count: 10 })).rejects.toThrow(/휴무 시간대/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("휴무 시간대가 아니면(정규장 시간) placeEntry가 정상적으로 게이트를 통과한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-pause-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      eng.saveSystemPauseEnabled(true); // 다른 테스트의 persistEnv() 잔재(process.env 전역 leak) 방어 — 명시적으로 기준선을 세운다
      freezeKst(2026, 7, 16, 23, 0);
      // 드라이런(기본값)이라 실제 체결은 없지만, 휴무 시간대 게이트를 통과해 정상 접수까지는 간다.
      const j = await eng.placeEntry({ symbol: "AAPL", price: 2.05, quantity: 1 });
      expect(j).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
