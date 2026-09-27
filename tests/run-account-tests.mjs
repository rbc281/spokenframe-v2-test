import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseFdx } from "../js/fdx-parser.js";
import {
  applyCloudPreferences,
  playbackStateRow,
  screenplayLibraryRow,
  screenplaySettingsRow,
  spokenCharacterCount
} from "../js/account/library-model.js";
import { DOMParser } from "@xmldom/xmldom";

globalThis.DOMParser = DOMParser;

const source = await fs.readFile(new URL("./fixtures/representative.fdx", import.meta.url), "utf8");
const script = parseFdx(source, "PASSENGER");
const record = {
  id: "0123456789abcdef0123456789abcdef",
  script,
  preferences: {
    currentIndex: 7,
    chunkIndex: 5,
    chunkPosition: 4.25,
    rate: 1.5,
    provider: "elevenlabs",
    readCharacterNames: true,
    voiceAssignments: { NARRATOR: { provider: "elevenlabs", voiceId: "voice-one" } }
  }
};
const owner = "11111111-1111-4111-8111-111111111111";
const screenplayId = "22222222-2222-4222-8222-222222222222";

const metadata = screenplayLibraryRow(record, owner);
assert.equal(metadata.owner_user_id, owner);
assert.equal(metadata.client_fingerprint, record.id);
assert.equal(metadata.source_format, "fdx");
assert.equal(metadata.page_count, null);
assert.equal(metadata.spoken_character_count, spokenCharacterCount(script));
assert.equal("script" in metadata, false, "Library metadata must not upload screenplay content");
console.log("✓ maps local screenplays to metadata without uploading content");

const playback = playbackStateRow(record, owner, screenplayId);
assert.equal(playback.current_unit, 7);
assert.equal(playback.current_chunk, 5);
assert.equal(playback.chunk_position_seconds, 4.25);
assert.equal(playback.playback_speed, 1.5);
assert.equal(playback.current_scene, "INT. TRAFFIC OPERATIONS CENTER - LATER");
console.log("✓ maps playback position to an owner-scoped cloud record");

const settings = screenplaySettingsRow(record, owner, screenplayId);
assert.equal(settings.audio_quality, "premium");
assert.equal(settings.read_character_names, true);
assert.notEqual(settings.cast_assignments, record.preferences.voiceAssignments);
console.log("✓ maps audio preferences without sharing mutable local objects");

const restored = applyCloudPreferences(
  { ...record, preferences: { rate: 1 } },
  { current_unit: 999, current_chunk: 3, chunk_position_seconds: 2, playback_speed: 9 },
  { audio_quality: "standard", read_character_names: false, cast_assignments: { EVAN: { voiceId: "local-one" } } }
);
assert.equal(restored.preferences.currentIndex, script.units.length - 1);
assert.equal(restored.preferences.rate, 2);
assert.equal(restored.preferences.provider, "browser");
assert.equal(record.preferences.rate, 1.5, "Cloud merge mutated the source record");
console.log("✓ restores cloud preferences defensively without mutating local data");

const migration = await fs.readFile(new URL("../supabase/migrations/202609270001_v4_accounts_library.sql", import.meta.url), "utf8");
for (const table of ["screenplays", "playback_states", "screenplay_settings"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  assert.match(migration, new RegExp(`revoke all on public\\.${table} from anon`, "i"));
}
assert.match(migration, /auth\.uid\(\)/i);
assert.doesNotMatch(migration, /sb_secret_|service_role\s*=|password\s*=/i);
console.log("✓ database migration enables owner policies and contains no credentials");
