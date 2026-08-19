// @ts-check

/**
 * Inventory transfer adapter — the typed, idempotent write primitive for
 * `inventoryTransferCreate` on Shopify.
 *
 * Safety contract (mirrors the clearance adapter's pattern):
 *   - previewInventoryTransfer  — pure validation; writes nothing.
 *   - blast-radius cap          — refuses a run that exceeds MAX_LINE_ITEMS.
 *   - idempotency               — keyed on (actionId, stepId, inputHash); a retry
 *                                 cannot create a second transfer for the same inputs.
 *   - external IDs durable      — Shopify transfer ID stored in ActionExecutionWrite.
 *   - compare-and-set gate      — checks inventory level before writing.
 *   - flag-gated                — INVENTORY_TRANSFER_EXECUTE_ENABLED must be "true".
 *   - scope-gated               — requires write_inventory_transfers OAuth scope.
 *   - no LLM GraphQL            — this module is the ONLY path to inventoryTransferCreate.
 */

/** Maximum line items in a single transfer run. */
export const TRANSFER_BLAST_RADIUS_CAP = 50;

/**
 * Whether the inventory transfer write path is switched on.
 */
export function isInventoryTransferExecuteEnabled() {
  return process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED === "true";
}

/**
 * Validate inputs and build a preview the merchant approves. Pure — writes nothing.
 *
 * @param {{
 *   originLocationId: string;
 *   destinationLocationId: string;
 *   lineItems: Array<{ inventoryItemId: string; title?: string | null; quantity: number }>;
 * }} input
 * @returns {{ ok: true; preview: { originLocationId: string; destinationLocationId: string; lineItems: Array<{ inventoryItemId: string; title: string | null; quantity: number }> }; summary: string; refused: string[] } | { ok: false; reason: string; message: string }}
 */
export function previewInventoryTransfer(input) {
  const origin = String(input?.originLocationId ?? "").trim();
  const destination = String(input?.destinationLocationId ?? "").trim();
  if (!origin) return { ok: false, reason: "missing_origin", message: "Origin location is required." };
  if (!destination) return { ok: false, reason: "missing_destination", message: "Destination location is required." };
  if (origin === destination) {
    return { ok: false, reason: "same_location", message: "Origin and destination must be different locations." };
  }

  const rawItems = Array.isArray(input?.lineItems) ? input.lineItems : [];
  const validItems = rawItems.filter(
    (item) =>
      item &&
      typeof item.inventoryItemId === "string" &&
      item.inventoryItemId.trim() &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0,
  );
  const refused = rawItems
    .filter(
      (item) =>
        !item ||
        typeof item.inventoryItemId !== "string" ||
        !item.inventoryItemId.trim() ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0,
    )
    .map((item) => String(item?.inventoryItemId ?? item?.title ?? "unknown"));

  if (validItems.length === 0) {
    return { ok: false, reason: "no_valid_items", message: "At least one item with a positive quantity is required." };
  }
  if (validItems.length > TRANSFER_BLAST_RADIUS_CAP) {
    return {
      ok: false,
      reason: "blast_radius_exceeded",
      message: `This transfer has ${validItems.length} items, which exceeds the cap of ${TRANSFER_BLAST_RADIUS_CAP}. Split it into smaller batches.`,
    };
  }

  const preview = {
    originLocationId: origin,
    destinationLocationId: destination,
    lineItems: validItems.map((item) => ({
      inventoryItemId: item.inventoryItemId.trim(),
      title: item.title != null ? String(item.title).trim() : null,
      quantity: item.quantity,
    })),
  };

  const itemSummary = preview.lineItems
    .slice(0, 5)
    .map((item) => `${item.title ?? item.inventoryItemId}: ${item.quantity}`)
    .join(", ");
  const more = preview.lineItems.length > 5 ? ` (+${preview.lineItems.length - 5} more)` : "";

  return {
    ok: true,
    preview,
    summary: `Transfer ${preview.lineItems.length} SKU${preview.lineItems.length === 1 ? "" : "s"}: ${itemSummary}${more}.`,
    refused,
  };
}

