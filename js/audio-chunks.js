import { normalizeForSpeech } from "./speech-normalizer.js";
import { splitForSpeech } from "./speech-engine.js";

function roleFor(unit) { return unit.type === "dialogue" ? unit.characterId : "NARRATOR"; }

export function buildAudioChunks(units, { maxChars = 700, maxUnits = 3 } = {}) {
  const chunks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    current.text = current.parts.join(" ").trim();
    delete current.parts;
    chunks.push(current);
    current = null;
  };
  units.forEach((unit, unitIndex) => {
    const text = normalizeForSpeech(unit.text, unit.type);
    if (!text) return;
    splitForSpeech(text, maxChars).forEach((part, partIndex) => {
      const roleId = roleFor(unit);
      const canJoin = partIndex === 0 && current && current.roleId === roleId && current.scene === unit.scene
        && current.unitIndices.length < maxUnits && current.parts.join(" ").length + part.length + 1 <= maxChars
        && unit.type !== "scene" && current.type !== "scene";
      if (!canJoin) {
        flush();
        current = { id: `chunk-${chunks.length}`, roleId, speaker: unit.type === "dialogue" ? unit.speaker : "Narrator", scene: unit.scene, type: unit.type, parts: [], unitIndices: [] };
      }
      current.parts.push(part);
      if (!current.unitIndices.includes(unitIndex)) current.unitIndices.push(unitIndex);
    });
  });
  flush();
  return chunks;
}

export function chunkIndexForUnit(chunks, unitIndex) {
  const exact = chunks.findIndex((chunk) => chunk.unitIndices.includes(unitIndex));
  if (exact >= 0) return exact;
  let candidate = 0;
  chunks.forEach((chunk, index) => { if (chunk.unitIndices[0] <= unitIndex) candidate = index; });
  return candidate;
}
