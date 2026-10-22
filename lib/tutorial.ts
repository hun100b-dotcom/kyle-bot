// =============================================================================
// lib/tutorial.ts — [v0.91.0] 튜토리얼(시작 가이드) 단계 정의 + 진행 판정 — 순수 함수
// -----------------------------------------------------------------------------
// [왜 이렇게 만들었나] 처음 쓰는 사람은 "무엇부터 어떤 순서로"를 모른다. 그래서 순서가 있는 단계(마법사)로 안내하되,
//   각 단계의 완료 여부는 사용자가 체크하는 게 아니라 **실제 상태에서 자동으로 판정**한다(키가 저장됐나, 디스코드가 등록됐나 …).
//   화면(src/Tutorial.tsx)은 이 파일의 결과를 그리기만 하므로, 판정 규칙은 여기서 테스트로 고정한다.
// [원칙] 숫자(손절폭·투입 비율 등)는 이 튜토리얼이 권하지 않는다 — 각 항목이 무엇인지 설명하고 해당 화면으로 안내만 한다(정하는 건 오너/사용자).
// =============================================================================

export type TutorialStepId = "welcome" | "account" | "keysPrep" | "keysInput" | "mode" | "discord" | "autoSettings" | "screening" | "launch";

export interface TutorialStepDef {
  id: TutorialStepId;
  /** 짧은 이름(체크리스트·좌측 레일) */
  title: string;
  icon: string;
  /** "desktop" = PC 앱에서만 할 수 있는 단계(폰에서는 건너뜀·집계 제외) */
  platform: "desktop" | "both";
  /** 이 단계가 안내하는 탭(있으면 [그 화면으로 이동] 버튼을 보여 준다) */
  tab?: string;
  /** 이동 뒤 강조할 화면 요소(data-tt 값) */
  target?: string;
}

/** 단계 순서(고정). 마법사·체크리스트가 이 순서 그대로 쓴다. */
export const TUTORIAL_STEPS: TutorialStepDef[] = [
  { id: "welcome", title: "시작하기 · 안전 3원칙", icon: "👋", platform: "both" },
  { id: "account", title: "계정·승인 확인", icon: "🔐", platform: "both" },
  { id: "keysPrep", title: "토스 키 준비", icon: "🗝️", platform: "desktop" },
  { id: "keysInput", title: "키 입력 · 연결 테스트", icon: "🔌", platform: "desktop", tab: "settings", target: "tt-keys" },
  { id: "mode", title: "연습 ↔ 실서버 · 실주문", icon: "🎚️", platform: "both", tab: "settings", target: "tt-keys" },
  { id: "discord", title: "디스코드 알림", icon: "🔔", platform: "desktop", tab: "settings", target: "tt-discord" },
  { id: "autoSettings", title: "자동매매 설정 살펴보기", icon: "🤖", platform: "both", tab: "autoControl", target: "tt-auto-limits" },
  { id: "screening", title: "스크리닝 기준 · 스캔", icon: "🔍", platform: "both", tab: "screenCriteria", target: "tt-screen-criteria" },
  { id: "launch", title: "시작하고 결과 보기", icon: "🚀", platform: "both", tab: "autoControl", target: "tt-auto-start" },
];

/** 화면이 넘겨주는 "지금 앱 상태" 스냅샷(판정의 유일한 입력). */
export interface TutorialSnapshot {
  isDesktop: boolean;
  loggedIn: boolean;
  /** 가입 승인 상태가 "approved"인가(확인 못 했으면 unknown → 막지 않고 승인으로 본다) */
  approved: boolean;
  hasKeys: boolean;
  /** 마법사에서 연결 테스트를 통과한 적이 있는가(이 기기 기록) */
  connectionOk: boolean;
  mode: "mock" | "live";
  liveOrders: boolean;
  discordSaved: boolean;
  /** 자동매매 현황·스크리닝 기준 화면을 마법사 안내로 열어 본 적이 있는가 */
  visited: TutorialStepId[];
  /** 스캔이 한 번이라도 실행됐는가(자동 스크리너 결과 존재) */
  scanRan: boolean;
  autoEnabled: boolean;
}

export interface TutorialProgress {
  /** 이 기기에서 집계에 포함되는 단계(폰이면 PC 전용 단계 제외) */
  steps: TutorialStepDef[];
  done: Record<TutorialStepId, boolean>;
  doneCount: number;
  total: number;
  /** 아직 안 끝난 첫 단계(모두 끝났으면 null) */
  nextId: TutorialStepId | null;
  allDone: boolean;
}

