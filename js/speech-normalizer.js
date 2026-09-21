const SCENE_RULES = [
  [/^\s*INT\.\s*\/\s*EXT\.\s*/i, "INTERIOR / EXTERIOR "],
  [/^\s*EXT\.\s*\/\s*INT\.\s*/i, "EXTERIOR / INTERIOR "],
  [/^\s*I\s*\/\s*E\.\s*/i, "INTERIOR / EXTERIOR "],
  [/^\s*INT\.\s*/i, "INTERIOR "],
  [/^\s*EXT\.\s*/i, "EXTERIOR "]
];

export function normalizeForSpeech(text, type = "action") {
  let normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (type === "scene") {
    for (const [pattern, replacement] of SCENE_RULES) {
      if (pattern.test(normalized)) {
        normalized = normalized.replace(pattern, replacement);
        break;
      }
    }
  }
  return normalized;
}
