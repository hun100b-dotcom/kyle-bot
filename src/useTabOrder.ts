// =============================================================================
// src/useTabOrder.ts — 상단 탭을 좌우로 끌어 순서를 바꾸고, 그 순서를 기억한다
// -----------------------------------------------------------------------------
// [사장님 요청] "상단 탭 순서를 좌우로 자유롭게 바꿀 수 있게."
//
// [어떻게 동작하나]
//   · PC: 탭을 누른 채 좌우로 끌면 자리가 바뀝니다.
//   · 폰: 탭을 **0.45초 꾹 눌렀다가** 좌우로 끌면 자리가 바뀝니다.
//     (그냥 밀면 탭 줄이 좌우로 스크롤됩니다 — 둘을 구분하기 위한 규칙입니다)
//   · 손을 떼면 그 순서를 저장합니다 → 앱을 껐다 켜도 그대로입니다.
//   · **마우스와 손가락(터치) 모두** 됩니다(포인터 이벤트 하나로 처리).
//   · 살짝 눌렀다 떼면 그냥 '탭 이동'입니다(6px 이상 끌어야 순서 바꾸기로 봅니다).
//
// [저장 위치] 이 기기 안에만 저장합니다(PC 앱=앱 저장소, 폰=브라우저 저장소).
//   기기마다 취향이 다를 수 있어 클라우드로 옮기지 않습니다.
//
// [안전 규칙] 저장된 순서에 없는 새 탭이 생기면 뒤에 자동으로 붙고,
//   없어진 탭은 조용히 빠집니다. 그래서 업데이트로 탭이 바뀌어도 화면이 깨지지 않습니다.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";

const STORE_KEY = "capri-tab-order";

/**
 * useTabOrder — 탭 순서 상태 + 드래그 핸들러를 돌려준다.
 * @param allTabs 앱이 가진 모든 탭(기본 순서)
 * @param storageKey [v0.95.0] 저장 위치(localStorage 키). 기본값은 예전부터 쓰던 메인(1단 그룹) 탭 키라
 *   이 인자를 안 주면 기존 동작과 완전히 같다. 하위 탭(2단)처럼 "같은 화면에서 여러 번" 이 훅을 쓰려면
 *   (그룹마다 서로 다른 하위 탭 목록) 그룹별로 다른 키를 줘서 저장이 서로 안 섞이게 해야 한다.
 */
