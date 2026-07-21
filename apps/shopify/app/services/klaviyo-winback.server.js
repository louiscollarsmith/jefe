// @ts-check

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";

import {
  createKlaviyoWinbackDraft,
  KlaviyoApiError,
} from "../lib/klaviyo/adapter.server.js";
import {
  approveAction,
  blockAction,
  cancelAction,
  transitionAction,
  rejectAction,
} from "./action-safety.server.js";
import {
  decryptKlaviyoPrivateKey,
  KLAVIYO_REQUIRED_DRAFT_SCOPES,
  loadKlaviyoCredential,
  removeKlaviyoCredential,
  saveKlaviyoPrivateKey,
  serializeKlaviyoCredential,
} from "./klaviyo-credentials.server.js";
import { HOUSE_RULE_DEFAULTS } from "./house-rules-policy.js";
import { loadMerchantPolicyContext } from "./onboarding.server.js";

export const KLAVIYO_CONNECTOR = "klaviyo";
export const WINBACK_ACTION_TYPE = "klaviyo_winback_draft";
export const LEGACY_WINBACK_ACTION_TYPE = "klaviyo_winback";
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
  const credential = await saveKlaviyoPrivateKey(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    privateKey,
    now,
  });
  const keyFingerprint = sha256(privateKey).slice(0, 16);
  const keySuffix = privateKey.slice(-4);
  const tokenRef = `merchant_klaviyo_credentials:${credential.id}`;
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
      scopes: [...KLAVIYO_REQUIRED_DRAFT_SCOPES],
      writeTokenRef: tokenRef,
      authMetadata: {
        mode: "merchant_private_key",
        maskedKey: maskSecret(privateKey),
        keySuffix,
        keyFingerprint,
        lastCheckedAt: now.toISOString(),
        credentialId: credential.id,
        secretStorage: "encrypted_db",
      },
      connectedAt: now,
      rawPayload: { source: "manager_settings", secretStoredInDb: true },
    },
    update: {
      shopId: input.shopId,
      status: "active",
      scopes: [...KLAVIYO_REQUIRED_DRAFT_SCOPES],
      writeTokenRef: tokenRef,
      authMetadata: {
        mode: "merchant_private_key",
        maskedKey: maskSecret(privateKey),
        keySuffix,
        keyFingerprint,
        lastCheckedAt: now.toISOString(),
        credentialId: credential.id,
        secretStorage: "encrypted_db",
      },
      connectedAt: now,
      rawPayload: { source: "manager_settings", secretStoredInDb: true },
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
      credentialId: credential.id,
      connector: KLAVIYO_CONNECTOR,
      maskedKey: maskSecret(privateKey),
      secretStoredInDb: true,
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
  await removeKlaviyoCredential(prisma, input);
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
  const [credential, proposal, actions] = await Promise.all([
    loadKlaviyoCredential(prisma, input),
    buildWinbackProposal(prisma, input),
    prisma.action.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionType: { in: [WINBACK_ACTION_TYPE, LEGACY_WINBACK_ACTION_TYPE] },
      },
      orderBy: { proposedAt: "desc" },
      take: 5,
      include: {
        executions: { orderBy: { createdAt: "desc" } },
        approvalEvents: { orderBy: { eventTs: "asc" } },
        holdoutAssignments: true,
        externalArtifacts: true,
      },
    }),
  ]);

  return {
    connection: serializeKlaviyoCredential(credential),
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
  const proposal = await buildWinbackProposal(prisma, { ...input, now });
  const idempotencyKey = winbackIdempotencyKey(input.shopId, now);
  const status = proposal.status === "blocked" ? "blocked" : "needs_approval";
  const title = "Dormant customer winback";
  const summary =
    "Prepare a Klaviyo dormant-customer winback draft with a randomised holdout. Sending remains disabled in v0.";

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
      title,
      summary,
      expectedValue: proposal.economics,
      valueCurrency: proposal.economics.currency,
      valueType: "estimated_revenue",
      confidence: "0.5500",
      riskLevel: proposal.riskLevel,
      approvalRequired: true,
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
      capsApplied: proposal.capsApplied,
      provenanceReferences: [
        {
          source: "orders",
          formulaVersion: WINBACK_FORMULA_VERSION,
          plannedVerification: proposal.plannedVerification,
        },
      ],
      preview: proposal.preview,
      verificationClass: "ESTIMATED",
      executionMode: "draft_only",
      externalSystem: KLAVIYO_CONNECTOR,
      blockedReason: proposal.status === "blocked"
        ? proposal.blockedReasons[0] ?? "house_rules_blocked"
        : null,
      idempotencyKey,
      proposedAt: now,
    },
    update: {
      status,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      blockedReason: proposal.status === "blocked"
        ? proposal.blockedReasons[0] ?? "house_rules_blocked"
        : null,
      title,
      summary,
      expectedValue: proposal.economics,
      valueCurrency: proposal.economics.currency,
      valueType: "estimated_revenue",
      confidence: "0.5500",
      riskLevel: proposal.riskLevel,
      approvalRequired: true,
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
      capsApplied: proposal.capsApplied,
      provenanceReferences: [
        {
          source: "orders",
          formulaVersion: WINBACK_FORMULA_VERSION,
          plannedVerification: proposal.plannedVerification,
        },
      ],
      preview: proposal.preview,
      verificationClass: "ESTIMATED",
      executionMode: "draft_only",
      externalSystem: KLAVIYO_CONNECTOR,
      externalDraftId: null,
      externalExecutionId: null,
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
      draftPrepared: proposal.status !== "blocked",
      formulaVersion: WINBACK_FORMULA_VERSION,
      verificationClass: "estimated",
      valueType: "estimated_revenue",
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
      status: "needs_approval",
    },
  });

  const approved = await approveAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    actor: "merchant",
    actorType: "merchant_user",
    comment: "Approved in Klaviyo Winback queue. Sending remains disabled in v0.",
    requestSnapshot: {
      actionType: WINBACK_ACTION_TYPE,
      executionMode: action.executionMode,
      noAutomaticSend: true,
    },
    now,
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
 * @param {{ merchantId: string; shopId: string; actionId: string; now?: Date; env?: Record<string, string | undefined>; fetchFn?: typeof fetch }} input
 */
