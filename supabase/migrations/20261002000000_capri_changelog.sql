-- [v0.61.9 — 오너 지시] "개발 내역을 모든 사용자에게 공유하고 싶다 — 업데이트 내역 탭을
-- 신설하고, 매 업데이트마다 Claude의 개발 보고(고민·고뇌까지, 민감사항만 제외)를 리포트로
-- 남겨 동업자들과 함께 성장하고 싶다." capri_group_trades(평문, 그룹 전원 공유)와 같은
-- 원칙 — 다만 쓰기는 오너 계정만(실수로 다른 그룹원이 변경로그를 건드리지 않게).
create table if not exists public.capri_changelog (
  id           bigint generated always as identity primary key,
  version      text not null,
  title        text not null,
  body         text not null, -- 마크다운 형식의 상세 리포트(민감사항 제외)
  published_at timestamptz not null default now()
);
alter table public.capri_changelog enable row level security;

-- 읽기: 승인된 그룹원이면 누구나(가입 허용목록 전원이 함께 보는 공개 변경 로그).
create policy capri_changelog_select_approved
  on public.capri_changelog
  for select
  to authenticated
  using (
    exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  );

-- 쓰기: 오너 계정만(실수로 다른 그룹원이 변경 로그를 건드리지 않게 — capri_accounts.isOwner
-- 같은 별도 플래그가 없어 이메일로 직접 비교한다, electron/tool-engine.ts의 OWNER_EMAIL과 동일).
create policy capri_changelog_insert_owner
  on public.capri_changelog
  for insert
  to authenticated
  with check (auth.jwt() ->> 'email' = 'hun100b@gmail.com');

create policy capri_changelog_delete_owner
  on public.capri_changelog
  for delete
  to authenticated
  using (auth.jwt() ->> 'email' = 'hun100b@gmail.com');

create index if not exists capri_changelog_published_at_idx on public.capri_changelog (published_at desc);

comment on table public.capri_changelog is
  '업데이트 내역(변경 로그) — 그룹 전원이 읽는 공개 게시판, 쓰기는 오너 계정만. 민감사항(실제 종목명·손익 금액 등)은 담지 않는다.';
