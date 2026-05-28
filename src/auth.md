Goal
Use Supabase Auth as the authentication layer and enable Google OAuth as the
primary sign-in method. Auth should support the upload system without rebuilding
identity, sessions, ownership, or permission checks from scratch.

Primary auth flow
1. User clicks "Sign in with Google".
2. Supabase Auth redirects the user through Google OAuth.
3. Supabase creates or retrieves the authenticated user.
4. The Vue app receives the active Supabase session.
5. The app uses the Supabase user id as owner_id for compositions, assets, and
   upload events.
6. Postgres Row Level Security and Supabase Storage policies enforce ownership.

Non-goals
- Do not build a custom username/password auth system.
- Do not store raw OAuth tokens in app tables.
- Do not rely on client-side checks for authorization.
- Do not expose upload functionality to anonymous users.

Architecture
Vue app -> Supabase Auth -> Google OAuth -> Supabase session
-> Postgres RLS -> Supabase Storage policies

Auth provider
Use Google OAuth through Supabase Auth.
Supabase handles:
- OAuth redirects
- session persistence
- refresh tokens
- user identity
- sign out
- current user lookup

User identity
Use the Supabase auth user id as the canonical user id.

Database records should store:
- owner_id uuid not null references auth.users(id)

Relevant records:
- compositions.owner_id
- composition_assets.owner_id
- upload_events.owner_id

The application should not invent a separate user id unless a profile table is
needed for app-specific display fields.

Optional profile table
Add a profiles table only if the app needs user-facing metadata beyond what
Supabase Auth provides.

profiles
- id uuid primary key references auth.users(id)
- display_name
- avatar_url
- created_at
- updated_at

This table should not replace auth.users as the identity source.

Authorization
Authorization belongs in Postgres RLS policies and Supabase Storage policies.
The frontend may hide or disable UI, but it is not the security boundary.

RLS expectations:
- Users can select only their own compositions.
- Users can insert compositions with owner_id = auth.uid().
- Users can update/delete only their own compositions, if supported.
- Users can select only their own composition assets.
- Users can insert assets with owner_id = auth.uid().
- Users can select only their own upload events.
- Users can insert upload events with owner_id = auth.uid().

Storage expectations:
- Files should be stored under user-scoped paths.
- Recommended path shape:
  user/{owner_id}/compositions/{composition_id}/{asset_id}/{filename}
- Storage policies should allow users to read/write only paths belonging to
  their own user id.
- Storage access should not depend on filename alone.

Session behavior in Vue
The app should have a small auth state layer that exposes:
- current user
- current session
- loading state while Supabase restores the session
- sign in with Google
- sign out

Upload screens should require an authenticated user before file selection or
upload begins.

Unauthenticated behavior
If there is no active session:
- show a sign-in action
- prevent upload attempts
- avoid creating local-only upload records that cannot be associated with a user

Security notes
- Trust auth.uid() in RLS, not owner_id passed from the client.
- Keep Supabase anon keys public but constrained by RLS.
- Never use the Supabase service role key in the browser.
- Validate ownership again in any server-side function or background job.
- Treat Google profile fields as display data, not authorization data.

Open decisions
- Whether Google OAuth is the only provider or just the first provider.
- Whether anonymous browsing is allowed outside the upload feature.
- Whether users can delete their account and associated uploads.
- Whether profile records are needed for display names and avatars.
- Whether organization/team ownership is needed later.

Initial implementation slice
1. Enable Google OAuth in Supabase Auth.
2. Add Supabase client configuration to the Vue app.
3. Build sign-in, sign-out, and session restore behavior.
4. Require an authenticated session before uploads.
5. Use auth.uid() as owner_id in database inserts.
6. Add RLS policies for compositions, composition_assets, and upload_events.
7. Add Storage policies for user-scoped file paths.
