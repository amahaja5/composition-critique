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
