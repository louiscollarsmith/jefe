// @ts-check

import { redirect } from "react-router";

import { resolveAuthMode } from "./auth-mode.server.js";
import { readStandaloneSession } from "./standalone-session.server.js";

/**
 * The dual-mode authentication seam for the `/app` route tree. The `/app`
 * loaders/actions call this instead of `authenticate.admin` directly, so the
 * SAME UI renders both embedded (Shopify admin iframe) and standalone
 * (app.mynamejefe.com), with the embedded path 100% unchanged.
 *
 * - EMBEDDED → delegate to `authenticate.admin(request)` verbatim (it owns the
 *   App Bridge session-token dance, including first-load bootstrap).
 * - STANDALONE (valid host-scoped cookie) → resolve the shop's offline session
 *   via `unauthenticated.admin(shop)`, returning the SAME `{ admin, session }`
 *   shape `authenticate.admin` returns (plus `standalone: true`).
 * - Logged-out on the standalone host → redirect to `/` (the standalone sign-in).
 *
 * The Shopify auth functions are INJECTED (`deps`) so this logic is unit-testable
 * without importing `shopify.server` (whose module side effects — the backfill
 * loop — should not run under `node --test`). In app code the loaders omit
 * `deps`; a lazy import wires the real `authenticate.admin` / `unauthenticated`
 * only when actually serving a request.
 *
 * @typedef {Object} AppAuthDeps
 * @property {(request: Request) => Promise<any>} authenticateAdmin
 * @property {(shop: string) => Promise<{ admin: any, session: any }>} unauthenticatedAdmin
 */

/** @returns {Promise<AppAuthDeps>} */
async function defaultDeps() {
  const mod = await import("../../shopify.server");
  return {
    authenticateAdmin: (request) => mod.authenticate.admin(request),
    unauthenticatedAdmin: (shop) => mod.unauthenticated.admin(shop),
  };
}

/**
 * Authenticate an `/app` request in whichever mode it arrived in.
 *
 * @param {Request} request
 * @param {AppAuthDeps} [deps] Injected Shopify auth fns (omit in app code).
 * @returns {Promise<any>} The authenticated admin context (`{ admin, session, ... }`).
 */
export async function authenticateAppRequest(request, deps) {
  const session = await readStandaloneSession(request);
  const mode = await resolveAuthMode(request, { session });

  // Logged-out standalone visitor → sign-in. (Thrown Response, RR-style.)
  if (mode === "standalone-login" || (mode === "standalone" && !session)) {
    throw redirect("/");
  }

  const resolved = deps ?? (await defaultDeps());

  if (mode === "embedded") {
    return resolved.authenticateAdmin(request);
  }

  // Standalone: `session` is guaranteed non-null here (the guard above already
  // redirected standalone-without-session); this also narrows the type.
  if (!session) throw redirect("/");

  // Re-resolve the offline token server-side; it never rides the cookie.
  // Returns the same shape the embedded loaders already consume. If it can't be
  // resolved (e.g. the shop uninstalled while the cookie was still valid), treat
  // the merchant as logged out — a clean redirect to sign-in, never a 500.
  let ctx;
  try {
    ctx = await resolved.unauthenticatedAdmin(session.shop);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw redirect("/");
  }
  return { admin: ctx.admin, session: ctx.session, standalone: true };
}
