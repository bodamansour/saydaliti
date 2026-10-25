@echo off
rem Saydaliti step 1: restore the newest backup in Downloads and write schema.json
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-and-discover.ps1" %*
pause
