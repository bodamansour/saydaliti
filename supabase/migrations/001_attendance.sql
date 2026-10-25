-- Saydaliti: pharmacies, members (owner/partners), employees, attendance.
-- Clock-in happens only on the pharmacy device, with a PIN per employee.
-- Times always come from the server clock (now()), never from the device.

create extension if not exists pgcrypto with schema extensions;

create table pharmacies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Africa/Cairo',
  created_at timestamptz not null default now()
);

-- Accounts that can see the pharmacy (owner, partners). The pharmacy device signs in as a 'device' member.
create table members (
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'partner', 'device')),
  primary key (pharmacy_id, user_id)
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  name text not null,
  pin_hash text not null,                 -- bcrypt via crypt(); the PIN itself is never stored
  shift_start time not null default '09:00',
  shift_end time not null default '17:00',
  work_days int[] not null default '{6,0,1,2,3,4}', -- 0 = Sunday … 6 = Saturday (Friday off by default)
  grace_minutes int not null default 15,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table attendance (
  id bigint generated always as identity primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  check_in timestamptz not null default now(),
  check_out timestamptz,
  note text
);
create index on attendance (employee_id, check_in);
create index on attendance (pharmacy_id, check_in);
create index on employees (pharmacy_id);
create index on members (user_id);
-- At most one open shift per employee
create unique index one_open_shift on attendance (employee_id) where check_out is null;

-- ---------- Row level security ----------
alter table pharmacies enable row level security;
alter table members enable row level security;
alter table employees enable row level security;
alter table attendance enable row level security;

create function is_member(p uuid, roles text[] default array['owner','partner','device'])
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from members m where m.pharmacy_id = p and m.user_id = auth.uid() and m.role = any(roles));
$$;

create policy "members read pharmacy" on pharmacies for select using (is_member(id));
create policy "members read own membership" on members for select using (user_id = (select auth.uid()));
-- Owners and partners see employees and attendance; the device sees only names (via the clock function).
create policy "managers read employees" on employees for select using (is_member(pharmacy_id, array['owner','partner']));
create policy "owner updates employees" on employees for update using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
create policy "managers read attendance" on attendance for select using (is_member(pharmacy_id, array['owner','partner']));
create policy "owner edits attendance" on attendance for update using (is_member(pharmacy_id, array['owner']));

-- ---------- Clock in / out with a PIN (the only way to write attendance) ----------
create function clock(p_pharmacy uuid, p_pin text)
returns table (employee_name text, action text, at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  e employees%rowtype;
  open_id bigint;
begin
  if not is_member(p_pharmacy) then raise exception 'not allowed'; end if;
  select * into e from employees
   where pharmacy_id = p_pharmacy and active and pin_hash = crypt(p_pin, pin_hash)
   limit 1;
  if not found then raise exception 'wrong pin'; end if;

  select a.id into open_id from attendance a where a.employee_id = e.id and a.check_out is null;
  if open_id is null then
    insert into attendance (pharmacy_id, employee_id) values (p_pharmacy, e.id);
    return query select e.name, 'in'::text, now();
  else
    update attendance set check_out = now() where attendance.id = open_id;
    return query select e.name, 'out'::text, now();
  end if;
end $$;

-- Owner sets/changes an employee's PIN (4–6 digits).
create function set_employee_pin(p_employee uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare p uuid;
begin
  if p_pin !~ '^\d{4,6}$' then raise exception 'PIN must be 4-6 digits'; end if;
  select pharmacy_id into p from employees where id = p_employee;
  if not is_member(p, array['owner']) then raise exception 'not allowed'; end if;
  if exists (select 1 from employees where pharmacy_id = p and id <> p_employee and active and pin_hash = crypt(p_pin, pin_hash)) then
    raise exception 'PIN already used';
  end if;
  update employees set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_employee;
end $$;

revoke all on function clock(uuid, text) from public, anon;
grant execute on function clock(uuid, text) to authenticated;
revoke all on function set_employee_pin(uuid, text) from public, anon;
grant execute on function set_employee_pin(uuid, text) to authenticated;

-- Nobody reads pin_hash through the API, not even the owner.
revoke select on employees from authenticated, anon;
grant select (id, pharmacy_id, name, shift_start, shift_end, work_days, grace_minutes, active, created_at) on employees to authenticated;
revoke update on employees from authenticated, anon;
grant update (name, shift_start, shift_end, work_days, grace_minutes, active) on employees to authenticated;

-- Create a pharmacy; the caller becomes its owner.
create function create_pharmacy(p_name text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare p uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into pharmacies (name) values (p_name) returning id into p;
  insert into members (pharmacy_id, user_id, role) values (p, auth.uid(), 'owner');
  return p;
end $$;

-- Owner adds an employee; the PIN is hashed here and must be unique in the pharmacy.
create function add_employee(p_pharmacy uuid, p_name text, p_pin text,
  p_shift_start time default '09:00', p_shift_end time default '17:00',
  p_work_days int[] default '{6,0,1,2,3,4}', p_grace int default 15)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare e uuid;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  if p_pin !~ '^\d{4,6}$' then raise exception 'PIN must be 4-6 digits'; end if;
  if exists (select 1 from employees where pharmacy_id = p_pharmacy and active and pin_hash = crypt(p_pin, pin_hash)) then
    raise exception 'PIN already used';
  end if;
  insert into employees (pharmacy_id, name, pin_hash, shift_start, shift_end, work_days, grace_minutes)
  values (p_pharmacy, trim(p_name), crypt(p_pin, gen_salt('bf')), p_shift_start, p_shift_end, p_work_days, p_grace)
  returning id into e;
  return e;
end $$;

revoke all on function create_pharmacy(text) from public, anon;
grant execute on function create_pharmacy(text) to authenticated;
revoke all on function add_employee(uuid, text, text, time, time, int[], int) from public, anon;
grant execute on function add_employee(uuid, text, text, time, time, int[], int) to authenticated;
revoke all on function is_member(uuid, text[]) from public, anon;
grant execute on function is_member(uuid, text[]) to authenticated;
