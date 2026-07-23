// @ts-check

import { createHash } from "node:crypto";
import { createLlmProvider } from "../llm/provider.server.js";
import {
  STORE_UNDERSTANDING_OUTPUT_SCHEMA,
  parseAndValidateStoreUnderstandingOutput,
} from "../llm/store-understanding-schema.server.js";
import {
  ACTIVE_BELIEF_STATUSES,
  AUTHORITATIVE_BELIEF_STATUSES,
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
} from "./constants.server.js";
import {
  STORE_UNDERSTANDING_DERIVATION_VERSION,
  STORE_UNDERSTANDING_INPUT_VERSION,
  STORE_UNDERSTANDING_RUN_STATUS,
  cappedStoreUnderstandingConfidence,
  formatInferenceValue,
  getStoreUnderstandingDefinition,
  getStoreUnderstandingRegistry,
  hasMinimumEvidence,
  validateStoreUnderstandingValue,
} from "./store-understanding-registry.server.js";

const MAX_PRODUCTS = 50;
const MAX_VARIANTS = 80;
const MAX_BELIEFS = 40;
const MIN_ACCEPTED_CONFIDENCE = 0.25;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; trigger?: string; force?: boolean; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function runStoreUnderstandingPass(prisma, input) {
  const logger = input.logger ?? console;
  const startedAt = new Date();
  const summary = await buildStoreUnderstandingSummary(prisma, input);
  const inputSummaryHash = hashSummary(summary);

  if (!input.force) {
    const existing = await prisma.storeUnderstandingRun.findFirst({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId ?? null,
        inputSummaryHash,
        derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
        status: {
          in: [
            STORE_UNDERSTANDING_RUN_STATUS.completed,
            STORE_UNDERSTANDING_RUN_STATUS.modelDisabled,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      await prisma.storeUnderstandingRun.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId ?? null,
          status: STORE_UNDERSTANDING_RUN_STATUS.skipped,
          trigger: input.trigger ?? "post_memory_rebuild",
          inputSummaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
          inputSummaryHash,
          derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
          provider: existing.provider,
          model: existing.model,
          completedAt: new Date(),
          result: {
            reason: "unchanged_input_summary",
            previousRunId: existing.id,
          },
        },
      });
      return { status: STORE_UNDERSTANDING_RUN_STATUS.skipped, inputSummaryHash };
    }
  }

  const provider = input.llmProvider ?? safeCreateLlmProvider(logger);
  const run = await prisma.storeUnderstandingRun.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      status: STORE_UNDERSTANDING_RUN_STATUS.running,
      trigger: input.trigger ?? "post_memory_rebuild",
      inputSummaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
      inputSummaryHash,
      derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
      provider: provider?.provider ?? null,
      model: provider?.model ?? null,
      startedAt,
    },
  });

  if (!provider?.enabled || !provider.generateStructuredJson) {
    await prisma.storeUnderstandingRun.update({
      where: { id: run.id },
      data: {
        status: STORE_UNDERSTANDING_RUN_STATUS.modelDisabled,
        completedAt: new Date(),
        result: { reason: "llm_disabled" },
      },
    });
    return {
      status: STORE_UNDERSTANDING_RUN_STATUS.modelDisabled,
      inputSummaryHash,
    };
  }

  try {
    const llmResult = await provider.generateStructuredJson({
      systemPrompt: buildStoreUnderstandingSystemPrompt(),
      prompt: buildStoreUnderstandingPrompt(summary),
      schema: STORE_UNDERSTANDING_OUTPUT_SCHEMA,
      maxInputTokens: 6000,
      maxOutputTokens: 3200,
      timeoutMs: 10_000,
    });
    const parsed = parseAndValidateStoreUnderstandingOutput(llmResult.json);
    if (!parsed.ok) {
      throw new Error("error" in parsed ? parsed.error : "Invalid model output.");
    }
    const output = /** @type {any} */ (parsed).output;

    const validation = validateCandidateBeliefs({
      output,
      summary,
      provider,
      runId: run.id,
      inputSummaryHash,
    });
    const persisted = [];
    for (const accepted of validation.accepted) {
      const result = await upsertStoreUnderstandingBelief(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        runId: run.id,
        inputSummaryHash,
        provider,
        candidate: accepted,
      });
      if (!result.skipped) persisted.push(result.belief);
      else if (result.rejection) validation.rejected.push(result.rejection);
    }

    const obsoleteCount = await obsoleteUnsupportedStoreUnderstandingBeliefs(
      prisma,
      {
        merchantId: input.merchantId,
        shopId: input.shopId,
        acceptedKeys: new Set(persisted.map((belief) => belief.key)),
        runId: run.id,
      },
    );
    const durationMs = Date.now() - startedAt.getTime();
    await prisma.storeUnderstandingRun.update({
      where: { id: run.id },
      data: {
        status: STORE_UNDERSTANDING_RUN_STATUS.completed,
        candidateCount: validation.candidateCount,
        acceptedCount: persisted.length,
        rejectedCount: validation.rejected.length,
        obsoleteCount,
        completedAt: new Date(),
        result: {
          storeSummary: output.storeSummary,
          acceptedKeys: persisted.map((belief) => belief.key),
          rejected: validation.rejected.slice(0, 20),
          uncertainties: output.uncertainties,
          suggestedInterviewConfirmations:
            output.suggestedInterviewConfirmations,
          usage: llmResult.usage,
          attempts: llmResult.attempts,
          durationMs,
        },
      },
    });

    logger.info("Store Understanding completed", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      runId: run.id,
      acceptedCount: persisted.length,
      rejectedCount: validation.rejected.length,
      obsoleteCount,
      durationMs,
    });

    return {
      status: STORE_UNDERSTANDING_RUN_STATUS.completed,
      inputSummaryHash,
      candidateCount: validation.candidateCount,
      acceptedCount: persisted.length,
      rejectedCount: validation.rejected.length,
      obsoleteCount,
      durationMs,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Store Understanding failed.";
    await prisma.storeUnderstandingRun.update({
      where: { id: run.id },
      data: {
        status: STORE_UNDERSTANDING_RUN_STATUS.failed,
        failedAt: new Date(),
        lastError: message.slice(0, 1000),
        result: { errorName: error instanceof Error ? error.name : "Error" },
      },
    });
    logger.warn("Store Understanding failed; interview will continue without provisional inferences", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      runId: run.id,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      status: STORE_UNDERSTANDING_RUN_STATUS.failed,
      inputSummaryHash,
      error: message,
    };
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
export async function buildStoreUnderstandingSummary(prisma, input) {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: input.merchantId },
    include: {
      shops: { where: input.shopId ? { id: input.shopId } : undefined, take: 1 },
    },
  });
  const shop = merchant.shops[0] ?? null;
  const shopId = input.shopId ?? shop?.id ?? null;

  const [beliefs, products, variants, orders, lineItems, refunds, customers, inventory] =
    await Promise.all([
      prisma.merchantMemoryBelief.findMany({
        where: {
          merchantId: input.merchantId,
          shopId: shopId ?? undefined,
          status: { in: ACTIVE_BELIEF_STATUSES },
        },
        orderBy: [{ category: "asc" }, { key: "asc" }],
        take: MAX_BELIEFS,
      }),
      prisma.product.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        orderBy: [{ status: "asc" }, { title: "asc" }],
        take: MAX_PRODUCTS,
        select: {
          id: true,
          title: true,
          status: true,
          vendor: true,
          productType: true,
          rawPayload: true,
        },
      }),
      prisma.variant.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        orderBy: [{ title: "asc" }, { externalId: "asc" }],
        take: MAX_VARIANTS,
        select: {
          productId: true,
          title: true,
          price: true,
          currency: true,
        },
      }),
      prisma.order.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        select: {
          id: true,
          totalPrice: true,
          currency: true,
          processedAt: true,
          sourceCreatedAt: true,
        },
      }),
      prisma.orderLineItem.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        select: {
          productId: true,
          title: true,
          quantity: true,
          totalPrice: true,
        },
      }),
      prisma.refund.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        select: { orderId: true, amount: true },
      }),
      prisma.customerIdentity.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        select: { orderCount: true, totalSpend: true, averageOrderValue: true },
      }),
      prisma.inventoryLevel.findMany({
        where: { merchantId: input.merchantId, shopId: shopId ?? undefined },
        select: { variantId: true, available: true },
      }),
    ]);

  const activeProducts = products.filter((product) => isActiveProduct(product));
  const pricedVariants = variants.filter((variant) => variant.price !== null);
  const productTypeDistribution = topCounts(products.map((product) => product.productType));
  const vendorDistribution = topCounts(products.map((product) => product.vendor));
  const priceValues = pricedVariants.map((variant) => Number(variant.price));
  const commerceOrders = orders.filter((order) => order.processedAt || order.totalPrice !== null);
  const pricedOrders = commerceOrders.filter((order) => order.totalPrice !== null);
  const repeatCustomers = customers.filter((customer) => customer.orderCount > 1).length;
  const datedOrders = commerceOrders
    .map((order) => order.processedAt ?? order.sourceCreatedAt)
    .filter((value) => value instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    summaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
    generatedAt: new Date().toISOString(),
    merchant: {
      name: merchant.name,
      shopDomain: shop?.shopDomain ?? null,
      storeName: storeNameFrom(shop?.rawPayload, merchant.name),
    },
    aggregateMetrics: {
      catalogue: {
        productCount: products.length,
        sampledProductCount: products.length,
        activeProductCount: activeProducts.length,
        variantCount: variants.length,
        sampledVariantCount: variants.length,
        productTypeDistribution,
        vendorDistribution,
        priceDistribution: priceDistribution(priceValues),
      },
      orders: {
        orderCount: commerceOrders.length,
        averageOrderValue: averageMoney(pricedOrders.map((order) => order.totalPrice)),
        averageItemsPerOrder: averageItemsPerOrder(commerceOrders, lineItems),
        firstOrderAt: datedOrders[0]?.toISOString?.() ?? null,
        latestOrderAt: datedOrders[datedOrders.length - 1]?.toISOString?.() ?? null,
      },
      customers: {
        knownCustomerCount: customers.length,
        repeatCustomerRate:
          customers.length === 0
            ? null
            : roundNumber((repeatCustomers / customers.length) * 100, 2),
      },
      refunds: {
        refundCount: refunds.length,
        refundedOrderRate:
          commerceOrders.length === 0
            ? null
            : roundNumber((new Set(refunds.map((refund) => refund.orderId)).size /
                commerceOrders.length) * 100, 2),
      },
      inventory: {
        inventoryLevelCount: inventory.length,
        knownAvailableUnitCount: inventory
          .filter((level) => level.available !== null)
          .reduce((total, level) => total + (level.available ?? 0), 0),
      },
    },
    catalogueSamples: products.map((product) => ({
      title: safeText(product.title, 120),
      status: product.status,
      vendor: safeText(product.vendor, 80),
      productType: safeText(product.productType, 80),
      tags: extractTags(product.rawPayload).slice(0, 12),
      descriptionExcerpt: descriptionExcerpt(product.rawPayload),
      variants: variants
        .filter((variant) => variant.productId === product.id)
        .slice(0, 4)
        .map((variant) => ({
          title: safeText(variant.title, 80),
          price: variant.price === null ? null : Number(variant.price),
          currency: variant.currency,
        })),
    })),
    topProductsByUnits: topProductsByUnits(lineItems).slice(0, 12),
    deterministicBeliefs: beliefs.map((belief) => ({
      key: belief.key,
      category: belief.category,
      value: belief.value,
      status: belief.status,
      confidence: belief.confidence === null ? null : Number(belief.confidence),
      derivationVersion: belief.derivationVersion,
    })),
    privacy: {
      excludesCustomerNamesEmailsPhonesAddresses: true,
      excludesRawOrderPayloads: true,
      boundedCatalogueSampleSize: MAX_PRODUCTS,
      boundedVariantSampleSize: MAX_VARIANTS,
    },
  };
}

