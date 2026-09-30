-- =============================================================================
-- 20260930130000_capri_remote_control.sql
-- 폰 원격 조종 — "폰으로 모든 작업 다 가능해야 해" (오너 지시, 2026-09-30)
-- -----------------------------------------------------------------------------
-- [전제] 카프리는 자동매매 봇이라 어차피 PC가 켜져 있어야 실주문이 나간다. 그래서
--   "PC가 켜져 있는 동안은 폰에서 전부 조작 가능"이면 오너 요구를 만족한다(오너도
--   이 전제를 확인했다). 증권사 키는 여전히 PC 로컬에만 있고, 서버로 가는 건 "이걸
--   해줘"라는 명령뿐이다 — 주문은 항상 PC가 자기 로컬 키로 낸다(3번 "매매를 서버로
--   이전"은 절대 하지 않는다, 오너 지시).
--
-- [왜 Realtime을 안 쓰나] 이 프로젝트는 `relation "realtime.subscription" does not
--   exist` 오류 상태라(Realtime 확장이 이 프로젝트에서 정상 동작하지 않음이 이미
--   확인됨), 대신 PC가 짧은 주기(수 초)로 폴링한다 — 실시간성은 약간 떨어지지만
--   추가 인프라 없이 지금 바로 안정적으로 동작한다.
--
-- [구조]
--   capri_commands            폰/PC 어디서든 명령을 넣으면(status=pending),
--                              그 계정으로 로그인한 PC가 폴링해서 집어(acked) 실행하고
--                              결과(done/failed + result)를 남긴다.
--   capri_desktop_heartbeat   PC가 살아있는 동안 몇 초마다 갱신하는 "최근 생존 시각".
--                              폰 화면 상단이 이 값으로 "PC 연결됨/꺼져 있음"을 보여준다
--                              — PC 꺼진 줄 모르고 버튼만 눌러놓고 됐다고 착각하는 사고를
--                              막기 위한 가장 중요한 안전장치(오너 지시).
--
-- [멱등성(중복 실행 방지)] 폴링이 같은 pending 행을 두 번 이상 집는 경쟁을 막기 위해,
--   PC는 "status='pending'인 행만" 조건부 UPDATE(status='pending' → 'acked')로 먼저
--   선점한다 — PostgREST가 WHERE 조건에 안 맞아 0행을 바꾸면 그건 "이미 누가 선점함"
--   이라는 신호가 되므로, 그 행은 건너뛴다(electron/tool-engine.ts의 executeCommand
--   참고). 실행은 그 선점에 성공한 행에 대해서만, 딱 한 번 한다.
--
-- [누가 쓸 수 있나] 본인 행만(auth.uid()=user_id) + capri_accounts가 'approved'인
--   계정만(승인 안 된 계정은 명령을 넣지도, PC 쪽에서 실행되지도 않는다 — 20260930120000
--   과 같은 게이트 원칙).
-- =============================================================================

create table if not exists public.capri_commands (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  type         text not null check (type in (
                 'autoTradeStart', 'autoTradeStop', 'saveAutoTradeSettings',
                 'setKillSwitch', 'placeEntry', 'placeSell', 'cancelAutoPosition', 'autoScanNow'
               )),
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending' check (status in ('pending', 'acked', 'done', 'failed')),
  result       jsonb,
  created_at   timestamptz not null default now(),
  executed_at  timestamptz
);
alter table public.capri_commands enable row level security;

-- 폴링 조회 패턴: "내 pending 명령을 오래된 순으로" — 인덱스로 빠르게.
create index if not exists capri_commands_user_status_idx
  on public.capri_commands (user_id, status, created_at);

drop policy if exists "capri_commands_own_approved" on public.capri_commands;
create policy "capri_commands_own_approved" on public.capri_commands
  for all to authenticated
  using (auth.uid() = user_id and exists (
    select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved'
  ))
  with check (auth.uid() = user_id and exists (
    select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved'
  ));

comment on table public.capri_commands is
  '폰↔PC 명령 중계(폴링 방식). 본인 행만, 승인된 계정만. 주문 실행은 항상 PC가 로컬 키로 한다.';


create table if not exists public.capri_desktop_heartbeat (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  last_seen    timestamptz not null default now(),
  app_version  text
);
alter table public.capri_desktop_heartbeat enable row level security;

drop policy if exists "capri_desktop_heartbeat_own_approved" on public.capri_desktop_heartbeat;
create policy "capri_desktop_heartbeat_own_approved" on public.capri_desktop_heartbeat
  for all to authenticated
  using (auth.uid() = user_id and exists (
    select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved'
  ))
  with check (auth.uid() = user_id and exists (
    select 1 from public.capri_accounts a where a.user_id = auth.uid() and a.status = 'approved'
  ));

comment on table public.capri_desktop_heartbeat is
  'PC(데스크톱 앱)가 살아있는 동안 주기적으로 갱신하는 생존 신호. 폰 화면이 "PC 연결됨/꺼져 있음" 표시에 쓴다.';
