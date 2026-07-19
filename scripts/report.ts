// =============================================================================
// scripts/report.ts  —  Capri 현황판 HTML 생성 (읽기전용, 주문 0건)
// -----------------------------------------------------------------------------
// [이게 뭔가?]
//   터미널을 몰라도 봇 상태를 볼 수 있게, "브라우저로 여는 HTML 현황판"을 만듭니다.
//   실행하면: 실제 토스에서 시세·잔고를 읽어와(읽기전용) → report.html 파일 생성.
//   오너는 Capri현황.bat 더블클릭 한 번이면 최신 현황이 브라우저에 뜹니다.
//
// [보안 설계 — 왜 이런 방식인가?]
//   브라우저(HTML/JS)에서 직접 토스 API를 부르면 비밀키가 브라우저에 노출됩니다(금지).
//   그래서 키를 아는 쪽(Node, 이 스크립트)이 조회를 대신 하고, 결과 "숫자만" 담긴
//   정적 HTML을 만들어 줍니다. HTML엔 키가 전혀 없습니다.
//   단, 잔고 등 계좌 정보가 담기므로 report.html은 git에 올리지 않습니다(.gitignore).
//
// [실행] npm run report   또는   Capri현황.bat 더블클릭
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { DateTime } from "luxon";

// .env 로드
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = raw.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].trim();
}

import { getPrice, getAccounts, getBuyingPower, getHoldings } from "../lib/toss";
import { getSession, getDayMarketOpen, getScanTime, getFirstOrderTime, getSecondOrderTime, getCloseDeadline } from "../lib/session";

const KRW = (n: number) => "₩" + Math.round(n).toLocaleString("ko-KR");
const USD = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 세션 코드 → 한국어 이름/색 */
const SESSION_KO: Record<string, { name: string; color: string }> = {
  day: { name: "데이마켓 (봇 활동 시간)", color: "#16a34a" },
  pre: { name: "프리마켓", color: "#d97706" },
  regular: { name: "정규장", color: "#2563eb" },
  after: { name: "애프터마켓", color: "#7c3aed" },
  closed: { name: "휴장", color: "#6b7280" },
};

