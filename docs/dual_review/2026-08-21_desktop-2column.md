# 데스크톱 2컬럼(두 탭 나란히) — A/B 교차 리뷰 (2026-08-21, v0.15.0)

사장님 승인 후 착수. PC(≥1024)에서 두 탭 동시 표시, 폰/좁은 화면은 기존 단일 컬럼 그대로(회귀 금지).

## 구조
- 콘텐츠 블록을 `.map((paneTab)=>...)`로 감싸 1컬럼=탭1개, 2컬럼=좌/우 2개. 가드 `tab`→`paneTab`(콘텐츠 영역에 가드 외 tab 사용 0 확인 후 변환).
- 상태: `twoCol`(localStorage), `isWide`(matchMedia 1024 + change 리스너), `tabL`/`tabR`. `showTwoCol=twoCol&&isWide`.
- 1컬럼 CSS는 `.panes/.pane{display:contents}`로 완전 투명 → 기존 레이아웃과 동일(회귀 0). 2컬럼만 flex.
- 상단 탭바는 2컬럼일 때 숨김, 각 패널 드롭다운으로 탭 선택. 넓은 화면에서만 [2컬럼] 토글.

## A/B 교차 리뷰

| # | 발견 | A | B | 최종 |
|---|------|---|---|------|
| **H1** | **2컬럼에서 자동계산이 죽음** — auto-calc effect가 stale `tab !== "calc"`를 봐서, 비계산기 탭에서 2컬럼 켜면 계산기 패널이 입력해도 계산 안 함 | — | **HIGH** | **FIX**: `isTabVisible("calc")`로 판정(좌/우 패널 포함) + deps 보강 |
| **H2** | **주문 전송·킬스위치 후 주문현황 패널 미갱신** — 3곳이 stale `tab==="orders"` 가드라, 계산기+주문현황 2컬럼에서 주문 내도 옆 패널이 안 바뀜 | — | **HIGH** | **FIX**: 3곳 모두 `isTabVisible("orders")`로 |
| M1 | 패널 select가 activateTab 직접 호출 + effect도 호출 → **이중 로드** | MEDIUM | MEDIUM | **FIX**: onChange의 activateTab 제거(effect가 처리) |
| M2 | 뷰포트 미디어쿼리가 '절반 폭 패널'에 안 먹어 리포트 배지(4열)·요약카드(3열)·히어로(9vw)가 넘침·잘림 | — | MEDIUM | **FIX**: `.panes.twocol` 전용 오버라이드(배지 2열·요약 1열·히어로 40px·pane overflow-x hidden) |
| U1 | 2컬럼→1컬럼 복귀 시 stale `tab` 표시 | LOW/UX | L3 | **FIX**: 토글 off 시 tab=tabL(왼쪽 패널 이어 보기) |
| — | 콘텐츠 내부 setTab(계산기로 불러오기·체결강도 보기)이 2컬럼서 먹통 | (선제) | (확인) | **선제 FIX**: goToTab(대상 탭을 패널에 띄움) — B도 "먹통 아님(고쳐짐)" 확인 |
| a11y | 2컬럼서 `<main>` 2개(landmark 중복) | LOW | LOW | 수용(기능 무해) |
| M3 | 같은 탭 2패널 시 상태 공유(strSym 등) | LOW | MEDIUM | 수용(비정상 사용 — 크래시 아님) |

**B의 근본 원인 요약:** 렌더 블록·autoRefresh는 `paneTab`/`tabL`/`tabR`로 옮겼으나, **명령형 가드(자동계산·주문 후 새로고침·킬스위치)가 stale 단일 `tab`에 남아** 2컬럼에서 오작동 → `isTabVisible` 헬퍼로 일괄 교정.

### A/B가 "확인"한 것(정상)
- **1컬럼/폰 회귀 0**: `display:contents`가 wrapper를 녹여 `.grid/.ticket/.statusmain`을 예전과 동일한 직속 flex 자식으로 승격 → 스크롤·flex:1·safe-area·height 체인 보존. 821~1023px도 단일.
- 폰 단일 보장(isWide=false), 토글 버튼도 좁으면 숨김. key(paneIdx) 안정, 중복 DOM id 없음, 드래그순서 보존, setTab→goToTab로 먹통 해소.

### A가 "확인"한 것(정상)
- **1컬럼 회귀 0**: `.app{flex column;height:100vh}` 아래 `display:contents`가 `.grid/.ticket/.statusmain`을 예전과 동일한 직속 flex 자식으로 승격 → 스크롤·flex:1·safe-area 그대로.
- **폰 단일컬럼 보장**: isWide=false면 twoCol 저장돼 있어도 단일, 토글 버튼도 숨김. 821~1023px 밴드도 단일.
- 데이터 로딩: 1컬럼은 기존 경로(report는 tab effect), 2컬럼은 activateTab. report 양쪽 다 로드. 1컬럼 이중호출 없음.
- 드래그 순서 보존(localStorage 독립), key(paneIdx) 안정, settings===null 안전.

## 검증
- 라이브(웹앱 1440px): [2컬럼] 토글→패널2개(왼쪽 계산기 706px+오른쪽 체결강도 706px), 드롭다운으로 오른쪽만 주문현황 전환(왼쪽 유지), 상단탭바 숨김·localStorage 저장. 375px: 단일컬럼·탭바·가로넘침0(회귀0). 콘솔0.
- **H1 재현 검증:** 설정 탭에서 2컬럼 켜고(tab=stale settings) 계산기 패널 입력 → 결과표(1·2·3분할) 정상 생성 = 자동계산 동작 확인.
- **M2 검증:** 리포트 패널 scrollWidth==clientWidth(706) → 가로 넘침 0.
- 타입체크(web+app)·vitest 253개 통과.
