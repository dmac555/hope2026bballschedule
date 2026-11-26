# JVB setup

The JVB pages are separate from the existing schedule. Do not publish these pages until the database setup and access tests are complete.

## Supabase

1. Open the existing project at https://supabase.com/dashboard/project/ffkqgkxxykoxztvigxzd and confirm you have administrator access.
2. In Authentication settings, enable anonymous sign-ins. Consider Supabase's CAPTCHA and rate-limit settings before enabling them.
3. In the SQL Editor, run `jvb-setup.sql`. It creates separate JVB tables, functions, and row-level access policies; it does not change the existing calendar tables.
4. Add each player's lowercase last name, display name, and the agreed player code privately in the SQL Editor. Repeat this statement for each player, substituting the values locally and never committing the statement with actual names or codes:

```sql
insert into public.hope_jvb_accounts (login_name, display_name, code_hash)
values (
  lower('PLAYER_LAST_NAME'),
  'PLAYER_FULL_NAME',
  extensions.crypt('PLAYER_CODE', extensions.gen_salt('bf'))
);
```

5. Give the separate `coach` account a strong, private code in the SQL Editor. Do not share that code with players or commit it to the repository:

```sql
update public.hope_jvb_accounts
set code_hash = extensions.crypt('PRIVATE_COACH_CODE', extensions.gen_salt('bf'))
where login_name = 'coach' and is_coach;
```

6. Verify that a player can read Team Chat and only their own Individual Chat, and that the coach can read and reply to each player. Verify that an unauthenticated request cannot read chat messages or roster records.

The coach signs in using `Coach` as the last name and the separate coach code. Players sign in with their last name and the player code.

## Chat notifications

Deploy `supabase/functions/hope-jvb-push/index.ts` as the `hope-jvb-push` Edge Function, with legacy gateway JWT verification disabled. The function checks JVB sign-in for subscription setup and verifies a private database webhook token for delivery. Run `jvb-push-setup.sql` in the same project after deploying the function. The migration creates JVB-only subscription storage, service-only key functions, and an insert trigger; it does not change the main calendar. The private Web Push key and webhook token remain in the database, not in the repository.

On iPhone or iPad, add the JVB page to the Home Screen, open it as a web app on iOS or iPadOS 16.4 or newer, and tap the bell to allow notifications. Alerts say only "New JVB message". The Home Screen badge clears for a conversation when that chat is viewed. Turning notifications off or signing out unsubscribes that device.

## Privacy limitations

The requested shared four-digit player code is easy to guess. Anyone who knows it and a player's last name can impersonate that player and read that player's individual chat. Use individual, stronger codes for meaningful identity protection.

The existing master schedule is publicly accessible and remains unchanged. The JVB calendar filters that existing public schedule; the underlying schedule is not made private by these pages. Chat messages and the roster are restricted by the new database policies once setup is complete.
