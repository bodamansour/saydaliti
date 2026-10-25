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

if (-not (Test-Path $Mapping)) { throw "mapping.json not found. Copy mapping.example.json to mapping.json and fill it in." }
$m = Get-Content $Mapping -Raw -Encoding UTF8 | ConvertFrom-Json

function Q([string]$n) { "[" + ($n -replace "\]", "]]") + "]" }
function T([string]$t) { if ($t -match "\.") { ($t.Split(".") | ForEach-Object { Q $_ }) -join "." } else { "dbo." + (Q $t) } }
function Col($sec, [string]$key, [string]$cast) {
  $v = $sec.$key
  if ([string]::IsNullOrWhiteSpace($v)) { return "NULL AS $key" }
  return "CAST($(Q $v) AS $cast) AS $key"
}

function Run([string]$sql) {
  $auth = if ($SqlUser) { "User ID=$SqlUser;Password=$SqlPassword" } else { "Integrated Security=True" }
  $c = New-Object System.Data.SqlClient.SqlConnection "Server=$Server;Database=$Database;$auth;TrustServerCertificate=True;ApplicationIntent=ReadOnly"
  $c.Open()
  try {
    $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 600
    $t = New-Object System.Data.DataTable; $t.Load($cmd.ExecuteReader()); return ,$t
  } finally { $c.Close() }
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
  if ($s.where) { $where += " AND ($($s.where))" }
  "SELECT CAST($(Q $s.code) AS nvarchar(100)) AS code, CAST($(Q $s.date) AS date) AS date, SUM(CAST($(Q $s.qty) AS decimal(18,3))) AS qty, $amount AS amount " +
  "FROM $(T $s.table) WHERE $where GROUP BY CAST($(Q $s.code) AS nvarchar(100)), CAST($(Q $s.date) AS date)"
}
Write-Host "Reading sales (last $days days) ..."
$sales = Rows (Run $sSql) @("code", "date", "qty", "amount")

$out = [ordered]@{ exportedAt = (Get-Date).ToString("s"); items = $items; batches = $batches; sales = $sales }
$out | ConvertTo-Json -Depth 4 -Compress | Out-File -FilePath $Out -Encoding utf8
Write-Host ("Done: {0} items, {1} batches, {2} daily sales rows -> {3}" -f $items.Count, $batches.Count, $sales.Count, $Out) -ForegroundColor Green
