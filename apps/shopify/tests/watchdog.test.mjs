import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  buildWatchdogView,
  generateWatchdog,
  WATCHDOG_ACTION_TYPE,
} from "../app/services/watchdog.server.js";

const databaseUrl = process.env.DATABASE_URL;
const now = new Date("2026-07-14T12:00:00Z");
const currentStart = new Date("2026-07-07T12:00:00Z");
const comparisonStart = new Date("2026-06-07T12:00:00Z");

test("Watchdog v0 detects read-only operational anomalies with estimated prevention labels", () => {
  const data = watchdogFixture();
  const view = buildWatchdogView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    now,
    currentStart,
    comparisonStart,
    ...data,
    currency: "GBP",
  });
  const types = new Set(view.alerts.map((alert) => alert.type));

  assert.equal(view.verificationClass, "estimated");
  assert.equal(view.emptyState, null);
  assert.equal(view.hero.highestSeverity, "critical");
  assert.match(view.hero.message, /estimated prevention alerts, not verified lift/i);
  assert.ok(view.metrics.estimatedValueAtRisk > 0);
  assert.ok(types.has("refund_spike"));
  assert.ok(types.has("sku_sales_collapse"));
  assert.ok(types.has("product_unavailable"));
  assert.ok(types.has("revenue_drop"));
  assert.ok(types.has("unusual_stock_movement"));
  assert.ok(types.has("missing_cogs_important_seller"));
  assert.ok(types.has("high_return_product"));

  const refundSpike = view.alerts.find((alert) => alert.type === "refund_spike");
  assert.equal(refundSpike.verificationClass, "estimated");
  assert.equal(refundSpike.severity, "critical");
  assert.equal(refundSpike.confidence, "high");
  assert.equal(refundSpike.evidence.currentRefundCount, 3);
  assert.equal(refundSpike.evidence.formulaVersion, "watchdog_v0");
  assert.match(refundSpike.suggestedCheck, /Review the refunded orders/);

  const salesCollapse = view.alerts.find(
    (alert) =>
      alert.type === "sku_sales_collapse" && alert.affectedSku === "HOODIE-M",
  );
  assert.equal(salesCollapse.affectedSku, "HOODIE-M");
  assert.equal(salesCollapse.evidence.previous30dUnits, 22);
  assert.equal(salesCollapse.evidence.last7dUnits, 0);
  assert.equal(salesCollapse.evidence.expected7dRevenue, 308);
  assert.equal(salesCollapse.evidence.last7dRevenue, 0);
  assert.ok(salesCollapse.estimatedValueAtRisk > 0);
  assert.match(salesCollapse.whyThisMatters, /recent demand/);
  assert.deepEqual(salesCollapse.suggestedChecks, [
    "Check product is visible on Online Store",
    "Check it is in stock",
    "Check price has not changed unexpectedly",
    "Check it is still included in normal collections",
    "Check recent product/theme edits",
  ]);

  const unavailable = view.alerts.find(
    (alert) => alert.type === "product_unavailable",
  );
  assert.equal(unavailable.affectedSku, "SNEAKER-9");
  assert.equal(unavailable.evidence.currentInventory, 0);
  assert.match(unavailable.summary, /appears unavailable/);

  const revenueDrop = view.alerts.find((alert) => alert.type === "revenue_drop");
  assert.equal(revenueDrop.severity, "critical");
  assert.ok(revenueDrop.evidence.expected7dRevenue > revenueDrop.evidence.current7dRevenue);
  assert.match(revenueDrop.suggestedCheck, /traffic, conversion/);

  const stockMovement = view.alerts.find(
    (alert) => alert.type === "unusual_stock_movement",
  );
  assert.equal(stockMovement.affectedSku, "CAP-GREEN");
  assert.equal(stockMovement.evidence.startAvailable, 214);
  assert.equal(stockMovement.evidence.endAvailable, 12);
  assert.equal(stockMovement.confidence, "medium");

  const missingCogs = view.alerts.find(
    (alert) => alert.type === "missing_cogs_important_seller",
  );
  assert.equal(missingCogs.affectedSku, "HYDRATION");
  assert.equal(missingCogs.estimatedValueAtRisk, null);
  assert.match(missingCogs.summary, /COGS is missing/);

  const highReturn = view.alerts.find(
    (alert) => alert.type === "high_return_product",
  );
  assert.equal(highReturn.affectedSku, "DRESS-M");
  assert.equal(highReturn.evidence.productOrderCount, 4);
  assert.equal(highReturn.evidence.productRefundRatePercent, 50);
  assert.match(highReturn.title, /fake winner/);
});

