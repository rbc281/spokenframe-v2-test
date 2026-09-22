import { normalizeForSpeech } from "./speech-normalizer.js";

export const SPEECH_NORMALIZATION_VERSION = 2;

export function sortedCastCharacters(script) {
  const counts = new Map();
  for (const unit of script?.units || []) {
    if (unit.type === "dialogue" && unit.characterId) {
      counts.set(unit.characterId, (counts.get(unit.characterId) || 0) + 1);
    }
  }
  return (script?.characters || [])
    .map((character, appearanceIndex) => ({ ...character, dialogueCount: counts.get(character.id) || 0, appearanceIndex }))
    .sort((a, b) => b.dialogueCount - a.dialogueCount || a.appearanceIndex - b.appearanceIndex);
}

export function spokenTextForChunk(chunk, { readCharacterNames = false } = {}) {
  const text = String(chunk?.text || "").trim();
  if (!text) return "";
  if (readCharacterNames && chunk.roleId !== "NARRATOR") {
    const name = normalizeForSpeech(chunk.speaker || chunk.roleId, "character");
    return `${name}. ${text}`;
  }
  return text;
}

export function creditsPerCharacter(model = "") {
  return /eleven_(flash|turbo)_v2_5|eleven_(flash|turbo)_v2/i.test(model) ? 0.5 : 1;
}

export function estimatePremiumCredits(chunks, { model, readCharacterNames = false } = {}) {
  const characters = (chunks || []).reduce((total, chunk) => total + spokenTextForChunk(chunk, { readCharacterNames }).length, 0);
  return Math.ceil(characters * creditsPerCharacter(model));
}

export function estimateSpeechSeconds(text, wordsPerMinute = 165) {
  const value = String(text || "").trim();
  if (!value) return 0;
  const words = value.split(/\s+/).length;
  const punctuationPauses = (value.match(/[.!?;:]/g) || []).length * 0.12;
  return Math.max(0.8, words * 60 / wordsPerMinute + punctuationPauses);
}

export function progressPercent(currentIndex, unitCount) {
  if (unitCount <= 1) return currentIndex > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((currentIndex / (unitCount - 1)) * 100)));
}

export function estimateRemainingSeconds(chunks, {
  chunkIndex = 0,
  chunkPosition = 0,
  rate = 1,
  durationForChunk = () => 0,
  readCharacterNames = false
} = {}) {
  const speed = Math.max(0.5, Number(rate) || 1);
  return (chunks || []).reduce((total, chunk, index) => {
    if (index < chunkIndex) return total;
    const known = Number(durationForChunk(index)) || 0;
    const duration = known || estimateSpeechSeconds(spokenTextForChunk(chunk, { readCharacterNames }));
    const remaining = index === chunkIndex ? Math.max(0, duration - (Number(chunkPosition) || 0)) : duration;
    return total + remaining / speed;
  }, 0);
}

export function formatTimeRemaining(seconds) {
  const minutes = Math.max(0, Math.ceil((Number(seconds) || 0) / 60));
  if (minutes < 60) return `${minutes} min remaining`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min remaining` : `${hours} hr remaining`;
}

export function progressSummary({ currentIndex, unitCount, remainingSeconds }) {
  return `${progressPercent(currentIndex, unitCount)}% · ${formatTimeRemaining(remainingSeconds)}`;
}

export function adjacentSceneUnit(scenes, currentUnitIndex, direction) {
  const ordered = scenes || [];
  if (!ordered.length) return 0;
  if (direction > 0) return ordered.find((scene) => scene.unitIndex > currentUnitIndex)?.unitIndex ?? ordered.at(-1).unitIndex;
  const currentSceneIndex = ordered.reduce((found, scene, index) => scene.unitIndex <= currentUnitIndex ? index : found, 0);
  return ordered[Math.max(0, currentSceneIndex - 1)].unitIndex;
}
