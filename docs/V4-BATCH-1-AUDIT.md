# SpokenFrame V4 public beta — Batch 1 audit

Status: architecture checkpoint only. The deployed V3 listening experience remains unchanged.

## Executive decision

Keep the current static frontend, parser adapters, normalized screenplay model, playback UI, provider boundary, and Cloudflare Worker. Add public-beta services around those boundaries instead of rewriting them.

Recommended stack:

| Responsibility | Service | Reason |
|---|---|---|
| Authentication and relational data | Supabase Auth + Postgres | Managed identity, password recovery, row-level security, and a free beta tier |
| Private screenplay and audio objects | Cloudflare R2 | Private object storage beside the existing Worker with no public bucket URLs |
| Server API and authorization | Existing Cloudflare Worker | Already owns the TTS secret and is the correct place for entitlement, cache, and usage checks |
| One-time payments | Stripe Checkout + verified webhooks | Hosted payment UI and server-verifiable one-time purchases |
| Premium speech | ElevenLabs Flash v2.5 | Preserves the working provider abstraction and current lower-cost model |
| Static application | Existing GitHub Pages site | No framework or hosting migration is required |

Do not publicize Premium Audio until server-side authentication and entitlement checks are live. The current origin allowlist protects the secret from the browser, but it is not user authentication; any visitor using the allowed site can currently request generation.

## What exists now

### Frontend and normalized screenplay model

- Static HTML, CSS, and JavaScript with no framework or build step.
- FDX, PDF, and Fountain parser adapters all return schema version 2 of the same normalized model.
- The normalized model contains title, format, source metadata, spoken units, scenes, characters, and import confidence.
- The player is format-agnostic. Parentheticals and page furniture are excluded before playback.
- PDF imports retain an exact extracted `source.pageCount`. FDX and Fountain do not currently retain a trustworthy rendered page count.

### Playback and Cast

- Premium playback uses a real `HTMLAudioElement` through `AudioPlayer`.
- Standard playback uses the Web Speech API.
- The UI maintains screenplay unit, audio chunk, within-chunk position, speed, provider, Cast, and character-name preferences.
- Premium chunks remain mapped to normalized screenplay units for highlighting and navigation.
- Media Session metadata and play/pause, scene, and passage actions are registered where supported.

### Persistence and cache

- IndexedDB database `scene-reader`, schema version 2.
- `screenplays` stores the normalized screenplay and per-screenplay preferences.
- `audio-cache` stores generated MP3 blobs and metadata, capped at approximately 150 MB or 250 entries.
- `localStorage` stores only the last screenplay ID.
- `AudioCache` already provides a small cache boundary with in-flight request deduplication. This is the correct seam for a later authenticated cloud cache.
- Existing V1/V2 records are migrated defensively in memory and upgraded on save.

### Worker and premium generation

- Public endpoints: `GET /v1/status`, `GET /v1/voices`, and `POST /v1/tts`.
- The Worker validates allowed origins, methods, content type, body size, text length, and voice-ID shape.
- The ElevenLabs key remains a Cloudflare secret and never reaches the browser.
- The Worker sends only the requested spoken passage to ElevenLabs and does not persist it.
- Flash v2.5 is the default production model.
- Premium generation is not authenticated and has no screenplay entitlement check, ownership check, or durable per-screenplay allowance yet.

### Deployment and PWA status

- GitHub Pages serves the repository root from the existing `main` branch deployment.
- Cloudflare deploys `worker/`; the deployed Worker name and the Wrangler `name` differ, but this does not affect the working endpoint or runtime behavior.
- There is no web app manifest, service worker, install prompt, or offline app shell today. SpokenFrame is not currently an installable PWA.

## What should remain

- All three parsers and the normalized schema boundary.
- Local-first parsing and authentic displayed screenplay text.
- Synchronized highlighting, Cast workflow, navigation, progress, speed, and resume behavior.
- Provider-independent speech orchestration.
- Flash v2.5, conservative next-chunk prefetch, deterministic cache keys, and in-flight deduplication.
- The existing Worker as the only holder of provider and future Stripe/Supabase server secrets.
- IndexedDB as a fast device cache even after cloud sync exists.
- GitHub Pages and the current public URL.

## What must change in later batches

1. Add Supabase sessions without blocking guest playback.
2. Separate temporary guest state from account-owned cloud state.
3. Add owner-scoped screenplay metadata, settings, and playback records.
4. Store private normalized screenplay objects and generated MP3 chunks in R2 through the Worker.
5. Require a valid user session, screenplay ownership, and paid entitlement before every premium generation request.
6. Verify Stripe webhooks server-side before granting entitlement.
7. Add per-screenplay generation accounting and a bounded regeneration allowance.
8. Add a manifest/service worker only after the authenticated data flows are stable.
9. Rework premium chunk handoff so background continuity is not dependent on a suspended page event loop.

## Public-beta data boundaries

