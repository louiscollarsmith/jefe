import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildDailyBriefView,
  deliverDailyBrief,
} from "../app/services/daily-brief.server.js";

const generatedAt = new Date("2026-07-14T07:00:00Z");
const periodStart = new Date("2026-07-07T07:00:00Z");
const periodEnd = generatedAt;

test("Daily Brief combines Verdict, Inventory Guardian and Watchdog without blending estimated value", () => {
  const brief = buildDailyBriefView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    merchantName: "Jefe Test Store",
    shopDomain: "jefe-test.myshopify.com",
    generatedAt,
    periodStart,
    periodEnd,
    currency: "GBP",
    dailyVerdict: dailyVerdictFixture(),
    inventoryGuardian: inventoryGuardianFixture(),
    watchdog: watchdogFixture(),
    sourceErrors: {},
  });

  assert.equal(brief.status, "generated");
  assert.equal(brief.confidenceLevel, "medium");
  assert.match(brief.headline, /Revenue was £202.00/);
  assert.match(brief.headline, /1 stockout risk/);
  assert.match(brief.headline, /1 Watchdog issue/);
  assert.equal(brief.sections.length, 4);

  const inventorySection = brief.sections.find(
    (section) => section.type === "inventory_guardian",
  );
  const watchdogSection = brief.sections.find(
    (section) => section.type === "watchdog",
  );
  const focusSection = brief.sections.find(
    (section) => section.type === "suggested_focus",
  );

  assert.equal(inventorySection.verificationClass, "estimated");
  assert.equal(inventorySection.valueAtRisk, 152);
  assert.equal(watchdogSection.verificationClass, "estimated");
  assert.equal(watchdogSection.valueAtRisk, 71.87);
  assert.match(focusSection.summary, /check Stockout Serum/);
  assert.equal(
    brief.evidence.verification.verifiedLift,
    "not_available_in_daily_brief_v0",
  );
});

test("Daily Brief marks degraded mode when source data is incomplete", () => {
  const brief = buildDailyBriefView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    merchantName: "Jefe Test Store",
    shopDomain: "jefe-test.myshopify.com",
    generatedAt,
    periodStart,
    periodEnd,
    currency: "GBP",
    dailyVerdict: {
      ...dailyVerdictFixture(),
      revenue: { gross: 0, net: 0, refunded: 0, currency: "GBP" },
      margin: {
        estimatedGrossProfit: null,
        estimatedMarginPercent: null,
        confidenceLevel: "low",
        missingCogsVariantCount: 0,
        cogsCoveragePercent: 0,
        soldUnitsWithCogs: 0,
        soldUnits: 0,
      },
      evidence: {
        orderLineItemCount: 0,
        refundDataCompleteness: "no_refunds_recorded",
      },
    },
    inventoryGuardian: {
      ...inventoryGuardianFixture(),
      emptyState: "no_inventory",
      hero: {
        ...inventoryGuardianFixture().hero,
        atRiskVariantCount: 0,
        confidence: "low",
      },
      metrics: {
        ...inventoryGuardianFixture().metrics,
        revenueAtRisk: 0,
      },
      riskyRecords: [],
    },
    watchdog: {
      ...watchdogFixture(),
      alerts: [],
      emptyState: "not_enough_history",
      hero: {
        alertCount: 0,
        highestSeverity: null,
        estimatedValueAtRisk: 0,
        message: "Not enough history.",
      },
      metrics: {
        critical: 0,
        warning: 0,
        watch: 0,
        estimatedValueAtRisk: 0,
        currency: "GBP",
      },
      limitations: {
        refundData: "Refund checks are limited.",
        inventoryMovement: "Inventory movement checks need webhook history.",
      },
    },
    sourceErrors: {},
  });

  assert.equal(brief.status, "degraded");
  assert.equal(brief.confidenceLevel, "low");
  assert.equal(brief.dataIncomplete, true);
  assert.ok(
    brief.degradedReasons.some((reason) =>
      reason.includes("No synced order history"),
    ),
  );
  assert.ok(
    brief.degradedReasons.some((reason) =>
      reason.includes("Inventory data is unavailable"),
    ),
  );
  assert.match(brief.headline, /Not enough order data yet/);
});

