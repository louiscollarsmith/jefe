import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  assignInventoryRiskLevel,
  calculateDaysUntilStockout,
  calculateInventoryGuardianRecord,
  generateInventoryGuardian,
  INVENTORY_GUARDIAN_ACTION_TYPE,
} from "../app/services/inventory-guardian.server.js";

const databaseUrl = process.env.DATABASE_URL;
const now = new Date("2026-07-14T12:00:00Z");

test("Inventory Guardian calculates velocity, stockout timing, risk and money at risk", () => {
  const record = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-1", title: "Black Hoodie" },
    variant: {
      id: "variant-1",
      sku: "HOODIE-M",
      title: "Medium",
      price: "60.00",
      currency: "60.00",
      inventoryItemExternalId: "inventory-item-1",
    },
    inventoryLevels: [
      {
        id: "inventory-level-1",
        inventoryItemExternalId: "inventory-item-1",
        locationExternalId: "location-1",
        available: 12,
        observedAt: new Date("2026-07-14T10:00:00Z"),
      },
    ],
    lineItems: [
      lineItem({
        id: "line-1",
        quantity: 30,
        unitPrice: "60.00",
        totalPrice: "1800.00",
        processedAt: "2026-07-13T10:00:00Z",
      }),
      lineItem({
        id: "line-2",
        quantity: 5,
        unitPrice: "60.00",
        totalPrice: "300.00",
        processedAt: "2026-06-25T10:00:00Z",
      }),
    ],
    cogsInput: { id: "cogs-1", costAmount: "20.00" },
    now,
  });

  assert.equal(record.unitsSold7d, 30);
  assert.equal(record.unitsSold14d, 30);
  assert.equal(record.unitsSold30d, 35);
  assert.equal(record.averageUnitsSoldPerDay, 2.1429);
  assert.equal(record.daysUntilStockout, 5.6);
  assert.equal(record.riskLevel, "critical");
  assert.equal(record.revenueAtRisk, 1080);
  assert.equal(record.grossProfitAtRisk, 720);
  assert.equal(record.suggestedReorderQuantity, 53);
  assert.equal(record.confidence, "high");
  assert.equal(record.currency, "GBP");
  assert.equal(record.verificationClass, "estimated");
  assert.equal(record.evidence.formulaVersion, "inventory_guardian_v0");
  assert.deepEqual(record.evidence.orderLineItemIds, ["line-1", "line-2"]);
});

test("Inventory Guardian handles out-of-stock, missing COGS, no sales and healthy inventory", () => {
  const outOfStock = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-2", title: "Red Sneakers" },
    variant: {
      id: "variant-2",
      sku: "SHOE-9",
      title: "UK 9",
      price: "80.00",
      currency: "80.00",
    },
    inventoryLevels: [{ available: 0, locationExternalId: "location-1" }],
    lineItems: [
      lineItem({
        quantity: 6,
        unitPrice: "80.00",
        totalPrice: "480.00",
        processedAt: "2026-07-10T10:00:00Z",
      }),
    ],
    cogsInput: { id: "cogs-2", costAmount: "35.00" },
    now,
  });
  assert.equal(outOfStock.riskLevel, "out_of_stock");
  assert.equal(outOfStock.statusReason, "active_stockout_risk");
  assert.equal(outOfStock.daysUntilStockout, 0);
  assert.equal(outOfStock.revenueAtRisk, 480);
  assert.equal(outOfStock.currency, "GBP");

  const outOfStockNoRecentDemand = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-2b", title: "Hidden Gift Card" },
    variant: {
      id: "variant-2b",
      sku: "GIFT-HIDDEN",
      title: "Hidden",
      price: "25.00",
      currency: "25.00",
    },
    inventoryLevels: [{ available: 0, locationExternalId: "location-1" }],
    lineItems: [],
    cogsInput: { id: "cogs-2b", costAmount: "15.00" },
    now,
  });
  assert.equal(outOfStockNoRecentDemand.riskLevel, "out_of_stock");
  assert.equal(
    outOfStockNoRecentDemand.statusReason,
    "out_of_stock_no_recent_demand",
  );
  assert.equal(outOfStockNoRecentDemand.unitsSold7d, 0);
  assert.equal(outOfStockNoRecentDemand.unitsSold14d, 0);
  assert.equal(outOfStockNoRecentDemand.unitsSold30d, 0);
  assert.equal(outOfStockNoRecentDemand.revenueAtRisk, 0);
  assert.equal(outOfStockNoRecentDemand.grossProfitAtRisk, 0);
  assert.equal(outOfStockNoRecentDemand.suggestedReorderQuantity, null);
  assert.match(
    outOfStockNoRecentDemand.evidence.limitations.join(" "),
    /No recent demand detected/,
  );

  const missingCogs = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-3", title: "Hero Hydration Pack" },
    variant: { id: "variant-3", sku: "HERO-SAND", title: "Sand", price: "64.00" },
    inventoryLevels: [{ available: 3, locationExternalId: "location-1" }],
    lineItems: [
      lineItem({
        quantity: 10,
        unitPrice: "64.00",
        totalPrice: "640.00",
        processedAt: "2026-07-13T10:00:00Z",
      }),
    ],
    cogsInput: null,
    now,
  });
  assert.equal(missingCogs.riskLevel, "critical");
  assert.equal(missingCogs.grossProfitAtRisk, null);
  assert.equal(missingCogs.confidence, "medium");
  assert.match(missingCogs.evidence.limitations.join(" "), /COGS is missing/);

  const noSales = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-4", title: "Green Cap" },
    variant: {
      id: "variant-4",
      sku: "CAP",
      title: "One Size",
      price: "22.00",
      currency: "22.00",
    },
    inventoryLevels: [{ available: 214, locationExternalId: "location-1" }],
    lineItems: [],
    cogsInput: { id: "cogs-4", costAmount: "5.00" },
    now,
  });
  assert.equal(noSales.riskLevel, "not_selling");
  assert.equal(noSales.daysUntilStockout, null);
  assert.equal(noSales.suggestedReorderQuantity, null);
  assert.equal(noSales.confidence, "low");
  assert.equal(noSales.currency, "GBP");

  const healthy = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-5", title: "Luxe Candle" },
    variant: { id: "variant-5", sku: "CANDLE-FIG", title: "Fig", price: "34.00" },
    inventoryLevels: [{ available: 120, locationExternalId: "location-1" }],
    lineItems: [
      lineItem({
        quantity: 8,
        unitPrice: "34.00",
        totalPrice: "272.00",
        processedAt: "2026-07-11T10:00:00Z",
      }),
    ],
    cogsInput: { id: "cogs-5", costAmount: "12.00" },
    now,
  });
  assert.equal(healthy.riskLevel, "healthy");
  assert.equal(healthy.revenueAtRisk, 0);
  assert.equal(healthy.suggestedReorderQuantity, 0);
});