export async function executeApprovedWinbackDraft(prisma, input) {
  const now = input.now ?? new Date();
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: { in: [WINBACK_ACTION_TYPE, LEGACY_WINBACK_ACTION_TYPE] },
    },
    include: {
      holdoutAssignments: true,
      externalArtifacts: true,
      executions: { orderBy: { createdAt: "desc" } },
    },
  });

  const existingSummary = existingDraftSummary(action);
  if (existingSummary) {
    return {
      ok: true,
      action,
      execution: action.executions[0] ?? null,
      response: existingSummary,
      blockedReasons: [],
    };
  }

  if (action.status !== "approved") {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "not_approved",
      request: { actionType: WINBACK_ACTION_TYPE },
      now,
    });
    return { ...result, response: null };
  }

  const connector = await loadKlaviyoConnection(prisma, input);
  if (!connector || connector.status !== "active") {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "missing_klaviyo_connection",
      request: { actionType: WINBACK_ACTION_TYPE },
      now,
    });
    return { ...result, response: null };
  }

  if (!action.idempotencyKey) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "missing_idempotency_key",
      request: { actionType: WINBACK_ACTION_TYPE },
      now,
    });
    return { ...result, response: null };
  }

  const credential = await loadKlaviyoCredential(prisma, input);
  let privateKey;
  try {
    privateKey = decryptKlaviyoPrivateKey(credential, input.env ?? process.env);
  } catch (error) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "missing_secret",
      request: {
        actionType: WINBACK_ACTION_TYPE,
        credentialError: error instanceof Error ? error.message : "missing_secret",
      },
      now,
    });
    return { ...result, response: null };
  }

  const treatmentAssignments = action.holdoutAssignments.filter(
    (assignment) => assignment.assignmentGroup === "treatment",
  );
  const holdoutAssignments = action.holdoutAssignments.filter(
    (assignment) => assignment.assignmentGroup === "holdout",
  );
  if (holdoutAssignments.length === 0) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "holdout_missing",
      request: { actionType: WINBACK_ACTION_TYPE },
      now,
    });
    return { ...result, response: null };
  }
  if (treatmentAssignments.length === 0) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "empty_treatment_audience",
      request: { actionType: WINBACK_ACTION_TYPE },
      now,
    });
    return { ...result, response: null };
  }

  const policy = await loadMerchantPolicyContext(prisma, input.shopId);
  const caps = policyCaps(policy);
  if (caps.bfcmFreezeMode) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "house_rules_blocked",
      request: { actionType: WINBACK_ACTION_TYPE, rule: "bfcm_freeze_mode" },
      now,
    });
    return { ...result, response: null };
  }
  if (action.holdoutAssignments.length > caps.maxCampaignAudienceSize) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "audience_cap_exceeded",
      request: {
        actionType: WINBACK_ACTION_TYPE,
        audienceCount: action.holdoutAssignments.length,
        cap: caps.maxCampaignAudienceSize,
      },
      now,
    });
    return { ...result, response: null };
  }

  const treatmentHashes = new Set(
    treatmentAssignments.map((assignment) => assignment.subjectId).filter(Boolean),
  );
  const audience = await includedAudienceForAction(
    prisma,
    input,
    action.proposedAt,
  );
  const treatmentCustomers = audience
    .filter((customer) => treatmentHashes.has(customer.emailHash))
    .map((customer) => ({
      email: customer.email,
      emailHash: customer.emailHash,
      customerExternalId: customer.customerExternalId,
    }));
  if (treatmentCustomers.length === 0) {
    const result = await blockWinbackExecution(prisma, action, {
      reason: "empty_treatment_audience",
      request: { actionType: WINBACK_ACTION_TYPE },
      now,
    });
    return { ...result, response: null };
  }

  await transitionAction(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    newStatus: "execution_queued",
    actor: "system",
    actorType: "system",
    requestSnapshot: {
      actionType: WINBACK_ACTION_TYPE,
      executionMode: "draft_only",
      sendEnabled: false,
    },
    now,
  });
  await transitionAction(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    newStatus: "executing",
    actor: "system",
    actorType: "system",
    requestSnapshot: {
      actionType: WINBACK_ACTION_TYPE,
      executionMode: "draft_only",
      sendEnabled: false,
    },
    now,
  });

  const executionIdempotencyKey = `klaviyo-draft:${action.id}`;
  const shortActionId = action.id.slice(0, 8);
  const date = dateOnly(now);
  const preview = objectValue(action.preview);

  try {
    const response = await createKlaviyoWinbackDraft({
      privateKey,
      shopId: input.shopId,
      actionId: action.id,
      idempotencyKey: executionIdempotencyKey,
      now,
      campaignName: `Jefe Dormant Customer Winback - ${date} - ${shortActionId}`,
      listName: `Jefe Winback Treatment - ${date} - ${shortActionId}`,
      templateName: `Jefe Winback Draft - ${date} - ${shortActionId}`,
      subjectLine: stringValue(preview.subjectLine) ??
        "A 10% thank-you for coming back",
      previewText: stringValue(preview.previewText) ??
        "A thank-you offer for coming back.",
      html: winbackTemplateHtml(preview),
      text: winbackTemplateText(preview),
      treatmentCustomers,
      holdoutCount: holdoutAssignments.length,
      existing: existingKlaviyoArtifacts(action.externalArtifacts),
      fetchFn: input.fetchFn,
    });

    await persistExternalArtifacts(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: action.id,
      artifacts: response.artifacts,
    });

    const execution = await prisma.execution.upsert({
      where: {
        merchantId_idempotencyKey: {
          merchantId: action.merchantId,
          idempotencyKey: executionIdempotencyKey,
        },
      },
      create: {
        merchantId: action.merchantId,
        shopId: action.shopId,
        actionId: action.id,
        status: "draft_created",
        connector: KLAVIYO_CONNECTOR,
        idempotencyKey: executionIdempotencyKey,
        dryRun: false,
        request: toJson({
          actionType: WINBACK_ACTION_TYPE,
          executionMode: "draft_only",
          sendEnabled: false,
          treatmentCount: treatmentCustomers.length,
          holdoutCount: holdoutAssignments.length,
        }),
        response: toJson(safeExecutionResponse(response)),
        startedAt: now,
        completedAt: now,
      },
      update: {
        status: "draft_created",
        dryRun: false,
        request: toJson({
          actionType: WINBACK_ACTION_TYPE,
          executionMode: "draft_only",
          sendEnabled: false,
          treatmentCount: treatmentCustomers.length,
          holdoutCount: holdoutAssignments.length,
        }),
        response: toJson(safeExecutionResponse(response)),
        startedAt: now,
        completedAt: now,
        error: Prisma.JsonNull,
      },
    });

    const executed = await transitionAction(prisma, {
      merchantId: action.merchantId,
      shopId: action.shopId,
      actionId: action.id,
      newStatus: "executed",
      actor: "system",
      actorType: "system",
      requestSnapshot: {
        executionId: execution.id,
        response: safeExecutionResponse(response),
      },
      now,
      data: {
        externalDraftId: response.klaviyoCampaignId,
        externalExecutionId: execution.id,
      },
    });

    await recordLedgerEvent(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      eventType: "action.klaviyo_winback.draft_created",
      dedupeKey: `klaviyo-draft-created:${action.id}`,
      idempotencyKey: `klaviyo-draft-created:${action.id}`,
      payload: safeExecutionResponse(response),
    });

    return {
      ok: true,
      action: executed,
      execution,
      response: safeExecutionResponse(response),
      blockedReasons: [],
    };
  } catch (error) {
    const safeError = safeKlaviyoExecutionError(error);
    const execution = await prisma.execution.upsert({
      where: {
        merchantId_idempotencyKey: {
          merchantId: action.merchantId,
          idempotencyKey: executionIdempotencyKey,
        },
      },
      create: {
        merchantId: action.merchantId,
        shopId: action.shopId,
        actionId: action.id,
        status: "execution_failed",
        connector: KLAVIYO_CONNECTOR,
        idempotencyKey: executionIdempotencyKey,
        dryRun: false,
        request: toJson({
          actionType: WINBACK_ACTION_TYPE,
          executionMode: "draft_only",
          sendEnabled: false,
        }),
        response: {},
        error: toJson(safeError),
        startedAt: now,
        completedAt: now,
      },
      update: {
        status: "execution_failed",
        dryRun: false,
        error: toJson(safeError),
        completedAt: now,
      },
    });

    const failed = await transitionAction(prisma, {
      merchantId: action.merchantId,
      shopId: action.shopId,
      actionId: action.id,
      newStatus: "execution_failed",
      actor: "system",
      actorType: "system",
      reason: safeError.code,
      requestSnapshot: {
        executionId: execution.id,
        error: safeError,
      },
      now,
      data: { externalExecutionId: execution.id },
    });

    return {
      ok: false,
      action: failed,
      execution,
      response: null,
      blockedReasons: [safeError.code],
    };
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; reason?: string | null; now?: Date }} input
 */