export function useTabOrder<T extends string>(allTabs: readonly T[], storageKey: string = STORE_KEY) {
  /** 저장된 순서를 읽되, 현재 존재하는 탭들과 맞춘다(빠진 건 뒤에 붙이고, 없어진 건 제거) */
  const normalize = useCallback(
    (saved: string[] | null): T[] => {
      const known = new Set(allTabs);
      const kept = (saved ?? []).filter((t): t is T => known.has(t as T));
      const missing = allTabs.filter((t) => !kept.includes(t));
      return [...kept, ...missing];
    },
    [allTabs],
  );

  const [order, setOrder] = useState<T[]>(() => {
    try {
      return normalize(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
    } catch {
      return [...allTabs];
    }
  });

  /** 지금 끌고 있는 탭.
   *   [왜 ref 와 state 를 함께 쓰나?]
   *     · ref: 이벤트 처리에서 '지금 값'을 즉시 읽기 위해(화면 갱신을 기다리지 않는다).
   *       state 만 쓰면 빠르게 끌 때 옛 값이 잡혀 순서가 안 바뀌는 일이 생긴다(실제로 겪음).
   *     · state: 끌고 있는 탭을 흐리게 보여 주는 등 '화면 표시'용.
   */
  const draggingRef = useRef<T | null>(null);
  const [dragging, setDragging] = useState<T | null>(null);
  const startX = useRef(0);
  const moved = useRef(false);

  // 탭 목록이 바뀌면(업데이트로 탭 추가 등) 저장본을 다시 맞춘다.
  useEffect(() => {
    setOrder((cur) => normalize(cur));
  }, [normalize]);

  const persist = useCallback((next: T[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* 저장 실패해도 이번 세션 순서는 그대로 쓴다 */
    }
  }, [storageKey]);

  /** 두 탭의 자리를 바꾼다 */
  const moveTab = useCallback((from: T, to: T) => {
    setOrder((cur) => {
      const i = cur.indexOf(from);
      const j = cur.indexOf(to);
      if (i < 0 || j < 0 || i === j) return cur;
      const next = [...cur];
      next.splice(i, 1); //      끌고 있는 탭을 빼고
      next.splice(j, 0, from); // 지나간 탭 자리에 끼워 넣는다
      return next;
    });
  }, []);

  /** 길게 누르기 타이머(폰에서 '스크롤'과 '순서 바꾸기'를 구분하려고 쓴다) */
  const holdTimer = useRef<number | undefined>(undefined);
  const armed = useRef(false); // 순서 바꾸기 모드에 들어갔나

  const clearHold = useCallback(() => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  }, []);

  /** 탭 버튼에 붙일 이벤트들 */
  const dragProps = useCallback(
    (t: T) => ({
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return; // 마우스는 왼쪽 버튼만
        draggingRef.current = t;
        startX.current = e.clientX;
        moved.current = false;

        if (e.pointerType === "mouse") {
          // PC: 바로 끌 수 있다(6px 이상 움직이면 순서 바꾸기).
          armed.current = true;
          setDragging(t);
        } else {
          // 폰: **0.45초 이상 꾹 누르면** 순서 바꾸기 모드.
          //   그냥 밀면 탭 줄이 좌우로 스크롤돼야 하기 때문이다(둘을 구분해야 한다).
          armed.current = false;
          clearHold();
          holdTimer.current = window.setTimeout(() => {
            armed.current = true;
            setDragging(t); // 살짝 흐려지며 "이제 옮길 수 있어요" 표시
          }, 450);
        }
      },
      onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
        const cur = draggingRef.current;
        if (cur == null) return;

        // 아직 '꾹 누르기'가 안 됐는데 움직이면 → 스크롤하려는 것이므로 순서 바꾸기를 포기한다.
        if (!armed.current) {
          if (Math.abs(e.clientX - startX.current) > 8) {
            clearHold();
            draggingRef.current = null;
          }
          return;
        }
        if (!moved.current && Math.abs(e.clientX - startX.current) < 6) return; // 살짝 떨린 건 무시
        moved.current = true;

        // 손가락/마우스가 있는 x 좌표에 **가장 가까운 탭**을 찾아 자리를 바꾼다.
        //   [왜 좌표로?] elementFromPoint 는 탭 사이 빈 공간에서 아무것도 못 잡는다.
        const container = (e.currentTarget as HTMLElement).parentElement;
        if (!container) return;
        let nearest: { tab: T; dist: number } | null = null;
        for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-tab]"))) {
          const id = el.dataset.tab as T | undefined;
          if (!id) continue;
          const r = el.getBoundingClientRect();
          const center = r.left + r.width / 2;
          const dist = Math.abs(e.clientX - center);
          if (!nearest || dist < nearest.dist) nearest = { tab: id, dist };
        }
        if (nearest && nearest.tab !== cur) moveTab(cur, nearest.tab);
      },
      onPointerUp: () => {
        clearHold();
        if (draggingRef.current != null && moved.current) {
          setOrder((curOrder) => {
            persist(curOrder);
            return curOrder;
          });
        }
        draggingRef.current = null;
        armed.current = false;
        setDragging(null);
        // 클릭(탭 이동)과 구분하기 위해 잠깐 뒤에 초기화한다.
        setTimeout(() => {
          moved.current = false;
        }, 0);
      },
      onPointerCancel: () => {
        clearHold();
        draggingRef.current = null;
        armed.current = false;
        moved.current = false;
        setDragging(null);
      },
      // 순서 바꾸기 모드일 때만 화면 스크롤을 막는다(평소엔 좌우로 밀어 탭을 볼 수 있어야 한다).
      style:
        dragging === t
          ? ({ touchAction: "none", opacity: 0.6, transform: "scale(1.04)" } as const)
          : ({ touchAction: "auto" } as const),
      "data-tab": t,
    }),
    [dragging, moveTab, persist, clearHold],
  );

  /** 순서를 처음 상태로 되돌리기(설정 등에서 쓸 수 있게) */
  const resetOrder = useCallback(() => {
    setOrder([...allTabs]);
    persist([...allTabs]);
  }, [allTabs, persist]);

  return { order, dragProps, dragging, resetOrder, isDragging: () => moved.current };
}
