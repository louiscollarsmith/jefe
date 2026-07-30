// @ts-check

import { normalizeShopDomain as strictNormalizeShopDomain } from "../shopify/admin-graphql.server.js";

/**
 * Shop-domain validation for the standalone (out-of-iframe) auth surface.
 *
 * SECURITY: the ONLY shop domains Jefe will start OAuth for, or resolve a
 * standalone session against, are canonical `<shop>.myshopify.com` hosts —
 * never a custom domain, an attacker-supplied host, or a look-alike
 * (`x.myshopify.com.evil.com`, `sub.shop.myshopify.com`). An unvalidated shop
 * value flowing into an OAuth `authorize` redirect or a session lookup would be
 * an open-redirect / SSRF / session-confusion vector, so every entry point
 * (login form, OAuth callback, cookie read, the auth seam) funnels through here.
 *
 * The canonical shape is defined once, in `normalizeShopDomain`
 * (`../shopify/admin-graphql.server.js`), which the ingestion layer already
 * uses; this module reuses it so the auth surface and the rest of the app can
 * never disagree on what a valid shop is. The only difference is ergonomics:
 * the ingestion helper THROWS on an invalid domain (it guards internal calls),
 * whereas the auth surface wants a non-throwing parse it can branch on when a
 * merchant fat-fingers the form.
 */

/**
 * Parse + normalize a user-supplied shop domain to its canonical
 * `<shop>.myshopify.com` form (lower-cased, protocol/trailing-slash stripped),
 * or `null` if it is not a valid Shopify shop domain. Never throws — callers
 * treat `null` as "not a shop we will authenticate".
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function parseShopDomain(input) {
  if (typeof input !== "string") return null;
  // Lower-case up front so the reused normalizer's (case-sensitive) protocol
  // strip also handles a fat-fingered `HTTPS://`; shop domains are
  // case-insensitive, so this never changes which host is accepted.
  const cleaned = input.trim().toLowerCase();
  if (!cleaned || cleaned.length > 255) return null;
  try {
    return strictNormalizeShopDomain(cleaned);
  } catch {
    return null;
  }
}

/**
 * Normalize the STORE-HANDLE input from the standalone sign-in form, where the
 * merchant types only the prefix and `.myshopify.com` is a fixed UI suffix.
 *
 * The `.myshopify.com` suffix is constant for every store (the permanent shop
 * domain is always `<handle>.myshopify.com`), so a bare handle with no dot gets
 * the suffix appended; a full domain (someone typed/pasted the whole thing) is
 * passed through unchanged. Either way the result is strictly validated by
 * {@link parseShopDomain}, so this can only ever return a canonical
 * `<handle>.myshopify.com` or `null`.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeShopInput(input) {
  if (typeof input !== "string") return null;
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!cleaned) return null;
  // A bare handle (no dot) → append the constant suffix. Anything with a dot is
  // treated as a full domain and validated as-is (so a pasted full domain, or a
  // non-myshopify host, is handled/rejected by parseShopDomain).
  const candidate = cleaned.includes(".") ? cleaned : `${cleaned}.myshopify.com`;
  return parseShopDomain(candidate);
}

/**
 * Whether `input` is a valid, canonical Shopify shop domain.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isValidShopDomain(input) {
  return parseShopDomain(input) !== null;
}
