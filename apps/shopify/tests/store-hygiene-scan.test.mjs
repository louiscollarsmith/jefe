import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  buildStoreHygieneFindings,
  detectMissingDescriptions,
  detectMissingCosts,
  detectMissingProductType,
  detectMissingSkus,
  detectRefundCluster,
  extractOrderRefunds,
  descriptionFromProductPayload,
  nameList,
  isSellableStatus,
  getStoreHygieneFindings,
  MAX_HYGIENE_FINDINGS,
} from "../app/lib/store-hygiene/store-hygiene-scan.server.js";
import { buildAdminDeepLinker } from "../app/lib/shopify/admin-deep-link.server.js";

const databaseUrl = process.env.DATABASE_URL;
const LINKS = buildAdminDeepLinker("everdew.myshopify.com");
const gid = (n) => `gid://shopify/Product/${n}`;

function uniqueSuffix() {
  return `hyg-${process.hrtime.bigint()}`;
}

/** Build the sellable set + product index a detector expects from a product list. */
function index(products) {
  return {
    sellable: new Set(products.filter((p) => isSellableStatus(p.status)).map((p) => p.externalId)),
    productsByExternalId: new Map(products.map((p) => [p.externalId, p])),
  };
}

// (Deep-link URL construction is covered in tests/admin-deep-link.test.mjs — the canonical helper.)

// ── text helpers ─────────────────────────────────────────────────────────────────
test("nameList reads naturally and collapses the tail", () => {
  assert.equal(nameList(["Alpha"]), "Alpha");
  assert.equal(nameList(["Alpha", "Beta"]), "Alpha and Beta");
  assert.equal(nameList(["Alpha", "Beta", "Gamma"]), "Alpha, Beta and Gamma");
  assert.equal(nameList(["A", "B", "C", "D"]), "A, B, C and 1 other");
  assert.equal(nameList(["A", "B", "C", "D", "E"]), "A, B, C and 2 others");
  assert.equal(nameList([""]), "Untitled");
});

test("isSellableStatus: active/unknown sellable, draft/archived not", () => {
  assert.equal(isSellableStatus("ACTIVE"), true);
  assert.equal(isSellableStatus("active"), true);
  assert.equal(isSellableStatus(null), true);
  assert.equal(isSellableStatus(""), true);
  assert.equal(isSellableStatus("DRAFT"), false);
  assert.equal(isSellableStatus("ARCHIVED"), false);
});

// ── description parsing + the "known vs not-yet-synced" gate ─────────────────────────
test("descriptionFromProductPayload distinguishes empty from not-synced", () => {
  assert.equal(descriptionFromProductPayload({ descriptionHtml: "<p>Hi</p>" }), "<p>Hi</p>");
  assert.equal(descriptionFromProductPayload({ descriptionHtml: "" }), "");
  assert.equal(descriptionFromProductPayload({ descriptionHtml: null }), "");
  assert.equal(descriptionFromProductPayload({ bodyHtml: "legacy" }), "legacy");
  assert.equal(descriptionFromProductPayload({}), undefined); // never synced → unknown
  assert.equal(descriptionFromProductPayload(null), undefined);
});

test("detectMissingDescriptions skips not-synced (undefined), flags empty/blank-HTML, ignores archived", () => {
  const products = [
    { id: "1", externalId: gid(1), title: "Synced OK", status: "ACTIVE", description: "<p>Lovely oil</p>" },
    { id: "2", externalId: gid(2), title: "Never synced", status: "ACTIVE", description: undefined },
    { id: "3", externalId: gid(3), title: "Empty", status: "ACTIVE", description: "" },
    { id: "4", externalId: gid(4), title: "Blank HTML", status: "ACTIVE", description: "<p>&nbsp;</p>" },
    { id: "5", externalId: gid(5), title: "Archived empty", status: "ARCHIVED", description: "" },
  ];
  const finding = detectMissingDescriptions({ ...index(products), products, links: LINKS });
  assert.ok(finding);
  assert.equal(finding.id, "hygiene:missing-description");
  assert.equal(finding.title, "2 products have no description");
  assert.match(finding.body, /Empty/);
  assert.match(finding.body, /Blank HTML/);
  assert.doesNotMatch(finding.body, /Never synced/); // not-synced never mislabelled as missing
  assert.doesNotMatch(finding.body, /Archived/);
  // Multi-product → links to the products index, opened top-level.
  assert.equal(finding.primary.href, "https://admin.shopify.com/store/everdew/products");
  assert.equal(finding.primary.external, true);
  assert.equal(finding.dismiss, "Not now");
});

