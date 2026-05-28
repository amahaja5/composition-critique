Goal
Provide a sample Supabase configuration for the auth and upload designs.
This sample assumes:
- Vue 3 + Vite frontend
- Supabase Auth with Google OAuth
- Supabase Storage for uploaded file blobs
- Postgres tables for composition metadata, asset metadata, and upload events
- Row Level Security for all user-owned data

Environment variables

Frontend `.env.local`:

```sh
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key_here
```

Do not put a service role key in the Vue app.

Local Supabase Google OAuth secret:

```sh
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=your-google-client-secret
```

Supabase local config

Example `supabase/config.toml` Google provider section:

```toml
[auth.external.google]
enabled = true
client_id = "your-google-client-id.apps.googleusercontent.com"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET)"
skip_nonce_check = false
```

Google OAuth setup
- Authorized JavaScript origins:
  - `http://localhost:5173`
  - production app origin
- Authorized redirect URIs:
  - local Supabase: `http://127.0.0.1:54321/auth/v1/callback`
  - hosted Supabase callback URL from the Supabase Google provider settings

Storage bucket

Create one private bucket:

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'composition-assets',
  'composition-assets',
  false,
  52428800,
  array[
    'application/pdf',
    'application/xml',
    'text/xml',
    'application/vnd.recordare.musicxml+xml',
    'application/vnd.recordare.musicxml'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
```

Recommended storage path shape:

```txt
user/{owner_id}/compositions/{composition_id}/{asset_id}/{safe_filename}
```

Database schema

```sql
create extension if not exists pgcrypto;

create type public.composition_asset_type as enum (
  'pdf',
  'musicxml'
);

create type public.upload_status as enum (
  'pending',
  'uploaded',
  'failed'
);

create type public.processing_status as enum (
  'unprocessed',
  'queued',
  'processing',
  'ready',
  'failed'
);

create type public.upload_event_type as enum (
  'selected',
  'validation_failed',
  'upload_started',
  'upload_succeeded',
  'upload_failed'
);

create table public.compositions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Untitled composition',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.composition_assets (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid not null references public.compositions(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  asset_type public.composition_asset_type not null,
  original_filename text not null,
  storage_bucket text not null default 'composition-assets',
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

create table public.upload_events (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.composition_assets(id) on delete set null,
  composition_id uuid references public.compositions(id) on delete set null,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  event_type public.upload_event_type not null,
  message text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index compositions_owner_id_idx on public.compositions(owner_id);
create index composition_assets_owner_id_idx on public.composition_assets(owner_id);
create index composition_assets_composition_id_idx on public.composition_assets(composition_id);
create index upload_events_owner_id_idx on public.upload_events(owner_id);
create index upload_events_composition_id_idx on public.upload_events(composition_id);
create index upload_events_asset_id_idx on public.upload_events(asset_id);
```

Row Level Security

```sql
alter table public.compositions enable row level security;
alter table public.composition_assets enable row level security;
alter table public.upload_events enable row level security;

create policy "Users can read their compositions"
on public.compositions
for select
to authenticated
using (owner_id = (select auth.uid()));

create policy "Users can create their compositions"
on public.compositions
for insert
to authenticated
with check (owner_id = (select auth.uid()));

create policy "Users can update their compositions"
on public.compositions
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy "Users can delete their compositions"
on public.compositions
for delete
to authenticated
using (owner_id = (select auth.uid()));

create policy "Users can read their composition assets"
on public.composition_assets
for select
to authenticated
using (owner_id = (select auth.uid()));

create policy "Users can create assets for their compositions"
on public.composition_assets
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
  and storage_bucket = 'composition-assets'
  and storage_path like ('user/' || ((select auth.uid())::text) || '/%')
  and exists (
    select 1
    from public.compositions c
    where c.id = composition_assets.composition_id
      and c.owner_id = (select auth.uid())
  )
);

create policy "Users can update their composition assets"
on public.composition_assets
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid())
  and storage_bucket = 'composition-assets'
  and storage_path like ('user/' || ((select auth.uid())::text) || '/%')
  and exists (
    select 1
    from public.compositions c
    where c.id = composition_assets.composition_id
      and c.owner_id = (select auth.uid())
  )
);

create policy "Users can delete their composition assets"
on public.composition_assets
for delete
to authenticated
using (owner_id = (select auth.uid()));

create policy "Users can read their upload events"
on public.upload_events
for select
to authenticated
using (owner_id = (select auth.uid()));

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
```

Storage policies

These policies assume every object path starts with `user/{owner_id}/...`.

```sql
create policy "Users can upload their own composition assets"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'composition-assets'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);

create policy "Users can read their own composition assets"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'composition-assets'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);

create policy "Users can delete their own composition assets"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'composition-assets'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
);
```

Do not enable object `update`/upsert until replacement and versioning behavior is
defined. Prefer creating a new asset row for replacements at first.

Vue Supabase client

Install:

```sh
npm install @supabase/supabase-js
```

Example `src/lib/supabase.js`:

```js
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)
```

Example auth calls:

```js
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
  })
}

export async function signOut() {
  return supabase.auth.signOut()
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  return data.user
}
```

Example upload sequence

```js
const { data: userData, error: userError } = await supabase.auth.getUser()
if (userError) throw userError

const ownerId = userData.user.id
const compositionId = crypto.randomUUID()
const assetId = crypto.randomUUID()
const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
const storagePath = `user/${ownerId}/compositions/${compositionId}/${assetId}/${safeFilename}`

await supabase.from('compositions').insert({
  id: compositionId,
  title: 'Untitled composition',
})

const { error: uploadError } = await supabase.storage
  .from('composition-assets')
  .upload(storagePath, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
  })

if (uploadError) throw uploadError

await supabase.from('composition_assets').insert({
  id: assetId,
  composition_id: compositionId,
  asset_type: file.type === 'application/pdf' ? 'pdf' : 'musicxml',
  original_filename: file.name,
  storage_path: storagePath,
  mime_type: file.type,
  byte_size: file.size,
  upload_status: 'uploaded',
})

await supabase.from('upload_events').insert({
  asset_id: assetId,
  composition_id: compositionId,
  event_type: 'upload_succeeded',
  message: 'Upload completed',
})
```

Notes
- Let database defaults fill `owner_id`; RLS still verifies the row belongs to
  the authenticated user.
- The upload sequence may leave a Storage object without a metadata row if the
  metadata insert fails. A production implementation should either clean up the
  object on failure or use a server-side function to coordinate the workflow.
- Server-side validation is still required before downstream parsing or
  long-context extraction.

Reference docs
- Supabase Google OAuth: https://supabase.com/docs/guides/auth/social-login/auth-google
- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Storage access control: https://supabase.com/docs/guides/storage/security/access-control
