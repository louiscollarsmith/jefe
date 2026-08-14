// @ts-check

// The single approve→execute entry point for a clearance action run — called from
// the app action on a merchant approve (mode "approve") or the autonomous path
// (mode "auto"). It records the approval transition (proposed→approved) inline —
// folded into this single execute fn per the 3-mode model, since there's no
// approve-without-execute — then the flag-gated adapter (applyClearance) does the
// store write. Flag-off is a safe no-op — the approval is recorded, nothing written.
//
// ⚠️ This is the wiring that makes clearance LIVE. It is UNWIRED until the app action
// calls it, and the actual store write stays behind CLEARANCE_EXECUTE_ENABLED. Going
// live is: the surface calls this on approve/auto + the merchant sets a non-recommend
// mode + the flag is flipped — a deliberate, single step.

import { ShopifyAdminGraphqlClient } from "../shopify/admin-graphql.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { createClearanceShopifyClient } from "./clearance-shopify-client.server.js";
import { applyClearance, isClearanceExecuteEnabled } from "./clearance-adapter.server.js";
import { updateMerchantActionForExecution } from "./merchant-action.server.js";

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
 * @param {{ createGqlClient?: (opts: any) => { request: (q: string, v?: any) => Promise<any> }; loadOfflineToken?: (prisma: any, shop: string) => Promise<string> }} [deps]  test/refresh seam
 * @returns {Promise<{ ok: boolean; executed: boolean; reason?: string; status?: string } & Record<string, unknown>>}
 */
export async function wireClearanceExecution(prisma, session, input, deps = {}) {
  const { merchantId, actionRunId, mode } = input;
  const row = await prisma.actionExecution.findUnique({ where: { runId: actionRunId } });
  if (!row || row.merchantId !== merchantId) {
    return { ok: false, executed: false, reason: "not_found" };
  }
  const preview = /** @type {any} */ (row.preview);

  // ⛔ This function executes ONE primitive — the clearance adapter — and does not dispatch on
  // action type. Refuse any other type explicitly rather than relying on it never arriving.
  //
  // Before this, nothing here checked: a foreign row would pass the `preview.changes` test (a
  // product-status preview also has `.changes`), be gated on CLEARANCE_EXECUTE_ENABLED rather
  // than its own flag, and reach `applyClearance`. It stopped only at a Prisma NOT NULL
  // constraint on `targetRef` (a product-status change carries `productId`, not `variantId`) —
  // an accident of the schema, not a decision. The single thing preventing it in practice was
  // `RESOLVERS` having no second entry, which puts the safety in the resolver map rather than
  // on the write path. When a second action type registers, it gets its own wire fn; this one
  // says no.
  if (row.actionType !== "price_markdown") {
    return { ok: false, executed: false, reason: `wrong_primitive:${row.actionType}`, status: row.status };
  }

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

  // Record proposed → approved inline. approvedBy tells apart a merchant tap from an
  // autonomous run. The row's status is the guard: only proposed/approved execute.
  const approvedBy = mode === "auto" ? "auto" : merchantId;
  if (row.status === "applied" || row.status === "partially_applied") {
    return { ok: true, executed: false, reason: "already_applied", status: row.status };
  }
  if (row.status !== "proposed" && row.status !== "approved") {
    // rejected / reverted / failed — not a state we execute from.
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
  // status "approved" (fresh or pre-existing, e.g. approved while the flag was off) —
  // fall through and execute; applyClearance is itself idempotent per write.

  if (!isClearanceExecuteEnabled()) {
    log.info("clearance approved; execution disabled (flag off) — no store write", {
      runId: actionRunId,
      shopId: row.shopId,
      mode,
    });
    return { ok: true, executed: false, reason: "execution_disabled", status: "approved" };
  }

  // Build the live write client scoped to the merchant's shop + offline token.
  // The loader is injectable so background/autonomous callers pass a refresh-
  // capable one (loadFreshOfflineToken) — Shopify 403s a stale offline token and
  // this write rides no embedded request that would refresh it. Default keeps the
  // raw read for tests + the flag-off no-op path.
  const loadToken = deps.loadOfflineToken ?? loadOfflineToken;
  const accessToken = await loadToken(prisma, session.shop);
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
    actionKind: row.actionKind ?? undefined,
    merchantSetting: row.merchantSetting,
    resolvedMode: row.resolvedMode,
    eligibility: /** @type {any} */ (row.eligibility),
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
