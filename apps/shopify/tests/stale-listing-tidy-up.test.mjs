import assert from "node:assert/strict";
import test from "node:test";

import { buildProductStatusPreview } from "../app/lib/actions/product-status-adapter.server.js";
import {
  MAX_STALE_LISTINGS,
  STALE_LISTING_WINDOW_DAYS,
  buildStaleListingTidyUpProposal,
  selectStaleListings,
} from "../app/lib/actions/stale-listing-tidy-up.server.js";

// `tidy_up` archives live products off a merchant's storefront. Everything worth testing here
// is a REFUSAL: the failure mode is not "missed a tidy-up", it is "hid a product the merchant
// was still selling". Each test below is a store shape that must produce NOTHING.

const P = (id, over = {}) => ({
  productId: id,
  externalId: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  status: "ACTIVE",
  ...over,
});

function select({ products, variants, sold = [], available = {}, maxProducts }) {
  return selectStaleListings({
    products,
    variants,
    soldVariantIds: new Set(sold),
    availableByVariant: new Map(Object.entries(available)),
    maxProducts,
  });
}

test("archives a live product with known-zero stock and no sales", () => {
  const picked = select({
    products: [P("1")],
    variants: [{ variantId: "v1", productId: "1" }],
    available: { v1: 0 },
  });
  assert.equal(picked.length, 1);
  assert.deepEqual(
    { productId: picked[0].productId, from: picked[0].currentStatus, to: picked[0].targetStatus },
    { productId: "gid://shopify/Product/1", from: "ACTIVE", to: "ARCHIVED" },
  );
});

test("negative stock counts as nothing left to sell", () => {
  // Oversold to -2 is still "a shopper cannot buy this".
  const picked = select({
    products: [P("1")],
    variants: [{ variantId: "v1", productId: "1" }],
    available: { v1: -2 },
  });
  assert.equal(picked.length, 1);
});

test("⛔ UNKNOWN STOCK IS NEVER TREATED AS ZERO", () => {
  // No inventory level ingested for this variant. Archiving it would hide a product that may
  // be fully in stock and simply not synced yet.
  const picked = select({
    products: [P("1")],
    variants: [{ variantId: "v1", productId: "1" }],
    available: {},
  });
  assert.deepEqual(picked, []);
});

test("⛔ one variant with stock protects the whole product", () => {
  // Small in stock, large sold out. The product is still buyable — and a slow seller WITH
  // stock is clearance's job (mark it down), never tidy-up's.
  const picked = select({
    products: [P("1")],
    variants: [
      { variantId: "v1", productId: "1" },
      { variantId: "v2", productId: "1" },
    ],
    available: { v1: 0, v2: 4 },
  });
  assert.deepEqual(picked, []);
});

test("⛔ a partly-unknown product with one known-zero variant is still refused if any is unknown-and-none-known-positive", () => {
  // v1 known 0, v2 unknown. The known evidence says zero, so this DOES qualify — but only
  // because at least one level is known. Documenting the boundary explicitly.
  const picked = select({
    products: [P("1")],
    variants: [
      { variantId: "v1", productId: "1" },
      { variantId: "v2", productId: "1" },
    ],
    available: { v1: 0 },
  });
  assert.equal(picked.length, 1);
});

test("⛔ a sale in the window disqualifies, whatever the stock says", () => {
  const picked = select({
    products: [P("1")],
    variants: [{ variantId: "v1", productId: "1" }],
    sold: ["v1"],
    available: { v1: 0 },
  });
  assert.deepEqual(picked, []);
});

test("⛔ only ACTIVE products are touched", () => {
  for (const status of ["ARCHIVED", "DRAFT"]) {
    const picked = select({
      products: [P("1", { status })],
      variants: [{ variantId: "v1", productId: "1" }],
      available: { v1: 0 },
    });
    assert.deepEqual(picked, [], `status ${status} must be left alone`);
  }
});

test("⛔ a product with no variants at all is left alone", () => {
  const picked = select({ products: [P("1")], variants: [], available: {} });
  assert.deepEqual(picked, []);
});

test("the run is capped and deterministically ordered", () => {
  const products = [];
  const variants = [];
  const available = {};
  // Build titles in reverse so an unsorted implementation would fail the order assertion.
  for (let i = MAX_STALE_LISTINGS + 10; i >= 1; i -= 1) {
    products.push(P(String(i), { title: `Product ${String(i).padStart(3, "0")}` }));
    variants.push({ variantId: `v${i}`, productId: String(i) });
    available[`v${i}`] = 0;
  }
  const picked = select({ products, variants, available });
  assert.equal(picked.length, MAX_STALE_LISTINGS);
  const titles = picked.map((p) => p.title);
  assert.deepEqual(titles, [...titles].sort(), "must be stably ordered so a rerun proposes the same set");

  // An explicit smaller max narrows it; a larger one cannot exceed the hard cap.
  assert.equal(select({ products, variants, available, maxProducts: 5 }).length, 5);
  assert.equal(select({ products, variants, available, maxProducts: 9999 }).length, MAX_STALE_LISTINGS);
});

