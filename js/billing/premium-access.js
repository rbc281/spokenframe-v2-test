export class PremiumAccessError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "PremiumAccessError";
    this.code = code;
    this.status = status;
  }
}

function safeMessage(code) {
  if (["auth_required", "invalid_session"].includes(code)) return "Sign in again to continue.";
  if (code === "already_premium") return "Premium Audio is already unlocked for this screenplay.";
  if (code === "pricing_unavailable") return "SpokenFrame couldn’t calculate Premium pricing for this screenplay yet.";
  if (code === "premium_required") return "Premium Audio has not been unlocked for this screenplay.";
  if (code === "network") return "SpokenFrame couldn’t connect to Premium checkout.";
  return "Premium checkout is temporarily unavailable. Please try again.";
}

export class PremiumAccessService {
  constructor({ workerUrl, tokenProvider, fetchImpl } = {}) {
    this.workerUrl = String(workerUrl || "").trim().replace(/\/+$/, "");
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl
      ? (...args) => fetchImpl(...args)
      : (...args) => globalThis.fetch(...args);
  }

  get configured() {
    return /^https:\/\//i.test(this.workerUrl) && typeof this.tokenProvider === "function";
  }

  async request(screenplayId, action, options = {}) {
    if (!this.configured) throw new PremiumAccessError("checkout_unavailable", safeMessage("checkout_unavailable"));
    let token;
    try { token = await this.tokenProvider(); }
    catch { throw new PremiumAccessError("auth_required", safeMessage("auth_required"), 401); }

    let response;
    try {
      response = await this.fetch(
        `${this.workerUrl}/v1/screenplays/${encodeURIComponent(screenplayId)}/${action}`,
        { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } }
      );
    } catch {
      throw new PremiumAccessError("network", safeMessage("network"));
    }

    let payload = {};
    try { payload = await response.json(); } catch { /* The Worker normally returns JSON. */ }
    if (!response.ok) {
      const code = String(payload.code || (response.status === 401 ? "invalid_session" : "checkout_unavailable"));
      throw new PremiumAccessError(code, safeMessage(code), response.status);
    }
    return payload;
  }

  entitlement(screenplayId) {
    return this.request(screenplayId, "entitlement");
  }

  async startCheckout(screenplayId) {
    const payload = await this.request(screenplayId, "checkout", { method: "POST" });
    if (!/^https:\/\/checkout\.stripe\.com\//i.test(String(payload.checkoutUrl || ""))) {
      throw new PremiumAccessError("checkout_unavailable", safeMessage("checkout_unavailable"));
    }
    return payload.checkoutUrl;
  }
}
