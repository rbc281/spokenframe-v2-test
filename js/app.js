import { AudioCache } from "./audio-cache.js";
import { buildAudioChunks, chunkIndexForUnit } from "./audio-chunks.js";
import { AudioPlayer } from "./audio-player.js";
import { SPOKENFRAME_CONFIG } from "./config.js";
import { parseScreenplay, ScreenplayParseError, supportedFile } from "./parsers/parser-registry.js";
import {
  SPEECH_NORMALIZATION_VERSION,
  adjacentSceneUnit,
  estimatePremiumCredits,
  estimateRemainingSeconds,
  progressPercent,
  progressSummary,
  sortedCastCharacters,
  spokenTextForChunk
} from "./playback-utils.js";
import { BrowserTtsProvider } from "./tts/browser-provider.js";
import { ElevenLabsProvider, PremiumTtsError } from "./tts/elevenlabs-provider.js";
import { audioCacheKey, hashFile, loadLastScreenplay, loadScreenplay, saveScreenplay } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  landing: $("#landing-view"), player: $("#player-view"), headerActions: $("#player-header-actions"), fileInput: $("#file-input"), replaceFileInput: $("#replace-file-input"), dropZone: $("#drop-zone"),
  uploadTitle: $("#upload-title"), uploadButtonLabel: $("#upload-button-label"), resumeCard: $("#resume-card"), resumeTitle: $("#resume-title"), resumeDetail: $("#resume-detail"), resumeProgress: $("#resume-progress"), resumeButton: $("#resume-button"), resumeFormat: $("#resume-format"),
  brandButton: $("#brand-button"), scriptTitle: $("#script-title"), scriptFormat: $("#script-format"), scriptMeta: $("#script-meta"), scriptPages: $("#script-pages"),
  currentScene: $("#current-scene"), currentSpeaker: $("#current-speaker"), nowPlaying: $("#now-playing-heading"), passageKind: $("#passage-kind"), audioStatus: $("#audio-status"),
  playButton: $("#play-button"), previousSceneButton: $("#previous-scene-button"), nextSceneButton: $("#next-scene-button"), backThreeButton: $("#back-three-button"), forwardThreeButton: $("#forward-three-button"),
  progressSlider: $("#progress-slider"), progressSummary: $("#progress-summary"), sceneSelect: $("#scene-select"), speedSelect: $("#speed-select"), toast: $("#toast"),
  castButton: $("#cast-button"), castModal: $("#cast-modal"), voiceList: $("#voice-list"), closeCastButton: $("#close-cast-button"), doneCastButton: $("#done-cast-button"), autoAssignButton: $("#auto-assign-button"),
  providerOptions: [...document.querySelectorAll('input[name="audio-quality"]')], readCharacterNames: $("#read-character-names"), premiumEstimate: $("#premium-estimate"),
  reviewModal: $("#review-modal"), reviewMessage: $("#review-message"), reviewCancel: $("#review-cancel"), reviewContinue: $("#review-continue"),
  fallbackModal: $("#fallback-modal"), fallbackMessage: $("#fallback-message"), fallbackDevice: $("#fallback-device"), fallbackRetry: $("#fallback-retry")
};

