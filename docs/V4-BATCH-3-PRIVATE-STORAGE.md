# SpokenFrame V4 — Batch 3 private storage

## Status

Batch 3 connects signed-in screenplay libraries to private Cloudflare R2 storage. It preserves the existing local-first parser, IndexedDB cache, player, and Supabase metadata tables.

## What is stored

For a signed-in user, R2 stores:

- the normalized screenplay structure required by the reader
- generated Premium Audio MP3 chunks

R2 does not store the original uploaded FDX, PDF, or Fountain file. Supabase continues to store only relational metadata, playback state, and preferences.

Guest screenplays remain local to the browser.

## Private object layout

```text
users/{verified-user-id}/screenplays/{owned-screenplay-id}/screenplay.json
users/{verified-user-id}/screenplays/{owned-screenplay-id}/audio/{cache-key}.mp3
```

The browser never supplies or chooses the user-ID portion. The Worker derives it from the validated Supabase session. Before every object operation, the Worker queries the owner-protected screenplay row using that same session.

The R2 bucket is named `spokenframe-private-media`, is bound to the Worker as `PRIVATE_MEDIA`, and must keep public access disabled.

## Cross-device restoration

1. The first device parses the file locally.
2. SpokenFrame writes library metadata to owner-protected Supabase tables.
3. The normalized screenplay is uploaded through the authenticated Worker to private R2.
4. A second signed-in device selects the library entry.
5. The Worker verifies the session and ownership, then returns the private screenplay JSON.
6. The browser saves it in IndexedDB and applies the latest playback/settings rows.

## Premium audio reuse

Local IndexedDB remains the first cache. On a local miss, signed-in playback requests an owner-scoped Worker route. The Worker checks R2 before calling ElevenLabs.

The deterministic key includes:

- provider
- model
- voice ID
- exact normalized speech text
- output format
- Read Character Names state
- normalization version

The Worker recomputes the key and rejects mismatches. A cache hit returns the existing private MP3 and does not call ElevenLabs. Changing one voice affects only chunks using that voice.

## Security properties

- R2 public access is disabled.
- Every private object route requires a Supabase bearer session.
- The Worker derives the user ID from Supabase rather than request JSON.
- Supabase Row Level Security independently verifies screenplay ownership.
- Browser responses use `no-store` even though the private R2 object persists.
- Request and object sizes are bounded.
- No service-role key, database password, ElevenLabs key, or R2 credential is present in GitHub.
- The Supabase publishable key and project URL are public client identifiers, not secrets.

## Batch 4 release gate

Batch 3 establishes identity, ownership, and private cache reuse. It does not prove payment.

Before Premium Audio can be offered publicly, Batch 4 must require a paid entitlement and remaining server-side generation allowance before any uncached ElevenLabs request. The legacy personal-beta generation route remains available only to preserve the working test application during the staged migration.

## Deployment configuration

`worker/wrangler.toml` declares:

- `PRIVATE_MEDIA` → `spokenframe-private-media`
- the public Supabase project URL
- the public Supabase publishable key

`ELEVENLABS_API_KEY` remains an encrypted Cloudflare secret. Never place it, a Supabase secret/service-role key, or a database password in Wrangler, GitHub, browser storage, or frontend JavaScript.
