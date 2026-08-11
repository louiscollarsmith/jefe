// @ts-check
//
// Write guards for the Quiver corpus.
//
// The corpus creates Merchant/Shop rows and fills the canonical commerce tables.
// Pointed at the wrong database that would inject simulated merchants into real
// tenant data — invisible in the app (which looks shops up by `platform:"shopify"`)
// but very visible in Ops, in cross-merchant counts, and in any future benchmark
// aggregate. These guards exist so that mistake is impossible rather than unlikely.
//
// Modelled on tools/synthetic-shopify/src/importers/safety.mjs — same
// fail-closed-by-default shape, so both tools refuse for the same reasons.

import { CORPUS_PLATFORM } from "./map.mjs";

/**
 * Hosts that indicate a managed/shared database. Matching one is not proof of
 * production, but it is enough to demand the operator say so out loud.
 */
const MANAGED_DB_HOSTS = Object.freeze([
  "neon.tech",
  "railway.app",
  "rlwy.net",
  "amazonaws.com",
  "supabase.co",
]);

/**
 * Resolve and validate the corpus target database.
 *
 * Deliberately does NOT fall back to `DATABASE_URL`. Every other tool in this repo
 * reads `DATABASE_URL`, and the shells these run in usually have it exported and
 * pointing at the app's own database — an implicit fallback would make "forgot to
 * set the variable" resolve silently to the most damaging possible target.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ databaseUrl: string, host: string }}
 */
export function resolveCorpusDatabase(env = process.env) {
  if (env.ALLOW_QUIVER_CORPUS_IMPORT !== "true") {
    throw new Error(
      "Refusing to write: set ALLOW_QUIVER_CORPUS_IMPORT=true to seed the Quiver corpus.",
    );
  }

  const databaseUrl = env.QUIVER_CORPUS_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Refusing to write: QUIVER_CORPUS_DATABASE_URL is not set. " +
        "This tool never falls back to DATABASE_URL — name the corpus database explicitly.",
    );
  }

  let host;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("Refusing to write: QUIVER_CORPUS_DATABASE_URL is not a valid URL.");
  }

  const managed = MANAGED_DB_HOSTS.find((candidate) => host.endsWith(candidate));
  if (managed && env.QUIVER_CORPUS_ALLOW_MANAGED_DB !== "true") {
    throw new Error(
      `Refusing to write: ${host} looks like a managed database (${managed}). ` +
        "The corpus is for local/disposable databases. If this really is a throwaway, " +
        "set QUIVER_CORPUS_ALLOW_MANAGED_DB=true.",
    );
  }

  return { databaseUrl, host };
}

/**
 * The shop domain a Quiver merchant is simulated under.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so a corpus domain can
 * never be mistaken for — or accidentally used to reach — a real Shopify store.
 * @param {string | number} quiverMerchantId
 */
export function corpusShopDomain(quiverMerchantId) {
  const id = String(quiverMerchantId ?? "").trim();
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) {
    throw new Error(`Refusing to write: unusable Quiver merchant id ${JSON.stringify(quiverMerchantId)}.`);
  }
  return `quiver-${id.toLowerCase()}.corpus.invalid`;
}

/**
 * Assert a shop record is a corpus shop before writing commerce rows against it.
 *
 * `platform` is the structural isolation: the app resolves tenants with
 * `{ platform: "shopify", shopDomain }`, so a `quiver_sim` shop is unreachable from
 * every merchant-facing path — no session, no token, and therefore no way for the
 * action layer to write to anyone's store. This asserts that property still holds
 * rather than assuming it.
 *
 * @param {{ platform?: string | null, shopDomain?: string | null }} shop
 */
export function assertCorpusShop(shop) {
  if (shop?.platform !== CORPUS_PLATFORM) {
    throw new Error(
      `Refusing to write: shop platform is ${JSON.stringify(shop?.platform)}, expected ${CORPUS_PLATFORM}.`,
    );
  }
  if (!String(shop?.shopDomain ?? "").endsWith(".corpus.invalid")) {
    throw new Error(
      `Refusing to write: ${JSON.stringify(shop?.shopDomain)} is not a corpus shop domain.`,
    );
  }
  return shop;
}

/**
 * The salt used to pseudonymise customer emails.
 *
 * Required, and required to be long: a short or shared salt makes the customer refs
 * reversible by brute force over a known email list, which would defeat the point
 * of hashing at all.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveCustomerSalt(env = process.env) {
  const salt = env.QUIVER_CORPUS_CUSTOMER_SALT ?? "";
  if (salt.length < 16) {
    throw new Error(
      "Refusing to write: QUIVER_CORPUS_CUSTOMER_SALT must be at least 16 characters.",
    );
  }
  return salt;
}
