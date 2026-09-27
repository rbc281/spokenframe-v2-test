function cleanUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function hasSupabaseConfig(config = {}) {
  const url = cleanUrl(config.supabaseUrl);
  const key = String(config.supabasePublishableKey || "").trim();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)
    && (/^sb_publishable_/i.test(key) || /^eyJ/.test(key));
}

export function createSpokenFrameSupabaseClient(config = {}, sdk = globalThis.supabase) {
  if (!hasSupabaseConfig(config) || typeof sdk?.createClient !== "function") return null;
  return sdk.createClient(cleanUrl(config.supabaseUrl), String(config.supabasePublishableKey).trim(), {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "spokenframe-account"
    },
    global: {
      headers: { "X-Client-Info": "spokenframe-web/4-beta" }
    }
  });
}
