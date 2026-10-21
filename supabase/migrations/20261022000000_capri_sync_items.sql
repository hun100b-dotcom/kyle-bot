-- =============================================================================
-- [v0.108.0 — 오너 지시 "PC에서 세팅한 값이 폰·다른 노트북에 동기화가 안 된다. 로그인 계정 기준으로
--   설정·자동매매 설정·스크리닝 기준·매매기록·매매연구소·관찰 기록·가상봇 기록 전부 실시간 동기화"]
--
-- [왜 새 테이블이 필요한가 — 지금까지 안 되던 진짜 이유]
--   · 설정(자동매매 한도·스크리닝 기준·시드 비율 등 약 60개)은 지금까지 "각 기기의 .env 파일"에만 있었다.
--     클라우드로 올라간 적이 한 번도 없다. 폰은 PC가 올린 상태 사진(capri_live_state snapshot)을
--     "보기만" 했고, 다른 노트북은 아예 자기 파일의 값(대부분 기본값)으로 돌았다.
--   · 매매연구소 기록·관찰 기록·트레이드 기록·매매 근거·자동매매 실행 기록도 전부 기기 파일에만 있었다.
--   · 기존 암호화 동기화(capri_trades·capri_auto_state·capri_splits)는 "한 사람당 한 줄을 통째로" 바꾸는
--     구조라, 기록이 수 MB인 연구소 데이터에는 맞지 않는다.
--
-- [새 구조 — 항목(아이템) 단위 동기화]
--   capri_sync_items: "계정 + 종류 + 항목 id" 마다 한 줄. 각 줄에 버전(rev, 항목을 마지막으로 고친 시각)과
--   내용 지문(hash)을 함께 둔다.
--   · 저장은 capri_sync_put 함수로만 한다 — 서버가 "들어온 버전이 지금 버전보다 클 때만" 바꾼다.
--     → 두 기기가 동시에 저장해도 항상 더 최신 쪽만 남는다(덮어쓰기 사고 없음). 버전이 같으면 지문이
--       큰 쪽으로 정해져, 모든 기기가 반드시 똑같은 내용으로 수렴한다(오차 0).
--   · 삭제는 줄을 지우지 않고 deleted=true 표식(묘비)으로 남긴다 → 다른 기기에서 다시 살아나지 않는다.
--   · updated_at 은 서버 시각 — 기기들은 "마지막으로 본 시각 이후 바뀐 줄"만 받아 간다(가볍게 자주 확인).
-- =============================================================================

create table if not exists public.capri_sync_items (
  user_id uuid not null default auth.uid(),
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  item_id text not null check (char_length(item_id) between 1 and 300),
  rev bigint not null,
  hash text not null,
  sort_ms bigint not null default 0,
  deleted boolean not null default false,
  payload jsonb,
  device_id text,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, kind, item_id)
);

create index if not exists capri_sync_items_user_updated on public.capri_sync_items (user_id, updated_at);

alter table public.capri_sync_items enable row level security;

drop policy if exists capri_sync_items_own_approved on public.capri_sync_items;
create policy capri_sync_items_own_approved
  on public.capri_sync_items
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

-- 저장 함수: 들어온 항목들 중 "서버 것보다 (버전, 지문)이 큰 것"만 반영하고, 반영된 id 목록을 돌려준다.
--   security invoker → 위 RLS가 그대로 적용된다(남의 계정 줄은 절대 못 건드림).
--   (오래된 줄 정리는 앱이 RLS 안에서 직접 한다 — 각 기기가 같은 상한 규칙으로 자르므로 결과가 같다.)
create or replace function public.capri_sync_put(p_kind text, p_items jsonb)
returns jsonb language sql volatile security invoker set search_path = public as $$
  with src as (
    select distinct on (x->>'id')
      x->>'id' as item_id, (x->>'rev')::bigint as rev, coalesce(x->>'hash', '') as hash,
      coalesce((x->>'sort')::bigint, 0) as sort_ms, coalesce((x->>'deleted')::boolean, false) as deleted,
      x->'payload' as payload, x->>'device' as device_id
    from jsonb_array_elements(p_items) x
    where x->>'id' is not null and x->>'rev' is not null and auth.uid() is not null
    order by x->>'id', (x->>'rev')::bigint desc
  ), up as (
    insert into public.capri_sync_items as t (user_id, kind, item_id, rev, hash, sort_ms, deleted, payload, device_id, updated_at)
    select auth.uid(), p_kind, s.item_id, s.rev, s.hash, s.sort_ms, s.deleted, case when s.deleted then null else s.payload end, s.device_id, clock_timestamp()
    from src s
    on conflict (user_id, kind, item_id) do update
      set rev = excluded.rev, hash = excluded.hash, sort_ms = excluded.sort_ms, deleted = excluded.deleted,
          payload = excluded.payload, device_id = excluded.device_id, updated_at = clock_timestamp()
      where (t.rev, t.hash) < (excluded.rev, excluded.hash)
    returning t.item_id
  )
  select jsonb_build_object('accepted', coalesce(jsonb_agg(item_id), '[]'::jsonb)) from up;
$$;

revoke execute on function public.capri_sync_put(text, jsonb) from anon, public;
grant execute on function public.capri_sync_put(text, jsonb) to authenticated;

-- 변경 감지 함수: "내 계정 데이터가 마지막으로 바뀐 시각"을 종류별로 한 번에 돌려준다.
--   기기들은 10초마다 이것만 가볍게 묻고, 바뀐 것만 받아 간다(실시간에 가까운 반영 + 트래픽 최소).
create or replace function public.capri_sync_versions()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'items', (select max(updated_at) from public.capri_sync_items where user_id = auth.uid()),
    'trades', (select max(updated_at) from public.capri_trades where user_id = auth.uid()),
    'autoState', (select max(updated_at) from public.capri_auto_state where user_id = auth.uid()),
    'splits', (select max(updated_at) from public.capri_splits where user_id = auth.uid()),
    'paper', (select max(updated_at) from public.capri_live_state where user_id = auth.uid() and kind = 'paper_bots')
  );
$$;

revoke execute on function public.capri_sync_versions() from anon, public;
grant execute on function public.capri_sync_versions() to authenticated;

-- [v0.108.0] PC가 여러 대(윈도우·맥)일 때 "지금 대표 PC가 누구인지" — 대표 PC만 상태 사진(snapshot)을
--   올리고 폰 명령을 실행한다(예전엔 두 PC가 번갈아 덮어써서 폰 화면이 PC 두 대 사이를 오락가락했다).
alter table public.capri_desktop_heartbeat add column if not exists device_id text;
