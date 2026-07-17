import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  completeOnboarding,
  getOnboardingState,
  HOUSE_RULE_DEFAULTS,
  loadMerchantPolicyContext,
  saveOnboardingApprovalMode,
  saveOnboardingCogsInputs,
  saveOnboardingGoals,
  saveOnboardingHouseRules,
  setOnboardingStepStatus,
} from "../app/services/onboarding.server.js";
import { upsertBackfillStatus } from "../app/services/shopify-backfill-status.server.js";

const databaseUrl = process.env.DATABASE_URL;

test("onboarding saves goals, House Rules and partial state", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);

    await saveOnboardingGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      goals: {
        THREE_MONTHS: "Get contribution margin under control",
        SIX_MONTHS: "Recover dormant customers profitably",
        TWELVE_MONTHS: "Build predictable founder-led ops",
      },
      priority: "margin",
      worthPayingFor: "Verified margin lift above the monthly app fee",
    });
    await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "20",
        maxWinbackDiscountPercent: "15",
        maxCampaignAudienceSize: "5000",
        emailCooldownDays: "14",
        maxEmailsPerCustomer: "2",
        emailFrequencyScope: "per_customer_per_month",
        bfcmFreezeMode: "on",
        neverDiscountedSkus: "HERO-1",
        protectedProducts: "Core bundle",
        minimumMarginPercent: "55",
        priorityMode: "protect_margin",
        brandVoice: "Plain spoken and premium",
        actionsRequiringExtraApproval: "Discounts above 10%",
        riskyPeriods: "BFCM freeze",
        freeTextRules: "Never hide weak confidence.",
      },
    });

    const readBack = await prisma.shop.findUniqueOrThrow({
      where: { id: shop.id },
      include: { goals: true, houseRules: true },
    });

    assert.ok(readBack.onboardingStartedAt);
    assert.equal(readBack.onboardingCompletedAt, null);
    assert.equal(readBack.goalsCompleted, true);
    assert.equal(readBack.houseRulesCompleted, true);
    assert.equal(readBack.goals.length, 3);
    assert.equal(readBack.houseRules.length, 1);
    assert.equal(readBack.houseRules[0].maxDiscountBps, 2000);
    assert.equal(readBack.houseRules[0].maxDefaultDiscountBps, 2000);
    assert.equal(readBack.houseRules[0].maxWinbackDiscountBps, 1500);
    assert.equal(readBack.houseRules[0].maxCampaignAudienceSize, 5000);
    assert.equal(readBack.houseRules[0].emailCooldownDays, 14);
    assert.equal(
      readBack.houseRules[0].emailFrequencyScope,
      "per_customer_per_month",
    );
    assert.equal(readBack.houseRules[0].bfcmFreezeMode, true);
    assert.deepEqual(readBack.houseRules[0].protectedProducts, ["Core bundle"]);
    assert.equal(
      readBack.houseRules[0].emailFrequencyRules.maxEmailsPerCustomer,
      2,
    );
    assert.equal(
      readBack.houseRules[0].emailFrequencyRules.cooldownDays,
      14,
    );
    assert.equal(
      readBack.houseRules[0].emailFrequencyRules.scope,
      "per_customer_per_month",
    );
    assert.equal(
      readBack.houseRules[0].structuredRules.maxWinbackDiscountBps,
      1500,
    );
    assert.equal(
      readBack.houseRules[0].structuredRules.maxCampaignAudienceSize,
      5000,
    );
    assert.equal(
      readBack.houseRules[0].structuredRules.maxEmailsPerCustomer,
      2,
    );
    assert.equal(
      readBack.houseRules[0].marginPriorityRules.priorityMode,
      "protect_margin",
    );
    assert.equal(
      readBack.houseRules[0].structuredRules.neverDiscountedSkus[0],
      "HERO-1",
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding edits House Rules in place", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);

    const first = await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "15",
        maxWinbackDiscountPercent: "10",
        maxCampaignAudienceSize: "1000",
        emailCooldownDays: "7",
        maxEmailsPerCustomer: "1",
        emailFrequencyScope: "per_customer_per_week",
        brandVoice: "Warm",
      },
    });
    const second = await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "10",
        maxWinbackDiscountPercent: "25",
        allowWinbackDiscountAboveDefault: "on",
        maxCampaignAudienceSize: "2500",
        emailCooldownDays: "21",
        maxEmailsPerCustomer: "3",
        emailFrequencyScope: "per_segment_per_week",
        bfcmFreezeMode: "on",
        brandVoice: "Direct",
        actionsRequiringExtraApproval:
          "Any winback audience above the default cap",
      },
    });
    const count = await prisma.houseRule.count({
      where: { merchantId: merchant.id, shopId: shop.id },
    });

    assert.equal(second.id, first.id);
    assert.equal(count, 1);
    assert.equal(second.maxDiscountBps, 1000);
    assert.equal(second.maxDefaultDiscountBps, 1000);
    assert.equal(second.maxWinbackDiscountBps, 2500);
    assert.equal(second.allowWinbackDiscountAboveDefault, true);
    assert.equal(second.maxCampaignAudienceSize, 2500);
    assert.equal(second.emailCooldownDays, 21);
    assert.equal(second.emailFrequencyScope, "per_segment_per_week");
    assert.equal(second.bfcmFreezeMode, true);
    assert.equal(second.emailFrequencyRules.maxEmailsPerCustomer, 3);
    assert.equal(second.brandVoiceRules.voice, "Direct");
    assert.equal(
      second.riskyActionRules.actionsRequiringExtraApproval,
      "Any winback audience above the default cap",
    );

    const third = await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "15",
        maxWinbackDiscountPercent: "10",
        allowWinbackDiscountAboveDefault: "false",
        maxCampaignAudienceSize: "20",
        emailCooldownDays: "7",
        maxEmailsPerCustomer: "1",
        emailFrequencyScope: "per_customer_per_week",
        bfcmFreezeMode: "false",
        brandVoice: "Direct",
      },
    });

    assert.equal(third.id, first.id);
    assert.equal(third.maxCampaignAudienceSize, 20);
    assert.equal(third.emailCooldownDays, 7);
    assert.equal(third.allowWinbackDiscountAboveDefault, false);
    assert.equal(third.bfcmFreezeMode, false);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding House Rules applies defaults for new merchants", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);

    const houseRule = await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {},
    });

    assert.equal(
      houseRule.maxDefaultDiscountBps,
      Number(HOUSE_RULE_DEFAULTS.maxDefaultDiscountPercent) * 100,
    );
    assert.equal(
      houseRule.maxWinbackDiscountBps,
      Number(HOUSE_RULE_DEFAULTS.maxWinbackDiscountPercent) * 100,
    );
    assert.equal(
      houseRule.marginPriorityRules.minimumMarginPercent,
      Number(HOUSE_RULE_DEFAULTS.minimumMarginPercent),
    );
    assert.equal(
      houseRule.marginPriorityRules.priorityMode,
      HOUSE_RULE_DEFAULTS.priorityMode,
    );
    assert.equal(
      houseRule.emailFrequencyRules.maxEmailsPerCustomer,
      Number(HOUSE_RULE_DEFAULTS.maxEmailsPerCustomer),
    );
    assert.equal(
      houseRule.emailFrequencyScope,
      HOUSE_RULE_DEFAULTS.emailFrequencyScope,
    );
    assert.equal(
      houseRule.maxCampaignAudienceSize,
      Number(HOUSE_RULE_DEFAULTS.maxCampaignAudienceSize),
    );
    assert.equal(
      houseRule.emailCooldownDays,
      Number(HOUSE_RULE_DEFAULTS.emailCooldownDays),
    );
    assert.equal(houseRule.allowWinbackDiscountAboveDefault, false);
    assert.equal(houseRule.bfcmFreezeMode, false);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding House Rules validates winback-ready structured fields", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    const base = { merchantId: merchant.id, shopId: shop.id };

    await assert.rejects(
      () =>
        saveOnboardingHouseRules(prisma, {
          ...base,
          rules: { maxDefaultDiscountPercent: "101" },
        }),
      /Max default discount % must be between 0 and 100/,
    );
    await assert.rejects(
      () =>
        saveOnboardingHouseRules(prisma, {
          ...base,
          rules: {
            maxDefaultDiscountPercent: "10",
            maxWinbackDiscountPercent: "15",
          },
        }),
      /Max winback discount % cannot exceed max default discount %/,
    );
    await assert.rejects(
      () =>
        saveOnboardingHouseRules(prisma, {
          ...base,
          rules: { minimumMarginPercent: "-1" },
        }),
      /Minimum margin preference % must be between 0 and 100/,
    );
    await assert.rejects(
      () =>
        saveOnboardingHouseRules(prisma, {
          ...base,
          rules: { maxCampaignAudienceSize: "0" },
        }),
      /Max campaign audience size before extra approval must be a positive integer/,
    );
    await assert.rejects(
      () =>
        saveOnboardingHouseRules(prisma, {
          ...base,
          rules: { emailCooldownDays: "1.5" },
        }),
      /Customer\/segment email cooldown period in days must be a positive integer/,
    );
    await assert.rejects(
      () =>
        saveOnboardingHouseRules(prisma, {
          ...base,
          rules: { emailFrequencyScope: "per_store_forever" },
        }),
      /Email frequency limit scope is invalid/,
    );

    const allowed = await saveOnboardingHouseRules(prisma, {
      ...base,
      rules: {
        maxDefaultDiscountPercent: "10",
        maxWinbackDiscountPercent: "15",
        allowWinbackDiscountAboveDefault: "on",
      },
    });

    assert.equal(allowed.maxWinbackDiscountBps, 1500);
    assert.equal(allowed.allowWinbackDiscountAboveDefault, true);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding loads saved House Rules as merchant policy context", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    const houseRule = await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: {
        maxDefaultDiscountPercent: "18",
        maxWinbackDiscountPercent: "12",
        maxEmailsPerCustomer: "1",
        emailFrequencyScope: "per_campaign_type",
        maxCampaignAudienceSize: "750",
        emailCooldownDays: "9",
        minimumMarginPercent: "35",
        priorityMode: "protect_margin",
        neverDiscountedSkus: "HERO-1, GIFT-CARD",
        protectedProducts: "Core Collection",
        brandVoice: "Premium and direct",
        actionsRequiringExtraApproval: "Any campaign over 750 customers",
        riskyPeriods: "BFCM",
        freeTextRules: "Always show expected value before approval.",
      },
    });

    const policy = await loadMerchantPolicyContext(prisma, shop.id);

    assert.equal(policy.policyVersion, "house_rules_v1");
    assert.equal(policy.sourceHouseRuleId, houseRule.id);
    assert.equal(policy.discounts.maxDefaultDiscountBps, 1800);
    assert.equal(policy.discounts.maxWinbackDiscountBps, 1200);
    assert.equal(policy.email.maxEmailsPerCustomer, 1);
    assert.equal(policy.email.frequencyScope, "per_campaign_type");
    assert.equal(policy.email.cooldownDays, 9);
    assert.equal(policy.approval.maxCampaignAudienceSize, 750);
    assert.equal(
      policy.approval.actionsRequiringExtraApproval,
      "Any campaign over 750 customers",
    );
    assert.equal(policy.margin.minimumMarginPercent, 35);
    assert.equal(policy.margin.priorityMode, "protect_margin");
    assert.deepEqual(policy.products.neverDiscountedSkus, [
      "HERO-1",
      "GIFT-CARD",
    ]);
    assert.deepEqual(policy.products.protectedProducts, ["Core Collection"]);
    assert.equal(policy.brand.voice, "Premium and direct");
    assert.deepEqual(policy.seasonal.riskyPeriods, ["BFCM"]);
    assert.equal(
      policy.freeTextRules,
      "Always show expected value before approval.",
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding COGS treats manual values as confirmed and blanks as missing", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop, variants } = await createOnboardingTenant(
      prisma,
      suffix,
    );

    const partial = await saveOnboardingCogsInputs(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: [
        {
          variantId: variants[0].id,
          productId: variants[0].productId,
          sku: variants[0].sku,
          costAmount: "12.5",
        },
        {
          variantId: variants[1].id,
          productId: variants[1].productId,
          sku: variants[1].sku,
          costAmount: "",
        },
      ],
    });

    assert.equal(partial.totalVariants, 2);
    assert.equal(partial.variantsWithCogs, 1);
    assert.equal(partial.completionPercentage, "50.00");
    assert.equal(partial.confidenceLevel, "medium");

    const manualCogsInput = await prisma.cogsInput.findFirstOrThrow({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: variants[0].id,
        effectiveTo: null,
      },
    });

    assert.equal(manualCogsInput.confidenceLevel, "confirmed");
    assert.equal(manualCogsInput.confirmedByMerchant, true);

    await saveOnboardingCogsInputs(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: variants.map((variant) => ({
        variantId: variant.id,
        productId: variant.productId,
        sku: variant.sku,
        costAmount: "14.25",
      })),
    });

    const readBack = await prisma.shop.findUniqueOrThrow({
      where: { id: shop.id },
      include: { cogsInputs: true },
    });

    assert.equal(Number(readBack.cogsCompletionPercentage), 100);
    assert.equal(readBack.cogsConfidenceLevel, "high");
    assert.equal(readBack.cogsInputs.length, 2);
    assert.equal(readBack.cogsInputs[0].confirmedByMerchant, true);

    const missingAgain = await saveOnboardingCogsInputs(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: variants.map((variant) => ({
        variantId: variant.id,
        productId: variant.productId,
        sku: variant.sku,
        costAmount: "",
      })),
    });

    assert.equal(missingAgain.variantsWithCogs, 0);
    assert.equal(missingAgain.completionPercentage, "0.00");
    assert.equal(missingAgain.confidenceLevel, "low");

    await completeOnboarding(prisma, shop.id);
    const completed = await prisma.shop.findUniqueOrThrow({
      where: { id: shop.id },
    });
    assert.ok(completed.onboardingCompletedAt);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding readiness exposes progressive setup while import runs", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    await createBackfillStatuses(prisma, merchant.id, shop.id, {
      shop: "complete",
      webhooks: "complete",
      products: "queued",
      orders: "queued",
      customers: "queued",
      inventory: "queued",
      refunds: "queued",
      derived_metrics: "queued",
    });

    const state = await getOnboardingState(prisma, shop.id);
    const stepsByKey = Object.fromEntries(
      state.steps.map((step) => [step.key, step]),
    );

    assert.equal(state.overallStatus, "importing");
    assert.equal(state.onboardingComplete, false);
    assert.equal(state.requiredOnboardingComplete, false);
    assert.equal(state.requiredProgress.completeSteps, 0);
    assert.equal(state.requiredProgress.totalSteps, 3);
    assert.equal(state.progress.totalSteps, 9);
    assert.equal(stepsByKey.business_goal.status, "available");
    assert.equal(stepsByKey.house_rules.status, "available");
    assert.equal(stepsByKey.approval_mode.status, "available");
    assert.equal(stepsByKey.brand_voice.status, "available");
    assert.equal(stepsByKey.klaviyo.status, "available");
    assert.equal(stepsByKey.product_costs.status, "locked");
    assert.equal(stepsByKey.protected_products.status, "locked");
    assert.equal(stepsByKey.first_risks.status, "locked");
    assert.equal(stepsByKey.first_daily_brief.status, "locked");
    assert.equal(state.recommendedNextStep.key, "business_goal");
    assert.equal(state.importStatus.orders.reason.includes("bulk"), false);
    assert.equal(
      JSON.stringify(state).includes("bulk_operation_id"),
      false,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding readiness unlocks product setup after products import", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    await createBackfillStatuses(prisma, merchant.id, shop.id, {
      products: "complete",
      orders: "queued",
      inventory: "queued",
      derived_metrics: "queued",
    });

    const state = await getOnboardingState(prisma, shop.id);
    const stepsByKey = Object.fromEntries(
      state.steps.map((step) => [step.key, step]),
    );

    assert.equal(stepsByKey.product_costs.status, "needs_attention");
    assert.equal(stepsByKey.protected_products.status, "available");
    assert.equal(state.importStatus.products.reason, "Products are ready. You can now confirm product costs.");
    assert.equal(state.cogs.coveragePercentage, 0);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding readiness recommends COGS after required setup is complete", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    await createBackfillStatuses(prisma, merchant.id, shop.id, {
      products: "complete",
      orders: "complete",
      inventory: "complete",
      derived_metrics: "complete",
    });
    await saveOnboardingGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      goals: {
        THREE_MONTHS: "Protect margin",
        SIX_MONTHS: "Improve retention",
        TWELVE_MONTHS: "Build operating discipline",
      },
    });
    await saveOnboardingHouseRules(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rules: { freeTextRules: "Protect margin before volume." },
    });
    await saveOnboardingApprovalMode(prisma, {
      shopId: shop.id,
      approvalMode: "balanced",
    });

    const state = await getOnboardingState(prisma, shop.id);

    assert.equal(state.requiredOnboardingComplete, true);
    assert.equal(state.onboardingComplete, false);
    assert.equal(state.recommendedNextStep.key, "product_costs");
    assert.equal(state.warnings[0].key, "margin_limited");
    assert.equal(
      state.moduleReadiness.find((module) => module.key === "revenue_margin")
        .status,
      "limited",
    );

    await completeOnboarding(prisma, shop.id);
    const completedState = await getOnboardingState(prisma, shop.id);

    assert.equal(completedState.onboardingComplete, true);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding readiness unlocks risks and Daily Brief after insights", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    await createBackfillStatuses(prisma, merchant.id, shop.id, {
      products: "complete",
      orders: "complete",
      inventory: "complete",
      derived_metrics: "complete",
    });
    await setOnboardingStepStatus(prisma, {
      shopId: shop.id,
      stepKey: "first_daily_brief",
      status: "complete",
    });

    const state = await getOnboardingState(prisma, shop.id);
    const stepsByKey = Object.fromEntries(
      state.steps.map((step) => [step.key, step]),
    );

    assert.equal(state.overallStatus, "ready");
    assert.equal(stepsByKey.first_risks.status, "available");
    assert.equal(stepsByKey.first_daily_brief.status, "complete");
    assert.equal(
      state.moduleReadiness.find((module) => module.key === "daily_brief")
        .status,
      "ready",
    );
    assert.equal(
      state.moduleReadiness.find((module) => module.key === "watchdog").status,
      "ready",
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding readiness persists skipped optional steps and limited order access", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for onboarding tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const { merchant, shop } = await createOnboardingTenant(prisma, suffix);
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        historicalOrderAccess: "limited",
        availableOrderHistoryDays: 60,
      },
    });
    await createBackfillStatuses(prisma, merchant.id, shop.id, {
      products: "complete",
      orders: "complete",
      inventory: "complete",
      derived_metrics: "complete",
    });
    await setOnboardingStepStatus(prisma, {
      shopId: shop.id,
      stepKey: "klaviyo",
      status: "skipped",
    });
    await setOnboardingStepStatus(prisma, {
      shopId: shop.id,
      stepKey: "product_costs",
      status: "skipped",
    });

    const state = await getOnboardingState(prisma, shop.id);
    const stepsByKey = Object.fromEntries(
      state.steps.map((step) => [step.key, step]),
    );

    assert.equal(state.overallStatus, "partial");
    assert.equal(state.historicalOrdersLimited, true);
    assert.equal(stepsByKey.klaviyo.status, "skipped");
    assert.equal(stepsByKey.product_costs.status, "skipped");
    assert.equal(state.progress.completeSteps, 2);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Onboarding Test Merchant ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("onboarding files do not contain production secrets", async () => {
  const prismaSchema = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8"),
  );
  const onboardingService = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../app/services/onboarding.server.js", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(/shpat_|sk_live_|SHOPIFY_API_SECRET=["'][^"']+/.test(prismaSchema), false);
  assert.equal(/shpat_|sk_live_|SHOPIFY_API_SECRET=["'][^"']+/.test(onboardingService), false);
});

