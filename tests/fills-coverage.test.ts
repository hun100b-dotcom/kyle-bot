// =============================================================================
// tests/fills-coverage.test.ts — 기간 리포트 정확도: "얼마나 깊이 가져왔나" (v0.10.1)
// -----------------------------------------------------------------------------
// [배경 — 실제로 겪은 부정확]
//   토스 '종료된 주문'을 8페이지(약 160건)에서 무조건 끊는 바람에, 매매가 잦으면
//   "최근 30일"을 눌러도 30일치가 그 안에 안 들어와 **옛 매매가 조용히 빠졌다.**
//   게다가 "오늘"(얕게)을 캐시한 뒤 "1개월"(깊게)을 누르면 얕은 캐시를 재사용해 또 잘렸다.
//
//   collectFills(엔진 내부, 네트워크 포함)에서 정확도를 좌우하는 두 판단을
//   순수 함수(coveredSince/cacheCovers)로 빼내 여기서 못 박는다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { coveredSince, cacheCovers, shouldReuseCache, type FillsCacheMeta } from "../lib/fills";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 20, 1); // 2026-08-20 (기준 시각, 값 자체는 중요치 않음)

describe("coveredSince — 이번 수집이 어느 시각까지 확실히 커버했나", () => {
  it("끝까지 다 받았으면(reachedEnd) 전 구간 커버 = -Infinity", () => {
    const c = coveredSince({ reachedEnd: true, reachedTarget: false, sinceMs: NOW - 30 * DAY, oldestSeenMs: NOW - 5 * DAY });
    expect(c).toBe(-Infinity);
  });

  it("목표 깊이에 도달했으면(reachedTarget) 요청한 sinceMs 까지 커버", () => {
    const since = NOW - 30 * DAY;
    const c = coveredSince({ reachedEnd: false, reachedTarget: true, sinceMs: since, oldestSeenMs: since - DAY });
    expect(c).toBe(since);
  });

  it("상한에 걸려 중간에 끊겼으면(둘 다 false) 실제로 본 가장 오래된 시각까지만", () => {
    const oldest = NOW - 12 * DAY; // 30일을 요청했지만 12일치에서 상한에 걸림
    const c = coveredSince({ reachedEnd: false, reachedTarget: false, sinceMs: NOW - 30 * DAY, oldestSeenMs: oldest });
    expect(c).toBe(oldest); // 12일까지만 확실 → 캐시가 얕다고 정직하게 표시
  });

  it("한 건도 못 봤으면(+Infinity) 커버 0 = +Infinity(어떤 요청도 재수집)", () => {
    const c = coveredSince({ reachedEnd: false, reachedTarget: false, sinceMs: NOW - 30 * DAY, oldestSeenMs: Number.POSITIVE_INFINITY });
    expect(c).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("cacheCovers — 저장된 캐시가 이번 요청을 감당하나", () => {
  it("같은 깊이면 재사용 가능", () => {
    const covered = NOW - 30 * DAY;
    expect(cacheCovers(covered, NOW - 30 * DAY)).toBe(true);
  });

  it("캐시가 더 깊으면(더 과거까지) 얕은 요청은 당연히 재사용 가능", () => {
    const covered = NOW - 74 * DAY; // 캐시는 74일까지 있다
    expect(cacheCovers(covered, NOW - 45 * DAY)).toBe(true); // 45일만 필요 → OK
  });

  it("★핵심 회귀: '오늘'(얕은 캐시) 뒤 '1개월'(깊은 요청)은 재수집해야 한다", () => {
    // 오늘 리포트가 45일까지만 커버해 캐시됨
    const coveredByToday = NOW - 45 * DAY;
    // 1개월 리포트는 74일(30일 창 + 45일 매칭 버퍼)이 필요
    const monthNeeds = NOW - 74 * DAY;
    expect(cacheCovers(coveredByToday, monthNeeds)).toBe(false); // 얕은 캐시 재사용 금지 → 재수집
  });

  it("전 구간 캐시(-Infinity)는 어떤 요청도 감당한다", () => {
    expect(cacheCovers(-Infinity, NOW - 365 * DAY)).toBe(true);
  });

  it("캐시가 아무것도 못 담았으면(+Infinity) 어떤 요청도 재수집", () => {
    expect(cacheCovers(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });
});

describe("shouldReuseCache — 60초 캐시를 이번 요청에 써도 되나 (A/B 리뷰가 잡은 회귀 방지)", () => {
  const cache = (over: Partial<FillsCacheMeta>): FillsCacheMeta => ({ atMs: NOW, coveredSinceMs: NOW - 45 * DAY, canDeepen: true, ...over });

  it("캐시가 없으면 재사용 불가", () => {
    expect(shouldReuseCache(null, NOW - 45 * DAY, NOW)).toBe(false);
  });

  it("TTL(60초) 지난 캐시는 재사용 안 함", () => {
    expect(shouldReuseCache(cache({ atMs: NOW - 61_000 }), NOW - 45 * DAY, NOW)).toBe(false);
  });

  it("캐시가 요청 깊이를 이미 덮으면 재사용(당연)", () => {
    // 캐시는 45일까지, 요청은 30일만 필요 → 재사용
    expect(shouldReuseCache(cache({ coveredSinceMs: NOW - 45 * DAY, canDeepen: true }), NOW - 30 * DAY, NOW)).toBe(true);
  });

  it("★정상 심화: 얕게 '일찍 멈춘' 캐시(canDeepen)에 더 깊은 요청 → 재조회", () => {
    // 오늘(45일, reachedTarget=일찍멈춤) 캐시 뒤 1개월(74일) 요청 → 더 얻을 수 있으니 재조회
    expect(shouldReuseCache(cache({ coveredSinceMs: NOW - 45 * DAY, canDeepen: true }), NOW - 74 * DAY, NOW)).toBe(false);
  });

  it("★핵심 회귀#1: 상한에 걸린 캐시(canDeepen=false)엔 더 깊은 요청이 와도 재사용(429 폭풍 방지)", () => {
    // 잦은 매매자: 상한에 걸려 26일까지만 담김. 74일이 필요해도 재조회하면 또 상한 → 낭비 → 재사용
    expect(shouldReuseCache(cache({ coveredSinceMs: NOW - 26 * DAY, canDeepen: false }), NOW - 74 * DAY, NOW)).toBe(true);
  });

  it("★핵심 회귀#3: 조회 실패 캐시(+Infinity·canDeepen=false)도 TTL 안엔 재사용(오프라인 난타 방지)", () => {
    // 실패 캐시는 covered=+Infinity(아무것도 못 덮음)라 needDeeper=true지만 canDeepen=false → 재사용(두드리지 않음)
    expect(shouldReuseCache(cache({ coveredSinceMs: Number.POSITIVE_INFINITY, canDeepen: false }), NOW - 45 * DAY, NOW)).toBe(true);
  });

  it("끝까지 받은 캐시(-Infinity)는 어떤 요청도 재사용", () => {
    expect(shouldReuseCache(cache({ coveredSinceMs: -Infinity, canDeepen: false }), NOW - 365 * DAY, NOW)).toBe(true);
  });
});
