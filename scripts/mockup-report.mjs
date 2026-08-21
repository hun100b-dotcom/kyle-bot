// scripts/mockup-report.mjs
// [v0.21.0 C시안] '매매 리포트' 화면을 4가지 비주얼로 렌더하는 목업 HTML 생성기.
// 목적: 사장님이 "달라졌다"고 체감할 개편 방향을 고르도록, 같은 데이터를 서로 확연히
//       다른 스타일 3개(+현재 기준)로 만들어 스크린샷으로 비교하게 한다.
// 실제 배포 코드와 무관한 '보여주기용' 정적 HTML이다(엔진·주문과 완전 분리).
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "outputs");
mkdirSync(OUT, { recursive: true });

// 공통 샘플 데이터(실제 리포트 구조와 동일: 히어로 손익 · 배지 4종 · 1등 · 종목별 성적)
const D = {
  period: "오늘",
  pnl: 46.2, pnlKrw: 61500, avgPct: 3.4, winRate: 75,
  tp: 6, sl: 2, wins: 6, losses: 2,
  best: { sym: "IONQ", pct: 8.1, trades: 3, wins: 3, losses: 0, pnl: 22.4 },
  rows: [
    { sym: "IONQ", pct: 8.1, trades: 3, w: 3, l: 0, pnl: 22.4 },
    { sym: "SLND", pct: 4.2, trades: 2, w: 2, l: 0, pnl: 14.8 },
    { sym: "AAPL", pct: 1.1, trades: 1, w: 1, l: 0, pnl: 6.0 },
    { sym: "XOS", pct: -2.3, trades: 2, w: 0, l: 2, pnl: -9.0 },
  ],
};

const money = (n) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const won = (n) => `${n >= 0 ? "+" : "−"}₩${Math.abs(Math.round(n)).toLocaleString("ko-KR")}`;
const maxAbs = Math.max(...D.rows.map((r) => Math.abs(r.pct)), 1);

// 리포트 화면 본문(스타일 클래스만 변주에 따라 다르게 먹는다)
function body() {
  return `
  <div class="rp">
    <div class="rp-period">조회 기간: <b>${D.period}</b></div>

    <section class="hero">
      <div class="hero-label">${D.period} 손익 <span class="hero-sub-lbl">(실제로 판 것만)</span></div>
      <div class="hero-num up">${money(D.pnl)}</div>
      <div class="hero-sub"><span class="won">${won(D.pnlKrw)}</span> · 평균 수익률 <b class="up">+${D.avgPct}%</b></div>
    </section>

    <section class="badges">
      <div class="badge win"><div class="b-num">${D.tp}</div><div class="b-lbl">이익 매도</div></div>
      <div class="badge loss"><div class="b-num">${D.sl}</div><div class="b-lbl">손실 매도</div></div>
      <div class="badge"><div class="b-num">${D.winRate}%</div><div class="b-lbl">승률 (${D.wins}승 ${D.losses}패)</div></div>
    </section>

    <section class="best">
      <div class="best-crown">👑 오늘의 1등</div>
      <div class="best-row"><b class="best-sym">${D.best.sym}</b><span class="best-pct up">+${D.best.pct}%</span></div>
      <div class="best-meta">${D.best.trades}회 매매 · ${D.best.wins}승 ${D.best.losses}패 · 실현 ${money(D.best.pnl)}</div>
    </section>

    <section class="rows-card">
      <h2>종목별 성적</h2>
      ${D.rows.map((r) => `
        <div class="row">
          <div class="row-head"><b>${r.sym}</b><span class="row-pct ${r.pct >= 0 ? "up" : "down"}">${r.pct >= 0 ? "+" : ""}${r.pct}%</span></div>
          <div class="bar-wrap"><div class="bar ${r.pct >= 0 ? "up" : "down"}" style="width:${(Math.abs(r.pct) / maxAbs) * 100}%"></div></div>
          <div class="row-meta">${r.trades}회 · ${r.w}승 ${r.l}패 · ${money(r.pnl)}</div>
        </div>`).join("")}
    </section>
  </div>`;
}

// ── 스타일 4종 ────────────────────────────────────────────────────────────
const RESET = `
*{box-sizing:border-box;margin:0;font-family:"Apple SD Gothic Neo","Pretendard",-apple-system,"Malgun Gothic",sans-serif}
.frame{width:390px;padding:16px;overflow:hidden}
.rp{display:flex;flex-direction:column;gap:14px}
.rp-period{font-size:12px}
.hero-num{font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1}
.badges{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.badge{text-align:center;padding:14px 8px;border-radius:16px}
.b-num{font-size:26px;font-weight:800}.b-lbl{font-size:11px;margin-top:2px}
.best-row{display:flex;justify-content:space-between;align-items:baseline;margin:4px 0}
.best-sym{font-size:20px}.best-pct{font-size:22px;font-weight:800}
.best-meta,.row-meta{font-size:12px}
.rows-card h2{font-size:15px;margin-bottom:10px}
.row{margin:10px 0}
.row-head{display:flex;justify-content:space-between;align-items:baseline}
.row-pct{font-weight:800}
.bar-wrap{height:8px;border-radius:6px;overflow:hidden;margin:5px 0}
.bar{height:100%}
`;

