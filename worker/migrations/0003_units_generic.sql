-- Selling by the strip or pill (how many in a box) and alternatives by active ingredient.
-- (Columns marked { added: 3 } in src/schema.js.)
ALTER TABLE catalog_items ADD COLUMN strips INTEGER;
ALTER TABLE catalog_items ADD COLUMN pills INTEGER;
ALTER TABLE catalog_items ADD COLUMN generic TEXT;
