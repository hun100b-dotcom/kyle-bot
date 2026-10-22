-- [v0.109.1] 공지 발송 경로를 capri_announce_*(20261022130000, 사람별 결과·재시도 포함) 하나로 통일.
-- v0.109.0에서 같이 들어갔던 capri_notices(+자동 발송 트리거)는 같은 공지를 두 번 보낼 수 있어 제거한다.
-- (앱은 이제 capri_announcements를 읽어 앱 안 표시만 한다. capri_notices는 비어 있었다.)
drop trigger if exists trg_capri_notify_notice on public.capri_notices;
drop function if exists public.capri_notify_notice();
drop table if exists public.capri_notices;
