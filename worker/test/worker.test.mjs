import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
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

class FakeR2 {
  constructor() { this.objects = new Map(); this.puts = []; }
  async get(key) {
    const entry = this.objects.get(key);
    return entry ? { body: entry.value, ...entry.options } : null;
  }
  async put(key, value, options = {}) {
    const stored = typeof value === "string" ? value : value instanceof ArrayBuffer ? value.slice(0) : value;
    this.objects.set(key, { value: stored, options });
    this.puts.push({ key, value: stored, options });
  }
}

const screenplayId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "b".repeat(64);
const privateRequest = (path, init = {}) => request(path, {
  ...init,
  headers: { Authorization: "Bearer valid-user-token", ...(init.headers || {}) }
});

function privateEnvironment(bucket = new FakeR2()) {
  return {
    ...env,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public-test-key",
    PRIVATE_MEDIA: bucket
  };
}

function cacheKeyFor(text, voiceId, model, settings) {
  return createHash("sha256").update(JSON.stringify({ version: 1, provider: "elevenlabs", model, voiceId, text, settings })).digest("hex");
}

function mockPrivateServices({ owner = true, onGeneration = () => {} } = {}) {
  return async (url, init = {}) => {
    if (String(url).endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(url).includes("/rest/v1/screenplays?")) {
      const rows = owner ? [{ id: screenplayId, client_fingerprint: fingerprint }] : [];
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("api.elevenlabs.io")) {
      onGeneration({ url, init });
      return new Response(new Uint8Array([7, 8, 9]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("private screenplay routes require an authenticated Supabase session", async () => {
  const response = await worker.fetch(request(`/v1/screenplays/${screenplayId}/content`), privateEnvironment());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "auth_required");
});

test("stores and restores normalized screenplay content under an owner-only R2 key", async () => {
  const originalFetch = globalThis.fetch;
  const bucket = new FakeR2();
  globalThis.fetch = mockPrivateServices();
  try {
    const screenplay = { title: "PASSENGER", format: "fdx", units: [{ id: "unit-1", type: "action", text: "Rain falls.", scene: "Opening" }], scenes: [], characters: [] };
    const saved = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientFingerprint: fingerprint, screenplay })
    }), privateEnvironment(bucket));
    assert.equal(saved.status, 200);
    assert.equal(bucket.puts[0].key, `users/user-1/screenplays/${screenplayId}/screenplay.json`);
    assert.equal(bucket.puts[0].options.customMetadata.ownerId, "user-1");

    const restored = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/content`), privateEnvironment(bucket));
    assert.equal(restored.status, 200);
    const payload = await restored.json();
    assert.equal(payload.clientFingerprint, fingerprint);
    assert.equal(payload.screenplay.title, "PASSENGER");
    assert.equal(restored.headers.get("Cache-Control"), "no-store");
  } finally { globalThis.fetch = originalFetch; }
});

test("denies private objects when the signed-in user does not own the screenplay", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPrivateServices({ owner: false });
  try {
    const response = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/content`), privateEnvironment());
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "screenplay_not_found");
  } finally { globalThis.fetch = originalFetch; }
});

test("generates a premium passage once and serves the second request from private R2", async () => {
  const originalFetch = globalThis.fetch;
  const bucket = new FakeR2();
  let generations = 0;
  globalThis.fetch = mockPrivateServices({ onGeneration: () => { generations += 1; } });
  try {
    const text = "Interior. A quiet room.";
    const voiceId = "voice_12345678";
    const settings = { format: "mp3_44100_128", readCharacterNames: false, normalizationVersion: 2 };
    const key = cacheKeyFor(text, voiceId, env.ELEVENLABS_MODEL_ID, settings);
    const makeRequest = () => privateRequest(`/v1/screenplays/${screenplayId}/audio/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voiceId, cacheSettings: settings })
    });
    const first = await worker.fetch(makeRequest(), privateEnvironment(bucket));
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("X-SpokenFrame-Cache"), "MISS");
    assert.equal(generations, 1);
    await first.arrayBuffer();

    const second = await worker.fetch(makeRequest(), privateEnvironment(bucket));
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("X-SpokenFrame-Cache"), "HIT");
    assert.equal(generations, 1);
    assert.equal(bucket.puts.at(-1).key, `users/user-1/screenplays/${screenplayId}/audio/${key}.mp3`);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects forged cache identities before spending premium generation", async () => {
  const originalFetch = globalThis.fetch;
  let generations = 0;
  globalThis.fetch = mockPrivateServices({ onGeneration: () => { generations += 1; } });
  try {
    const response = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/audio/${"a".repeat(64)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Different text.", voiceId: "voice_12345678", cacheSettings: { format: "mp3_44100_128", readCharacterNames: false, normalizationVersion: 2 } })
    }), privateEnvironment());
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "cache_identity");
    assert.equal(generations, 0);
  } finally { globalThis.fetch = originalFetch; }
});
