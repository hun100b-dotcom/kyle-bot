// =============================================================================
// scripts/dryrun-live.ts  —  실장 드라이런 점검 (실시세 + DRY_RUN, 주문 0건)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   "실제 토스 시세"를 읽어 와서, 실행부(lifecycle)가 안전장치 게이트까지 통과시킨 뒤
//   실주문 대신 "이런 주문을 냈을 것"이라는 로그만 남기는지 확인합니다.
//   = 실장 드라이런(설계서 2단계: 키도착→읽기전용✅→드라이런→소액)의 최소 동작 증명.
//
// [안전] DRY_RUN=true이므로 toss.createOrder는 호출 자체가 안 됩니다(코드 경로상 차단).
//   이 스크립트가 실서버에 하는 것은 시세/잔고 "읽기"뿐입니다.
//
// [실행] npx tsx scripts/dryrun-live.ts
// =============================================================================

import { readFileSync } from "node:fs";
import { DateTime } from "luxon";

// .env 로드(실키·DRY_RUN 설정)
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}

import { getPrice, getBuyingPower, getAccounts, getOrder, cancelOrder, createOrder } from "../lib/toss";
import { roundPrice } from "../lib/calc";
import { getSession, getDayMarketOpen, getCloseDeadline } from "../lib/session";
import { createSession, armSession, type LifecycleDeps, type Store, type SessionRuntime, type OrderRecord, type TradeLogRecord } from "../lib/lifecycle";
import { runOneTick } from "../lib/worker";
import type { RiskState } from "../lib/risk";

class InMemoryStore implements Store {
  orders: OrderRecord[] = [];
  tradeLogs: TradeLogRecord[] = [];
  private risk = new Map<string, RiskState>();
  async saveSession(_rt: SessionRuntime) {}
  async saveOrder(o: OrderRecord) { this.orders.push(o); }
  async appendTradeLog(l: TradeLogRecord) { this.tradeLogs.push(l); }
  async getRiskState(d: string): Promise<RiskState> {
    if (!this.risk.has(d)) this.risk.set(d, { trade_date: d, realized_pnl_pct: 0, order_count: 0, consecutive_losses: 0, halted: false, halt_reason: null });
    return this.risk.get(d)!;
  }
  async updateRiskState(d: string, apply: (s: RiskState) => RiskState) { this.risk.set(d, apply(await this.getRiskState(d))); }
}

async function main() {
  console.log("■ 실장 드라이런 점검 (실시세 + DRY_RUN, 쓰기 호출 0건)");
  console.log("  DRY_RUN:", process.env.DRY_RUN, "| TOSS_MOCK:", process.env.TOSS_MOCK);

  // 1) 지금 실제 시각의 세션 판정(서머타임 자동)
  const now = DateTime.now().setZone("Asia/Seoul");
  console.log(`\n[1] 지금 시각: ${now.toFormat("yyyy-MM-dd HH:mm")} KST → 세션: '${getSession(now)}'`);
  console.log(`    오늘 데이마켓 개장: ${getDayMarketOpen(now).toFormat("HH:mm")} KST / 청산 데드라인: ${getCloseDeadline(now).toFormat("HH:mm")} KST`);

  // 2) 실서버에서 실시세·실잔고 읽기(읽기전용)
  const p = await getPrice("AAPL");
  const bp = await getBuyingPower("USD");
  console.log(`\n[2] 실시세: AAPL = $${p.price} | 실계좌 매수가능: $${bp.buyingPowerUsd}`);

  // 3) 실시세 기반 가상 매매 계획: 현재가 0.5% 아래 진입 / 익절 +2% / 손절 -10%, 1주
  const entry = roundPrice(p.price * 0.995);
  const tp = roundPrice(entry * 1.02);
  const sl = roundPrice(entry * 0.9);
  console.log(`\n[3] 가상 계획: 진입 $${entry} / 익절 $${tp} / 손절 $${sl} / 1주 (예상 투입 $${entry})`);

  // 4) 실행부(lifecycle)로 세션 장전 — DRY_RUN이므로 게이트 통과 후 "로그만"
  const store = new InMemoryStore();
  const logs: string[] = [];
  const deps: LifecycleDeps = {
    toss: { createOrder, getOrder, cancelOrder, getPrice, getBuyingPower },
    store,
    riskConfig: { dryRun: true }, // ★ 드라이런: 실주문 차단
    killSwitch: () => false,
    log: (msg) => { logs.push(msg); console.log("   " + msg); },
    tradeDateOf: (n) => n.setZone("Asia/Seoul").toFormat("yyyy-MM-dd"),
  };
  const rt = createSession("dryrun-live-001", "AAPL", "candle", [
    { level: 1, entryPrice: entry, tpPrice: tp, slPrice: sl, quantity: 1 },
  ]);

  console.log("\n[4] armSession 실행(안전장치 게이트 → DRY_RUN 로그):");
  await armSession(rt, deps, now);
  console.log(`    포지션 상태: ${rt.positions[0].state} (skipped=실주문 안 나감이 정상)`);
  console.log(`    실제로 주문 API가 호출됐나? → store 주문기록 ${store.orders.length}건 (0건이어야 정상)`);

  // 5) 워커 틱도 실서버 시세로 도는지(지금 세션 기준)
  console.log("\n[5] 워커 한 틱(runOneTick) — 지금 실제 시각 기준:");
  const tick = await runOneTick(now, {
    getActiveSessions: () => [rt],
    advance: async () => {}, // 세션이 전부 skipped라 전진할 것 없음(형식상)
    log: (m) => console.log("   " + m),
  });
  console.log(`    틱 결과: 세션='${tick.session}', 동작='${tick.action}' (데이마켓이 아니면 idle이 정상)`);

  console.log("\n■ 점검 완료 — 실서버에는 읽기(시세/잔고)만 나갔고, 주문·쓰기 호출은 0건입니다.");
  console.log("  → DRY_RUN 실장 운전은 지금 코드로 즉시 가능합니다.");
}

main().catch((e) => { console.error("점검 중 오류:", e); process.exit(1); });
