// @ts-check

import * as Sentry from "@sentry/node";
import { redact } from "./redact.server.js";
import { isBenignStreamError } from "./stream-errors.server.js";

/**
 * Server-side Sentry error tracking — grouping, regressions and release tracking
 * on top of our structured logging. Completely INERT unless `SENTRY_DSN` is set,
 * so shipping this costs nothing until the DSN is configured.
 *
 * PII posture: `sendDefaultPii` is off, request cookies/body are dropped, and any
 * extra context is passed through `redact()` before send — defence-in-depth on
 * top of the fact that we only capture Error objects, not payloads.
 */

let initialized = false;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean} whether Sentry was initialised
 */
export function initSentry(env = process.env) {
  if (initialized || !env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV || env.NODE_ENV || "development",
    release: env.APP_VERSION || env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // Errors only for now; performance tracing is a later item (#7).
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event, hint) {
      // Drop already-handled benign noise so a real error stands out in Sentry:
      // a client disconnecting mid-SSR-stream, and 4xx route responses (bot POSTs
      // to actionless routes, 404s/405s). Both are logged at WARN, not faults —
      // filtering here (not only in handleError) also catches Sentry's own SDK
      // auto-instrumentation, which can capture before handleError runs.
      const original = /** @type {any} */ (hint?.originalException);
      if (isBenignStreamError(original)) return null;
      const status = Number(original?.status);
      if (Number.isFinite(status) && status >= 400 && status < 500) return null;

      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
      }
      if (event.extra) event.extra = /** @type {any} */ (redact(event.extra));
      if (event.contexts) {
        event.contexts = /** @type {any} */ (redact(event.contexts));
      }
      return event;
    },
  });
  initialized = true;
  return true;
}

/** @returns {boolean} */
export function isSentryEnabled() {
  return initialized;
}

/**
 * Capture an exception to Sentry (no-op unless initialised). Never throws.
 *
 * @param {unknown} error
 * @param {Record<string, unknown>} [context]
 */
export function captureError(error, context) {
  if (!initialized) return;
  try {
    Sentry.captureException(
      error,
      context
        ? { extra: /** @type {any} */ (redact(context)) }
        : undefined,
    );
  } catch {
    // Capturing an error must never itself break the request.
  }
}
