import { AudioCache } from "./audio-cache.js";
import { buildAudioChunks, chunkIndexForUnit } from "./audio-chunks.js";
import { AudioPlayer } from "./audio-player.js";
import { AccountSessionService } from "./account/account-session.js";
import { SupabaseLibraryRepository } from "./account/library-repository.js";
import { applyCloudPreferences } from "./account/library-model.js";
import { PrivateCloudStorage } from "./account/private-cloud-storage.js";
import { createSpokenFrameSupabaseClient } from "./account/supabase-client.js";
import { PremiumAccessService } from "./billing/premium-access.js";
import { screenplayPageDetails } from "./billing/screenplay-page-count.js";
import { SPOKENFRAME_CONFIG } from "./config.js";
import { parseScreenplay, ScreenplayParseError, supportedFile } from "./parsers/parser-registry.js";
import {
  SPEECH_NORMALIZATION_VERSION,
  adjacentSceneUnit,
  estimateRemainingSeconds,
  progressPercent,
  progressSummary,
  sortedCastCharacters,
  spokenTextForChunk
} from "./playback-utils.js";
import { BrowserTtsProvider } from "./tts/browser-provider.js";
import { ElevenLabsProvider, PremiumTtsError } from "./tts/elevenlabs-provider.js";
import { audioCacheKey, hashFile, loadLastScreenplay, loadScreenplay, saveScreenplay } from "./storage.js";
import { premiumPrice } from "../shared/premium-pricing.js";

const $ = (selector) => document.querySelector(selector);
const PREMIUM_INTENT_KEY = "spokenframe-premium-intent";

function savedPremiumIntent() {
  try { return window.sessionStorage.getItem(PREMIUM_INTENT_KEY) === "true"; }
  catch { return false; }
}

function setPendingPremiumIntent(value) {
  state.pendingPremiumIntent = value === true;
  try {
    if (state.pendingPremiumIntent) window.sessionStorage.setItem(PREMIUM_INTENT_KEY, "true");
    else window.sessionStorage.removeItem(PREMIUM_INTENT_KEY);
  } catch { /* Checkout still works when session storage is unavailable. */ }
}

const elements = {
  landing: $("#landing-view"), player: $("#player-view"), headerActions: $("#player-header-actions"), fileInput: $("#file-input"), replaceFileInput: $("#replace-file-input"), dropZone: $("#drop-zone"),
  uploadTitle: $("#upload-title"), uploadButtonLabel: $("#upload-button-label"), resumeCard: $("#resume-card"), resumeTitle: $("#resume-title"), resumeDetail: $("#resume-detail"), resumeProgress: $("#resume-progress"), resumeButton: $("#resume-button"), resumeFormat: $("#resume-format"),
  accountButton: $("#account-button"), accountButtonLabel: $("#account-button-label"), accountContext: $("#account-context"), accountContextTitle: $("#account-context-title"), accountContextCopy: $("#account-context-copy"), accountContextAction: $("#account-context-action"),
  librarySection: $("#library-section"), libraryList: $("#library-list"), libraryEmpty: $("#library-empty"), libraryRefreshButton: $("#library-refresh-button"),
  accountModal: $("#account-modal"), closeAccountButton: $("#close-account-button"), accountModalTitle: $("#account-modal-title"), accountModalCopy: $("#account-modal-copy"), accountForm: $("#account-form"), accountEmailField: $("#account-email-field"), accountEmail: $("#account-email"), accountPasswordField: $("#account-password-field"), accountPasswordLabel: $("#account-password-label"), accountPassword: $("#account-password"), accountConfirmField: $("#account-confirm-field"), accountPasswordConfirm: $("#account-password-confirm"), accountMessage: $("#account-message"), accountSubmit: $("#account-submit"), accountModeButton: $("#account-mode-button"), forgotPasswordButton: $("#forgot-password-button"), accountProfile: $("#account-profile"), accountProfileEmail: $("#account-profile-email"), accountInitial: $("#account-initial"), signOutButton: $("#sign-out-button"),
  brandButton: $("#brand-button"), scriptTitle: $("#script-title"), scriptFormat: $("#script-format"), scriptMeta: $("#script-meta"), scriptPages: $("#script-pages"),
  currentScene: $("#current-scene"), currentSpeaker: $("#current-speaker"), nowPlaying: $("#now-playing-heading"), passageKind: $("#passage-kind"), audioStatus: $("#audio-status"),
  playButton: $("#play-button"), previousSceneButton: $("#previous-scene-button"), nextSceneButton: $("#next-scene-button"), backThreeButton: $("#back-three-button"), forwardThreeButton: $("#forward-three-button"),
  progressSlider: $("#progress-slider"), progressSummary: $("#progress-summary"), sceneSelect: $("#scene-select"), speedSelect: $("#speed-select"), toast: $("#toast"),
  castButton: $("#cast-button"), castModal: $("#cast-modal"), voiceList: $("#voice-list"), closeCastButton: $("#close-cast-button"), doneCastButton: $("#done-cast-button"), autoAssignButton: $("#auto-assign-button"),
  providerOptions: [...document.querySelectorAll('input[name="audio-quality"]')], readCharacterNames: $("#read-character-names"), premiumEstimate: $("#premium-estimate"),
  reviewModal: $("#review-modal"), reviewMessage: $("#review-message"), reviewCancel: $("#review-cancel"), reviewContinue: $("#review-continue"),
  fallbackModal: $("#fallback-modal"), fallbackMessage: $("#fallback-message"), fallbackDevice: $("#fallback-device"), fallbackRetry: $("#fallback-retry"),
  premiumModal: $("#premium-modal"), premiumModalTitle: $("#premium-modal-title"), premiumModalCopy: $("#premium-modal-copy"), premiumPrice: $("#premium-price"), premiumMessage: $("#premium-message"), premiumUnlockButton: $("#premium-unlock-button"), premiumStandardButton: $("#premium-standard-button"), closePremiumButton: $("#close-premium-button")
};

