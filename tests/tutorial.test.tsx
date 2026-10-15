// =============================================================================
// tests/tutorial.test.tsx — [v0.91.0] 튜토리얼(시작 가이드): 진행 판정 · 연결 테스트 분류 · 엔진 테스트 함수 · 화면 렌더
// ⚠️ 실서버·실계좌 안 건드림(디스코드·Supabase 호출은 가짜 fetch).
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TUTORIAL_STEPS, computeProgress, parseTutorialStored, shouldAutoOpen, tutorialStorageKey, TUTORIAL_STORED_DEFAULT, type TutorialSnapshot,
} from "../lib/tutorial";
import { classifyTossError } from "../lib/connection-test";
import { ToolEngine } from "../electron/tool-engine";
import Tutorial from "../src/Tutorial";

const base: TutorialSnapshot = {
  isDesktop: true, loggedIn: true, approved: true, hasKeys: false, connectionOk: false, mode: "mock", liveOrders: false,
  discordSaved: false, visited: [], scanRan: false, autoEnabled: false,
};

describe("lib/tutorial — 진행 판정", () => {
  it("처음 쓰는 사람: 계정만 완료이고 다음 단계는 '시작하기'", () => {
    const p = computeProgress(base);
    expect(p.done.account).toBe(true);
    expect(p.doneCount).toBe(1);
    expect(p.total).toBe(TUTORIAL_STEPS.length);
    expect(p.nextId).toBe("welcome");
    expect(p.allDone).toBe(false);
  });

  it("키가 저장되고 연결 테스트를 통과해야 '키 입력' 단계가 완료된다(저장만으론 부족)", () => {
    expect(computeProgress({ ...base, hasKeys: true }).done.keysInput).toBe(false);
    expect(computeProgress({ ...base, hasKeys: true, connectionOk: true }).done.keysInput).toBe(true);
    expect(computeProgress({ ...base, hasKeys: true }).done.keysPrep).toBe(true); // 키가 이미 있으면 '준비' 단계도 끝난 것
  });

  it("디스코드·스캔·자동매매 켜짐은 실제 상태에서 자동 완료되고, 정보 단계는 '확인함(visited)'이 조건이다", () => {
    const p = computeProgress({ ...base, discordSaved: true, scanRan: true, autoEnabled: true, visited: ["welcome", "mode", "autoSettings"] });
    expect(p.done.discord && p.done.screening && p.done.launch && p.done.welcome && p.done.mode && p.done.autoSettings).toBe(true);
  });

  it("전부 끝나면 allDone·nextId null", () => {
    const p = computeProgress({ ...base, hasKeys: true, connectionOk: true, discordSaved: true, scanRan: true, autoEnabled: true, visited: TUTORIAL_STEPS.map((s) => s.id) });
    expect(p.allDone).toBe(true);
    expect(p.nextId).toBeNull();
    expect(p.doneCount).toBe(p.total);
  });

  it("폰은 PC 전용 단계(키 준비·키 입력·디스코드)를 집계에서 뺀다", () => {
    const p = computeProgress({ ...base, isDesktop: false });
    expect(p.steps.map((s) => s.id)).not.toContain("keysInput");
    expect(p.steps.map((s) => s.id)).not.toContain("discord");
    expect(p.total).toBeLessThan(TUTORIAL_STEPS.length);
  });
});

describe("lib/tutorial — 저장 상태·자동 열림", () => {
  it("깨진/옛 저장값은 기본값으로, 모르는 단계 id는 걸러낸다", () => {
    expect(parseTutorialStored(null)).toEqual(TUTORIAL_STORED_DEFAULT);
    expect(parseTutorialStored("{깨짐")).toEqual(TUTORIAL_STORED_DEFAULT);
    expect(parseTutorialStored(JSON.stringify({ visited: ["welcome", "없는단계"], connectionOk: true, lastStep: "mode" }))).toMatchObject({ visited: ["welcome"], connectionOk: true, lastStep: "mode" });
  });
  it("계정별로 저장 키가 다르다(이메일 대소문자 무시)", () => {
    expect(tutorialStorageKey("A@b.com")).toBe(tutorialStorageKey("a@B.com"));
    expect(tutorialStorageKey("a@b.com")).not.toBe(tutorialStorageKey("c@d.com"));
  });
  it("자동 열림: 로그인·승인됐고 키가 없고 한 번도 안 본 '처음 쓰는 사람'에게 딱 한 번만", () => {
    const s = { loggedIn: true, approved: true, hasKeys: false };
    expect(shouldAutoOpen(s, TUTORIAL_STORED_DEFAULT)).toBe(true);
    expect(shouldAutoOpen(s, { ...TUTORIAL_STORED_DEFAULT, autoOpened: true })).toBe(false); // 이미 한 번 열었음(닫아도 다시 안 열림)
    expect(shouldAutoOpen({ ...s, hasKeys: true }, TUTORIAL_STORED_DEFAULT)).toBe(false); // 이미 설정한 사람
    expect(shouldAutoOpen({ ...s, loggedIn: false }, TUTORIAL_STORED_DEFAULT)).toBe(false);
    expect(shouldAutoOpen({ ...s, approved: false }, TUTORIAL_STORED_DEFAULT)).toBe(false);
  });
});

