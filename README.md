# SpokenFrame

**Your Screenplay. Read Aloud.**

SpokenFrame is an audiobook-style screenplay listener: import a screenplay, press Play, and follow the synchronized text while it is read aloud. It supports Final Draft (`.fdx`), text-based PDF, and Fountain.

V3 adds a sharper black, warm-white, and marker-yellow identity; lower-cost Premium Audio; screenplay-aware navigation; clearer progress and time remaining; optional character-name reading; safer previews; dialogue-volume Cast ordering; and stronger cost controls.

## Start here

- New to deployment? Follow the [Beginner Deployment Guide](docs/BEGINNER-DEPLOYMENT.md).
- For the system design, security boundary, caching, and developer workflow, read [Architecture](docs/ARCHITECTURE.md).
- After deployment, use the [Real-Device QA Checklist](docs/REAL-DEVICE-QA.md).

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

## Privacy and security

The screenplay is parsed in the browser. SpokenFrame does not send the whole file to the Worker. Premium playback sends only the small spoken passage currently needed and its selected voice ID.

The repository contains no ElevenLabs key. The key belongs only in the Cloudflare secret named `ELEVENLABS_API_KEY`.

The Worker validates origins, methods, content types, request size, text length, and voice-ID shape. It does not store screenplay text or generated audio. CORS is not authentication, so maintain a restricted ElevenLabs key/credit limit while this remains a personal beta.

V3 intentionally does **not** provide cross-device audio caching. There is no user login or secure ownership boundary yet, and a public shared cache could expose private screenplay audio. Playback now uses a small cache interface so an authenticated private R2 adapter can be added later without rewriting the player.

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
js/playback-utils.js       Cast sorting, speech text, credits, progress, navigation
js/audio-cache.js          Local cache interface and future remote-cache boundary
js/parsers/                Format adapters and normalized screenplay model
js/tts/                    Standard and premium provider adapters
js/audio-chunks.js         Cost-aware chunking and unit mapping
js/audio-player.js         HTML audio playback wrapper
js/speech-normalizer.js    Audio-only screenplay abbreviation rules
js/storage.js              Migration, screenplay state, audio blob cache
js/config.js               Public Worker URL only — never a secret
vendor/pdfjs/              Pinned local PDF.js distribution
worker/                     Cloudflare Worker proxy and tests/config
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

`npm test` covers the three import formats, normalization, chunking, Cast order, previews, navigation, character-name behavior, progress, credit estimates, cache identity/reuse, migration, resume, model selection, and Worker security/error mapping.

The browser suite requires Playwright Chromium:

```bash
npx playwright install chromium
```

## Known limitations

- PDF parsing is heuristic. Unusual layouts, protected PDFs, or broken font encodings may import imperfectly.
- Scanned PDFs require OCR and are rejected with a clear explanation.
- Premium previews and uncached playback consume credits. Cached identical audio is reused in the same browser.
- Media Session and lock-screen behavior varies by browser and operating system. Android Chrome is the main target; no static site can guarantee uninterrupted background playback on every device.
- A network connection is required for new Premium Audio. Cached chunks remain available in the same browser.
- The local audio cache is capped at roughly 150 MB or 250 items and evicts least-recently-used entries.
- Audio cache does not yet sync between devices because secure cross-device storage requires authenticated user ownership.

## License

SpokenFrame project code is provided under [MIT](LICENSE). Bundled PDF.js is covered by its included [Apache 2.0 license](vendor/pdfjs/LICENSE).
