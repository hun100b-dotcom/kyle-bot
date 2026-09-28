-- =============================================================================
-- 20260928010000_capri_group_trades.sql
-- 그룹(공동개발자·동업자) 전체가 서로의 자동매매기록을 실명으로 함께 볼 수 있는 표
-- -----------------------------------------------------------------------------
-- [오너 지시, 2026-09-28] "카프리는 비공개 그룹(10명 내외, 현재 개발자 3명이 공동대표로
--   운영)이고, 우리 카프리의 모든 사항에 동의한 사람만 엄격히 선별해 들어온다 —
--   동의하지 않으면 함께할 수 없으니 이 그룹에서는 동의 절차가 이미 전제돼 있다. 카프리에
--   '고객'은 없고 전원이 '소유주'다. 투자조언·연구 목적 둘 다 유지하고, 비식별화(익명화)도
--   하지 않는다 — 어떤 그룹원의 어떤 스타일·성향·지속성이 어떤 영향을 미치는지까지 연구해야
--   하기 때문이다."
--
-- [왜 capri_trades/capri_auto_state와 다른 표가 필요한가]
--   capri_trades·capri_auto_state는 "내 것은 나만" 보는 개인용 기기 간 동기화 표라, 로그인
--   비밀번호로 암호화돼 있다(다른 사람은 내 비밀번호를 몰라 복호화 자체가 불가능 —
--   설계상 "본인 전용"). 그룹 전체가 서로의 기록을 실명으로 함께 봐야 하는 이번 요구는
--   그 설계와 정반대라, 개인용 표를 건드리지 않고(기존 기기 간 동기화 기능은 그대로 유지)
--   완전히 별도의 "그룹 공유용" 표를 새로 둔다. 이 표는 평문으로 저장한다(오너 지시:
--   비식별화 없음 — 애초에 암호화해서 서로 못 보게 할 이유가 없다).
--
-- [누가 볼 수 있나] capri_allowed_emails(가입 허용목록)에 있는 사람 = 이미 "카프리의 모든
--   사항에 동의하고 엄격히 선별돼 들어온" 사람이므로, 그 목록에 있으면 전원이 그룹 전체
--   행을 다 볼 수 있다(별도 동의 플래그·비공개 옵션 없음 — 오너 지시 그대로).
-- [누가 쓸 수 있나] 자기 행(user_id=본인)만 쓸 수 있다 — 남의 매매기록을 대신 조작 못 하게.
-- =============================================================================

create table if not exists public.capri_group_trades (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  member_email text not null,      -- 실명(가입 이메일) 그대로 — 비식별화하지 않는다(오너 지시)
  history      jsonb not null,     -- AutoTradeHistoryEntry[] 전체를 평문 그대로 저장
  updated_at   timestamptz not null default now()
);
alter table public.capri_group_trades enable row level security;

-- 그룹(허용목록) 구성원이면 누구나 전체 행을 볼 수 있다 — "내 것만" 제한 없음(오너 지시).
create policy "capri_group_trades_select_members" on public.capri_group_trades
  for select to authenticated
  using (exists (
    select 1 from public.capri_allowed_emails a
    where a.email = (auth.jwt() ->> 'email')
  ));

-- 쓰기는 여전히 본인 행만 — 남의 매매기록을 대신 써넣지 못하게(데이터 무결성, 오너 요구와 무관하게 당연한 제약).
create policy "capri_group_trades_insert_own" on public.capri_group_trades
  for insert to authenticated
  with check (auth.uid() = user_id and member_email = (auth.jwt() ->> 'email'));

create policy "capri_group_trades_update_own" on public.capri_group_trades
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and member_email = (auth.jwt() ->> 'email'));

comment on table public.capri_group_trades is
  '그룹(비공개, 가입 허용목록에 있는 전원) 전체가 실명으로 함께 보는 자동매매기록 — 평문, 비식별화 없음(오너 지시 2026-09-28). 개인용 capri_auto_state(암호화, 본인 전용)와는 별도 표.';
