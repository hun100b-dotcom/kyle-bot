@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 카일봇 현황을 불러오는 중... (읽기전용, 주문 없음)
call npx tsx scripts/report.ts
if errorlevel 1 (echo 오류가 발생했습니다. & pause & exit /b 1)
start "" report.html
