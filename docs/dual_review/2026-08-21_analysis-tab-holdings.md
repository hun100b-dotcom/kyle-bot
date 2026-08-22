# 더블리뷰 — 탭 '체결강도'→'매매분석' + 보유 종목 체결강도 자동표시 (v0.23.0, 2026-08-21)

> 대상: src/App.tsx, src/App.css, src/kyletool.d.ts, electron/main.ts, electron/preload.cjs, web/kyletool-adapter.ts
> 변경: ① 탭 라벨 개명 ② 수동 [기록 시작] 제거 → holdingsView로 보유(USD) 종목을 가져와 각 strengthStart(auto) + 칩/상세.

## 리뷰어 A(총괄): 통과(HIGH 0)
- 라벨: `TAB_LABEL`은 상단 탭·2컬럼 드롭다운 두 곳에서만 소비 → `strength:"매매분석"` 한 곳 변경으로 전부 반영. useTabOrder는 ID로 저장(라벨 무관). trades="매매분석(구)"는 렌더/네비 경로가 없어 사문화·무해.
- auto=true 5단 배선(d.ts/preload/main/adapter/engine) 일치. 엔진 auto 수명제한(6h/5실패) 확인 → 연결 없으면 무한 폴링 없이 자동 종료.
- 연결/빈/로딩 3분기 상호배타. 매매분석(진입→청산) 섹션·단일 .grid·네온다크 유지. openStrengthFor focus 보존. 미사용(startStrength/stopStrength/strIv) 제거로 noUnusedLocals 안전.
- LOW: 탭명 vs 첫 카드명("보유 종목 체결강도") 미묘차(의도), 고아 CSS 잔존(.str-sym-input 등, 무해), 첫 이벤트 미세 지연.

## 리뷰어 B(적대): HIGH 2 + MEDIUM 3 + LOW 4 → HIGH·L4 반영
- **[H1] 연결오류가 "보유 종목 없음"으로 위장(회귀):** `holdingsView()`는 연결 실패 시 throw가 아니라 `items:[]` 반환(tool-engine.ts:3043-3053) → catch 미발동 → strErr=null → 잘못된 빈 상태.
  → **반영:** 보유가 비고 focus도 없으면 `quote("AAPL")`로 연결을 한 번 확인. throw면 연결 안내(strErr), 성공이면 진짜 '보유 0'. 무음 실패 금지 복구.
- **[H2] 2컬럼에서 openStrengthFor가 loadHoldingsStrength 이중 호출 → focus 종목 유실:** goToTab이 setTabL→effect→activateTab→loadHoldingsStrength()(focus 없음)와 경합.
  → **반영:** focus를 `strFocusRef`(ref)로 잡고 함수 진입 시 **동기적으로** 읽는다. 두 호출 다 같은 focus를 집으므로 유실 불가. 소비 후 ref 비움.
- **[L4] 칩 ∞(매도0=초강세 매수)가 회색으로 '무데이터'처럼 보임:** → **반영:** oneWayBuy면 초록(up).
- **[M1] 탭을 '보기'만 해도 보유 전 종목 폴러 6h 지속 / [M3] 순차 await로 느림:** → **부분 완화(선반영):** 실시간 폴링을 **최대 12종목**으로 상한(그 이상은 저장값만 표시) → 429·타이머 폭증 방지. 6h/5실패 자동 종료가 상한 유지. (탭 이탈 시 즉시 중지는 미도입 — 자동 수명제한+상한으로 갈음. 문서화.)
- **[M2] 2컬럼 좌/우 둘 다 strength면 이중 로드 / [L1] 첫 emit 종목 튐 / [L2] 죽은 라벨 / [L3] 잔존 strSym:** 저위험 — startStrength dup-guard·heldSyms 게이트로 무해, 수용(문서화).

## 재검증
타입체크(web+app, 엔진 포함)·vitest 264개 통과. 라이브(웹, 샘플 보유 주입): 탭명 '매매분석', 보유칩(AAPL/IONQ/XOS, KR 제외), 칩 클릭 상세전환, 빈/연결오류 안내 확인.
