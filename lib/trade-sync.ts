// =============================================================================
// lib/trade-sync.ts — 매매 이력을 '암호화해서' 기기 간에 옮기는 규칙 (순수 계산)
// -----------------------------------------------------------------------------
// [무엇을 푸는가 — 사장님 상황]
//   회사에서 폰으로 리포트를 보고 싶은데, 매매 이력은 집 PC에만 쌓여 있습니다.
//   집 PC가 꺼져 있으면(또는 접속 주소가 바뀌면) 폰은 아무것도 볼 수 없었습니다.
//
//   그래서 집 PC가 **매매 이력을 자물쇠로 잠가(암호화)** 인터넷 보관함에 올려 두고,
//   폰은 그 파일을 받아 **같은 비밀번호로 풀어** 리포트를 그립니다.
//   → PC가 꺼져 있어도, 어디에 있어도, 리포트가 보입니다.
//
// [무엇을 올리고 무엇은 절대 안 올리나 — 중요]
//   올리는 것  : 종목·방향(매수/매도)·수량·체결가·수수료/세금·체결시각  (= 매매 결과뿐)
//   안 올리는 것: **토스 API 키, 액세스 토큰, 계좌번호, 비밀번호, 이름 등 신원 정보**
//   게다가 전부 암호문이라, 비밀번호가 없으면 아무 의미 없는 글자 뭉치입니다.
//
// [파일 이름도 비밀]
//   파일 이름을 비밀번호에서 만들어(deriveSyncId) 어떤 파일이 사장님 것인지조차 알 수 없습니다.
// =============================================================================

import type { Fill } from "./fills";

/** 동기화 파일에 담기는 내용(이 안에는 매매 결과만 있다) */
export interface TradeSyncPayload {
  v: 1; //             형식 버전(나중에 바꿔도 옛 파일을 읽을 수 있게)
  pushedAtMs: number; // 올린 시각
  fills: Fill[]; //     체결 목록(매매 결과)
}

/**
 * toSyncPayload — 저장된 체결에서 **올려도 되는 항목만** 골라 담는다.
 *
 *   [왜 굳이 다시 만드나?] 나중에 체결 기록에 다른 정보가 붙더라도
 *   여기서 고른 항목만 나가므로, 실수로 민감한 값이 함께 올라가는 일을 막는다.
 */
export function toSyncPayload(fills: Fill[], nowMs: number): TradeSyncPayload {
  return {
    v: 1,
    pushedAtMs: nowMs,
    fills: fills.map((f) => ({
      symbol: f.symbol,
      side: f.side,
      qty: f.qty,
      price: f.price,
      atMs: f.atMs,
      commission: f.commission,
      tax: f.tax,
      currency: f.currency,
    })),
  };
}

/** 받은 파일이 올바른 모양인지 확인한다(깨진 파일로 화면이 망가지지 않게). */
export function isSyncPayload(v: unknown): v is TradeSyncPayload {
  const o = v as TradeSyncPayload | null;
  return !!o && o.v === 1 && Array.isArray(o.fills) && typeof o.pushedAtMs === "number";
}

/** 동기화 파일이 올라가는 공개 저장소(암호문만 올라간다) */
export const SYNC_REPO = { owner: "hun100b-dotcom", repo: "capri-sync", branch: "main" };

/** 저장소 안에서의 파일 경로 — 이름은 비밀번호에서 만든 식별자다. */
export function syncPath(syncId: string): string {
  return `t/${syncId}.json`;
}

/**
 * syncReadUrl — 폰이 파일을 받아 갈 주소.
 *   raw.githubusercontent.com 은 어떤 사이트에서도 읽을 수 있게 열려 있어(CORS) 폰에서 바로 받아진다.
 *   `cb`(캐시 무력화)를 붙여 방금 올린 최신본을 받도록 한다.
 */
export function syncReadUrl(syncId: string, cacheBust = true): string {
  const base = `https://raw.githubusercontent.com/${SYNC_REPO.owner}/${SYNC_REPO.repo}/${SYNC_REPO.branch}/${syncPath(syncId)}`;
  return cacheBust ? `${base}?cb=${Date.now()}` : base;
}
