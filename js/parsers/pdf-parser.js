import { calculateConfidence, createScreenplay, filenameToTitle, normalizeCharacterName, ScreenplayParseError } from "./normalized-model.js";

const PDFJS_ROOT = new URL("../../vendor/pdfjs/", import.meta.url).href;
const SCENE = /^(?:INT\.?|EXT\.?|EST\.?|I\/E\.?|INT\.?\/EXT\.?|EXT\.?\/INT\.?)(?:\s|$)/i;
const TRANSITION = /^(?:FADE (?:IN|OUT)|CUT TO|SMASH CUT TO|MATCH CUT TO|DISSOLVE TO|WIPE TO|BACK TO)(?:\s*:)?$/i;
const UPPER_CUE = /^[A-Z0-9][A-Z0-9 ._'’\-()#]+$/;

function looksLikePageNumber(line) {
  return /^\s*(?:PAGE\s+)?\d{1,4}\.?\s*$/i.test(line.text);
}

function looksLikeCue(text) {
  const cue = text.trim();
  return cue.length >= 2 && cue.length <= 60 && UPPER_CUE.test(cue) && !SCENE.test(cue) && !TRANSITION.test(cue) && !/[.!?]$/.test(cue.replace(/\([^)]*\)$/, ""));
}

function noiseRatio(text) {
  if (!text) return 1;
  const strange = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F�]/g) || []).length;
  return strange / text.length;
}

export function classifyPdfLines(pages, fallbackTitle = "Untitled Screenplay") {
  const repeated = new Map();
  for (const page of pages) {
    for (const line of [...page.lines.slice(0, 2), ...page.lines.slice(-2)]) {
      const key = line.text.trim().toUpperCase();
      if (key.length > 2) repeated.set(key, (repeated.get(key) || 0) + 1);
    }
  }
  const repeatThreshold = Math.max(3, Math.ceil(pages.length * 0.6));
  const units = [];
  let currentScene = "Opening";
  const allText = [];

  for (const page of pages) {
    const lines = page.lines.filter((line) => {
      const key = line.text.trim().toUpperCase();
      return line.text.trim() && !looksLikePageNumber(line) && (repeated.get(key) || 0) < repeatThreshold;
    });
    allText.push(...lines.map((line) => line.text));
    let index = 0;
    while (index < lines.length) {
      const current = lines[index];
      const text = current.text.trim();
      if (SCENE.test(text)) {
        currentScene = text;
        units.push({ type: "scene", text, scene: currentScene });
        index += 1;
        continue;
      }
      if (TRANSITION.test(text)) {
        units.push({ type: "transition", text, scene: currentScene });
        index += 1;
        continue;
      }

      const next = lines[index + 1]?.text.trim();
      const nextSpoken = /^\(.*\)$/.test(next || "") ? lines[index + 2]?.text.trim() : next;
      const currentIsCue = looksLikeCue(text) && nextSpoken
        && (current.x > page.width * 0.28 || current.indentRank >= 2);
      if (currentIsCue) {
        const displayCue = text;
        const speaker = normalizeCharacterName(displayCue);
        index += 1;
        while (index < lines.length) {
          const candidate = lines[index];
          const dialogue = candidate.text.trim();
          if (!dialogue) { index += 1; continue; }
          if (/^\(.*\)$/.test(dialogue)) { index += 1; continue; }
          if (SCENE.test(dialogue) || TRANSITION.test(dialogue)) break;
          if (looksLikeCue(dialogue) && lines[index + 1] && (candidate.x > page.width * 0.28 || candidate.indentRank >= 2)) break;
          if (candidate.x < page.width * 0.18 && dialogue.length > 80) break;
          units.push({ type: "dialogue", text: dialogue, scene: currentScene, speaker, characterId: speaker.toLocaleUpperCase(), displayCue });
          index += 1;
        }
        continue;
      }

      const action = [text];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        const candidateText = candidate.text.trim();
        if (SCENE.test(candidateText) || TRANSITION.test(candidateText) || (looksLikeCue(candidateText) && lines[index + 1] && candidate.x > page.width * 0.28)) break;
        if (!/^\(.*\)$/.test(candidateText)) action.push(candidateText);
        index += 1;
      }
      const joined = action.join(" ").replace(/\s+/g, " ").trim();
      if (joined) units.push({ type: "action", text: joined, scene: currentScene });
    }
  }

  const confidence = calculateConfidence(units, { pageCount: pages.length, extractionNoise: noiseRatio(allText.join(" ")) });
  const firstPage = pages[0]?.lines.map((line) => line.text.trim()).filter(Boolean) || [];
  const titleCandidate = firstPage.find((line) => line.length > 2 && line.length < 100 && !looksLikePageNumber({ text: line }) && !SCENE.test(line));
  return createScreenplay({ title: titleCandidate || fallbackTitle, format: "PDF", units, confidence, source: { extension: "pdf", pageCount: pages.length } });
}

function groupTextItems(items, viewport) {
  const rows = [];
  for (const item of items) {
    const text = String(item.str || "").trim();
    if (!text) continue;
    const x = item.transform?.[4] || 0;
    const y = item.transform?.[5] || 0;
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < 2.5);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ text, x });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    const x = row.items[0].x;
    return { text: row.items.map((item) => item.text).join(" ").replace(/\s+/g, " "), x, y: row.y, indentRank: x > viewport.width * 0.52 ? 3 : x > viewport.width * 0.34 ? 2 : x > viewport.width * 0.18 ? 1 : 0 };
  });
}

async function loadPdfJs() {
  try {
    const pdfjs = await import("../../vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ROOT}pdf.worker.min.mjs`;
    return pdfjs;
  } catch (error) {
    throw new ScreenplayParseError("pdf_library", "The PDF reader could not load. Check your internet connection and try again.", { cause: error });
  }
}

export async function parsePdf(file, fallbackTitle = filenameToTitle(file?.name)) {
  const pdfjs = await loadPdfJs();
  let document;
  try {
    document = await pdfjs.getDocument({
      data: await file.arrayBuffer(),
      cMapUrl: `${PDFJS_ROOT}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ROOT}standard_fonts/`,
      wasmUrl: `${PDFJS_ROOT}wasm/`
    }).promise;
  } catch (error) {
    throw new ScreenplayParseError("malformed_pdf", "This PDF could not be opened. It may be damaged or password-protected.", { cause: error });
  }
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({ width: viewport.width, height: viewport.height, lines: groupTextItems(content.items, viewport) });
  }
  const extracted = pages.flatMap((page) => page.lines).map((line) => line.text).join(" ").trim();
  if (extracted.length < 40) {
    throw new ScreenplayParseError("scanned_pdf", "This PDF does not contain readable text. SpokenFrame currently supports text-based PDFs, not scanned or image-only PDFs.");
  }
  return classifyPdfLines(pages, fallbackTitle);
}
