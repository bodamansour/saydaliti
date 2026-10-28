# CI: a small database shaped like United (Genius) on the SQL Server installed on the runner, for the
# live sync test. Made-up items only. Dates are relative to today, like a pharmacy working now.
$ErrorActionPreference = 'Stop'
function Run([string]$db, [string]$sql) {
  $c = New-Object System.Data.SqlClient.SqlConnection "Data Source=localhost;Initial Catalog=$db;Integrated Security=True"
  $c.Open()
  try { $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; [void]$cmd.ExecuteNonQuery() } finally { $c.Close() }
}
Run 'master' "IF DB_ID('GeniusTest') IS NOT NULL DROP DATABASE GeniusTest; CREATE DATABASE GeniusTest COLLATE Arabic_CI_AS"
Run 'GeniusTest' @"
CREATE TABLE Item_Catalog (itm_id decimal(18,0) PRIMARY KEY, itm_code varchar(20), itm_name_ar varchar(100), itm_ismedicine int, itm_def_pharm_price money, itm_def_sell_price money, itm_active char(1), itm_unit1_unit2 decimal(18,0), itm_unit1_unit3 decimal(18,0));
CREATE TABLE Item_Class_Store (c_id int IDENTITY, itm_id decimal(18,0), sto_id int, itm_qty decimal(18,2), pharm_price money, sell_price money, itm_expiry_date datetime);
CREATE TABLE Item_Daily_Stock (ids_day int, ids_store int, ids_itm_id int, ids_qty decimal(9,2), ids_sellPrice decimal(9,2), ids_purchasePrice decimal(9,3));
CREATE TABLE sales_trans_h (sth_id decimal(18,0), cust_name varchar(50), sec_insert_date datetime);
CREATE TABLE sales_trans_d (id int IDENTITY, sth_id decimal(18,0), itm_id decimal(18,0), qnty float, itm_unit int, itm_sell money, itm_dis_mon money, itm_back decimal(18,2), sec_insert_date datetime);
CREATE TABLE pur_trans_h (pth_id decimal(18,0), sec_insert_date datetime);
CREATE TABLE pur_trans_d (id int IDENTITY, pth_id decimal(18,0), itm_id decimal(18,0), qnty float, bonus float, itm_cost money, sec_insert_date datetime);
CREATE TABLE Customers (cust_id int, cust_name varchar(50), cust_phone varchar(20));
"@
Run 'GeniusTest' @"
DECLARE @t datetime, @y int, @old int
SET @t = DATEADD(hour, 10, DATEADD(day, DATEDIFF(day, 0, GETDATE()), 0))
SET @y = CONVERT(int, CONVERT(char(8), DATEADD(day, -1, @t), 112))
SET @old = CONVERT(int, CONVERT(char(8), DATEADD(day, -30, @t), 112))
INSERT Item_Catalog VALUES (1, 'P1', N'بانادول إكسترا', 1, 40, 50, '1', 2, 20)
INSERT Item_Catalog VALUES (2, 'S1', N'كريم شمس', 0, 290, 420, '1', 1, 1)
INSERT Item_Catalog VALUES (3, 'X1', N'صنف متوقف', 1, 1, 2, '0', 1, 1)
INSERT Item_Class_Store (itm_id, sto_id, itm_qty, pharm_price, sell_price, itm_expiry_date) VALUES (1, 1, 7, 41, 52, '20270601')
INSERT Item_Class_Store (itm_id, sto_id, itm_qty, pharm_price, sell_price, itm_expiry_date) VALUES (1, 1, 5, 41, 52, '20261201')
INSERT Item_Class_Store (itm_id, sto_id, itm_qty, pharm_price, sell_price, itm_expiry_date) VALUES (2, 1, 3, 290, 420, '20270201')
INSERT Item_Class_Store (itm_id, sto_id, itm_qty, pharm_price, sell_price, itm_expiry_date) VALUES (3, 1, 0, 1, 2, '20250101')
INSERT Item_Daily_Stock VALUES (@old, 1, 1, 99, 50, 40)
INSERT Item_Daily_Stock VALUES (@y, 1, 1, 12, 52, 41)
INSERT Item_Daily_Stock VALUES (@y, 1, 2, 3, 420, 290)
INSERT sales_trans_h VALUES (100, 'customer one', DATEADD(day, -5, @t))
INSERT sales_trans_h VALUES (101, 'customer two', @t)
INSERT sales_trans_h VALUES (102, NULL, DATEADD(day, -400, @t))
INSERT sales_trans_d (sth_id, itm_id, qnty, itm_unit, itm_sell, itm_dis_mon, itm_back, sec_insert_date) VALUES (100, 1, 2, 1, 50, 5, 0, DATEADD(day, -5, @t))
INSERT sales_trans_d (sth_id, itm_id, qnty, itm_unit, itm_sell, itm_dis_mon, itm_back, sec_insert_date) VALUES (101, 1, 1, 2, 26, 0, 0, @t)
INSERT sales_trans_d (sth_id, itm_id, qnty, itm_unit, itm_sell, itm_dis_mon, itm_back, sec_insert_date) VALUES (101, 2, 1, 1, 420, 0, 0, NULL)
INSERT sales_trans_d (sth_id, itm_id, qnty, itm_unit, itm_sell, itm_dis_mon, itm_back, sec_insert_date) VALUES (102, 1, 9, 1, 50, 0, 0, DATEADD(day, -400, @t))
INSERT pur_trans_h VALUES (7, DATEADD(day, -3, @t))
INSERT pur_trans_d (pth_id, itm_id, qnty, bonus, itm_cost, sec_insert_date) VALUES (7, 1, 40, 2, 43, DATEADD(day, -3, @t))
INSERT Customers VALUES (1, 'customer one', '01000000000')
"@
Write-Host 'GeniusTest is ready'