test("detectMissingDescriptions returns null when every description is known-and-present or unknown", () => {
  const products = [
    { id: "1", externalId: gid(1), title: "OK", status: "ACTIVE", description: "<p>words</p>" },
    { id: "2", externalId: gid(2), title: "Not synced", status: "ACTIVE", description: undefined },
  ];
  assert.equal(detectMissingDescriptions({ ...index(products), products, links: LINKS }), null);
});

// ── missing cost ─────────────────────────────────────────────────────────────────
test("detectMissingCosts flags null cost only, links straight to a single product", () => {
  const products = [{ id: "p", externalId: gid(7), title: "Repair Balm", status: "ACTIVE" }];
  const variants = [
    { id: "v1", externalId: "v-1", productExternalId: gid(7), sku: "A", unitCost: null },
    { id: "v2", externalId: "v-2", productExternalId: gid(7), sku: "B", unitCost: 0 }, // set to 0 = merchant's call, not missing
  ];
  const finding = detectMissingCosts({ ...index(products), variants, links: LINKS });
  assert.ok(finding);
  assert.equal(finding.id, "hygiene:missing-cost");
  assert.equal(finding.title, "Jefe can't see cost on 1 product");
  assert.equal(finding.primary.label, "Add the cost");
  assert.equal(finding.primary.href, "https://admin.shopify.com/store/everdew/products/7");
});

test("detectMissingCosts ignores variants of non-sellable products", () => {
  const products = [{ id: "p", externalId: gid(8), title: "Draft", status: "DRAFT" }];
  const variants = [{ id: "v", externalId: "v", productExternalId: gid(8), sku: "A", unitCost: null }];
  assert.equal(detectMissingCosts({ ...index(products), variants, links: LINKS }), null);
});

// ── missing product type + SKU ──────────────────────────────────────────────────────
test("detectMissingProductType flags blank type on sellable products", () => {
  const products = [
    { id: "1", externalId: gid(1), title: "Untyped", status: "ACTIVE", productType: "" },
    { id: "2", externalId: gid(2), title: "Typed", status: "ACTIVE", productType: "Skincare" },
  ];
  const finding = detectMissingProductType({ ...index(products), products, links: LINKS });
  assert.ok(finding);
  assert.equal(finding.title, "1 product has no product type");
  assert.equal(finding.primary.href, "https://admin.shopify.com/store/everdew/products/1");
});

test("detectMissingSkus counts variants and names their products", () => {
  const products = [{ id: "p", externalId: gid(9), title: "Bundle", status: "ACTIVE" }];
  const variants = [
    { id: "v1", externalId: "v1", productExternalId: gid(9), sku: "", unitCost: 5 },
    { id: "v2", externalId: "v2", productExternalId: gid(9), sku: null, unitCost: 5 },
    { id: "v3", externalId: "v3", productExternalId: gid(9), sku: "HAS-SKU", unitCost: 5 },
  ];
  const finding = detectMissingSkus({ ...index(products), variants, links: LINKS });
  assert.ok(finding);
  assert.equal(finding.title, "2 variants have no SKU");
  assert.match(finding.body, /Bundle/);
});

// ── refund cluster ─────────────────────────────────────────────────────────────────
function refundLine(refundId, productExternalId, amount) {
  return { refundId, productExternalId, refundedAmount: amount, refundedQuantity: 1 };
}

