// =============================================================================
// web/App.tsx  —  Capri 아이폰 웹앱(PWA) 화면
// -----------------------------------------------------------------------------
// [이 화면이 하는 일 — 1단계]
//   폰에서 **계산**을 합니다. 종목의 전봉 종가·EMA200 같은 숫자를 넣으면
//   삼분할 진입가 / 익절 / 손절 / 살 수량을 계산해 주고, 값을 복사해서
//   토스 앱에 그대로 옮겨 적을 수 있습니다.
//
// [왜 주문 버튼이 없나?]
//   브라우저가 토스 API를 직접 부를 수 없습니다(토스가 브라우저 호출을 허용하는
//   CORS 헤더를 주지 않고, 무엇보다 키가 폰에 노출됩니다). 시세·주문은 **클라우드
//   서버(api/ 폴더)** 를 거쳐야 하며, 그 서버 배포는 2단계입니다. 자세한 건 README-web.md.
//
// [계산 로직은 데스크톱 앱과 같은 것을 씁니다]
//   lib/calc.ts · lib/session.ts · lib/holidays.ts 를 그대로 가져다 씁니다.
//   → 폰과 PC의 계산 결과가 다를 수 없습니다(같은 코드, 같은 테스트 150개).
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { calcSplit3, calcOrderbook, calcCandle, getTick, roundPrice } from "../lib/calc";
import { getMarketStatus } from "../lib/session";
import { useUpdate } from "./useUpdate";

// 빌드 시각(배포 스크립트가 넣어 준다) — 지금 보고 있는 버전이 언제 것인지 확인용
declare const __BUILD_ID__: string;

type Technique = "split3" | "orderbook" | "candle";

const TECH_LABEL: Record<Technique, string> = {
  split3: "삼분할",
  orderbook: "호가창(매수벽)",
  candle: "캔들(시가-3틱)",
};

const SESSION_LABEL: Record<string, string> = {
  day: "데이마켓",
  pre: "프리마켓",
  regular: "본장(정규장)",
  after: "애프터마켓",
  closed: "장 마감",
};

/** 설정값(폰 안에만 저장 — 서버로 나가지 않는다) */
interface Settings {
  seedUsd: number; //     시드(달러)
  dayPct: number; //      데이마켓에 쓸 시드 비율(%)
  prePct: number; //      프리마켓 비율(%)
  regularPct: number; //  본장 비율(%)
  tpPct: number; //       기본 익절 %
  slPct: number; //       기본 손절 %
  fxRate: number; //      환율(1달러 = ? 원) — API 주소가 있으면 자동 조회로 갱신
  apiBase: string; //     [2단계] 토스 프록시 서버 주소(비어 있으면 자동조회 끔)
}

const DEFAULTS: Settings = {
  seedUsd: 1000,
  dayPct: 90,
  prePct: 50,
  regularPct: 50,
  tpPct: 2,
  slPct: 10,
  fxRate: 1390,
  // 배포된 프록시 주소가 정해지면 여기에 기본값으로 넣는다.
  // 그 전에도 주소창에 ?api=https://... 를 붙이거나 설정 탭에서 직접 넣을 수 있다.
  apiBase: "",
};
const STORE_KEY = "capri-web-settings";

function loadSettings(): Settings {
  let saved: Settings = DEFAULTS;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    // 저장된 값에 빠진 항목이 있어도(옛 버전) 기본값으로 메워 안전하게 읽는다.
    if (raw) saved = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    saved = DEFAULTS;
  }
  // 주소창에 ?api=https://... 를 붙이면 자동조회 서버를 바로 지정할 수 있다.
  //   (앱을 새로 배포하지 않고도 서버 주소를 꽂을 수 있게 하는 통로)
  try {
    const q = new URLSearchParams(location.search).get("api");
    if (q) {
      const next = { ...saved, apiBase: q.trim() };
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      return next;
    }
  } catch {
    /* 무시 */
  }
  return saved;
}

