# Saydaliti connector - step 3: upload data.json to the pharmacy account.
#   powershell -ExecutionPolicy Bypass -File .\upload.ps1
# Needs connector.json (made from the dashboard: Settings -> Connector). Keep that file on this PC only.

param(
  [string]$Config = (Join-Path $PSScriptRoot "connector.json"),
  [string]$Data = (Join-Path $PSScriptRoot "data.json")
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path $Config)) { throw "connector.json not found. Create it from the dashboard (Settings -> Connector)." }
if (-not (Test-Path $Data)) { throw "data.json not found. Run export.ps1 first." }
$cfg = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$json = (Get-Content $Data -Raw -Encoding UTF8).Trim([char]0xFEFF)

# Build the body without re-parsing data.json (it can be several MB)
$body = '{"p_token":' + ($cfg.token | ConvertTo-Json) + ',"p_data":' + $json + '}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Write-Host ("Uploading {0:N1} MB ..." -f ($bytes.Length / 1MB))
try {
  $id = Invoke-RestMethod -Method Post -Uri "$($cfg.supabaseUrl)/rest/v1/rpc/upload_snapshot" `
    -Headers @{ apikey = $cfg.publishableKey } -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 300
  Write-Host "Uploaded (snapshot $id). Open the dashboard to see today's numbers." -ForegroundColor Green
} catch {
  $msg = $_.ErrorDetails.Message
  if ($msg -match "invalid token") { throw "The connector code is wrong or was replaced. Make a new one from the dashboard." }
  throw "Upload failed: $msg $($_.Exception.Message)"
}