const browserProvider = new BrowserTtsProvider();
const premiumProvider = new ElevenLabsProvider({ workerUrl: SPOKENFRAME_CONFIG.workerUrl });
const canUseAudio = typeof globalThis.Audio === "function" || typeof window.Audio === "function";
const AudioConstructor = globalThis.Audio || window.Audio;
const audioPlayer = canUseAudio ? new AudioPlayer(new AudioConstructor()) : null;
const previewPlayer = canUseAudio ? new AudioPlayer(new AudioConstructor()) : null;
const audioCache = new AudioCache();
const state = {
  record: null, chunks: [], chunkIndex: 0, index: 0, isPlaying: false, isBuffering: false, rate: 1, providerId: "browser",
  readCharacterNames: false, voices: { browser: [], elevenlabs: [] }, premiumReady: false, voiceAssignments: {}, chunkPosition: 0,
  controllers: new Map(), chunkDurations: new Map(), saveTimer: null, lastFocused: null, pendingRecord: null,
  playbackToken: 0, previewToken: 0, previewController: null, previewButton: null
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

function defaultPreferences() {
  return { currentIndex: 0, chunkIndex: 0, chunkPosition: 0, rate: 1, provider: state.premiumReady ? "elevenlabs" : "browser", readCharacterNames: false, voiceAssignments: {} };
}
function currentChunk() { return state.chunks[state.chunkIndex]; }
function spokenChunkText(chunk = currentChunk()) { return spokenTextForChunk(chunk, { readCharacterNames: state.readCharacterNames }); }
function assignmentFor(roleId) {
  const saved = state.voiceAssignments[roleId];
  if (typeof saved === "string" && state.providerId === "browser") return { provider: "browser", voiceId: saved };
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
  elements.progressSlider.max = String(Math.max(0, script.units.length - 1));
}

function updateProgress() {
  if (!state.record) return;
  const remainingSeconds = estimateRemainingSeconds(state.chunks, {
    chunkIndex: state.chunkIndex,
    chunkPosition: state.chunkPosition,
    rate: state.rate,
    durationForChunk: (index) => state.chunkDurations.get(index) || 0,
    readCharacterNames: state.readCharacterNames
  });
  elements.progressSummary.textContent = progressSummary({ currentIndex: state.index, unitCount: state.record.script.units.length, remainingSeconds });
}

function updateNowPlaying({ scroll = false } = {}) {
  if (!state.record?.script.units.length) return;
  const chunk = currentChunk();
  if (chunk) state.index = chunk.unitIndices[0];
  const unit = state.record.script.units[state.index];
  elements.currentScene.textContent = unit.scene || "Opening";
  elements.currentSpeaker.textContent = chunk?.speaker || (unit.type === "dialogue" ? unit.displayCue : "Narrator");
  elements.nowPlaying.textContent = chunk ? chunk.unitIndices.map((index) => state.record.script.units[index].text).join(" ") : unit.text;
  elements.passageKind.textContent = unitLabel(unit); elements.progressSlider.value = String(state.index); elements.speedSelect.value = String(state.rate);
  elements.audioStatus.textContent = state.isBuffering ? "Preparing audio…" : state.providerId === "elevenlabs" ? "Premium Audio" : "Standard Audio";
  elements.scriptPages.querySelectorAll(".is-active").forEach((element) => element.classList.remove("is-active"));
  const indices = chunk?.unitIndices || [state.index];
  indices.forEach((index) => document.getElementById(state.record.script.units[index].id)?.classList.add("is-active"));
  const firstActive = document.getElementById(state.record.script.units[indices[0]].id);
  if (scroll) firstActive?.scrollIntoView({ behavior: "smooth", block: "center" });
  const scene = [...state.record.script.scenes].reverse().find((item) => item.unitIndex <= state.index);
  if (scene) elements.sceneSelect.value = String(scene.unitIndex);
  updateProgress(); updateMediaSession(); queueSave();
}

function setBuffering(value) { state.isBuffering = value; elements.playButton.classList.toggle("is-loading", value); updateNowPlaying(); }
function setPlaying(value, { stop = true } = {}) {
  state.isPlaying = value; elements.playButton.classList.toggle("is-playing", value); elements.playButton.setAttribute("aria-label", value ? "Pause" : "Play");
  if (!value && stop) { browserProvider.stop(); audioPlayer?.pause(); }
  if (navigator.mediaSession) navigator.mediaSession.playbackState = value ? "playing" : "paused";
}

async function cacheIdentity(chunk) {
  const assignment = assignmentFor(chunk.roleId);
  return audioCacheKey({
    provider: "elevenlabs",
    model: premiumProvider.model,
    voiceId: assignment.voiceId,
    text: spokenChunkText(chunk),
    settings: { format: "mp3_44100_128", readCharacterNames: state.readCharacterNames, normalizationVersion: SPEECH_NORMALIZATION_VERSION }
  });
}

async function getPremiumAudio(chunkIndex, { foreground = false } = {}) {
  const chunk = state.chunks[chunkIndex];
  if (!chunk) return null;
  const key = await cacheIdentity(chunk);
  const assignment = assignmentFor(chunk.roleId);
  const promise = audioCache.getOrCreate(key, async () => {
    const controller = new AbortController(); state.controllers.set(key, controller);
    try { return await premiumProvider.generateSpeech({ text: spokenChunkText(chunk), voiceId: assignment.voiceId, signal: controller.signal }); }
    finally { state.controllers.delete(key); }
  }, { screenplayId: state.record.id, chunkIndex, roleId: chunk.roleId, model: premiumProvider.model });
  promise.then((entry) => { if (entry.metadata?.duration) state.chunkDurations.set(chunkIndex, entry.metadata.duration); }).catch(() => {});
  if (!foreground) promise.catch(() => {});
  return promise;
}

function prefetchUpcoming() {
  if (state.providerId !== "elevenlabs") return;
  const next = state.chunkIndex + 1;
  if (state.chunks[next]) getPremiumAudio(next).catch(() => {});
}

function cancelDistantGeneration() {
  for (const controller of state.controllers.values()) controller.abort();
  state.controllers.clear();
}

function stopPreview() {
  state.previewToken += 1;
  state.previewController?.abort(); state.previewController = null;
  browserProvider.stop(); previewPlayer?.pause();
  if (state.previewButton) {
    state.previewButton.disabled = false;
    state.previewButton.classList.remove("is-previewing");
    state.previewButton = null;
  }
}

async function playPremium(token) {
  if (!state.premiumReady || !audioPlayer) throw new PremiumTtsError("unavailable", "Premium audio is temporarily unavailable.");
  setBuffering(true);
  const generated = await getPremiumAudio(state.chunkIndex, { foreground: true });
  if (token !== state.playbackToken || !state.isPlaying) return;
  try {
    await audioPlayer.load(generated.blob, { rate: state.rate, position: state.chunkPosition });
    if (audioPlayer.duration) {
      state.chunkDurations.set(state.chunkIndex, audioPlayer.duration);
      audioCache.updateMetadata(generated.key, { duration: audioPlayer.duration }).catch(() => {});
    }
  } catch (error) {
    await audioCache.delete(generated.key).catch(() => {});
    throw error;
  }
  if (token !== state.playbackToken || !state.isPlaying) return;
  setBuffering(false); await audioPlayer.play(); prefetchUpcoming();
}

function playDevice(token) {
  const chunk = currentChunk();
  browserProvider.speak(spokenChunkText(chunk), {
    voiceId: assignmentFor(chunk.roleId).voiceId, rate: state.rate,
    onEnd: () => { if (token === state.playbackToken && state.isPlaying) advanceAfterEnd(); },
    onError: () => { if (token === state.playbackToken) { setPlaying(false); showToast("Standard Audio stopped. Tap Play to continue."); } }
  });
}

async function playCurrent() {
  if (!state.record || !currentChunk()) return;
  stopPreview();
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
  if (state.isPlaying) {
    state.playbackToken += 1;
    state.chunkPosition = state.providerId === "elevenlabs" ? (audioPlayer?.currentTime || 0) : 0;
    setPlaying(false); queueSave(100);
  } else playCurrent();
}

function advanceAfterEnd() {
  if (!state.isPlaying) return;
  state.chunkPosition = 0;
  if (state.chunkIndex >= state.chunks.length - 1) { setPlaying(false); showToast("Screenplay finished."); return; }
  state.chunkIndex += 1; state.index = currentChunk().unitIndices[0]; playCurrent();
}

function jumpToUnit(unitIndex, autoplay = state.isPlaying) {
  state.playbackToken += 1; setPlaying(false); cancelDistantGeneration();
  state.chunkIndex = chunkIndexForUnit(state.chunks, Math.max(0, Math.min(state.record.script.units.length - 1, unitIndex)));
  state.chunkPosition = 0; state.index = currentChunk().unitIndices[0]; updateNowPlaying({ scroll: true });
  if (autoplay) playCurrent();
}

function movePassages(direction) {
  if (!state.record) return;
  jumpToUnit(state.index + direction * 3);
}

function moveScene(direction) {
  if (!state.record) return;
  jumpToUnit(adjacentSceneUnit(state.record.script.scenes, state.index, direction));
}

function queueSave(delay = 450) {
  if (!state.record) return;
  state.record.preferences = currentPreferences();
  clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveState, delay);
}
function currentPreferences() {
  return {
    currentIndex: state.index, chunkIndex: state.chunkIndex,
    chunkPosition: state.providerId === "elevenlabs" ? (audioPlayer?.currentTime || state.chunkPosition) : 0,
    rate: state.rate, provider: state.providerId, readCharacterNames: state.readCharacterNames, voiceAssignments: state.voiceAssignments
  };
}
async function saveState() {
  if (!state.record) return;
  state.record.preferences = currentPreferences();
  try { state.record = await saveScreenplay(state.record); } catch { /* Playback remains usable without persistence. */ }
}

