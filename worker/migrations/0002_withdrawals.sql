-- Owner withdrawals: who took the money or the goods, and the cashier shift a drawer withdrawal came out of.
-- (Columns marked { added: 2 } in src/schema.js.)
ALTER TABLE expenses ADD COLUMN person TEXT;
ALTER TABLE expenses ADD COLUMN shift_id TEXT;
ALTER TABLE stock_moves ADD COLUMN person TEXT;
CREATE INDEX IF NOT EXISTS ix_expenses_shift_id ON expenses (shift_id);
