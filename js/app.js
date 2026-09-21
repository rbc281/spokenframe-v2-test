import { buildAudioChunks, chunkIndexForUnit } from "./audio-chunks.js";
import { AudioPlayer } from "./audio-player.js";
import { SPOKENFRAME_CONFIG } from "./config.js";
import { parseScreenplay, ScreenplayParseError, supportedFile } from "./parsers/parser-registry.js";
import { BrowserTtsProvider } from "./tts/browser-provider.js";
import { ElevenLabsProvider, PremiumTtsError } from "./tts/elevenlabs-provider.js";
import { audioCacheKey, deleteCachedAudio, getCachedAudio, hashFile, loadLastScreenplay, loadScreenplay, putCachedAudio, saveScreenplay } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  landing: $("#landing-view"), player: $("#player-view"), headerActions: $("#player-header-actions"), fileInput: $("#file-input"), replaceFileInput: $("#replace-file-input"), dropZone: $("#drop-zone"),
  resumeCard: $("#resume-card"), resumeTitle: $("#resume-title"), resumeDetail: $("#resume-detail"), resumeProgress: $("#resume-progress"), resumeButton: $("#resume-button"), resumeFormat: $("#resume-format"),
  brandButton: $("#brand-button"), scriptTitle: $("#script-title"), scriptFormat: $("#script-format"), scriptMeta: $("#script-meta"), scriptPages: $("#script-pages"),
  currentScene: $("#current-scene"), currentSpeaker: $("#current-speaker"), nowPlaying: $("#now-playing-heading"), passageKind: $("#passage-kind"), audioStatus: $("#audio-status"),
  playButton: $("#play-button"), previousButton: $("#previous-button"), nextButton: $("#next-button"), progressSlider: $("#progress-slider"), progressCurrent: $("#progress-current"), progressTotal: $("#progress-total"), sceneSelect: $("#scene-select"), speedSelect: $("#speed-select"), toast: $("#toast"),
  castButton: $("#cast-button"), castModal: $("#cast-modal"), voiceList: $("#voice-list"), closeCastButton: $("#close-cast-button"), doneCastButton: $("#done-cast-button"), autoAssignButton: $("#auto-assign-button"), providerSelect: $("#provider-select"),
  reviewModal: $("#review-modal"), reviewMessage: $("#review-message"), reviewCancel: $("#review-cancel"), reviewContinue: $("#review-continue"),
  fallbackModal: $("#fallback-modal"), fallbackMessage: $("#fallback-message"), fallbackDevice: $("#fallback-device"), fallbackRetry: $("#fallback-retry")
};

const browserProvider = new BrowserTtsProvider();
const premiumProvider = new ElevenLabsProvider({ workerUrl: SPOKENFRAME_CONFIG.workerUrl });
const canUseAudio = typeof globalThis.Audio === "function" || typeof window.Audio === "function";
const audioPlayer = canUseAudio ? new AudioPlayer(new (globalThis.Audio || window.Audio)()) : null;
const providers = { browser: browserProvider, elevenlabs: premiumProvider };
const state = {
  record: null, chunks: [], chunkIndex: 0, index: 0, isPlaying: false, isBuffering: false, rate: 1, providerId: "browser",
  voices: { browser: [], elevenlabs: [] }, premiumReady: false, voiceAssignments: {}, chunkPosition: 0,
  inflight: new Map(), controllers: new Map(), saveTimer: null, lastFocused: null, pendingRecord: null, playbackToken: 0
};

function showToast(message, duration = 4200) {
  clearTimeout(showToast.timer); elements.toast.textContent = message; elements.toast.hidden = false;
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, duration);
}

function errorMessage(error) {
  if (error instanceof ScreenplayParseError) return error.message;
  if (/storage/i.test(error?.message || "")) return "This browser could not save the screenplay. You can still listen during this session.";
  return "SpokenFrame could not open that screenplay. Try another Final Draft, PDF, or Fountain file.";
}

function defaultPreferences() { return { currentIndex: 0, chunkIndex: 0, chunkPosition: 0, rate: 1, provider: state.premiumReady ? "elevenlabs" : "browser", voiceAssignments: {} }; }
function activeProvider() { return providers[state.providerId] || browserProvider; }
function currentChunk() { return state.chunks[state.chunkIndex]; }
function assignmentFor(roleId) {
  const saved = state.voiceAssignments[roleId];
  if (typeof saved === "string") return { provider: "browser", voiceId: saved };
  if (saved?.provider === state.providerId) return saved;
  const voice = state.voices[state.providerId][0];
  return { provider: state.providerId, voiceId: voice?.id || "" };
}

