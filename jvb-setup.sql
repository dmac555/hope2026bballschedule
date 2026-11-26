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

commit;
