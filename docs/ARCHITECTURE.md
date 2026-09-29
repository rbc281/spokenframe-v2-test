# SpokenFrame V4 architecture

## Data flow

```text
FDX / PDF / Fountain file
        ↓ browser only
Format parser adapter
        ↓
Normalized screenplay model
        ↓
Speech text + Cast + chunk map
        ↓
Premium provider → authenticated Worker → private R2 hit or ElevenLabs → MP3
       or
Standard provider → Web Speech API
        ↓
Player, synchronized text, resume, local cache

Optional account path:

Supabase Auth session
        ↓
Owner-scoped screenplay metadata + playback + preferences
        ↓
Private normalized screenplay + generated audio in R2
        ↓
Local screenplay/audio cache matched by deterministic identity
```

The player never branches by source format. Every parser returns:

```js
{
  schemaVersion: 2,
  title,
  format,
  source,
  units: [{ id, type, text, scene, speaker, characterId, displayCue }],
  scenes: [{ title, unitIndex }],
  characters: [{ id, name, displayCues }],
  confidence: { score, warnings, reviewRecommended }
}
```

Readable unit types are `scene`, `action`, `dialogue`, and `transition`. Character cues remain display context rather than standalone spoken units. Parentheticals are excluded.

## Parsers

- `fdx-parser.js` preserves the proven XML/DOM behavior and adapts it through `createScreenplay()`.
- `fountain-parser.js` recognizes title metadata, standard and forced screenplay elements, dialogue, and skipped parentheticals.
- `pdf-parser.js` uses repository-local PDF.js, removes page furniture, and applies screenplay-layout heuristics. Substantially suspicious imports receive a warning.
- `parser-registry.js` selects an adapter. Additional formats do not require player changes.

## Speech text and Cast

`speech-normalizer.js` operates on a copy, so displayed screenplay text is never changed. `playback-utils.js` adds an optional character name immediately before dialogue only when **Read character names** is enabled.

Cast ordering is deterministic: Narrator first, then characters by dialogue-block count descending, with first appearance as the tie-breaker. The count is workflow assistance, not a claim about story importance.

The same final speech string powers:

- Standard Audio
- Premium Audio requests
- deterministic usage accounting
- deterministic cache identity

This prevents estimates or cached results from drifting away from what is actually heard.

## Providers and media playback

The provider boundary remains independent:

- `ElevenLabsProvider` returns generated audio blobs through the Worker. Signed-in playback includes a short-lived Supabase access token, screenplay ID, and deterministic cache identity so the Worker can authorize and reuse a private R2 object.
- `BrowserTtsProvider` wraps the defensive Web Speech engine.
- `AudioPlayer` owns real `HTMLAudioElement` playback, rate, position, and media events.

The Worker defaults to `eleven_flash_v2_5`. Provider/model names remain implementation details and are not shown in the listening UI.

Premium failure never silently changes quality. Playback pauses, known error codes become safe human language, and the listener can retry or explicitly select Standard Audio.

Voice previews use separate playback ownership. Opening Cast pauses the screenplay. A new preview stops the old preview, closing Cast stops preview audio, and preview completion never resumes the screenplay.

## Chunking, prefetch, and cost controls

`audio-chunks.js` groups only adjacent units with the same role and scene, up to three units/700 characters. Scene headings remain separate. Each chunk retains normalized-model unit indexes for synchronized highlighting.

On Play, the current chunk is loaded from cache or generated. Only the next chunk is prefetched. Large navigation jumps abort pending requests. Identical in-flight requests are deduplicated.

The cache key includes:

- provider
- model
- voice ID
- exact normalized spoken text
- output format
- character-name preference
- speech-normalization version

Changing one voice rekeys only chunks assigned to that role. Replaying identical cached audio never calls TTS again.

## Cache boundary and cross-device storage

`audio-cache.js` keeps IndexedDB as the fast first-level cache. `PrivateCloudStorage` handles authenticated screenplay-object synchronization. The premium Worker route is cache-first: it checks the owner's private R2 audio key before calling the provider.

Audio blobs are never placed in localStorage or base64. IndexedDB keeps at most 250 entries/approximately 150 MB and prunes least-recently-used items. Known audio duration is stored as cache metadata and improves remaining-time estimates.

