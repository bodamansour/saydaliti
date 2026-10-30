# Saydaliti - reads the United (Genius) database on this computer for the live sync.
# Read-only: only SELECT ... WITH (NOLOCK), so the pharmacy program is never changed or blocked.
# Works with Windows PowerShell 2.0 (Windows 7) and later, and SQL Server 2000 and later.
#
#   -Find -Out f.txt                                     lists SQL Server instances and the Genius databases
#   -Server s -Database d -From yyyyMMdd -Out f.txt      writes the tables the sync needs
# A SQL login: -User name, with the password in the SAYDALITI_SQL_PASSWORD environment variable.
# The result is written as UTF-8 text; on failure the message is written to <Out>.err and the exit code is 1.
param(
  [switch]$Find,
  [string]$Server = '',
  [string]$Database = '',
  [string]$User = '',
  [string]$From = '',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
[void][Reflection.Assembly]::LoadWithPartialName('System.Data')
$inv = [Globalization.CultureInfo]::InvariantCulture
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Clean([string]$s) { if ($s -eq $null) { return '' }; return ($s -replace "[\t\r\n\\]", ' ') }
function Br([string]$n) { return '[' + $n.Replace(']', ']]') + ']' }

function Open-Db([string]$srv, [string]$db) {
  $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $b['Data Source'] = $srv
  $b['Initial Catalog'] = $db
  if ($User) { $b['User ID'] = $User; $b['Password'] = [string]$env:SAYDALITI_SQL_PASSWORD } else { $b['Integrated Security'] = $true }
  $b['Connect Timeout'] = 15
  $b['Application Name'] = 'Saydaliti sync (read only)'
  $c = New-Object System.Data.SqlClient.SqlConnection($b.ToString())
  $c.Open()
  return $c
}
function Scalar($c, [string]$sql) {
  $cmd = $c.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = 120
  return $cmd.ExecuteScalar()
}
function Strings($c, [string]$sql) {
  $cmd = $c.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = 120
  $r = $cmd.ExecuteReader()
  $list = New-Object System.Collections.ArrayList
  try { while ($r.Read()) { if (-not $r.IsDBNull(0)) { [void]$list.Add([string]$r.GetValue(0)) } } } finally { $r.Close() }
  return ,$list
}

# SQL Server instances on this computer, from the Windows services (SQL Server 2000 and later).
function Instances {
  $list = New-Object System.Collections.ArrayList
  if ($Server) { [void]$list.Add(@{ name = $Server; running = $true }); return ,$list }
  $svc = @()
  try { $svc = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'MSSQLSERVER' -or $_.Name -like 'MSSQL$*' }) } catch { }
  foreach ($s in $svc) {
    if ($s.Name -eq 'MSSQLSERVER') { $n = '.' } else { $n = '.\' + $s.Name.Substring(6) }
    [void]$list.Add(@{ name = $n; running = ($s.Status -eq 'Running') })
  }
  return ,$list
}

# One table: a header line (@@name, columns), a type line (@t: n number, d date, b yes/no, s text),
# then one line per row, tab-separated, \N for nothing.
function Write-Block($w, [string]$name, $reader) {
  $n = $reader.FieldCount
  $cols = New-Object string[] $n
  $types = New-Object string[] $n
  for ($k = 0; $k -lt $n; $k++) {
    $cols[$k] = $reader.GetName($k)
    $t = $reader.GetFieldType($k)
    if ($t -eq [DateTime]) { $types[$k] = 'd' }
    elseif ($t -eq [Boolean]) { $types[$k] = 'b' }
    elseif ($t -eq [Decimal] -or $t -eq [Double] -or $t -eq [Single] -or $t -eq [Int32] -or $t -eq [Int16] -or $t -eq [Int64] -or $t -eq [Byte]) { $types[$k] = 'n' }
    else { $types[$k] = 's' }
  }
  $w.WriteLine('@@' + $name + "`t" + [string]::Join("`t", $cols))
  $w.WriteLine("@t`t" + [string]::Join("`t", $types))
  $vals = New-Object string[] $n
  $rows = 0
  while ($reader.Read()) {
    for ($k = 0; $k -lt $n; $k++) {
      if ($reader.IsDBNull($k)) { $vals[$k] = '\N'; continue }
      $v = $reader.GetValue($k)
      $t = $types[$k]
      if ($t -eq 'n') { $vals[$k] = ([IFormattable]$v).ToString($null, $inv) }
      elseif ($t -eq 'd') { $vals[$k] = ([DateTime]$v).ToString('yyyy-MM-ddTHH:mm:ss', $inv) }
      elseif ($t -eq 'b') { if ($v) { $vals[$k] = '1' } else { $vals[$k] = '0' } }
      else { $vals[$k] = Clean ([string]$v) }
    }
    $w.WriteLine([string]::Join("`t", $vals))
    $rows++
  }
  return $rows
}

