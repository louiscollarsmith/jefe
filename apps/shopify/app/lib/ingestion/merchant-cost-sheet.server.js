// @ts-check

// Merchant-supplied product costs from an uploaded spreadsheet — the first
// net-new modality of the memory feed. A costs sheet is STRUCTURED input, so it
// becomes a deterministic fact (no LLM inference): we detect the SKU and cost
// columns by header aliases and map SKU → variant. If we can't confidently find
// both columns we say so (needs confirmation) rather than guess. This directly
// raises products.cost_coverage and unlocks the gross-margin belief for merchants
// who won't fill cost-per-item one product at a time in Shopify.

// Header aliases for the two columns we need. Matching is case-insensitive and
// ignores spaces, underscores and punctuation (see normalizeHeader).
const SKU_COLUMN_ALIASES = [
  "sku",
  "variantsku",
  "productsku",
  "itemsku",
  "skucode",
  "itemnumber",
  "productcode",
  "code",
];
const COST_COLUMN_ALIASES = [
  "costperitem",
  "unitcost",
  "costprice",
  "cogs",
  "buyprice",
  "wholesaleprice",
  "wholesale",
  "supplycost",
  "cost",
];

/** @param {any} header */
function normalizeHeader(header) {
  return String(header ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Find the first header that matches one of the aliases — an exact normalized
 * match wins over a substring match, and earlier aliases win over later ones, so
 * "cost per item" is preferred over a stray "cost centre".
 * @param {string[]} headers
 * @param {string[]} aliases
 */
function detectColumn(headers, aliases) {
  for (const alias of aliases) {
    const exact = headers.find((header) => normalizeHeader(header) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const partial = headers.find((header) =>
      normalizeHeader(header).includes(alias),
    );
    if (partial) return partial;
  }
  return null;
}

/**
 * Parse a cost cell to a non-negative number. Strips currency symbols and
 * thousands separators; a bare decimal point is kept. Returns null when the cell
 * isn't a usable cost. (European decimal-comma is a documented follow-up.)
 * @param {any} raw
 */
function parseCostValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  const cleaned = String(raw).trim().replace(/[^0-9.,-]/g, "");
  if (!cleaned) return null;
  const normalized = cleaned.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Deterministically parse an uploaded costs sheet (array of header→value rows)
 * into de-duplicated {sku, cost} entries. Pure — no DB, no LLM.
 * @param {Array<Record<string, any>>} rows
 */
export function parseCostSheet(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      confident: false,
      reason: "empty_sheet",
      skuColumn: null,
      costColumn: null,
      entries: [],
      invalidRows: 0,
    };
  }
  const headers = [
    ...new Set(
      rows.flatMap((row) =>
        row && typeof row === "object" ? Object.keys(row) : [],
      ),
    ),
  ];
  const skuColumn = detectColumn(headers, SKU_COLUMN_ALIASES);
  const costColumn = detectColumn(headers, COST_COLUMN_ALIASES);
  if (!skuColumn || !costColumn) {
    return {
      confident: false,
      reason:
        !skuColumn && !costColumn
          ? "no_columns_detected"
          : !skuColumn
            ? "no_sku_column"
            : "no_cost_column",
      skuColumn,
      costColumn,
      entries: [],
      invalidRows: 0,
    };
  }
  const entries = [];
  const seenSkus = new Set();
  let invalidRows = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      invalidRows += 1;
      continue;
    }
    const sku = String(row[skuColumn] ?? "").trim();
    const cost = parseCostValue(row[costColumn]);
    if (!sku || cost === null) {
      invalidRows += 1;
      continue;
    }
    if (seenSkus.has(sku)) continue; // first occurrence wins
    seenSkus.add(sku);
    entries.push({ sku, cost });
  }
  return {
    confident: entries.length > 0,
    reason: entries.length > 0 ? "ok" : "no_valid_rows",
    skuColumn,
    costColumn,
    entries,
    invalidRows,
  };
}

/**
 * Ingest merchant-supplied product costs from an uploaded sheet. v1 is a
 * GAP-FILL: it sets unit cost only for matched variants that don't already have
 * one, so it can never silently overwrite a Shopify-observed cost (override +
 * cost provenance is a documented follow-up). The existing ingestion guard keeps
 * a filled cost from being wiped by a later cost-less Shopify sync. Returns a
 * summary the merchant-facing surface can report back.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; rows: Array<Record<string, any>> }} input
 */
export async function ingestMerchantCostRows(prisma, input) {
  const parsed = parseCostSheet(input.rows);
  if (!parsed.confident) {
    return {
      status: "needs_confirmation",
      reason: parsed.reason,
      skuColumn: parsed.skuColumn,
      costColumn: parsed.costColumn,
      matched: 0,
      filled: 0,
      skippedExisting: 0,
      unmatchedSkus: [],
      invalidRows: parsed.invalidRows,
    };
  }

  const costBySku = new Map(parsed.entries.map((entry) => [entry.sku, entry.cost]));
  const variants = await prisma.variant.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      sku: { in: [...costBySku.keys()] },
    },
    select: { id: true, sku: true, unitCost: true },
  });

  const matchedSkus = new Set();
  let filled = 0;
  let skippedExisting = 0;
  for (const variant of variants) {
    if (!variant.sku || !costBySku.has(variant.sku)) continue;
    matchedSkus.add(variant.sku);
    const alreadyHasCost =
      variant.unitCost !== null &&
      variant.unitCost !== undefined &&
      Number(variant.unitCost) > 0;
    if (alreadyHasCost) {
      skippedExisting += 1;
      continue;
    }
    await prisma.variant.update({
      where: { id: variant.id },
      data: { unitCost: costBySku.get(variant.sku) },
    });
    filled += 1;
  }

  const unmatchedSkus = [...costBySku.keys()].filter(
    (sku) => !matchedSkus.has(sku),
  );
  return {
    status: "applied",
    skuColumn: parsed.skuColumn,
    costColumn: parsed.costColumn,
    matched: matchedSkus.size,
    filled,
    skippedExisting,
    unmatchedSkus,
    invalidRows: parsed.invalidRows,
  };
}
