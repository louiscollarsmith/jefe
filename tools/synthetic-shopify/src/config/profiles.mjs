// @ts-check

export const DEFAULT_API_VERSION = "2026-07";
export const DEFAULT_SCENARIO = "healthy_gbp";
export const SYNTHETIC_TAG = "jefe_synthetic";

export const PROFILE_DEFINITIONS = {
  smoke: {
    historyDays: 365,
    activeProducts: 18,
    archivedProducts: 1,
    draftProducts: 1,
    activeVariants: 24,
    knownCustomers: 180,
    guestOrders: 18,
    nonTestOrders: 250,
    testOrders: 3,
    refundedOrders: 15,
    refundRecords: 16,
  },
  realistic: {
    historyDays: 730,
    activeProducts: 24,
    archivedProducts: 3,
    draftProducts: 2,
    activeVariants: 34,
    knownCustomers: 780,
    guestOrders: 80,
    nonTestOrders: 1250,
    testOrders: 10,
    refundedOrders: 83,
    refundRecords: 89,
  },
  load: {
    historyDays: 730,
    activeProducts: 36,
    archivedProducts: 4,
    draftProducts: 2,
    activeVariants: 56,
    knownCustomers: 1850,
    guestOrders: 210,
    nonTestOrders: 3000,
    testOrders: 18,
    refundedOrders: 205,
    refundRecords: 218,
  },
};

export function profileNames() {
  return Object.keys(PROFILE_DEFINITIONS);
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [overrides]
 */
export function resolveProfile(name = "realistic", overrides = {}) {
  const base = PROFILE_DEFINITIONS[name];
  if (!base) {
    throw new Error(`Unknown synthetic Shopify profile: ${name}`);
  }

  return {
    name,
    ...base,
    ...numericOverrides(overrides),
  };
}

/** @param {Record<string, unknown>} overrides */
function numericOverrides(overrides) {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => Number.isFinite(value)),
  );
}