test("detectRefundCluster flags a dominant product with an honest 'N of M' body", () => {
  const products = [
    { id: "p1", externalId: gid(1), title: "Repair Balm 50ml", status: "ACTIVE" },
    { id: "p2", externalId: gid(2), title: "Other", status: "ACTIVE" },
  ];
  const refundLines = [
    refundLine("r1", gid(1), 20),
    refundLine("r2", gid(1), 20),
    refundLine("r3", gid(1), 20),
    refundLine("r4", gid(2), 20),
  ];
  const finding = detectRefundCluster({
    refundLines,
    refundCount: 5, // 5 refunds total; one had no attributable lines → honest denominator
    orderCount: 55,
    productsByExternalId: index(products).productsByExternalId,
    windowDays: 30,
    links: LINKS,
  });
  assert.ok(finding);
  assert.equal(finding.id, "hygiene:refund-cluster");
  assert.equal(finding.kind, "pattern");
  assert.match(finding.body, /3 of 5 refunds were Repair Balm 50ml/);
  assert.match(finding.body, /9%/); // 5/55 ≈ 9%
  assert.equal(finding.primary.label, "Review Repair Balm 50ml");
  assert.equal(finding.primary.href, "https://admin.shopify.com/store/everdew/products/1");
});

test("detectRefundCluster attributes each refund to its largest-amount line", () => {
  const products = [
    { id: "p1", externalId: gid(1), title: "Big", status: "ACTIVE" },
    { id: "p2", externalId: gid(2), title: "Small", status: "ACTIVE" },
  ];
  // Two refunds, each touching both products; the bigger amount wins each refund → P1 leads 2–0.
  const refundLines = [
    refundLine("r1", gid(1), 30),
    refundLine("r1", gid(2), 5),
    refundLine("r2", gid(1), 40),
    refundLine("r2", gid(2), 5),
    refundLine("r3", gid(2), 50),
  ];
  const finding = detectRefundCluster({
    refundLines,
    refundCount: 3,
    productsByExternalId: index(products).productsByExternalId,
    windowDays: 30,
    links: LINKS,
  });
  assert.ok(finding);
  assert.match(finding.body, /2 of 3 refunds were Big/);
});

test("detectRefundCluster stays quiet below thresholds", () => {
  const products = [{ id: "p1", externalId: gid(1), title: "X", status: "ACTIVE" }];
  const pbe = index(products).productsByExternalId;
  // Too few refunds overall.
  assert.equal(
    detectRefundCluster({ refundLines: [refundLine("r1", gid(1), 10), refundLine("r2", gid(1), 10)], refundCount: 2, productsByExternalId: pbe, windowDays: 30, links: LINKS }),
    null,
  );
  // Enough refunds, but no product dominates (spread across many).
  const spread = [
    refundLine("r1", gid(1), 10),
    refundLine("r2", "gid://shopify/Product/2", 10),
    refundLine("r3", "gid://shopify/Product/3", 10),
    refundLine("r4", "gid://shopify/Product/4", 10),
  ];
  assert.equal(
    detectRefundCluster({ refundLines: spread, refundCount: 4, productsByExternalId: pbe, windowDays: 30, links: LINKS }),
    null,
  );
});

// ── rawPayload refund parsing ───────────────────────────────────────────────────────
test("extractOrderRefunds parses in-window refunds with per-product lines", () => {
  const now = Date.parse("2026-07-31T00:00:00Z");
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const order = {
    refunds: [
      {
        id: "gid://shopify/Refund/1",
        createdAt: "2026-07-20T10:00:00Z", // in window
        refundLineItems: {
          edges: [
            { node: { quantity: 1, subtotalSet: { shopMoney: { amount: "12.50" } }, lineItem: { product: { id: gid(1) } } } },
          ],
        },
      },
      {
        id: "gid://shopify/Refund/2",
        createdAt: "2026-05-01T10:00:00Z", // out of window → dropped
        refundLineItems: { edges: [{ node: { quantity: 1, subtotalSet: { shopMoney: { amount: "9.99" } }, lineItem: { product: { id: gid(2) } } } }] },
      },
    ],
  };
  const parsed = extractOrderRefunds(order, cutoff);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].refundId, "gid://shopify/Refund/1");
  assert.equal(parsed[0].lines.length, 1);
  assert.equal(parsed[0].lines[0].productExternalId, gid(1));
  assert.equal(parsed[0].lines[0].refundedAmount, 12.5);
});

test("extractOrderRefunds is defensive about missing/odd shapes", () => {
  assert.deepEqual(extractOrderRefunds(null, 0), []);
  assert.deepEqual(extractOrderRefunds({ refunds: "nope" }, 0), []);
  // A refund with no line items still counts as a refund (empty lines), keeping the denominator honest.
  const parsed = extractOrderRefunds({ refunds: [{ id: "r", createdAt: "2026-07-20T00:00:00Z" }] }, 0);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].lines, []);
});

