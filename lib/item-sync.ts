// =============================================================================
// lib/item-sync.ts — [v0.108.0] "항목 단위" 계정 동기화 엔진 (모든 기기: 윈도우·맥·폰·웹)
// -----------------------------------------------------------------------------
// [왜 만들었나 — 오너 지시 2026-10-22]
//   "PC에서 세팅한 값이 폰·다른 노트북에 동기화가 안 된다. 로그인 계정 기준으로 설정·자동매매 설정·
//    스크리닝 기준·매매기록·매매연구소·관찰 기록·가상봇 기록 전부 실시간으로 맞아야 한다."
//   조사해 보니 설정 60여 개와 연구소·관찰·트레이드·매매근거·실행 기록이 전부 "기기 파일"에만 있었다.
//   이 파일은 그 데이터를 클라우드 표(capri_sync_items) 하나로 모든 기기에 맞추는 규칙을 담는다.
//
// [동작 원리 — 은행 장부처럼]
//   1) 항목 하나(설정 1개, 연구소 신호 1개, 관찰 기록 1개 …)마다 "버전(rev)"과 "내용 지문(hash)"을 붙인다.
//      · 버전 = 그 항목을 마지막으로 고친 시각(ms). 내용이 바뀌면 이 기기가 새 버전을 찍는다.
//      · 같은 버전이면 지문이 큰 쪽이 이긴다 → 모든 기기가 반드시 "똑같은 내용"으로 수렴한다(오차 0).
//   2) 올리기: 서버 함수(capri_sync_put)가 "들어온 (버전, 지문)이 서버 것보다 클 때만" 바꾼다.
//      → 두 기기가 동시에 저장해도 더 최신인 쪽만 남는다. 옛 값이 새 값을 덮는 일은 구조적으로 없다.
//   3) 받기: "마지막으로 본 시각 이후 바뀐 줄"만 받는다(2분 겹쳐서 받아 짧은 간격 누락도 막는다).
//      받은 버전이 이 기기 것보다 크면 반영하고, 작으면 이 기기 것을 다시 올린다.
//   4) 삭제: 줄을 지우지 않고 "삭제 표식(묘비)"을 더 높은 버전으로 올린다 → 다른 기기에서 부활하지 않는다.
//
// [처음 한 번(마이그레이션) — 기존 데이터 유실 방지]
//   이 기능이 생기기 전부터 기기에 있던 항목은 "옛 버전 번호"(1~3 같은 아주 작은 수)를 받는다.
//   그래서 처음 동기화할 때 어느 기기의 기록도 지워지지 않고(합집합), 같은 항목이 양쪽에 있으면
//   더 진행된 쪽(예: '관찰 중'보다 '확정')이 이긴다. 이후 고친 것은 전부 시각 버전(수조 단위)이라
//   옛 버전보다 항상 크다.
//
// ⚠️ 이 파일은 네트워크·파일을 직접 다루지 않는다(전송·저장은 엔진이 넘겨준 함수로만) → 가짜 클라우드로 테스트 가능.
// =============================================================================

/** 항목 하나의 버전 정보(이 기기가 알고 있는 것). del=true면 "지워졌음" 표식. */
export interface ItemVer {
  rev: number;
  hash: string;
  del?: boolean;
}

/** 서버(capri_sync_items)에서 받은 한 줄. */
export interface SyncRow {
  kind: string;
  item_id: string;
  rev: number;
  hash: string;
  deleted: boolean;
  payload: unknown;
  updated_at: string;
}

/** 올릴 항목 한 개(서버 함수 capri_sync_put에 그대로 넘어간다). */
export interface PutItem {
  id: string;
  rev: number;
  hash: string;
  sort: number;
  deleted?: boolean;
  payload?: unknown;
  device?: string;
}

