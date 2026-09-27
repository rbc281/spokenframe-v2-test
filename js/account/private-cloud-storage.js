export class PrivateStorageError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "PrivateStorageError";
    this.code = code;
    this.status = status;
  }
}

function safeMessage(code) {
  if (["auth_required", "invalid_session"].includes(code)) return "Sign in again to reach your saved screenplay.";
  if (["screenplay_not_found", "content_not_found"].includes(code)) return "That screenplay is not available in your private library yet.";
  if (code === "network") return "SpokenFrame couldn’t connect to your private library.";
  if (code === "storage_unavailable") return "Private screenplay storage is temporarily unavailable.";
  return "SpokenFrame couldn’t reach your private screenplay copy.";
}

export class PrivateCloudStorage {
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

  async request(path, options = {}) {
    if (!this.configured) throw new PrivateStorageError("storage_unavailable", safeMessage("storage_unavailable"));
    let token;
    try { token = await this.tokenProvider(); }
    catch { throw new PrivateStorageError("auth_required", safeMessage("auth_required"), 401); }
    let response;
    try {
      response = await this.fetch(`${this.workerUrl}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
      });
    } catch {
      throw new PrivateStorageError("network", safeMessage("network"));
    }
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { /* Response may not contain JSON. */ }
      const code = payload.code || (response.status === 401 ? "invalid_session" : response.status === 404 ? "content_not_found" : "storage_unavailable");
      throw new PrivateStorageError(code, safeMessage(code), response.status);
    }
    return response;
  }

  async saveScreenplay(screenplayId, record) {
    if (!screenplayId || !record?.id || !record?.script?.units?.length) {
      throw new PrivateStorageError("invalid_screenplay", "A complete screenplay is required for private storage.");
    }
    const response = await this.request(`/v1/screenplays/${encodeURIComponent(screenplayId)}/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientFingerprint: record.id, screenplay: record.script })
    });
    return response.json();
  }

  async loadScreenplay(screenplayId) {
    const response = await this.request(`/v1/screenplays/${encodeURIComponent(screenplayId)}/content`);
    return response.json();
  }
}
