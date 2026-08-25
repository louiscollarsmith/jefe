// @ts-check
//
// Durable, per-invocation explicit confirmation for Shopify mutations classified at the
// EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED interaction tier (see mutation-safety.server.js) — the
// one non-frictionless tier the classifier can produce. Ordinary Action approval covers "the
// merchant agreed to this Action" as a whole; this covers "the merchant was shown exactly what
// THIS mutation call is about to do, immediately before it ran, and said yes" — a stronger,
// narrower, non-bypassable gate for the operations that need it. (An earlier version of this
// module also served a second, stricter SYSTEM_CRITICAL_CONFIRMATION_REQUIRED tier with its own
// shorter freshness window; the founder asked for that tier removed as a distinct concept — see
// mutation-safety.server.js's module note — so this module now serves exactly one tier.)
//
// Deliberately reuses MerchantActionEvent (schema.prisma) rather than a new table: it is already
// the durable, action-scoped audit history table, and a confirmation is exactly that — an event
// in an Action's history, not new domain state.
//
// Previously (before the 2026-08-25 execution-safety architecture change, see CLAUDE.md) this
// gate did not exist at runtime: gateway.server.js's hasExplicitHighRiskConfirmation() always
// returned false, because the operations that needed it were denied outright by
// PROHIBITED_OPERATIONS/UNSUPPORTED_SEMANTICS before reaching this check. Now that those
// operations have a real execution path, the confirmation gate has to be real too.

const EVENT_TYPE = "explicit_high_risk_confirmation";

// How long a recorded confirmation remains valid for the *exact same* (action, revision,
// operation, variables) invocation before it must be re-confirmed. Deliberately short —
// "immediately before execution", not a standing blanket approval.
const FRESHNESS_MS = Object.freeze({
  EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED: 60 * 60 * 1000, // 1 hour
});

/**
 * @param {{
 *   prisma: any;
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   acceptedActionRevision: string;
 *   operation: string;
 *   variablesHash: string;
 *   interactionTier: string;
 * }} input
 * @returns {Promise<boolean>}
 */
export async function hasExplicitHighRiskConfirmation(input) {
  const freshnessMs = /** @type {Record<string, number>} */ (FRESHNESS_MS)[input.interactionTier];
  if (!freshnessMs) return false; // unknown tier — fail closed, never let unknown mean confirmed
  if (!input.prisma?.merchantActionEvent?.findFirst) return false;
  const event = await input.prisma.merchantActionEvent.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      eventType: EVENT_TYPE,
      createdAt: { gte: new Date(Date.now() - freshnessMs) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!event) return false;
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return (
    metadata.acceptedActionRevision === input.acceptedActionRevision &&
    metadata.operation === input.operation &&
    metadata.variablesHash === input.variablesHash &&
    metadata.interactionTier === input.interactionTier
  );
}

/**
 * Records that a merchant (or an authenticated agent acting with the merchant present, e.g. a
 * chat confirmation) explicitly confirmed a specific high-risk Shopify mutation invocation,
 * immediately before it executes. The caller is responsible for having actually shown the
 * merchant the risk explanation and preview text — this function only durably records that the
 * confirmation happened, scoped to the exact invocation it applies to.
 * @param {{
 *   prisma: any;
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   acceptedActionRevision: string;
 *   operation: string;
 *   variablesHash: string;
 *   interactionTier: string;
 *   riskTier: string;
 *   confirmedBy: string;
 *   confirmationText: string;
 * }} input
 */
export async function recordExplicitHighRiskConfirmation(input) {
  if (!input.prisma?.merchantActionEvent?.create) {
    throw new Error("recordExplicitHighRiskConfirmation requires prisma.merchantActionEvent.create");
  }
  if (!input.confirmationText || input.confirmationText.length < 5) {
    throw new Error("An explicit high-risk confirmation requires non-trivial confirmation text from the merchant.");
  }
  return input.prisma.merchantActionEvent.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.actionId,
      eventType: EVENT_TYPE,
      metadata: {
        acceptedActionRevision: input.acceptedActionRevision,
        operation: input.operation,
        variablesHash: input.variablesHash,
        interactionTier: input.interactionTier,
        riskTier: input.riskTier,
        confirmedBy: input.confirmedBy,
        confirmationText: input.confirmationText,
      },
    },
  });
}

export { EVENT_TYPE as EXPLICIT_HIGH_RISK_CONFIRMATION_EVENT_TYPE, FRESHNESS_MS as EXPLICIT_CONFIRMATION_FRESHNESS_MS };
