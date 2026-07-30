import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  ingestMerchantCostRows,
  parseCostSheet,
} from "../app/lib/ingestion/merchant-cost-sheet.server.js";

const databaseUrl = process.env.DATABASE_URL;

function uniqueSuffix() {
  return `cost-${process.hrtime.bigint()}`;
}

test("parseCostSheet detects columns and parses costs deterministically", () => {
  const parsed = parseCostSheet([
    { SKU: "ALPHA-1", "Cost per item": "£12.50", Title: "Alpha" },
    { SKU: "BETA-2", "Cost per item": "8", Title: "Beta" },
    { SKU: "GAMMA-3", "Cost per item": "1,250.00", Title: "Gamma" },
  ]);
  assert.equal(parsed.confident, true);
  assert.equal(parsed.skuColumn, "SKU");
  assert.equal(parsed.costColumn, "Cost per item");
  assert.deepEqual(parsed.entries, [
    { sku: "ALPHA-1", cost: 12.5 },
    { sku: "BETA-2", cost: 8 },
    { sku: "GAMMA-3", cost: 1250 },
  ]);
  assert.equal(parsed.invalidRows, 0);
});

test("parseCostSheet handles alternate headers, dedupes and skips invalid rows", () => {
  const parsed = parseCostSheet([
    { "Variant SKU": "A", COGS: "5.00" },
    { "Variant SKU": "", COGS: "5.00" }, // no sku -> invalid
    { "Variant SKU": "B", COGS: "n/a" }, // unparseable cost -> invalid
    { "Variant SKU": "A", COGS: "9.00" }, // duplicate sku -> first wins
  ]);
  assert.equal(parsed.skuColumn, "Variant SKU");
  assert.equal(parsed.costColumn, "COGS");
  assert.deepEqual(parsed.entries, [{ sku: "A", cost: 5 }]);
  assert.equal(parsed.invalidRows, 2);
});

test("parseCostSheet prefers the specific cost column over a generic one", () => {
  const parsed = parseCostSheet([
    { sku: "A", "Retail cost": "20", "Cost per item": "7" },
  ]);
  assert.equal(parsed.costColumn, "Cost per item");
  assert.deepEqual(parsed.entries, [{ sku: "A", cost: 7 }]);
});

test("parseCostSheet parses European decimal-comma formats without mis-scaling Anglo ones", () => {
  const parsed = parseCostSheet([
    { sku: "EU1", cost: "1.234,56" }, // European: dot=thousands, comma=decimal
    { sku: "EU2", cost: "12,50" }, // European decimal comma
    { sku: "EU3", cost: "€2,05" }, // currency symbol + decimal comma
    { sku: "UK1", cost: "1,250.00" }, // Anglo: comma=thousands, dot=decimal
    { sku: "UK2", cost: "1,250" }, // Anglo thousands, no decimal
    { sku: "PLAIN", cost: "8" },
  ]);
  assert.deepEqual(parsed.entries, [
    { sku: "EU1", cost: 1234.56 },
    { sku: "EU2", cost: 12.5 },
    { sku: "EU3", cost: 2.05 },
    { sku: "UK1", cost: 1250 },
    { sku: "UK2", cost: 1250 },
    { sku: "PLAIN", cost: 8 },
  ]);
});

test("parseCostSheet is not confident when a required column is missing", () => {
  const noCost = parseCostSheet([{ SKU: "A", Price: "20" }]);
  assert.equal(noCost.confident, false);
  assert.equal(noCost.reason, "no_cost_column");

  const empty = parseCostSheet([]);
  assert.equal(empty.confident, false);
  assert.equal(empty.reason, "empty_sheet");
});

test("ingestMerchantCostRows gap-fills matched variants without overwriting existing costs", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for cost-sheet ingestion tests");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Cost Sheet Merchant ${suffix}`,
        shops: {
          create: {
            shopDomain: `cost-${suffix}.myshopify.com`,
            rawPayload: {},
          },
        },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];
    await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `product-${suffix}`,
        title: "Cost Product",
        status: "ACTIVE",
        variants: {
          create: [
            {
              merchantId: merchant.id,
              shopId: shop.id,
              externalId: `var-a-${suffix}`,
              sku: "ALPHA-1",
              title: "A",
              price: "20.00",
            },
            {
              merchantId: merchant.id,
              shopId: shop.id,
              externalId: `var-b-${suffix}`,
              sku: "BETA-2",
              title: "B",
              price: "40.00",
              unitCost: "18.00", // already has a cost
            },
          ],
        },
      },
    });

    const result = await ingestMerchantCostRows(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: [
        { SKU: "ALPHA-1", "Cost per item": "£7.50" }, // gap-fill
        { SKU: "BETA-2", "Cost per item": "9.00" }, // already costed -> skip
        { SKU: "NOPE-9", "Cost per item": "3.00" }, // no such variant -> unmatched
      ],
    });

    assert.equal(result.status, "applied");
    assert.equal(result.matched, 2);
    assert.equal(result.filled, 1);
    assert.equal(result.skippedExisting, 1);
    assert.deepEqual(result.unmatchedSkus, ["NOPE-9"]);

    const alpha = await prisma.variant.findFirstOrThrow({
      where: { shopId: shop.id, sku: "ALPHA-1" },
    });
    const beta = await prisma.variant.findFirstOrThrow({
      where: { shopId: shop.id, sku: "BETA-2" },
    });
    assert.equal(Number(alpha.unitCost), 7.5); // gap-filled from the sheet
    assert.equal(Number(beta.unitCost), 18); // existing Shopify cost untouched
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Cost Sheet Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});
