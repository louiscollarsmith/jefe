// @ts-check

/**
 * Canonical current-action state. Chat, Change Sets, assist artifacts and
 * step execution all consume this so a merchant revision cannot exist in
 * conversation and disappear when the step runs.
 */

import { createHash } from "node:crypto";
import { logger as baseLogger } from "../observability/logger.server.js";
import { getMerchantAction } from "./merchant-action.server.js";
import {
  applyConstraintsToPreview,
  listActionConstraints,
  serializeConstraint,
} from "./action-constraint.server.js";
import {
  inspectCandidates,
  inspectRestockEvidence,
  recommendedPurchaseUnits,
} from "./action-capability.server.js";
import { deriveScopeStatus } from "./listing-copy-scope.server.js";

const log = baseLogger.child({ component: "resolved-action-context" });

export const DEFAULT_RESTOCK_COVER_DAYS = 120;

/** @param {any} action */
export function actionRuntimeKind(action) {
  const type = String(action?.actionType ?? "");
  if (type === "price_markdown") return "markdown";
  if (type === "listing_copy") return "listing_copy";
  if (type === "tidy_up") return "tidy_up";
  const haystack = [
    action?.title,
    action?.summary,
    ...(Array.isArray(action?.workflow?.steps) ? action.workflow.steps : []).map(
      (/** @type {any} */ step) => `${step?.title ?? ""} ${step?.capabilityRef ?? ""}`,
    ),
    ...(Array.isArray(action?.displaySteps) ? action.displaySteps : []).map(
      (/** @type {any} */ step) => `${step?.title ?? ""} ${step?.capabilityRef ?? ""}`,
    ),
  ]
    .join(" ")
    .toLowerCase();
  if (
    /\blisting_copy\b/.test(haystack) ||
    /\b(product types?|missing product types?|categoris(?:e|ing)|unassigned products?)\b/.test(
      haystack,
    )
  ) {
    return "listing_copy";
  }
  if (/\b(restock|replenish(?:ment)?|reorder|stock cover|supplier order)\b/.test(haystack)) {
    return "restock";
  }
  return "generic";
}

/** @param {any} action */
export function isRestockAction(action) {
  return actionRuntimeKind(action) === "restock";
}

/**
 * @param {any} prisma
 * @param {{
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   conversationId?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 * @returns {Promise<ResolvedActionContext | null>}
 */
export async function resolveActionContext(prisma, input) {
  const logger = input.logger ?? log;
  const action = await getMerchantAction(prisma, input);
  if (!action) return null;
  const kind = actionRuntimeKind(action);
  const constraints = (await listActionConstraints(prisma, input)).map(serializeConstraint);
  const plan = resolvePlanValues(action, kind);
  const candidates = await loadScopeCandidates(prisma, { ...input, action, kind });
  const catalog = await inspectCandidates(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    changes: candidates,
  });
  const scopeDiscovery = jsonObject(action?.progress?.scopeDiscovery);
  const scope = resolveActionScope({
    candidates,
    constraints,
    catalog,
    planValues: plan.values,
    kind,
    scopeDiscovery,
  });
  const constraintVersion = hashPayload(
    constraints.map((/** @type {any} */ row) => ({ id: row.id, kind: row.kind, params: row.params })),
  );
  const inputHash = hashResolvedActionInput({
    planValues: plan.values,
    constraints,
    scopeKeys: scope.items.map(scopeKey),
  });
  const currentStep = action.currentStep ?? null;
  const context = {
    action,
    workflow: action.workflow ?? null,
    currentStep,
    plan,
    constraints,
    constraintVersion,
    scope,
    evidence: {
      kind,
      loadedAt: new Date().toISOString(),
      candidateCount: candidates.length,
    },
    inputHash,
    focusedConversationId: input.conversationId ?? null,
  };
  logger.info("resolved action context", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    actionVersion: action.updatedAt,
    planVersion: plan.version,
    constraintVersion,
    inputHash,
    kind,
    coverDays: plan.values.coverDays ?? null,
    markdownPercent: plan.values.markdownPercent ?? null,
    scopeCount: scope.items.length,
    scopeStatus: scope.status,
    excludedCount: scope.excluded.length,
    scopeDiscovered: Boolean(scopeDiscovery.discoveredAt),
    currentStepId: currentStep?.id ?? null,
    conversationId: input.conversationId ?? null,
  });
  return context;
}

/**
 * Plan precedence: merchant-revised current plan, then accepted/generated
 * proposal values, then the documented action-type default. Never skip the
 * current plan and jump back to a default.
 *
 * @param {any} action
 * @param {string} [kind]
 */
