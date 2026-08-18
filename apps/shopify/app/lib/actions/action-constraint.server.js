// @ts-check

/**
 * Action-scoped constraints. These are operating rules for one MerchantAction,
 * not Merchant Memory beliefs. Chat and buttons persist them here; Change Set
 * creation and execution enforce them.
 */

export const CONSTRAINT_KIND = Object.freeze({
  excludeArchived: "exclude_archived",
  excludeCollection: "exclude_collection",
  excludeTag: "exclude_tag",
  minInventory: "min_inventory",
  priceFloor: "price_floor",
  custom: "custom",
});

export const CONSTRAINT_STATUS = Object.freeze({
  active: "active",
  removed: "removed",
});

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function listActionConstraints(prisma, input) {
  if (!prisma?.merchantActionConstraint?.findMany) return [];
  return prisma.merchantActionConstraint.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      status: CONSTRAINT_STATUS.active,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; kind: string; params?: Record<string, any>; label?: string; source?: string }} input
 */
export async function addActionConstraint(prisma, input) {
  const normalized = normalizeConstraint({
    kind: input.kind,
    params: input.params ?? {},
    label: input.label,
  });
  if (!normalized) {
    return { ok: false, reason: "invalid_constraint" };
  }
  const existing = (await listActionConstraints(prisma, input)).find((/** @type {any} */ row) =>
    constraintsEquivalent(row, normalized),
  );
  if (existing) {
    return { ok: true, constraint: serializeConstraint(existing), duplicate: true };
  }
  if (!prisma?.merchantActionConstraint?.create) {
    return { ok: false, reason: "constraints_unavailable" };
  }
  const row = await prisma.merchantActionConstraint.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      kind: normalized.kind,
      params: normalized.params,
      label: normalized.label,
      source: input.source ?? "chat",
      status: CONSTRAINT_STATUS.active,
    },
  });
  return { ok: true, constraint: serializeConstraint(row), duplicate: false };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; constraintId?: string | null; kind?: string | null }} input
 */
export async function removeActionConstraint(prisma, input) {
  if (!prisma?.merchantActionConstraint?.updateMany) {
    return { ok: false, reason: "constraints_unavailable" };
  }
  const now = new Date();
  const result = await prisma.merchantActionConstraint.updateMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      status: CONSTRAINT_STATUS.active,
      ...(input.constraintId ? { id: input.constraintId } : {}),
      ...(input.kind && !input.constraintId ? { kind: input.kind } : {}),
    },
    data: { status: CONSTRAINT_STATUS.removed, removedAt: now },
  });
  if (result.count < 1) return { ok: false, reason: "not_found" };
  return { ok: true, removed: result.count };
}

/** @param {any} row */
export function serializeConstraint(row) {
  return {
    id: row?.id ?? null,
    kind: row?.kind ?? CONSTRAINT_KIND.custom,
    params: jsonObject(row?.params),
    label: String(row?.label ?? "").trim(),
    source: row?.source ?? "chat",
    status: row?.status ?? CONSTRAINT_STATUS.active,
  };
}

/**
 * Split a preview's changes into kept vs excluded using active constraints.
 * `catalogByRef` is optional live/local product state keyed by product or variant id.
 *
 * @param {{ changes?: any[] } | null | undefined} preview
 * @param {any[]} constraints
 * @param {Record<string, any>} [catalogByRef]
 */
export function applyConstraintsToPreview(preview, constraints, catalogByRef = {}) {
  const changes = Array.isArray(preview?.changes) ? preview.changes : [];
  const active = (Array.isArray(constraints) ? constraints : [])
    .map(serializeConstraint)
    .filter((row) => row.status === CONSTRAINT_STATUS.active && row.kind);
  /** @type {any[]} */
  const kept = [];
  /** @type {any[]} */
  const excluded = [];
  for (const change of changes) {
    const record = catalogRecordForChange(change, catalogByRef);
    const hit = firstMatchingConstraint(change, record, active);
    if (hit) {
      excluded.push({
        ...summarizeChange(change),
        reason: hit.label || constraintReason(hit),
        constraintKind: hit.kind,
      });
      continue;
    }
    const floored = applyPriceFloor(change, record, active);
    if (floored.excluded) {
      excluded.push({
        ...summarizeChange(change),
        reason: floored.reason,
        constraintKind: CONSTRAINT_KIND.priceFloor,
      });
      continue;
    }
    kept.push(floored.change);
  }
  return {
    changes: kept,
    excluded,
    originalCount: changes.length,
    keptCount: kept.length,
    excludedCount: excluded.length,
  };
}

