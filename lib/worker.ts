// =============================================================================
// lib/worker.ts  —  로컬 워커 루프 (설계서 아키텍처: 로컬 상시 실행)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   카일봇은 웹 서버가 아니라 "내 PC에서 계속 켜져 도는 프로그램"입니다(아키텍처 확정).
//   이 파일은 그 심장 박동에 해당하는 "틱(tick) 루프"의 최소 뼈대입니다.
//   일정 간격마다 깨어나 "지금 무슨 장이지? → 시세 확인 → 상태 갱신" 한 사이클을 돕니다.
//
// [Vercel Cron 대신 로컬 루프인 이유]
//   서버리스 크론은 정해진 시각에 잠깐 실행되고 꺼져 상태를 유지하지 못합니다.
//   자동매매는 호가·체결을 "끊김 없이" 감시해야 하므로, 상시 켜진 프로세스 안에서
//   setInterval 로 스스로 반복하는 구조가 맞습니다.
//
// [테스트하기 쉽게 만든 방법]
//   실제 시간·실제 네트워크에 의존하면 테스트가 어렵습니다. 그래서
//     - "지금 시각(now)"을 인자로 받고,
//     - 시세 조회 같은 바깥일은 deps(의존성)로 주입받습니다.
//   덕분에 목(mock) 어댑터를 꽂아 한 사이클이 제대로 도는지 검증할 수 있습니다.
// =============================================================================

import { DateTime } from "luxon";
import { getSession, type Session } from "./session";

/** 워커가 바깥세상과 소통하는 통로(주입 가능) — 테스트에선 목으로 대체 */
export interface WorkerDeps {
  /** 현재가 조회(실전에선 lib/toss.ts의 getPrice를 넣음) */
  getPrice: (symbol: string) => Promise<{ price: number }>;
}

/** 워커 설정 */
export interface WorkerConfig {
  symbol: string; // 감시할 종목
}

/** 한 틱의 결과(무슨 일을 했는지 보고) */
export interface TickResult {
  session: Session; // 그 시각의 세션
  action: "idle" | "polled"; // idle=쉼(장이 아님) / polled=시세 확인함
  symbol?: string;
  price?: number;
}

/**
 * runOneTick — 워커의 "한 박동". 지금 시각을 보고 한 사이클을 수행한다.
 *
 *   1) 지금이 어떤 세션인지 확인(getSession).
 *   2) 데이마켓('day')이 아니면 아무것도 안 하고 쉰다(idle) — 불필요한 호출/위험 방지.
 *   3) 데이마켓이면 시세를 폴링해 상태를 갱신할 준비를 한다(polled).
 *
 * [지금은 뼈대] 실제로는 여기서 스캔 시각/주문 시각 도달 여부(getScanTime 등)를 보고
 *   주문 생성·정정·청산을 호출하게 됩니다. S4에서는 "루프가 돈다"는 골격만 세웁니다.
 */
export async function runOneTick(now: DateTime, cfg: WorkerConfig, deps: WorkerDeps): Promise<TickResult> {
  const session = getSession(now);

  // 데이마켓이 아니면 쉰다. (프리/정규/애프터 매매 여부는 설계서상 아직 미확정 → TODO)
  if (session !== "day") {
    return { session, action: "idle" };
  }

  // 데이마켓이면 시세를 확인한다. (실전에선 여기서 호가 감시·주문 타이밍 판단으로 확장)
  const { price } = await deps.getPrice(cfg.symbol);

  // TODO(다음 단계): 스캔/1차/2차 주문 시각 도달 판단 → 주문 생성,
  //   청산 데드라인 도달 → 미체결 취소 및 청산, risk_state 확인 등.
  return { session, action: "polled", symbol: cfg.symbol, price };
}

/**
 * startWorker — 워커를 "상시 실행"으로 켠다. intervalMs 마다 runOneTick 을 반복.
 *
 * [왜 setInterval 인가?] 이게 바로 "로컬 상시 실행"의 실체입니다. 프로그램이 켜져 있는
 *   한 지정 간격으로 스스로 깨어나 틱을 돕니다(서버 요청이 없어도 동작).
 *
 * @returns stop() 함수 — 호출하면 루프를 멈춘다(프로그램 종료·킬스위치 등에서 사용).
 */
export function startWorker(cfg: WorkerConfig, deps: WorkerDeps, intervalMs: number, onTick?: (r: TickResult) => void) {
  const timer = setInterval(async () => {
    try {
      const result = await runOneTick(DateTime.now(), cfg, deps);
      onTick?.(result);
    } catch (err) {
      // 한 틱이 실패해도 루프 자체는 죽지 않게 감싼다(안전장치: 봇이 계속 살아있어야 함).
      // TODO(다음 단계): 실패를 로깅/알림하고, 연속 실패 시 halted 처리와 연동.
      console.error("[worker] 틱 실행 중 오류:", err);
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
