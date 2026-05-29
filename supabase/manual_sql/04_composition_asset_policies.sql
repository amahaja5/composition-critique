drop policy if exists "Users can read their compositions" on public.compositions;
create policy "Users can read their compositions"
on public.compositions
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can create their compositions" on public.compositions;
create policy "Users can create their compositions"
on public.compositions
for insert
to authenticated
with check (owner_id = (select auth.uid()));

drop policy if exists "Users can update their compositions" on public.compositions;
create policy "Users can update their compositions"
on public.compositions
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

drop policy if exists "Users can delete their compositions" on public.compositions;
create policy "Users can delete their compositions"
on public.compositions
for delete
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can read their composition assets" on public.composition_assets;
create policy "Users can read their composition assets"
on public.composition_assets
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can create assets for their compositions" on public.composition_assets;
create policy "Users can create assets for their compositions"
on public.composition_assets
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
  and storage_bucket = 'compositions'
  and storage_path like ('user/' || ((select auth.uid())::text) || '/compositions/%')
  and exists (
    select 1
    from public.compositions c
    where c.id = composition_assets.composition_id
      and c.owner_id = (select auth.uid())
  )
);
