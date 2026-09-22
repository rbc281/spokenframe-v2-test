export class PremiumTtsError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = "PremiumTtsError"; this.code = code; this.status = status; }
}

export function premiumErrorMessage(code) {
  if (["quota", "rate_limit"].includes(code)) return "Premium audio credits are unavailable.";
  if (code === "network") return "Premium audio couldn’t connect.";
  if (["provider_unavailable", "provider_error", "worker_error", "timeout", "unavailable"].includes(code)) return "Premium audio is temporarily unavailable.";
  if (["not_configured", "provider_auth", "origin_denied"].includes(code)) return "Premium audio isn’t configured correctly.";
  if (code === "invalid_voice") return "That premium voice is no longer available. Choose another voice.";
  return "Premium audio couldn’t generate that passage.";
}

export class ElevenLabsProvider {
  constructor({ workerUrl, fetchImpl } = {}) {
    this.id = "elevenlabs";
    this.name = "Premium Audio";
    this.kind = "audio";
    this.workerUrl = String(workerUrl || "").replace(/\/$/, "");
    // Native browser fetch is receiver-sensitive. Wrapping the call keeps it
    // bound to the browser global instead of invoking it as a provider method.
    this.fetch = fetchImpl
      ? (...args) => fetchImpl(...args)
      : (...args) => globalThis.fetch(...args);
    this.model = "eleven_flash_v2_5";
  }
  get configured() { return /^https:\/\//i.test(this.workerUrl); }
  async request(path, options = {}) {
    if (!this.configured) throw new PremiumTtsError("not_configured", premiumErrorMessage("not_configured"));
    let response;
    try { response = await this.fetch(`${this.workerUrl}${path}`, options); }
    catch { throw new PremiumTtsError("network", premiumErrorMessage("network")); }
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { /* Upstream may not return JSON. */ }
      const code = payload.code || (response.status === 429 ? "quota" : response.status >= 500 ? "provider_unavailable" : "provider_error");
      throw new PremiumTtsError(code, premiumErrorMessage(code), response.status);
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
      if (timedOut) throw new PremiumTtsError("timeout", premiumErrorMessage("timeout"));
      if (signal?.aborted) { const aborted = new Error("Generation canceled."); aborted.name = "AbortError"; throw aborted; }
      throw error;
    } finally {
      clearTimeout(timeout); signal?.removeEventListener("abort", abort);
    }
  }
}
