const FORMATTED_LINES_PER_PAGE = 55;

function wrappedLines(text, width) {
  const value = String(text || "").trim();
  return value ? Math.max(1, Math.ceil(value.length / width)) : 0;
}

export function estimateScreenplayPages(script) {
  const units = script?.units || [];
  if (!units.length) return 1;
  let lines = 0;
  let previousDialogueRole = "";
  for (const unit of units) {
    if (unit.type === "dialogue") {
      const role = unit.characterId || unit.speaker || "UNKNOWN";
      if (role !== previousDialogueRole) lines += 2; // spacing plus character cue
      lines += wrappedLines(unit.text, 35);
      previousDialogueRole = role;
      continue;
    }
    previousDialogueRole = "";
    if (unit.type === "scene") lines += 2 + wrappedLines(unit.text, 60);
    else if (unit.type === "transition") lines += 1 + wrappedLines(unit.text, 60);
    else lines += 1 + wrappedLines(unit.text, 60);
  }
  return Math.max(1, Math.ceil(lines / FORMATTED_LINES_PER_PAGE));
}

export function screenplayPageDetails(script) {
  const exact = Math.ceil(Number(script?.source?.pageCount));
  if (Number.isFinite(exact) && exact > 0) return { pageCount: exact, pageCountMethod: "pdf-exact" };
  return { pageCount: estimateScreenplayPages(script), pageCountMethod: "screenplay-estimate-v1" };
}