function buildStoreUnderstandingSystemPrompt() {
  return [
    "You perform Jefe's Store Understanding pass.",
    "Return exactly one JSON object matching the supplied schema.",
    "Use only the registered belief keys supplied in the prompt.",
    "Every candidate must be grounded in the bounded store summary.",
    "Do not infer merchant goals, private strategy, or anything about individual customers.",
    "Do not include customer names, email addresses, phone numbers or postal addresses.",
    "Use cautious language. These are provisional LLM-derived inferences for merchant confirmation.",
  ].join("\n");
}

/** @param {any} summary */
function buildStoreUnderstandingPrompt(summary) {
  const registry = Object.values(getStoreUnderstandingRegistry()).map((definition) => ({
    key: definition.key,
    category: definition.category,
    valueType: definition.valueType,
    allowedValues: definition.allowedValues ?? [],
    description: definition.description,
    minimumEvidence: definition.minimumEvidence,
    confidenceCeiling: definition.confidenceCeiling,
    guidance: definition.promptGuidance,
  }));
  return JSON.stringify({
    promptVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
    instructions: {
      allowedBeliefsOnly: true,
      keepReasonsConcise: true,
      confidenceIsTentative: true,
      unsupportedTopicsGoInUncertainties: true,
      maximumCandidateBeliefs: 6,
      maximumSupportingEvidencePerBelief: 2,
      maximumUncertainties: 4,
      maximumSuggestedInterviewConfirmations: 4,
    },
    registry,
    storeSummary: summary,
  });
}

