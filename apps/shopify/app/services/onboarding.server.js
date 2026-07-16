// @ts-check

import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server.js";
import {
  EMAIL_FREQUENCY_SCOPES,
  HOUSE_RULE_DEFAULTS,
} from "./house-rules-policy.js";
import { getShopBackfillProgress } from "./shopify-backfill-status.server.js";
export { HOUSE_RULE_DEFAULTS } from "./house-rules-policy.js";

/** @type {import("@prisma/client").GoalHorizon[]} */
export const GOAL_HORIZONS = ["THREE_MONTHS", "SIX_MONTHS", "TWELVE_MONTHS"];
export const COGS_CONFIDENCE_LEVELS = ["missing", "estimated", "confirmed"];
export const APPROVAL_MODES = ["very_cautious", "balanced", "experimental"];
export const ONBOARDING_STEP_KEYS = [
  "business_goal",
  "house_rules",
  "approval_mode",
  "brand_voice",
  "klaviyo",
  "product_costs",
  "protected_products",
  "first_risks",
  "first_daily_brief",
];

const OPTIONAL_ONBOARDING_STEPS = new Set([
  "brand_voice",
  "klaviyo",
  "product_costs",
  "protected_products",
]);

const STEP_DEFINITIONS = [
  {
    key: "business_goal",
    label: "Confirm business goals",
    description:
      "Tell Jefe whether the store is prioritising growth, margin, stock control or retention.",
    href: "/app/onboarding?task=goal",
    requiredData: [],
  },
  {
    key: "house_rules",
    label: "Review House Rules",
    description: "Set the rules Jefe must obey before recommending actions.",
    href: "/app/onboarding?task=house-rules",
    requiredData: [],
  },
  {
    key: "approval_mode",
    label: "Choose approval mode",
    description:
      "Decide how cautious Jefe should be with recommendations and future action drafts.",
    href: "/app/daily-brief",
    requiredData: [],
  },
  {
    key: "brand_voice",
    label: "Confirm brand voice",
    description: "Give Jefe guidance for future email and campaign copy.",
    href: "/app/onboarding?task=brand-voice",
    requiredData: [],
  },
  {
    key: "klaviyo",
    label: "Connect Klaviyo",
    description:
      "Connect Klaviyo so Jefe can prepare winback drafts. Live sends remain disabled.",
    href: "/app/klaviyo-winback",
    requiredData: [],
  },
  {
    key: "product_costs",
    label: "Confirm product costs",
    description: "Add or confirm COGS so Jefe can calculate margin.",
    href: "/app/onboarding?task=product-costs&cogs=1",
    requiredData: ["products"],
  },
  {
    key: "protected_products",
    label: "Protect hero products",
    description: "Mark products Jefe should not discount or treat casually.",
    href: "/app/onboarding?task=protected-products",
    requiredData: ["products"],
  },
  {
    key: "first_risks",
    label: "Review first risks",
    description: "Review the first Inventory Guardian and Watchdog findings.",
    href: "/app/daily-brief",
    requiredData: ["orders", "inventory", "insights"],
  },
  {
    key: "first_daily_brief",
    label: "Read first Daily Brief",
    description: "Review Jefe's first summary of the store.",
    href: "/app/daily-brief",
    requiredData: ["insights"],
  },
];

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopDomain: string; accessTokenSessionId?: string | null; scopes?: string[] }} input
 */
export async function ensureOnboardingTenant(prisma, input) {
  return ensureShopifyTenant(prisma, {
    shopDomain: input.shopDomain,
    accessTokenSessionId: input.accessTokenSessionId,
    scopes: input.scopes,
    rawPayload: { source: "onboarding" },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function markOnboardingStarted(prisma, shopId) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });

  if (shop.onboardingStartedAt) {
    return shop;
  }

  return prisma.shop.update({
    where: { id: shopId },
    data: { onboardingStartedAt: new Date() },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; goals: Record<string, string>; priority?: string | null; worthPayingFor?: string | null }} input
 */
export async function saveOnboardingGoals(prisma, input) {
  await markOnboardingStarted(prisma, input.shopId);

  const writes = GOAL_HORIZONS.map((horizon) =>
    prisma.goal.upsert({
      where: {
        merchantId_shopId_horizon_status: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          horizon,
          status: "active",
        },
      },
      create: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        horizon,
        description: input.goals[horizon]?.trim() || "Not set yet",
        metric: "founder_defined",
        metadata: {
          priority: input.priority || null,
          worthPayingFor: input.worthPayingFor || null,
        },
      },
      update: {
        description: input.goals[horizon]?.trim() || "Not set yet",
        metadata: {
          priority: input.priority || null,
          worthPayingFor: input.worthPayingFor || null,
        },
      },
    }),
  );

  const goals = await prisma.$transaction(writes);
  await prisma.shop.update({
    where: { id: input.shopId },
    data: {
      goalsCompleted: goals.every((goal) => goal.description !== "Not set yet"),
    },
  });

  return goals;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; rules: Record<string, unknown> }} input
 */