const STYLES = {
  // ── 현재(Before): v0.17 리디자인 그대로(다크·그라디언트 히어로·알약) ──
  current: `
  .frame{background:#0a0b0f;color:#f3f5fa}
  .rp-period{color:#99a1b3}
  .hero{background:linear-gradient(135deg,#1a2740,#141821);border:1px solid rgba(255,255,255,.07);border-radius:24px;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.55)}
  .hero-label{font-size:13px;color:#99a1b3}.hero-sub-lbl{color:#6b7280}
  .hero-num{font-size:48px;font-weight:800;margin:6px 0}
  .hero-sub{font-size:14px;color:#c7cdd8}.won{color:#8a93a4}
  .up{color:#2fd39a}.down{color:#f6606f}
  .badge{background:#1e222c;border:1px solid rgba(255,255,255,.07)}
  .badge.win .b-num{color:#2fd39a}.badge.loss .b-num{color:#f6606f}.b-lbl{color:#99a1b3}
  .best{background:#15181f;border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:16px}
  .best-crown{font-size:13px;color:#f7b955}.best-meta{color:#99a1b3}
  .rows-card{background:#15181f;border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:16px}
  .row-meta{color:#99a1b3}.bar-wrap{background:#0f131a}.bar.up{background:#2fd39a}.bar.down{background:#f6606f}
  `,

  // ── 시안 ① "네온 다크": 다크 유지 + 포인트컬러/그라디언트/글로우 강화 ──
  neon: `
  .frame{background:radial-gradient(120% 80% at 50% -10%,#141a2e 0%,#08090e 60%);color:#eef1f8}
  .rp-period{color:#8b93a7;letter-spacing:.02em}
  .hero{background:linear-gradient(135deg,#3b2df0 0%,#7c3aed 45%,#0ea5e9 100%);border-radius:26px;padding:26px;box-shadow:0 0 0 1px rgba(124,58,237,.4),0 18px 50px rgba(59,45,240,.45)}
  .hero-label{font-size:13px;color:rgba(255,255,255,.85);font-weight:600}.hero-sub-lbl{color:rgba(255,255,255,.6)}
  .hero-num{font-size:60px;font-weight:900;margin:8px 0;color:#fff;text-shadow:0 4px 30px rgba(255,255,255,.35)}
  .hero-sub{font-size:14px;color:rgba(255,255,255,.9)}.won{color:rgba(255,255,255,.7)}
  .hero .up{color:#eafff6}
  .up{color:#2ff3b0}.down{color:#ff5d78}
  .badge{background:linear-gradient(180deg,#191f2e,#12161f);border:1px solid rgba(124,58,237,.28);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
  .badge.win{box-shadow:0 0 24px rgba(47,243,176,.18),inset 0 0 0 1px rgba(47,243,176,.35)}
  .badge.loss{box-shadow:0 0 24px rgba(255,93,120,.16),inset 0 0 0 1px rgba(255,93,120,.32)}
  .badge.win .b-num{color:#2ff3b0}.badge.loss .b-num{color:#ff5d78}.b-lbl{color:#98a1b6}
  .best{background:linear-gradient(135deg,#1a1230,#12131c);border:1px solid rgba(124,58,237,.3);border-radius:22px;padding:18px}
  .best-crown{font-size:13px;color:#fbbf24;font-weight:700}.best-meta{color:#9aa3b7}
  .rows-card{background:#0f1219;border:1px solid rgba(255,255,255,.08);border-radius:22px;padding:18px}
  .rows-card h2{color:#c7cdda}.row-meta{color:#8b93a7}
  .bar-wrap{background:#0a0d14}.bar.up{background:linear-gradient(90deg,#2ff3b0,#0ea5e9)}.bar.down{background:linear-gradient(90deg,#ff5d78,#f7b955)}
  `,

  // ── 시안 ② "라이트 투톤": 밝은 서피스 + 컬러 액센트(완전히 다른 인상) ──
  light: `
  .frame{background:#eef1f7;color:#131722}
  .rp-period{color:#5b6577}
  .hero{background:#ffffff;border:1px solid #e3e8f0;border-radius:24px;padding:24px;box-shadow:0 10px 30px rgba(30,50,90,.10)}
  .hero-label{font-size:13px;color:#5b6577;font-weight:600}.hero-sub-lbl{color:#98a2b3}
  .hero-num{font-size:54px;font-weight:900;margin:6px 0}
  .hero-sub{font-size:14px;color:#3a4353}.won{color:#8b95a6}
  .up{color:#12b981}.down{color:#f0435b}
  .badges{gap:10px}
  .badge{background:#fff;border:1px solid #e3e8f0;box-shadow:0 4px 14px rgba(30,50,90,.06)}
  .badge.win{background:#e9f9f2}.badge.loss{background:#fdecef}
  .badge.win .b-num{color:#0ea371}.badge.loss .b-num{color:#e11d48}.b-lbl{color:#5b6577}
  .best{background:linear-gradient(135deg,#eef4ff,#ffffff);border:1px solid #dfe7f5;border-radius:20px;padding:18px}
  .best-crown{font-size:13px;color:#c2810a;font-weight:700}.best-meta{color:#5b6577}
  .rows-card{background:#fff;border:1px solid #e3e8f0;border-radius:20px;padding:18px;box-shadow:0 4px 14px rgba(30,50,90,.05)}
  .rows-card h2{color:#131722}.row-meta{color:#5b6577}
  .bar-wrap{background:#eef1f7}.bar.up{background:#12b981}.bar.down{background:#f0435b}
  `,

  // ── 시안 ③ "토스식 컬러풀": 컬러 블록 카드 + 아주 큰 타이포 ──
  toss: `
  .frame{background:#f4f5f7;color:#191f28}
  .rp-period{color:#6b7684;font-weight:600}
  .hero{background:linear-gradient(135deg,#3182f6,#1b64da);border-radius:28px;padding:28px;box-shadow:0 14px 34px rgba(49,130,246,.34)}
  .hero-label{font-size:14px;color:rgba(255,255,255,.9);font-weight:700}.hero-sub-lbl{color:rgba(255,255,255,.65)}
  .hero-num{font-size:62px;font-weight:900;margin:8px 0;color:#fff}
  .hero-sub{font-size:15px;color:rgba(255,255,255,.92)}.won{color:rgba(255,255,255,.75)}
  .hero .up{color:#fff}
  .up{color:#f04452}.down{color:#3182f6} /* 토스=한국식(이익 빨강/손실 파랑) */
  .badges{gap:12px}
  .badge{border-radius:20px;color:#fff}
  .badge.win{background:#f04452}.badge.loss{background:#3182f6}
  .badge:not(.win):not(.loss){background:#e8f0fe;color:#1b64da}
  .badge .b-num{font-size:30px}.badge.win .b-num,.badge.loss .b-num{color:#fff}
  .badge:not(.win):not(.loss) .b-num{color:#1b64da}.b-lbl{opacity:.92}
  .best{background:#fff;border-radius:24px;padding:20px;box-shadow:0 6px 20px rgba(25,31,40,.08)}
  .best-crown{font-size:14px;color:#f5a623;font-weight:800}.best-sym{font-size:24px}.best-pct{font-size:26px}
  .best-meta{color:#6b7684}
  .rows-card{background:#fff;border-radius:24px;padding:20px;box-shadow:0 6px 20px rgba(25,31,40,.08)}
  .rows-card h2{font-size:17px;color:#191f28;font-weight:800}.row-meta{color:#8b95a1}
  .bar-wrap{height:10px;background:#f2f4f6}.bar.up{background:#f04452}.bar.down{background:#3182f6}
  `,
};

