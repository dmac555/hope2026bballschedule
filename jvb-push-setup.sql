begin;

create extension if not exists pg_net;

create table if not exists public.hope_jvb_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.hope_jvb_accounts(id) on delete cascade,
  subscription jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.hope_jvb_push_subscriptions enable row level security;
revoke all on public.hope_jvb_push_subscriptions from public, anon, authenticated;

create table if not exists public.hope_jvb_push_keys (
  singleton boolean primary key default true check (singleton),
  public_key text not null,
  private_key text not null
);
alter table public.hope_jvb_push_keys enable row level security;
revoke all on public.hope_jvb_push_keys from public, anon, authenticated;

create or replace function public.hope_jvb_register_push(p_subscription jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  current_account uuid := public.hope_jvb_account_id();
  push_endpoint text := p_subscription->>'endpoint';
begin
  if auth.uid() is null or current_account is null then
    raise exception 'JVB sign-in required' using errcode = '42501';
  end if;
  if push_endpoint is null or length(push_endpoint) > 2048
    or push_endpoint !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-zA-Z0-9.-]+[.]push[.]apple[.]com)/'
    or coalesce(length(p_subscription->'keys'->>'p256dh'), 0) not between 1 and 256
    or coalesce(length(p_subscription->'keys'->>'auth'), 0) not between 1 and 256 then
    raise exception 'Invalid push subscription' using errcode = '22023';
  end if;
  if not exists (select 1 from public.hope_jvb_push_subscriptions where endpoint = push_endpoint and account_id = current_account)
    and (select count(*) from public.hope_jvb_push_subscriptions where account_id = current_account) >= 10 then
    raise exception 'Too many notification devices' using errcode = '22023';
  end if;
  insert into public.hope_jvb_push_subscriptions (endpoint, user_id, account_id, subscription)
  values (push_endpoint, auth.uid(), current_account, jsonb_build_object(
    'endpoint', push_endpoint,
    'keys', jsonb_build_object('p256dh', p_subscription->'keys'->>'p256dh', 'auth', p_subscription->'keys'->>'auth')
  ))
  on conflict (endpoint) do update set user_id = excluded.user_id, account_id = excluded.account_id,
    subscription = excluded.subscription, updated_at = now();
end;
$$;

create or replace function public.hope_jvb_unregister_push(p_endpoint text)
returns void language sql security definer set search_path = public, pg_temp
as $$
  delete from public.hope_jvb_push_subscriptions
  where endpoint = p_endpoint and user_id = auth.uid() and account_id = public.hope_jvb_account_id()
$$;

create or replace function public.hope_jvb_push_get_keys(p_public text, p_private text)
returns table (public_key text, private_key text)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.hope_jvb_push_keys (singleton, public_key, private_key)
  values (true, p_public, p_private) on conflict (singleton) do nothing;
  return query select keys.public_key, keys.private_key from public.hope_jvb_push_keys keys where singleton;
end;
$$;

create or replace function public.hope_jvb_push_authorize(p_token text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from vault.decrypted_secrets
    where name = 'hope_jvb_push_hook' and decrypted_secret = p_token)
$$;

create or replace function public.hope_jvb_push_targets(p_message_id uuid)
returns table (endpoint text, subscription jsonb, channel text, participant_id uuid)
language sql stable security definer set search_path = public, pg_temp
as $$
  select target.endpoint, target.subscription, message.channel, message.participant_id
  from public.hope_jvb_messages message
  join public.hope_jvb_push_subscriptions target on target.account_id <> message.sender_id
  join public.hope_jvb_accounts recipient on recipient.id = target.account_id
  join public.hope_jvb_sessions session on session.user_id = target.user_id and session.account_id = target.account_id
  where message.id = p_message_id
    and (message.channel = 'team' or target.account_id = message.participant_id or recipient.is_coach)
$$;

create or replace function public.hope_jvb_push_remove_expired(p_endpoint text)
returns void language sql security definer set search_path = public, pg_temp
as $$
  delete from public.hope_jvb_push_subscriptions where endpoint = p_endpoint
$$;

revoke all on function public.hope_jvb_register_push(jsonb) from public, anon;
revoke all on function public.hope_jvb_unregister_push(text) from public, anon;
grant execute on function public.hope_jvb_register_push(jsonb) to authenticated;
grant execute on function public.hope_jvb_unregister_push(text) to authenticated;
revoke all on function public.hope_jvb_push_get_keys(text, text) from public, anon, authenticated;
revoke all on function public.hope_jvb_push_authorize(text) from public, anon, authenticated;
revoke all on function public.hope_jvb_push_targets(uuid) from public, anon, authenticated;
revoke all on function public.hope_jvb_push_remove_expired(text) from public, anon, authenticated;
grant execute on function public.hope_jvb_push_get_keys(text, text) to service_role;
grant execute on function public.hope_jvb_push_authorize(text) to service_role;
grant execute on function public.hope_jvb_push_targets(uuid) to service_role;
grant execute on function public.hope_jvb_push_remove_expired(text) to service_role;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'hope_jvb_push_hook') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'hope_jvb_push_hook');
  end if;
end;
$$;

create or replace function public.hope_jvb_queue_push()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform net.http_post(
    url := 'https://ffkqgkxxykoxztvigxzd.supabase.co/functions/v1/hope-jvb-push',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('action', 'deliver', 'message_id', new.id,
      'token', (select decrypted_secret from vault.decrypted_secrets where name = 'hope_jvb_push_hook'))
  );
  return new;
exception when others then
  raise warning 'JVB notification dispatch failed';
  return new;
end;
$$;

drop trigger if exists hope_jvb_queue_push on public.hope_jvb_messages;
create trigger hope_jvb_queue_push after insert on public.hope_jvb_messages
for each row execute function public.hope_jvb_queue_push();

commit;