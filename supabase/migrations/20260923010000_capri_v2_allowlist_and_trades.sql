-- =============================================================================
-- 20260923010000_capri_v2_allowlist_and_trades.sql
-- Capri 회원제 전환: "허용된 사람만 가입" + "동기화는 로그인 비밀번호 하나로"
-- -----------------------------------------------------------------------------
-- [오너 요청, 2026-09-23]
--   ① "누구나 자기 토스 API를 연결해 카프리를 쓸 수 있어야 한다. 단 몇 명까지
--      쓸지는 내가 정한다." → 아래 1)·2)가 이걸 처리한다(허용목록 + 가입 게이트).
--   ② "동기화가 너무 복잡하다 — 가장 간단하고 확실한 방법으로." → 아래 3)이 이걸
--      처리한다. 예전엔 로그인 비밀번호 + 키 잠금 비밀번호 + 매매이력 동기화
--      비밀번호, 이렇게 비밀번호가 3개였다(그마저 매매이력은 GitHub 공개 저장소에
--      올리는 방식이라 일반 사용자 PC에선 아예 작동도 안 했다). 이제는 매매 이력도
--      토스 키(capri_secrets)와 "완전히 같은 방식"으로 Supabase에 저장해서,
--      비밀번호는 로그인 비밀번호 하나만 쓴다.
--   ③ [추가 요청] "허용 인원을 오너한테 SQL로 부탁하는 건 PC가 꺼져 있으면 못 하는
--      방법이라 대안이 필요하다" → 4)가 이걸 처리한다. Supabase SQL 편집기 대신
--      **카프리 앱 안에서** 오너 계정으로 로그인해 승인 요청을 보고 [승인] 누르는
--      화면을 만든다. 오너는 폰(웹앱)으로도, PC 없이도 아무 때나 승인할 수 있다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) capri_allowed_emails — "이 이메일은 가입해도 된다" 허용목록
-- -----------------------------------------------------------------------------
-- [RLS 정책(policy) — 오너 계정만 API로 손댈 수 있게 한다]
--   RLS를 켜고, "로그인한 사람의 이메일이 오너 이메일과 같을 때만" 전부(조회/추가/
--   수정/삭제) 허용하는 정책 하나만 둔다. 그 밖의 모든 사람(비로그인·다른 계정)은
--   기본값(RLS는 정책에 없으면 전부 차단)대로 이 표를 절대 못 본다.
--   → 오너는 카프리 앱 안(설정 탭 → 가입 승인)에서 로그인만 하면 이 표를 바로
--     다룰 수 있다. PC가 꺼져 있어도, Supabase 사이트에 안 들어가도, 폰 앱으로 된다.
--   [왜 이메일을 SQL에 그대로 박아 넣나?] 오너가 딱 한 명뿐인 개인용 도구라, 별도
--   "관리자 역할(role)" 표를 만드는 것 자체가 불필요한 복잡함이다. 오너 이메일이
--   바뀌면 이 마이그레이션에 새 파일을 하나 더 추가해 정책만 바꾸면 된다.
create table if not exists public.capri_allowed_emails (
  email    text primary key,   -- 항상 소문자로 저장(아래 트리거가 강제)
  note     text,               -- 누구인지 메모(선택, 예: '지인 A')
  added_at timestamptz not null default now()
);
alter table public.capri_allowed_emails enable row level security;

create policy "capri_allowed_emails_owner_all" on public.capri_allowed_emails
  for all
  to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

comment on table public.capri_allowed_emails is
  '가입 허용 이메일 목록. RLS로 오너 계정(hun100b@gmail.com)만 API로 관리 가능(앱 안에서 승인).';

-- 이메일을 어떤 대소문자로 넣든 항상 소문자로 저장(가입 검사와 비교 기준을 통일).
create or replace function public.capri_lower_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(new.email);
  return new;
end;
$$;

drop trigger if exists trg_capri_allowed_emails_lower on public.capri_allowed_emails;
create trigger trg_capri_allowed_emails_lower
  before insert or update on public.capri_allowed_emails
  for each row execute function public.capri_lower_email();

-- 오너 계정은 바로 허용(이미 가입돼 있어도 무해 — 기존 가입을 막지 않는다).
insert into public.capri_allowed_emails (email, note)
values ('hun100b@gmail.com', '오너')
on conflict (email) do nothing;


-- -----------------------------------------------------------------------------
-- 2) 가입 게이트 — 허용목록에 없는 이메일은 가입 자체가 안 되게 막는다
-- -----------------------------------------------------------------------------
-- [왜 앱 코드가 아니라 DB 트리거로 막나 = "확실한" 방법]
--   앱 화면에서 "가입 전에 허용목록부터 확인"하는 방식도 될 것 같지만, 그러면 그
--   확인을 건너뛰는 경로(다른 화면·다른 기기·미래의 실수)가 생길 여지가 있다.
--   대신 auth.users 에 행이 "생기기 바로 직전"을 DB가 가로막으면, 가입 시도가 어느
--   경로로 들어오든 100% 걸러진다.
-- [기존 자동확인(auto-confirm) 트리거와의 관계]
--   v0.8.2 에서 "가입하면 확인메일 클릭 없이 바로 로그인"되게 만든 트리거가 이미
--   있다. 이 함수가 그 일도 함께 한다(허용 확인 → 통과하면 이메일 자동확인까지
--   한 번에). 기존 트리거가 남아 있어도 같은 값을 한 번 더 채울 뿐이라 무해하다.
create or replace function public.capri_auth_gate()
returns trigger
language plpgsql
security definer  -- 가입 시도자는 아직 로그인 전이라 위 허용목록 표를 읽을 권한이
                   --   없다. 이 함수만은 "표 소유자 권한"으로 돌아 허용목록을 읽는다.
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.capri_allowed_emails
    where email = lower(new.email)
  ) then
    raise exception 'CAPRI_NOT_ALLOWED: 아직 사용 승인이 안 된 이메일입니다. 운영자에게 사용 신청을 해주세요.';
  end if;

  -- 승인된 이메일이면: 확인메일 클릭 없이 바로 로그인되게(v0.8.2 정책 유지).
  new.email_confirmed_at := now();
  return new;
