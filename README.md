# Capri 매매도구

Capri매매기법 **계산기 + 토스 조건주문(OCO/OTO) 제출 도구**. 데스크톱 앱(Windows/macOS).
자율 매매 봇이 아니라, 사람이 판단해 버튼을 누르면 계산·주문을 도와주는 도구입니다.

> 현재 v0.2 — **실주문은 잠금(드라이런)** 상태입니다. 소액(1주) 테스트를 사람이 통과시킨 뒤
> 별도 버전에서 해금됩니다. 지금은 계산·조회·모의주문까지 안전하게 사용할 수 있습니다.

---

## 📥 설치 방법 (오너용)

### Windows
1. [배포 페이지](https://github.com/hun100b-dotcom/kyle-bot-releases/releases/latest)에서
   **`Capri-Setup-x.y.z.exe`** 를 다운로드합니다.
2. 파일을 실행합니다.
3. ⚠️ **파란색 "Windows의 PC 보호" 경고(SmartScreen)가 뜹니다.** 이건 이 앱이 유료 코드서명
   인증서로 서명되지 않아서 뜨는 정상 경고입니다(바이러스가 아님).
   → **"추가 정보"** 클릭 → **"실행"** 버튼을 누르면 설치가 진행됩니다.
4. 설치 후 바탕화면/시작메뉴의 **"Capri 매매도구"** 아이콘으로 실행합니다.

### macOS
1. 배포 페이지에서 **`Capri-x.y.z-arm64.dmg`**(애플 실리콘) 또는
   **`Capri-x.y.z.dmg`**(인텔 맥)을 다운로드합니다.
2. dmg를 열고 앱을 **응용 프로그램** 폴더로 드래그합니다.
3. ⚠️ **첫 실행 시 "확인되지 않은 개발자" 경고(Gatekeeper)가 뜹니다.**
   → 앱 아이콘을 **우클릭(또는 Control+클릭) → "열기"** → 다시 나오는 창에서 **"열기"** 를 누릅니다.
   (한 번만 이렇게 하면 다음부터는 그냥 더블클릭으로 열립니다.)

### 처음 켠 뒤 — 로그인 하나로 끝 (v0.59.0부터)
앱을 켜면 **로그인 화면이 먼저** 뜹니다. 계정이 없으면 그 화면에서 바로 가입하세요
(이메일/비밀번호, 또는 구글 로그인 — 카카오는 준비 중). **가입은 운영자 승인이 필요합니다**
— 승인 전에는 "승인 대기 중" 화면만 보이고, 운영자가 폰이든 PC든 로그인만 하면 언제든
승인할 수 있습니다.

이미 다른 기기에서 토스 키를 등록해 둔 계정으로 로그인하면 **키·매매 이력이 자동으로
이 기기에도 동기화**됩니다(별도 입력 불필요). 이 기기가 처음이면 로그인 뒤 [설정] 탭에서
본인의 토스 Open API **Client ID / Client Secret / 계좌번호(accountSeq)** 를 한 번만
입력·저장하세요 — 키는 이 컴퓨터에만 저장되고 화면에 다시 표시되지 않습니다.

### 📱 폰에서 쓰기 (v0.59.0부터 — 로그인만 하면 어디서든)
같은 계정으로 폰 웹앱(`https://hun100b-dotcom.github.io/capri-web/`)에 로그인하면
QR 페어링 없이도 승인·매매기록·자동매매 원격 조종을 바로 쓸 수 있습니다. 다만 **실시간
시세 조회·수동 주문 실행처럼 토스 서버를 직접 불러야 하는 기능은 여전히 PC(홈 PC)가
켜져 있어야** 합니다(토스 API 키에 걸린 IP 허용목록 때문 — 로그인으로도 우회할 수 없는
제약입니다). 화면 상단의 "🟢 PC 연결됨 / 🔴 PC 꺼져 있음" 배지로 지금 원격 조종이 실제로
실행될지 확인하세요. 옛 QR 페어링([설정] → 📱 폰에서 쓰기)은 폰에서 실시간 시세·직접
조회가 필요할 때를 위해 그대로 남아 있습니다.

---

## 🔄 업데이트 방법 (오너용) — v0.58.0부터 완전 자동

**이제 아무것도 누르지 않아도 됩니다.**

- **화면(기능 개선·버그 수정 대부분)**: 앱을 껐다 켜기만 하면 그새 나온 배포가 그대로
  반영됩니다(인터넷에서 최신 화면을 바로 받아오기 때문 — 설치파일이 필요 없습니다).
  윈도우·맥 **둘 다** 똑같이 됩니다.
- **앱 자체(윈도우)**: 새 버전이 있으면 조용히 받아 두고, 오너가 10분 이상 자리를 비운
  순간(그리고 **자동매매가 꺼져 있을 때만**)에 스스로 재시작해 적용합니다. 화면 오른쪽
  위에 작은 안내가 뜨지만 누르지 않아도 됩니다 — 급하면 거기서 "지금 바로 재시작"을
  누를 수 있습니다.
- **앱 자체(맥)**: 유료 애플 개발자 인증서가 없어 윈도우처럼 스스로 재설치는 못 합니다
  (아래 "맥에서 자동 업데이트가 완전하지 않은 이유" 참고). 다만 이 경우는 **아주
  드뭅니다** — 화면이 아니라 앱의 내부 엔진 코드 자체가 바뀐 배포일 때만 해당하고, 그럴
  땐 새 dmg를 미리 받아 화면에 안내해 드립니다(눌러서 폴더 열기 → 평소처럼 설치).
- 인터넷이 안 되거나 확인에 실패해도 **앱은 그대로 정상 동작**합니다(내장된 화면으로
  자동 대체).

### 🍎 맥에서 자동 업데이트가 완전하지 않은 이유

맥의 자동 업데이트 엔진(Squirrel.Mac)은 **유료 Apple Developer Program(연 $99) 가입 +
Developer ID 인증서 + 공증(notarization)** 이 있어야만 "재설치까지 스스로" 할 수
있습니다. 이 앱은 그 조건이 없어(애드혹 서명만 적용) 그 마지막 단계만 안 됩니다.
→ **결제·계정 가입은 오너가 직접 해야 하는 일**이라 대신할 수 없습니다. 위 "화면 원격
갱신"(대부분의 배포)과 "새 dmg 자동 다운로드"(드문 엔진 배포)로 실사용 불편은 최대한
줄여 뒀습니다.

---

## 🛠 새 버전 배포 방법 (개발자용)

배포는 **바이너리 전용 공개 레포**([kyle-bot-releases](https://github.com/hun100b-dotcom/kyle-bot-releases))로 나갑니다.
소스 레포(kyle-bot)는 private로 유지합니다.

1. `package.json` 의 `version` 을 올린다 (예: `0.8.3` → `0.8.4`).
2. 빌드 + 배포 (**한 줄**) — `web:deploy`(폰 웹앱 + PC앱 원격 화면)까지 자동으로 함께 됩니다:
   ```bash
   npm run release:win     # 윈도우: 화면 배포 → .exe 빌드 → 릴리스 업로드
   npm run release:mac     # 맥:   화면 배포 → .dmg + .zip 빌드 → 릴리스 업로드 (맥에서만 가능)
   ```
3. **화면(UI) 변경**은 사용자 앱이 **다음 실행 때 바로** 반영됩니다(설치파일 불필요 —
   electron/main.ts의 원격 화면 로딩). **엔진(메인 프로세스) 코드 변경**은 여전히
   설치파일이 필요합니다 — 윈도우는 조용히 자동 적용되고, 맥은 새 dmg를 자동으로 받아
   화면에 안내합니다(README 위 "🔄 업데이트 방법" 참고).

**토큰은 따로 설정하지 않아도 됩니다.** 배포 스크립트(`scripts/publish-release.mjs`)가
`GH_TOKEN` → `gh auth token` → 저장된 git 자격증명 순서로 알아서 찾습니다.
(어느 것도 없으면 `gh auth login` 한 번만 하면 됩니다.)

- **빌드만**(배포 없이 설치파일만): `npm run dist:win` / `npm run dist:mac` → `release/` 폴더.
- **이미 빌드된 걸 올리기만**: `npm run publish:release` (`--dry-run` 붙이면 올릴 목록만 확인).
- **아이콘 다시 만들기**: `npm run icon` → `build/icon.png`(1024×1024). electron-builder가
  윈도우 `.ico`·맥 `.icns` 로 자동 변환합니다. 외부 라이브러리 없이 순수 Node로 그립니다.

### ⚠️ 자동 업데이트가 깨지는 3가지 함정 (실제로 겪은 사고)
1. **`latest.yml` 이 릴리스에 없으면 업데이트 팝업이 아예 안 뜬다.** electron-builder의
   `--publish always` 가 이 파일 업로드에서 422 오류를 내는 일이 4번 반복됐다.
   → 그래서 배포를 `scripts/publish-release.mjs` 로 옮겼다. 이 스크립트는 `latest.yml` 을
   **기준**으로 올릴 목록을 정하고, 업로드 후 **다시 내려받아 로컬과 같은지 검증**한다.
2. **파일 이름의 공백.** 빌드 결과는 `Capri Setup 0.8.4.exe`(공백)인데 GitHub 자산 이름은
   `Capri-Setup-0.8.4.exe`(하이픈)여야 `latest.yml` 과 짝이 맞는다. 스크립트가 자동 변환한다.
3. **맥은 dmg만으론 자동 업데이트가 안 된다.** 맥의 electron-updater는 `.zip` 을 내려받는다.
   그래서 `electron-builder.yml` 의 mac 타깃에 `dmg` 와 `zip` 을 **둘 다** 넣어 두었다
   (`latest-mac.yml` 도 함께 업로드된다).

### 🍎 맥에서 처음 빌드할 때 (맥북 세션 체크리스트)
```bash
git pull                 # 윈도우에서 올린 최신 코드 받기
npm install              # 기기가 바뀌면 최초 1회
npx vitest run           # 테스트 전부 통과하는지 확인
npm run release:mac      # dmg + zip 빌드 → 릴리스 업로드까지 한 줄
```
- **맥에서만 가능**합니다(애플의 dmg/코드서명 도구가 맥에만 있음). 윈도우에서는 만들 수 없습니다.
- 애플 개발자 인증서가 없어 **애드혹("-") 서명**으로 나갑니다(`electron-builder.yml`의
  `mac.identity: "-"`). 애드혹 서명이 없으면(`identity: null`) 애플 실리콘 맥은 앱 실행
  자체가 거부됩니다 — v0.32.1에서 겪은 실제 사고, 지금은 CI가 이 서명 여부를 매번
  검증합니다(`ship.yml`의 "애드혹 서명 확인" 단계). 첫 실행은 **우클릭 → 열기**로 통과합니다.
- ⚠️ **실행파일 이름에 한글을 넣지 말 것.** 예전에 `productName` 을 한글("카일봇")로 했더니
  애플 실리콘 맥에서 앱 부팅 자체가 SIGTRAP 크래시했습니다. 실행파일은 영문 `Capri`,
  화면 표시명만 `CFBundleDisplayName` 으로 지정합니다.
- 릴리스에 dmg가 올라가면 README 설치 안내(위 macOS 절)가 그대로 유효해집니다.

---

## 👤 계정·로그인 체계 (v0.59.0)

Supabase Auth 기반. 가입은 **항상 성공**하고(예전처럼 허용목록에 없으면 가입 자체가
막히던 방식이 아님), 승인 전엔 `capri_accounts.status`가 `pending`으로 남아 **RLS가
서버에서** 매매 데이터(`capri_secrets`·`capri_trades`·`capri_auto_state`) 접근을 막습니다
— 화면의 "승인 대기 중" 표시는 UX일 뿐, 진짜 차단은 DB가 합니다. 스키마·트리거는
`supabase/migrations/20260930120000_capri_login_gate.sql`(로그인 게이트) +
`20260930130000_capri_remote_control.sql`(폰 원격 조종, 아래 참고).

**적용 방법**: 이 저장소를 새로 클론한 기기에서 직접 Supabase 대시보드로 DB 스키마를
바꿀 일은 없습니다(이미 실제 프로젝트에 적용 완료). 스키마를 더 바꿔야 하면
[Supabase SQL Editor](https://supabase.com/dashboard/project/fauieykjxdfkngwvfoky/sql/new)에
새 마이그레이션 파일 내용을 그대로 붙여넣어 실행하고, 같은 내용을
`supabase/migrations/`에도 파일로 남겨 두세요(레포와 실제 DB가 항상 같은 상태를 유지하기 위함).

### 소셜 로그인(구글·카카오)
- **구글**: 설정 완료·동작 중(Google Cloud 프로젝트 "Capri", OAuth 동의 화면은 테스트
  모드 — 테스트 사용자로 등록된 이메일만 로그인 가능, 100명까지 무료로 추가 가능).
  테스트 사용자 추가: [Google Cloud 콘솔 → 대상](https://console.cloud.google.com/auth/audience) →
  프로젝트 "Capri" 선택 → 테스트 사용자에 이메일 추가.
- **카카오**: 아직 미설정. [Kakao Developers](https://developers.kakao.com)에서 앱 생성 →
  카카오 로그인 활성화 → Redirect URI에 `https://fauieykjxdfkngwvfoky.supabase.co/auth/v1/callback`
  등록 → REST API 키 + Client Secret 발급 → [Supabase Auth Providers](https://supabase.com/dashboard/project/fauieykjxdfkngwvfoky/auth/providers)의
  Kakao 항목에 입력·저장. 오너의 카카오 계정 로그인이 필요해 이 저장소 작업만으로는
  대신할 수 없습니다.

### 디스코드 알림
새 가입 대기가 생기면 DB 트리거(`capri_notify_new_pending_account`, pg_net 사용)가
`capri_notify_settings.discord_webhook_url`로 직접 알림을 보냅니다(앱이 꺼져 있어도 옴).
디스코드 서버 → 채널 설정 → 연동 → 웹후크 만들기로 주소를 받아, 앱의
[👥 그룹원 관리] 탭(오너 로그인 시)에서 그 주소를 붙여넣고 저장하면 됩니다 — SQL 불필요.

### 폰 원격 조종
`capri_commands`(명령 큐, PC가 8초마다 폴링해 실행) + `capri_desktop_heartbeat`(PC 생존
신호, 폰 화면 상단 배지가 참조) 두 표로 동작합니다. Supabase Realtime은 이 프로젝트에서
`relation "realtime.subscription" does not exist` 오류로 못 쓰는 상태라 폴링 방식을 씁니다.
지원 명령(전부 `electron/tool-engine.ts`의 `dispatchCommand` 화이트리스트에 있는 기존
IPC 메서드 그대로 호출 — 안전장치 우회 경로 없음): `autoTradeStart`·`autoTradeStop`·
`saveAutoTradeSettings`·`setKillSwitch`·`placeEntry`·`placeSell`·`cancelAutoPosition`·
`autoScanNow`. 화면(자동매매 컨트롤 탭)에는 이 중 자주 쓰는 몇 개만 버튼으로 연결돼 있고,
`placeEntry`/`placeSell`은 서버·엔진 쪽은 이미 준비돼 있지만 아직 폰 화면에 입력 폼을
만들지 않았습니다.

---

## 🔒 보안

- **실제 API 키(.env)는 앱/설치파일/릴리스에 절대 포함되지 않습니다.**
  `electron-builder.yml` 의 `files` 화이트리스트 + `!**/.env` 제외로 이중 차단, 빌드 후 산출물에서
  키 문자열이 없음을 실제로 검증합니다.
- 키는 사용자가 설정 탭에서 입력해 본인 컴퓨터에만 저장합니다.

---

## 💻 개발

```bash
npm install
npm test        # vitest 150개
npm run app     # 개발 모드로 앱 실행
```
자세한 진행 상황·아키텍처는 `docs/progress.md` 참고.
