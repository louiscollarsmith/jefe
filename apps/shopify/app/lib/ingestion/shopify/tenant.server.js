// @ts-check

import { normalizeShopDomain } from "../../shopify/admin-graphql.server.js";
import { logger } from "../../observability/logger.server.js";

const tenantLog = logger.child({ component: "tenant" });

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; accessTokenSessionId?: string | null; scopes?: string[]; rawPayload?: unknown }} input
 */
export async function ensureShopifyTenant(prisma, input) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const existingShop = await findShopifyShop(prisma, shopDomain);

  if (existingShop) {
    // Self-heal a dangling merchant BEFORE touching the (required) relation
    // downstream, so a missing Merchant can never 5xx the shop's requests.
    const shop = existingShop.merchant
      ? existingShop
      : await relinkOrphanedShop(prisma, existingShop, shopDomain);
    return activateExistingShopifyTenant(prisma, shop, { ...input, shopDomain });
  }

  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: shopDomain,
        shops: {
          create: {
            platform: "shopify",
            shopDomain,
            rawPayload: input.rawPayload ?? {},
          },
        },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];

    await upsertConnectorAccount(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain,
      accessTokenSessionId: input.accessTokenSessionId,
      scopes: input.scopes,
      rawPayload: input.rawPayload,
    });

    return { merchant, shop };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const racedShop = await findShopifyShop(prisma, shopDomain);
    if (!racedShop) throw error;
    const shop = racedShop.merchant
      ? racedShop
      : await relinkOrphanedShop(prisma, racedShop, shopDomain);

    return activateExistingShopifyTenant(prisma, shop, {
      ...input,
      shopDomain,
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopDomain
 */
async function findShopifyShop(prisma, shopDomain) {
  const shop = await prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain } },
  });
  if (!shop) return null;
  // The `merchant` relation is REQUIRED in the schema, but the DB-level FK isn't
  // enforced yet — so a Merchant can go missing (deleted by GDPR redaction, or a
  // delete/create race) while the Shop lingers with a dangling merchantId. An
  // `include: { merchant: true }` on that row throws Prisma's "Field merchant is
  // required to return data, got null" and 5xx's EVERY request/webhook for the
  // shop (incl. app/uninstalled — the review-time incident). Fetch it separately +
  // null-safe so the caller can self-heal. (Root-cause FK constraint: chat 10.)
  const merchant = await prisma.merchant.findUnique({
    where: { id: shop.merchantId },
  });
  return { ...shop, merchant };
}

/**
 * Self-heal a Shop whose `merchant` relation is dangling (see findShopifyShop):
 * mint a fresh Merchant and relink the Shop so the tenant is consistent again
 * instead of 5xx-ing. Rare — logged at WARN so a recurring FK gap stays visible.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ id: string, merchantId: string }} shop
 * @param {string} shopDomain
 */
async function relinkOrphanedShop(prisma, shop, shopDomain) {
  const merchant = await prisma.merchant.create({ data: { name: shopDomain } });
  const relinked = await prisma.shop.update({
    where: { id: shop.id },
    data: { merchantId: merchant.id },
  });
  tenantLog.warn("Self-healed a Shop with a dangling merchant (relinked)", {
    shopDomain,
    shopId: shop.id,
    orphanedMerchantId: shop.merchantId,
    newMerchantId: merchant.id,
  });
  return { ...relinked, merchant };
}

/** How long after the last welcome a reinstall counts as a genuine return (not
 * evaluation thrash) and should be re-onboarded. */
const WELCOME_REONBOARD_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a reactivating (reinstalling) shop should have its once-forever welcome
 * claim cleared so afterAuth re-sends the Day-0 welcome. True only when the last
 * welcome is old enough that this is a real return — an uninstall+reinstall within
 * the window must NOT re-welcome, or someone evaluating the app gets a welcome on
 * every reinstall. Pure; exported for test.
 * @param {Date | string | null} welcomeEmailSentAt
 * @param {Date} now
 * @returns {boolean}
 */
