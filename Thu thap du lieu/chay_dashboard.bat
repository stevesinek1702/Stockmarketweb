@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Fireant Dashboard - DUNG DONG CUA SO NAY
echo ============================================================
echo   FIREANT DASHBOARD
echo   Dang khoi dong server... (GIU NGUYEN cua so nay khi dung)
echo ============================================================
echo.

REM Thu lenh 'python', neu khong co thi thu 'py'
where python >nul 2>nul
if %errorlevel%==0 (
    python fireant_dashboard.py
    goto done
)
where py >nul 2>nul
if %errorlevel%==0 (
    py fireant_dashboard.py
    goto done
)

echo [LOI] Khong tim thay Python tren may.
echo Hay cai Python tu https://www.python.org/downloads/ (nho tick "Add to PATH").

:done
echo.
echo ============================================================
echo   Server da dung. Nhan phim bat ky de dong cua so.
echo ============================================================
pause >nul
