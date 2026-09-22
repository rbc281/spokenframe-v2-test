import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { ELEVENLABS_API_KEY: "test-secret-never-logged", ALLOWED_ORIGINS: "https://user.github.io,http://localhost:8080", ELEVENLABS_MODEL_ID: "test-model" };
const request = (path, init = {}) => new Request(`https://worker.example${path}`, { ...init, headers: { Origin: "https://user.github.io", ...(init.headers || {}) } });

test("rejects origins outside the allowlist", async () => {
  const response = await worker.fetch(new Request("https://worker.example/v1/status", { headers: { Origin: "https://attacker.example" } }), env);
  assert.equal(response.status, 403);
});

test("answers approved CORS preflight without generating audio", async () => {
  const response = await worker.fetch(request("/v1/tts", { method: "OPTIONS" }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://user.github.io");
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("requires server-side secret configuration", async () => {
  const response = await worker.fetch(request("/v1/status"), { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "not_configured");
});

test("uses Flash v2.5 as the safe default model", async () => {
  const response = await worker.fetch(request("/v1/status"), { ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY, ALLOWED_ORIGINS: env.ALLOWED_ORIGINS });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "eleven_flash_v2_5");
});

test("validates text and voice identifiers before provider calls", async () => {
  const response = await worker.fetch(request("/v1/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "", voiceId: "bad" }) }), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_text");
});

test("proxies bounded speech requests without exposing the API key", async () => {
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (url, init) => {
    upstream = { url, init };
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  try {
    const response = await worker.fetch(request("/v1/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Interior. A quiet room.", voiceId: "voice_12345678" }) }), env);
    assert.equal(response.status, 200);
    assert.equal(upstream.init.headers["xi-api-key"], env.ELEVENLABS_API_KEY);
    assert.equal(upstream.init.body.includes(env.ELEVENLABS_API_KEY), false);
    assert.equal(JSON.parse(upstream.init.body).model_id, "test-model");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://user.github.io");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally { globalThis.fetch = originalFetch; }
});

test("maps upstream quota errors to a safe public response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("quota", { status: 429 });
  try {
    const response = await worker.fetch(request("/v1/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "A passage.", voiceId: "voice_12345678" }) }), env);
    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.equal(payload.code, "quota");
    assert.equal(payload.message, "Premium audio credits are unavailable.");
  } finally { globalThis.fetch = originalFetch; }
});
