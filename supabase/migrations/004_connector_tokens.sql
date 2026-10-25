-- The cashier-PC connector uploads a daily snapshot with a per-pharmacy token (no user password on that PC).
-- Only a SHA-256 hash of the token is stored; the owner sees the token once when creating it.

create table connector_tokens (
  id bigint generated always as identity primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked boolean not null default false
);
create index on connector_tokens (pharmacy_id);
alter table connector_tokens enable row level security;
create policy "owner reads tokens" on connector_tokens for select using (is_member(pharmacy_id, array['owner']));

-- Owner creates a token; any earlier tokens for the pharmacy are revoked.
create function create_connector_token(p_pharmacy uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare t text;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  update connector_tokens set revoked = true where pharmacy_id = p_pharmacy and not revoked;
  t := 'sdl_' || encode(gen_random_bytes(24), 'hex');
  insert into connector_tokens (pharmacy_id, token_hash) values (p_pharmacy, encode(digest(t, 'sha256'), 'hex'));
  return t;
end $$;

-- Called by the connector with the publishable key (anon role) + token.
create function upload_snapshot(p_token text, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  ct connector_tokens%rowtype;
  s bigint;
begin
  select * into ct from connector_tokens where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and not revoked;
  if not found then raise exception 'invalid token'; end if;
  if jsonb_typeof(p_data -> 'items') <> 'array' then raise exception 'bad snapshot'; end if;
  if pg_column_size(p_data) > 20 * 1024 * 1024 then raise exception 'snapshot too large'; end if;
  insert into snapshots (pharmacy_id, created_by, item_count, data)
  values (ct.pharmacy_id, null, jsonb_array_length(p_data -> 'items'), p_data)
  returning id into s;
  update connector_tokens set last_used_at = now() where id = ct.id;
  delete from snapshots where pharmacy_id = ct.pharmacy_id and id not in
    (select id from snapshots where pharmacy_id = ct.pharmacy_id order by created_at desc limit 10);
  return s;
end $$;

revoke all on function create_connector_token(uuid) from public, anon;
grant execute on function create_connector_token(uuid) to authenticated;
revoke all on function upload_snapshot(text, jsonb) from public;
grant execute on function upload_snapshot(text, jsonb) to anon, authenticated;
