-- Customers on account: people who buy on credit, and insurance companies / contracts that pay part
-- of the bill. Cashier receipts can name a customer and put part (or all) of the bill on their account.
-- Needs 009_cashier.sql. Row ids are made on the device so offline retries never duplicate.

create table customers (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  phone text check (length(phone) <= 20),
  kind text not null default 'person' check (kind in ('person', 'insurance')),
  coverage_pct numeric(5, 2) not null default 0 check (coverage_pct between 0 and 100), -- share the insurance pays
  credit_limit numeric(12, 2) check (credit_limit >= 0),
  note text check (length(note) <= 300),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index on customers (pharmacy_id);
create index on customers (created_by);
alter table customers enable row level security;
-- The cashier PC needs the list (and may add a customer at the counter); only the owner edits.
create policy "members read customers" on customers for select using (is_member(pharmacy_id));
create policy "owner and cashier add customers" on customers for insert with check (
  is_member(pharmacy_id, array['owner', 'device']) and created_by = (select auth.uid()));
create policy "owner edits customers" on customers for update using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
create policy "owner removes customers" on customers for delete using (is_member(pharmacy_id, array['owner']));
revoke all on customers from anon;
revoke update on customers from authenticated;
grant update (name, phone, kind, coverage_pct, credit_limit, note, active, updated_at) on customers to authenticated;

-- Receipts: who the customer was, how much went on their account, and the insurance approval number.
alter table pos_sales add column customer_id uuid references customers(id) on delete set null;
alter table pos_sales add column credit numeric(12, 2) not null default 0;   -- on account; negative for a return
alter table pos_sales add column claim_no text check (length(claim_no) <= 60);
create index on pos_sales (customer_id);
drop policy "owner and cashier add sales" on pos_sales;
create policy "owner and cashier add sales" on pos_sales for insert with check (
  is_member(pharmacy_id, array['owner', 'device'])
  and created_by = (select auth.uid())
  and (branch_id is null or exists (select 1 from branches b where b.id = branch_id and b.pharmacy_id = pos_sales.pharmacy_id))
  and (customer_id is null or exists (select 1 from customers c where c.id = customer_id and c.pharmacy_id = pos_sales.pharmacy_id)));

-- Money collected from a customer (or paid by an insurance company) against their account.
create table customer_payments (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  paid_on date not null,
  amount numeric(12, 2) not null check (amount > 0 and amount < 100000000),
  note text check (length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on customer_payments (pharmacy_id, paid_on desc);
create index on customer_payments (customer_id);
create index on customer_payments (created_by);
alter table customer_payments enable row level security;
create policy "members read customer payments" on customer_payments for select using (is_member(pharmacy_id));
create policy "owner and cashier collect" on customer_payments for insert with check (
  is_member(pharmacy_id, array['owner', 'device'])
  and created_by = (select auth.uid())
  and exists (select 1 from customers c where c.id = customer_id and c.pharmacy_id = customer_payments.pharmacy_id));
create policy "owner deletes customer payments" on customer_payments for delete using (is_member(pharmacy_id, array['owner']));
revoke all on customer_payments from anon;
revoke update on customer_payments from authenticated;
