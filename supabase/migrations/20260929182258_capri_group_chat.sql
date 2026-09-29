-- =============================================================================
-- 20260929182258_capri_group_chat.sql
-- 그룹(가입 허용목록 전원)이 실명으로 함께 쓰는 채팅방
-- -----------------------------------------------------------------------------
-- [오너 지시, 2026-09-29] "그룹원 끼리의 근황 현황파악 가능하도록 CHAT 기능도 도입해서
--   그룹원끼리 챗 가능하게 해줘." capri_group_trades와 같은 원칙(비공개 그룹, 이미 카프리의
--   모든 사항에 동의하고 선별돼 들어온 사람들이라 비식별화하지 않는다 — 실명 그대로).
-- =============================================================================

create table if not exists public.capri_group_chat (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  member_email text not null,      -- 실명(가입 이메일) — capri_group_trades와 동일 원칙
  body         text not null,
  created_at   timestamptz not null default now()
);
alter table public.capri_group_chat enable row level security;

-- 오래된 메시지부터 커서 없이 최근 N개를 빠르게 가져오기 위한 인덱스.
create index if not exists capri_group_chat_created_at_idx on public.capri_group_chat (created_at desc);

-- 그룹(허용목록) 구성원이면 누구나 전체 대화를 볼 수 있다 — capri_group_trades와 동일한 원칙.
create policy "capri_group_chat_select_members" on public.capri_group_chat
  for select to authenticated
  using (exists (
    select 1 from public.capri_allowed_emails a
    where a.email = (auth.jwt() ->> 'email')
  ));

-- 쓰기는 본인 이름으로만 — 남의 이름을 빌려 메시지를 남기지 못하게, 그리고 허용목록에 있는
-- 사람만(가입은 됐지만 나중에 허용목록에서 빠진 경우까지 막아 준다).
create policy "capri_group_chat_insert_own" on public.capri_group_chat
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and member_email = (auth.jwt() ->> 'email')
    and exists (select 1 from public.capri_allowed_emails a where a.email = (auth.jwt() ->> 'email'))
  );

comment on table public.capri_group_chat is
  '그룹(비공개, 가입 허용목록에 있는 전원) 전체가 실명으로 함께 쓰는 채팅 — 평문, 비식별화 없음(오너 지시 2026-09-29). 수정·삭제 정책은 의도적으로 두지 않음(대화 기록 그대로 보존).';