function ensureDefaultAssignments(force = false, varied = false) {
  if (!state.record) return;
  const pool = state.voices[state.providerId];
  if (!pool.length) return;
  const roles = ["NARRATOR", ...state.record.script.characters.map((character) => character.id)];
  const first = pool[0];
  roles.forEach((roleId, index) => {
    const existing = state.voiceAssignments[roleId];
    const valid = existing && existing.provider === state.providerId && pool.some((voice) => voice.id === existing.voiceId);
    if (force || !valid) state.voiceAssignments[roleId] = { provider: state.providerId, voiceId: varied ? pool[index % pool.length].id : first.id };
  });
}

function unitLabel(unit) { return unit.type === "scene" ? "scene heading" : unit.type; }

function renderScript() {
  const { script } = state.record;
  elements.scriptTitle.textContent = script.title;
  elements.scriptFormat.textContent = script.format.toUpperCase();
  elements.scriptMeta.textContent = `${script.scenes.length} ${script.scenes.length === 1 ? "scene" : "scenes"} · ${script.characters.length} ${script.characters.length === 1 ? "character" : "characters"}`;
  elements.scriptPages.replaceChildren();
  const fragment = document.createDocumentFragment();
  let lastCue = null;
  script.units.forEach((unit, index) => {
    if (unit.type === "dialogue" && unit.displayCue !== lastCue) {
      const cue = document.createElement("p"); cue.className = "script-unit character"; cue.textContent = unit.displayCue; cue.setAttribute("aria-hidden", "true"); fragment.appendChild(cue); lastCue = unit.displayCue;
    } else if (unit.type !== "dialogue") lastCue = null;
    const paragraph = document.createElement("p"); paragraph.id = unit.id; paragraph.className = `script-unit ${unit.type}`; paragraph.textContent = unit.text; paragraph.dataset.index = String(index); fragment.appendChild(paragraph);
  });
  elements.scriptPages.appendChild(fragment);
  elements.sceneSelect.replaceChildren();
  script.scenes.forEach((scene) => { const option = document.createElement("option"); option.value = String(scene.unitIndex); option.textContent = scene.title; elements.sceneSelect.appendChild(option); });
  elements.progressSlider.max = String(Math.max(0, script.units.length - 1)); elements.progressTotal.textContent = String(script.units.length);
}

function updateNowPlaying({ scroll = false } = {}) {
  if (!state.record?.script.units.length) return;
  const chunk = currentChunk();
  if (chunk) state.index = chunk.unitIndices[0];
  const unit = state.record.script.units[state.index];
  elements.currentScene.textContent = unit.scene || "Opening";
  elements.currentSpeaker.textContent = chunk?.speaker || (unit.type === "dialogue" ? unit.displayCue : "Narrator");
  elements.nowPlaying.textContent = chunk ? chunk.unitIndices.map((index) => state.record.script.units[index].text).join(" ") : unit.text;
  elements.passageKind.textContent = unitLabel(unit); elements.progressSlider.value = String(state.index); elements.progressCurrent.textContent = String(state.index + 1); elements.speedSelect.value = String(state.rate);
  elements.audioStatus.textContent = state.isBuffering ? "Preparing audio…" : state.providerId === "elevenlabs" ? "Premium audio" : "Device voice";
  elements.scriptPages.querySelectorAll(".is-active").forEach((element) => element.classList.remove("is-active"));
  const indices = chunk?.unitIndices || [state.index];
  indices.forEach((index) => document.getElementById(state.record.script.units[index].id)?.classList.add("is-active"));
  const firstActive = document.getElementById(state.record.script.units[indices[0]].id);
  if (scroll) firstActive?.scrollIntoView({ behavior: "smooth", block: "center" });
  const scene = [...state.record.script.scenes].reverse().find((item) => item.unitIndex <= state.index);
  if (scene) elements.sceneSelect.value = String(scene.unitIndex);
  updateMediaSession(); queueSave();
}

