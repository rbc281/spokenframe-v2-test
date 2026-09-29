export class PremiumTtsError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = "PremiumTtsError"; this.code = code; this.status = status; }
}

export function premiumErrorMessage(code) {
  if (["quota", "rate_limit"].includes(code)) return "Premium audio is temporarily unavailable.";
  if (["auth_required", "invalid_session"].includes(code)) return "Sign in again to use Premium Audio.";
  if (code === "premium_required") return "Premium Audio has not been unlocked for this screenplay.";
  if (code === "premium_limit") return "This screenplay has reached its Premium Audio generation limit.";
  if (["billing_unavailable", "checkout_unavailable", "generation_in_progress"].includes(code)) return "Premium audio is temporarily unavailable.";
  if (["screenplay_not_found", "cache_identity"].includes(code)) return "This screenplay isn’t ready for Premium Audio yet.";
  if (code === "network") return "Premium audio couldn’t connect.";
  if (["provider_unavailable", "provider_error", "worker_error", "timeout", "unavailable"].includes(code)) return "Premium audio is temporarily unavailable.";
  if (["not_configured", "provider_auth", "origin_denied"].includes(code)) return "Premium audio isn’t configured correctly.";
  if (code === "invalid_voice") return "That premium voice is no longer available. Choose another voice.";
  return "Premium audio couldn’t generate that passage.";
}

export class ElevenLabsProvider {
  constructor({ workerUrl, tokenProvider, fetchImpl } = {}) {
    this.id = "elevenlabs";
    this.name = "Premium Audio";
    this.kind = "audio";
    this.workerUrl = String(workerUrl || "").replace(/\/$/, "");
    this.tokenProvider = tokenProvider;
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
  async generateSpeech({ text, voiceId, signal, screenplayId = "", cacheKey = "", cacheSettings = {} }) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
    try {
      const usePrivateCache = Boolean(screenplayId && cacheKey && typeof this.tokenProvider === "function");
      let token = "";
      if (usePrivateCache) {
        try { token = await this.tokenProvider(); }
        catch { throw new PremiumTtsError("auth_required", premiumErrorMessage("auth_required"), 401); }
      }
      const path = usePrivateCache
        ? `/v1/screenplays/${encodeURIComponent(screenplayId)}/audio/${encodeURIComponent(cacheKey)}`
        : "/v1/tts";
      const response = await this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text, voiceId, ...(usePrivateCache ? { cacheSettings } : {}) }),
        signal: controller.signal
      });
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
