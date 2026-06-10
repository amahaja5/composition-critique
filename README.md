# Composition Critique

Vue app for authenticated composition uploads and critique workflows.

The app currently wires:
- Google OAuth through Supabase Auth
- PDF score selection and preview
- Supabase Storage uploads to the `compositions` bucket
- Postgres inserts for `compositions`, `composition_assets`, and `upload_events`
- ownership via the logged-in Supabase user id on every submission row and path
- live engraving review streaming through a server-side Anthropic endpoint

## Environment

Create `.env.local` from `.env.example`:

```sh
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
VITE_REVIEW_STREAM_URL=/api/engraving-stream
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_ENGRAVING_MODEL=claude-sonnet-4-6
ANTHROPIC_ENGRAVING_ADVISOR_ENABLED=true
ANTHROPIC_ENGRAVING_ADVISOR_MODEL=claude-opus-4-8
ANTHROPIC_ENGRAVING_ADVISOR_MAX_USES=1
ANTHROPIC_POLISH_MODEL=claude-haiku-4-5
ENGRAVING_MAX_PAGES=12
ENGRAVING_PAGES_PER_CALL=3
ENGRAVING_RENDER_SCALE=2
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
FEEDBACK_ADMIN_EMAILS=you@example.com
```

The browser app must never receive a Supabase service role key or Anthropic API
key. Those secrets are used only by the Vercel API function.

## Engraving Review Streaming

The app posts uploaded composition ids to `/api/engraving-stream`. That Vercel
API function validates the Supabase user session, loads the submitted PDF,
renders pages to images, asks the configured Anthropic engraving model for
findings, then streams a findings report back to the browser. The user can then click **Polish output** to
run the optional Haiku polish pass.

Engraving and routing calls use Anthropic prompt caching on the stable system
prompt, so repeated page batches can reuse the assembled engraving rulebook
while each request still sends fresh rendered page images. To test the
lower-cost advisor path, set `ANTHROPIC_ENGRAVING_MODEL=claude-sonnet-4-6`,
`ANTHROPIC_ENGRAVING_ADVISOR_ENABLED=true`, and
`ANTHROPIC_ENGRAVING_ADVISOR_MODEL=claude-opus-4-8`. The API records that model
strategy with each review response so token usage can be compared per page.

Vision few-shot examples for page analysis are loaded from the prompt repo
manifest at `system_prompts/engraving/vision_examples/manifest.json`. To add a
new example, add the image and gold JSON file there, then add one manifest entry
with `image` and `gold`; no API code change is needed.

When `SUPABASE_SERVICE_ROLE_KEY` is configured, engraving findings, optional Haiku
polish responses, and normalized engraving findings are stored under a shared
`review_runs` row for DPO/evaluation preparation. Prompt files are loaded from
`system_prompts/`, which is intentionally ignored because those prompts live in
a separate repository.

## Development

```sh
npm install
npm run dev
```

## Engraving Eval Loop

The eval tooling is file-based and lives under `eval/`. Golden inputs are PNGs,
not PDFs.

1. Add page PNGs to `eval/golden/pages/` as `{scoreId}_p{NN}.png`.
2. Add score metadata to `eval/golden/manifest.json`.
3. Generate labeling sheets and blank truth templates:

```sh
npm run eval:sheets -- --templates
```

4. Review `eval/golden/sheets/REVIEW.md`, then label
   `eval/golden/truth/{pageId}.json` using the printed `S#` and `m#` labels.
5. Validate truth:

```sh
npm run eval:validate-truth
```

6. Run a baseline:

```sh
npm run eval:run -- --label baseline
```

7. Reproduce without API calls:

```sh
npm run eval:run -- --mock {runId} --label baseline-mock
```

8. Compare after a prompt/model/rule change:

```sh
npm run eval:compare -- {baselineRunId} {experimentRunId}
```

9. Import canonicalized in-app feedback after admin review:

```sh
npm run eval:import-feedback -- --dry-run
npm run eval:import-feedback
```

Reports are written to `eval/report/`; raw and normalized run outputs are written
to `eval/runs/`. Eval reports separate exhaustive golden pages, partial/feedback
pages, regression subsets, and seeded cases so headline recall only comes from
fully labeled pages. Generated reports, runs, sheets, and seeded render artifacts
are ignored by git.

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

For in-app eval feedback, run
[supabase/migrations/20260610100000_create_finding_verdicts.sql](supabase/migrations/20260610100000_create_finding_verdicts.sql).
This creates `finding_verdicts` for useful/irrelevant/not-true feedback and
admin canonicalization into eval truth.

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
