-- [v0.61.6 — ③ 전수조사 중간-1, 오너 승인("모두 승인 계속 진행해라")] 실주문 활성화
-- (setLiveOrders)·시스템 휴무 시간대(saveSystemPauseEnabled)를 원격 명령 화이트리스트에
-- 추가한다 — 둘 다 PC의 실제 매매 동작을 바꾸는 공유 안전 설정이라 killSwitch와 같은
-- 원칙으로 원격화한다. setPriceGuard·setSkipConfirm은 그 기기 자신이 직접 내는 주문에만
-- 적용되는 화면별 설정이라(각 기기가 자기 주문을 자기 설정으로 보호) 의도적으로 뺐다
-- (docs/audit-2026-10-01.md [중간-1] 참고 — 화이트리스트에 없으면 그 기기 로컬에만 적용).
alter table public.capri_commands
  drop constraint capri_commands_type_check;

alter table public.capri_commands
  add constraint capri_commands_type_check check (type in (
    'autoTradeStart', 'autoTradeStop', 'saveAutoTradeSettings', 'saveAutoScanSettings',
    'setKillSwitch', 'setLiveOrders', 'saveSystemPauseEnabled',
    'placeEntry', 'placeSell', 'cancelAutoPosition', 'autoScanNow'
  ));
