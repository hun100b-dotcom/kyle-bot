// =============================================================================
// web/useUpdate.ts  —  "새 버전이 있습니다" 감지 + 한 번 눌러 적용 (PWA 자동 업데이트)
// -----------------------------------------------------------------------------
// [사장님 요구사항] "설치 없이 앱 안에서 자동 업데이트"
//   데스크톱 앱은 설치파일을 다시 받아야 했지만, 웹앱은 **서버에 새 화면을 올리기만** 하면
//   폰이 알아서 새 버전을 발견합니다. 이 파일이 그 감지·적용을 담당합니다.
//
// [동작 순서]
//   1) 앱이 켜지면 서비스 워커(web/sw.js)를 등록한다.
//   2) 1시간마다, 그리고 **앱을 다시 열 때마다** 새 버전이 있는지 확인한다(update()).
//   3) 새 버전이 '대기 중'이 되면 화면 위에 [지금 업데이트] 배너를 띄운다.
//   4) 누르면 새 워커에게 "기다리지 말고 바로 켜져라(SKIP_WAITING)"라고 알리고,
//      교체가 끝나는 순간 화면을 새로고침한다 → 최신 버전으로 즉시 전환.
// =============================================================================

import { useEffect, useState } from "react";

export interface UpdateState {
  /** 새 버전이 준비돼 배너를 띄워야 하는가 */
  ready: boolean;
  /** 사장님이 [지금 업데이트]를 눌렀을 때 실행 */
  apply: () => void;
  /** 마지막으로 새 버전을 확인한 시각(표시용) */
  lastCheck: string | null;
}

export function useUpdate(): UpdateState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [lastCheck, setLastCheck] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return; // 아주 오래된 브라우저 대비

    let reg: ServiceWorkerRegistration | null = null;
    let timer: number | undefined;

    const check = async () => {
      try {
        await reg?.update(); // 서버에 새 sw.js 가 있는지 확인
        setLastCheck(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
      } catch {
        /* 인터넷이 없거나 실패해도 앱은 그대로 동작해야 한다(무시) */
      }
    };

    navigator.serviceWorker
      // [중요] 문자열 경로로 등록한다. new URL(..., import.meta.url) 로 쓰면 번들러가
      //   sw.js 를 /assets/sw-해시.js 로 옮겨 버리고, 그러면 **스코프가 /assets/ 로 제한돼**
      //   첫 화면을 제어하지 못한다(등록 자체가 실패). 그래서 public 폴더의 루트 sw.js 를 쓴다.
      .register("./sw.js", { scope: "./" })
      .then((r) => {
        reg = r;

        // 이미 대기 중인 새 버전이 있으면(앱을 껐다 켠 경우) 바로 배너를 띄운다.
        if (r.waiting) setWaiting(r.waiting);

        // 새 워커가 설치되는 중이면, 설치 완료 시점을 지켜본다.
        r.addEventListener("updatefound", () => {
          const nw = r.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            // 'installed' + 이미 제어 중인 워커가 있음 = 기존 버전을 쓰는 중에 새 버전이 준비됨
            if (nw.state === "installed" && navigator.serviceWorker.controller) setWaiting(nw);
          });
        });

        void check();
        // 1시간마다 확인(폰 배터리에 부담 없는 간격)
        timer = window.setInterval(check, 60 * 60 * 1000);
      })
      .catch(() => {
        /* 서비스 워커 등록 실패해도 계산기는 정상 동작 */
      });

    // 앱을 다시 열었을 때(홈 화면 아이콘으로 복귀) 즉시 새 버전 확인
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);

    // 새 워커가 실제로 제어권을 가져가면 화면을 새로고침 → 최신 화면으로 교체
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return {
    ready: waiting !== null,
    lastCheck,
    apply: () => waiting?.postMessage("SKIP_WAITING"),
  };
}
