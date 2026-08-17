// =============================================================================
// vite.web.config.ts  —  아이폰 웹앱(PWA) 전용 빌드 설정
// -----------------------------------------------------------------------------
// 기존 vite.config.ts(데스크톱 Electron 화면용)는 **건드리지 않습니다.**
// 웹앱은 이 설정으로 따로 빌드해 dist-web/ 에 나옵니다.
//
//   npm run web:dev    개발 중 미리보기(PC 브라우저)
//   npm run web:build  배포용 빌드 → dist-web/
// =============================================================================

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

// 빌드마다 바뀌는 식별자. 서비스 워커의 캐시 이름에 들어가고,
// 이 값이 바뀌면 폰이 "새 버전이 있다"고 알아챈다.
const BUILD_ID = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

/**
 * 빌드 식별자를 파일로 남긴다(dist-web/.build-id).
 *
 *   [주의] 여기서 sw.js 를 직접 고치면 안 된다. Vite 가 이 훅 **이후에**
 *   web/public/ 을 복사하면서 원본으로 덮어쓰기 때문이다(실제로 겪음).
 *   그래서 값만 남겨 두고, 실제 새기기는 빌드가 끝난 뒤 scripts/stamp-sw.mjs 가 한다.
 */
function writeBuildId() {
  return {
    name: "capri-write-build-id",
    closeBundle() {
      const out = resolve(__dirname, "dist-web");
      writeFileSync(resolve(out, ".build-id"), BUILD_ID);
      // GitHub Pages 의 Jekyll 처리를 끈다(밑줄로 시작하는 파일이 사라지는 것 방지)
      writeFileSync(resolve(out, ".nojekyll"), "");
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, "web"),
  // [핵심] 데스크톱 엔진(electron/tool-engine.ts)을 **고치지 않고 그대로** 브라우저에서 돌리기 위해,
  //   그 엔진이 쓰는 Node 전용 모듈을 브라우저용 껍데기로 바꿔치기한다.
  //   이렇게 해야 PC와 웹의 계산·주문 규칙·안전장치가 100% 같은 코드로 유지된다.
  // base "./" : 어떤 주소(도메인 루트든 /하위폴더/든)에 올려도 자원 경로가 맞도록 상대 경로 사용.
  //   [주의] 이 줄을 빼면 GitHub Pages 하위폴더(/capri-web/)에서 /assets/... 를 찾다가 404 가 나고
  //   화면이 아예 뜨지 않는다(실제로 겪음 — 편집 중 이 줄이 함께 지워졌다).
  base: "./",
  resolve: {
    // [중요] alias 키는 '코드에 적힌 import 문자열'과 맞아야 한다.
    //   예전에 절대경로를 키로 썼다가 **하나도 적용되지 않아**, 브라우저에서 가짜 서버를 띄우려다
    //   "createServer is not a function" 같은 알 수 없는 오류가 났다(원인 파악 불가한 증상).
    //   그래서 find/replacement 형태로 '실제 import 경로'를 정확히 잡는다.
    alias: [
      { find: /^node:fs$/, replacement: resolve(__dirname, "web/shims/fs.ts") },
      { find: /^node:path$/, replacement: resolve(__dirname, "web/shims/path.ts") },
      { find: /^node:events$/, replacement: resolve(__dirname, "web/shims/events.ts") },
      { find: /^node:crypto$/, replacement: resolve(__dirname, "web/shims/crypto.ts") },
      // 브라우저에서는 서버를 못 띄운다 → 부르면 한국어로 이유를 알려 주는 껍데기
      { find: /^node:http$/, replacement: resolve(__dirname, "web/shims/http.ts") },
      { find: /^node:net$/, replacement: resolve(__dirname, "web/shims/http.ts") },
      // 연습(목) 토스 서버: tool-engine 이 "../mocks/toss-mock" 으로 불러온다
      // [주의] 정규식은 **경로 전체**를 잡아야 한다. 일부만 잡으면 남은 앞부분("../")이
      //   결과에 붙어 "../C:\...\toss-mock.ts" 같은 잘못된 경로가 되어 빌드가 깨진다(실제로 겪음).
      { find: /^\.\.\/mocks\/toss-mock$/, replacement: resolve(__dirname, "web/shims/toss-mock.ts") },
    ],
  },
  plugins: [react(), writeBuildId()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    // [중요] 번들러 기본 동작은 `process.env` 를 빈 객체로 바꿔 버린다(설정이 저장 안 되는 버그).
    //   우리가 만든 진짜 객체로 연결해 읽기·쓰기가 모두 살아 있게 한다. (web/env-shim.ts)
    "process.env": "globalThis.__capriEnv",
  },
  build: {
    outDir: resolve(__dirname, "dist-web"),
    emptyOutDir: true,
    target: "es2020", // 아이폰 사파리 호환 범위
  },
  server: { port: 5174 },
});
