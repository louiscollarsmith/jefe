// @ts-check

// The single approve→execute entry point for a tidy-up action run — the direct parallel of
// `wireClearanceExecution` and `wireListingCopyExecution`, for the third executable primitive.
// Records the approval transition (proposed→approved) inline, then the flag-gated adapter
// (`applyProductStatusChange`) does the store write. Flag-off is a safe no-op: the approval is
// recorded, nothing is written.
//
// Reached via `executeApprovedAction`, which dispatches on the row's own actionType — so a
// merchant approving a tidy-up lands here and not in the clearance wire.

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { createProductStatusShopifyClient } from "./product-status-shopify-client.server.js";
import {
  applyProductStatusChange,
  isProductStatusExecuteEnabled,
} from "./product-status-adapter.server.js";

const log = baseLogger.child({ component: "tidy-up-execution" });

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
 * Record approval + (only when execution is enabled) run the product-status write.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: string }} session  the online action session — we take session.shop
 * @param {{ merchantId: string; actionRunId: string; mode: "approve" | "auto" }} input
 * @param {{ createGqlClient?: (opts: any) => { request: (q: string, v?: any) => Promise<any> }; loadOfflineToken?: (prisma: any, shop: string) => Promise<string> }} [deps]  test/refresh seam
 */
export async function wireTidyUpExecution(prisma, session, input, deps = {}) {
  const { merchantId, actionRunId, mode } = input;
  const row = await prisma.actionExecution.findUnique({ where: { runId: actionRunId } });
  if (!row || row.merchantId !== merchantId) {
    return { ok: false, executed: false, reason: "not_found" };
  }
  const preview = /** @type {any} */ (row.preview);

  // ⛔ This function executes ONE primitive and does not dispatch on action type. The
  // clearance wire learned this the hard way: a foreign row passed its `preview.changes`
  // check, was gated on the WRONG flag, and only stopped at an accidental NOT NULL
  // constraint. Refuse anything that isn't ours, explicitly.
  if (row.actionType !== "tidy_up") {
    return { ok: false, executed: false, reason: `wrong_primitive:${row.actionType}`, status: row.status };
  }

  // Safety gates BEFORE recording approval — the row's resolvedMode is authoritative (the
  // merchant-dial × structural-gate decision made at propose time). The caller's `mode` can
  // never widen what the merchant authorised.
  if (row.resolvedMode === "recommend") {
    return { ok: false, executed: false, reason: "recommend_mode", status: row.status };
  }
  if (mode === "auto" && row.resolvedMode !== "auto") {
    return { ok: false, executed: false, reason: "auto_not_authorized", status: row.status };
  }
  if (!Array.isArray(preview?.changes) || preview.changes.length === 0) {
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
  }

  if (!isProductStatusExecuteEnabled()) {
    log.info("tidy-up approved; execution disabled (flag off) — no store write", {
      runId: actionRunId,
      shopId: row.shopId,
      mode,
    });
    return { ok: true, executed: false, reason: "execution_disabled", status: "approved" };
  }

  // Build the live write client scoped to the merchant's shop + offline token. The loader is
  // injectable so background/autonomous callers can pass a refresh-capable one — Shopify 403s
  // a stale offline token and this write rides no embedded request that would refresh it.
  const loadToken = deps.loadOfflineToken ?? loadOfflineToken;
  const accessToken = await loadToken(prisma, session.shop);
  const createGqlClient = deps.createGqlClient ?? ((opts) => new ShopifyAdminGraphqlClient(opts));
  const gqlClient = createGqlClient({
    shopDomain: session.shop,
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    logger: log,
  });
  const shopifyClient = createProductStatusShopifyClient(gqlClient);

  const execution = {
    runId: row.runId,
    merchantId: row.merchantId,
    shopId: row.shopId,
    actionType: row.actionType,
    actionKind: row.actionKind ?? undefined,
    merchantSetting: row.merchantSetting,
    resolvedMode: row.resolvedMode,
    eligibility: /** @type {any} */ (row.eligibility),
    confidence: row.confidence,
    approvedBy,
  };

  log.info("tidy-up execution starting", {
    runId: row.runId,
    shopId: row.shopId,
    mode,
    productCount: preview.changes.length,
  });

  // ⚠️ `applyProductStatusChange` SIGNALS FAILURE BY RETURN VALUE, not by throwing — unlike
  // the clearance and listing-copy adapters, which throw. Both paths are handled here on
  // purpose: the returned `{ ok: false }` is a write that failed and was auto-reverted, while
  // a THROW is one of the adapter's own guards refusing to run at all (flag off, missing
  // ledger, missing client, recommend-mode, over-cap). Treating the returned failure as
  // success is the exact bug this comment exists to prevent — it would report a reverted
  // tidy-up to the merchant as done.
  try {
    const result = await applyProductStatusChange({ prisma, shopifyClient, execution }, preview);
    if (!result.ok) {
      // The adapter has already put back whatever this run applied and marked the row
      // reverted. Error-level forwards to the ops alerter via the logger's onError.
      log.error("tidy-up execution failed — auto-reverted", {
        runId: row.runId,
        shopId: row.shopId,
        error: result.error,
        revertedCount: result.revertedCount,
        revertFailureCount: result.revertFailures?.length ?? 0,
      });
      return { ok: false, executed: true, reason: "execution_failed", error: result.error };
    }
    if (Number(result.skippedCount) > 0) {
      // Not an error: the merchant changed those products' status themselves between propose
      // and execute, and the adapter's compare-and-set correctly left them alone. Worth
      // seeing, because a high rate means Jefe is proposing tidy-ups they're already doing.
      log.warn("tidy-up skipped writes (status drifted upstream)", {
        runId: row.runId,
        shopId: row.shopId,
        skippedCount: result.skippedCount,
      });
    }
    log.info("tidy-up execution complete", {
      runId: row.runId,
      shopId: row.shopId,
      status: result.status,
      appliedCount: result.appliedCount,
      skippedCount: result.skippedCount,
    });
    // Spread first: `result.ok` is already true on this branch, and letting it land after
    // our own `ok` would silently make the wire's contract depend on the adapter's field
    // order. The wire owns `ok`/`executed`; the adapter owns the counts.
    return { ...result, ok: true, executed: true };
  } catch (error) {
    // A guard refused to run — nothing was written, so there is nothing to revert.
    log.error("tidy-up execution refused before writing", {
      runId: row.runId,
      shopId: row.shopId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      executed: false,
      reason: "execution_refused",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
