// @ts-check

// The single approve→execute entry point for a clearance action run — called from
// the app action on a merchant approve (mode "approve") or the autonomous path
// (mode "auto"). It COMPOSES the two existing halves rather than re-implementing
// either: chat 4's approveAction records proposed→approved, and the flag-gated
// adapter (applyClearance) does the store write. Flag-off is a safe no-op — the
// approval is recorded, nothing is written.
//
// ⚠️ This is the wiring that makes clearance LIVE. It is UNWIRED until the app action
// calls it, and the actual store write stays behind CLEARANCE_EXECUTE_ENABLED. Going
// live is: the surface calls this on approve/auto + the merchant sets a non-recommend
// mode + the flag is flipped — a deliberate, single step.

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { approveAction } from "./action-resolution.server.js";
import { createClearanceShopifyClient } from "./clearance-shopify-client.server.js";
import { applyClearance, isClearanceExecuteEnabled } from "./clearance-adapter.server.js";

const log = baseLogger.child({ component: "clearance-execution" });

/**
 * Load the merchant's offline Shopify token for a shop (the backfill worker's pattern):
 * the most-recently-issued offline session carries the token the adapter writes with.
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
 * Record approval + (only when execution is enabled) run the clearance write. The
 * single fn the surface calls for both the merchant-approve and autonomous paths.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: string }} session  the online action session — we take session.shop
 * @param {{ merchantId: string; actionRunId: string; mode: "approve" | "auto" }} input
 * @param {{ createGqlClient?: (opts: any) => { request: (q: string, v?: any) => Promise<any> } }} [deps]  test seam
 * @returns {Promise<{ ok: boolean; executed: boolean; reason?: string; status?: string } & Record<string, unknown>>}
 */
export async function wireClearanceExecution(prisma, session, input, deps = {}) {
  const { merchantId, actionRunId, mode } = input;
  const row = await prisma.actionExecution.findUnique({ where: { runId: actionRunId } });
  if (!row || row.merchantId !== merchantId) {
    return { ok: false, executed: false, reason: "not_found" };
  }
  const preview = /** @type {any} */ (row.preview);

  // Safety gates BEFORE recording approval — the row's resolvedMode is authoritative
  // (it's the merchant-dial × structural-gate decision made at propose time). The
  // caller's `mode` can never widen what the merchant authorized.
  if (row.resolvedMode === "recommend") {
    return { ok: false, executed: false, reason: "recommend_mode", status: row.status };
  }
  if (mode === "auto" && row.resolvedMode !== "auto") {
    // Asked for autonomous execution, but the merchant didn't authorize it for this
    // action — never auto-write on an approve-only setting.
    return { ok: false, executed: false, reason: "auto_not_authorized", status: row.status };
  }
  if (!Array.isArray(preview?.changes) || preview.changes.length === 0) {
    return { ok: false, executed: false, reason: "empty_preview", status: row.status };
  }

  // Record proposed → approved (reuse chat 4's guarded transition; approvedBy tells
  // apart a merchant tap from an autonomous run).
  const approvedBy = mode === "auto" ? "auto" : merchantId;
  const approval = await approveAction(prisma, { merchantId, actionRunId, approvedBy });
  if (approval.status === "not_found") {
    return { ok: false, executed: false, reason: "not_found" };
  }
  if (approval.status === "not_proposable") {
    const cur = approval.currentStatus;
    if (cur === "applied" || cur === "partially_applied") {
      return { ok: true, executed: false, reason: "already_applied", status: cur };
    }
    if (cur !== "approved") {
      // rejected / reverted / failed — not a state we execute from.
      return { ok: false, executed: false, reason: `not_executable:${cur}`, status: cur };
    }
    // Already "approved" (e.g. a prior run recorded approval while the flag was off) —
    // fall through and execute now. applyClearance is itself idempotent per write.
  }

  if (!isClearanceExecuteEnabled()) {
    log.info("clearance approved; execution disabled (flag off) — no store write", {
      runId: actionRunId,
      shopId: row.shopId,
      mode,
    });
    return { ok: true, executed: false, reason: "execution_disabled", status: "approved" };
  }

  // Build the live write client scoped to the merchant's shop + offline token.
  const accessToken = await loadOfflineToken(prisma, session.shop);
  const createGqlClient =
    deps.createGqlClient ??
    ((opts) => new ShopifyAdminGraphqlClient(opts));
  const gqlClient = createGqlClient({
    shopDomain: session.shop,
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: log,
  });
  const shopifyClient = createClearanceShopifyClient(gqlClient);

  const execution = {
    runId: row.runId,
    merchantId: row.merchantId,
    shopId: row.shopId,
    actionType: row.actionType,
    actionKind: row.actionKind,
    merchantSetting: row.merchantSetting,
    resolvedMode: row.resolvedMode,
    eligibility: row.eligibility,
    confidence: row.confidence,
    approvedBy,
  };

  log.info("clearance execution starting", {
    runId: row.runId,
    shopId: row.shopId,
    mode,
    variantCount: preview.changes.length,
  });
  const result = await applyClearance({ prisma, shopifyClient, execution }, preview);
  if (!result.ok) {
    // Error-level forwards to the ops alerter (Slack) via the logger's onError.
    log.error("clearance execution failed — auto-reverted", {
      runId: row.runId,
      shopId: row.shopId,
      error: result.error,
      revertedCount: result.revertedCount,
    });
  } else {
    if (Number(result.skippedCount) > 0) {
      log.warn("clearance execution skipped writes (price drift)", {
        runId: row.runId,
        shopId: row.shopId,
        skippedCount: result.skippedCount,
      });
    }
    log.info("clearance execution complete", {
      runId: row.runId,
      shopId: row.shopId,
      status: result.status,
      appliedCount: result.appliedCount,
      skippedCount: result.skippedCount,
    });
  }
  return { executed: true, ...result };
}
