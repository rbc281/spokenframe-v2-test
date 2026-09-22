export class PremiumTtsError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = "PremiumTtsError"; this.code = code; this.status = status; }
}

export class ElevenLabsProvider {
  constructor({ workerUrl, fetchImpl } = {}) {
    this.id = "elevenlabs";
    this.name = "Premium AI voices";
    this.kind = "audio";
    this.workerUrl = String(workerUrl || "").replace(/\/$/, "");
    // Native browser fetch is receiver-sensitive. Wrapping the call keeps it
    // bound to the browser global instead of invoking it as a provider method.
    this.fetch = fetchImpl
      ? (...args) => fetchImpl(...args)
      : (...args) => globalThis.fetch(...args);
    this.model = "eleven_multilingual_v2";
  }
  get configured() { return /^https:\/\//i.test(this.workerUrl); }
  async request(path, options = {}) {
    if (!this.configured) throw new PremiumTtsError("not_configured", "Premium audio has not been connected yet.");
    let response;
    try { response = await this.fetch(`${this.workerUrl}${path}`, options); }
    catch { throw new PremiumTtsError("network", "SpokenFrame could not reach premium audio. Check your connection and try again."); }
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { /* Upstream may not return JSON. */ }
      const code = payload.code || (response.status === 429 ? "quota" : "provider");
      const message = payload.message || (response.status === 429 ? "Premium audio has reached its current usage limit." : "Premium audio is temporarily unavailable.");
      throw new PremiumTtsError(code, message, response.status);
    }
    return response;
  }
  async isAvailable() { if (!this.configured) return false; try { await this.request("/v1/status"); return true; } catch { return false; } }
  async getVoices({ signal } = {}) {
    const response = await this.request("/v1/voices", { signal });
    const payload = await response.json();
    this.model = payload.model || this.model;
    return (payload.voices || []).map((voice) => ({ id: voice.voice_id, name: voice.name, language: voice.labels?.language || "Multilingual", provider: this.id }));
  }
  async generateSpeech({ text, voiceId, signal }) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
    try {
      const response = await this.request("/v1/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voiceId }), signal: controller.signal });
      this.model = response.headers.get("X-SpokenFrame-Model") || this.model;
      return response.blob();
    } catch (error) {
      if (timedOut) throw new PremiumTtsError("timeout", "Premium audio took too long to respond. Try that passage again.");
      if (signal?.aborted) { const aborted = new Error("Generation canceled."); aborted.name = "AbortError"; throw aborted; }
      throw error;
    } finally {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort);
    }
  }
}
