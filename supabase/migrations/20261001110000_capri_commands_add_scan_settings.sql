-- [v0.61.1 긴급 — ③ 전수조사에서 발견] "스크리닝 기준" 탭(자동매매용 스캔 조건 8+4개)의
-- 저장 버튼이 원격 명령 화이트리스트에 없어, 웹(폰)에서 저장하면 그 폰 세션의 로컬 엔진에만
-- 적용되고 PC는 전혀 모른 채 옛 조건으로 계속 스캔하고 있었다(src/App.tsx saveScreenCriteriaUI
-- 참고). 오너가 폰에서 "위험한 조건을 더 엄격하게 바꿨다"고 믿어도 실제 PC 동작은 그대로인
-- 치명적 상태 불일치 — saveAutoScanSettings를 원격 명령 화이트리스트에 추가해 고친다.
alter table public.capri_commands
  drop constraint capri_commands_type_check;

alter table public.capri_commands
  add constraint capri_commands_type_check check (type in (
    'autoTradeStart', 'autoTradeStop', 'saveAutoTradeSettings', 'saveAutoScanSettings',
    'setKillSwitch', 'placeEntry', 'placeSell', 'cancelAutoPosition', 'autoScanNow'
  ));
