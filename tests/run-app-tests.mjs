import fs from "node:fs/promises";
import { Window } from "happy-dom";
import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";

const window = new Window({ url: "https://example.test/spokenframe/" });
const document = window.document;
const voices = [
  { name: "Local One", lang: "en-US", voiceURI: "local-one", default: true, localService: true },
  { name: "Local Two", lang: "en-US", voiceURI: "local-two", default: false, localService: true },
  { name: "Local Three", lang: "en-GB", voiceURI: "local-three", default: false, localService: true }
];
const spoken = [];
const fakeSpeech = { speaking: false, cancelCount: 0, getVoices: () => voices, addEventListener() {}, removeEventListener() {}, speak(utterance) { this.speaking = true; spoken.push(utterance); }, cancel() { this.speaking = false; this.cancelCount += 1; } };
class FakeUtterance { constructor(text) { this.text = text; } }

for (const [name, value] of Object.entries({ window, document, navigator: window.navigator, localStorage: window.localStorage, indexedDB, crypto: webcrypto, DOMParser: window.DOMParser, SpeechSynthesisUtterance: FakeUtterance, File: window.File, Event: window.Event })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
Object.defineProperty(window, "indexedDB", { value: indexedDB }); Object.defineProperty(window, "speechSynthesis", { value: fakeSpeech });
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = () => {};

const html = await fs.readFile(new URL("../index.html", import.meta.url), "utf8"); document.write(html); document.close();
await import(`../js/app.js?test=${Date.now()}`);
const fdx = await fs.readFile(new URL("./fixtures/representative.fdx", import.meta.url), "utf8");
const fountain = await fs.readFile(new URL("./fixtures/representative.fountain", import.meta.url), "utf8");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const results = [];
async function test(name, fn) { try { await fn(); results.push(true); console.log(`✓ ${name}`); } catch (error) { results.push(false); console.error(`✗ ${name} — ${error.message}`); } }
async function upload(contents, filename, inputId = "#file-input") {
  const input = document.querySelector(inputId); const file = new window.File([contents], filename, { type: "text/plain" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new window.Event("change", { bubbles: true })); await pause(100);
}

await pause(25);
await test("starts with SpokenFrame's focused import experience", () => {
  check(document.querySelector("#landing-title").textContent.includes("Your Screenplay."), "Headline missing");
  check(document.body.textContent.includes("Final Draft (.fdx) recommended"), "Preferred format missing");
  check(document.querySelector("#narration-toggle") === null, "Narration toggle still exists");
});
await test("imports FDX into the synchronized player", async () => {
  await upload(fdx, "passenger.fdx");
  check(!document.querySelector("#player-view").hidden, "Player did not open");
  check(document.querySelector("#script-title").textContent === "PASSENGER", "Title missing");
  check(document.querySelectorAll(".script-unit.dialogue").length === 3, "Dialogue missing");
  check(!document.body.textContent.includes("(carefully)"), "Parenthetical leaked");
});
await test("device playback uses speech normalization and reads action", () => {
  const play = document.querySelector("#play-button"); play.click();
  check(spoken.at(-1)?.text === "EXTERIOR LOS ANGELES - NIGHT", "Scene heading was not normalized for speech");
  play.click(); document.querySelector('[data-index="1"]').click();
  check(document.querySelector("#current-speaker").textContent === "Narrator", "Action is not narrated");
  check(document.querySelector("#now-playing-heading").textContent.startsWith("Traffic glows"), "Action did not follow scene");
});
await test("first import gives every role the same predictable voice", () => {
  document.querySelector("#cast-button").click();
  const values = [...document.querySelectorAll(".voice-row select")].map((select) => select.value);
  check(values.length === 3, "Cast list should include narrator and two characters");
  check(new Set(values).size === 1 && values[0] === "local-one", "Voices varied automatically");
});
await test("Auto Assign is opt-in and previews own playback", () => {
  document.querySelector("#auto-assign-button").click();
  const values = [...document.querySelectorAll(".voice-row select")].map((select) => select.value);
  check(new Set(values).size > 1, "Auto Assign did not vary voices");
  const before = spoken.length; const cancelBefore = fakeSpeech.cancelCount;
  document.querySelector(".preview-voice").click();
  check(spoken.length === before + 1 && spoken.at(-1)?.text.includes("voice sounds"), "Preview did not speak");
  check(fakeSpeech.cancelCount > cancelBefore, "Preview did not stop prior playback");
  spoken.at(-1).onend?.();
  check(!document.querySelector("#play-button").classList.contains("is-playing"), "Screenplay resumed after preview");
  document.querySelector("#done-cast-button").click();
  check(!fakeSpeech.speaking, "Closing Cast did not stop preview audio");
});
await test("Cast is narrator-first and ordered by dialogue quantity", () => {
  document.querySelector("#cast-button").click();
  const names = [...document.querySelectorAll(".voice-identity strong")].map((element) => element.textContent);
  check(names.join("|") === "Narrator|EVAN|LENA PARK", `Unexpected Cast order: ${names.join("|")}`);
  check(document.body.textContent.includes("Audio Quality") && document.body.textContent.includes("Premium Audio") && document.body.textContent.includes("Standard Audio"), "V3 audio terminology missing");
  document.querySelector("#done-cast-button").click();
});
await test("character-name reading is optional and persists", () => {
  document.querySelector("#cast-button").click();
  const toggle = document.querySelector("#read-character-names"); check(!toggle.checked, "Character names should default off");
  toggle.checked = true; toggle.dispatchEvent(new window.Event("change", { bubbles: true })); document.querySelector("#done-cast-button").click();
  document.querySelector('[data-index="2"]').click(); document.querySelector("#play-button").click();
  check(spoken.at(-1)?.text.startsWith("EVAN."), "Character name was not read when enabled");
  document.querySelector("#play-button").click(); document.querySelector("#cast-button").click();
  check(document.querySelector("#read-character-names").checked, "Character-name setting did not persist");
  document.querySelector("#done-cast-button").click();
});
await test("scene and three-passage navigation use screenplay structure", () => {
  document.querySelector("#next-scene-button").click();
  check(document.querySelector("#now-playing-heading").textContent.includes("TRAFFIC OPERATIONS"), "Next scene failed");
  document.querySelector("#previous-scene-button").click();
  check(document.querySelector("#now-playing-heading").textContent.includes("LOS ANGELES"), "Previous scene failed");
  document.querySelector("#forward-three-button").click();
  check(Number(document.querySelector("#progress-slider").value) >= 2, "Forward 3 failed");
  document.querySelector("#back-three-button").click();
  check(Number(document.querySelector("#progress-slider").value) === 0, "Back 3 failed");
});
await test("speed, scenes, highlighting, and resume persist", async () => {
  const speed = document.querySelector("#speed-select"); speed.value = "1.5"; speed.dispatchEvent(new window.Event("change", { bubbles: true }));
  const scene = document.querySelector("#scene-select"); scene.value = "7"; scene.dispatchEvent(new window.Event("change", { bubbles: true })); await pause(400);
  check(document.querySelectorAll(".script-unit.is-active").length >= 1, "Highlight missing");
  document.querySelector("#brand-button").click(); check(!document.querySelector("#resume-card").hidden, "Resume missing"); document.querySelector("#resume-button").click();
  check(document.querySelector("#speed-select").value === "1.5", "Speed did not persist");
  check(document.querySelector("#now-playing-heading").textContent.includes("TRAFFIC OPERATIONS"), "Position did not persist");
  check(/^\d+% · /.test(document.querySelector("#progress-summary").textContent), "Friendly progress summary missing");
  check(!document.querySelector("#progress-summary").textContent.includes("/"), "Internal unit count is visible");
  document.querySelector("#cast-button").click();
  const savedVoices = [...document.querySelectorAll(".voice-row select")].map((select) => select.value);
  check(new Set(savedVoices).size > 1, "Voice assignments did not persist");
  check(document.querySelector("#read-character-names").checked, "Character-name preference did not persist after resume");
  document.querySelector("#done-cast-button").click();
});
await test("imports Fountain through the same player", async () => {
  await upload(fountain, "night-window.fountain", "#replace-file-input");
  check(document.querySelector("#script-title").textContent === "NIGHT WINDOW", "Fountain title missing");
  check(document.querySelector("#script-format").textContent === "FOUNTAIN", "Fountain format missing");
  check(document.querySelectorAll(".script-unit.dialogue").length === 2, "Fountain dialogue missing");
});
await test("malformed FDX shows a plain-language error", async () => {
  await upload("<FinalDraft><Content>", "broken.fdx", "#replace-file-input");
  check(/damaged|valid Final Draft/i.test(document.querySelector("#toast").textContent), "Friendly error missing");
});
if (results.some((result) => !result)) process.exit(1);
