import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { Window } from "happy-dom";

const window = new Window({ url: "https://example.test/spokenframe/" });
Object.defineProperty(globalThis, "window", { configurable: true, value: window });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
Object.defineProperty(window, "indexedDB", { configurable: true, value: indexedDB });

await new Promise((resolve, reject) => {
  const request = indexedDB.open("scene-reader", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("screenplays", { keyPath: "id" });
  request.onsuccess = () => {
    const db = request.result; const tx = db.transaction("screenplays", "readwrite");
    tx.objectStore("screenplays").put({ id: "v1-script", script: { title: "Legacy", units: [{ id: "unit-0", type: "action", text: "Old data survives.", scene: "Opening" }], scenes: [{ title: "Opening", unitIndex: 0 }], characters: [], format: "Final Draft" }, preferences: { currentIndex: 0, narration: false, rate: 1.25, voiceAssignments: { NARRATOR: "old-voice" } } });
    tx.oncomplete = () => { db.close(); window.localStorage.setItem("scene-reader:last-script", "v1-script"); resolve(); };
  };
  request.onerror = () => reject(request.error);
});

const { audioCacheKey, getCachedAudio, loadLastScreenplay, putCachedAudio } = await import("../js/storage.js");
const restored = await loadLastScreenplay();
if (restored.script.title !== "Legacy" || restored.preferences.rate !== 1.25 || restored.schemaVersion !== 2) throw new Error("V1 screenplay did not migrate safely");
if (restored.preferences.provider !== "browser") throw new Error("Legacy voice provider was not preserved as browser speech");
console.log("✓ migrates V1 records without deleting screenplay or position");

const identity = { provider: "elevenlabs", model: "model", voiceId: "voice", text: "Same passage", settings: {} };
const firstKey = await audioCacheKey(identity); const secondKey = await audioCacheKey(identity);
if (firstKey !== secondKey) throw new Error("Cache identity is not deterministic");
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });
await putCachedAudio(firstKey, blob, { screenplayId: "v1-script" }); const restoredBlob = await getCachedAudio(firstKey);
if (!restoredBlob || restoredBlob.size !== 3) throw new Error("Audio blob cache failed");
console.log("✓ stores generated audio as deterministic IndexedDB blobs");
