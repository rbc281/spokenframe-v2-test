import { deleteCachedAudio, getCachedAudioEntry, putCachedAudio, updateCachedAudioMetadata } from "./storage.js";

export class LocalAudioCache {
  constructor() { this.scope = "local-device"; }
  get(key) { return getCachedAudioEntry(key); }
  put(key, blob, metadata = {}) { return putCachedAudio(key, blob, metadata); }
  delete(key) { return deleteCachedAudio(key); }
  updateMetadata(key, metadata = {}) { return updateCachedAudioMetadata(key, metadata); }
}

// Playback depends on this small interface, not IndexedDB directly. A future
// authenticated R2 adapter can implement the same methods without changing the
// player or any screenplay parser.
export class AudioCache {
  constructor(primary = new LocalAudioCache()) { this.primary = primary; this.inflight = new Map(); }
  get(key) { return this.primary.get(key); }
  put(key, blob, metadata = {}) { return this.primary.put(key, blob, metadata); }
  delete(key) { return this.primary.delete(key); }
  updateMetadata(key, metadata = {}) { return this.primary.updateMetadata(key, metadata); }
  async getOrCreate(key, create, metadata = {}) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const cached = await this.get(key).catch(() => null);
    if (cached) return { ...cached, key, cached: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = Promise.resolve()
      .then(create)
      .then(async (blob) => { await this.put(key, blob, metadata).catch(() => {}); return { blob, key, cached: false, metadata }; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }
}
