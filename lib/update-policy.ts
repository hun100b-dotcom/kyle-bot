// =============================================================================
// lib/update-policy.ts — [v0.70.0] 자동 업데이트 "적용·재시작" 정책 (순수 함수)
// -----------------------------------------------------------------------------
// [오너 확정 정책 — 2026-10-13, 재논의 대상 아님]
//   업데이트는 자동매매가 돌고 있어도, 포지션을 보유 중이어도 받아서 적용하고 재시작한다.
//   (OCO 익절·손절은 토스 서버에 등록돼 있어 앱이 꺼져도 살아 있다 — 앱은 감시자일 뿐 보호자가 아니다.)
//   재시작을 미루는 경우는 딱 두 순간뿐이다. 안전이 아니라 "그 순간 죽으면 주문 상태가 깨지기 때문"이다:
//     ① 주문 전송 후 결과(체결·접수 응답)를 못 받은 구간(in-flight) — 중복 주문·유실 방지
//     ② 매수 체결 확인 ~ OCO(익절·손절) 등록 완료 전 구간 — 보호 없는 포지션 방지(WETO·QTEX·WHLR·NAUT 사고의 무방비 창)
//   두 구간은 길어야 수 초~수십 초다. "자동매매가 켜져 있다"는 이유로는 절대 미루지 않는다.
// =============================================================================

export interface RestartBlocker {
  /** inflight = 주문 전송~응답 / oco-window = 체결 확인~OCO 등록 완료 / guard = 보호 가드가 주문을 내는 중 */
  kind: "inflight" | "oco-window" | "guard";
  label: string;
  sinceMs: number;
}

/** 이보다 오래 붙어 있는 차단 표시는 "꼬인 표시"로 보고 무시한다(어떤 버그로도 업데이트가 영영 막히지 않게). 주문 API 타임아웃(10초)×재시도(약 4회)보다 넉넉하게. */
export const BLOCKER_STALE_MS = 150_000;

export interface RestartDecision {
  ok: boolean;
  /** 지금 실제로 재시작을 막고 있는 구간. */
  active: RestartBlocker[];
  /** 너무 오래돼 무시한 표시(진단용 — 저널에 남긴다). */
  stale: RestartBlocker[];
}

/** 지금 재시작해도 되는가? 위 두 구간(+가드 주문 중)에만 막히고, 그 밖의 이유(자동매매 켜짐·보유 포지션·사람 활동)는 보지 않는다. */
export function evaluateRestart(blockers: RestartBlocker[], nowMs: number): RestartDecision {
  const active: RestartBlocker[] = [];
  const stale: RestartBlocker[] = [];
  for (const b of blockers) (nowMs - b.sinceMs > BLOCKER_STALE_MS ? stale : active).push(b);
  return { ok: active.length === 0, active, stale };
}

/** 재시작 직전에 디스크에 남기는 한 번용 표식 — 새 버전이 켜지면 한 번 읽고 지운다. */
export interface RestartMarker {
  atMs: number;
  fromVersion: string;
  toVersion: string | null;
  autoTradeWasOn: boolean;
  positions: Array<{ symbol: string; status: string; quantity: number }>;
  unprotected: string[];
}

/** 표식이 아직 유효한가(너무 오래된 표식으로 뒤늦게 자동매매를 켜지 않기 위해). */
export const RESUME_WINDOW_MS = 30 * 60_000;
export function isMarkerFresh(m: RestartMarker, nowMs: number): boolean {
  return Number.isFinite(m.atMs) && nowMs - m.atMs >= 0 && nowMs - m.atMs <= RESUME_WINDOW_MS;
}

/** 디스코드·저널에 남기는 재시작 기록 한 줄(사람이 읽는 문장). */
export function describeRestart(m: RestartMarker, nowVersion: string): string {
  const pos = m.positions.length ? m.positions.map((p) => `${p.symbol}(${p.status === "active" ? "보유·보호중" : "매수대기"} ${p.quantity}주)`).join(", ") : "없음";
  return (
    `🔄 자동 업데이트 재시작 — v${m.fromVersion} → v${nowVersion}. 당시 자동매매 ${m.autoTradeWasOn ? "켜짐(재시작 후 자동으로 다시 켭니다)" : "꺼짐"} · ` +
    `보유/대기 포지션: ${pos}${m.unprotected.length ? ` · 보호 대기: ${m.unprotected.join(", ")}` : ""}`
  );
}
