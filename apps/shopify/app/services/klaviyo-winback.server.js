// @ts-check

import crypto from "node:crypto";

import { prepareKlaviyoWinbackDraft } from "../lib/klaviyo/adapter.server.js";
import { HOUSE_RULE_DEFAULTS } from "./house-rules-policy.js";
import { loadMerchantPolicyContext } from "./onboarding.server.js";

export const KLAVIYO_CONNECTOR = "klaviyo";
export const WINBACK_ACTION_TYPE = "klaviyo_winback";
export const WINBACK_DORMANT_MIN_DAYS = 60;
export const WINBACK_DORMANT_MAX_DAYS = 180;
export const WINBACK_HOLDOUT_PERCENT = 10;
export const WINBACK_FORMULA_VERSION = "klaviyo_winback_v0";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; privateKey: string; now?: Date }} input
 */
export async function connectKlaviyoPrivateKey(prisma, input) {
  const privateKey = input.privateKey.trim();
  if (privateKey.length < 12) {
    throw new Error("Klaviyo private key looks too short.");
  }

  const now = input.now ?? new Date();
  const keyFingerprint = sha256(privateKey).slice(0, 16);
  const keySuffix = privateKey.slice(-4);
  const tokenRef = `klaviyo_private_key:${input.shopId}:${keyFingerprint}`;
  const accountExternalId = `shop:${input.shopId}`;

  const connectorAccount = await prisma.connectorAccount.upsert({
    where: {
      merchantId_connector_accountExternalId: {
        merchantId: input.merchantId,
        connector: KLAVIYO_CONNECTOR,
        accountExternalId,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      connector: KLAVIYO_CONNECTOR,
      accountExternalId,
      status: "active",
      scopes: ["profiles:read", "campaigns:write:draft"],
      writeTokenRef: tokenRef,
      authMetadata: {
        mode: "merchant_private_key",
        maskedKey: maskSecret(privateKey),
        keySuffix,
        keyFingerprint,
        lastCheckedAt: now.toISOString(),
        secretStorage: "external_secret_required",
      },
      connectedAt: now,
      rawPayload: { source: "manager_settings", secretStoredInDb: false },
    },
    update: {
      shopId: input.shopId,
      status: "active",
      scopes: ["profiles:read", "campaigns:write:draft"],
      writeTokenRef: tokenRef,
      authMetadata: {
        mode: "merchant_private_key",
        maskedKey: maskSecret(privateKey),
        keySuffix,
        keyFingerprint,
        lastCheckedAt: now.toISOString(),
        secretStorage: "external_secret_required",
      },
      connectedAt: now,
      rawPayload: { source: "manager_settings", secretStoredInDb: false },
    },
  });

  await recordLedgerEvent(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    eventType: "connector.klaviyo.connected",
    dedupeKey: `klaviyo-connected:${input.shopId}:${keyFingerprint}`,
    idempotencyKey: `klaviyo-connected:${input.shopId}:${keyFingerprint}`,
    payload: {
      connectorAccountId: connectorAccount.id,
      connector: KLAVIYO_CONNECTOR,
      maskedKey: maskSecret(privateKey),
      secretStoredInDb: false,
    },
  });

  return connectorAccount;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function disconnectKlaviyo(prisma, input) {
  const account = await loadKlaviyoConnection(prisma, input);
  if (!account) return null;

  const disconnected = await prisma.connectorAccount.update({
    where: { id: account.id },
    data: {
      status: "disconnected",
      readTokenRef: null,
      writeTokenRef: null,
      authMetadata: {
        ...(objectValue(account.authMetadata)),
        disconnectedAt: new Date().toISOString(),
      },
    },
  });

  await recordLedgerEvent(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    eventType: "connector.klaviyo.disconnected",
    dedupeKey: `klaviyo-disconnected:${input.shopId}:${Date.now()}`,
    idempotencyKey: `klaviyo-disconnected:${input.shopId}:${Date.now()}`,
    payload: {
      connectorAccountId: account.id,
      connector: KLAVIYO_CONNECTOR,
    },
  });

  return disconnected;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function getWinbackDashboard(prisma, input) {
  const [connection, proposal, actions] = await Promise.all([
    loadKlaviyoConnection(prisma, input),
    buildWinbackProposal(prisma, input),
    prisma.action.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionType: WINBACK_ACTION_TYPE,
      },
      orderBy: { proposedAt: "desc" },
      take: 5,
      include: {
        executions: { orderBy: { createdAt: "desc" }, take: 1 },
        holdoutAssignments: true,
      },
    }),
  ]);

  return {
    connection: serializeConnection(connection),
    proposal,
    actions: actions.map(serializeAction),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function buildWinbackProposal(prisma, input) {
  const now = input.now ?? new Date();
  const [orders, policy] = await Promise.all([
    prisma.order.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        processedAt: {
          gte: daysAgo(now, WINBACK_DORMANT_MAX_DAYS),
          lt: now,
        },
      },
      include: { lineItems: { include: { product: true, variant: true } } },
      orderBy: { processedAt: "desc" },
    }),
    loadMerchantPolicyContext(prisma, input.shopId),
  ]);

  const allCustomers = dormantCustomersFromOrders(orders, now);
  const orderDiagnostics = diagnoseWinbackOrderInputs(orders, now);
  const caps = policyCaps(policy);
  const eligibleAudience = allCustomers.slice(0, caps.maxCampaignAudienceSize);
  const overflowCount = Math.max(
    0,
    allCustomers.length - caps.maxCampaignAudienceSize,
  );
  const blockedReasons = [];
  if (caps.bfcmFreezeMode) {
    blockedReasons.push("BFCM/freeze mode is active.");
  }
  if (eligibleAudience.length === 0) {
    blockedReasons.push(winbackEmptyAudienceReason(orderDiagnostics));
  }

  const averageOrderValue = average(
    eligibleAudience.map((customer) => customer.averageOrderValue),
  );
  const discountPercent = caps.maxAllowedWinbackDiscountBps / 100;
  const estimates = estimateWinbackValue({
    audienceSize: eligibleAudience.length,
    averageOrderValue,
    discountPercent,
  });
  const formattedDiscount = formatPercent(discountPercent);
  const holdoutCount = Math.ceil(
    eligibleAudience.length * (WINBACK_HOLDOUT_PERCENT / 100),
  );
  const treatmentCount = Math.max(0, eligibleAudience.length - holdoutCount);
  const riskLevel =
    overflowCount > 0 || treatmentCount > caps.maxCampaignAudienceSize
      ? "high"
      : treatmentCount >= 250
        ? "medium"
        : "low";
  const rulesConsulted = rulesConsultedFromPolicy(policy);
  const capsApplied = capsAppliedFromPolicy({
    policy,
    caps,
    eligibleCount: allCustomers.length,
    includedCount: eligibleAudience.length,
    overflowCount,
    discountPercent,
  });
  const assignmentSeed = winbackIdempotencyKey(input.shopId, now);
  const groupAssignments = exactHoldoutAssignments(
    assignmentSeed,
    eligibleAudience,
  );

  return {
    status: blockedReasons.length > 0 ? "blocked" : "ready",
    blockedReasons,
    generatedAt: now.toISOString(),
    formulaVersion: WINBACK_FORMULA_VERSION,
    verificationClass: "estimated",
    plannedVerification: "10% randomised holdout",
    audience: {
      eligibleCount: allCustomers.length,
      includedCount: eligibleAudience.length,
      overflowCount,
      treatmentCount,
      holdoutCount,
      dormantWindowDays: {
        min: WINBACK_DORMANT_MIN_DAYS,
        max: WINBACK_DORMANT_MAX_DAYS,
      },
      diagnostics: orderDiagnostics,
      sample: eligibleAudience.slice(0, 5).map((customer) =>
        redactedCustomerView(customer, groupAssignments.get(customer.emailHash)),
      ),
    },
    economics: {
      currency: firstCurrency(orders) ?? "GBP",
      averageOrderValue,
      estimatedConversionRate: {
        low: 0.02,
        base: 0.05,
        high: 0.08,
      },
      expectedRevenue: estimates.expectedRevenue,
      estimatedDiscountCost: estimates.discountCost,
      expectedRevenueAfterDiscount: estimates.revenueAfterDiscount,
      discountPercent,
      assumptions: [
        "Estimated conversion range is 2%-8%, with 5% as the base case.",
        "Discount cost is estimated from previous average order value.",
        "This is not verified lift until the holdout result is measured.",
      ],
    },
    preview: {
      campaignName: `Dormant customer winback ${dateOnly(now)}`,
      subjectLine: `A ${formattedDiscount} thank-you for coming back`,
      previewText: `${formattedDiscount} off your next order, just in case now is a good time to come back.`,
      headline: `Here is ${formattedDiscount} off your next order`,
      bodySummary:
        `We noticed it has been a while since your last order. Here is ${formattedDiscount} off your next purchase.`,
      bodyCopy: [
        "We noticed it has been a while since your last order.",
        `As a thank-you for shopping with us before, here is ${formattedDiscount} off your next purchase.`,
        "No pressure. If now is a good time to come back, your offer is ready.",
      ],
      ctaText: `Shop with ${formattedDiscount} off`,
      footerNote: "You are receiving this because you previously placed an order with us.",
      discount: `${formattedDiscount} off`,
      stagedSend: [
        {
          stage: "pilot",
          percentOfTreatment: 10,
          requiresApproval: true,
        },
        {
          stage: "rollout",
          percentOfTreatment: 90,
          requiresApproval: true,
        },
      ],
      approvalRequired: true,
      noAutomaticSend: true,
    },
    rulesConsulted,
    capsApplied,
    riskLevel,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function createWinbackProposal(prisma, input) {
  const now = input.now ?? new Date();
  const connection = await loadKlaviyoConnection(prisma, input);
  const proposal = await buildWinbackProposal(prisma, { ...input, now });
  const idempotencyKey = winbackIdempotencyKey(input.shopId, now);
  const status = proposal.status === "blocked" ? "blocked" : "draft_prepared";

  const action = await prisma.action.upsert({
    where: {
      merchantId_idempotencyKey: {
        merchantId: input.merchantId,
        idempotencyKey,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: WINBACK_ACTION_TYPE,
      status,
      expectedValue: proposal.economics,
      confidence: "0.5500",
      riskLevel: proposal.riskLevel,
      evidence: [
        {
          source: "orders",
          formulaVersion: WINBACK_FORMULA_VERSION,
          dormantWindowDays: proposal.audience.dormantWindowDays,
          eligibleCustomers: proposal.audience.eligibleCount,
        },
      ],
      rulesConsulted: proposal.rulesConsulted,
      ruleConstraintsApplied: proposal.capsApplied,
      preview: proposal.preview,
      verificationClass: "ESTIMATED",
      idempotencyKey,
      proposedAt: now,
    },
    update: {
      status,
      approvedAt: null,
      expectedValue: proposal.economics,
      confidence: "0.5500",
      riskLevel: proposal.riskLevel,
      evidence: [
        {
          source: "orders",
          formulaVersion: WINBACK_FORMULA_VERSION,
          dormantWindowDays: proposal.audience.dormantWindowDays,
          eligibleCustomers: proposal.audience.eligibleCount,
        },
      ],
      rulesConsulted: proposal.rulesConsulted,
      ruleConstraintsApplied: proposal.capsApplied,
      preview: proposal.preview,
      verificationClass: "ESTIMATED",
      proposedAt: now,
    },
  });

  await recordLedgerEvent(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    eventType: "action.klaviyo_winback.draft_prepared",
    dedupeKey: `action-proposed:${action.id}`,
    idempotencyKey: `action-proposed:${action.id}`,
    payload: {
      actionId: action.id,
      status,
      formulaVersion: WINBACK_FORMULA_VERSION,
      verificationClass: "estimated",
      eligibleCustomers: proposal.audience.eligibleCount,
      includedCustomers: proposal.audience.includedCount,
      holdoutPercent: WINBACK_HOLDOUT_PERCENT,
    },
  });

  if (proposal.status !== "blocked") {
    await persistHoldouts(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: action.id,
      now,
      customers: await includedAudienceForAction(prisma, input, now),
      assignmentSeed: idempotencyKey,
    });

    const executionIdempotencyKey = `klaviyo-draft:${action.id}`;
    const response = await prepareKlaviyoWinbackDraft({
      actionId: action.id,
      idempotencyKey: executionIdempotencyKey,
      privateKeyRef: connection?.writeTokenRef ?? null,
      dryRun: true,
      campaignName: proposal.preview.campaignName,
      discountPercent: proposal.economics.discountPercent,
      audience: {
        treatmentCount: proposal.audience.treatmentCount,
        holdoutCount: proposal.audience.holdoutCount,
      },
      stagedSend: proposal.preview.stagedSend,
    });

    await prisma.execution.upsert({
      where: {
        merchantId_idempotencyKey: {
          merchantId: input.merchantId,
          idempotencyKey: executionIdempotencyKey,
        },
      },
      create: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: action.id,
        status: "draft_prepared",
        connector: KLAVIYO_CONNECTOR,
        idempotencyKey: executionIdempotencyKey,
        dryRun: true,
        request: {
          actionType: WINBACK_ACTION_TYPE,
          noAutomaticSend: true,
          connectionStatus: connection?.status ?? "missing",
        },
        response: toJson(response),
        completedAt: now,
      },
      update: {
        status: "draft_prepared",
        dryRun: true,
        request: {
          actionType: WINBACK_ACTION_TYPE,
          noAutomaticSend: true,
          connectionStatus: connection?.status ?? "missing",
        },
        response: toJson(response),
        completedAt: now,
      },
    });
  }

  return prisma.action.findUniqueOrThrow({
    where: { id: action.id },
    include: { executions: true, holdoutAssignments: true },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; now?: Date }} input
 */