/**
 * 종류별 어댑터 — 엔진이 "내 데이터는 이렇게 생겼고, 받은 건 이렇게 반영해라"를 알려 주는 창구.
 *   · list(): 지금 이 기기에 있는 항목 전부(id·내용·정렬용 시각)
 *   · legacyRev(): 이 기능 이전부터 있던 항목의 "옛 버전 번호"(작은 수, 진행 단계가 클수록 큼)
 *   · apply(): 받은 변경(추가·수정·삭제)을 이 기기 데이터에 반영(엔진이 상한 정리·파일 저장까지)
 *   · keep: 서버에 최근 몇 개까지 둘지(연구소·관찰처럼 기기도 상한이 있는 종류). 없으면 정리 안 함.
 *   · enabled(): false면 이 기기는 이 종류를 아예 주고받지 않는다(예: 폰은 연구소 탭을 열기 전까지 안 받음).
 *   · persistMeta: 버전 정보를 기기에 저장할지(데이터 자체를 저장하지 않는 기기는 false).
 */
export interface ItemAdapter {
  kind: string;
  list(): Array<{ id: string; data: unknown; sort: number }>;
  legacyRev(data: unknown, id: string): number;
  apply(upserts: Array<{ id: string; data: unknown }>, deletes: string[]): void;
  keep?: number;
  enabled?(): boolean;
  persistMeta?: boolean;
  /** true면 버전 정보가 없는 새 항목도 "옛 버전"으로 등록한다 — 설정처럼 새 항목이 사람의 수정이 아니라
   *  "앱 업데이트로 새로 생긴 설정 칸"일 때(그 기본값이 다른 기기에서 이미 바꾼 값을 덮으면 안 되므로). */
  newItemsLegacy?: boolean;
}

/** 전송 창구(엔진이 Supabase REST로 구현, 테스트는 메모리 가짜 클라우드로 구현). */
export interface ItemTransport {
  /** 서버 함수 호출. 실제로 반영된 id 목록을 돌려준다(버전이 낮아 거절된 건 빠진다). */
  put(kind: string, items: PutItem[]): Promise<string[]>;
  /** since(ISO 시각) 이후 바뀐 줄. kinds를 주면 그 종류만. since=null이면 전부. */
  pull(since: string | null, kinds: string[]): Promise<SyncRow[]>;
  /** 오래된 줄 정리 — sort_ms < beforeSort 인 (삭제 아닌) 줄을 지운다(RLS 안에서 내 줄만). */
  prune?(kind: string, beforeSort: number): Promise<void>;
}

// ── 순수 함수들 ─────────────────────────────────────────────────────────────

/**
 * syncHash — 내용 지문(16자리 16진수). 같은 내용이면 어느 기기에서 계산해도 같은 값.
 *   두 개의 32비트 해시(FNV-1a + 다른 씨앗)를 이어 붙여 우연히 같을 확률을 극히 낮춘다.
 *   고정 길이 소문자 16진수라 서버(Postgres)의 문자열 비교와 JS의 비교 결과가 똑같다(동점 판정 일치).
 */
