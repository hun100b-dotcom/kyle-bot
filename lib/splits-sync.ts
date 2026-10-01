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

export interface SplitsSyncPayload {
  v: 1;
  pushedAtMs: number;
  splits: SavedSplit[];
}

export function isSplitsSyncPayload(v: unknown): v is SplitsSyncPayload {
  const o = v as SplitsSyncPayload | null;
  return !!o && o.v === 1 && Array.isArray(o.splits) && typeof o.pushedAtMs === "number";
}

/** [보안 — tests/trade-sync.test.ts와 같은 원칙] 알려진 필드만 골라 새 객체로 다시 만든다 —
 *  혹시라도 SavedSplit에 엉뚱한 값이 얹혀 있어도 그 필드 자체가 아니면 올라가지 않는다. */
export function toSplitsSyncPayload(splits: SavedSplit[], nowMs: number): SplitsSyncPayload {
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
    })),
  };
}

/**
 * mergeSplits — 이 기기에 있던 기록과 클라우드에서 받은 기록을 합친다.
 *   같은 id가 양쪽에 있으면 더 최근(ts 문자열 비교, "MM-dd HH:mm:ss" 형식이라 같은 해
 *   안에서는 사전식 비교가 시간순과 일치)에 손댄 쪽이 이긴다 — 한쪽에만 있으면 그대로
 *   포함(신규 병합). 자동매매 기록과 달리 "상태가 역행하면 안 되는" 성질이 없어(단순
 *   메모성 기록) "최신이 이긴다"는 단순한 규칙으로 충분하다.
 */
export function mergeSplits(local: SavedSplit[], incoming: SavedSplit[]): SavedSplit[] {
  const map = new Map<string, SavedSplit>();
  for (const s of local) map.set(s.id, s);
  for (const s of incoming) {
    const existing = map.get(s.id);
    if (!existing || s.ts > existing.ts) map.set(s.id, s);
  }
  return [...map.values()].sort((a, b) => b.ts.localeCompare(a.ts)); // 최신이 위(기존 화면 정렬과 동일)
}