test("Watchdog sales-collapse-only hero and baseline evidence stay estimated", () => {
  const product = { id: "product-collapse", title: "Black Hoodie" };
  const variantRecord = {
    id: "variant-collapse",
    productId: product.id,
    sku: "HOODIE-M",
    title: "M",
    product,
  };
  const view = buildWatchdogView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    now,
    currentStart,
    comparisonStart,
    orders: [
      order({
        id: "order-collapse-prev",
        externalId: "order-collapse-prev",
        processedAt: "2026-06-20T10:00:00Z",
        totalPrice: "308.00",
      }),
    ],
    lineItems: [
      lineItem({
        id: "line-collapse-prev",
        orderId: "order-collapse-prev",
        productId: product.id,
        variantId: variantRecord.id,
        sku: "HOODIE-M",
        title: product.title,
        quantity: 11,
        unitPrice: "28.00",
        totalPrice: "308.00",
        processedAt: "2026-06-20T10:00:00Z",
        product,
        variant: variantRecord,
      }),
    ],
    refunds: [],
    variants: [],
    cogsInputs: [],
    ledgerEvents: [],
    currency: "GBP",
  });

  assert.equal(view.alerts.length, 1);
  assert.equal(view.alerts[0].type, "sku_sales_collapse");
  assert.equal(
    view.hero.message,
    "Jefe found 1 sales collapse worth checking. Estimated value at risk is £71.87.",
  );
  assert.equal(view.verificationClass, "estimated");
  assert.equal(view.alerts[0].verificationClass, "estimated");
  assert.equal(view.alerts[0].evidence.expected7dRevenue, 71.87);
  assert.equal(view.alerts[0].evidence.last7dRevenue, 0);
  assert.equal(view.alerts[0].estimatedValueAtRisk, 71.87);
});

test("Watchdog v0 returns no-alert and not-enough-history empty states", () => {
  const healthy = buildWatchdogView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    now,
    currentStart,
    comparisonStart,
    orders: Array.from({ length: 4 }, (_, index) =>
      order({
        id: `healthy-order-${index}`,
        externalId: `healthy-order-${index}`,
        processedAt: "2026-06-20T10:00:00Z",
        totalPrice: "50.00",
      }),
    ),
    lineItems: Array.from({ length: 4 }, (_, index) =>
      lineItem({
        id: `healthy-line-${index}`,
        orderId: `healthy-order-${index}`,
        productId: "product-healthy",
        variantId: "variant-healthy",
        sku: "HEALTHY",
        title: "Healthy Product",
        quantity: 1,
        unitPrice: "50.00",
        totalPrice: "50.00",
        processedAt: "2026-06-20T10:00:00Z",
      }),
    ),
    refunds: [],
    variants: [],
    cogsInputs: [],
    ledgerEvents: [],
    currency: "GBP",
  });

  assert.equal(healthy.alerts.length, 0);
  assert.equal(healthy.emptyState, "no_alerts");
  assert.match(healthy.hero.message, /No urgent issues found/);
  assert.match(healthy.limitations.refundData, /refund data is incomplete/);

  const notEnoughHistory = buildWatchdogView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    now,
    currentStart,
    comparisonStart,
    orders: [],
    lineItems: [],
    refunds: [],
    variants: [],
    cogsInputs: [],
    ledgerEvents: [],
    currency: "GBP",
  });

  assert.equal(notEnoughHistory.alerts.length, 0);
  assert.equal(notEnoughHistory.emptyState, "not_enough_history");
});

