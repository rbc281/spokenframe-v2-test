# SpokenFrame

**Your Screenplay. Read Aloud.**

SpokenFrame is a focused screenplay listener: import a screenplay, press Play, and follow the synchronized text while the screenplay is read aloud. It supports Final Draft (`.fdx`), text-based PDF, and Fountain files.

V2 adds premium ElevenLabs audio through a secure Cloudflare Worker while preserving free device voices as an explicit fallback. The ElevenLabs key is never placed in the website or sent to the browser.

## Start here

- If you are deploying this yourself and do not code, follow [Beginner Deployment Guide](docs/BEGINNER-DEPLOYMENT.md).
- For the system design, security boundaries, parsers, caching, and developer workflow, read [Architecture](docs/ARCHITECTURE.md).
- Before replacing your current live version, use the [Real-Device QA Checklist](docs/REAL-DEVICE-QA.md).

## What V2 does

- Imports Final Draft, Fountain, and normal text-based screenplay PDFs locally in the browser
- Uses one normalized screenplay model for every format
- Reads scene headings, action, dialogue, and transitions; parentheticals and page furniture are skipped
- Keeps displayed screenplay text authentic while expanding `INT.`, `EXT.`, and `INT./EXT.` only for speech
- Starts every role on one consistent default voice
- Provides a simple **Cast** panel for manual voice changes, previews, and opt-in **Auto Assign Voices**
- Generates only the current premium-audio chunk, then prepares the next two
- Caches generated MP3 blobs in IndexedDB so identical audio can be replayed without another generation request
- Preserves synchronized text highlighting, playback speed, scene navigation, Previous/Next, and resume position
- Uses real browser media playback and Media Session metadata for supported lock-screen controls
- Migrates existing V1 screenplay records without deleting them

## Privacy and security in plain English

The selected screenplay is parsed in your browser. SpokenFrame does not send the whole file to the Worker. When premium playback is used, only the text of the small passage currently needed for audio, plus its selected voice ID, is sent through your Worker to ElevenLabs.

The public GitHub repository contains no ElevenLabs key. The key belongs only in the Cloudflare secret named `ELEVENLABS_API_KEY`.

The Worker validates origins, methods, content types, body size, text length, and voice-ID shape. It does not store screenplay text or generated audio. CORS/origin checks are useful browser restrictions, but they are **not authentication**. Keep the restricted credit limit on your ElevenLabs key while this remains a personal beta. The Worker code includes an optional Cloudflare rate-limiter hook for a later public release.

## Supported files

| Format | Support | Notes |
|---|---|---|
| Final Draft `.fdx` | Preferred | Most reliable scene, character, dialogue, and structural detection |
| Fountain `.fountain` / `.spmd` | High confidence | Native parser; supports standard and forced elements |
| Text-based `.pdf` | Heuristic | Uses bundled PDF.js; suspicious structures show a review warning |
| Scanned/image-only PDF | Not supported | OCR is intentionally outside V2 |

## Project structure

```text
index.html                  SpokenFrame interface
styles.css                 Responsive dark/gold visual system
assets/                    Product icon
js/app.js                  UI, playback orchestration, Cast, Media Session
js/parsers/                Format adapters and normalized screenplay model
js/tts/                    Browser and ElevenLabs provider adapters
js/audio-chunks.js         Cost-aware chunking and unit mapping
js/audio-player.js         HTML audio playback wrapper
js/speech-normalizer.js    Audio-only screenplay abbreviation rules
js/storage.js              V1 migration, screenplay state, audio blob cache
js/config.js               Public Worker URL only — never a secret
vendor/pdfjs/               Pinned PDF.js distribution used locally
worker/                     Cloudflare Worker proxy and its tests/config
tests/                      Parser, player, cache, migration, and fixture tests
docs/                       Beginner deployment, architecture, phone QA
```

## Run locally

You need a recent version of Node.js only for development and tests. The website itself is static.

```bash
npm install
npm start
```

Open `http://localhost:8080`. Do not double-click `index.html`; browser security rules can block module and PDF worker files when opened directly from disk.

Premium audio will remain unavailable locally until `js/config.js` contains your deployed public Worker URL and the Worker allows `http://localhost:8080`.

## Tests

```bash
npm test
npm run test:browser
```

`npm test` covers FDX, Fountain, PDF heuristics, real PDF.js extraction, scanned PDFs, normalization, chunk mapping, V1 storage migration, audio caching, Cast behavior, resume, and Worker validation/error mapping.

The browser-layout suite needs a Playwright Chromium binary. Install it once with:

```bash
npx playwright install chromium
```

## Known limitations

- PDF parsing is heuristic. Unusual layouts, two-column scripts, protected PDFs, or broken font encodings may import imperfectly.
- Scanned PDFs need OCR and are rejected with a clear message.
- Premium generation costs ElevenLabs credits. Previewing a new premium voice also generates a short paid sample; cached previews are reused.
- Media Session and lock-screen controls have uneven browser/OS support. Android Chrome is the primary background-playback target. iOS Safari may suspend or reclaim a browser tab, especially under memory pressure, and no static website can guarantee uninterrupted lock-screen playback on every device.
- A network connection is required for new premium chunks. Cached chunks remain locally available in the same browser.
- The local audio cache is capped at roughly 150 MB or 250 items and evicts the least recently used entries.
- V2 has no user authentication. The origin allowlist reduces casual browser misuse but cannot protect a discovered endpoint like a login would. Maintain a restricted ElevenLabs key/credit limit for the personal beta.

## License

SpokenFrame project code is provided under [MIT](LICENSE). The bundled PDF.js distribution is covered by its included [Apache 2.0 license](vendor/pdfjs/LICENSE).