function setBuffering(value) { state.isBuffering = value; elements.playButton.classList.toggle("is-loading", value); updateNowPlaying(); }
function setPlaying(value, { stop = true } = {}) {
  state.isPlaying = value; elements.playButton.classList.toggle("is-playing", value); elements.playButton.setAttribute("aria-label", value ? "Pause" : "Play");
  if (!value && stop) { browserProvider.stop(); audioPlayer?.pause(); }
  if (navigator.mediaSession) navigator.mediaSession.playbackState = value ? "playing" : "paused";
}

async function cacheIdentity(chunk) {
  const assignment = assignmentFor(chunk.roleId);
  return audioCacheKey({ provider: "elevenlabs", model: premiumProvider.model, voiceId: assignment.voiceId, text: chunk.text, settings: { format: "mp3_44100_128" } });
}

async function getPremiumAudio(chunkIndex, { foreground = false } = {}) {
  const chunk = state.chunks[chunkIndex];
  if (!chunk) return null;
  const key = await cacheIdentity(chunk);
  const cached = await getCachedAudio(key).catch(() => null);
  if (cached) return { blob: cached, key, cached: true };
  if (state.inflight.has(key)) return state.inflight.get(key);
  const controller = new AbortController(); state.controllers.set(key, controller);
  const assignment = assignmentFor(chunk.roleId);
  const promise = premiumProvider.generateSpeech({ text: chunk.text, voiceId: assignment.voiceId, signal: controller.signal })
    .then(async (blob) => { await putCachedAudio(key, blob, { screenplayId: state.record.id, chunkIndex, roleId: chunk.roleId }); return { blob, key, cached: false }; })
    .finally(() => { state.inflight.delete(key); state.controllers.delete(key); });
  state.inflight.set(key, promise);
  if (!foreground) promise.catch(() => {});
  return promise;
}

function prefetchUpcoming() {
  if (state.providerId !== "elevenlabs") return;
  [1, 2].forEach((offset) => { if (state.chunks[state.chunkIndex + offset]) getPremiumAudio(state.chunkIndex + offset).catch(() => {}); });
}

function cancelDistantGeneration() {
  for (const controller of state.controllers.values()) controller.abort();
  state.controllers.clear(); state.inflight.clear();
}

async function playPremium(token) {
  if (!state.premiumReady || !audioPlayer) throw new PremiumTtsError("unavailable", "Premium audio is not available in this browser right now.");
  setBuffering(true);
  const generated = await getPremiumAudio(state.chunkIndex, { foreground: true });
  if (token !== state.playbackToken || !state.isPlaying) return;
  try {
    await audioPlayer.load(generated.blob, { rate: state.rate, position: state.chunkPosition });
  } catch (error) {
    await deleteCachedAudio(generated.key).catch(() => {});
    throw error;
  }
  if (token !== state.playbackToken || !state.isPlaying) return;
  setBuffering(false); await audioPlayer.play(); prefetchUpcoming();
}

function playDevice(token) {
  const chunk = currentChunk();
  browserProvider.speak(chunk.text, {
    voiceId: assignmentFor(chunk.roleId).voiceId, rate: state.rate,
    onEnd: () => { if (token === state.playbackToken && state.isPlaying) advanceAfterEnd(); },
    onError: () => { if (token === state.playbackToken) { setPlaying(false); showToast("Device speech stopped. Tap Play to continue."); } }
  });
}

async function playCurrent() {
  if (!state.record || !currentChunk()) return;
  const token = ++state.playbackToken; setPlaying(true); updateNowPlaying({ scroll: true });
  try {
    if (state.providerId === "elevenlabs") await playPremium(token);
    else playDevice(token);
  } catch (error) {
    if (error?.name === "AbortError" || token !== state.playbackToken) return;
    setBuffering(false); setPlaying(false); openFallback(error);
  }
}

function togglePlayback() {
  if (state.isPlaying) { state.playbackToken += 1; state.chunkPosition = audioPlayer?.currentTime || 0; setPlaying(false); queueSave(); }
  else playCurrent();
}

function advanceAfterEnd() {
  state.chunkPosition = 0;
  if (state.chunkIndex >= state.chunks.length - 1) { setPlaying(false); showToast("Screenplay finished."); return; }
  state.chunkIndex += 1; state.index = currentChunk().unitIndices[0]; playCurrent();
}

