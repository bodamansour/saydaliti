-- Purchase returns: a purchase row with kind 'return' is goods sent back to the supplier.
-- (Column marked { added: 5 } in src/schema.js.)
ALTER TABLE purchases ADD COLUMN kind TEXT NOT NULL DEFAULT 'buy';