export async function saveOnboardingHouseRules(prisma, input) {
  await markOnboardingStarted(prisma, input.shopId);

  const existing = await prisma.houseRule.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: "active",
      title: "Founder House Rules",
    },
  });
  const maxDefaultDiscountBps = percentToBps(
    firstDefined(
      input.rules.maxDefaultDiscountPercent,
      input.rules.maxDiscountPercent,
      bpsToPercentString(existing?.maxDefaultDiscountBps),
      bpsToPercentString(existing?.maxDiscountBps),
      HOUSE_RULE_DEFAULTS.maxDefaultDiscountPercent,
    ),
    "Max default discount %",
  );
  const maxWinbackDiscountBps = percentToBps(
    firstDefined(
      input.rules.maxWinbackDiscountPercent,
      bpsToPercentString(existing?.maxWinbackDiscountBps),
      HOUSE_RULE_DEFAULTS.maxWinbackDiscountPercent,
    ),
    "Max winback discount %",
  );
  const allowWinbackDiscountAboveDefault = booleanValue(
    firstDefined(
      input.rules.allowWinbackDiscountAboveDefault,
      existing?.allowWinbackDiscountAboveDefault,
      HOUSE_RULE_DEFAULTS.allowWinbackDiscountAboveDefault,
    ),
  );
  const minimumMarginPercent = percentOrNull(
    firstDefined(
      input.rules.minimumMarginPercent,
      jsonValue(existing?.marginPriorityRules, "minimumMarginPercent"),
      HOUSE_RULE_DEFAULTS.minimumMarginPercent,
    ),
    "Minimum margin preference %",
  );
  const maxEmailsPerCustomer = positiveIntegerOrNull(
    firstDefined(
      input.rules.maxEmailsPerCustomer,
      input.rules.emailFrequencyLimit,
      jsonValue(existing?.emailFrequencyRules, "maxEmailsPerCustomer"),
      HOUSE_RULE_DEFAULTS.maxEmailsPerCustomer,
    ),
    "Maximum emails per customer",
  );
  const maxCampaignAudienceSize = positiveIntegerOrNull(
    firstDefined(
      input.rules.maxCampaignAudienceSize,
      existing?.maxCampaignAudienceSize,
      HOUSE_RULE_DEFAULTS.maxCampaignAudienceSize,
    ),
    "Max campaign audience size before extra approval",
  );
  const emailCooldownDays = positiveIntegerOrNull(
    firstDefined(
      input.rules.emailCooldownDays,
      existing?.emailCooldownDays,
      HOUSE_RULE_DEFAULTS.emailCooldownDays,
    ),
    "Customer/segment email cooldown period in days",
  );
  const emailFrequencyScope = normalizeEmailFrequencyScope(
    firstDefined(
      input.rules.emailFrequencyScope,
      existing?.emailFrequencyScope,
      HOUSE_RULE_DEFAULTS.emailFrequencyScope,
    ),
    "Email frequency limit scope",
  );
  const priorityMode = enumOrNull(
    firstDefined(
      input.rules.priorityMode,
      jsonValue(existing?.marginPriorityRules, "priorityMode"),
      HOUSE_RULE_DEFAULTS.priorityMode,
    ),
    ["protect_margin", "balanced", "growth"],
    "Margin / growth priority",
  );
  const bfcmFreezeMode = booleanValue(
    firstDefined(
      input.rules.bfcmFreezeMode,
      existing?.bfcmFreezeMode,
      HOUSE_RULE_DEFAULTS.bfcmFreezeMode,
    ),
  );

  if (
    maxDefaultDiscountBps !== null &&
    maxWinbackDiscountBps !== null &&
    maxWinbackDiscountBps > maxDefaultDiscountBps &&
    !allowWinbackDiscountAboveDefault
  ) {
    throw new Error(
      "Max winback discount % cannot exceed max default discount % unless explicitly allowed.",
    );
  }

  const protectedProducts = splitList(input.rules.protectedProducts);
  const neverDiscountedSkus = splitList(input.rules.neverDiscountedSkus);
  const actionsRequiringExtraApproval = stringOrNull(
    input.rules.actionsRequiringExtraApproval,
  );
  const riskyPeriods = splitList(input.rules.riskyPeriods);
  const data = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    title: "Founder House Rules",
    status: "active",
    structuredRules: {
      maxDefaultDiscountBps,
      maxWinbackDiscountBps,
      allowWinbackDiscountAboveDefault,
      maxCampaignAudienceSize,
      emailCooldownDays,
      emailFrequencyScope,
      maxEmailsPerCustomer,
      bfcmFreezeMode,
      maxDiscountBps: maxDefaultDiscountBps,
      neverDiscountedSkus,
      protectedProducts,
      minimumMarginPercent,
      priorityMode,
      actionsRequiringExtraApproval,
      riskyPeriods,
    },
    freeTextRules: stringOrNull(input.rules.freeTextRules),
    maxDiscountBps: maxDefaultDiscountBps,
    maxDefaultDiscountBps,
    maxWinbackDiscountBps,
    allowWinbackDiscountAboveDefault,
    maxCampaignAudienceSize,
    emailCooldownDays,
    emailFrequencyScope,
    bfcmFreezeMode,
    protectedProducts,
    emailFrequencyRules: {
      maxEmailsPerCustomer,
      scope: emailFrequencyScope,
      cooldownDays: emailCooldownDays,
    },
    brandVoiceRules: {
      voice: stringOrNull(input.rules.brandVoice),
    },
    marginPriorityRules: {
      minimumMarginPercent,
      priorityMode,
    },
    seasonalPriorities: {
      riskyPeriods,
      bfcmFreezeMode,
    },
    riskyActionRules: {
      actionsRequiringExtraApproval,
    },
  };

  const houseRule = existing
    ? await prisma.houseRule.update({ where: { id: existing.id }, data })
    : await prisma.houseRule.create({ data });

  await prisma.shop.update({
    where: { id: input.shopId },
    data: { houseRulesCompleted: hasMeaningfulHouseRules(input.rules) },
  });

  return houseRule;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function loadMerchantPolicyContext(prisma, shopId) {
  const houseRule = await prisma.houseRule.findFirst({
    where: {
      shopId,
      status: "active",
      title: "Founder House Rules",
    },
    orderBy: { updatedAt: "desc" },
  });

  return houseRule ? buildMerchantPolicyContext(houseRule) : null;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; rows: Array<{ variantId: string; productId?: string | null; sku?: string | null; costAmount?: string | number | null; confidenceLevel?: string | null }> }} input
 */
