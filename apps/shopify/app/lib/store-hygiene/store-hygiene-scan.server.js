// @ts-check

// The store-hygiene ("tidy-up") scan — Jefe's first-week credibility feature (design_backend_backlog
// item 8). It reads REAL, already-ingested store data and surfaces concrete tidy-ups as Brief
// findings, each with a real primary action that deep-links the merchant to the exact fix inside
// Shopify admin. It NEVER writes to the store and NEVER fabricates a number: a check emits a finding
// only when the underlying data is present and actually shows the gap.
//
// Shape mirrors app/lib/actions/dead-stock-clearance.server.js: a PURE core (detectors +
// `buildStoreHygieneFindings`, fully unit-testable with plain rows) and a thin DB layer
// (`getStoreHygieneFindings`) that queries Prisma, shapes rows, and calls the pure core.
//
// Deliberately NOT here (honest scope): generative "drafted copy" and any write-back. Drafting
// listing copy is an LLM + typed write-adapter feature (the clearance pattern), a separate
// action-type; v1 finds the gap and links to the fix. Primary-action labels say what actually
// happens ("Add a description"), never a "Read the drafts" we can't yet deliver.

import { buildAdminDeepLinker } from "../shopify/admin-deep-link.server.js";

/**
 * A rendered tidy-up finding. Structurally matches the `Finding` type the 13a Brief renders
 * (app/components/app-home/sections.tsx) — `primary.external` opens the admin link top-level.
 * @typedef {Object} HygieneFinding
 * @property {string} id
 * @property {string} title
 * @property {string} body
 * @property {"tidy-up" | "pattern"} kind
 * @property {null} when
 * @property {{ label: string, href?: string, external?: boolean } | null} primary
 * @property {string | null} dismiss
 */

/** Trailing window (days) for the refund-cluster check. */
export const HYGIENE_WINDOW_DAYS = 30;

/** How many findings the scan will surface at most, so the Brief stays calm. */
export const MAX_HYGIENE_FINDINGS = 4;

// Refund-cluster thresholds — tuned to avoid crying wolf on tiny numbers. A cluster needs
// enough refunds to be a pattern (not one unhappy customer) AND one product to genuinely dominate.
const REFUND_CLUSTER_MIN_REFUNDS = 3; // at least this many refunds in the window
const REFUND_CLUSTER_MIN_PRODUCT_COUNT = 2; // the leading product must drive at least this many
const REFUND_CLUSTER_MIN_SHARE = 0.4; // ...and at least this share of them

// ── text helpers ─────────────────────────────────────────────────────────────────
/** @param {string | null | undefined} value */
function isBlank(value) {
  return value == null || String(value).trim() === "";
}

/**
 * Strip HTML tags/entities to decide whether a description is *really* empty (Shopify stores
 * descriptions as HTML, so "<p></p>" or "&nbsp;" is blank in every way that matters).
 * @param {string | null | undefined} html
 */
function htmlIsBlank(html) {
  if (html == null) return true;
  const text = String(html)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z]+;/gi, "")
    .trim();
  return text === "";
}

/** @param {number} count @param {string} singular @param {string} [plural] */
function plural(count, singular, plural) {
  return count === 1 ? singular : plural ?? `${singular}s`;
}

/**
 * "Alpha", "Alpha and Beta", "Alpha, Beta and Gamma", "Alpha, Beta and 3 others".
 * @param {Array<string | null | undefined>} titles @param {number} [max]
 */
export function nameList(titles, max = 3) {
  const clean = titles.map((t) => (isBlank(t) ? "Untitled" : String(t).trim()));
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  const shown = clean.slice(0, max);
  const remainder = clean.length - shown.length;
  if (remainder > 0) {
    return `${shown.join(", ")} and ${remainder} ${plural(remainder, "other")}`;
  }
  const last = shown[shown.length - 1];
  return `${shown.slice(0, -1).join(", ")} and ${last}`;
}

// Shopify admin deep-links are built through the canonical shared helper (app/lib/shopify/
// admin-deep-link.server.js) so every Finding action shapes them the same way. `buildAdminDeepLinker`
// is imported at the top of this module.

/**
 * Choose the primary action for a finding that covers N products: link to the single product when
 * there's exactly one (straight to the fix), otherwise to the products index.
 * @param {ReturnType<typeof buildAdminDeepLinker>} links
 * @param {Array<{ externalId?: string | null }>} products
 * @param {string} label
 * @returns {HygieneFinding["primary"]}
 */
