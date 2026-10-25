# Saydaliti connector - export from the pharmacy database and upload. Used by the daily scheduled task.
$ErrorActionPreference = "Stop"
$log = Join-Path $PSScriptRoot "connector.log"
$cfg = Get-Content (Join-Path $PSScriptRoot "connector.json") -Raw -Encoding UTF8 | ConvertFrom-Json
Start-Transcript -Path $log -Append | Out-Null
try {
  Write-Host "=== $(Get-Date -Format s) ==="
  $exportArgs = @{}
  if ($cfg.server) { $exportArgs.Server = $cfg.server }
  if ($cfg.database) { $exportArgs.Database = $cfg.database }
  if ($cfg.sqlUser) { $exportArgs.SqlUser = $cfg.sqlUser; $exportArgs.SqlPassword = $cfg.sqlPassword }
  & (Join-Path $PSScriptRoot "export.ps1") @exportArgs
  & (Join-Path $PSScriptRoot "upload.ps1")
} catch {
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally { Stop-Transcript | Out-Null }
