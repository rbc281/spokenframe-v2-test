import { premiumGenerationAllowance, premiumPrice } from "../../shared/premium-pricing.js";
import { createStripeCheckout, verifyStripeWebhook } from "./stripe.js";

const MAX_WEBHOOK_BYTES = 256_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

function publicError(status, code, message, headers = {}) {
  return json({ code, message }, status, headers);
}

function appUrl(env) {
  const value = String(env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(value) || /^http:\/\/localhost(?::\d+)?$/i.test(value) ? value : "";
}

function serviceConfig(env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  // Prefer Supabase's current opaque server key. Keep the legacy variable as a
  // migration fallback for existing deployments that still use a JWT-based
  // service_role key.
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && key ? { url, key } : null;
}

function serviceKeyHeaders(key) {
  // New sb_secret_* keys are opaque and must only be sent in the apikey header.
  // Legacy service_role keys are JWTs and also require Authorization.
  const looksLikeLegacyJwt = /^eyJ[^.]*\.[^.]+\.[^.]+$/.test(key);
  return {
    apikey: key,
    ...(looksLikeLegacyJwt ? { Authorization: `Bearer ${key}` } : {})
  };
}

export function billingReady(env) {
  return Boolean(
    String(env.STRIPE_SECRET_KEY || "").trim()
    && String(env.STRIPE_WEBHOOK_SECRET || "").trim()
    && serviceConfig(env)
    && appUrl(env)
  );
}

export function premiumEntitlementsRequired(env) {
  return String(env.PREMIUM_ENTITLEMENTS_REQUIRED || "").toLowerCase() === "true";
}

async function serviceRequest(env, path, init = {}) {
  const config = serviceConfig(env);
  if (!config) throw new Error("Billing database access is not configured.");
  return fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...serviceKeyHeaders(config.key),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {})
    },
    signal: init.signal || AbortSignal.timeout(12_000)
  });
}

