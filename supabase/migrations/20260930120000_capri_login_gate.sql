-- =============================================================================
-- 20260930120000_capri_login_gate.sql
-- 로그인 체계 전면 전환: "가입은 항상 되고, 승인 전엔 데이터 접근만 막는다"
-- -----------------------------------------------------------------------------
-- [오너 요청, 2026-09-30]
--   "카프리를 켜면 로그인 화면이 먼저 나오고, 로그인만 하면 끝나야 한다. 가입 기능도
--   그 화면에 넣고, 가입 즉시는 쓸 수 없게(pending) 하고, 승인은 내가 폰이든 PC든
--   아무 때나 할 수 있어야 한다. 새 가입 요청은 디스코드로 알림도 오게."
--
-- [예전 모델(20260923010000)과 무엇이 다른가]
--   예전: capri_auth_gate 트리거가 "허용목록(capri_allowed_emails)에 없으면 가입 자체를
--   막는다"(회원가입 시도가 500으로 실패). 그래서 승인 전에는 계정이 아예 존재하지 않았고,
--   "승인 대기 화면"이라는 게 있을 수 없었다(로그인할 계정이 없으니까) — 대신 별도
--   "승인 요청함"(capri_access_requests)에 이메일만 접수하는 우회 절차가 있었다.
--
--   지금: 가입은 **항상 성공**한다(트리거는 이제 막지 않고 이메일 자동확인만 한다).
--   대신 가입 직후 새 표 capri_accounts에 status='pending' 행이 자동으로 생기고,
--   **매매 데이터(capri_secrets·capri_trades·capri_auto_state)는 이 상태가 'approved'가
--   아니면 RLS가 서버에서 통째로 막는다.** 화면은 pending이면 "승인 대기 중" 화면만
--   보여주지만, 이건 UX일 뿐이고 진짜 차단은 이 마이그레이션의 RLS다(오너 지시:
--   "화면에서만 막으면 안 된다").
--
-- [기존 이용자는?] 이 마이그레이션 적용 시점에 이미 auth.users에 있는 계정(오너 +
--   기존에 허용목록을 통해 가입한 동료들)은 전부 status='approved'로 일괄 채워 넣는다
--   (아래 2번) — 재승인을 요구하지 않는다.
--
-- [capri_allowed_emails·capri_access_requests는?] 지우지 않는다. capri_group_trades·
--   capri_group_chat이 지금도 capri_allowed_emails를 기준으로 "그룹 전체 실명 공유"
--   범위를 정하고 있어서, 그 두 표의 RLS 정책은 이 마이그레이션에서 건드리지 않는다.
--   대신 capri_accounts가 'approved'로 바뀔 때마다 capri_allowed_emails에도 자동으로
--   같이 반영되도록 트리거로 동기화한다(6번) — 그룹 기능은 손대지 않고도 계속 정확하게
--   맞물려 돌아간다. capri_access_requests(옛 "승인 요청함")도 그대로 둔다 — 화면의
--   "이메일 직접 등록" 보조 경로가 여전히 그 표를 쓴다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) capri_accounts — 가입 승인 상태(진짜 게이트)
-- -----------------------------------------------------------------------------
create table if not exists public.capri_accounts (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,          -- 오너가 승인/거절한 시각(대기 중이면 NULL)
  decided_by   text                  -- 결정한 오너의 이메일(추적용)
);
alter table public.capri_accounts enable row level security;

comment on table public.capri_accounts is
  '가입 승인 상태(진짜 게이트). approved가 아니면 RLS가 매매 데이터 접근을 서버에서 차단한다.';

-- 본인 행만 조회 가능(승인 대기 화면이 "내 상태가 뭔지" 확인하는 용도).
drop policy if exists "capri_accounts_select_own" on public.capri_accounts;
create policy "capri_accounts_select_own" on public.capri_accounts
  for select to authenticated
  using (auth.uid() = user_id);

-- 오너는 전체 조회 + 승인/거절(update) 가능. insert/delete는 클라이언트가 직접 못 한다
-- (계정 생성은 아래 3)의 트리거만 한다 — 스스로 승인 상태를 조작하는 경로를 원천 차단).
drop policy if exists "capri_accounts_owner_select_all" on public.capri_accounts;
create policy "capri_accounts_owner_select_all" on public.capri_accounts
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

drop policy if exists "capri_accounts_owner_update" on public.capri_accounts;
create policy "capri_accounts_owner_update" on public.capri_accounts
  for update to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');


-- -----------------------------------------------------------------------------
-- 2) 기존 이용자 일괄 승인 — 이미 가입돼 있던 계정은 재승인 없이 그대로 쓸 수 있게.
-- -----------------------------------------------------------------------------
insert into public.capri_accounts (user_id, email, status, requested_at, decided_at, decided_by)
select
  u.id,
  lower(u.email),
  'approved',
  u.created_at,
  now(),
  'migration-backfill(기존 이용자 일괄승인)'