test("Inventory Guardian handles missing inventory without inventing stockout risk", () => {
  const record = calculateInventoryGuardianRecord({
    merchantId: "merchant-1",
    shopId: "shop-1",
    product: { id: "product-6", title: "Missing Inventory Product" },
    variant: { id: "variant-6", sku: "MISS-INV", title: "Default", price: "40.00" },
    inventoryLevels: [],
    lineItems: [
      lineItem({
        quantity: 4,
        unitPrice: "40.00",
        totalPrice: "160.00",
        processedAt: "2026-07-12T10:00:00Z",
      }),
    ],
    cogsInput: { id: "cogs-6", costAmount: "10.00" },
    now,
  });

  assert.equal(record.currentInventory, null);
  assert.equal(record.daysUntilStockout, null);
  assert.equal(record.riskLevel, "healthy");
  assert.equal(record.revenueAtRisk, 0);
  assert.equal(record.confidence, "low");
  assert.match(record.evidence.limitations.join(" "), /Inventory is missing/);
});

test("Inventory Guardian assigns risk levels from v0 thresholds", () => {
  assert.equal(
    assignInventoryRiskLevel({
      currentInventory: 0,
      averageUnitsSoldPerDay: 0,
      daysUntilStockout: 0,
    }),
    "out_of_stock",
  );
  assert.equal(calculateDaysUntilStockout(12, 2), 6);
  assert.equal(
    assignInventoryRiskLevel({
      currentInventory: 12,
      averageUnitsSoldPerDay: 2,
      daysUntilStockout: 6,
    }),
    "critical",
  );
  assert.equal(
    assignInventoryRiskLevel({
      currentInventory: 20,
      averageUnitsSoldPerDay: 2,
      daysUntilStockout: 10,
    }),
    "warning",
  );
  assert.equal(
    assignInventoryRiskLevel({
      currentInventory: 40,
      averageUnitsSoldPerDay: 2,
      daysUntilStockout: 20,
    }),
    "watch",
  );
  assert.equal(
    assignInventoryRiskLevel({
      currentInventory: 80,
      averageUnitsSoldPerDay: 2,
      daysUntilStockout: 40,
    }),
    "healthy",
  );
  assert.equal(calculateDaysUntilStockout(80, 0), null);
});

