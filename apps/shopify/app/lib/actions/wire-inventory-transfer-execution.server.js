// @ts-check

// Approve -> execute for Shopify inventory transfers. This is intentionally small:
// the typed adapter owns validation, idempotency and the actual Shopify write, and
// the flag defaults off until inventory-transfer execution is explicitly launched.

import { logger as baseLogger } from "../observability/logger.server.js";
import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import {
  executeInventoryTransfer,
  isInventoryTransferExecuteEnabled,
} from "./inventory-transfer-adapter.server.js";
import { createInventoryTransferShopifyClient } from "./inventory-transfer-shopify-client.server.js";
import { updateMerchantActionForExecution } from "./merchant-action.server.js";

const log = baseLogger.child({ component: "inventory-transfer-execution" });

/**
 * Load the merchant's offline Shopify token for a shop — same pattern as the other wires.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shop
 */
async function loadOfflineToken(prisma, shop) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    throw new Error(`No offline Shopify session token for shop ${shop}`);
  }
  return session.accessToken;
}

/**
 * Record approval + (only when execution is enabled) run the transfer write.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: string }} session
 * @param {{ merchantId: string; actionRunId: string; mode: "approve" | "auto" }} input
 * @param {{ shopifyClient?: { createInventoryTransfer: (input: any) => Promise<any> }; createGqlClient?: (opts: any) => { request: (q: string, v?: any) => Promise<any> }; loadOfflineToken?: (prisma: any, shop: string) => Promise<string> }} [deps]
 */
export async function wireInventoryTransferExecution(
  prisma,
  session,
  input,
  deps = {},
) {
  const { merchantId, actionRunId, mode } = input;
  const row = await prisma.actionExecution.findUnique({
    where: { runId: actionRunId },
  });
  if (!row || row.merchantId !== merchantId) {
    return { ok: false, executed: false, reason: "not_found" };
  }
  const preview = /** @type {any} */ (row.preview);

  if (row.actionType !== "shopify_inventory_transfer") {
    return {
      ok: false,
      executed: false,
      reason: `wrong_primitive:${row.actionType}`,
      status: row.status,
    };
  }
  if (row.resolvedMode === "recommend") {
    return { ok: false, executed: false, reason: "recommend_mode", status: row.status };
  }
  if (mode === "auto" && row.resolvedMode !== "auto") {
    return { ok: false, executed: false, reason: "auto_not_authorized", status: row.status };
  }
  if (!Array.isArray(preview?.lineItems) || preview.lineItems.length === 0) {
    return { ok: false, executed: false, reason: "empty_preview", status: row.status };
  }

  const approvedBy = mode === "auto" ? "auto" : merchantId;
  if (row.status === "applied" || row.status === "partially_applied") {
    return { ok: true, executed: false, reason: "already_applied", status: row.status };
  }
  if (row.status !== "proposed" && row.status !== "approved") {
    return { ok: false, executed: false, reason: `not_executable:${row.status}`, status: row.status };
  }
  if (row.status === "proposed") {
    const claimed = await prisma.actionExecution.updateMany({
      where: { runId: actionRunId, merchantId, status: "proposed" },
      data: { status: "approved", approvedBy, approvedAt: new Date() },
    });
    if (claimed.count !== 1) {
      const fresh = await prisma.actionExecution.findUnique({
        where: { runId: actionRunId },
        select: { status: true },
      });
      return {
        ok: false,
        executed: false,
        reason: `approval_race:${fresh?.status ?? "missing"}`,
        status: fresh?.status,
      };
    }
    await updateMerchantActionForExecution(prisma, {
      merchantId: row.merchantId,
      shopId: row.shopId,
      actionRunId: row.runId,
      execution: { ...row, status: "approved", approvedBy },
    });
  }

  if (!isInventoryTransferExecuteEnabled()) {
    log.info("inventory transfer approved; execution disabled (flag off) - no store write", {
      runId: actionRunId,
      shopId: row.shopId,
      mode,
    });
    return { ok: true, executed: false, reason: "execution_disabled", status: "approved" };
  }

  let shopifyClient = deps.shopifyClient;
  if (!shopifyClient) {
    const loadToken = deps.loadOfflineToken ?? loadOfflineToken;
    const accessToken = await loadToken(prisma, session.shop);
    const createGqlClient =
      deps.createGqlClient ?? ((opts) => new ShopifyAdminGraphqlClient(opts));
    const gqlClient = createGqlClient({
      shopDomain: session.shop,
      accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: log,
    });
    shopifyClient = createInventoryTransferShopifyClient(gqlClient);
  }

  const result = await executeInventoryTransfer(prisma, {
    actionId: row.merchantActionId ?? row.runId,
    executionId: row.id,
    merchantId: row.merchantId,
    shopId: row.shopId,
    idempotencyKey: `${row.runId}:inventory_transfer`,
    preview,
    shopifyClient,
    actor: approvedBy,
    logger: log,
  });
  return result.ok
    ? { ok: true, executed: true, status: "applied", result }
    : { ok: false, executed: false, reason: result.reason, status: "approved", result };
}
