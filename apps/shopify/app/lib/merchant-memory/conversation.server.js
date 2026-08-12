// @ts-check

import { createLlmProvider } from "../llm/provider.server.js";
import {
  STRUCTURED_OPERATION_SCHEMA,
  parseAndValidateStructuredOperation,
} from "../llm/structured-operation-schema.server.js";
import { BELIEF_PRECEDENCE } from "./constants.server.js";
import {
  OPERATION_STATUS,
  OPERATION_TYPES,
} from "./conversation-constants.server.js";
import {
  confirmBelief,
  correctBelief,
  getBeliefsForMerchant,
  retractBeliefForMerchant,
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
import { isBusinessShapeBeliefKey } from "./deterministic-belief-registry.server.js";
import { track } from "../../services/analytics/event-log.server.js";
import { getLlmConfig } from "../llm/config.server.js";
import {
  appendConversationMessage,
  linkConversationMessageToBelief,
  sanitizeMemoryText,
} from "./episodic-memory.server.js";
import { sendGeneralChatMessage } from "./general-chat.server.js";
import { retrieveMerchantContext } from "./merchant-context.server.js";
import { historicaliseBeliefSources } from "./passive-memory.server.js";
import { redact } from "../observability/redact.server.js";

export { OPERATION_STATUS, OPERATION_TYPES };

export const CONVERSATION_TOPICS = Object.freeze({
  memory: "memory",
  onboardingGoals: "onboarding_goals",
  onboardingPlan: "onboarding_plan",
  action: "action",
});

// A reply that never arrived. Said in Jefe's voice and from the merchant's side — they
// asked something and got nothing back, which is Jefe's failure, not theirs. Deliberately
// does NOT say "try again" as the whole sentence: the surface renders a real retry next to
// it, and a dead end with no way forward is exactly what we're fixing.
export const REPLY_FAILED_MESSAGE =
  "I couldn't get to that one just now — your message is saved, so ask me to try again.";
export const REPLY_FAILED_KIND = "reply_failed";

// How much of the home conversation the interpreter sees. Beliefs take whatever character
// budget is left after the fixed parts, so a longer thread costs beliefs rather than
// overflowing the provider limit — see the budget note in buildMerchantMemoryLlmPrompt.
const MEMORY_CHAT_THREAD_TURNS = 8;
const MEMORY_CHAT_THREAD_MESSAGE_MAX = 600;

const INITIAL_OPEN_QUESTIONS = [
  {
    category: "preferences",
    questionKey: "preferences.optimisation_priority",
    question:
      "What should Jefe optimise for: growth, profit, cash flow, or something else?",
    reason: "This affects how Jefe should evaluate tradeoffs.",
    priority: 10,
    answerType: "option",
    answerOptions: ["growth", "profit", "cash_flow", "retention", "revenue"],
  },
  {
    category: "policies",
    questionKey: "policies.business_rules",
    question: "Are there any business rules Jefe should never break?",
    reason:
      "Hard constraints prevent unsafe or unsuitable future recommendations.",
    priority: 20,
    answerType: "text",
    answerOptions: [],
  },
];

// Open questions the GAP generator owns. Listing them lets us retract a question
// automatically once its gap has been filled (a question that memory answered
// for itself from data should stop being asked).
const GAP_DRIVEN_QUESTION_KEYS = [
  "data.product_costs",
  "policies.no_sale_products",
];

/** @param {any} belief */
function beliefPercentage(belief) {
  const value = belief?.value;
  if (!value || typeof value !== "object") return null;
  if (typeof value.percentage === "number") return value.percentage;
  if (typeof value.ratio === "number") return value.ratio * 100;
  return null;
}

/**
 * Turn the current belief state into targeted open questions for the gaps only
 * the merchant can fill — so memory actively reduces its own uncertainty instead
 * of relying on two static seeds. Deterministic and keyed, so re-running upserts
 * (never duplicates) and a resolved gap retracts its question.
 * @param {Array<{ key: string; value: any }>} beliefs
 */
export function buildGapDrivenOpenQuestions(beliefs) {
  const byKey = new Map(beliefs.map((belief) => [belief.key, belief]));
  const questions = [];

  // Missing or thin product costs → margin/profit can't be tracked. Cost-per-item
  // is the one margin input Jefe cannot observe, so this is the highest-value gap.
  const coveragePct = beliefPercentage(byKey.get("products.cost_coverage"));
  const hasMargin = byKey.has("products.gross_margin.trailing_90d");
  if (!hasMargin || (coveragePct !== null && coveragePct < 70)) {
    const roundedPct = coveragePct !== null ? Math.round(coveragePct) : null;
    // Below ~5% reads as "none" to a merchant, and a bare "0%" looks like a bug — so
    // speak plainly instead of quoting a number no one trusts.
    const haveSomeCosts = roundedPct !== null && roundedPct >= 5;
    questions.push({
      category: "costs",
      questionKey: "data.product_costs",
      question: haveSomeCosts
        ? `I’ve only got cost prices for about ${roundedPct}% of your products, so I can’t work out your margins reliably yet. If you add cost-per-item on the rest in Shopify (open a product → Inventory → Cost per item), I’ll start tracking your profit properly.`
        : "I can’t see cost prices for your products yet, so I can’t work out your margins or profit. If you add cost-per-item in Shopify (open a product → Inventory → Cost per item), I’ll start tracking profit for you.",
      reason:
        "Cost per item is the one margin input Jefe cannot observe; with it, margin and profit beliefs unlock.",
      priority: 15,
      answerType: "text",
      answerOptions: [],
    });
  }

  // Several active products with no recent sales: memory can't tell dead stock
  // from seasonal or newly launched lines — only the merchant can.
  const noSale = byKey.get(
    "products.no_sale_active_product_count.trailing_90d",
  );
  const noSaleCount = Number(noSale?.value?.count ?? 0);
  if (noSaleCount >= 5) {
    questions.push({
      category: "policies",
      questionKey: "policies.no_sale_products",
      question: `I can see ${noSaleCount} of your active products haven’t sold in the last 90 days. Do you want me to treat products like these as discontinued, seasonal, newly launched, or still worth promoting?`,
      reason:
        "Lets Jefe classify no-sale products correctly instead of assuming they are dead stock.",
      priority: 40,
      answerType: "option",
      answerOptions: [
        "discontinued",
        "seasonal",
        "new_or_launching",
        "keep_promoting",
      ],
    });
  }

  return questions;
}

/**
 * Intent-capture — the seed of the demand-derived action ontology. A merchant
 * message Jefe can't resolve into a memory operation is often an *action* the
 * merchant wants but Jefe can't yet take ("reorder my bestseller", "email my VIPs").
 * Shape a PII-safe candidate-intent event from it, logged via the activity stream
 * and mined later (by frequency × value) for what to build. Best-effort; the
 * event never affects the reply. Pure so the shape is unit-testable.
 * @param {{ merchantId: string; shopId?: string | null }} input
 * @param {string} content
 * @param {{ reason?: string | null } | null | undefined} operation
 */
export function buildUnfulfilledIntentEvent(input, content, operation) {
  return {
    type: "merchant_intent_unfulfilled",
    topic: "intent",
    summary: summarizeMerchantStatement(content),
    merchantId: input.merchantId,
    shopId: input.shopId ?? undefined,
    properties: { reason: operation?.reason ?? null },
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; topic?: string }} input
 */
export async function getMerchantMemoryConversationExperience(prisma, input) {
  const topic = conversationTopic(input);
  if (topic === CONVERSATION_TOPICS.memory) {
    await ensureInitialOpenQuestions(prisma, input);
    await ensureGapDrivenOpenQuestions(prisma, input);
  }
  const [conversation, summary] = await Promise.all([
    getOrCreateConversation(prisma, input),
    getMerchantMemorySummary(prisma, input),
  ]);

  let messages = await listConversationMessages(prisma, {
    conversationId: conversation.id,
    merchantId: input.merchantId,
  });

  if (
    messages.length === 0 &&
    conversation.topic === CONVERSATION_TOPICS.memory
  ) {
    await appendConversationMessage(prisma, {
      conversationId: conversation.id,
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      role: "assistant",
      content: buildOpeningMessage(summary),
      surface: conversation.surface ?? "app",
      operationStatus: null,
      relatedBeliefIds: summary.overviewItems.map((item) => item.id),
      safeSummary: "Initial Jefe introduction.",
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
 * Read-only view of the merchant's conversation for the Daily Home composer — the
 * most recent messages, oldest-first for display. Deliberately thin: unlike
 * getMerchantMemoryConversationExperience it does NO ensure/gap/open-question
 * writes and does NOT create a conversation, so it is safe on the fast, read-only
 * home (the conversation is created lazily on the first posted message via
 * sendConversationMessage). Returns { messages: [] } when no conversation exists.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; take?: number }} input
 */
export async function getDailyChatThread(prisma, input) {
  const conversation = await prisma.merchantMemoryConversation.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      topic: CONVERSATION_TOPICS.memory,
      status: "active",
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) return { messages: [] };
  // Most-recent N, then reversed to ascending (oldest→newest) for the thread.
  const rows = await prisma.merchantMemoryConversationMessage.findMany({
    where: { conversationId: conversation.id, merchantId: input.merchantId },
    orderBy: { createdAt: "desc" },
    take: input.take ?? 20,
  });
  return { messages: rows.reverse().map(serializeMessage) };
}

/**
 * @param {{ recommendationId?: string | null; actionRunId?: string | null }} input
 */
export function actionConversationTopic(input) {
  const stableId =
    typeof input.recommendationId === "string" && input.recommendationId.trim()
      ? input.recommendationId.trim()
      : typeof input.actionRunId === "string" && input.actionRunId.trim()
        ? input.actionRunId.trim()
        : "unknown";
  return `${CONVERSATION_TOPICS.action}:${stableId}`;
}

/**
 * Read-only action-scoped chat thread. Does not create memory questions or the
 * global memory conversation.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; recommendationId?: string | null; actionRunId?: string | null; take?: number }} input
 */
export async function getActionChatThread(prisma, input) {
  const topic = actionConversationTopic(input);
  const conversation = await prisma.merchantMemoryConversation.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      topic,
      status: "active",
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) return { topic, messages: [] };
  const rows = await prisma.merchantMemoryConversationMessage.findMany({
    where: { conversationId: conversation.id, merchantId: input.merchantId },
    orderBy: { createdAt: "asc" },
    take: input.take ?? 40,
  });
  return { topic, messages: rows.map(serializeMessage) };
}

/**
 * Persist a merchant message against one action and answer with an LLM over scoped
 * action context. This keeps the action chat scoped to the move; it does not
 * interpret the message into Merchant Memory and does not write to Shopify.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; recommendationId?: string | null; actionRunId?: string | null; message: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; messageDecisionProcessor?: typeof import("./passive-memory.server.js").processPassiveMemoryMessage; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function sendActionChatMessage(prisma, input) {
  const topic = actionConversationTopic(input);
  if (!input.shopId)
    return { ok: false, error: "A shop is required for action chat." };
  const result = await sendGeneralChatMessage(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    message: input.message,
    surface: "app",
    externalThreadId: topic,
    recommendationId: input.recommendationId,
    actionRunId: input.actionRunId,
    llmProvider: input.llmProvider,
    messageDecisionProcessor: input.messageDecisionProcessor,
    logger: input.logger,
  });
  return result.ok ? { ok: true, topic } : result;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; recommendationId?: string | null; actionRunId?: string | null; note: string }} input
 */
export async function addActionChatNote(prisma, input) {
  const topic = actionConversationTopic(input);
  const conversation = await getOrCreateConversation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    topic,
  });
  await updateConversationContext(prisma, conversation, {
    currentActionRunId: input.actionRunId ?? null,
    actionRunId: input.actionRunId ?? null,
    recommendationId: input.recommendationId ?? null,
  });
  await createAssistantMessage(prisma, {
    conversation,
    content: input.note,
    operation: {
      operationType: "action_chat_note",
      reason: "Action revision note.",
      actionRunId: input.actionRunId ?? null,
      recommendationId: input.recommendationId ?? null,
    },
    operationStatus: null,
  });
  return { ok: true, topic };
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
 * @param {{ merchantId: string; shopId?: string | null; topic?: string; message: string; relatedOpenQuestionId?: string | null; reuseMessageId?: string | null; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function sendConversationMessage(prisma, input) {
  const content = input.message.trim();
  if (!content) return { ok: false, error: "Message is required." };

  await ensureInitialOpenQuestions(prisma, input);
  const conversation = await getOrCreateConversation(prisma, input);
  // A retry answers the merchant's EXISTING message rather than storing a second copy of
  // it. The first attempt already committed the merchant's row (it commits before the LLM
  // is called), so re-sending would leave the thread saying the same thing twice.
  const userMessage = input.reuseMessageId
    ? await prisma.merchantMemoryConversationMessage.findFirst({
        where: {
          id: input.reuseMessageId,
          conversationId: conversation.id,
          merchantId: input.merchantId,
          role: "merchant",
        },
      })
    : (
        await appendConversationMessage(prisma, {
          conversationId: conversation.id,
          merchantId: input.merchantId,
          shopId: input.shopId ?? null,
          role: "merchant",
          content,
          surface: conversation.surface ?? "app",
          safeSummary: summarizeMerchantStatement(content),
        })
      ).message;
  if (!userMessage) {
    return { ok: false, error: REPLY_FAILED_MESSAGE, kind: REPLY_FAILED_KIND };
  }

  const [beliefs, openQuestions, recentMessages, merchantContext] =
    await Promise.all([
      getBeliefsForMerchant(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        includeEvidence: true,
      }),
      getOpenQuestions(prisma, input),
      listRecentConversationMessages(prisma, {
        conversationId: conversation.id,
        merchantId: input.merchantId,
        take: 12,
      }),
      input.shopId
        ? retrieveMerchantContext(prisma, {
            merchantId: input.merchantId,
            shopId: input.shopId,
            task: "memory_edit",
            query: content,
            queryMessageId: userMessage.id,
            conversationId: conversation.id,
            tokenBudget: 6000,
          })
        : Promise.resolve(null),
    ]);
  const context = buildConversationContext(conversation.context, recentMessages);
  // What was said before this turn. The merchant's current message is already stored by the
  // time we read the thread, so it comes back in `recentMessages` — drop it here rather than
  // send the model the same sentence twice, once as history and once as the question.
  const priorMessages = recentMessages.filter(
    (message) => message.id !== userMessage.id,
  );
  // Exact-targeting: when the merchant answers a SPECIFIC open question from the surface (the
  // answer composer posts its id), aim the interpreter at THAT question rather than the
  // top-priority fallback in interpretMerchantMessage. An id that is no longer open harmlessly
  // falls back to the default (the .find below simply won't match it).
  if (input.relatedOpenQuestionId) {
    context.currentOpenQuestionId = input.relatedOpenQuestionId;
  }
  // The interpret call is the flaky step — ~6k-token prompts against an LLM timeout. It is
  // also side-effect-free, so failing it is recoverable: the merchant's message is already
  // stored, and a retry can answer it without writing anything twice. Catch it HERE rather
  // than around the whole function — everything below this point mutates Merchant Memory,
  // and a write that half-failed must surface, not be swallowed as "couldn't reply".
  let operation;
  try {
    operation = /** @type {any} */ (await interpretMerchantMessageWithLlm({
      message: sanitizeMemoryText(content),
      beliefs,
      openQuestions,
      context,
      merchantContext,
      recentMessages: priorMessages,
      llmProvider: input.llmProvider,
      logger: input.logger,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId ?? null,
        feature: "conversation",
      },
    }));
  } catch (error) {
    // Redacted: a merchant message can carry customer names/emails, and this is the one
    // path that logs while holding the raw text.
    input.logger?.error?.("conversation reply failed", {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      conversationId: conversation.id,
      messageId: userMessage.id,
      reason: redact(error instanceof Error ? error.message : String(error)),
    });
    return {
      ok: false,
      error: REPLY_FAILED_MESSAGE,
      kind: REPLY_FAILED_KIND,
      retryMessageId: userMessage.id,
    };
  }
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
      relatedBeliefIds: operation.targetBeliefId
        ? [operation.targetBeliefId]
        : [],
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
      relatedBeliefIds: operation.targetBeliefId
        ? [operation.targetBeliefId]
        : [],
    });
    await updateConversationContext(prisma, conversation, {
      lastDiscussedBeliefKeys: operation.targetBeliefKey
        ? [operation.targetBeliefKey]
        : context.lastDiscussedBeliefKeys,
      currentOpenQuestionId: openQuestions[0]?.id ?? null,
    });
    return { ok: true };
  }

  // Undo runs its own path: it reverses the merchant's last memory change and reports what
  // it reversed, rather than proposing anything. No confirmation gate — undo is the safe
  // direction, and asking "are you sure you want to undo?" after a destructive act is the
  // wrong place to add friction.
  if (operation.operationType === OPERATION_TYPES.undoLastChange) {
    return undoLatestMerchantMemoryChange(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      topic: input.topic,
    });
  }

  if (operation.operationType === OPERATION_TYPES.noMemoryChange) {
    await createAssistantMessage(prisma, {
      conversation,
      content: buildNoChangeResponse(operation, beliefs),
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
    // Intent-capture: an unresolved ask is often an action Jefe can't yet take —
    // log it (PII-safe, best-effort) as a candidate intent for the ontology.
    void track(prisma, buildUnfulfilledIntentEvent(input, content, operation));
    await createAssistantMessage(prisma, {
      conversation,
      content: buildClarificationReply(operation),
      operation,
      operationStatus: OPERATION_STATUS.proposed,
      relatedBeliefIds: operation.targetBeliefId
        ? [operation.targetBeliefId]
        : [],
      relatedOpenQuestionId: operation.relatedOpenQuestionId,
    });
    return { ok: true };
  }

  if (operation.requiresConfirmation) {
    await createAssistantMessage(prisma, {
      conversation,
      content: buildProposedChangeResponse(operation, beliefs),
      operation,
      operationStatus: OPERATION_STATUS.proposed,
      relatedBeliefIds: operation.targetBeliefId
        ? [operation.targetBeliefId]
        : [],
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
 * Answer the merchant's last message when the first attempt failed to produce a reply.
 *
 * Reads the thread rather than taking a message id from the client: the merchant is asking
 * for the thing they can SEE, and the tail of the thread is that thing.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; topic?: string; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 */
export async function retryLastConversationReply(prisma, input) {
  const conversation = await getOrCreateConversation(prisma, input);
  const latest = await prisma.merchantMemoryConversationMessage.findFirst({
    where: { conversationId: conversation.id, merchantId: input.merchantId },
    orderBy: { createdAt: "desc" },
  });
  // Nothing to retry — an empty thread, or Jefe has already answered. Idempotent by
  // construction: a double-tapped Retry, or one clicked on a stale tab, is a no-op rather
  // than a second reply to a message that already has one.
  if (!latest || latest.role !== "merchant") {
    return { ok: true, retried: false, conversationId: conversation.id };
  }
  const result = await sendConversationMessage(prisma, {
    ...input,
    message: latest.content,
    reuseMessageId: latest.id,
  });
  return { ...result, retried: true, conversationId: conversation.id };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; topic?: string; message: string }} input
 */
export async function addMerchantConversationNote(prisma, input) {
  const content = input.message.trim();
  if (!content) return { ok: false, error: "Message is required." };
  const conversation = await getOrCreateConversation(prisma, input);
  await appendConversationMessage(prisma, {
    conversationId: conversation.id,
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    role: "merchant",
    content,
    surface: conversation.surface ?? "app",
    safeSummary: summarizeMerchantStatement(content),
  });
  return { ok: true };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null; topic?: string; content: string; operation?: any; relatedBeliefIds?: string[] }} input
 */
export async function addAssistantConversationNote(prisma, input) {
  const content = input.content.trim();
  if (!content) return { ok: false, error: "Message is required." };
  if (conversationTopic(input) === CONVERSATION_TOPICS.memory) {
    await ensureInitialOpenQuestions(prisma, input);
  }
  const conversation = await getOrCreateConversation(prisma, input);
  await createAssistantMessage(prisma, {
    conversation,
    content,
    operation: input.operation,
    operationStatus: null,
    relatedBeliefIds: input.relatedBeliefIds ?? [],
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
  const validation = /** @type {any} */ (
    await validateStructuredOperation(prisma, {
      merchantId: input.merchantId,
      operation,
    })
  );
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
    relatedBeliefIds: commit.beliefId
      ? [commit.beliefId]
      : message.relatedBeliefIds,
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
 * @param {{ merchantId: string; shopId?: string | null; topic?: string }} input
 */
export async function undoLatestMerchantMemoryChange(prisma, input) {
  const conversation = await getOrCreateConversation(prisma, input);
  const reverted = await revertLatestMerchantSuppliedChange(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
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
  const currentQuestion =
    (input.openQuestions ?? []).find(
      (question) => question.id === input.context?.currentOpenQuestionId,
    ) ?? input.openQuestions?.[0];

  if (isUndo(normalized)) {
    // Was noMemoryChange — which meant "undo that" was ACKNOWLEDGED and then ignored:
    // `undoLatestMerchantMemoryChange` existed but had no caller anywhere, so the merchant
    // got a reply and nothing was reversed. That is worse than having no undo at all, and
    // it mattered most right after a forget, where the reply promises one.
    return {
      operationType: OPERATION_TYPES.undoLastChange,
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

  // "Forget that." Sits beside isConfirmation — both act on an EXISTING belief — but with
  // the opposite risk profile, so the targeting rule is inverted. Confirm can afford a fuzzy
  // target: confirming the wrong belief is recoverable and visible. Obsolete cannot: it
  // retires a fact the merchant may never notice is gone. So this branch resolves a target
  // only when it is certain, and asks otherwise. Never guess what to forget.
  if (isObsoleteRequest(normalized)) {
    const candidate =
      target ??
      input.beliefs.find(
        (item) => item.key === input.context?.lastDiscussedBeliefKeys?.[0],
      );
    // `findTargetBelief` returns a bare `{ key }` when a keyword matched but the merchant
    // holds no such belief — a phantom. Requiring `id` keeps a phantom from becoming a
    // "forgotten" belief that never existed.
    const resolved = candidate?.id ? candidate : null;
    const onlyOneThingDiscussed =
      (input.context?.lastDiscussedBeliefKeys ?? []).length === 1;
    if (
      !resolved ||
      !(onlyOneThingDiscussed || hasExplicitBeliefReference(normalized))
    ) {
      return clarification(
        "Which understanding should I forget? Name it and I'll drop it.",
        message,
        input.context,
      );
    }
    return {
      operationType: OPERATION_TYPES.obsoleteBelief,
      targetBeliefKey: resolved.key,
      targetBeliefId: resolved.id,
      category: resolved.category,
      reason: "Merchant asked Jefe to forget this understanding.",
      merchantStatement: message,
      confidence: 0.85,
      // ALWAYS. Destructive and easy to mis-target, so the merchant sees exactly what is
      // about to go before it goes — never auto-committed, however confident the read.
      requiresConfirmation: true,
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
    const belief =
      target ??
      input.beliefs.find(
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

  const extracted = extractSupportedChange(
    normalized,
    message,
    target,
    currentQuestion,
    input.context,
  );
  if (extracted) return extracted;

  if (currentQuestion && !isQuestion(normalized) && message.length > 8) {
    const openQuestionOperation = operationForOpenQuestion(
      currentQuestion,
      message,
    );
    if (openQuestionOperation) return openQuestionOperation;
  }

  if (normalized.includes("wrong") || normalized.includes("not right")) {
    return clarification("What should I change it to?", message, input.context);
  }

  return {
    operationType: OPERATION_TYPES.noMemoryChange,
    reason:
      "I understand. If you want this to change how I run the business, tell me the specific rule, priority, or fact to use.",
    merchantStatement: message,
    confidence: 0.55,
    relatedBeliefKeys: target ? [target.key] : [],
    relatedBeliefIds: target ? [target.id] : [],
  };
}

/**
 * @param {{ message: string; beliefs: any[]; openQuestions?: any[]; context?: any; merchantContext?: any; recentMessages?: Array<{ role: string; content: string }>; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error">; usage?: { prisma: any; merchantId?: string | null; shopId?: string | null; feature: string } }} input
 */
export async function interpretMerchantMessageWithLlm(input) {
  const fallbackOperation = interpretMerchantMessage(input);
  const provider =
    input.llmProvider ?? safeCreateLlmProvider(input.logger, input.usage);
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
    input.logger?.warn?.(
      "LLM structured operation unavailable; using fallback",
      {
        provider: provider.provider,
        model: provider.model,
        error: error instanceof Error ? error.name : "UnknownError",
      },
    );
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
    input.operation.operationType === OPERATION_TYPES.clarificationRequired ||
    // Undo names no belief — it resolves its own target from history.
    input.operation.operationType === OPERATION_TYPES.undoLastChange
  ) {
    return { ok: true };
  }

  const key = input.operation.targetBeliefKey;
  const definition = key ? getBeliefDefinition(key) : null;
  if (!key || !definition) {
    return invalid(
      "I need to understand exactly what this changes before I update Jefe’s understanding.",
    );
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
    return invalid(
      "I should keep that observed Shopify fact separate from merchant interpretation.",
    );
  }

  // Forget must name something Jefe actually holds AND something the merchant is allowed to
  // retract. Observed Shopify facts are not obsoletable: the fact is still true in the store,
  // so forgetting it would only make Jefe blind to it until the next sync re-derived it.
  // Correcting is the right move there, which is what this steers them to.
  if (input.operation.operationType === OPERATION_TYPES.obsoleteBelief) {
    if (!existing) {
      return invalid(
        "I don’t have that in memory, so there’s nothing for me to forget.",
      );
    }
    if (!definition.merchantObsoletable) {
      return invalid(
        "That one comes straight from your Shopify data, so I can’t forget it — but tell me what’s wrong with it and I’ll correct it.",
      );
    }
  }

  if (
    (input.operation.operationType === OPERATION_TYPES.createMerchantBelief ||
      input.operation.operationType === OPERATION_TYPES.answerOpenQuestion) &&
    !definition.merchantCreatable
  ) {
    return invalid("I can’t learn that directly from this conversation yet.");
  }

  // Value-bearing operations only. Confirm and obsolete both act on a belief WITHOUT
  // proposing a new value — running them through value validation would reject them for
  // failing to supply something they are not meant to carry.
  if (
    input.operation.operationType !== OPERATION_TYPES.confirmBelief &&
    input.operation.operationType !== OPERATION_TYPES.obsoleteBelief
  ) {
    const value = /** @type {any} */ (
      validateConversationalValue(input.operation.proposedValue, definition)
    );
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
      shopId: input.shopId,
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
    if (operation.targetBeliefId) {
      await historicaliseBeliefSources(prisma, {
        beliefId: operation.targetBeliefId,
        merchantId: input.merchantId,
        shopId: input.shopId,
      });
    }
    const belief = await correctBelief(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      key: operation.targetBeliefKey,
      value: operation.proposedValue,
      valueType: operation.valueType,
      correctedBy: "merchant_conversation",
      evidenceSummary: summarizeMerchantStatement(operation.merchantStatement),
      evidenceSourceType: "merchant_conversation",
      evidenceSourceReference: reference,
      metadata,
    });
    await linkConversationMessageToBelief(prisma, {
      merchantId: input.merchantId,
      messageId: input.messageId,
      beliefId: belief.id,
    });
    return { beliefId: belief.id, belief };
  }

  if (operation.operationType === OPERATION_TYPES.obsoleteBelief) {
    // Shop-scoped: belief keys repeat across a merchant's shops, and this is a write.
    const belief = await retractBeliefForMerchant(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      key: operation.targetBeliefKey,
      retractedBy: "merchant_conversation",
      metadata,
    });
    if (belief) {
      await historicaliseBeliefSources(prisma, {
        beliefId: belief.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        sourceMessageId: input.messageId,
      });
    }
    // null = nothing active under that key (already forgotten, or a double-send). Harmless,
    // and the caller reports it as done rather than surfacing an error for a no-op.
    return { beliefId: belief?.id ?? null, belief };
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
      allowRetractedSuccessor: true,
      precedence:
        getBeliefDefinition(operation.targetBeliefKey)?.kind === "policy"
          ? BELIEF_PRECEDENCE.houseRule
          : undefined,
    });
    await linkConversationMessageToBelief(prisma, {
      merchantId: input.merchantId,
      messageId: input.messageId,
      beliefId: result.belief.id,
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
 * Generate and reconcile gap-driven open questions from the current belief
 * state. Raises a question when a fillable gap exists, retracts it (status
 * "resolved") once the gap closes, and re-opens it if the gap returns — so
 * memory keeps its own questions in sync with what it can and can't yet see. A
 * question the merchant already answered is never reopened or disturbed.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId?: string | null }} input
 */
async function ensureGapDrivenOpenQuestions(prisma, input) {
  const beliefs = await getBeliefsForMerchant(prisma, {
    merchantId: input.merchantId,
  });
  const scoped = beliefs.filter(
    (belief) => !belief.shopId || belief.shopId === input.shopId,
  );
  const applying = buildGapDrivenOpenQuestions(scoped);
  const applyingKeys = new Set(
    applying.map((question) => question.questionKey),
  );

  const toResolve = GAP_DRIVEN_QUESTION_KEYS.filter(
    (key) => !applyingKeys.has(key),
  );
  if (toResolve.length > 0) {
    await prisma.merchantMemoryOpenQuestion.updateMany({
      where: {
        merchantId: input.merchantId,
        questionKey: { in: toResolve },
        status: "open",
      },
      data: { status: "resolved" },
    });
  }

  if (applyingKeys.size > 0) {
    // Re-open a managed question that was auto-resolved but whose gap is back.
    await prisma.merchantMemoryOpenQuestion.updateMany({
      where: {
        merchantId: input.merchantId,
        questionKey: { in: [...applyingKeys] },
        status: "resolved",
      },
      data: { status: "open" },
    });
  }

  await Promise.all(
    applying.map((question) =>
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
 * @param {{ merchantId: string; shopId?: string | null; topic?: string }} input
 */
async function getOrCreateConversation(prisma, input) {
  const topic = conversationTopic(input);
  const existing = await prisma.merchantMemoryConversation.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
      topic,
      status: "active",
    },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) return existing;
  return prisma.merchantMemoryConversation.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      topic,
      conversationType: conversationTypeForTopic(topic),
      surface: "app",
      lastMessageAt: new Date(),
      context: {},
    },
  });
}

/** @param {string} topic */
function conversationTypeForTopic(topic) {
  if (topic === CONVERSATION_TOPICS.memory) return "memory_review";
  if (topic === CONVERSATION_TOPICS.onboardingGoals) return "goal_coaching";
  if (topic === CONVERSATION_TOPICS.onboardingPlan) return "plan_refinement";
  if (topic.startsWith(`${CONVERSATION_TOPICS.action}:`)) return "action";
  return "general";
}

/** @param {{ topic?: string }} input */
function conversationTopic(input) {
  return input.topic ?? CONVERSATION_TOPICS.memory;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ conversationId: string; merchantId: string; take?: number }} input
 */
/**
 * The most recent N messages, in chronological order.
 *
 * `listConversationMessages` orders ASC, so giving it a `take` returns the OLDEST N — right
 * for rendering a whole thread, wrong for "what was just said". The conversation path needs
 * the tail, which is why the action chat has always had its own reader
 * (`listRecentActionMessages`); this is the same read for the memory path, keeping the
 * fields `buildConversationContext` needs.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ conversationId: string; merchantId: string; take: number }} input
 */
async function listRecentConversationMessages(prisma, input) {
  const rows = await prisma.merchantMemoryConversationMessage.findMany({
    where: {
      conversationId: input.conversationId,
      merchantId: input.merchantId,
    },
    orderBy: { createdAt: "desc" },
    take: input.take,
  });
  return rows.reverse().map(serializeMessage);
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
  const result = await appendConversationMessage(prisma, {
    conversation: input.conversation,
    conversationId: input.conversation.id,
    merchantId: input.conversation.merchantId,
    shopId: input.conversation.shopId,
    role: "assistant",
    content: input.content,
    surface: input.conversation.surface ?? "app",
    recommendationId: input.operation?.recommendationId ?? null,
    actionRunId: input.operation?.actionRunId ?? null,
    structuredOperation: input.operation ?? undefined,
    operationStatus: input.operationStatus ?? null,
    relatedBeliefIds: input.relatedBeliefIds ?? [],
    relatedOpenQuestionId: input.relatedOpenQuestionId ?? null,
    safeSummary: input.operation?.reason ?? input.content.slice(0, 160),
  });
  return result.message;
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
  const context =
    rawContext && typeof rawContext === "object" ? rawContext : {};
  const recentBeliefKeys = [...messages]
    .reverse()
    .flatMap((message) => {
      const operation = /** @type {any} */ (message.structuredOperation);
      return operation?.targetBeliefKey ?? [];
    })
    .filter(Boolean);
  // `??` only falls through on null/undefined, and EVERY no-change turn stores
  // `relatedBeliefKeys ?? []` — so the first one wrote an empty array and, from then on, this
  // line kept returning it and the recompute-from-history fallback below was unreachable for
  // the life of the conversation. Confirmed empty on a production conversation row.
  //
  // The thread now reaching the prompt does not cover this: `lastDiscussedBeliefKeys` feeds
  // the DETERMINISTIC path, where it resolves "that" for "that's right" and "forget that".
  // With it stuck empty, isConfirmation sees nothing under discussion and Jefe asks "which
  // part should I mark as confirmed?" about a belief named one message earlier.
  const storedKeys = Array.isArray(context.lastDiscussedBeliefKeys)
    ? context.lastDiscussedBeliefKeys.filter(Boolean)
    : null;
  return {
    ...context,
    lastDiscussedBeliefKeys:
      storedKeys && storedKeys.length
        ? storedKeys
        : recentBeliefKeys.length
          ? [recentBeliefKeys[0]]
          : [],
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
    // Without this the model treated every turn as the first one. `recentThread` is the
    // conversation so far, oldest first, and `merchantMessage` is the turn being answered.
    "`recentThread` is what has already been said in this conversation, oldest first; `merchantMessage` is the new turn. Resolve references like \"that\", \"it\", \"what you said before\" against it.",
    "Never ask the merchant to repeat something they have already told you in `recentThread`.",
    "Write `reason` for yourself: it is your private justification and is never shown to the merchant.",
    "Write `merchantReply` as the words the merchant will actually read: speak to them directly as \"you\", keep it warm and plain, and never refer to \"the merchant\" or narrate your own reasoning.",
    "Set `merchantReply` whenever operationType is clarification_required or no_memory_change. For clarification_required make it a direct question that names exactly what you need (\"Which product do you mean?\"), not a note that says you need clarification.",
    // The model can now emit a DESTRUCTIVE op, so it gets an explicit rule rather than
    // inferring the risk. Server-side validation enforces all of this regardless — this only
    // stops the model proposing retractions the merchant then has to decline.
    "Use obsolete_belief only when the merchant clearly asks you to forget or drop something they can name. It takes a target belief key and no value.",
    "Never choose obsolete_belief to fix a wrong value — that is correct_belief. Forgetting removes the understanding entirely.",
    "If you cannot tell which belief a forget request refers to, return clarification_required instead. Never guess the target of a forget.",
    'Use undo_last_change when the merchant wants the previous change put back ("undo that", "actually keep it"). It takes no target and no value — the server resolves what to reverse from history.',
    "Do not create customer-level personal beliefs or store customer PII.",
    "Use only the supplied supported belief keys.",
  ].join("\n");
}

/**
 * Bound a value for the LLM prompt so one belief can't dominate the budget.
 * @param {any} value
 * @param {number} max
 */
function truncateForPrompt(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function safePromptText(value, max) {
  return truncateForPrompt(sanitizeMemoryText(String(value ?? "")), max) ?? "";
}

/** @param {unknown} role */
function safePromptRole(role) {
  if (role === "merchant") return "merchant";
  if (role === "assistant") return "assistant";
  return "message";
}

/** @param {unknown} value */
function text(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

// Belief-budget tuning for the conversation prompt. CHARS_PER_TOKEN is a
// deliberately conservative characters-per-token estimate (real is ~4) so we
// under-fill rather than overflow the provider's input-token limit.
const CHARS_PER_TOKEN = 3.5;
const MAX_PROMPT_BELIEFS = 40;
const MIN_PROMPT_BELIEFS = 8;

/**
 * Serialize one belief to the compact shape the LLM sees; value + evidence bounded.
 * @param {any} belief
 */
function serializePromptBelief(belief) {
  return {
    id: belief.id,
    key: belief.key,
    category: belief.category,
    label: labelForBeliefKey(belief.key),
    // Structured beliefs fall through formatBeliefValue to a full JSON dump; bound
    // it — the LLM only needs enough of the value to identify the belief.
    value: truncateForPrompt(formatBeliefValue(belief.value), 150),
    valueType: belief.valueType,
    status: belief.status,
    confidence: belief.confidence,
    evidenceSummaries: (belief.evidence ?? [])
      .slice(0, 1)
      .map((/** @type {any} */ evidence) =>
        truncateForPrompt(evidence.summary, 110),
      ),
  };
}

/**
 * Relevance score for keeping a belief in the budgeted prompt: the belief the
 * merchant is discussing wins hardest, then merchant-owned and high-confidence
 * ones. Ensures the belief actually under discussion survives the cut.
 * @param {any} belief @param {string} messageLower @param {Set<string>} discussedKeys
 */
function promptBeliefScore(belief, messageLower, discussedKeys) {
  let score = 0;
  const key = String(belief.key ?? "");
  if (discussedKeys.has(key)) score += 100;
  const label = labelForBeliefKey(key).toLowerCase();
  const keyTokens = key.split(/[._]/).filter((token) => token.length > 3);
  if (keyTokens.some((token) => messageLower.includes(token))) score += 50;
  if (label.length > 3 && messageLower.includes(label)) score += 40;
  if (belief.status === "merchant_corrected") score += 30;
  else if (belief.status === "merchant_confirmed") score += 20;
  // What KIND of business this is frames every answer, so it earns a standing place in the
  // prompt rather than competing on keyword relevance. Without this the shape beliefs scored
  // ~8 (confidence alone) against 140 competitors for 40 slots, so they were derived and then
  // never reached the model — the representation existed and the advice stayed generic.
  //
  // A boost, deliberately NOT a pin: below a keyword match (+50) and far below the belief
  // actually under discussion (+100), so shape frames the answer without ever displacing the
  // subject of it.
  if (isBusinessShapeBeliefKey(key)) score += 25;
  score += Math.round(Number(belief.confidence ?? 0) * 10);
  return score;
}

/**
 * Choose the beliefs to include in the prompt: rank by relevance, then fill up to
 * a character budget (and the hard MAX_PROMPT_BELIEFS cap). This is the dynamic
 * token budget — it guarantees the prompt fits the input-token limit even for a
 * memory-rich merchant, while keeping the belief the merchant is talking about.
 * @param {{ beliefs: any[]; message?: string; context?: any }} input
 * @param {number} budgetChars
 */
export function selectPromptBeliefs(input, budgetChars) {
  const messageLower = String(input.message ?? "").toLowerCase();
  const discussedKeys = new Set(
    [
      ...(input.context?.lastDiscussedBeliefKeys ?? []),
      input.context?.lastCommittedBeliefKey,
    ].filter(Boolean),
  );
  const ranked = [...(input.beliefs ?? [])]
    .map((belief) => ({
      belief,
      score: promptBeliefScore(belief, messageLower, discussedKeys),
    }))
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let usedChars = 0;
  for (const { belief } of ranked) {
    if (selected.length >= MAX_PROMPT_BELIEFS) break;
    const serialized = serializePromptBelief(belief);
    const cost = JSON.stringify(serialized).length + 1;
    if (
      usedChars + cost > budgetChars &&
      selected.length >= MIN_PROMPT_BELIEFS
    ) {
      break;
    }
    selected.push(serialized);
    usedChars += cost;
  }
  // Emit ordered by key for a stable, readable prompt.
  selected.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return selected;
}

/**
 * @param {{ message: string; beliefs: any[]; openQuestions?: any[]; context?: any; merchantContext?: any; recentMessages?: Array<{ role: string; content: string }> }} input
 */
function buildMerchantMemoryLlmPrompt(input) {
  const registry = getConversationalBeliefRegistry();
  // The conversation so far. Without this the model saw one sentence and three belief keys,
  // so "for what you said before, the cost-per-item in Shopify" was unanswerable — it had no
  // "before" — and Jefe asked the merchant to re-explain what they had just explained. The
  // action chat has always sent its thread; this is the same read for the home path.
  // Redacted through safePromptText like every other merchant text crossing the AI boundary.
  const recentThread = (input.recentMessages ?? [])
    .slice(-MEMORY_CHAT_THREAD_TURNS)
    .map((/** @type {any} */ message) => ({
      role: safePromptRole(message.role),
      content: safePromptText(message.content, MEMORY_CHAT_THREAD_MESSAGE_MAX),
    }))
    .filter((/** @type {{ role: string; content: string }} */ message) => message.content);
  const prompt = {
    merchantMessage: input.message,
    recentThread,
    conversationContext: {
      lastDiscussedBeliefKeys: input.context?.lastDiscussedBeliefKeys ?? [],
      currentOpenQuestionId: input.context?.currentOpenQuestionId ?? null,
      lastCommittedBeliefKey: input.context?.lastCommittedBeliefKey ?? null,
    },
    retrievedContext: input.merchantContext
      ? {
          episodicMemory: input.merchantContext.episodicMemory,
          actionMemory: input.merchantContext.actionMemory,
          openQuestions: input.merchantContext.openQuestions,
        }
      : null,
    activeBeliefs: /** @type {any[]} */ ([]),
    openQuestions: (input.openQuestions ?? [])
      .slice(0, 3)
      .map((/** @type {any} */ question) => ({
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
  };
  // Beliefs get whatever character budget remains after the fixed parts (message,
  // context, open questions, the supported-belief registry, policy), so the whole
  // prompt stays under the provider's input-token limit however rich the memory.
  const overheadChars = JSON.stringify(prompt).length;
  const maxPromptChars = getLlmConfig().maxInputTokens * CHARS_PER_TOKEN;
  prompt.activeBeliefs = selectPromptBeliefs(
    input,
    maxPromptChars - overheadChars,
  );
  return JSON.stringify(prompt);
}

/**
 * @param {Pick<Console, "info" | "warn" | "error"> | undefined} logger
 * @param {{ prisma: any; merchantId?: string | null; shopId?: string | null; feature: string; runType?: string | null; runId?: string | null }} [usage]
 */
function safeCreateLlmProvider(logger, usage) {
  try {
    return createLlmProvider({ logger, usage });
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
    parts.push(
      `I last checked this on ${formatDateTime(belief.lastEvaluatedAt)}.`,
    );
  }
  if (belief.confidenceReason)
    parts.push(`Worth knowing: ${belief.confidenceReason}`);
  return parts.join("\n\n");
}

/**
 * The merchant-facing text for a clarification. `operation.reason` is the model's
 * private, third-person justification and must never be shown; prefer the dedicated
 * second-person `merchantReply`, and fall back to a general but still-human question
 * rather than leaking the rationale.
 * @param {any} operation
 */
export function buildClarificationReply(operation) {
  return (
    text(operation?.merchantReply) ||
    "I want to get this right — could you tell me a bit more about which part you mean?"
  );
}

/**
 * @param {any} operation
 * @param {any[]} beliefs
 */
export function buildNoChangeResponse(operation, beliefs) {
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
  // A no-change reply speaks for itself. It must NOT bolt on an unrelated open
  // question — that is what produced replies that answered nothing and then re-asked
  // a stray cost prompt — and it must not leak the model's private `reason`. Prefer
  // the second-person merchantReply; otherwise a plain human acknowledgement.
  return (
    text(operation.merchantReply) ||
    "Got it — I’ve taken that in. Nothing for me to change in what I remember just yet."
  );
}

/**
 * @param {any} operation
 */
function buildProposedChangeResponse(
  operation,
  /** @type {any[]} */ beliefs = [],
) {
  const label = labelForBeliefKey(operation.targetBeliefKey);
  if (operation.operationType === OPERATION_TYPES.obsoleteBelief) {
    // Show what is about to GO, with its current value. This is the merchant's one chance to
    // catch a mis-targeted forget, and they can only catch it if they can see which fact it
    // is — a bare "forget this?" gives them nothing to check against.
    const current = (beliefs ?? []).find(
      (belief) => belief.key === operation.targetBeliefKey,
    );
    const detail = current ? `\n${formatBeliefValue(current.value)}` : "";
    return `Just to check — you want me to forget this?\n\n${label}${detail}\n\nSay yes and I’ll drop it. This only changes what I remember; nothing changes in your store.`;
  }
  return `I think this should update Jefe’s understanding:\n\n${label}\n${formatBeliefValue(operation.proposedValue)}\n\nSource: told to Jefe by you.`;
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
  if (operation.operationType === OPERATION_TYPES.obsoleteBelief) {
    // A no-op (nothing active under that key) reads as already-done rather than as an error —
    // the merchant asked for it to be gone and it is gone.
    if (!commit.belief) {
      return `That’s not something I’m holding onto any more, so there’s nothing to forget.`;
    }
    // Name the undo. A destructive change the merchant can't see a way back from is one
    // they'll hesitate to make.
    return `Done — I’ve forgotten ${label}, and I won’t work it out again from your store data. Say “undo that” if you want it back.`;
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
    topic: conversation.topic,
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
                  : normalized.includes("store name") ||
                      normalized.includes("business name")
                    ? "business.store_name"
                    : null;
  if (key) return beliefs.find((belief) => belief.key === key) ?? { key };
  const lastKey = context?.lastDiscussedBeliefKeys?.[0];
  return lastKey &&
    /\b(that|this|it|those|yes|correct|right|why)\b/.test(normalized)
    ? beliefs.find((belief) => belief.key === lastKey)
    : null;
}

/**
 * @param {string} normalized
 * @param {string} message
 * @param {any} target
 * @param {any} currentQuestion
 * @param {any} context
 */
function extractSupportedChange(
  normalized,
  message,
  target,
  currentQuestion,
  context,
) {
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

  const lowStock = normalized.match(
    /(?:fewer than|less than|below|under)\s+(\d+)/,
  );
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
    const openQuestionOperation = operationForOpenQuestion(
      currentQuestion,
      message,
    );
    if (openQuestionOperation) return openQuestionOperation;
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
    return clarification(
      "Which optimisation priority should I remember: growth, profit, cash flow, retention or revenue?",
      message,
      {
        ...context,
        lastDiscussedBeliefKeys: ["preferences.optimisation_priority"],
      },
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
    return clarification(
      "Which optimisation priority should I remember: growth, profit, cash flow, retention or revenue?",
      message,
      { lastDiscussedBeliefKeys: ["preferences.optimisation_priority"] },
    );
  }

  if (question.questionKey !== "policies.business_rules") {
    return null;
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
function merchantBelief(
  key,
  category,
  value,
  reason,
  message,
  requiresConfirmation,
  question,
) {
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
    // The deterministic clarifications are already phrased to the merchant, so the
    // spoken reply is that same text. The LLM path fills merchantReply itself.
    merchantReply: reason,
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
  return (
    [
      "business",
      "catalog",
      "orders",
      "customers",
      "inventory",
      "operations",
      "preferences",
      "policies",
    ].find((category) => value.includes(category)) ??
    (value.includes("stock") ? "inventory" : null)
  );
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
  return (
    value.includes("?") ||
    /^(what|why|how|where|show|tell me|do you)/.test(value)
  );
}

/**
 * @param {string} value
 */
function isInspectRequest(value) {
  return /what.*(know|learn|understand|believe)|show.*believe|what.*need/.test(
    value,
  );
}

/**
 * @param {string} value
 */
function isExplanationRequest(value) {
  return /\bwhy\b|how did|where did|how confident|calculate|calculated|come from/.test(
    value,
  );
}

/**
 * @param {string} value
 */
function isConfirmation(value) {
  return /\b(yes|correct|right|accurate|looks good|that is correct|that's correct)\b/.test(
    value,
  );
}

// Deliberately NARROW. This is the one detector whose false positives destroy something, so
// it is tuned for precision over recall: an unmatched "forget" phrasing costs the merchant a
// second attempt, while a wrong match costs them a fact they may never notice is gone. Widen
// it only from real transcripts (the correction-controls session is collecting fall-throughs).
const OBSOLETE_INTENT =
  /\b(forget|disregard|discard)\b|\b(drop|remove|delete) (that|this|it)\b|\bstop (tracking|remembering)\b|\bno longer (true|relevant|applies|the case)\b|\bnot (true|relevant) (any ?more|anymore)\b/;

// "Don't forget we ship on Fridays" is a merchant TEACHING Jefe something — the exact
// opposite instruction, and it contains the trigger word. "I forget what the margin is" is a
// merchant admitting they don't know, not asking Jefe to drop anything.
const OBSOLETE_NEGATION =
  /\b(do not|don't|dont|never) forget\b|\bi (forget|forgot)\b/;

/**
 * @param {string} value
 */
function isObsoleteRequest(value) {
  if (OBSOLETE_NEGATION.test(value)) return false;
  return OBSOLETE_INTENT.test(value);
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
