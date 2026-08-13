// =============================================================================
// scripts/stamp-sw.mjs — 빌드 후: 서비스 워커에 '이번 빌드 식별자'를 새긴다
// -----------------------------------------------------------------------------
// [왜 이렇게 하나? — 실제로 당한 문제]
//   처음에는 sw.js 를 web/public/ 에 두고 빌드 중에 값을 바꿔 넣었는데,
//   Vite 의 public 폴더 복사와 **순서가 엇갈려** 원본(__BUILD_ID__)이 되살아났다.
//   그 결과 배포해도 sw.js 내용이 매번 똑같아서 **브라우저가 "새 버전"을 영영 감지하지
//   못했다**(= 업데이트 배너가 안 뜸). 조용히 망가지는 종류의 버그다.
//
//   그래서 지금은 원본을 web/sw-template.js (public 밖!) 에 두고,
//   빌드가 끝난 뒤 이 스크립트가 dist-web/sw.js 를 **새로 만든다.**
//   아무도 이 파일을 덮어쓰지 않으므로 경합이 원천적으로 없다.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-web");
const idFile = join(OUT, ".build-id");

if (!existsSync(idFile)) {
  console.error("✖ dist-web/.build-id 가 없습니다. `vite build --config vite.web.config.ts` 를 먼저 실행하세요.");
  process.exit(1);
}
const buildId = readFileSync(idFile, "utf8").trim();

const template = readFileSync(join(ROOT, "web", "sw-template.js"), "utf8");
if (!template.includes("__BUILD_ID__")) {
  console.error("✖ web/sw-template.js 에 __BUILD_ID__ 자리표시자가 없습니다.");
  process.exit(1);
}
const swPath = join(OUT, "sw.js");
// [주의] replace 가 아니라 replaceAll 이다.
//   템플릿의 **주석에도** __BUILD_ID__ 라는 글자가 들어 있어서, replace(첫 번째만 치환)를 쓰면
//   주석만 바뀌고 정작 중요한 const 줄은 그대로 남는다. 그러면 캐시 이름이 매 배포마다 똑같아져
//   업데이트 감지가 조용히 죽는다. 실제로 이 실수를 했고, 아래 검증에서 잡았다.
writeFileSync(swPath, template.replaceAll("__BUILD_ID__", buildId));

// 확인: 화면(App)의 버전 표시와 서비스 워커의 캐시 이름이 같은 값인지 대조한다.
const ok = readFileSync(swPath, "utf8").includes(`const BUILD_ID = "${buildId}"`);
console.log(ok ? `서비스 워커 버전 새김 완료: ${buildId}` : "✖ 새기기 실패");
process.exit(ok ? 0 : 1);
