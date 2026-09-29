// =============================================================================
// tests/auto-research.test.ts — "자동매매기록 → 연구" 탭 통계 규칙 고정 (v0.33.0)
// -----------------------------------------------------------------------------
// summarizeAutoHistory(순수 함수)가 승/패 집계·종목별/시간대별 성적·헤드라인을 규칙대로
// 뽑는지 검증. 실제 엔진(목 서버) 없이도 AutoTradeHistoryEntry 배열만 있으면 되므로
// 순수 데이터로 빠르게 고정한다.
// =============================================================================

import { describe, it, expect } from "vitest";
import { summarizeAutoHistory, summarizeGroupHistory, summarizeByCriteria, autoHistoryToCsv } from "../lib/auto-research";
import type { AutoTradeHistoryEntry } from "../electron/tool-engine";

/** criteriaSnapshot 기본값 — 테스트마다 필요한 필드만 덮어써서 쓴다. */
function criteria(o: Partial<NonNullable<AutoTradeHistoryEntry["criteriaSnapshot"]>> = {}): AutoTradeHistoryEntry["criteriaSnapshot"] {
  return {
    bodyRatio: 0.5,
    emaTrendEnabled: false,
    emaPeriod: 20,
    cloudEnabled: false,
    dojiWickMinRatio: 0.3,
    dojiMaxAgeEnabled: false,
    dojiMaxAgeMinutes: 5,
    nextCandleConfirmEnabled: false,
    excludeEtf: false,
    session: "day",
    maxPositions: 3,
    maxLossPct: 5,
    maxInvestPct: 20,
    watchMinutes: 10,
    ...o,
  };
}

function entry(o: Partial<AutoTradeHistoryEntry>): AutoTradeHistoryEntry {
  return {
    id: `${o.symbol ?? "AAPL"}@${o.entry ?? 100}@${Math.random()}`,
    symbol: "AAPL",
    entry: 100,
    tp: 102,
    sl: 98,
    quantity: 1,
    enteredAt: "09-28 10:00:00",
    status: "closed_win",
    exitedAt: "09-28 10:05:00",
    exitPrice: 102,
    pnlUsd: 2,
    pnlPct: 2,
    note: "테스트",
    ...o,
  };
}

describe("summarizeAutoHistory — 기본 승/패 집계", () => {
  it("승/패/수동청산/취소를 각각 올바른 통에 담는다", () => {
    const s = summarizeAutoHistory([
      entry({ status: "closed_win", pnlUsd: 5, pnlPct: 3 }),
      entry({ status: "closed_loss", pnlUsd: -3, pnlPct: -2 }),
      entry({ status: "closed_manual", pnlUsd: 1, pnlPct: 1 }),
      entry({ status: "cancelled", pnlUsd: null, pnlPct: null, exitPrice: null, exitedAt: null }),
    ]);
    expect(s.totalEntries).toBe(4);
    expect(s.cancelledCount).toBe(1);
    expect(s.manualCloses).toBe(1);
    expect(s.overall.n).toBe(2); // 승패로 마감된 것만(수동청산·취소 제외)
    expect(s.overall.wins).toBe(1);
    expect(s.overall.losses).toBe(1);
    expect(s.overall.winRate).toBe(50);
    expect(s.overall.totalPnlUsd).toBe(2); // 5 + -3
  });

  it("표본이 없으면 winRate는 null(0%로 거짓 표시하지 않는다)", () => {
    const s = summarizeAutoHistory([]);
    expect(s.overall.n).toBe(0);
    expect(s.overall.winRate).toBeNull();
    expect(s.headline).toBeNull();
  });
});

describe("summarizeAutoHistory — 종목별/시간대별 성적", () => {
  it("종목별로 승/패·손익이 따로 집계되고 손익 합계 내림차순으로 정렬된다", () => {
    const s = summarizeAutoHistory([
      entry({ symbol: "AAPL", status: "closed_win", pnlUsd: 10 }),
      entry({ symbol: "AAPL", status: "closed_win", pnlUsd: 5 }),
      entry({ symbol: "TSLA", status: "closed_loss", pnlUsd: -20 }),
    ]);
    expect(s.bySymbol[0].symbol).toBe("AAPL");
    expect(s.bySymbol[0].n).toBe(2);
    expect(s.bySymbol[0].totalPnlUsd).toBe(15);
    expect(s.bySymbol[1].symbol).toBe("TSLA");
    expect(s.bySymbol[1].totalPnlUsd).toBe(-20);
  });

  it("진입 시각(시 단위, KST)별로 집계된다", () => {
    const s = summarizeAutoHistory([
      entry({ enteredAt: "09-28 09:15:00", status: "closed_win" }),
      entry({ enteredAt: "09-28 09:45:00", status: "closed_win" }),
      entry({ enteredAt: "09-28 14:00:00", status: "closed_loss" }),
    ]);
    const h9 = s.byHour.find((h) => h.hour === 9);
    const h14 = s.byHour.find((h) => h.hour === 14);
    expect(h9?.n).toBe(2);
    expect(h14?.n).toBe(1);
  });
});