export function resolvePlanValues(action, kind = actionRuntimeKind(action)) {
  const plan = jsonObject(action?.plan);
  const proposal = jsonObject(
    action?.sourceRecommendation?.proposal ??
      action?.progress?.proposalSummary ??
      {},
  );
  /** @type {Record<string, number>} */
  const values = {};
  /** @type {Record<string, "plan" | "proposal" | "default">} */
  const source = {};
  const cover = firstPositive(plan.coverDays, proposal.coverDays);
  if (cover != null) {
    values.coverDays = cover;
    source.coverDays = positive(plan.coverDays) != null ? "plan" : "proposal";
  } else if (kind === "restock") {
    values.coverDays = DEFAULT_RESTOCK_COVER_DAYS;
    source.coverDays = "default";
  }
  const markdown = firstPositive(plan.markdownPercent, proposal.markdownPercent);
  if (markdown != null) {
    values.markdownPercent = markdown;
    source.markdownPercent =
      positive(plan.markdownPercent) != null ? "plan" : "proposal";
  }
  const maxProducts = firstPositive(plan.maxProducts, proposal.maxProducts);
  if (maxProducts != null) {
    values.maxProducts = maxProducts;
    source.maxProducts = positive(plan.maxProducts) != null ? "plan" : "proposal";
  }
  return {
    values,
    source,
    version: hashPayload(values),
  };
}

/**
 * candidate evidence → plan filters → active constraints → eligible scope.
 *
 * @param {{
 *   candidates?: any[];
 *   constraints?: any[];
 *   catalog?: Record<string, any>;
 *   planValues?: Record<string, number>;
 *   kind?: string;
 *   scopeDiscovery?: Record<string, any> | null;
 * }} input
 */
export function resolveActionScope(input) {
  const kind = input.kind ?? "generic";
  const planValues = input.planValues ?? {};
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const scopeDiscovery = input.scopeDiscovery ?? null;
  const planned =
    kind === "markdown" ? applyMarkdownPlan(candidates, planValues.markdownPercent) : candidates;
  const filtered = applyConstraintsToPreview(
    { changes: planned.map(candidateToChange) },
    input.constraints ?? [],
    input.catalog ?? {},
  );
  let kept = filtered.changes;
  if (Number.isInteger(planValues.maxProducts) && planValues.maxProducts > 0) {
    kept = kept.slice(0, planValues.maxProducts);
  }
  const items = kept.map((/** @type {any} */ change) => {
    const available = numberOrNull(change.available ?? change.inventory);
    const dailyVelocity = numberOrNull(change.dailyVelocity);
    const recommended =
      kind === "restock"
        ? recommendedPurchaseUnits({ available, dailyVelocity }, planValues.coverDays)
        : null;
    return {
      title: change.title ?? change.productTitle ?? null,
      productId: change.productId ?? null,
      variantId: change.variantId ?? null,
      targetRef: change.variantId ?? change.productId ?? null,
      available,
      inventory: available,
      dailyVelocity,
      daysOfCover: numberOrNull(change.daysOfCover),
      recommendedUnits: recommended,
      recommendedUnitsAtDefaultCover: recommended,
      fromPrice: numberOrNull(change.fromPrice ?? change.before),
      toPrice: numberOrNull(change.toPrice ?? change.after),
      discountPercent: numberOrNull(change.discountPercent),
      toType: change.toType ?? change.proposedType ?? null,
      fromType: change.fromType ?? null,
      confidence: change.confidence ?? null,
      because: change.because ?? null,
      reason:
        kind === "restock" && planValues.coverDays
          ? `${planValues.coverDays} days of cover`
          : change.reason ?? null,
      tags: Array.isArray(change.tags) ? change.tags : [],
      status: change.status ?? null,
    };
  });
  const status = deriveScopeStatus({
    kind,
    candidateCount: candidates.length,
    keptCount: items.length,
    discovery: scopeDiscovery,
  });
  return {
    items,
    excluded: filtered.excluded,
    candidateCount: candidates.length,
    keptCount: items.length,
    excludedCount: filtered.excludedCount,
    status,
    discovery: scopeDiscovery,
    originalEvidence: scopeDiscovery?.originalEvidence ?? null,
  };
}

/**
 * @param {{ planValues?: Record<string, unknown>; constraints?: any[]; scopeKeys?: string[] }} input
 */
export function hashResolvedActionInput(input) {
  return hashPayload({
    plan: input.planValues ?? {},
    constraints: (input.constraints ?? []).map((row) => ({
      kind: row.kind,
      params: row.params,
    })),
    scope: input.scopeKeys ?? [],
  });
}

/** @param {ResolvedActionContext} context */
export function snapshotFromResolvedContext(context) {
  return {
    actionId: context.action?.id ?? null,
    actionUpdatedAt: context.action?.updatedAt ?? null,
    kind: context.evidence?.kind ?? null,
    plan: context.plan?.values ?? {},
    planVersion: context.plan?.version ?? null,
    planSource: context.plan?.source ?? {},
    constraints: (context.constraints ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      params: row.params,
      label: row.label,
    })),
    constraintVersion: context.constraintVersion,
    scope: (context.scope?.items ?? []).map((item) => ({
      title: item.title,
      productId: item.productId ?? null,
      variantId: item.variantId ?? null,
      recommendedUnits: item.recommendedUnits ?? null,
    })),
    excluded: (context.scope?.excluded ?? []).map((item) => ({
      title: item.title,
      reason: item.reason ?? null,
    })),
    inputHash: context.inputHash,
    currentStepId: context.currentStep?.id ?? null,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Invariant: a run snapshot must not use a default cover/markdown when the
 * current plan already has a merchant-revised value.
 *
 * @param {any} snapshot
 * @param {ResolvedActionContext} context
 */
