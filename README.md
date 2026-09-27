# SpokenFrame

**Your Screenplay. Read Aloud.**

SpokenFrame is an audiobook-style screenplay listener: import a screenplay, press Play, and follow the synchronized text while it is read aloud. It supports Final Draft (`.fdx`), text-based PDF, and Fountain.

V4 Batch 3 adds private cross-device screenplay and premium-audio storage without changing the proven V3 screenplay player. The Stripe-independent Batch 4 payment foundation is also prepared, but checkout remains intentionally inactive until sandbox setup is complete.

## Start here

- New to deployment? Follow the [Beginner Deployment Guide](docs/BEGINNER-DEPLOYMENT.md).
- For the system design, security boundary, caching, and developer workflow, read [Architecture](docs/ARCHITECTURE.md).
- For the committed V4 public-beta plan and Android lock-screen audit, read [V4 Batch 1 Audit](docs/V4-BATCH-1-AUDIT.md).
- For the account, library, privacy boundary, and email release gate, read [V4 Batch 2 Accounts](docs/V4-BATCH-2-ACCOUNTS.md).
- For private screenplay storage, cross-device audio reuse, and R2 security, read [V4 Batch 3 Private Storage](docs/V4-BATCH-3-PRIVATE-STORAGE.md).
- For the staged payment, entitlement, and spending-control foundation, read [V4 Batch 4 Payment Preparation](docs/V4-BATCH-4-PAYMENTS-PREP.md).
- To recreate the account backend safely, follow [Supabase Setup](docs/V4-SUPABASE-SETUP.md).
- After deployment, use the [Real-Device QA Checklist](docs/REAL-DEVICE-QA.md).

## V4 public-beta checkpoint

Batch 1's architecture audit, Batch 2's account/library foundation, and Batch 3's private storage layer are complete. Batch 4 now has deterministic pricing, server-owned payment/entitlement tables, verified-webhook plumbing, and generation guardrails prepared behind an inactive release switch. Guest playback remains immediate and free. Signed-in users can save screenplay content, position, speed, preferences, and generated premium passages to an owner-scoped private library.

The original uploaded file is not retained in the cloud. SpokenFrame stores the normalized screenplay structure needed to reconstruct the reader and stores generated audio under private user/screenplay paths. Checkout is not live yet. Premium must remain a personal beta until the Stripe sandbox is connected, the Batch 4 migration is applied, and end-to-end payment tests pass before entitlement enforcement is enabled.

## What V3 does

- Imports Final Draft, Fountain, and normal text-based screenplay PDFs locally
- Uses one normalized screenplay model for every format
- Reads scene headings, action, dialogue, and transitions while skipping parentheticals and page furniture
- Keeps displayed text authentic while expanding `INT.`, `EXT.`, and `INT./EXT.` only for speech
- Starts immediately with one consistent voice; Cast customization remains optional
- Sorts Cast with Narrator first, then characters by spoken dialogue-block count
- Offers **Premium Audio** and free **Standard Audio** without exposing provider/model language in the player
- Uses Eleven Flash v2.5 for faster generation and approximately half-credit-per-character API usage
- Shows an estimate based only on the exact text that would be sent for Premium Audio
- Generates the current premium chunk and conservatively prepares only the next chunk
- Deduplicates in-flight requests and reuses deterministic IndexedDB audio blobs
- Provides Previous/Next Scene plus Back/Forward 3 spoken passages
- Shows progress as percentage and speed-aware estimated time remaining
- Optionally reads character names, off by default
- Auto-saves position, speed, Cast, Audio Quality, and character-name preference
- Uses real media playback and Media Session metadata for supported lock-screen controls
- Migrates existing V1/V2 screenplay records without deleting them
- Offers optional email/password accounts while preserving account-free guest playback
- Saves signed-in library metadata, playback position, speed, and preferences with owner-only database policies
- Restores a signed-in screenplay on another device from a private normalized R2 copy
- Reuses identical premium passages across the owner's devices without a second TTS request

## Privacy and security

The screenplay is parsed in the browser. Guest files remain local. For signed-in libraries, SpokenFrame sends the normalized screenplay structure—not the original uploaded file—to private R2 storage so another authenticated device can restore it. Premium generation sends only the small spoken passage currently needed and its selected voice ID.

