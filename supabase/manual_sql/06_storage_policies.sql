drop policy if exists "Users can upload their own composition assets" on storage.objects;
create policy "Users can upload their own composition assets"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'compositions'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
  and (storage.foldername(name))[3] = 'compositions'
);

drop policy if exists "Users can read their own composition assets" on storage.objects;
create policy "Users can read their own composition assets"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'compositions'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
  and (storage.foldername(name))[3] = 'compositions'
);

drop policy if exists "Users can delete their own composition assets" on storage.objects;
create policy "Users can delete their own composition assets"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'compositions'
  and (storage.foldername(name))[1] = 'user'
  and (storage.foldername(name))[2] = ((select auth.uid())::text)
  and (storage.foldername(name))[3] = 'compositions'
);

notify pgrst, 'reload schema';