export async function approveWinbackProposal(prisma, input) {
  const now = input.now ?? new Date();
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: WINBACK_ACTION_TYPE,
      status: { in: ["draft_prepared", "needs_approval"] },
    },
  });

  const approved = await prisma.action.update({
    where: { id: action.id },
    data: {
      status: "approved",
      approvedAt: now,
    },
  });

  await recordLedgerEvent(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    eventType: "action.klaviyo_winback.approved",
    dedupeKey: `action-approved:${action.id}`,
    idempotencyKey: `action-approved:${action.id}`,
    payload: {
      actionId: action.id,
      noAutomaticSend: true,
      nextStep: "manual Klaviyo draft review/send remains required",
    },
  });

  return approved;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
async function loadKlaviyoConnection(prisma, input) {
  return prisma.connectorAccount.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      connector: KLAVIYO_CONNECTOR,
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 * @param {Date} now
 */
async function includedAudienceForAction(prisma, input, now) {
  const [orders, policy] = await Promise.all([
    prisma.order.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        processedAt: {
          gte: daysAgo(now, WINBACK_DORMANT_MAX_DAYS),
          lt: now,
        },
      },
      include: { lineItems: { include: { product: true, variant: true } } },
      orderBy: { processedAt: "desc" },
    }),
    loadMerchantPolicyContext(prisma, input.shopId),
  ]);

  return dormantCustomersFromOrders(orders, now).slice(
    0,
    policyCaps(policy).maxCampaignAudienceSize,
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; assignmentSeed: string; now: Date; customers: ReturnType<typeof dormantCustomersFromOrders> }} input
 */
