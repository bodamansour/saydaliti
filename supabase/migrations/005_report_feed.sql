-- Daily WhatsApp job reads each pharmacy's latest snapshot through one function guarded by a shared secret.
-- Only the SHA-256 hash of the secret is stored. With no row in app_secrets the feed is off.

create table app_secrets (
  name text primary key,
  hash text not null,
  created_at timestamptz not null default now()
);
alter table app_secrets enable row level security; -- no policies: unreadable through the API
revoke all on table app_secrets from anon, authenticated;

create function report_feed(p_secret text)
returns table (pharmacy_id uuid, pharmacy_name text, settings jsonb, snapshot_at timestamptz, data jsonb)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from app_secrets where name = 'report' and hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex')) then
    raise exception 'invalid secret';
  end if;
  return query
    select p.id, p.name, p.settings, s.created_at, s.data
    from pharmacies p
    join lateral (select sn.created_at, sn.data from snapshots sn where sn.pharmacy_id = p.id order by sn.created_at desc limit 1) s on true
    where coalesce(p.settings ->> 'waNumbers', '') <> '';
end $$;

revoke all on function report_feed(text) from public;
grant execute on function report_feed(text) to anon, authenticated;