function move(direction, { autoplay = state.isPlaying } = {}) {
  if (!state.record) return;
  const next = Math.max(0, Math.min(state.chunks.length - 1, state.chunkIndex + direction));
  if (next === state.chunkIndex && direction !== 0) return;
  state.playbackToken += 1; setPlaying(false); cancelDistantGeneration(); state.chunkIndex = next; state.chunkPosition = 0; state.index = currentChunk().unitIndices[0]; updateNowPlaying({ scroll: true });
  if (autoplay) playCurrent();
}

function jumpToUnit(unitIndex, autoplay = false) {
  state.playbackToken += 1; setPlaying(false); cancelDistantGeneration(); state.chunkIndex = chunkIndexForUnit(state.chunks, unitIndex); state.chunkPosition = 0; state.index = currentChunk().unitIndices[0]; updateNowPlaying({ scroll: true });
  if (autoplay) playCurrent();
}

function queueSave() { if (!state.record) return; clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveState, 300); }
async function saveState() {
  if (!state.record) return;
  state.record.preferences = { currentIndex: state.index, chunkIndex: state.chunkIndex, chunkPosition: state.providerId === "elevenlabs" ? (audioPlayer?.currentTime || state.chunkPosition) : 0, rate: state.rate, provider: state.providerId, voiceAssignments: state.voiceAssignments };
  try { state.record = await saveScreenplay(state.record); } catch { /* Playback remains usable without persistence. */ }
}

async function openRecord(record) {
  state.playbackToken += 1; setPlaying(false); state.record = record; state.chunks = buildAudioChunks(record.script.units);
  const preferences = { ...defaultPreferences(), ...(record.preferences || {}) };
  state.index = Number.isInteger(preferences.currentIndex) ? preferences.currentIndex : 0;
  state.chunkIndex = Number.isInteger(preferences.chunkIndex) && state.chunks[preferences.chunkIndex]?.unitIndices.includes(state.index) ? preferences.chunkIndex : chunkIndexForUnit(state.chunks, state.index);
  state.chunkPosition = Number(preferences.chunkPosition) || 0; state.rate = Number(preferences.rate) || 1;
  state.providerId = preferences.provider === "elevenlabs" ? "elevenlabs" : "browser"; state.voiceAssignments = preferences.voiceAssignments || {}; ensureDefaultAssignments();
  renderScript(); elements.landing.hidden = true; elements.player.hidden = false; elements.headerActions.hidden = false; updateNowPlaying({ scroll: true }); queueSave();
}

async function commitImport(record) { await openRecord(record); await saveState(); showToast(`${record.script.title} is ready.`); }

async function handleFile(file) {
  if (!file) return;
  if (!supportedFile(file)) { showToast("Choose a Final Draft (.fdx), PDF, or Fountain screenplay."); return; }
  if (file.size > 50 * 1024 * 1024) { showToast("That file is unusually large. Choose a screenplay under 50 MB."); return; }
  try {
    showToast(file.name.toLowerCase().endsWith(".pdf") ? "Reading PDF…" : "Reading screenplay…", 12000);
    const id = await hashFile(file); let record = null;
    try { record = await loadScreenplay(id); } catch { /* New or damaged local record. */ }
    if (!record) record = { id, filename: file.name, script: await parseScreenplay(file), preferences: defaultPreferences(), createdAt: Date.now(), schemaVersion: 2 };
    if (record.script.confidence?.reviewRecommended) {
      state.pendingRecord = record; elements.reviewMessage.textContent = record.script.confidence.warnings.join(" ") || "The screenplay structure looks unusual."; elements.reviewModal.hidden = false;
    } else await commitImport(record);
  } catch (error) {
    console.error("Could not open screenplay:", { name: error?.name, code: error?.code, message: error?.message }); showToast(errorMessage(error), 6500);
  } finally { elements.fileInput.value = ""; elements.replaceFileInput.value = ""; }
}

function showHome() { state.playbackToken += 1; setPlaying(false); closeCastModal(); if (state.record) populateResume(state.record); elements.player.hidden = true; elements.headerActions.hidden = true; elements.landing.hidden = false; }

function voiceOptions(selectedId) {
  return state.voices[state.providerId].map((voice) => { const option = document.createElement("option"); option.value = voice.id; option.textContent = `${voice.name}${voice.language ? ` · ${voice.language}` : ""}`; option.selected = voice.id === selectedId; return option; });
}

