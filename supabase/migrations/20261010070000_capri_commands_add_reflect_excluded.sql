-- [v0.78.0 — 오너 지시 "Capri가 모르는 매매도 자동 반영, 장기보유 종목은 내가 선택해서 제외"]
-- 폰에서 "자동 반영 제외(장기보유 등)" 토글을 원격으로 보낼 수 있게 화이트리스트에 추가.
-- 이 명령은 종목 하나를 reflectUnknownHoldings(참고용 자동 반영)의 제외 목록에 넣거나 뺄
-- 뿐이고, 주문을 새로 내지도 익절/손절을 걸지도 않는다(electron/tool-engine.ts의
-- setAutoReflectExcluded 참고).
alter table public.capri_commands
  drop constraint capri_commands_type_check;

alter table public.capri_commands
  add constraint capri_commands_type_check check (type in (
    'autoTradeStart', 'autoTradeStop', 'saveAutoTradeSettings', 'saveAutoScanSettings',
    'setKillSwitch', 'setLiveOrders', 'saveSystemPauseEnabled',
    'placeEntry', 'placeSell', 'cancelAutoPosition', 'autoScanNow',
    'saveLabSettings', 'dismissUnprotected', 'setAutoReflectExcluded'
  ));
