# Saydaliti connector - step 2: read stock, batches and daily sales from the restored copy into data.json.
#   powershell -ExecutionPolicy Bypass -File .\export.ps1
# Uses mapping.json (next to this script) to know which tables/columns hold what.
# Reads ONLY: item code/name/category/cost/price/owner, stock per batch with expiry, and sales summed per item per day.
# Never reads customer names, phones or invoice-level details.

param(
  [string]$Server = ".\SQLEXPRESS",
  [string]$Database = "SaydalitiCopy",
  [string]$Mapping = (Join-Path $PSScriptRoot "mapping.json"),
  [string]$Out = (Join-Path $PSScriptRoot "data.json"),
  [string]$SqlUser = "",
  [string]$SqlPassword = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Data

# step1-live writes connection.json when reading the pharmacy database directly (no backup)
$connFile = Join-Path $PSScriptRoot "connection.json"
if ((Test-Path $connFile) -and -not $PSBoundParameters.ContainsKey("Server") -and -not $PSBoundParameters.ContainsKey("Database")) {
  $cj = Get-Content $connFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $Server = $cj.server
  $Database = $cj.database
  if ($cj.sqlUser -and -not $SqlUser) { $SqlUser = $cj.sqlUser }
  Write-Host "Reading directly from '$Database' on '$Server' (from connection.json)."
}
# A SQL login needs its password here too (it is never saved by step 1): from connector.json, the
# SAYDALITI_SQL_PASSWORD environment variable, or typed now.
if ($SqlUser -and -not $SqlPassword) {
  $cfgFile = Join-Path $PSScriptRoot "connector.json"
  if (Test-Path $cfgFile) { $cc = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json; if ($cc.sqlUser -eq $SqlUser -and $cc.sqlPassword) { $SqlPassword = $cc.sqlPassword } }
  if (-not $SqlPassword -and $env:SAYDALITI_SQL_PASSWORD) { $SqlPassword = $env:SAYDALITI_SQL_PASSWORD }
  if (-not $SqlPassword -and [Environment]::UserInteractive) {
    $sec = Read-Host "Password for SQL user '$SqlUser'" -AsSecureString
    $SqlPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if (-not $SqlPassword) { throw "No password for SQL user '$SqlUser'. Put it in connector.json (sqlPassword) or SAYDALITI_SQL_PASSWORD." }
}

if (-not (Test-Path $Mapping)) { throw "mapping.json not found. Copy mapping.example.json to mapping.json and fill it in." }
$m = Get-Content $Mapping -Raw -Encoding UTF8 | ConvertFrom-Json

function Q([string]$n) { "[" + ($n -replace "\]", "]]") + "]" }
function T([string]$t) { if ($t -match "\.") { ($t.Split(".") | ForEach-Object { Q $_ }) -join "." } else { "dbo." + (Q $t) } }
function Col($sec, [string]$key, [string]$cast) {
  $v = $sec.$key
  if ([string]::IsNullOrWhiteSpace($v)) { return "NULL AS $key" }
  return "CAST($(Q $v) AS $cast) AS $key"
}

# Queries from mapping.json are only allowed to read: one SELECT (or WITH … SELECT), no statements
# that change anything — and every query runs inside a transaction that is always rolled back.
function Assert-ReadOnly([string]$sql) {
  $t = ($sql -replace "--[^\r\n]*", " " -replace "/\*[\s\S]*?\*/", " ").Trim()
  if ($t -notmatch '^(?i)(select|with)\b') { throw "mapping.json: a query must start with SELECT (or WITH). Refused: $($t.Substring(0, [Math]::Min(80, $t.Length)))" }
  if ($t.TrimEnd(';') -match ';') { throw "mapping.json: only one statement per query." }
  if ($t -match '(?i)\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|backup|restore|dbcc|shutdown|kill|into|openrowset|opendatasource|xp_\w+|sp_\w+)\b') { throw "mapping.json: a query may only read data. Refused: $($t.Substring(0, [Math]::Min(80, $t.Length)))" }
}
function Run([string]$sql) {
  Assert-ReadOnly $sql
  $auth = if ($SqlUser) { "User ID=$SqlUser;Password=$SqlPassword" } else { "Integrated Security=True" }
  $c = New-Object System.Data.SqlClient.SqlConnection "Server=$Server;Database=$Database;$auth;TrustServerCertificate=True;ApplicationIntent=ReadOnly"
  $c.Open()
  $tx = $c.BeginTransaction()
  try {
    $cmd = $c.CreateCommand(); $cmd.Transaction = $tx; $cmd.CommandText = $sql; $cmd.CommandTimeout = 600
    $t = New-Object System.Data.DataTable; $t.Load($cmd.ExecuteReader()); return ,$t
  } finally { try { $tx.Rollback() } catch { }; $c.Close() }
}

function Rows($table, [string[]]$cols) {
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($r in $table.Rows) {
    $o = [ordered]@{}
    foreach ($c in $cols) {
      $v = $r[$c]
      if ($v -is [DBNull]) { $v = $null }
      elseif ($v -is [DateTime]) { $v = $v.ToString("yyyy-MM-dd") }
      $o[$c] = $v
    }
    $list.Add([pscustomobject]$o)
  }
  return ,$list
}

# ---- Items ----
$i = $m.items
$itemsSql = if ($i.sql) { $i.sql } else {
  "SELECT " + ((Col $i "code" "nvarchar(100)"), (Col $i "name" "nvarchar(300)"), (Col $i "category" "nvarchar(100)"),
    (Col $i "cost" "decimal(18,3)"), (Col $i "price" "decimal(18,3)"), (Col $i "owner" "nvarchar(100)"),
    (Col $i "qty" "decimal(18,3)"), (Col $i "expiry" "date") -join ", ") + " FROM $(T $i.table)"
}
Write-Host "Reading items ..."
$items = Rows (Run $itemsSql) @("code", "name", "category", "cost", "price", "owner", "qty", "expiry")

# ---- Batches (optional: stock per expiry date) ----
$batches = @()
if ($m.batches) {
  $b = $m.batches
  $bSql = if ($b.sql) { $b.sql } else {
    "SELECT CAST($(Q $b.code) AS nvarchar(100)) AS code, SUM(CAST($(Q $b.qty) AS decimal(18,3))) AS qty, CAST($(Q $b.expiry) AS date) AS expiry " +
    "FROM $(T $b.table) WHERE $(Q $b.qty) > 0 GROUP BY CAST($(Q $b.code) AS nvarchar(100)), CAST($(Q $b.expiry) AS date)"
  }
  Write-Host "Reading batches ..."
  $batches = Rows (Run $bSql) @("code", "qty", "expiry")
}

# ---- Sales, summed per item per day ----
$s = $m.sales
$days = if ($m.salesDays) { [int]$m.salesDays } else { 180 }
$sSql = if ($s.sql) { $s.sql -replace "\{days\}", $days } else {
  $amount = if ($s.amount) { "SUM(CAST($(Q $s.amount) AS decimal(18,3)))" } else { "NULL" }
  $where = "$(Q $s.date) >= DATEADD(day, -$days, GETDATE())"
  if ($s.where) { Assert-ReadOnly "SELECT 1 WHERE $($s.where)"; $where += " AND ($($s.where))" }
  "SELECT CAST($(Q $s.code) AS nvarchar(100)) AS code, CAST($(Q $s.date) AS date) AS date, SUM(CAST($(Q $s.qty) AS decimal(18,3))) AS qty, $amount AS amount " +
  "FROM $(T $s.table) WHERE $where GROUP BY CAST($(Q $s.code) AS nvarchar(100)), CAST($(Q $s.date) AS date)"
}
Write-Host "Reading sales (last $days days) ..."
$sales = Rows (Run $sSql) @("code", "date", "qty", "amount")

$out = [ordered]@{ exportedAt = (Get-Date).ToString("s"); items = $items; batches = $batches; sales = $sales }
$out | ConvertTo-Json -Depth 4 -Compress | Out-File -FilePath $Out -Encoding utf8
Write-Host ("Done: {0} items, {1} batches, {2} daily sales rows -> {3}" -f $items.Count, $batches.Count, $sales.Count, $Out) -ForegroundColor Green
