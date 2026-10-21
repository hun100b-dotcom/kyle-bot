// =============================================================================
// src/useLab.ts — [v0.65.0] 매매연구소 화면 상태(요약·필터·설정·내보내기)를 한곳에서 관리
// -----------------------------------------------------------------------------
// [PC vs 폰]
//   · PC(데스크톱 앱): 엔진이 이 기기에 있으니 getLabSummary 등을 직접 부른다.
//   · 폰(웹): [v0.108.0] 이제 폰 엔진도 계정 동기화로 연구소 신호 전체를 받는다(연구소 화면을 처음 열 때).
//     그래서 폰도 PC와 "같은 데이터·같은 계산"으로 요약을 직접 만든다. 다만 "지금 수집 중인지·스캔 진행" 같은
//     실시간 상태는 수집하는 PC 것이므로 PC가 올린 상태 사진(pcLab.status)을 쓴다. 받기 전(첫 몇 초)엔 예전처럼 PC 요약을 보여 준다.
//     켜기/끄기는 원격 명령으로 PC에 보낸다(수집은 PC만 한다). 기준값(몸통·거래량 등)은 계정 설정이라 폰에서 저장해도 모든 기기에 반영된다.
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
    try {
      const s = await window.kyletool.getLabSummary?.(filter);
      if (s) setLocal(s);
    } catch (e) {
      setMsg(`불러오기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [isWebApp, filter]);

  // 연구소 탭이 열려 있는 동안: 필터가 바뀔 때 즉시 + 15초마다 갱신(스캔 중 진행 상황이 보이게)
  useEffect(() => {
    if (!active) return;
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    // [v0.108.0] 다른 기기에서 연구소 신호가 들어오면 15초를 기다리지 않고 바로 다시 그린다.
    const off = window.kyletool.onItemsSynced?.((p) => {
      if (p.kind === "lab_signal") void refresh();
    });
    return () => {
      clearInterval(id);
      off?.();
    };
  }, [active, refresh]);

  const summary: LabSummary | null = useMemo(() => {
    if (!isWebApp) return local;
    // [v0.108.0] 폰: 동기화로 받은 전체 기록으로 만든 요약(local)을 우선 — 수집 상태만 PC 것으로 덮는다.
    if (local && local.counts.total > 0) return pcLab ? { ...local, status: pcLab.status } : local;
    return pcLab ? mirrorToSummary(pcLab) : local;
  }, [isWebApp, pcLab, local]);

  const saveSettings = useCallback(
    async (input: { enabled?: boolean; rankCount?: number; dojiBodyMaxPct?: number; bodyMinPct?: number; volRatioMin?: number; minRangePct?: number }) => {
      setBusy(true);
      try {
        if (isWebApp) {
          // [v0.108.0] 기준값은 폰에도 저장(→ 계정 동기화로 모든 기기). 켜기/끄기는 수집하는 PC의 일이라 명령으로만 보낸다.
          const { enabled: _enabled, ...criteria } = input;
          if (Object.keys(criteria).length > 0) await window.kyletool.saveLabSettings?.(criteria);
          const r = await window.kyletool.sendCommand("saveLabSettings", input);
          setMsg(r.ok ? "✅ 저장했습니다 — 계정의 모든 기기에 반영되고, 켜기/끄기는 PC가 몇 초 안에 처리합니다." : `⚠️ ${r.message}`);
          await refresh();
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

  // [v0.108.0] isMirror = "PC 요약만 있는 상태"(폰이 아직 전체 기록을 못 받음) — 상세 표·분해 화면을 막는 데 쓴다.
  //   isWeb = 폰인가 — 지금 스캔·초기화(모든 기기의 연구소 기록을 지움)·내보내기는 PC에서만 하게 막는 데 쓴다.
  const isMirror = isWebApp && !(local && local.counts.total > 0);
  return { summary, filter, setFilter, busy, msg, setMsg, refresh, saveSettings, scanNow, reset, download, isMirror, isWeb: isWebApp };
}

export type LabApi = ReturnType<typeof useLab>;