const supabaseClient = createSpokenFrameSupabaseClient(SPOKENFRAME_CONFIG);
const accountSession = supabaseClient ? new AccountSessionService(supabaseClient, { redirectUrl: SPOKENFRAME_CONFIG.accountRedirectUrl }) : null;
const accountLibrary = accountSession ? new SupabaseLibraryRepository(supabaseClient, accountSession) : null;
const privateCloudStorage = accountSession ? new PrivateCloudStorage({
  workerUrl: SPOKENFRAME_CONFIG.workerUrl,
  tokenProvider: () => accountSession.accessToken()
}) : null;
const premiumAccess = accountSession ? new PremiumAccessService({
  workerUrl: SPOKENFRAME_CONFIG.workerUrl,
  tokenProvider: () => accountSession.accessToken()
}) : null;
const browserProvider = new BrowserTtsProvider();
const premiumProvider = new ElevenLabsProvider({
  workerUrl: SPOKENFRAME_CONFIG.workerUrl,
  tokenProvider: accountSession ? () => accountSession.accessToken() : null
});
const canUseAudio = typeof globalThis.Audio === "function" || typeof window.Audio === "function";
const AudioConstructor = globalThis.Audio || window.Audio;
const audioPlayer = canUseAudio ? new AudioPlayer(new AudioConstructor()) : null;
const previewPlayer = canUseAudio ? new AudioPlayer(new AudioConstructor()) : null;
const audioCache = new AudioCache();
const state = {
  record: null, chunks: [], chunkIndex: 0, index: 0, isPlaying: false, isBuffering: false, rate: 1, providerId: "browser", preferredProvider: "browser",
  readCharacterNames: false, voices: { browser: [], elevenlabs: [] }, premiumReady: false, voiceAssignments: {}, chunkPosition: 0,
  controllers: new Map(), chunkDurations: new Map(), saveTimer: null, lastFocused: null, pendingRecord: null,
  playbackToken: 0, previewToken: 0, previewController: null, previewButton: null,
  accountStatus: accountSession ? "loading" : "unavailable", accountUser: null, accountMode: "signin", accountLibrary: [], accountRequestBusy: false,
  cloudSaveTimer: null, cloudSaveSignature: "", cloudSaveRunning: false, cloudSavePending: false,
  cloudContentReady: new Set(), premiumEntitled: false, premiumAccessLoaded: false,
  premiumCheckoutAvailable: false, premiumRequestBusy: false, pendingPremiumIntent: savedPremiumIntent()
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

function accountScreenplayId(record = state.record) {
  const ownerId = state.accountUser?.id;
  if (!record || !ownerId) return "";
  return record.accountLinks?.[ownerId]
    || state.accountLibrary.find((item) => item.client_fingerprint === record.id)?.id
    || "";
}

function setAccountMessage(message = "", success = false) {
  elements.accountMessage.textContent = message;
  elements.accountMessage.hidden = !message;
  elements.accountMessage.classList.toggle("is-success", success);
}

function setAccountMode(mode, message = "") {
  state.accountMode = mode;
  elements.accountProfile.hidden = true;
  elements.accountForm.hidden = false;
  elements.accountEmailField.hidden = mode === "reset";
  elements.accountPasswordField.hidden = mode === "forgot";
  elements.accountConfirmField.hidden = !["signup", "reset"].includes(mode);
  elements.forgotPasswordButton.hidden = mode !== "signin";
  elements.accountPassword.autocomplete = mode === "signin" ? "current-password" : "new-password";
  elements.accountPasswordLabel.textContent = mode === "reset" ? "New password" : "Password";
  elements.accountPassword.value = "";
  elements.accountPasswordConfirm.value = "";
  const content = {
    signin: ["Welcome back", "Sign in to open your library and resume your screenplays.", "Sign in", "Create a free account"],
    signup: ["Create your free account", "Save your library, listening position, and preferences.", "Create account", "Already have an account? Sign in"],
    forgot: ["Reset your password", "We’ll email you a secure link to choose a new password.", "Send reset link", "Back to sign in"],
    reset: ["Choose a new password", "Use at least 8 characters, then return to your library.", "Update password", "Back to sign in"]
  }[mode] || null;
  if (!content) return;
  [elements.accountModalTitle.textContent, elements.accountModalCopy.textContent, elements.accountSubmit.textContent, elements.accountModeButton.textContent] = content;
  setAccountMessage(message, Boolean(message));
}

function openAccountModal(mode = "signin") {
  if (!accountSession) {
    showToast("Accounts are temporarily unavailable. You can continue listening as a guest.");
    return;
  }
  state.lastFocused = document.activeElement;
  if (state.accountStatus === "authenticated") {
    elements.accountForm.hidden = true;
    elements.accountProfile.hidden = false;
    elements.accountModalTitle.textContent = "Your account";
    elements.accountModalCopy.textContent = "Your listening library and preferences are saved here.";
    elements.accountProfileEmail.textContent = state.accountUser.email;
    elements.accountInitial.textContent = (state.accountUser.email?.[0] || "S").toUpperCase();
  } else {
    setAccountMode(mode);
  }
  elements.accountModal.hidden = false;
  (state.accountStatus === "authenticated" ? elements.signOutButton : (mode === "reset" ? elements.accountPassword : elements.accountEmail)).focus();
}

function closeAccountModal() {
  if (elements.accountModal.hidden) return;
  elements.accountModal.hidden = true;
  setAccountMessage();
  state.lastFocused?.focus?.();
}

function renderAccountState() {
  const authenticated = state.accountStatus === "authenticated" && state.accountUser;
  elements.accountButton.classList.toggle("is-authenticated", Boolean(authenticated));
  elements.accountButtonLabel.textContent = authenticated ? "Library" : "Sign in";
  elements.accountButton.setAttribute("aria-label", authenticated ? `Open account for ${state.accountUser.email}` : "Sign in or create an account");
  if (authenticated) {
    elements.accountContextTitle.textContent = `Signed in as ${state.accountUser.email}`;
    elements.accountContextCopy.textContent = "Your library, listening position, and preferences are saved to this account.";
    elements.accountContextAction.textContent = "View account";
    elements.librarySection.hidden = false;
  } else {
    elements.accountContextTitle.textContent = "Listening as Guest";
    elements.accountContextCopy.textContent = "Create a free account to save your progress and build your library.";
    elements.accountContextAction.textContent = "Create free account";
    elements.librarySection.hidden = true;
  }
}

function renderLibrary() {
  elements.libraryList.replaceChildren();
  elements.libraryEmpty.hidden = state.accountLibrary.length > 0;
  const fragment = document.createDocumentFragment();
  state.accountLibrary.forEach((entry) => {
    const progress = Math.max(0, Math.min(100, Number(entry.playback?.progress_percent) || 0));
    const scene = entry.playback?.current_scene || "Ready to begin";
    const card = document.createElement("article"); card.className = "library-item";
    const button = document.createElement("button"); button.type = "button"; button.className = "library-main"; button.setAttribute("aria-label", `Continue ${entry.title}`);
    const format = document.createElement("span"); format.className = "library-format"; format.textContent = String(entry.source_format || "script").toUpperCase();
    const copy = document.createElement("span"); copy.className = "library-copy";
    const title = document.createElement("strong"); title.textContent = entry.title;
    const detail = document.createElement("span"); detail.textContent = `${progress}% · ${scene}`;
    const status = document.createElement("span"); status.className = `library-status${entry.premium ? " is-premium" : ""}`; status.textContent = entry.premium ? "Premium" : "Standard";
    copy.append(title, detail, status); button.append(format, copy);
    button.addEventListener("click", () => openLibraryEntry(entry));
    const actions = document.createElement("span"); actions.className = "library-actions";
    const continueLabel = document.createElement("span"); continueLabel.className = "library-action"; continueLabel.textContent = "Continue"; actions.appendChild(continueLabel);
    if (!entry.premium) {
      const upgrade = document.createElement("button"); upgrade.type = "button"; upgrade.className = "library-upgrade";
      upgrade.textContent = `Upgrade · ${premiumPrice(entry.page_count).displayAmount}`;
      upgrade.addEventListener("click", async () => { if (await openLibraryEntry(entry)) openPremiumModal(); });
      actions.appendChild(upgrade);
    }
    card.append(button, actions); fragment.appendChild(card);
  });
  elements.libraryList.appendChild(fragment);
}

async function loadAccountLibrary({ quiet = false } = {}) {
  if (!accountLibrary || state.accountStatus !== "authenticated") return [];
  try {
    state.accountLibrary = await accountLibrary.listScreenplays();
    renderLibrary();
    return state.accountLibrary;
  } catch (error) {
    console.warn("Account library could not be loaded:", { code: error?.code, message: error?.message });
    if (!quiet) showToast(error?.message || "Your library couldn’t be loaded.");
    return [];
  }
}

async function hydrateRecordFromAccount(record) {
  if (!record || state.accountStatus !== "authenticated" || !accountLibrary) return record;
  const screenplayId = accountScreenplayId(record);
  if (!screenplayId) return record;
  try {
    const { playback, settings } = await accountLibrary.loadPreferences(screenplayId);
    const merged = applyCloudPreferences(record, playback, settings);
    merged.accountLinks = { ...(record.accountLinks || {}), [state.accountUser.id]: screenplayId };
    return await saveScreenplay(merged);
  } catch (error) {
    console.warn("Cloud preferences could not be restored:", { code: error?.code, message: error?.message });
    showToast("Your saved position couldn’t be reached. Continuing from this device.");
    return record;
  }
}

async function openLibraryEntry(entry) {
  try {
    let local = await loadScreenplay(entry.client_fingerprint);
    if (!local) {
      if (!privateCloudStorage) throw new Error("Private storage is unavailable.");
      showToast("Opening your private screenplay copy…", 12000);
      const stored = await privateCloudStorage.loadScreenplay(entry.id);
      if (stored.clientFingerprint !== entry.client_fingerprint || !stored.screenplay?.units?.length) {
        throw new Error("Private screenplay data did not match the library record.");
      }
      local = await saveScreenplay({
        id: stored.clientFingerprint,
        filename: `${entry.title || "Screenplay"}.${entry.source_format || "fdx"}`,
        script: stored.screenplay,
        preferences: defaultPreferences(),
        accountLinks: { [state.accountUser.id]: entry.id },
        createdAt: Date.now(),
        schemaVersion: 2
      });
      state.cloudContentReady.add(entry.id);
    }
    local.accountLinks = { ...(local.accountLinks || {}), [state.accountUser.id]: entry.id };
    await openRecord(await hydrateRecordFromAccount(local));
    await refreshPremiumAccess({ restorePreference: true });
    return true;
  } catch (error) {
    console.warn("Library screenplay could not be opened:", error);
    showToast(error?.message || "That screenplay couldn’t be opened from your private library.", 6500);
    return false;
  }
}

async function syncPrivateScreenplay(record, screenplayId) {
  if (!privateCloudStorage || !screenplayId || state.cloudContentReady.has(screenplayId)) return false;
  await privateCloudStorage.saveScreenplay(screenplayId, record);
  state.cloudContentReady.add(screenplayId);
  return true;
}

async function syncCurrentRecord({ includeMetadata = false, refreshLibrary = false } = {}) {
  if (!state.record || state.accountStatus !== "authenticated" || !accountLibrary || state.cloudSaveRunning) {
    if (state.cloudSaveRunning) state.cloudSavePending = true;
    return;
  }
  const record = state.record;
  const ownerId = state.accountUser.id;
  const screenplayId = accountScreenplayId(record);
  const signature = JSON.stringify({ id: record.id, ownerId, screenplayId, preferences: currentPreferences() });
  if (!includeMetadata && screenplayId && signature === state.cloudSaveSignature) return;
  state.cloudSaveRunning = true;
  try {
    let id = screenplayId;
    if (!id || includeMetadata) {
      const saved = await accountLibrary.saveScreenplay(record);
      id = saved.id;
    } else {
      await Promise.all([accountLibrary.savePlayback(record, id), accountLibrary.saveSettings(record, id)]);
    }
    record.accountLinks = { ...(record.accountLinks || {}), [ownerId]: id };
    if (state.record?.id === record.id) state.record = await saveScreenplay(record);
    try { await syncPrivateScreenplay(record, id); }
    catch (error) {
      console.warn("Private screenplay copy could not be updated:", { code: error?.code, message: error?.message });
      if (includeMetadata) showToast("Your listening position was saved, but the private screenplay copy couldn’t sync yet.", 6500);
    }
    state.cloudSaveSignature = JSON.stringify({ id: record.id, ownerId, screenplayId: id, preferences: currentPreferences() });
    if (refreshLibrary || !screenplayId) await loadAccountLibrary({ quiet: true });
    return id;
  } catch (error) {
    console.warn("Account library could not be updated:", { code: error?.code, message: error?.message });
    showToast(error?.message || "Your account library couldn’t be updated.");
  } finally {
    state.cloudSaveRunning = false;
    if (state.cloudSavePending) {
      state.cloudSavePending = false;
      queueCloudSave(250);
    }
  }
}

async function ensureAccountScreenplay() {
  if (state.accountStatus !== "authenticated" || !state.record) return "";
  let screenplayId = accountScreenplayId();
  if (!screenplayId) screenplayId = await syncCurrentRecord({ includeMetadata: true, refreshLibrary: true });
  return screenplayId || accountScreenplayId();
}

function queueCloudSave(delay = 2800) {
  if (state.accountStatus !== "authenticated" || !state.record) return;
  clearTimeout(state.cloudSaveTimer);
  state.cloudSaveTimer = setTimeout(() => syncCurrentRecord(), delay);
}

async function handleAccountSubmit(event) {
  event.preventDefault();
  if (!accountSession || state.accountRequestBusy) return;
  const email = elements.accountEmail.value;
  const password = elements.accountPassword.value;
  const confirmation = elements.accountPasswordConfirm.value;
  setAccountMessage();
  if (["signup", "reset"].includes(state.accountMode) && password !== confirmation) {
    setAccountMessage("Those passwords don’t match.");
    return;
  }
  state.accountRequestBusy = true;
  elements.accountSubmit.disabled = true;
  try {
    if (state.accountMode === "signup") {
      const result = await accountSession.signUp(email, password);
      if (result.confirmationRequired) {
        setAccountMessage("Check your email and select the confirmation link. Then return here and sign in.", true);
        return;
      }
      closeAccountModal(); showToast("Your free account is ready.");
    } else if (state.accountMode === "signin") {
      await accountSession.signIn(email, password);
      closeAccountModal(); showToast("Signed in. Your library is ready.");
    } else if (state.accountMode === "forgot") {
      await accountSession.requestPasswordReset(email);
      setAccountMessage("Check your email for the password reset link.", true);
    } else if (state.accountMode === "reset") {
      await accountSession.updatePassword(password);
      closeAccountModal(); showToast("Your password has been updated.");
    }
  } catch (error) {
    setAccountMessage(error?.message || "SpokenFrame couldn’t complete that request.");
  } finally {
    state.accountRequestBusy = false;
    elements.accountSubmit.disabled = false;
  }
}

async function handleSessionState(snapshot) {
  const previousUserId = state.accountUser?.id || "";
  state.accountStatus = snapshot.status;
  state.accountUser = snapshot.user;
  renderAccountState();
  if (snapshot.status === "authenticated") {
    await loadAccountLibrary({ quiet: true });
    if (state.record) {
      await syncCurrentRecord({ includeMetadata: previousUserId !== snapshot.user.id, refreshLibrary: previousUserId !== snapshot.user.id });
      await refreshPremiumAccess({ restorePreference: true });
      if (state.pendingPremiumIntent) openPremiumModal();
    }
  } else {
    state.accountLibrary = [];
    state.cloudContentReady.clear();
    state.premiumEntitled = false;
    state.premiumAccessLoaded = false;
    state.premiumCheckoutAvailable = false;
    if (state.providerId === "elevenlabs") {
      state.providerId = "browser";
      state.chunkPosition = 0;
      ensureDefaultAssignments();
      syncProviderControls();
      updateNowPlaying();
    }
    renderLibrary();
  }
}

async function initializeAccounts() {
  renderAccountState();
  if (!accountSession) return;
  let initializing = true;
  accountSession.subscribe((snapshot) => {
    if (initializing) {
      state.accountStatus = snapshot.status;
      state.accountUser = snapshot.user;
      renderAccountState();
      return;
    }
    handleSessionState(snapshot);
  });
  accountSession.subscribeEvents((event) => {
    if (event === "PASSWORD_RECOVERY") openAccountModal("reset");
  });
  try {
    const snapshot = await accountSession.initialize();
    initializing = false;
    await handleSessionState(snapshot);
  }
  catch (error) {
    initializing = false;
    console.warn("Account connection could not initialize:", { code: error?.code, message: error?.message });
    showToast("Accounts couldn’t connect. Guest listening is still available.");
  }
}

function defaultPreferences() {
  return { currentIndex: 0, chunkIndex: 0, chunkPosition: 0, rate: 1, provider: "browser", readCharacterNames: false, voiceAssignments: {} };
}
function currentChunk() { return state.chunks[state.chunkIndex]; }
function spokenChunkText(chunk = currentChunk()) { return spokenTextForChunk(chunk, { readCharacterNames: state.readCharacterNames }); }
function assignmentFor(roleId) {
  if (state.providerId === "browser") {
    const standard = state.voiceAssignments.NARRATOR;
    if (typeof standard === "string" && state.voices.browser.some((voice) => voice.id === standard)) return { provider: "browser", voiceId: standard };
    if (standard?.provider === "browser" && state.voices.browser.some((voice) => voice.id === standard.voiceId)) return standard;
    const voice = state.voices.browser[0];
    return { provider: "browser", voiceId: voice?.id || "" };
  }
  const saved = state.voiceAssignments[roleId];
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
  if (state.providerId === "browser") {
    const standardVoiceId = (!force && assignmentFor("NARRATOR").voiceId) || first.id;
    roles.forEach((roleId) => { state.voiceAssignments[roleId] = { provider: "browser", voiceId: standardVoiceId }; });
    return;
  }
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
  const cacheSettings = { format: "mp3_44100_128", readCharacterNames: state.readCharacterNames, normalizationVersion: SPEECH_NORMALIZATION_VERSION };
  const screenplayId = state.accountStatus === "authenticated" ? accountScreenplayId() : "";
  const promise = audioCache.getOrCreate(key, async () => {
    const controller = new AbortController(); state.controllers.set(key, controller);
    try {
      return await premiumProvider.generateSpeech({
        text: spokenChunkText(chunk),
        voiceId: assignment.voiceId,
        signal: controller.signal,
        screenplayId,
        cacheKey: key,
        cacheSettings
      });
    }
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
  if (!state.premiumEntitled) throw new PremiumTtsError("premium_required", "Premium Audio has not been unlocked for this screenplay.", 402);
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
  try {
    state.record = await saveScreenplay(state.record);
    queueCloudSave();
  } catch { /* Playback remains usable without persistence. */ }
}

async function openRecord(record) {
  state.playbackToken += 1; stopPreview(); setPlaying(false); cancelDistantGeneration(); state.record = record; state.chunks = buildAudioChunks(record.script.units); state.chunkDurations.clear();
  const preferences = { ...defaultPreferences(), ...(record.preferences || {}) };
  state.index = Number.isInteger(preferences.currentIndex) ? Math.min(preferences.currentIndex, record.script.units.length - 1) : 0;
  state.chunkIndex = Number.isInteger(preferences.chunkIndex) && state.chunks[preferences.chunkIndex]?.unitIndices.includes(state.index) ? preferences.chunkIndex : chunkIndexForUnit(state.chunks, state.index);
  state.chunkPosition = Number(preferences.chunkPosition) || 0; state.rate = Number(preferences.rate) || 1;
  state.preferredProvider = preferences.provider === "elevenlabs" ? "elevenlabs" : "browser";
  state.providerId = "browser";
  state.premiumEntitled = false; state.premiumAccessLoaded = false; state.premiumCheckoutAvailable = false;
  state.readCharacterNames = preferences.readCharacterNames === true; state.voiceAssignments = preferences.voiceAssignments || {}; ensureDefaultAssignments();
  renderScript(); elements.landing.hidden = true; elements.player.hidden = false; elements.headerActions.hidden = false; updateNowPlaying({ scroll: true }); queueSave();
}

async function commitImport(record) {
  const hydrated = await hydrateRecordFromAccount(record);
  await openRecord(hydrated);
  await saveState();
  if (state.accountStatus === "authenticated") {
    await syncCurrentRecord({ includeMetadata: true, refreshLibrary: true });
    await refreshPremiumAccess({ restorePreference: true });
  }
  showToast(`${record.script.title} is ready.`);
}

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
  const premiumCast = state.providerId === "elevenlabs" && state.premiumEntitled;
  elements.autoAssignButton.hidden = !premiumCast;
  const roles = premiumCast
    ? [{ id: "NARRATOR", name: "Narrator", detail: "Scenes, action & transitions" }, ...sortedCastCharacters(state.record.script).map((character) => ({ ...character, detail: "Character" }))]
    : [{ id: "NARRATOR", name: "Standard voice", detail: "Used for narrator and every character" }];
  const fragment = document.createDocumentFragment();
  roles.forEach((role) => {
    const row = document.createElement("div"); row.className = "voice-row";
    const identity = document.createElement("div"); identity.className = "voice-identity"; const strong = document.createElement("strong"); strong.textContent = role.name; const detail = document.createElement("span"); detail.textContent = role.detail; identity.append(strong, detail);
    const select = document.createElement("select"); select.setAttribute("aria-label", `${role.name} voice`); select.append(...voiceOptions(assignmentFor(role.id).voiceId));
    select.addEventListener("change", () => {
      stopPreview(); cancelDistantGeneration();
      if (premiumCast) {
        state.voiceAssignments[role.id] = { provider: state.providerId, voiceId: select.value }; invalidateRoleDurations(role.id);
      } else {
        ["NARRATOR", ...state.record.script.characters.map((character) => character.id)].forEach((roleId) => {
          state.voiceAssignments[roleId] = { provider: "browser", voiceId: select.value }; invalidateRoleDurations(roleId);
        });
      }
      updatePremiumEstimate(); queueSave();
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
    const screenplayId = accountScreenplayId();
    if (!state.premiumEntitled || !screenplayId) throw new PremiumTtsError("premium_required", "Premium Audio has not been unlocked for this screenplay.", 402);
    const cacheSettings = { preview: true, format: "mp3_44100_128", normalizationVersion: SPEECH_NORMALIZATION_VERSION };
    const key = await audioCacheKey({ provider: "elevenlabs", model: premiumProvider.model, voiceId, text, settings: cacheSettings });
    const entry = await audioCache.getOrCreate(
      key,
      () => premiumProvider.generateSpeech({ text, voiceId, signal: controller.signal, screenplayId, cacheKey: key, cacheSettings }),
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
  const price = premiumPrice(screenplayPageDetails(state.record.script).pageCount);
  elements.premiumEstimate.querySelector("strong").textContent = `${price.pages} ${price.pages === 1 ? "page" : "pages"} · ${price.displayAmount} one-time`;
}

function setPremiumMessage(message = "") {
  elements.premiumMessage.textContent = message;
  elements.premiumMessage.hidden = !message;
}

function activatePremiumAudio({ announce = false } = {}) {
  if (!state.premiumEntitled || !state.premiumReady) return false;
  state.providerId = "elevenlabs";
  state.preferredProvider = "elevenlabs";
  state.chunkPosition = 0;
  state.chunkDurations.clear();
  ensureDefaultAssignments();
  syncProviderControls();
  if (state.record) {
    renderVoiceList();
    updateNowPlaying();
    queueSave();
  }
  if (announce) showToast("Premium Audio is ready for this screenplay.");
  return true;
}

async function refreshPremiumAccess({ restorePreference = false, quiet = true } = {}) {
  state.premiumEntitled = false;
  state.premiumCheckoutAvailable = false;
  state.premiumAccessLoaded = false;
  if (state.accountStatus !== "authenticated" || !premiumAccess || !state.record) return null;
  const screenplayId = accountScreenplayId();
  if (!screenplayId) return null;
  try {
    const access = await premiumAccess.entitlement(screenplayId);
    state.premiumEntitled = access.premium === true;
    state.premiumCheckoutAvailable = access.checkoutAvailable === true;
    state.premiumAccessLoaded = true;
    if (state.premiumEntitled && restorePreference && state.preferredProvider === "elevenlabs") activatePremiumAudio();
    if (!state.premiumEntitled && state.providerId === "elevenlabs") {
      state.providerId = "browser"; state.preferredProvider = "browser"; ensureDefaultAssignments(); syncProviderControls(); updateNowPlaying(); queueSave();
    }
    return access;
  } catch (error) {
    console.warn("Premium access could not be checked:", { code: error?.code, message: error?.message });
    if (!quiet) showToast(error?.message || "Premium purchase information is temporarily unavailable.");
    return null;
  }
}

function openPremiumModal() {
  if (!state.record) return;
  if (!elements.castModal.hidden) closeCastModal();
  state.lastFocused = document.activeElement;
  setPendingPremiumIntent(true);
  const price = premiumPrice(screenplayPageDetails(state.record.script).pageCount);
  elements.premiumPrice.querySelector("strong").textContent = `${price.pages} ${price.pages === 1 ? "page" : "pages"} · Premium Audio ${price.displayAmount}`;
  elements.premiumPrice.querySelector("span").textContent = "One-time purchase · No subscription";
  setPremiumMessage();
  if (state.accountStatus !== "authenticated") {
    elements.premiumModalTitle.textContent = "Save this screenplay first";
    elements.premiumModalCopy.textContent = "Create a free account to save this screenplay and unlock Premium Audio.";
    elements.premiumUnlockButton.textContent = "Create free account";
  } else if (state.premiumEntitled) {
    elements.premiumModalTitle.textContent = "Premium Audio is unlocked";
    elements.premiumModalCopy.textContent = "Natural voices and character casting are ready for this screenplay.";
    elements.premiumUnlockButton.textContent = "Use Premium Audio";
  } else {
    elements.premiumModalTitle.textContent = "Unlock natural voices";
    elements.premiumModalCopy.textContent = "A one-time purchase for this screenplay. No subscription.";
    elements.premiumUnlockButton.textContent = "Unlock Premium";
    if (state.premiumAccessLoaded && !state.premiumCheckoutAvailable) setPremiumMessage("Premium checkout is temporarily unavailable. Standard Audio remains free.");
  }
  elements.premiumUnlockButton.disabled = state.premiumRequestBusy;
  elements.premiumModal.hidden = false;
  elements.premiumUnlockButton.focus();
}

function closePremiumModal({ preserveIntent = false } = {}) {
  if (elements.premiumModal.hidden) return;
  elements.premiumModal.hidden = true;
  setPremiumMessage();
  if (!preserveIntent) setPendingPremiumIntent(false);
  state.lastFocused?.focus?.();
}

async function handlePremiumUnlock() {
  if (state.premiumRequestBusy || !state.record) return;
  if (state.accountStatus !== "authenticated") {
    closePremiumModal({ preserveIntent: true });
    openAccountModal("signup");
    return;
  }
  if (state.premiumEntitled) {
    closePremiumModal();
    if (!activatePremiumAudio({ announce: true })) showToast("Premium voices are temporarily unavailable. Standard Audio still works.");
    return;
  }
  state.premiumRequestBusy = true;
  elements.premiumUnlockButton.disabled = true;
  elements.premiumUnlockButton.textContent = "Opening secure checkout…";
  setPremiumMessage();
  try {
    const screenplayId = await ensureAccountScreenplay();
    if (!screenplayId) throw new Error("This screenplay could not be saved to your account yet.");
    const access = await refreshPremiumAccess({ quiet: false });
    if (access?.premium) {
      closePremiumModal(); activatePremiumAudio({ announce: true }); return;
    }
    const checkoutUrl = await premiumAccess.startCheckout(screenplayId);
    window.location.assign(checkoutUrl);
  } catch (error) {
    console.warn("Premium checkout could not start:", { code: error?.code, message: error?.message });
    setPremiumMessage(error?.message || "Premium checkout is temporarily unavailable. Please try again.");
  } finally {
    state.premiumRequestBusy = false;
    elements.premiumUnlockButton.disabled = false;
    if (!elements.premiumModal.hidden) elements.premiumUnlockButton.textContent = "Unlock Premium";
  }
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
  if (providerId === "elevenlabs" && !state.premiumEntitled) { state.providerId = "browser"; syncProviderControls(); openPremiumModal(); return; }
  state.providerId = providerId; state.preferredProvider = providerId; state.chunkPosition = 0; state.chunkDurations.clear(); ensureDefaultAssignments(); syncProviderControls(); renderVoiceList(); updateNowPlaying(); updatePremiumEstimate(); queueSave();
}

function openFallback(error) {
  elements.fallbackMessage.textContent = error instanceof PremiumTtsError ? `${error.message} You can try again or use Standard Audio.` : "That premium passage could not be played. You can try again or use Standard Audio.";
  elements.fallbackModal.hidden = false; elements.fallbackRetry.focus();
}
function closeFallback() { elements.fallbackModal.hidden = true; }

function clearCheckoutQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("checkout");
  url.searchParams.delete("screenplay");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("checkout");
  const screenplayId = params.get("screenplay") || "";
  if (!result) return;
  clearCheckoutQuery();
  if (result === "cancelled") {
    showToast("Premium checkout was cancelled. Standard Audio is still free.");
    return;
  }
  if (result !== "success") return;
  if (state.accountStatus !== "authenticated") {
    setPendingPremiumIntent(true);
    showToast("Your payment is being confirmed. Sign in to open the screenplay.", 6500);
    openAccountModal("signin");
    return;
  }
  const entry = state.accountLibrary.find((item) => item.id === screenplayId);
  if (entry && accountScreenplayId() !== screenplayId) await openLibraryEntry(entry);
  showToast("Confirming Premium Audio…", 9000);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const access = await refreshPremiumAccess({ quiet: true });
    if (access?.premium) {
      setPendingPremiumIntent(false);
      activatePremiumAudio({ announce: true });
      await loadAccountLibrary({ quiet: true });
      return;
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 900));
  }
  setPendingPremiumIntent(true);
  showToast("Payment received. Premium Audio is still being confirmed; try again in a moment.", 7000);
  openPremiumModal();
}

function populateResume(record) {
  const prefs = record.preferences || {};
  const currentIndex = prefs.currentIndex || 0;
  const progress = progressPercent(currentIndex, record.script.units.length);
  const scene = [...record.script.scenes].reverse().find((item) => item.unitIndex <= currentIndex)?.title || "Opening";
  elements.resumeTitle.textContent = record.script.title;
  elements.resumeDetail.textContent = progress > 0 ? `${progress}% · ${scene}` : "Ready to begin";
  elements.resumeProgress.style.width = `${progress}%`; elements.resumeFormat.textContent = record.script.format?.toUpperCase() || "SCRIPT"; elements.resumeCard.hidden = false;
  elements.resumeButton.setAttribute("aria-label", `Continue ${record.script.title}`); elements.resumeButton.onclick = async () => openRecord(await hydrateRecordFromAccount(record));
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
  elements.accountButton.addEventListener("click", () => openAccountModal(state.accountStatus === "authenticated" ? "profile" : "signin"));
  elements.accountContextAction.addEventListener("click", () => openAccountModal(state.accountStatus === "authenticated" ? "profile" : "signup"));
  elements.closeAccountButton.addEventListener("click", closeAccountModal);
  elements.accountModal.addEventListener("click", (event) => { if (event.target === elements.accountModal) closeAccountModal(); });
  elements.accountForm.addEventListener("submit", handleAccountSubmit);
  elements.accountModeButton.addEventListener("click", () => setAccountMode(state.accountMode === "signin" ? "signup" : "signin"));
  elements.forgotPasswordButton.addEventListener("click", () => setAccountMode("forgot"));
  elements.signOutButton.addEventListener("click", async () => {
    if (state.accountRequestBusy) return;
    state.accountRequestBusy = true;
    try { await accountSession?.signOut(); closeAccountModal(); showToast("Signed out. Guest listening is still available."); }
    catch (error) { showToast(error?.message || "SpokenFrame couldn’t sign out."); }
    finally { state.accountRequestBusy = false; }
  });
  elements.libraryRefreshButton.addEventListener("click", () => loadAccountLibrary());
  elements.playButton.addEventListener("click", togglePlayback); elements.previousSceneButton.addEventListener("click", () => moveScene(-1)); elements.nextSceneButton.addEventListener("click", () => moveScene(1));
  elements.backThreeButton.addEventListener("click", () => movePassages(-1)); elements.forwardThreeButton.addEventListener("click", () => movePassages(1)); elements.brandButton.addEventListener("click", showHome);
  elements.castButton.addEventListener("click", openCastModal); elements.closeCastButton.addEventListener("click", closeCastModal); elements.doneCastButton.addEventListener("click", closeCastModal); elements.castModal.addEventListener("click", (event) => { if (event.target === elements.castModal) closeCastModal(); });
  elements.closePremiumButton.addEventListener("click", () => closePremiumModal());
  elements.premiumModal.addEventListener("click", (event) => { if (event.target === elements.premiumModal) closePremiumModal(); });
  elements.premiumStandardButton.addEventListener("click", () => { closePremiumModal(); changeProvider("browser"); });
  elements.premiumUnlockButton.addEventListener("click", handlePremiumUnlock);
  elements.providerOptions.forEach((option) => option.addEventListener("change", () => { if (option.checked) changeProvider(option.value); }));
  elements.readCharacterNames.addEventListener("change", () => { cancelDistantGeneration(); state.readCharacterNames = elements.readCharacterNames.checked; state.chunkDurations.clear(); updatePremiumEstimate(); updateProgress(); queueSave(); });
  elements.autoAssignButton.addEventListener("click", () => { stopPreview(); cancelDistantGeneration(); ensureDefaultAssignments(true, true); state.chunkDurations.clear(); renderVoiceList(); queueSave(); showToast("Voices automatically assigned."); });
  elements.speedSelect.addEventListener("change", () => { state.rate = Number(elements.speedSelect.value) || 1; audioPlayer?.setRate(state.rate); updateProgress(); updateMediaSession(); queueSave(); });
  elements.sceneSelect.addEventListener("change", () => jumpToUnit(Number(elements.sceneSelect.value) || 0)); elements.progressSlider.addEventListener("input", () => jumpToUnit(Number(elements.progressSlider.value) || 0));
  elements.scriptPages.addEventListener("click", (event) => { const unit = event.target.closest("[data-index]"); if (unit) jumpToUnit(Number(unit.dataset.index)); });
  elements.reviewCancel.addEventListener("click", () => { state.pendingRecord = null; elements.reviewModal.hidden = true; }); elements.reviewContinue.addEventListener("click", async () => { const record = state.pendingRecord; state.pendingRecord = null; elements.reviewModal.hidden = true; if (record) await commitImport(record); });
  elements.fallbackRetry.addEventListener("click", () => { closeFallback(); playCurrent(); }); elements.fallbackDevice.addEventListener("click", () => { closeFallback(); state.providerId = "browser"; state.preferredProvider = "browser"; state.chunkDurations.clear(); ensureDefaultAssignments(); updateNowPlaying(); queueSave(); playCurrent(); });
  ["dragenter", "dragover"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.dropZone.addEventListener(name, (event) => { event.preventDefault(); elements.dropZone.classList.remove("is-dragging"); })); elements.dropZone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
  document.addEventListener("keydown", (event) => {
    const interactive = /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName);
    if (event.key === "Escape") { closeAccountModal(); closeCastModal(); closeFallback(); closePremiumModal(); }
    if (!state.record || interactive || !elements.accountModal.hidden || !elements.castModal.hidden || !elements.fallbackModal.hidden || !elements.premiumModal.hidden) return;
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
  bindEvents(); setupMediaSession();
  await Promise.all([initProviders(), initializeAccounts()]);
  try {
    const last = await loadLastScreenplay();
    if (last) {
      const hydrated = await hydrateRecordFromAccount(last);
      const returningFromCheckout = new URLSearchParams(window.location.search).has("checkout");
      if (state.pendingPremiumIntent && state.accountStatus === "authenticated" && !returningFromCheckout) {
        await openRecord(hydrated);
        await ensureAccountScreenplay();
        await refreshPremiumAccess({ restorePreference: true });
        openPremiumModal();
      } else populateResume(hydrated);
    }
  }
  catch (error) { console.warn("Saved screenplay could not be restored:", error); showToast("A saved screenplay could not be restored. You can import it again.", 5000); }
  await handleCheckoutReturn();
}

init();