### Guest

Guest parsing and Standard playback stay in the browser. New public-beta guest sessions should not create account records. V3 local records must not be deleted during rollout; after account launch, an existing local screenplay can be offered for explicit import into the new account library.

### Account owner

Supabase owns identity and relational metadata. R2 owns private screenplay/audio objects. A browser session sends its short-lived Supabase access token to the Worker. The Worker verifies the token and derives the user ID; it never trusts a user ID supplied in request JSON.

### Premium request authorization

The required Worker order is:

1. Verify the signed user session.
2. Load the screenplay and confirm ownership.
3. Confirm an active Premium entitlement for that screenplay.
4. Validate the requested cache identity and generation allowance.
5. Return an owner-authorized R2 cache hit when available.
6. Call ElevenLabs only for a valid cache miss.
7. Store the audio privately and atomically record usage.

Origin validation remains useful defense-in-depth, but never substitutes for these checks.

## Page-count and pricing preparation

PDF provides an exact document page count. FDX and Fountain are reflowable source formats, so browser parsing cannot claim an exact Final Draft-rendered page count without reproducing the originating application's pagination.

For deterministic public pricing:

- Use extracted document pages for PDF.
- Use a versioned standard screenplay pagination estimate for FDX and Fountain, based on structural line weights and standard line wrapping.
- Store both `page_count` and `page_count_method` (`pdf-exact` or `screenplay-estimate-v1`).
- Label non-PDF counts as approximate in the purchase review.
- Calculate price on the server from the stored count; never accept a price sent by the browser.

This avoids format-specific pricing surprises while keeping the rule testable and auditable.

## Android lock-screen audit

### Observed symptom explained by the current code

The premium player keeps one `HTMLAudioElement` object, but each screenplay chunk is a separate Blob URL. At the end of every chunk:

1. the media element emits `ended`;
2. page JavaScript runs `advanceAfterEnd()`;
3. page JavaScript reads IndexedDB or requests the next blob;
4. `AudioPlayer.load()` pauses the element, replaces `src`, waits for `canplay`, and calls `play()`.

Android may suspend page JavaScript after screen lock. If suspension occurs at a chunk boundary, the next `src` is never attached and playback stops. Prefetch makes the next Blob available but does not queue it in the media pipeline, so it cannot solve a suspended handoff by itself.

The stale pause icon has a separate, confirmed cause: UI state is driven by `state.isPlaying`, but `AudioPlayer`'s native `play` and `pause` events are not connected to that state. An operating-system pause or failed background handoff can therefore leave the UI showing “Pause” while the actual element is paused or ended.

### Additional findings

- There is no visibility-change pause, which is correct.
- Media Session playback state is set from app intent rather than reconciled from the media element.
- Media Session position represents the current chunk, not the whole screenplay.
- Standard Audio relies on Web Speech and cannot be expected to provide reliable lock-screen continuation.
- There is no PWA manifest/service worker, so installed-PWA behavior has not yet been tested.

### Batch 6 fix path

First preserve a persistent media owner and make native media events authoritative for UI state. Then remove foreground-only work from the boundary between already-buffered chunks. Candidate implementations should be tested on real Android hardware:

1. prepare a playable next source before the current chunk ends and perform the smallest possible native-event handoff;
2. consider a rolling combined audio buffer or Media Source strategy if Blob URL swaps still fail under lock;
3. add PWA installability and repeat screen-lock/app-switch testing;
4. if the web platform still cannot maintain continuity, wrap the existing web app with Capacitor and add native background media without rewriting parsers or UI.

The present evidence supports a strong root-cause hypothesis, but only a physical Android lock test can prove the final remedy.

## Risks and release gates

| Risk | Required gate |
|---|---|
| Anonymous visitors can spend TTS money | Do not launch public Premium before Worker auth + entitlement enforcement |
| Private screenplay or audio exposure | No public R2 bucket; owner verification on every Worker object request |
| Frontend fakes a paid state | Only a verified Stripe webhook creates an entitlement |
| Duplicate generation | Cache-first lookup plus one server-side lock/idempotency key per cache identity |
| Unlimited recasting liability | Server-side allowance based on the initial spoken-character estimate |
| Existing local data loss | Versioned additive migration; never clear V3 stores automatically |
| Incorrect page-based price | Store count method and calculate price server-side from a deterministic versioned rule |
| Background playback claims exceed reality | Real-device acceptance test before marketing the feature |

## External services, by future batch

No external setup is required for Batch 1.

- Batch 2: one Supabase project for Auth and Postgres.
- Batch 3: one private Cloudflare R2 bucket.
- Batch 4: one Stripe account in test mode, then a Checkout webhook secret stored only in Cloudflare.
- Before inviting a larger beta: a production email delivery configuration for reliable account messages may be needed, depending on Supabase's current beta limits.

Each service should be configured only when its batch begins so Roger receives one short dashboard task at a time.
