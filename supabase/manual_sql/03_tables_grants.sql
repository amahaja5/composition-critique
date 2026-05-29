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
