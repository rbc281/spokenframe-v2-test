import {
  billingReady,
  checkPremiumEntitlement,
  finalizePremiumGeneration,
  handleCheckout,
  handleEntitlement,
  handleStripeWebhook,
  premiumEntitlementsRequired,
  reservePremiumGeneration
} from "./billing.js";

const MAX_TEXT_LENGTH = 1200;
const MAX_TTS_BODY_BYTES = 10_000;
const MAX_SCREENPLAY_BODY_BYTES = 6_000_000;
const MAX_AUDIO_BYTES = 12_000_000;
const DEFAULT_MODEL = "eleven_flash_v2_5";
const ALLOWED_VOICE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const ALLOWED_CACHE_KEY = /^[a-f0-9]{64}$/;
const ALLOWED_SCREENPLAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = allowedOrigins(env);
  const normalized = String(origin || "").replace(/\/$/, "");
  const accepted = allowed.includes(normalized) ? normalized : "";
  return {
    "Access-Control-Allow-Origin": accepted,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "X-SpokenFrame-Cache, X-SpokenFrame-Model",
    "Vary": "Origin"
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function publicError(status, code, message, cors) { return json({ code, message }, status, cors); }

function mapUpstreamError(status) {
  if (status === 401 || status === 403) return [502, "provider_auth", "Premium audio isn’t configured correctly."];
  if (status === 402 || status === 429) return [429, "quota", "Premium audio credits are unavailable."];
  if (status >= 500) return [503, "provider_unavailable", "Premium audio is temporarily unavailable."];
  return [502, "provider_error", "Premium audio could not generate that passage."];
}

function supabaseConfig(env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && key ? { url, key } : null;
}

function privateStorageReady(env) {
  return Boolean(env.PRIVATE_MEDIA && supabaseConfig(env));
}

async function readJson(request, maximumBytes, cors) {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return { error: publicError(415, "content_type", "The request must contain JSON.", cors) };
  }
  if (Number(request.headers.get("Content-Length") || 0) > maximumBytes) {
    return { error: publicError(413, "request_too_large", "That request is too large to process safely.", cors) };
  }
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
      return { error: publicError(413, "request_too_large", "That request is too large to process safely.", cors) };
    }
    return { body: JSON.parse(raw), raw };
  } catch {
    return { error: publicError(400, "invalid_json", "The request could not be read.", cors) };
  }
}

async function elevenLabs(path, env, init = {}) {
  return fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(40000),
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, ...(init.headers || {}) }
  });
}

async function handleVoices(env, cors) {
  if (!env.ELEVENLABS_API_KEY) return publicError(503, "not_configured", "Premium audio has not been configured.", cors);
  const response = await elevenLabs("/v2/voices?page_size=100", env);
  if (!response.ok) {
    const [status, code, message] = mapUpstreamError(response.status);
    return publicError(status, code, message, cors);
  }
  const payload = await response.json();
  const voices = (payload.voices || []).map(({ voice_id, name, labels }) => ({ voice_id, name, labels })).slice(0, 100);
  return json({ voices, model: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL }, 200, { ...cors, "Cache-Control": "private, max-age=300" });
}

function validateSpeech(body, cors) {
  const text = String(body?.text || "").replace(/\s+/g, " ").trim();
  const voiceId = String(body?.voiceId || "");
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return { error: publicError(400, "invalid_text", `Passages must contain 1 to ${MAX_TEXT_LENGTH} characters.`, cors) };
  }
  if (!ALLOWED_VOICE_ID.test(voiceId)) {
    return { error: publicError(400, "invalid_voice", "Choose a valid premium voice.", cors) };
  }
  return { text, voiceId };
}

async function enforceGenerationRateLimit(request, env, cors, ownerId = "") {
  if (!env.GENERATION_RATE_LIMITER) return null;
  const key = ownerId || request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await env.GENERATION_RATE_LIMITER.limit({ key });
  return result.success ? null : publicError(429, "rate_limit", "Premium audio is receiving too many requests. Wait a moment and try again.", cors);
}

