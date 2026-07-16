# CLAUDE.md — kyle-bot 작업 부트스트랩 규칙

> **작업 시작 시 이 파일과 `docs/progress.md`를 먼저 읽어라.** (진행 상황·커밋·남은 일은 progress.md에 있음)
> 이 레포는 윈도우(집)↔맥북(밖) 두 기기에서 이어 작업한다. GitHub 원격이 맥락의 저장소다.

## 프로젝트
미국 주식(토스 데이마켓·달러) 자동매매 봇. 유일 사양서: `docs/카일봇_개발설계서.md`.

## 아키텍처 (최우선 전제)
- **웹 배포 아님.** 오너 PC에서 **상시 실행하는 로컬 프로그램**이다.
- 런타임: **로컬 Node 워커 + 스케줄러 루프**(setInterval tick). Vercel Functions/Cron 안 씀.
- UI: React를 **Electron으로 감싼 데스크톱 앱**(추후).
- 시크릿: **로컬 `.env`(gitignore) + OS 환경변수.** `TOSS_CLIENT_SECRET` 커밋·프론트 노출 금지.

## 작업 방식 (오너 = 비전공자)
- **모든 코드에 한국어 주석을 상세히**, "왜 그렇게 했는지" 이유까지.
- 작업은 **단계별로 번호**를 붙여 순서대로.
- **완전 자율 진행.** 승인/팝업 묻지 말고, **AskUserQuestion 쓰지 마라.**
- 보고는 **비전공자 눈높이**로(용어는 괄호 풀이, 강의식).

## 안전 규칙 (실계좌를 다룸)
- **DRY_RUN 기본 true.** 실주문은 반드시 검증 후 명시적으로 꺼야 나간다.
- 신규 진입 주문은 **반드시 `lib/risk.ts`의 `canPlaceOrder` 게이트를 통과**해야만 나간다(우회 경로 금지).
- 실제 토스 키·실주문은 스펙 확정 + 목 서버 검증 통과 후에만.
- CATCH 등 다른 프로젝트와 **격리**(실계좌).

## 실행/검증
```bash
npm install        # 기기 바꾸면 최초 1회
npx vitest run     # 전체 테스트(현재 66개 통과)
npm run demo       # 키 없이 워커가 목 서버에 붙어 한 판 도는 데모
npm run app        # 데스크톱 앱을 개발 모드로 빌드해 실행(Electron)
npm run app:dist   # macOS 설치 파일(dmg) 생성 → release/
```
- 데스크톱 앱(S5) 완료: `electron/` + `src/App.tsx`. **v0.1은 실주문 코드 잠금(드라이런 강제)**.
- macOS 패키징 주의: productName 한글 금지(SIGTRAP) — 영문 이름 + CFBundleDisplayName 한글.

## 환경 팁
- 커밋 메시지에 큰따옴표가 있으면 PowerShell here-string이 깨진다 → `git commit -F <메시지파일>` 사용.
- 타입체크(참고): lib은 tsconfig include 밖이라, 필요 시 `tsc --noEmit --ignoreConfig` 로 개별 검사.
