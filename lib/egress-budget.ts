// =============================================================================
// lib/egress-budget.ts — Supabase 하루 내려받기(egress) 예산 계산기 (순수 로직, 테스트 가능)
// -----------------------------------------------------------------------------
// [왜 필요한가 — 2026-11-01 사고]
//   Supabase 무료 플랜은 한 달에 5GB(하루 약 160MB)까지만 서버→앱 전송을 허용한다. 넘으면 로그인까지
//   전부 막힌다(HTTP 402). v0.108/109 실시간 동기화가 이 한도를 10/22~27에 하루 6~11GB로 넘겼다.
//   그래서 앱이 "오늘 내가 얼마나 받았나"를 스스로 세고, 예산에 가까워지면 폴링 간격을 자동으로
//   늘려(멈추지는 않는다) 한도를 넘지 않게 한다.
//
// [예산 산정] 월 5GB ÷ 30일 ≈ 166MB/일. 기기 수 10대(PC 3 + 폰 + 팀원 등)까지 가정하면 기기당 약 16MB/일.
//   여유를 두어 기기당 하루 12MB를 기본 예산으로 쓴다(12MB × 10대 × 30일 = 3.6GB < 5GB).
// =============================================================================

/** 기기당 하루 기본 예산(바이트). */
export const DAILY_EGRESS_BUDGET_BYTES = 12 * 1024 * 1024;

/** 응답 크기를 알 수 없을 때(content-length 없음) 쓰는 어림값 — 헤더 포함 대략. */
export const UNKNOWN_RESPONSE_BYTES = 2 * 1024;

/** 요청마다 붙는 헤더 등 고정 비용 어림값. */
export const REQUEST_OVERHEAD_BYTES = 400;

export class EgressBudget {
  private dayKey = "";
  private bytes = 0;
  private requests = 0;
  private counters: Record<string, number> = {};

  constructor(private readonly budgetBytes: number = DAILY_EGRESS_BUDGET_BYTES) {}

  private roll(now: number): void {
    const d = new Date(now);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.bytes = 0;
      this.requests = 0;
      this.counters = {};
    }
  }

  /** 응답 하나를 센다. contentLength가 null이면 어림값을 쓴다. */
  record(contentLength: number | null, now: number = Date.now()): void {
    this.roll(now);
    const n = contentLength != null && Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : UNKNOWN_RESPONSE_BYTES;
    this.bytes += n + REQUEST_OVERHEAD_BYTES;
    this.requests += 1;
  }

  /** 오늘 쓴 비율(0~). */
  fraction(now: number = Date.now()): number {
    this.roll(now);
    return this.bytes / this.budgetBytes;
  }

  /**
   * 폴링을 몇 번에 한 번만 실행할지(배수). 예산의 50%까지는 정상(1), 이후 단계적으로 늘리고
   * 100%를 넘어도 완전히 멈추지는 않는다(8번에 1번) — 로그인·명령이 영영 안 되는 것보다 낫다.
   */
  multiplier(now: number = Date.now()): number {
    const f = this.fraction(now);
    if (f < 0.5) return 1;
    if (f < 0.75) return 2;
    if (f < 1) return 4;
    return 8;
  }

  /** 이름별 틱 카운터로 "이번 틱을 건너뛸지" 판단한다. true면 실행해도 된다. */
  shouldRun(key: string, now: number = Date.now()): boolean {
    this.roll(now);
    const m = this.multiplier(now);
    const c = (this.counters[key] ?? 0) + 1;
    if (c >= m) {
      this.counters[key] = 0;
      return true;
    }
    this.counters[key] = c;
    return false;
  }

  /** 화면·로그용 요약. */
  snapshot(now: number = Date.now()): { bytes: number; requests: number; fraction: number; multiplier: number; budgetBytes: number } {
    this.roll(now);
    return { bytes: this.bytes, requests: this.requests, fraction: this.fraction(now), multiplier: this.multiplier(now), budgetBytes: this.budgetBytes };
  }
}

/** 프로세스 전체에서 공유하는 인스턴스(fetchWithTimeout이 기록하고 폴링 루프가 읽는다). */
export const egressBudget = new EgressBudget();