async function generateAudio(text, voiceId, env, cors) {
  if (!env.ELEVENLABS_API_KEY) return { error: publicError(503, "not_configured", "Premium audio has not been configured.", cors) };
  const model = env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;
  const response = await elevenLabs(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, env, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0, use_speaker_boost: true } })
  });
  if (!response.ok) {
    console.warn("Premium generation failed", { status: response.status });
    const [status, code, message] = mapUpstreamError(response.status);
    return { error: publicError(status, code, message, cors) };
  }
  const audio = await response.arrayBuffer();
  if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
    return { error: publicError(502, "provider_error", "Premium audio returned an invalid passage.", cors) };
  }
  return { audio, model };
}

async function handleSpeech(request, env, cors) {
  const parsed = await readJson(request, MAX_TTS_BODY_BYTES, cors);
  if (parsed.error) return parsed.error;
  const speech = validateSpeech(parsed.body, cors);
  if (speech.error) return speech.error;
  const limited = await enforceGenerationRateLimit(request, env, cors);
  if (limited) return limited;
  const generated = await generateAudio(speech.text, speech.voiceId, env, cors);
  if (generated.error) return generated.error;
  return new Response(generated.audio, {
    status: 200,
    headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-SpokenFrame-Model": generated.model, "X-SpokenFrame-Cache": "BYPASS", "X-Content-Type-Options": "nosniff" }
  });
}