describe("lib/connection-test — 오류를 쉬운 말로", () => {
  it("키 오류·허용 IP·계좌·네트워크를 구분한다", () => {
    expect(classifyTossError("토스 API 키 인증에 실패했습니다(invalid_client).").stage).toBe("auth");
    expect(classifyTossError("토스가 이 인터넷 주소(IP)에서의 접속을 허용하지 않습니다.").stage).toBe("ip");
    expect(classifyTossError("HTTP 400 missing_account").stage).toBe("account");
    expect(classifyTossError("요청 타임아웃(10000ms 초과): GET /prices").stage).toBe("network");
    expect(classifyTossError("뭔가 이상함").stage).toBe("price");
  });
  it("조치 문구에 키·토큰 원문이 섞이지 않는다", () => {
    const c = classifyTossError("invalid_client client_secret=SUPERSECRET123");
    expect(JSON.stringify(c)).not.toContain("SUPERSECRET123");
  });
});

describe("엔진 — 연결 테스트 / 디스코드 테스트", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("연습 모드에선 토스에 연결하지 않고 안내만 한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-tut-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const r = await eng.testTossConnection();
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("mode");
      expect(r.message).toContain("연습 모드");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("디스코드: 주소가 없으면 안내, 있으면 테스트 메시지를 보내고 결과를 쉬운 말로 돌려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyle-tut-"));
    try {
      const eng = new ToolEngine(dir, { forceMock: true });
      const x = eng as unknown as { authAccessToken: string; authUserId: string; authExpiresAtMs: number };
      x.authAccessToken = "tok"; x.authUserId = "u1"; x.authExpiresAtMs = Date.now() + 3_600_000;
      const posted: string[] = [];
      let hook: string | null = null;
      let discordStatus = 204;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("capri_user_notify_settings")) return new Response(JSON.stringify(hook ? [{ discord_webhook_url: hook }] : []), { status: 200 });
        if (url.startsWith("https://discord.com/api/webhooks/")) { posted.push(String(init?.body ?? "")); return new Response(null, { status: discordStatus }); }
        return new Response("[]", { status: 200 });
      }) as typeof fetch;

      expect((await eng.sendMyDiscordTest()).ok).toBe(false); // 주소 없음
      hook = "https://discord.com/api/webhooks/123/abc";
      const ok = await eng.sendMyDiscordTest();
      expect(ok.ok).toBe(true);
      expect(posted[0]).toContain("Capri 알림 테스트");
      discordStatus = 404;
      expect((await eng.sendMyDiscordTest()).message).toContain("찾지 못");
      hook = "https://evil.example.com/x";
      expect((await eng.sendMyDiscordTest()).ok).toBe(false); // 디스코드 주소가 아니면 보내지 않는다
      expect(posted.length).toBe(2); // 위 404 호출까지만(주소 모양이 틀린 건 아예 전송 안 함)
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("화면 — 렌더 스모크", () => {
  const props = {
    isDesktop: true, email: "me@test.com", loggedIn: true, accountStatus: "approved",
    settings: { hasClientId: false, hasClientSecret: false, mode: "mock", liveOrdersEnabled: false },
    autoStatus: { enabled: false, lastScan: null, maxPositions: 3, maxLossPct: 5, maxInvestPct: 30, watchMinutes: 30 },
    goToTab: () => undefined, onSettingsChanged: () => undefined,
  };

  it("닫혀 있을 땐 왼쪽 아래 알약만 보이고 진행 수(완료/전체)가 표시된다", () => {
    const html = renderToString(<Tutorial {...props} />);
    expect(html).toContain("시작 가이드 1/");
    expect(html).not.toContain("tt-overlay");
  });

  it("로그인 전엔 아무것도 그리지 않는다", () => {
    expect(renderToString(<Tutorial {...props} loggedIn={false} />)).toBe("");
  });

  it("모든 단계의 마법사가 예외 없이 그려지고 핵심 문구가 있다", () => {
    const expectText: Record<string, string> = {
      welcome: "안전 3원칙", account: "운영자 승인", keysPrep: "허용 IP", keysInput: "연결 테스트", mode: "실주문을 대신 켜 주지 않아요",
      discord: "웹후크", autoSettings: "정해진 정답은 없고", screening: "스크리닝", launch: "자동매매 현황",
    };
    for (const step of TUTORIAL_STEPS) {
      const html = renderToString(<Tutorial {...props} defaultOpenStep={step.id} />);
      expect(html).toContain("tt-overlay");
      if (step.id === "welcome") expect(html).toContain("연습 모드");
      expect(html.replace(/<[^>]+>/g, "")).toContain(step.id === "welcome" ? "비상 정지" : expectText[step.id].replace(/ 안전 3원칙/, ""));
    }
  });

  it("폰에서는 PC 전용 단계(키 준비·키 입력·디스코드)가 목록에서 빠지고 입력칸이 없다", () => {
    const html = renderToString(<Tutorial {...props} isDesktop={false} defaultOpenStep="keysInput" />);
    expect(html).not.toContain("키 입력 · 연결 테스트");
    expect(html).not.toContain("디스코드 알림");
    expect(html).not.toContain('type="password"');
    expect(html).toContain("시작하기");
  });

  it("키 입력 단계: 비밀번호 칸(화면에 안 보임)과 저장·연결 테스트 버튼이 있고, 키 없으면 연결 테스트는 비활성", () => {
    const html = renderToString(<Tutorial {...props} defaultOpenStep="keysInput" />);
    expect(html).toContain('type="password"');
    expect(html).toContain("연결 테스트");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>🔌 연결 테스트/);
  });

  it("[버그 수정] 저장된 모드가 '연습'이면 라디오도 연습이 기본 선택된다(예전엔 저장값과 무관하게 항상 '실서버'로 시작했다)", () => {
    const mockHtml = renderToString(<Tutorial {...props} defaultOpenStep="keysInput" settings={{ ...props.settings, mode: "mock" }} />);
    const mockRadios = mockHtml.match(/<input type="radio"[^>]*\/?>/g) ?? [];
    expect(mockRadios.length).toBe(2); // [0]=실서버 모드, [1]=연습 모드 (마크업 순서 고정)
    expect(mockRadios[0]).not.toMatch(/checked/);
    expect(mockRadios[1]).toMatch(/checked/);

    const liveHtml = renderToString(<Tutorial {...props} defaultOpenStep="keysInput" settings={{ ...props.settings, mode: "live" }} />);
    const liveRadios = liveHtml.match(/<input type="radio"[^>]*\/?>/g) ?? [];
    expect(liveRadios[0]).toMatch(/checked/);
    expect(liveRadios[1]).not.toMatch(/checked/);
  });

  it("키 입력 단계: 설정 탭에서 이미 연결 테스트를 했어도 이 화면에서 다시 눌러야 체크된다는 안내가 있다", () => {
    const html = renderToString(<Tutorial {...props} defaultOpenStep="keysInput" />);
    expect(html.replace(/<[^>]+>/g, "")).toContain("여기서 한 번 더 눌러야");
  });

  it("'확인함(visited)'으로만 완료되는 정보 단계(welcome·keysPrep·mode·autoSettings)는 완료 조건을 화면 문장으로 적어 둔다", () => {
    for (const id of ["welcome", "keysPrep", "mode", "autoSettings"] as const) {
      const html = renderToString(<Tutorial {...props} defaultOpenStep={id} />);
      expect(html.replace(/<[^>]+>/g, "")).toContain("완료로 표시돼요");
    }
  });

  it("닫혀 있을 때(기본 상태)는 '그 화면으로 이동' 안내 칩이 보이지 않는다", () => {
    const html = renderToString(<Tutorial {...props} />);
    expect(html).not.toContain("tt-guide-chip");
  });
});