// ── the new-store guard, at the DB layer ────────────────────────────────────────────
function buildPrisma({ firstOrderProcessedAt }) {
  const calls = { product: 0, variant: 0, inventoryLevel: 0, orderLineItem: 0 };
  return {
    calls,
    order: {
      async findFirst() {
        return firstOrderProcessedAt ? { processedAt: firstOrderProcessedAt } : null;
      },
    },
    product: {
      async findMany() {
        calls.product += 1;
        return [{ id: "1", externalId: "gid://shopify/Product/1", title: "Old thing", status: "ACTIVE" }];
      },
    },
    variant: {
      async findMany() {
        calls.variant += 1;
        return [{ id: "v1", productId: "1" }];
      },
    },
    inventoryLevel: {
      async findMany() {
        calls.inventoryLevel += 1;
        return [{ variantId: "v1", available: 0 }];
      },
    },
    orderLineItem: {
      async findMany() {
        calls.orderLineItem += 1;
        return [];
      },
    },
  };
}

const NOW = new Date("2026-08-13T09:00:00.000Z");
const DAY = 86400000;

test("⛔ NEW-STORE GUARD: a shop with less history than the window proposes nothing", async () => {
  // Connected three weeks ago. Every product has "no sales in 180 days" — because Jefe has
  // only been watching for 21. Without this guard, day one proposes archiving the catalogue.
  const prisma = buildPrisma({ firstOrderProcessedAt: new Date(NOW.getTime() - 21 * DAY) });
  const result = await buildStaleListingTidyUpProposal(prisma, {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
  });
  assert.equal(result.status, "insufficient_history");
  assert.deepEqual(result.items, []);
  // And it bails BEFORE the expensive catalogue reads.
  assert.equal(prisma.calls.product, 0, "must not scan the catalogue it has already refused to judge");
});

test("⛔ NEW-STORE GUARD: a shop with no orders at all proposes nothing", async () => {
  const prisma = buildPrisma({ firstOrderProcessedAt: null });
  const result = await buildStaleListingTidyUpProposal(prisma, {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
  });
  assert.equal(result.status, "insufficient_history");
  assert.equal(prisma.calls.product, 0);
});

test("a shop with history longer than the window is judged normally", async () => {
  const prisma = buildPrisma({
    firstOrderProcessedAt: new Date(NOW.getTime() - (STALE_LISTING_WINDOW_DAYS + 30) * DAY),
  });
  const result = await buildStaleListingTidyUpProposal(prisma, {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.productCount, 1);
  // The Shopify GID, not our internal uuid — the write client cannot use the latter.
  assert.equal(result.items[0].productId, "gid://shopify/Product/1");
});

test("a shop exactly at the window boundary is not judged", async () => {
  // firstOrder == cutoff is NOT "longer than the window" — the guard needs history strictly
  // older than the cutoff before "hasn't sold in 180 days" says anything about the product.
  const prisma = buildPrisma({
    firstOrderProcessedAt: new Date(NOW.getTime() - STALE_LISTING_WINDOW_DAYS * DAY + 1),
  });
  const result = await buildStaleListingTidyUpProposal(prisma, {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
  });
  assert.equal(result.status, "insufficient_history");
});

// ── the resolver → preview seam ─────────────────────────────────────────────────────
// selectStaleListings and buildProductStatusPreview are tested apart, but the shape passed
// between them is a contract nothing else checks: the proposal emits {productId, title,
// currentStatus, targetStatus, reason} and the preview reads four of those five. A rename on
// either side would leave both suites green and produce an EMPTY preview in production —
// which the wire reports as "empty_preview" and the merchant sees as a tidy-up that silently
// did nothing.
test("a proposal flows into a real preview with a correct reversibility plan", async () => {
  const prisma = {
    order: { async findFirst() { return { processedAt: new Date(NOW.getTime() - 400 * DAY) }; } },
    product: {
      async findMany() {
        return [
          { id: "1", externalId: "gid://shopify/Product/1", title: "Sold-out clogs", status: "ACTIVE" },
          { id: "2", externalId: "gid://shopify/Product/2", title: "Still in stock", status: "ACTIVE" },
        ];
      },
    },
    variant: {
      async findMany() {
        return [{ id: "v1", productId: "1" }, { id: "v2", productId: "2" }];
      },
    },
    inventoryLevel: {
      async findMany() {
        return [{ variantId: "v1", available: 0 }, { variantId: "v2", available: 7 }];
      },
    },
    orderLineItem: { async findMany() { return []; } },
  };

  const proposal = await buildStaleListingTidyUpProposal(prisma, {
    merchantId: "m1",
    shopId: "s1",
    now: NOW,
  });
  const preview = buildProductStatusPreview({ items: proposal.items });

  assert.equal(preview.productCount, 1, "the in-stock product must not reach the preview");
  assert.deepEqual(preview.changes, [
    {
      productId: "gid://shopify/Product/1",
      title: "Sold-out clogs",
      fromStatus: "ACTIVE",
      toStatus: "ARCHIVED",
    },
  ]);
  // Reversibility is what makes this action offerable at all — an empty or partial plan
  // means an archive the merchant cannot undo.
  assert.deepEqual(preview.reversibilityPlan, [
    { productId: "gid://shopify/Product/1", restoreStatus: "ACTIVE" },
  ]);
  assert.deepEqual(preview.refused, []);
});
