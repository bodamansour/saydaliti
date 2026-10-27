-- Cashier (point of sale): receipts and learned barcodes. Needs 007_branches_expenses.sql.
-- The cashier PC signs in as the pharmacy device (or the owner) and sells; partners only read.
-- Receipt ids are made on the device so a sale recorded offline is uploaded exactly once.

create table pos_sales (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  branch_id uuid references branches(id) on delete cascade,
  number text not null check (length(number) between 1 and 40),     -- shown on the printed receipt
  sold_at timestamptz not null,                                      -- device time of the sale
  kind text not null default 'sale' check (kind in ('sale', 'return')),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 300),
  total numeric(12, 2) not null,                                     -- after discounts; negative for a return
  discount numeric(12, 2) not null default 0 check (discount >= 0),
  paid numeric(12, 2),
  payment text not null default 'cash' check (payment in ('cash', 'card', 'wallet', 'credit')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on pos_sales (pharmacy_id, sold_at desc);
create index on pos_sales (branch_id, sold_at desc);
create index on pos_sales (created_by);
alter table pos_sales enable row level security;
create policy "managers and cashier read sales" on pos_sales for select using (is_member(pharmacy_id, array['owner', 'partner', 'device']));
create policy "owner and cashier add sales" on pos_sales for insert with check (
  is_member(pharmacy_id, array['owner', 'device'])
  and created_by = (select auth.uid())
  and (branch_id is null or exists (select 1 from branches b where b.id = branch_id and b.pharmacy_id = pos_sales.pharmacy_id)));
-- Receipts are never edited or deleted through the app; a mistake is corrected with a return.
revoke all on pos_sales from anon;
revoke update, delete on pos_sales from authenticated;

-- Barcodes the cashier taught the app (scanned once, linked to an item code).
create table pos_barcodes (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  barcode text not null check (length(barcode) between 3 and 64),
  code text not null check (length(code) between 1 and 60),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (pharmacy_id, barcode)
);
create index on pos_barcodes (created_by);
alter table pos_barcodes enable row level security;
create policy "members read barcodes" on pos_barcodes for select using (is_member(pharmacy_id));
create policy "owner and cashier add barcodes" on pos_barcodes for insert with check (
  is_member(pharmacy_id, array['owner', 'device']) and created_by = (select auth.uid()));
create policy "owner deletes barcodes" on pos_barcodes for delete using (is_member(pharmacy_id, array['owner']));
revoke all on pos_barcodes from anon;
revoke update on pos_barcodes from authenticated;

-- The cashier PC (device role) needs the item list: let it read the latest uploaded data.
drop policy "managers read snapshots" on snapshots;
create policy "members read snapshots" on snapshots for select using (is_member(pharmacy_id));
