// @ts-check

import { ACTIVE_BELIEF_STATUSES } from "../constants.server.js";
import { labelForBeliefKey } from "../conversational-belief-registry.server.js";

/** @param {any} prisma @param {{ merchantId: string; shopId: string; take?: number; now?: Date }} input */
export async function retrieveSemanticMemory(prisma, input) {
  if (!prisma.merchantMemoryBelief?.findMany) return [];
  const now = input.now ?? new Date();
  const rows = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      OR: [{ shopId: input.shopId }, { shopId: null }],
      status: { in: ACTIVE_BELIEF_STATUSES },
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
      ],
    },
    include: {
      evidence: { orderBy: { createdAt: "desc" }, take: 2 },
    },
    orderBy: [
      { precedence: "desc" },
      { lastConfirmedAt: "desc" },
      { updatedAt: "desc" },
    ],
    take: input.take ?? 16,
  });
  return rows.map((/** @type {any} */ row) => ({
    id: `belief:${row.id}`,
    memoryType: "semantic",
    content: `${labelForBeliefKey(row.key)}: ${formatValue(row.value)}`,
    data: {
      key: row.key,
      category: row.category,
      value: row.value,
      valueType: row.valueType,
    },
    authority: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    temporalStatus: "current",
    occurredAt: (
      row.lastObservedAt ??
      row.updatedAt ??
      new Date(0)
    ).toISOString(),
    scope: row.scope ?? {},
    validFrom: row.validFrom?.toISOString?.() ?? null,
    validUntil: row.validUntil?.toISOString?.() ?? null,
    source: {
      type: "merchant_memory_belief",
      beliefId: row.id,
      evidenceIds: (row.evidence ?? []).map(
        (/** @type {any} */ item) => item.id,
      ),
    },
    score: { authority: row.precedence / 100 },
  }));
}

/** @param {any} value */
function formatValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.option === "string")
      return value.option.replaceAll("_", " ");
  }
  return JSON.stringify(value);
}
