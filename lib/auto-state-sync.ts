// =============================================================================
// lib/auto-state-sync.ts — 자동매매 기록(포지션+이력)을 '암호화해서' 기기 간에 옮기는 규칙 (순수 계산)
// -----------------------------------------------------------------------------
// [무엇을 푸는가 — 오너 상황, 2026-09-26]
//   "PC에서 진행하다 폰에서 킬 경우 자동매매 기록·현황이 모두 사라져 있음. 실제 토스에는
//   그 주문이 남아있는데." → v0.30.1 긴급수정으로 "같은 기기"에서 앱을 껐다 켜도 안 사라지게는
//   고쳤지만, PC와 폰은 완전히 별개 저장소라 서로는 여전히 안 보였다(그때는 "알려진 한계"로
//   남겨둠). 이 파일은 그 나머지 절반 — **다른 기기에서도** 보이게 하는 부분을 푼다.
//
//   방법은 이미 있는 매매이력 동기화(lib/trade-sync.ts)와 똑같다: 로그인 비밀번호로
//   암호화해 Supabase(내 계정 전용 행)에 올려 두고, 같은 계정으로 로그인한 다른 기기가
//   자동으로 받아서 푼다. 새 비밀번호도, 새 화면도 필요 없다 — 로그인만 하면 된다.
//
// [무엇을 올리고 무엇은 절대 안 올리나 — 중요]
//   올리는 것  : autoTradeHistory 전체(종목·진입가·익절가·손절가·수량·시각·상태·손익·
//                조건주문번호·매수주문번호 — 전부 "이 계정의 매매 결과와 그 추적용 번호"뿐)
//   안 올리는 것: **토스 API 키, 액세스 토큰, 계좌번호, 비밀번호, 이름 등 신원 정보**
//   게다가 전부 암호문이라, 비밀번호가 없으면 아무 의미 없는 글자 뭉치다.
//
// [왜 positions(포지션 목록)는 따로 안 올리나 — 핵심 설계]
//   "지금 감시 중인 포지션"은 사실 history 안에서 status가 아직 안 끝난(watching/active)
//   레코드와 완전히 같은 정보다. 그래서 따로 동기화하지 않고 **history 하나만 동기화한 뒤,
//   그 안에서 진행 중인 것만 걸러 positions를 다시 만든다**(derivePositionsFromHistory).
//   두 개를 따로 옮기면 "둘이 서로 다른 말을 하는" 불일치가 생기기 쉬운데(v0.25.0에서 차트와
//   근거 표가 어긋나던 것과 같은 종류의 문제), 하나만 옮기면 애초에 어긋날 방법이 없다.
// =============================================================================

import type { AutoPosition, AutoTradeHistoryEntry, ScreenRun } from "../electron/tool-engine";

/**
 * 동기화 파일에 담기는 내용(자동매매 기록 전체 — 위 주석대로 신원 정보는 없다).
 *
 * [v0.60.5 — 오너 요청 "PC에서와같이 자동스크리닝이 돌아가면 자동스크리너에서 pc와
 *   동일하게 조회할 수 있도록"] lastScan(마지막 스캔 전체 결과 — 확정/관찰/탈락 종목과
 *   그 근거까지 전부)·skipReasons(확정됐는데 아직 안 들어간 이유)를 추가했다. 웹(폰)은
 *   토스에 직접 못 붙어 스스로 스캔할 수 없으므로, PC가 실제로 돈 스캔을 그대로 받아와
 *   보여주는 것이 유일한 방법이다 — history와 같은 자리(capri_auto_state, 암호화)에
 *   얹었다(새 테이블 없이 재사용, 어차피 같은 "내 계정 전용" 보안 모델). v는 그대로 1로
 *   둔다(두 필드 다 선택 필드라 구버전이 보내거나 받아도 깨지지 않음 — 구버전이 이
 *   필드 없는 걸 보내면 신버전은 그냥 undefined로 받고, 신버전이 보낸 걸 구버전이
 *   받으면 모르는 필드를 무시할 뿐 isAutoStateSyncPayload 통과엔 지장 없다).
 */
export interface AutoStateSyncPayload {
  v: 1; //             형식 버전(나중에 바꿔도 옛 파일을 읽을 수 있게)
  pushedAtMs: number; // 올린 시각
  history: AutoTradeHistoryEntry[]; // 자동매매 전체 생애주기 기록
  lastScan?: ScreenRun | null; //                 [v0.60.5] 마지막 자동 스캔 결과 전체
  skipReasons?: Record<string, string>; //         [v0.60.5] 확정됐는데 아직 미진입인 이유
}

