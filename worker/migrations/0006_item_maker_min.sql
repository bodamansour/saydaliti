-- An item's maker and the least to keep on the shelf. (Columns marked { added: 6 } in src/schema.js.)
ALTER TABLE catalog_items ADD COLUMN maker TEXT;
ALTER TABLE catalog_items ADD COLUMN min_qty REAL;
