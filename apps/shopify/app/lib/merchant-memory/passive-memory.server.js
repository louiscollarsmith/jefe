// @ts-check

import crypto from "node:crypto";
import { Type } from "@google/genai";
import { createLlmProvider } from "../llm/provider.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { getMerchantMemoryV2Config } from "./config.server.js";
import { sanitizeMemoryText } from "./episodic-memory.server.js";
import {
  BELIEF_PRECEDENCE,
  BELIEF_STATUS,
  DERIVATION_LOOKUP_STATUSES,
} from "./constants.server.js";
import {
  beliefDefinitionChangesBehaviour,
  getBeliefDefinition,
  getConversationalBeliefRegistry,
  validateConversationalValue,
} from "./conversational-belief-registry.server.js";
import { retrieveSemanticMemory } from "./retrievers/semantic-memory-retriever.server.js";
import {
  retractBeliefForMerchant,
  upsertMerchantSuppliedBelief,
} from "./service.server.js";

export const PASSIVE_MEMORY_EXTRACTOR_VERSION = "passive-memory-v2";
export const PASSIVE_MEMORY_SCHEMA_VERSION = "message-decision-v2";

export const MERCHANT_MESSAGE_ACTIONS = Object.freeze([
  "acknowledge_memory",
  "commerce_analysis",
  "historical_recall",
  "general_chat",
]);

const log = baseLogger.child({ component: "passive-merchant-memory" });
const ALLOWED_OPERATIONS = new Set([
  "create",
  "correct",
  "retract",
  "conflict",
  "unmapped",
  "noop",
]);
const ALLOWED_SCOPE_KEYS = new Set([
  "market",
  "countryCode",
  "salesChannel",
  "locationId",
  "customerSegment",
  "collectionId",
  "productId",
  "sku",
  "timePeriod",
]);
const MESSAGE_DECISION_MAX_INPUT_TOKENS = 8000;
const MESSAGE_DECISION_MEMORY_LIMIT = 8;
const MESSAGE_DECISION_TEXT_LIMIT = 360;
const MESSAGE_DECISION_DATA_LIMIT = 320;
const MESSAGE_DECISION_GUIDANCE_LIMIT = 160;

const MESSAGE_DECISION_SCHEMA = {
  type: Type.OBJECT,
  required: ["action", "candidates"],
  properties: {
    action: {
      type: Type.STRING,
      enum: MERCHANT_MESSAGE_ACTIONS,
    },
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "operationType",
          "key",
          "proposedValue",
          "confidence",
          "rationale",
          "explicitChange",
        ],
        properties: {
          operationType: {
            type: Type.STRING,
            enum: [
              "create",
              "correct",
              "retract",
              "conflict",
              "unmapped",
              "noop",
            ],
          },
          key: { type: Type.STRING, nullable: true },
          proposedValue: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              text: { type: Type.STRING, nullable: true },
              number: { type: Type.NUMBER, nullable: true },
              boolean: { type: Type.BOOLEAN, nullable: true },
              option: { type: Type.STRING, nullable: true },
              currency: { type: Type.STRING, nullable: true },
              amount: { type: Type.NUMBER, nullable: true },
              percentage: { type: Type.NUMBER, nullable: true },
              timestamp: { type: Type.STRING, nullable: true },
            },
          },
          confidence: { type: Type.NUMBER },
          rationale: { type: Type.STRING },
          explicitChange: { type: Type.BOOLEAN },
          scope: { type: Type.OBJECT, nullable: true },
          validFrom: { type: Type.STRING, nullable: true },
          validUntil: { type: Type.STRING, nullable: true },
        },
      },
    },
  },
};