export function assertRunMatchesResolvedContext(snapshot, context) {
  const plan = context.plan?.values ?? {};
  const used = jsonObject(snapshot?.plan ?? snapshot);
  if (plan.coverDays != null && Number(used.coverDays) !== Number(plan.coverDays)) {
    throw new Error(
      `Plan consistency: run used coverDays=${used.coverDays} but current plan is ${plan.coverDays}.`,
    );
  }
  if (
    plan.markdownPercent != null &&
    used.markdownPercent != null &&
    Number(used.markdownPercent) !== Number(plan.markdownPercent)
  ) {
    throw new Error(
      `Plan consistency: run used markdownPercent=${used.markdownPercent} but current plan is ${plan.markdownPercent}.`,
    );
  }
  const excludedTitles = new Set(
    (context.constraints ?? [])
      .filter((row) => row.kind === "exclude_product")
      .map((row) => normalizeMatch(row.params?.title)),
  );
  for (const item of context.scope?.items ?? []) {
    const title = normalizeMatch(item.title);
    if (title && excludedTitles.has(title)) {
      throw new Error(`Constraint consistency: excluded product ${item.title} is still in scope.`);
    }
  }
  return true;
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; action: any; kind: string }} input
 */
async function loadScopeCandidates(prisma, input) {
  if (input.kind === "restock") {
    return inspectRestockEvidence(prisma, input);
  }
  const preview = jsonObject(input.action?.progress?.preview);
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  if (changes.length > 0) return changes;
  return Array.isArray(input.action?.previewItems) ? input.action.previewItems : [];
}

/** @param {any[]} candidates @param {number | undefined} markdownPercent */
export function applyMarkdownPlan(candidates, markdownPercent) {
  const percent = Number(markdownPercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return candidates;
  return candidates.map((candidate) => {
    const from = numberOrNull(
      candidate?.fromPrice ?? candidate?.currentPrice ?? candidate?.before,
    );
    if (from == null) return { ...candidate, discountPercent: percent };
    const to = Math.round(from * (1 - percent / 100) * 100) / 100;
    return {
      ...candidate,
      fromPrice: from,
      toPrice: to,
      discountPercent: percent,
      before: from,
      after: to,
    };
  });
}

/** @param {any} item */
function candidateToChange(item) {
  return {
    title: item?.title ?? item?.productTitle ?? null,
    productId: item?.productId ?? null,
    variantId: item?.variantId ?? null,
    targetRef: item?.targetRef ?? item?.variantId ?? item?.productId ?? null,
    available: item?.available ?? item?.inventory ?? null,
    inventory: item?.available ?? item?.inventory ?? null,
    dailyVelocity: item?.dailyVelocity ?? null,
    daysOfCover: item?.daysOfCover ?? null,
    fromPrice: item?.fromPrice ?? item?.currentPrice ?? item?.before ?? null,
    toPrice: item?.toPrice ?? item?.suggestedPrice ?? item?.after ?? null,
    discountPercent: item?.discountPercent ?? null,
    toType: item?.toType ?? item?.proposedType ?? null,
    fromType: item?.fromType ?? null,
    confidence: item?.confidence ?? null,
    because: item?.because ?? null,
    reason: item?.reason ?? null,
    tags: Array.isArray(item?.tags) ? item.tags : [],
    status: item?.status ?? null,
    collections: Array.isArray(item?.collections) ? item.collections : [],
  };
}

/** @param {any} item */
function scopeKey(item) {
  return String(item?.productId || item?.variantId || item?.title || "")
    .trim()
    .toLowerCase();
}

/** @param {unknown} value */
function hashPayload(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex").slice(0, 16);
}

/** @param {...unknown} values */
function firstPositive(...values) {
  for (const value of values) {
    const number = positive(value);
    if (number != null) return number;
  }
  return null;
}

/** @param {unknown} value */
function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** @param {unknown} value */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function normalizeMatch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @typedef {{
 *   action: any;
 *   workflow: any;
 *   currentStep: any;
 *   plan: { values: Record<string, number>; source: Record<string, string>; version: string };
 *   constraints: any[];
 *   constraintVersion: string;
 *   scope: {
 *     items: any[];
 *     excluded: any[];
 *     candidateCount: number;
 *     keptCount: number;
 *     excludedCount: number;
 *     status: string;
 *     discovery?: Record<string, any> | null;
 *     originalEvidence?: Record<string, any> | null;
 *   };
 *   evidence: { kind: string; loadedAt: string; candidateCount: number };
 *   inputHash: string;
 *   focusedConversationId?: string | null;
 * }} ResolvedActionContext
 */
