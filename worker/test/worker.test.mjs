import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
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

function billingEnvironment(bucket = new FakeR2()) {
  return {
    ...privateEnvironment(bucket),
    STRIPE_SECRET_KEY: "stripe-test-key",
    STRIPE_WEBHOOK_SECRET: "webhook-test-key",
    SUPABASE_SECRET_KEY: "sb_secret_supabase-server-test-key",
    PUBLIC_APP_URL: "https://user.github.io/spokenframe"
  };
}

test("creates one-time checkout from the server-owned screenplay page count", async () => {
  const originalFetch = globalThis.fetch;
  let stripeForm;
  let supabaseServiceHeaders;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "reader@example.com" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/screenplays?")) {
      return new Response(JSON.stringify([{ id: screenplayId, client_fingerprint: fingerprint, title: "PASSENGER", page_count: 120, spoken_character_count: 100_000 }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (value.includes("/rest/v1/premium_entitlements?")) {
      supabaseServiceHeaders = init.headers;
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (value === "https://api.stripe.com/v1/checkout/sessions") {
      stripeForm = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ id: "checkout-session", url: "https://checkout.example/session" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const response = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/checkout`, { method: "POST" }), billingEnvironment());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).checkoutUrl, "https://checkout.example/session");
    assert.equal(stripeForm.get("line_items[0][price_data][unit_amount]"), "1500");
    assert.equal(stripeForm.get("metadata[screenplay_id]"), screenplayId);
    assert.equal(supabaseServiceHeaders.apikey, "sb_secret_supabase-server-test-key");
    assert.equal("Authorization" in supabaseServiceHeaders, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("checkout remains safely unavailable until every server secret is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockPrivateServices();
  try {
    const response = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/checkout`, { method: "POST" }), privateEnvironment());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "checkout_unavailable");
  } finally { globalThis.fetch = originalFetch; }
});

test("verified payment webhook grants an owner-scoped entitlement idempotently", async () => {
  const originalFetch = globalThis.fetch;
  const ownerId = "22222222-2222-4222-8222-222222222222";
  const paymentId = "33333333-3333-4333-8333-333333333333";
  const event = {
    id: "evt_spokenframe_test",
    type: "checkout.session.completed",
    data: { object: {
      id: "checkout-session", mode: "payment", payment_status: "paid", currency: "usd", amount_total: 1500,
      payment_intent: "payment-intent", metadata: { user_id: ownerId, screenplay_id: screenplayId }
    } }
  };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", "webhook-test-key").update(`${timestamp}.${raw}`).digest("hex");
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("stripe_webhook_events?") && (!init.method || init.method === "GET")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/screenplays?")) return new Response(JSON.stringify([{ id: screenplayId, owner_user_id: ownerId, title: "PASSENGER", page_count: 120, spoken_character_count: 100_000 }]), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init.method === "POST" && value.includes("/rest/v1/")) {
      const table = value.match(/\/rest\/v1\/([^?]+)/)?.[1];
      const body = JSON.parse(init.body);
      writes.push({ table, body });
      if (table === "premium_payments") return new Response(JSON.stringify([{ id: paymentId, ...body }]), { status: 201, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify([body]), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const webhookRequest = new Request("https://worker.example/v1/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${digest}` },
      body: raw
    });
    const response = await worker.fetch(webhookRequest, billingEnvironment());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
    const entitlement = writes.find(({ table }) => table === "premium_entitlements").body;
    assert.equal(entitlement.owner_user_id, ownerId);
    assert.equal(entitlement.amount_paid_cents, 1500);
    assert.equal(entitlement.generation_allowance, 150_000);
    assert(writes.some(({ table }) => table === "stripe_webhook_events"));
  } finally { globalThis.fetch = originalFetch; }
});

test("payment webhook rejects an invalid signature before database access", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("should not run"); };
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=invalid" },
      body: "{}"
    }), billingEnvironment());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_signature");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("entitlement enforcement denies unpaid generation before cache or provider access", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "reader@example.com" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/screenplays?")) return new Response(JSON.stringify([{ id: screenplayId, client_fingerprint: fingerprint, title: "PASSENGER", page_count: 120, spoken_character_count: 100_000 }]), { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/premium_entitlements?")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("api.elevenlabs.io")) providerCalls += 1;
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const text = "Interior. A quiet room.";
    const voiceId = "voice_12345678";
    const settings = { format: "mp3_44100_128", readCharacterNames: false, normalizationVersion: 2 };
    const key = cacheKeyFor(text, voiceId, env.ELEVENLABS_MODEL_ID, settings);
    const response = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/audio/${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voiceId, cacheSettings: settings })
    }), { ...billingEnvironment(), PREMIUM_ENTITLEMENTS_REQUIRED: "true" });
    assert.equal(response.status, 402);
    assert.equal((await response.json()).code, "premium_required");
    assert.equal(providerCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("paid generation reserves allowance, caches audio, and finalizes accounting", async () => {
  const originalFetch = globalThis.fetch;
  const bucket = new FakeR2();
  const eventId = "44444444-4444-4444-8444-444444444444";
  const rpcCalls = [];
  let providerCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "user-1", email: "reader@example.com" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/screenplays?")) return new Response(JSON.stringify([{ id: screenplayId, client_fingerprint: fingerprint, title: "PASSENGER", page_count: 120, spoken_character_count: 100_000 }]), { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/premium_entitlements?")) return new Response(JSON.stringify([{ screenplay_id: screenplayId, status: "active" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    if (value.includes("/rest/v1/rpc/reserve_premium_generation")) {
      rpcCalls.push({ kind: "reserve", body: JSON.parse(init.body) });
      return new Response(JSON.stringify([{ decision: "reserved", event_id: eventId, remaining_characters: 149_000 }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (value.includes("/rest/v1/rpc/finalize_premium_generation")) {
      rpcCalls.push({ kind: "finalize", body: JSON.parse(init.body) });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (value.includes("api.elevenlabs.io")) {
      providerCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const text = "Interior. A quiet room.";
    const voiceId = "voice_12345678";
    const settings = { format: "mp3_44100_128", readCharacterNames: false, normalizationVersion: 2 };
    const key = cacheKeyFor(text, voiceId, env.ELEVENLABS_MODEL_ID, settings);
    const response = await worker.fetch(privateRequest(`/v1/screenplays/${screenplayId}/audio/${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voiceId, cacheSettings: settings })
    }), { ...billingEnvironment(bucket), PREMIUM_ENTITLEMENTS_REQUIRED: "true" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-SpokenFrame-Cache"), "MISS");
    assert.equal(providerCalls, 1);
    assert.equal(rpcCalls[0].kind, "reserve");
    assert.equal(rpcCalls[0].body.p_character_count, text.length);
    assert.equal(rpcCalls[1].kind, "finalize");
    assert.equal(rpcCalls[1].body.p_succeeded, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("entitlement mode disables the legacy anonymous TTS route", async () => {
  const response = await worker.fetch(request("/v1/tts", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "A passage.", voiceId: "voice_12345678" })
  }), { ...billingEnvironment(), PREMIUM_ENTITLEMENTS_REQUIRED: "true" });
  assert.equal(response.status, 404);
});