/**
 * Extract and deterministically adjudicate durable memory candidates for one
 * merchant-authored source message. Safe to retry.
 * @param {any} prisma
 * @param {{ messageId: string; semanticMemory?: any[]; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function processPassiveMemoryMessage(prisma, input) {
  const message = await prisma.merchantMemoryConversationMessage.findUnique({
    where: { id: input.messageId },
    include: { conversation: true },
  });
  if (
    !message ||
    message.role !== "merchant" ||
    !message.shopId ||
    message.visibility !== "current" ||
    message.retractedAt
  ) {
    return { processed: false, reason: "ineligible_source" };
  }
  if (message.processingStatus === "complete") {
    return {
      processed: false,
      reason: "already_processed",
      action: "general_chat",
      candidates: [],
    };
  }
  const config = getMerchantMemoryV2Config();
  if (!config.passiveMemoryEnabled) {
    await prisma.merchantMemoryConversationMessage.update({
      where: { id: message.id },
      data: { processingStatus: "indexed" },
    });
    return { processed: false, reason: "passive_memory_disabled" };
  }
  const semanticMemory =
    input.semanticMemory ??
    (await retrieveSemanticMemory(prisma, {
      merchantId: message.merchantId,
      shopId: message.shopId,
      take: 16,
    }));
  const decision = await decideMerchantMessage({
    prisma,
    message,
    semanticMemory,
    llmProvider: input.llmProvider,
    logger: input.logger ?? log,
  });
  const proposals = decision.candidates;
  const candidates =
    proposals.length > 0
      ? proposals
      : [
          {
            operationType: "noop",
            key: null,
            proposedValue: null,
            confidence: 1,
            rationale: "No durable business memory identified.",
            explicitChange: false,
          },
        ];
  const results = [];
  for (const proposal of candidates.slice(0, 8)) {
    const persisted = await persistCandidate(prisma, { message, proposal });
    if (persisted.status === "pending") {
      results.push(
        await adjudicateCandidate(prisma, {
          candidate: persisted,
          message,
          proposal,
        }),
      );
    } else {
      results.push(persisted);
    }
  }
  await prisma.merchantMemoryConversationMessage.update({
    where: { id: message.id },
    data: {
      processingStatus: "complete",
      metadata: {
        ...(message.metadata && typeof message.metadata === "object"
          ? message.metadata
          : {}),
        messageDecision: {
          action: decision.action,
          reason: decision.reason,
          candidateCount: results.length,
          candidateStatuses: results.map(
            (/** @type {any} */ candidate) => candidate.status,
          ),
          reasonCodes: results
            .map((/** @type {any} */ candidate) => candidate.reasonCode)
            .filter(Boolean),
          version: PASSIVE_MEMORY_SCHEMA_VERSION,
        },
      },
    },
  });
  return {
    processed: true,
    action: decision.action,
    candidates: results,
  };
}

