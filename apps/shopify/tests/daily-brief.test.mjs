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
  const brief = buildDailyBriefView(
    baseBriefInput({
      dailyVerdict: dailyVerdictFixture(),
      inventoryGuardian: inventoryGuardianFixture(),
      watchdog: watchdogFixture(),
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 72 }),
      missingCosts: missingCostsFixture(),
      winbackProposal: winbackProposalFixture({ eligibleCount: 14 }),
      sourceErrors: {},
    }),
  );

  assert.equal(brief.status, "generated");
  assert.equal(brief.confidenceLevel, "medium");
  assert.match(brief.headline, /stockout risk on Stockout Serum/);
  assert.equal(brief.recommendedFocus.type, "stockout_risk");
  assert.equal(brief.recommendedFocus.buttonLabel, "Review stockout risk");
  assert.equal(
    brief.verdict.title,
    "A stockout risk is the highest-value issue.",
  );
  assert.equal(
    brief.todayNumbers.find((item) => item.label === "Margin coverage")?.value,
    "72%",
  );
  assert.equal(
    brief.todayNumbers.find((item) => item.label === "Estimated gross profit"),
    undefined,
  );
  assert.ok(brief.whatChanged.length <= 3);
  assert.ok(
    brief.evidenceItems.some((item) =>
      item.includes("72% sold revenue has product costs"),
    ),
  );
  assert.equal(brief.moduleSummaries.length, 4);
  assert.equal(brief.recommendedFocus.valueLabel, "Revenue at risk");
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
  assert.equal(brief.evidence.cogsCoverage.coverageBasis, "sold_revenue");
  assert.equal(
    brief.evidence.verification.verifiedLift,
    "not_available_in_daily_brief_v0",
  );
});

test("Daily Brief marks degraded mode when source data is incomplete", () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
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
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 0 }),
      missingCosts: [],
      winbackProposal: winbackProposalFixture({
        eligibleCount: 0,
        status: "blocked",
      }),
      sourceErrors: {},
    }),
  );

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

test("Daily Brief explains high, medium and low margin confidence from sold-revenue COGS coverage", () => {
  const high = buildDailyBriefView(
    baseBriefInput({
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 90 }),
    }),
  );
  const medium = buildDailyBriefView(
    baseBriefInput({
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 72 }),
    }),
  );
  const low = buildDailyBriefView(
    baseBriefInput({
      dailyVerdict: dailyVerdictFixture({ cogsCoveragePercent: 38 }),
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 38 }),
    }),
  );

  assert.equal(
    high.verdict.title,
    "A stockout risk is the highest-value issue.",
  );
  assert.equal(
    medium.todayNumbers.find((item) => item.label === "Margin coverage")?.value,
    "72%",
  );
  assert.equal(
    low.todayNumbers.find((item) => item.label === "Margin coverage")?.value,
    "38%",
  );
  assert.match(medium.moduleSummaries[0].detail, /72% margin coverage/);
});

test("Daily Brief shows product costs skipped as a limited warning and focus", () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
      productCostsSkipped: true,
      inventoryGuardian: inventoryGuardianFixture({
        revenueAtRisk: 0,
        riskCount: 0,
      }),
      watchdog: watchdogFixture({ alerts: [] }),
      cogsCoverage: cogsCoverageFixture({
        usableRevenueCoveragePercent: 0,
        soldRevenueMissingCost: 202,
      }),
    }),
  );

  assert.equal(brief.recommendedFocus.type, "cogs_coverage");
  assert.match(brief.headline, /product costs were skipped during setup/);
  assert.equal(brief.verdict.title, "Margin insight is limited.");
  assert.equal(brief.recommendedFocus.valueLabel, "Sold revenue affected");
  assert.ok(
    brief.optionalWarnings.some((warning) =>
      warning.includes("margin-based recommendations will stay limited"),
    ),
  );
});

test("Daily Brief selects low COGS coverage when it blocks margin confidence", () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
      inventoryGuardian: inventoryGuardianFixture({ revenueAtRisk: 25 }),
      watchdog: watchdogFixture({ alerts: [] }),
      cogsCoverage: cogsCoverageFixture({
        usableRevenueCoveragePercent: 42,
        soldRevenueMissingCost: 180,
      }),
      missingCosts: missingCostsFixture(),
    }),
  );

  assert.equal(brief.recommendedFocus.type, "cogs_coverage");
  assert.equal(brief.recommendedFocus.buttonLabel, "Review product costs");
  assert.equal(brief.recommendedFocus.valueLabel, "Sold revenue affected");
  assert.match(brief.recommendedFocus.reason, /42% to 81%/);
  assert.equal(
    brief.recommendationEvidence.title,
    "Product costs are the blocker today.",
  );
});

