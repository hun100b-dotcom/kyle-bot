#!/bin/bash
# =============================================================================
# scripts/mac-update-e2e.sh — 맥 자동 업데이트를 "실제 맥에서 처음부터 끝까지" 재현·검증
# -----------------------------------------------------------------------------
# [왜 필요한가]
#   2026-10-21 오너 보고: 맥에서 자동 업데이트로 재시작되면 앱이 그대로 꺼지고 다시 안 켜진다.
#   맥 자동 업데이트는 "앱이 스스로 자기 번들(Capri.app)을 갈아끼우는" 방식이라(mac-self-update.ts),
#   리눅스·윈도우에서는 절대 시험해 볼 수 없다. 그래서 GitHub의 진짜 맥 컴퓨터(macos 러너)에서
#   사용자가 겪는 그대로를 재현한다:
#     ① 옛 버전을 사용자와 똑같이 .pkg 설치팩으로 /Applications 에 설치한다(관리자 권한 설치).
#     ② 그 앱을 실행해 두고 **앱이 스스로** 새 버전을 받아 재시작하게 내버려 둔다.
#     ③ 일정 시간 뒤 "새 버전이 /Applications 에 있고, 실제로 실행 중인가"를 확인한다.
#
# [사용법]  mac-update-e2e.sh <옛 버전 pkg 경로> <기대하는 새 버전 번호> [최대 대기 초]
#   - 새 버전은 앱이 GitHub 릴리스(또는 CAPRI_UPDATE_FEED_DIR 로 지정한 로컬 폴더)에서 직접 받는다.
# =============================================================================
set -u
OLD_PKG="$1"
WANT_VERSION="$2"
MAX_WAIT="${3:-420}"
APP="/Applications/Capri.app"
LOG_DIR="${RUNNER_TEMP:-/tmp}/capri-e2e"
mkdir -p "$LOG_DIR"

ver_of() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist" 2>/dev/null || echo "(없음)"; }
is_running() { pgrep -f "$APP/Contents/MacOS/Capri" >/dev/null 2>&1; }

echo "== ① 옛 버전 설치(.pkg, 사용자와 똑같이 관리자 권한) =="
sudo rm -rf "$APP"
sudo installer -pkg "$OLD_PKG" -target / || { echo "::error::pkg 설치 실패"; exit 1; }
echo "설치된 버전: $(ver_of "$APP")"
ls -ld "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -3

echo "== ② 옛 버전 실행 — 앱이 스스로 업데이트·재시작하도록 둔다 =="
# 앱 출력(console.log)을 파일로 받으려고 실행파일을 직접 띄운다(재시작 뒤엔 교체 스크립트가 open 으로 띄움).
"$APP/Contents/MacOS/Capri" >"$LOG_DIR/old-app.log" 2>&1 &
OLD_PID=$!
echo "옛 앱 PID=$OLD_PID"

START=$(date +%s)
RESULT="timeout"
while :; do
  sleep 5
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))
  V="$(ver_of "$APP")"
  if ! kill -0 "$OLD_PID" 2>/dev/null; then
    # 옛 앱이 꺼졌다 → 재시작 단계. 새 버전이 떠 있는지 본다.
    if [ "$V" = "$WANT_VERSION" ] && is_running; then
      # 바로 죽는 경우(서명 문제 등)를 걸러내려고 20초 더 살아 있는지 확인한다.
      sleep 20
      if is_running; then RESULT="ok"; break; fi
      RESULT="new-app-died"; break
    fi
  fi
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then break; fi
  echo "  …${ELAPSED}초: 설치 버전=$V, 옛 앱 실행중=$(kill -0 "$OLD_PID" 2>/dev/null && echo 예 || echo 아니오), Capri 실행중=$(is_running && echo 예 || echo 아니오)"
done

echo "== ③ 결과: $RESULT =="
echo "최종 설치 버전: $(ver_of "$APP") (기대: $WANT_VERSION)"
ls -la /Applications | grep -i capri || true
ls -ld "$APP" 2>/dev/null || true
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -5 || true
echo "--- 실행 중 프로세스 ---"; pgrep -fl Capri || true
echo "--- 옛 앱 로그(업데이트 관련) ---"; grep -i "update\|capri\]\[" "$LOG_DIR/old-app.log" | tail -40 || true
echo "--- 교체 스크립트 로그 ---"; cat "$HOME/Library/Logs/Capri/update-swap.log" 2>/dev/null || echo "(없음 — 옛 버전은 로그를 안 남김)"
echo "--- 커널/AMFI 서명 거부 기록 ---"
log show --last 10m --style compact --predicate '(eventMessage CONTAINS[c] "Capri") AND (process == "kernel" OR process == "amfid" OR process == "syspolicyd" OR process == "tccd")' 2>/dev/null | tail -40 || true
echo "--- 충돌 보고서 ---"; ls -la "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | grep -i capri || echo "(없음)"

pkill -f "$APP/Contents/MacOS/Capri" 2>/dev/null || true
[ "$RESULT" = "ok" ] || exit 1
