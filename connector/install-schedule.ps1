# Saydaliti connector - run export + upload every day at the given time (default 07:00).
#   powershell -ExecutionPolicy Bypass -File .\install-schedule.ps1 -At 07:00
# Runs as the current Windows user, while that user is signed in on this PC.
param([string]$At = "07:00")
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "run-daily.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "Saydaliti Daily" -Action $action -Trigger $trigger -Settings $settings -Description "Export pharmacy stock and sales, upload to Saydaliti" -Force | Out-Null
Write-Host "Scheduled: every day at $At. Log file: $(Join-Path $PSScriptRoot 'connector.log')" -ForegroundColor Green
Write-Host "To run it now: Start-ScheduledTask -TaskName 'Saydaliti Daily'"