/**
 * @param {{ output: any; summary: any; provider: import("../llm/provider.server.js").LlmProvider; runId: string; inputSummaryHash: string }} input
 */
function validateCandidateBeliefs(input) {
  const accepted = /** @type {any[]} */ ([]);
  const rejected = /** @type {any[]} */ ([]);
  const seen = new Set();
  for (const candidate of input.output.candidateBeliefs) {
    if (seen.has(candidate.beliefKey)) {
      rejected.push({ beliefKey: candidate.beliefKey, reason: "duplicate_key" });
      continue;
    }
    seen.add(candidate.beliefKey);
    const definition = getStoreUnderstandingDefinition(candidate.beliefKey);
    if (!definition) {
      rejected.push({ beliefKey: candidate.beliefKey, reason: "unsupported_key" });
      continue;
    }
    if (!hasMinimumEvidence(definition, input.summary)) {
      rejected.push({
        beliefKey: candidate.beliefKey,
        reason: "minimum_evidence_not_met",
      });
      continue;
    }
    const value = validateStoreUnderstandingValue(candidate.value, definition);
    if (!value.ok) {
      rejected.push({
        beliefKey: candidate.beliefKey,
        reason: "invalid_value",
        detail: value.error,
      });
      continue;
    }
    if (candidate.supportingEvidence.length === 0) {
      rejected.push({ beliefKey: candidate.beliefKey, reason: "missing_evidence" });
      continue;
    }
    const confidence = cappedStoreUnderstandingConfidence(
      definition,
      candidate.confidence,
      input.summary,
    );
    if (confidence < MIN_ACCEPTED_CONFIDENCE) {
      rejected.push({
        beliefKey: candidate.beliefKey,
        reason: "confidence_too_low",
      });
      continue;
    }
    accepted.push({
      definition,
      beliefKey: candidate.beliefKey,
      value: value.value,
      valueType: definition.valueType,
      confidence,
      confidenceReason: candidate.reason,
      supportingEvidence: candidate.supportingEvidence,
      modelConfidence: candidate.confidence,
    });
  }
  return {
    candidateCount: input.output.candidateBeliefs.length,
    accepted,
    rejected,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; runId: string; inputSummaryHash: string; provider: import("../llm/provider.server.js").LlmProvider; candidate: any }} input
 */
