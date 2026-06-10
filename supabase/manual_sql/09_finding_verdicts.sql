create table if not exists public.finding_verdicts (
  id uuid primary key default gen_random_uuid(),
  engraving_finding_id uuid not null references public.engraving_findings(id) on delete cascade,
  review_run_id uuid not null references public.review_runs(id) on delete cascade,
  composition_id uuid not null references public.compositions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  verdict text not null
    check (verdict in ('useful', 'irrelevant', 'not_true')),
  note text not null default '',
  metadata_json jsonb not null default '{}'::jsonb,
  canonical_status text not null default 'pending'
    check (canonical_status in ('pending', 'canonicalized', 'imported', 'discarded')),
  canonical_kind text
    check (
      canonical_kind is null
      or canonical_kind in (
        'accepted',
        'suppressed',
        'known_false_positive',
        'user_miss',
        'ignore',
        'discard'
      )
    ),
  canonical_payload_json jsonb not null default '{}'::jsonb,
  canonicalized_by uuid references auth.users(id) on delete set null,
  canonicalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (engraving_finding_id, owner_id)
);

create index if not exists finding_verdicts_owner_id_idx
on public.finding_verdicts(owner_id);

create index if not exists finding_verdicts_review_run_id_idx
on public.finding_verdicts(review_run_id);

create index if not exists finding_verdicts_composition_id_idx
on public.finding_verdicts(composition_id);

create index if not exists finding_verdicts_canonical_status_idx
on public.finding_verdicts(canonical_status);

alter table public.finding_verdicts enable row level security;

revoke all on public.finding_verdicts from anon, authenticated;
grant select on public.finding_verdicts to authenticated;
grant all on public.finding_verdicts to service_role;

drop policy if exists "Users can read their finding verdicts" on public.finding_verdicts;
create policy "Users can read their finding verdicts"
on public.finding_verdicts
for select
to authenticated
using (owner_id = (select auth.uid()));

notify pgrst, 'reload schema';
