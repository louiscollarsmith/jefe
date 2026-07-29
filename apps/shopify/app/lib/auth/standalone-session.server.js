// @ts-check

import { createCookie } from "react-router";

import { parseShopDomain } from "./shop-domain.server.js";

/**
 * Signed standalone-session cookie for the out-of-iframe app surface
 * (app.mynamejefe.com), the counterpart to Shopify App Bridge session tokens
 * used embedded.
 *
 * SECURITY MODEL (per architecture steer):
 * - The cookie carries ONLY `{ shop, iat, exp }` — an integrity-SIGNED but not
 *   secret identity claim. It grants nothing on its own.
 * - The merchant's offline Shopify access token NEVER leaves the server; every
 *   standalone request re-resolves an admin client from session storage via
 *   `unauthenticated.admin(shop)`. So the blast radius of a stolen/leaked
 *   cookie is "identifies which shop", never "grants Shopify API access".
 * - Signing rides React Router's framework cookie (HMAC via `secrets`) rather
 *   than a hand-rolled MAC — least custom crypto, and it supports key rotation
 *   (add older secrets after the primary; they verify but never sign).
 * - Attributes: httpOnly (no JS access), secure in production (HTTPS-only),
 *   sameSite=lax (survives the top-level OAuth redirect back, blocks cross-site
 *   POST), path=/, short-lived + sliding refresh.
 *
 * The shop value is validated with `parseShopDomain` on the way in AND on the
 * way out, so a forged-but-somehow-valid cookie still cannot smuggle a
 * non-`*.myshopify.com` host into a session lookup.
 */

const COOKIE_NAME = "jefe_standalone_session";

/**
 * Sliding session lifetime. Deliberately short: a standalone session is a
 * convenience that is cheaply re-minted by re-resolving the offline token, so a
 * shorter window bounds the value of a stolen cookie. Refreshed once past its
 * half-life (see {@link sessionNeedsRefresh}).
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h
const REFRESH_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;

/**
 * @typedef {Object} StandaloneSession
 * @property {string} shop Canonical `<shop>.myshopify.com`.
 * @property {number} iat Issued-at, unix seconds.
 * @property {number} exp Expiry, unix seconds.
 */

/**
 * Secrets used to sign/verify the cookie: the primary `SESSION_SECRET` plus any
 * comma-separated rotated secrets (which verify old cookies during a rotation
 * but never sign new ones). Throws on missing config so a misdeploy fails loud.
 * @returns {string[]}
 */
function cookieSecrets() {
  const primary = (process.env.SESSION_SECRET || "").trim();
  if (!primary) {
    throw new Error(
      "SESSION_SECRET must be set to sign standalone session cookies",
    );
  }
  const rotated = (process.env.STANDALONE_SESSION_SECRET_ROTATED || "")
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);
  return [primary, ...rotated];
}

/** Secure cookies only over HTTPS; disabled in dev so http://localhost works. */
function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
}

/** @returns {import("react-router").Cookie} */
function sessionCookie() {
  return createCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProductionRuntime(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secrets: cookieSecrets(),
  });
}

/** @returns {number} */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Serialize a signed `Set-Cookie` header establishing a standalone session for
 * `shop`. Refuses (throws) to issue a session for a non-`*.myshopify.com` host.
 *
 * @param {string} shop
 * @param {{ nowSeconds?: number }} [options] `nowSeconds` overrides the clock (tests).
 * @returns {Promise<string>}
 */
export async function serializeStandaloneSession(shop, options = {}) {
  const validShop = parseShopDomain(shop);
  if (!validShop) {
    throw new Error(
      "refusing to issue a standalone session for a non-myshopify shop",
    );
  }
  const iat = options.nowSeconds ?? nowSeconds();
  const exp = iat + SESSION_TTL_SECONDS;
  return sessionCookie().serialize({ shop: validShop, iat, exp });
}

/**
 * Read + verify the standalone session from a request's `Cookie` header.
 * Returns the session, or `null` for: no cookie, bad signature (tamper),
 * malformed payload, a non-`*.myshopify.com` shop, or an expired session.
 * A missing `SESSION_SECRET` throws (misconfig surfaces to the error hook).
 *
 * @param {Request} request
 * @param {{ nowSeconds?: number }} [options]
 * @returns {Promise<StandaloneSession | null>}
 */
export async function readStandaloneSession(request, options = {}) {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  // Build the cookie outside the try so a config error (missing secret) throws
  // loudly rather than being swallowed as "no session".
  const cookie = sessionCookie();
  let value;
  try {
    value = await cookie.parse(header);
  } catch {
    // Malformed/undecodable cookie value → treat as unauthenticated.
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const shop = parseShopDomain(value.shop);
  const iat = Number(value.iat);
  const exp = Number(value.exp);
  if (!shop || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;

  const now = options.nowSeconds ?? nowSeconds();
  if (exp <= now) return null;

  return { shop, iat, exp };
}

/**
 * Whether a session is past its half-life and should be re-issued (sliding
 * refresh). Callers re-serialize with a fresh `iat`/`exp` and set the cookie.
 *
 * @param {StandaloneSession | null | undefined} session
 * @param {{ nowSeconds?: number }} [options]
 * @returns {boolean}
 */
export function sessionNeedsRefresh(session, options = {}) {
  if (!session || !Number.isFinite(session.iat)) return false;
  const now = options.nowSeconds ?? nowSeconds();
  return now - session.iat >= REFRESH_AFTER_SECONDS;
}

/**
 * Serialize a `Set-Cookie` header that clears the standalone session (logout).
 * @returns {Promise<string>}
 */
export async function destroyStandaloneSession() {
  return sessionCookie().serialize("", { maxAge: 0 });
}