/** 숫자 입력칸의 문자열을 숫자로 (빈칸·오타는 null) */
function num(s: string): number | null {
  if (s.trim() === "") return null;
  const v = Number(s.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

/** $ 표기 */
function usd(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
/** ₩ 표기(참고용 환산) */
function krw(v: number, fx: number): string {
  return `₩${Math.round(v * fx).toLocaleString("ko-KR")}`;
}

export default function App() {
  const update = useUpdate();

  // [토스 키 취급 원칙]
  //   키는 **화면이 열려 있는 동안 메모리에만** 둔다. localStorage 등에 저장하지 않는다.
  //   → 폰을 잃어버려도 웹앱에 키가 남지 않는다. 앱을 껐다 켜면 다시 입력해야 한다(의도된 불편).
  //   시세·환율 조회는 이 키를 프록시 서버에 실어 보내고, 서버는 저장 없이 토스로 전달만 한다.
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [quote, setQuote] = useState<{ symbol: string; price: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiMsg, setApiMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<"calc" | "settings">("calc");
  const [settings, setSettings] = useState<Settings>(loadSettings);

  // 1분마다 시계를 갱신해 장 상태 배지가 저절로 바뀌게 한다.
  const [now, setNow] = useState(() => DateTime.now().setZone("Asia/Seoul"));
  useEffect(() => {
    const t = setInterval(() => setNow(DateTime.now().setZone("Asia/Seoul")), 60_000);
    return () => clearInterval(t);
  }, []);
  const market = useMemo(() => getMarketStatus(now), [now]);

  // ---- 계산기 입력 ---------------------------------------------------------
  const [tech, setTech] = useState<Technique>("split3");
  const [symbol, setSymbol] = useState("");
  const [baseClose, setBaseClose] = useState(""); //  전봉 종가(삼분할)
  const [ema200, setEma200] = useState(""); //        EMA200(삼분할)
  const [wallPrice, setWallPrice] = useState(""); //  매수벽 가격(호가창)
  const [barOpen, setBarOpen] = useState(""); //      현재봉 시가(캔들)
  const [tpPct, setTpPct] = useState(String(settings.tpPct));
  const [slPct, setSlPct] = useState(String(settings.slPct));

  // 이번 세션에 쓸 시드 비율(장이 닫혔으면 본장 기준을 준용 — 데스크톱 앱과 같은 규칙)
  const sessionPct =
    market.session === "day" ? settings.dayPct : market.session === "pre" ? settings.prePct : settings.regularPct;

  // ---- 계산 실행(입력이 바뀌면 자동으로) -----------------------------------
  const result = useMemo(() => {
    const tp = num(tpPct);
    const sl = num(slPct);
    if (tp === null || sl === null) return { rows: [], error: null as string | null };

    try {
      if (tech === "split3") {
        const bc = num(baseClose);
        const ema = num(ema200);
        if (bc === null || ema === null) return { rows: [], error: null };
        const { splits } = calcSplit3(bc, ema, tp, sl);
        return { rows: splits.map((s) => ({ label: `${s.level}분할`, entry: s.entry, tp: s.tp, sl: s.sl })), error: null };
      }
      if (tech === "orderbook") {
        const w = num(wallPrice);
        if (w === null) return { rows: [], error: null };
        const o = calcOrderbook(w, getTick(w), tp, sl);
        return { rows: [{ label: "매수벽 +1틱", entry: o.entry, tp: o.tp!, sl: o.sl! }], error: null };
      }
      const b = num(barOpen);
      if (b === null) return { rows: [], error: null };
      const o = calcCandle(b, getTick(b), tp, sl);
      return { rows: [{ label: "시가 −3틱", entry: o.entry, tp: o.tp!, sl: o.sl! }], error: null };
    } catch (e) {
      // 삼분할은 '전봉 종가 > EMA200'이 아니면 진입을 거부한다(상승추세가 아니면 매수 안 함).
      return { rows: [], error: e instanceof Error ? e.message : String(e) };
    }
  }, [tech, baseClose, ema200, wallPrice, barOpen, tpPct, slPct]);

  /** 진입가로 살 수 있는 제안 수량 = 시드 × 세션비율 ÷ 진입가 (데스크톱 앱과 같은 방식) */
  function suggestQty(entry: number): number {
    if (entry <= 0) return 0;
    const budget = (settings.seedUsd * sessionPct) / 100;
    return Math.floor((budget / entry) * 10000) / 10000; // 소수주 지원(토스는 소수점 매매 가능)
  }

  /** 계산 결과를 텍스트로 복사 — 폰에서 토스 앱에 옮겨 적을 때 쓴다 */
  async function copyAll() {
    const lines = result.rows.map(
      (r) => `${r.label} 진입 ${r.entry} / 익절 ${r.tp} / 손절 ${r.sl} / 수량 ${suggestQty(r.entry)}`,
    );
    const text = [`${symbol || "종목"} · ${TECH_LABEL[tech]}`, ...lines].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      alert("복사했습니다. 토스 앱에 붙여 넣어 확인하세요.");
    } catch {
      alert(text); // 복사가 막힌 환경에서는 그냥 보여 준다
    }
  }

  /** 프록시 서버를 통해 시세·환율을 불러온다(키는 요청에만 실려 가고 서버에 저장되지 않음) */
  async function loadLive() {
    const base = settings.apiBase.replace(/\/$/, "");
    if (!base) {
      setApiMsg("설정 탭에 API 주소를 먼저 넣어 주세요(자동조회 서버).");
      return;
    }
    if (!keyId || !keySecret) {
      setApiMsg("토스 키를 입력해 주세요(이 화면에서만 쓰이고 저장되지 않습니다).");
      return;
    }
    setBusy(true);
    setApiMsg(null);
    try {
      const body = { clientId: keyId, clientSecret: keySecret };

      // 환율은 종목과 무관하게 항상 갱신한다.
      const fxRes = await fetch(`${base}/api/fx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const fx = (await fxRes.json()) as { rate?: number; error?: string };
      if (!fxRes.ok) throw new Error(fx.error ?? `환율 조회 실패(${fxRes.status})`);
      if (fx.rate) saveSettings({ ...settings, fxRate: Math.round(fx.rate * 100) / 100 });

      // 종목을 적었으면 현재가도 불러온다.
      if (symbol.trim()) {
        const qRes = await fetch(`${base}/api/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, symbol }),
        });
        const q = (await qRes.json()) as { symbol?: string; price?: number; error?: string };
        if (!qRes.ok) throw new Error(q.error ?? `시세 조회 실패(${qRes.status})`);
        if (q.price) {
          setQuote({ symbol: q.symbol ?? symbol, price: q.price });
          setApiMsg(`${q.symbol} 현재가 ${usd(q.price)} · 환율 ${fx.rate?.toFixed(2)}원 불러옴`);
          return;
        }
      }
      setApiMsg(`환율 ${fx.rate?.toFixed(2)}원 불러옴 (종목을 적으면 현재가도 가져옵니다)`);
    } catch (e) {
      setApiMsg(`⚠ ${e instanceof Error ? e.message : "조회 실패"}`);
    } finally {
      setBusy(false);
    }
  }

  function saveSettings(next: Settings) {
    setSettings(next);
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  }

  return (
    <div className="app">
      {/* ── 새 버전 배너 (설치 없이 업데이트) ────────────────────────────── */}
      {update.ready && (
        <div className="update-banner">
          <span>새 버전이 준비됐습니다.</span>
          <button onClick={update.apply}>지금 업데이트</button>
        </div>
      )}

      <header className="head">
        <div className="brand">
          <img src="./icons/icon-192.png" alt="" width={28} height={28} />
          <b>Capri</b>
        </div>
        {market.closedReason ? (
          <span className="badge warn">
            휴장 · {market.closedReason}
            {market.nextOpen && ` → ${market.nextOpen.setLocale("ko").toFormat("MM-dd(ccc) HH:mm")}`}
          </span>
        ) : (
          <span className="badge ok">
            {SESSION_LABEL[market.session]}
            {market.earlyClose && ` · 조기폐장`}
          </span>
        )}
      </header>

      <nav className="tabs">
        <button className={tab === "calc" ? "on" : ""} onClick={() => setTab("calc")}>
          계산기
        </button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          설정
        </button>
      </nav>

      {tab === "calc" ? (
        <main className="card">
          <div className="row">
            <label>종목(메모용)</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="AAPL" />
          </div>

          {settings.apiBase && (
            <div className="live">
              <div className="row2">
                <div className="row">
                  <label>토스 Client ID (저장 안 함)</label>
                  <input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="키 입력" autoComplete="off" />
                </div>
                <div className="row">
                  <label>Client Secret (저장 안 함)</label>
                  <input
                    type="password"
                    value={keySecret}
                    onChange={(e) => setKeySecret(e.target.value)}
                    placeholder="키 입력"
                    autoComplete="off"
                  />
                </div>
              </div>
              <button className="ghost" disabled={busy} onClick={loadLive}>
                {busy ? "불러오는 중…" : "현재가·환율 불러오기"}
              </button>
              {apiMsg && <p className="hint">{apiMsg}</p>}
              {quote && (
                <p className="hint">
                  참고: {quote.symbol} 현재가 <b>{usd(quote.price)}</b> {krw(quote.price, settings.fxRate)}
                </p>
              )}
            </div>
          )}

          <div className="seg">
            {(Object.keys(TECH_LABEL) as Technique[]).map((t) => (
              <button key={t} className={tech === t ? "on" : ""} onClick={() => setTech(t)}>
                {TECH_LABEL[t]}
              </button>
            ))}
          </div>

          {tech === "split3" && (
            <>
              <div className="row">
                <label>전봉 종가 ($)</label>
                <input inputMode="decimal" value={baseClose} onChange={(e) => setBaseClose(e.target.value)} placeholder="예: 233.50" />
              </div>
              <div className="row">
                <label>EMA200 ($)</label>
                <input inputMode="decimal" value={ema200} onChange={(e) => setEma200(e.target.value)} placeholder="예: 228.10" />
              </div>
            </>
          )}
          {tech === "orderbook" && (
            <div className="row">
              <label>매수벽 가격 ($)</label>
              <input inputMode="decimal" value={wallPrice} onChange={(e) => setWallPrice(e.target.value)} placeholder="예: 230.00" />
            </div>
          )}
          {tech === "candle" && (
            <div className="row">
              <label>현재봉 시가 ($)</label>
              <input inputMode="decimal" value={barOpen} onChange={(e) => setBarOpen(e.target.value)} placeholder="예: 231.20" />
            </div>
          )}

          <div className="row2">
            <div className="row">
              <label>익절 %</label>
              <input inputMode="decimal" value={tpPct} onChange={(e) => setTpPct(e.target.value)} />
            </div>
            <div className="row">
              <label>손절 %</label>
              <input inputMode="decimal" value={slPct} onChange={(e) => setSlPct(e.target.value)} />
            </div>
          </div>

          {result.error && <p className="err">⚠ {result.error}</p>}

          {result.rows.length > 0 && (
            <>
              <div className="hint">
                시드 {usd(settings.seedUsd)} × {sessionPct}%({SESSION_LABEL[market.session]}) 기준 · 환율 {settings.fxRate}원
              </div>
              {result.rows.map((r) => {
                const qty = suggestQty(r.entry);
                const cost = roundPrice(r.entry * qty);
                return (
                  <div className="split" key={r.label}>
                    <div className="split-head">
                      <b>{r.label}</b>
                      <span className="qty">{qty} 주 · {usd(cost)} <span className="won">{krw(cost, settings.fxRate)}</span></span>
                    </div>
                    <div className="grid3">
                      <div>
                        <span className="k">진입</span>
                        <b>{usd(r.entry)}</b>
                        <span className="won">{krw(r.entry, settings.fxRate)}</span>
                      </div>
                      <div className="tp">
                        <span className="k">익절</span>
                        <b>{usd(r.tp)}</b>
                        <span className="won">{krw(r.tp, settings.fxRate)}</span>
                      </div>
                      <div className="sl">
                        <span className="k">손절</span>
                        <b>{usd(r.sl)}</b>
                        <span className="won">{krw(r.sl, settings.fxRate)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <button className="primary" onClick={copyAll}>
                결과 복사하기
              </button>
            </>
          )}

          <p className="note">
            이 웹앱은 <b>계산 전용</b>입니다. 주문은 토스 앱(또는 PC의 Capri)에서 직접 넣으세요.
            원화는 참고용 환산이며 실제 체결은 달러 기준입니다.
          </p>
        </main>
      ) : (
        <main className="card">
          <div className="row">
            <label>시드 금액 ($)</label>
            <input
              inputMode="decimal"
              value={String(settings.seedUsd)}
              onChange={(e) => saveSettings({ ...settings, seedUsd: num(e.target.value) ?? 0 })}
            />
          </div>
          <div className="row2">
            <div className="row">
              <label>데이마켓 %</label>
              <input
                inputMode="decimal"
                value={String(settings.dayPct)}
                onChange={(e) => saveSettings({ ...settings, dayPct: num(e.target.value) ?? 0 })}
              />
            </div>
            <div className="row">
              <label>프리마켓 %</label>
              <input
                inputMode="decimal"
                value={String(settings.prePct)}
                onChange={(e) => saveSettings({ ...settings, prePct: num(e.target.value) ?? 0 })}
              />
            </div>
          </div>
          <div className="row2">
            <div className="row">
              <label>본장 %</label>
              <input
                inputMode="decimal"
                value={String(settings.regularPct)}
                onChange={(e) => saveSettings({ ...settings, regularPct: num(e.target.value) ?? 0 })}
              />
            </div>
            <div className="row">
              <label>환율 (1달러 = ?원)</label>
              <input
                inputMode="decimal"
                value={String(settings.fxRate)}
                onChange={(e) => saveSettings({ ...settings, fxRate: num(e.target.value) ?? 0 })}
              />
            </div>
          </div>
          <div className="row2">
            <div className="row">
              <label>기본 익절 %</label>
              <input
                inputMode="decimal"
                value={String(settings.tpPct)}
                onChange={(e) => {
                  const v = num(e.target.value) ?? 0;
                  saveSettings({ ...settings, tpPct: v });
                  setTpPct(String(v));
                }}
              />
            </div>
            <div className="row">
              <label>기본 손절 %</label>
              <input
                inputMode="decimal"
                value={String(settings.slPct)}
                onChange={(e) => {
                  const v = num(e.target.value) ?? 0;
                  saveSettings({ ...settings, slPct: v });
                  setSlPct(String(v));
                }}
              />
            </div>
          </div>
          <div className="row">
            <label>자동조회 서버 주소 (비우면 계산 전용)</label>
            <input
              value={settings.apiBase}
              onChange={(e) => saveSettings({ ...settings, apiBase: e.target.value.trim() })}
              placeholder="https://capri-api.vercel.app"
              autoComplete="off"
            />
          </div>
          <p className="note">
            토스 키는 <b>어디에도 저장하지 않습니다</b>. 자동조회를 쓸 때 그 순간에만 입력해 쓰고,
            앱을 닫으면 사라집니다. 서버도 키를 저장하지 않고 토스로 전달만 합니다.
          </p>
          <p className="note">
            설정은 <b>이 폰 안에만</b> 저장됩니다(서버로 전송하지 않음). 토스 키는 이 웹앱에 넣지 않습니다.
          </p>
        </main>
      )}

      <footer className="foot">
        버전 {typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"}
        {update.lastCheck && ` · 업데이트 확인 ${update.lastCheck}`}
      </footer>
    </div>
  );
}
