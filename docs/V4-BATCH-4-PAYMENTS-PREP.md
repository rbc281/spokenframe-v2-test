# SpokenFrame V4 — Batch 4 payments

## Status

The Batch 4 code and infrastructure are implemented. Stripe sandbox checkout, the signed webhook, encrypted Worker secrets, Supabase billing tables, customer upgrade UI, and server-side generation controls are connected.

`PREMIUM_ENTITLEMENTS_REQUIRED` deliberately remains `false` until one real end-to-end sandbox purchase is confirmed. This preserves the existing personal-beta path and provides a safe rollback while the customer flow is validated.

## Prepared architecture

- deterministic server-authoritative price tiers
- exact PDF page counts and deterministic FDX/Fountain page estimates
- one-time Stripe Checkout request construction
- raw-body Stripe webhook signature verification with replay-age checks
- server-owned payment, entitlement, webhook-idempotency, and generation-accounting tables
- owner-readable but browser-nonwritable payment and entitlement records
- a 1.5× per-screenplay generation allowance
- atomic generation reservation/finalization database functions
- an entitlement gate for private Premium Audio routes
- a release switch that disables the legacy anonymous TTS route when entitlements are enforced
- a customer upgrade modal with automatic page-based pricing
- Standard Audio for guests and free accounts, using one consistent device voice
- Premium-only multi-character Cast controls

## Price policy

| Screenplay pages | One-time Premium price |
|---:|---:|
| 1–100 | $10 |
| 101–150 | $15 |
| 151–200 | $20 |
| 201–250 | $25 |
| Each additional 50-page block | +$5 |

The Worker calculates the amount from the server-owned screenplay page count. It never accepts a price from the browser.

## Security boundary

The browser cannot create payments, entitlements, usage events, or allowance changes. Supabase Row Level Security allows an authenticated owner to read their own payment and entitlement status only. Stripe webhook processing and generation accounting require a Supabase server secret held by Cloudflare. The Worker prefers the current `sb_secret_*` key through `SUPABASE_SECRET_KEY` and retains `SUPABASE_SERVICE_ROLE_KEY` only as a legacy JWT fallback.

The webhook endpoint does not rely on CORS or an Origin header. It accepts only a valid Stripe signature over the exact raw request body. Duplicate webhook IDs are recorded and treated idempotently.

No Stripe key, webhook signing secret, Supabase server key, ElevenLabs key, or test credential is committed.

## Activation status

Completed:

1. Stripe sandbox created.
2. Batch 4 Supabase schema and database hardening applied.
3. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SUPABASE_SECRET_KEY` stored as encrypted Cloudflare Worker secrets.
4. Signed webhook registered at `/v1/billing/webhook`.
5. Frontend entitlement, pricing, and checkout flow connected.
6. Automated price, signature, webhook, entitlement, allowance, and cache tests pass.

Remaining release gate:

1. Complete one end-to-end Stripe sandbox purchase in the deployed app.
2. Confirm the webhook creates the entitlement and Premium Audio becomes available for only that screenplay.
3. Confirm uncached generation, R2 replay, and generation accounting.
4. Only then set `PREMIUM_ENTITLEMENTS_REQUIRED` to `true` and redeploy the Worker.

Do not enable the final switch before the deployed checkout UI and webhook pass that end-to-end sandbox test.
