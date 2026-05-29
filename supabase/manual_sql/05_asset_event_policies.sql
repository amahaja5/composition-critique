drop policy if exists "Users can update their composition assets" on public.composition_assets;
create policy "Users can update their composition assets"
on public.composition_assets
for update
to authenticated
using (owner_id = (select auth.uid()))
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

drop policy if exists "Users can delete their composition assets" on public.composition_assets;
create policy "Users can delete their composition assets"
on public.composition_assets
for delete
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can read their upload events" on public.upload_events;
create policy "Users can read their upload events"
on public.upload_events
for select
to authenticated
using (owner_id = (select auth.uid()));

drop policy if exists "Users can create their upload events" on public.upload_events;
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
