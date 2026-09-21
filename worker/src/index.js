const MAX_TEXT_LENGTH = 1200;
const DEFAULT_MODEL = "eleven_multilingual_v2";
const ALLOWED_VOICE_ID = /^[A-Za-z0-9_-]{8,80}$/;

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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function publicError(status, code, message, cors) { return json({ code, message }, status, cors); }

function mapUpstreamError(status) {
  if (status === 401) return [502, "provider_auth", "Premium audio is not configured correctly."];
  if (status === 402 || status === 429) return [429, "quota", "Premium audio has reached its current usage limit. You can try again later or use a device voice."];
  if (status >= 500) return [503, "provider_unavailable", "Premium audio is temporarily unavailable."];
  return [502, "provider_error", "Premium audio could not generate that passage."];
}

async function elevenLabs(path, env, init = {}) {
  return fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(40000),
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, ...(init.headers || {}) }
  });
}

async function handleVoices(env, cors) {
  const response = await elevenLabs("/v2/voices?page_size=100", env);
  if (!response.ok) {
    const [status, code, message] = mapUpstreamError(response.status);
    return publicError(status, code, message, cors);
  }
  const payload = await response.json();
  const voices = (payload.voices || []).map(({ voice_id, name, labels }) => ({ voice_id, name, labels })).slice(0, 100);
  return json({ voices, model: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL }, 200, { ...cors, "Cache-Control": "private, max-age=300" });
}

async function handleSpeech(request, env, cors) {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return publicError(415, "content_type", "The request must contain JSON.", cors);
  }
  if (Number(request.headers.get("Content-Length") || 0) > 10_000) {
    return publicError(413, "request_too_large", "That passage is too large to generate safely.", cors);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 10_000) return publicError(413, "request_too_large", "That passage is too large to generate safely.", cors);
    body = JSON.parse(raw);
  }
  catch { return publicError(400, "invalid_json", "The request could not be read.", cors); }
  const text = String(body.text || "").replace(/\s+/g, " ").trim();
  const voiceId = String(body.voiceId || "");
  if (!text || text.length > MAX_TEXT_LENGTH) return publicError(400, "invalid_text", `Passages must contain 1 to ${MAX_TEXT_LENGTH} characters.`, cors);
  if (!ALLOWED_VOICE_ID.test(voiceId)) return publicError(400, "invalid_voice", "Choose a valid premium voice.", cors);

  // Optional binding. It is not authentication, but it can cap accidental bursts in a personal beta.
  if (env.GENERATION_RATE_LIMITER) {
    const key = request.headers.get("CF-Connecting-IP") || "unknown";
    const result = await env.GENERATION_RATE_LIMITER.limit({ key });
    if (!result.success) return publicError(429, "rate_limit", "Premium audio is receiving too many requests. Wait a moment and try again.", cors);
  }

  const model = env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;
  const response = await elevenLabs(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, env, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0, use_speaker_boost: true } })
  });
  if (!response.ok) {
    console.warn("ElevenLabs generation failed", { status: response.status });
    const [status, code, message] = mapUpstreamError(response.status);
    return publicError(status, code, message, cors);
  }
  return new Response(response.body, {
    status: 200,
    headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-SpokenFrame-Model": model, "X-Content-Type-Options": "nosniff" }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (!cors["Access-Control-Allow-Origin"]) return publicError(403, "origin_denied", "This site is not allowed to use this SpokenFrame Worker.", { "Vary": "Origin" });
    if (!env.ELEVENLABS_API_KEY) return publicError(503, "not_configured", "Premium audio has not been configured.", cors);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/$/, "");
    try {
      if (request.method === "GET" && path === "/v1/status") return json({ ok: true, model: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL }, 200, { ...cors, "Cache-Control": "no-store" });
      if (request.method === "GET" && path === "/v1/voices") return handleVoices(env, cors);
      if (request.method === "POST" && path === "/v1/tts") return handleSpeech(request, env, cors);
      return publicError(404, "not_found", "That SpokenFrame endpoint does not exist.", cors);
    } catch (error) {
      console.error("Worker request failed", { name: error?.name, message: error?.message });
      return publicError(503, "worker_error", "Premium audio is temporarily unavailable.", cors);
    }
  }
};
