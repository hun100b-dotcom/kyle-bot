-- =============================================================================
-- 20260926010000_capri_auto_state.sql
-- 자동매매 기록(포지션+이력)의 기기 간 동기화 — capri_trades와 완전히 같은 패턴
-- -----------------------------------------------------------------------------
-- [오너 보고, 2026-09-26] "PC에서 진행하다 폰에서 킬 경우 자동매매 기록·현황이 모두
--   사라져 있음. 실제 토스에는 그 주문이 남아있는데." v0.30.1 긴급수정으로 "같은 기기"
--   재시작은 고쳤지만, PC↔폰처럼 서로 다른 기기 사이의 동기화는 그때 "알려진 한계"로
--   남겨뒀다. 이 표가 그 나머지 절반을 푼다.
--
-- [왜 capri_trades와 똑같이 만드나] 표마다 보안·동기화 방식이 다르면 그 자체가 복잡함이다.
--   capri_secrets(토스 키)·capri_trades(매매이력)와 완전히 같은 패턴을 그대로 따른다:
--   유저 1명당 행 1개, 평문은 절대 들어오지 않고 암호문(ciphertext/salt/iv)만 저장,
--   RLS로 "내 것은 나만" 접근. 비밀번호는 로그인 비밀번호 하나 그대로 재사용한다.
-- =============================================================================

create table if not exists public.capri_auto_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  ciphertext text not null,
  salt       text not null,
  iv         text not null,
  updated_at timestamptz not null default now()
);
alter table public.capri_auto_state enable row level security;

create policy "capri_auto_state_select_own" on public.capri_auto_state
  for select to authenticated
  using (auth.uid() = user_id);

create policy "capri_auto_state_insert_own" on public.capri_auto_state
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy "capri_auto_state_update_own" on public.capri_auto_state
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

comment on table public.capri_auto_state is
  '자동매매 기록(포지션+생애주기 이력)을 로그인 비밀번호로 암호화해 보관. 평문 없음. RLS로 본인 행만 접근.';
