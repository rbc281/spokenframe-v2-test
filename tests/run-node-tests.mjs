import fs from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";

globalThis.DOMParser = DOMParser;

const { normalizeCharacterName, parseFdx } = await import("../js/fdx-parser.js");
const { BrowserSpeechEngine, splitForSpeech } = await import("../js/speech-engine.js");
const xml = await fs.readFile(new URL("./fixtures/representative.fdx", import.meta.url), "utf8");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const equal = (actual, expected, message = "Values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const script = parseFdx(xml, "Fallback");

test("extracts title", () => equal(script.title, "PASSENGER"));
test("preserves readable order", () => equal(script.units.map((unit) => unit.type), ["scene", "action", "dialogue", "dialogue", "action", "dialogue", "transition", "scene", "action"]));
test("skips parentheticals", () => equal(script.units.some((unit) => unit.text === "(carefully)"), false));
test("normalizes V.O., O.S., and continued cues", () => equal(script.characters.map((character) => character.name), ["EVAN", "LENA PARK"]));
test("preserves useful cue context", () => equal(script.units[2].displayCue, "EVAN (V.O.)"));
test("tracks scene positions", () => equal(script.scenes, [
  { title: "EXT. LOS ANGELES - NIGHT", unitIndex: 0 },
  { title: "INT. TRAFFIC OPERATIONS CENTER - LATER", unitIndex: 7 }
]));
test("does not strip unknown descriptive parentheses", () => {
  equal(normalizeCharacterName("EVAN (CONT'D) (V.O.)"), "EVAN");
  equal(normalizeCharacterName("MAN (50s)"), "MAN (50s)");
});
test("chunks long speech without losing words", () => {
  const input = "One short sentence. ".repeat(40).trim();
  const chunks = splitForSpeech(input, 100);
  if (chunks.length < 2 || chunks.some((chunk) => chunk.length > 100)) throw new Error("Chunk sizes are unsafe");
  equal(chunks.join(" "), input);
});
test("keeps a long unpunctuated action block in safe chunks", () => {
  const input = Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ");
  const chunks = splitForSpeech(input, 80);
  if (chunks.some((chunk) => chunk.length > 80)) throw new Error("Unpunctuated chunk is too large");
  equal(chunks.join(" "), input);
});
test("falls back when a saved voice is unavailable", () => {
  const voices = [
    { name: "Voice One", lang: "en-US", voiceURI: "voice-one", default: true },
    { name: "Voice Two", lang: "en-US", voiceURI: "voice-two", default: false }
  ];
  const engine = new BrowserSpeechEngine({ getVoices: () => voices, cancel() {} });
  equal(engine.resolveVoice("removed-voice").voiceURI, "voice-one");
  equal(engine.resolveVoice("voice-two").voiceURI, "voice-two");
});
test("rejects malformed XML", () => {
  let rejected = false;
  try { parseFdx("<FinalDraft><Content>"); } catch { rejected = true; }
  equal(rejected, true);
});
test("rejects non-FDX XML", () => {
  let rejected = false;
  try { parseFdx("<document><p>Hello</p></document>"); } catch { rejected = true; }
  equal(rejected, true);
});
test("rejects an empty Final Draft document", () => {
  let rejected = false;
  try { parseFdx("<FinalDraft><Content/></FinalDraft>"); } catch { rejected = true; }
  equal(rejected, true);
});

let failures = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`✓ ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${item.name} — ${error.message}`);
  }
}
if (failures) process.exit(1);