export async function rejectWinbackProposal(prisma, input) {
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: WINBACK_ACTION_TYPE,
      status: { in: ["needs_approval", "approved"] },
    },
  });

  return rejectAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    actor: "merchant",
    actorType: "merchant_user",
    reason: input.reason ?? null,
    requestSnapshot: {
      actionType: WINBACK_ACTION_TYPE,
      executionMode: action.executionMode,
      noAutomaticSend: true,
    },
    now: input.now,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; reason?: string | null; now?: Date }} input
 */
export async function cancelWinbackProposal(prisma, input) {
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: WINBACK_ACTION_TYPE,
      status: { in: ["proposed", "draft_prepared", "needs_approval", "approved"] },
    },
  });

  return cancelAction(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: action.id,
    actor: "merchant",
    actorType: "merchant_user",
    reason: input.reason ?? null,
    requestSnapshot: {
      actionType: WINBACK_ACTION_TYPE,
      executionMode: action.executionMode,
      noAutomaticSend: true,
    },
    now: input.now,
  });
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
      status: "active",
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
    email: customer.email,
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

/** @param {any} action */
function serializeAction(action) {
  const execution = action.executions.find(
    /** @param {any} item */
    (item) => ["draft_created", "draft_prepared"].includes(item.status),
  ) ?? action.executions[0] ?? null;
  const executionResponse = objectValue(execution?.response);
  const artifacts = existingKlaviyoArtifacts(action.externalArtifacts ?? []);
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
    rejectedAt: action.rejectedAt?.toISOString() ?? null,
    blockedReason: action.blockedReason ?? null,
    title: action.title,
    summary: action.summary,
    riskLevel: action.riskLevel,
    expectedValue: action.expectedValue,
    valueCurrency: action.valueCurrency,
    valueType: action.valueType,
    preview: action.preview,
    rulesConsulted: action.rulesConsulted,
    capsApplied: action.capsApplied?.length
      ? action.capsApplied
      : action.ruleConstraintsApplied,
    provenanceReferences: action.provenanceReferences ?? [],
    verificationClass: "estimated",
    executionMode: action.executionMode,
    externalSystem: action.externalSystem,
    executionStatus: execution?.status ?? null,
    executionDryRun: execution?.dryRun ?? null,
    externalDraftId:
      action.externalDraftId ??
      executionResponse.externalDraftId ??
      artifacts.campaign?.id ??
      null,
    externalExecutionId: action.externalExecutionId ?? null,
    approvalHistory: (action.approvalEvents ?? []).map(
      /** @param {any} event */
      (event) => ({
        id: event.id,
        previousStatus: event.previousStatus,
        newStatus: event.newStatus,
        actor: event.actor,
        actorType: event.actorType,
        reason: event.reason,
        eventTs: event.eventTs.toISOString(),
      }),
    ),
    executionHistory: action.executions.map(
      /** @param {any} item */
      (item) => ({
        id: item.id,
        status: item.status,
        dryRun: item.dryRun,
        connector: item.connector,
        createdAt: item.createdAt.toISOString(),
        completedAt: item.completedAt?.toISOString() ?? null,
      }),
    ),
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
 * @param {{ merchantId: string; shopId: string; actionId: string; artifacts: Array<{ artifactType: string; externalId: string; externalName?: string | null; externalStatus: string; externalUrl?: string | null; payloadSnapshotJson?: unknown }> }} input
 */
async function persistExternalArtifacts(prisma, input) {
  for (const artifact of input.artifacts) {
    await prisma.externalActionArtifact.upsert({
      where: {
        actionId_provider_artifactType_externalId: {
          actionId: input.actionId,
          provider: KLAVIYO_CONNECTOR,
          artifactType: artifact.artifactType,
          externalId: artifact.externalId,
        },
      },
      create: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        actionId: input.actionId,
        provider: KLAVIYO_CONNECTOR,
        artifactType: artifact.artifactType,
        externalId: artifact.externalId,
        externalName: artifact.externalName ?? null,
        externalStatus: artifact.externalStatus,
        externalUrl: artifact.externalUrl ?? null,
        payloadSnapshotJson: toJson(artifact.payloadSnapshotJson ?? {}),
      },
      update: {
        externalName: artifact.externalName ?? null,
        externalStatus: artifact.externalStatus,
        externalUrl: artifact.externalUrl ?? null,
        payloadSnapshotJson: toJson(artifact.payloadSnapshotJson ?? {}),
      },
    });
  }
}

