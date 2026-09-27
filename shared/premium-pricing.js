export const PREMIUM_PRICE_POLICY_VERSION = "v1";

export function normalizePageCount(value) {
  const pages = Math.ceil(Number(value));
  if (!Number.isFinite(pages) || pages < 1 || pages > 10_000) {
    throw new RangeError("A valid screenplay page count is required.");
  }
  return pages;
}

export function premiumPriceCents(pageCount) {
  const pages = normalizePageCount(pageCount);
  return 1_000 + Math.max(0, Math.ceil((pages - 100) / 50)) * 500;
}

export function premiumPrice(pageCount) {
  const pages = normalizePageCount(pageCount);
  const amountCents = premiumPriceCents(pages);
  return {
    pages,
    amountCents,
    currency: "usd",
    policyVersion: PREMIUM_PRICE_POLICY_VERSION,
    displayAmount: `$${amountCents / 100}`
  };
}

export function premiumGenerationAllowance(spokenCharacterCount, multiplier = 1.5) {
  const characters = Math.ceil(Number(spokenCharacterCount));
  const factor = Number(multiplier);
  if (!Number.isFinite(characters) || characters < 1 || characters > 10_000_000) {
    throw new RangeError("A valid spoken character count is required.");
  }
  if (!Number.isFinite(factor) || factor < 1 || factor > 3) {
    throw new RangeError("A safe generation allowance multiplier is required.");
  }
  return Math.ceil(characters * factor);
}