async function serviceRows(env, path) {
  const response = await serviceRequest(env, path);
  if (!response.ok) throw new Error(`Billing database query failed (${response.status}).`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function serviceUpsert(env, table, row, conflict) {
  const response = await serviceRequest(env, `${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
  if (!response.ok) throw new Error(`Billing database write failed (${response.status}).`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}

async function activeEntitlement(env, screenplayId, ownerId) {
  const query = new URLSearchParams({
    screenplay_id: `eq.${screenplayId}`,
    owner_user_id: `eq.${ownerId}`,
    status: "eq.active",
    select: "screenplay_id,status,amount_paid_cents,page_count_at_purchase,generation_allowance,generated_character_count,reserved_character_count",
    limit: "1"
  });
  return (await serviceRows(env, `premium_entitlements?${query}`))[0] || null;
}

export async function checkPremiumEntitlement(access, env, cors) {
  if (!premiumEntitlementsRequired(env)) return { enforced: false };
  if (!billingReady(env)) {
    return { error: publicError(503, "billing_unavailable", "Premium Audio is temporarily unavailable.", cors) };
  }
  try {
    const entitlement = await activeEntitlement(env, access.screenplay.id, access.user.id);
    if (!entitlement) {
      return { error: publicError(402, "premium_required", "Unlock Premium Audio for this screenplay to continue.", cors) };
    }
    return { enforced: true, entitlement };
  } catch (error) {
    console.error("Premium entitlement check failed", { name: error?.name, message: error?.message });
    return { error: publicError(503, "billing_unavailable", "Premium Audio is temporarily unavailable.", cors) };
  }
}

export async function reservePremiumGeneration(access, env, cors, { cacheKey, voiceId, model, characterCount }) {
  if (!premiumEntitlementsRequired(env)) return { enforced: false };
  try {
    const response = await serviceRequest(env, "rpc/reserve_premium_generation", {
      method: "POST",
      body: JSON.stringify({
        p_screenplay_id: access.screenplay.id,
        p_owner_user_id: access.user.id,
        p_cache_key: cacheKey,
        p_voice_id: voiceId,
        p_model_id: model,
        p_character_count: characterCount,
        p_is_regeneration: false,
        p_estimated_provider_cost_micros: 0
      })
    });
    if (!response.ok) throw new Error(`Generation reservation failed (${response.status}).`);
    const payload = await response.json().catch(() => []);
    const reservation = Array.isArray(payload) ? payload[0] : payload;
    if (reservation?.decision === "reserved" && reservation.event_id) return { enforced: true, eventId: reservation.event_id };
    if (reservation?.decision === "generation_in_progress") {
      return { error: publicError(409, "generation_in_progress", "That passage is already being prepared. Try again in a moment.", cors) };
    }
    if (reservation?.decision === "allowance_exhausted") {
      return { error: publicError(429, "premium_limit", "This screenplay has reached its Premium Audio generation limit.", cors) };
    }
    if (reservation?.decision === "premium_required") {
      return { error: publicError(402, "premium_required", "Unlock Premium Audio for this screenplay to continue.", cors) };
    }
    return { error: publicError(409, "cache_unavailable", "That Premium passage needs to be prepared again.", cors) };
  } catch (error) {
    console.error("Premium generation reservation failed", { name: error?.name, message: error?.message });
    return { error: publicError(503, "billing_unavailable", "Premium Audio is temporarily unavailable.", cors) };
  }
}

export async function finalizePremiumGeneration(env, eventId, succeeded, errorCode = null) {
  if (!eventId) return false;
  const response = await serviceRequest(env, "rpc/finalize_premium_generation", {
    method: "POST",
    body: JSON.stringify({ p_event_id: eventId, p_succeeded: succeeded, p_error_code: errorCode })
  });
  if (!response.ok) throw new Error(`Generation accounting finalization failed (${response.status}).`);
  return response.json().catch(() => false);
}

export async function handleEntitlement(access, env, cors) {
  if (!billingReady(env)) return json({ premium: false, checkoutAvailable: false }, 200, cors);
  try {
    const entitlement = await activeEntitlement(env, access.screenplay.id, access.user.id);
    const price = premiumPrice(access.screenplay.page_count);
    return json({
      premium: Boolean(entitlement),
      checkoutAvailable: true,
      status: entitlement?.status || "standard",
      pages: price.pages,
      amountCents: price.amountCents,
      displayAmount: price.displayAmount
    }, 200, cors);
  } catch (error) {
    console.error("Entitlement lookup failed", { name: error?.name, message: error?.message });
    return publicError(503, "billing_unavailable", "Premium purchase information is temporarily unavailable.", cors);
  }
}

export async function handleCheckout(access, env, cors) {
  if (!billingReady(env)) return publicError(503, "checkout_unavailable", "Premium checkout is not available yet.", cors);
  const pages = Number(access.screenplay.page_count);
  const spokenCharacters = Number(access.screenplay.spoken_character_count);
  if (!Number.isInteger(pages) || pages < 1 || !Number.isInteger(spokenCharacters) || spokenCharacters < 1) {
    return publicError(409, "pricing_unavailable", "SpokenFrame couldn’t calculate Premium pricing for this screenplay yet.", cors);
  }
  try {
    if (await activeEntitlement(env, access.screenplay.id, access.user.id)) {
      return publicError(409, "already_premium", "Premium Audio is already unlocked for this screenplay.", cors);
    }
    const price = premiumPrice(pages);
    const base = appUrl(env);
    const session = await createStripeCheckout({
      secretKey: env.STRIPE_SECRET_KEY,
      screenplay: access.screenplay,
      owner: access.user,
      price,
      successUrl: `${base}/?checkout=success&screenplay=${encodeURIComponent(access.screenplay.id)}`,
      cancelUrl: `${base}/?checkout=cancelled&screenplay=${encodeURIComponent(access.screenplay.id)}`
    });
    return json({ checkoutUrl: session.url }, 200, cors);
  } catch (error) {
    console.error("Checkout creation failed", { name: error?.name, status: error?.status, message: error?.message });
    return publicError(503, "checkout_unavailable", "Premium checkout couldn’t start. Please try again.", cors);
  }
}

async function readWebhookBody(request) {
  if (Number(request.headers.get("Content-Length") || 0) > MAX_WEBHOOK_BYTES) throw new Error("Webhook payload is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) throw new Error("Webhook payload is too large.");
  return raw;
}

async function webhookAlreadyProcessed(env, eventId) {
  const query = new URLSearchParams({ event_id: `eq.${eventId}`, select: "event_id", limit: "1" });
  return (await serviceRows(env, `stripe_webhook_events?${query}`)).length > 0;
}

async function ownedScreenplay(env, screenplayId, ownerId) {
  const query = new URLSearchParams({
    id: `eq.${screenplayId}`,
    owner_user_id: `eq.${ownerId}`,
    select: "id,owner_user_id,title,page_count,spoken_character_count",
    limit: "1"
  });
  return (await serviceRows(env, `screenplays?${query}`))[0] || null;
}

async function recordCompletedCheckout(env, event) {
  const session = event.data?.object;
  if (event.type !== "checkout.session.completed" || session?.payment_status !== "paid") return;
  const ownerId = String(session.metadata?.user_id || "");
  const screenplayId = String(session.metadata?.screenplay_id || "");
  if (!UUID.test(ownerId) || !UUID.test(screenplayId)) throw new Error("Checkout metadata is invalid.");
  const screenplay = await ownedScreenplay(env, screenplayId, ownerId);
  if (!screenplay) throw new Error("Checkout screenplay ownership could not be verified.");
  const price = premiumPrice(screenplay.page_count);
  if (session.mode !== "payment" || session.currency !== "usd" || Number(session.amount_total) !== price.amountCents) {
    throw new Error("Checkout amount did not match the authoritative price.");
  }
  const payment = await serviceUpsert(env, "premium_payments", {
    screenplay_id: screenplayId,
    owner_user_id: ownerId,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
    amount_paid_cents: price.amountCents,
    currency: "usd",
    status: "paid"
  }, "stripe_checkout_session_id");
  if (!payment?.id) throw new Error("Payment record could not be confirmed.");
  await serviceUpsert(env, "premium_entitlements", {
    screenplay_id: screenplayId,
    owner_user_id: ownerId,
    payment_id: payment.id,
    status: "active",
    page_count_at_purchase: price.pages,
    amount_paid_cents: price.amountCents,
    initial_spoken_character_count: screenplay.spoken_character_count,
    generation_allowance: premiumGenerationAllowance(screenplay.spoken_character_count)
  }, "screenplay_id,owner_user_id");
}

export async function handleStripeWebhook(request, env) {
  if (!billingReady(env)) return publicError(503, "billing_unavailable", "Premium billing is not configured.");
  let raw;
  try { raw = await readWebhookBody(request); }
  catch { return publicError(413, "request_too_large", "That webhook request is too large."); }
  const signature = request.headers.get("Stripe-Signature") || "";
  if (!await verifyStripeWebhook(raw, signature, env.STRIPE_WEBHOOK_SECRET).catch(() => false)) {
    return publicError(400, "invalid_signature", "That webhook signature is invalid.");
  }
  let event;
  try { event = JSON.parse(raw); }
  catch { return publicError(400, "invalid_json", "That webhook request could not be read."); }
  if (!String(event?.id || "").startsWith("evt_") || !event?.type) return publicError(400, "invalid_event", "That webhook event is invalid.");
  try {
    if (await webhookAlreadyProcessed(env, event.id)) return json({ received: true }, 200);
    await recordCompletedCheckout(env, event);
    await serviceUpsert(env, "stripe_webhook_events", { event_id: event.id, event_type: event.type }, "event_id");
    return json({ received: true }, 200);
  } catch (error) {
    console.error("Stripe webhook processing failed", { eventId: event.id, type: event.type, name: error?.name, message: error?.message });
    return publicError(503, "webhook_processing_failed", "That payment update could not be processed yet.");
  }
}