/** @param {{ prisma: any; message: any; semanticMemory: any[]; llmProvider?: any; logger: any }} input */
export async function decideMerchantMessage(input) {
  const provider =
    input.llmProvider ??
    createMerchantMessageDecisionProvider(input);
  if (!provider?.enabled || !provider.generateStructuredJson) {
    return {
      action: "general_chat",
      candidates: [],
      reason: "provider_unavailable",
    };
  }
  const writableRegistry = Object.values(getConversationalBeliefRegistry())
    .filter(
      (definition) =>
        definition.merchantCreatable ||
        definition.merchantCorrectable ||
        definition.merchantObsoletable,
    )
    .map((definition) => ({
      key: definition.key,
      category: definition.category,
      valueType: definition.valueType,
      allowedValues: definition.allowedValues,
      creatable: definition.merchantCreatable,
      correctable: definition.merchantCorrectable,
      retractable: definition.merchantObsoletable,
      decisionImpact: definition.decisionImpact ?? definition.kind,
      guidance: truncateDecisionText(
        definition.guidance,
        MESSAGE_DECISION_GUIDANCE_LIMIT,
      ),
    }));
  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: [
        "Decide what Jefe should do with this merchant-authored message before any specialist tool runs.",
        "Choose commerce_analysis only when the merchant is actually asking for current or quantitative commerce analysis. Mentioning revenue, margin, stock, orders, or another commerce topic inside an instruction is not an analysis request.",
        "Choose acknowledge_memory when the merchant explicitly states a durable business fact, goal, constraint, policy, preference, correction, or retraction that fits the writable registry.",
        "Choose historical_recall when the merchant asks what was said, discussed, decided, or recommended previously.",
        "Choose general_chat for everything else.",
        "Ordinary anecdotes and assistant statements are not durable memory.",
        "Use only a supplied registry key. Choose the most specific matching key. If nothing fits, return unmapped or noop; never invent a key.",
        "A correction or reactivation must be explicit in the merchant's current words.",
        "Wrap candidate values by registry type: string as {text}, boolean as {boolean}, enum as {option}, number as {number}, percentage as {percentage}, currency_code as {currency}, and timestamp as {timestamp}.",
        "For a strong rule about recommendations that has no narrower registered key, use policies.never_recommend with a concise {text} description of what Jefe must avoid.",
        "Do not include customer personal data. Do not claim anything was persisted.",
      ].join("\n"),
      prompt: JSON.stringify({
        merchantMessage: sanitizeMemoryText(input.message.content),
        currentSemanticMemory: compactDecisionSemanticMemory(
          input.semanticMemory,
        ),
        writableRegistry,
      }),
      schema: MESSAGE_DECISION_SCHEMA,
      maxInputTokens: MESSAGE_DECISION_MAX_INPUT_TOKENS,
      maxOutputTokens: 1200,
    });
    const candidates = Array.isArray(result.json?.candidates)
      ? result.json.candidates
      : [];
    const action = MERCHANT_MESSAGE_ACTIONS.includes(result.json?.action)
      ? result.json.action
      : "general_chat";
    return { action, candidates, reason: "model_decision" };
  } catch (error) {
    input.logger.warn(
      "Merchant message decision unavailable; using general chat",
      {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.message.merchantId,
        shopId: input.message.shopId,
        messageId: input.message.id,
      },
    );
    return {
      action: "general_chat",
      candidates: [],
      reason: "provider_unavailable",
    };
  }
}

/** @param {any[]} items */
function compactDecisionSemanticMemory(items) {
  return (items ?? [])
    .slice(0, MESSAGE_DECISION_MEMORY_LIMIT)
    .map((item) => ({
      id: item.id,
      key: item.key ?? item.data?.key ?? null,
      category: item.category ?? item.data?.category ?? null,
      content: truncateDecisionText(item.content, MESSAGE_DECISION_TEXT_LIMIT),
      authority: item.authority ?? null,
      confidence: item.confidence ?? null,
      temporalStatus: item.temporalStatus ?? "current",
      scope: item.scope ?? null,
      data: truncateDecisionJson(item.data, MESSAGE_DECISION_DATA_LIMIT),
      source: item.source
        ? {
            type: item.source.type ?? null,
            beliefId: item.source.beliefId ?? null,
          }
        : null,
    }));
}

/** @param {unknown} value @param {number} limit */
function truncateDecisionJson(value, limit) {
  if (!value || typeof value !== "object") return value ?? null;
  const text = JSON.stringify(value);
  if (text.length <= limit) return value;
  return { summary: truncateDecisionText(text, limit) };
}

/** @param {unknown} value @param {number} limit */
function truncateDecisionText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

/** @param {{ prisma: any; message: any; logger: any }} input */
function createMerchantMessageDecisionProvider(input) {
  return createLlmProvider({
    logger: input.logger,
    usage: {
      prisma: input.prisma,
      merchantId: input.message.merchantId,
      shopId: input.message.shopId,
      feature: "merchant_message_decision",
    },
  });
}