async function persistHoldouts(prisma, input) {
  const assignments = exactHoldoutAssignments(
    input.assignmentSeed,
    input.customers,
  );

  for (const customer of input.customers) {
    const group = assignments.get(customer.emailHash) ?? "treatment";
    await prisma.holdoutAssignment.upsert({
      where: {
        merchantId_dedupeKey: {
          merchantId: input.merchantId,
          dedupeKey: `winback:${input.actionId}:${customer.emailHash}`,
        },
      },
      create: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        subjectType: "customer",
        subjectId: customer.emailHash,
        subjectExternalId: customer.customerExternalId,
        assignmentGroup: group,
        dedupeKey: `winback:${input.actionId}:${customer.emailHash}`,
        metadata: toJson({
          maskedEmail: customer.maskedEmail,
          lastOrderDate: customer.lastOrderDate,
          daysSinceLastOrder: customer.daysSinceLastOrder,
          previousOrderCount: customer.previousOrderCount,
          previousTotalSpend: customer.previousTotalSpend,
          averageOrderValue: customer.averageOrderValue,
          productsBought: customer.productsBought,
        }),
        assignedAt: input.now,
      },
      update: {
        assignmentGroup: group,
        metadata: toJson({
          maskedEmail: customer.maskedEmail,
          lastOrderDate: customer.lastOrderDate,
          daysSinceLastOrder: customer.daysSinceLastOrder,
          previousOrderCount: customer.previousOrderCount,
          previousTotalSpend: customer.previousTotalSpend,
          averageOrderValue: customer.averageOrderValue,
          productsBought: customer.productsBought,
        }),
      },
    });
  }
}

