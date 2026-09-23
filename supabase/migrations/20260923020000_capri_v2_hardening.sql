-- =============================================================================
-- 20260923020000_capri_v2_hardening.sql
-- 보안 점검(Advisor)이 잡아낸 2가지 보강 — 트리거 전용 함수 강화
-- -----------------------------------------------------------------------------
-- 앞 마이그레이션을 실제 서버에 적용한 뒤 Supabase 보안 점검(get_advisors)을 돌려
-- 두 가지를 발견했다. 둘 다 "당장 뚫리는 구멍"은 아니지만(트리거 함수를 트리거가
-- 아닌 방식으로 직접 부르면 Postgres가 자동으로 거부한다), 원칙대로 최소 권한으로
-- 맞춰 둔다.
--
--   1) capri_lower_email 함수에 search_path 고정이 빠져 있었다. 같은 마이그레이션의
--      capri_auth_gate 는 CREATE 시점에 `set search_path = public` 을 넣었는데,
--      이 함수는 빠뜨렸다. search_path 가 고정 안 된 SECURITY 관련 함수는 악의적으로
--      같은 이름의 함수/테이블을 다른 스키마에 몰래 심어 실행 흐름을 가로채는 공격
--      (search_path 하이재킹)에 이론상 노출될 수 있다.
--   2) capri_auth_gate·capri_autoconfirm(트리거 전용 함수) 이 REST API
--      (`/rest/v1/rpc/함수이름`)로 익명·로그인 사용자 모두에게 직접 호출 가능하게
--      노출돼 있었다. 트리거로만 쓰이는 함수라 원래 사람이 직접 부를 일이 없다 —
--      실행 권한을 거둬 "트리거 안에서만" 돌게 좁힌다(트리거 자체는 실행 권한과
--      무관하게 계속 정상 작동한다).
-- =============================================================================

alter function public.capri_lower_email() set search_path = public;

revoke execute on function public.capri_auth_gate() from public, anon, authenticated;
revoke execute on function public.capri_autoconfirm() from public, anon, authenticated;
