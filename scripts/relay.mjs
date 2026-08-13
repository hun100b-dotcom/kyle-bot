// =============================================================================
// scripts/relay.mjs — "폰에서 쓰기" 한 방 실행 (npm run relay)
// -----------------------------------------------------------------------------
// 집 PC에서 릴레이를 켜고, 인터넷 터널까지 만들어 **폰에 넣을 주소**를 알려 준다.
// 데스크톱 Capri 앱에도 같은 기능이 들어 있지만, 앱 없이 이 명령만으로도 쓸 수 있다.
// =============================================================================

import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// TS 파일을 그대로 불러오기 위해 tsx 를 쓴다(개발용 실행 경로).
// [윈도우 주의] 절대경로 문자열로 import 하면 'c:' 를 프로토콜로 착각해 실패한다.
//   pathToFileURL 로 file:// 주소를 만들어 줘야 한다.
const { startRelay } = await import(pathToFileURL(join(ROOT, "electron", "relay.ts")).href);
const { startTunnel } = await import(pathToFileURL(join(ROOT, "electron", "tunnel.ts")).href);

const WEB_APP = "https://hun100b-dotcom.github.io/capri-web/";
const binDir = join(homedir(), ".capri");

console.log("\n집 PC 릴레이를 켭니다…");
const relay = await startRelay(8790);
console.log(`  로컬 주소: ${relay.localUrl}`);

const tunnel = await startTunnel(relay.port, binDir, (m) => console.log(`  ${m}`));
const phoneApi = `${tunnel.publicUrl}/r/${relay.token}`;

console.log("\n────────────────────────────────────────────────────────");
console.log(" 폰에서 아래 주소로 웹앱을 여세요(한 번만 열면 저장됩니다):\n");
console.log(`   ${WEB_APP}?api=${encodeURIComponent(phoneApi)}`);
console.log("\n 이 창을 닫거나 PC를 끄면 폰에서 조회·주문이 안 됩니다.");
console.log("────────────────────────────────────────────────────────\n");

const shutdown = async () => {
  console.log("\n릴레이·터널을 정리합니다…");
  tunnel.stop();
  await relay.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
