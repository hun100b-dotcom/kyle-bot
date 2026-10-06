// =============================================================================
// src/useLab.ts — [v0.65.0] 매매연구소 화면 상태(요약·필터·설정·내보내기)를 한곳에서 관리
// -----------------------------------------------------------------------------
// [PC vs 폰]
//   · PC(데스크톱 앱): 엔진이 이 기기에 있으니 getLabSummary 등을 직접 부른다.
//   · 폰(웹): 로컬 엔진엔 데이터가 없다 → PC가 상태 미러에 올려 둔 요약(pcLab)만 보여 주고,
//     켜기/끄기·설정은 원격 명령(saveLabSettings)으로 PC에 보낸다. 상세 로우·내보내기는 PC 전용.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";

const FILTER_KEY = "capri-lab-filter";

export const DEFAULT_REF_KEY = "DD-1.5-e1";

function loadFilter(): LabQueryFilter {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as LabQueryFilter | null;
    if (raw) return { includeIneligible: !!raw.includeIneligible, includeThin: !!raw.includeThin, includeBackfilled: raw.includeBackfilled !== false, refKey: raw.refKey || DEFAULT_REF_KEY };
  } catch {
    /* 저장본이 깨졌으면 기본값 */
  }
  return { includeIneligible: false, includeThin: false, includeBackfilled: true, refKey: DEFAULT_REF_KEY };
}

/** 폰이 받은 미러를 화면이 쓰는 요약 모양으로 바꾼다(변형은 상위 일부만 있음). */
function mirrorToSummary(m: LabMirror): LabSummary {
  return {
    updatedAtMs: m.updatedAtMs,
    status: m.status,
    funnel: m.funnel,
    linkage: m.linkage,
    variants: m.topVariants,
    signals: m.signals,
    refKey: m.refKey,
    counts: m.counts,
    assessment: m.assessment,
  };
}

export function useLab(isWebApp: boolean, pcLab: LabMirror | null, active: boolean) {
  const [local, setLocal] = useState<LabSummary | null>(null);
  const [filter, setFilterState] = useState<LabQueryFilter>(loadFilter);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const setFilter = useCallback((f: LabQueryFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      /* 저장 실패는 무시 */
    }
  }, []);

  const refresh = useCallback(async () => {
    if (isWebApp) return;
    try {
      const s = await window.kyletool.getLabSummary?.(filter);
      if (s) setLocal(s);
    } catch (e) {
      setMsg(`불러오기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [isWebApp, filter]);

  // 연구소 탭이 열려 있는 동안: 필터가 바뀔 때 즉시 + 15초마다 갱신(스캔 중 진행 상황이 보이게)
  useEffect(() => {
    if (!active || isWebApp) return;
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [active, isWebApp, refresh]);

  const summary: LabSummary | null = useMemo(() => (isWebApp ? (pcLab ? mirrorToSummary(pcLab) : null) : local), [isWebApp, pcLab, local]);

  const saveSettings = useCallback(
    async (input: { enabled?: boolean; rankCount?: number; dojiBodyMaxPct?: number; bodyMinPct?: number; volRatioMin?: number; minRangePct?: number }) => {
      setBusy(true);
      try {
        if (isWebApp) {
          const r = await window.kyletool.sendCommand("saveLabSettings", input);
          setMsg(r.ok ? "✅ PC로 명령을 보냈습니다(PC가 몇 초 안에 반영 — 아래 상태가 곧 갱신됩니다)." : `⚠️ ${r.message}`);
        } else {
          await window.kyletool.saveLabSettings?.(input);
          setMsg("✅ 저장했습니다.");
          await refresh();
        }
      } catch (e) {
        setMsg(`⚠️ 실패: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
        setTimeout(() => setMsg(""), 5000);
      }
    },
    [isWebApp, refresh],
  );

  const scanNow = useCallback(async () => {
    if (isWebApp) return;
    setBusy(true);
    setMsg("스캔 중… (거래량 순위 종목마다 1분봉을 깊게 받아 과거 신호까지 훑습니다. 처음엔 몇 분 걸릴 수 있어요)");
    try {
      await window.kyletool.labScanNow?.();
      await refresh();
      setMsg("✅ 스캔을 마쳤습니다.");
    } catch (e) {
      setMsg(`⚠️ 스캔 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(""), 6000);
    }
  }, [isWebApp, refresh]);

  const reset = useCallback(async () => {
    if (isWebApp) return;
    await window.kyletool.labReset?.();
    await refresh();
    setMsg("연구소 데이터를 모두 지웠습니다.");
    setTimeout(() => setMsg(""), 5000);
  }, [isWebApp, refresh]);

  /** 파일로 저장(브라우저 다운로드) */
  const download = useCallback(
    async (kind: "signals-csv" | "trades-csv" | "json") => {
      if (isWebApp) return;
      const r = await window.kyletool.exportLab?.(kind);
      if (!r) return;
      const blob = new Blob([kind === "json" ? r.text : "﻿" + r.text], { type: kind === "json" ? "application/json" : "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setMsg(`✅ ${r.filename} 저장을 시작했습니다(브라우저 다운로드 폴더).`);
      setTimeout(() => setMsg(""), 5000);
    },
    [isWebApp],
  );

  return { summary, filter, setFilter, busy, msg, setMsg, refresh, saveSettings, scanNow, reset, download, isMirror: isWebApp };
}

export type LabApi = ReturnType<typeof useLab>;