async function createBackfillStatuses(prisma, merchantId, shopId, statuses) {
  const domains = [
    "shop",
    "webhooks",
    "products",
    "orders",
    "customers",
    "inventory",
    "refunds",
    "derived_metrics",
  ];

  await Promise.all(
    domains.map((domain) =>
      upsertBackfillStatus(prisma, {
        merchantId,
        shopId,
        domain,
        status: statuses[domain] ?? "complete",
        recordsProcessed: statuses[domain] === "queued" ? 0 : 1,
      }),
    ),
  );
}

async function createOnboardingTenant(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Onboarding Test Merchant ${suffix}`,
      shops: {
        create: {
          shopDomain: `onboarding-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      externalId: `product-${suffix}`,
      title: "Onboarding Product",
      rawPayload: { source: "test" },
      variants: {
        create: [
          {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `variant-a-${suffix}`,
            sku: `SKU-A-${suffix}`,
            title: "Small",
            price: "40.00",
            rawPayload: { source: "test" },
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            externalId: `variant-b-${suffix}`,
            sku: `SKU-B-${suffix}`,
            title: "Large",
            price: "50.00",
            rawPayload: { source: "test" },
          },
        ],
      },
    },
    include: { variants: true },
  });

  return { merchant, shop, variants: product.variants };
}
