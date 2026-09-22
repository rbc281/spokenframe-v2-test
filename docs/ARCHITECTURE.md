# SpokenFrame V3 architecture

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
Premium provider → Cloudflare Worker → ElevenLabs → MP3
       or
Standard provider → Web Speech API
        ↓
Player, synchronized text, resume, local cache
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
- Premium credit estimates
- deterministic cache identity

This prevents estimates or cached results from drifting away from what is actually heard.

## Providers and media playback

The provider boundary remains independent:

- `ElevenLabsProvider` returns generated audio blobs through the Worker.
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

## Cache boundary and cross-device status

`audio-cache.js` gives playback a small `get / put / delete / updateMetadata` interface. The current implementation delegates to IndexedDB through `LocalAudioCache`.

Audio blobs are never placed in localStorage or base64. IndexedDB keeps at most 250 entries/approximately 150 MB and prunes least-recently-used items. Known audio duration is stored as cache metadata and improves remaining-time estimates.

Secure cross-device caching is intentionally not implemented. SpokenFrame has no account, authenticated session, or ownership identifier. Origin checks are not authentication, and a predictable shared R2 key would risk exposing private screenplay audio.

A future implementation can add an authenticated private R2 adapter behind the existing cache interface. It must enforce server-side user ownership before returning audio. Parsers and playback do not need to change.

## Progress and navigation

The progress display uses normalized spoken-unit position as a whole-number percentage. Remaining time uses actual known generated-audio duration where available, then a spoken-word heuristic for ungenerated chunks. Playback speed is applied to both.

Navigation has two scales:

- Previous/Next Scene uses parsed scene-heading indexes.
- Back/Forward 3 uses normalized spoken screenplay units.

Media Session maps track navigation to scenes and supported seek actions to three-passage jumps.

## Persistence and migration

The IndexedDB database retains V1's `scene-reader` name and existing stores. V1/V2 records receive safe defaults in memory and upgrade on their next save.

Per-screenplay state includes normalized content, unit/chunk position, generated-audio position, playback speed, Audio Quality, character-name preference, and Cast assignments. UI changes update in-memory state immediately and debounce IndexedDB writes.

## Worker security boundary

Routes:

- `GET /v1/status`
- `GET /v1/voices`
- `POST /v1/tts`

The Worker accepts explicit origins and validates method, content type, declared/actual request size, text length, and voice-ID shape. Provider failures become stable public error codes. Generated audio uses `no-store`; the Worker writes to no database or bucket.

`ELEVENLABS_API_KEY` exists only as a Cloudflare secret. `ALLOWED_ORIGINS` and `ELEVENLABS_MODEL_ID` are non-secret variables. The frontend receives only the public Worker URL.

CORS is not authentication. A public version should add authentication, usage allowances, server-side accounting, and an actual rate-limit binding before a remote cache.

## Deployment

- GitHub Pages serves the static repository root.
- Cloudflare deploys only `worker/`.
- `js/config.js` contains the public Worker URL.
- The allowlist uses the GitHub Pages origin (`https://rbc281.github.io`), not a repository path.

## Adding another provider

Implement `id`, `name`, `kind`, `isAvailable()`, `getVoices()`, and either `generateSpeech()` or `speak()/stop()`. Register it in orchestration and include its provider/model/settings in cache identity. No parser rewrite is required.
