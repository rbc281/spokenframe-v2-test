# SpokenFrame V4 — Batch 2 accounts and library

## Status

Batch 2 connects the existing static application to Supabase Auth and an owner-scoped Postgres library. Guest import and playback remain available without an account.

The browser uses only the Supabase project URL and publishable key. Both are public identifiers. No Supabase secret key, service-role key, database password, Cloudflare secret, or ElevenLabs key is present in the frontend.

## Account experience

- Email/password create-account, confirmation, sign-in, password recovery, password update, and sign-out flows
- Persistent Supabase sessions with automatic token refresh
- Guest listening remains the default and never requires account setup
- Signed-in landing page shows the user's library and listening progress
- Existing locally saved V3 screenplays can be linked to an account without deleting or rewriting them
- Account and library failures use short customer-safe messages

## Cloud data boundary

Supabase stores only:

- screenplay ID/fingerprint, title, source format, page-count metadata, and spoken-character estimate
- playback unit/chunk position, progress, speed, and current scene
- Audio Quality, Read Character Names, and Cast voice assignments

Raw screenplay files and normalized screenplay text are **not** uploaded to Supabase in Batch 2. They remain in the existing IndexedDB record on the device that imported them.

This means a second signed-in device can see library metadata, but the user must re-upload the screenplay on that device until Batch 3 adds authenticated private object storage. After re-upload, the deterministic fingerprint reconnects the local file to the cloud playback state.

## Authorization

Every library table:

- references `auth.users`
- has Row Level Security enabled
- allows authenticated owners to access only rows with their own user ID
- revokes anonymous table access
- cascades account deletion through owned metadata

The frontend never accepts a manually supplied owner ID. The repository adapter derives it from the current authenticated session, while Postgres policies independently enforce the same ownership boundary.

## Files

- `supabase/migrations/202609270001_v4_accounts_library.sql` — schema, constraints, grants, and owner policies
- `js/account/account-session.js` — session and account operations
- `js/account/library-model.js` — local-to-cloud data mapper
- `js/account/library-repository.js` — authenticated Postgres operations
- `js/account/supabase-client.js` — public browser-client configuration boundary
- `vendor/supabase/` — pinned browser SDK and license

## Email delivery release gate

The built-in Supabase email service is suitable only for project-team testing. Before inviting public beta users, configure a custom SMTP provider in Supabase. Until then, confirmation and recovery emails can be refused for addresses that are not members of the Supabase organization.

Do not disable email confirmation merely to bypass this release gate. Configure reliable transactional email before public invitations.