// ── aggregator: ordering + cap ──────────────────────────────────────────────────────
test("buildStoreHygieneFindings orders by value and caps the count", () => {
  const products = [
    { id: "1", externalId: gid(1), title: "Alpha", status: "ACTIVE", productType: "Type", description: "<p>ok</p>" }, // refund cluster host
    { id: "2", externalId: gid(2), title: "Beta", status: "ACTIVE", productType: "Type", description: "" }, // missing description
    { id: "3", externalId: gid(3), title: "Gamma", status: "ACTIVE", productType: "", description: "<p>ok</p>" }, // missing type
    { id: "4", externalId: gid(4), title: "Delta", status: "ACTIVE", productType: "Type", description: "<p>ok</p>" }, // missing cost host
    { id: "5", externalId: gid(5), title: "Epsilon", status: "ACTIVE", productType: "Type", description: "<p>ok</p>" }, // missing sku host
  ];
  const variants = [
    { id: "v4", externalId: "v4", productExternalId: gid(4), sku: "S4", unitCost: null }, // missing cost
    { id: "v5", externalId: "v5", productExternalId: gid(5), sku: "", unitCost: 5 }, // missing sku
  ];
  const refundLines = [
    refundLine("r1", gid(1), 10),
    refundLine("r2", gid(1), 10),
    refundLine("r3", gid(1), 10),
    refundLine("r4", gid(2), 10),
  ];
  const findings = buildStoreHygieneFindings({
    products,
    variants,
    refundLines,
    refundCount: 4,
    orderCount: 40,
    links: LINKS,
  });
  // Five detectors fire; the cap keeps the top MAX and drops the least-urgent (SKU).
  assert.equal(findings.length, MAX_HYGIENE_FINDINGS);
  assert.equal(findings[0].id, "hygiene:refund-cluster"); // most valuable first
  const ids = findings.map((f) => f.id);
  assert.ok(ids.includes("hygiene:missing-cost"));
  assert.ok(ids.includes("hygiene:missing-description"));
  assert.ok(ids.includes("hygiene:missing-product-type"));
  assert.ok(!ids.includes("hygiene:missing-sku")); // dropped by the cap
});

test("buildStoreHygieneFindings returns [] for a clean/empty store", () => {
  assert.deepEqual(
    buildStoreHygieneFindings({ products: [], variants: [], refundLines: [], refundCount: 0, links: LINKS }),
    [],
  );
});

// ── DB layer (skips without a database) ─────────────────────────────────────────────
test("getStoreHygieneFindings reads real rows and surfaces gaps", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the store-hygiene DB test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Hygiene ${suffix}`,
        shops: { create: { shopDomain: `${suffix}.myshopify.com`, rawPayload: {} } },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];
    // One active product with no product type + a variant with no cost.
    await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `gid://shopify/Product/${suffix}`,
        title: "Untyped Balm",
        status: "ACTIVE",
        productType: null,
        rawPayload: { descriptionHtml: "<p>Has copy</p>" }, // description present → not flagged
        variants: {
          create: [
            { merchantId: merchant.id, shopId: shop.id, externalId: `var-${suffix}`, sku: "BALM", price: "20.00" }, // unitCost null
          ],
        },
      },
    });

    const findings = await getStoreHygieneFindings(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: `${suffix}.myshopify.com`,
    });
    const ids = findings.map((f) => f.id);
    assert.ok(ids.includes("hygiene:missing-cost"), "expected a missing-cost finding");
    assert.ok(ids.includes("hygiene:missing-product-type"), "expected a missing-product-type finding");
    assert.ok(!ids.includes("hygiene:missing-description"), "description present → no description finding");
    // Deep-link points at the real store handle.
    const cost = findings.find((f) => f.id === "hygiene:missing-cost");
    assert.match(cost.primary.href, new RegExp(`admin\\.shopify\\.com/store/${suffix}/products/`));
  } finally {
    await prisma.merchant.deleteMany({ where: { name: `Hygiene ${suffix}` } });
    await prisma.$disconnect();
  }
});
