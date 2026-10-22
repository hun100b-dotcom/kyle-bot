// =============================================================================
// lib/group-presence.ts — [v0.109.0] 그룹원 "근황"(접속·상태) 합치기 규칙 (순수 함수)
// -----------------------------------------------------------------------------
// [왜 필요한가 — 오너 지시 2026-10-22 "그룹원 근황 등 동기화 전수조사"]
//   예전 근황 표는 자동매매 기록 건수/마지막 매매만 보여줬다. 상대가 지금 접속 중인지,
//   자동매매가 켜져 있는지, 몇 종목을 들고 있는지는 서로 알 방법이 없었다.
//   이제 기기마다 capri_group_presence에 한 줄씩 올리고(30초마다), 화면은 이 파일의 규칙으로
//   "사람 한 명 = 한 줄"로 합쳐서 보여준다.
//
// [합치는 규칙 — 오차가 없게 한 곳에 고정]
//   · 접속 중 = 그 사람의 기기 중 하나라도 마지막 신호가 90초 안(신호는 30초마다 → 두 번 놓쳐도 유지).
//   · 자동매매 켜짐 = PC 기기 중 하나라도 켜짐(폰·웹은 매매를 안 하므로 제외).
//   · 보유 종목 수 = PC 기기 중 가장 큰 값(같은 계좌를 두 PC가 보면 중복 합산하면 안 되므로 합이 아니라 최대).
//   · 버전 = 가장 최근에 신호를 보낸 기기의 버전.
// ⚠️ 이 파일은 네트워크·파일을 다루지 않는다 → 테스트가 쉽다.
// =============================================================================

/** 서버(capri_group_presence)의 한 줄 = 기기 한 대. */
export interface PresenceRow {
  user_id: string;
  device_id: string;
  member_email: string;
  platform: "pc" | "web";
  app_version: string | null;
  auto_trade_enabled: boolean;
  open_positions: number;
  last_seen: string; // ISO
}

/** 화면에 보여줄 "사람 한 명" 상태. */
export interface GroupPresence {
  email: string;
  online: boolean;
  lastSeenMs: number | null;
  platforms: Array<"pc" | "web">;
  appVersion: string | null;
  autoTradeEnabled: boolean;
  openPositions: number;
}

/** 신호를 30초마다 보내므로 90초(=두 번 놓쳐도) 안이면 접속 중으로 본다. */
export const PRESENCE_ONLINE_WINDOW_MS = 90_000;
/** 상태 신호를 올리는 간격. */
export const PRESENCE_PUSH_INTERVAL_MS = 30_000;

/**
 * aggregatePresence — 기기별 줄들을 사람별로 합친다(이메일 알파벳순).
 *   nowMs를 인자로 받는 이유: 테스트에서 시각을 고정하기 위해.
 */
export function aggregatePresence(rows: PresenceRow[], nowMs: number): GroupPresence[] {
  const byEmail = new Map<string, PresenceRow[]>();
  for (const r of rows) {
    if (!r || typeof r.member_email !== "string") continue;
    const list = byEmail.get(r.member_email) ?? [];
    list.push(r);
    byEmail.set(r.member_email, list);
  }
  const out: GroupPresence[] = [];
  for (const [email, list] of byEmail) {
    const withMs = list
      .map((r) => ({ r, ms: Date.parse(r.last_seen) }))
      .filter((x) => Number.isFinite(x.ms))
      .sort((a, b) => b.ms - a.ms); // 최근 신호가 앞
    if (withMs.length === 0) continue;
    const recent = withMs.filter((x) => nowMs - x.ms < PRESENCE_ONLINE_WINDOW_MS);
    const pcRecent = recent.filter((x) => x.r.platform === "pc");
    out.push({
      email,
      online: recent.length > 0,
      lastSeenMs: withMs[0].ms,
      platforms: [...new Set(recent.map((x) => x.r.platform))].sort() as Array<"pc" | "web">,
      appVersion: withMs[0].r.app_version ?? null,
      autoTradeEnabled: pcRecent.some((x) => x.r.auto_trade_enabled),
      openPositions: pcRecent.reduce((m, x) => Math.max(m, Math.max(0, Math.floor(x.r.open_positions || 0))), 0),
    });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * presenceKey — 화면을 다시 그려야 하는지 판단하는 지문. "접속 중인지"가 같으면 마지막 신호 시각이
 *   바뀌어도 같은 키 → 불필요한 화면 갱신을 막는다(8초마다 깜빡이지 않게).
 */
export function presenceKey(list: GroupPresence[]): string {
  return JSON.stringify(list.map((p) => [p.email, p.online, p.platforms, p.appVersion, p.autoTradeEnabled, p.openPositions]));
}

/** 서버 이메일이 아직 허용목록 오타 등으로 다를 수 있어 소문자로 비교하는 헬퍼. */
export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