describe("summarizeAutoHistory — 보유시간·최고/최악 매매·헤드라인", () => {
  it("보유시간(분)을 진입~청산으로 계산한다", () => {
    const s = summarizeAutoHistory([
      entry({ enteredAt: "09-28 10:00:00", exitedAt: "09-28 10:07:00", status: "closed_win" }),
    ]);
    expect(s.avgHoldMin).toBe(7);
  });

  it("best/worst가 손익 기준으로 정확히 뽑힌다", () => {
    const s = summarizeAutoHistory([
      entry({ symbol: "A", status: "closed_win", pnlUsd: 3 }),
      entry({ symbol: "B", status: "closed_win", pnlUsd: 30 }),
      entry({ symbol: "C", status: "closed_loss", pnlUsd: -15 }),
    ]);
    expect(s.best?.symbol).toBe("B");
    expect(s.worst?.symbol).toBe("C");
  });

  it("표본이 10건 미만이면 헤드라인을 만들지 않는다(성급한 결론 방지)", () => {
    const few = Array.from({ length: 5 }, () => entry({ status: "closed_win" }));
    expect(summarizeAutoHistory(few).headline).toBeNull();
  });

  it("표본이 10건 이상이면 헤드라인 문장을 만든다", () => {
    const many = Array.from({ length: 10 }, () => entry({ status: "closed_win", pnlUsd: 1 }));
    const s = summarizeAutoHistory(many);
    expect(s.headline).toContain("10건");
    expect(s.headline).toContain("승률");
  });
});

describe("summarizeGroupHistory — 그룹 리더보드(실명, 비식별화 없음)", () => {
  it("회원별로 실명(이메일) 그대로 성적이 나뉘고, 누적손익 큰 순으로 정렬된다", () => {
    const g = summarizeGroupHistory([
      { email: "a@capri.dev", history: [entry({ status: "closed_win", pnlUsd: 5 }), entry({ status: "closed_win", pnlUsd: 3 })] },
      { email: "b@capri.dev", history: [entry({ status: "closed_loss", pnlUsd: -20 })] },
      { email: "c@capri.dev", history: [entry({ status: "closed_win", pnlUsd: 50 })] },
    ]);
    expect(g.memberCount).toBe(3);
    expect(g.byMember.map((m) => m.email)).toEqual(["c@capri.dev", "a@capri.dev", "b@capri.dev"]);
    expect(g.byMember[0].totalPnlUsd).toBe(50);
    expect(g.byMember.find((m) => m.email === "a@capri.dev")?.n).toBe(2);
  });

  it("그룹 전체 overall은 전원의 결정적 매매를 하나로 합친 값이다", () => {
    const g = summarizeGroupHistory([
      { email: "a@capri.dev", history: [entry({ status: "closed_win", pnlUsd: 5 })] },
      { email: "b@capri.dev", history: [entry({ status: "closed_loss", pnlUsd: -2 })] },
    ]);
    expect(g.overall.n).toBe(2);
    expect(g.overall.wins).toBe(1);
    expect(g.overall.losses).toBe(1);
    expect(g.overall.totalPnlUsd).toBe(3);
  });

  it("회원이 0명이면 표본 0으로 안전하게 처리된다(에러 없이)", () => {
    const g = summarizeGroupHistory([]);
    expect(g.memberCount).toBe(0);
    expect(g.overall.n).toBe(0);
    expect(g.overall.winRate).toBeNull();
    expect(g.byMember).toEqual([]);
    expect(g.headline).toBeNull();
  });

  it("그룹 전체 표본이 10건 이상이면 헤드라인에 1위 회원의 실명(이메일)이 그대로 들어간다", () => {
    const g = summarizeGroupHistory([
      { email: "ace@capri.dev", history: Array.from({ length: 10 }, () => entry({ status: "closed_win", pnlUsd: 100 })) },
      { email: "rookie@capri.dev", history: Array.from({ length: 2 }, () => entry({ status: "closed_loss", pnlUsd: -1 })) },
    ]);
    expect(g.headline).toContain("ace@capri.dev");
  });
});

