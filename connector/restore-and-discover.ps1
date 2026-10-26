# Saydaliti connector - step 1: restore the pharmacy backup and describe its tables.
# Run in PowerShell (as the same Windows user that installed SQL Server Express):
#   powershell -ExecutionPolicy Bypass -File .\restore-and-discover.ps1 -Backup "C:\Users\you\Downloads\file.gen"
#   Without -Backup it uses the newest .gen/.bak file in your Downloads folder.
#
# What it does:
#   1. Copies the backup to C:\Users\Public\Documents\saydaliti (SQL Server can read there).
#   2. Restores it as a NEW database named "SaydalitiCopy" (never touches the pharmacy's live database).
#   3. Writes schema.json next to this script: table names, column names/types and row counts ONLY.
#      No customer names, phones, prices or any other row data are read or saved.

param(
  [string]$Backup,
  [string]$Server = ".\SQLEXPRESS",
  [string]$Database = "SaydalitiCopy",
  [string]$BackupPassword
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

if (-not $Backup) {
  $dl = Join-Path $env:USERPROFILE "Downloads"
  $latest = Get-ChildItem -LiteralPath $dl -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in ".gen", ".bak" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { throw "No .gen or .bak file found in $dl. Pass -Backup with the file path." }
  $Backup = $latest.FullName
  Write-Host "Using newest backup in Downloads: $Backup"
}
if (-not (Test-Path -LiteralPath $Backup)) { throw "Backup file not found: $Backup" }

# 0) Catch an unfinished backup early: a real backup has data spread through the file,
#    an interrupted one is mostly zeros after the first few MB.
function Test-BackupHasData([string]$path) {
  $len = (Get-Item -LiteralPath $path).Length
  if ($len -lt 16MB) { return $true }  # small databases: let SQL Server judge
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $buf = New-Object byte[] 65536
    $nonZero = 0
    for ($k = 1; $k -le 16; $k++) {
      $fs.Position = [int64](8MB + ($len - 8MB - 65536) * $k / 16)
      $n = $fs.Read($buf, 0, $buf.Length)
      for ($j = 0; $j -lt $n; $j += 64) { if ($buf[$j] -ne 0) { $nonZero++; break } }
    }
    return ($nonZero -ge 2)
  } finally { $fs.Close() }
}
if (-not (Test-BackupHasData $Backup)) {
  Write-Host "This backup file looks unfinished (almost all zeros)." -ForegroundColor Red
  Write-Host "Make a new backup from the pharmacy program, wait until it says the backup is complete, then copy it again."
  throw "Backup is incomplete: $Backup"
}

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
$copied = $false
$src = Get-Item -LiteralPath $Backup
if (-not (Test-Path $bak) -or ((Get-Item $bak).Length -ne $src.Length) -or ((Get-Item $bak).LastWriteTime -lt $src.LastWriteTime)) {
  Write-Host "Copying backup to $bak ..."
  Copy-Item -LiteralPath $Backup -Destination $bak -Force
  $copied = $true
}

# 3) Inspect backup header
# Some pharmacy programs protect their backups with a password (WITH PASSWORD).
$pw = ""
$pwOpts = ""
if ($BackupPassword) {
  $q = $BackupPassword -replace "'", "''"
  $pwOpts = "PASSWORD = N'$q'"
  $pw = " WITH $pwOpts"
}
$hdr = Query $master "RESTORE HEADERONLY FROM DISK = N'$bak'" 300  # the header is readable without the password
$h = $hdr.Rows[0]
Write-Host ("Backup: database '{0}', made on {1}, SQL Server {2}.{3}.{4}" -f $h.DatabaseName, $h.BackupFinishDate, $h.SoftwareVersionMajor, $h.SoftwareVersionMinor, $h.SoftwareVersionBuild)

# 4) Restore as a separate copy (skip if already restored)
$exists = (Query $master "SELECT COUNT(*) n FROM sys.databases WHERE name = N'$Database'").Rows[0].n
if ($exists -eq 0 -or $copied) {
  try { $files = Query $master "RESTORE FILELISTONLY FROM DISK = N'$bak'$pw" 300 }
  catch {
    if ("$_" -match "password" -and $BackupPassword) {
      Write-Host ""
      Write-Host "The password was not accepted. Check it (capital letters, spaces) and try again." -ForegroundColor Red
    } elseif ("$_" -match "password") {
      Write-Host ""
      Write-Host "This backup is protected with a password set by the pharmacy program." -ForegroundColor Red
      Write-Host "Run again with the password:  step1-restore.bat -BackupPassword ""the-password"""
      Write-Host "Ask the program's support for it, or look in the program's settings/config on the pharmacy PC."
    }
    throw
  }
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
  $sql = "RESTORE DATABASE [$Database] FROM DISK = N'$bak' WITH " + ($moves -join ", ") + ", RECOVERY, REPLACE, STATS = 10" + ($(if ($pwOpts) { ", $pwOpts" } else { "" }))
  Exec $master $sql 3600
  Write-Host "Restored." -ForegroundColor Green
} else {
  Write-Host "Database '$Database' already restored from this backup, skipping restore."
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
