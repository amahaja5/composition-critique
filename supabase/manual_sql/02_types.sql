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