function primaryFor(links, products, label) {
  const href =
    products.length === 1 ? links.product(products[0]?.externalId) : links.products();
  return { label, href: href ?? undefined, external: true };
}

// ── sellability ────────────────────────────────────────────────────────────────────
/**
 * Only sellable products are worth tidying — an ARCHIVED or DRAFT product missing a description
 * isn't a customer-facing problem. Unknown/blank status is treated as sellable (thin/old data).
 * @param {string | null | undefined} status
 */
export function isSellableStatus(status) {
  if (isBlank(status)) return true;
  return String(status).trim().toUpperCase() === "ACTIVE";
}

// ── detectors (pure) ─────────────────────────────────────────────────────────────
/**
 * @typedef {Object} HygieneProduct
 * @property {string} id
 * @property {string} externalId
 * @property {string | null} [title]
 * @property {string | null} [status]
 * @property {string | null} [productType]
 * @property {string | null | undefined} [description] // undefined = not synced yet (unknown); string ('' ok) = known
 */
/**
 * @typedef {Object} HygieneVariant
 * @property {string} id
 * @property {string} externalId
 * @property {string} productExternalId
 * @property {string | null} [sku]
 * @property {number | null} [unitCost]
 */

/**
 * Products missing a description. Only considers products whose description is KNOWN (synced);
 * a store backfilled before the description field existed reports `undefined` and is skipped, so
 * we never mislabel "not yet synced" as "missing". Blank HTML ("<p></p>") counts as missing.
 * @param {{ products: HygieneProduct[], sellable: Set<string>, links: ReturnType<typeof buildAdminDeepLinker> }} input
 * @returns {HygieneFinding | null}
 */
export function detectMissingDescriptions({ products, sellable, links }) {
  const gap = products.filter(
    (p) =>
      sellable.has(p.externalId) &&
      p.description !== undefined && // known
      htmlIsBlank(p.description),
  );
  if (gap.length === 0) return null;
  const n = gap.length;
  return {
    id: "hygiene:missing-description",
    title: `${n} ${plural(n, "product has", "products have")} no description`,
    body: `${nameList(gap.map((p) => p.title))} ${n === 1 ? "has" : "have"} an empty description. Shoppers and search skip listings with nothing to read — adding a few lines is often the fastest lift for a product that gets views but no sales.`,
    kind: "tidy-up",
    when: null,
    primary: primaryFor(links, gap, n === 1 ? "Add a description" : "Add descriptions"),
    dismiss: "Not now",
  };
}

/**
 * Sellable variants with no unit cost. This one is Jefe-shaped: without cost he can't protect your
 * margin floor, so these products are invisible to clearance and any margin-aware move.
 * @param {{ variants: HygieneVariant[], productsByExternalId: Map<string, HygieneProduct>, sellable: Set<string>, links: ReturnType<typeof buildAdminDeepLinker> }} input
 * @returns {HygieneFinding | null}
 */
export function detectMissingCosts({ variants, productsByExternalId, sellable, links }) {
  const missing = variants.filter(
    (v) => sellable.has(v.productExternalId) && v.unitCost == null,
  );
  if (missing.length === 0) return null;
  const productExternalIds = [...new Set(missing.map((v) => v.productExternalId))];
  const products = productExternalIds
    .map((extId) => productsByExternalId.get(extId))
    .filter(/** @returns {p is HygieneProduct} */ (p) => Boolean(p));
  const n = products.length;
  return {
    id: "hygiene:missing-cost",
    title: `Jefe can't see cost on ${n} ${plural(n, "product")}`,
    body: `${nameList(products.map((p) => p.title))} ${n === 1 ? "has" : "have"} no cost per item set. Cost is what keeps Jefe from ever marking a product below what you paid — until it's filled in, he'll leave ${n === 1 ? "this product" : "these"} out of clearance and any pricing move, to be safe.`,
    kind: "tidy-up",
    when: null,
    primary: primaryFor(links, products, n === 1 ? "Add the cost" : "Add costs"),
    dismiss: "Not now",
  };
}

/**
 * Sellable products with no product type — hurts categorisation, collections and reporting.
 * @param {{ products: HygieneProduct[], sellable: Set<string>, links: ReturnType<typeof buildAdminDeepLinker> }} input
 * @returns {HygieneFinding | null}
 */