export async function saveOnboardingCogsInputs(prisma, input) {
  await markOnboardingStarted(prisma, input.shopId);

  const now = new Date();
  for (const row of input.rows) {
    const costAmount = decimalStringOrNull(row.costAmount);

    if (!costAmount) {
      await prisma.cogsInput.updateMany({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          variantId: row.variantId,
          source: "manual_onboarding",
          effectiveTo: null,
        },
        data: { effectiveTo: now },
      });
      continue;
    }

    const confidenceLevel = "confirmed";
    const existing = await prisma.cogsInput.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        variantId: row.variantId,
        source: "manual_onboarding",
        effectiveTo: null,
      },
    });
    const data = {
      merchantId: input.merchantId,
      shopId: input.shopId,
      productId: row.productId || null,
      variantId: row.variantId,
      sku: row.sku || null,
      costAmount,
      currency: "GBP",
      source: "manual_onboarding",
      confidence: "1.0000",
      confidenceLevel,
      confirmedByMerchant: true,
      effectiveFrom: now,
      rawPayload: {
        onboarding: true,
        confidenceState: confidenceLevel,
      },
    };

    if (existing) {
      await prisma.cogsInput.update({ where: { id: existing.id }, data });
    } else {
      await prisma.cogsInput.create({ data });
    }
  }

  return updateShopCogsCompletion(prisma, input.shopId);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function updateShopCogsCompletion(prisma, shopId) {
  const stats = await calculateCogsCompletion(prisma, shopId);

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      cogsCompletionPercentage: stats.completionPercentage,
      cogsConfidenceLevel: stats.confidenceLevel,
    },
  });

  return stats;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function calculateCogsCompletion(prisma, shopId) {
  const [totalVariants, cogsInputs] = await Promise.all([
    prisma.variant.count({ where: { shopId } }),
    prisma.cogsInput.findMany({
      where: {
        shopId,
        variantId: { not: null },
        effectiveTo: null,
      },
      select: {
        variantId: true,
        confidenceLevel: true,
        confirmedByMerchant: true,
      },
    }),
  ]);

  if (totalVariants === 0) {
    return {
      totalVariants,
      variantsWithCogs: 0,
      completionPercentage: "0.00",
      confidenceLevel: "missing",
    };
  }

  const covered = new Set(cogsInputs.map((input) => input.variantId));
  const confirmed = new Set(
    cogsInputs
      .filter(
        (input) =>
          input.confidenceLevel === "confirmed" && input.confirmedByMerchant,
      )
      .map((input) => input.variantId),
  );
  const completionPercentage = ((covered.size / totalVariants) * 100).toFixed(
    2,
  );
  const confidenceLevel =
    covered.size === 0
      ? "missing"
      : covered.size === totalVariants && confirmed.size === totalVariants
        ? "confirmed"
        : "estimated";

  return {
    totalVariants,
    variantsWithCogs: covered.size,
    completionPercentage,
    confidenceLevel,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function completeOnboarding(prisma, shopId) {
  const stats = await updateShopCogsCompletion(prisma, shopId);
  return prisma.shop.update({
    where: { id: shopId },
    data: {
      onboardingStartedAt: new Date(),
      onboardingCompletedAt: new Date(),
      cogsCompletionPercentage: stats.completionPercentage,
      cogsConfidenceLevel: stats.confidenceLevel,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function getOnboardingState(prisma, shopId) {
  const [shop, backfillProgress, soldUnitCogsCoverage] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        houseRules: {
          where: {
            status: "active",
            title: "Founder House Rules",
          },
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        connectorAccounts: {
          where: {
            connector: "klaviyo",
            status: "active",
          },
          take: 1,
        },
      },
    }),
    getShopBackfillProgress(prisma, { shopId }),
    calculateSoldUnitCogsCoverage(prisma, shopId),
  ]);

  if (!shop) {
    throw new Error(`Shop ${shopId} not found.`);
  }

  const metadata = onboardingMetadata(shop.onboardingMetadata);
  const houseRule = shop.houseRules[0] ?? null;
  const readiness = buildImportReadiness(backfillProgress);
  const klaviyoConnected = shop.connectorAccounts.length > 0;
  const goalsComplete = shop.goalsCompleted;
  const houseRulesComplete = shop.houseRulesCompleted;
  const approvalMode = normalizeApprovalMode(metadata.approvalMode);
  const brandVoice = stringOrNull(
    objectValue(houseRule?.brandVoiceRules).voice,
  );
  const protectedProducts = Array.isArray(houseRule?.protectedProducts)
    ? houseRule.protectedProducts
    : [];
  const criticalRiskCount = await countCriticalOpenRisks(prisma, shopId);
  const winbackAudienceCount = await countWinbackAudience(prisma, shopId);
  const context = {
    metadata,
    readiness,
    goalsComplete,
    houseRulesComplete,
    approvalMode,
    brandVoiceComplete: Boolean(brandVoice),
    klaviyoConnected,
    cogsCoveragePercent: soldUnitCogsCoverage.coveragePercentage,
    protectedProductsConfirmed: protectedProducts.length > 0,
    criticalRiskCount,
    winbackAudienceCount,
  };
  const steps = STEP_DEFINITIONS.map((definition) =>
    buildOnboardingStep(definition, context),
  );
  const requiredSetup = buildRequiredSetup({
    readiness,
    goalsComplete,
    houseRulesComplete,
    approvalMode,
  });
  const merchantRequiredSetup = requiredSetup.filter(
    (item) => item.key !== "store_review",
  );
  const requiredOnboardingComplete = merchantRequiredSetup.every(
    (item) => item.complete,
  );
  const completeSteps = steps.filter((step) =>
    ["complete", "skipped"].includes(step.status),
  ).length;
  const recommendedNextStep = chooseRecommendedNextStep({
    steps,
    readiness,
    cogsCoveragePercent: soldUnitCogsCoverage.coveragePercentage,
    criticalRiskCount,
    klaviyoConnected,
    winbackAudienceCount,
  });

  return {
    overallStatus: overallOnboardingStatus(
      readiness,
      backfillProgress?.historicalOrdersLimited ?? false,
    ),
    progress: {
      completeSteps,
      totalSteps: steps.length,
    },
    requiredProgress: {
      completeSteps: merchantRequiredSetup.filter((item) => item.complete)
        .length,
      totalSteps: merchantRequiredSetup.length,
    },
    requiredSetup,
    requiredOnboardingComplete,
    onboardingComplete: Boolean(shop.onboardingCompletedAt),
    importStatus: readiness.importStatus,
    steps,
    moduleReadiness: buildModuleReadiness({
      readiness,
      cogsCoveragePercent: soldUnitCogsCoverage.coveragePercentage,
      klaviyoConnected,
      goalsComplete,
      houseRulesComplete,
      approvalMode,
    }),
    recommendedNextStep,
    approvalMode,
    cogs: soldUnitCogsCoverage,
    warnings: buildOnboardingWarnings({
      cogsCoveragePercent: soldUnitCogsCoverage.coveragePercentage,
      productCostsSkipped:
        objectValue(metadata.steps.product_costs).status === "skipped",
    }),
    historicalOrdersLimited: backfillProgress?.historicalOrdersLimited ?? false,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
export async function calculateSoldUnitCogsCoverage(prisma, shopId) {
  const lineItems = await prisma.orderLineItem.findMany({
    where: { shopId, variantId: { not: null } },
    select: { variantId: true, quantity: true },
  });
  const variantIds = Array.from(
    new Set(
      lineItems
        .map((lineItem) => lineItem.variantId)
        .filter((variantId) => typeof variantId === "string"),
    ),
  );

  if (lineItems.length === 0 || variantIds.length === 0) {
    const stats = await calculateCogsCompletion(prisma, shopId);

    return {
      soldUnits: 0,
      soldUnitsWithCogs: 0,
      coveragePercentage: Number(stats.completionPercentage),
      basis: "variant_count",
    };
  }

  const cogsInputs = await prisma.cogsInput.findMany({
    where: {
      shopId,
      variantId: { in: variantIds },
      effectiveTo: null,
    },
    select: { variantId: true },
  });
  const coveredVariantIds = new Set(cogsInputs.map((input) => input.variantId));
  const soldUnits = lineItems.reduce(
    (total, lineItem) => total + Math.max(0, lineItem.quantity),
    0,
  );
  const soldUnitsWithCogs = lineItems.reduce(
    (total, lineItem) =>
      coveredVariantIds.has(lineItem.variantId)
        ? total + Math.max(0, lineItem.quantity)
        : total,
    0,
  );

  return {
    soldUnits,
    soldUnitsWithCogs,
    coveragePercentage:
      soldUnits === 0
        ? 0
        : Number(((soldUnitsWithCogs / soldUnits) * 100).toFixed(2)),
    basis: "sold_units",
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; stepKey: string; status: "complete" | "skipped"; metadata?: Record<string, unknown> }} input
 */
export async function setOnboardingStepStatus(prisma, input) {
  if (!ONBOARDING_STEP_KEYS.includes(input.stepKey)) {
    throw new Error("Unknown onboarding step.");
  }
  if (
    input.status === "skipped" &&
    !OPTIONAL_ONBOARDING_STEPS.has(input.stepKey)
  ) {
    throw new Error("This onboarding step cannot be skipped.");
  }

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: input.shopId },
  });
  const now = new Date().toISOString();
  const metadata = onboardingMetadata(shop.onboardingMetadata);
  const current = objectValue(metadata.steps[input.stepKey]);

  metadata.steps[input.stepKey] = {
    ...current,
    status: input.status,
    completedAt:
      input.status === "complete" ? now : (current.completedAt ?? null),
    skippedAt: input.status === "skipped" ? now : (current.skippedAt ?? null),
    updatedAt: now,
    metadata: {
      ...objectValue(current.metadata),
      ...objectValue(input.metadata),
    },
  };

  return prisma.shop.update({
    where: { id: input.shopId },
    data: {
      onboardingStartedAt: shop.onboardingStartedAt ?? new Date(),
      onboardingMetadata: metadata,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; approvalMode: string }} input
 */
export async function saveOnboardingApprovalMode(prisma, input) {
  const approvalMode = normalizeApprovalMode(input.approvalMode);

  if (!approvalMode) {
    throw new Error("Approval mode is invalid.");
  }

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: input.shopId },
  });
  const metadata = onboardingMetadata(shop.onboardingMetadata);

  metadata.approvalMode = approvalMode;

  await prisma.shop.update({
    where: { id: input.shopId },
    data: {
      onboardingStartedAt: shop.onboardingStartedAt ?? new Date(),
      onboardingMetadata: metadata,
    },
  });

  return setOnboardingStepStatus(prisma, {
    shopId: input.shopId,
    stepKey: "approval_mode",
    status: "complete",
    metadata: { approvalMode },
  });
}