R2 keys are scoped as `users/{verified-user-id}/screenplays/{owned-screenplay-id}/...`. The Worker derives the user from a validated Supabase session and independently verifies the screenplay through owner-protected Postgres data. It never trusts a user ID from browser JSON.

Audio keys contain the same deterministic inputs used by the local cache. The Worker recomputes the identity and rejects a mismatch before TTS generation. A second device therefore receives an existing private audio object without a second provider request. R2 public access remains disabled.

## Progress and navigation

The progress display uses normalized spoken-unit position as a whole-number percentage. Remaining time uses actual known generated-audio duration where available, then a spoken-word heuristic for ungenerated chunks. Playback speed is applied to both.

Navigation has two scales:

- Previous/Next Scene uses parsed scene-heading indexes.
- Back/Forward 3 uses normalized spoken screenplay units.

Media Session maps track navigation to scenes and supported seek actions to three-passage jumps.

## Persistence and migration

The IndexedDB database retains V1's `scene-reader` name and existing stores. V1/V2 records receive safe defaults in memory and upgrade on their next save.

Per-screenplay state includes normalized content, unit/chunk position, generated-audio position, playback speed, Audio Quality, character-name preference, and Cast assignments. UI changes update in-memory state immediately and debounce IndexedDB writes.

Signed-in state is also mapped to three owner-scoped Supabase tables: `screenplays`, `playback_states`, and `screenplay_settings`. Row Level Security derives the caller from the authenticated JWT and rejects anonymous table access. The public browser client never receives a service-role key.

Postgres contains metadata, playback, and settings—not screenplay text or audio blobs. For signed-in libraries, the Worker stores normalized screenplay JSON and generated MP3 passages in private R2. The original uploaded file is not retained. A second device restores normalized content through the authenticated Worker, then applies the latest Postgres playback/settings rows.

## Worker security boundary

Routes:

- `GET /v1/status`
- `GET /v1/voices`
- `POST /v1/tts`
- `GET|POST /v1/screenplays/:id/content`
- `POST /v1/screenplays/:id/audio/:cacheKey`
- `GET /v1/screenplays/:id/entitlement`
- `POST /v1/screenplays/:id/checkout`
- `POST /v1/billing/webhook`

The Worker accepts explicit origins and validates method, content type, declared/actual request size, text length, voice-ID shape, Supabase session, screenplay ownership, and deterministic cache identity. Provider failures become stable public error codes. Browser responses use `no-store`; durable private objects are served only after owner authorization.

`ELEVENLABS_API_KEY` exists only as a Cloudflare secret. `ALLOWED_ORIGINS`, `ELEVENLABS_MODEL_ID`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY` are non-secret variables. The `PRIVATE_MEDIA` binding points to the private `spokenframe-private-media` bucket. The frontend receives only public endpoints/identifiers.

CORS is not authentication. The private routes require a bearer session and owner lookup. In enforced mode, uncached Premium generation also requires a paid screenplay entitlement and an atomic generation-allowance reservation. Stripe redirects are never treated as proof of payment; only a verified webhook creates an entitlement.

## Payments and entitlements

The browser displays the deterministic page-based price but never submits an amount. The Worker reads the owner-scoped screenplay page count, calculates the price again, and creates a one-time Stripe Checkout session. Premium belongs to one screenplay, not the whole account.

The webhook verifies Stripe's signature against the exact raw body, checks ownership and the authoritative price, records the payment idempotently, then creates the entitlement. Payment, entitlement, webhook, and generation-accounting writes use a Supabase server secret held only by Cloudflare. Browser roles can read only their own payment and entitlement rows.

## Deployment

- GitHub Pages serves the static repository root.
- Cloudflare deploys only `worker/`.
- `worker/wrangler.toml` declares the private R2 binding; the bucket itself has public access disabled.
- `js/config.js` contains the public Worker URL plus the public Supabase URL/publishable key.
- The allowlist uses the GitHub Pages origin (`https://rbc281.github.io`), not a repository path.

## Adding another provider

Implement `id`, `name`, `kind`, `isAvailable()`, `getVoices()`, and either `generateSpeech()` or `speak()/stop()`. Register it in orchestration and include its provider/model/settings in cache identity. No parser rewrite is required.
