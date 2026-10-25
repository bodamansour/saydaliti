-- Owner invites partners and the pharmacy device with a short one-time code.

create table invites (
  code text primary key,
  pharmacy_id uuid not null references pharmacies(id) on delete cascade,
  role text not null check (role in ('partner', 'device')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz
);
create index on invites (pharmacy_id);
alter table invites enable row level security;
create policy "owner reads invites" on invites for select using (is_member(pharmacy_id, array['owner']));

create function create_invite(p_pharmacy uuid, p_role text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare c text;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if p_role not in ('partner', 'device') then raise exception 'bad role'; end if;
  c := upper(encode(gen_random_bytes(4), 'hex')); -- 8 characters
  insert into invites (code, pharmacy_id, role) values (c, p_pharmacy, p_role);
  return c;
end $$;

create function join_pharmacy(p_code text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare i invites%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into i from invites where code = upper(trim(p_code)) and used_by is null and expires_at > now() for update;
  if not found then raise exception 'invalid code'; end if;
  insert into members (pharmacy_id, user_id, role) values (i.pharmacy_id, auth.uid(), i.role)
    on conflict (pharmacy_id, user_id) do nothing;
  update invites set used_by = auth.uid(), used_at = now() where code = i.code;
  return i.pharmacy_id;
end $$;

revoke all on function create_invite(uuid, text) from public, anon;
grant execute on function create_invite(uuid, text) to authenticated;
revoke all on function join_pharmacy(text) from public, anon;
grant execute on function join_pharmacy(text) to authenticated;