async function upsertStoreUnderstandingBelief(prisma, input) {
  const existing = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: input.merchantId,
      key: input.candidate.beliefKey,
      status: { in: ACTIVE_BELIEF_STATUSES },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (existing && AUTHORITATIVE_BELIEF_STATUSES.includes(existing.status)) {
    return {
      skipped: true,
      belief: existing,
      rejection: {
        beliefKey: input.candidate.beliefKey,
        reason: "authoritative_belief_exists",
      },
    };
  }
  if (
    existing &&
    existing.derivationVersion !== STORE_UNDERSTANDING_DERIVATION_VERSION &&
    existing.precedence >= BELIEF_PRECEDENCE.directObservation
  ) {
    return {
      skipped: true,
      belief: existing,
      rejection: {
        beliefKey: input.candidate.beliefKey,
        reason: "higher_precedence_belief_exists",
      },
    };
  }

  const now = new Date();
  const data = {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    category: input.candidate.definition.category,
    key: input.candidate.beliefKey,
    value: input.candidate.value,
    valueType: input.candidate.valueType,
    status: BELIEF_STATUS.inferred,
    confidence: String(input.candidate.confidence.toFixed(4)),
    confidenceReason: input.candidate.confidenceReason,
    precedence: BELIEF_PRECEDENCE.llmInference,
    derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
    firstObservedAt: existing?.firstObservedAt ?? now,
    lastObservedAt: now,
    lastEvaluatedAt: now,
  };
  const belief = existing
    ? await prisma.merchantMemoryBelief.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.merchantMemoryBelief.create({ data });

  await prisma.merchantMemoryBeliefHistory.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      beliefId: belief.id,
      key: belief.key,
      previousStatus: existing?.status ?? null,
      newStatus: belief.status,
      previousValue: existing?.value ?? undefined,
      newValue: belief.value ?? undefined,
      changeReason: existing
        ? valuesEqual(existing.value, belief.value)
          ? "llm_store_analysis_recalculated"
          : "llm_store_analysis_updated"
        : "llm_store_analysis_created",
      changedBy: "llm_store_analysis",
      metadata: {
        derivationFamily: "llm_store_understanding",
        derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
        runId: input.runId,
        provider: input.provider.provider,
        model: input.provider.model,
        promptVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
        inputSummaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
        inputSummaryHash: input.inputSummaryHash,
        modelConfidence: input.candidate.modelConfidence,
        cappedConfidence: input.candidate.confidence,
        recommendedForConfirmation: true,
        qualityFlags: ["recommended_for_confirmation"],
      },
    },
  });
  await prisma.merchantMemoryEvidence.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      beliefId: belief.id,
      sourceType: "llm_store_analysis",
      sourceReference: input.runId,
      evidenceType: "model_inference",
      summary: `Store Understanding inferred ${belief.key}: ${formatInferenceValue(belief.value)}.`,
      metadata: {
        derivationFamily: "llm_store_understanding",
        derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
        provider: input.provider.provider,
        model: input.provider.model,
        promptVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
        inputSummaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
        inputSummaryHash: input.inputSummaryHash,
        inputSnapshot: {
          summaryVersion: STORE_UNDERSTANDING_INPUT_VERSION,
          summaryHash: input.inputSummaryHash,
        },
        precedence: BELIEF_PRECEDENCE.llmInference,
        recommendedForConfirmation: true,
        qualityFlags: ["recommended_for_confirmation"],
        supportingEvidence: input.candidate.supportingEvidence,
        rationale: input.candidate.confidenceReason,
        confidenceCalculation: {
          modelConfidence: input.candidate.modelConfidence,
          confidenceCeiling: input.candidate.definition.confidenceCeiling,
          finalConfidence: input.candidate.confidence,
        },
        analysedAt: now.toISOString(),
      },
      observedAt: now,
    },
  });
  return { skipped: false, belief };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; acceptedKeys: Set<string>; runId: string }} input
 */
