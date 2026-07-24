// @ts-check
import { normalizeShopDomain } from "../../../../apps/shopify/app/lib/shopify/admin-graphql.server.js";

export function assertWriteSafety({ shopDomain, allowNonemptyStore = false }) {
  const normalized = normalizeShopDomain(shopDomain);
  if (process.env.ALLOW_SYNTHETIC_SHOPIFY_SEED !== "true") {
    throw new Error("Refusing to write: set ALLOW_SYNTHETIC_SHOPIFY_SEED=true for synthetic seeding.");
  }
  const allowed = splitList(process.env.SYNTHETIC_SHOPIFY_ALLOWED_SHOPS);
  if (!allowed.includes(normalized)) {
    throw new Error(`Refusing to write: ${normalized} is not in SYNTHETIC_SHOPIFY_ALLOWED_SHOPS.`);
  }
  return { shopDomain: normalized, allowNonemptyStore };
}

export function readAccessTokenFromEnv() {
  const token = process.env.SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!token) throw new Error("Missing SYNTHETIC_SHOPIFY_ADMIN_ACCESS_TOKEN.");
  return token;
}

function splitList(value = "") {
  return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}