test("Watchdog persists proposed estimated alerts with merchant/shop tenancy", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Watchdog persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const first = await createWatchdogTenant(prisma, suffix, "first");
    const second = await createWatchdogTenant(prisma, suffix, "second");
    await createWatchdogPersistenceScenario(prisma, first, suffix);
    await createWatchdogPersistenceScenario(prisma, second, `${suffix}-other`);

    const watchdog = await generateWatchdog(prisma, {
      merchantId: first.merchant.id,
      shopId: first.shop.id,
      now,
    });

    assert.ok(watchdog.alerts.length > 0);
    assert.ok(watchdog.persistedActionCount > 0);

    const actions = await prisma.action.findMany({
      where: {
        merchantId: first.merchant.id,
        shopId: first.shop.id,
        actionType: WATCHDOG_ACTION_TYPE,
      },
      include: { executions: true },
    });

    assert.equal(actions.length, watchdog.persistedActionCount);
    assert.ok(actions.length > 0);
    assert.equal(actions[0].verificationClass, "ESTIMATED");
    assert.equal(actions[0].expectedValue.verificationClass, "estimated");
    assert.equal(actions[0].evidence.verificationClass, "estimated");
    assert.equal(actions[0].evidence.merchantId, first.merchant.id);
    assert.equal(actions[0].evidence.shopId, first.shop.id);
    assert.equal(actions[0].executions.length, 0);

    const otherTenantActions = await prisma.action.count({
      where: {
        merchantId: second.merchant.id,
        actionType: WATCHDOG_ACTION_TYPE,
      },
    });

    assert.equal(otherTenantActions, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Watchdog Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("Watchdog route includes required merchant-facing sections and labels", async () => {
  const route = await readFile(
    new URL("../app/routes/app.watchdog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(route, /Watchdog/);
  assert.match(route, /Estimated prevention/);
  assert.match(route, /Primary action/);
  assert.match(route, /Open Watchdog alert/);
  assert.match(route, /Value at risk/);
  assert.match(route, /Alert severity/);
  assert.match(route, /Products affected/);
  assert.match(route, /alert-queue/);
  assert.match(route, /Refund spike/);
  assert.match(route, /Sales collapse/);
  assert.match(route, /Product unavailable/);
  assert.match(route, /Revenue drop/);
  assert.match(route, /Unusual stock movement/);
  assert.match(route, /Missing product costs/);
  assert.match(route, /High return warning/);
  assert.match(route, /Why Jefe recommends this/);
  assert.match(route, /Expected 7d revenue/);
  assert.match(route, /Actual last 7d units/);
  assert.match(route, /Suggested check/);
  assert.match(route, /No urgent issues found/);
  assert.match(route, /Not enough store history yet/);
});

function watchdogFixture() {
  const products = {
    hoodie: { id: "product-hoodie", title: "Black Hoodie" },
    sneakers: { id: "product-sneakers", title: "Red Sneakers" },
    hydration: { id: "product-hydration", title: "Hero Hydration Pack" },
    dress: { id: "product-dress", title: "Summer Dress" },
    cap: { id: "product-cap", title: "Green Cap" },
    stable: { id: "product-stable", title: "Core Tee" },
  };
  const variants = [
    variant({
      id: "variant-hoodie",
      productId: products.hoodie.id,
      sku: "HOODIE-M",
      title: "M",
      product: products.hoodie,
      inventory: 40,
      price: "60.00",
      inventoryItemExternalId: "inventory-hoodie",
    }),
    variant({
      id: "variant-sneakers",
      productId: products.sneakers.id,
      sku: "SNEAKER-9",
      title: "UK 9",
      product: products.sneakers,
      inventory: 0,
      price: "80.00",
      inventoryItemExternalId: "inventory-sneakers",
    }),
    variant({
      id: "variant-hydration",
      productId: products.hydration.id,
      sku: "HYDRATION",
      title: "Default",
      product: products.hydration,
      inventory: 20,
      price: "64.00",
      inventoryItemExternalId: "inventory-hydration",
    }),
    variant({
      id: "variant-dress",
      productId: products.dress.id,
      sku: "DRESS-M",
      title: "M",
      product: products.dress,
      inventory: 20,
      price: "70.00",
      inventoryItemExternalId: "inventory-dress",
    }),
    variant({
      id: "variant-cap",
      productId: products.cap.id,
      sku: "CAP-GREEN",
      title: "Green",
      product: products.cap,
      inventory: 12,
      price: "22.00",
      inventoryItemExternalId: "inventory-cap",
    }),
    variant({
      id: "variant-stable",
      productId: products.stable.id,
      sku: "TEE",
      title: "Default",
      product: products.stable,
      inventory: 100,
      price: "50.00",
      inventoryItemExternalId: "inventory-stable",
    }),
  ];
  const lineItems = [
    lineItem({
      id: "line-hoodie-prev",
      orderId: "order-hoodie-prev",
      productId: products.hoodie.id,
      variantId: "variant-hoodie",
      sku: "HOODIE-M",
      title: products.hoodie.title,
      quantity: 22,
      unitPrice: "60.00",
      totalPrice: "1320.00",
      processedAt: "2026-06-20T10:00:00Z",
      product: products.hoodie,
      variant: variants[0],
    }),
    lineItem({
      id: "line-sneaker-prev",
      orderId: "order-sneaker-prev",
      productId: products.sneakers.id,
      variantId: "variant-sneakers",
      sku: "SNEAKER-9",
      title: products.sneakers.title,
      quantity: 5,
      unitPrice: "80.00",
      totalPrice: "400.00",
      processedAt: "2026-06-22T10:00:00Z",
      product: products.sneakers,
      variant: variants[1],
    }),
    lineItem({
      id: "line-stable-prev",
      orderId: "order-stable-prev",
      productId: products.stable.id,
      variantId: "variant-stable",
      sku: "TEE",
      title: products.stable.title,
      quantity: 180,
      unitPrice: "50.00",
      totalPrice: "9000.00",
      processedAt: "2026-06-23T10:00:00Z",
      product: products.stable,
      variant: variants[5],
    }),
    lineItem({
      id: "line-hydration-current",
      orderId: "order-hydration-current",
      productId: products.hydration.id,
      variantId: "variant-hydration",
      sku: "HYDRATION",
      title: products.hydration.title,
      quantity: 5,
      unitPrice: "64.00",
      totalPrice: "320.00",
      processedAt: "2026-07-12T10:00:00Z",
      product: products.hydration,
      variant: variants[2],
    }),
    ...[0, 1, 2, 3].map((index) =>
      lineItem({
        id: `line-dress-current-${index}`,
        orderId: `order-dress-current-${index}`,
        productId: products.dress.id,
        variantId: "variant-dress",
        sku: "DRESS-M",
        title: products.dress.title,
        quantity: 1,
        unitPrice: "70.00",
        totalPrice: "70.00",
        processedAt: "2026-07-12T10:00:00Z",
        product: products.dress,
        variant: variants[3],
      }),
    ),
    lineItem({
      id: "line-cap-current",
      orderId: "order-cap-current",
      productId: products.cap.id,
      variantId: "variant-cap",
      sku: "CAP-GREEN",
      title: products.cap.title,
      quantity: 3,
      unitPrice: "22.00",
      totalPrice: "66.00",
      processedAt: "2026-07-13T10:00:00Z",
      product: products.cap,
      variant: variants[4],
    }),
  ];
  const orders = uniqueOrdersFromLineItems(lineItems);
  const refunds = [
    refund({
      id: "refund-current-1",
      orderId: "order-dress-current-0",
      amount: "80.00",
      processedAt: "2026-07-13T09:00:00Z",
      order: orderWithLineItems("order-dress-current-0", lineItems),
    }),
    refund({
      id: "refund-current-2",
      orderId: "order-dress-current-1",
      amount: "80.00",
      processedAt: "2026-07-13T10:00:00Z",
      order: orderWithLineItems("order-dress-current-1", lineItems),
    }),
    refund({
      id: "refund-current-3",
      orderId: "order-hydration-current",
      amount: "60.00",
      processedAt: "2026-07-13T11:00:00Z",
      order: orderWithLineItems("order-hydration-current", lineItems),
    }),
    refund({
      id: "refund-prev",
      orderId: "order-stable-prev",
      amount: "50.00",
      processedAt: "2026-06-25T09:00:00Z",
      order: orderWithLineItems("order-stable-prev", lineItems),
    }),
  ];

  return {
    orders,
    lineItems,
    refunds,
    variants,
    cogsInputs: [
      { id: "cogs-dress", variantId: "variant-dress", costAmount: "30.00" },
      { id: "cogs-cap", variantId: "variant-cap", costAmount: "5.00" },
    ],
    ledgerEvents: [
      inventoryLedgerEvent({
        id: "ledger-cap-start",
        inventoryItemExternalId: "inventory-cap",
        available: 214,
        eventTs: "2026-07-08T10:00:00Z",
      }),
      inventoryLedgerEvent({
        id: "ledger-cap-end",
        inventoryItemExternalId: "inventory-cap",
        available: 12,
        eventTs: "2026-07-13T10:00:00Z",
      }),
    ],
  };
}

async function createWatchdogTenant(prisma, suffix, label) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Watchdog Test ${suffix} ${label}`,
      primaryCurrency: "GBP",
      shops: {
        create: {
          shopDomain: `watchdog-${suffix}-${label}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });

  return { merchant, shop: merchant.shops[0] };
}

async function createWatchdogPersistenceScenario(prisma, { merchant, shop }, suffix) {
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `product-${suffix}`,
      title: "Hero Hydration Pack",
      rawPayload: { source: "test" },
      variants: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `variant-${suffix}`,
          sku: `HYDRATION-${suffix}`,
          title: "Default",
          price: "64.00",
          inventoryItemExternalId: `inventory-${suffix}`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { variants: true },
  });
  const variantRecord = product.variants[0];

  await prisma.order.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `order-prev-${suffix}`,
      orderName: `#PREV-${suffix}`,
      currency: "GBP",
      totalPrice: "1000.00",
      processedAt: new Date("2026-06-20T10:00:00Z"),
      lineItems: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          productId: product.id,
          variantId: variantRecord.id,
          externalId: `line-prev-${suffix}`,
          sku: variantRecord.sku,
          title: product.title,
          quantity: 20,
          unitPrice: "50.00",
          totalPrice: "1000.00",
        },
      },
    },
  });
  await prisma.order.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `order-current-${suffix}`,
      orderName: `#CUR-${suffix}`,
      currency: "GBP",
      totalPrice: "128.00",
      processedAt: new Date("2026-07-12T10:00:00Z"),
      lineItems: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          productId: product.id,
          variantId: variantRecord.id,
          externalId: `line-current-${suffix}`,
          sku: variantRecord.sku,
          title: product.title,
          quantity: 2,
          unitPrice: "64.00",
          totalPrice: "128.00",
        },
      },
    },
  });
}

