# Composition Critique

Vue app for authenticated composition uploads and critique workflows.

The app currently wires:
- Google OAuth through Supabase Auth
- PDF score selection and preview
- Supabase Storage uploads to the `compositions` bucket
- Postgres inserts for `compositions`, `composition_assets`, and `upload_events`
- ownership via the logged-in Supabase user id on every submission row and path
- live review streaming through a server-side Anthropic review endpoint

## Environment

Create `.env.local` from `.env.example`:

```sh
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
VITE_REVIEW_STREAM_URL=/api/review-stream
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=claude-opus-4-8
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

The browser app must never receive a Supabase service role key or Anthropic API
key. `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are used only by the
Vercel API function.

## Review Streaming

The app posts uploaded composition ids to `/api/review-stream`. That Vercel API
function validates the Supabase user session, loads the submitted PDF, runs two
Anthropic streaming review passes using prompts in `system_prompts/`, and sends
SSE events back to the browser.

The technical pass is kept private, while the composer-facing pass streams to
the UI. When `SUPABASE_SERVICE_ROLE_KEY` is configured, both full Anthropic
responses are stored in `review_responses` under a shared `review_runs` row for
DPO/evaluation preparation.

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
- create the private `compositions` bucket
- create the composition metadata tables
- enable Row Level Security
- add Storage policies for `user/{owner_id}/...` paths

For the production upload database and Storage wiring, run
[supabase/migrations/20260529100000_create_composition_upload_schema.sql](supabase/migrations/20260529100000_create_composition_upload_schema.sql)
in the Supabase SQL editor or through the Supabase CLI. This creates the private
bucket, `compositions`, `composition_assets`, `upload_events`, grants, RLS
policies, and Storage object policies needed for authenticated uploads.

For review/DPO capture, run
[supabase/migrations/20260530120000_create_review_capture_schema.sql](supabase/migrations/20260530120000_create_review_capture_schema.sql).
This creates `review_runs` and `review_responses`, grants server-side write
access to `service_role`, and allows users to read only their own review rows.

If the Supabase SQL editor limits you to 100 lines, run the files in
[supabase/manual_sql](supabase/manual_sql) in numeric order instead.

For optional auth diagnostics, run
[supabase/migrations/20260528152000_create_auth_events.sql](supabase/migrations/20260528152000_create_auth_events.sql)
in the Supabase SQL editor or through the Supabase CLI. This creates
`public.auth_events`, grants API access, and reloads the PostgREST schema cache.
Auth diagnostic events are written to Supabase and are not rendered in the app UI.

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

If the browser still shows `redirect_to=http://127.0.0.1:5173` without
`/auth/callback`, restart the local dev server and start the login again from
the app. That URL means the browser is using an older auth request.

## Public Legal Routes

The app includes public legal pages for provider review:
- `/terms` for Terms of Service
- `/eula` for the End User License Agreement

These are starter templates and should be reviewed before production launch.