export function detectMissingProductType({ products, sellable, links }) {
  const gap = products.filter(
    (p) => sellable.has(p.externalId) && isBlank(p.productType),
  );
  if (gap.length === 0) return null;
  const n = gap.length;
  return {
    id: "hygiene:missing-product-type",
    title: `${n} ${plural(n, "product has", "products have")} no product type`,
    body: `${nameList(gap.map((p) => p.title))} ${n === 1 ? "isn't" : "aren't"} categorised. Product type drives collections, filtering and how Jefe groups your catalogue — a quick label makes everything downstream tidier.`,
    kind: "tidy-up",
    when: null,
    primary: primaryFor(links, gap, n === 1 ? "Set the type" : "Set product types"),
    dismiss: "Not now",
  };
}

/**
 * Sellable variants with no SKU — breaks inventory tracking and clean reporting.
 * @param {{ variants: HygieneVariant[], productsByExternalId: Map<string, HygieneProduct>, sellable: Set<string>, links: ReturnType<typeof buildAdminDeepLinker> }} input
 * @returns {HygieneFinding | null}
 */
export function detectMissingSkus({ variants, productsByExternalId, sellable, links }) {
  const missing = variants.filter(
    (v) => sellable.has(v.productExternalId) && isBlank(v.sku),
  );
  if (missing.length === 0) return null;
  const productExternalIds = [...new Set(missing.map((v) => v.productExternalId))];
  const products = productExternalIds
    .map((extId) => productsByExternalId.get(extId))
    .filter(/** @returns {p is HygieneProduct} */ (p) => Boolean(p));
  const variantCount = missing.length;
  return {
    id: "hygiene:missing-sku",
    title: `${variantCount} ${plural(variantCount, "variant has", "variants have")} no SKU`,
    body: `${nameList(products.map((p) => p.title))} ${products.length === 1 ? "has a variant" : "have variants"} with no SKU. SKUs are how inventory and reporting stay accurate — worth adding before the numbers drift.`,
    kind: "tidy-up",
    when: null,
    primary: primaryFor(
      links,
      products,
      products.length === 1 ? "Add a SKU" : "Add SKUs",
    ),
    dismiss: "Not now",
  };
}

/**
 * @typedef {Object} RefundLine
 * @property {string} refundId
 * @property {string | null} productExternalId
 * @property {number} refundedAmount
 * @property {number} refundedQuantity
 */
/**
 * A single product driving a disproportionate share of refunds in the window. Each refund is
 * attributed to its dominant product (largest refunded amount); a cluster needs enough refunds to
 * be a pattern and one product to genuinely lead. Frames it as a listing signal, not a verdict.
 * @param {{ refundLines: RefundLine[], refundCount: number, orderCount?: number, productsByExternalId: Map<string, HygieneProduct>, windowDays: number, links: ReturnType<typeof buildAdminDeepLinker> }} input
 * @returns {HygieneFinding | null}
 */
export function detectRefundCluster({
  refundLines,
  refundCount,
  orderCount,
  productsByExternalId,
  windowDays,
  links,
}) {
  if (refundCount < REFUND_CLUSTER_MIN_REFUNDS) return null;

  // Reduce lines → one dominant product per refund (argmax refunded amount).
  /** @type {Map<string, { productExternalId: string | null, amount: number }>} */
  const byRefund = new Map();
  for (const line of refundLines) {
    const current = byRefund.get(line.refundId);
    if (!current || line.refundedAmount > current.amount) {
      byRefund.set(line.refundId, {
        productExternalId: line.productExternalId,
        amount: line.refundedAmount,
      });
    }
  }
  // Tally dominant-product across refunds.
  /** @type {Map<string, number>} */
  const tally = new Map();
  for (const { productExternalId } of byRefund.values()) {
    if (!productExternalId) continue;
    tally.set(productExternalId, (tally.get(productExternalId) ?? 0) + 1);
  }
  let leadExternalId = /** @type {string | null} */ (null);
  let leadCount = 0;
  for (const [extId, count] of tally) {
    if (count > leadCount) {
      leadExternalId = extId;
      leadCount = count;
    }
  }
  if (
    !leadExternalId ||
    leadCount < REFUND_CLUSTER_MIN_PRODUCT_COUNT ||
    leadCount / refundCount < REFUND_CLUSTER_MIN_SHARE
  ) {
    return null;
  }
  const product = productsByExternalId.get(leadExternalId);
  const name = product ? (isBlank(product.title) ? "one product" : String(product.title).trim()) : "one product";
  const ratePart =
    orderCount && orderCount > 0
      ? ` Your refund rate is about ${Math.round((refundCount / orderCount) * 100)}% over the last ${windowDays} days —`
      : ` Over the last ${windowDays} days,`;
  return {
    id: "hygiene:refund-cluster",
    title: `Refunds are clustering on one product`,
    body: `${ratePart} ${leadCount} of ${refundCount} refunds were ${name}. That's usually a listing or expectations problem, not the product — worth a read before anything changes. Jefe won't touch the listing without you.`,
    kind: "pattern",
    when: null,
    primary: product
      ? { label: `Review ${name}`, href: links.product(product.externalId) ?? undefined, external: true }
      : { label: "Review these refunds", href: links.products() ?? undefined, external: true },
    dismiss: "I know about this",
  };
}

