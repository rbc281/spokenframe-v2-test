import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import {
  PREMIUM_PRICE_POLICY_VERSION,
  premiumGenerationAllowance,
  premiumPrice,
  premiumPriceCents
} from "../shared/premium-pricing.js";
import { createStripeCheckout, verifyStripeWebhook } from "../worker/src/stripe.js";
import { PremiumAccessError, PremiumAccessService } from "../js/billing/premium-access.js";
import { estimateScreenplayPages, screenplayPageDetails } from "../js/billing/screenplay-page-count.js";
import { parseFdx } from "../js/fdx-parser.js";
import { DOMParser } from "@xmldom/xmldom";

globalThis.DOMParser = DOMParser;

const tiers = new Map([
  [1, 1_000], [100, 1_000], [101, 1_500], [150, 1_500],
  [151, 2_000], [200, 2_000], [201, 2_500], [250, 2_500],
  [251, 3_000], [300, 3_000], [301, 3_500]
]);
for (const [pages, expected] of tiers) assert.equal(premiumPriceCents(pages), expected, `${pages} pages`);
assert.deepEqual(premiumPrice(120), { pages: 120, amountCents: 1_500, currency: "usd", policyVersion: PREMIUM_PRICE_POLICY_VERSION, displayAmount: "$15" });
assert.throws(() => premiumPriceCents(0), RangeError);
assert.throws(() => premiumPriceCents("unknown"), RangeError);
assert.equal(premiumGenerationAllowance(100_001), 150_002);
console.log("✓ Premium pricing tiers and 1.5× generation allowance are deterministic");

const fdx = await fs.readFile(new URL("./fixtures/representative.fdx", import.meta.url), "utf8");
const parsedScript = parseFdx(fdx, "PASSENGER");
assert.equal(estimateScreenplayPages(parsedScript), 1);
assert.deepEqual(screenplayPageDetails(parsedScript), { pageCount: 1, pageCountMethod: "screenplay-estimate-v1" });
assert.deepEqual(screenplayPageDetails({ source: { pageCount: 120 }, units: parsedScript.units }), { pageCount: 120, pageCountMethod: "pdf-exact" });
console.log("✓ PDF page counts remain exact while FDX/Fountain receive a deterministic estimate");

let checkoutRequest;
const checkout = await createStripeCheckout({
  secretKey: "stripe-test-key",
  screenplay: { id: "11111111-1111-4111-8111-111111111111", title: "PASSENGER" },
  owner: { id: "user-1", email: "Roger@Example.com" },
  price: premiumPrice(120),
  successUrl: "https://example.test/?checkout=success",
  cancelUrl: "https://example.test/?checkout=cancelled",
  fetchImpl: async (url, init) => {
    checkoutRequest = { url, init };
    return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.test/session" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
});
assert.equal(checkout.id, "cs_test_123");
assert.equal(checkoutRequest.url, "https://api.stripe.com/v1/checkout/sessions");
assert.equal(checkoutRequest.init.headers.Authorization, "Bearer stripe-test-key");
const form = new URLSearchParams(checkoutRequest.init.body);
assert.equal(form.get("line_items[0][price_data][unit_amount]"), "1500");
assert.equal(form.get("mode"), "payment");
assert.equal(form.get("metadata[screenplay_id]"), "11111111-1111-4111-8111-111111111111");
assert.equal(form.get("metadata[user_id]"), "user-1");
assert.equal(form.get("customer_email"), "roger@example.com");
assert.equal(form.has("api_key"), false);
console.log("✓ Checkout request uses only the server-calculated one-time price and safe metadata");

const accessRequests = [];
const premiumAccess = new PremiumAccessService({
  workerUrl: "https://worker.example/",
  tokenProvider: async () => "signed-user-token",
  fetchImpl: async (url, init = {}) => {
    accessRequests.push({ url, init });
    if (url.endsWith("/entitlement")) return new Response(JSON.stringify({ premium: false, checkoutAvailable: true, pages: 120, displayAmount: "$15" }), { status: 200 });
    return new Response(JSON.stringify({ checkoutUrl: "https://checkout.stripe.com/c/pay/test-session" }), { status: 200 });
  }
});
assert.equal((await premiumAccess.entitlement("screenplay-1")).displayAmount, "$15");
assert.equal(await premiumAccess.startCheckout("screenplay-1"), "https://checkout.stripe.com/c/pay/test-session");
assert(accessRequests.every(({ init }) => init.headers.Authorization === "Bearer signed-user-token"));
await assert.rejects(
  () => new PremiumAccessService({ workerUrl: "https://worker.example", tokenProvider: async () => "token", fetchImpl: async () => new Response(JSON.stringify({ checkoutUrl: "https://attacker.example" }), { status: 200 }) }).startCheckout("screenplay-1"),
  (error) => error instanceof PremiumAccessError && error.code === "checkout_unavailable"
);
console.log("✓ Browser checkout client requires an authenticated token and a Stripe-hosted redirect");

const payload = JSON.stringify({ id: "evt_test_123", type: "checkout.session.completed" });
const timestamp = 1_800_000_000;
const webhookSecret = "webhook-test-key";
const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${payload}`).digest("hex");
assert.equal(await verifyStripeWebhook(payload, `t=${timestamp},v1=${signature}`, webhookSecret, { nowSeconds: timestamp }), true);
assert.equal(await verifyStripeWebhook(`${payload} `, `t=${timestamp},v1=${signature}`, webhookSecret, { nowSeconds: timestamp }), false);
assert.equal(await verifyStripeWebhook(payload, `t=${timestamp - 301},v1=${signature}`, webhookSecret, { nowSeconds: timestamp }), false);
console.log("✓ Webhook verification rejects modified and stale payloads");

const migration = await fs.readFile(new URL("../supabase/migrations/202609270002_v4_premium_billing.sql", import.meta.url), "utf8");
for (const table of ["premium_payments", "premium_entitlements", "premium_generation_events", "stripe_webhook_events"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  assert.match(migration, new RegExp(`revoke all on public\\.${table} from anon`, "i"));
}
assert.match(migration, /owners can read their Premium entitlements/i);
assert.match(migration, /grant select on public\.premium_entitlements to authenticated/i);
assert.doesNotMatch(migration, /sk_(?:live|test)_|whsec_|sb_secret_|service_role\s*=/i);
console.log("✓ Billing migration keeps payment proof and usage writes server-owned and contains no credentials");

const hardening = await fs.readFile(new URL("../supabase/migrations/202609290001_v4_database_hardening.sql", import.meta.url), "utf8");
assert.match(hardening, /revoke execute on function public\.rls_auto_enable\(\) from public, anon, authenticated/i);
assert.match(hardening, /premium_payments_screenplay_owner_idx/i);
assert.doesNotMatch(hardening, /sk_(?:live|test)_|whsec_|sb_secret_/i);
console.log("✓ Database hardening removes public helper execution and covers owner foreign keys");
