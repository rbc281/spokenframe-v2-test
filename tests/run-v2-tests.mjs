import fs from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";

globalThis.DOMParser = DOMParser;
if (!Uint8Array.prototype.toHex) Object.defineProperty(Uint8Array.prototype, "toHex", { value() { return [...this].map((byte) => byte.toString(16).padStart(2, "0")).join(""); } });
const { parseFountain } = await import("../js/parsers/fountain-parser.js");
const { classifyPdfLines, parsePdf } = await import("../js/parsers/pdf-parser.js");
const { normalizeForSpeech } = await import("../js/speech-normalizer.js");
const { buildAudioChunks } = await import("../js/audio-chunks.js");
const { ElevenLabsProvider } = await import("../js/tts/elevenlabs-provider.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message = "Values differ") => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); };

const fountainText = await fs.readFile(new URL("./fixtures/representative.fountain", import.meta.url), "utf8");
const fountain = parseFountain(fountainText, "Fallback");

test("Fountain extracts title and forced scene headings", () => {
  equal(fountain.title, "NIGHT WINDOW");
  equal(fountain.scenes.map((scene) => scene.title), ["INT. APARTMENT - NIGHT", "THE ROOFTOP"]);
});
test("Fountain skips parentheticals and preserves dialogue order", () => {
  check(!fountain.units.some((unit) => unit.text === "(quietly)"), "Parenthetical was spoken");
  equal(fountain.units.filter((unit) => unit.type === "dialogue").map((unit) => unit.text), ["You only hear the truth when the city sleeps.", "Then we should stay awake."]);
});
test("Fountain normalizes modifiers without losing display cue", () => {
  const unit = fountain.units.find((item) => item.type === "dialogue");
  equal(unit.speaker, "DR. MORA"); equal(unit.displayCue, "DR. MORA (V.O.)");
});
test("Fountain detects transitions and forced action", () => {
  check(fountain.units.some((unit) => unit.type === "transition" && unit.text === "CUT TO:"), "Transition missing");
  check(fountain.units.some((unit) => unit.type === "action" && unit.text.startsWith("A red signal")), "Forced action missing");
});

const pdfPages = [{ width: 612, lines: [
  { text: "PASSENGER", x: 255, indentRank: 2 },
  { text: "1.", x: 570, indentRank: 3 },
  { text: "EXT. LOS ANGELES - NIGHT", x: 72, indentRank: 0 },
  { text: "Traffic glows beneath the rain.", x: 72, indentRank: 0 },
  { text: "EVAN (V.O.)", x: 250, indentRank: 2 },
  { text: "We are almost there.", x: 180, indentRank: 1 },
  { text: "(carefully)", x: 210, indentRank: 1 },
  { text: "LENA PARK", x: 250, indentRank: 2 },
  { text: "Then keep driving.", x: 180, indentRank: 1 },
  { text: "CUT TO:", x: 480, indentRank: 3 }
] }];
const pdf = classifyPdfLines(pdfPages, "Passenger");
test("PDF heuristics find screenplay structure", () => {
  check(pdf.units.some((unit) => unit.type === "scene"), "Scene missing");
  check(pdf.units.filter((unit) => unit.type === "dialogue").length === 2, "Dialogue count is wrong");
  check(pdf.units.some((unit) => unit.type === "transition"), "Transition missing");
  check(!pdf.units.some((unit) => unit.text === "1." || unit.text === "(carefully)"), "Page number or parenthetical leaked");
});
test("suspicious PDF imports request review", () => {
  const pages = Array.from({ length: 6 }, (_, page) => ({ width: 612, lines: Array.from({ length: 20 }, (_, line) => ({ text: `ordinary action sentence ${page}-${line}.`, x: 72, indentRank: 0 })) }));
  const suspicious = classifyPdfLines(pages, "Odd PDF");
  check(suspicious.confidence.reviewRecommended, "Suspicious import was accepted silently");
});
test("PDF.js extracts a real multi-column screenplay page locally", async () => {
  const buffer = await fs.readFile(new URL("./fixtures/representative.pdf", import.meta.url));
  const file = { name: "representative.pdf", arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  const imported = await parsePdf(file, "Representative");
  check(imported.units.some((unit) => unit.type === "scene"), "Real PDF scene missing");
  check(imported.units.some((unit) => unit.type === "dialogue" && unit.speaker === "EVAN"), "Real PDF dialogue missing");
  check(!imported.units.some((unit) => unit.text === "(carefully)"), "Real PDF parenthetical leaked");
});
test("image-only PDF receives a clear scanned-document error", async () => {
  const buffer = await fs.readFile(new URL("./fixtures/image-only.pdf", import.meta.url));
  const file = { name: "image-only.pdf", arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  let code = "";
  try { await parsePdf(file, "Image Only"); } catch (error) { code = error.code; }
  equal(code, "scanned_pdf");
});

test("speech normalization changes audio text but not source text", () => {
  const displayed = "INT./EXT. EVAN'S CAR - NIGHT";
  equal(normalizeForSpeech(displayed, "scene"), "INTERIOR / EXTERIOR EVAN'S CAR - NIGHT");
  equal(displayed, "INT./EXT. EVAN'S CAR - NIGHT");
});
test("audio chunks preserve unit mapping and avoid cross-speaker batching", () => {
  const chunks = buildAudioChunks(fountain.units);
  check(chunks.every((chunk) => chunk.text.length <= 700), "Oversized chunk");
  const covered = [...new Set(chunks.flatMap((chunk) => chunk.unitIndices))].sort((a, b) => a - b);
  equal(covered, fountain.units.map((_, index) => index));
  check(chunks.every((chunk) => new Set(chunk.unitIndices.map((index) => fountain.units[index].type === "dialogue" ? fountain.units[index].characterId : "NARRATOR")).size === 1), "Speakers were mixed");
});
test("long action is split below the Worker limit without losing its highlight mapping", () => {
  const text = "A long uninterrupted production detail continues. ".repeat(80).trim();
  const chunks = buildAudioChunks([{ type: "action", text, scene: "Opening" }]);
  check(chunks.length > 1 && chunks.every((chunk) => chunk.text.length <= 700), "Long action was not safely split");
  check(chunks.every((chunk) => chunk.unitIndices[0] === 0), "Long action lost its source mapping");
  equal(chunks.map((chunk) => chunk.text).join(" "), text);
});

test("premium provider sends only text and voice ID to Worker", async () => {
  let request;
  const provider = new ElevenLabsProvider({ workerUrl: "https://worker.example", fetchImpl: async (url, options) => { request = { url, options }; return new Response(new Blob(["audio"], { type: "audio/mpeg" }), { status: 200, headers: { "X-SpokenFrame-Model": "test-model" } }); } });
  const blob = await provider.generateSpeech({ text: "A short passage.", voiceId: "voice_12345678" });
  equal(blob.type, "audio/mpeg");
  equal(JSON.parse(request.options.body), { text: "A short passage.", voiceId: "voice_12345678" });
  check(!request.options.body.includes("API"), "Secret-like data leaked to request body");
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log(`✓ ${item.name}`); }
  catch (error) { failures += 1; console.error(`✗ ${item.name} — ${error.message}`); }
}
if (failures) process.exit(1);
