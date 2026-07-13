// @ts-check

import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server.js";
import {
  EMAIL_FREQUENCY_SCOPES,
  HOUSE_RULE_DEFAULTS,
} from "./house-rules-policy.js";
export { HOUSE_RULE_DEFAULTS } from "./house-rules-policy.js";

/** @type {import("@prisma/client").GoalHorizon[]} */
export const GOAL_HORIZONS = ["THREE_MONTHS", "SIX_MONTHS", "TWELVE_MONTHS"];
export const COGS_CONFIDENCE_LEVELS = ["missing", "estimated", "confirmed"];

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
      goalsCompleted: goals.every(
        (goal) => goal.description !== "Not set yet",
      ),
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
  const completionPercentage = (
    (covered.size / totalVariants) *
    100
  ).toFixed(2);
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
  return value === null || value === undefined ? undefined : String(value / 100);
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