/**
 * @param {Array<any>} orders
 * @param {Date} now
 * @returns {Array<ReturnType<typeof summarizeCustomer>>}
 */
export function dormantCustomersFromOrders(orders, now = new Date()) {
  const customers = new Map();

  for (const order of orders) {
    if (!order.processedAt) continue;
    const email = extractEmail(order.rawPayload);
    if (!email) continue;
    if (isSuppressed(order.rawPayload)) continue;

    const normalizedEmail = email.trim().toLowerCase();
    const customerKey = sha256(normalizedEmail);
    const current =
      customers.get(customerKey) ??
      emptyCustomer({
        customerExternalId: order.customerExternalId ?? null,
        email: normalizedEmail,
        currency: order.currency ?? "GBP",
      });
    if (!current.customerExternalId && order.customerExternalId) {
      current.customerExternalId = order.customerExternalId;
    }
    const orderTotal = money(order.totalPrice);
    const processedAt = new Date(order.processedAt);

    current.orders.push({
      processedAt,
      totalPrice: orderTotal,
      products: productsForOrder(order),
    });
    current.previousTotalSpend += orderTotal;
    current.currency = order.currency ?? current.currency;
    customers.set(customerKey, current);
  }

  return Array.from(customers.values())
    .map((customer) => summarizeCustomer(customer, now))
    .filter((customer) => {
      return (
        customer.daysSinceLastOrder >= WINBACK_DORMANT_MIN_DAYS &&
        customer.daysSinceLastOrder <= WINBACK_DORMANT_MAX_DAYS
      );
    })
    .sort((a, b) => {
      if (b.previousTotalSpend !== a.previousTotalSpend) {
        return b.previousTotalSpend - a.previousTotalSpend;
      }

      return a.emailHash.localeCompare(b.emailHash);
    });
}

