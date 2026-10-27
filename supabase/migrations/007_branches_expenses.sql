-- Branches (each pharmacy has one or more) and recorded expenses / owner withdrawals.
-- Snapshots and connector tokens belong to a branch; the dashboard merges branches for the "all branches" view.

create table branches (
  id uuid primary key default gen_random_uuid(),
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create index on branches (pharmacy_id);
alter table branches enable row level security;
create policy "members read branches" on branches for select using (is_member(pharmacy_id));
create policy "owner renames branches" on branches for update
  using (is_member(pharmacy_id, array['owner'])) with check (is_member(pharmacy_id, array['owner']));
revoke update on branches from authenticated, anon;
grant update (name) on branches to authenticated;

-- Every existing pharmacy gets its main branch.
insert into branches (pharmacy_id, name) select id, 'الفرع الرئيسي' from pharmacies;

alter table snapshots add column branch_id uuid references branches(id) on delete cascade;
update snapshots s set branch_id = (select b.id from branches b where b.pharmacy_id = s.pharmacy_id order by b.created_at limit 1);
create index on snapshots (branch_id, created_at desc);

alter table connector_tokens add column branch_id uuid references branches(id) on delete cascade;
update connector_tokens t set branch_id = (select b.id from branches b where b.pharmacy_id = t.pharmacy_id order by b.created_at limit 1);
create index on connector_tokens (branch_id);

-- Main branch of a pharmacy (oldest); used when a caller does not name one.
create function main_branch(p_pharmacy uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from branches where pharmacy_id = p_pharmacy order by created_at limit 1;
$$;
revoke all on function main_branch(uuid) from public, anon, authenticated;

-- A branch id is only accepted if it belongs to the pharmacy.
create function branch_of(p_pharmacy uuid, p_branch uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare b uuid;
begin
  if p_branch is null then return main_branch(p_pharmacy); end if;
  select id into b from branches where id = p_branch and pharmacy_id = p_pharmacy;
  if b is null then raise exception 'unknown branch'; end if;
  return b;
end $$;
revoke all on function branch_of(uuid, uuid) from public, anon, authenticated;

create function add_branch(p_pharmacy uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  insert into branches (pharmacy_id, name) values (p_pharmacy, trim(p_name)) returning id into b;
  return b;
end $$;
revoke all on function add_branch(uuid, text) from public, anon;
grant execute on function add_branch(uuid, text) to authenticated;

-- New pharmacies start with a main branch.
create or replace function create_pharmacy(p_name text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare p uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into pharmacies (name) values (p_name) returning id into p;
  insert into members (pharmacy_id, user_id, role) values (p, auth.uid(), 'owner');
  insert into branches (pharmacy_id, name) values (p, 'الفرع الرئيسي');
  return p;
end $$;

-- Snapshots per branch (keep the 10 most recent per branch).
drop function save_snapshot(uuid, jsonb);
create function save_snapshot(p_pharmacy uuid, p_data jsonb, p_branch uuid default null)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare s bigint; b uuid;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_data -> 'items') <> 'array' then raise exception 'bad snapshot'; end if;
  if pg_column_size(p_data) > 20 * 1024 * 1024 then raise exception 'snapshot too large'; end if;
  b := branch_of(p_pharmacy, p_branch);
  insert into snapshots (pharmacy_id, branch_id, created_by, item_count, data)
  values (p_pharmacy, b, auth.uid(), jsonb_array_length(p_data -> 'items'), p_data)
  returning id into s;
  delete from snapshots where branch_id = b and id not in
    (select id from snapshots where branch_id = b order by created_at desc limit 10);
  return s;
end $$;
revoke all on function save_snapshot(uuid, jsonb, uuid) from public, anon;
grant execute on function save_snapshot(uuid, jsonb, uuid) to authenticated;

-- One connector token per branch; a new token revokes the old one for that branch only.
drop function create_connector_token(uuid);
create function create_connector_token(p_pharmacy uuid, p_branch uuid default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare t text; b uuid;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  b := branch_of(p_pharmacy, p_branch);
  update connector_tokens set revoked = true where branch_id = b and not revoked;
  t := 'sdl_' || encode(gen_random_bytes(24), 'hex');
  insert into connector_tokens (pharmacy_id, branch_id, token_hash) values (p_pharmacy, b, encode(digest(t, 'sha256'), 'hex'));
  return t;
end $$;
revoke all on function create_connector_token(uuid, uuid) from public, anon;
grant execute on function create_connector_token(uuid, uuid) to authenticated;

create or replace function upload_snapshot(p_token text, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  ct connector_tokens%rowtype;
  s bigint; b uuid;
begin
  select * into ct from connector_tokens where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and not revoked;
  if not found then raise exception 'invalid token'; end if;
  if jsonb_typeof(p_data -> 'items') <> 'array' then raise exception 'bad snapshot'; end if;
  if pg_column_size(p_data) > 20 * 1024 * 1024 then raise exception 'snapshot too large'; end if;
  b := coalesce(ct.branch_id, main_branch(ct.pharmacy_id));
  insert into snapshots (pharmacy_id, branch_id, created_by, item_count, data)
  values (ct.pharmacy_id, b, null, jsonb_array_length(p_data -> 'items'), p_data)
  returning id into s;
  update connector_tokens set last_used_at = now() where id = ct.id;
  delete from snapshots where branch_id = b and id not in
    (select id from snapshots where branch_id = b order by created_at desc limit 10);
  return s;
end $$;

-- ---------- Expenses and owner withdrawals ----------
-- The id is made on the device so an entry saved offline is uploaded once, however many times sync retries.
create table expenses (
  id uuid primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  branch_id uuid references branches(id) on delete cascade,
  spent_on date not null,
  kind text not null check (kind in ('electricity', 'water', 'rent', 'salaries', 'maintenance', 'supplies', 'withdrawal', 'other')),
  amount numeric(12, 2) not null check (amount > 0 and amount < 100000000),
  note text check (length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on expenses (pharmacy_id, spent_on);
create index on expenses (branch_id);
create index on expenses (created_by);
alter table expenses enable row level security;
create policy "managers read expenses" on expenses for select using (is_member(pharmacy_id, array['owner', 'partner']));
create policy "owner adds expenses" on expenses for insert with check (
  is_member(pharmacy_id, array['owner'])
  and created_by = (select auth.uid())
  and (branch_id is null or exists (select 1 from branches b where b.id = branch_id and b.pharmacy_id = expenses.pharmacy_id)));
create policy "owner deletes expenses" on expenses for delete using (is_member(pharmacy_id, array['owner']));
revoke all on expenses from anon;
revoke update on expenses from authenticated;