export function shouldReWelcomeOnReactivation(welcomeEmailSentAt, now) {
  if (welcomeEmailSentAt == null) return false;
  return (
    now.getTime() - new Date(welcomeEmailSentAt).getTime() > WELCOME_REONBOARD_AFTER_MS
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {NonNullable<Awaited<ReturnType<typeof findShopifyShop>>>} existingShop
 * @param {{ shopDomain: string; accessTokenSessionId?: string | null; scopes?: string[]; rawPayload?: unknown }} input
 */
async function activateExistingShopifyTenant(prisma, existingShop, input) {
  // ensureShopifyTenant already heals a dangling merchant before calling here; the
  // `??` is defense-in-depth — it heals inline if a future caller passes an
  // orphan, and it narrows `merchant` to non-null. No `include: { merchant: true }`
  // on the reactivation update either — merchant is already in hand, and the
  // include would re-expose the same dangling-relation throw.
  const merchant =
    existingShop.merchant ??
    (await relinkOrphanedShop(prisma, existingShop, input.shopDomain)).merchant;
  const reWelcome = shouldReWelcomeOnReactivation(
    existingShop.welcomeEmailSentAt,
    new Date(),
  );
  const shop =
    existingShop.status === "uninstalled" ||
    existingShop.setupStatus === "uninstalled"
      ? await prisma.shop.update({
          where: { id: existingShop.id },
          // Reactivating a reinstalled shop clears the uninstall stamp too — else a
          // stale Shop.uninstalledAt lingers on an active shop (it's only re-set on
          // the next uninstall) and mislabels a live shop as churned. And when the
          // last welcome is old (>30d), clear the welcome claim so a genuinely
          // returned merchant is re-onboarded (afterAuth re-sends the welcome).
          data: {
            status: "active",
            setupStatus: "installed",
            uninstalledAt: null,
            ...(reWelcome ? { welcomeEmailSentAt: null } : {}),
          },
        })
      : existingShop;

  await upsertConnectorAccount(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: input.shopDomain,
    accessTokenSessionId: input.accessTokenSessionId,
    scopes: input.scopes,
    rawPayload: input.rawPayload,
  });

  return { merchant, shop };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain: string; accessTokenSessionId?: string | null; scopes?: string[]; rawPayload?: unknown }} input
 */
async function upsertConnectorAccount(prisma, input) {
  await prisma.connectorAccount.upsert({
    where: {
      merchantId_connector_accountExternalId: {
        merchantId: input.merchantId,
        connector: "shopify",
        accountExternalId: input.shopDomain,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      connector: "shopify",
      accountExternalId: input.shopDomain,
      status: "active",
      scopes: input.scopes ?? [],
      readTokenRef: input.accessTokenSessionId
        ? `shopify_session:${input.accessTokenSessionId}`
        : null,
      authMetadata: { tokenStorage: "shopify_session_storage" },
      rawPayload: input.rawPayload ?? {},
      connectedAt: new Date(),
    },
    update: {
      shopId: input.shopId,
      status: "active",
      scopes: input.scopes ?? undefined,
      readTokenRef: input.accessTokenSessionId
        ? `shopify_session:${input.accessTokenSessionId}`
        : undefined,
      authMetadata: { tokenStorage: "shopify_session_storage" },
      rawPayload: input.rawPayload ?? undefined,
      connectedAt: new Date(),
    },
  });
}

/** @param {unknown} error */
function isUniqueConstraintError(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopDomain
 */
export async function markShopifyInstallInactive(prisma, shopDomain) {
  const normalized = normalizeShopDomain(shopDomain);
  const shop = await prisma.shop.findUnique({
    where: {
      platform_shopDomain: { platform: "shopify", shopDomain: normalized },
    },
  });

  if (!shop) return null;

  await prisma.$transaction([
    prisma.connectorAccount.updateMany({
      where: { shopId: shop.id, connector: "shopify" },
      data: { status: "inactive" },
    }),
    prisma.shop.update({
      where: { id: shop.id },
      data: {
        status: "uninstalled",
        setupStatus: "uninstalled",
        uninstalledAt: new Date(),
      },
    }),
    prisma.backfillJob.updateMany({
      where: {
        shopId: shop.id,
        status: { in: ["queued", "running", "failed"] },
      },
      data: {
        status: "cancelled",
        failedAt: null,
        completedAt: new Date(),
        lastError: null,
      },
    }),
    prisma.session.deleteMany({ where: { shop: normalized } }),
  ]);

  return shop;
}
