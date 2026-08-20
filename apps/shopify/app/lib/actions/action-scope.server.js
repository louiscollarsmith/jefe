// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { recommendedPurchaseUnits } from "./action-capability.server.js";

export const ACTION_SCOPE_VERSION = 1;

/**
 * @param {any} action
 */
export function actionScopeFromProgress(action) {
  const scope = jsonObject(action?.progress?.actionScope);
  if (Number(scope.version) !== ACTION_SCOPE_VERSION) {
    return {
      version: ACTION_SCOPE_VERSION,
      revision: 0,
      items: [],
      removed: [],
      quantityOverrides: {},
      updatedAt: null,
    };
  }
  return {
    version: ACTION_SCOPE_VERSION,
    revision: Number.isFinite(Number(scope.revision)) ? Number(scope.revision) : 0,
    items: Array.isArray(scope.items) ? scope.items.map(normalizeScopeItem).filter(Boolean) : [],
    removed: Array.isArray(scope.removed) ? scope.removed.map(normalizeScopeItem).filter(Boolean) : [],
    quantityOverrides: jsonObject(scope.quantityOverrides),
    updatedAt: scope.updatedAt ?? null,
  };
}

/**
 * Merge initial recommendation evidence with merchant-maintained current scope.
 * The recommendation is historical evidence; progress.actionScope is the current
 * collaborative scope delta.
 *
 * @param {any} action
 * @param {any[]} initialCandidates
 */
export function mergeCurrentScopeCandidates(action, initialCandidates) {
  const actionScope = actionScopeFromProgress(action);
  const removedKeys = new Set(actionScope.removed.map(scopeIdentity));
  const byKey = new Map();

  for (const candidate of initialCandidates ?? []) {
    const item = normalizeScopeItem({ ...candidate, source: candidate?.source ?? "recommendation" });
    if (!item) continue;
    const key = scopeIdentity(item);
    if (!key || removedKeys.has(key)) continue;
    byKey.set(key, item);
  }
  for (const scoped of actionScope.items) {
    const key = scopeIdentity(scoped);
    if (!key || removedKeys.has(key)) continue;
    byKey.set(key, { ...scoped, source: scoped.source ?? "merchant_added" });
  }
  return [...byKey.values()];
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; item: any; actor?: string | null }} input
 */
export async function addItemToActionScope(prisma, input) {
  const action = await prisma.merchantAction.findFirst({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
    select: { id: true, progress: true },
  });
  if (!action) return { ok: false, reason: "action_not_found" };
  const progress = jsonObject(action.progress);
  const scope = actionScopeFromProgress({ progress });
  const item = normalizeScopeItem({
    ...input.item,
    source: input.item?.source ?? "merchant_added",
    addedBy: input.actor ?? null,
    addedAt: new Date().toISOString(),
  });
  if (!item) return { ok: false, reason: "invalid_scope_item" };
  const key = scopeIdentity(item);
  const items = scope.items.filter((row) => scopeIdentity(row) !== key);
  const removed = scope.removed.filter((row) => scopeIdentity(row) !== key);
  const nextScope = {
    ...scope,
    revision: scope.revision + 1,
    items: [...items, item],
    removed,
    updatedAt: new Date().toISOString(),
  };
  const nextProgress = recalculateCanonicalProposal({
    ...progress,
    actionScope: nextScope,
  });
  await prisma.merchantAction.update({
    where: { id: input.actionId },
    data: { progress: nextProgress },
  });
  return { ok: true, item, scope: nextScope, proposal: nextProgress.replenishmentProposal };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; item: any; actor?: string | null }} input
 */
export async function removeItemFromActionScope(prisma, input) {
  const action = await prisma.merchantAction.findFirst({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
    select: { id: true, progress: true },
  });
  if (!action) return { ok: false, reason: "action_not_found" };
  const progress = jsonObject(action.progress);
  const scope = actionScopeFromProgress({ progress });
  const item = normalizeScopeItem({
    ...input.item,
    removedBy: input.actor ?? null,
    removedAt: new Date().toISOString(),
  });
  if (!item) return { ok: false, reason: "invalid_scope_item" };
  const key = scopeIdentity(item);
  const nextScope = {
    ...scope,
    revision: scope.revision + 1,
    items: scope.items.filter((row) => scopeIdentity(row) !== key),
    removed: [...scope.removed.filter((row) => scopeIdentity(row) !== key), item],
    updatedAt: new Date().toISOString(),
  };
  const nextProgress = recalculateCanonicalProposal({
    ...progress,
    actionScope: nextScope,
  });
  await prisma.merchantAction.update({
    where: { id: input.actionId },
    data: { progress: nextProgress },
  });
  return { ok: true, item, scope: nextScope, proposal: nextProgress.replenishmentProposal };
}

/**
 * Persist the current canonical replenishment proposal snapshot after bounded
 * state changes. This keeps the visible proposal current instead of leaving
 * an old assist artifact marked "needs update".
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 * @param {any} resolvedContext
 */
