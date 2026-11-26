begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.hope_jvb_accounts (
  id uuid primary key default gen_random_uuid(),
  login_name text not null unique,
  display_name text not null,
  is_coach boolean not null default false,
  code_hash text
);

create table if not exists public.hope_jvb_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_id uuid not null references public.hope_jvb_accounts(id) on delete cascade
);

insert into public.hope_jvb_accounts (login_name, display_name, is_coach)
values ('coach', 'Coach', true)
on conflict (login_name) do nothing;

create or replace function public.hope_jvb_account_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$
  select account_id from public.hope_jvb_sessions where user_id = auth.uid()
$$;

create or replace function public.hope_jvb_sign_in(last_name text, account_code text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  matching_account uuid;
begin
  if auth.uid() is null then return false; end if;
  select id into matching_account
  from public.hope_jvb_accounts
  where login_name = lower(btrim(last_name))
    and code_hash is not null
    and code_hash = extensions.crypt(account_code, code_hash);
  if matching_account is null then return false; end if;
  insert into public.hope_jvb_sessions (user_id, account_id)
  values (auth.uid(), matching_account)
  on conflict (user_id) do update set account_id = excluded.account_id;
  return true;
end;
$$;

create or replace function public.hope_jvb_session()
returns table (account_id uuid, display_name text, is_coach boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  select id, accounts.display_name, accounts.is_coach
  from public.hope_jvb_accounts accounts
  where id = public.hope_jvb_account_id()
$$;

create or replace function public.hope_jvb_roster()
returns table (account_id uuid, display_name text, is_coach boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  select accounts.id, accounts.display_name, accounts.is_coach
  from public.hope_jvb_accounts accounts
  where public.hope_jvb_account_id() is not null
  order by accounts.is_coach desc, accounts.display_name
$$;

create table if not exists public.hope_jvb_messages (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('team', 'direct')),
  participant_id uuid references public.hope_jvb_accounts(id),
  sender_id uuid not null default public.hope_jvb_account_id() references public.hope_jvb_accounts(id),
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  check ((channel = 'team' and participant_id is null) or (channel = 'direct' and participant_id is not null))
);

create index if not exists hope_jvb_messages_conversation_idx
  on public.hope_jvb_messages (channel, participant_id, created_at);

alter table public.hope_jvb_accounts enable row level security;
alter table public.hope_jvb_sessions enable row level security;
alter table public.hope_jvb_messages enable row level security;
revoke all on public.hope_jvb_accounts, public.hope_jvb_sessions, public.hope_jvb_messages from anon, authenticated;
grant select, insert on public.hope_jvb_messages to authenticated;

drop policy if exists hope_jvb_read_messages on public.hope_jvb_messages;
create policy hope_jvb_read_messages on public.hope_jvb_messages for select to authenticated
using (
  public.hope_jvb_account_id() is not null
  and (channel = 'team' or participant_id = public.hope_jvb_account_id()
    or exists (select 1 from public.hope_jvb_session() where is_coach))
);

drop policy if exists hope_jvb_send_messages on public.hope_jvb_messages;
create policy hope_jvb_send_messages on public.hope_jvb_messages for insert to authenticated
with check (
  sender_id = public.hope_jvb_account_id()
  and (channel = 'team' or participant_id = public.hope_jvb_account_id()
    or (exists (select 1 from public.hope_jvb_session() where is_coach)
      and exists (select 1 from public.hope_jvb_roster() where account_id = participant_id and not is_coach)))
);

revoke all on function public.hope_jvb_account_id() from public, anon;
revoke all on function public.hope_jvb_sign_in(text, text) from public, anon;
revoke all on function public.hope_jvb_session() from public, anon;
revoke all on function public.hope_jvb_roster() from public, anon;
grant execute on function public.hope_jvb_account_id() to authenticated;
grant execute on function public.hope_jvb_sign_in(text, text) to authenticated;
grant execute on function public.hope_jvb_session() to authenticated;
grant execute on function public.hope_jvb_roster() to authenticated;

create table if not exists public.hope_jvb_availability (
  event_id text not null,
  account_id uuid not null references public.hope_jvb_accounts(id) on delete cascade,
  attending boolean not null,
  updated_at timestamptz not null default now(),
  primary key (event_id, account_id)
);

alter table public.hope_jvb_availability enable row level security;
revoke all on public.hope_jvb_availability from public, anon, authenticated;

create or replace function public.hope_jvb_get_availability(p_event_id text)
returns table (attending_count bigint, not_attending_count bigint, my_attending boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  current_account uuid := public.hope_jvb_account_id();
begin
  if current_account is null then
    raise exception 'JVB sign-in required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.calendar_events event_item
    where event_item.id = p_event_id
      and upper(coalesce(event_item.title, '') || ' ' || coalesce(event_item.details, '')) like '%HOPE JVB%'
  ) then
    raise exception 'JVB event not found' using errcode = 'P0002';
  end if;
  return query
    select count(*) filter (where response.attending),
      count(*) filter (where not response.attending),
      bool_or(response.attending) filter (where response.account_id = current_account)
    from public.hope_jvb_availability response
    where response.event_id = p_event_id;
end;
$$;

create or replace function public.hope_jvb_set_availability(p_event_id text, p_attending boolean)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_account uuid := public.hope_jvb_account_id();
begin
  if not exists (select 1 from public.hope_jvb_accounts where id = current_account and not is_coach) then
    raise exception 'Player sign-in required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.calendar_events event_item
    where event_item.id = p_event_id
      and upper(coalesce(event_item.title, '') || ' ' || coalesce(event_item.details, '')) like '%HOPE JVB%'
  ) then
    raise exception 'JVB event not found' using errcode = 'P0002';
  end if;
  if p_attending is null then
    delete from public.hope_jvb_availability where event_id = p_event_id and account_id = current_account;
  else
    insert into public.hope_jvb_availability (event_id, account_id, attending)
    values (p_event_id, current_account, p_attending)
    on conflict (event_id, account_id) do update set attending = excluded.attending, updated_at = now();
  end if;
end;
$$;

revoke all on function public.hope_jvb_get_availability(text) from public, anon;
revoke all on function public.hope_jvb_set_availability(text, boolean) from public, anon;
grant execute on function public.hope_jvb_get_availability(text) to authenticated;
grant execute on function public.hope_jvb_set_availability(text, boolean) to authenticated;

commit;