# The Genius tables and columns the sync reads (only items, stock, sales and purchases; no customers).
# DATE = rows from -From on (and rows with no date).
$SPECS = @(
  @('Item_Catalog', 'itm_id,itm_name_ar,itm_name_en,itm_name]en,itm_ismedicine,itm_def_pharm_price,itm_def_sell_price,itm_active,itm_unit1_unit2,itm_unit1_unit3,itm_code,itm_code2,itm_int_code', ''),
  @('Item_Objects', 'io_itm_id,io_itm_int', ''),
  @('Item_Class_Store', 'itm_id,itm_qty,itm_expiry_date,pharm_price,sell_price', 'itm_qty > 0'),
  @('Item_Daily_Stock', 'ids_day,ids_itm_id,ids_qty,ids_purchasePrice,ids_sellPrice', 'ids_day = (SELECT MAX(ids_day) FROM dbo.Item_Daily_Stock WITH (NOLOCK) WHERE ids_day BETWEEN 20180101 AND 20301231)'),
  @('sales_trans_h', 'sth_id,sec_insert_date', 'DATE'),
  @('sales_trans_d', 'sth_id,itm_id,itm_unit,qnty,itm_back,itm_sell,itm_dis_mon,sec_insert_date', 'DATE'),
  @('pur_trans_h', 'pth_id,sec_insert_date,pth_date', 'DATE'),
  @('pur_trans_d', 'pth_id,itm_id,qnty,bonus,itm_cost,sec_insert_date', 'DATE')
)

function Read-Genius($w) {
  if ($From -notmatch '^\d{8}$') { throw "-From must be yyyyMMdd" }
  $c = Open-Db $Server $Database
  try {
    $ver = [string](Scalar $c 'SELECT @@VERSION')
    $w.WriteLine("@m`t" + (Clean $Server) + "`t" + (Clean $Database) + "`t" + (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss', $inv) + "`t" + (Clean ($ver.Split("`n")[0])))
    foreach ($s in $SPECS) {
      $table = $s[0]
      $have = Strings $c ("SELECT name FROM dbo.syscolumns WHERE id = OBJECT_ID('dbo." + $table.Replace("'", "''") + "')")
      if ($have.Count -eq 0) { $w.WriteLine('@@' + $table); $w.WriteLine("@t"); continue }
      $cols = New-Object System.Collections.ArrayList
      foreach ($want in $s[1].Split(',')) { foreach ($h in $have) { if ($h -ieq $want) { [void]$cols.Add((Br $h)); break } } }
      if ($cols.Count -eq 0) { $w.WriteLine('@@' + $table); $w.WriteLine("@t"); continue }
      $where = $s[2]
      if ($where -eq 'DATE') {
        $hasDate = $false
        foreach ($h in $have) { if ($h -ieq 'sec_insert_date') { $hasDate = $true } }
        if ($hasDate) { $where = "(sec_insert_date >= '" + $From + "' OR sec_insert_date IS NULL)" } else { $where = '' }
      }
      $sql = 'SELECT ' + [string]::Join(', ', [string[]]$cols.ToArray()) + ' FROM dbo.' + (Br $table) + ' WITH (NOLOCK)'
      if ($where) { $sql += ' WHERE ' + $where }
      $cmd = $c.CreateCommand()
      $cmd.CommandText = $sql
      $cmd.CommandTimeout = 600
      $r = $cmd.ExecuteReader()
      try { [void](Write-Block $w $table $r) } finally { $r.Close() }
    }
  } finally { $c.Close() }
}

function Find-Genius($w) {
  foreach ($i in (Instances)) {
    $w.WriteLine("server`t" + (Clean $i.name) + "`t" + $i.running)
    if (-not $i.running) { continue }
    try {
      $c = Open-Db $i.name 'master'
      try {
        foreach ($d in (Strings $c 'SELECT name FROM master.dbo.sysdatabases WHERE dbid > 4 ORDER BY name')) {
          try {
            $n = Scalar $c ("SELECT COUNT(*) FROM " + (Br $d) + ".dbo.sysobjects WHERE name = 'Item_Catalog' AND xtype = 'U'")
            if ($n -gt 0) {
              $items = Scalar $c ("SELECT COUNT(*) FROM " + (Br $d) + ".dbo.Item_Catalog WITH (NOLOCK)")
              $w.WriteLine("db`t" + (Clean $i.name) + "`t" + (Clean $d) + "`t" + $items)
            }
          } catch { }
        }
      } finally { $c.Close() }
    } catch { $w.WriteLine("error`t" + (Clean $i.name) + "`t" + (Clean $_.Exception.Message)) }
  }
}

if ($MyInvocation.InvocationName -eq '.') { return } # loaded by a test, not run
if (-not $Out) { throw '-Out is required' }
$tmp = $Out + '.part'
try {
  $w = New-Object System.IO.StreamWriter($tmp, $false, $utf8)
  try { if ($Find) { Find-Genius $w } else { Read-Genius $w } } finally { $w.Close() }
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
  Move-Item -LiteralPath $tmp -Destination $Out
  if (Test-Path -LiteralPath ($Out + '.err')) { Remove-Item -LiteralPath ($Out + '.err') -Force }
  exit 0
} catch {
  $msg = $_.Exception.Message
  if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
  [IO.File]::WriteAllText($Out + '.err', $msg, $utf8)
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  exit 1
}