test("Daily Brief delivery defaults to safe preview mode and can log dev email previews", async () => {
  const brief = buildDailyBriefView({
    merchantId: "merchant-1",
    shopId: "shop-1",
    merchantName: "Jefe Test Store",
    shopDomain: "jefe-test.myshopify.com",
    generatedAt,
    periodStart,
    periodEnd,
    currency: "GBP",
    dailyVerdict: dailyVerdictFixture(),
    inventoryGuardian: inventoryGuardianFixture(),
    watchdog: watchdogFixture(),
    sourceErrors: {},
  });

  const notConfigured = await deliverDailyBrief(brief, {});
  assert.equal(notConfigured.inApp, "ready");
  assert.equal(notConfigured.email, "not_configured");

  const originalInfo = console.info;
  let logged = "";
  console.info = (message) => {
    logged = message;
  };
  try {
    const delivery = await deliverDailyBrief(brief, {
      ENABLE_DAILY_BRIEF_EMAIL: "true",
      DAILY_BRIEF_EMAIL_TO: "founder@example.com",
    });

    assert.equal(delivery.email, "logged");
    assert.match(logged, /daily_brief.email_preview/);
    assert.match(logged, /founder@example.com/);
  } finally {
    console.info = originalInfo;
  }
});

test("Daily Brief navigation and scheduled status copy match product IA", async () => {
  const [
    appShell,
    dailyBriefRoute,
    dailyBriefService,
    revenueMarginRoute,
    inventoryRoute,
    watchdogRoute,
    onboardingRoute,
    appIndexRoute,
    devRoute,
  ] = await Promise.all([
      readFile("app/routes/app.tsx", "utf8"),
      readFile("app/routes/app.daily-brief.tsx", "utf8"),
      readFile("app/services/daily-brief.server.js", "utf8"),
      readFile("app/routes/app.revenue-margin.tsx", "utf8"),
      readFile("app/routes/app.inventory-guardian.tsx", "utf8"),
      readFile("app/routes/app.watchdog.tsx", "utf8"),
      readFile("app/routes/app.onboarding.tsx", "utf8"),
      readFile("app/routes/app._index.tsx", "utf8"),
      readFile("app/routes/app.dev.tsx", "utf8"),
    ]);

  assert.match(appShell, /label: "Daily Brief"/);
  assert.match(appShell, /label: "Revenue & Margin"/);
  assert.doesNotMatch(appShell, /Today's Verdict|Today&apos;s Verdict/);
  assert.match(appShell, /paddingBlockEnd="1600"/);
  assert.match(revenueMarginRoute, /Revenue &amp; Margin/);
  assert.match(dailyBriefRoute, /View revenue and margin details/);
  assert.match(dailyBriefRoute, /\/app\/revenue-margin/);
  assert.match(dailyBriefRoute, /queueInstallShopifyBackfill/);
  assert.match(dailyBriefRoute, /daily_brief_backfill_guard/);
  assert.match(dailyBriefRoute, /useRevalidator/);
  assert.match(dailyBriefRoute, /setInterval/);
  assert.match(dailyBriefRoute, /getCanonicalBackfillCounts/);
  assert.match(dailyBriefRoute, /SETUP_IMPORT_DOMAINS.length/);
  assert.match(dailyBriefRoute, /completedCount/);
  assert.match(dailyBriefRoute, /totalRecordsEstimate/);
  assert.match(dailyBriefRoute, /Imported \$\{count\} of/);
  assert.match(dailyBriefRoute, /availableOrderHistoryDays/);
  assert.match(dailyBriefRoute, /days of order\s+history from Shopify/);
  assert.match(
    dailyBriefRoute,
    /status\.status === "queued" && status\.recordsProcessed === 0[\s\S]*return null;/,
  );
  assert.doesNotMatch(dailyBriefRoute, /Module readiness/);
  assert.doesNotMatch(dailyBriefRoute, /Bulk:/);
  assert.doesNotMatch(dailyBriefRoute, /bulkOperationObjectCount/);
  assert.doesNotMatch(dailyBriefRoute, /records processed/);
  assert.match(appIndexRoute, /\/app\/daily-brief/);
  assert.doesNotMatch(dailyBriefRoute, />\s*Generate brief\s*</);
  assert.match(dailyBriefRoute, /Daily Brief scheduled for 7:00am/);
  assert.match(
    dailyBriefRoute,
    /Automatic morning delivery is not enabled in this dev preview yet/,
  );
  assert.match(dailyBriefRoute, /Last generated:/);
  assert.match(dailyBriefRoute, /Status:/);
  assert.match(dailyBriefRoute, /Email:/);
  assert.match(dailyBriefRoute, /headline/);
  assert.match(dailyBriefService, /Suggested focus/);
  assert.match(devRoute, /Generate test brief/);
  assert.match(
    devRoute,
    /Use this to regenerate the Daily Brief during development/,
  );
  assert.doesNotMatch(revenueMarginRoute, /Open Inventory Guardian/);
  assert.doesNotMatch(revenueMarginRoute, /Open Watchdog/);
  assert.match(revenueMarginRoute, /Performance evidence/);
  assert.match(revenueMarginRoute, /COGS coverage/);
  assert.match(inventoryRoute, /Stockout evidence/);
  assert.match(inventoryRoute, /Detailed stockout and reorder evidence/);
  assert.match(watchdogRoute, /Incident evidence/);
  assert.match(watchdogRoute, /Detailed read-only anomaly checks/);
  assert.match(onboardingRoute, /Settings sections/);
  assert.match(onboardingRoute, /Goals/);
  assert.match(onboardingRoute, /House Rules/);
  assert.match(onboardingRoute, /Product Costs/);
  assert.match(onboardingRoute, /Approval Rules/);
});

function dailyVerdictFixture() {
  return {
    revenue: { gross: 202, net: 202, refunded: 0, currency: "GBP" },
    margin: {
      estimatedGrossProfit: 96,
      estimatedMarginPercent: 47.52,
      confidenceLevel: "high",
      missingCogsVariantCount: 0,
      cogsCoveragePercent: 100,
      soldUnitsWithCogs: 8,
      soldUnits: 8,
    },
    highlights: [
      {
        type: "top_revenue_product",
        message: "Stockout Serum drove £202.00 of revenue.",
      },
    ],
    sections: {
      nextStep: "Use Stockout Serum as the margin benchmark for the next brief.",
    },
    evidence: {
      orderLineItemCount: 2,
      refundDataCompleteness: "order_level_only",
    },
  };
}

function inventoryGuardianFixture() {
  return {
    hero: {
      atRiskVariantCount: 1,
      revenueAtRisk: 152,
      grossProfitAtRisk: 74,
      confidence: "high",
    },
    metrics: {
      critical: 1,
      warning: 0,
      revenueAtRisk: 152,
      grossProfitAtRisk: 74,
      currency: "GBP",
    },
    emptyState: null,
    riskyRecords: [
      {
        title: "Stockout Serum",
        variantTitle: "30ml",
        daysUntilStockout: 6,
        suggestedReorderQuantity: 40,
      },
    ],
    verificationClass: "estimated",
  };
}

function watchdogFixture() {
  return {
    hero: {
      alertCount: 1,
      highestSeverity: "warning",
      estimatedValueAtRisk: 71.87,
      message: "Jefe found 1 sales collapse worth checking.",
    },
    metrics: {
      critical: 0,
      warning: 1,
      watch: 0,
      estimatedValueAtRisk: 71.87,
      currency: "GBP",
    },
    alerts: [
      {
        type: "sku_sales_collapse",
        title: "Viral Tote stopped selling",
        summary:
          "Viral Tote / Natural sold 14 units in the previous 30 days but 0 in the last 7 days.",
        severity: "warning",
        confidence: "medium",
        estimatedValueAtRisk: 71.87,
        suggestedCheck:
          "Check why Viral Tote stopped selling before assuming demand has disappeared.",
      },
    ],
    emptyState: null,
    limitations: {
      refundData: null,
      inventoryMovement: null,
    },
    verificationClass: "estimated",
  };
}
