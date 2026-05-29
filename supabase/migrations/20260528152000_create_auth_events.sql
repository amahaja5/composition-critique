create extension if not exists pgcrypto;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'auth_event_type'
      and n.nspname = 'public'
  ) then
    create type public.auth_event_type as enum (
      'auth_init_started',
      'auth_init_skipped',
      'session_restore_failed',
      'session_restored',
      'auth_state_changed',
      'google_oauth_button_clicked',
      'google_oauth_start_failed',
      'google_oauth_redirect_requested',
      'sign_out_requested',
      'sign_out_failed',
      'sign_out_succeeded'
    );
  end if;
end $$;

create table if not exists public.auth_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid default auth.uid() references auth.users(id) on delete set null,
  event_type public.auth_event_type not null,
  route_path text,
  message text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists auth_events_owner_id_idx on public.auth_events(owner_id);
create index if not exists auth_events_created_at_idx on public.auth_events(created_at desc);

alter table public.auth_events enable row level security;

grant usage on type public.auth_event_type to anon, authenticated;
grant insert on public.auth_events to anon, authenticated;
grant select on public.auth_events to authenticated;

drop policy if exists "Clients can create auth diagnostic events" on public.auth_events;
create policy "Clients can create auth diagnostic events"
on public.auth_events
for insert
to anon, authenticated
with check (
  ((select auth.uid()) is null and owner_id is null)
  or owner_id = (select auth.uid())
);

drop policy if exists "Users can read their own auth diagnostic events" on public.auth_events;
create policy "Users can read their own auth diagnostic events"
on public.auth_events
for select
to authenticated
using (owner_id = (select auth.uid()));

notify pgrst, 'reload schema';
