// @ts-check

// Deterministic, timezone-pinned date labels for the app home — the fix for the
// SSR/hydration date mismatch (React #418/#425/#423) Matt hit ("Tuesday 11 August"
// on the 12th). Two rules make a label hydration-safe:
//   1. NEVER call `new Date()` at render — the server (SSR) and browser evaluate it
//      at different instants, so near midnight they produce different calendar days.
//      The CURRENT-day label is computed once in the loader (computeHomeDateLabel)
//      and passed as a prop; the component never recomputes it.
//   2. ALWAYS pin an explicit timeZone — a bare toLocaleDateString formats in the
//      RENDERER's zone (server=UTC, browser=merchant-local), which differs. Both a
//      fixed-instant label (formatDateInZone) and the today label pin the zone.
//
// The zone is the SERVICE's, never the viewer's browser (house rule). For a per-
// merchant Shopify app the "service" is the STORE, so callers pass the store's
// ianaTimezone (falling back to the default below when it isn't known yet). Pure +
// no `new Date()` inside → unit-testable at a fixed instant across ambient zones.

/** Fallback when the merchant's store timezone/locale isn't known yet. */
export const DEFAULT_HOME_TIME_ZONE = "Europe/London";
export const DEFAULT_HOME_LOCALE = "en-GB";

/**
 * The single, deliberate "now" read for the home. It lives HERE, not in the route
 * module, for two reasons: (1) `computeHomeDateLabel` stays a pure function of its
 * inputs (unit-testable at a fixed instant); (2) the route module (app._index.tsx)
 * stays free of any bare `new Date()`, which the onboarding hydration-safety lint
 * forbids there — a render-time clock read is the exact SSR/browser mismatch bug.
 * This is called from the LOADER (server-only, once per request), where reading the
 * clock is safe: the resulting label is serialized and the component never recomputes.
 * @returns {Date}
 */
export function currentServerInstant() {
  return new Date();
}

/**
 * The current-day header label ("Wednesday, 12 August"), computed from an instant
 * the CALLER provides (the loader passes `new Date()` — server-side, once). Pinned
 * to the store zone so SSR + hydration render identical text.
 * @param {{ now: Date; timeZone?: string | null; locale?: string | null }} input
 * @returns {string}
 */
export function computeHomeDateLabel(input) {
  const timeZone = input.timeZone || DEFAULT_HOME_TIME_ZONE;
  const locale = input.locale || DEFAULT_HOME_LOCALE;
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone,
    }).format(input.now);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_HOME_LOCALE, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: DEFAULT_HOME_TIME_ZONE,
    }).format(input.now);
  }
}

/**
 * A short "12 Aug" label for a FIXED ISO instant (e.g. an action's appliedAt).
 * The instant is fixed, so this is hydration-safe as long as the zone is pinned —
 * which it always is here. Empty string for a missing/invalid value.
 * @param {{ iso: string | null | undefined; timeZone?: string | null; locale?: string | null }} input
 * @returns {string}
 */
export function formatDateInZone(input) {
  if (!input.iso) return "";
  const date = new Date(input.iso);
  if (Number.isNaN(date.getTime())) return "";
  const timeZone = input.timeZone || DEFAULT_HOME_TIME_ZONE;
  const locale = input.locale || DEFAULT_HOME_LOCALE;
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_HOME_LOCALE, {
      day: "numeric",
      month: "short",
      timeZone: DEFAULT_HOME_TIME_ZONE,
    }).format(date);
  }
}

/**
 * Read the store's IANA timezone from the persisted shop rawPayload, or null when
 * it isn't known yet (the label then falls back to the default zone — never the
 * viewer's browser). Pure.
 * @param {unknown} rawPayload
 * @returns {string | null}
 */
export function storeTimeZoneFromPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const shopify = /** @type {{ shopify?: unknown }} */ (rawPayload).shopify;
  if (!shopify || typeof shopify !== "object") return null;
  const tz = /** @type {{ ianaTimezone?: unknown }} */ (shopify).ianaTimezone;
  return typeof tz === "string" && tz.trim() ? tz : null;
}