/** @param {any} prisma @param {{ message: any; proposal: any }} input */
async function persistCandidate(prisma, input) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      `${PASSIVE_MEMORY_EXTRACTOR_VERSION}:${input.message.id}:${input.proposal.operationType}:${input.proposal.key ?? ""}:${JSON.stringify(input.proposal.proposedValue ?? null)}`,
    )
    .digest("hex");
  return prisma.merchantMemoryCandidate.upsert({
    where: { candidateFingerprint: fingerprint },
    create: {
      merchantId: input.message.merchantId,
      shopId: input.message.shopId,
      sourceMessageId: input.message.id,
      candidateFingerprint: fingerprint,
      operationType: String(input.proposal.operationType ?? "noop"),
      category: input.proposal.key?.split(".")[0] ?? null,
      key: input.proposal.key ?? null,
      proposedValue: input.proposal.proposedValue ?? undefined,
      valueType: input.proposal.key
        ? (getBeliefDefinition(input.proposal.key)?.valueType ?? null)
        : null,
      scope: sanitiseScope(input.proposal.scope),
      validFrom: parseDate(input.proposal.validFrom),
      validUntil: parseDate(input.proposal.validUntil),
      confidence: clampConfidence(input.proposal.confidence),
      rationaleSummary: safeSummary(input.proposal.rationale),
      extractorVersion: PASSIVE_MEMORY_EXTRACTOR_VERSION,
      schemaVersion: PASSIVE_MEMORY_SCHEMA_VERSION,
    },
    update: {},
  });
}