end;
$$;

drop trigger if exists trg_capri_auth_gate on auth.users;
create trigger trg_capri_auth_gate
  before insert on auth.users
  for each row execute function public.capri_auth_gate();


-- -----------------------------------------------------------------------------
-- 3) capri_trades — 매매 이력을 "토스 키(capri_secrets)와 완전히 같은 방식"으로 저장
-- -----------------------------------------------------------------------------
-- [왜 굳이 capri_secrets 와 똑같은 모양으로 만드나]
--   보안·동기화 방식을 표마다 다르게 가져가면 그 자체가 또 다른 "복잡함"이 된다.
--   그래서 토스 키(capri_secrets)와 매매 이력(capri_trades)을 완전히 같은 패턴으로
--   맞춘다: 유저 1명당 행 1개, 평문은 절대 들어오지 않고 암호문(ciphertext/salt/iv)만
--   저장, RLS로 "내 것은 나만" 접근. 앱은 로그인 비밀번호로 암호화/복호화하므로
--   사용자가 따로 외울 비밀번호가 없다.
create table if not exists public.capri_trades (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ciphertext text not null,
  salt       text not null,
  iv         text not null,
  updated_at timestamptz not null default now()
);
alter table public.capri_trades enable row level security;

create policy "capri_trades_select_own" on public.capri_trades
  for select to authenticated
  using (auth.uid() = user_id);

create policy "capri_trades_insert_own" on public.capri_trades
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy "capri_trades_update_own" on public.capri_trades
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table public.capri_trades is
  '매매 이력(체결 결과)을 로그인 비밀번호로 암호화해 보관. 평문 없음. RLS로 본인 행만 접근.';


-- -----------------------------------------------------------------------------
-- 4) capri_access_requests — "저 좀 승인해 주세요" 요청함 (앱 안에서 오너가 처리)
-- -----------------------------------------------------------------------------
-- [흐름] 허용목록에 없는 이메일로 가입을 시도하면 2)의 게이트가 막는다. 그 사람이
--   화면의 [승인 요청 남기기]를 누르면 이 표에 이메일이 한 줄 쌓인다(로그인 없이도
--   가능 — 아직 계정이 없으니 당연하다). 오너가 앱에 로그인해 "가입 승인" 화면을
--   열면 대기 목록이 보이고, [승인]을 누르면 1)의 허용목록에 자동으로 추가된다.
-- [anon(비로그인)이 이 표에 쓸 수 있게 한 것이 안전한 이유]
--   이 표에 아무리 마음대로 써넣어도(심지어 status를 직접 조작해도) **실제 가입 허용
--   여부는 오직 capri_allowed_emails 로만 결정**된다(2)의 게이트가 그 표만 본다).
--   즉 이 표는 "요청서 우편함"일 뿐 열쇠가 아니라서, 아무나 접수는 해도 아무도
--   스스로를 승인시킬 수는 없다.
create table if not exists public.capri_access_requests (
  email        text primary key,  -- 이메일 하나당 요청 한 줄(같은 이메일 중복 신청 방지)
  note         text,              -- 신청자가 남긴 메모(선택)
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz        -- 오너가 승인/거절한 시각(대기 중이면 NULL)
);
alter table public.capri_access_requests enable row level security;

drop trigger if exists trg_capri_access_requests_lower on public.capri_access_requests;
create trigger trg_capri_access_requests_lower
  before insert or update on public.capri_access_requests
  for each row execute function public.capri_lower_email();

-- 누구나(비로그인 포함) 새 요청을 접수할 수 있다 — 아직 계정이 없는 사람이 보내는 것이므로.
create policy "capri_access_requests_anyone_insert" on public.capri_access_requests
  for insert
  to anon, authenticated
  with check (true);

-- 조회·승인/거절 처리·정리(삭제)는 오너 계정만(capri_allowed_emails와 같은 규칙).
create policy "capri_access_requests_owner_select" on public.capri_access_requests
  for select
  to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

create policy "capri_access_requests_owner_update" on public.capri_access_requests
  for update
  to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

create policy "capri_access_requests_owner_delete" on public.capri_access_requests
  for delete
  to authenticated
  using ((auth.jwt() ->> 'email') = 'hun100b@gmail.com');

comment on table public.capri_access_requests is
  '가입 승인 요청함. 누구나 접수(insert) 가능하지만, 실제 가입 허용은 capri_allowed_emails 로만 결정된다. 조회·승인은 오너 전용.';
