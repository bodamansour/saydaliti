@echo off
rem Saydaliti step 2: read stock and sales from the restored copy into data.json
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export.ps1" %*
pause
