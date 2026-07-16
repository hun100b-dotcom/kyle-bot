// =============================================================================
// electron/file-store.ts  —  파일 기반 저장소 (Store 인터페이스의 로컬 구현)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   봇의 "행동 대장"(lib/lifecycle.ts)은 기록을 남길 때 Store 라는 창구(인터페이스)만
//   사용합니다. 지금까지 테스트/데모는 "인메모리(메모리에만 저장 → 끄면 사라짐)"를
//   썼는데, 데스크톱 앱에서는 프로그램을 껐다 켜도 매매일지가 남아야 합니다.
//
//   이 파일은 그 창구를 "JSON 파일 저장"으로 구현한 것입니다.
//   - 저장 위치: 앱 데이터 폴더(macOS 기준 ~/Library/Application Support/카일봇/)
//   - 저장 내용: 세션 스냅샷 / 주문 기록 / 매매일지 / 일일 리스크 상태
//
// [왜 Supabase(클라우드 DB)가 아니라 파일인가?]
//   progress.md 남은 일 2번 "Supabase 실연결"은 별도 단계입니다. 파일 저장소는
//   네트워크·계정 없이도 즉시 동작하고, 나중에 SupabaseStore 로 갈아끼워도
//   lifecycle 코드는 한 줄도 안 바뀝니다(인터페이스로 분리해 둔 덕분).
//
// [왜 매번 통째로 다시 쓰나?]
//   기록량이 하루 수십 건 수준이라 성능 문제가 없고, "쓰다 만 파일"이 생기지 않도록
//   임시 파일에 쓴 뒤 이름을 바꾸는(원자적 교체) 가장 단순·안전한 방식을 골랐습니다.
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store, SessionRuntime, OrderRecord, TradeLogRecord } from "../lib/lifecycle";
import type { RiskState } from "../lib/risk";

/** 디스크에 저장되는 전체 데이터 모양 */
interface FileData {
  /** 세션 스냅샷(id → 마지막 상태). 대시보드 표시·기록용 */
  sessions: Record<string, SessionRuntime>;
  /** 주문 기록(시간순 누적) */
  orders: OrderRecord[];
  /** 매매일지(시간순 누적) — 승률·손익 계산의 재료 */
  tradeLogs: TradeLogRecord[];
  /** 일일 리스크 상태(거래일 → 상태). 일일 손실한도·연속손절 등의 재료 */
  riskStates: Record<string, RiskState>;
}

/** 비어 있는 초기 데이터 */
function emptyData(): FileData {
  return { sessions: {}, orders: [], tradeLogs: [], riskStates: {} };
}

export class FileStore implements Store {
  private filePath: string;
  private data: FileData;

  /**
   * @param dir 저장 폴더(앱 데이터 폴더). 없으면 만든다.
   */
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "kylebot-data.json");
    // 기존 파일이 있으면 읽어서 이어가고, 없거나 깨졌으면 새로 시작.
    // [왜 try/catch?] 파일이 손상돼도 앱이 못 켜지는 사태를 막기 위해서(안전 우선).
    try {
      this.data = existsSync(this.filePath)
        ? { ...emptyData(), ...JSON.parse(readFileSync(this.filePath, "utf8")) }
        : emptyData();
    } catch {
      this.data = emptyData();
    }
  }

  /** 디스크에 원자적으로 저장: 임시 파일에 다 쓴 뒤 → 본 파일로 이름 교체 */
  private persist(): void {
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  // --- Store 인터페이스 구현 (lifecycle 이 호출하는 함수들) ---

  async saveSession(rt: SessionRuntime): Promise<void> {
    // structuredClone: 런타임 객체를 그대로 참조하면 이후 변경이 몰래 반영되므로 복사본 저장.
    this.data.sessions[rt.id] = structuredClone(rt);
    this.persist();
  }

  async saveOrder(o: OrderRecord): Promise<void> {
    this.data.orders.push(o);
    this.persist();
  }

  async appendTradeLog(l: TradeLogRecord): Promise<void> {
    this.data.tradeLogs.push(l);
    this.persist();
  }

  async getRiskState(tradeDate: string): Promise<RiskState> {
    // 그날 기록이 없으면 "깨끗한 하루"로 시작(손익 0, 주문 0, 정지 아님).
    if (!this.data.riskStates[tradeDate]) {
      this.data.riskStates[tradeDate] = {
        trade_date: tradeDate,
        realized_pnl_pct: 0,
        order_count: 0,
        consecutive_losses: 0,
        halted: false,
        halt_reason: null,
      };
      this.persist();
    }
    return this.data.riskStates[tradeDate];
  }

  async updateRiskState(tradeDate: string, apply: (s: RiskState) => RiskState): Promise<void> {
    this.data.riskStates[tradeDate] = apply(await this.getRiskState(tradeDate));
    this.persist();
  }

  // --- 대시보드가 읽어 가는 조회 함수들(Store 인터페이스 외 추가 제공) ---

  /** 매매일지 전체(최신이 뒤) */
  getTradeLogs(): TradeLogRecord[] {
    return this.data.tradeLogs;
  }

  /** 주문 기록 전체 */
  getOrders(): OrderRecord[] {
    return this.data.orders;
  }

  /** 특정 거래일의 리스크 상태(없으면 undefined) — 대시보드 표시용 */
  peekRiskState(tradeDate: string): RiskState | undefined {
    return this.data.riskStates[tradeDate];
  }
}
