// =============================================================================
// lib/connection-test.ts — [v0.91.0] 튜토리얼 "연결 테스트" 결과를 쉬운 말로 풀어 주는 순수 함수
// -----------------------------------------------------------------------------
// 토스 키를 넣은 직후 "연결이 되나?"를 확인할 때, 실패 원인(키 오류 / 허용 IP / 계좌 번호 / 네트워크)을 비전공자가 바로 조치할 수 있는 문장으로 돌려준다.
//   원문(토스 응답·예외 메시지)에는 키가 들어 있지 않지만, 혹시 모를 노출을 막기 위해 결과 메시지에는 원문을 그대로 싣지 않고 분류된 안내만 쓴다.
// =============================================================================

export type ConnectionStage = "mode" | "keys" | "auth" | "ip" | "price" | "account" | "network" | "done";

export interface ConnectionTestResult {
  ok: boolean;
  stage: ConnectionStage;
  /** 사람이 읽는 한 줄 결론 */
  message: string;
  /** 사람이 할 조치(있으면) */
  action?: string;
  /** 단계별 결과(화면의 체크 애니메이션용) */
  steps: Array<{ name: string; ok: boolean }>;
}

/** 예외 메시지(원문)를 보고 어느 단계의 어떤 문제인지 분류한다. */
export function classifyTossError(raw: string): { stage: ConnectionStage; message: string; action: string } {
  const s = String(raw ?? "");
  if (/invalid_client|인증에 실패/i.test(s)) {
    return {
      stage: "auth",
      message: "토스가 이 키를 거부했습니다(키 인증 실패).",
      action: "Client ID와 Client Secret을 다시 확인해 주세요. 앞뒤 공백이 섞였거나, 토스 개발자센터에서 키를 재발급해 이전 키가 무효가 됐을 수 있습니다.",
    };
  }
  if (/IP address not allowed|허용하지 않습니다|IP\)에서/i.test(s)) {
    return {
      stage: "ip",
      message: "키는 맞지만, 이 컴퓨터의 인터넷 주소(IP)가 토스에 등록돼 있지 않아 막혔습니다.",
      action: "토스 개발자센터에서 이 키의 '허용 IP'에 지금 쓰는 컴퓨터의 공인 IP를 추가해 주세요(집 인터넷이 바뀌면 IP도 바뀔 수 있습니다).",
    };
  }
  if (/missing_account|계좌/i.test(s)) {
    return { stage: "account", message: "계좌 번호가 비어 있거나 맞지 않습니다.", action: "계좌 번호 칸을 확인하세요(보통 1번 — 계좌가 여러 개면 순서 번호)." };
  }
  if (/타임아웃|timeout|fetch failed|ENOTFOUND|ECONN|network|네트워크/i.test(s)) {
    return { stage: "network", message: "토스 서버에 연결하지 못했습니다(인터넷 문제일 수 있습니다).", action: "인터넷 연결을 확인하고 잠시 뒤 다시 시도하세요." };
  }
  return { stage: "price", message: "연결 확인 중 알 수 없는 오류가 났습니다.", action: "잠시 뒤 다시 시도하세요. 계속되면 [서버 로그] 탭의 마지막 줄을 알려 주세요." };
}

/** 단계 목록(화면 표시용). */
export const CONNECTION_STEP_NAMES = ["키 인증", "시세 조회", "계좌 조회"] as const;