from auth.users u
on conflict (user_id) do nothing;


-- -----------------------------------------------------------------------------
-- 3) 가입 게이트를 "막기"에서 "표시만"으로 전환 + 신규 가입 시 자동으로 pending 계정 생성
-- -----------------------------------------------------------------------------
-- 3-1) capri_auth_gate: 더 이상 예외를 던지지 않는다(가입을 막지 않는다). 이메일
--   자동확인(바로 로그인)만 그대로 유지 — 기존 v0.8.2 정책과 동일.
create or replace function public.capri_auth_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.email_confirmed_at := now();
  return new;
end;
$$;
-- 트리거 자체는 이미 걸려 있으므로 새로 만들 필요 없음(함수 본문만 create or replace로 교체).

-- 3-2) 신규 가입이 끝난 뒤(AFTER INSERT — user_id가 이미 존재해야 하므로) capri_accounts
--   행을 자동으로 만든다. 오너 이메일이거나 이미 허용목록에 있던 이메일(과거에 허용됐던
--   사람이 다시 가입하는 드문 경우 대비)이면 바로 승인, 그 외엔 대기(pending).
create or replace function public.capri_create_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if lower(new.email) = 'hun100b@gmail.com'
     or exists (select 1 from public.capri_allowed_emails where email = lower(new.email))
  then
    v_status := 'approved';
  else
    v_status := 'pending';
  end if;

  insert into public.capri_accounts (user_id, email, status, requested_at, decided_at, decided_by)
  values (
    new.id,
    lower(new.email),
    v_status,
    now(),
    case when v_status = 'approved' then now() end,
    case when v_status = 'approved' then 'auto(허용목록/오너)' end
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_capri_create_account on auth.users;
create trigger trg_capri_create_account
  after insert on auth.users
  for each row execute function public.capri_create_account();

-- 트리거 전용 함수라 REST RPC로 직접 호출될 필요가 없다(20260923020000과 같은 원칙).
revoke execute on function public.capri_create_account() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4) capri_secrets · capri_trades · capri_auto_state — "approved만" 접근 가능하게 RLS 강화
-- -----------------------------------------------------------------------------
-- [왜 기존 정책 이름을 미리 알 필요가 없게 짰나] capri_secrets는 이 저장소의 git 이력에
--   CREATE TABLE이 없다(예전에 대시보드 SQL 편집기로 직접 만들어짐 — 이 마이그레이션을
--   작성하는 시점엔 실제 서버의 정책 이름을 조회할 방법이 없었다). 이름을 잘못 짚어
--   DROP POLICY가 조용히 아무 일도 안 하면, 옛 정책이 새 정책과 함께 "OR"로 남아
--   approved 조건이 사실상 무력화된다(Postgres RLS는 같은 명령에 대해 permissive
--   정책이 여러 개면 하나라도 통과하면 허용). 그래서 이름을 추측하지 않고, 각 표에
--   걸린 정책을 전부 조회해 무조건 지운 뒤 새로 만든다 — 이름이 뭐였든 안전하다.
do $$
declare
  pol record;
  tbl text;
begin
  foreach tbl in array array['capri_secrets', 'capri_trades', 'capri_auto_state']
  loop
    if to_regclass('public.' || tbl) is not null then
      execute format('alter table public.%I enable row level security', tbl);
      for pol in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = tbl
      loop
        execute format('drop policy if exists %I on public.%I', pol.policyname, tbl);
      end loop;

      execute format(
        'create policy %I on public.%I for select to authenticated
           using (auth.uid() = user_id and exists (
             select 1 from public.capri_accounts a
             where a.user_id = auth.uid() and a.status = ''approved''
           ))',
        tbl || '_select_own_approved', tbl
      );
      execute format(
        'create policy %I on public.%I for insert to authenticated
           with check (auth.uid() = user_id and exists (
             select 1 from public.capri_accounts a
             where a.user_id = auth.uid() and a.status = ''approved''
           ))',
        tbl || '_insert_own_approved', tbl
      );
      execute format(
        'create policy %I on public.%I for update to authenticated
           using (auth.uid() = user_id and exists (
             select 1 from public.capri_accounts a
             where a.user_id = auth.uid() and a.status = ''approved''
           ))
           with check (auth.uid() = user_id and exists (
             select 1 from public.capri_accounts a
             where a.user_id = auth.uid() and a.status = ''approved''
           ))',
        tbl || '_update_own_approved', tbl
      );
    end if;
  end loop;
end $$;


