-- [v0.60.0 — 오너 실사용 보고: "매매연구 탭이 그룹원 데이터를 못 불러옴(본인 데이터만
--   보임)" + "그룹원 관리 탭에 실제 그룹원 카일이 안 보임"]
--
-- 조사 결과 capri_group_trades/capri_group_chat의 SELECT 정책(*_select_members)은
-- 이미 그룹 전체를 볼 수 있게 열려 있었다(본인 행 제한 아님) — 진짜 원인은 다른 곳:
--
--   1) capri_group_trades에는 실제로 오너(hun100b) 행 1개뿐이었다. 카일 계정
--      (jimraine2@gmailcom — 가입 당시 오타로 점 하나가 빠짐, 실제 auth.users.email도
--      동일)은 2026-09-29 가입 이후 로그인한 적이 없어(last_sign_in_at = 가입 시각과
--      동일) 자동매매 기록을 올린 적이 없다 — RLS·쿼리 문제가 아니라 "아직 데이터가
--      없다"는 사실 그 자체였다.
--   2) 그런데 화면(그룹원 근황 표)은 capri_group_trades에 실제로 행이 있는 사람만
--      나열한다 — 로그인만 하고 기록이 없는 그룹원은 "아직 기록 없음"으로 보여야
--      한다는 주석이 코드에 있었지만, 실제로는 그런 "빈 자리"를 채워 줄 명단(로스터)
--      자체를 어디서도 안 가져오고 있었다. 그 명단 역할을 할 수 있는 capri_allowed_emails
--      테이블은 **오너 전용**(capri_allowed_emails_owner_all)이라 카일 같은 일반
--      그룹원은 애초에 조회할 방법이 없었다 — 이번 로그인 개편(capri_accounts) 때
--      "그룹 명단"을 누가 볼 수 있는지를 따로 열어 두지 않은 게 진짜 누락이었다.
--
-- 수정: capri_allowed_emails에 "승인된 그룹원이면 명단 전체를 볼 수 있다" 정책을
--   추가한다. 기존 오너 전용 정책(capri_allowed_emails_owner_all)은 그대로 둔다(오너의
--   쓰기 권한 등은 안 건드림) — 이건 오직 SELECT만 넓히는 추가 정책이다. capri_accounts를
--   참조하되 capri_allowed_emails 자기 자신을 참조하지 않아(무한 재귀 걱정 없음),
--   capri_trades_select_own_approved 등 기존에 이미 쓰던 "승인된 계정만" 패턴 그대로다.
create policy capri_allowed_emails_select_members
  on public.capri_allowed_emails
  for select
  to authenticated
  using (
    exists (
      select 1 from public.capri_accounts a
      where a.user_id = auth.uid() and a.status = 'approved'
    )
  );
