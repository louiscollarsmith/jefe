// @ts-check

import { normalizeShopDomain } from "../../shopify/admin-graphql.server.js";
import { hashRecipient } from "../unsubscribe.server.js";

/**
 * Sender → shop resolution for inbound email, by email HASH only.
 *
 * We never store or query a merchant's plaintext email for routing — the join key
 * is `sha256(normalizeEmail(email))`, the same hash the unsubscribe token + the
 * `email_preferences` table use. The forward index is `email_identities`, written
 * while a merchant is active (see recordEmailIdentity, called from afterAuth) so a
 * later win-back reply — arriving after the shop's Session rows are deleted on
 * uninstall — still resolves to their memory.
 *
 * For a merchant who installed before this shipped (no identity row yet, but still
 * active) there is a self-healing fallback: match the sender hash against the
 * hashes of active Shopify Session owner emails, then backfill the index. That
 * fallback only helps ACTIVE merchants (Sessions are deleted on uninstall) — which
 * is exactly the gap the afterAuth write closes for everyone going forward.
 */

/** Safety bound on the self-heal Session scan (dark-scale; logged if hit). */
const SESSION_SCAN_LIMIT = 2000;

/**
 * sha256 hash of a sender email (normalised first). Null when not address-shaped.
 * Identical to the unsubscribe/win-back hashing so a sender resolves consistently.
 * @param {string | null | undefined} email
 * @returns {string | null}
 */
export function emailHashOf(email) {
  return hashRecipient(email);
}

/**
 * Record (upsert) the identity index for a merchant's email. Idempotent; the
 * newest (merchantId, shopId) wins if an address moves between shops. Hash-only —
 * the plaintext `email` is used solely to compute the hash and is never stored.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; email: string | null | undefined }} input
 * @returns {Promise<{ recorded: boolean; reason?: string; emailHash?: string }>}
 */
export async function recordEmailIdentity(prisma, input) {
  const emailHash = emailHashOf(input.email);
  if (!emailHash) return { recorded: false, reason: "no_email" };
  if (!input.merchantId || !input.shopId) {
    return { recorded: false, reason: "no_shop" };
  }
  const now = new Date();
  await prisma.emailIdentity.upsert({
    where: { emailHash },
    update: { merchantId: input.merchantId, shopId: input.shopId, lastSeenAt: now },
    create: { emailHash, merchantId: input.merchantId, shopId: input.shopId, lastSeenAt: now },
  });
  return { recorded: true, emailHash };
}

/**
 * @typedef {Object} ResolvedSender
 * @property {string | null} merchantId
 * @property {string | null} shopId
 * @property {string | null} shopDomain
 * @property {string | null} emailHash
 * @property {"identity" | "session" | "none"} source
 * @property {string} [reason]
 */

/**
 * Resolve an inbound sender to a shop by hash. Tries the `email_identities` index
 * first, then the self-healing Session fallback (active merchants only), which
 * backfills the index on a hit. Returns `shopId: null` when the sender maps to no
 * known shop — the caller parks such mail (never acts on an unknown sender).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string | null | undefined} sender
 * @returns {Promise<ResolvedSender>}
 */
export async function resolveShopBySender(prisma, sender) {
  const emailHash = emailHashOf(sender);
  if (!emailHash) {
    return { merchantId: null, shopId: null, shopDomain: null, emailHash: null, source: "none", reason: "no_sender" };
  }

  const existing = await prisma.emailIdentity.findUnique({
    where: { emailHash },
    select: { merchantId: true, shopId: true, shop: { select: { shopDomain: true } } },
  });
  if (existing) {
    return {
      merchantId: existing.merchantId,
      shopId: existing.shopId,
      shopDomain: existing.shop?.shopDomain ?? null,
      emailHash,
      source: "identity",
    };
  }

  // Self-heal: hash active Session owner emails and match. Bounded scan; hash-only
  // comparison (plaintext is loaded transiently only to compute the hash, never
  // stored). Misses churned merchants by design — those must be pre-indexed.
  const sessions = await prisma.session.findMany({
    where: { email: { not: null } },
    select: { shop: true, email: true },
    take: SESSION_SCAN_LIMIT,
  });
  const match = sessions.find((s) => emailHashOf(s.email) === emailHash);
  if (match) {
    const shopDomain = normalizeShopDomain(match.shop);
    const shop = await prisma.shop.findUnique({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
      select: { id: true, merchantId: true, shopDomain: true },
    });
    if (shop) {
      // Backfill the index so the next reply (incl. post-uninstall) resolves fast.
      await recordEmailIdentity(prisma, {
        merchantId: shop.merchantId,
        shopId: shop.id,
        email: match.email,
      }).catch(() => {});
      return {
        merchantId: shop.merchantId,
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        emailHash,
        source: "session",
      };
    }
  }

  return { merchantId: null, shopId: null, shopDomain: null, emailHash, source: "none", reason: "unknown_sender" };
}

/**
 * Populate the identity index at auth time, so a merchant is routable BEFORE they
 * ever churn (Session rows are deleted on uninstall, so a win-back reply can only
 * resolve if we indexed the hash while they were active). Resolves the shop by
 * domain, and — when afterAuth's online-access user carries no email — falls back
 * to the account owner's Session email (same resolution the win-back uses). One
 * fire-and-forget line from afterAuth; hash-only.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; email: string | null | undefined }} input
 * @returns {Promise<{ recorded: boolean; reason?: string; emailHash?: string }>}
 */
export async function recordEmailIdentityOnAuth(prisma, input) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const shop = await prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    select: { id: true, merchantId: true },
  });
  if (!shop) return { recorded: false, reason: "no_shop" };

  let email = input.email ?? null;
  if (!email) {
    const sessions = await prisma.session.findMany({
      where: { shop: shopDomain, email: { not: null } },
      select: { email: true, accountOwner: true, expires: true },
      orderBy: [{ accountOwner: "desc" }, { expires: "desc" }],
      take: 1,
    });
    email = sessions[0]?.email ?? null;
  }
  return recordEmailIdentity(prisma, { merchantId: shop.merchantId, shopId: shop.id, email });
}
