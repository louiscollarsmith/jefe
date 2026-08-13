// @ts-check

// The single approve→execute entry point for a listing-copy action run — the direct parallel
// of `wireClearanceExecution`, for the second executable primitive. Records the approval
// transition (proposed→approved) inline, then the flag-gated adapter
// (`applyListingCopyChange`) does the store write. Flag-off is a safe no-op: the approval is
// recorded, nothing is written.
//
// ⚠️ Still UNWIRED to a surface: nothing calls this yet. `LISTING_COPY_EXECUTE_ENABLED` is on
// in production, so the Settings dial is live — but until a surface calls this on approve,
// setting that dial does nothing. Closing that gap is the remaining step.

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { createListingCopyShopifyClient } from "./listing-copy-shopify-client.server.js";
import {
  applyListingCopyChange,
  isListingCopyExecuteEnabled,
} from "./listing-copy-adapter.server.js";

const log = baseLogger.child({ component: "listing-copy-execution" });

/**
 * Load the merchant's offline Shopify token for a shop — same pattern as the clearance wire.
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
 * Record approval + (only when execution is enabled) run the listing-copy write.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: string }} session  the online action session — we take session.shop
 * @param {{ merchantId: string; actionRunId: string; mode: "approve" | "auto" }} input
 * @param {{ createGqlClient?: (opts: any) => { request: (q: string, v?: any) => Promise<any> }; loadOfflineToken?: (prisma: any, shop: string) => Promise<string> }} [deps]  test/refresh seam
 */
export async function wireListingCopyExecution(prisma, session, input, deps = {}) {
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
  if (row.actionType !== "listing_copy") {
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

  if (!isListingCopyExecuteEnabled()) {
    log.info("listing copy approved; execution disabled (flag off) — no store write", {
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
  const shopifyClient = createListingCopyShopifyClient(gqlClient);

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

  log.info("listing copy execution starting", {
    runId: row.runId,
    shopId: row.shopId,
    mode,
    productCount: preview.changes.length,
  });

  try {
    const result = await applyListingCopyChange({ prisma, shopifyClient, execution }, preview);
    if (Number(result.skipped?.length) > 0) {
      // Not an error: the merchant typed those products themselves between propose and
      // execute, and the adapter correctly left them alone. Worth seeing, because a high rate
      // means Jefe is proposing things the merchant is already busy fixing.
      log.warn("listing copy skipped writes (merchant typed upstream)", {
        runId: row.runId,
        shopId: row.shopId,
        skippedCount: result.skipped.length,
      });
    }
    log.info("listing copy execution complete", {
      runId: row.runId,
      shopId: row.shopId,
      appliedCount: result.applied.length,
      skippedCount: result.skipped.length,
      refusedCount: result.refused?.length ?? 0,
    });
    return { ok: true, executed: true, ...result };
  } catch (error) {
    // The adapter has already auto-reverted whatever this run applied. Error-level forwards
    // to the ops alerter via the logger's onError.
    log.error("listing copy execution failed — auto-reverted", {
      runId: row.runId,
      shopId: row.shopId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      executed: true,
      reason: "execution_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
