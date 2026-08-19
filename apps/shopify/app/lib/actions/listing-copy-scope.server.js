// @ts-check

/**
 * Bounded catalog discovery for listing_copy actions.
 *
 * Recommendation-time preview and focused-chat scope resolution are separate
 * paths today: a workflow-only recommendation can exist with no materialized
 * preview. This module is the reproducible scope query that lets the Action
 * Agent discover eligible products safely at chat time.
 */

import { logger as baseLogger } from "../observability/logger.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  DEFAULT_LISTING_COPY_CAPS,
  buildListingCopyPreview,
} from "./listing-copy-adapter.server.js";
import { proposeProductTypes } from "./listing-copy-proposal.server.js";

const log = baseLogger.child({ component: "listing-copy-scope" });

export const SCOPE_STATUS = Object.freeze({
  unresolved: "unresolved",
  resolvedEmpty: "resolved_empty",
  resolvedNonempty: "resolved_nonempty",
});

/**
 * @param {{
 *   kind?: string;
 *   candidateCount?: number;
 *   keptCount?: number;
 *   discovery?: { discoveredAt?: string | null } | null;
 * }} input
 */
export function deriveScopeStatus(input) {
  const kind = input.kind ?? "generic";
  const candidateCount = Number(input.candidateCount ?? 0);
  const keptCount = Number(input.keptCount ?? 0);
  const discovered = Boolean(input.discovery?.discoveredAt);

  if (kind === "listing_copy") {
    if (!discovered && candidateCount === 0) return SCOPE_STATUS.unresolved;
    return keptCount > 0 ? SCOPE_STATUS.resolvedNonempty : SCOPE_STATUS.resolvedEmpty;
  }

  if (candidateCount === 0 && keptCount === 0 && !discovered) {
    return SCOPE_STATUS.unresolved;
  }
  return keptCount > 0 ? SCOPE_STATUS.resolvedNonempty : SCOPE_STATUS.resolvedEmpty;
}

/**
 * @param {any} state
 */
export function emptyProposalMessage(state) {
  const status = state?.scope?.status ?? SCOPE_STATUS.unresolved;
  const excluded = (state?.scope?.excluded ?? [])
    .map((/** @type {any} */ item) => String(item.title ?? "").trim())
    .filter(Boolean);

  if (status === SCOPE_STATUS.unresolved) {
    return "There is no proposal yet — product scope has not been discovered from the catalog.";
  }
  if (status === SCOPE_STATUS.resolvedEmpty) {
    if (excluded.length > 0) {
      return `I checked the current catalog and nothing eligible remains. Excluded by you: ${excluded.join(", ")}.`;
    }
    return "I checked the current catalog and there are no eligible products missing product types, so there is nothing to change.";
  }
  if (excluded.length > 0) {
    return `Nothing remains in the current proposal. Excluded: ${excluded.join(", ")}.`;
  }
  return "There is nothing in the current proposal.";
}

/**
 * Discover sellable products missing product types and propose types from the
 * merchant's existing catalogue vocabulary. Pure read against local mirror.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; maxProducts?: number | null }} input
 */
