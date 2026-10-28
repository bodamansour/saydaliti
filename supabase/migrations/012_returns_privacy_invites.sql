-- Fixes from the review of 28 Oct 2026. Needs 011_customers.sql.
--  1. A return names the sale receipt it comes from, and can't take back more than that receipt sold.
--     A return with no receipt carries the reason the cashier typed (note).
--  2. Customers' names, phones and payments are for the owner and the cashier, not partners.
--  3. Invite codes: longer (12 characters, about 60 bits), and a limit on wrong guesses.

-- ---------- 1. Returns against a receipt ----------
alter table pos_sales add column return_of uuid references pos_sales(id) on delete restrict;
alter table pos_sales add column note text check (length(note) <= 300);
create index on pos_sales (return_of) where return_of is not null;
create index on pos_sales (pharmacy_id, number);

create function check_pos_return() returns trigger
language plpgsql security definer set search_path = public as $$
declare o pos_sales%rowtype; bad text;
begin
  if new.kind <> 'return' then
    if new.return_of is not null then raise exception 'return_of is only for returns'; end if;
    return new;
  end if;
  -- With no receipt the cashier screen asks for a reason (kept in note); the return is still accepted
  -- here, so a money record from an older cashier screen is never refused.
  if new.return_of is null then return new; end if;
  -- Locks the sale receipt, so two returns of it at the same moment are checked one after the other.
  select * into o from pos_sales where id = new.return_of and pharmacy_id = new.pharmacy_id and kind = 'sale' for update;
  if not found then raise exception 'receipt not found'; end if;
  select r.code into bad
  from (select x->>'code' as code, sum((x->>'qty')::numeric) as q from jsonb_array_elements(new.lines) x group by 1) r
  left join (select x->>'code' as code, sum((x->>'qty')::numeric) as q from jsonb_array_elements(o.lines) x group by 1) s using (code)
  left join (select x->>'code' as code, sum((x->>'qty')::numeric) as q
             from pos_sales p, jsonb_array_elements(p.lines) x
             where p.return_of = o.id and p.id <> new.id group by 1) b using (code)
  where r.q > coalesce(s.q, 0) - coalesce(b.q, 0) + 0.0001
  limit 1;
  if bad is not null then raise exception 'return more than sold'; end if;
  return new;
end $$;
revoke all on function check_pos_return() from public, anon, authenticated;
create trigger pos_sales_check_return before insert on pos_sales for each row execute function check_pos_return();

-- ---------- 2. Customers are not shown to partners ----------
drop policy "members read customers" on customers;
create policy "owner and cashier read customers" on customers for select using (is_member(pharmacy_id, array['owner', 'device']));
drop policy "members read customer payments" on customer_payments;
create policy "owner and cashier read customer payments" on customer_payments for select using (is_member(pharmacy_id, array['owner', 'device']));

-- ---------- 3. Invite codes ----------
create table invite_attempts (
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index on invite_attempts (user_id, at desc);
alter table invite_attempts enable row level security; -- no policies: only the functions below use it

-- 12 characters with no look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX-XXXX.
create or replace function create_invite(p_pharmacy uuid, p_role text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea; c text;
begin
  if not is_member(p_pharmacy, array['owner']) then raise exception 'not allowed'; end if;
  if p_role not in ('partner', 'device') then raise exception 'bad role'; end if;
  loop
    b := gen_random_bytes(12); c := '';
    for i in 0..11 loop c := c || substr(abc, 1 + (get_byte(b, i) % length(abc)), 1); end loop;
    exit when not exists (select 1 from invites where code = c);
  end loop;
  insert into invites (code, pharmacy_id, role, expires_at) values (c, p_pharmacy, p_role, now() + interval '3 days');
  return substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4);
end $$;

-- A wrong code returns nothing (instead of an error) so the attempt is still counted; after 10 wrong
-- codes in an hour the account has to wait.
create or replace function join_pharmacy(p_code text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare i invites%rowtype; c text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from invite_attempts where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'too many attempts';
  end if;
  c := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select * into i from invites where code = c and used_by is null and expires_at > now() for update;
  if not found then
    insert into invite_attempts (user_id) values (auth.uid());
    delete from invite_attempts where at < now() - interval '1 day';
    return null;
  end if;
  insert into members (pharmacy_id, user_id, role) values (i.pharmacy_id, auth.uid(), i.role)
    on conflict (pharmacy_id, user_id) do nothing;
  update invites set used_by = auth.uid(), used_at = now() where code = i.code;
  return i.pharmacy_id;
end $$;

revoke all on function create_invite(uuid, text) from public, anon;
grant execute on function create_invite(uuid, text) to authenticated;
revoke all on function join_pharmacy(text) from public, anon;
grant execute on function join_pharmacy(text) to authenticated;
