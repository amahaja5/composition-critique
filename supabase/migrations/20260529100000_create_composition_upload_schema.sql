create extension if not exists pgcrypto;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'compositions',
  'compositions',
  false,
  52428800,
  array[
    'application/pdf',
    'application/xml',
    'text/xml',
    'application/vnd.recordare.musicxml+xml',
    'application/vnd.recordare.musicxml',
    'application/vnd.recordare.musicxml-compressed'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'composition_asset_type'
      and n.nspname = 'public'
  ) then
    create type public.composition_asset_type as enum (
      'pdf',
      'musicxml'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'upload_status'
      and n.nspname = 'public'
  ) then
    create type public.upload_status as enum (
      'pending',
      'uploaded',
      'failed'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'processing_status'
      and n.nspname = 'public'
  ) then
    create type public.processing_status as enum (
      'unprocessed',
      'queued',
      'processing',
      'ready',
      'failed'
    );
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'upload_event_type'
      and n.nspname = 'public'
  ) then
    create type public.upload_event_type as enum (
      'selected',
      'validation_failed',
      'upload_started',
      'upload_succeeded',
      'upload_failed'
    );
  end if;
end $$;

create table if not exists public.compositions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Untitled composition',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.composition_assets (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid not null references public.compositions(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_type public.composition_asset_type not null,
  original_filename text not null,
  storage_bucket text not null default 'compositions',
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  checksum text,
  upload_status public.upload_status not null default 'pending',
  processing_status public.processing_status not null default 'unprocessed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create table if not exists public.upload_events (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.composition_assets(id) on delete set null,
  composition_id uuid references public.compositions(id) on delete set null,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_type public.upload_event_type not null,
  message text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists compositions_owner_id_idx on public.compositions(owner_id);
create index if not exists composition_assets_owner_id_idx on public.composition_assets(owner_id);
create index if not exists composition_assets_composition_id_idx on public.composition_assets(composition_id);
create index if not exists upload_events_owner_id_idx on public.upload_events(owner_id);
create index if not exists upload_events_composition_id_idx on public.upload_events(composition_id);
create index if not exists upload_events_asset_id_idx on public.upload_events(asset_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_compositions_updated_at on public.compositions;
create trigger set_compositions_updated_at
before update on public.compositions
for each row
execute function public.set_updated_at();

drop trigger if exists set_composition_assets_updated_at on public.composition_assets;
create trigger set_composition_assets_updated_at
before update on public.composition_assets
for each row
execute function public.set_updated_at();

alter table public.compositions enable row level security;
alter table public.composition_assets enable row level security;
alter table public.upload_events enable row level security;

revoke all on public.compositions from anon;
revoke all on public.composition_assets from anon;
revoke all on public.upload_events from anon;

grant usage on type public.composition_asset_type to authenticated;
grant usage on type public.upload_status to authenticated;
grant usage on type public.processing_status to authenticated;
grant usage on type public.upload_event_type to authenticated;
grant select, insert, update, delete on public.compositions to authenticated;
grant select, insert, update, delete on public.composition_assets to authenticated;
grant select, insert on public.upload_events to authenticated;

drop policy if exists "Users can read their compositions" on public.compositions;
create policy "Users can read their compositions"
on public.compositions
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can create their compositions" on public.compositions;
create policy "Users can create their compositions"
on public.compositions
for insert
to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists "Users can update their compositions" on public.compositions;
create policy "Users can update their compositions"
on public.compositions
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

drop policy if exists "Users can delete their compositions" on public.compositions;
create policy "Users can delete their compositions"
on public.compositions
for delete
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can read their composition assets" on public.composition_assets;
create policy "Users can read their composition assets"
on public.composition_assets
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can create assets for their compositions" on public.composition_assets;
create policy "Users can create assets for their compositions"
on public.composition_assets
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
  and storage_bucket = 'compositions'
  and storage_path like ('user/' || ((select auth.uid())::text) || '/compositions/%')
  and exists (
    select 1
    from public.compositions c
    where c.id = composition_assets.composition_id
      and c.owner_id = (select auth.uid())
  )
);

drop policy if exists "Users can update their composition assets" on public.composition_assets;
create policy "Users can update their composition assets"
on public.composition_assets
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid())
  and storage_bucket = 'compositions'
  and storage_path like ('user/' || ((select auth.uid())::text) || '/compositions/%')
  and exists (
    select 1
    from public.compositions c
    where c.id = composition_assets.composition_id
      and c.owner_id = (select auth.uid())
  )
);

drop policy if exists "Users can delete their composition assets" on public.composition_assets;
create policy "Users can delete their composition assets"
on public.composition_assets
for delete
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can read their upload events" on public.upload_events;
create policy "Users can read their upload events"
on public.upload_events
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can create their upload events" on public.upload_events;
create policy "Users can create their upload events"
on public.upload_events
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
  and (
    composition_id is null
    or exists (
      select 1
      from public.compositions c
      where c.id = upload_events.composition_id
        and c.owner_id = (select auth.uid())
    )
  )
  and (
    asset_id is null
    or exists (
      select 1
      from public.composition_assets a
      where a.id = upload_events.asset_id
        and a.owner_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can upload their own composition assets" on storage.objects;
create policy "Users can upload their own composition assets"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'compositions'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
  and (storage.foldername(name))[3] = 'compositions'
);

drop policy if exists "Users can read their own composition assets" on storage.objects;
create policy "Users can read their own composition assets"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'compositions'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
  and (storage.foldername(name))[3] = 'compositions'
);

drop policy if exists "Users can delete their own composition assets" on storage.objects;
create policy "Users can delete their own composition assets"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'compositions'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
  and (storage.foldername(name))[3] = 'compositions'
);

notify pgrst, 'reload schema';