function variant({
  id,
  productId,
  sku,
  title,
  product,
  inventory,
  price,
  inventoryItemExternalId,
}) {
  return {
    id,
    productId,
    sku,
    title,
    product,
    price,
    inventoryItemExternalId,
    rawPayload: {},
    inventoryLevels: [{ available: inventory }],
  };
}

function lineItem({
  id,
  orderId,
  productId,
  variantId,
  sku,
  title,
  quantity,
  unitPrice,
  totalPrice,
  processedAt,
  product,
  variant: variantRecord,
}) {
  return {
    id,
    orderId,
    productId,
    variantId,
    sku,
    title,
    quantity,
    unitPrice,
    totalPrice,
    product,
    variant: variantRecord,
    order: order({
      id: orderId,
      externalId: orderId,
      orderName: `#${orderId}`,
      processedAt,
      totalPrice,
    }),
  };
}

function order({ id, externalId, orderName = `#${id}`, processedAt, totalPrice }) {
  return {
    id,
    externalId,
    orderName,
    currency: "GBP",
    totalPrice,
    processedAt: new Date(processedAt),
  };
}

function refund({ id, orderId, amount, processedAt, order: refundOrder }) {
  return {
    id,
    orderId,
    amount,
    currency: "GBP",
    processedAt: new Date(processedAt),
    sourceCreatedAt: new Date(processedAt),
    order: refundOrder,
  };
}

function orderWithLineItems(orderId, lineItems) {
  const orderLineItems = lineItems.filter((lineItem) => lineItem.orderId === orderId);
  return {
    ...orderLineItems[0].order,
    lineItems: orderLineItems,
  };
}

function uniqueOrdersFromLineItems(lineItems) {
  const map = new Map();
  for (const lineItem of lineItems) {
    map.set(lineItem.orderId, {
      ...lineItem.order,
      lineItems: [lineItem],
      refunds: [],
    });
  }
  return [...map.values()];
}

function inventoryLedgerEvent({ id, inventoryItemExternalId, available, eventTs }) {
  return {
    id,
    eventTs: new Date(eventTs),
    rawPayload: {
      inventory_item_id: inventoryItemExternalId,
      available,
    },
  };
}
