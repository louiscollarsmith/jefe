// @ts-check

// Persistence bridge for tool-stack detection → the `business.tool_stack` Merchant Memory belief.
//
// This is the memory lane's half of tool-stack detection. It is a PURE leaf (imports nothing
// from the memory service or prisma) so it can be shared by BOTH feeder paths without a cycle:
//
//   1. DB-derivation  — `shopify-derivations.server.js` extracts signals from ingested records
//      (`toolStackSignalsFromRecords`), runs `detectToolStack`, and shapes the belief value with
//      `toolStackBeliefContent`. Persisted through the normal deriver → `upsertDerivedBelief` path.
//   2. Live-query feeder — the `detectAndRecordToolStack` orchestrator hands its already-`detected`
//      list to the injected `recordBelief` seam. `makeToolStackBeliefRecorder` is the concrete seam
//      implementation; the caller injects the real `upsertDerivedBelief` (see
//      `service.server.js#toolStackBeliefRecorder`). The orchestrator stays dark behind
//      `ENABLE_TOOL_STACK_DETECTION` and has no caller yet, so the seam is inert until one lands.
//
// `business.tool_stack` is MODEL INFERENCE, never a merchant-confirmed fact: it is written at
// systemInference precedence (the `upsertDerivedBelief` default — see the note on the builder) and
// is superseded by any merchant correction. Confidence reflects the strongest single matched
// signal, so a weak tag-only guess is never dressed up as near-certain. Every detected value is
// PII-free — tool ids/names/categories and signal KINDS only, never customer data.

/**
 * @typedef {{ id: string, name: string, category: string, matchedBy: string[], confidence: number }} DetectedTool
 */

/** The Merchant Memory belief key this module reads and writes. */
export const TOOL_STACK_BELIEF_KEY = "business.tool_stack";
export const TOOL_STACK_BELIEF_CATEGORY = "business";
export const TOOL_STACK_BELIEF_VALUE_TYPE = "structured";

const uniqueSorted = (/** @type {string[]} */ xs) => Array.from(new Set(xs)).sort();

/**
 * Shape a detected tool-stack list into the `business.tool_stack` belief content. Pure.
 * Confidence is the MAX per-tool confidence (the strongest single signal we have); an empty
 * detection yields a zero-confidence, zero-count value so callers can guard/skip on it.
 *
 * @param {DetectedTool[]} [detected]
 * @returns {{ value: { tools: Array<{ id: string, name: string, category: string, confidence: number, matchedBy: string[] }>, toolIds: string[], categories: string[], detectedCount: number, window: string }, confidence: number, confidenceReason: string, summary: string }}
 */
export function toolStackBeliefContent(detected = []) {
  const list = Array.isArray(detected) ? detected : [];
  const tools = list.map((tool) => ({
    id: tool.id,
    name: tool.name,
    category: tool.category,
    confidence: tool.confidence,
    matchedBy: Array.isArray(tool.matchedBy) ? tool.matchedBy : [],
  }));
  const categories = uniqueSorted(tools.map((tool) => tool.category));
  const confidence = tools.length
    ? Math.max(...tools.map((tool) => Number(tool.confidence) || 0))
    : 0;
  const summary = tools.length
    ? `Tool stack inferred from Shopify signals: ${tools.length} tool(s) across ${categories.length} categor${categories.length === 1 ? "y" : "ies"}.`
    : "No third-party tools detected from Shopify signals.";
  return {
    value: {
      tools,
      toolIds: tools.map((tool) => tool.id),
      categories,
      detectedCount: tools.length,
      window: "current_state",
    },
    confidence,
    confidenceReason:
      "Inferred from native Shopify signals (metafield namespaces, payment gateways, order/customer tags, fulfilment services); confidence reflects the strongest single matched signal. Model inference — a merchant correction supersedes it.",
    summary,
  };
}

const asStringArray = (/** @type {unknown} */ value) =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];

/**
 * Extract tool-stack detection signals from already-fetched ingested records — no new query.
 * Mirrors the live-query `signalsFromShopifyResponse` mapper but reads the DB `rawPayload` JSON.
 *
 * NOTE: `Order.rawPayload` is not currently selected by `loadDerivationContext` (avoiding the
 * memory cost of loading full order JSON on every memory build), so order-derived gateways/tags/
 * fulfilment are DORMANT until that select is added — this reader is written defensively so it
 * lights up automatically if it is. `metafieldNamespaces` (the strongest signatures) are never in
 * ingested records and arrive only via the live-query feeder. Customer tags come from the
 * already-selected `CustomerIdentity.rawPayload`. See docs/integrations/tool-stack-phase2.md.
 *
 * @param {{ orders?: Array<{ rawPayload?: any }>, customerIdentities?: Array<{ rawPayload?: any }> }} [records]
 * @returns {{ metafieldNamespaces: string[], fulfillmentServices: string[], gateways: string[], orderTags: string[], customerTags: string[] }}
 */
