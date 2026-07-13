// @ts-check

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   eventType: string;
 *   source?: string;
 *   sourceEventId?: string | null;
 *   dedupeKey: string;
 *   idempotencyKey?: string | null;
 *   payload?: unknown;
 *   rawPayload?: unknown;
 *   eventTs?: Date | null;
 * }} input
 */
export async function writeLedgerEvent(prisma, input) {
  const existing = await prisma.ledgerEvent.findUnique({
    where: {
      merchantId_dedupeKey: {
        merchantId: input.merchantId,
        dedupeKey: input.dedupeKey,
      },
    },
  });

  if (existing) return { event: existing, created: false };

  const event = await prisma.ledgerEvent.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      eventType: input.eventType,
      source: input.source ?? "shopify",
      sourceEventId: input.sourceEventId ?? null,
      dedupeKey: input.dedupeKey,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: input.payload ?? {},
      rawPayload: input.rawPayload ?? {},
      eventTs: input.eventTs ?? new Date(),
    },
  });

  return { event, created: true };
}
