-- =============================================================================
-- 20261022130000_capri_announcements.sql
-- 오너 공지 → 팀원 각자가 등록한 디스코드 웹훅으로 발송 (v0.109.0)
-- -----------------------------------------------------------------------------
-- [오너 지시 2026-10-22] "내가 공지를 하면 팀원들이 등록한 웹훅 디스코드로 받을 수 있게."
--
-- [왜 서버(DB 함수)에서 보내나]
--   팀원의 웹훅 주소는 비밀값이라 capri_user_notify_settings 가 "본인 행만" 읽히도록
--   잠겨 있다(오너 앱도 남의 주소를 읽을 수 없다). 그래서 오너 앱이 직접 쏘는 방식은 불가능하고,
--   주소를 읽을 수 있는 서버 쪽 함수(security definer)가 대신 보낸다. 주소는 이 함수 안에서만
--   쓰이고 어떤 표·로그·화면에도 복사하지 않는다(결과 표에는 "누구에게 성공/실패"만 남는다).
-- [재시도] pg_net 은 요청을 큐에 넣고 바로 돌아온다. 결과는 net._http_response 에 쌓이므로,
--   상태 조회(capri_announce_status)가 불릴 때 결과를 반영하고, 일시 오류(429·5xx·시간초과)는
--   최대 3번까지 자동 재전송한다. 주소가 틀린 경우(404·401·403)는 재시도해도 소용없으니 실패로 확정.
-- =============================================================================

create extension if not exists pg_net;

-- 1) 공지 본문 ----------------------------------------------------------------
create table if not exists public.capri_announcements (
  id         bigint generated always as identity primary key,
  title      text not null,
  body       text not null,
  created_by text not null,                       -- 보낸 사람(오너 이메일)
  created_at timestamptz not null default now()
);
alter table public.capri_announcements enable row level security;

-- 승인된 그룹원은 공지 내용을 읽을 수 있다(디스코드 못 받았을 때 앱에서 확인용). 쓰기 정책은 없음 → 함수로만 작성.
drop policy if exists "capri_announcements_select_members" on public.capri_announcements;
create policy "capri_announcements_select_members" on public.capri_announcements
  for select to authenticated
  using (exists (select 1 from public.capri_allowed_emails a where a.email = (auth.jwt() ->> 'email')));

-- 2) 사람별 발송 결과 (웹훅 주소는 저장하지 않는다) ---------------------------------
create table if not exists public.capri_announcement_deliveries (
  id              bigint generated always as identity primary key,
  announcement_id bigint not null references public.capri_announcements(id) on delete cascade,
  user_id         uuid not null,
  member_email    text not null,
  status          text not null default 'pending'
                  check (status in ('pending','sent','failed','no_webhook')),
  attempts        int not null default 0,
  request_id      bigint,                         -- pg_net 요청 번호(결과 조회용)
  http_status     int,
  error           text,
  last_attempt_at timestamptz,
  unique (announcement_id, user_id)
);
alter table public.capri_announcement_deliveries enable row level security;
-- 정책을 일부러 두지 않는다 → 직접 조회·수정 불가. 오너는 아래 함수로만 본다.

-- 3) 내부: 한 명에게 보내기(웹훅 주소는 여기서만 읽는다) -----------------------------
create or replace function public.capri_announce_dispatch(p_delivery_id bigint)
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  d record;
  a record;
  v_url text;
  v_req bigint;
begin
  select * into d from public.capri_announcement_deliveries where id = p_delivery_id;
  if not found then return; end if;
  select * into a from public.capri_announcements where id = d.announcement_id;

  select discord_webhook_url into v_url from public.capri_user_notify_settings where user_id = d.user_id;
  if v_url is null or btrim(v_url) = '' then
    update public.capri_announcement_deliveries
       set status = 'no_webhook', error = '웹훅 미등록' where id = d.id;
    return;
  end if;
  -- 디스코드 웹훅 주소 모양만 허용(엉뚱한 주소로 요청이 나가는 것 방지 — SSRF 방어)
  if v_url !~ '^https://(discord|discordapp)\.com/api/webhooks/' then
    update public.capri_announcement_deliveries
       set status = 'failed', error = '디스코드 웹훅 주소 모양이 아님' where id = d.id;
    return;
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'content', left(format(E'📢 **%s**\n%s', a.title, a.body), 1990),
      'allowed_mentions', jsonb_build_object('parse', jsonb_build_array())  -- @everyone 등 멘션 폭탄 방지
    )
  ) into v_req;

  update public.capri_announcement_deliveries
     set status = 'pending', attempts = attempts + 1, request_id = v_req,
         http_status = null, error = null, last_attempt_at = now()
   where id = d.id;
end;
$$;
revoke execute on function public.capri_announce_dispatch(bigint) from public, anon, authenticated;