export function syncHash(value: unknown): string {
  const text = stableJson(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** 키 순서와 무관하게 같은 문자열을 만드는 JSON(기기마다 객체 키 순서가 달라도 지문이 같게). */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

/** 두 버전 비교: 양수면 a가 더 최신. (버전 → 지문) 순서 — 서버 함수의 (rev, hash) 비교와 똑같다. */
export function cmpVer(a: { rev: number; hash: string }, b: { rev: number; hash: string }): number {
  if (a.rev !== b.rev) return a.rev > b.rev ? 1 : -1;
  if (a.hash === b.hash) return 0;
  return a.hash > b.hash ? 1 : -1;
}

/** 새로 고친 항목에 찍을 버전 — 지금 시각, 단 이전 버전보다 반드시 크게(같은 ms에 두 번 고쳐도 겹치지 않게). */
export function nextRev(prev: number | undefined, nowMs: number): number {
  return Math.max(nowMs, (prev ?? 0) + 1);
}

/** 이 기능 이전 항목의 버전이 "시각 버전"과 절대 겹치지 않게 하는 상한(옛 버전은 이보다 작아야 한다). */
export const LEGACY_REV_MAX = 1_000;

/**
 * planPush — 이 기기 데이터와 "알고 있는 버전"을 비교해 ①바뀐 항목에 새 버전을 찍고 ②올려야 할 항목을 고른다.
 *   · meta: 이 기기가 아는 각 항목의 버전(갱신됨 — 함수가 직접 고친다)
 *   · srv : 서버에 이미 올라가 있다고 확인된 버전(받기·올리기 때마다 갱신)
 *   · legacy: true면 meta가 비어 있던 첫 실행 — 지금 있는 항목은 "옛 버전"으로 등록한다(덮어쓰기 방지 핵심).
 */
export function planPush(
  items: Array<{ id: string; data: unknown; sort: number }>,
  meta: Record<string, ItemVer>,
  srv: Record<string, ItemVer>,
  nowMs: number,
  legacyRev: (data: unknown, id: string) => number,
  legacy: boolean,
  deviceId?: string,
): PutItem[] {
  const out: PutItem[] = [];
  const present = new Set<string>();
  for (const it of items) {
    present.add(it.id);
    const hash = syncHash(it.data);
    const m = meta[it.id];
    if (!m) {
      meta[it.id] = { rev: legacy ? Math.min(LEGACY_REV_MAX - 1, Math.max(1, legacyRev(it.data, it.id))) : nowMs, hash };
    } else if (m.del || m.hash !== hash) {
      // 내용이 바뀌었다(또는 지웠던 id가 이 기기에서 새로 생겼다) → 새 버전
      meta[it.id] = { rev: nextRev(m.rev, nowMs), hash };
    }
    const cur = meta[it.id];
    const s = srv[it.id];
    if (!s || cmpVer(cur, s) > 0) out.push({ id: it.id, rev: cur.rev, hash: cur.hash, sort: it.sort, payload: it.data, ...(deviceId ? { device: deviceId } : {}) });
  }
  // 지운 표식(묘비)도 서버에 아직 없으면 올린다.
  for (const [id, m] of Object.entries(meta)) {
    if (present.has(id)) continue;
    if (!m.del) {
      // 상한 정리로 빠진 항목(지운 게 아님) — 버전 정보만 정리한다(다른 기기에서 지우지 않는다).
      delete meta[id];
      continue;
    }
    const s = srv[id];
    if (!s || cmpVer(m, s) > 0) out.push({ id, rev: m.rev, hash: m.hash, sort: 0, deleted: true, ...(deviceId ? { device: deviceId } : {}) });
  }
  return out;
}

/**
 * decideRow — 받은 줄 하나를 이 기기에 반영할지 정한다.
 *   "apply"  : 받은 게 더 최신(또는 이 기기에 그 항목 자체가 없음) → 반영
 *   "keep"   : 이 기기 것이 같거나 더 최신 → 그대로(더 최신이면 다음 올리기에서 서버를 바로잡는다)
 */
export function decideRow(row: { rev: number; hash: string; deleted: boolean }, local: ItemVer | undefined, present: boolean): "apply" | "keep" {
  if (!local) return row.deleted && !present ? "keep" : "apply";
  const c = cmpVer(row, local);
  if (c > 0) return "apply";
  // 이 기기에 내용이 없는데(저장 안 하는 기기·잘린 항목) 지운 표식도 아니면, 받은 내용을 그대로 쓴다.
  if (!present && !local.del && !row.deleted) return "apply";
  return "keep";
}

// ── 동기화 관리자 ────────────────────────────────────────────────────────────

export interface ItemSyncState {
  meta: Record<string, Record<string, ItemVer>>;
  /** 이 종류를 한 번이라도 서버와 맞춘 적이 있는가(첫 실행 '옛 버전' 등록 여부 판단용). */
  inited: Record<string, boolean>;
}

/**
 * ItemSync — 종류별 어댑터를 받아 받기·올리기·삭제를 관리한다.
 *   엔진은 ①데이터가 바뀔 때 markDirty(kind) ②주기적으로 pullChanges() 만 부르면 된다.
 */
export class ItemSync {
  private adapters = new Map<string, ItemAdapter>();
  private state: ItemSyncState;
  private srv: Record<string, Record<string, ItemVer>> = {};
  /** 서버와 처음 한 번 전부 맞춘 종류(그 전에는 올리지 않는다 — 서버 상태를 모른 채 올리는 사고 방지). */
  private ready = new Set<string>();
  private cursor: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = new Set<string>();
  lastOkMs: number | null = null;
  lastError: string | null = null;

  constructor(
    adapters: ItemAdapter[],
    private transport: ItemTransport,
    private opts: {
      deviceId: () => string;
      loadState: () => ItemSyncState | null;
      saveState: (s: ItemSyncState) => void;
      now?: () => number;
      /** 첫 전체 받기가 끝났을 때(종류별) — 설정 '처음 맞추기'(대표 PC 값 이어받기) 같은 후처리용. */
      onFirstSync?: (kind: string, serverRows: number) => Promise<void> | void;
      debounceMs?: number;
    },
  ) {
    for (const a of adapters) this.adapters.set(a.kind, a);
    const loaded = opts.loadState();
    this.state = loaded && loaded.meta && loaded.inited ? loaded : { meta: {}, inited: {} };
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private metaOf(kind: string): Record<string, ItemVer> {
    return (this.state.meta[kind] ??= {});
  }

  private enabledKinds(): string[] {
    return [...this.adapters.values()].filter((a) => !a.enabled || a.enabled()).map((a) => a.kind);
  }

  isReady(kind: string): boolean {
    return this.ready.has(kind);
  }

  /** 버전 정보만 저장(데이터 자체를 저장 안 하는 종류는 빼고). */
  private persist(): void {
    const meta: Record<string, Record<string, ItemVer>> = {};
    const inited: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(this.state.meta)) {
      const a = this.adapters.get(k);
      if (a && a.persistMeta === false) continue;
      meta[k] = v;
      if (this.state.inited[k]) inited[k] = true;
    }
    try {
      this.opts.saveState({ meta, inited });
    } catch {
      /* 저장 실패는 무시 — 다음 실행 때 서버와 다시 맞춘다(서버가 버전으로 지켜 주므로 데이터는 안전) */
    }
  }

  /** 한 번에 하나씩(받기·올리기가 엇갈려 반쯤 합쳐진 상태로 올라가는 일 방지). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 데이터가 바뀌었다 — 잠시(기본 1.5초) 모았다가 올린다(연달아 바뀌어도 한 번에). */
  markDirty(kind: string): void {
    if (!this.adapters.has(kind)) return;
    // 바뀐 "그 순간"에 버전을 찍는다(1.5초 뒤 올릴 때가 아니라). 그래야 ①두 기기가 거의 동시에 고쳤을 때
    // 실제로 나중에 고친 쪽이 이기고 ②올리기 전에 받기가 먼저 돌아도 방금 고친 값이 받은 옛 값에 덮이지 않는다.
    this.stamp(kind);
    this.scheduleDirty(kind);
  }

  /** 올리기 예약만(버전 찍기 없이). */
  private scheduleDirty(kind: string): void {
    this.dirty.add(kind);
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      const kinds = [...this.dirty];
      this.dirty.clear();
      void this.pushKinds(kinds).catch(() => undefined);
    }, this.opts.debounceMs ?? 1_500);
    (this.dirtyTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 항목을 "지웠다"고 표시한다(다음 올리기 때 묘비가 올라간다). 데이터에서 빼는 건 엔진이 직접 한다. */
  markDeleted(kind: string, ids: string[]): void {
    const meta = this.metaOf(kind);
    const now = this.now();
    for (const id of ids) {
      const m = meta[id];
      meta[id] = { rev: nextRev(m?.rev, now), hash: "", del: true };
    }
    this.persist();
    // ⚠️ 여기서 버전 찍기(stamp)를 하면 안 된다 — 엔진이 데이터에서 아직 안 뺐을 수 있어(호출 순서가 '표시 → 빼기'인 곳),
    //   그 순간 찍으면 "다시 생겼다"로 오해해 묘비를 덮어 버린다(연구소 초기화 후 부활하던 버그 — 테스트로 발견).
    this.scheduleDirty(kind);
  }

  /**
   * seed — 정해진 버전(rev)으로 값을 "이어받는다"(첫 동기화 때 대표 PC 값 이어받기 전용).
   *   이 기기의 옛 값(버전 1·2)보다 크고, 누군가 이미 새로 고친 값(시각 버전)보다는 항상 작다.
   */
  seed(kind: string, ups: Array<{ id: string; data: unknown }>, rev: number): number {
    const a = this.adapters.get(kind);
    if (!a) return 0;
    this.ensureInited(kind);
    const meta = this.metaOf(kind);
    const take: Array<{ id: string; data: unknown }> = [];
    for (const u of ups) {
      const ver: ItemVer = { rev: Math.min(LEGACY_REV_MAX - 1, rev), hash: syncHash(u.data) };
      const m = meta[u.id];
      if (m && cmpVer(ver, m) <= 0) continue;
      meta[u.id] = ver;
      take.push(u);
    }
    if (take.length > 0) {
      try {
        a.apply(take, []);
      } catch {
        /* 반영 실패 — 다음 받기에서 다시 맞춘다 */
      }
    }
    this.persist();
    return take.length;
  }

  /** 첫 실행: 서버 전체를 받아 맞춘 뒤(ready) 이 기기에만 있던 것을 올린다. 종류를 주면 그 종류만. */
  async start(kinds?: string[]): Promise<void> {
    const ks = (kinds ?? this.enabledKinds()).filter((k) => !this.ready.has(k) && this.adapters.has(k));
    if (ks.length === 0) return;
    await this.serial(async () => {
      const rows = await this.transport.pull(null, ks);
      const counts: Record<string, number> = {};
      for (const k of ks) counts[k] = 0;
      for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      this.absorb(rows);
      for (const k of ks) this.ready.add(k);
      for (const k of ks) {
        try {
          await this.opts.onFirstSync?.(k, counts[k] ?? 0);
        } catch {
          /* 후처리 실패는 다음 기회에 */
        }
      }
      this.lastOkMs = this.now();
      this.lastError = null;
    });
    await this.pushKinds(ks);
  }

  /** 서버에서 바뀐 것만 받는다(2분 겹침 — 거의 동시에 저장된 줄을 놓치지 않게). */
  async pullChanges(): Promise<number> {
    const ks = this.enabledKinds().filter((k) => this.ready.has(k));
    if (ks.length === 0) return 0;
    return this.serial(async () => {
      const since = this.cursor ? new Date(Date.parse(this.cursor) - 120_000).toISOString() : null;
      const rows = await this.transport.pull(since, ks);
      const n = this.absorb(rows);
      this.lastOkMs = this.now();
      this.lastError = null;
      return n;
    }).then(async (n) => {
      // 받은 것 중 이 기기 것이 더 최신인 항목이 있으면(옛 앱이 덮었거나 동시 저장) 바로 다시 올린다.
      await this.pushKinds(ks);
      return n;
    });
  }

  /** 받은 줄들을 반영한다. 반환: 실제로 이 기기 데이터가 바뀐 항목 수. */
  private absorb(rows: SyncRow[]): number {
    const byKind = new Map<string, SyncRow[]>();
    for (const r of rows) {
      if (!this.cursor || r.updated_at > this.cursor) this.cursor = r.updated_at;
      if (!this.adapters.has(r.kind)) continue;
      const arr = byKind.get(r.kind) ?? [];
      arr.push(r);
      byKind.set(r.kind, arr);
    }
    let changed = 0;
    for (const [kind, list] of byKind) {
      const a = this.adapters.get(kind)!;
      const meta = this.metaOf(kind);
      const srv = (this.srv[kind] ??= {});
      // 첫 실행이면 이 기기 항목을 먼저 "옛 버전"으로 등록해 둔다(그래야 받은 것과 공정하게 비교된다).
      this.ensureInited(kind);
      // 아직 버전이 안 찍힌 이 기기의 수정(markDirty 없이 바뀐 것)도 먼저 찍는다 — 받은 옛 값이 방금 고친 값을 덮지 않게.
      planPush(a.list(), meta, {}, this.now(), (d, id) => a.legacyRev(d, id), !!a.newItemsLegacy);
      const present = new Set(a.list().map((x) => x.id));
      const upserts = new Map<string, unknown>();
      const deletes = new Set<string>();
      for (const r of list) {
        const ver: ItemVer = { rev: Number(r.rev), hash: r.hash ?? "", ...(r.deleted ? { del: true } : {}) };
        const prevSrv = srv[r.item_id];
        if (!prevSrv || cmpVer(ver, prevSrv) > 0) srv[r.item_id] = ver;
        if (decideRow({ rev: ver.rev, hash: ver.hash, deleted: !!r.deleted }, meta[r.item_id], present.has(r.item_id)) !== "apply") continue;
        meta[r.item_id] = ver;
        if (r.deleted) {
          upserts.delete(r.item_id);
          if (present.has(r.item_id)) deletes.add(r.item_id);
        } else {
          deletes.delete(r.item_id);
          upserts.set(r.item_id, r.payload);
        }
      }
      if (upserts.size > 0 || deletes.size > 0) {
        changed += upserts.size + deletes.size;
        try {
          a.apply([...upserts.entries()].map(([id, data]) => ({ id, data })), [...deletes]);
        } catch (e) {
          this.lastError = `받은 기록 반영 실패(${kind}): ${e instanceof Error ? e.message : String(e)}`;
        }
        // 반영 후 이 기기 내용의 지문이 받은 것과 같은지 맞춰 둔다(상한 정리 등으로 빠진 항목은 meta에서 지운다 —
        // 묘비가 아니므로 다른 기기에서 지우지 않는다).
        const after = new Map(a.list().map((x) => [x.id, x.data]));
        for (const [id] of upserts) {
          if (!after.has(id)) {
            if (meta[id] && !meta[id].del) delete meta[id];
          }
        }
      }
    }
    this.persist();
    return changed;
  }

  /** 이 기기에서 내용이 바뀐 항목에 새 버전을 찍어 둔다(올리지는 않음). */
  private stamp(kind: string): void {
    const a = this.adapters.get(kind);
    if (!a) return;
    this.ensureInited(kind);
    planPush(a.list(), this.metaOf(kind), {}, this.now(), (d, id) => a.legacyRev(d, id), !!a.newItemsLegacy);
    this.persist();
  }

  private ensureInited(kind: string): boolean {
    if (this.state.inited[kind]) return false;
    const a = this.adapters.get(kind);
    if (!a) return false;
    // 이 기기에 이미 있던 항목 → 옛 버전 번호로 등록(planPush legacy=true와 같은 규칙)
    planPush(a.list(), this.metaOf(kind), {}, this.now(), (d, id) => a.legacyRev(d, id), true);
    this.state.inited[kind] = true;
    return true;
  }

  /** 바뀐 항목을 올린다(서버와 처음 맞춘 종류만). 50개씩 나눠 보낸다. */
  async pushKinds(kinds: string[]): Promise<void> {
    await this.serial(async () => {
      for (const kind of kinds) {
        const a = this.adapters.get(kind);
        if (!a || (a.enabled && !a.enabled()) || !this.ready.has(kind)) continue;
        const legacy = this.ensureInited(kind);
        const meta = this.metaOf(kind);
        const srv = (this.srv[kind] ??= {});
        const items = a.list();
        const todo = planPush(items, meta, srv, this.now(), (d, id) => a.legacyRev(d, id), legacy || !!a.newItemsLegacy, this.opts.deviceId());
        this.persist();
        for (let i = 0; i < todo.length; i += 50) {
          const batch = todo.slice(i, i + 50);
          try {
            const accepted = new Set(await this.transport.put(kind, batch));
            for (const it of batch) {
              // 반영된 것은 서버 버전 = 내 버전. 거절된 것(서버가 더 최신)은 다음 받기에서 서버 것을 받아 온다.
              if (accepted.has(it.id)) srv[it.id] = { rev: it.rev, hash: it.hash, ...(it.deleted ? { del: true } : {}) };
            }
            this.lastOkMs = this.now();
            this.lastError = null;
          } catch (e) {
            this.lastError = `올리기 실패(${kind}): ${e instanceof Error ? e.message : String(e)}`;
            break; // 다음 기회(주기 점검·다음 변경)에 다시 — 버전은 이미 찍혀 있어 빠짐없이 올라간다
          }
        }
        // 상한이 있는 종류: 이 기기가 이미 잘라 낸 오래된 항목은 서버에서도 정리(내가 가진 가장 오래된 것보다 더 오래된 것만).
        if (a.keep && this.transport.prune && items.length >= a.keep) {
          const minSort = Math.min(...items.map((x) => x.sort).filter((x) => Number.isFinite(x) && x > 0));
          if (Number.isFinite(minSort)) await this.transport.prune(kind, minSort).catch(() => undefined);
        }
      }
    });
  }

  /** 화면 표시용 상태. */
  status(): { ready: string[]; lastOkMs: number | null; lastError: string | null; cursor: string | null } {
    return { ready: [...this.ready], lastOkMs: this.lastOkMs, lastError: this.lastError, cursor: this.cursor };
  }
}