function renderVoiceList() {
  elements.voiceList.replaceChildren();
  const roles = [{ id: "NARRATOR", name: "Narrator", detail: "Scenes, action & transitions" }, ...state.record.script.characters.map((character) => ({ ...character, detail: "Character" }))];
  const fragment = document.createDocumentFragment();
  roles.forEach((role) => {
    const row = document.createElement("div"); row.className = "voice-row";
    const identity = document.createElement("div"); identity.className = "voice-identity"; const strong = document.createElement("strong"); strong.textContent = role.name; const detail = document.createElement("span"); detail.textContent = role.detail; identity.append(strong, detail);
    const select = document.createElement("select"); select.setAttribute("aria-label", `${role.name} voice`); select.append(...voiceOptions(assignmentFor(role.id).voiceId));
    select.addEventListener("change", () => { state.voiceAssignments[role.id] = { provider: state.providerId, voiceId: select.value }; queueSave(); });
    const preview = document.createElement("button"); preview.type = "button"; preview.className = "preview-voice"; preview.setAttribute("aria-label", `Preview ${role.name} voice`); preview.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M11 5 6.5 9H3v6h3.5l4.5 4zM15 9a4 4 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11"/></svg>';
    preview.addEventListener("click", () => previewVoice(role, select.value, preview)); row.append(identity, select, preview); fragment.appendChild(row);
  });
  elements.voiceList.appendChild(fragment);
}

async function previewVoice(role, voiceId, button) {
  const text = role.id === "NARRATOR" ? "The city settles into the blue hour." : `This is ${role.name}.`;
  button.disabled = true;
  try {
    if (state.providerId === "browser") browserProvider.speak(text, { voiceId, rate: state.rate });
    else {
      const key = await audioCacheKey({ provider: "elevenlabs", model: premiumProvider.model, voiceId, text, settings: { preview: true } });
      let blob = await getCachedAudio(key); if (!blob) { blob = await premiumProvider.generateSpeech({ text, voiceId }); await putCachedAudio(key, blob, { preview: true }); }
      await audioPlayer.load(blob, { rate: state.rate }); await audioPlayer.play();
    }
  } catch (error) { showToast(error.message || "That voice could not be previewed."); }
  finally { button.disabled = false; }
}

function openCastModal() { if (!state.record) return; state.lastFocused = document.activeElement; state.playbackToken += 1; setPlaying(false); elements.providerSelect.value = state.providerId; elements.providerSelect.querySelector('[value="elevenlabs"]').disabled = !state.premiumReady; renderVoiceList(); elements.castModal.hidden = false; elements.closeCastButton.focus(); }
function closeCastModal() { if (elements.castModal.hidden) return; browserProvider.stop(); audioPlayer?.pause(); elements.castModal.hidden = true; state.lastFocused?.focus?.(); }

function changeProvider(providerId) {
  if (providerId === "elevenlabs" && !state.premiumReady) { elements.providerSelect.value = "browser"; showToast("Premium audio is not connected yet."); return; }
  state.providerId = providerId; state.chunkPosition = 0; ensureDefaultAssignments(); renderVoiceList(); updateNowPlaying(); queueSave();
}

function openFallback(error) { elements.fallbackMessage.textContent = error instanceof PremiumTtsError ? error.message : "That premium passage could not be played. You can retry or continue with a device voice."; elements.fallbackModal.hidden = false; elements.fallbackRetry.focus(); }
function closeFallback() { elements.fallbackModal.hidden = true; }

function populateResume(record) {
  const progress = Math.round(((record.preferences?.currentIndex || 0) / Math.max(1, record.script.units.length - 1)) * 100);
  elements.resumeTitle.textContent = record.script.title; elements.resumeDetail.textContent = progress > 1 ? `${progress}% complete` : "Ready to begin"; elements.resumeProgress.style.width = `${progress}%`; elements.resumeFormat.textContent = record.script.format?.toUpperCase() || "SCRIPT"; elements.resumeCard.hidden = false; elements.resumeButton.onclick = () => openRecord(record);
}

function updateMediaSession() {
  if (!navigator.mediaSession || !state.record) return;
  const chunk = currentChunk();
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: state.record.script.title, artist: chunk?.speaker || "Narrator", album: chunk?.scene || "SpokenFrame", artwork: [{ src: new URL("assets/logo.svg", document.baseURI).href, sizes: "512x512", type: "image/svg+xml" }] });
    if (audioPlayer?.duration) navigator.mediaSession.setPositionState({ duration: audioPlayer.duration, playbackRate: state.rate, position: Math.min(audioPlayer.currentTime, audioPlayer.duration) });
  } catch { /* Some browsers expose only part of Media Session. */ }
}