-- 4) 오너 전용: 공지 발송 -----------------------------------------------------------
create or replace function public.capri_announce_send(p_title text, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  r record;
  d_id bigint;
begin
  if (auth.jwt() ->> 'email') is distinct from 'hun100b@gmail.com' then
    raise exception '공지는 운영자만 보낼 수 있습니다.';
  end if;
  if btrim(coalesce(p_title, '')) = '' or btrim(coalesce(p_body, '')) = '' then
    raise exception '제목과 내용을 모두 입력하세요.';
  end if;
  if char_length(p_title) > 100 or char_length(p_body) > 1700 then
    raise exception '제목은 100자, 내용은 1700자까지 보낼 수 있습니다.';
  end if;

  insert into public.capri_announcements (title, body, created_by)
  values (btrim(p_title), btrim(p_body), auth.jwt() ->> 'email')
  returning id into v_id;

  -- 받는 사람 = 승인된 그룹원 전원(오너 본인 포함 — 내 웹훅으로 도착 확인도 된다)
  for r in select user_id, email from public.capri_accounts where status = 'approved' loop
    insert into public.capri_announcement_deliveries (announcement_id, user_id, member_email)
    values (v_id, r.user_id, r.email)
    returning id into d_id;
    perform public.capri_announce_dispatch(d_id);
  end loop;
  return v_id;
end;
$$;

-- 5) 오너 전용: 결과 반영 + 자동 재시도 + 조회 ---------------------------------------
create or replace function public.capri_announce_status(p_id bigint)
returns table (member_email text, status text, attempts int, http_status int, error text)
language plpgsql
security definer
set search_path = public, net
as $$
#variable_conflict use_column
declare
  d record;
  resp record;
begin
  if (auth.jwt() ->> 'email') is distinct from 'hun100b@gmail.com' then
    raise exception '운영자만 볼 수 있습니다.';
  end if;

  for d in select * from public.capri_announcement_deliveries
            where announcement_id = p_id and status = 'pending' and request_id is not null loop
    select r.status_code, r.timed_out, r.error_msg into resp
      from net._http_response r where r.id = d.request_id;
    if not found then
      -- 5분이 지나도 결과가 안 오면 유실로 보고 실패 처리(재시도 대상)
      if d.last_attempt_at < now() - interval '5 minutes' then
        update public.capri_announcement_deliveries
           set status = 'failed', error = '응답 없음(시간초과)' where id = d.id;
      end if;
    elsif resp.status_code between 200 and 299 then
      update public.capri_announcement_deliveries
         set status = 'sent', http_status = resp.status_code, error = null where id = d.id;
    else
      update public.capri_announcement_deliveries
         set status = 'failed', http_status = resp.status_code,
             error = coalesce(resp.error_msg,
                     case when resp.timed_out then '시간초과'
                          when resp.status_code in (401,403) then '디스코드가 주소 사용을 거부함'
                          when resp.status_code = 404 then '웹훅이 삭제됐거나 주소가 틀림'
                          else 'HTTP ' || resp.status_code end)
       where id = d.id;
    end if;
  end loop;

  -- 일시 오류(429·5xx·시간초과·응답없음)만 최대 3회까지 자동 재전송
  for d in select * from public.capri_announcement_deliveries
            where announcement_id = p_id and status = 'failed' and attempts < 3
              and (http_status is null or http_status = 429 or http_status >= 500)
              and coalesce(error, '') <> '디스코드 웹훅 주소 모양이 아님' loop
    perform public.capri_announce_dispatch(d.id);
  end loop;

  return query
    select x.member_email, x.status, x.attempts, x.http_status, x.error
      from public.capri_announcement_deliveries x
     where x.announcement_id = p_id
     order by x.member_email;
end;
$$;

-- 6) 오너 전용: 최근 공지 목록(요약) --------------------------------------------------
create or replace function public.capri_announce_list(p_limit int default 10)
returns table (id bigint, title text, body text, created_at timestamptz,
               sent int, failed int, pending int, no_webhook int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if (auth.jwt() ->> 'email') is distinct from 'hun100b@gmail.com' then
    raise exception '운영자만 볼 수 있습니다.';
  end if;
  return query
    select a.id, a.title, a.body, a.created_at,
           count(*) filter (where d.status = 'sent')::int,
           count(*) filter (where d.status = 'failed')::int,
           count(*) filter (where d.status = 'pending')::int,
           count(*) filter (where d.status = 'no_webhook')::int
      from public.capri_announcements a
      left join public.capri_announcement_deliveries d on d.announcement_id = a.id
     group by a.id
     order by a.id desc
     limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

-- 7) 오너 전용: 실패분 수동 재전송 (자동 재시도 3회를 다 쓴 경우 등) --------------------
create or replace function public.capri_announce_retry(p_id bigint)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
  n int := 0;
begin
  if (auth.jwt() ->> 'email') is distinct from 'hun100b@gmail.com' then
    raise exception '운영자만 보낼 수 있습니다.';
  end if;
  for d in select id from public.capri_announcement_deliveries
            where announcement_id = p_id and status in ('failed', 'no_webhook') loop
    perform public.capri_announce_dispatch(d.id);   -- 그새 웹훅을 등록한 사람도 이때 받는다
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 오너 확인은 함수 안에서 하므로 로그인 사용자에게 실행 권한을 연다(익명은 불가).
revoke execute on function public.capri_announce_send(text, text) from public, anon;
revoke execute on function public.capri_announce_status(bigint) from public, anon;
revoke execute on function public.capri_announce_list(int) from public, anon;
revoke execute on function public.capri_announce_retry(bigint) from public, anon;
grant execute on function public.capri_announce_send(text, text) to authenticated;
grant execute on function public.capri_announce_status(bigint) to authenticated;
grant execute on function public.capri_announce_list(int) to authenticated;
grant execute on function public.capri_announce_retry(bigint) to authenticated;
