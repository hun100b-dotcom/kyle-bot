// =============================================================================
// lib/worker.ts  —  로컬 워커 루프 (설계서 아키텍처: 로컬 상시 실행)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   카일봇은 "내 PC에서 계속 켜져 도는 프로그램"입니다(웹 서버 아님).
//   이 파일은 그 심장 박동에 해당하는 "틱(tick) 루프"입니다. 일정 간격마다 깨어나
//   "지금 데이마켓인가? → 맞으면 활성 세션들을 한 걸음씩 전진(체결확인·익절·손절·청산)"
//   시킵니다. 실제 전진 로직은 lib/lifecycle.ts(advanceSession)가 담당하고,
//   여기서는 "언제·무엇을 전진시킬지" 조율만 합니다.
//
// [Vercel Cron 대신 로컬 루프인 이유]
//   서버리스 크론은 정해진 시각에 잠깐 실행되고 꺼져 상태를 유지하지 못합니다.
//   자동매매는 호가·체결을 끊김 없이 감시해야 하므로, 상시 켜진 프로세스 안에서
//   setInterval 로 스스로 반복하는 구조가 맞습니다.
//
// [한 세션이 실패해도 루프는 안 죽는다]
//   세션 하나를 전진시키다 오류가 나도(네트워크 등), try/catch로 감싸 다음 세션으로
//   넘어갑니다. 봇 전체가 한 세션 때문에 멈추면 안 되기 때문입니다(안전장치).
//
// [테스트하기 쉽게 만든 방법]
//   "지금 시각(now)"과 "세션 전진 함수(advance)"를 주입받습니다. 덕분에 실제 시간·
//   네트워크 없이 루프의 조율 동작(전진/쉼/부분실패)을 검증할 수 있습니다.
// =============================================================================

import { DateTime } from "luxon";
import { getSession, type Session } from "./session";
import type { SessionRuntime } from "./lifecycle";

/** 워커가 바깥세상과 소통하는 통로(주입 가능) */
export interface WorkerDeps {
  /** 지금 살아있는(전진시킬) 세션 목록을 돌려준다. */
  getActiveSessions: () => SessionRuntime[];
  /** 세션 하나를 한 걸음 전진시킨다(실전에선 (rt,now)=>advanceSession(rt, lifecycleDeps, now)). */
  advance: (rt: SessionRuntime, now: DateTime) => Promise<void>;
  /** 로그(선택) */
  log?: (msg: string, data?: unknown) => void;
}

/** 한 틱의 결과(무슨 일을 했는지 보고) */
export interface TickResult {
  session: Session; // 그 시각의 세션
  action: "idle" | "advanced"; // idle=쉼(장이 아니거나 세션 없음) / advanced=세션 전진함
  advanced: number; // 전진에 성공한 세션 수
  errors: number; // 전진 중 실패한 세션 수(루프는 계속됨)
}

/**
 * runOneTick — 워커의 "한 박동". 지금 시각을 보고 활성 세션들을 전진시킨다.
 *
 *   1) 지금이 데이마켓('day')이 아니면 아무것도 안 하고 쉰다(idle).
 *   2) 데이마켓이면 활성 세션(닫히지 않은)들을 하나씩 advance로 전진.
 *      각 세션은 try/catch로 감싸, 하나가 실패해도 나머지는 계속 전진.
 */
export async function runOneTick(now: DateTime, deps: WorkerDeps): Promise<TickResult> {
  const session = getSession(now);

  // 데이마켓이 아니면 쉰다. (프리/정규/애프터 매매 여부는 설계서상 미확정 → TODO)
  if (session !== "day") {
    return { session, action: "idle", advanced: 0, errors: 0 };
  }

  const sessions = deps.getActiveSessions().filter((s) => s.status !== "closed");
  let advanced = 0;
  let errors = 0;

  for (const rt of sessions) {
    try {
      await deps.advance(rt, now);
      advanced += 1;
    } catch (err) {
      // 한 세션 실패가 전체 루프를 죽이지 않게 격리한다.
      errors += 1;
      deps.log?.("[worker] 세션 전진 실패(다음 세션 계속)", { sessionId: rt.id, error: String(err) });
    }
  }

  return { session, action: advanced > 0 ? "advanced" : "idle", advanced, errors };
}

/**
 * startWorker — 워커를 "상시 실행"으로 켠다. intervalMs 마다 runOneTick 을 반복.
 *   [왜 setInterval?] 이게 "로컬 상시 실행"의 실체입니다. 프로그램이 켜져 있는 한
 *   지정 간격으로 스스로 깨어나 틱을 돕니다(외부 요청이 없어도 동작).
 *
 * @returns stop() — 루프를 멈춘다(프로그램 종료·킬스위치 등에서 사용).
 */
export function startWorker(deps: WorkerDeps, intervalMs: number, onTick?: (r: TickResult) => void) {
  const timer = setInterval(async () => {
    try {
      const result = await runOneTick(DateTime.now(), deps);
      onTick?.(result);
    } catch (err) {
      // runOneTick 자체가 죽는 극단적 경우에도 루프는 살려둔다.
      deps.log?.("[worker] 틱 실행 중 오류", { error: String(err) });
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
