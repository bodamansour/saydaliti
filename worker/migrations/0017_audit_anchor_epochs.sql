-- A manual owner-authorized rebaseline starts a new seal chain without deleting prior evidence.
-- Rollback is safe only before any epoch greater than zero has been created.
-- Rollback:
--   DROP INDEX IF EXISTS ix_audit_seals_pharmacy_epoch_upto;
--   ALTER TABLE audit_seals DROP COLUMN epoch;
ALTER TABLE audit_seals ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_audit_seals_pharmacy_epoch_upto ON audit_seals (pharmacy_id, epoch, upto_id);