The repository contains no ElevenLabs key. The key belongs only in the Cloudflare secret named `ELEVENLABS_API_KEY`.

The Worker validates origins, authenticated Supabase sessions, screenplay ownership, methods, content types, request sizes, deterministic audio identities, text length, and voice-ID shape. Private screenplay and generated-audio objects use owner-scoped R2 paths and are never exposed through public bucket URLs. CORS remains defense-in-depth, not authentication.

The legacy personal-beta TTS route remains available until Batch 4 adds payment entitlements. Do not invite public Premium users before Batch 4: it will require an authenticated owner, paid screenplay entitlement, and server-side generation allowance before every uncached TTS request.

## Supported files

| Format | Support | Notes |
|---|---|---|
| Final Draft `.fdx` | Preferred | Most reliable scene, character, dialogue, and structural detection |
| Fountain `.fountain` / `.spmd` | High confidence | Native parser supports standard and forced elements |
| Text-based `.pdf` | Heuristic | Bundled PDF.js; suspicious structures show a review warning |
| Scanned/image-only PDF | Not supported | OCR remains intentionally out of scope |

## Project structure

```text
index.html                  SpokenFrame interface
styles.css                 Responsive V3 visual system
assets/                    Compact app mark and favicon
js/app.js                  Playback, Cast, previews, Media Session, persistence
js/account/                Connected V4 session, Supabase client, and private library adapters
js/billing/                Deterministic screenplay page-count estimation
shared/                    Pricing policy shared by the frontend and Worker
js/playback-utils.js       Cast sorting, speech text, credits, progress, navigation
js/audio-cache.js          Fast local IndexedDB cache and in-flight deduplication
js/parsers/                Format adapters and normalized screenplay model
js/tts/                    Standard and premium provider adapters
js/audio-chunks.js         Cost-aware chunking and unit mapping
js/audio-player.js         HTML audio playback wrapper
js/speech-normalizer.js    Audio-only screenplay abbreviation rules
js/storage.js              Migration, screenplay state, audio blob cache
js/config.js               Public Worker/Supabase identifiers only — never a secret
vendor/supabase/           Pinned Supabase browser SDK and license
vendor/pdfjs/              Pinned local PDF.js distribution
worker/                     Cloudflare Worker proxy and tests/config
supabase/migrations/        Versioned V4 account/database migrations
tests/                      Parser, player, cache, migration, UI, and Worker tests
docs/                       Deployment, architecture, and phone QA
```

## Run locally

You need a recent Node.js version for tests. The deployed site itself is static.

```bash
npm install
npm start
```

Open `http://localhost:8080`. Do not double-click `index.html`; browsers can block modules and PDF worker files opened directly from disk.

## Tests

```bash
npm test
npm run test:browser
```

`npm test` covers the three import formats, normalization, chunking, Cast order, previews, navigation, character-name behavior, progress, local/cloud cache identity and reuse, migration, account mapping/session behavior, ownership isolation, public-client configuration, model selection, and Worker security/error mapping.

The browser suite requires Playwright Chromium:

```bash
npx playwright install chromium
```

## Known limitations

- PDF parsing is heuristic. Unusual layouts, protected PDFs, or broken font encodings may import imperfectly.
- Scanned PDFs require OCR and are rejected with a clear explanation.
- Premium previews and uncached playback consume provider usage. Signed-in playback reuses identical audio from private R2 across devices; guest/preview audio remains device-local.
- Media Session and lock-screen behavior varies by browser and operating system. Android Chrome is the main target; no static site can guarantee uninterrupted background playback on every device.
- A network connection is required for new Premium Audio. Cached chunks remain available in the same browser.
- The local audio cache is capped at roughly 150 MB or 250 items and evicts least-recently-used entries.
- Cloud restoration requires a network connection and a valid signed-in session. Local IndexedDB remains the fast first-level cache.
- Batch 4 payment plumbing is staged but not active. Until Stripe sandbox verification is complete and the entitlement switch is deliberately enabled, Premium remains a controlled personal beta rather than a public service.
- Supabase's built-in email sender is restricted to project-team testing. Custom SMTP is required before inviting public beta users.

## License

SpokenFrame project code is provided under [MIT](LICENSE). Bundled PDF.js and Supabase SDK licenses are included beside their vendor files.