// =============================================================================
// [v0.49.0] Raw Data 탭 — summarizeByCriteria / autoHistoryToCsv
// =============================================================================
describe("summarizeByCriteria — criteriaSnapshot 필드별 성적 비교", () => {
  it("cloudEnabled on/off 두 그룹으로 정확히 나뉘고, 각 그룹 승률·손익이 따로 집계된다", () => {
    const s = summarizeByCriteria([
      entry({ status: "closed_win", pnlUsd: 10, criteriaSnapshot: criteria({ cloudEnabled: true }) }),
      entry({ status: "closed_loss", pnlUsd: -4, criteriaSnapshot: criteria({ cloudEnabled: true }) }),
      entry({ status: "closed_win", pnlUsd: 3, criteriaSnapshot: criteria({ cloudEnabled: false }) }),
    ]);
    const cloud = s.breakdowns.find((b) => b.field === "cloudEnabled")!;
    const on = cloud.groups.find((g) => g.label === "켬")!;
    const off = cloud.groups.find((g) => g.label === "끔")!;
    expect(on.n).toBe(2);
    expect(on.wins).toBe(1);
    expect(on.totalPnlUsd).toBe(6); // 10 + -4
    expect(off.n).toBe(1);
    expect(off.totalPnlUsd).toBe(3);
    // "켬"이 "끔"보다 먼저 오는 고정 순서
    expect(cloud.groups.map((g) => g.label)).toEqual(["켬", "끔"]);
  });

  it("session별로 갈라지고 표시 순서는 데이→프리→본장→애프터→장마감 고정이다", () => {
    const s = summarizeByCriteria([
      entry({ status: "closed_win", criteriaSnapshot: criteria({ session: "regular" }) }),
      entry({ status: "closed_win", criteriaSnapshot: criteria({ session: "day" }) }),
      entry({ status: "closed_loss", criteriaSnapshot: criteria({ session: "pre" }) }),
    ]);
    const session = s.breakdowns.find((b) => b.field === "session")!;
    expect(session.groups.map((g) => g.label)).toEqual(["데이", "프리", "본장"]);
  });

  it("maxInvestPct는 구간(버킷)으로 묶이고 구간 오름차순으로 표시된다", () => {
    const s = summarizeByCriteria([
      entry({ status: "closed_win", criteriaSnapshot: criteria({ maxInvestPct: 45 }) }), // "30~50%"
      entry({ status: "closed_win", criteriaSnapshot: criteria({ maxInvestPct: 5 }) }), // "10% 미만"
      entry({ status: "closed_loss", criteriaSnapshot: criteria({ maxInvestPct: 60 }) }), // "50% 이상"
    ]);
    const invest = s.breakdowns.find((b) => b.field === "maxInvestPct")!;
    expect(invest.groups.map((g) => g.label)).toEqual(["10% 미만", "30~50%", "50% 이상"]);
  });

  it("criteriaSnapshot이 없는 기록(v0.45.0 이전·수동매매)은 집계에서 조용히 빠진다", () => {
    const s = summarizeByCriteria([
      entry({ status: "closed_win", criteriaSnapshot: undefined }),
      entry({ status: "closed_win", criteriaSnapshot: criteria() }),
    ]);
    expect(s.sampleSize).toBe(1);
  });

  it("수동청산·취소·드라이런은 승패가 없으므로 표본에서 제외된다", () => {
    const s = summarizeByCriteria([
      entry({ status: "closed_manual", criteriaSnapshot: criteria() }),
      entry({ status: "cancelled", criteriaSnapshot: criteria() }),
      entry({ status: "dryrun", criteriaSnapshot: criteria() }),
    ]);
    expect(s.sampleSize).toBe(0);
    s.breakdowns.forEach((b) => expect(b.groups).toEqual([]));
  });

  it("표본이 하나도 없으면 에러 없이 빈 그룹들을 돌려준다", () => {
    const s = summarizeByCriteria([]);
    expect(s.sampleSize).toBe(0);
    expect(s.breakdowns.length).toBeGreaterThan(0); // 필드 목록 자체는 항상 나온다
    s.breakdowns.forEach((b) => expect(b.groups).toEqual([]));
  });
});

describe("autoHistoryToCsv — Raw Data 탭 CSV 내보내기", () => {
  it("헤더 + 행이 criteriaSnapshot까지 펼쳐진 컬럼으로 나온다", () => {
    const csv = autoHistoryToCsv([
      { entry: entry({ symbol: "AAPL", status: "closed_win", pnlUsd: 5, criteriaSnapshot: criteria({ cloudEnabled: true, session: "day" }) }) },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "email,id,symbol,status,enteredAt,exitedAt,entry,exitPrice,quantity,pnlUsd,pnlPct,note," +
      "bodyRatio,emaTrendEnabled,emaPeriod,cloudEnabled,dojiWickMinRatio," +
      "dojiMaxAgeEnabled,dojiMaxAgeMinutes,nextCandleConfirmEnabled,excludeEtf,session," +
      "maxPositions,maxLossPct,maxInvestPct,watchMinutes"
    );
    expect(lines[1]).toContain("AAPL");
    expect(lines[1]).toContain("true"); // cloudEnabled
    expect(lines[1]).toContain("day");
  });

  it("그룹 원본일 때만 email이 채워지고, 내 데이터 원본이면 빈 칸이다", () => {
    const csv = autoHistoryToCsv([
      { email: "a@capri.dev", entry: entry({ status: "closed_win" }) },
      { entry: entry({ status: "closed_win" }) },
    ]);
    const [, row1, row2] = csv.split("\n");
    expect(row1.startsWith("a@capri.dev,")).toBe(true);
    expect(row2.startsWith(",")).toBe(true); // email 칸이 비어 있음
  });

  it("쉼표·줄바꿈·큰따옴표가 든 값은 CSV 규칙대로 큰따옴표로 감싼다", () => {
    const csv = autoHistoryToCsv([
      { entry: entry({ note: '사유: "익절, 완료"', status: "closed_win" }) },
    ]);
    expect(csv).toContain('"사유: ""익절, 완료"""');
  });
});
