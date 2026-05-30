create table if not exists public.review_runs (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid not null references public.compositions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'anthropic',
  model text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  error_message text,
  metadata_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.review_responses (
  id uuid primary key default gen_random_uuid(),
  review_run_id uuid not null references public.review_runs(id) on delete cascade,
  composition_id uuid not null references public.compositions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  response_kind text not null
    check (response_kind in ('technical_analysis', 'composer_review')),
  provider text not null default 'anthropic',
  model text not null,
  prompt_name text not null,
  prompt_version text not null,
  system_prompt text not null,
  input_summary_json jsonb not null default '{}'::jsonb,
  response_text text not null default '',
  response_json jsonb not null default '{}'::jsonb,
  stream_events_json jsonb not null default '[]'::jsonb,
  usage_json jsonb not null default '{}'::jsonb,
  status text not null default 'completed'
    check (status in ('completed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists review_runs_owner_id_idx
on public.review_runs(owner_id);

create index if not exists review_runs_composition_id_idx
on public.review_runs(composition_id);

create index if not exists review_responses_owner_id_idx
on public.review_responses(owner_id);

create index if not exists review_responses_review_run_id_idx
on public.review_responses(review_run_id);

create index if not exists review_responses_composition_id_idx
on public.review_responses(composition_id);

create index if not exists review_responses_response_kind_idx
on public.review_responses(response_kind);
