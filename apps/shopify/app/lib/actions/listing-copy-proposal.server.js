// @ts-check

// What product type should Jefe propose for a product that has none?
//
// ⛔ FROM THE MERCHANT'S OWN VOCABULARY, never an invented taxonomy. A merchant who calls a
// category "Barware" does not want Jefe deciding it is "Drinkware" — the value here is
// CONSISTENCY with what they already do, not classification against some external standard.
// It also means every proposal is explainable in one line ("your other Hawkstone products are
// all Spirits"), which is what makes it correctable rather than mysterious.
//
// Deterministic and pure — no LLM. A model could guess a type for a product whose vendor and
// title say nothing, but a guess is exactly what must not be written into a merchant's
// catalogue silently. Where the evidence is thin this proposes NOTHING and the caller asks
// the merchant instead (the instruct path — no dead ends).

/** A vendor needs this many typed products before its dominant type means anything. */
const MIN_VENDOR_EVIDENCE = 3;
/** …and that dominant type must cover this much of them. */
const MIN_VENDOR_DOMINANCE = 0.8;
/** A title match needs a token this long to be distinctive ("tonic" yes, "the" no). */
const MIN_TOKEN_LENGTH = 4;

const STOPWORDS = new Set([
  "with", "from", "your", "our", "the", "and", "for", "size", "pack", "set", "new",
  "ml", "cl", "litre", "liter", "gram", "grams", "kg", "cm", "mm", "black", "white",
]);

/** @param {unknown} value */
function blank(value) {
  return typeof value !== "string" || value.trim() === "";
}

/** @param {string | null | undefined} title */
function tokens(title) {
  return String(title ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Most frequent entry, with its share. Ties break alphabetically so a rerun proposes the same thing.
 * @param {Map<string, number>} counts */
function dominant(counts) {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return null;
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return { value: entries[0][0], count: entries[0][1], share: entries[0][1] / total };
}

/**
 * Propose product types for the untyped products in a catalogue, using the typed ones as the
 * vocabulary. Pure — no I/O.
 *
 * @param {{ products?: Array<{ productId: string, title?: string | null, vendor?: string | null, productType?: string | null, status?: string | null }> }} input
 * @returns {{ proposals: Array<{ productId: string, title: string | null, currentType: string, proposedType: string, confidence: number, basis: string, because: string }>, unresolved: Array<{ productId: string, title: string | null, reason: string }>, vocabulary: string[] }}
 */
export function proposeProductTypes(input) {
  const products = (input?.products ?? []).filter((p) => p?.productId);
  // Only sellable products are worth categorising, and only they inform the vocabulary — an
  // archived product's type is not evidence of how the merchant organises what they sell.
  const sellable = products.filter((p) => (p.status ?? "ACTIVE").toUpperCase() === "ACTIVE");
  const typed = sellable.filter((p) => !blank(p.productType));
  const untyped = sellable.filter((p) => blank(p.productType));

  /** @type {Map<string, Map<string, number>>} vendor → type → count */
  const byVendor = new Map();
  /** @type {Map<string, Map<string, number>>} title token → type → count */
  const byToken = new Map();
  const vocabulary = new Map();

  for (const product of typed) {
    const type = String(product.productType).trim();
    vocabulary.set(type, (vocabulary.get(type) ?? 0) + 1);
    const vendor = blank(product.vendor) ? null : String(product.vendor).trim().toLowerCase();
    if (vendor) {
      const counts = byVendor.get(vendor) ?? new Map();
      counts.set(type, (counts.get(type) ?? 0) + 1);
      byVendor.set(vendor, counts);
    }
    for (const token of new Set(tokens(product.title))) {
      const counts = byToken.get(token) ?? new Map();
      counts.set(type, (counts.get(type) ?? 0) + 1);
      byToken.set(token, counts);
    }
  }

  /** @type {Array<{ productId: string, title: string | null, currentType: string, proposedType: string, confidence: number, basis: string, because: string }>} */
  const proposals = [];
  /** @type {Array<{ productId: string, title: string | null, reason: string }>} */
  const unresolved = [];

  // Nothing typed at all means there is no vocabulary to be consistent WITH. Inventing one
  // is exactly the failure mode this module exists to avoid, so Jefe asks instead.
  if (vocabulary.size === 0) {
    for (const product of untyped) {
      unresolved.push({ productId: product.productId, title: product.title ?? null, reason: "no_existing_vocabulary" });
    }
    return { proposals, unresolved, vocabulary: [] };
  }

  for (const product of untyped) {
    const vendor = blank(product.vendor) ? null : String(product.vendor).trim().toLowerCase();
    const vendorCounts = vendor ? byVendor.get(vendor) : null;
    const vendorPick = vendorCounts ? dominant(vendorCounts) : null;

    // Vendor first: a brand almost always sells one kind of thing, and it is the signal a
    // merchant would use themselves.
    if (vendorPick && vendorPick.count >= MIN_VENDOR_EVIDENCE && vendorPick.share >= MIN_VENDOR_DOMINANCE) {
      proposals.push({
        productId: product.productId,
        title: product.title ?? null,
        currentType: "",
        proposedType: vendorPick.value,
        confidence: Math.min(0.95, 0.8 + vendorPick.share * 0.15),
        basis: "vendor",
        because: `your other ${String(product.vendor).trim()} products are ${vendorPick.value}`,
      });
      continue;
    }

    // Then a distinctive word the merchant themselves uses in titles of one type only.
    /** @type {Map<string, number>} */
    const titleVotes = new Map();
    for (const token of new Set(tokens(product.title))) {
      const counts = byToken.get(token);
      if (!counts) continue;
      const pick = dominant(counts);
      // Only an UNAMBIGUOUS token votes: a word appearing under two types tells us nothing.
      if (pick && pick.share === 1 && pick.count >= 2) {
        titleVotes.set(pick.value, (titleVotes.get(pick.value) ?? 0) + pick.count);
      }
    }
    const titlePick = dominant(titleVotes);
    if (titlePick && titleVotes.size === 1) {
      proposals.push({
        productId: product.productId,
        title: product.title ?? null,
        currentType: "",
        proposedType: titlePick.value,
        confidence: 0.85,
        basis: "title",
        because: `products you name like this are ${titlePick.value}`,
      });
      continue;
    }

    unresolved.push({
      productId: product.productId,
      title: product.title ?? null,
      reason: titleVotes.size > 1 ? "ambiguous_signals" : "no_matching_signal",
    });
  }

  return {
    proposals,
    unresolved,
    vocabulary: [...vocabulary.keys()].sort(),
  };
}
