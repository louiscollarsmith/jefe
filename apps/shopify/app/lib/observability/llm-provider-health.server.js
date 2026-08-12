// @ts-check

// In-memory rolling window of LLM primary→fallback transitions, so a degraded
// provider posture (primary erroring, fallback carrying traffic) is visible on
// /health and the ops panel — not just a log grep. Mirrors webhook-health.
//
// The provider swap (Groq primary, Gemini fallback) made this necessary: the
// fallback path only logged a warn per transition, so sustained full-time
// fallback operation — e.g. a bad GROQ_API_KEY, or Groq rate-limiting all day —
// was invisible outside the logs. `fallbacksInWindow` climbing (or a low
// `lastFallbackAgoMs`) is the signal that the primary is not actually serving.
//
// Per-process + in-memory (like webhook-health / inbound-email health): the web
// process and the backfill worker each keep their own window. That's fine for a
// health signal — each surface reports the fallbacks it saw.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** @type {number[]} */
let fallbackAt = [];
/** @type {{ at: number; fromProvider: string; fromModel: string; toProvider: string; toModel: string } | null} */
let last = null;

/**
 * @param {number} now
 */
function prune(now) {
  const cutoff = now - WINDOW_MS;
  if (fallbackAt.length && fallbackAt[0] < cutoff) {
    fallbackAt = fallbackAt.filter((t) => t >= cutoff);
  }
}

/**
 * Record one primary→fallback transition. Fire-and-forget from the provider
 * layer; never throws (a health tracker must not affect generation).
 *
 * @param {{ fromProvider?: string; fromModel?: string; toProvider?: string; toModel?: string }} info
 * @param {number} [now]
 */
export function recordLlmFallback(info, now = Date.now()) {
  try {
    fallbackAt.push(now);
    last = {
      at: now,
      fromProvider: String(info.fromProvider ?? "unknown"),
      fromModel: String(info.fromModel ?? "unknown"),
      toProvider: String(info.toProvider ?? "unknown"),
      toModel: String(info.toModel ?? "unknown"),
    };
    prune(now);
  } catch {
    // never let health tracking break a generation
  }
}

/**
 * Health snapshot for /health. `fallbacksInWindow` > 0 means the primary
 * provider failed at least once recently; a high count or a very low
 * `lastFallbackAgoMs` means the fallback is carrying live traffic.
 *
 * @param {number} [now]
 * @returns {{ windowMs: number; fallbacksInWindow: number; lastFallbackAgoMs: number | null; lastFallbackFrom: string | null }}
 */
export function getLlmProviderHealth(now = Date.now()) {
  prune(now);
  return {
    windowMs: WINDOW_MS,
    fallbacksInWindow: fallbackAt.length,
    lastFallbackAgoMs: last ? now - last.at : null,
    lastFallbackFrom: last ? `${last.fromProvider}:${last.fromModel}` : null,
  };
}

/** Test-only reset of the in-memory window. */
export function __resetLlmProviderHealth() {
  fallbackAt = [];
  last = null;
}