test("Inventory Guardian persists estimated stockout warnings with merchant tenancy", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Inventory Guardian persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const first = await createInventoryGuardianTenant(prisma, suffix, "first");
    const second = await createInventoryGuardianTenant(prisma, suffix, "second");

    await createInventoryScenario(prisma, first, {
      productTitle: "Black Hoodie",
      variantTitle: "Medium",
      sku: `HOODIE-${suffix}`,
      inventory: 2,
      soldUnits: 14,
      unitPrice: "60.00",
      cogs: "20.00",
    });
    await createInventoryScenario(prisma, first, {
      productTitle: "Hidden Gift Card",
      variantTitle: "Hidden",
      sku: `GIFT-${suffix}`,
      inventory: 0,
      soldUnits: 0,
      unitPrice: "25.00",
      cogs: "15.00",
    });
    await createInventoryScenario(prisma, second, {
      productTitle: "Other Store Hoodie",
      variantTitle: "Medium",
      sku: `OTHER-${suffix}`,
      inventory: 1,
      soldUnits: 14,
      unitPrice: "60.00",
      cogs: "20.00",
    });

    const guardian = await generateInventoryGuardian(prisma, {
      merchantId: first.merchant.id,
      shopId: first.shop.id,
      now,
    });

    assert.equal(guardian.hero.atRiskVariantCount, 1);
    assert.equal(guardian.hero.outOfStockNoRecentDemandCount, 1);
    assert.equal(guardian.hero.confidence, "high");
    assert.equal(guardian.metrics.outOfStock, 1);
    assert.equal(guardian.metrics.outOfStockNoRecentDemand, 1);
    assert.equal(guardian.metrics.revenueAtRisk, 720);
    assert.equal(guardian.emptyState, null);
    assert.equal(guardian.persistedActionCount, 2);
    assert.match(guardian.hero.message, /1 variant is likely to stock out/);
    assert.match(
      guardian.hero.message,
      /1 variant is already out of stock with no recent demand/,
    );
    assert.match(guardian.hero.message, /Estimated revenue at risk is £720.00/);

    assert.equal(guardian.riskyRecords[0].sku, `HOODIE-${suffix}`);
    assert.equal(guardian.riskyRecords[0].revenueAtRisk, 720);
    assert.equal(guardian.riskyRecords[1].sku, `GIFT-${suffix}`);
    assert.equal(guardian.riskyRecords[1].revenueAtRisk, 0);

    const noDemandRecord = guardian.riskyRecords.find(
      (record) => record.sku === `GIFT-${suffix}`,
    );
    assert.equal(noDemandRecord.statusReason, "out_of_stock_no_recent_demand");
    assert.equal(noDemandRecord.revenueAtRisk, 0);
    assert.equal(noDemandRecord.suggestedReorderQuantity, null);

    const actions = await prisma.action.findMany({
      where: {
        merchantId: first.merchant.id,
        shopId: first.shop.id,
        actionType: INVENTORY_GUARDIAN_ACTION_TYPE,
      },
      include: { executions: true },
    });

    assert.equal(actions.length, 2);
    const revenueRiskAction = actions.find(
      (action) => action.expectedValue.revenueAtRisk === 720,
    );
    assert.equal(revenueRiskAction.verificationClass, "ESTIMATED");
    assert.equal(revenueRiskAction.riskLevel, "critical");
    assert.equal(revenueRiskAction.expectedValue.verificationClass, "estimated");
    assert.equal(revenueRiskAction.evidence.merchantId, first.merchant.id);
    assert.equal(revenueRiskAction.evidence.shopId, first.shop.id);
    assert.equal(revenueRiskAction.executions.length, 0);

    const otherTenantActions = await prisma.action.count({
      where: {
        merchantId: second.merchant.id,
        actionType: INVENTORY_GUARDIAN_ACTION_TYPE,
      },
    });

    assert.equal(otherTenantActions, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Inventory Guardian Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

function lineItem({
  id = "line",
  quantity,
  unitPrice,
  totalPrice,
  processedAt,
}) {
  return {
    id,
    quantity,
    unitPrice,
    totalPrice,
    order: {
      orderName: `#${id}`,
      externalId: `order-${id}`,
      currency: "GBP",
      processedAt: new Date(processedAt),
    },
  };
}

async function createInventoryGuardianTenant(prisma, suffix, label) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Inventory Guardian Test ${suffix} ${label}`,
      primaryCurrency: "GBP",
      shops: {
        create: {
          shopDomain: `inventory-guardian-${suffix}-${label}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });

  return { merchant, shop: merchant.shops[0] };
}

async function createInventoryScenario(
  prisma,
  { merchant, shop },
  { productTitle, variantTitle, sku, inventory, soldUnits, unitPrice, cogs },
) {
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `product-${sku}`,
      title: productTitle,
      rawPayload: { source: "test" },
      variants: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `variant-${sku}`,
          sku,
          title: variantTitle,
          price: unitPrice,
          inventoryItemExternalId: `inventory-item-${sku}`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0];

  await prisma.inventoryLevel.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      variantId: variant.id,
      inventoryItemExternalId: `inventory-item-${sku}`,
      locationExternalId: `location-${sku}`,
      available: inventory,
      observedAt: new Date("2026-07-14T10:00:00Z"),
      rawPayload: { source: "test" },
    },
  });
  await prisma.cogsInput.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      productId: product.id,
      variantId: variant.id,
      sku,
      costAmount: cogs,
      source: "test",
      confidence: "1.0000",
      confidenceLevel: "confirmed",
      confirmedByMerchant: true,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    },
  });
  if (soldUnits > 0) {
    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-${sku}`,
        orderName: `#${sku}`,
        currency: "GBP",
        totalPrice: String(Number(unitPrice) * soldUnits),
        processedAt: new Date("2026-07-13T10:00:00Z"),
        lineItems: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            productId: product.id,
            variantId: variant.id,
            externalId: `line-${sku}`,
            sku,
            title: productTitle,
            quantity: soldUnits,
            unitPrice,
            totalPrice: String(Number(unitPrice) * soldUnits),
          },
        },
      },
    });
  }
}