async function authenticate(request, env, cors) {
  const config = supabaseConfig(env);
  if (!config) return { error: publicError(503, "storage_unavailable", "Private storage is temporarily unavailable.", cors) };
  const authorization = String(request.headers.get("Authorization") || "");
  if (!/^Bearer\s+\S+$/i.test(authorization) || authorization.length > 5000) {
    return { error: publicError(401, "auth_required", "Sign in to use private screenplay storage.", cors) };
  }
  let response;
  try {
    response = await fetch(`${config.url}/auth/v1/user`, {
      headers: { apikey: config.key, Authorization: authorization, Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { error: publicError(503, "identity_unavailable", "Account verification is temporarily unavailable.", cors) };
  }
  if (!response.ok) return { error: publicError(401, "invalid_session", "Your session has expired. Sign in again.", cors) };
  const user = await response.json().catch(() => null);
  if (!user?.id) return { error: publicError(401, "invalid_session", "Your session has expired. Sign in again.", cors) };
  return { user: { id: String(user.id), email: String(user.email || "") }, authorization, config };
}

async function authorizeScreenplay(request, screenplayId, env, cors) {
  if (!ALLOWED_SCREENPLAY_ID.test(screenplayId)) {
    return { error: publicError(400, "invalid_screenplay", "Choose a valid screenplay.", cors) };
  }
  if (!env.PRIVATE_MEDIA) {
    return { error: publicError(503, "storage_unavailable", "Private storage is temporarily unavailable.", cors) };
  }
  const auth = await authenticate(request, env, cors);
  if (auth.error) return auth;
  const query = new URLSearchParams({
    id: `eq.${screenplayId}`,
    owner_user_id: `eq.${auth.user.id}`,
    select: "id,client_fingerprint,title,page_count,spoken_character_count",
    limit: "1"
  });
  let response;
  try {
    response = await fetch(`${auth.config.url}/rest/v1/screenplays?${query}`, {
      headers: { apikey: auth.config.key, Authorization: auth.authorization, Accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    return { error: publicError(503, "ownership_unavailable", "Screenplay ownership could not be verified.", cors) };
  }
  if (response.status === 401) return { error: publicError(401, "invalid_session", "Your session has expired. Sign in again.", cors) };
  if (!response.ok) return { error: publicError(503, "ownership_unavailable", "Screenplay ownership could not be verified.", cors) };
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || !rows[0]?.id) {
    return { error: publicError(404, "screenplay_not_found", "That screenplay is not part of your private library.", cors) };
  }
  return { ...auth, screenplay: rows[0] };
}

function screenplayObjectKey(ownerId, screenplayId) {
  return `users/${ownerId}/screenplays/${screenplayId}/screenplay.json`;
}

function audioObjectKey(ownerId, screenplayId, cacheKey) {
  return `users/${ownerId}/screenplays/${screenplayId}/audio/${cacheKey}.mp3`;
}

async function handleScreenplayContent(request, screenplayId, env, cors) {
  const access = await authorizeScreenplay(request, screenplayId, env, cors);
  if (access.error) return access.error;
  const key = screenplayObjectKey(access.user.id, screenplayId);
  if (request.method === "GET") {
    const object = await env.PRIVATE_MEDIA.get(key);
    if (!object) return publicError(404, "content_not_found", "That screenplay does not have a private copy yet.", cors);
    const headers = new Headers({ ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return new Response(object.body, { status: 200, headers });
  }

  const parsed = await readJson(request, MAX_SCREENPLAY_BODY_BYTES, cors);
  if (parsed.error) return parsed.error;
  const fingerprint = String(parsed.body?.clientFingerprint || "");
  const screenplay = parsed.body?.screenplay;
  if (fingerprint !== access.screenplay.client_fingerprint) {
    return publicError(409, "screenplay_mismatch", "The private screenplay copy did not match its library record.", cors);
  }
  if (!screenplay || typeof screenplay !== "object" || !Array.isArray(screenplay.units) || !screenplay.units.length || screenplay.units.length > 20_000) {
    return publicError(400, "invalid_screenplay", "The screenplay structure could not be saved.", cors);
  }
  const stored = JSON.stringify({ clientFingerprint: fingerprint, screenplay, storedAt: new Date().toISOString() });
  if (new TextEncoder().encode(stored).byteLength > MAX_SCREENPLAY_BODY_BYTES) {
    return publicError(413, "request_too_large", "That screenplay is too large for private storage.", cors);
  }
  await env.PRIVATE_MEDIA.put(key, stored, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { ownerId: access.user.id, screenplayId, fingerprint, schema: "spokenframe-screenplay-v1" }
  });
  return json({ saved: true }, 200, { ...cors, "Cache-Control": "no-store" });
}

function normalizedCacheSettings(value = {}) {
  return {
    format: value.format === "mp3_44100_128" ? value.format : "",
    readCharacterNames: value.readCharacterNames === true,
    normalizationVersion: Number.isInteger(Number(value.normalizationVersion)) ? Number(value.normalizationVersion) : 0
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectedAudioCacheKey({ text, voiceId, model, settings }) {
  return sha256(JSON.stringify({ version: 1, provider: "elevenlabs", model, voiceId, text, settings }));
}

function privateAudioResponse(object, env, cors, cacheStatus) {
  const headers = new Headers({ ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-SpokenFrame-Model": env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL, "X-SpokenFrame-Cache": cacheStatus, "X-Content-Type-Options": "nosniff" });
  return new Response(object.body ?? object, { status: 200, headers });
}

async function handlePrivateAudio(request, screenplayId, cacheKey, env, cors) {
  if (!ALLOWED_CACHE_KEY.test(cacheKey)) return publicError(400, "cache_identity", "That audio identity is invalid.", cors);
  const access = await authorizeScreenplay(request, screenplayId, env, cors);
  if (access.error) return access.error;
  const premiumAccess = await checkPremiumEntitlement(access, env, cors);
  if (premiumAccess.error) return premiumAccess.error;
  const objectKey = audioObjectKey(access.user.id, screenplayId, cacheKey);
  const existing = await env.PRIVATE_MEDIA.get(objectKey);
  if (existing) return privateAudioResponse(existing, env, cors, "HIT");

  const parsed = await readJson(request, MAX_TTS_BODY_BYTES, cors);
  if (parsed.error) return parsed.error;
  const speech = validateSpeech(parsed.body, cors);
  if (speech.error) return speech.error;
  const settings = normalizedCacheSettings(parsed.body?.cacheSettings);
  if (!settings.format || settings.normalizationVersion < 1 || settings.normalizationVersion > 100) {
    return publicError(400, "cache_identity", "That audio identity is invalid.", cors);
  }
  const model = env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;
  const expected = await expectedAudioCacheKey({ text: speech.text, voiceId: speech.voiceId, model, settings });
  if (expected !== cacheKey) return publicError(409, "cache_identity", "That audio identity did not match the requested passage.", cors);

  const reservation = await reservePremiumGeneration(access, env, cors, {
    cacheKey,
    voiceId: speech.voiceId,
    model,
    characterCount: speech.text.length
  });
  if (reservation.error) return reservation.error;

  const limited = await enforceGenerationRateLimit(request, env, cors, access.user.id);
  if (limited) {
    if (reservation.eventId) await finalizePremiumGeneration(env, reservation.eventId, false, "rate_limit").catch(() => {});
    return limited;
  }
  const generated = await generateAudio(speech.text, speech.voiceId, env, cors);
  if (generated.error) {
    if (reservation.eventId) await finalizePremiumGeneration(env, reservation.eventId, false, "provider_error").catch(() => {});
    return generated.error;
  }
  try {
    await env.PRIVATE_MEDIA.put(objectKey, generated.audio, {
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: { ownerId: access.user.id, screenplayId, cacheKey, voiceId: speech.voiceId, model: generated.model, characters: String(speech.text.length) }
    });
  } catch (error) {
    console.error("Private audio cache write failed", { name: error?.name, message: error?.message });
    if (reservation.eventId) await finalizePremiumGeneration(env, reservation.eventId, true).catch(() => {});
    return privateAudioResponse(generated.audio, env, cors, "BYPASS");
  }
  if (reservation.eventId) {
    await finalizePremiumGeneration(env, reservation.eventId, true).catch((error) => {
      console.error("Premium generation accounting could not finalize", { name: error?.name, message: error?.message });
    });
  }
  return privateAudioResponse(generated.audio, env, cors, "MISS");
}

function privateRoute(path) {
  const content = path.match(/^\/v1\/screenplays\/([^/]+)\/content$/);
  if (content) return { kind: "content", screenplayId: decodeURIComponent(content[1]) };
  const audio = path.match(/^\/v1\/screenplays\/([^/]+)\/audio\/([^/]+)$/);
  if (audio) return { kind: "audio", screenplayId: decodeURIComponent(audio[1]), cacheKey: decodeURIComponent(audio[2]) };
  const entitlement = path.match(/^\/v1\/screenplays\/([^/]+)\/entitlement$/);
  if (entitlement) return { kind: "entitlement", screenplayId: decodeURIComponent(entitlement[1]) };
  const checkout = path.match(/^\/v1\/screenplays\/([^/]+)\/checkout$/);
  if (checkout) return { kind: "checkout", screenplayId: decodeURIComponent(checkout[1]) };
  return null;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    if (path === "/v1/billing/webhook") {
      if (request.method !== "POST") return publicError(405, "method_not_allowed", "That payment endpoint requires POST.", { Allow: "POST" });
      return handleStripeWebhook(request, env);
    }
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (!cors["Access-Control-Allow-Origin"]) return publicError(403, "origin_denied", "This site is not allowed to use this SpokenFrame Worker.", { "Vary": "Origin" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === "GET" && path === "/v1/status") {
        if (!env.ELEVENLABS_API_KEY) return publicError(503, "not_configured", "Premium audio has not been configured.", cors);
        return json({ ok: true, model: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL, privateStorage: privateStorageReady(env), billing: billingReady(env) }, 200, { ...cors, "Cache-Control": "no-store" });
      }
      if (request.method === "GET" && path === "/v1/voices") return handleVoices(env, cors);
      if (request.method === "POST" && path === "/v1/tts") {
        if (premiumEntitlementsRequired(env)) return publicError(404, "not_found", "That SpokenFrame endpoint does not exist.", cors);
        return handleSpeech(request, env, cors);
      }

      const route = privateRoute(path);
      if (route?.kind === "content" && ["GET", "POST"].includes(request.method)) return handleScreenplayContent(request, route.screenplayId, env, cors);
      if (route?.kind === "audio" && request.method === "POST") return handlePrivateAudio(request, route.screenplayId, route.cacheKey, env, cors);
      if (route?.kind === "entitlement" && request.method === "GET") {
        const access = await authorizeScreenplay(request, route.screenplayId, env, cors);
        return access.error || handleEntitlement(access, env, cors);
      }
      if (route?.kind === "checkout" && request.method === "POST") {
        const access = await authorizeScreenplay(request, route.screenplayId, env, cors);
        return access.error || handleCheckout(access, env, cors);
      }
      return publicError(404, "not_found", "That SpokenFrame endpoint does not exist.", cors);
    } catch (error) {
      console.error("Worker request failed", { name: error?.name, message: error?.message });
      return publicError(503, "worker_error", "Premium audio is temporarily unavailable.", cors);
    }
  }
};