/**
 * @param {Array<any>} orders
 * @param {Date} now
 */
export function diagnoseWinbackOrderInputs(orders, now = new Date()) {
  let ordersInDormantWindow = 0;
  let ordersWithUsableEmail = 0;
  let ordersInDormantWindowWithUsableEmail = 0;
  let recentOrderCount = 0;

  for (const order of orders) {
    if (!order.processedAt) continue;
    const daysSinceOrder = Math.floor(
      (now.getTime() - new Date(order.processedAt).getTime()) / 86400000,
    );
    const hasUsableEmail = Boolean(extractEmail(order.rawPayload)) &&
      !isSuppressed(order.rawPayload);
    const inDormantWindow =
      daysSinceOrder >= WINBACK_DORMANT_MIN_DAYS &&
      daysSinceOrder <= WINBACK_DORMANT_MAX_DAYS;

    if (daysSinceOrder < WINBACK_DORMANT_MIN_DAYS) {
      recentOrderCount += 1;
    }
    if (hasUsableEmail) {
      ordersWithUsableEmail += 1;
    }
    if (inDormantWindow) {
      ordersInDormantWindow += 1;
    }
    if (inDormantWindow && hasUsableEmail) {
      ordersInDormantWindowWithUsableEmail += 1;
    }
  }

  return {
    totalOrdersChecked: orders.length,
    recentOrderCount,
    ordersInDormantWindow,
    ordersWithUsableEmail,
    ordersInDormantWindowWithUsableEmail,
  };
}

/** @param {ReturnType<typeof diagnoseWinbackOrderInputs>} diagnostics */
function winbackEmptyAudienceReason(diagnostics) {
  if (diagnostics.totalOrdersChecked === 0) {
    return "No Shopify orders have been synced for the 60-180 day winback lookback.";
  }

  if (diagnostics.ordersInDormantWindow === 0) {
    return "No orders are currently in the 60-180 day dormant window. Existing dev fixture orders are likely still too recent for winback.";
  }

  if (diagnostics.ordersInDormantWindowWithUsableEmail === 0) {
    return "Orders exist in the 60-180 day dormant window, but none have a usable email in the stored order payload.";
  }

  return "Customers with usable email were found, but each has reordered within the last 60 days or is outside the dormant window.";
}

/**
 * @param {{ audienceSize: number; averageOrderValue: number; discountPercent: number }} input
 */