/** 단계별 완료 판정. 정보 단계(환영·키 준비·모드 설명·설정 살펴보기)는 "마법사에서 확인함(visited)"이 완료 조건이다. */
export function computeProgress(s: TutorialSnapshot): TutorialProgress {
  const seen = (id: TutorialStepId) => s.visited.includes(id);
  const done: Record<TutorialStepId, boolean> = {
    welcome: seen("welcome"),
    account: s.loggedIn && s.approved,
    keysPrep: s.hasKeys || seen("keysPrep"),
    keysInput: s.hasKeys && s.connectionOk,
    mode: seen("mode"),
    discord: s.discordSaved,
    autoSettings: seen("autoSettings"),
    screening: s.scanRan || seen("screening"),
    launch: s.autoEnabled,
  };
  const steps = TUTORIAL_STEPS.filter((d) => s.isDesktop || d.platform === "both");
  const doneCount = steps.filter((d) => done[d.id]).length;
  const next = steps.find((d) => !done[d.id]);
  return { steps, done, doneCount, total: steps.length, nextId: next ? next.id : null, allDone: !next };
}

// ── 이 기기에 저장하는 튜토리얼 상태(localStorage) ─────────────────────────────────────────────

export interface TutorialStored {
  /** 마법사에서 확인한 단계들 */
  visited: TutorialStepId[];
  /** 마법사 연결 테스트를 통과한 적 */
  connectionOk: boolean;
  /** 처음 로그인 직후 자동으로 한 번 열었는가 — true면 다시 자동으로 열지 않는다(수동으로는 언제든 연다) */
  autoOpened: boolean;
  /** 화면 구석 알약을 사용자가 숨겼는가(헤더 버튼·설정 항목으로는 계속 다시 열 수 있다) */
  pillHidden: boolean;
  /** 마지막으로 보던 단계(다시 열면 거기서 이어서) */
  lastStep: TutorialStepId | null;
}

export const TUTORIAL_STORED_DEFAULT: TutorialStored = { visited: [], connectionOk: false, autoOpened: false, pillHidden: false, lastStep: null };

/** [v0.95.0][버그 수정] 저장 상태에 patch(값 그대로, 또는 "이전 상태 → patch" 함수)를 반영한다.
 *  화면(Tutorial.tsx)의 patchStored가 이 함수로 React의 함수형 setState처럼 "직전 결과 위에 이어붙이게" 한다.
 *  예전엔 매번 "그 틱이 시작될 때의" 오래된 상태를 기준으로 next를 계산했는데, 한 핸들러 안에서
 *  patchStored를 두 번 부르면(예: "다음" 버튼의 go() — markVisited(현재 단계) 직후 lastStep을 또 갱신)
 *  두 번째 호출이 첫 번째 호출의 변경(visited 추가)을 그대로 덮어써 버렸다 — "다음"을 눌러도 방문
 *  체크가 저장되지 않고 사라지던 버그의 원인. 항상 직전 patch가 반영된 prev를 넘겨 받아야 이게 안 생긴다. */
export function applyTutorialPatch(
  prev: TutorialStored,
  patch: Partial<TutorialStored> | ((prev: TutorialStored) => Partial<TutorialStored>),
): TutorialStored {
  return { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
}

/**
 * [v0.109.0] mergeTutorialStored — 두 기기의 튜토리얼 진행 상태를 합친다(계정 동기화용).
 *   방문한 단계는 합집합, 켜짐 표시는 하나라도 true면 true — "한 번 한 것은 되돌아가지 않는" 단방향 값뿐이라
 *   어느 기기가 먼저 합쳐도 결과가 같다(수렴). lastStep은 현재(local) 기기 것을 우선한다.
 */
export function mergeTutorialStored(local: TutorialStored, remote: TutorialStored): TutorialStored {
  return {
    visited: [...new Set([...local.visited, ...remote.visited])],
    connectionOk: local.connectionOk || remote.connectionOk,
    autoOpened: local.autoOpened || remote.autoOpened,
    pillHidden: local.pillHidden || remote.pillHidden,
    lastStep: local.lastStep ?? remote.lastStep,
  };
}

export function tutorialStorageKey(email: string | null | undefined): string {
  return `capri-tutorial-v1:${(email ?? "anon").toLowerCase()}`;
}

/** 저장된 JSON을 안전하게 읽는다(깨졌거나 옛 모양이면 기본값). */
export function parseTutorialStored(raw: string | null): TutorialStored {
  if (!raw) return { ...TUTORIAL_STORED_DEFAULT };
  try {
    const o = JSON.parse(raw) as Partial<TutorialStored>;
    const ids = new Set(TUTORIAL_STEPS.map((d) => d.id));
    return {
      visited: Array.isArray(o.visited) ? (o.visited.filter((x): x is TutorialStepId => ids.has(x as TutorialStepId))) : [],
      connectionOk: o.connectionOk === true,
      autoOpened: o.autoOpened === true,
      pillHidden: o.pillHidden === true,
      lastStep: o.lastStep && ids.has(o.lastStep) ? o.lastStep : null,
    };
  } catch {
    return { ...TUTORIAL_STORED_DEFAULT };
  }
}

/** 처음 로그인 직후 자동으로 열어야 하는가: 로그인·승인됐고, 아직 자동으로 연 적 없고, 키도 없는 "처음 쓰는 사람". */
export function shouldAutoOpen(s: { loggedIn: boolean; approved: boolean; hasKeys: boolean }, stored: TutorialStored): boolean {
  return s.loggedIn && s.approved && !stored.autoOpened && !s.hasKeys && stored.visited.length === 0;
}