async function obsoleteUnsupportedStoreUnderstandingBeliefs(prisma, input) {
  const registryKeys = Object.keys(getStoreUnderstandingRegistry());
  const stale = await prisma.merchantMemoryBelief.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      key: { in: registryKeys.filter((key) => !input.acceptedKeys.has(key)) },
      status: BELIEF_STATUS.inferred,
      derivationVersion: STORE_UNDERSTANDING_DERIVATION_VERSION,
    },
  });
  for (const belief of stale) {
    await prisma.merchantMemoryBelief.update({
      where: { id: belief.id },
      data: { status: BELIEF_STATUS.obsolete, supersededAt: new Date() },
    });
    await prisma.merchantMemoryBeliefHistory.create({
      data: {
        merchantId: belief.merchantId,
        shopId: belief.shopId,
        beliefId: belief.id,
        key: belief.key,
        previousStatus: belief.status,
        newStatus: BELIEF_STATUS.obsolete,
        previousValue: belief.value ?? undefined,
        newValue: belief.value ?? undefined,
        changeReason: "llm_store_analysis_no_longer_supported",
        changedBy: "llm_store_analysis",
        metadata: { runId: input.runId },
      },
    });
  }
  return stale.length;
}

/** @param {any} summary */
function hashSummary(summary) {
  const stableSummary = { ...summary, generatedAt: undefined };
  return createHash("sha256").update(JSON.stringify(stableSummary)).digest("hex");
}