-- -----------------------------------------------------------------------------
-- 5) capri_allowed_emails 자동 동기화 — capri_accounts가 approved로 바뀔 때마다
--    그룹 표(capri_group_trades·capri_group_chat)가 쓰는 허용목록에도 반영한다.
--    (그 두 표의 RLS는 이 마이그레이션에서 손대지 않는다 — 이미 잘 동작 중이므로
--    허용목록만 정확히 맞춰 주면 계속 올바르게 작동한다.)
-- -----------------------------------------------------------------------------
create or replace function public.capri_sync_allowed_emails()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' then
    insert into public.capri_allowed_emails (email, note)
    values (new.email, '앱에서 승인(capri_accounts 동기화)')
    on conflict (email) do nothing;
  elsif old.status = 'approved' and new.status <> 'approved' then
    delete from public.capri_allowed_emails where email = new.email;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_capri_sync_allowed_emails on public.capri_accounts;
create trigger trg_capri_sync_allowed_emails
  after update on public.capri_accounts
  for each row execute function public.capri_sync_allowed_emails();

revoke execute on function public.capri_sync_allowed_emails() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 6) capri_notify_settings — 디스코드 웹훅 주소(오너만 읽고 쓸 수 있음)
-- -----------------------------------------------------------------------------
-- [왜 .env가 아니라 DB 표인가] 알림은 "누가 가입 신청을 했다"는 이벤트가 DB(Postgres)
--   에서 일어나는 순간 쏴야 한다 — 어떤 기기의 앱이 켜져 있는지와 무관하게 항상 울려야
--   하기 때문이다(오너 요청: "언제 어디서든"). 그래서 DB 트리거(7번)가 직접 디스코드로
--   쏘고, 그 트리거가 읽을 주소를 이 표에 "오너만 쓸 수 있는" 설정 한 줄로 둔다. 값은
--   기본 비워 둔다 — 오너가 [그룹원 관리] 화면에서 디스코드 웹훅 주소를 붙여넣으면
--   그때부터 알림이 나가기 시작한다(SQL 편집기 없이 앱 안에서 설정 가능).
create table if not exists public.capri_notify_settings (
  id                 boolean primary key default true check (id),  -- 항상 한 행만 존재
  discord_webhook_url text,
  updated_at         timestamptz not null default now()
);
alter table public.capri_notify_settings enable row level security;
insert into public.capri_notify_settings (id) values (true) on conflict (id) do nothing;

drop policy if exists "capri_notify_settings_owner_all" on public.capri_notify_settings;
create policy "capri_notify_settings_owner_all" on public.capri_notify_settings
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

comment on table public.capri_notify_settings is
  '디스코드 웹훅 주소 등 알림 설정(오너 전용, 항상 한 행). 값이 비어 있으면 알림을 보내지 않는다.';


-- -----------------------------------------------------------------------------
-- 7) 새 가입 대기(pending) 발생 시 디스코드로 알림 — 승인 화면 직행 링크 포함
-- -----------------------------------------------------------------------------
-- pg_net: Postgres에서 바깥 HTTP로 요청을 쏘는 Supabase 확장. 트리거 안에서 비동기로
--   큐에 넣기만 하고 바로 반환하므로(가입 절차 자체를 늦추지 않음) 안전하다.
create extension if not exists pg_net;

create or replace function public.capri_notify_new_pending_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_webhook text;
begin
  if new.status <> 'pending' then
    return new;
  end if;
  select discord_webhook_url into v_webhook from public.capri_notify_settings where id = true;
  if v_webhook is null or v_webhook = '' then
    return new; -- 웹훅 주소를 아직 설정 안 했으면 조용히 아무 일도 안 함
  end if;

  perform net.http_post(
    url := v_webhook,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'content',
      format(
        E'🔔 Capri 새 가입 승인 요청\n· 이메일: %s\n· 신청 시각: %s\n👉 지금 승인하기: https://hun100b-dotcom.github.io/capri-web/#/approve',
        new.email,
        to_char(new.requested_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')
      )
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_capri_notify_new_pending on public.capri_accounts;
create trigger trg_capri_notify_new_pending
  after insert on public.capri_accounts
  for each row execute function public.capri_notify_new_pending_account();

revoke execute on function public.capri_notify_new_pending_account() from public, anon, authenticated;


-- -----------------------------------------------------------------------------
-- 8) 적용 확인용 쿼리(참고 — 이 파일 실행에는 필요 없음, 오너/다음 세션이 눈으로 확인할 때 씀)
-- -----------------------------------------------------------------------------
-- select user_id, email, status, decided_by from public.capri_accounts order by requested_at desc limit 20;
-- select policyname, cmd from pg_policies where schemaname='public' and tablename in ('capri_secrets','capri_trades','capri_auto_state');