/** @param {any} prisma @param {{ candidate: any; message: any; proposal: any }} input */
async function adjudicateCandidate(prisma, input) {
  const { candidate, message, proposal } = input;
  if (!ALLOWED_OPERATIONS.has(candidate.operationType)) {
    return finishCandidate(
      prisma,
      candidate.id,
      "rejected",
      "operation_not_allowed",
    );
  }
  if (["noop", "unmapped"].includes(candidate.operationType)) {
    return finishCandidate(
      prisma,
      candidate.id,
      candidate.operationType,
      candidate.operationType === "noop"
        ? "not_durable"
        : "unmapped_registry_key",
    );
  }
  const definition = candidate.key ? getBeliefDefinition(candidate.key) : null;
  if (!definition)
    return finishCandidate(
      prisma,
      candidate.id,
      "rejected",
      "unmapped_registry_key",
    );
  if (!beliefDefinitionChangesBehaviour(definition)) {
    return finishCandidate(
      prisma,
      candidate.id,
      "rejected",
      "no_decision_impact",
    );
  }
  if (
    !validScope(candidate.scope) ||
    !validTemporalRange(candidate.validFrom, candidate.validUntil)
  ) {
    return finishCandidate(
      prisma,
      candidate.id,
      "rejected",
      "invalid_scope_or_time",
    );
  }
  const existing = await prisma.merchantMemoryBelief.findFirst({
    where: {
      merchantId: candidate.merchantId,
      OR: [{ shopId: candidate.shopId }, { shopId: null }],
      key: candidate.key,
      status: { in: DERIVATION_LOOKUP_STATUSES },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (candidate.operationType === "retract") {
    if (
      !definition.merchantObsoletable ||
      !proposal.explicitChange ||
      !existing ||
      existing.status === BELIEF_STATUS.merchantRetracted
    ) {
      return finishCandidate(
        prisma,
        candidate.id,
        "rejected",
        "retraction_not_explicit_or_missing",
      );
    }
    const belief = await retractBeliefForMerchant(prisma, {
      merchantId: candidate.merchantId,
      shopId: candidate.shopId,
      key: candidate.key,
      retractedBy: "passive_merchant_memory",
      metadata: { candidateId: candidate.id, sourceMessageId: message.id },
    });
    if (belief)
      await historicaliseBeliefSources(prisma, {
        beliefId: belief.id,
        merchantId: candidate.merchantId,
        shopId: candidate.shopId,
        sourceMessageId: message.id,
      });
    return finishCandidate(
      prisma,
      candidate.id,
      "promoted",
      "merchant_retraction",
      belief?.id ?? null,
    );
  }
  if (!definition.merchantCreatable && !existing) {
    return finishCandidate(
      prisma,
      candidate.id,
      "rejected",
      "key_not_merchant_creatable",
    );
  }
  if (existing && !definition.merchantCorrectable) {
    return finishCandidate(
      prisma,
      candidate.id,
      "rejected",
      "key_not_merchant_correctable",
    );
  }
  const validated = validateConversationalValue(
    candidate.proposedValue,
    definition,
  );
  if (!validated.ok)
    return finishCandidate(prisma, candidate.id, "rejected", "invalid_value");
  if (
    existing?.status === BELIEF_STATUS.merchantRetracted &&
    !proposal.explicitChange
  ) {
    return finishCandidate(
      prisma,
      candidate.id,
      "suppressed_retraction",
      "merchant_retracted",
    );
  }
  if (
    existing &&
    JSON.stringify(existing.value) === JSON.stringify(validated.value)
  ) {
    return finishCandidate(prisma, candidate.id, "rejected", "no_change");
  }
  if (
    existing &&
    existing.status !== BELIEF_STATUS.merchantRetracted &&
    candidate.operationType !== "correct" &&
    !proposal.explicitChange
  ) {
    await createConflictQuestion(prisma, { candidate, definition });
    return finishCandidate(
      prisma,
      candidate.id,
      "conflict",
      "ambiguous_conflict",
    );
  }
  if (existing && candidate.operationType === "correct") {
    await historicaliseBeliefSources(prisma, {
      beliefId: existing.id,
      merchantId: candidate.merchantId,
      shopId: candidate.shopId,
    });
  }
  const promoted = await upsertMerchantSuppliedBelief(prisma, {
    merchantId: candidate.merchantId,
    shopId: candidate.shopId,
    category: definition.category,
    key: definition.key,
    value: validated.value,
    valueType: definition.valueType,
    suppliedBy: "passive_merchant_memory",
    suppliedAt: message.createdAt,
    evidenceSummary: safeSummary(message.safeSummary ?? message.content),
    evidenceSourceType: "merchant_conversation",
    evidenceSourceReference: `conversation:${message.conversationId}:message:${message.id}`,
    metadata: { candidateId: candidate.id, sourceMessageId: message.id },
    precedence:
      definition.kind === "policy"
        ? BELIEF_PRECEDENCE.houseRule
        : BELIEF_PRECEDENCE.merchantConfirmation,
    scope: candidate.scope ?? {},
    validFrom: candidate.validFrom,
    validUntil: candidate.validUntil,
    allowRetractedSuccessor: Boolean(
      existing?.status === BELIEF_STATUS.merchantRetracted &&
      proposal.explicitChange,
    ),
  });
  if (promoted.suppressed) {
    return finishCandidate(
      prisma,
      candidate.id,
      "suppressed_retraction",
      "merchant_retracted",
    );
  }
  const linkedEpisodes = await prisma.merchantMemoryEpisode.findMany({
    where: {
      merchantId: candidate.merchantId,
      sourceMessageIds: { has: message.id },
    },
    select: { id: true, relatedBeliefIds: true },
  });
  await Promise.all(
    linkedEpisodes.map((/** @type {any} */ episode) =>
      prisma.merchantMemoryEpisode.update({
        where: { id: episode.id },
        data: {
          relatedBeliefIds: [
            ...new Set([...episode.relatedBeliefIds, promoted.belief.id]),
          ],
        },
      }),
    ),
  );
  return finishCandidate(
    prisma,
    candidate.id,
    "promoted",
    promoted.created ? "created" : "corrected",
    promoted.belief.id,
  );
}

/** @param {any} prisma @param {{ candidate: any; definition: any }} input */
async function createConflictQuestion(prisma, input) {
  const questionKey = `passive_conflict:${input.definition.key}`;
  await prisma.merchantMemoryOpenQuestion.upsert({
    where: {
      merchantId_questionKey: {
        merchantId: input.candidate.merchantId,
        questionKey,
      },
    },
    create: {
      merchantId: input.candidate.merchantId,
      shopId: input.candidate.shopId,
      category: input.definition.category,
      questionKey,
      question: `You’ve told me something different about ${input.definition.label.toLowerCase()}. What should I treat as current?`,
      reason:
        "A newer ordinary conversation conflicts with current Merchant Memory.",
      priority: 15,
      status: "open",
      answerType: "text",
      answerOptions: [],
    },
    update: {
      status: "open",
      answeredAt: null,
      shopId: input.candidate.shopId,
    },
  });
}

/** @param {any} prisma @param {{ beliefId: string; merchantId: string; shopId?: string | null; sourceMessageId?: string | null }} input */
export async function historicaliseBeliefSources(prisma, input) {
  const [candidates, evidence] = await Promise.all([
    prisma.merchantMemoryCandidate.findMany({
      where: { merchantId: input.merchantId, promotedBeliefId: input.beliefId },
      select: { sourceMessageId: true },
    }),
    prisma.merchantMemoryEvidence.findMany({
      where: { merchantId: input.merchantId, beliefId: input.beliefId },
      select: { sourceReference: true },
    }),
  ]);
  const evidenceMessageIds = evidence.flatMap((/** @type {any} */ item) => {
    const match = String(item.sourceReference ?? "").match(
      /:message:([0-9a-f-]{36})$/i,
    );
    return match ? [match[1]] : [];
  });
  const sourceMessageIds = [
    ...new Set([
      ...candidates.map((/** @type {any} */ item) => item.sourceMessageId),
      ...evidenceMessageIds,
      ...(input.sourceMessageId ? [input.sourceMessageId] : []),
    ]),
  ];
  await prisma.merchantMemoryCandidate.updateMany({
    where: { merchantId: input.merchantId, promotedBeliefId: input.beliefId },
    data: {
      status: "suppressed_retraction",
      reasonCode: "merchant_retracted",
      processedAt: new Date(),
    },
  });
  if (sourceMessageIds.length > 0) {
    await prisma.merchantMemoryConversationMessage.updateMany({
      where: { merchantId: input.merchantId, id: { in: sourceMessageIds } },
      data: { visibility: "historical_only", retractedAt: new Date() },
    });
  }
  await prisma.merchantMemoryEpisode.updateMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      OR: [
        { relatedBeliefIds: { has: input.beliefId } },
        ...(sourceMessageIds.length
          ? [{ sourceMessageIds: { hasSome: sourceMessageIds } }]
          : []),
      ],
    },
    data: { visibility: "historical_only", processingStatus: "stale" },
  });
}

/** @param {any} prisma @param {string} id @param {string} status @param {string} reasonCode @param {string | null} [promotedBeliefId] */
function finishCandidate(
  prisma,
  id,
  status,
  reasonCode,
  promotedBeliefId = null,
) {
  return prisma.merchantMemoryCandidate.update({
    where: { id },
    data: { status, reasonCode, promotedBeliefId, processedAt: new Date() },
  });
}

/** @param {any} value */
function sanitiseScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        ALLOWED_SCOPE_KEYS.has(key) &&
        ["string", "number", "boolean"].includes(typeof item),
    ),
  );
}

/** @param {any} value */
function validScope(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => ALLOWED_SCOPE_KEYS.has(key))
  );
}

/** @param {Date | null} from @param {Date | null} until */
function validTemporalRange(from, until) {
  return !from || !until || from < until;
}

/** @param {any} value */
function parseDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {any} value */
function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

/** @param {any} value */
function safeSummary(value) {
  const string = sanitizeMemoryText(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return string.length > 300 ? `${string.slice(0, 297)}...` : string;
}