test("Daily Brief selects stockout above COGS when revenue at risk is higher", () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
      inventoryGuardian: inventoryGuardianFixture({ revenueAtRisk: 260 }),
      watchdog: watchdogFixture({ alerts: [] }),
      cogsCoverage: cogsCoverageFixture({
        usableRevenueCoveragePercent: 42,
        soldRevenueMissingCost: 180,
      }),
    }),
  );

  assert.equal(brief.recommendedFocus.type, "stockout_risk");
  assert.equal(brief.recommendedFocus.valueLabel, "Revenue at risk");
  assert.equal(brief.recommendedFocus.estimatedValue, "£260");
});

test("Daily Brief selects critical Watchdog issue above normal opportunities", () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
      watchdog: watchdogFixture({
        severity: "critical",
        estimatedValueAtRisk: 500,
      }),
      inventoryGuardian: inventoryGuardianFixture({ revenueAtRisk: 260 }),
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 42 }),
      winbackProposal: winbackProposalFixture({ eligibleCount: 50 }),
    }),
  );

  assert.equal(brief.recommendedFocus.type, "watchdog_critical");
  assert.equal(brief.recommendedFocus.buttonLabel, "Open Watchdog alert");
  assert.equal(brief.recommendedFocus.valueLabel, "Value at risk");
});

test("Daily Brief selects Klaviyo winback when no higher priority issue exists", () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
      inventoryGuardian: inventoryGuardianFixture({
        revenueAtRisk: 0,
        riskCount: 0,
      }),
      watchdog: watchdogFixture({ alerts: [] }),
      cogsCoverage: cogsCoverageFixture({ usableRevenueCoveragePercent: 90 }),
      winbackProposal: winbackProposalFixture({ eligibleCount: 14 }),
    }),
  );

  assert.equal(brief.recommendedFocus.type, "winback");
  assert.equal(brief.recommendedFocus.buttonLabel, "Review winback draft");
  assert.equal(brief.recommendedFocus.valueLabel, "Estimated upside");
  assert.match(brief.headline, /14 dormant customers/);
});

