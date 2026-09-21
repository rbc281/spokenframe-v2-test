import { normalizeCharacterName, parseFdx } from "../js/fdx-parser.js";
import { splitForSpeech } from "../js/speech-engine.js";

const results = [];
const test = (name, fn) => {
  try { fn(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: error.message }); }
};
const equal = (actual, expected, message = "Values differ") => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};

const xml = await fetch("fixtures/representative.fdx").then((response) => response.text());
const script = parseFdx(xml, "Fallback");

test("extracts title", () => equal(script.title, "PASSENGER"));
test("preserves readable order", () => equal(script.units.map((unit) => unit.type), ["scene", "action", "dialogue", "dialogue", "action", "dialogue", "transition", "scene", "action"]));
test("skips parentheticals", () => equal(script.units.some((unit) => unit.text === "(carefully)"), false));
test("normalizes VO OS and continued cues", () => equal(script.characters.map((character) => character.name), ["EVAN", "LENA PARK"]));
test("preserves display cue", () => equal(script.units[2].displayCue, "EVAN (V.O.)"));
test("tracks scenes", () => equal(script.scenes.length, 2));
test("normalizes character modifiers only", () => {
  equal(normalizeCharacterName("EVAN (CONT'D) (V.O.)"), "EVAN");
  equal(normalizeCharacterName("MAN (50s)"), "MAN (50s)");
});
test("chunks long speech without losing text", () => {
  const input = "One short sentence. ".repeat(40).trim();
  const chunks = splitForSpeech(input, 100);
  if (chunks.length < 2 || chunks.some((chunk) => chunk.length > 100)) throw new Error("Chunk sizes are unsafe");
  equal(chunks.join(" "), input);
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

window.__TEST_RESULTS__ = results;
document.querySelector("#results").textContent = JSON.stringify(results, null, 2);

