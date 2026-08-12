// @ts-check

// Render-ready read over the `business.tool_stack` belief for the onboarding + integrations
// surface ("we can see you're using X — connect it?"). READ-ONLY and NULL-SAFE: the belief may
// not exist yet — detection is dark until `ENABLE_TOOL_STACK_DETECTION` + a caller land, and the
// belief-write seam is wired separately — so "no belief" is a first-class, friendly state, never
// an error.
//
// Detection is INFERENCE. Every tool carries a confidence band + a "Jefe spotted this" framing,
// is marked `surfaceable` only at/above a threshold, and stays merchant-correctable through the
// standard memory provenance ladder — never asserted as fact (context/product-truth).
//
// Nothing here is "connected": the connect MECHANISM is a deferred product decision
// (docs/integrations/connect-mechanism.md). Each tool still exposes a `connectOffer` descriptor so
// the surface can render the CTA per design — honestly gated "coming_soon", not a fake working
// button (wire-or-keep design fidelity; never fabricate merchant data).

import { getBelief } from "../merchant-memory/service.server.js";

export const TOOL_STACK_BELIEF_KEY = "business.tool_stack";

// At/above this confidence a detection is firm enough to say "we can see you use X"; below it the
// surface should soften to "you might use X". Tag-only matches (0.6 in the detector) fall below.
export const TOOL_SURFACEABLE_CONFIDENCE = 0.7;

/** @type {Record<string, string>} */
const CATEGORY_LABEL = {
  subscriptions: "Subscriptions",
  reviews: "Reviews",
  loyalty: "Loyalty & rewards",
  fulfillment: "Fulfillment & shipping",
  payments: "Payments",
  support: "Support & helpdesk",
  email_marketing: "Email & marketing",
  upsell: "Upsell & cross-sell",
  other: "Other",
};

// "How Jefe spotted it" — humanize the detector's matchedBy tokens (metafield:klaviyo,
// gateway:paypal, fulfillment:shipstation, orderTag:…, customerTag:…) into one plain phrase.
/** @type {Record<string, string>} */
const SIGNAL_PHRASE = {
  metafield: "app data saved in your store",
  fulfillment: "a fulfillment service on your orders",
  gateway: "a payment method at checkout",
  orderTag: "how your orders are tagged",
  customerTag: "how your customers are tagged",
};

/** @param {number | null | undefined} c */
export function toolConfidenceBand(c) {
  if (c == null) return "unknown";
  if (c >= 0.85) return "high";
  if (c >= 0.7) return "medium";
  return "low";
}

/** @param {string[] | undefined} matchedBy */
export function detectedViaPhrase(matchedBy) {
  for (const m of matchedBy ?? []) {
    const kind = String(m).split(":")[0];
    const phrase = SIGNAL_PHRASE[kind];
    if (phrase) return phrase; // matchedBy is confidence-sorted upstream; the first is the strongest tell
  }
  return "signals in your store";
}

// Tolerate however the belief-write seam shapes the value: a bare array, or a wrapper with
// `detected`/`tools`. Keep only well-formed tool entries (must have an id).
/** @param {any} value */
function normalizeDetected(value) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(value?.detected)
      ? value.detected
      : Array.isArray(value?.tools)
        ? value.tools
        : [];
  return list.filter((/** @type {any} */ t) => t && typeof t === "object" && t.id);
}

/** @param {Array<{ name: string }>} tools */
function buildHeadline(tools) {
  const names = tools.map((t) => t.name);
  if (names.length === 0) return null;
  if (names.length === 1) return `Jefe spotted ${names[0]} in your stack`;
  if (names.length === 2) return `Jefe spotted ${names[0]} and ${names[1]} in your stack`;
  return `Jefe spotted ${names.slice(0, 2).join(", ")} and ${names.length - 2} more in your stack`;
}

/**
 * Pure: map a `business.tool_stack` domain belief (or null) → a render-ready view for the
 * onboarding + integrations surface. No I/O — unit-testable on plain Node.
 * @param {any} belief — a domain belief from getBelief, or null
 */
export function buildDetectedToolStackView(belief) {
  const detected = normalizeDetected(belief?.value);
  const tools = detected.map((/** @type {any} */ t) => {
    const confidence = typeof t.confidence === "number" ? t.confidence : null;
    const category = typeof t.category === "string" ? t.category : "other";
    const name = String(t.name ?? t.id);
    return {
      id: String(t.id),
      name,
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? CATEGORY_LABEL.other,
      confidence,
      confidenceBand: toolConfidenceBand(confidence),
      surfaceable: confidence != null && confidence >= TOOL_SURFACEABLE_CONFIDENCE,
      detectedVia: detectedViaPhrase(t.matchedBy),
      // No connection store + no connect mechanism yet → nothing is connected. Honest, not fabricated.
      connected: false,
      connectOffer: {
        // Kept visible per design; honestly gated until the connect mechanism lands.
        status: "coming_soon",
        cta: `Connect ${name}`,
      },
    };
  });

  /** @type {Map<string, { category: string, categoryLabel: string, tools: typeof tools }>} */
  const byCategoryMap = new Map();
  for (const tool of tools) {
    const bucket = byCategoryMap.get(tool.category);
    if (bucket) bucket.tools.push(tool);
    else byCategoryMap.set(tool.category, { category: tool.category, categoryLabel: tool.categoryLabel, tools: [tool] });
  }

  return {
    beliefKey: TOOL_STACK_BELIEF_KEY,
    // The whole belief is model inference — the surface must frame it as "Jefe spotted", never fact.
    provenance: "inference",
    confidence: belief && typeof belief.confidence === "number" ? belief.confidence : null,
    detectedAt: belief?.lastObservedAt ?? belief?.lastEvaluatedAt ?? null,
    tools,
    byCategory: Array.from(byCategoryMap.values()),
    count: tools.length,
    surfaceableCount: tools.filter((/** @type {any} */ t) => t.surfaceable).length,
    empty: tools.length === 0,
    headline: buildHeadline(tools),
    // "none_yet" covers belief-absent / detection-dark / no-matches alike — the surface shows a
    // "still learning your stack" state rather than claiming the merchant runs nothing.
    status: tools.length ? "detected" : "none_yet",
  };
}

/**
 * Read the merchant's detected tool stack, render-ready for the onboarding + integrations page.
 * Null-safe: no belief → a friendly "none_yet" view. DB errors propagate to the caller's error
 * boundary (a read failure is not an empty stack — don't mask it).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string }} input
 */
export async function getDetectedToolStack(prisma, input) {
  const belief = await getBelief(prisma, { merchantId: input.merchantId, key: TOOL_STACK_BELIEF_KEY });
  return buildDetectedToolStackView(belief);
}
