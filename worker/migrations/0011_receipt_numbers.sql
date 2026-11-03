-- Receipt numbers that stay unique across devices (Phase 1, 2026-11-03).
-- New cashier builds number receipts "YYMMDD-<tag>-<device>-<0001>" and send the device code in
-- receipt_device. Only rows that carry it are in the unique index, so this migration cannot fail on
-- receipts already stored (older numbers may repeat and are left exactly as they are). Every new
-- receipt, with or without the column, is also refused by the server if its number is already used.
--
-- Additive and backward compatible: older app builds keep working (they don't send the column).
-- Rollback (only if needed; nothing else depends on it):
--   DROP INDEX IF EXISTS ux_pos_sales_pharmacy_number_device;
--   ALTER TABLE pos_sales DROP COLUMN receipt_device;
ALTER TABLE pos_sales ADD COLUMN receipt_device TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pos_sales_pharmacy_number_device ON pos_sales (pharmacy_id, number) WHERE receipt_device IS NOT NULL;
