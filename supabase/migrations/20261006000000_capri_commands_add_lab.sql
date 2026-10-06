-- [v0.65.0] 매매연구소(신호 기록 모드) 켜기/끄기·설정을 폰에서 원격으로 보낼 수 있게 화이트리스트에 추가.
-- 이 기능은 주문을 내지 않는 읽기 전용(시세·캔들 조회만)이라 원격화해도 실계좌 위험이 없다.
alter table public.capri_commands
  drop constraint capri_commands_type_check;

alter table public.capri_commands
  add constraint capri_commands_type_check check (type in (
    'autoTradeStart', 'autoTradeStop', 'saveAutoTradeSettings', 'saveAutoScanSettings',
    'setKillSwitch', 'setLiveOrders', 'saveSystemPauseEnabled',
    'placeEntry', 'placeSell', 'cancelAutoPosition', 'autoScanNow',
    'saveLabSettings'
  ));