/**
 * @param {any} backfillProgress
 */
function buildImportReadiness(backfillProgress) {
  const statusByDomain = backfillProgress?.statuses ?? {};
  /** @param {string} domain */
  const domainStatus = (domain) =>
    importDomainStatus(domain, statusByDomain[domain]);
  const products = domainStatus("products");
  const orders = domainStatus("orders");
  const inventory = domainStatus("inventory");
  const insights = domainStatus("derived_metrics");
  const failed =
    Object.values(statusByDomain).some((status) =>
      ["failed", "bulk_failed"].includes(status?.status ?? ""),
    ) ||
    (backfillProgress?.jobs ?? []).some(
      /** @param {any} job */
      (job) => job.status === "failed",
    );

  return {
    failed,
    productsComplete: products.status === "complete",
    ordersComplete: orders.status === "complete",
    inventoryComplete: inventory.status === "complete",
    insightsComplete: insights.status === "complete",
    risksReady:
      orders.status === "complete" &&
      inventory.status === "complete" &&
      insights.status === "complete",
    importStatus: {
      products,
      orders,
      inventory,
      insights,
    },
  };
}

/**
 * @param {string} domain
 * @param {any} status
 */
function importDomainStatus(domain, status) {
  const rawStatus = status?.status ?? "waiting";
  const failed = rawStatus === "failed" || rawStatus === "bulk_failed";
  const complete = rawStatus === "complete" || rawStatus === "bulk_imported";
  const waiting = rawStatus === "queued" || rawStatus === "waiting";
  const label = importStatusLabel(domain);

  if (failed) {
    return {
      key: domain === "derived_metrics" ? "insights" : domain,
      label,
      status: "failed",
      reason: `${label} import needs attention.`,
    };
  }
  if (complete) {
    return {
      key: domain === "derived_metrics" ? "insights" : domain,
      label,
      status: "complete",
      reason:
        domain === "products"
          ? "Products are ready. You can now confirm product costs."
          : `${label} ${pluralImportLabel(label) ? "are" : "is"} ready.`,
    };
  }
  if (waiting) {
    return {
      key: domain === "derived_metrics" ? "insights" : domain,
      label,
      status: "waiting",
      reason: `${label} will unlock shortly.`,
    };
  }

  return {
    key: domain === "derived_metrics" ? "insights" : domain,
    label,
    status: "importing",
    reason:
      domain === "orders"
        ? "Order history is still importing. Revenue and winback insights will unlock shortly."
        : `${label} is importing.`,
  };
}

