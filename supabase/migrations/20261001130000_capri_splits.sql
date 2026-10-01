-- [v0.61.7 — ③ 전수조사 중간-2, 오너 승인] 삼분할 타점 기록(SavedSplit)이 PC·폰 각자
-- 로컬 파일에만 저장돼 기기 간 동기화가 전혀 없었다 — "PC·폰 모두 동일 화면" 지시 미달
-- 항목이었다. capri_auto_state·capri_trades와 완전히 같은 패턴(개인 전용, 로그인
-- 비밀번호로 암호화, user_id가 곧 기본키)으로 전용 채널을 하나 더 둔다.
create table if not exists public.capri_splits (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ciphertext text not null,
  salt       text not null,
  iv         text not null,
  updated_at timestamptz not null default now()
);
alter table public.capri_splits enable row level security;

create policy capri_splits_select_own_approved
  on public.capri_splits
  for select
  to authenticated
  using (
    auth.uid() = user_id
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  );

create policy capri_splits_insert_own_approved
  on public.capri_splits
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  );

create policy capri_splits_update_own_approved
  on public.capri_splits
  for update
  to authenticated
  using (
    auth.uid() = user_id
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  );

comment on table public.capri_splits is
  '삼분할 타점 기록(SavedSplit) 기기 간 동기화 — 본인 행만, 암호화(로그인 비밀번호), capri_auto_state와 같은 패턴.';