/** @param {any} action */
function existingDraftSummary(action) {
  const artifacts = action.externalArtifacts ?? [];
  const existing = existingKlaviyoArtifacts(artifacts);
  if (
    !existing.list?.id ||
    !existing.campaign?.id ||
    !existing.campaignMessage?.id ||
    !existing.template?.id
  ) {
    return null;
  }

  const treatmentCount = action.holdoutAssignments.filter(
    /** @param {any} assignment */
    (assignment) => assignment.assignmentGroup === "treatment",
  ).length;
  const holdoutCount = action.holdoutAssignments.filter(
    /** @param {any} assignment */
    (assignment) => assignment.assignmentGroup === "holdout",
  ).length;

  return {
    connector: KLAVIYO_CONNECTOR,
    actionId: action.id,
    externalDraftId: existing.campaign.id,
    klaviyoListId: existing.list.id,
    klaviyoCampaignId: existing.campaign.id,
    klaviyoCampaignMessageId: existing.campaignMessage.id,
    klaviyoTemplateId: existing.template.id,
    externalStatus: "draft_created",
    executionMode: "draft_only",
    sendEnabled: false,
    audience: { treatmentCount, holdoutCount },
    profilesCreatedOrUpdated: artifacts.filter(
      /** @param {any} artifact */
      (artifact) => artifact.artifactType === "klaviyo_profile",
    ).length,
    profilesAddedToList: treatmentCount,
    profilesFailed: 0,
  };
}