/** @param {string} label */
function pluralImportLabel(label) {
  return ["Products", "Orders", "Insights"].includes(label);
}

/** @param {string} domain */
function importStatusLabel(domain) {
  if (domain === "derived_metrics") return "Insights";
  return formatLabel(domain);
}

/** @param {unknown} value */
function formatLabel(value) {
  const label = String(value).replace(/_/g, " ");

  return label[0].toUpperCase() + label.slice(1);
}

/**
 * @param {any} definition
 * @param {any} context
 */
function buildOnboardingStep(definition, context) {
  const stored = objectValue(context.metadata.steps[definition.key]);
  const storedStatus = stored.status;
  const unlocked = isStepUnlocked(definition.key, context.readiness);
  const href = definition.href;
  const base = {
    key: definition.key,
    label: definition.label,
    description: definition.description,
    status: "locked",
    unlockReason: unlockReason(definition.key),
    href,
    primary: false,
    requiredData: definition.requiredData,
    skippable: OPTIONAL_ONBOARDING_STEPS.has(definition.key),
  };

  if (!unlocked) return base;
  if (storedStatus === "skipped") {
    return {
      ...base,
      status: "skipped",
      unlockReason: null,
    };
  }

  if (isStepAutomaticallyComplete(definition.key, context, storedStatus)) {
    return {
      ...base,
      status: "complete",
      unlockReason: null,
    };
  }

  if (definition.key === "product_costs" && context.cogsCoveragePercent < 50) {
    return {
      ...base,
      status: "needs_attention",
      unlockReason:
        "Margin confidence is limited because product costs are missing for most sold units.",
    };
  }

  return {
    ...base,
    status: "available",
    unlockReason: null,
  };
}

