@echo off
rem Saydaliti step 1 on the pharmacy PC: read the pharmacy database directly (no backup needed)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0discover-live.ps1" %*
pause
