// =============================================================================
// scripts/verify-live.ts  —  토스 실제 서버 "읽기 전용" 연결 검증 (S7)
// -----------------------------------------------------------------------------
// ⚠️ 이 스크립트는 실제 토스 서버에 붙습니다. 단, "읽기 전용"만 합니다.
//    - 토큰 발급(OAuth) / 현재가 조회 / 계좌 목록 / 매수가능금액 조회까지만.
//    - 주문 생성·정정·취소 등 "쓰기"는 절대 하지 않습니다(자금 이동 0).
//
// [실행] npm run verify:live   (내부에서 .env의 실제 키를 읽어 사용)
// [보안] 키는 .env(gitignore)에서만 읽고, 화면 출력은 마스킹합니다.
// =============================================================================

import { readFileSync } from "node:fs";

// --- .env 로드(작은 파서). dotenv 패키지 없이 직접 읽는다. ---
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const BASE = process.env.TOSS_BASE_URL!;
const mask = (s: string) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "(없음)");

async function main() {
  console.log("■ 토스 실서버 읽기전용 검증 시작 (주문 없음)");
  console.log("  BASE:", BASE, "| DRY_RUN:", process.env.DRY_RUN, "| TOSS_MOCK:", process.env.TOSS_MOCK);

  // 1) OAuth 토큰 발급 (form-urlencoded, body에 client_id/secret)
  console.log("\n[1] OAuth 토큰 발급 시도…");
  const tokenRes = await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.TOSS_CLIENT_ID!,
      client_secret: process.env.TOSS_CLIENT_SECRET!,
    }),
  });
  console.log("    HTTP", tokenRes.status);
  const tokenJson: any = await tokenRes.json();
  if (!tokenRes.ok) {
    console.log("    ❌ 실패 응답:", JSON.stringify(tokenJson).slice(0, 300));
    return;
  }
  const token = tokenJson.access_token;
  console.log("    ✅ 토큰 발급 성공:", mask(token), "| type:", tokenJson.token_type, "| 만료(초):", tokenJson.expires_in);

  const authHeaders = { Authorization: `Bearer ${token}` };

  // 2) 현재가 조회 (계좌 불필요) — symbols(복수) 파라미터
  console.log("\n[2] 현재가 조회 GET /api/v1/prices?symbols=AAPL …");
  const pr = await fetch(`${BASE}/api/v1/prices?symbols=AAPL`, { headers: authHeaders });
  console.log("    HTTP", pr.status);
  const prJson: any = await pr.json();
  console.log("    응답:", JSON.stringify(prJson).slice(0, 400));

  // 3) 계좌 목록 조회 (계좌 헤더 불필요) — accountSeq 확보 시도
  console.log("\n[3] 계좌 목록 GET /api/v1/accounts …");
  const ac = await fetch(`${BASE}/api/v1/accounts`, { headers: authHeaders });
  console.log("    HTTP", ac.status);
  const acJson: any = await ac.json();
  const accounts = acJson?.result ?? [];
  console.log("    계좌 수:", Array.isArray(accounts) ? accounts.length : "(응답형식 다름)");
  if (Array.isArray(accounts) && accounts.length > 0) {
    const a = accounts[0];
    console.log("    첫 계좌: accountNo", mask(String(a.accountNo)), "| accountSeq", a.accountSeq, "| type", a.accountType);

    // 3-1) 오너가 준 실제 계좌번호와 API가 돌려준 계좌번호 교차검증(대시 제거 후 비교).
    const ownerNo = (process.env.TOSS_ACCOUNT_NO ?? "").replace(/-/g, "");
    if (ownerNo) {
      const apiNo = String(a.accountNo).replace(/-/g, "");
      console.log(
        "    계좌번호 교차검증:",
        apiNo === ownerNo ? "✅ 일치 (오너 계좌 = API 계좌)" : `❌ 불일치 (API ${mask(apiNo)} vs 오너 ${mask(ownerNo)})`,
      );
    }

    const acctHeaders = { ...authHeaders, "X-Tossinvest-Account": String(a.accountSeq) };

    // 4) 매수가능금액 — USD와 KRW 둘 다 조회해 오너 스샷 값과 교차검증.
    console.log("\n[4] 매수가능금액 GET /api/v1/buying-power (계좌 헤더 사용) …");
    for (const cur of ["USD", "KRW"]) {
      const bp = await fetch(`${BASE}/api/v1/buying-power?currency=${cur}`, { headers: acctHeaders });
      const body: any = await bp.json();
      console.log(`    ${cur}: HTTP ${bp.status} →`, JSON.stringify(body.result ?? body).slice(0, 200));
    }

    // 4-1) 보유 종목(잔고) 조회 — 읽기전용.
    console.log("\n[4-1] 보유 종목 GET /api/v1/holdings …");
    const hd = await fetch(`${BASE}/api/v1/holdings`, { headers: acctHeaders });
    const hdBody: any = await hd.json();
    console.log("    HTTP", hd.status, "→", JSON.stringify(hdBody.result ?? hdBody).slice(0, 400));
  } else {
    console.log("    (계좌가 없거나 조회 불가 → buying-power 테스트 건너뜀)");
  }

  // 5) 우리 어댑터(lib/toss.ts)로도 같은 읽기전용 호출이 되는지 확인.
  //    (직접 fetch가 아니라 "봇이 실제로 쓰는 코드 경로"가 실서버에서 도는 걸 증명)
  console.log("\n[5] 어댑터(lib/toss.ts) 경유 검증 — getPrice / getAccounts / getBuyingPower …");
  const adapter = await import("../lib/toss");
  const ap = await adapter.getPrice("AAPL");
  console.log(`    getPrice: ${ap.symbol} = $${ap.price} (${typeof ap.price}) ${ap.currency}`);
  const accs = await adapter.getAccounts();
  console.log(`    getAccounts: ${accs.length}개, accountSeq=${accs[0]?.accountSeq}`);
  const abp = await adapter.getBuyingPower("USD");
  console.log(`    getBuyingPower: $${abp.buyingPowerUsd} (${typeof abp.buyingPowerUsd})`);

  console.log("\n■ 검증 종료 — 주문/쓰기 호출은 한 건도 하지 않았습니다.");
}

main().catch((e) => {
  console.error("검증 중 오류:", e);
  process.exit(1);
});