/** @param {Array<any>} artifacts */
function existingKlaviyoArtifacts(artifacts) {
  const byType = new Map(
    artifacts
      .filter((artifact) => artifact.provider === KLAVIYO_CONNECTOR)
      .map((artifact) => [
        artifact.artifactType,
        { id: artifact.externalId, name: artifact.externalName },
      ]),
  );

  return {
    list: byType.get("klaviyo_list"),
    campaign: byType.get("klaviyo_campaign"),
    campaignMessage: byType.get("klaviyo_campaign_message"),
    template: byType.get("klaviyo_template"),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} action
 * @param {{ reason: string; request: Record<string, unknown>; now: Date }} input
 */
async function blockWinbackExecution(prisma, action, input) {
  const blocked = await blockAction(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    reason: input.reason,
    actor: "system",
    actorType: "system",
    requestSnapshot: {
      blockedReasons: [input.reason],
      request: input.request,
    },
    now: input.now,
  });

  return {
    ok: false,
    blockedReasons: [input.reason],
    action: blocked,
    execution: null,
  };
}

/** @param {Record<string, any>} preview */
function winbackTemplateHtml(preview) {
  const headline = escapeHtml(
    stringValue(preview.headline) ?? "Here is 10% off your next order",
  );
  const bodyCopy = Array.isArray(preview.bodyCopy)
    ? preview.bodyCopy.map((item) => String(item))
    : [
        "We noticed it has been a while since your last order.",
        "Here is 10% off your next purchase.",
      ];
  const ctaText = escapeHtml(stringValue(preview.ctaText) ?? "Shop now");
  const footerNote = escapeHtml(
    stringValue(preview.footerNote) ??
      "You are receiving this because you previously placed an order with us.",
  );

  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #202223; line-height: 1.5;">
    <h1>${headline}</h1>
    ${bodyCopy.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n    ")}
    <p><strong>${ctaText}</strong></p>
    <p>Use your usual winback discount code before sending.</p>
    <p style="font-size: 12px; color: #6d7175;">${footerNote}</p>
  </body>
</html>`;
}

/** @param {Record<string, any>} preview */
function winbackTemplateText(preview) {
  const bodyCopy = Array.isArray(preview.bodyCopy)
    ? preview.bodyCopy.map((item) => String(item))
    : [
        "We noticed it has been a while since your last order.",
        "Here is 10% off your next purchase.",
      ];
  return [
    stringValue(preview.headline) ?? "Here is 10% off your next order",
    "",
    ...bodyCopy,
    "",
    stringValue(preview.ctaText) ?? "Shop now",
    "Use your usual winback discount code before sending.",
    "",
    stringValue(preview.footerNote) ??
      "You are receiving this because you previously placed an order with us.",
  ].join("\n");
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {any} response */
function safeExecutionResponse(response) {
  return {
    connector: KLAVIYO_CONNECTOR,
    actionId: response.actionId,
    externalDraftId: response.externalDraftId,
    klaviyoListId: response.klaviyoListId,
    klaviyoCampaignId: response.klaviyoCampaignId,
    klaviyoCampaignMessageId: response.klaviyoCampaignMessageId,
    klaviyoTemplateId: response.klaviyoTemplateId,
    externalStatus: response.externalStatus,
    executionMode: "draft_only",
    sendEnabled: false,
    audience: response.audience,
    profilesCreatedOrUpdated: response.profilesCreatedOrUpdated,
    profilesAddedToList: response.profilesAddedToList,
    profilesFailed: response.profilesFailed,
  };
}

/** @param {unknown} error */
function safeKlaviyoExecutionError(error) {
  if (error instanceof KlaviyoApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      requestId: error.requestId,
      failedStep: error.step,
      retryable: error.retryable,
    };
  }

  return {
    code: "klaviyo_validation_error",
    message: error instanceof Error ? error.message : "Klaviyo draft creation failed.",
    status: null,
    requestId: null,
    failedStep: "unknown",
    retryable: false,
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