async function main() {
  console.log("현황 조회 중… (실서버 읽기전용, 주문 없음)");

  const now = DateTime.now().setZone("Asia/Seoul");
  const session = getSession(now);

  // 실서버 읽기전용 조회(전부 병렬)
  const [price, accounts, bpUsd, bpKrw, holdingsRaw] = await Promise.all([
    getPrice("AAPL"),
    getAccounts(),
    getBuyingPower("USD"),
    getBuyingPower("KRW"),
    getHoldings() as Promise<any>,
  ]);

  // 보유 요약(실제 스펙: totalPurchaseAmount/marketValue/profitLoss, 값은 문자열)
  const h = holdingsRaw ?? {};
  const buyKrw = Number(h?.totalPurchaseAmount?.krw ?? 0);
  const valKrw = Number(h?.marketValue?.amount?.krw ?? 0);
  const plKrw = Number(h?.profitLoss?.amount?.krw ?? 0);
  const plRate = Number(h?.profitLoss?.rate ?? 0) * 100;

  const s = SESSION_KO[session] ?? SESSION_KO.closed;
  const dryRun = process.env.DRY_RUN === "true";

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Capri 현황판</title>
<style>
  :root{--bg:#f6f7fb;--card:#fff;--tx:#111827;--sub:#6b7280;--line:#e5e7eb}
  @media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--tx:#e5e7eb;--sub:#9ca3af;--line:#2a2e37}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:'Segoe UI',Pretendard,sans-serif;padding:24px}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}.sub{color:var(--sub);font-size:13px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
  .label{font-size:12px;color:var(--sub);margin-bottom:6px}
  .big{font-size:24px;font-weight:700}.mid{font-size:16px;font-weight:600}
  .badge{display:inline-block;padding:4px 12px;border-radius:999px;color:#fff;font-size:13px;font-weight:600}
  .neg{color:#dc2626}.pos{color:#16a34a}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:7px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right;font-weight:600}
  tr:last-child td{border-bottom:0}
  .foot{margin-top:20px;font-size:12px;color:var(--sub);line-height:1.7}
  .steps{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .step{font-size:12px;padding:4px 10px;border-radius:8px;background:var(--line)}
  .done{background:#16a34a22;color:#16a34a;font-weight:600}
  .now{background:#d9770622;color:#d97706;font-weight:600}
</style></head><body><div class="wrap">
  <h1>🤖 Capri 현황판</h1>
  <div class="sub">생성: ${now.toFormat("yyyy-MM-dd HH:mm:ss")} KST · 실제 토스 계좌에서 읽어온 값(읽기전용) · 이 파일에는 계좌 정보가 있으니 공유 금지</div>

  <div class="grid">
    <div class="card"><div class="label">지금 세션</div>
      <span class="badge" style="background:${s.color}">${s.name}</span>
      <div class="label" style="margin-top:10px">모드</div>
      <span class="badge" style="background:${dryRun ? "#2563eb" : "#dc2626"}">${dryRun ? "🔒 드라이런 (실주문 잠금)" : "⚠️ 실거래 모드"}</span>
    </div>
    <div class="card"><div class="label">오늘 봇 시간표 (KST)</div>
      <table>
        <tr><td>데이마켓 개장</td><td>${getDayMarketOpen(now).toFormat("HH:mm")}</td></tr>
        <tr><td>종목 스캔</td><td>${getScanTime(now).toFormat("HH:mm")}</td></tr>
        <tr><td>1차 / 2차 주문</td><td>${getFirstOrderTime(now).toFormat("HH:mm")} / ${getSecondOrderTime(now).toFormat("HH:mm")}</td></tr>
        <tr><td>청산 데드라인</td><td>${getCloseDeadline(now).toFormat("HH:mm")}</td></tr>
      </table>
    </div>
    <div class="card"><div class="label">주문 가능 금액 (실계좌)</div>
      <div class="big">${USD(bpUsd.buyingPowerUsd)}</div>
      <div class="mid" style="color:var(--sub)">${KRW(bpKrw.buyingPowerUsd)}</div>
    </div>
    <div class="card"><div class="label">보유 종목 평가 (실계좌)</div>
      <table>
        <tr><td>총 매입</td><td>${KRW(buyKrw)}</td></tr>
        <tr><td>평가 금액</td><td>${KRW(valKrw)}</td></tr>
        <tr><td>평가 손익</td><td class="${plKrw < 0 ? "neg" : "pos"}">${KRW(plKrw)} (${plRate.toFixed(1)}%)</td></tr>
      </table>
    </div>
    <div class="card"><div class="label">시세 연결 확인 (예시: 애플)</div>
      <div class="big">AAPL ${USD(price.price)}</div>
      <div class="label" style="margin-top:4px">계좌 ${accounts.length}개 연결됨 (accountSeq ${accounts[0]?.accountSeq})</div>
    </div>
    <div class="card"><div class="label">프로젝트 진행 단계</div>
      <div class="steps">
        <span class="step done">계산엔진 ✓</span><span class="step done">DB설계 ✓</span>
        <span class="step done">토스연동 ✓</span><span class="step done">안전장치 ✓</span>
        <span class="step done">실행부 ✓</span><span class="step done">읽기전용 실연결 ✓</span>
        <span class="step now">드라이런 운전 ◀ 지금</span>
        <span class="step">소액 실주문</span><span class="step">데스크톱 앱(S5)</span>
      </div>
    </div>
  </div>

  <div class="foot">
    ✅ 이 현황판을 만드는 동안 서버에는 <b>조회(읽기)만</b> 나갔고 주문은 0건입니다.<br>
    🔄 새로고침하려면: <b>Capri현황.bat</b>을 다시 더블클릭 (또는 터미널에서 <code>npm run report</code>)<br>
    📁 코드·진행상황: github.com/hun100b-dotcom/kyle-bot → docs/progress.md
  </div>
</div></body></html>`;

  const out = new URL("../report.html", import.meta.url);
  writeFileSync(out, html, "utf8");
  console.log("✅ report.html 생성 완료 — 브라우저로 열면 현황이 보입니다.");
}

main().catch((e) => { console.error("현황판 생성 오류:", e); process.exit(1); });
