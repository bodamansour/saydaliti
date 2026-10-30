-- Home delivery on a cashier receipt: the fee (included in the total) and the address/phone.
-- (Columns marked { added: 4 } in src/schema.js.)
ALTER TABLE pos_sales ADD COLUMN delivery_fee REAL;
ALTER TABLE pos_sales ADD COLUMN delivery_to TEXT;
