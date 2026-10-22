-- =============================================================================
-- 20261022120000_capri_group_presence_notices.sql
-- [v0.109.0 — 오너 지시 2026-10-22]
--   ① "그룹원 근황 등 동기화가 제대로 안 되는 부분 전수조사 + 실시간 교환"
--   ② "내가 공지를 하면 팀원들이 등록한 웹훅 디스코드로 받을 수 있게"
--
-- [전수조사에서 드러난 구멍]
--   · 그룹원 근황 표가 "자동매매 기록 건수/마지막 매매"뿐 — 상대가 지금 접속 중인지, 자동매매가
--     켜져 있는지, 몇 종목을 들고 있는지, 몇 버전인지는 어디에도 올라가지 않았다
--     (capri_desktop_heartbeat는 본인만 볼 수 있는 표라 그룹원끼리는 못 봄).
--   · 그룹 채팅·업데이트 내역은 탭을 열거나 새로고침을 눌러야만 갱신됐다(자동 갱신 없음).
--   → 이 파일: 그룹 전원이 보는 "접속·상태(presence)" 표 + "공지" 표(+디스코드 자동 발송).
--
-- [Realtime을 안 쓰는 이유] 이 프로젝트는 Realtime 확장이 정상 동작하지 않아(20260930130000 참고)
--   앱이 몇 초마다 가볍게 확인하는 방식(폴링)으로 "실시간"을 만든다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) capri_group_presence — 그룹원 접속·상태 (기기 한 대당 한 줄)
--    기기마다 따로 한 줄을 둔 이유: PC(자동매매 상태)와 폰(접속만)이 서로 덮어쓰지 않게.
--    화면은 사람(user_id)별로 합쳐서 보여준다(하나라도 최근이면 접속 중).
--    ⚠️ 금액·종목명 등 민감값은 담지 않는다(건수·ON/OFF·버전만).
-- -----------------------------------------------------------------------------
create table if not exists public.capri_group_presence (
  user_id            uuid not null references auth.users(id) on delete cascade,
  device_id          text not null check (char_length(device_id) between 1 and 80),
  member_email       text not null,
  platform           text not null default 'pc' check (platform in ('pc', 'web')),
  app_version        text,
  auto_trade_enabled boolean not null default false,
  open_positions     integer not null default 0 check (open_positions >= 0),
  last_seen          timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.capri_group_presence enable row level security;

create index if not exists capri_group_presence_last_seen_idx on public.capri_group_presence (last_seen desc);

-- 읽기: 승인된 그룹원이면 전체(채팅·변경 로그와 같은 원칙).
drop policy if exists capri_group_presence_select_approved on public.capri_group_presence;
create policy capri_group_presence_select_approved on public.capri_group_presence
  for select to authenticated
  using (exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved'));

-- 쓰기: 승인된 본인 이름으로 본인 줄만(남의 상태를 조작 못 하게).
drop policy if exists capri_group_presence_insert_own on public.capri_group_presence;
create policy capri_group_presence_insert_own on public.capri_group_presence
  for insert to authenticated
  with check (
    auth.uid() = user_id and member_email = (auth.jwt() ->> 'email')
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  );

drop policy if exists capri_group_presence_update_own on public.capri_group_presence;
create policy capri_group_presence_update_own on public.capri_group_presence
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and member_email = (auth.jwt() ->> 'email'));

-- 오래된 내 기기 줄 정리용(앱이 하루 한 번 14일 지난 본인 줄을 지운다).
drop policy if exists capri_group_presence_delete_own on public.capri_group_presence;
create policy capri_group_presence_delete_own on public.capri_group_presence
  for delete to authenticated
  using (auth.uid() = user_id);

comment on table public.capri_group_presence is
  '그룹원 접속·상태(기기당 한 줄). 그룹 전원이 읽고 본인 줄만 쓴다. 금액·종목명 없음(건수·ON/OFF·버전만).';

-- -----------------------------------------------------------------------------
-- 2) capri_notices — 오너 공지 (그룹 전원이 앱에서 보고, 디스코드 웹훅 등록자에게는 자동 발송)
-- -----------------------------------------------------------------------------
create table if not exists public.capri_notices (
  id            bigint generated always as identity primary key,
  title         text not null check (char_length(title) between 1 and 100),
  body          text not null check (char_length(body) between 1 and 1500),
  author_email  text not null,
  created_at    timestamptz not null default now(),
  webhook_sent  integer not null default 0   -- 디스코드로 발송을 시도한 팀원 수(트리거가 채움)
);
alter table public.capri_notices enable row level security;

create index if not exists capri_notices_created_at_idx on public.capri_notices (created_at desc);

drop policy if exists capri_notices_select_approved on public.capri_notices;
create policy capri_notices_select_approved on public.capri_notices
  for select to authenticated
  using (exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved'));

-- 쓰기·삭제는 오너 계정만(capri_changelog와 동일 원칙).
drop policy if exists capri_notices_insert_owner on public.capri_notices;
create policy capri_notices_insert_owner on public.capri_notices
  for insert to authenticated
  with check ((auth.jwt() ->> 'email') = 'hun100b@gmail.com' and author_email = 'hun100b@gmail.com');

drop policy if exists capri_notices_delete_owner on public.capri_notices;
create policy capri_notices_delete_owner on public.capri_notices
  for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

comment on table public.capri_notices is
  '오너 공지. 그룹 전원이 읽고 오너만 쓴다. 등록 시 DB 트리거가 팀원들이 등록해 둔 디스코드 웹훅(capri_user_notify_settings)으로 자동 발송한다.';

-- -----------------------------------------------------------------------------
-- 3) 공지가 올라오면 → 승인된 팀원 중 웹훅을 등록한 사람 전원에게 디스코드 발송
--    · DB가 직접 쏘므로 누구의 앱이 꺼져 있어도 도착한다(새 가입 알림과 같은 방식, pg_net).
--    · 웹훅 주소 모양이 디스코드가 아니면 건너뛴다(엉뚱한 주소로 요청을 보내지 않게).
--    · 한 사람 발송이 실패해도 나머지는 계속 보낸다. @everyone 같은 멘션은 막는다.
--    · 팀원이 등록한 웹훅 주소는 본인만 읽을 수 있다 — 이 함수(security definer)만 서버 안에서 읽고, 오너에게도 노출되지 않는다.
-- -----------------------------------------------------------------------------
create extension if not exists pg_net;

create or replace function public.capri_notify_notice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  v_sent integer := 0;
  v_text text;
begin
  v_text := left(
    format(E'📢 **Capri 공지 — %s**\n%s\n\n— %s', new.title, new.body, split_part(new.author_email, '@', 1)),
    1900
  );
  for r in
    select s.discord_webhook_url as url
    from public.capri_user_notify_settings s
    join public.capri_accounts a on a.user_id = s.user_id and a.status = 'approved'
    where s.discord_webhook_url ~ '^https://((ptb|canary)\.)?(discord|discordapp)\.com/api/webhooks/'
  loop
    begin
      perform net.http_post(
        url := r.url,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('content', v_text, 'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb))
      );
      v_sent := v_sent + 1;
    exception when others then
      null; -- 한 명 실패는 건너뛰고 계속
    end;
  end loop;
  update public.capri_notices set webhook_sent = v_sent where id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_capri_notify_notice on public.capri_notices;
create trigger trg_capri_notify_notice
  after insert on public.capri_notices
  for each row execute function public.capri_notify_notice();

revoke execute on function public.capri_notify_notice() from public, anon, authenticated;
