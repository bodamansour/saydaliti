# Saydaliti connector - step 1: restore the pharmacy backup and describe its tables.
# Run in PowerShell (as the same Windows user that installed SQL Server Express):
#   powershell -ExecutionPolicy Bypass -File .\restore-and-discover.ps1 -Backup "C:\Users\you\Downloads\file.gen"
#
# What it does:
#   1. Copies the backup to C:\Users\Public\Documents\saydaliti (SQL Server can read there).
#   2. Restores it as a NEW database named "SaydalitiCopy" (never touches the pharmacy's live database).
#   3. Writes schema.json next to this script: table names, column names/types and row counts ONLY.
#      No customer names, phones, prices or any other row data are read or saved.

param(
  [Parameter(Mandatory = $true)][string]$Backup,
  [string]$Server = ".\SQLEXPRESS",
  [string]$Database = "SaydalitiCopy"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Data

function Open-Sql([string]$db) {
  $cs = "Server=$Server;Database=$db;Integrated Security=True;TrustServerCertificate=True;Connect Timeout=15"
  $c = New-Object System.Data.SqlClient.SqlConnection $cs
  $c.Open()
  return $c
}

function Query($conn, [string]$sql, [int]$timeout = 60) {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = $timeout
  $t = New-Object System.Data.DataTable
  $t.Load($cmd.ExecuteReader())
  return ,$t
}

function Exec($conn, [string]$sql, [int]$timeout = 3600) {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = $timeout
  [void]$cmd.ExecuteNonQuery()
}

Write-Host "== Saydaliti: restore and discover ==" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $Backup)) { throw "Backup file not found: $Backup" }

# 1) Connect
try { $master = Open-Sql "master" }
catch {
  Write-Host "Could not connect to SQL Server at $Server." -ForegroundColor Red
  Write-Host "Check that SQL Server Express is installed and running (Services -> SQL Server (SQLEXPRESS))."
  throw
}
$ver = (Query $master "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) v").Rows[0].v
Write-Host "Connected. SQL Server version: $ver"

# 2) Copy backup where the SQL Server service can read it
$work = Join-Path $env:PUBLIC "Documents\saydaliti"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$bak = Join-Path $work "pharmacy.bak"
if (-not (Test-Path $bak) -or ((Get-Item $bak).Length -ne (Get-Item -LiteralPath $Backup).Length)) {
  Write-Host "Copying backup to $bak ..."
  Copy-Item -LiteralPath $Backup -Destination $bak -Force
}

# 3) Inspect backup header
$hdr = Query $master "RESTORE HEADERONLY FROM DISK = N'$bak'" 300
$h = $hdr.Rows[0]
Write-Host ("Backup: database '{0}', made on {1}, SQL Server {2}.{3}.{4}" -f $h.DatabaseName, $h.BackupFinishDate, $h.SoftwareVersionMajor, $h.SoftwareVersionMinor, $h.SoftwareVersionBuild)

# 4) Restore as a separate copy (skip if already restored)
$exists = (Query $master "SELECT COUNT(*) n FROM sys.databases WHERE name = N'$Database'").Rows[0].n
if ($exists -eq 0) {
  $files = Query $master "RESTORE FILELISTONLY FROM DISK = N'$bak'" 300
  $dataPath = (Query $master "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) p").Rows[0].p
  $moves = @()
  $i = 0
  foreach ($f in $files.Rows) {
    $ext = if ($f.Type -eq "L") { "ldf" } else { "mdf" }
    $target = Join-Path $dataPath ("{0}_{1}.{2}" -f $Database, $i, $ext)
    $moves += "MOVE N'$($f.LogicalName)' TO N'$target'"
    $i++
  }
  Write-Host "Restoring as '$Database' (this can take a few minutes for ~1 GB) ..."
  $sql = "RESTORE DATABASE [$Database] FROM DISK = N'$bak' WITH " + ($moves -join ", ") + ", RECOVERY, STATS = 10"
  Exec $master $sql 3600
  Write-Host "Restored." -ForegroundColor Green
} else {
  Write-Host "Database '$Database' already exists, skipping restore."
}
$master.Close()

# 5) Describe tables (names, types, row counts only)
$db = Open-Sql $Database
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
