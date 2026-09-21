export const SCREENPLAY_SCHEMA_VERSION = 2;

export class ScreenplayParseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ScreenplayParseError";
    this.code = code;
    this.details = details;
  }
}

const CHARACTER_MODIFIERS = new Set([
  "CONT'D", "CONT’D", "CONTINUED", "V.O.", "VO", "V/O", "VOICE OVER",
  "O.S.", "OS", "O/S", "OFF SCREEN", "O.C.", "OC", "OFF CAMERA", "FILTERED"
]);

export function normalizeCharacterName(cue) {
  let value = String(cue || "").replace(/\s+/g, " ").trim();
  let previous = "";
  while (value && previous !== value) {
    previous = value;
    value = value.replace(/\s*\(([^()]*)\)\s*$/, (match, inner) => {
      const normalized = inner.replace(/\s+/g, " ").trim().toUpperCase();
      return CHARACTER_MODIFIERS.has(normalized) ? "" : match;
    }).trim();
  }
  return value || String(cue || "").trim() || "Unknown Character";
}

export function filenameToTitle(filename = "") {
  return filename
    .replace(/\.(fdx|pdf|fountain|spmd|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim() || "Untitled Screenplay";
}

export function createScreenplay({ title, format, units, confidence, source = {} }) {
  if (!Array.isArray(units) || !units.length) {
    throw new ScreenplayParseError("empty", "No readable screenplay content was found in this file.");
  }

  const normalizedUnits = units.map((unit, index) => ({
    id: `unit-${index}`,
    type: unit.type,
    text: String(unit.text || "").trim(),
    scene: unit.scene || "Opening",
    speaker: unit.type === "dialogue" ? (unit.speaker || "Unknown Character") : "Narrator",
    characterId: unit.type === "dialogue" ? (unit.characterId || normalizeCharacterName(unit.speaker)).toLocaleUpperCase() : null,
    displayCue: unit.type === "dialogue" ? (unit.displayCue || unit.speaker || "Unknown Character") : null
  })).filter((unit) => unit.text);

  if (!normalizedUnits.length) {
    throw new ScreenplayParseError("empty", "No readable screenplay content was found in this file.");
  }

  const characterMap = new Map();
  const scenes = [];
  normalizedUnits.forEach((unit, index) => {
    unit.id = `unit-${index}`;
    if (unit.type === "scene") scenes.push({ title: unit.text, unitIndex: index });
    if (unit.type !== "dialogue") return;
    const id = unit.characterId;
    if (!characterMap.has(id)) characterMap.set(id, { id, name: unit.speaker, displayCues: new Set() });
    characterMap.get(id).displayCues.add(unit.displayCue);
  });

  if (!scenes.length) scenes.push({ title: "Opening", unitIndex: 0 });
  return {
    schemaVersion: SCREENPLAY_SCHEMA_VERSION,
    title: title || "Untitled Screenplay",
    format,
    source,
    units: normalizedUnits,
    scenes,
    characters: [...characterMap.values()].map((character) => ({
      ...character,
      displayCues: [...character.displayCues]
    })),
    confidence: confidence || { score: 1, warnings: [], reviewRecommended: false }
  };
}

export function calculateConfidence(units, { pageCount = 0, extractionNoise = 0 } = {}) {
  const counts = units.reduce((result, unit) => {
    result[unit.type] = (result[unit.type] || 0) + 1;
    return result;
  }, {});
  const total = Math.max(1, units.length);
  const warnings = [];
  let score = 1;

  if (!counts.dialogue) { warnings.push("No character dialogue was detected."); score -= 0.35; }
  if (!counts.scene && (pageCount >= 5 || total >= 80)) { warnings.push("No scene headings were detected."); score -= 0.25; }
  if ((counts.action || 0) / total > 0.92 && total > 30) { warnings.push("Most of the document was interpreted as action."); score -= 0.3; }
  if (extractionNoise > 0.12) { warnings.push("Some PDF text appears to be extracted incorrectly."); score -= 0.25; }
  if (total < 3) { warnings.push("Very little readable screenplay content was found."); score -= 0.3; }

  score = Math.max(0, Math.min(1, score));
  return { score, warnings, reviewRecommended: score < 0.58 };
}
