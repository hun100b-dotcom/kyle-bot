// =============================================================================
// src/SyncBanner.tsx — [v0.88.0] 클라우드 동기화 상태 띠 (PC·폰 공통)
// -----------------------------------------------------------------------------
// [왜 만들었나 — 오너 보고 "폰 기록이 9월까지만 있다 / PC는 멀쩡할 수 있다"]
//   PC는 자기 로컬 파일을 읽고 폰은 클라우드(Supabase)를 읽는다. 그래서 PC는 "내가 폰으로 못 올리고 있다"는 걸 전혀 몰랐고,
//   폰은 "이 데이터가 낡았다"는 걸 알 방법이 없었다(9일 넘게 아무도 몰랐다). 이 띠가 양쪽에서 같은 사실을 보여준다:
//     · 각 채널(자동매매 기록·체결 이력·삼분할)이 클라우드에 마지막으로 갱신된 시각 — 실제 DB의 updated_at을 직접 읽은 값
//     · 24시간 넘게 갱신 안 됐거나 이 PC가 열쇠가 없어 못 올리는 중이면 붉게, 이유와 함께
//     · PC에서 잠겨 있으면 로그인 비밀번호를 한 번 입력하는 칸(입력하면 그동안 밀린 기록을 전부 올림)
// =============================================================================

import { useCallback, useEffect, useState } from "react";

function ago(ms: number | null): string {
  if (ms == null) return "기록 없음";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 2) return "방금";
  if (m < 90) return `${m}분 전`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}시간 전` : `${Math.round(h / 24)}일 전`;
}

export default function SyncBanner({ isWebApp, loggedIn }: { isWebApp: boolean; loggedIn: boolean }) {
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await window.kyletool.getSyncStatus?.();
      if (s) setSt(s);
    } catch {
      /* 조회 실패는 띠만 안 보일 뿐 — 다음 주기에 다시 */
    }
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [loggedIn, load]);

  if (!loggedIn || !st || !st.loggedIn) return null;
  const bad = st.locked || st.channels.some((c) => c.stale);
  const err = st.channels.find((c) => c.lastError)?.lastError ?? null;

  async function unlock() {
    setBusy(true);
    setMsg("올리는 중…");
    try {
      const r = await window.kyletool.unlockSync(pw);
      setMsg((r.ok ? "✅ " : "⚠️ ") + r.message);
      if (r.ok) setPw("");
      await load();
    } catch (e) {
      setMsg("⚠️ " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={bad ? "sync-banner bad" : "sync-banner ok"} role={bad ? "alert" : undefined}>
      <div className="sync-line" onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <b>{bad ? (st.locked ? "🔒 동기화 잠김" : "⚠️ 클라우드 기록이 낡았습니다") : "☁️ 클라우드 동기화 정상"}</b>
        {" · "}
        {st.channels.map((c) => `${c.label} ${ago(c.cloudUpdatedAtMs)}`).join(" · ")}
        <span className="hint small"> {open ? "▲" : "▼ 자세히"}</span>
      </div>
      {bad && (
        <p className="hint small" style={{ margin: "4px 0 0" }}>
          {isWebApp
            ? "폰은 PC가 클라우드에 올려 둔 기록을 읽습니다. 위 시각이 오래됐다면 PC가 그 뒤로 기록을 못 올린 것입니다 — PC 앱을 열어 상단의 '동기화 잠김' 안내에 로그인 비밀번호를 한 번 입력해 주세요."
            : st.locked
              ? "이 PC에는 동기화 키가 없어 폰으로 기록을 올리지 못하고 있습니다(앱을 껐다 켜면 비밀번호가 사라지는 구조 때문). 로그인 비밀번호를 한 번 입력하면 그동안 쌓인 기록 전부가 폰으로 올라가고, 이후엔 재시작해도 계속 올라갑니다. 비밀번호 자체는 저장하지 않습니다."
              : "올라가는 중 문제가 있습니다. 아래 사유를 확인하세요. 자동으로 5분마다 다시 시도합니다."}
          {err ? ` (사유: ${err})` : ""}
        </p>
      )}
      {bad && !isWebApp && st.locked && (
        <div className="form-row" style={{ marginTop: 6 }}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="로그인 비밀번호" autoComplete="current-password" onKeyDown={(e) => { if (e.key === "Enter" && pw && !busy) void unlock(); }} />
          <button className="btn" disabled={busy || !pw} onClick={() => void unlock()}>{busy ? "처리 중…" : "🔓 잠금 풀고 전부 올리기"}</button>
        </div>
      )}
      {msg && <p className="hint small" style={{ margin: "4px 0 0" }}>{msg}</p>}
      {open && (
        <table className="result-table" style={{ marginTop: 6 }}>
          <thead><tr><th>채널</th><th>클라우드 마지막 갱신</th><th>이 기기 마지막 성공</th><th>이 기기 마지막 시도 결과</th></tr></thead>
          <tbody>
            {st.channels.map((c) => (
              <tr key={c.key} className={c.stale ? "danger" : undefined}>
                <td>{c.label}</td>
                <td>{c.cloudUpdatedAtMs ? `${new Date(c.cloudUpdatedAtMs).toLocaleString("ko-KR")} (${ago(c.cloudUpdatedAtMs)})` : "—"}</td>
                <td>{c.lastOkMs ? ago(c.lastOkMs) : "—"}</td>
                <td>{c.lastError ?? (c.lastTryMs ? "성공" : "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
