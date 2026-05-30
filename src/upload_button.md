Goal
Build a Vue upload flow for composition source files: PDF scores.
The UI starts as an upload button, but the system should handle validation,
storage, ownership, metadata, logging, and association between related files.

Related design docs
- auth.md defines Supabase Auth and Google OAuth.
- supabase_config.md provides the sample schema, RLS policies, Storage bucket,
  and Vue client calls this upload flow should target.

Primary user flow
1. User opens the upload screen from the upload button.
2. User selects one or more files from their computer.
3. Client validates basic file constraints before upload.
4. Files are uploaded to Supabase Storage.
5. Postgres stores file metadata, ownership, association, and upload events.
6. The UI shows upload progress, success, failure, and retry options.

Non-goals
- This is not a full document management system.
- This is not a score editor, parser, OCR system, or preview generator.
- This should not store raw file blobs directly in Postgres.
- Screenshot generation and long-context extraction are downstream processing tasks,
  not part of the upload button itself.

Architecture
button -> upload screen -> file picker -> client validation -> Supabase Storage upload
-> Postgres metadata row -> upload event log -> optional background processing

Storage approach
Use Supabase Storage for PDF score blobs.
Use Postgres for structured records:
- who uploaded the file
- when it was uploaded
- what type of file it is
- where the file is stored
- which composition/project it belongs to
- upload state and processing state

Use the private `compositions` Storage bucket from supabase_config.md.
Store files under user-scoped paths:

```txt
user/{owner_id}/compositions/{composition_id}/{asset_id}/{safe_filename}
```

Suggested data model

compositions
- id
- owner_id
- title
- created_at
- updated_at

composition_assets
- id
- composition_id
- owner_id
- asset_type: pdf
- original_filename
- storage_bucket
- storage_path
- mime_type
- byte_size
- checksum
- upload_status: pending | uploaded | failed
- processing_status: unprocessed | queued | processing | ready | failed
- created_at
- updated_at

upload_events
- id
- asset_id
- composition_id
- owner_id
- event_type: selected | validation_failed | upload_started | upload_succeeded | upload_failed
- message
- metadata_json
- created_at

Associating PDFs
Use a composition as the parent entity. A composition can have zero or more assets.
This lets one or more PDFs become part of the same composition.

The database enum may keep historical MusicXML compatibility, but the active
frontend workflow is PDF-only.

Recommended behavior:
- If the user uploads multiple PDFs together, create one composition and attach each asset.
- If the user uploads one PDF first, create a composition with one asset.
- If the user later uploads a replacement or alternate PDF, attach it to the existing composition.
- If there is ambiguity, let the user choose the target composition.

Validation

Client-side validation:
- Accept only PDF files.
- Enforce max file size before upload.
- Show a clear error for unsupported types.
- Do not rely on client validation for security.

Server-side validation:
- Re-check MIME type and extension.
- Enforce size limits.
- Store files under user-scoped paths.
- Treat PDFs as untrusted input.
- Consider malware scanning before downstream processing.

Upload states
The Vue component should model these states explicitly:
- idle
- selecting
- validating
- ready
- uploading
- success
- error

The UI should support:
- single-file upload
- multi-file PDF upload
- progress indicator
- retry failed upload
- remove selected file before upload
- clear error states

Supabase responsibilities
- Supabase Auth provides the current user.
- Supabase Storage stores the uploaded files.
- Postgres stores metadata and logs.
- Row Level Security ensures users can access only their own compositions,
  assets, and upload events.
- Storage policies should mirror the ownership rules from Postgres.

Access control
Every composition, asset, and upload event should include owner_id.
The Vue app should require a Supabase session before upload starts.
RLS policies should enforce:
- users can select their own records
- users can insert records for themselves
- users can update/delete only their own records, if deletion is supported
- users cannot access another user's storage paths

Scale considerations
- Upload directly to Supabase Storage instead of proxying large files through the app server.
- Keep Postgres rows small and metadata-focused.
- Use checksums for deduplication and integrity checks.
- Add background jobs later for preview generation or PDF analysis.
- Store generated previews or extracted artifacts in Storage, then reference them from Postgres.

Open decisions
- Maximum PDF size.
- Whether each composition can have multiple PDFs.
- Whether replacing an asset creates a new version or overwrites the old asset.
- Whether uploaded PDFs need malware scanning before they can be processed.
- Whether long-context extraction should happen immediately, on demand, or as a background job.
- Whether failed uploads should leave audit rows only, partial asset rows, or both.

Initial implementation slice
1. Build the Vue upload screen and reusable upload button.
2. Require an authenticated Supabase session before file selection.
3. Add file selection, validation, progress, success, and error states.
4. Create or select the target composition.
5. Upload valid files to the `compositions` Supabase Storage bucket.
6. Insert composition_assets metadata rows that match the stored object paths.
7. Insert upload_events rows for success and failure.
8. Use the RLS and Storage policies from supabase_config.md before exposing the
   feature to users.
