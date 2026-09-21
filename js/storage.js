const DB_NAME = "scene-reader"; // Preserve V1 data and migrate it in place.
const DB_VERSION = 2;
const SCREENPLAYS = "screenplays";
const AUDIO_CACHE = "audio-cache";
const LAST_KEY = "scene-reader:last-script";
const CACHE_MAX_BYTES = 150 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 250;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("Local storage is unavailable.")); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SCREENPLAYS)) database.createObjectStore(SCREENPLAYS, { keyPath: "id" });
      if (!database.objectStoreNames.contains(AUDIO_CACHE)) {
        const cache = database.createObjectStore(AUDIO_CACHE, { keyPath: "id" });
        cache.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not open local storage."));
  });
}

async function requestInStore(storeName, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not access saved SpokenFrame data."));
    tx.oncomplete = () => db.close();
    tx.onabort = () => { db.close(); reject(new Error("Could not save SpokenFrame data.")); };
  });
}

export async function hashData(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `fallback-${(hash >>> 0).toString(16)}-${bytes.byteLength}`;
}

export async function hashFile(file) { return hashData(await file.arrayBuffer()); }

function migrateRecord(record) {
  if (!record?.script?.units) throw new Error("Saved screenplay data is incomplete.");
  return {
    ...record,
    schemaVersion: 2,
    script: { schemaVersion: 2, confidence: { score: 1, warnings: [], reviewRecommended: false }, ...record.script },
    preferences: { currentIndex: 0, chunkIndex: 0, chunkPosition: 0, rate: 1, provider: "browser", voiceAssignments: {}, ...(record.preferences || {}) }
  };
}

export async function saveScreenplay(record) {
  const saved = { ...migrateRecord(record), updatedAt: Date.now() };
  await requestInStore(SCREENPLAYS, "readwrite", (store) => store.put(saved));
  try { localStorage.setItem(LAST_KEY, record.id); } catch { /* Optional convenience only. */ }
  return saved;
}

export async function loadScreenplay(id) {
  if (!id) return null;
  const record = await requestInStore(SCREENPLAYS, "readonly", (store) => store.get(id));
  return record ? migrateRecord(record) : null;
}

export async function loadLastScreenplay() {
  let id = null;
  try { id = localStorage.getItem(LAST_KEY); } catch { return null; }
  return loadScreenplay(id);
}

export async function audioCacheKey({ provider, model, voiceId, text, settings = {} }) {
  return hashData(JSON.stringify({ version: 1, provider, model, voiceId, text, settings }));
}

export async function getCachedAudio(id) {
  const entry = await requestInStore(AUDIO_CACHE, "readonly", (store) => store.get(id));
  if (!entry?.blob || !(entry.blob instanceof Blob)) return null;
  requestInStore(AUDIO_CACHE, "readwrite", (store) => store.put({ ...entry, updatedAt: Date.now() })).catch(() => {});
  return entry.blob;
}

export async function putCachedAudio(id, blob, metadata = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("Generated audio was empty.");
  await requestInStore(AUDIO_CACHE, "readwrite", (store) => store.put({ id, blob, bytes: blob.size, metadata, updatedAt: Date.now() }));
  pruneAudioCache().catch(() => {});
}

export async function deleteCachedAudio(id) {
  await requestInStore(AUDIO_CACHE, "readwrite", (store) => store.delete(id));
}

export async function pruneAudioCache() {
  const entries = await requestInStore(AUDIO_CACHE, "readonly", (store) => store.getAll());
  entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let bytes = 0;
  const removals = [];
  entries.forEach((entry, index) => {
    bytes += entry.bytes || entry.blob?.size || 0;
    if (index >= CACHE_MAX_ENTRIES || bytes > CACHE_MAX_BYTES) removals.push(entry.id);
  });
  await Promise.all(removals.map((id) => deleteCachedAudio(id)));
  return removals.length;
}