export function toolStackSignalsFromRecords(records = {}) {
  const orders = Array.isArray(records.orders) ? records.orders : [];
  const customerIdentities = Array.isArray(records.customerIdentities)
    ? records.customerIdentities
    : [];

  const gateways = new Set();
  const orderTags = new Set();
  const fulfillmentServices = new Set();
  const customerTags = new Set();

  for (const order of orders) {
    const payload = order?.rawPayload;
    if (!payload || typeof payload !== "object") continue;
    for (const gateway of asStringArray(payload.paymentGatewayNames)) gateways.add(gateway);
    for (const tag of normalizeTags(payload.tags)) orderTags.add(tag);
    const fulfillments = Array.isArray(payload.fulfillments) ? payload.fulfillments : [];
    for (const fulfillment of fulfillments) {
      const service = fulfillment?.service ?? fulfillment?.fulfillmentService;
      if (typeof service === "string" && service) fulfillmentServices.add(service);
    }
  }

  for (const identity of customerIdentities) {
    const payload = identity?.rawPayload;
    if (!payload || typeof payload !== "object") continue;
    for (const tag of normalizeTags(payload.tags)) customerTags.add(tag);
  }

  return {
    metafieldNamespaces: [],
    fulfillmentServices: Array.from(fulfillmentServices),
    gateways: Array.from(gateways),
    orderTags: Array.from(orderTags),
    customerTags: Array.from(customerTags),
  };
}

/** Shopify tags come as a comma-joined string or an array; normalise to a trimmed string array. */
function normalizeTags(/** @type {unknown} */ tags) {
  if (Array.isArray(tags)) return tags.filter((tag) => typeof tag === "string");
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Build the `upsertDerivedBelief` input for the detected tool stack. Pure — no I/O.
 *
 * Precedence is intentionally OMITTED: `upsertDerivedBelief` defaults it to systemInference and
 * always writes `status: inferred`, so the belief is guaranteed model inference and can never be
 * written as merchant-confirmed here. Do not add a merchant precedence to this input.
 *
 * @param {{ merchantId: string, shopId?: string | null, detected?: DetectedTool[], now?: Date }} args
 */
export function buildToolStackBeliefUpsertInput({ merchantId, shopId = null, detected = [], now = new Date() }) {
  const content = toolStackBeliefContent(detected);
  const matchedSignalKinds = uniqueSorted(
    content.value.tools.flatMap((tool) => tool.matchedBy.map((match) => String(match).split(":")[0])),
  );
  return {
    merchantId,
    shopId: shopId ?? null,
    category: TOOL_STACK_BELIEF_CATEGORY,
    key: TOOL_STACK_BELIEF_KEY,
    valueType: TOOL_STACK_BELIEF_VALUE_TYPE,
    value: content.value,
    confidence: content.confidence,
    confidenceReason: content.confidenceReason,
    observedAt: now,
    evaluatedAt: now,
    evidence: {
      sourceType: "shopify_signal_inference",
      sourceReference: null,
      evidenceType: "tool_stack_detection",
      summary: content.summary,
      metadata: {
        toolIds: content.value.toolIds,
        categories: content.value.categories,
        detectedCount: content.value.detectedCount,
        matchedSignalKinds,
      },
      observedAt: now,
    },
  };
}

/**
 * Build the concrete `recordBelief` seam for `detectAndRecordToolStack`. The real derived-belief
 * write path (`upsertDerivedBelief`) is INJECTED — this module never imports the memory service, so
 * `shopify-derivations` and `service` can both depend on it without a cycle. `service.server.js`
 * exposes `toolStackBeliefRecorder(prisma, opts)` which binds the real write path for callers.
 *
 * The returned fn matches the orchestrator's seam contract `({ merchantId, detected, signals })`.
 * An empty detection is a no-op (never writes an empty belief). A write failure is logged (error
 * capture) and rethrown so the fire-and-forget caller decides — a detection miss must never break
 * ingestion/auth.
 *
 * @param {{ upsertDerivedBelief: (prisma: any, input: any) => Promise<any>, prisma: any, shopId?: string | null, logger?: { info?: Function, warn?: Function, error?: Function } }} deps
 */
export function makeToolStackBeliefRecorder({ upsertDerivedBelief, prisma, shopId = null, logger } = /** @type {any} */ ({})) {
  if (typeof upsertDerivedBelief !== "function") {
    throw new TypeError("makeToolStackBeliefRecorder requires an upsertDerivedBelief function");
  }
  return async function recordToolStackBelief({ merchantId, detected = [], signals } = /** @type {any} */ ({})) {
    if (!merchantId) throw new TypeError("recordToolStackBelief requires merchantId");
    const list = Array.isArray(detected) ? detected : [];
    if (list.length < 1) {
      logger?.info?.("tool-stack belief skipped: no tools detected", {
        component: "integrations",
        merchantId,
        detectedCount: 0,
        signalKinds: signalKinds(signals),
      });
      return { wrote: false, reason: "no_tools_detected" };
    }
    const input = buildToolStackBeliefUpsertInput({ merchantId, shopId, detected: list });
    try {
      const result = await upsertDerivedBelief(prisma, input);
      logger?.info?.("tool-stack belief recorded", {
        component: "integrations",
        merchantId,
        detectedCount: list.length,
        // ids only — non-PII product identifiers
        toolIds: input.value.toolIds,
        confidence: input.confidence,
        changed: result?.changed ?? null,
      });
      return { wrote: true, result };
    } catch (error) {
      logger?.error?.("tool-stack belief write failed", {
        component: "integrations",
        merchantId,
        detectedCount: list.length,
        err: error,
      });
      throw error;
    }
  };
}

/**
 * Non-PII summary of which signal kinds a live-query `signals` object carried, for logging.
 * @param {any} signals
 */
function signalKinds(signals) {
  if (!signals || typeof signals !== "object") return [];
  return Object.entries(signals)
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([kind]) => kind)
    .sort();
}
