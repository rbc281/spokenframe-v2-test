import { createScreenplay, filenameToTitle, normalizeCharacterName, ScreenplayParseError } from "./normalized-model.js";

const SCENE = /^(?:INT\.?|EXT\.?|EST\.?|I\/E\.?|INT\.?\/EXT\.?|EXT\.?\/INT\.?)(?:\s|$)/i;
const TRANSITION = /^(?:FADE (?:IN|OUT)|CUT TO|SMASH CUT TO|MATCH CUT TO|DISSOLVE TO|WIPE TO|BACK TO)(?:\s*:)?$/i;
const CHARACTER = /^[A-Z0-9][A-Z0-9 ._'’\-()#]+$/;

function cleanLine(line) {
  return line.replace(/\t/g, "    ").replace(/\s+$/, "");
}

function parseTitlePage(lines, fallbackTitle) {
  const titleLine = lines.slice(0, 15).find((line) => /^Title\s*:/i.test(line));
  return titleLine?.replace(/^Title\s*:/i, "").trim() || fallbackTitle;
}

function isCharacterCue(line, nextLine) {
  const forced = line.startsWith("@");
  const cue = forced ? line.slice(1).trim() : line.trim();
  if (!cue || !nextLine?.trim() || cue.length > 70) return false;
  if (SCENE.test(cue) || TRANSITION.test(cue) || /[.!?]$/.test(cue.replace(/\([^)]*\)$/, "").trim())) return false;
  return forced || CHARACTER.test(cue);
}

export function parseFountain(text, fallbackTitle = "Untitled Screenplay") {
  const source = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!source.trim()) throw new ScreenplayParseError("empty", "This Fountain file does not contain readable screenplay text.");
  const rawLines = source.split("\n").map(cleanLine);
  const title = parseTitlePage(rawLines, fallbackTitle);
  const units = [];
  let currentScene = "Opening";
  let index = 0;
  let inBoneyard = false;

  while (index < rawLines.length) {
    let line = rawLines[index];
    const trimmed = line.trim();
    if (trimmed.includes("/*")) inBoneyard = true;
    if (inBoneyard) {
      if (trimmed.includes("*/")) inBoneyard = false;
      index += 1;
      continue;
    }
    if (!trimmed || /^\[\[.*\]\]$/.test(trimmed) || /^#{1,6}\s/.test(trimmed) || /^={3,}$/.test(trimmed)) { index += 1; continue; }
    if (/^(Title|Credit|Author|Authors|Source|Draft date|Contact|Copyright|Notes)\s*:/i.test(trimmed)) { index += 1; continue; }

    const forcedScene = trimmed.startsWith(".") && !trimmed.startsWith("..");
    const sceneText = forcedScene ? trimmed.slice(1).trim() : trimmed;
    if (forcedScene || SCENE.test(sceneText)) {
      currentScene = sceneText;
      units.push({ type: "scene", text: sceneText, scene: currentScene });
      index += 1;
      continue;
    }

    const forcedTransition = trimmed.startsWith(">") && trimmed.endsWith("<") === false;
    const transitionText = forcedTransition ? trimmed.slice(1).trim() : trimmed;
    if (forcedTransition || TRANSITION.test(transitionText)) {
      units.push({ type: "transition", text: transitionText, scene: currentScene });
      index += 1;
      continue;
    }

    if (isCharacterCue(trimmed, rawLines[index + 1])) {
      const displayCue = trimmed.replace(/^@/, "").replace(/\^$/, "").trim();
      const speaker = normalizeCharacterName(displayCue);
      index += 1;
      while (index < rawLines.length) {
        const dialogueLine = rawLines[index].trim();
        if (!dialogueLine) break;
        if (/^\(.*\)$/.test(dialogueLine)) { index += 1; continue; }
        if (SCENE.test(dialogueLine) || isCharacterCue(dialogueLine, rawLines[index + 1])) break;
        units.push({ type: "dialogue", text: dialogueLine.replace(/^!/, ""), scene: currentScene, speaker, characterId: speaker.toLocaleUpperCase(), displayCue });
        index += 1;
      }
      continue;
    }

    const actionLines = [];
    while (index < rawLines.length) {
      line = rawLines[index].trim();
      if (!line) break;
      if (actionLines.length && (SCENE.test(line.replace(/^\./, "")) || TRANSITION.test(line.replace(/^>/, "")) || isCharacterCue(line, rawLines[index + 1]))) break;
      if (!/^(?:Title|Credit|Author|Authors|Source|Draft date|Contact|Copyright|Notes)\s*:/i.test(line)) {
        actionLines.push(line.replace(/^!/, ""));
      }
      index += 1;
    }
    const action = actionLines.join(" ").trim();
    if (action) units.push({ type: "action", text: action, scene: currentScene });
  }

  return createScreenplay({
    title,
    format: "Fountain",
    units,
    confidence: { score: 0.96, warnings: [], reviewRecommended: false },
    source: { extension: "fountain" }
  });
}

export { filenameToTitle };