async function openRecord(record) {
  state.playbackToken += 1; stopPreview(); setPlaying(false); cancelDistantGeneration(); state.record = record; state.chunks = buildAudioChunks(record.script.units); state.chunkDurations.clear();
  const preferences = { ...defaultPreferences(), ...(record.preferences || {}) };
  state.index = Number.isInteger(preferences.currentIndex) ? Math.min(preferences.currentIndex, record.script.units.length - 1) : 0;
  state.chunkIndex = Number.isInteger(preferences.chunkIndex) && state.chunks[preferences.chunkIndex]?.unitIndices.includes(state.index) ? preferences.chunkIndex : chunkIndexForUnit(state.chunks, state.index);
  state.chunkPosition = Number(preferences.chunkPosition) || 0; state.rate = Number(preferences.rate) || 1;
  state.providerId = preferences.provider === "elevenlabs" && state.premiumReady ? "elevenlabs" : "browser";
  state.readCharacterNames = preferences.readCharacterNames === true; state.voiceAssignments = preferences.voiceAssignments || {}; ensureDefaultAssignments();
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

function showHome() {
  state.playbackToken += 1; setPlaying(false); cancelDistantGeneration(); closeCastModal();
  if (state.record) populateResume(state.record);
  elements.player.hidden = true; elements.headerActions.hidden = true; elements.landing.hidden = false;
}

function voiceOptions(selectedId) {
  return state.voices[state.providerId].map((voice) => {
    const option = document.createElement("option"); option.value = voice.id; option.textContent = `${voice.name}${voice.language ? ` · ${voice.language}` : ""}`; option.selected = voice.id === selectedId; return option;
  });
}

function invalidateRoleDurations(roleId) {
  state.chunks.forEach((chunk, index) => { if (chunk.roleId === roleId) state.chunkDurations.delete(index); });
}

function renderVoiceList() {
  elements.voiceList.replaceChildren();
  const roles = [{ id: "NARRATOR", name: "Narrator", detail: "Scenes, action & transitions" }, ...sortedCastCharacters(state.record.script).map((character) => ({ ...character, detail: "Character" }))];
  const fragment = document.createDocumentFragment();
  roles.forEach((role) => {
    const row = document.createElement("div"); row.className = "voice-row";
    const identity = document.createElement("div"); identity.className = "voice-identity"; const strong = document.createElement("strong"); strong.textContent = role.name; const detail = document.createElement("span"); detail.textContent = role.detail; identity.append(strong, detail);
    const select = document.createElement("select"); select.setAttribute("aria-label", `${role.name} voice`); select.append(...voiceOptions(assignmentFor(role.id).voiceId));
    select.addEventListener("change", () => {
      stopPreview(); cancelDistantGeneration(); state.voiceAssignments[role.id] = { provider: state.providerId, voiceId: select.value }; invalidateRoleDurations(role.id); updatePremiumEstimate(); queueSave();
    });
    const preview = document.createElement("button"); preview.type = "button"; preview.className = "preview-voice"; preview.setAttribute("aria-label", `Preview ${role.name} voice`); preview.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M11 5 6.5 9H3v6h3.5l4.5 4zM15 9a4 4 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11"/></svg>';
    preview.addEventListener("click", () => previewVoice(select.value, preview)); row.append(identity, select, preview); fragment.appendChild(row);
  });
  elements.voiceList.appendChild(fragment);
}

function finishPreview(token) {
  if (token !== state.previewToken) return;
  if (state.previewButton) {
    state.previewButton.disabled = false;
    state.previewButton.classList.remove("is-previewing");
    state.previewButton = null;
  }
}

async function previewVoice(voiceId, button) {
  state.playbackToken += 1;
  if (state.providerId === "elevenlabs") state.chunkPosition = audioPlayer?.currentTime || state.chunkPosition;
  setPlaying(false); stopPreview();
  const token = ++state.previewToken;
  state.previewButton = button; button.disabled = true; button.classList.add("is-previewing");
  const text = "This is how this voice sounds in SpokenFrame.";
  if (state.providerId === "browser") {
    browserProvider.speak(text, {
      voiceId, rate: state.rate,
      onEnd: () => finishPreview(token),
      onError: () => { finishPreview(token); showToast("That voice could not be previewed."); }
    });
    return;
  }
  const controller = new AbortController(); state.previewController = controller;
  try {
    const key = await audioCacheKey({ provider: "elevenlabs", model: premiumProvider.model, voiceId, text, settings: { preview: true, normalizationVersion: SPEECH_NORMALIZATION_VERSION } });
    const entry = await audioCache.getOrCreate(
      key,
      () => premiumProvider.generateSpeech({ text, voiceId, signal: controller.signal }),
      { preview: true, model: premiumProvider.model }
    );
    if (token !== state.previewToken) return;
    await previewPlayer.load(entry.blob, { rate: state.rate }); await previewPlayer.play();
  } catch (error) {
    if (error?.name !== "AbortError") showToast(error instanceof PremiumTtsError ? error.message : "That voice could not be previewed.");
    finishPreview(token);
  } finally {
    if (state.previewController === controller) state.previewController = null;
  }
}

function syncProviderControls() {
  elements.providerOptions.forEach((option) => {
    option.checked = option.value === state.providerId;
    if (option.value === "elevenlabs") option.disabled = !state.premiumReady;
  });
}

function updatePremiumEstimate() {
  if (!state.record) return;
  const credits = estimatePremiumCredits(state.chunks, { model: premiumProvider.model, readCharacterNames: state.readCharacterNames });
  elements.premiumEstimate.querySelector("strong").textContent = `~${credits.toLocaleString()} credits`;
}

function openCastModal() {
  if (!state.record) return;
  state.lastFocused = document.activeElement;
  state.playbackToken += 1;
  if (state.providerId === "elevenlabs") state.chunkPosition = audioPlayer?.currentTime || state.chunkPosition;
  setPlaying(false); stopPreview(); cancelDistantGeneration(); syncProviderControls(); elements.readCharacterNames.checked = state.readCharacterNames;
  updatePremiumEstimate(); renderVoiceList(); elements.castModal.hidden = false; elements.closeCastButton.focus(); queueSave();
}
function closeCastModal() {
  if (elements.castModal.hidden) return;
  stopPreview(); elements.castModal.hidden = true; state.lastFocused?.focus?.(); queueSave();
}

function changeProvider(providerId) {
  stopPreview(); cancelDistantGeneration();
  if (providerId === "elevenlabs" && !state.premiumReady) { state.providerId = "browser"; syncProviderControls(); showToast("Premium Audio isn’t available yet."); return; }
  state.providerId = providerId; state.chunkPosition = 0; state.chunkDurations.clear(); ensureDefaultAssignments(); syncProviderControls(); renderVoiceList(); updateNowPlaying(); updatePremiumEstimate(); queueSave();
}

function openFallback(error) {
  elements.fallbackMessage.textContent = error instanceof PremiumTtsError ? `${error.message} You can try again or use Standard Audio.` : "That premium passage could not be played. You can try again or use Standard Audio.";
  elements.fallbackModal.hidden = false; elements.fallbackRetry.focus();
}
function closeFallback() { elements.fallbackModal.hidden = true; }

function populateResume(record) {
  const prefs = record.preferences || {};
  const currentIndex = prefs.currentIndex || 0;
  const progress = progressPercent(currentIndex, record.script.units.length);
  const scene = [...record.script.scenes].reverse().find((item) => item.unitIndex <= currentIndex)?.title || "Opening";
  elements.resumeTitle.textContent = record.script.title;
  elements.resumeDetail.textContent = progress > 0 ? `${progress}% · ${scene}` : "Ready to begin";
  elements.resumeProgress.style.width = `${progress}%`; elements.resumeFormat.textContent = record.script.format?.toUpperCase() || "SCRIPT"; elements.resumeCard.hidden = false;
  elements.resumeButton.setAttribute("aria-label", `Continue ${record.script.title}`); elements.resumeButton.onclick = () => openRecord(record);
  elements.landing.classList.add("has-resume"); elements.uploadTitle.textContent = "Open a different screenplay"; elements.uploadButtonLabel.textContent = "Choose another screenplay";
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
  const handlers = {
    play: () => { if (!state.isPlaying) playCurrent(); },
    pause: () => { if (state.isPlaying) togglePlayback(); },
    previoustrack: () => moveScene(-1),
    nexttrack: () => moveScene(1),
    seekbackward: () => movePassages(-1),
    seekforward: () => movePassages(1)
  };
  Object.entries(handlers).forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ } });
}