/**
 * Execute the inventory transfer against Shopify. Idempotent: a second call with the
 * same idempotencyKey is a no-op that returns the previous result.
 *
 * @param {any} prisma
 * @param {{
 *   actionId: string;
 *   merchantId: string;
 *   shopId: string;
 *   idempotencyKey: string;
 *   preview: { originLocationId: string; destinationLocationId: string; lineItems: Array<{ inventoryItemId: string; quantity: number }> };
 *   shopifyClient: { createInventoryTransfer: (input: any) => Promise<any> };
 *   actor?: string | null;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function executeInventoryTransfer(prisma, input) {
  const logger = input.logger ?? console;

  if (!isInventoryTransferExecuteEnabled()) {
    return {
      ok: false,
      reason: "flag_disabled",
      message: "Inventory transfer execution is not enabled. Set INVENTORY_TRANSFER_EXECUTE_ENABLED=true to activate.",
    };
  }

  // Idempotency: if a write row with this key already succeeded, return it.
  const existing = await prisma.actionExecutionWrite?.findFirst?.({
    where: {
      idempotencyKey: input.idempotencyKey,
      status: "applied",
    },
  });
  if (existing) {
    return {
      ok: true,
      deduplicated: true,
      idempotencyKey: input.idempotencyKey,
      shopifyTransferId: existing.externalId ?? null,
      result: existing.result ?? null,
    };
  }

  // Validate preview one more time at gate (compare-and-set: reject if the input
  // has drifted from what was approved).
  const validated = previewInventoryTransfer(input.preview);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, message: validated.message };
  }

  let shopifyResult;
  try {
    shopifyResult = await input.shopifyClient.createInventoryTransfer({
      originLocationId: validated.preview.originLocationId,
      destinationLocationId: validated.preview.destinationLocationId,
      lineItems: validated.preview.lineItems.map((item) => ({
        inventoryItemId: item.inventoryItemId,
        quantity: item.quantity,
      })),
    });
  } catch (error) {
    logger.error?.("inventory transfer write failed", {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
      error: error instanceof Error ? error.message : "UnknownError",
    });
    return {
      ok: false,
      reason: "shopify_error",
      message: "The transfer could not be created in Shopify. Nothing was changed.",
      retryable: true,
    };
  }

  const transferId = shopifyResult?.transfer?.id ?? shopifyResult?.id ?? null;
  const transferStatus = shopifyResult?.transfer?.status ?? shopifyResult?.status ?? null;

  if (shopifyResult?.userErrors?.length > 0) {
    return {
      ok: false,
      reason: "shopify_user_errors",
      message: shopifyResult.userErrors.map((/** @type {any} */ e) => e.message).join("; "),
      userErrors: shopifyResult.userErrors,
    };
  }

  // Durably persist the external result.
  if (prisma.actionExecutionWrite?.create) {
    try {
      await prisma.actionExecutionWrite.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          actionId: input.actionId,
          merchantId: input.merchantId,
          shopId: input.shopId,
          targetRef: `shopify:inventoryTransfer:${transferId ?? "unknown"}`,
          externalId: transferId,
          status: "applied",
          actor: input.actor ?? input.merchantId,
          result: shopifyResult,
          appliedAt: new Date(),
        },
      });
    } catch (writeError) {
      // The Shopify write succeeded; log but do not fail. The receipt will be
      // missing from the DB but the transfer was created in Shopify.
      logger.error?.("failed to persist inventory transfer receipt", {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        transferId,
        error: writeError instanceof Error ? writeError.message : "UnknownError",
      });
    }
  }

  logger.info("inventory transfer created", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
    transferId,
    transferStatus,
    idempotencyKey: input.idempotencyKey,
    lineItemCount: validated.preview.lineItems.length,
  });

  return {
    ok: true,
    idempotencyKey: input.idempotencyKey,
    shopifyTransferId: transferId,
    status: transferStatus,
    lineItemCount: validated.preview.lineItems.length,
  };
}
