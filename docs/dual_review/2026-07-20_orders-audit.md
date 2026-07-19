# 전수 감사 + A/B 교차 리뷰 — 주문/API 연동 (2026-07-20)

오너 "목록조회 오류 + 왜 이렇게 오류가 많냐" → 땜질 대신 전수 조사. 실서버(openapi.tossinvest.com)
읽기전용 재현 + Reviewer A(총괄)·B(적대) 교차검토.

## 실서버 읽기전용 전수 호출 결과 (사실 근거)

| 동작 | 엔드포인트 | 헤더/파라미터 | 실제 결과 |
|------|-----------|--------------|-----------|
| 현재가 | GET /api/v1/prices | `symbols=` | ✅ 200 (result 배열, lastPrice 문자열) |
| 환율 | GET /api/v1/exchange-rate | `baseCurrency=&quoteCurrency=` | ✅ 200 (rate/midRate/basisPoint 문자열) |
| 계좌목록 | GET /api/v1/accounts | (헤더 불필요) | ✅ 200 (accountNo/accountSeq/accountType) |
| 매수가능 | GET /api/v1/buying-power | `currency=` + 계좌헤더 | ✅ 200 (cashBuyingPower 문자열) |
| 보유종목 | GET /api/v1/holdings | 계좌헤더 | ✅ 200 (객체: totalPurchaseAmount/marketValue/profitLoss/items) |
| 매도가능 | GET /api/v1/sellable-quantity | `symbol=` + 계좌헤더 | ✅ 200 |
| 수수료 | GET /api/v1/commissions | 계좌헤더 | ✅ 200 (배열) |
| 일반주문목록 | GET /api/v1/orders | `status=OPEN` + 계좌헤더 | ✅ 200 ({orders,nextCursor,hasNext}) |
| 조건주문목록 | GET /api/v1/conditional-orders | `status=OPEN` + 계좌헤더 | ✅ 200 ({conditionalOrders,...}) |
| (반례) orders | GET /api/v1/orders | status 없음 | ❌ 400 invalid-request field:status |
| (반례) conditional | GET /api/v1/conditional-orders | status 없음 | ❌ 400 invalid-request field:status |
| (반례) 아무 계좌API | — | 계좌헤더 없음 | ❌ 400 account-header-required |

**목록조회 오류의 진짜 원인:** `listConditionalOrders()`가 필수 `status` 파라미터 없이 호출 → 400.
**"OPEN" enum은 실서버에서 유효**(orders·conditional 둘 다 200) — B의 "OPEN 무효" 의심은 실호출로 반증.

## A/B 교차 리뷰

| # | 발견 | A | B | 합의/이견 | 최종 결정 |
|---|------|---|---|-----------|-----------|
| 1 | listConditionalOrders status 누락 → 조건주문 400 | (전제 확정) | 치명(단독 아님) | 합의 | **FIX**: status='OPEN' 기본값 |
| 2 | Promise.all이 한쪽 실패 시 주문현황 탭 전체 붕괴 | — | 치명 | B 단독(핵심) | **FIX**: allSettled + 친절 에러 |
| 3 | 목서버가 conditional GET status 미검증 → 테스트가 버그 못 잡음(근본원인) | 구조 | 높음 | 합의 | **FIX**: 목서버 status 필수화 |
| 4 | "OPEN"이 실 enum 아님(의심) | — | 치명(강한의심) | **이견→반증** | 오탐(실서버 200 확인). 조치 없음 |
| A | accountSeq 자동조회 부재(getAccounts 죽은코드), "1" 하드 안내 | 높음 | (buyingPower 죽은기능 지적) | 합의 | **FIX**: 저장 시 getAccounts로 자동조회·검증 |
| B | getPrice 빈 배열 → 크래시 | 중간 | 중간 | 합의 | **FIX**: 빈 결과 방어 |
| — | orderGate 현재가 0/NaN → 0-나눗셈 오차단 | — | 중간 | B 단독 | **FIX**: cur<=0 방어 |
| C | 페이지네이션(hasNext) 무시 | 중간 | — | A 단독 | 낮음(수동도구 건수 적음) → TODO |
| D | 목서버 holdings 배열(실서버 객체) | 중간 | — | A 단독 | **FIX**: 목 객체화(스펙 일치) |
| — | mapOrderStatus default가 미지값을 'submitted'로 위장 | — | 낮음-중간 | B 단독 | **FIX**: 'unknown'으로 |
| — | defaultExpire UTC → KST 새벽 하루 어긋남 | — | 낮음 | B 단독 | **FIX**: KST 기준 |
| — | cancel 경로에 prepareBackend 없음 | — | 낮음-중간 | B 단독 | **FIX**: 추가 |
| — | 계좌만 바꾸면 fx/buyingPower 캐시 안 비움 | — | 낮음 | B 단독 | **FIX**: 캐시 무효화 |
| — | OCO 손절 orderPrice=triggerPrice 동일 → 급락 미체결 위험 | — | 낮음-중간(전략) | B 단독 | **FIX**: 손절 지정가 몇 틱 아래 |
| — | App.tsx "OCO/OTO" 죽은 문구(OTO 제거 잔재) | — | 낮음 | B 단독 | **FIX**: 문구 정리 |
| E | 실서버 취소는 드라이런이라 실호출 안 됨 | 정보 | — | — | 의도된 잠금(해금 시 검증) |
| F | 주문 생성 바디 실서버 미검증(목이 가정 흉내) | 높음(추정) | — | A 단독 | 해금 전 openapi 스키마 대조(TODO) |
| G | 조건주문 취소 DELETE 가정 | 중간(추정) | — | **반증** | 스펙에 GET,DELETE /conditional-orders/{id} 존재 → 유효 |

## 근본원인 (왜 오류가 많았나)
1. **어댑터가 토스 공개 스펙 없이 '가정'으로 초기 작성** → 필드/파라미터/엔드포인트가 곳곳에서 실제와 어긋남.
2. **목서버가 실서버보다 관대**(필수 파라미터/헤더 검증 누락, 미지 심볼 폴백, 응답모양 불일치) → 실서버
   전용 규칙 위반을 vitest/E2E가 구조적으로 통과시킴. ← **재발의 핵심 메커니즘**.
3. 계층별: 패키징(한글명 크래시), 키저장/모드(URL 불일치·계좌 하드), 업데이트(latest.yml 422)도 각각 별 사고.

## 재발 방지책
- **목서버를 실서버 규칙과 대칭으로 엄격화**(필수 status/헤더 검증, 응답모양 일치) → 같은 유형이 테스트에서 걸림.
- **실서버 읽기전용 자가진단 상시화**(CAPRI_SELFTEST / verify-live 확장): 배포 전 실 엔드포인트 대조.
- 해금 전 주문 바디를 openapi.json 스키마로 정적 대조(F).
