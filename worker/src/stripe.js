const STRIPE_API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_SECONDS = 300;

function required(value, message) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacSha256Hex(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripeSignatureParts(header) {
  return String(header || "").split(",").reduce((result, part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return result;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") result.timestamp = Number(value);
    if (key === "v1" && value) result.signatures.push(value);
    return result;
  }, { timestamp: 0, signatures: [] });
}

export async function verifyStripeWebhook(rawBody, signatureHeader, secret, {
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS
} = {}) {
  const webhookSecret = required(secret, "Stripe webhook verification is not configured.");
  const parts = stripeSignatureParts(signatureHeader);
  if (!Number.isInteger(parts.timestamp) || !parts.signatures.length) return false;
  if (Math.abs(nowSeconds - parts.timestamp) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(webhookSecret, `${parts.timestamp}.${rawBody}`);
  return parts.signatures.some((signature) => timingSafeEqual(signature, expected));
}

export async function createStripeCheckout({
  secretKey,
  screenplay,
  owner,
  price,
  successUrl,
  cancelUrl,
  fetchImpl = globalThis.fetch
}) {
  const key = required(secretKey, "Stripe Checkout is not configured.");
  const screenplayId = required(screenplay?.id, "A screenplay is required for checkout.");
  const ownerId = required(owner?.id, "A signed-in owner is required for checkout.");
  const title = required(screenplay?.title, "A screenplay title is required for checkout.").slice(0, 300);
  const amount = Number(price?.amountCents);
  if (!Number.isInteger(amount) || amount < 100) throw new Error("The server-calculated price is invalid.");

  const metadata = {
    user_id: ownerId,
    screenplay_id: screenplayId,
    page_count: String(price.pages),
    price_policy_version: String(price.policyVersion)
  };
  const form = new URLSearchParams({
    mode: "payment",
    success_url: required(successUrl, "A checkout success URL is required."),
    cancel_url: required(cancelUrl, "A checkout cancel URL is required."),
    client_reference_id: screenplayId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": `Premium Audio — ${title}`,
    "line_items[0][price_data][product_data][description]": "One-time Premium Audio access for this screenplay",
    submit_type: "pay"
  });
  if (owner.email) form.set("customer_email", String(owner.email).trim().toLowerCase());
  for (const [name, value] of Object.entries(metadata)) {
    form.set(`metadata[${name}]`, value);
    form.set(`payment_intent_data[metadata][${name}]`, value);
  }

  const response = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id || !payload?.url) {
    const error = new Error("Stripe Checkout could not be started.");
    error.status = response.status;
    throw error;
  }
  return { id: payload.id, url: payload.url };
}
