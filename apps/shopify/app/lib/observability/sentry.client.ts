import * as Sentry from "@sentry/react";

/**
 * Client-side Sentry — the browser half of error capture. Catches render errors
 * surfaced by the root `ErrorBoundary` and, via Sentry's default global handlers,
 * uncaught errors and unhandled promise rejections. These never reach the
 * server-side `handleError` hook, so before this they vanished silently.
 *
 * INERT unless `VITE_SENTRY_DSN` is set at build time (Vite inlines `VITE_*`
 * into the client bundle). A Sentry DSN is a public identifier — safe to ship to
 * the browser. PII posture mirrors the server (`sentry.server.js`):
 * `sendDefaultPii` off and request cookies/body/headers dropped in `beforeSend`.
 * We attach only explicit, caller-provided context (never raw payloads).
 */

let initialized = false;

export function initClientSentry(): boolean {
  if (initialized) return false;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment:
      (import.meta.env.VITE_APP_ENV as string | undefined) ||
      import.meta.env.MODE ||
      "development",
    release:
      (import.meta.env.VITE_APP_VERSION as string | undefined) || undefined,
    // Errors only; performance tracing intentionally off (parity with server).
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.headers;
      }
      return event;
    },
  });
  initialized = true;
  return true;
}

export function isClientSentryEnabled(): boolean {
  return initialized;
}

/**
 * Capture an exception from the client (no-op unless initialised). Never throws.
 */
export function captureClientError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!initialized) return;
  try {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } catch {
    // Reporting an error must never itself break the app.
  }
}