export async function discoverListingCopyScope(prisma, input) {
  if (!prisma?.product?.findMany) {
    return {
      ok: false,
      reason: "catalog_unavailable",
      preview: { changes: [], productCount: 0, refused: [] },
      changes: [],
      unresolved: [],
      discovery: null,
      vocabulary: [],
    };
  }

  const rows = await prisma.product.findMany({
    where: { merchantId: input.merchantId, shopId: input.shopId },
    select: {
      externalId: true,
      title: true,
      vendor: true,
      productType: true,
      status: true,
    },
  });

  const { proposals, unresolved, vocabulary } = proposeProductTypes({
    products: rows.map((/** @type {any} */ row) => ({
      productId: row.externalId,
      title: row.title,
      vendor: row.vendor,
      productType: row.productType,
      status: row.status,
    })),
  });

  const requestedMax = Number(input.maxProducts);
  const cap =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, DEFAULT_LISTING_COPY_CAPS.maxProducts)
      : DEFAULT_LISTING_COPY_CAPS.maxProducts;
  const capped = proposals.slice(0, cap);

  const preview = buildListingCopyPreview({
    items: capped.map((proposal) => ({
      productId: proposal.productId,
      title: proposal.title,
      currentType: "",
      proposedType: proposal.proposedType,
    })),
  });

  /** @type {any[]} */
  const changes = preview.changes.map((change, index) => {
    const source = capped[index];
    return {
      ...change,
      because: source?.because ?? null,
      confidence: source?.confidence ?? null,
      basis: source?.basis ?? null,
    };
  });

  const sellableCount = rows.filter(
    (/** @type {any} */ row) => String(row.status ?? "ACTIVE").toUpperCase() === "ACTIVE",
  ).length;

  const discovery = {
    discoveredAt: new Date().toISOString(),
    sellableProductCount: sellableCount,
    missingTypeCount: proposals.length + unresolved.length,
    proposedCount: changes.length,
    unresolvedCount: unresolved.length,
    vocabulary: vocabulary.slice(0, 12),
  };

  return {
    ok: true,
    preview: { ...preview, changes },
    changes,
    unresolved,
    discovery,
    vocabulary,
  };
}

/**
 * Persist discovered scope onto the MerchantAction (and linked execution when
 * present) so resolveActionContext can materialize scope on subsequent reads.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   preview: any;
 *   discovery: any;
 *   preserveOriginalEvidence?: boolean;
 * }} input
 */
export async function persistListingCopyScope(prisma, input) {
  if (!prisma?.merchantAction?.findFirst || !prisma?.merchantAction?.update) {
    return { ok: false, reason: "action_unavailable" };
  }

  const action = await getMerchantAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  });
  if (!action) return { ok: false, reason: "not_found" };

  const progress =
    action.progress && typeof action.progress === "object" && !Array.isArray(action.progress)
      ? { ...action.progress }
      : {};

  const priorDiscovery = jsonObject(progress.scopeDiscovery);
  const originalEvidence =
    input.preserveOriginalEvidence !== false && priorDiscovery.originalEvidence
      ? priorDiscovery.originalEvidence
      : {
          recordedAt: input.discovery.discoveredAt,
          productIds: (input.preview?.changes ?? []).map(
            (/** @type {any} */ row) => row.productId,
          ),
          productCount: Number(input.discovery.missingTypeCount ?? 0),
          proposedCount: Number(input.discovery.proposedCount ?? 0),
        };

  progress.preview = input.preview;
  progress.actionType = "listing_copy";
  progress.scopeDiscovery = {
    ...input.discovery,
    originalEvidence,
  };

  await prisma.merchantAction.update({
    where: { id: action.id },
    data: { progress },
  });

  if (action.actionRunId && prisma.actionExecution?.update) {
    try {
      await prisma.actionExecution.update({
        where: { runId: action.actionRunId },
        data: {
          preview: input.preview,
          proposalSummary: {
            productCount: input.preview?.productCount ?? input.preview?.changes?.length ?? 0,
            unresolvedCount: input.discovery?.unresolvedCount ?? 0,
            vocabulary: input.discovery?.vocabulary ?? [],
          },
        },
      });
    } catch (error) {
      log.warn("listing copy execution preview write-through failed", {
        actionRunId: action.actionRunId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  log.info("listing copy scope persisted", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    proposedCount: input.preview?.changes?.length ?? 0,
    unresolvedCount: input.discovery?.unresolvedCount ?? 0,
    scopeStatus:
      (input.preview?.changes?.length ?? 0) > 0
        ? SCOPE_STATUS.resolvedNonempty
        : SCOPE_STATUS.resolvedEmpty,
  });

  return { ok: true, originalEvidence };
}

/** @param {Array<{ title?: string | null; fromType?: string | null; toType?: string | null }>} lines */
export function formatListingCopyProposalSummary(lines) {
  if (!lines.length) return "No product type changes to propose.";
  return `Proposed changes: ${lines
    .map((row) => `${row.title}: ${row.fromType || "none"} → ${row.toType}`)
    .join("; ")}.`;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
