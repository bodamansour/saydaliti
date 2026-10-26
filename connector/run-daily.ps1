# Saydaliti connector - export from the pharmacy database and upload. Used by the daily scheduled task.
$ErrorActionPreference = "Stop"
$log = Join-Path $PSScriptRoot "connector.log"
$cfg = Get-Content (Join-Path $PSScriptRoot "connector.json") -Raw -Encoding UTF8 | ConvertFrom-Json
Start-Transcript -Path $log -Append | Out-Null
try {
  Write-Host "=== $(Get-Date -Format s) ==="
  if ($cfg.geniusBackupDir) {
    # Genius: read the newest backup file directly (no SQL Server, no backup password needed)
    $bak = Get-ChildItem -LiteralPath $cfg.geniusBackupDir -File | Where-Object { $_.Extension -in ".gen", ".bak" } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $bak) { throw "No .gen/.bak file in $($cfg.geniusBackupDir)" }
    Write-Host "Genius backup: $($bak.FullName) ($($bak.LastWriteTime))"
    $py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } else { "python" }
    & $py (Join-Path $PSScriptRoot "genius\genius_export.py") $bak.FullName (Join-Path $PSScriptRoot "data.json")
    if ($LASTEXITCODE -ne 0) { throw "genius_export.py failed" }
    & (Join-Path $PSScriptRoot "upload.ps1")
    return
  }
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
