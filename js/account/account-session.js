export class AccountError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.status = status;
  }
}

export function accountError(error) {
  if (error instanceof AccountError) return error;
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status) || 0;
  if (/email.*not confirmed|confirm.*email/.test(message)) {
    return new AccountError("email_unconfirmed", "Confirm your email before signing in.", status);
  }
  if (/already registered|already exists/.test(message)) {
    return new AccountError("account_exists", "An account already exists for that email.", status);
  }
  if (/password/.test(message)) {
    return new AccountError("weak_password", "Choose a password with at least 8 characters.", status);
  }
  if (status === 429 || /rate limit|too many/.test(message)) {
    return new AccountError("rate_limit", "Too many account attempts. Wait a moment and try again.", status);
  }
  if (/invalid login|invalid credentials/.test(message)) {
    return new AccountError("invalid_credentials", "That email and password were not recognized.", status);
  }
  if (error?.name === "TypeError" || /fetch|network|connection/.test(message)) {
    return new AccountError("network", "SpokenFrame couldn’t connect to accounts. Check your connection and try again.", status);
  }
  return new AccountError("account_error", "SpokenFrame couldn’t complete that account request.", status);
}

function cleanEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new AccountError("invalid_email", "Enter a valid email address.");
  }
  return value;
}

function checkedPassword(password) {
  const value = String(password || "");
  if (value.length < 8) throw new AccountError("weak_password", "Choose a password with at least 8 characters.");
  return value;
}

function publicUser(user) {
  return user?.id ? { id: user.id, email: user.email || "" } : null;
}

export class AccountSessionService {
  constructor(client, { redirectUrl = "" } = {}) {
    if (!client?.auth) throw new Error("An authentication client is required.");
    this.client = client;
    this.redirectUrl = redirectUrl;
    this.state = Object.freeze({ status: "loading", user: null });
    this.listeners = new Set();
    this.subscription = null;
  }

  snapshot() { return this.state; }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  #update(session) {
    const user = publicUser(session?.user);
    this.state = Object.freeze({ status: user ? "authenticated" : "guest", user });
    this.listeners.forEach((listener) => listener(this.state));
  }

  async initialize() {
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error) throw error;
      this.#update(data?.session || null);
      const result = this.client.auth.onAuthStateChange((_event, session) => this.#update(session));
      this.subscription = result?.data?.subscription || null;
      return this.state;
    } catch (error) {
      this.#update(null);
      throw accountError(error);
    }
  }

  async signUp(email, password) {
    try {
      const options = this.redirectUrl ? { emailRedirectTo: this.redirectUrl } : undefined;
      const { data, error } = await this.client.auth.signUp({ email: cleanEmail(email), password: checkedPassword(password), ...(options ? { options } : {}) });
      if (error) throw error;
      if (data?.session) this.#update(data.session);
      return { user: publicUser(data?.user), confirmationRequired: !data?.session };
    } catch (error) { throw accountError(error); }
  }

  async signIn(email, password) {
    try {
      const { data, error } = await this.client.auth.signInWithPassword({ email: cleanEmail(email), password: checkedPassword(password) });
      if (error) throw error;
      this.#update(data?.session || null);
      return this.state;
    } catch (error) { throw accountError(error); }
  }

  async requestPasswordReset(email) {
    try {
      const options = this.redirectUrl ? { redirectTo: this.redirectUrl } : undefined;
      const { error } = await this.client.auth.resetPasswordForEmail(cleanEmail(email), options);
      if (error) throw error;
      return true;
    } catch (error) { throw accountError(error); }
  }

  async updatePassword(password) {
    try {
      const { error } = await this.client.auth.updateUser({ password: checkedPassword(password) });
      if (error) throw error;
      return true;
    } catch (error) { throw accountError(error); }
  }

  async signOut() {
    try {
      const { error } = await this.client.auth.signOut();
      if (error) throw error;
      this.#update(null);
    } catch (error) { throw accountError(error); }
  }

  destroy() {
    this.subscription?.unsubscribe?.();
    this.subscription = null;
    this.listeners.clear();
  }
}
