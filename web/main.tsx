// =============================================================================
// web/main.tsx  —  아이폰 웹앱(PWA) 시작점
// -----------------------------------------------------------------------------
// 데스크톱(Electron) 앱과 **완전히 별개의 진입점**입니다.
// 기존 src/(데스크톱 화면)·electron/(엔진)은 하나도 건드리지 않습니다.
// 공통으로 쓰는 건 lib/ 의 '순수 계산 로직'뿐입니다(계산·장시간·휴장일).
// =============================================================================

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
