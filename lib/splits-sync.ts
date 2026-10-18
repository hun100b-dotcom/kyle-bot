// =============================================================================
// lib/splits-sync.ts — 삼분할 타점 기록(SavedSplit)을 '암호화해서' 기기 간에 옮기는 규칙 (순수 계산)
// -----------------------------------------------------------------------------
// [무엇을 푸는가 — ③ 전수조사 중간-2, 2026-10-01]
//   삼분할 타점 기록은 PC·폰 각자의 로컬 파일에만 저장돼 기기 간 동기화가 전혀 없었다
//   — "PC·폰 모두 동일 기능·화면 조회 가능"(오너 지시) 미달 항목. lib/auto-state-sync.ts
//   (자동매매 기록 동기화)와 완전히 같은 패턴: 로그인 비밀번호로 암호화해 Supabase(내 계정
//   전용 행)에 올려 두고, 같은 계정으로 로그인한 다른 기기가 자동으로 받아서 푼다.
// =============================================================================

import type { SavedSplit } from "../electron/tool-engine";

/**
 * [v0.102.0] 삭제 표식(tombstone, "이 기록은 지워졌음" 메모) 목록 — { 기록id: 지운 시각(ms) }.
 *
 * [왜 필요한가 — "지운 기록이 다른 기기에서 다시 살아나는" 사고의 원인]
 *   예전 동기화는 "양쪽 기록을 합집합으로 합친다"였다. 맥에서 기록 A를 지우고 올려도,
 *   아직 A를 갖고 있는 윈도우가 받기→합치기를 하면 "클라우드엔 없고 나한텐 있네 → 새 기록이구나"
 *   라고 착각해 A를 다시 올려 버린다. 그러면 맥이 다음 동기화 때 A를 다시 받는다(부활).
 *   기기 입장에선 "아직 못 받은 새 기록"과 "누가 지운 기록"을 구별할 방법이 없었던 것이다.
 *
 *   그래서 지울 때 기록만 빼는 게 아니라 "A는 몇 시에 지워졌음"이라는 표식을 남기고, 이 표식도
 *   함께 동기화한다. 표식이 있는 id는 어느 기기에 남아 있든 합칠 때 빠진다 → 부활이 불가능해진다.
 *   (삭제 표식은 id와 시각 숫자뿐이라 아주 작다 — 기록 내용은 들어 있지 않다.)
 */
export type Tombstones = Record<string, number>;

/** 삭제 표식을 얼마나 오래 들고 있을지 — 1년 넘게 꺼져 있던 기기가 아니면 충분하다(그보다 오래된 표식만 정리). */
export const TOMBSTONE_KEEP_MS = 400 * 86_400_000;
/** 삭제 표식 최대 개수 — 무한히 쌓이지 않게(최신 것부터 남긴다). */
export const TOMBSTONE_MAX = 5000;
/** 삼분할 기록 최대 보관 개수(addSplit의 기존 한도와 같다 — 모든 기기가 같은 규칙으로 잘라야 결과가 같아진다). */
export const SPLITS_MAX = 500;

/**
 * mergeTombstones — 두 기기의 삭제 표식을 합친다(같은 id면 더 늦은 시각).
 *   오래된 표식(TOMBSTONE_KEEP_MS 초과)은 정리하고, 개수도 TOMBSTONE_MAX로 제한한다.
 *   순서·결과가 입력 순서와 무관하게 항상 같다(교환법칙) — 어느 기기에서 합쳐도 똑같은 결과.
 */
export function mergeTombstones(a: Tombstones | undefined, b: Tombstones | undefined, nowMs: number): Tombstones {
  const out = new Map<string, number>();
  for (const src of [a ?? {}, b ?? {}]) {
    for (const [id, at] of Object.entries(src)) {
      if (typeof at !== "number" || !Number.isFinite(at)) continue; // 깨진 값은 무시
      if (nowMs - at > TOMBSTONE_KEEP_MS) continue; // 너무 오래된 표식은 정리
      out.set(id, Math.max(out.get(id) ?? 0, at));
    }
  }
  const sorted = [...out.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, TOMBSTONE_MAX);
  return Object.fromEntries(sorted);
}

export interface SplitsSyncPayload {
  v: 1;
  pushedAtMs: number;
  splits: SavedSplit[];
  /** [v0.102.0] 삭제 표식(없으면 옛 버전이 올린 파일 — 빈 목록으로 취급). */
  deleted?: Tombstones;
}

