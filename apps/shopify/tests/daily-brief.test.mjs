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
    importProgressRoute,
    managerSettingsRoute,
    dailyBriefReadinessService,
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
    readFile("app/routes/app.import-progress.tsx", "utf8"),
    readFile("app/routes/app.manager-settings.tsx", "utf8"),
    readFile("app/services/daily-brief-readiness.server.js", "utf8"),
    readFile("app/routes/app._index.tsx", "utf8"),
    readFile("app/routes/app.dev.tsx", "utf8"),
  ]);

  assert.match(appShell, /label: "Daily Brief"/);
  assert.match(appShell, /label: "Revenue & Margin"/);
  assert.match(appShell, /label: "Manager Settings"/);
  assert.match(appShell, /\/app\/manager-settings/);
  assert.doesNotMatch(appShell, /label: "Onboarding"/);
  assert.match(appShell, /getOnboardingState/);
  assert.match(appShell, /getDailyBriefReadiness/);
  assert.match(appShell, /app_shell_backfill_guard/);
  assert.match(appShell, /onboardingComplete/);
  assert.match(appShell, /!briefReady && !allowedBeforeOnboarding/);
  assert.match(appShell, /\{ session, redirect \} = await authenticate\.admin/);
  assert.match(appShell, /throw redirect\("\/app\/onboarding"\)/);
  assert.doesNotMatch(appShell, /redirect\("\/app\/daily-brief"\)/);
  assert.doesNotMatch(appShell, /from "react-router";[\s\S]*redirect,/);
  assert.doesNotMatch(appShell, /url\.searchParams\.get\("task"\) === null/);
  assert.match(appShell, /location\.pathname === "\/app\/onboarding"/);
  assert.match(appShell, /<Outlet \/>/);
  assert.doesNotMatch(appShell, /variant="plain" url="\/app\/dev"/);
  assert.doesNotMatch(appShell, /Today's Verdict|Today&apos;s Verdict/);
  assert.match(appShell, /paddingBlockEnd="1600"/);
  assert.match(revenueMarginRoute, /Revenue &amp; Margin/);
  assert.match(dailyBriefRoute, /View revenue and margin details/);
  assert.match(dailyBriefRoute, /\/app\/revenue-margin/);
  assert.match(dailyBriefRoute, /getDailyBriefReadiness/);
  assert.match(dailyBriefRoute, /daily_brief_backfill_guard/);
  assert.match(
    dailyBriefRoute,
    /\{ session, redirect \} = await authenticate\.admin/,
  );
  assert.match(dailyBriefRoute, /throw redirect\("\/app\/onboarding"\)/);
  assert.doesNotMatch(dailyBriefRoute, /import \{ redirect,/);
  assert.match(dailyBriefRoute, /getOnboardingState/);
  assert.match(dailyBriefRoute, /setOnboardingStepStatus/);
  assert.match(dailyBriefRoute, /onboarding\.warnings/);
  assert.match(dailyBriefReadinessService, /queueInstallShopifyBackfill/);
  assert.match(dailyBriefReadinessService, /allBackfillDomainsComplete/);
  assert.match(
    dailyBriefReadinessService,
    /isReadyDailyBriefStatus\(latestBrief\?\.status\)/,
  );
  assert.match(dailyBriefReadinessService, /status === "degraded"/);
  assert.match(importProgressRoute, /\/app\/onboarding/);
  assert.match(importProgressRoute, /authenticate\.admin\(request\)/);
  assert.match(importProgressRoute, /throw redirect\("\/app\/onboarding"\)/);
  assert.match(managerSettingsRoute, /Manager Settings/);
  assert.match(managerSettingsRoute, /Edit the operating settings/);
  assert.match(managerSettingsRoute, /Business goals/);
  assert.match(managerSettingsRoute, /\/app\/manager-settings\?task=goal/);
  assert.match(
    managerSettingsRoute,
    /\/app\/manager-settings\?task=brand-voice/,
  );
  assert.match(
    managerSettingsRoute,
    /\/app\/manager-settings\?task=product-costs/,
  );
  assert.doesNotMatch(managerSettingsRoute, /\/app\/onboarding\?task=/);
  assert.doesNotMatch(managerSettingsRoute, /cogs=1/);
  assert.match(managerSettingsRoute, /saveOnboardingCogsInputs/);
  assert.match(managerSettingsRoute, /Product cost/);
  assert.match(managerSettingsRoute, /ShopifyAdminLink/);
  assert.match(managerSettingsRoute, /ExternalSmallIcon/);
  assert.match(managerSettingsRoute, /align="start"/);
  assert.match(managerSettingsRoute, /admin\.shopify\.com\/store/);
  assert.match(managerSettingsRoute, /target="_blank"/);
  assert.doesNotMatch(managerSettingsRoute, /<Badge/);
  assert.doesNotMatch(managerSettingsRoute, /settingTone/);
  assert.doesNotMatch(managerSettingsRoute, /settingLabel/);
  assert.doesNotMatch(dailyBriefRoute, /useRevalidator/);
  assert.doesNotMatch(dailyBriefRoute, /setInterval/);
  assert.doesNotMatch(dailyBriefRoute, /getCanonicalBackfillCounts/);
  assert.doesNotMatch(dailyBriefRoute, /SetupProgressView/);
  assert.doesNotMatch(
    dailyBriefRoute,
    /Finish setup before opening the first Daily Brief/,
  );
  assert.doesNotMatch(dailyBriefRoute, /Jefe is reviewing your Shopify store/);
  assert.doesNotMatch(dailyBriefRoute, /Jefe setup/);
  assert.doesNotMatch(dailyBriefRoute, /Recommended next step/);
  assert.doesNotMatch(dailyBriefRoute, /Module readiness/);
  assert.doesNotMatch(dailyBriefRoute, /Do now/);
  assert.doesNotMatch(dailyBriefRoute, /Unlocked soon/);
  assert.doesNotMatch(dailyBriefRoute, /set-approval-mode/);
  assert.doesNotMatch(dailyBriefRoute, /onboarding-step/);
  assert.doesNotMatch(dailyBriefRoute, /Retry import/);
  assert.doesNotMatch(dailyBriefRoute, /OnboardingReadinessPanel/);
  assert.doesNotMatch(dailyBriefRoute, /Bulk:/);
  assert.doesNotMatch(dailyBriefRoute, /bulkOperationObjectCount/);
  assert.doesNotMatch(dailyBriefRoute, /records processed/);
  assert.doesNotMatch(dailyBriefRoute, /bulk_operation_id/);
  assert.match(appIndexRoute, /getOnboardingState/);
  assert.match(appIndexRoute, /getDailyBriefReadiness/);
  assert.match(appIndexRoute, /app_index_backfill_guard/);
  assert.match(appIndexRoute, /\{ session, redirect \} = await authenticate\.admin/);
  assert.match(appIndexRoute, /throw redirect\("\/app\/daily-brief"\)/);
  assert.match(appIndexRoute, /\/app\/onboarding/);
  assert.doesNotMatch(appIndexRoute, /task", "backfill"/);
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
  assert.match(devRoute, /All \$\{input\.label\} records are present/);
  assert.match(
    devRoute,
    /The loader is disabled for this store to avoid duplicate fixture data/,
  );
  assert.doesNotMatch(devRoute, /Partial dummy data found/);
  assert.doesNotMatch(devRoute, /Finalize/);
  assert.doesNotMatch(revenueMarginRoute, /Open Inventory Guardian/);
  assert.doesNotMatch(revenueMarginRoute, /Open Watchdog/);
  assert.match(revenueMarginRoute, /Performance evidence/);
  assert.match(revenueMarginRoute, /COGS coverage/);
  assert.match(inventoryRoute, /Stockout evidence/);
  assert.match(inventoryRoute, /Detailed stockout and reorder evidence/);
  assert.match(watchdogRoute, /Incident evidence/);
  assert.match(watchdogRoute, /Detailed read-only anomaly checks/);
  assert.match(onboardingRoute, /Onboarding/);
  assert.match(onboardingRoute, /FocusedOnboardingPanel/);
  assert.match(onboardingRoute, /TaskPageHeader/);
  assert.match(
    onboardingRoute,
    /Jefe is importing your Shopify data in the background/,
  );
  assert.match(onboardingRoute, /not set in stone/);
  assert.match(onboardingRoute, /Manager Settings whenever you want/);
  assert.match(onboardingRoute, /Required/);
  assert.match(onboardingRoute, /Your setup/);
  assert.match(onboardingRoute, /Recommended while you wait/);
  assert.match(onboardingRoute, /Unlocked when products are ready/);
  assert.doesNotMatch(onboardingRoute, /CollapsibleSetupHeader/);
  assert.doesNotMatch(onboardingRoute, /requiredExpanded/);
  assert.doesNotMatch(onboardingRoute, /optionalExpanded/);
  assert.match(
    onboardingRoute,
    /These settings are optional now but recommended later/,
  );
  assert.match(onboardingRoute, /requiredTaskSteps/);
  assert.doesNotMatch(onboardingRoute, /requiredTasksComplete/);
  assert.doesNotMatch(onboardingRoute, /completeOptionalSteps/);
  assert.doesNotMatch(
    onboardingRoute,
    /of \$\{requiredTaskSteps\.length\} complete/,
  );
  assert.doesNotMatch(onboardingRoute, /Start here/);
  assert.doesNotMatch(onboardingRoute, /ImportStatusPopover/);
  assert.doesNotMatch(onboardingRoute, /Shopify import/);
  assert.doesNotMatch(onboardingRoute, /Last updated:/);
  assert.doesNotMatch(onboardingRoute, /Import progress/);
  assert.doesNotMatch(onboardingRoute, /Jefe is reviewing your Shopify data/);
  assert.doesNotMatch(onboardingRoute, /bulk import/);
  assert.match(onboardingRoute, /complete_onboarding_backfill_guard/);
  assert.match(
    onboardingRoute,
    /\{ session, redirect \} = await authenticate\.admin/,
  );
  assert.match(onboardingRoute, /throw redirect\("\/app\/daily-brief"\)/);
  assert.match(onboardingRoute, /throw redirect\(afterSave\)/);
  assert.doesNotMatch(onboardingRoute, /import \{[\s\S]*redirect,/);
  assert.doesNotMatch(onboardingRoute, /\/app\/manager-settings/);
  assert.match(onboardingRoute, /readiness\.briefReady/);
  assert.match(onboardingRoute, /"\/app\/daily-brief"/);
  assert.doesNotMatch(onboardingRoute, /"\/app\/onboarding\?task=backfill"/);
  assert.match(onboardingRoute, /Waiting for orders and insights to finish importing/);
  assert.match(onboardingRoute, /Back/);
  assert.doesNotMatch(onboardingRoute, /task === "backfill"/);
  assert.match(onboardingRoute, /365 days of Shopify history/);
  assert.match(onboardingRoute, /Jefe setup/);
  assert.match(onboardingRoute, /BackfillStatusRow/);
  assert.match(onboardingRoute, /loadCurrentBackfillCounts/);
  assert.match(onboardingRoute, /prisma\.product\.count/);
  assert.match(onboardingRoute, /prisma\.order\.count/);
  assert.match(onboardingRoute, /Math\.max/);
  assert.match(onboardingRoute, /useRevalidator/);
  assert.match(onboardingRoute, /BACKFILL_POLL_INTERVAL_MS/);
  assert.match(onboardingRoute, /Open Daily Brief/);
  assert.match(onboardingRoute, /disabled=\{!ready\}/);
  assert.match(onboardingRoute, /formatBackfillImportCount/);
  assert.match(onboardingRoute, /Insights ready/);
  assert.match(onboardingRoute, /return "Queued"/);
  assert.match(onboardingRoute, /return "Importing"/);
  assert.match(onboardingRoute, /Imported \$\{processed\} of \$\{total\}/);
  assert.match(onboardingRoute, /Importing \$\{processed\} of \$\{total\}/);
  assert.match(onboardingRoute, /Analysing/);
  assert.match(onboardingRoute, /primaryLabel="Save"/);
  assert.match(onboardingRoute, /primaryDisabled/);
  assert.match(onboardingRoute, /formChanged/);
  assert.match(onboardingRoute, /onDirtyChange/);
  assert.match(onboardingRoute, /goalExampleOptions/);
  assert.match(onboardingRoute, /3 month goal starting point/);
  assert.match(onboardingRoute, /Protect margin/);
  assert.match(onboardingRoute, /Reduce founder firefighting/);
  assert.match(onboardingRoute, /navigate\(step\.href\)/);
  assert.match(onboardingRoute, /navigate\("\/app\/onboarding"\)/);
  assert.match(onboardingRoute, /const prefix =/);
  assert.match(onboardingRoute, /\$\{prefix\} goals/);
  assert.match(onboardingRoute, /\$\{prefix\} rules/);
  assert.match(onboardingRoute, /Margin and discounts/);
  assert.match(onboardingRoute, /Messaging limits/);
  assert.match(onboardingRoute, /HiddenHouseRulesFields/);
  assert.match(onboardingRoute, /Brand voice/);
  assert.match(onboardingRoute, /Protected products/);
  assert.match(onboardingRoute, /Approvals and risk periods/);
  assert.match(onboardingRoute, /approvalModeOptions/);
  assert.match(onboardingRoute, /Approval mode/);
  assert.match(onboardingRoute, /Very cautious/);
  assert.match(onboardingRoute, /\$\{prefix\} mode/);
  assert.match(onboardingRoute, /\$\{prefix\} costs/);
  assert.match(onboardingRoute, /Connect Klaviyo/);
  assert.match(onboardingRoute, /\$\{prefix\} products/);
  assert.match(onboardingRoute, /requiredOnboardingComplete/);
  assert.match(onboardingRoute, /set-approval-mode/);
  assert.match(onboardingRoute, /onboarding-step/);
  assert.match(onboardingRoute, /task === "goal"/);
  assert.match(onboardingRoute, /task === "house-rules"/);
  assert.match(onboardingRoute, /task === "brand-voice"/);
  assert.match(onboardingRoute, /task === "protected-products"/);
  assert.match(onboardingRoute, /task === "product-costs"/);
  assert.doesNotMatch(onboardingRoute, /AnnotatedSection/);
  assert.doesNotMatch(onboardingRoute, /Current priority/);
  assert.doesNotMatch(onboardingRoute, /What would be worth paying/);
  assert.doesNotMatch(onboardingRoute, /Balanced by default/);
  assert.doesNotMatch(onboardingRoute, /Settings sections/);
  assert.match(managerSettingsRoute, /House Rules/);
  assert.match(managerSettingsRoute, /Product costs/);
  assert.match(managerSettingsRoute, /Approval mode/);
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
      nextStep:
        "Use Stockout Serum as the margin benchmark for the next brief.",
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