export function estimateWinbackValue(input) {
  const rates = { low: 0.02, base: 0.05, high: 0.08 };
  const expectedRevenue = {
    low: roundMoney(input.audienceSize * rates.low * input.averageOrderValue),
    base: roundMoney(input.audienceSize * rates.base * input.averageOrderValue),
    high: roundMoney(input.audienceSize * rates.high * input.averageOrderValue),
  };
  const discountRate = input.discountPercent / 100;
  const discountCost = {
    low: roundMoney(expectedRevenue.low * discountRate),
    base: roundMoney(expectedRevenue.base * discountRate),
    high: roundMoney(expectedRevenue.high * discountRate),
  };

  return {
    expectedRevenue,
    discountCost,
    revenueAfterDiscount: {
      low: roundMoney(expectedRevenue.low - discountCost.low),
      base: roundMoney(expectedRevenue.base - discountCost.base),
      high: roundMoney(expectedRevenue.high - discountCost.high),
    },
  };
}

/** @param {unknown} value */
function extractEmail(value) {
  const payload = objectValue(value);
  const customer = objectValue(payload.customer);
  const email =
    stringValue(payload.email) ??
    stringValue(payload.contact_email) ??
    stringValue(customer.email);

  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** @param {unknown} value */
function isSuppressed(value) {
  const payload = objectValue(value);
  const customer = objectValue(payload.customer);
  const emailMarketingConsent = objectValue(
    payload.emailMarketingConsent ??
      payload.email_marketing_consent ??
      customer.emailMarketingConsent ??
      customer.email_marketing_consent,
  );
  const marketingConsentValues = [
    payload.acceptsMarketing,
    payload.accepts_marketing,
    payload.buyer_accepts_marketing,
    customer.acceptsMarketing,
    customer.accepts_marketing,
  ];

  return (
    Boolean(payload.cancelled_at) ||
    emailMarketingConsent.marketingState === "UNSUBSCRIBED" ||
    emailMarketingConsent.marketing_state === "UNSUBSCRIBED" ||
    marketingConsentValues.some((consentValue) => consentValue === false)
  );
}

/** @param {{ rawPayload?: unknown; lineItems?: Array<any> }} order */
function productsForOrder(order) {
  return (order.lineItems ?? [])
    .map((lineItem) => {
      return (
        lineItem.product?.title ??
        lineItem.title ??
        lineItem.variant?.sku ??
        lineItem.sku
      );
    })
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * @param {{ customerExternalId: string | null; email: string; currency: string }} input
 * @returns {{ customerExternalId: string | null; email: string; currency: string; orders: Array<{ processedAt: Date; totalPrice: number; products: string[] }>; previousTotalSpend: number }}
 */
function emptyCustomer(input) {
  return {
    customerExternalId: input.customerExternalId,
    email: input.email,
    currency: input.currency,
    orders: [],
    previousTotalSpend: 0,
  };
}

/**
 * @param {ReturnType<typeof emptyCustomer>} customer
 * @param {Date} now
 */
function summarizeCustomer(customer, now) {
  const orders = customer.orders.sort(
    (a, b) => b.processedAt.getTime() - a.processedAt.getTime(),
  );
  const lastOrder = orders[0];
  const previousOrderCount = orders.length;
  const productsBought = uniqueStrings(
    orders.flatMap((order) => order.products).filter(Boolean),
  ).slice(0, 5);

  return {
    customerExternalId: customer.customerExternalId,
    emailHash: sha256(customer.email),
    maskedEmail: maskEmail(customer.email),
    lastOrderDate: lastOrder.processedAt.toISOString(),
    daysSinceLastOrder: Math.floor(
      (now.getTime() - lastOrder.processedAt.getTime()) / 86400000,
    ),
    previousOrderCount,
    previousTotalSpend: roundMoney(customer.previousTotalSpend),
    averageOrderValue: roundMoney(customer.previousTotalSpend / previousOrderCount),
    productsBought,
    currency: customer.currency,
  };
}

/** @param {unknown} policy */
function policyCaps(policy) {
  const policyRecord = objectValue(policy);
  const discounts = objectValue(policyRecord.discounts);
  const approval = objectValue(policyRecord.approval);
  const email = objectValue(policyRecord.email);
  const seasonal = objectValue(policyRecord.seasonal);
  const defaultDiscountBps =
    numberOrNull(discounts.maxDefaultDiscountBps) ??
    Number(HOUSE_RULE_DEFAULTS.maxDefaultDiscountPercent) * 100;
  const winbackDiscountBps =
    numberOrNull(discounts.maxWinbackDiscountBps) ??
    Number(HOUSE_RULE_DEFAULTS.maxWinbackDiscountPercent) * 100;
  const allowAboveDefault = discounts.allowWinbackDiscountAboveDefault === true;
  const maxAllowedWinbackDiscountBps = allowAboveDefault
    ? winbackDiscountBps
    : Math.min(defaultDiscountBps, winbackDiscountBps);

  return {
    defaultDiscountBps,
    winbackDiscountBps,
    maxAllowedWinbackDiscountBps,
    allowAboveDefault,
    maxCampaignAudienceSize:
      numberOrNull(approval.maxCampaignAudienceSize) ??
      Number(HOUSE_RULE_DEFAULTS.maxCampaignAudienceSize),
    emailCooldownDays:
      numberOrNull(email.cooldownDays) ??
      Number(HOUSE_RULE_DEFAULTS.emailCooldownDays),
    maxEmailsPerCustomer:
      numberOrNull(email.maxEmailsPerCustomer) ??
      Number(HOUSE_RULE_DEFAULTS.maxEmailsPerCustomer),
    emailFrequencyScope:
      stringValue(email.frequencyScope) ?? HOUSE_RULE_DEFAULTS.emailFrequencyScope,
    bfcmFreezeMode: seasonal.bfcmFreezeMode === true,
  };
}

/**
 * @param {{ policy: unknown; caps: ReturnType<typeof policyCaps>; eligibleCount: number; includedCount: number; overflowCount: number; discountPercent: number }} input
 */
function capsAppliedFromPolicy(input) {
  return [
    {
      rule: "winback_discount_cap",
      appliedValue: input.caps.maxAllowedWinbackDiscountBps,
      display: `${formatPercent(input.discountPercent)} max winback discount`,
    },
    {
      rule: "campaign_audience_cap",
      appliedValue: input.caps.maxCampaignAudienceSize,
      eligibleCount: input.eligibleCount,
      includedCount: input.includedCount,
      overflowCount: input.overflowCount,
    },
    {
      rule: "email_cooldown",
      appliedValue: input.caps.emailCooldownDays,
      dataCompleteness: "no_prior_klaviyo_send_history_yet",
    },
    {
      rule: "no_automatic_send",
      appliedValue: true,
    },
    {
      rule: "bfcm_freeze_mode",
      appliedValue: input.caps.bfcmFreezeMode,
    },
  ];
}

/** @param {unknown} policy */
function rulesConsultedFromPolicy(policy) {
  if (!policy) {
    return [
      {
        source: "default_house_rules",
        rules: [
          "max winback discount",
          "campaign audience cap",
          "email cooldown",
          "manual approval required",
        ],
      },
    ];
  }
  const policyRecord = objectValue(policy);

  return [
    {
      source: "house_rules",
      houseRuleId: policyRecord.sourceHouseRuleId,
      policyVersion: policyRecord.policyVersion,
      rules: [
        "max default discount",
        "max winback discount",
        "campaign audience cap",
        "email cooldown",
        "BFCM/freeze mode",
        "approval rules",
        "brand voice",
      ],
    },
  ];
}

/**
 * @param {string} actionId
 * @param {Array<ReturnType<typeof summarizeCustomer>>} customers
 */
function exactHoldoutAssignments(actionId, customers) {
  const holdoutTarget = Math.ceil(
    customers.length * (WINBACK_HOLDOUT_PERCENT / 100),
  );
  const ranked = customers
    .map((customer) => ({
      emailHash: customer.emailHash,
      score: sha256(`${actionId}:${customer.emailHash}`),
    }))
    .sort((a, b) => a.score.localeCompare(b.score));
  const holdout = new Set(
    ranked.slice(0, holdoutTarget).map((customer) => customer.emailHash),
  );

  return new Map(
    customers.map((customer) => [
      customer.emailHash,
      holdout.has(customer.emailHash) ? "holdout" : "treatment",
    ]),
  );
}

/** @param {any} connection */
function serializeConnection(connection) {
  if (!connection) {
    return {
      status: "missing",
      maskedKey: null,
      lastCheckedAt: null,
      secretStoredInDb: false,
    };
  }
  const metadata = objectValue(connection.authMetadata);

  return {
    id: connection.id,
    status: connection.status,
    maskedKey: metadata.maskedKey ?? null,
    lastCheckedAt: metadata.lastCheckedAt ?? null,
    secretStoredInDb: false,
  };
}

/** @param {any} action */
function serializeAction(action) {
  const execution = action.executions[0] ?? null;
  const executionResponse = objectValue(execution?.response);
  const holdoutCount = action.holdoutAssignments.filter(
    /** @param {any} assignment */
    (assignment) => assignment.assignmentGroup === "holdout",
  ).length;
  const treatmentCount = action.holdoutAssignments.filter(
    /** @param {any} assignment */
    (assignment) => assignment.assignmentGroup === "treatment",
  ).length;

  return {
    id: action.id,
    status: action.status,
    proposedAt: action.proposedAt.toISOString(),
    approvedAt: action.approvedAt?.toISOString() ?? null,
    riskLevel: action.riskLevel,
    expectedValue: action.expectedValue,
    preview: action.preview,
    rulesConsulted: action.rulesConsulted,
    capsApplied: action.ruleConstraintsApplied,
    verificationClass: "estimated",
    executionStatus: execution?.status ?? null,
    executionDryRun: execution?.dryRun ?? null,
    externalDraftId: executionResponse.externalDraftId ?? null,
    holdoutCount,
    treatmentCount,
  };
}

/**
 * @param {ReturnType<typeof summarizeCustomer>} customer
 * @param {string | undefined} group
 */
function redactedCustomerView(customer, group = "treatment") {
  return {
    maskedEmail: customer.maskedEmail,
    emailHash: customer.emailHash.slice(0, 12),
    group: group === "holdout" ? "Holdout" : "Treatment",
    lastOrderDate: customer.lastOrderDate,
    daysSinceLastOrder: customer.daysSinceLastOrder,
    previousOrderCount: customer.previousOrderCount,
    previousTotalSpend: customer.previousTotalSpend,
    averageOrderValue: customer.averageOrderValue,
    productsBought: customer.productsBought,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; eventType: string; dedupeKey: string; idempotencyKey: string; payload: Record<string, unknown> }} input
 */
async function recordLedgerEvent(prisma, input) {
  return prisma.ledgerEvent.upsert({
    where: {
      merchantId_idempotencyKey: {
        merchantId: input.merchantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      eventType: input.eventType,
      source: "app",
      dedupeKey: input.dedupeKey,
      idempotencyKey: input.idempotencyKey,
      actorType: "merchant_user",
      payload: toJson(input.payload),
      rawPayload: toJson(input.payload),
    },
    update: {
      payload: toJson(input.payload),
      rawPayload: toJson(input.payload),
    },
  });
}

/** @param {Date} now @param {number} days */
function daysAgo(now, days) {
  return new Date(now.getTime() - days * 86400000);
}

/** @param {Date} date */
function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {string} shopId
 * @param {Date} now
 */
function winbackIdempotencyKey(shopId, now) {
  return `klaviyo-winback:${shopId}:${dateOnly(now)}`;
}

/** @param {unknown[]} values */
function uniqueStrings(values) {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? value : String(value)))
        .filter(Boolean),
    ),
  );
}

/** @param {number[]} values */
function average(values) {
  if (values.length === 0) return 0;
  return roundMoney(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** @param {unknown} value */
function money(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && "toNumber" in value) {
    const decimalLike = /** @type {{ toNumber: () => number }} */ (value);
    return decimalLike.toNumber();
  }

  return 0;
}

/** @param {number} value */
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** @param {unknown} value */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
 * @returns {import("@prisma/client").Prisma.InputJsonValue}
 */
function toJson(value) {
  return /** @type {import("@prisma/client").Prisma.InputJsonValue} */ (
    JSON.parse(JSON.stringify(value ?? null))
  );
}

/** @param {string} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} secret */
function maskSecret(secret) {
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

/** @param {string} email */
function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

/** @param {number} percent */
function formatPercent(percent) {
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** @param {Array<any>} orders */
function firstCurrency(orders) {
  return orders.find((order) => order.currency)?.currency ?? null;
}
