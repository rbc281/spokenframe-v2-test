# SpokenFrame V2 architecture

## Data flow

```text
FDX / PDF / Fountain file
        ↓ browser only
Format parser adapter
        ↓
Normalized screenplay model
        ↓
Audio chunk map + Cast assignments
        ↓
Premium provider → Cloudflare Worker → ElevenLabs → MP3
       or
Device provider → Web Speech API
        ↓
Player, synchronized text, resume, local cache
```

The player never branches by source format. Every parser returns the same model:

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

Readable unit types are `scene`, `action`, `dialogue`, and `transition`. Character cues are display context for dialogue rather than separate spoken units. Parentheticals are intentionally excluded.

## Parsers

- `fdx-parser.js` preserves the proven XML/DOM parsing behavior from V1 and adapts its result through `createScreenplay()`.
- `fountain-parser.js` recognizes title-page metadata, standard and forced scene/action/character/transition syntax, dialogue, and skipped parentheticals.
- `pdf-parser.js` uses a pinned, repository-local PDF.js build. It groups positioned text into lines, removes page numbers and repeated page furniture, then uses screenplay-layout heuristics. Confidence checks warn only when structure is substantially suspicious.
- `parser-registry.js` chooses an adapter from the file extension. New formats can be added without touching playback.

## Speech and audio

`speech-normalizer.js` receives a copy of displayed text and applies audio-only rules. The underlying screenplay model is never changed.

`audio-chunks.js` groups only adjacent units with the same role and scene, up to three units/700 characters. Scene headings remain separate. Each chunk retains its exact normalized-model unit indexes, so the reader can highlight every passage represented by the playing audio.

The TTS boundary is provider-independent:

- `ElevenLabsProvider`: returns generated audio blobs through the Worker.
- `BrowserTtsProvider`: wraps V1's defensive Web Speech engine.
- `AudioPlayer`: owns real `HTMLAudioElement` playback, rate, position, and media events.

Premium is preferred when configured and reachable. Fallback is never silent: a failed premium request pauses playback and asks the user whether to retry or use a device voice.

## Generate-as-you-listen and cost controls

On Play, the current chunk is loaded from IndexedDB or generated. Playback begins as soon as that chunk is ready. Only the next two chunks are prepared. A large navigation jump aborts pending generation. Identical in-flight requests are deduplicated.

The deterministic cache key includes provider, model, voice ID, normalized audio text, output format, and a cache-schema version. Changing a role's voice naturally creates a different key only for that role's affected chunks.

Generated audio is stored as Blob data in IndexedDB, never base64 in localStorage. The cache keeps at most 250 entries/approximately 150 MB and prunes least-recently-used entries.

## Persistence and V1 migration

The IndexedDB database deliberately keeps V1's `scene-reader` name and `screenplays` store. Database version 2 adds the `audio-cache` object store. Loaded V1 records receive safe V2 defaults in memory and are upgraded on their next save. Existing screenplay content, index, speed, and device voice IDs are retained.

Per-screenplay state includes source identity, normalized screenplay, current unit, current premium-chunk time, rate, provider, and Cast assignments.

## Background playback

Premium playback is based on a real HTML audio element, not a speech-synthesis queue. The app does not pause audio when the document becomes hidden. Media Session supplies screenplay title, current speaker/scene, artwork, play/pause, and previous/next handlers when the browser supports them.

This architecture gives Android Chrome the best available web background behavior, but mobile operating systems retain control over tab suspension. See the device checklist for honest verification steps.

## Worker security boundary

The Worker is an ES-module Worker with three routes:

- `GET /v1/status`
- `GET /v1/voices`
- `POST /v1/tts`

It accepts only explicitly allowed origins and validates method, JSON content type, declared and actual request size, text length (maximum 1,200 characters), and voice-ID format. ElevenLabs failures are converted to plain, stable public errors. Responses use `no-store` for generated audio, and the Worker does not write to KV, D1, R2, logs, or any screenplay store.

`ELEVENLABS_API_KEY` is read only from Cloudflare's secret binding. `ALLOWED_ORIGINS` and `ELEVENLABS_MODEL_ID` are non-secret variables. The frontend sees only the Worker URL.

CORS is not authentication. For a future public product, put authentication/allowances in front of `/v1/tts`, then add server-side usage accounting and a real rate-limiting binding. No parser or player rewrite is needed for that change.

## Deployment topology

- GitHub Pages serves the static root.
- Cloudflare deploys only `worker/` as `spokenframe-tts`.
- `js/config.js` points the static site to the public `workers.dev` URL.
- `worker/wrangler.toml` allows the GitHub Pages origin, not an individual repository path, because a browser origin is scheme + host + port.

## Adding another provider

Implement `id`, `name`, `kind`, `isAvailable()`, `getVoices()`, and either `generateSpeech()` for media or `speak()/stop()` for a device engine. Register it in the orchestration layer, then include its provider/model/settings in cache identity. Parser, normalized model, and synchronized reader code do not need to change.
