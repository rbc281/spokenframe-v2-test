import { buildAudioChunks } from "../audio-chunks.js";
import { screenplayPageDetails } from "../billing/screenplay-page-count.js";
import { progressPercent, spokenTextForChunk } from "../playback-utils.js";

export const ACCOUNT_LIBRARY_SCHEMA_VERSION = 1;

function sourceFormat(script) {
  const value = String(script?.format || script?.source?.extension || "").toLowerCase();
  if (value.includes("final") || value === "fdx") return "fdx";
  if (value.includes("pdf")) return "pdf";
  if (value.includes("fountain") || value === "spmd") return "fountain";
  throw new Error("Unsupported screenplay format for account library.");
}

function sceneForIndex(script, currentIndex) {
  return [...(script?.scenes || [])]
    .reverse()
    .find((scene) => scene.unitIndex <= currentIndex)?.title || "Opening";
}

export function spokenCharacterCount(script, { readCharacterNames = false } = {}) {
  return buildAudioChunks(script?.units || []).reduce(
    (total, chunk) => total + spokenTextForChunk(chunk, { readCharacterNames }).length,
    0
  );
}

export function screenplayLibraryRow(record, ownerUserId, pageDetails = {}) {
  if (!record?.id || !record?.script?.units?.length) throw new Error("A complete local screenplay record is required.");
  if (!ownerUserId) throw new Error("An authenticated owner is required.");
  const inferredPages = screenplayPageDetails(record.script);
  const pageCount = pageDetails.pageCount ?? inferredPages.pageCount;
  const pageCountMethod = pageDetails.pageCountMethod ?? inferredPages.pageCountMethod;
  return {
    owner_user_id: ownerUserId,
    client_fingerprint: record.id,
    title: String(record.script.title || "Untitled Screenplay").slice(0, 300),
    source_format: sourceFormat(record.script),
    page_count: Math.max(1, Math.round(Number(pageCount))),
    page_count_method: pageCountMethod,
    spoken_character_count: spokenCharacterCount(record.script)
  };
}

export function playbackStateRow(record, ownerUserId, screenplayId) {
  if (!ownerUserId || !screenplayId) throw new Error("Playback state requires an owner and screenplay.");
  const preferences = record?.preferences || {};
  const currentIndex = Math.max(0, Number(preferences.currentIndex) || 0);
  return {
    screenplay_id: screenplayId,
    owner_user_id: ownerUserId,
    current_unit: currentIndex,
    current_chunk: Math.max(0, Number(preferences.chunkIndex) || 0),
    chunk_position_seconds: Math.max(0, Number(preferences.chunkPosition) || 0),
    progress_percent: progressPercent(currentIndex, record?.script?.units?.length || 0),
    playback_speed: Math.max(0.5, Math.min(2, Number(preferences.rate) || 1)),
    current_scene: sceneForIndex(record?.script, currentIndex)
  };
}

export function screenplaySettingsRow(record, ownerUserId, screenplayId) {
  if (!ownerUserId || !screenplayId) throw new Error("Screenplay settings require an owner and screenplay.");
  const preferences = record?.preferences || {};
  return {
    screenplay_id: screenplayId,
    owner_user_id: ownerUserId,
    audio_quality: preferences.provider === "elevenlabs" ? "premium" : "standard",
    read_character_names: preferences.readCharacterNames === true,
    cast_assignments: structuredClone(preferences.voiceAssignments || {})
  };
}

export function applyCloudPreferences(record, playback = {}, settings = {}) {
  if (!record?.script?.units?.length) throw new Error("A complete local screenplay record is required.");
  const maximumIndex = Math.max(0, record.script.units.length - 1);
  const currentIndex = Math.max(0, Math.min(maximumIndex, Number(playback.current_unit) || 0));
  return {
    ...record,
    preferences: {
      ...(record.preferences || {}),
      currentIndex,
      chunkIndex: Math.max(0, Number(playback.current_chunk) || 0),
      chunkPosition: Math.max(0, Number(playback.chunk_position_seconds) || 0),
      rate: Math.max(0.5, Math.min(2, Number(playback.playback_speed) || 1)),
      provider: settings.audio_quality === "premium" ? "elevenlabs" : "browser",
      readCharacterNames: settings.read_character_names === true,
      voiceAssignments: structuredClone(settings.cast_assignments || {})
    }
  };
}
