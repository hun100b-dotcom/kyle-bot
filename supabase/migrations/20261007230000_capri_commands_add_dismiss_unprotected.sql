-- [v0.69.4] 폰에서 "보호 중단(직접 관리)" 버튼을 원격으로 보낼 수 있게 화이트리스트에 추가.
-- 이 명령은 봇의 보호 재시도만 멈추고(토스의 기존 주문은 건드리지 않음) 주문을 새로 내지 않는다.
alter table public.capri_commands
  drop constraint capri_commands_type_check;

alter table public.capri_commands
  add constraint capri_commands_type_check check (type in (
    'autoTradeStart', 'autoTradeStop', 'saveAutoTradeSettings', 'saveAutoScanSettings',
    'setKillSwitch', 'setLiveOrders', 'saveSystemPauseEnabled',
    'placeEntry', 'placeSell', 'cancelAutoPosition', 'autoScanNow',
    'saveLabSettings', 'dismissUnprotected'
  ));
