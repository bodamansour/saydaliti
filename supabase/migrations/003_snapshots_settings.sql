-- Shared pharmacy data: the latest stock/sales snapshot and the owner's settings (tax, expenses, targets).
-- Snapshots hold item-level stock, batches and per-day sales totals only — no customer data.

alter table pharmacies add column settings jsonb not null default '{}'::jsonb;

create table snapshots (
  id bigint generated always as identity primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  item_count int not null,
  data jsonb not null
);
create index on snapshots (pharmacy_id, created_at desc);
alter table snapshots enable row level security;
create policy "managers read snapshots" on snapshots for select using (is_member(pharmacy_id, array['owner','partner']));

create function save_snapshot(p_pharmacy uuid, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare s bigint;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_data -> 'items') <> 'array' then raise exception 'bad snapshot'; end if;
  if pg_column_size(p_data) > 20 * 1024 * 1024 then raise exception 'snapshot too large'; end if;
  insert into snapshots (pharmacy_id, created_by, item_count, data)
  values (p_pharmacy, auth.uid(), jsonb_array_length(p_data -> 'items'), p_data)
  returning id into s;
  -- keep the 10 most recent
  delete from snapshots where pharmacy_id = p_pharmacy and id not in
    (select id from snapshots where pharmacy_id = p_pharmacy order by created_at desc limit 10);
  return s;
end $$;

create function save_settings(p_pharmacy uuid, p_settings jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_settings) <> 'object' then raise exception 'bad settings'; end if;
  update pharmacies set settings = p_settings where id = p_pharmacy;
end $$;

revoke all on function save_snapshot(uuid, jsonb) from public, anon;
grant execute on function save_snapshot(uuid, jsonb) to authenticated;
revoke all on function save_settings(uuid, jsonb) from public, anon;
grant execute on function save_settings(uuid, jsonb) to authenticated;
