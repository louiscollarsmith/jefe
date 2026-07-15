import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  generateDailyVerdict,
  shouldShowDailyVerdictDevTools,
} from "../app/services/daily-verdict.server.js";
import {
  saveOnboardingGoals,
  saveOnboardingHouseRules,
} from "../app/services/onboarding.server.js";

const databaseUrl = process.env.DATABASE_URL;

test("Daily Verdict stores revenue, margin confidence and highlights", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Daily Verdict tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop, variants, products } =
      await createDailyVerdictTenant(prisma, suffix);

    await saveOnboardingGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      goals: {
        THREE_MONTHS: "Improve profit margin and avoid stockouts.",
        SIX_MONTHS: "Grow repeat purchase revenue and prepare for BFCM.",
        TWELVE_MONTHS:
          "Build a more profitable store with less founder involvement.",
      },
    });
    await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "20",
        maxWinbackDiscountPercent: "15",
        minimumMarginPercent: "50",
        priorityMode: "protect_margin",
        brandVoice: "Evidence-led",
      },
    });
    await prisma.cogsInput.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        productId: products[0].id,
        variantId: variants[0].id,
        sku: variants[0].sku,
        costAmount: "20.00",
        source: "manual_onboarding",
        confidence: "1.0000",
        confidenceLevel: "confirmed",
        confirmedByMerchant: true,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const order = await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-${suffix}`,
        orderName: "#1001",
        currency: "GBP",
        totalPrice: "280.00",
        totalShipping: "5.00",
        processedAt: new Date("2026-07-12T10:00:00Z"),
        lineItems: {
          create: [
            {
              merchantId: merchant.id,
              shopId: shop.id,
              productId: products[0].id,
              variantId: variants[0].id,
              externalId: `line-a-${suffix}`,
              sku: variants[0].sku,
              title: products[0].title,
              quantity: 3,
              unitPrice: "60.00",
              totalPrice: "180.00",
            },
            {
              merchantId: merchant.id,
              shopId: shop.id,
              productId: products[1].id,
              variantId: variants[1].id,
              externalId: `line-b-${suffix}`,
              sku: variants[1].sku,
              title: products[1].title,
              quantity: 1,
              unitPrice: "100.00",
              totalPrice: "100.00",
            },
          ],
        },
      },
    });

    await prisma.refund.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        orderId: order.id,
        externalId: `refund-${suffix}`,
        amount: "28.00",
        currency: "GBP",
        sourceCreatedAt: new Date("2026-07-13T09:00:00Z"),
      },
    });

    const brief = await generateDailyVerdict(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      periodStart: new Date("2026-07-07T00:00:00Z"),
      periodEnd: new Date("2026-07-14T00:00:00Z"),
    });
    const verdict = brief.verdict;

    assert.equal(brief.status, "ready");
    assert.equal(verdict.revenue.gross, 280);
    assert.equal(verdict.revenue.net, 252);
    assert.equal(verdict.revenue.refunded, 28);
    assert.equal(verdict.margin.soldUnits, 4);
    assert.equal(verdict.margin.soldUnitsWithCogs, 3);
    assert.equal(verdict.margin.cogsCoveragePercent, 75);
    assert.equal(verdict.margin.confidenceLevel, "medium");
    assert.equal(verdict.margin.missingCogsVariantCount, 1);
    assert.equal(verdict.margin.estimatedGrossProfit, 120);
    assert.equal(verdict.period.display, "Last 7 days · 7 Jul-13 Jul");
    assert.match(verdict.headline, /margin confidence is medium/);
    assert.match(verdict.summary, /Revenue was £280.00/);
    assert.match(verdict.sections.whatHappened, /£280.00 gross revenue/);
    assert.match(verdict.sections.confidence, /75% of sold units have COGS/);
    assert.equal(
      verdict.sections.nextStep,
      "Add product costs for Ceramic Mug before relying on margin recommendations.",
    );
    assert.ok(
      verdict.highlights.some(
        (highlight) => highlight.type === "missing_cogs",
      ),
    );
    const topRevenueHighlight = verdict.highlights.find(
      (highlight) => highlight.type === "top_revenue_product",
    );
    assert.equal(topRevenueHighlight.evidence.productName, "Black Hoodie");
    assert.equal(topRevenueHighlight.evidence.sku, variants[0].sku);
    assert.equal(topRevenueHighlight.evidence.unitsSold, 3);
    assert.equal(topRevenueHighlight.evidence.revenue, 180);
    assert.equal(topRevenueHighlight.evidence.unitCogs, 20);
    assert.equal(topRevenueHighlight.evidence.grossProfit, 120);
    assert.equal(topRevenueHighlight.evidence.marginPercent, 66.67);
    assert.equal(topRevenueHighlight.evidence.confidence, "high");

    const missingCogsHighlight = verdict.highlights.find(
      (highlight) => highlight.type === "missing_cogs",
    );
    assert.equal(missingCogsHighlight.evidence.productName, "Ceramic Mug");
    assert.equal(missingCogsHighlight.evidence.sku, variants[1].sku);
    assert.equal(missingCogsHighlight.evidence.unitCogs, null);
    assert.equal(missingCogsHighlight.evidence.grossProfit, null);
    assert.equal(missingCogsHighlight.evidence.marginPercent, null);
    assert.equal(missingCogsHighlight.evidence.confidence, "low");
    assert.equal(verdict.evidence.goals.length, 3);
    assert.equal(
      verdict.evidence.houseRules.minimumMarginPercent,
      50,
    );

    const stored = await prisma.dailyBrief.findUniqueOrThrow({
      where: { id: brief.id },
    });

    assert.equal(stored.verdict.margin.confidenceLevel, "medium");
    assert.equal(stored.metrics.revenue.gross, 280);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Daily Verdict Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Daily Verdict handles no sales without blocking", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Daily Verdict tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createDailyVerdictTenant(prisma, suffix);
    const brief = await generateDailyVerdict(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      periodStart: new Date("2026-07-07T00:00:00Z"),
      periodEnd: new Date("2026-07-14T00:00:00Z"),
    });

    assert.equal(brief.verdict.revenue.gross, 0);
    assert.equal(brief.verdict.margin.confidenceLevel, "low");
    assert.match(brief.verdict.headline, /Not enough order data yet/);
    assert.match(brief.verdict.sections.whatHappened, /No Shopify sales/);
    assert.equal(
      brief.verdict.sections.nextStep,
      "Wait for Shopify orders to sync, then check the first product-level highlight.",
    );
    assert.match(brief.verdict.summary, /No Shopify sales were recorded/);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Daily Verdict Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Daily Verdict uses high-confidence headline when all sold units have COGS", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Daily Verdict tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop, variants, products } =
      await createDailyVerdictTenant(prisma, suffix);

    await createCogsInput(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      productId: products[0].id,
      variant: variants[0],
      costAmount: "20.00",
    });
    await createCogsInput(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      productId: products[1].id,
      variant: variants[1],
      costAmount: "35.00",
    });
    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-high-${suffix}`,
        orderName: "#2001",
        currency: "GBP",
        totalPrice: "280.00",
        processedAt: new Date("2026-07-12T10:00:00Z"),
        lineItems: {
          create: [
            {
              merchantId: merchant.id,
              shopId: shop.id,
              productId: products[0].id,
              variantId: variants[0].id,
              externalId: `line-high-a-${suffix}`,
              sku: variants[0].sku,
              title: products[0].title,
              quantity: 3,
              unitPrice: "60.00",
              totalPrice: "180.00",
            },
            {
              merchantId: merchant.id,
              shopId: shop.id,
              productId: products[1].id,
              variantId: variants[1].id,
              externalId: `line-high-b-${suffix}`,
              sku: variants[1].sku,
              title: products[1].title,
              quantity: 1,
              unitPrice: "100.00",
              totalPrice: "100.00",
            },
          ],
        },
      },
    });

    const brief = await generateDailyVerdict(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      periodStart: new Date("2026-07-07T00:00:00Z"),
      periodEnd: new Date("2026-07-14T00:00:00Z"),
    });

    assert.equal(brief.verdict.margin.confidenceLevel, "high");
    assert.equal(brief.verdict.margin.cogsCoveragePercent, 100);
    assert.match(brief.verdict.headline, /high margin confidence/);
    assert.doesNotMatch(brief.verdict.headline, /missing COGS/);
    assert.match(
      brief.verdict.sections.nextStep,
      /Use Black Hoodie as the margin benchmark/,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Daily Verdict Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Daily Verdict shows no-COGS state when sold products have no costs", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Daily Verdict tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop, variants, products } =
      await createDailyVerdictTenant(prisma, suffix);

    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-low-${suffix}`,
        orderName: "#3001",
        currency: "GBP",
        totalPrice: "180.00",
        processedAt: new Date("2026-07-12T10:00:00Z"),
        lineItems: {
          create: [
            {
              merchantId: merchant.id,
              shopId: shop.id,
              productId: products[0].id,
              variantId: variants[0].id,
              externalId: `line-low-a-${suffix}`,
              sku: variants[0].sku,
              title: products[0].title,
              quantity: 3,
              unitPrice: "60.00",
              totalPrice: "180.00",
            },
          ],
        },
      },
    });

    const brief = await generateDailyVerdict(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      periodStart: new Date("2026-07-07T00:00:00Z"),
      periodEnd: new Date("2026-07-14T00:00:00Z"),
    });

    assert.equal(brief.verdict.margin.confidenceLevel, "low");
    assert.equal(brief.verdict.margin.cogsCoveragePercent, 0);
    assert.match(brief.verdict.headline, /product costs are missing/);
    assert.match(
      brief.verdict.sections.confidence,
      /0% of sold units have COGS and 100% are missing product costs/,
    );
    assert.doesNotMatch(
      brief.verdict.sections.confidence,
      /every selling variant|all selling variants have COGS/i,
    );
    assert.doesNotMatch(
      brief.verdict.summary,
      /all selling variants have COGS/i,
    );
    assert.match(brief.verdict.sections.nextStep, /Add product costs/);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Daily Verdict Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Daily Verdict dev panels are hidden unless explicitly enabled", () => {
  assert.equal(shouldShowDailyVerdictDevTools({}), false);
  assert.equal(
    shouldShowDailyVerdictDevTools({ ENABLE_DUMMY_STORE_LOADER: "false" }),
    false,
  );
  assert.equal(
    shouldShowDailyVerdictDevTools({ ENABLE_DUMMY_STORE_LOADER: "true" }),
    true,
  );
});

async function createCogsInput(
  prisma,
  { merchantId, shopId, productId, variant, costAmount },
) {
  return prisma.cogsInput.create({
    data: {
      merchantId,
      shopId,
      productId,
      variantId: variant.id,
      sku: variant.sku,
      costAmount,
      source: "manual_onboarding",
      confidence: "1.0000",
      confidenceLevel: "confirmed",
      confirmedByMerchant: true,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    },
  });
}

async function createDailyVerdictTenant(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Daily Verdict Test Merchant ${suffix}`,
      primaryCurrency: "GBP",
      shops: {
        create: {
          shopDomain: `daily-verdict-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const firstProduct = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `product-a-${suffix}`,
      title: "Black Hoodie",
      rawPayload: { source: "test" },
      variants: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `variant-a-${suffix}`,
          sku: `HOODIE-${suffix}`,
          title: "Black",
          price: "60.00",
          rawPayload: { source: "test" },
        },
      },
    },
    include: { variants: true },
  });
  const secondProduct = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `product-b-${suffix}`,
      title: "Ceramic Mug",
      rawPayload: { source: "test" },
      variants: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `variant-b-${suffix}`,
          sku: `MUG-${suffix}`,
          title: "White",
          price: "100.00",
          rawPayload: { source: "test" },
        },
      },
    },
    include: { variants: true },
  });

  return {
    merchant,
    shop,
    products: [firstProduct, secondProduct],
    variants: [firstProduct.variants[0], secondProduct.variants[0]],
  };
}
