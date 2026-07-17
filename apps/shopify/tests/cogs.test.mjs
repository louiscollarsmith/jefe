import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  applyCostToProductVariants,
  applyRetailPercentageRule,
  getCogsCoverage,
  getPrioritizedMissingCosts,
  saveManualCosts,
  upsertVariantCost,
} from "../app/services/cogs.server.js";

const databaseUrl = process.env.DATABASE_URL;

test("COGS coverage uses sold revenue and prioritises missing costs by impact", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for COGS tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop, products, variants } = await createCogsTenant(
      prisma,
      suffix,
    );

    await upsertVariantCost(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      productId: products[0].id,
      variantId: variants[0].id,
      inventoryItemExternalId: variants[0].inventoryItemExternalId,
      sku: variants[0].sku,
      costAmount: "20.00",
      currency: "GBP",
      source: "shopify_unit_cost",
      confidenceLevel: "confirmed",
    });
    await createOrder(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      suffix,
      lines: [
        {
          productId: products[0].id,
          variantId: variants[0].id,
          sku: variants[0].sku,
          title: products[0].title,
          quantity: 8,
          unitPrice: "100.00",
          totalPrice: "800.00",
        },
        {
          productId: products[1].id,
          variantId: variants[1].id,
          sku: variants[1].sku,
          title: products[1].title,
          quantity: 2,
          unitPrice: "100.00",
          totalPrice: "200.00",
        },
      ],
    });

    const coverage = await getCogsCoverage(prisma, shop.id);
    assert.equal(coverage.soldRevenueTotal, 1000);
    assert.equal(coverage.soldRevenueConfirmedCost, 800);
    assert.equal(coverage.usableRevenueCoveragePercent, 80);
    assert.equal(coverage.marginConfidence, "high");

    const missing = await getPrioritizedMissingCosts(prisma, {
      shopId: shop.id,
      limit: 10,
    });
    assert.equal(missing[0].variantId, variants[1].id);
    assert.equal(missing[0].soldRevenue, 200);

    await saveManualCosts(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: [
        {
          variantId: variants[1].id,
          productId: products[1].id,
          sku: variants[1].sku,
          costAmount: "30.00",
        },
      ],
    });
    const afterManual = await getCogsCoverage(prisma, shop.id);
    assert.equal(afterManual.usableRevenueCoveragePercent, 100);
    assert.equal(afterManual.variantsWithConfirmedCost, 2);

    const productApply = await applyCostToProductVariants(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      productId: products[2].id,
      costAmount: "9.50",
    });
    assert.equal(productApply.updated, 2);

    const rule = await applyRetailPercentageRule(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      variantIds: [variants[3].id],
      percent: "35",
    });
    assert.equal(rule.updated, 1);
    const ruleCost = await prisma.cogsInput.findFirstOrThrow({
      where: { shopId: shop.id, variantId: variants[3].id, effectiveTo: null },
    });
    assert.equal(ruleCost.source, "merchant_rule");
    assert.equal(ruleCost.confidenceLevel, "merchant_rule");
    assert.equal(Number(ruleCost.costAmount), 35);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `COGS Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

async function createCogsTenant(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `COGS Test Merchant ${suffix}`,
      primaryCurrency: "GBP",
      shops: {
        create: {
          shopDomain: `cogs-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const products = [];
  const variants = [];

  for (const [index, title] of ["Covered Product", "Missing Product", "Bulk Product"].entries()) {
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `product-${index}-${suffix}`,
        title,
        rawPayload: { source: "test" },
        variants: {
          create: index === 2
            ? [
                variantCreate(merchant.id, shop.id, suffix, index, 0),
                variantCreate(merchant.id, shop.id, suffix, index, 1),
              ]
            : variantCreate(merchant.id, shop.id, suffix, index, 0),
        },
      },
      include: { variants: true },
    });
    products.push(product);
    variants.push(...product.variants);
  }

  return { merchant, shop, products, variants };
}

function variantCreate(merchantId, shopId, suffix, productIndex, variantIndex) {
  return {
    merchantId,
    shopId,
    externalId: `variant-${productIndex}-${variantIndex}-${suffix}`,
    sku: `SKU-${productIndex}-${variantIndex}-${suffix}`,
    title: `Variant ${variantIndex + 1}`,
    price: "100.00",
    currency: "GBP",
    inventoryItemExternalId: `gid://shopify/InventoryItem/inv-${productIndex}-${variantIndex}-${suffix}`,
    rawPayload: { source: "test" },
  };
}

async function createOrder(prisma, input) {
  return prisma.order.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      externalId: `order-${input.suffix}`,
      orderName: "#COGS",
      currency: "GBP",
      totalPrice: "1000.00",
      processedAt: new Date("2026-07-15T10:00:00Z"),
      lineItems: {
        create: input.lines.map((line, index) => ({
          merchantId: input.merchantId,
          shopId: input.shopId,
          externalId: `line-${index}-${input.suffix}`,
          ...line,
        })),
      },
    },
  });
}
