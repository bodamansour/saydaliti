-- Market shortages, market prices (shared), patient WhatsApp reminders, and a per-branch morning feed.
-- Needs 007_branches_expenses.sql. Row ids are made on the device so offline retries never duplicate.

-- ---------- Market shortages ----------
create table shortages (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  code text check (length(code) <= 60),
  name text not null check (length(trim(name)) between 1 and 160),
  note text check (length(note) <= 300),
  status text not null default 'active' check (status in ('active', 'resolved')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index on shortages (pharmacy_id, status);
create index on shortages (created_by);
alter table shortages enable row level security;
create policy "managers read shortages" on shortages for select using (is_member(pharmacy_id, array['owner', 'partner']));
create policy "owner adds shortages" on shortages for insert with check (is_member(pharmacy_id, array['owner']) and created_by = (select auth.uid()));
create policy "owner updates shortages" on shortages for update using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
create policy "owner deletes shortages" on shortages for delete using (is_member(pharmacy_id, array['owner']));
revoke all on shortages from anon;
revoke update on shortages from authenticated;
grant update (status, resolved_at, note) on shortages to authenticated;

-- ---------- Market prices (what other pharmacies / sites charge) ----------
create table market_prices (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  code text not null check (length(code) between 1 and 60),
  price numeric(12, 2) not null check (price > 0 and price < 10000000),
  source text check (length(source) <= 80),
  seen_on date not null default current_date,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on market_prices (pharmacy_id, code, seen_on desc);
create index on market_prices (created_by);
alter table market_prices enable row level security;
create policy "managers read prices" on market_prices for select using (is_member(pharmacy_id, array['owner', 'partner']));
create policy "managers add prices" on market_prices for insert with check (is_member(pharmacy_id, array['owner', 'partner']) and created_by = (select auth.uid()));
create policy "owner or author deletes prices" on market_prices for delete using (is_member(pharmacy_id, array['owner']) or created_by = (select auth.uid()));
revoke all on market_prices from anon;
revoke update on market_prices from authenticated;

-- ---------- Patients and reminders (owner only: names, phones and medicines are private) ----------
create table patients (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  phone text not null check (phone ~ '^201[0125][0-9]{8}$'),
  consent boolean not null check (consent),          -- stored only with the patient's agreement
  consent_at timestamptz not null default now(),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on patients (pharmacy_id);
create index on patients (created_by);
alter table patients enable row level security;
create policy "owner reads patients" on patients for select using (is_member(pharmacy_id, array['owner']));
create policy "owner adds patients" on patients for insert with check (is_member(pharmacy_id, array['owner']) and created_by = (select auth.uid()));
create policy "owner updates patients" on patients for update using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
create policy "owner deletes patients" on patients for delete using (is_member(pharmacy_id, array['owner']));
revoke all on patients from anon;
revoke update on patients from authenticated;
grant update (active) on patients to authenticated;

create table reminders (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  medicine text not null check (length(trim(medicine)) between 1 and 120),
  kind text not null check (kind in ('dose', 'refill')),
  dose_times text[] check (kind <> 'dose' or (cardinality(dose_times) between 1 and 8)),
  refill_every_days int check (kind <> 'refill' or refill_every_days between 1 and 365),
  next_refill date check (kind <> 'refill' or next_refill is not null),
  active boolean not null default true,
  last_sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on reminders (pharmacy_id);
create index on reminders (patient_id);
create index on reminders (created_by);
alter table reminders enable row level security;
create policy "owner reads reminders" on reminders for select using (is_member(pharmacy_id, array['owner']));
create policy "owner adds reminders" on reminders for insert with check (
  is_member(pharmacy_id, array['owner']) and created_by = (select auth.uid())
  and exists (select 1 from patients p where p.id = patient_id and p.pharmacy_id = reminders.pharmacy_id));
create policy "owner updates reminders" on reminders for update using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
create policy "owner deletes reminders" on reminders for delete using (is_member(pharmacy_id, array['owner']));
revoke all on reminders from anon;
revoke update on reminders from authenticated;
grant update (active) on reminders to authenticated;

-- The reminder job (anon + shared secret, like the morning report) reads active reminders and marks them sent.
create function reminders_feed(p_secret text)
returns table (id uuid, kind text, medicine text, dose_times text[], refill_every_days int, next_refill date,
  last_sent_at timestamptz, patient_name text, phone text, pharmacy_name text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from app_secrets where name = 'report' and hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex')) then
    raise exception 'invalid secret';
  end if;
  return query
    select r.id, r.kind, r.medicine, r.dose_times, r.refill_every_days, r.next_refill, r.last_sent_at, pa.name, pa.phone, ph.name
    from reminders r join patients pa on pa.id = r.patient_id join pharmacies ph on ph.id = r.pharmacy_id
    where r.active and pa.active and pa.consent;
end $$;

-- p_items: [{ "id": uuid, "next_refill": "yyyy-mm-dd" | null }]
create function mark_reminders_sent(p_secret text, p_items jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not exists (select 1 from app_secrets where name = 'report' and hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex')) then
    raise exception 'invalid secret';
  end if;
  update reminders r set last_sent_at = now(),
    next_refill = coalesce((i ->> 'next_refill')::date, r.next_refill)
  from jsonb_array_elements(p_items) i where r.id = (i ->> 'id')::uuid;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function reminders_feed(text) from public, authenticated;
grant execute on function reminders_feed(text) to anon;
revoke all on function mark_reminders_sent(text, jsonb) from public, authenticated;
grant execute on function mark_reminders_sent(text, jsonb) to anon;

-- ---------- Morning feed: latest snapshot of every branch ----------
drop function report_feed(text);
create function report_feed(p_secret text)
returns table (pharmacy_id uuid, pharmacy_name text, settings jsonb, snapshot_at timestamptz, data jsonb, branch_data jsonb)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from app_secrets where name = 'report' and hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex')) then
    raise exception 'invalid secret';
  end if;
  return query
    select p.id, p.name, p.settings, s.newest, s.newest_data, s.per_branch
    from pharmacies p
    join lateral (
      select max(l.created_at) as newest,
             (array_agg(l.data order by l.created_at desc))[1] as newest_data,
             jsonb_agg(jsonb_build_object('branch', l.branch_name, 'at', l.created_at, 'data', l.data)) as per_branch
      from (select distinct on (b.id) b.name as branch_name, sn.created_at, sn.data
            from branches b join snapshots sn on sn.branch_id = b.id
            where b.pharmacy_id = p.id order by b.id, sn.created_at desc) l
    ) s on s.newest is not null
    where coalesce(p.settings ->> 'waNumbers', '') <> '';
end $$;
revoke all on function report_feed(text) from public, authenticated;
grant execute on function report_feed(text) to anon;
