# Saydaliti connector - step 1 on the pharmacy PC itself (no backup, no password):
# finds the pharmacy program's SQL Server database on THIS computer and describes its tables.
#   Double-click step1-live.bat on the PC where the pharmacy database runs (e.g. SERVER-PC).
# Read-only: it only lists table/column names and row counts. Nothing is changed or copied.
# It also writes connection.json so step 2 (export) reads from the same database.

param(
  [string]$Server,
  [string]$Database,
  [string]$SqlUser = "",
  [string]$SqlPassword = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Data

function Open-Sql([string]$srv, [string]$db) {
  $auth = if ($SqlUser) { "User ID=$SqlUser;Password=$SqlPassword" } else { "Integrated Security=True" }
  $c = New-Object System.Data.SqlClient.SqlConnection "Server=$srv;Database=$db;$auth;TrustServerCertificate=True;ApplicationIntent=ReadOnly;Connect Timeout=8"
  $c.Open()
  return $c
}

function Query($conn, [string]$sql, [int]$timeout = 120) {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = $timeout
  $t = New-Object System.Data.DataTable
  $t.Load($cmd.ExecuteReader())
  return ,$t
}

Write-Host "== Saydaliti: find the pharmacy database on this PC ==" -ForegroundColor Cyan

# 1) Candidate SQL Server instances installed on this computer
$servers = @()
if ($Server) { $servers = @($Server) } else {
  $reg = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL"
  if (Test-Path $reg) {
    (Get-Item $reg).Property | ForEach-Object { $servers += $(if ($_ -eq "MSSQLSERVER") { "." } else { ".\$_" }) }
  }
  if (-not $servers) { $servers = @(".", ".\SQLEXPRESS") }
}

# 2) Connect and find user databases, biggest first
$found = $null
if ($Server -and $Database) { $found = @{ server = $Server; database = $Database }; $servers = @() }
foreach ($srv in $servers) {
  try {
    $master = Open-Sql $srv "master"
    $dbs = Query $master @"
SELECT d.name, CAST(SUM(mf.size) * 8 / 1024 AS int) AS mb
FROM sys.databases d JOIN sys.master_files mf ON mf.database_id = d.database_id
WHERE d.database_id > 4 AND d.state = 0 AND d.name NOT IN ('SaydalitiCopy', 'ReportServer', 'ReportServerTempDB')
GROUP BY d.name ORDER BY mb DESC
"@
    $master.Close()
    Write-Host "Server $srv databases:"
    foreach ($r in $dbs.Rows) { Write-Host ("  {0}  ({1} MB)" -f $r.name, $r.mb) }
    if ($dbs.Rows.Count -gt 0 -and -not $found) {
      $pick = if ($Database) { $Database } else { $dbs.Rows[0].name }
      $found = @{ server = $srv; database = $pick }
    }
  } catch {
    Write-Host "Could not open $srv with this Windows account: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
if (-not $found) {
  Write-Host ""
  Write-Host "No database could be opened. Run this as the Windows user that uses the pharmacy program," -ForegroundColor Red
  Write-Host "or pass a SQL login:  step1-live.bat -SqlUser name -SqlPassword pass"
  throw "No pharmacy database found"
}
$Server = $found.server
$Database = $found.database
Write-Host ("Using database '{0}' on '{1}'. (Pass -Database to choose another.)" -f $Database, $Server) -ForegroundColor Green
$ver = "live"
$h = @{ DatabaseName = $Database; BackupFinishDate = (Get-Date).ToString("s") }

[ordered]@{ server = $Server; database = $Database; sqlUser = $SqlUser } | ConvertTo-Json | Out-File -FilePath (Join-Path $PSScriptRoot "connection.json") -Encoding utf8

# 5) Describe tables (names, types, row counts only)
$db = Open-Sql $Server $Database
$tables = Query $db @"
SELECT s.name AS [schema], t.name AS [table], SUM(p.rows) AS [rows]
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
GROUP BY s.name, t.name
ORDER BY SUM(p.rows) DESC
"@
$cols = Query $db @"
SELECT s.name AS [schema], t.name AS [table], c.name AS [column], ty.name AS [type], c.column_id AS [pos]
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY s.name, t.name, c.column_id
"@
$db.Close()

$out = [ordered]@{
  generatedAt = (Get-Date).ToString("s")
  sqlServer = $ver
  backupDatabase = "$($h.DatabaseName)"
  backupDate = "$($h.BackupFinishDate)"
  tables = @()
}
foreach ($t in $tables.Rows) {
  $c = $cols.Select("[schema] = '$($t.schema)' AND [table] = '$($t.table -replace "'", "''")'") | ForEach-Object { [ordered]@{ name = $_.column; type = $_.type } }
  $out.tables += [ordered]@{ schema = $t.schema; name = $t.table; rows = [int64]$t.rows; columns = @($c) }
}

$jsonPath = Join-Path $PSScriptRoot "schema.json"
$out | ConvertTo-Json -Depth 6 | Out-File -FilePath $jsonPath -Encoding utf8
Write-Host ""
Write-Host ("Done. {0} tables described in:" -f $out.tables.Count) -ForegroundColor Green
Write-Host "  $jsonPath"
Write-Host "Send this schema.json file. It has table and column names only, no customer or sales data."