/** 받은 파일이 올바른 모양인지 확인한다(깨진 파일로 화면이 망가지지 않게). */
export function isAutoStateSyncPayload(v: unknown): v is AutoStateSyncPayload {
  const o = v as AutoStateSyncPayload | null;
  return !!o && o.v === 1 && Array.isArray(o.history) && typeof o.pushedAtMs === "number";
}

export function toAutoStateSyncPayload(
  history: AutoTradeHistoryEntry[],
  nowMs: number,
  extra?: { lastScan?: ScreenRun | null; skipReasons?: Record<string, string> },
): AutoStateSyncPayload {
  return { v: 1, pushedAtMs: nowMs, history, lastScan: extra?.lastScan, skipReasons: extra?.skipReasons };
}

/**
 * [핵심] 상태의 "진행 단계"를 숫자로 매긴다 — watching(0) < active(1) < 그 외 전부 끝난 상태(2).
 *   같은 레코드(id)를 두 기기가 각자 다른 시점까지 진행시켰을 때, **더 앞서 나간 쪽을
 *   이긴다.** 자동매매의 상태 전이는 항상 한 방향으로만 흐르므로(watching→active→종료,
 *   거꾸로 가는 일이 없음) 이 규칙만으로 "뒤로 되돌리는" 병합 사고 없이 항상 안전하다.
 */
const STATUS_RANK: Record<AutoTradeHistoryEntry["status"], number> = {
  watching: 0,
  active: 1,
  closed_win: 2,
  closed_loss: 2,
  closed_manual: 2,
  cancelled: 2,
  oco_failed: 2,
  dryrun: 2,
};

/**
 * mergeAutoHistory — 이 기기에 있던 기록과 클라우드에서 받은 기록을 합친다.
 *   같은 id(=`symbol@entry@enteredAtMs`, 한 번의 진입을 가리키는 열쇠)가 양쪽에 있으면
 *   "더 진행된 쪽"만 남긴다(위 STATUS_RANK). 한쪽에만 있으면 그대로 포함(신규 병합).
 */
export function mergeAutoHistory(local: AutoTradeHistoryEntry[], incoming: AutoTradeHistoryEntry[]): AutoTradeHistoryEntry[] {
  const map = new Map<string, AutoTradeHistoryEntry>();
  for (const h of local) map.set(h.id, h);
  for (const h of incoming) {
    const existing = map.get(h.id);
    if (!existing || STATUS_RANK[h.status] > STATUS_RANK[existing.status]) map.set(h.id, h);
  }
  return [...map.values()].sort((a, b) => a.enteredAt.localeCompare(b.enteredAt));
}

/**
 * derivePositionsFromHistory — "지금 감시 중" 목록을 병합된 history에서 다시 만든다.
 *   status가 watching/active인(=아직 안 끝난) 레코드만 AutoPosition 모양으로 되돌린다.
 *   [주의] conditionalOrderId/buyOrderId가 없는(=v0.30.0 이전 기록이거나, 애초에 실패해서
 *   번호를 못 받은) 항목은 이 기기가 실제로 재확인할 방법이 없으므로 걸러낸다 — 화면에
 *   "감시 중"이라고 떠도 정작 아무것도 확인 못 하면 오히려 헷갈린다(정직하게 표시).
 */
export function derivePositionsFromHistory(history: AutoTradeHistoryEntry[]): AutoPosition[] {
  return history
    .filter((h) => (h.status === "watching" && h.buyOrderId) || (h.status === "active" && h.conditionalOrderId))
    .map((h) => {
      // enteredAtMs(정확한 ms 단위 시각)는 history엔 없다(사람이 읽는 KST 문자열만 있음) —
      //   id가 원래 `${symbol}@${entry}@${enteredAtMs}`로 만들어지므로 그 안에서 그대로 복원한다
      //   (Date.parse로 문자열을 다시 계산하면 초 단위 이하가 달라져 이후 이 항목을 다시 찾을
      //   열쇠가 어긋난다 — 반드시 원본 숫자를 그대로 써야 함).
      const enteredAtMs = Number(h.id.slice(h.id.lastIndexOf("@") + 1));
      return {
        symbol: h.symbol,
        entry: h.entry,
        tp: h.tp,
        sl: h.sl,
        quantity: h.quantity,
        enteredAtMs: Number.isFinite(enteredAtMs) ? enteredAtMs : Date.now(),
        status: h.status as "watching" | "active",
        conditionalOrderId: h.conditionalOrderId ?? null,
        buyOrderId: h.buyOrderId ?? null,
      };
    });
}
