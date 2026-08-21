# 더블리뷰 — 체결강도 '매매하면 자동 기록' (v0.22.0, 2026-08-21)

> 대상: electron/tool-engine.ts, lib/trade-analysis.ts, src/App.tsx, src/kyletool.d.ts, tests/trade-analysis.test.ts
> 요구: 수동 [기록 시작] 없이 Capri로 매매하면 체결강도가 진입→청산까지 자동 기록되고, 매매분석이 진입·청산 강도를 자동 확보.

## 설계 / 훅 지점 (전수조사 결과)
사전 조사(2개 에이전트): 체결강도 기록은 **엔진 setInterval**(`startStrength`→`sampleStrengthOnce`→`kylebot-strength.json`), 진입/청산 스냅샷은 v0.7.0 `recordEntry`/`recordExit`가 이미 존재. 갭 = **연속 기록 자동 시작 없음** + 자동 청산(OCO/앱매도) 미포착.

구현:
1. **진입 자동 시작:** `recordEntry`(placeEntry 1630 / placeOto 1790에서 호출)에 `this.startStrength(symbol)` 추가.
2. **청산 자동 종료:** `recordExit`가 그 종목 미청산 매매가 없을 때만 `stopStrength`.
3. **자동 청산 감지:** `absorbFills`(새 체결 단일 관문)에서 `fillKey`(mergeFills와 동일)로 새 SELL 판정 → `isStrengthRunning`인 종목만 `recordExit("auto")`. OCO 자동익절/손절·토스앱 매도 포괄, 앱 꺼져있던 사이 판 건은 제외(옛 강도 오해 방지).
4. **매매분석:** `CycleEnrichment`/`TradeCycle`에 `exitStrength` 추가, enrich가 `st.exit.strength` 매칭, UI '진입→청산 강도' 열.
5. **UI 문구:** "매매하면 자동 기록", [기록 시작]=관찰용 선택, 연결 없을 때 안내.
6. **exitKind** 타입에 `"auto"` 추가.

## 안전 원칙
- 모든 훅 fire-and-forget(`void`)·try/catch 삼킴 → 주문 로직·DRY_RUN·주문 게이트 영향 0.
- 타이머 정리: before-quit `stopAllStrength` 유지 + 청산 시 stopStrength.
- 매칭 열쇠 `fillKey` 재사용(중복 처리 사고 차단), recordExit 미청산-없으면-무시(중복 발화 무해).

## 검증
타입체크(web+app, 엔진 포함 tsconfig.web) 통과 · vitest 264개(trade-analysis exitStrength 1개 추가) 통과.

## A/B 리뷰 결과 및 반영

리뷰어 A(총괄): HIGH 없음, 안전 무결. MEDIUM 1 — **같은 종목 다진입(삼분할)을 한 번에 팔면 미청산 1건만 닫혀 stopStrength 안 걸림(타이머 잔존)**.
리뷰어 B(적대): **HIGH 2** — (H1) 자동 시작 타이머가 안 꺼짐(mock/dryrun 무한, live도 탭 열기 전까지) → 종목당 10초 폴러 누적·429 위험, v2 대전제("상시 실행 불필요") 위반. (H2) savedFills 얕을 때 collectFills가 45~75일치를 끌어와 **옛 매도가 방금 연 매매를 닫아 승률·손익 오염**. MEDIUM: (M1) 자동+수동 이중발화로 1매도가 2트레이드 청산, (M2) 종목만 매칭→무관 매도가 청산, (M3) 부분청산이 통째 청산, (M4) 배치당 1건만 닫아 누락.

→ **근본 원인: '체결(fills)→페이퍼 트레이드' 매칭으로 청산을 감지·기록하는 방식이 시간역전·다진입·부분청산·외부매도에 취약.** 리뷰 권고대로 **접근을 교체**:

- **[H1 해결] 자동 기록 수명 제한:** 매매로 자동 시작한 기록(`auto=true`)만 (a) 연속 5회 실패(연결 없음) 또는 (b) 최대 6시간 초과 시 **스스로 종료**(`sampleStrengthOnce`). 수동으로 켠 기록은 손대지 않음. → mock/dryrun/오프라인 무한 폴링·타이머 누적 제거.
- **[H2·M1~M4 해결] fills 기반 자동청산 제거:** `absorbFills`의 recordExit("auto") 블록·`fillKey`/newSells 로직 **전부 삭제**. 청산 강도는 대신 **자동 저장된 체결강도 시계열을 '청산 시각(sellAtMs)'으로 조회**(`strengthAt`, 읽기 전용·±30분 허용)해 붙인다. 트레이드를 건드리지 않으니 시간역전·다진입·부분청산·외부매도 오염이 원천 발생 불가. 진입강도도 스냅샷 없으면 `strengthAt(buyAtMs)`로 폴백.
- **[L1] UI:** 매매분석 청산강도 `null`이 주황(str-oneway)으로 오해되던 것 → 회색(hint)으로.
- exitKind "auto"·recordExit "auto" 인자 원복(불필요). recordExit의 stopStrength(수동 매도 시)만 유지.

재검증: 타입체크(web+app, 엔진 포함) 통과 · vitest **264개 통과**. 잔여 참조(newSells/beforeKeys/fillKey/"auto") 0.
자체 확정 점검: 수명제한은 `run.auto`에만 적용(수동 기록 불간섭), strengthAt 읽기전용, 주문 로직·DRY_RUN 무영향.