function setupMediaSession() {
  if (!navigator.mediaSession) return;
  const handlers = { play: () => { if (!state.isPlaying) playCurrent(); }, pause: () => { if (state.isPlaying) togglePlayback(); }, previoustrack: () => move(-1), nexttrack: () => move(1) };
  Object.entries(handlers).forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ } });
}

function bindEvents() {
  elements.fileInput.addEventListener("change", (event) => handleFile(event.target.files[0])); elements.replaceFileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
  elements.playButton.addEventListener("click", togglePlayback); elements.previousButton.addEventListener("click", () => move(-1)); elements.nextButton.addEventListener("click", () => move(1)); elements.brandButton.addEventListener("click", showHome);
  elements.castButton.addEventListener("click", openCastModal); elements.closeCastButton.addEventListener("click", closeCastModal); elements.doneCastButton.addEventListener("click", closeCastModal); elements.castModal.addEventListener("click", (event) => { if (event.target === elements.castModal) closeCastModal(); });
  elements.providerSelect.addEventListener("change", () => changeProvider(elements.providerSelect.value));
  elements.autoAssignButton.addEventListener("click", () => { ensureDefaultAssignments(true, true); renderVoiceList(); queueSave(); showToast("Voices automatically assigned."); });
  elements.speedSelect.addEventListener("change", () => { state.rate = Number(elements.speedSelect.value) || 1; audioPlayer?.setRate(state.rate); updateNowPlaying(); queueSave(); });
  elements.sceneSelect.addEventListener("change", () => jumpToUnit(Number(elements.sceneSelect.value) || 0)); elements.progressSlider.addEventListener("input", () => jumpToUnit(Number(elements.progressSlider.value) || 0));
  elements.scriptPages.addEventListener("click", (event) => { const unit = event.target.closest("[data-index]"); if (unit) jumpToUnit(Number(unit.dataset.index)); });
  elements.reviewCancel.addEventListener("click", () => { state.pendingRecord = null; elements.reviewModal.hidden = true; }); elements.reviewContinue.addEventListener("click", async () => { const record = state.pendingRecord; state.pendingRecord = null; elements.reviewModal.hidden = true; if (record) await commitImport(record); });
  elements.fallbackRetry.addEventListener("click", () => { closeFallback(); playCurrent(); }); elements.fallbackDevice.addEventListener("click", () => { closeFallback(); state.providerId = "browser"; ensureDefaultAssignments(); updateNowPlaying(); queueSave(); playCurrent(); });
  ["dragenter", "dragover"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); })); elements.dropZone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
  document.addEventListener("keydown", (event) => { const interactive = /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName); if (event.key === "Escape") { closeCastModal(); closeFallback(); } if (!state.record || interactive || !elements.castModal.hidden || !elements.fallbackModal.hidden) return; if (event.code === "Space") { event.preventDefault(); togglePlayback(); } if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); } if (event.key === "ArrowRight") { event.preventDefault(); move(1); } });
  window.addEventListener("pagehide", () => saveState());
  audioPlayer?.setHandlers({ onEnd: advanceAfterEnd, onTime: (position) => { state.chunkPosition = position; updateMediaSession(); queueSave(); }, onError: (error) => { if (state.isPlaying) { setPlaying(false); openFallback(error); } } });
}

async function initProviders() {
  state.voices.browser = await browserProvider.getVoices();
  if (premiumProvider.configured && audioPlayer) {
    try { state.voices.elevenlabs = await premiumProvider.getVoices(); state.premiumReady = state.voices.elevenlabs.length > 0; }
    catch (error) { console.warn("Premium audio is not ready:", { code: error?.code, message: error?.message }); }
  }
  if (!state.voices.browser.length && !state.premiumReady) showToast("No speech voices are available. Try current Chrome, Edge, or Safari.", 6500);
}

async function init() {
  bindEvents(); setupMediaSession(); await initProviders();
  try { const last = await loadLastScreenplay(); if (last) populateResume(last); }
  catch (error) { console.warn("Saved screenplay could not be restored:", error); showToast("A saved screenplay could not be restored. You can import it again.", 5000); }
}

init();
