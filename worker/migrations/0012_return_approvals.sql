-- Returns without the original receipt need a manager's approval (owner decision, 2026-11-03).
-- The owner marks which employees may approve; the approver types their own PIN at the cashier; the
-- server checks it and keeps one approval per return (who sold, who approved, why, how much). The
-- return then carries the approval's id. (Marked { added: 12 } in src/schema.js.)
--
-- Additive and backward compatible: existing employees cannot approve until the owner marks them;
-- existing rows are not changed. Rollback (only if needed; returns saved since then keep their
-- approval_id value, which nothing else reads):
--   DROP TABLE IF EXISTS return_approvals;
--   ALTER TABLE pos_sales DROP COLUMN approval_id;
--   ALTER TABLE employees DROP COLUMN can_approve_returns;
ALTER TABLE employees ADD COLUMN can_approve_returns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_sales ADD COLUMN approval_id TEXT;
CREATE TABLE IF NOT EXISTS return_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  return_id TEXT NOT NULL,
  total REAL NOT NULL,
  reason TEXT NOT NULL,
  cashier_employee_id TEXT NOT NULL,
  cashier_name TEXT NOT NULL,
  approver_employee_id TEXT NOT NULL,
  approver_name TEXT NOT NULL,
  approved_by_user TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_return_approvals_return ON return_approvals (return_id);
CREATE INDEX IF NOT EXISTS ix_return_approvals_pharmacy ON return_approvals (pharmacy_id, created_at);
