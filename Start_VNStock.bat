@echo off
title VN Stock Market Server
echo.
echo ========================================
echo    VN STOCK MARKET SERVER
echo ========================================
echo.

:: Kiem tra da chay server chua
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Server da chay san. Dang mo trinh duyet...
    start http://localhost:3000
    timeout /t 2 >nul
    exit
)

echo Dang khoi dong server...
echo.
cd /d "%~dp0server"

:: Mo trinh duyet sau 3 giay de server co thoi gian khoi dong
start "" cmd /c "timeout /t 3 >nul && start http://localhost:3000"

:: Chay server
npm start
