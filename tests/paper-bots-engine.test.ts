// =============================================================================
// tests/paper-bots-engine.test.ts — [v0.103.0] 가상매매 봇 엔진 연동
//   추가·설정·시작/중지·복제·손절 세트·초기화·삭제 + 재시작 후 복원 + 한 주기(tick)가 실제로
//   스크리닝 → 가상 매수 → 체결 → 손절까지 흘러가는지. 주문 API는 한 번도 불리지 않아야 한다.
// =============================================================================
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Settings } from "luxon";
import { ToolEngine } from "../electron/tool-engine";

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => {
  Settings.now = () => Date.now();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkEngine(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "paper-"));
  if (!dir) dirs.push(d);
  return { e: new ToolEngine(d, { forceMock: true }), dir: d };
}

describe("가상매매 봇 — 엔진", () => {
  it("추가·설정·시작/중지·복제·손절 세트·초기화·삭제, 그리고 재시작 후 그대로 복원", async () => {
    const { e, dir } = mkEngine();
    let v = await e.paperBotAdd({ name: "기준봇", seedUsd: 5000, tpPct: 2, slPct: 10 });
    expect(v.bots.length).toBe(1);
    const id = v.bots[0].id;
    expect(v.bots[0].config.seedUsd).toBe(5000);
    expect(v.bots[0].config.running).toBe(false);

    v = await e.paperBotUpdate(id, { slPct: 6, running: true } as never);
    expect(v.bots[0].config.slPct).toBe(6);
    expect(v.bots[0].config.running).toBe(false); // 설정 저장으로는 켜지지 않는다(시작 버튼으로만)

    v = await e.paperBotStart(id);
    expect(v.bots[0].config.running).toBe(true);
    expect(v.bots[0].config.runnerDeviceId).toBeNull(); // 루프를 안 켠 기기(=폰과 같은 처지)에서 켬 → PC가 가져갈 몫
    v = await e.paperBotStop(id);
    expect(v.bots[0].config.running).toBe(false);

    v = await e.paperBotDuplicate(id);
    expect(v.bots.length).toBe(2);
    v = await e.paperBotAddSlSet(id, [3, 5]);
    expect(v.bots.map((b) => b.config.slPct)).toEqual([6, 6, 3, 5]);
    expect(v.bots[3].config.seedUsd).toBe(5000); // 기준 봇 설정 그대로, 손절만 다름

    const epoch = v.bots[0].sim.epoch;
    v = await e.paperBotReset(id);
    expect(v.bots[0].sim.epoch).toBe(epoch + 1);
    v = await e.paperBotDelete(v.bots[1].id);
    expect(v.bots.length).toBe(3);

    e.flushAllFileSavesSync();
    const again = mkEngine(dir).e;
    const v2 = again.getPaperBots();
    expect(v2.bots.map((b) => b.config.slPct)).toEqual([6, 3, 5]);
    expect(v2.deviceId).toBe(v.deviceId); // 기기 번호도 유지
  });

  it("한 주기: 확정 종목에 가상 매수 → 체결 → 손절까지(주문 API 호출 0)", async () => {
    // 목요일 KST 22:00 = 정규장(세션 켜짐) — 실행 시각에 좌우되지 않게 고정
    const t0 = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 22, minute: 0 }, { zone: "Asia/Seoul" }).toMillis();
    let now = t0;
    Settings.now = () => now;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const { e } = mkEngine();
      const anyE = e as unknown as Record<string, unknown>;
      anyE.paperLoopOn = true; // 데스크톱처럼(타이머는 켜지 않고 tick만 직접 부른다)
      anyE.prepareBackend = async () => undefined;
      anyE.resolveCommissionRate = async () => null;
      let orderCalls = 0;
      anyE.placeEntry = async () => { orderCalls++; throw new Error("주문 금지"); };
      anyE.scanScreener = async () => ({ results: [{ symbol: "ZZZ", status: "confirmed", price: 10, prevClose: 10, ema200: 9 }] });
      let bars: Array<{ time: number; open: number; high: number; low: number; close: number }> = [];
      anyE.paperFetchBars = async () => bars;

      let v = await e.paperBotAdd({ name: "A", slPct: 5, tpPct: 2 });
      const id = v.bots[0].id;
      await e.paperBotStart(id); // 루프 켜진 기기 → 이 기기가 돌림
      v = await e.paperBotsRunNow();
      const b = v.bots[0];
      expect(b.runnerIsMe).toBe(true);
      expect(b.sim.pending.length).toBe(1);
      const o = b.sim.pending[0];

      // 다음 봉에서 지정가를 뚫고 체결, 그다음 봉에서 손절선 아래로
      bars = [
        { time: t0 + MIN, open: o.entry + 0.05, high: o.entry + 0.05, low: o.entry - 0.01, close: o.entry },
        { time: t0 + 2 * MIN, open: o.entry, high: o.entry, low: o.sl - 0.01, close: o.sl - 0.01 },
      ];
      now = t0 + 4 * MIN;
      v = await e.paperBotsRunNow();
      const b2 = v.bots[0];
      expect(b2.sim.trades.length).toBe(1);
      expect(b2.sim.trades[0].result).toBe("sl");
      expect(b2.stats.n).toBe(1);
      expect(b2.stats.returnPct).toBeLessThan(0);
      expect(v.dashboard.bySl[0].trades).toBe(1);
      expect(orderCalls).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  // [v0.105.0] 2026-10-20 버그: 자동매매가 종목을 잡는데 가상봇은 하루 종일 0건이던 문제
  it("봇은 자기 스크리닝 기준으로 스캔한다(기본) — 자동매매 기준은 명시적으로 켠 봇만, 카운트·요약도 기록", async () => {
    const t0 = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 22, minute: 0 }, { zone: "Asia/Seoul" }).toMillis();
    const now = t0;
    Settings.now = () => now;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const { e } = mkEngine();
      const anyE = e as unknown as Record<string, unknown>;
      anyE.paperLoopOn = true;
      anyE.prepareBackend = async () => undefined;
      anyE.resolveCommissionRate = async () => null;
      anyE.paperFetchBars = async () => [];
      const ownScans: unknown[] = [];
      anyE.scanScreener = async (opts: unknown) => {
        ownScans.push(opts);
        return { results: [] }; // 봇 자기 기준으로는 확정 종목 없음
      };
      // 봇 둘: 저장된 스크리닝 기준(가격 $20~30)은 자동매매(기본 $1~9)와 다름
      let v = await e.paperBotAdd({ name: "따라감", followAutoScreen: true, screen: { priceMin: 20, priceMax: 30 } as never });
      v = await e.paperBotAdd({ name: "직접", screen: { priceMin: 20, priceMax: 30 } as never });
      expect(v.bots[0].config.followAutoScreen).toBe(true);
      expect(v.bots[1].config.followAutoScreen).toBe(false); // 기본 끔 = 봇 자기 기준
      for (const b of v.bots) await e.paperBotStart(b.id);

      // 자동매매가 방금 스캔을 끝냄(확정 1종목) → 결과를 봇과 나눠 씀 + 곧바로 봇 한 번 돌리기 예약
      const autoOpts = (e as unknown as { buildAutoScanOpts(): unknown }).buildAutoScanOpts();
      (e as unknown as { rememberScanForPaper(o: unknown, r: unknown): void }).rememberScanForPaper(autoOpts, {
        results: [{ symbol: "ZZZ", status: "confirmed", price: 10, prevClose: 5, ema200: 4.5 }],
      });
      expect(anyE.paperAfterScanTimer).not.toBeNull();
      clearTimeout(anyE.paperAfterScanTimer as ReturnType<typeof setTimeout>);
      anyE.paperAfterScanTimer = null;

      v = await e.paperBotsRunNow();
      expect(v.bots[0].sim.pending.map((o) => o.symbol)).toEqual(["ZZZ"]); // 자동매매가 잡은 종목에 가상 진입
      expect(v.bots[1].sim.pending.length).toBe(0); //                          자기 기준(가격 $20~30)으론 없음
      expect(ownScans.length).toBe(1); //                                       자기 기준 봇만 따로 스캔
      expect((ownScans[0] as { priceMin: number }).priceMin).toBe(20); // 봇이 정한 기준 그대로 스캔
      expect(v.bots[1].sim.funnel?.scans).toBe(1); //                      봇 기준 스캔 횟수가 쌓임
      expect(v.bots[1].sim.lastScan?.autoMissed.map((m) => m.symbol)).toEqual(["ZZZ"]); // 자동매매 확정과 비교
      expect(v.bots[0].sim.funnel?.confirmed).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it("자동매매가 스캔 중이면 다음 5분이 아니라 1분 뒤 다시 시도", async () => {
    const t0 = DateTime.fromObject({ year: 2026, month: 7, day: 16, hour: 22, minute: 0 }, { zone: "Asia/Seoul" }).toMillis();
    Settings.now = () => t0;
    const realNow = Date.now;
    Date.now = () => t0;
    try {
      const { e } = mkEngine();
      const anyE = e as unknown as Record<string, unknown>;
      anyE.paperLoopOn = true;
      anyE.prepareBackend = async () => undefined;
      anyE.resolveCommissionRate = async () => null;
      anyE.paperFetchBars = async () => [];
      const v = await e.paperBotAdd({ name: "A" });
      await e.paperBotStart(v.bots[0].id);
      anyE.screenBusy = true; // 자동매매 스캔이 도는 중
      const v2 = await e.paperBotsRunNow();
      expect(v2.bots[0].sim.lastNote).toContain("1분 뒤");
      expect(anyE.paperDeferTimer).not.toBeNull();
      clearTimeout(anyE.paperDeferTimer as ReturnType<typeof setTimeout>);
      anyE.paperDeferTimer = null;
    } finally {
      Date.now = realNow;
    }
  });

  it("옛 버전에서 만든 봇(설정 칸 없음)을 파일에서 읽으면 봇 자기 기준 그대로(덮어쓰지 않음)", async () => {
    const { e, dir } = mkEngine();
    await e.paperBotAdd({ name: "옛봇", screen: { priceMin: 20, priceMax: 30 } as never });
    e.flushAllFileSavesSync();
    const fs = await import("node:fs");
    const file = join(dir, "kylebot-paper.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.store.bots[0].config.followAutoScreen; // v0.104.0 이하 저장본 흉내
    fs.writeFileSync(file, JSON.stringify(raw));
    const again = mkEngine(dir).e;
    expect(again.getPaperBots().bots[0].config.followAutoScreen).toBe(false);
    expect(again.getPaperBots().bots[0].config.screen.priceMin).toBe(20);
  });
});