const TITLE = { current: "현재 (Before)", neon: "시안 ① 네온 다크", light: "시안 ② 라이트 투톤", toss: "시안 ③ 토스식 컬러풀" };

function pageFor(variant) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>${RESET}${STYLES[variant]} html,body{background:${variant === "current" || variant === "neon" ? "#0a0b0f" : "#dfe3ea"}}
.wrap{display:inline-block}.cap{font:700 14px sans-serif;color:${variant === "current" || variant === "neon" ? "#e6ebf3" : "#333"};padding:10px 4px}</style>
</head><body><div class="wrap"><div class="cap">${TITLE[variant]}</div><div class="frame">${body()}</div></div></body></html>`;
}

// 개별 4장
for (const v of Object.keys(STYLES)) {
  const p = join(OUT, `report_${v}.html`);
  writeFileSync(p, pageFor(v), "utf8");
  console.log("wrote", p);
}

// 비교용: 4개 프레임을 한 줄로(iframe 임베드 → 한 장 스크린샷)
const compare = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>*{margin:0;box-sizing:border-box}body{background:#0e1116;padding:20px}
.grid{display:flex;gap:18px;align-items:flex-start}
iframe{width:424px;height:760px;border:0;border-radius:14px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.5)}
</style></head><body><div class="grid">
${Object.keys(STYLES).map((v) => `<iframe src="report_${v}.html"></iframe>`).join("")}
</div></body></html>`;
writeFileSync(join(OUT, "report_compare.html"), compare, "utf8");
console.log("wrote", join(OUT, "report_compare.html"));
