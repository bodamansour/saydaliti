-- Stock kept in Saydaliti itself: items added here, purchase invoices received, supplier payments,
-- and stock adjustments (count, damaged/expired, returns to supplier, transfers between branches).
-- The last uploaded file from the pharmacy program is the starting stock; these rows come on top.
-- Needs 007_branches_expenses.sql. Row ids are made on the device so offline retries never duplicate.

-- ---------- Items added or edited here ----------
create table catalog_items (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  code text not null check (length(code) between 1 and 60),
  name text check (length(trim(name)) between 1 and 160),
  category text check (length(category) <= 60),
  price numeric(12, 2) check (price >= 0 and price < 10000000),
  cost numeric(12, 2) check (cost >= 0 and cost < 10000000),
  barcode text check (length(barcode) <= 64),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (pharmacy_id, code)
);
create index on catalog_items (created_by);
alter table catalog_items enable row level security;
create policy "members read items" on catalog_items for select using (is_member(pharmacy_id));
-- The cashier PC may add an item it scans for the first time; only the owner edits or removes.
create policy "owner and cashier add items" on catalog_items for insert with check (
  is_member(pharmacy_id, array['owner', 'device']) and created_by = (select auth.uid()));
create policy "owner edits items" on catalog_items for update using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
create policy "owner removes items" on catalog_items for delete using (is_member(pharmacy_id, array['owner']));
revoke all on catalog_items from anon;
revoke update on catalog_items from authenticated;
grant update (name, category, price, cost, barcode, updated_at) on catalog_items to authenticated;

-- ---------- Purchase invoices (a delivery from a supplier) ----------
create table purchases (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  branch_id uuid references branches(id) on delete cascade,
  supplier_id text check (length(supplier_id) <= 60),          -- supplier saved in the pharmacy settings
  supplier_name text check (length(supplier_name) <= 120),
  invoice_no text check (length(invoice_no) <= 60),
  received_on date not null,
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 500),
  total numeric(12, 2) not null check (total >= 0 and total < 100000000),
  paid numeric(12, 2) not null default 0 check (paid >= 0 and paid < 100000000),
  note text check (length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on purchases (pharmacy_id, received_on desc);
create index on purchases (branch_id);
create index on purchases (created_by);
alter table purchases enable row level security;
-- The cashier PC reads them too: they are part of the stock it sells from.
create policy "members read purchases" on purchases for select using (is_member(pharmacy_id));
create policy "owner adds purchases" on purchases for insert with check (
  is_member(pharmacy_id, array['owner'])
  and created_by = (select auth.uid())
  and (branch_id is null or exists (select 1 from branches b where b.id = branch_id and b.pharmacy_id = purchases.pharmacy_id)));
create policy "owner deletes purchases" on purchases for delete using (is_member(pharmacy_id, array['owner']));
revoke all on purchases from anon;
revoke update on purchases from authenticated;

-- ---------- Payments to suppliers (after the invoice) ----------
create table supplier_payments (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  supplier_id text check (length(supplier_id) <= 60),
  supplier_name text check (length(supplier_name) <= 120),
  paid_on date not null,
  amount numeric(12, 2) not null check (amount > 0 and amount < 100000000),
  note text check (length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on supplier_payments (pharmacy_id, paid_on desc);
create index on supplier_payments (created_by);
alter table supplier_payments enable row level security;
create policy "managers read supplier payments" on supplier_payments for select using (is_member(pharmacy_id, array['owner', 'partner']));
create policy "owner adds supplier payments" on supplier_payments for insert with check (is_member(pharmacy_id, array['owner']) and created_by = (select auth.uid()));
create policy "owner deletes supplier payments" on supplier_payments for delete using (is_member(pharmacy_id, array['owner']));
revoke all on supplier_payments from anon;
revoke update on supplier_payments from authenticated;

-- ---------- Stock adjustments ----------
-- qty is signed: + adds to the shelf, − takes off. A transfer is two rows sharing ref (out of one branch, into another).
create table stock_moves (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  branch_id uuid references branches(id) on delete cascade,
  code text not null check (length(code) between 1 and 60),
  qty numeric(12, 2) not null check (qty <> 0 and abs(qty) < 10000000),
  kind text not null check (kind in ('count', 'damaged', 'expired', 'supplier_return', 'transfer')),
  expiry date,
  cost numeric(12, 2) check (cost >= 0),
  ref uuid,
  note text check (length(note) <= 300),
  happened_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on stock_moves (pharmacy_id, happened_at desc);
create index on stock_moves (branch_id);
create index on stock_moves (created_by);
alter table stock_moves enable row level security;
create policy "members read stock moves" on stock_moves for select using (is_member(pharmacy_id));
create policy "owner adds stock moves" on stock_moves for insert with check (
  is_member(pharmacy_id, array['owner'])
  and created_by = (select auth.uid())
  and (branch_id is null or exists (select 1 from branches b where b.id = branch_id and b.pharmacy_id = stock_moves.pharmacy_id)));
create policy "owner deletes stock moves" on stock_moves for delete using (is_member(pharmacy_id, array['owner']));
revoke all on stock_moves from anon;
revoke update on stock_moves from authenticated;
