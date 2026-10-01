-- [v0.61.0 — 오너 지시: "PC·폰 기능 동등성 구조를 고쳐라"]
--
-- 예전 명령 중계(capri_commands)는 폰→PC 단방향이었다 — PC가 실행한 결과·상태가
-- 폰으로 돌아올 길이 없었다. 스크리너 스캔 결과는 PC 메모리에만 있고 어디에도
-- 올라가지 않았으니, 폰에는 애초에 보여줄 데이터 자체가 없었다(v0.60.5~v0.60.9가
-- capri_auto_state에 끼워 넣으려 했던 건 "개인용 암호화 기록 동기화" 채널을 억지로
-- 재사용한 임시방편이었다 — 이번에 제대로 된 전용 통로로 교체한다).
--
-- capri_live_state: PC → 폰 "상태 미러" 전용 테이블. 평문(capri_group_trades와 같은
-- 원칙 — 비공개 그룹, 전원이 소유주, 비식별화 없음)이고, kind별로 한 행(upsert)만
-- 유지한다. RLS는 "본인 것만 + 승인된 계정만"(다른 개인용 테이블과 동일 원칙).
create table if not exists public.capri_live_state (
  user_id uuid not null,
  kind text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

alter table public.capri_live_state enable row level security;

create policy capri_live_state_own_approved
  on public.capri_live_state
  for all
  to authenticated
  using (
    auth.uid() = user_id
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  )
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved')
  );
