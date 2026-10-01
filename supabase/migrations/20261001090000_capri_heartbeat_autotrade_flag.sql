-- [v0.60.4 — 오너 실사용 보고] 폰에서 자동매매 시작/중지를 눌러도 "지금 실제로 PC에서
-- 돌고 있는지"를 폰이 알 방법이 없었다. capri_desktop_heartbeat는 지금까지 "PC가
-- 살아있는지"(last_seen)만 실어 날랐고, "지금 자동매매가 켜져 있는지"는 안 실어
-- 날랐다(v0.59.0 당시 이미 남겨둔 한계 — docs/progress.md 참고). PC가 8초마다 보내는
-- 생존 신호에 이 값을 함께 실어, 폰이 20초마다 같은 신호를 볼 때 PC의 진짜 상태를
-- 그대로 보여줄 수 있게 한다.
alter table public.capri_desktop_heartbeat
  add column if not exists auto_trade_enabled boolean not null default false;