// ── pure aggregator ────────────────────────────────────────────────────────────────
/**
 * Run every detector over shaped rows and return ordered findings (most valuable first, capped).
 * Order: refund cluster (revenue/trust) → missing cost (margin, blocks Jefe) → descriptions →
 * product types → SKUs.
 * @param {{
 *   products: HygieneProduct[],
 *   variants: HygieneVariant[],
 *   refundLines: RefundLine[],
 *   refundCount: number,
 *   orderCount?: number,
 *   windowDays?: number,
 *   links: ReturnType<typeof buildAdminDeepLinker>,
 * }} input
 * @returns {HygieneFinding[]}
 */
export function buildStoreHygieneFindings(input) {
  const windowDays = input.windowDays ?? HYGIENE_WINDOW_DAYS;
  const sellable = new Set(
    input.products.filter((p) => isSellableStatus(p.status)).map((p) => p.externalId),
  );
  const productsByExternalId = new Map(input.products.map((p) => [p.externalId, p]));

  const findings = [
    detectRefundCluster({
      refundLines: input.refundLines,
      refundCount: input.refundCount,
      orderCount: input.orderCount,
      productsByExternalId,
      windowDays,
      links: input.links,
    }),
    detectMissingCosts({
      variants: input.variants,
      productsByExternalId,
      sellable,
      links: input.links,
    }),
    detectMissingDescriptions({ products: input.products, sellable, links: input.links }),
    detectMissingProductType({ products: input.products, sellable, links: input.links }),
    detectMissingSkus({
      variants: input.variants,
      productsByExternalId,
      sellable,
      links: input.links,
    }),
  ].filter(/** @returns {f is HygieneFinding} */ (f) => Boolean(f));

  return findings.slice(0, MAX_HYGIENE_FINDINGS);
}

// ── rawPayload parsing (pure) ───────────────────────────────────────────────────────
/** @param {unknown} value */
function asObject(value) {
  return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : {};
}

/** @param {unknown} value */
function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** shopMoney amount out of a Shopify MoneySet. @param {unknown} moneySet */
function moneySetAmount(moneySet) {
  return asNumber(asObject(asObject(moneySet).shopMoney).amount);
}

/**
 * A product's description out of the stored product rawPayload. Returns `undefined` when the
 * field was never synced (so callers can tell "unknown" from an actual empty string). Kept
 * separate + exported so the "known vs not-yet-synced" rule is unit-tested.
 * @param {unknown} rawPayload
 * @returns {string | null | undefined}
 */
export function descriptionFromProductPayload(rawPayload) {
  const payload = asObject(rawPayload);
  if (Object.prototype.hasOwnProperty.call(payload, "descriptionHtml")) {
    const value = payload.descriptionHtml;
    return value == null ? "" : String(value);
  }
  // `bodyHtml` is the REST spelling — accept it too in case a store was synced via that path.
  if (Object.prototype.hasOwnProperty.call(payload, "bodyHtml")) {
    const value = payload.bodyHtml;
    return value == null ? "" : String(value);
  }
  return undefined;
}

/**
 * Parse one order's stored rawPayload into its in-window refunds, each with per-product
 * attribution lines. Pure + exported so refund attribution is unit-testable without a DB.
 * @param {unknown} orderRawPayload
 * @param {number} cutoffMs epoch ms; refunds created before this are ignored
 * @returns {Array<{ refundId: string, lines: RefundLine[] }>}
 */
