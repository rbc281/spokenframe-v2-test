# SpokenFrame V4 — Batch 4 payment preparation

## Status

The Stripe-independent portion of Batch 4 is implemented and tested. Checkout remains intentionally inactive until the Stripe sandbox and required Cloudflare secrets are connected.

This checkpoint does not alter current Premium Audio access. `PREMIUM_ENTITLEMENTS_REQUIRED` remains `false`, so the existing personal-beta flow continues while payment setup is incomplete.

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

## Activation sequence (not yet performed)

1. Create the Stripe sandbox.
2. Apply the Batch 4 Supabase migration.
3. Store `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SUPABASE_SECRET_KEY` as encrypted Cloudflare Worker secrets.
4. Deploy the Worker and register its `/v1/billing/webhook` URL in the Stripe sandbox.
5. Connect the frontend upgrade flow and verify sandbox checkout.
6. Confirm unpaid denial, paid generation, cache reuse, allowance accounting, and webhook idempotency.
7. Only after every test passes, set `PREMIUM_ENTITLEMENTS_REQUIRED` to `true`.

Do not enable the final switch before the checkout UI and webhook have passed end-to-end sandbox testing.
