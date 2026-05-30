alter table public.review_runs enable row level security;
alter table public.review_responses enable row level security;
alter table public.engraving_findings enable row level security;

revoke all on public.review_runs from anon, authenticated;
revoke all on public.review_responses from anon, authenticated;
revoke all on public.engraving_findings from anon, authenticated;

grant select on public.review_runs to authenticated;
grant select on public.review_responses to authenticated;
grant select on public.engraving_findings to authenticated;
grant all on public.review_runs to service_role;
grant all on public.review_responses to service_role;
grant all on public.engraving_findings to service_role;

drop policy if exists "Users can read their review runs" on public.review_runs;
create policy "Users can read their review runs"
on public.review_runs
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can read their review responses" on public.review_responses;
create policy "Users can read their review responses"
on public.review_responses
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can read their engraving findings" on public.engraving_findings;
create policy "Users can read their engraving findings"
on public.engraving_findings
for select
to authenticated
using (owner_id = (select auth.uid()));

notify pgrst, 'reload schema';
