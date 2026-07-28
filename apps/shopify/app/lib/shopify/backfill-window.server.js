// @ts-check

// Single source of truth for the Shopify order/refund backfill history window.
//
// Configurable per deploy: dial down for cost-sensitive installs, up for
// high-value stores (up to the max). Additive + reversible — change the env, no
// schema, no code. A longer window unlocks the year-over-year / seasonality
// belief class; the cost is install-time API throughput, not storage.
//
// NOTE: this only applies with the `read_all_orders` scope. Without it Shopify
// caps order history at 60 days (see FALLBACK_WITHOUT_READ_ALL_ORDERS_DAYS in
// shopify-backfill-status.server.js), independent of this window.

const DAYS_PER_MONTH = 30.44;

/** @param {number} months */
export function monthsToDays(months) {
  return Math.round(months * DAYS_PER_MONTH);
}

/**
 * @param {string} name
 * @param {number} fallback
 */
function envMonths(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Default order/refund history window, in months. 24 = a full year-over-year
// comparison plus two seasonal cycles for the single-market design-partner ICP.
export const BACKFILL_WINDOW_MONTHS = envMonths("BACKFILL_WINDOW_MONTHS", 24);

// Hard ceiling, in months, so a mis-set request can never fetch unbounded
// history. Never below the configured default. Raise for "all history" installs.
export const MAX_BACKFILL_MONTHS = Math.max(
  envMonths("BACKFILL_MAX_MONTHS", 60),
  BACKFILL_WINDOW_MONTHS,
);

export const DEFAULT_BACKFILL_DAYS = monthsToDays(BACKFILL_WINDOW_MONTHS);
export const MAX_BACKFILL_DAYS = monthsToDays(MAX_BACKFILL_MONTHS);