export function extractOrderRefunds(orderRawPayload, cutoffMs) {
  const order = asObject(orderRawPayload);
  const refunds = Array.isArray(order.refunds) ? order.refunds : [];
  /** @type {Array<{ refundId: string, lines: RefundLine[] }>} */
  const result = [];
  for (let i = 0; i < refunds.length; i += 1) {
    const refund = asObject(refunds[i]);
    const refundId = typeof refund.id === "string" && refund.id ? refund.id : `refund-${i}`;
    const createdAt = typeof refund.createdAt === "string" ? Date.parse(refund.createdAt) : NaN;
    // Missing/unparseable dates are kept (a real refund we can't date shouldn't vanish); only a
    // parseable date that's out of window is dropped.
    if (Number.isFinite(createdAt) && createdAt < cutoffMs) continue;
    const edges = Array.isArray(asObject(refund.refundLineItems).edges)
      ? asObject(refund.refundLineItems).edges
      : [];
    /** @type {RefundLine[]} */
    const lines = [];
    for (const edge of edges) {
      const node = asObject(asObject(edge).node);
      const productId = asObject(asObject(node.lineItem).product).id;
      lines.push({
        refundId,
        productExternalId: typeof productId === "string" && productId ? productId : null,
        refundedAmount: moneySetAmount(node.subtotalSet),
        refundedQuantity: asNumber(node.quantity),
      });
    }
    result.push({ refundId, lines });
  }
  return result;
}

// ── DB layer ─────────────────────────────────────────────────────────────────────
// Generous caps: Jefe's stores are thin, so these usually cover the whole catalogue. If a store
// exceeds a cap the scan under-reports (never over-reports) and stays honest.
const PRODUCT_SCAN_CAP = 1000;
const VARIANT_SCAN_CAP = 2000;
const REFUND_ORDER_SCAN_CAP = 500;

/**
 * The live scan: read real store rows and return render-ready findings for the 13a Brief. Read-only
 * (a handful of indexed queries), and safe on a thin/empty store (returns []). Never throws for the
 * caller to worry about — the loader treats findings as best-effort.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string, shopId: string, shopDomain: string, now?: Date, windowDays?: number }} input
 * @returns {Promise<HygieneFinding[]>}
 */
export async function getStoreHygieneFindings(prisma, input) {
  const { merchantId, shopId, shopDomain } = input;
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? HYGIENE_WINDOW_DAYS;
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const links = buildAdminDeepLinker(shopDomain);

  const [productRows, variantRows, refundRows, orderCount] = await Promise.all([
    prisma.product.findMany({
      where: { merchantId, shopId },
      select: { id: true, externalId: true, title: true, status: true, productType: true, rawPayload: true },
      take: PRODUCT_SCAN_CAP,
      orderBy: { sourceUpdatedAt: "desc" },
    }),
    prisma.variant.findMany({
      where: { merchantId, shopId },
      select: { id: true, externalId: true, sku: true, unitCost: true, product: { select: { externalId: true } } },
      take: VARIANT_SCAN_CAP,
    }),
    prisma.refund.findMany({
      where: { merchantId, shopId, processedAt: { gte: cutoff } },
      select: { orderId: true },
      take: REFUND_ORDER_SCAN_CAP,
    }),
    prisma.order.count({ where: { merchantId, shopId, processedAt: { gte: cutoff } } }),
  ]);

  /** @type {HygieneProduct[]} */
  const products = productRows.map((p) => ({
    id: p.id,
    externalId: p.externalId,
    title: p.title ?? null,
    status: p.status ?? null,
    productType: p.productType ?? null,
    description: descriptionFromProductPayload(p.rawPayload),
  }));

  /** @type {HygieneVariant[]} */
  const variants = variantRows
    .filter((v) => v.product?.externalId)
    .map((v) => ({
      id: v.id,
      externalId: v.externalId,
      productExternalId: /** @type {string} */ (v.product.externalId),
      sku: v.sku ?? null,
      unitCost: v.unitCost == null ? null : Number(v.unitCost),
    }));

  // Attribute refunds to products by parsing the orders that had a refund in the window.
  const orderIds = [...new Set(refundRows.map((r) => r.orderId))];
  /** @type {RefundLine[]} */
  const refundLines = [];
  let refundCount = 0;
  if (orderIds.length > 0) {
    const orders = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { rawPayload: true },
    });
    const cutoffMs = cutoff.getTime();
    for (const order of orders) {
      for (const refund of extractOrderRefunds(order.rawPayload, cutoffMs)) {
        refundCount += 1;
        refundLines.push(...refund.lines);
      }
    }
  }

  return buildStoreHygieneFindings({
    products,
    variants,
    refundLines,
    refundCount,
    orderCount,
    windowDays,
    links,
  });
}
