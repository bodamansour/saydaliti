-- Ready for use and for sale. Needs 012_returns_privacy_invites.sql.
--  1. Cashier shifts: each employee sells under their own PIN; a shift is opened with the cash in the
--     drawer and closed with a count. Every receipt says who sold it and in which shift.
--  2. A log of who added, changed or removed what (purchases, items, stock, customers, money).
--  3. Subscriptions: a free trial for each new pharmacy, then a paid period the app owner turns on by
--     hand after a transfer (InstaPay / Vodafone Cash). An admin page for the app owner.
--  4. Errors from the app's screens are recorded, so problems are seen before customers report them.

-- ---------- 1. Cashier shifts ----------
create table pos_shifts (
  id uuid primary key,                                          -- made on the device (works offline)
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  branch_id uuid references branches(id) on delete cascade,
  employee_id uuid references employees(id) on delete set null,
  employee_name text not null check (length(employee_name) between 1 and 120),
  opened_at timestamptz not null,
  opening_cash numeric(12, 2) not null default 0 check (opening_cash >= 0),
  closed_at timestamptz,
  expected_cash numeric(12, 2),
  counted_cash numeric(12, 2) check (counted_cash >= 0),
  totals jsonb,                                                 -- receipts, returns, by payment, at closing
  note text check (length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on pos_shifts (pharmacy_id, opened_at desc);
create index on pos_shifts (employee_id);
create index on pos_shifts (branch_id);
create index on pos_shifts (created_by);
alter table pos_shifts enable row level security;
create policy "managers and cashier read shifts" on pos_shifts for select using (is_member(pharmacy_id, array['owner', 'partner', 'device']));
create policy "owner and cashier open shifts" on pos_shifts for insert with check (
  is_member(pharmacy_id, array['owner', 'device']) and created_by = (select auth.uid())
  and (branch_id is null or exists (select 1 from branches b where b.id = branch_id and b.pharmacy_id = pos_shifts.pharmacy_id))
  and (employee_id is null or exists (select 1 from employees e where e.id = employee_id and e.pharmacy_id = pos_shifts.pharmacy_id)));
-- Closing: only an open shift, only the closing fields.
create policy "owner and cashier close shifts" on pos_shifts for update
  using (is_member(pharmacy_id, array['owner', 'device']) and closed_at is null)
  with check (is_member(pharmacy_id, array['owner', 'device']));
revoke update on pos_shifts from authenticated, anon;
grant update (closed_at, expected_cash, counted_cash, totals, note) on pos_shifts to authenticated;
revoke all on pos_shifts from anon;

alter table pos_sales add column employee_id uuid references employees(id) on delete set null;
alter table pos_sales add column employee_name text check (length(employee_name) <= 120);
alter table pos_sales add column shift_id uuid references pos_shifts(id) on delete set null;
create index on pos_sales (employee_id);
create index on pos_sales (shift_id);

-- A receipt's employee and shift belong to the same pharmacy.
create function check_pos_staff() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.employee_id is not null and not exists (select 1 from employees e where e.id = new.employee_id and e.pharmacy_id = new.pharmacy_id) then
    raise exception 'unknown employee';
  end if;
  if new.shift_id is not null and not exists (select 1 from pos_shifts s where s.id = new.shift_id and s.pharmacy_id = new.pharmacy_id) then
    raise exception 'unknown shift';
  end if;
  return new;
end $$;
revoke all on function check_pos_staff() from public, anon, authenticated;
create trigger pos_sales_check_staff before insert on pos_sales for each row execute function check_pos_staff();

-- Wrong PINs are counted per account, so a PIN can't be found by trying all 10,000.
create table pin_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index on pin_attempts (user_id, at desc);
alter table pin_attempts enable row level security; -- no policies: only the function below uses it

-- How many employees can sell (the cashier asks for a PIN only when there are some).
create function cashier_staff(p_pharmacy uuid)
returns int language sql stable security definer set search_path = public as $$
  select case when is_member(p_pharmacy, array['owner', 'device']) then (select count(*)::int from employees where pharmacy_id = p_pharmacy and active) else 0 end;
$$;

-- The employee a PIN belongs to. A wrong PIN returns nothing and is counted; 20 wrong in 15 minutes
-- and the account has to wait.
create function cashier_pin(p_pharmacy uuid, p_pin text)
returns table (employee_id uuid, employee_name text)
language plpgsql security definer set search_path = public, extensions as $$
declare e employees%rowtype;
begin
  if not is_member(p_pharmacy, array['owner', 'device']) then raise exception 'not allowed'; end if;
  if (select count(*) from pin_attempts where user_id = auth.uid() and at > now() - interval '15 minutes') >= 20 then
    raise exception 'too many attempts';
  end if;
  select * into e from employees where pharmacy_id = p_pharmacy and active and pin_hash = crypt(p_pin, pin_hash) limit 1;
  if not found then
    insert into pin_attempts (user_id) values (auth.uid());
    delete from pin_attempts where at < now() - interval '1 day';
    return;
  end if;
  return query select e.id, e.name;
end $$;
revoke all on function cashier_staff(uuid) from public, anon;
grant execute on function cashier_staff(uuid) to authenticated;
revoke all on function cashier_pin(uuid, text) from public, anon;
grant execute on function cashier_pin(uuid, text) to authenticated;

-- ---------- 2. Log of changes ----------
create table audit_log (
  id bigint generated always as identity primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  table_name text not null,
  op text not null check (op in ('insert', 'update', 'delete')),
  row_id text,
  old_row jsonb,
  new_row jsonb
);
create index on audit_log (pharmacy_id, at desc);
create index on audit_log (user_id);
alter table audit_log enable row level security;
create policy "owner reads the log" on audit_log for select using (is_member(pharmacy_id, array['owner']));
revoke insert, update, delete on audit_log from authenticated, anon; -- written only by the trigger

create function log_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  -- An employee's PIN hash is never copied into the log.
  insert into audit_log (pharmacy_id, user_id, table_name, op, row_id, old_row, new_row)
  values ((r->>'pharmacy_id')::uuid, auth.uid(), tg_table_name, lower(tg_op), r->>'id',
          case when tg_op <> 'INSERT' then to_jsonb(old) - 'pin_hash' end,
          case when tg_op <> 'DELETE' then to_jsonb(new) - 'pin_hash' end);
  return null;
end $$;
revoke all on function log_change() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['catalog_items', 'purchases', 'stock_moves', 'supplier_payments', 'customers', 'customer_payments', 'expenses', 'pos_shifts', 'employees'] loop
    execute format('create trigger %I after insert or update or delete on %I for each row execute function log_change()', t || '_log', t);
  end loop;
end $$;

-- ---------- 3. Subscriptions ----------
-- The app owner (who sells Saydaliti). Added by hand in the database, never through the app.
create table app_admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table app_admins enable row level security; -- no policies

create function is_app_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;
revoke all on function is_app_admin() from public, anon;
grant execute on function is_app_admin() to authenticated;

-- Prices and how to pay, shown to pharmacies and on the public page. One row.
create table app_config (
  id int primary key default 1 check (id = 1),
  trial_days int not null default 14 check (trial_days between 0 and 365),
  grace_days int not null default 7 check (grace_days between 0 and 60),
  price_month numeric(10, 2) not null default 0,
  price_branch numeric(10, 2) not null default 0,
  pay_note text not null default '' check (length(pay_note) <= 600),   -- e.g. InstaPay / Vodafone Cash number
  support_phone text not null default '' check (length(support_phone) <= 30),
  updated_at timestamptz not null default now()
);
insert into app_config (id) values (1);
alter table app_config enable row level security;
create policy "everyone reads prices" on app_config for select using (true);
grant select on app_config to anon, authenticated;
revoke insert, update, delete on app_config from anon, authenticated;

create table subscriptions (
  pharmacy_id uuid primary key references pharmacies(id) on delete cascade,
  status text not null default 'trial' check (status in ('trial', 'active', 'free', 'suspended')),
  trial_ends date,
  paid_until date,
  price_month numeric(10, 2),
  note text check (length(note) <= 600),
  updated_at timestamptz not null default now()
);
alter table subscriptions enable row level security;
create policy "members read their subscription" on subscriptions for select using (is_member(pharmacy_id));
revoke insert, update, delete on subscriptions from anon, authenticated;

-- Pharmacies already here (made before subscriptions existed) stay free.
insert into subscriptions (pharmacy_id, status) select id, 'free' from pharmacies;

-- Every new pharmacy starts a free trial.
create function start_trial() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into subscriptions (pharmacy_id, status, trial_ends)
  values (new.id, 'trial', current_date + (select trial_days from app_config where id = 1))
  on conflict (pharmacy_id) do nothing;
  return null;
end $$;
revoke all on function start_trial() from public, anon, authenticated;
create trigger pharmacies_start_trial after insert on pharmacies for each row execute function start_trial();

-- ---- Admin page (app owner only) ----
create function admin_pharmacies()
returns table (pharmacy_id uuid, name text, created_at timestamptz, owner_email text, branches int, employees int,
  status text, trial_ends date, paid_until date, price_month numeric, note text, last_sale timestamptz, sales_30d int)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  return query
  select p.id, p.name, p.created_at,
    (select u.email::text from members m join auth.users u on u.id = m.user_id where m.pharmacy_id = p.id and m.role = 'owner' limit 1),
    (select count(*)::int from branches b where b.pharmacy_id = p.id),
    (select count(*)::int from employees e where e.pharmacy_id = p.id and e.active),
    s.status, s.trial_ends, s.paid_until, s.price_month, s.note,
    (select max(x.sold_at) from pos_sales x where x.pharmacy_id = p.id),
    (select count(*)::int from pos_sales x where x.pharmacy_id = p.id and x.sold_at > now() - interval '30 days')
  from pharmacies p left join subscriptions s on s.pharmacy_id = p.id
  order by p.created_at desc;
end $$;

create function admin_set_subscription(p_pharmacy uuid, p_status text, p_trial_ends date, p_paid_until date, p_price numeric, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  if p_status not in ('trial', 'active', 'free', 'suspended') then raise exception 'bad status'; end if;
  insert into subscriptions (pharmacy_id, status, trial_ends, paid_until, price_month, note, updated_at)
  values (p_pharmacy, p_status, p_trial_ends, p_paid_until, p_price, nullif(trim(p_note), ''), now())
  on conflict (pharmacy_id) do update set status = excluded.status, trial_ends = excluded.trial_ends,
    paid_until = excluded.paid_until, price_month = excluded.price_month, note = excluded.note, updated_at = now();
end $$;

create function admin_set_config(p_trial_days int, p_grace_days int, p_price_month numeric, p_price_branch numeric, p_pay_note text, p_support_phone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  update app_config set trial_days = p_trial_days, grace_days = p_grace_days, price_month = p_price_month, price_branch = p_price_branch,
    pay_note = coalesce(p_pay_note, ''), support_phone = coalesce(p_support_phone, ''), updated_at = now() where id = 1;
end $$;

revoke all on function admin_pharmacies() from public, anon;
grant execute on function admin_pharmacies() to authenticated;
revoke all on function admin_set_subscription(uuid, text, date, date, numeric, text) from public, anon;
grant execute on function admin_set_subscription(uuid, text, date, date, numeric, text) to authenticated;
revoke all on function admin_set_config(int, int, numeric, numeric, text, text) from public, anon;
grant execute on function admin_set_config(int, int, numeric, numeric, text, text) to authenticated;

-- ---------- 4. Errors from the app ----------
create table client_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  pharmacy_id uuid references pharmacies(id) on delete set null,
  page text check (length(page) <= 60),
  message text not null check (length(message) <= 500),
  stack text check (length(stack) <= 4000),
  agent text check (length(agent) <= 300),
  version text check (length(version) <= 40)
);
create index on client_errors (at desc);
create index on client_errors (user_id);
create index on client_errors (pharmacy_id);
alter table client_errors enable row level security;
create policy "app owner reads errors" on client_errors for select using (is_app_admin());
revoke insert, update, delete on client_errors from anon, authenticated;

-- At most 30 a hour per account, so a broken loop can't fill the table.
create function log_client_error(p_pharmacy uuid, p_page text, p_message text, p_stack text, p_agent text, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from client_errors where user_id = auth.uid() and at > now() - interval '1 hour') >= 30 then return; end if;
  insert into client_errors (pharmacy_id, page, message, stack, agent, version)
  values (case when p_pharmacy is not null and is_member(p_pharmacy) then p_pharmacy end,
          left(p_page, 60), left(coalesce(p_message, '?'), 500), left(p_stack, 4000), left(p_agent, 300), left(p_version, 40));
end $$;
revoke all on function log_client_error(uuid, text, text, text, text, text) from public, anon;
grant execute on function log_client_error(uuid, text, text, text, text, text) to authenticated;

create function admin_errors(p_limit int default 200)
returns setof client_errors language plpgsql stable security definer set search_path = public as $$
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  return query select * from client_errors order by at desc limit least(greatest(p_limit, 1), 1000);
end $$;
revoke all on function admin_errors(int) from public, anon;
grant execute on function admin_errors(int) to authenticated;
