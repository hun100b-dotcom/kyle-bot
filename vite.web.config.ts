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
  // base "./" : 어떤 주소(도메인 루트든 /하위폴더/든)에 올려도 자원 경로가 맞도록 상대 경로 사용.
  //   GitHub Pages 처럼 https://아이디.github.io/저장소이름/ 형태에 올릴 때 특히 중요하다.
  base: "./",
  plugins: [react(), writeBuildId()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    outDir: resolve(__dirname, "dist-web"),
    emptyOutDir: true,
    target: "es2020", // 아이폰 사파리 호환 범위
  },
  server: { port: 5174 },
});
