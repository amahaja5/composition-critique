# Composition Critique

Vue app for authenticated composition uploads and critique workflows.

The app currently wires:
- Google OAuth through Supabase Auth
- PDF, MusicXML, XML, and MXL file selection
- Supabase Storage uploads to the `composition-assets` bucket
- Postgres inserts for `compositions`, `composition_assets`, and `upload_events`
- in-app reference panels for the auth, upload, and Supabase design docs

## Environment

Create `.env.local` from `.env.example`:

```sh
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

The browser app must never receive a Supabase service role key.

## Development

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Supabase Setup

Use [src/supabase_config.md](src/supabase_config.md) as the sample backend setup:
- enable Google OAuth
- create the private `composition-assets` bucket
- create the composition metadata tables
- enable Row Level Security
- add Storage policies for `user/{owner_id}/...` paths

For auth button logging, run
[supabase/migrations/20260528152000_create_auth_events.sql](supabase/migrations/20260528152000_create_auth_events.sql)
in the Supabase SQL editor or through the Supabase CLI. This creates
`public.auth_events`, grants API access, and reloads the PostgREST schema cache.

## OAuth Preview Route

The app implements `/oauth/consent` for provider preview checks. Vercel rewrites
that path to the Vue app through `vercel.json`, and the app normalizes double
slashes so `//oauth/consent` reaches the same consent screen.

## Auth Callback Route

Google OAuth returns to Supabase first, then Supabase redirects the browser to
`/auth/callback` on this app. Add both local and production callback URLs to
Supabase Auth redirect URLs:

```txt
http://127.0.0.1:5173/auth/callback
http://localhost:5173/auth/callback
https://your-vercel-domain.vercel.app/auth/callback
```

## Public Legal Routes

The app includes public legal pages for provider review:
- `/terms` for Terms of Service
- `/eula` for the End User License Agreement

These are starter templates and should be reviewed before production launch.