/** @param {Pick<Console, "info" | "warn" | "error">} logger */
function safeCreateLlmProvider(logger) {
  try {
    return createLlmProvider({ logger });
  } catch (error) {
    logger.warn("Store Understanding LLM provider unavailable", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/** @param {unknown} rawPayload */
function extractTags(rawPayload) {
  const payload = jsonObject(rawPayload);
  const tags = Array.isArray(payload.tags)
    ? payload.tags
    : typeof payload.tags === "string"
      ? payload.tags.split(",")
      : [];
  return tags
    .filter((tag) => typeof tag === "string")
    .map((tag) => safeText(tag, 40))
    .filter(Boolean);
}

/** @param {unknown} rawPayload */
function descriptionExcerpt(rawPayload) {
  const payload = jsonObject(rawPayload);
  const raw =
    typeof payload.description === "string"
      ? payload.description
      : typeof payload.body_html === "string"
        ? payload.body_html
        : typeof payload.bodyHtml === "string"
          ? payload.bodyHtml
          : "";
  return safeText(raw.replace(/<[^>]+>/g, " "), 220);
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function safeText(value, max) {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, max) || null;
}

/** @param {Array<string | null | undefined>} values */
function topCounts(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value || !value.trim()) continue;
    const key = value.trim().slice(0, 80);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([value, count]) => ({ value, count }));
}

/** @param {number[]} values */
function priceDistribution(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  return {
    min: roundNumber(clean[0], 2),
    median: roundNumber(clean[Math.floor(clean.length / 2)], 2),
    max: roundNumber(clean[clean.length - 1], 2),
    pricedVariantCount: clean.length,
  };
}

/** @param {Array<unknown>} values */
function averageMoney(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  if (clean.length === 0) return null;
  return roundNumber(clean.reduce((total, value) => total + value, 0) / clean.length, 2);
}

/** @param {Array<{ id: string }>} orders @param {Array<{ productId: string | null; title: string | null; quantity: number; totalPrice: unknown }>} lineItems */
function averageItemsPerOrder(orders, lineItems) {
  if (orders.length === 0) return null;
  const total = lineItems.reduce((sum, item) => sum + item.quantity, 0);
  return roundNumber(total / orders.length, 2);
}

/** @param {Array<{ productId: string | null; title: string | null; quantity: number; totalPrice: unknown }>} lineItems */
function topProductsByUnits(lineItems) {
  const byTitle = new Map();
  for (const item of lineItems) {
    const title = item.title?.trim();
    if (!title) continue;
    const current = byTitle.get(title) ?? { title, units: 0, revenue: 0 };
    current.units += item.quantity;
    current.revenue += Number(item.totalPrice) || 0;
    byTitle.set(title, current);
  }
  return Array.from(byTitle.values()).sort((a, b) => b.units - a.units);
}

/** @param {{ status: string | null }} product */
function isActiveProduct(product) {
  return String(product.status ?? "").toUpperCase() === "ACTIVE";
}

/** @param {number} value @param {number} places */
function roundNumber(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} a @param {unknown} b */
function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {unknown} rawPayload
 * @param {string} merchantName
 */
function storeNameFrom(rawPayload, merchantName) {
  const payload = jsonObject(rawPayload);
  const candidates = [payload.name, payload.shop?.name, payload.shopName, merchantName];
  return candidates.find((value) => typeof value === "string" && value.trim())
    ?.trim();
}