test("Daily Brief delivery defaults to safe preview mode and can log dev email previews", async () => {
  const brief = buildDailyBriefView(
    baseBriefInput({
      dailyVerdict: dailyVerdictFixture(),
      inventoryGuardian: inventoryGuardianFixture(),
      watchdog: watchdogFixture(),
      cogsCoverage: cogsCoverageFixture(),
      missingCosts: missingCostsFixture(),
      winbackProposal: winbackProposalFixture(),
      sourceErrors: {},
    }),
  );

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
    dailyBriefStyles,
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
    readFile("app/styles/daily-brief.module.css", "utf8"),
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
  assert.match(dailyBriefRoute, /Recommended action/);
  assert.match(dailyBriefRoute, /Key numbers/);
  assert.match(dailyBriefRoute, /Why Jefe recommends this/);
  assert.match(dailyBriefRoute, /aria-label="Supporting modules"/);
  assert.match(dailyBriefRoute, /styles\.briefing/);
  assert.match(dailyBriefRoute, /styles\.verdict/);
  assert.match(dailyBriefRoute, /styles\.actionCard/);
  assert.match(dailyBriefRoute, /styles\.keyNumbers/);
  assert.match(dailyBriefRoute, /styles\.explanation/);
  assert.match(dailyBriefRoute, /styles\.moduleRow/);
  assert.doesNotMatch(dailyBriefRoute, /columns=\{\{ xs: 1, md: 2 \}\}/);
  assert.doesNotMatch(dailyBriefRoute, /<Card/);
  assert.match(dailyBriefRoute, /todayNumbers/);
  assert.match(dailyBriefRoute, /Array\.isArray\(view\.todayNumbers\)/);
  assert.match(dailyBriefRoute, /Array\.isArray\(view\.moduleSummaries\)/);
  assert.match(dailyBriefRoute, /recommendedFocus\.valueLabel/);
  assert.match(dailyBriefRoute, /recommendedFocus\.riskLabel/);
  assert.match(dailyBriefRoute, /recommendedFocus\.effortLabel/);
  assert.doesNotMatch(dailyBriefRoute, /Recommended action value/);
  assert.doesNotMatch(dailyBriefRoute, /Daily Brief scheduled for 7:00am/);
  assert.doesNotMatch(dailyBriefRoute, /Morning delivery is not enabled/);
  assert.match(dailyBriefRoute, /recommendedFocus/);
  assert.match(dailyBriefRoute, /moduleSummaries/);
  assert.match(dailyBriefService, /\/app\/revenue-margin/);
  assert.match(dailyBriefRoute, /getDailyBriefReadiness/);
  assert.match(dailyBriefRoute, /daily_brief_backfill_guard/);
  assert.match(dailyBriefRoute, /isDailyBriefV1Payload/);
  assert.match(dailyBriefRoute, /!isDailyBriefV1Payload\(brief\.verdict\)/);
  assert.match(
    dailyBriefRoute,
    /\{ session, redirect \} = await authenticate\.admin/,
  );
  assert.match(dailyBriefRoute, /throw redirect\("\/app\/onboarding"\)/);
  assert.doesNotMatch(dailyBriefRoute, /import \{ redirect,/);
  assert.match(dailyBriefRoute, /getOnboardingState/);
  assert.match(dailyBriefRoute, /requiredOnboardingComplete/);
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
  assert.match(
    appIndexRoute,
    /\{ session, redirect \} = await authenticate\.admin/,
  );
  assert.match(appIndexRoute, /throw redirect\("\/app\/daily-brief"\)/);
  assert.match(appIndexRoute, /\/app\/onboarding/);
  assert.doesNotMatch(appIndexRoute, /task", "backfill"/);
  assert.match(appIndexRoute, /\/app\/daily-brief/);
  assert.doesNotMatch(dailyBriefRoute, />\s*Generate brief\s*</);
  assert.match(dailyBriefRoute, /Email/);
  assert.match(dailyBriefRoute, /headline/);
  assert.match(dailyBriefService, /selectRecommendedFocus/);
  assert.match(dailyBriefService, /getCogsCoverage/);
  assert.match(dailyBriefService, /buildWinbackProposal/);
  assert.doesNotMatch(dailyBriefService, /createWinbackProposal/);
  assert.doesNotMatch(dailyBriefService, /executeAction/);
  assert.match(dailyBriefStyles, /max-width: 880px/);
  assert.match(dailyBriefStyles, /margin: 0 auto/);
  assert.match(dailyBriefStyles, /\.actionCard/);
  assert.match(dailyBriefStyles, /\.keyNumberGrid/);
  assert.match(dailyBriefStyles, /\.evidenceItem/);
  assert.match(dailyBriefStyles, /\.moduleRow/);
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
  assert.match(
    onboardingRoute,
    /Waiting for orders and insights to finish importing/,
  );
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

function baseBriefInput(overrides = {}) {
  return {
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
    cogsCoverage: cogsCoverageFixture(),
    missingCosts: missingCostsFixture(),
    winbackProposal: winbackProposalFixture({
      eligibleCount: 0,
      status: "blocked",
    }),
    productCostsSkipped: false,
    sourceErrors: {},
    ...overrides,
  };
}

function dailyVerdictFixture(overrides = {}) {
  const cogsCoveragePercent = overrides.cogsCoveragePercent ?? 100;
  return {
    revenue: { gross: 202, net: 202, refunded: 0, currency: "GBP" },
    margin: {
      estimatedGrossProfit: 96,
      estimatedMarginPercent: 47.52,
      confidenceLevel:
        cogsCoveragePercent >= 80
          ? "high"
          : cogsCoveragePercent >= 50
            ? "medium"
            : "low",
      missingCogsVariantCount: 0,
      cogsCoveragePercent,
      soldRevenueWithCogs: (202 * cogsCoveragePercent) / 100,
      soldRevenue: 202,
      soldUnitsWithCogs: Math.round((8 * cogsCoveragePercent) / 100),
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

function inventoryGuardianFixture(options = {}) {
  const revenueAtRisk = options.revenueAtRisk ?? 152;
  const riskCount = options.riskCount ?? (revenueAtRisk > 0 ? 1 : 0);
  return {
    hero: {
      atRiskVariantCount: riskCount,
      revenueAtRisk,
      grossProfitAtRisk: revenueAtRisk > 0 ? 74 : 0,
      confidence: "high",
    },
    metrics: {
      critical: riskCount,
      warning: 0,
      revenueAtRisk,
      grossProfitAtRisk: revenueAtRisk > 0 ? 74 : 0,
      currency: "GBP",
    },
    emptyState: null,
    riskyRecords:
      riskCount > 0
        ? [
            {
              title: "Stockout Serum",
              variantTitle: "30ml",
              daysUntilStockout: 6,
              suggestedReorderQuantity: 40,
              revenueAtRisk,
              confidence: "high",
              currency: "GBP",
            },
          ]
        : [],
    verificationClass: "estimated",
  };
}

function watchdogFixture(options = {}) {
  const alerts = options.alerts ?? [
    {
      type: "sku_sales_collapse",
      title: "Viral Tote stopped selling",
      summary:
        "Viral Tote / Natural sold 14 units in the previous 30 days but 0 in the last 7 days.",
      severity: options.severity ?? "warning",
      confidence: "medium",
      estimatedValueAtRisk: options.estimatedValueAtRisk ?? 71.87,
      suggestedCheck:
        "Check why Viral Tote stopped selling before assuming demand has disappeared.",
    },
  ];
  const estimatedValueAtRisk = alerts.reduce(
    (sum, alert) => sum + Number(alert.estimatedValueAtRisk ?? 0),
    0,
  );
  return {
    hero: {
      alertCount: alerts.length,
      highestSeverity: alerts[0]?.severity ?? null,
      estimatedValueAtRisk,
      message: alerts.length
        ? "Jefe found 1 sales collapse worth checking."
        : "Jefe found no urgent silent-breakage alerts.",
    },
    metrics: {
      critical: alerts.filter((alert) => alert.severity === "critical").length,
      warning: alerts.filter((alert) => alert.severity === "warning").length,
      watch: 0,
      estimatedValueAtRisk,
      currency: "GBP",
    },
    alerts,
    emptyState: null,
    limitations: {
      refundData: null,
      inventoryMovement: null,
    },
    verificationClass: "estimated",
  };
}

function cogsCoverageFixture(overrides = {}) {
  const usableRevenueCoveragePercent =
    overrides.usableRevenueCoveragePercent ?? 100;
  const soldRevenueTotal = overrides.soldRevenueTotal ?? 202;
  const soldRevenueMissingCost =
    overrides.soldRevenueMissingCost ??
    Number(
      (soldRevenueTotal * ((100 - usableRevenueCoveragePercent) / 100)).toFixed(
        2,
      ),
    );
  const soldRevenueConfirmedCost =
    overrides.soldRevenueConfirmedCost ??
    Number((soldRevenueTotal - soldRevenueMissingCost).toFixed(2));

  return {
    soldRevenueTotal,
    soldRevenueConfirmedCost,
    soldRevenueMerchantRuleCost: 0,
    soldRevenueMissingCost,
    soldUnitsTotal: 8,
    soldUnitsConfirmedCost: Math.round(
      (8 * usableRevenueCoveragePercent) / 100,
    ),
    soldUnitsMerchantRuleCost: 0,
    soldUnitsMissingCost:
      8 - Math.round((8 * usableRevenueCoveragePercent) / 100),
    confirmedRevenueCoveragePercent: usableRevenueCoveragePercent,
    usableRevenueCoveragePercent,
    missingRevenueCoveragePercent: Math.max(
      0,
      100 - usableRevenueCoveragePercent,
    ),
    marginConfidence:
      usableRevenueCoveragePercent >= 80
        ? "high"
        : usableRevenueCoveragePercent >= 50
          ? "medium"
          : usableRevenueCoveragePercent > 0
            ? "low"
            : "limited",
    coverageBasis: "sold_revenue",
    variantsMissingCost: usableRevenueCoveragePercent >= 100 ? 0 : 6,
    currency: "GBP",
    ...overrides,
  };
}

function missingCostsFixture() {
  return [
    { variantId: "variant-1", productTitle: "Missing One", soldRevenue: 34 },
    { variantId: "variant-2", productTitle: "Missing Two", soldRevenue: 31 },
    { variantId: "variant-3", productTitle: "Missing Three", soldRevenue: 29 },
    { variantId: "variant-4", productTitle: "Missing Four", soldRevenue: 22 },
    { variantId: "variant-5", productTitle: "Missing Five", soldRevenue: 15 },
    { variantId: "variant-6", productTitle: "Missing Six", soldRevenue: 11 },
  ];
}

function winbackProposalFixture(options = {}) {
  const eligibleCount = options.eligibleCount ?? 14;
  const status = options.status ?? "ready";

  return {
    status,
    blockedReasons: status === "ready" ? [] : ["Needs eligible audience"],
    verificationClass: "estimated",
    plannedVerification: "10% randomised holdout",
    audience: {
      eligibleCount,
      includedCount: eligibleCount,
      treatmentCount: Math.max(
        0,
        eligibleCount - Math.ceil(eligibleCount * 0.1),
      ),
      holdoutCount: Math.ceil(eligibleCount * 0.1),
    },
    economics: {
      currency: "GBP",
      expectedRevenueAfterDiscount:
        options.expectedRevenueAfterDiscount ?? 88.2,
    },
  };
}
