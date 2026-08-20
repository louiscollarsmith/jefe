// @ts-check

export const CAPABILITY_AVAILABILITY = Object.freeze({
  available: "AVAILABLE",
  needsAuthorization: "NEEDS_AUTHORIZATION",
  needsConfiguration: "NEEDS_CONFIGURATION",
  needsInput: "NEEDS_INPUT",
  providerPreview: "PROVIDER_PREVIEW",
  unsupportedByJefe: "UNSUPPORTED_BY_JEFE",
  unsupportedByProvider: "UNSUPPORTED_BY_PROVIDER",
});

export const INTENDED_ACTOR = Object.freeze({
  jefe: "JEFE",
  merchant: "MERCHANT",
  external: "EXTERNAL",
});

export const SHOPIFY_ACTION_CAPABILITIES = [
  {
    ref: "shopify.inventory_transfer.create",
    provider: "SHOPIFY",
    domain: "inventory",
    operation: "inventory_transfer.create",
    write: true,
    apiSurface: "Admin GraphQL",
    apiVersion: "2026-07",
    stability: "stable",
    requiredScopes: ["write_inventory_transfers"],
    providerSupport: "SUPPORTED_BY_PROVIDER",
    jefeSupport: "IMPLEMENTED_BY_JEFE",
    availability: CAPABILITY_AVAILABILITY.available,
    intendedActor: INTENDED_ACTOR.jefe,
    approvalPolicy: "MERCHANT_REQUIRED",
    idempotency: "required_idempotent_directive",
  },
  {
    ref: "shopify.inventory_purchase_order.read",
    provider: "SHOPIFY",
    domain: "inventory",
    operation: "inventory_purchase_order.read",
    write: false,
    apiSurface: "Admin GraphQL unstable",
    apiVersion: "unstable",
    stability: "feature_preview",
    requiredScopes: ["read_inventory_purchase_orders"],
    providerSupport: "PREVIEW_ONLY",
    jefeSupport: "NOT_IMPLEMENTED",
    availability: CAPABILITY_AVAILABILITY.providerPreview,
    intendedActor: INTENDED_ACTOR.jefe,
    approvalPolicy: "NONE",
    idempotency: "none",
  },
  {
    ref: "shopify.inventory_purchase_order.create",
    provider: "SHOPIFY",
    domain: "inventory",
    operation: "inventory_purchase_order.create",
    write: true,
    apiSurface: "Admin GraphQL",
    apiVersion: "2026-07",
    stability: "not_public",
    requiredScopes: ["write_inventory_purchase_orders"],
    providerSupport: "NOT_AVAILABLE",
    jefeSupport: "NOT_IMPLEMENTED",
    availability: CAPABILITY_AVAILABILITY.unsupportedByProvider,
    intendedActor: INTENDED_ACTOR.jefe,
    approvalPolicy: "MERCHANT_REQUIRED_WHEN_AVAILABLE",
    idempotency: "not_available",
  },
];

export function listShopifyActionCapabilities() {
  return SHOPIFY_ACTION_CAPABILITIES.map((row) => ({ ...row }));
}

/** @param {unknown} ref */
export function getShopifyActionCapability(ref) {
  const key = String(ref ?? "").trim();
  return SHOPIFY_ACTION_CAPABILITIES.find((row) => row.ref === key) ?? null;
}

/** @param {any} step */
export function resolveStepCapabilityTruth(step) {
  const text = `${step?.title ?? ""} ${step?.capabilityRef ?? ""}`.toLowerCase();
  if (/purchase order|\bpo\b/.test(text)) {
    return getShopifyActionCapability("shopify.inventory_purchase_order.create");
  }
  if (/inventory.*transfer|transfer.*inventory|shopify.*transfer/.test(text)) {
    return getShopifyActionCapability("shopify.inventory_transfer.create");
  }
  return null;
}