function bindEvents() {
  elements.fileInput.addEventListener("change", (event) => handleFile(event.target.files[0])); elements.replaceFileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
  elements.playButton.addEventListener("click", togglePlayback); elements.previousSceneButton.addEventListener("click", () => moveScene(-1)); elements.nextSceneButton.addEventListener("click", () => moveScene(1));
  elements.backThreeButton.addEventListener("click", () => movePassages(-1)); elements.forwardThreeButton.addEventListener("click", () => movePassages(1)); elements.brandButton.addEventListener("click", showHome);
  elements.castButton.addEventListener("click", openCastModal); elements.closeCastButton.addEventListener("click", closeCastModal); elements.doneCastButton.addEventListener("click", closeCastModal); elements.castModal.addEventListener("click", (event) => { if (event.target === elements.castModal) closeCastModal(); });
  elements.providerOptions.forEach((option) => option.addEventListener("change", () => { if (option.checked) changeProvider(option.value); }));
  elements.readCharacterNames.addEventListener("change", () => { cancelDistantGeneration(); state.readCharacterNames = elements.readCharacterNames.checked; state.chunkDurations.clear(); updatePremiumEstimate(); updateProgress(); queueSave(); });
  elements.autoAssignButton.addEventListener("click", () => { stopPreview(); cancelDistantGeneration(); ensureDefaultAssignments(true, true); state.chunkDurations.clear(); renderVoiceList(); queueSave(); showToast("Voices automatically assigned."); });
  elements.speedSelect.addEventListener("change", () => { state.rate = Number(elements.speedSelect.value) || 1; audioPlayer?.setRate(state.rate); updateProgress(); updateMediaSession(); queueSave(); });
  elements.sceneSelect.addEventListener("change", () => jumpToUnit(Number(elements.sceneSelect.value) || 0)); elements.progressSlider.addEventListener("input", () => jumpToUnit(Number(elements.progressSlider.value) || 0));
  elements.scriptPages.addEventListener("click", (event) => { const unit = event.target.closest("[data-index]"); if (unit) jumpToUnit(Number(unit.dataset.index)); });
  elements.reviewCancel.addEventListener("click", () => { state.pendingRecord = null; elements.reviewModal.hidden = true; }); elements.reviewContinue.addEventListener("click", async () => { const record = state.pendingRecord; state.pendingRecord = null; elements.reviewModal.hidden = true; if (record) await commitImport(record); });
  elements.fallbackRetry.addEventListener("click", () => { closeFallback(); playCurrent(); }); elements.fallbackDevice.addEventListener("click", () => { closeFallback(); state.providerId = "browser"; state.chunkDurations.clear(); ensureDefaultAssignments(); updateNowPlaying(); queueSave(); playCurrent(); });
  ["dragenter", "dragover"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); })); elements.dropZone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
  document.addEventListener("keydown", (event) => {
    const interactive = /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName);
    if (event.key === "Escape") { closeCastModal(); closeFallback(); }
    if (!state.record || interactive || !elements.castModal.hidden || !elements.fallbackModal.hidden) return;
    if (event.code === "Space") { event.preventDefault(); togglePlayback(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); movePassages(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); movePassages(1); }
  });
  window.addEventListener("pagehide", () => saveState());
  audioPlayer?.setHandlers({
    onEnd: () => { if (state.isPlaying) advanceAfterEnd(); },
    onTime: (position) => { if (!state.isPlaying) return; state.chunkPosition = position; updateProgress(); updateMediaSession(); queueSave(1800); },
    onError: (error) => { if (state.isPlaying) { setPlaying(false); openFallback(error); } }
  });
  previewPlayer?.setHandlers({ onEnd: () => finishPreview(state.previewToken), onError: () => { finishPreview(state.previewToken); showToast("That voice could not be previewed."); } });
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
