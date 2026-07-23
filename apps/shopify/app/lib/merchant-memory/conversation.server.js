// @ts-check

import {
  createLlmProvider,
} from "../llm/provider.server.js";
import {
  STRUCTURED_OPERATION_SCHEMA,
  parseAndValidateStructuredOperation,
} from "../llm/structured-operation-schema.server.js";
import {
  BELIEF_PRECEDENCE,
} from "./constants.server.js";
import {
  OPERATION_STATUS,
  OPERATION_TYPES,
} from "./conversation-constants.server.js";
import {
  confirmBelief,
  correctBelief,
  getBeliefsForMerchant,
  revertLatestMerchantSuppliedChange,
  upsertMerchantSuppliedBelief,
} from "./service.server.js";
import {
  formatBeliefValue,
  getConversationalBeliefRegistry,
  getBeliefDefinition,
  isAllowedConversationalCategory,
  labelForBeliefKey,
  validateConversationalValue,
} from "./conversational-belief-registry.server.js";

export { OPERATION_STATUS, OPERATION_TYPES };

const INITIAL_OPEN_QUESTIONS = [
  {
    category: "goals",
    questionKey: "goals.primary_business_goal",
    question: "What is the main goal you want Jefe to help with first?",
    reason: "Jefe needs one clear target before recommendations can become useful.",
    priority: 10,
    answerType: "text",
    answerOptions: [],
  },
  {
    category: "preferences",
    questionKey: "preferences.optimisation_priority",
    question: "What should Jefe optimise for: growth, profit, cash flow, or something else?",
    reason: "This affects how Jefe should evaluate tradeoffs.",
    priority: 20,
    answerType: "option",
    answerOptions: ["growth", "profit", "cash_flow", "retention", "revenue"],
  },
  {
    category: "policies",
    questionKey: "policies.business_rules",
    question: "Are there any business rules Jefe should never break?",
    reason: "Hard constraints prevent unsafe or unsuitable future recommendations.",
    priority: 30,
    answerType: "text",
    answerOptions: [],
  },
];

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
export async function getMerchantMemoryConversationExperience(prisma, input) {
  await ensureInitialOpenQuestions(prisma, input);
  const [conversation, summary] = await Promise.all([
    getOrCreateConversation(prisma, input),
    getMerchantMemorySummary(prisma, input),
  ]);

  let messages = await listConversationMessages(prisma, {
    conversationId: conversation.id,
    merchantId: input.merchantId,
  });

  if (messages.length === 0) {
    await prisma.merchantMemoryConversationMessage.create({
      data: {
        conversationId: conversation.id,
        merchantId: input.merchantId,
        shopId: input.shopId ?? null,
        role: "assistant",
        content: buildOpeningMessage(summary),
        operationStatus: null,
        relatedBeliefIds: summary.overviewItems.map((item) => item.id),
        safeSummary: "Initial Jefe introduction.",
      },
    });
    messages = await listConversationMessages(prisma, {
      conversationId: conversation.id,
      merchantId: input.merchantId,
    });
  }

  return {
    conversation: serializeConversation(conversation),
    summary,
    messages,
    suggestions: [
      "That's not quite right",
      "Here's something you should know",
      "Why do you think that?",
      "What else have you noticed?",
      "Let's talk about my customers",
    ],
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
export async function getMerchantMemorySummary(prisma, input) {
  const [beliefs, latestRefresh, recentCorrections, openQuestions] =
    await Promise.all([
      getBeliefsForMerchant(prisma, {
        merchantId: input.merchantId,
        includeEvidence: false,
      }),
      prisma.merchantMemoryRefreshRun.findFirst({
        where: {
          merchantId: input.merchantId,
          shopId: input.shopId ?? undefined,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.merchantMemoryBeliefHistory.findMany({
        where: {
          merchantId: input.merchantId,
          changeReason: {
            in: [
              "merchant_conversation_belief_created",
              "merchant_conversation_belief_updated",
              "merchant_corrected_belief",
              "merchant_confirmed_belief",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
      getOpenQuestions(prisma, input),
    ]);

  const importantKeys = [
    "business.store_name",
    "catalog.active_product_count",
    "orders.average_order_value.all_time",
    "customers.repeat_customer_rate.all_time",
    "inventory.out_of_stock_variant_count",
    "catalog.out_of_stock_product_count",
  ];
  const byKey = new Map(beliefs.map((belief) => [belief.key, belief]));
  const overviewItems = importantKeys
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .slice(0, 5)
    .map(serializeBelief);
  const lowConfidenceItems = beliefs
    .filter((belief) => belief.confidence !== null && belief.confidence < 0.8)
    .slice(0, 3)
    .map(serializeBelief);

  return {
    overviewItems,
    lowConfidenceItems,
    recentCorrections: recentCorrections.map((item) => ({
      id: item.id,
      label: labelForBeliefKey(item.key),
      changeReason: item.changeReason,
      createdAt: item.createdAt.toISOString(),
    })),
    openQuestions: openQuestions.slice(0, 3),
    lastMemoryRefreshAt:
      latestRefresh?.completedAt?.toISOString() ??
      latestRefresh?.startedAt?.toISOString() ??
      null,
    memoryRefreshStatus: latestRefresh?.status ?? null,
    beliefCount: beliefs.length,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
export async function getOpenQuestions(prisma, input) {
  await ensureInitialOpenQuestions(prisma, input);
  const questions = await prisma.merchantMemoryOpenQuestion.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      status: "open",
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return questions.map((question) => ({
    id: question.id,
    category: question.category,
    questionKey: question.questionKey,
    question: question.question,
    reason: question.reason,
    priority: question.priority,
    answerType: question.answerType,
    answerOptions: question.answerOptions,
  }));
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; message: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function sendConversationMessage(prisma, input) {
  const content = input.message.trim();
  if (!content) return { ok: false, error: "Message is required." };

  await ensureInitialOpenQuestions(prisma, input);
  const conversation = await getOrCreateConversation(prisma, input);
  const userMessage = await prisma.merchantMemoryConversationMessage.create({
    data: {
      conversationId: conversation.id,
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      role: "merchant",
      content,
      safeSummary: summarizeMerchantStatement(content),
    },
  });

  const [beliefs, openQuestions, recentMessages] = await Promise.all([
    getBeliefsForMerchant(prisma, {
      merchantId: input.merchantId,
      includeEvidence: true,
    }),
    getOpenQuestions(prisma, input),
    listConversationMessages(prisma, {
      conversationId: conversation.id,
      merchantId: input.merchantId,
      take: 12,
    }),
  ]);
  const context = buildConversationContext(conversation.context, recentMessages);
  const operation = /** @type {any} */ (await interpretMerchantMessageWithLlm({
    message: content,
    beliefs,
    openQuestions,
    context,
    llmProvider: input.llmProvider,
    logger: input.logger,
  }));
  const validation = /** @type {any} */ (await validateStructuredOperation(prisma, {
    merchantId: input.merchantId,
    operation,
    beliefs,
  }));

  if (!validation.ok) {
    const failedOperation = {
      ...operation,
      operationType: OPERATION_TYPES.clarificationRequired,
      reason: validation.error,
      requiresConfirmation: true,
    };
    await createAssistantMessage(prisma, {
      conversation,
      content: validation.merchantMessage,
      operation: failedOperation,
      operationStatus: OPERATION_STATUS.proposed,
      relatedBeliefIds: operation.targetBeliefId ? [operation.targetBeliefId] : [],
      relatedOpenQuestionId: operation.relatedOpenQuestionId,
    });
    return { ok: true };
  }

  if (operation.operationType === OPERATION_TYPES.requestExplanation) {
    const assistantContent = buildExplanation(operation, beliefs);
    await createAssistantMessage(prisma, {
      conversation,
      content: assistantContent,
      operation,
      operationStatus: null,
      relatedBeliefIds: operation.targetBeliefId ? [operation.targetBeliefId] : [],
    });
    await updateConversationContext(prisma, conversation, {
      lastDiscussedBeliefKeys: operation.targetBeliefKey
        ? [operation.targetBeliefKey]
        : context.lastDiscussedBeliefKeys,
      currentOpenQuestionId: openQuestions[0]?.id ?? null,
    });
    return { ok: true };
  }

  if (operation.operationType === OPERATION_TYPES.noMemoryChange) {
    await createAssistantMessage(prisma, {
      conversation,
      content: buildNoChangeResponse(operation, beliefs, openQuestions),
      operation,
      operationStatus: null,
      relatedBeliefIds: operation.relatedBeliefIds ?? [],
      relatedOpenQuestionId: operation.relatedOpenQuestionId,
    });
    await updateConversationContext(prisma, conversation, {
      lastDiscussedBeliefKeys: operation.relatedBeliefKeys ?? [],
      currentOpenQuestionId: openQuestions[0]?.id ?? null,
    });
    return { ok: true };
  }

  if (operation.operationType === OPERATION_TYPES.clarificationRequired) {
    await createAssistantMessage(prisma, {
      conversation,
      content: operation.reason,
      operation,
      operationStatus: OPERATION_STATUS.proposed,
      relatedBeliefIds: operation.targetBeliefId ? [operation.targetBeliefId] : [],
      relatedOpenQuestionId: operation.relatedOpenQuestionId,
    });
    return { ok: true };
  }

  if (operation.requiresConfirmation) {
    await createAssistantMessage(prisma, {
      conversation,
      content: buildProposedChangeResponse(operation),
      operation,
      operationStatus: OPERATION_STATUS.proposed,
      relatedBeliefIds: operation.targetBeliefId ? [operation.targetBeliefId] : [],
      relatedOpenQuestionId: operation.relatedOpenQuestionId,
    });
    await updateConversationContext(prisma, conversation, {
      pendingOperationMessageId: userMessage.id,
      lastDiscussedBeliefKeys: operation.targetBeliefKey
        ? [operation.targetBeliefKey]
        : context.lastDiscussedBeliefKeys,
      currentOpenQuestionId: openQuestions[0]?.id ?? null,
    });
    return { ok: true };
  }

  const commit = await commitStructuredOperation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: conversation.id,
    messageId: userMessage.id,
    operation,
  });
  await createAssistantMessage(prisma, {
    conversation,
    content: buildCommittedChangeResponse(operation, commit),
    operation,
    operationStatus: OPERATION_STATUS.committed,
    relatedBeliefIds: commit.beliefId ? [commit.beliefId] : [],
    relatedOpenQuestionId: operation.relatedOpenQuestionId,
  });
  await updateConversationContext(prisma, conversation, {
    lastDiscussedBeliefKeys: operation.targetBeliefKey
      ? [operation.targetBeliefKey]
      : context.lastDiscussedBeliefKeys,
    lastCommittedBeliefKey: operation.targetBeliefKey ?? null,
    currentOpenQuestionId: openQuestions[1]?.id ?? null,
  });
  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; messageId: string }} input
 */
export async function confirmProposedOperation(prisma, input) {
  const message = await prisma.merchantMemoryConversationMessage.findFirst({
    where: {
      id: input.messageId,
      merchantId: input.merchantId,
      operationStatus: OPERATION_STATUS.proposed,
    },
    include: { conversation: true },
  });
  if (!message?.structuredOperation) {
    return { ok: false, error: "No pending operation was found." };
  }

  const operation = /** @type {any} */ (message.structuredOperation);
  const validation = /** @type {any} */ (await validateStructuredOperation(prisma, {
    merchantId: input.merchantId,
    operation,
  }));
  if (!validation.ok) {
    await prisma.merchantMemoryConversationMessage.update({
      where: { id: message.id },
      data: { operationStatus: OPERATION_STATUS.failed },
    });
    await createAssistantMessage(prisma, {
      conversation: message.conversation,
      content: validation.merchantMessage,
      operation,
      operationStatus: OPERATION_STATUS.failed,
      relatedBeliefIds: message.relatedBeliefIds,
      relatedOpenQuestionId: message.relatedOpenQuestionId,
    });
    return { ok: true };
  }

  const commit = await commitStructuredOperation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: message.conversationId,
    messageId: message.id,
    operation,
  });
  await prisma.merchantMemoryConversationMessage.update({
    where: { id: message.id },
    data: { operationStatus: OPERATION_STATUS.committed },
  });
  await createAssistantMessage(prisma, {
    conversation: message.conversation,
    content: buildCommittedChangeResponse(operation, commit),
    operation,
    operationStatus: OPERATION_STATUS.committed,
    relatedBeliefIds: commit.beliefId ? [commit.beliefId] : message.relatedBeliefIds,
    relatedOpenQuestionId: message.relatedOpenQuestionId,
  });
  await updateConversationContext(prisma, message.conversation, {
    lastDiscussedBeliefKeys: operation.targetBeliefKey
      ? [operation.targetBeliefKey]
      : [],
    lastCommittedBeliefKey: operation.targetBeliefKey ?? null,
    pendingOperationMessageId: null,
  });
  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; messageId: string }} input
 */
export async function rejectProposedOperation(prisma, input) {
  const message = await prisma.merchantMemoryConversationMessage.findFirst({
    where: {
      id: input.messageId,
      merchantId: input.merchantId,
      operationStatus: OPERATION_STATUS.proposed,
    },
    include: { conversation: true },
  });
  if (!message) return { ok: false, error: "No pending operation was found." };
  await prisma.merchantMemoryConversationMessage.update({
    where: { id: message.id },
    data: { operationStatus: OPERATION_STATUS.rejected },
  });
  await createAssistantMessage(prisma, {
    conversation: message.conversation,
    content: "No change made. I’ll keep the existing understanding for now.",
    operation: message.structuredOperation,
    operationStatus: OPERATION_STATUS.rejected,
    relatedBeliefIds: message.relatedBeliefIds,
    relatedOpenQuestionId: message.relatedOpenQuestionId,
  });
  await updateConversationContext(prisma, message.conversation, {
    pendingOperationMessageId: null,
  });
  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
export async function undoLatestMerchantMemoryChange(prisma, input) {
  const conversation = await getOrCreateConversation(prisma, input);
  const reverted = await revertLatestMerchantSuppliedChange(prisma, {
    merchantId: input.merchantId,
    changedByPrefix: "merchant_conversation",
    revertedBy: "merchant_conversation",
    metadata: { conversationId: conversation.id },
  });
  await createAssistantMessage(prisma, {
    conversation,
    content: reverted
      ? `I’ve undone the latest change about ${labelForBeliefKey(reverted.key)}.`
      : "I could not find a recent change from this conversation to undo.",
    operation: {
      operationType: reverted
        ? "undo_latest_change"
        : OPERATION_TYPES.noMemoryChange,
      targetBeliefKey: reverted?.key ?? null,
      reason: "Merchant requested undo.",
    },
    operationStatus: reverted ? OPERATION_STATUS.reverted : null,
    relatedBeliefIds: reverted ? [reverted.id] : [],
  });
  return { ok: true };
}

/**
 * @param {{ message: string; beliefs: any[]; openQuestions?: any[]; context?: any }} input
 */
export function interpretMerchantMessage(input) {
  const message = input.message.trim();
  const normalized = normalize(message);
  const target = findTargetBelief(normalized, input.beliefs, input.context);
  const currentQuestion = (input.openQuestions ?? []).find(
    (question) => question.id === input.context?.currentOpenQuestionId,
  ) ?? input.openQuestions?.[0];

  if (isUndo(normalized)) {
    return {
      operationType: OPERATION_TYPES.noMemoryChange,
      reason: "Merchant wants to undo the latest change.",
      merchantStatement: message,
      confidence: 0.9,
      relatedBeliefKeys: input.context?.lastDiscussedBeliefKeys ?? [],
    };
  }

  if (isQuestion(normalized) && isExplanationRequest(normalized)) {
    if (!target) {
      return clarification(
        "Which understanding should I explain?",
        message,
        input.context,
      );
    }
    return {
      operationType: OPERATION_TYPES.requestExplanation,
      targetBeliefKey: target.key,
      targetBeliefId: target.id,
      category: target.category,
      reason: "Merchant asked for evidence or calculation details.",
      merchantStatement: message,
      confidence: 0.9,
      requiresConfirmation: false,
    };
  }

  if (isQuestion(normalized) && isInspectRequest(normalized)) {
    const category = categoryFromMessage(normalized);
    const related = category
      ? input.beliefs.filter((belief) => belief.category === category)
      : input.beliefs;
    return {
      operationType: OPERATION_TYPES.noMemoryChange,
      reason: category
        ? `Merchant asked what Jefe knows about ${category}.`
        : "Merchant asked what Jefe knows.",
      merchantStatement: message,
      category,
      confidence: 0.9,
      relatedBeliefKeys: related.map((belief) => belief.key),
      relatedBeliefIds: related.map((belief) => belief.id),
    };
  }

  if (isConfirmation(normalized)) {
    const discussedBeliefKeys = input.context?.lastDiscussedBeliefKeys ?? [];
    if (
      discussedBeliefKeys.length !== 1 &&
      !hasExplicitBeliefReference(normalized)
    ) {
      return clarification(
        "Which part should I mark as confirmed?",
        message,
        input.context,
      );
    }
    const belief = target ?? input.beliefs.find(
      (item) => item.key === input.context.lastDiscussedBeliefKeys[0],
    );
    return {
      operationType: OPERATION_TYPES.confirmBelief,
      targetBeliefKey: belief?.key,
      targetBeliefId: belief?.id,
      category: belief?.category,
      reason: "Merchant explicitly confirmed this understanding.",
      merchantStatement: message,
      confidence: 0.88,
      requiresConfirmation: false,
    };
  }

  const extracted = extractSupportedChange(normalized, message, target, currentQuestion);
  if (extracted) return extracted;

  if (currentQuestion && !isQuestion(normalized) && message.length > 8) {
    return operationForOpenQuestion(currentQuestion, message);
  }

  if (normalized.includes("wrong") || normalized.includes("not right")) {
    return clarification(
      "What should I change it to?",
      message,
      input.context,
    );
  }

  return {
    operationType: OPERATION_TYPES.noMemoryChange,
    reason:
      "I can use this in the conversation, but I need a little more detail before I treat it as something I should remember.",
    merchantStatement: message,
    confidence: 0.55,
    relatedBeliefKeys: target ? [target.key] : [],
    relatedBeliefIds: target ? [target.id] : [],
  };
}

/**
 * @param {{ message: string; beliefs: any[]; openQuestions?: any[]; context?: any; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function interpretMerchantMessageWithLlm(input) {
  const fallbackOperation = interpretMerchantMessage(input);
  const provider = input.llmProvider ?? safeCreateLlmProvider(input.logger);
  if (!provider?.enabled) return fallbackOperation;

  try {
    const result = await provider.generateStructuredOperation({
      systemPrompt: buildMerchantMemoryLlmSystemPrompt(),
      prompt: buildMerchantMemoryLlmPrompt(input),
      schema: STRUCTURED_OPERATION_SCHEMA,
    });
    const parsed = /** @type {any} */ (
      parseAndValidateStructuredOperation(result.operation)
    );
    if (!parsed.ok) {
      input.logger?.warn?.("LLM structured operation failed validation", {
        provider: provider.provider,
        model: provider.model,
        error: parsed.error,
      });
      return fallbackOperation;
    }
    return parsed.operation;
  } catch (error) {
    input.logger?.warn?.("LLM structured operation unavailable; using fallback", {
      provider: provider.provider,
      model: provider.model,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return fallbackOperation;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; operation: any; beliefs?: any[] }} input
 */
export async function validateStructuredOperation(prisma, input) {
  const supported = Object.values(OPERATION_TYPES);
  if (!supported.includes(input.operation.operationType)) {
    return invalid("I can’t apply that kind of change yet.");
  }
  if (
    input.operation.operationType === OPERATION_TYPES.noMemoryChange ||
    input.operation.operationType === OPERATION_TYPES.requestExplanation ||
    input.operation.operationType === OPERATION_TYPES.clarificationRequired
  ) {
    return { ok: true };
  }

  const key = input.operation.targetBeliefKey;
  const definition = key ? getBeliefDefinition(key) : null;
  if (!key || !definition) {
    return invalid("I need to understand exactly what this changes before I update Jefe’s understanding.");
  }
  if (!isAllowedConversationalCategory(definition.category)) {
    return invalid("I can’t use that kind of business context yet.");
  }

  const beliefs =
    input.beliefs ??
    (await getBeliefsForMerchant(prisma, {
      merchantId: input.merchantId,
      includeEvidence: false,
    }));
  const existing = beliefs.find((belief) => belief.key === key);

  if (
    input.operation.operationType === OPERATION_TYPES.confirmBelief &&
    (!existing || !definition.confirmable)
  ) {
    return invalid("I can only confirm an existing supported understanding.");
  }

  if (
    input.operation.operationType === OPERATION_TYPES.correctBelief &&
    (!existing || !definition.merchantCorrectable)
  ) {
    return invalid("I should keep that observed Shopify fact separate from merchant interpretation.");
  }

  if (
    (input.operation.operationType === OPERATION_TYPES.createMerchantBelief ||
      input.operation.operationType === OPERATION_TYPES.answerOpenQuestion) &&
    !definition.merchantCreatable
  ) {
    return invalid("I can’t learn that directly from this conversation yet.");
  }

  if (
    input.operation.operationType !== OPERATION_TYPES.confirmBelief
  ) {
    const value = /** @type {any} */ (validateConversationalValue(
      input.operation.proposedValue,
      definition,
    ));
    if (!value.ok) return invalid(value.error);
    input.operation.proposedValue = value.value;
    input.operation.valueType = definition.valueType;
    input.operation.category = definition.category;
  }

  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; conversationId: string; messageId: string; operation: any }} input
 */
async function commitStructuredOperation(prisma, input) {
  const operation = input.operation;
  const reference = `conversation:${input.conversationId}:message:${input.messageId}`;
  const metadata = {
    conversationId: input.conversationId,
    messageId: input.messageId,
    operationType: operation.operationType,
  };

  if (operation.operationType === OPERATION_TYPES.confirmBelief) {
    const belief = await confirmBelief(prisma, {
      merchantId: input.merchantId,
      key: operation.targetBeliefKey,
      confirmedBy: "merchant_conversation",
      evidenceSummary: summarizeMerchantStatement(operation.merchantStatement),
      evidenceSourceType: "merchant_conversation",
      evidenceSourceReference: reference,
      metadata,
    });
    return { beliefId: belief.id, belief };
  }

  if (operation.operationType === OPERATION_TYPES.correctBelief) {
    const belief = await correctBelief(prisma, {
      merchantId: input.merchantId,
      key: operation.targetBeliefKey,
      value: operation.proposedValue,
      valueType: operation.valueType,
      correctedBy: "merchant_conversation",
      evidenceSummary: summarizeMerchantStatement(operation.merchantStatement),
      evidenceSourceType: "merchant_conversation",
      evidenceSourceReference: reference,
      metadata,
    });
    return { beliefId: belief.id, belief };
  }

  if (
    operation.operationType === OPERATION_TYPES.createMerchantBelief ||
    operation.operationType === OPERATION_TYPES.answerOpenQuestion
  ) {
    const result = await upsertMerchantSuppliedBelief(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      category: operation.category,
      key: operation.targetBeliefKey,
      value: operation.proposedValue,
      valueType: operation.valueType,
      suppliedBy: "merchant_conversation",
      evidenceSummary: summarizeMerchantStatement(operation.merchantStatement),
      evidenceSourceType: "merchant_conversation",
      evidenceSourceReference: reference,
      metadata,
      precedence:
        getBeliefDefinition(operation.targetBeliefKey)?.kind === "policy"
          ? BELIEF_PRECEDENCE.houseRule
          : undefined,
    });
    if (operation.relatedOpenQuestionId) {
      await prisma.merchantMemoryOpenQuestion.updateMany({
        where: {
          id: operation.relatedOpenQuestionId,
          merchantId: input.merchantId,
          status: "open",
        },
        data: { status: "answered", answeredAt: new Date() },
      });
    }
    return { beliefId: result.belief.id, belief: result.belief };
  }

  throw new Error(`Unsupported operation type: ${operation.operationType}`);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
async function ensureInitialOpenQuestions(prisma, input) {
  await Promise.all(
    INITIAL_OPEN_QUESTIONS.map((question) =>
      prisma.merchantMemoryOpenQuestion.upsert({
        where: {
          merchantId_questionKey: {
            merchantId: input.merchantId,
            questionKey: question.questionKey,
          },
        },
        create: {
          merchantId: input.merchantId,
          shopId: input.shopId ?? null,
          ...question,
        },
        update: {
          shopId: input.shopId ?? undefined,
          question: question.question,
          reason: question.reason,
          priority: question.priority,
          answerType: question.answerType,
          answerOptions: question.answerOptions,
        },
      }),
    ),
  );
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
async function getOrCreateConversation(prisma, input) {
  const existing = await prisma.merchantMemoryConversation.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      status: "active",
    },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) return existing;
  return prisma.merchantMemoryConversation.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      context: {},
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ conversationId: string; merchantId: string; take?: number }} input
 */
async function listConversationMessages(prisma, input) {
  const messages = await prisma.merchantMemoryConversationMessage.findMany({
    where: {
      conversationId: input.conversationId,
      merchantId: input.merchantId,
    },
    orderBy: { createdAt: "asc" },
    take: input.take,
  });
  return messages.map(serializeMessage);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ conversation: any; content: string; operation?: any; operationStatus?: string | null; relatedBeliefIds?: string[]; relatedOpenQuestionId?: string | null }} input
 */
async function createAssistantMessage(prisma, input) {
  return prisma.merchantMemoryConversationMessage.create({
    data: {
      conversationId: input.conversation.id,
      merchantId: input.conversation.merchantId,
      shopId: input.conversation.shopId,
      role: "assistant",
      content: input.content,
      structuredOperation: input.operation ?? undefined,
      operationStatus: input.operationStatus ?? null,
      relatedBeliefIds: input.relatedBeliefIds ?? [],
      relatedOpenQuestionId: input.relatedOpenQuestionId ?? null,
      safeSummary: input.operation?.reason ?? input.content.slice(0, 160),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} conversation
 * @param {any} patch
 */
async function updateConversationContext(prisma, conversation, patch) {
  await prisma.merchantMemoryConversation.update({
    where: { id: conversation.id },
    data: { context: { ...(conversation.context ?? {}), ...patch } },
  });
}

/**
 * @param {any} rawContext
 * @param {any[]} messages
 */
function buildConversationContext(rawContext, messages) {
  const context = rawContext && typeof rawContext === "object" ? rawContext : {};
  const recentBeliefKeys = [...messages]
    .reverse()
    .flatMap((message) => {
      const operation = /** @type {any} */ (message.structuredOperation);
      return operation?.targetBeliefKey ?? [];
    })
    .filter(Boolean);
  return {
    ...context,
    lastDiscussedBeliefKeys:
      context.lastDiscussedBeliefKeys ??
      (recentBeliefKeys.length ? [recentBeliefKeys[0]] : []),
  };
}

function buildMerchantMemoryLlmSystemPrompt() {
  return [
    "You interpret merchant messages for Jefe Merchant Memory.",
    "Return exactly one JSON object matching the supplied schema.",
    "Do not write to databases or claim an update succeeded.",
    "Shopify-derived observations are not always merchant truth.",
    "Merchant corrections have authority, but raw observations and merchant policies must stay separate.",
    "Do not invent evidence.",
    "Ask for clarification when a reference is ambiguous.",
    "Do not create customer-level personal beliefs or store customer PII.",
    "Use only the supplied supported belief keys.",
  ].join("\n");
}

/**
 * @param {{ message: string; beliefs: any[]; openQuestions?: any[]; context?: any }} input
 */
function buildMerchantMemoryLlmPrompt(input) {
  const registry = getConversationalBeliefRegistry();
  return JSON.stringify({
    merchantMessage: input.message,
    conversationContext: {
      lastDiscussedBeliefKeys: input.context?.lastDiscussedBeliefKeys ?? [],
      currentOpenQuestionId: input.context?.currentOpenQuestionId ?? null,
      lastCommittedBeliefKey: input.context?.lastCommittedBeliefKey ?? null,
    },
    activeBeliefs: input.beliefs.slice(0, 40).map((belief) => ({
      id: belief.id,
      key: belief.key,
      category: belief.category,
      label: labelForBeliefKey(belief.key),
      value: formatBeliefValue(belief.value),
      valueType: belief.valueType,
      status: belief.status,
      confidence: belief.confidence,
      evidenceSummaries: (belief.evidence ?? []).slice(0, 2).map(
        (/** @type {any} */ evidence) => evidence.summary,
      ),
    })),
    openQuestions: (input.openQuestions ?? []).slice(0, 3).map((question) => ({
      id: question.id,
      questionKey: question.questionKey,
      category: question.category,
      question: question.question,
      answerType: question.answerType,
      answerOptions: question.answerOptions,
    })),
    supportedBeliefDefinitions: Object.values(registry).map((definition) => ({
      key: definition.key,
      category: definition.category,
      label: definition.label,
      valueType: definition.valueType,
      merchantCreatable: definition.merchantCreatable,
      merchantCorrectable: definition.merchantCorrectable,
      confirmable: definition.confirmable,
      kind: definition.kind,
      guidance: definition.guidance,
      allowedValues: definition.allowedValues ?? [],
    })),
    policy:
      "For observed inventory or catalogue counts, create a policy/preference belief when the merchant gives interpretation rather than overwriting observed data.",
  });
}

/**
 * @param {Pick<Console, "info" | "warn" | "error"> | undefined} logger
 */
function safeCreateLlmProvider(logger) {
  try {
    return createLlmProvider({ logger });
  } catch (error) {
    logger?.warn?.("LLM provider unavailable", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

/**
 * @param {any} summary
 */
function buildOpeningMessage(summary) {
  if (summary.overviewItems.length === 0) {
    return "I’m still learning about your business. Once I have enough to go on, you can ask what I know, correct anything I have misunderstood, or add context in your own words.";
  }
  const bullets = summary.overviewItems
    .slice(0, 5)
    .map((/** @type {any} */ item) => `• ${openingObservationForItem(item)}`)
    .join("\n");
  const question =
    summary.openQuestions?.[0]?.question ??
    "What would you most like me to help improve first?";
  return `I've spent a few minutes learning about your business.\n\nHere's what I think I understand so far.\n\n${bullets}\n\nI'll improve this over time, but tell me if I've misunderstood anything.\n\nSome things I can learn from Shopify. Others only you can tell me.\n\n${question}`;
}

/** @param {{ key: string; label: string; value: string }} item */
function openingObservationForItem(item) {
  if (item.key === "business.store_name") {
    return `You’re trading through ${item.value}.`;
  }
  if (item.key === "catalog.active_product_count") {
    return `You currently have ${item.value} active products.`;
  }
  if (item.key === "orders.average_order_value.all_time") {
    return `Customers currently spend around ${friendlyCurrency(item.value)} per order.`;
  }
  if (item.key === "customers.repeat_customer_rate.all_time") {
    return friendlyRepeatCustomerObservation(item.value);
  }
  if (item.key === "inventory.out_of_stock_variant_count") {
    return `I’ve noticed ${friendlyCount(item.value)} variants are currently out of stock.`;
  }
  if (item.key === "catalog.out_of_stock_product_count") {
    return `I’ve noticed ${friendlyCount(item.value)} products are currently out of stock.`;
  }
  return `I’ve noticed ${item.label.toLowerCase()} is ${item.value}.`;
}

/** @param {string} value */
function friendlyCurrency(value) {
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Z]{3})$/);
  if (!match) return value;
  const amount = Math.round(Number(match[1]));
  const currency = match[2];
  if (currency === "GBP") return `£${amount}`;
  if (currency === "USD") return `$${amount}`;
  if (currency === "EUR") return `€${amount}`;
  return `${amount} ${currency}`;
}

/** @param {string} value */
function friendlyRepeatCustomerObservation(value) {
  const percentage = Number(value.replace("%", ""));
  if (!Number.isFinite(percentage)) {
    return `Around ${value} of your customers come back for another purchase.`;
  }
  if (percentage >= 45 && percentage <= 55) {
    return "Around half of your customers come back for another purchase.";
  }
  return `Around ${Math.round(percentage)}% of your customers come back for another purchase.`;
}

/** @param {string} value */
function friendlyCount(value) {
  const count = Number(value);
  const words = ["no", "one", "two", "three", "four", "five"];
  if (Number.isInteger(count) && count >= 0 && count < words.length) {
    return words[count];
  }
  return value;
}

/**
 * @param {any} operation
 * @param {any[]} beliefs
 */
function buildExplanation(operation, beliefs) {
  const belief = beliefs.find((item) => item.key === operation.targetBeliefKey);
  if (!belief) return "I could not find that understanding anymore.";
  const evidence = belief.evidence?.[0];
  const parts = [conversationObservationForBelief(belief)];
  if (evidence?.summary) parts.push(evidence.summary);
  if (evidence?.metadata?.formula) {
    parts.push(`I got there by using: ${evidence.metadata.formula}.`);
  }
  if (evidence?.metadata?.sourceRecordCounts) {
    parts.push(
      `I looked at ${formatSourceCounts(evidence.metadata.sourceRecordCounts)}.`,
    );
  }
  if (belief.lastEvaluatedAt) {
    parts.push(`I last checked this on ${formatDateTime(belief.lastEvaluatedAt)}.`);
  }
  if (belief.confidenceReason) parts.push(`Worth knowing: ${belief.confidenceReason}`);
  return parts.join("\n\n");
}

/**
 * @param {any} operation
 * @param {any[]} beliefs
 * @param {any[]} openQuestions
 */
function buildNoChangeResponse(operation, beliefs, openQuestions) {
  if ((operation.relatedBeliefKeys ?? []).length > 0) {
    const related = beliefs.filter((belief) =>
      operation.relatedBeliefKeys.includes(belief.key),
    );
    if (related.length > 0) {
      return related
        .slice(0, 6)
        .map(conversationObservationForBelief)
        .join("\n");
    }
  }
  if (operation.reason?.includes("undo")) {
    return "Tell me what you want to undo, and I’ll try to reverse the latest matching change from this conversation.";
  }
  if (openQuestions.length > 0) {
    return `${operation.reason}\n\nOne thing I still need to know: ${openQuestions[0].question}`;
  }
  return operation.reason;
}

/**
 * @param {any} operation
 */
function buildProposedChangeResponse(operation) {
  return `I think this should update Jefe’s understanding:\n\n${labelForBeliefKey(operation.targetBeliefKey)}\n${formatBeliefValue(operation.proposedValue)}\n\nSource: told to Jefe by you.`;
}

/**
 * @param {any} operation
 * @param {{ belief?: any }} commit
 */
function buildCommittedChangeResponse(operation, commit) {
  const label = labelForBeliefKey(operation.targetBeliefKey);
  const value = commit.belief?.value ?? operation.proposedValue;
  if (operation.operationType === OPERATION_TYPES.confirmBelief) {
    return `Understood. I’ll treat ${label} as something you’ve told me is right.`;
  }
  return `Understood. I’ll remember this:\n\n${label}\n${formatBeliefValue(value)}`;
}

/** @param {{ key: string; label?: string; value: any }} belief */
function conversationObservationForBelief(belief) {
  return openingObservationForItem({
    key: belief.key,
    label: belief.label ?? labelForBeliefKey(belief.key),
    value: formatBeliefValue(belief.value),
  });
}

/**
 * @param {any} belief
 */
function serializeBelief(belief) {
  return {
    id: belief.id,
    key: belief.key,
    category: belief.category,
    label: labelForBeliefKey(belief.key),
    value: formatBeliefValue(belief.value),
    status: belief.status,
    confidence: belief.confidence,
    confidenceReason: belief.confidenceReason,
    lastEvaluatedAt: belief.lastEvaluatedAt?.toISOString?.() ?? null,
    lastConfirmedAt: belief.lastConfirmedAt?.toISOString?.() ?? null,
  };
}

/**
 * @param {any} message
 */
function serializeMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    structuredOperation: message.structuredOperation,
    operationStatus: message.operationStatus,
    relatedBeliefIds: message.relatedBeliefIds,
    relatedOpenQuestionId: message.relatedOpenQuestionId,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * @param {any} conversation
 */
function serializeConversation(conversation) {
  return {
    id: conversation.id,
    status: conversation.status,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

/**
 * @param {string} normalized
 * @param {any[]} beliefs
 * @param {any} context
 */
function findTargetBelief(normalized, beliefs, context) {
  const key =
    normalized.includes("currency") ||
    normalized.includes("euro") ||
    normalized.includes("eur") ||
    normalized.includes("gbp") ||
    normalized.includes("usd")
      ? "business.primary_currency"
      : normalized.includes("average order") || normalized.includes("aov")
        ? "orders.average_order_value.all_time"
        : normalized.includes("repeat")
          ? "customers.repeat_customer_rate.all_time"
          : normalized.includes("variant") && normalized.includes("stock")
            ? "inventory.out_of_stock_variant_count"
            : normalized.includes("out of stock")
              ? "catalog.out_of_stock_product_count"
              : normalized.includes("active product")
                ? "catalog.active_product_count"
                : normalized.includes("product")
                  ? "catalog.total_product_count"
                  : normalized.includes("store name") || normalized.includes("business name")
                    ? "business.store_name"
                    : null;
  if (key) return beliefs.find((belief) => belief.key === key) ?? { key };
  const lastKey = context?.lastDiscussedBeliefKeys?.[0];
  return lastKey && /\b(that|this|it|those|yes|correct|right|why)\b/.test(normalized)
    ? beliefs.find((belief) => belief.key === lastKey)
    : null;
}

/**
 * @param {string} normalized
 * @param {string} message
 * @param {any} target
 * @param {any} currentQuestion
 */
function extractSupportedChange(normalized, message, target, currentQuestion) {
  const currency = extractCurrency(normalized);
  if (currency && target?.key === "business.primary_currency") {
    return {
      operationType: OPERATION_TYPES.correctBelief,
      targetBeliefKey: "business.primary_currency",
      targetBeliefId: target.id,
      category: "business",
      proposedValue: { currency },
      valueType: "currency_code",
      reason: "Merchant explicitly corrected the primary currency.",
      merchantStatement: message,
      confidence: 0.92,
      requiresConfirmation: false,
    };
  }

  const lowStock = normalized.match(/(?:fewer than|less than|below|under)\s+(\d+)/);
  if (normalized.includes("low stock") && lowStock) {
    return {
      operationType: OPERATION_TYPES.createMerchantBelief,
      targetBeliefKey: "policies.low_stock_threshold",
      category: "policies",
      proposedValue: { number: Number(lowStock[1]) },
      valueType: "number",
      reason: "Merchant defined a low-stock policy.",
      merchantStatement: message,
      confidence: 0.92,
      requiresConfirmation: false,
    };
  }

  if (normalized.includes("preorder") && normalized.includes("stock")) {
    return {
      operationType: OPERATION_TYPES.createMerchantBelief,
      targetBeliefKey: "policies.preorder_zero_inventory_available",
      category: "policies",
      proposedValue: { boolean: true },
      valueType: "boolean",
      reason:
        "Merchant supplied a preorder availability policy instead of changing raw inventory observations.",
      merchantStatement: message,
      confidence: 0.86,
      requiresConfirmation: false,
    };
  }

  if (normalized.includes("gift") && normalized.includes("customer")) {
    return merchantBelief(
      "customers.primary_customer_type",
      "customers",
      { text: extractAfterIs(message) ?? "Gift buyers" },
      "Merchant described the primary customer type.",
      message,
      false,
    );
  }

  if (currentQuestion && !isQuestion(normalized) && message.length > 8) {
    return operationForOpenQuestion(currentQuestion, message);
  }

  if (
    normalized.includes("priority") ||
    normalized.includes("focus") ||
    normalized.includes("goal")
  ) {
    if (normalized.includes("profit")) {
      return merchantBelief(
        "preferences.optimisation_priority",
        "preferences",
        { option: "profit" },
        "Merchant stated the optimisation priority.",
        message,
        false,
        currentQuestion,
      );
    }
    if (normalized.includes("growth")) {
      return merchantBelief(
        "preferences.optimisation_priority",
        "preferences",
        { option: "growth" },
        "Merchant stated the optimisation priority.",
        message,
        false,
        currentQuestion,
      );
    }
    if (normalized.includes("cash flow")) {
      return merchantBelief(
        "preferences.optimisation_priority",
        "preferences",
        { option: "cash_flow" },
        "Merchant stated the optimisation priority.",
        message,
        false,
        currentQuestion,
      );
    }
    return merchantBelief(
      "goals.current_priority",
      "goals",
      { text: cleanBusinessStatement(message) },
      "Merchant stated the current priority.",
      message,
      false,
      currentQuestion,
    );
  }

  if (normalized.includes("wholesale")) {
    return merchantBelief(
      "business.primary_sales_channel",
      "business",
      { text: "Wholesale" },
      "Merchant described the primary sales channel.",
      message,
      false,
    );
  }

  if (normalized.includes("warehouse") || normalized.includes("fulfil")) {
    return merchantBelief(
      "operations.fulfilment_model",
      "operations",
      { text: cleanBusinessStatement(message) },
      "Merchant described the fulfilment model.",
      message,
      false,
      currentQuestion,
    );
  }

  return null;
}

/**
 * @param {any} question
 * @param {string} message
 */
function operationForOpenQuestion(question, message) {
  if (question.questionKey === "preferences.optimisation_priority") {
    const normalized = normalize(message);
    const option = normalized.includes("profit")
      ? "profit"
      : normalized.includes("cash")
        ? "cash_flow"
        : normalized.includes("retention") || normalized.includes("repeat")
          ? "retention"
          : normalized.includes("revenue")
            ? "revenue"
            : normalized.includes("growth")
              ? "growth"
              : null;
    if (option) {
      return merchantBelief(
        "preferences.optimisation_priority",
        "preferences",
        { option },
        "Merchant answered Jefe’s optimisation question.",
        message,
        false,
        question,
      );
    }
  }

  if (question.questionKey === "goals.primary_business_goal") {
    return merchantBelief(
      "goals.primary_business_goal",
      "goals",
      { text: cleanBusinessStatement(message) },
      "Merchant answered Jefe’s primary goal question.",
      message,
      false,
      question,
    );
  }

  return merchantBelief(
    "policies.never_discount_products",
    "policies",
    { text: cleanBusinessStatement(message) },
    "Merchant answered Jefe’s business-rules question.",
    message,
    true,
    question,
  );
}

/**
 * @param {string} key
 * @param {string} category
 * @param {any} value
 * @param {string} reason
 * @param {string} message
 * @param {boolean} requiresConfirmation
 * @param {any} [question]
 */
function merchantBelief(key, category, value, reason, message, requiresConfirmation, question) {
  return {
    operationType: question
      ? OPERATION_TYPES.answerOpenQuestion
      : OPERATION_TYPES.createMerchantBelief,
    targetBeliefKey: key,
    category,
    proposedValue: value,
    valueType: getBeliefDefinition(key)?.valueType,
    reason,
    merchantStatement: message,
    confidence: 0.86,
    requiresConfirmation,
    relatedOpenQuestionId: question?.id ?? null,
  };
}

/**
 * @param {string} reason
 * @param {string} message
 * @param {any} context
 */
function clarification(reason, message, context) {
  return {
    operationType: OPERATION_TYPES.clarificationRequired,
    reason,
    merchantStatement: message,
    confidence: 0.6,
    requiresConfirmation: true,
    relatedBeliefKeys: context?.lastDiscussedBeliefKeys ?? [],
  };
}

/**
 * @param {string} value
 */
function categoryFromMessage(value) {
  return ["business", "catalog", "orders", "customers", "inventory", "goals", "operations", "preferences", "policies"].find(
    (category) => value.includes(category),
  ) ?? (value.includes("stock") ? "inventory" : null);
}

/**
 * @param {string} value
 */
function extractCurrency(value) {
  if (/\beur\b|euro|euros/.test(value)) return "EUR";
  if (/\bgbp\b|pound|pounds|sterling/.test(value)) return "GBP";
  if (/\busd\b|dollar|dollars/.test(value)) return "USD";
  return null;
}

/**
 * @param {string} value
 */
function hasExplicitBeliefReference(value) {
  return (
    value.includes("currency") ||
    value.includes("average order") ||
    value.includes("aov") ||
    value.includes("repeat") ||
    value.includes("stock") ||
    value.includes("product") ||
    value.includes("store name") ||
    value.includes("business name")
  );
}

/**
 * @param {string} value
 */
function isQuestion(value) {
  return value.includes("?") || /^(what|why|how|where|show|tell me|do you)/.test(value);
}

/**
 * @param {string} value
 */
function isInspectRequest(value) {
  return /what.*(know|learn|understand|believe)|show.*believe|what.*need/.test(value);
}

/**
 * @param {string} value
 */
function isExplanationRequest(value) {
  return /\bwhy\b|how did|where did|how confident|calculate|calculated|come from/.test(value);
}

/**
 * @param {string} value
 */
function isConfirmation(value) {
  return /\b(yes|correct|right|accurate|looks good|that is correct|that's correct)\b/.test(value);
}

/**
 * @param {string} value
 */
function isUndo(value) {
  return /\bundo\b|keep the original|not what i meant|reject/.test(value);
}

/**
 * @param {string} value
 */
function normalize(value) {
  return value.toLowerCase().replace(/[’']/g, "'").trim();
}

/**
 * @param {string} value
 */
function extractAfterIs(value) {
  const match = value.match(/\b(?:is|are|as)\s+(.+)$/i);
  return match?.[1]?.replace(/[.!?]+$/, "").trim() ?? null;
}

/**
 * @param {string} value
 */
function cleanBusinessStatement(value) {
  return value.replace(/[.!?]+$/, "").trim();
}

/**
 * @param {string} value
 */
function summarizeMerchantStatement(value) {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

/**
 * @param {Record<string, number>} counts
 */
function formatSourceCounts(counts) {
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
}

/**
 * @param {Date | string} value
 */
function formatDateTime(value) {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * @param {string} message
 */
function invalid(message) {
  return {
    ok: false,
    error: message,
    merchantMessage: `${message} Tell me the change in a more specific way and I’ll try again.`,
  };
}