/**
 * Parse one merchant message into zero or more structured constraints.
 * Deterministic on purpose: the LLM may also propose these, but regex is the
 * fast path for the phrases the vertical slice must handle.
 *
 * @param {string} message
 * @returns {Array<{ kind: string; params: Record<string, any>; label: string }>}
 */
export function parseConstraintsFromMessage(message) {
  const text = normalizeChatText(message);
  if (!text) return [];
  /** @type {Array<{ kind: string; params: Record<string, any>; label: string }>} */
  const found = [];

  if (
    /\b(don'?t|do not|never)\b.{0,40}\barchived\b/i.test(text) ||
    /\bexclude archived\b/i.test(text) ||
    /\bno archived\b/i.test(text)
  ) {
    found.push({
      kind: CONSTRAINT_KIND.excludeArchived,
      params: {},
      label: "Exclude archived products",
    });
  }

  const collection = text.match(
    /\b(?:anything|products?|items?)\s+in\s+(?:the\s+)?(?:collection\s+)?["“']?([^"'”.,]+)["”']?/i,
  ) || text.match(
    /\bexclude(?:\s+the)?\s+collection\s+["“']?([^"'”.,]+)["”']?/i,
  );
  if (collection?.[1]) {
    const title = collection[1].replace(/\s+or\s+anything.*$/i, "").trim();
    if (title && !/^archived$/i.test(title)) {
      found.push({
        kind: CONSTRAINT_KIND.excludeCollection,
        params: { collectionTitle: title },
        label: `Exclude collection ${title}`,
      });
    }
  }

  const tagged = text.match(
    /\b(?:tagged|tag(?:ged)?\s+as)\s+["“']?([a-z0-9][\w-]*)["”']?/i,
  );
  if (tagged?.[1]) {
    const tag = tagged[1].trim();
    found.push({
      kind: CONSTRAINT_KIND.excludeTag,
      params: { tag },
      label: `Do not modify products tagged ${tag}`,
    });
  }

  const inventory = text.match(
    /\binventory\s*(?:>|greater than|over|above|at least)\s*(\d+)\b/i,
  );
  if (inventory?.[1]) {
    const min = Number(inventory[1]);
    found.push({
      kind: CONSTRAINT_KIND.minInventory,
      params: { min },
      label: `Only include products with inventory > ${min}`,
    });
  }

  const floor = text.match(
    /\b(?:never|don'?t|do not)\s+reduce.{0,24}below\s*£?\s*(\d+(?:\.\d+)?)\b/i,
  ) || text.match(/\b(?:price )?floor\s*(?:of\s*)?£?\s*(\d+(?:\.\d+)?)\b/i);
  if (floor?.[1]) {
    const amount = Number(floor[1]);
    found.push({
      kind: CONSTRAINT_KIND.priceFloor,
      params: { amount, currency: "GBP" },
      label: `Never reduce price below £${amount}`,
    });
  }

  return found
    .map((item) => normalizeConstraint(item))
    .filter((item) => item != null);
}

/** @param {unknown} value */
export function normalizeChatText(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
}

/** @param {{ kind?: string; params?: any; label?: string }} input */
export function normalizeConstraint(input) {
  const kind = String(input?.kind ?? "").trim();
  const params = jsonObject(input?.params);
  if (kind === CONSTRAINT_KIND.excludeArchived) {
    return {
      kind,
      params: {},
      label: input.label?.trim() || "Exclude archived products",
    };
  }
  if (kind === CONSTRAINT_KIND.excludeCollection) {
    const collectionTitle = String(params.collectionTitle ?? params.title ?? "").trim();
    if (!collectionTitle) return null;
    return {
      kind,
      params: { collectionTitle },
      label: input.label?.trim() || `Exclude collection ${collectionTitle}`,
    };
  }
  if (kind === CONSTRAINT_KIND.excludeTag) {
    const tag = String(params.tag ?? "").trim();
    if (!tag) return null;
    return {
      kind,
      params: { tag },
      label: input.label?.trim() || `Do not modify products tagged ${tag}`,
    };
  }
  if (kind === CONSTRAINT_KIND.minInventory) {
    const min = Number(params.min ?? params.inventory);
    if (!Number.isFinite(min) || min < 0) return null;
    return {
      kind,
      params: { min },
      label: input.label?.trim() || `Only include products with inventory > ${min}`,
    };
  }
  if (kind === CONSTRAINT_KIND.priceFloor) {
    const amount = Number(params.amount ?? params.minPrice);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return {
      kind,
      params: { amount, currency: String(params.currency ?? "GBP") },
      label: input.label?.trim() || `Never reduce price below £${amount}`,
    };
  }
  if (kind === CONSTRAINT_KIND.custom) {
    const text = String(params.text ?? input.label ?? "").trim();
    if (!text) return null;
    return {
      kind,
      params: { text },
      label: input.label?.trim() || text,
    };
  }
  return null;
}

/** @param {any} left @param {any} right */
function constraintsEquivalent(left, right) {
  if (String(left?.kind) !== String(right?.kind)) return false;
  return JSON.stringify(jsonObject(left?.params)) === JSON.stringify(jsonObject(right?.params));
}

/** @param {any} change @param {any} record @param {any[]} constraints */
function firstMatchingConstraint(change, record, constraints) {
  for (const constraint of constraints) {
    if (constraint.kind === CONSTRAINT_KIND.priceFloor) continue;
    if (constraintMatches(constraint, change, record)) return constraint;
  }
  return null;
}

/** @param {any} constraint @param {any} change @param {any} record */
function constraintMatches(constraint, change, record) {
  if (constraint.kind === CONSTRAINT_KIND.excludeArchived) {
    return isArchivedStatus(record?.status ?? change?.status);
  }
  if (constraint.kind === CONSTRAINT_KIND.excludeCollection) {
    const wanted = normalizeMatch(constraint.params.collectionTitle);
    const collections = Array.isArray(record?.collections) ? record.collections : [];
    return collections.some(
      (/** @type {any} */ item) =>
        normalizeMatch(item?.title) === wanted ||
        normalizeMatch(item?.handle) === wanted ||
        normalizeMatch(item?.title).includes(wanted),
    );
  }
  if (constraint.kind === CONSTRAINT_KIND.excludeTag) {
    const wanted = normalizeMatch(constraint.params.tag);
    const tags = Array.isArray(record?.tags) ? record.tags : [];
    return tags.some((/** @type {any} */ tag) => normalizeMatch(tag) === wanted);
  }
  if (constraint.kind === CONSTRAINT_KIND.minInventory) {
    const inventory = Number(record?.inventory ?? change?.inventory ?? change?.unitsOnHand);
    if (!Number.isFinite(inventory)) return false;
    return inventory <= Number(constraint.params.min);
  }
  return false;
}

/** @param {any} change @param {any} record @param {any[]} constraints */
function applyPriceFloor(change, record, constraints) {
  const floor = constraints.find((item) => item.kind === CONSTRAINT_KIND.priceFloor);
  if (!floor) return { change, excluded: false };
  const amount = Number(floor.params.amount);
  const toPrice = Number(change?.toPrice ?? change?.suggestedPrice);
  const fromPrice = Number(change?.fromPrice ?? change?.currentPrice ?? record?.price);
  if (!Number.isFinite(toPrice) || !Number.isFinite(amount)) {
    return { change, excluded: false };
  }
  if (toPrice >= amount) return { change, excluded: false };
  if (Number.isFinite(fromPrice) && amount < fromPrice) {
    return {
      change: {
        ...change,
        toPrice: amount,
        discountPercent: round1(((fromPrice - amount) / fromPrice) * 100),
      },
      excluded: false,
    };
  }
  return {
    change,
    excluded: true,
    reason: floor.label || `Proposed price would fall below £${amount}`,
  };
}

/** @param {any} change @param {Record<string, any>} catalogByRef */
function catalogRecordForChange(change, catalogByRef) {
  const keys = [
    change?.variantId,
    change?.productId,
    change?.targetRef,
  ].filter((value) => typeof value === "string" && value);
  for (const key of keys) {
    if (catalogByRef[key]) return catalogByRef[key];
  }
  return {
    status: change?.status ?? null,
    tags: Array.isArray(change?.tags) ? change.tags : [],
    collections: Array.isArray(change?.collections) ? change.collections : [],
    inventory: change?.inventory ?? change?.unitsOnHand ?? null,
    price: change?.fromPrice ?? change?.currentPrice ?? null,
  };
}

/** @param {any} change */
function summarizeChange(change) {
  return {
    title: change?.title ?? change?.productTitle ?? null,
    productId: change?.productId ?? null,
    variantId: change?.variantId ?? null,
    fromPrice: change?.fromPrice ?? null,
    toPrice: change?.toPrice ?? null,
    toType: change?.toType ?? change?.proposedType ?? null,
  };
}

/** @param {any} constraint */
function constraintReason(constraint) {
  return constraint.label || constraint.kind;
}

/** @param {unknown} value */
function isArchivedStatus(value) {
  return String(value ?? "").trim().toUpperCase() === "ARCHIVED";
}

/** @param {unknown} value */
function normalizeMatch(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {number} value */
function round1(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}
