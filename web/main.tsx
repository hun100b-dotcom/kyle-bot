// =============================================================================
// web/main.tsx  —  아이폰 웹앱(PWA) 시작점
// -----------------------------------------------------------------------------
// [중요] 화면은 **데스크톱 앱과 같은 것**(src/App.tsx)을 그대로 씁니다.
//   먼저 window.kyletool 다리를 놓고(=엔진 준비), 그 다음에 화면을 띄웁니다.
//   순서가 중요합니다. 화면이 뜨는 순간 kyletool 을 부르기 때문입니다.
//
//   업데이트 배너(웹 전용)만 화면 위에 덧붙입니다 — 데스크톱은 설치파일로,
//   웹은 서비스 워커로 업데이트하기 때문입니다.
// =============================================================================

import "./env-shim"; // ← 가장 먼저(설정 저장소 준비)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installKyleTool } from "./kyletool-adapter";
import UpdateBanner from "./UpdateBanner";
import "./app.css"; //      웹 전용 보정(아이폰 안전영역 등)
import "../src/App.css"; // 데스크톱 화면 스타일 그대로

// ① 다리 먼저 놓기(엔진 생성). 실패해도 원인을 화면에 보여 준다.
try {
  installKyleTool();
} catch (e) {
  document.body.innerHTML =
    `<div style="padding:24px;font-family:system-ui;color:#e2e8f0;background:#0f172a">` +
    `<h2>시작하지 못했습니다</h2><p>${e instanceof Error ? e.message : String(e)}</p></div>`;
  throw e;
}

// ② 데스크톱 화면을 그대로 띄운다.
//   [왜 동적 import 인가?] 다리(kyletool)를 놓은 **뒤에** 화면 코드를 불러오기 위해서다.
//   [왜 await 가 아니라 then 인가?] 파일 맨 위에서 await 를 쓰면(top-level await) 옛 아이폰
//   사파리에서 화면이 아예 안 뜰 수 있다. then 으로 쓰면 그런 걱정이 없다.
void import("../src/App").then(({ default: App }) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <UpdateBanner />
      <App />
    </StrictMode>,
  );
});