export function isSplitsSyncPayload(v: unknown): v is SplitsSyncPayload {
  const o = v as SplitsSyncPayload | null;
  if (!(!!o && o.v === 1 && Array.isArray(o.splits) && typeof o.pushedAtMs === "number")) return false;
  // deleted는 선택 항목 — 있으면 반드시 "객체"여야 한다(배열·문자열이면 깨진 파일로 본다).
  return o.deleted === undefined || (typeof o.deleted === "object" && o.deleted !== null && !Array.isArray(o.deleted));
}

/** [보안 — tests/trade-sync.test.ts와 같은 원칙] 알려진 필드만 골라 새 객체로 다시 만든다 —
 *  혹시라도 SavedSplit에 엉뚱한 값이 얹혀 있어도 그 필드 자체가 아니면 올라가지 않는다. */
export function toSplitsSyncPayload(splits: SavedSplit[], nowMs: number, deleted: Tombstones = {}): SplitsSyncPayload {
  return {
    v: 1,
    pushedAtMs: nowMs,
    splits: splits.map((s) => ({
      id: s.id,
      ts: s.ts,
      symbol: s.symbol,
      technique: s.technique,
      levels: s.levels,
      tpPct: s.tpPct,
      slPct: s.slPct,
      qty: s.qty,
      memo: s.memo,
      ...(s.inputs ? { inputs: s.inputs } : {}),
      // [v0.102.0] 마지막으로 손댄 시각 — 이게 있어야 "메모 수정·진입완료 체크"가 다른 기기로 넘어간다.
      ...(typeof s.updatedAtMs === "number" ? { updatedAtMs: s.updatedAtMs } : {}),
    })),
    deleted: { ...deleted },
  };
}

/** 정렬용 "만든 시각" — id가 저장 시각(ms)이라 숫자로 바꾸면 연도까지 포함된 정확한 시간순이 된다.
 *  (ts "MM-dd HH:mm:ss"는 연도가 없어 12월→1월을 넘어가면 순서가 뒤집힌다 — 그래서 id를 쓴다.) */
function splitCreatedMs(s: SavedSplit): number {
  const n = Number(s.id);
  return Number.isFinite(n) ? n : 0;
}

/**
 * pickNewerSplit — 같은 id 기록 두 개 중 "더 나중에 손댄 쪽"을 고른다.
 *   1) updatedAtMs(v0.102.0부터 수정할 때마다 찍힘)가 큰 쪽.
 *   2) 둘 다 같으면(옛 기록이라 둘 다 없음 등) 예전 규칙대로 ts가 더 최근인 쪽.
 *   3) 그래도 같으면 이 기기 것을 유지(예전 동작 그대로).
 */
function pickNewerSplit(local: SavedSplit, incoming: SavedSplit): SavedSplit {
  const lu = local.updatedAtMs ?? 0;
  const iu = incoming.updatedAtMs ?? 0;
  if (iu !== lu) return iu > lu ? incoming : local;
  if (incoming.ts !== local.ts) return incoming.ts > local.ts ? incoming : local;
  return local;
}

/**
 * mergeSplits — 이 기기에 있던 기록과 클라우드에서 받은 기록을 합친다.
 *   · 같은 id가 양쪽에 있으면 더 나중에 손댄 쪽이 이긴다(pickNewerSplit).
 *   · 한쪽에만 있으면 포함(신규 병합) — **단, 삭제 표식이 있는 id는 어느 쪽에 있든 뺀다**(부활 방지).
 *   · 최신(만든 시각)이 위, 최대 SPLITS_MAX개 — 모든 기기가 같은 규칙으로 정렬·자르므로 결과가 같다.
 */
export function mergeSplits(local: SavedSplit[], incoming: SavedSplit[], deleted: Tombstones = {}): SavedSplit[] {
  const map = new Map<string, SavedSplit>();
  for (const s of local) map.set(s.id, s);
  for (const s of incoming) {
    const existing = map.get(s.id);
    map.set(s.id, existing ? pickNewerSplit(existing, s) : s);
  }
  return [...map.values()]
    .filter((s) => deleted[s.id] === undefined) // 삭제 표식이 있으면 무조건 제외
    .sort((a, b) => splitCreatedMs(b) - splitCreatedMs(a) || b.ts.localeCompare(a.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SPLITS_MAX);
}
