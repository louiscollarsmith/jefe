// @ts-check

import { readStandaloneSession } from "./standalone-session.server.js";

/**
 * Decide how an `/app` request should authenticate: EMBEDDED (Shopify admin
 * iframe, App Bridge session token) or STANDALONE (out-of-iframe,
 * app.mynamejefe.com, our signed cookie) — the decision behind the
 * `authenticateAppRequest` seam.
 *
 * HOST-PRIMARY (per architecture steer, chat 7): the standalone surface is
 * served by a dedicated Shopify-API instance on its own host
 * (app.mynamejefe.com), while the embedded app loads from SHOPIFY_APP_URL (a
 * different host). That genuine host separation makes the host the clean,
 * primary discriminator:
 *  - Standalone host → standalone surface: a valid host-scoped cookie resolves
 *    the shop (`unauthenticated.admin`); no cookie → send to standalone sign-in.
 *  - Any other host → embedded, handled by `authenticate.admin` unchanged
 *    (it owns the App Bridge session-token dance, including first-load bootstrap).
 *
 * The standalone cookie is SameSite=Lax and host-scoped, so it is never even
 * sent on the cross-site embedded-iframe requests — there is no cross-surface
 * collision to resolve. The host is read from the proxy-forwarded value
 * (`X-Forwarded-Host` behind Railway) so a proxy hop cannot fool it.
 */

/** Default public host the standalone surface is served on. */
const DEFAULT_STANDALONE_HOST = "app.mynamejefe.com";

/**
 * The public host the standalone surface is served on (env-overridable).
 * Exported so the dedicated standalone Shopify-API instance mints its OAuth
 * `redirect_uri` on exactly this host — one source of truth for "standalone host".
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function standaloneAppHost(env = process.env) {
  return (env.STANDALONE_APP_HOST || DEFAULT_STANDALONE_HOST)
    .trim()
    .toLowerCase();
}

/**
 * The public host the request arrived on, preferring the proxy-forwarded host
 * (Railway terminates TLS and forwards), then `Host`, then the URL. Lower-cased,
 * port stripped.
 * @param {Request} request
 * @returns {string}
 */
export function requestHost(request) {
  const forwarded = request.headers.get("X-Forwarded-Host");
  const host =
    forwarded || request.headers.get("Host") || new URL(request.url).host;
  return String(host).split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * Whether the request arrived on the standalone host — the primary discriminator.
 * @param {Request} request
 * @param {string} [standaloneHost]
 * @returns {boolean}
 */
export function isStandaloneHost(request, standaloneHost = standaloneAppHost()) {
  return requestHost(request) === standaloneHost;
}

/**
 * Resolve the authentication mode for an `/app` request.
 *
 * - `"embedded"` → hand to `authenticate.admin(request)` (unchanged).
 * - `"standalone"` → resolve via the standalone cookie + `unauthenticated.admin`.
 * - `"standalone-login"` → a logged-out standalone visitor; redirect to sign-in.
 *
 * @param {Request} request
 * @param {{ session?: import("./standalone-session.server.js").StandaloneSession | null }} [options]
 *   `session` injects the already-read standalone session (tests / avoiding a
 *   double read); when omitted it is read from the request.
 * @returns {Promise<"embedded" | "standalone" | "standalone-login">}
 */
export async function resolveAuthMode(request, options = {}) {
  if (!isStandaloneHost(request)) return "embedded";

  const session =
    options.session !== undefined
      ? options.session
      : await readStandaloneSession(request);
  return session ? "standalone" : "standalone-login";
}
