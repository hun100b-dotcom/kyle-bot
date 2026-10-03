// =============================================================================
// lib/fetch-timeout.ts — 제한 시간 안에 응답이 없으면 끊는 fetch (공용 헬퍼)
// -----------------------------------------------------------------------------
// [왜 필요한가 — ③ 전수조사 "높음-1"]
//   lib/toss.ts는 처음부터 모든 토스 API 호출에 이 패턴(AbortController, 기본 10초)을
//   썼는데, electron/tool-engine.ts의 Supabase REST 호출(로그인·키/매매이력 동기화·
//   capri_commands·capri_desktop_heartbeat·capri_live_state 등, 33곳 이상)은 그냥
//   맨 fetch를 썼다 — 네트워크가 "살아있지만 응답이 없는" 상태에 걸리면 기본 fetch는
//   OS 수준 타임아웃(수 분 이상)까지 매달릴 수 있고, 그동안 그 사이클은 아무 오류 없이
//   "조용히 멈춘 것처럼" 보인다. 오너가 반복 보고한 "눌러도 무반응" 류 증상의 후보
//   원인이었다 — 토스 쪽은 이미 안전했으니, 같은 안전장치를 Supabase 쪽에도 공용
//   헬퍼로 일괄 적용한다(토스·Supabase 양쪽이 이제 같은 함수를 쓴다 — 로직 중복 없음).
// =============================================================================

/**
 * [v0.62.1 — 자동매매 리포트의 "오류 로그 요약"용] 프로세스 전체 네트워크 오류 카운터.
 *   fetchWithTimeout가 타임아웃·네트워크 실패를 셀 수 있는 유일한 공통 지점이고, 재시도는
 *   토스 호출부(lib/toss.ts)가 recordApiRetry()로 센다. 자동매매 한 번의 실행(run)은 시작 때
 *   이 값을 기준점으로 저장하고 끝날 때 차이만 가져가 "그 실행 동안의 횟수"를 얻는다.
 */
export const netStats = { timeouts: 0, failures: 0, retries: 0 };
export function recordApiRetry(): void {
  netStats.retries++;
}

/** 제한 시간 안에 응답이 없으면 요청을 끊는 fetch(봇이 한 요청에 매달려 멈추지 않게). */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      netStats.timeouts++;
      throw new Error(`요청 타임아웃(${timeoutMs}ms 초과): ${label}`);
    }
    netStats.failures++; // 타임아웃이 아닌 네트워크 실패(연결 거부·DNS 등)
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