/**
 * @param {string} stepKey
 * @param {any} readiness
 */
function isStepUnlocked(stepKey, readiness) {
  if (["product_costs", "protected_products"].includes(stepKey)) {
    return readiness.productsComplete;
  }
  if (stepKey === "first_risks") return readiness.risksReady;
  if (stepKey === "first_daily_brief") return readiness.insightsComplete;
  return true;
}

/** @param {string} stepKey */
function unlockReason(stepKey) {
  if (["product_costs", "protected_products"].includes(stepKey)) {
    return "Available when products finish importing.";
  }
  if (stepKey === "first_risks") {
    return "Available when orders, inventory and insights are ready.";
  }
  if (stepKey === "first_daily_brief") {
    return "Available when insights are ready.";
  }
  return null;
}

/**
 * @param {string} stepKey
 * @param {any} context
 * @param {unknown} storedStatus
 */
function isStepAutomaticallyComplete(stepKey, context, storedStatus) {
  if (storedStatus === "complete") return true;
  if (stepKey === "business_goal") return context.goalsComplete;
  if (stepKey === "house_rules") return context.houseRulesComplete;
  if (stepKey === "approval_mode") return Boolean(context.approvalMode);
  if (stepKey === "brand_voice") return context.brandVoiceComplete;
  if (stepKey === "klaviyo") return context.klaviyoConnected;
  if (stepKey === "product_costs") return context.cogsCoveragePercent >= 80;
  if (stepKey === "protected_products") {
    return context.protectedProductsConfirmed;
  }
  return false;
}

/** @param {any} input */
function chooseRecommendedNextStep(input) {
  if (input.readiness.failed) {
    return {
      key: "retry_backfill",
      label: "Retry backfill",
      reason: "Shopify import needs attention before Jefe can finish setup.",
      href: "/app/daily-brief",
    };
  }

  const byKey = Object.fromEntries(
    input.steps.map(
      /** @param {any} step */
      (step) => [step.key, step],
    ),
  );
  const immediateStep = input.steps.find(
    /** @param {any} step */
    (step) =>
      ["business_goal", "house_rules", "approval_mode", "brand_voice"].includes(
        step.key,
      ) && ["available", "needs_attention"].includes(step.status),
  );

  if (!input.readiness.insightsComplete && immediateStep) {
    return recommendationFromStep(
      immediateStep,
      "You can teach Jefe your operating rules while Shopify data imports.",
    );
  }
  if (["available", "needs_attention"].includes(byKey.house_rules?.status)) {
    return recommendationFromStep(
      byKey.house_rules,
      "Jefe needs House Rules before it can recommend bounded actions.",
    );
  }
  if (["available", "needs_attention"].includes(byKey.business_goal?.status)) {
    return recommendationFromStep(
      byKey.business_goal,
      "Jefe needs a founder-defined goal before judging useful work.",
    );
  }
  if (
    ["available", "needs_attention"].includes(byKey.product_costs?.status) &&
    input.cogsCoveragePercent < 80
  ) {
    return recommendationFromStep(
      byKey.product_costs,
      "Revenue & Margin is limited until sold-unit COGS coverage reaches 80%.",
    );
  }
  if (
    ["available", "needs_attention"].includes(byKey.protected_products?.status)
  ) {
    return recommendationFromStep(
      byKey.protected_products,
      "Protected hero products keep future discount recommendations inside your rules.",
    );
  }
  if (
    ["available", "needs_attention"].includes(byKey.first_risks?.status) &&
    input.criticalRiskCount > 0
  ) {
    return recommendationFromStep(
      byKey.first_risks,
      "Jefe found a critical risk worth reviewing.",
    );
  }
  if (
    ["available", "needs_attention"].includes(byKey.klaviyo?.status) &&
    !input.klaviyoConnected &&
    input.winbackAudienceCount > 0
  ) {
    return recommendationFromStep(
      byKey.klaviyo,
      "A winback audience is available once Klaviyo is connected.",
    );
  }
  if (
    ["available", "needs_attention"].includes(byKey.first_daily_brief?.status)
  ) {
    return recommendationFromStep(
      byKey.first_daily_brief,
      "Your first Daily Brief is ready to review.",
    );
  }

  return {
    key: "review_daily_brief",
    label: "Review Daily Brief",
    reason: "Jefe has enough setup to show the current store verdict.",
    href: "/app/daily-brief",
  };
}