export async function persistCanonicalReplenishmentState(prisma, input, resolvedContext) {
  if (!resolvedContext?.canonicalProposal || !prisma?.merchantAction?.findFirst) {
    return { ok: false, reason: "not_restock" };
  }
  const action = await prisma.merchantAction.findFirst({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
    select: { id: true, progress: true },
  });
  if (!action) return { ok: false, reason: "action_not_found" };
  const progress = jsonObject(action.progress);
  const next = markDerivedArtifactsForProposal({
    ...progress,
    planValues: resolvedContext.plan?.values ?? {},
    scopeItems: resolvedContext.scope?.items ?? [],
    inputHash: resolvedContext.inputHash ?? null,
    scopeVersion: resolvedContext.scopeVersion ?? null,
    evidenceVersion: resolvedContext.evidenceVersion ?? null,
    replenishmentProposal: resolvedContext.canonicalProposal,
  });
  await prisma.merchantAction.update({
    where: { id: input.actionId },
    data: { progress: next },
  });
  return { ok: true, proposal: resolvedContext.canonicalProposal };
}

/**
 * @param {{ progress: any; planValues: Record<string, any>; scopeItems: any[]; inputHash?: string | null; scopeVersion?: string | null; evidenceVersion?: string | null }} input
 */
export function buildCanonicalReplenishmentProposal(input) {
  const coverDays = Number(input.planValues?.coverDays) > 0 ? Number(input.planValues.coverDays) : 120;
  const lines = (Array.isArray(input.scopeItems) ? input.scopeItems : []).flatMap((item) => {
    const line = proposalLine(item, coverDays, input.progress);
    return line ? [line] : [];
  });
  const fingerprint = hashPayload({
    coverDays,
    lines: lines.map((line) => ({
      key: line.key,
      quantity: line.recommendedUnits,
      override: line.quantityOverride ?? null,
    })),
    inputHash: input.inputHash ?? null,
  });
  const prior = jsonObject(input.progress?.replenishmentProposal);
  const sameInputs = prior.inputFingerprint === fingerprint;
  const revision = sameInputs
    ? Number(prior.revision ?? 0) || 1
    : Math.max(1, Number(prior.revision ?? 0) + 1);
  return {
    id: prior.id ?? randomUUID(),
    kind: "replenishment_proposal",
    revision,
    current: true,
    status: "current",
    coverDays,
    items: lines,
    inputFingerprint: fingerprint,
    inputHash: input.inputHash ?? null,
    scopeVersion: input.scopeVersion ?? null,
    evidenceVersion: input.evidenceVersion ?? null,
    generatedAt: sameInputs ? (prior.generatedAt ?? new Date().toISOString()) : new Date().toISOString(),
  };
}

/**
 * @param {any} progress
 */
export function recalculateCanonicalProposal(progress) {
  const next = jsonObject(progress);
  const planValues = jsonObject(next.planValues);
  const scopeItems = Array.isArray(next.scopeItems) ? next.scopeItems : [];
  if (scopeItems.length === 0) return next;
  next.replenishmentProposal = buildCanonicalReplenishmentProposal({
    progress: next,
    planValues,
    scopeItems,
    inputHash: next.inputHash ?? null,
    scopeVersion: next.scopeVersion ?? null,
    evidenceVersion: next.evidenceVersion ?? null,
  });
  return markDerivedArtifactsForProposal(next);
}

/** @param {any} progress */
export function markDerivedArtifactsForProposal(progress) {
  const proposal = jsonObject(progress?.replenishmentProposal);
  if (!proposal.inputFingerprint) return progress;
  const next = { ...jsonObject(progress) };
  const email = jsonObject(next.supplierEmailDraft);
  if (email.artifactType && email.derivedFromProposalFingerprint !== proposal.inputFingerprint) {
    next.supplierEmailDraft = {
      ...email,
      current: false,
      stale: true,
      staleReason: "Derived from an older replenishment proposal.",
    };
  }
  return next;
}

/** @param {any} item @param {number} coverDays @param {any} progress */
function proposalLine(item, coverDays, progress) {
  const normalized = normalizeScopeItem(item);
  if (!normalized) return null;
  const key = scopeIdentity(normalized);
  const overrides = jsonObject(progress?.actionScope?.quantityOverrides);
  const override = numberOrNull(overrides[key]);
  const calculated = recommendedPurchaseUnits(
    {
      available: numberOrNull(normalized.available),
      dailyVelocity: numberOrNull(normalized.dailyVelocity),
    },
    coverDays,
  );
  return {
    key,
    title: normalized.title,
    productId: normalized.productId ?? null,
    variantId: normalized.variantId ?? null,
    inventoryItemId: normalized.inventoryItemId ?? null,
    available: numberOrNull(normalized.available),
    dailyVelocity: numberOrNull(normalized.dailyVelocity),
    coverDays,
    recommendedUnits: override ?? calculated,
    calculatedUnits: calculated,
    quantityOverride: override,
    source: normalized.source ?? null,
  };
}

/** @param {any} item */
export function normalizeScopeItem(item) {
  const title = String(item?.title ?? item?.productTitle ?? "").trim();
  const productId = stringOrNull(item?.productId);
  const variantId = stringOrNull(item?.variantId);
  if (!title && !productId && !variantId) return null;
  return {
    ...item,
    title: title || productId || variantId,
    productId,
    variantId,
    inventoryItemId: stringOrNull(item?.inventoryItemId),
    available: numberOrNull(item?.available ?? item?.inventory),
    inventory: numberOrNull(item?.available ?? item?.inventory),
    dailyVelocity: numberOrNull(item?.dailyVelocity),
    daysOfCover: numberOrNull(item?.daysOfCover),
  };
}

/** @param {any} item */
export function scopeIdentity(item) {
  return String(item?.variantId || item?.productId || item?.title || "")
    .trim()
    .toLowerCase();
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/** @param {unknown} value */
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function hashPayload(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex").slice(0, 16);
}