/**
 * @param {any} step
 * @param {string} reason
 */
function recommendationFromStep(step, reason) {
  return {
    key: step.key,
    label: step.label,
    reason,
    href: step.href,
  };
}

/** @param {any} input */
function buildModuleReadiness(input) {
  const dailyBriefReady = input.readiness.insightsComplete;
  const cogsMissing = input.cogsCoveragePercent < 80;

  return [
    {
      key: "daily_brief",
      label: "Daily Brief",
      status: dailyBriefReady ? "ready" : "waiting",
      reason: dailyBriefReady
        ? "Ready"
        : "Waiting for insights to finish importing.",
      href: "/app/daily-brief",
    },
    {
      key: "revenue_margin",
      label: "Revenue & Margin",
      status:
        dailyBriefReady && cogsMissing
          ? "limited"
          : dailyBriefReady
            ? "ready"
            : "waiting",
      reason:
        dailyBriefReady && cogsMissing
          ? "Limited because product costs are missing."
          : dailyBriefReady
            ? "Ready"
            : "Waiting for order history and insights.",
      href: "/app/revenue-margin",
    },
    {
      key: "inventory_guardian",
      label: "Inventory Guardian",
      status:
        input.readiness.productsComplete && input.readiness.inventoryComplete
          ? "ready"
          : "waiting",
      reason:
        input.readiness.productsComplete && input.readiness.inventoryComplete
          ? "Ready"
          : "Waiting for products and inventory.",
      href: "/app/inventory-guardian",
    },
    {
      key: "watchdog",
      label: "Watchdog",
      status:
        input.readiness.ordersComplete && input.readiness.insightsComplete
          ? "ready"
          : "waiting",
      reason:
        input.readiness.ordersComplete && input.readiness.insightsComplete
          ? "Ready"
          : "Waiting for order history and insights.",
      href: "/app/watchdog",
    },
    {
      key: "klaviyo_winback",
      label: "Klaviyo Winback",
      status: klaviyoWinbackReadinessStatus(input),
      reason: klaviyoWinbackReadinessReason(input),
      href: "/app/klaviyo-winback",
    },
    {
      key: "manager_settings",
      label: "Manager Settings",
      status:
        input.goalsComplete && input.houseRulesComplete && input.approvalMode
          ? "ready"
          : "needs_review",
      reason:
        input.goalsComplete && input.houseRulesComplete && input.approvalMode
          ? "Ready"
          : "Needs goals, House Rules and approval mode.",
      href: "/app/onboarding",
    },
  ];
}

/** @param {any} input */
function buildRequiredSetup(input) {
  return [
    {
      key: "store_review",
      label: "Store review",
      complete:
        input.readiness.productsComplete &&
        input.readiness.ordersComplete &&
        input.readiness.insightsComplete,
      href: "/app/onboarding",
      reason: input.readiness.failed
        ? "Shopify import needs attention."
        : "Jefe needs products, order history and insights before opening the app.",
    },
    {
      key: "business_goal",
      label: "Confirm business goals",
      complete: input.goalsComplete,
      href: "/app/onboarding?task=goal",
      reason: "Tell Jefe what the store is trying to improve.",
    },
    {
      key: "house_rules",
      label: "Review House Rules",
      complete: input.houseRulesComplete,
      href: "/app/onboarding?task=house-rules",
      reason:
        "Set the boundaries Jefe must follow before recommending actions.",
    },
    {
      key: "approval_mode",
      label: "Confirm approval mode",
      complete: Boolean(input.approvalMode),
      href: "/app/onboarding?task=approval-mode",
      reason: "Choose how cautious Jefe should be with recommendations.",
    },
  ];
}

/** @param {{ cogsCoveragePercent: number; productCostsSkipped: boolean }} input */
function buildOnboardingWarnings(input) {
  const warnings = [];

  if (input.productCostsSkipped || input.cogsCoveragePercent < 80) {
    warnings.push({
      key: "margin_limited",
      message: "Margin insights will be limited until product costs are added.",
    });
  }

  return warnings;
}

/** @param {any} input */
function klaviyoWinbackReadinessStatus(input) {
  if (!input.klaviyoConnected) return "needs_klaviyo";
  if (!input.readiness.ordersComplete) return "waiting";
  return "ready";
}

/** @param {any} input */
function klaviyoWinbackReadinessReason(input) {
  if (!input.klaviyoConnected) return "Needs Klaviyo.";
  if (!input.readiness.ordersComplete) return "Waiting for order history.";
  return "Ready";
}

/**
 * @param {any} readiness
 * @param {boolean} historicalOrdersLimited
 */
function overallOnboardingStatus(readiness, historicalOrdersLimited) {
  if (readiness.failed) return "failed";
  if (historicalOrdersLimited && readiness.insightsComplete) return "partial";
  if (readiness.insightsComplete) return "ready";
  return "importing";
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
async function countCriticalOpenRisks(prisma, shopId) {
  return prisma.action.count({
    where: {
      shopId,
      riskLevel: "critical",
      status: { in: ["proposed", "needs_approval", "approved"] },
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopId
 */
async function countWinbackAudience(prisma, shopId) {
  return prisma.customerIdentity.count({
    where: {
      shopId,
      orderCount: { gt: 0 },
    },
  });
}

/** @param {unknown} value */
function onboardingMetadata(value) {
  const metadata = objectValue(value);

  return {
    ...metadata,
    steps: objectValue(metadata.steps),
    approvalMode: normalizeApprovalMode(metadata.approvalMode),
  };
}

/** @param {unknown} value */
function normalizeApprovalMode(value) {
  const normalized = stringOrNull(value);

  return normalized && APPROVAL_MODES.includes(normalized) ? normalized : null;
}

/**
 * @param {unknown} value
 */
export function splitList(value) {
  if (typeof value !== "string") return [];

  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} value
 */
export function normalizeCogsConfidence(value) {
  return COGS_CONFIDENCE_LEVELS.includes(String(value))
    ? String(value)
    : "missing";
}

/**
 * @param {unknown} value
 */
function percentToBps(value, fieldName = "Percentage") {
  const number = percentOrNull(value, fieldName);

  return number === null ? null : Math.round(number * 100);
}

/**
 * @param {number | null | undefined} value
 */
function bpsToPercentString(value) {
  return value === null || value === undefined
    ? undefined
    : String(value / 100);
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 */
function percentOrNull(value, fieldName) {
  const number = numberOrNull(value);

  if (number === null) return null;

  if (number < 0 || number > 100) {
    throw new Error(`${fieldName} must be between 0 and 100.`);
  }

  return number;
}

/**
 * @param {unknown} value
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 */
function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {...unknown} values
 */
function firstDefined(...values) {
  return values.find(
    (value) => value !== null && value !== undefined && value !== "",
  );
}

/**
 * @param {unknown} value
 * @param {string} key
 */
function jsonValue(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = /** @type {Record<string, unknown>} */ (value);

  return record[key];
}

/**
 * @param {unknown} value
 */
function booleanValue(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 */
function positiveIntegerOrNull(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return parsed;
}

/**
 * @param {unknown} value
 * @param {string[]} allowedValues
 * @param {string} fieldName
 */
function enumOrNull(value, allowedValues, fieldName) {
  const normalized = stringOrNull(value);

  if (normalized === null) return null;

  if (!allowedValues.includes(normalized)) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 */
function normalizeEmailFrequencyScope(value, fieldName) {
  const normalized = stringOrNull(value);

  if (normalized === null) return null;

  /** @type {Record<string, string>} */
  const legacyScopeMap = {
    per_customer: "per_customer_per_week",
    per_segment: "per_segment_per_week",
    per_week: "per_customer_per_week",
  };
  const mapped = legacyScopeMap[normalized] ?? normalized;

  return enumOrNull(mapped, EMAIL_FREQUENCY_SCOPES, fieldName);
}

/**
 * @param {import("@prisma/client").HouseRule} houseRule
 */
function buildMerchantPolicyContext(houseRule) {
  const structuredRules = objectValue(houseRule.structuredRules);
  const emailRules = objectValue(houseRule.emailFrequencyRules);
  const marginRules = objectValue(houseRule.marginPriorityRules);
  const seasonalPriorities = objectValue(houseRule.seasonalPriorities);
  const riskyActionRules = objectValue(houseRule.riskyActionRules);
  const brandVoiceRules = objectValue(houseRule.brandVoiceRules);

  return {
    policyVersion: "house_rules_v1",
    sourceHouseRuleId: houseRule.id,
    shopId: houseRule.shopId,
    discounts: {
      maxDefaultDiscountBps: houseRule.maxDefaultDiscountBps,
      maxWinbackDiscountBps: houseRule.maxWinbackDiscountBps,
      allowWinbackDiscountAboveDefault:
        houseRule.allowWinbackDiscountAboveDefault,
    },
    email: {
      maxEmailsPerCustomer: emailRules.maxEmailsPerCustomer ?? null,
      frequencyScope: houseRule.emailFrequencyScope,
      cooldownDays: houseRule.emailCooldownDays,
    },
    approval: {
      maxCampaignAudienceSize: houseRule.maxCampaignAudienceSize,
      actionsRequiringExtraApproval:
        riskyActionRules.actionsRequiringExtraApproval ?? null,
    },
    margin: {
      minimumMarginPercent: marginRules.minimumMarginPercent ?? null,
      priorityMode: marginRules.priorityMode ?? null,
    },
    products: {
      neverDiscountedSkus: structuredRules.neverDiscountedSkus ?? [],
      protectedProducts: houseRule.protectedProducts,
    },
    brand: {
      voice: brandVoiceRules.voice ?? null,
    },
    seasonal: {
      bfcmFreezeMode: houseRule.bfcmFreezeMode,
      riskyPeriods: seasonalPriorities.riskyPeriods ?? [],
    },
    freeTextRules: houseRule.freeTextRules,
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * @param {unknown} value
 */
function decimalStringOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(4) : null;
}

/**
 * @param {Record<string, unknown>} rules
 */
function hasMeaningfulHouseRules(rules) {
  return Object.values(rules).some((value) => {
    if (typeof value !== "string") return value !== null && value !== undefined;

    return value.trim().length > 0;
  });
}
