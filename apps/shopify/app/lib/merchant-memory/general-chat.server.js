// @ts-check

import { Type } from "@google/genai";
import { createLlmProvider } from "../llm/provider.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  appendConversationMessage,
  createMerchantConversation,
  getOrCreateMerchantConversation,
  sanitizeMemoryText,
} from "./episodic-memory.server.js";
import { retrieveMerchantContext } from "./merchant-context.server.js";
import { getMerchantContextForQuestion } from "./context-retriever.server.js";
import { answerCommerceQuestion } from "./commerce-analyst.server.js";

const GENERAL_CHAT_REPLY_SCHEMA = {
  type: Type.OBJECT,
  required: ["reply", "citedContextIds"],
  properties: {
    reply: { type: Type.STRING },
    citedContextIds: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
};

const log = baseLogger.child({ component: "merchant-general-chat" });

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; message: string; conversationId?: string | null; surface?: string; externalThreadId?: string | null; externalMessageId?: string | null; recommendationId?: string | null; actionRunId?: string | null; metadata?: any; llmProvider?: import("../llm/provider.server.js").LlmProvider; logger?: Pick<Console, "info" | "warn" | "error"> }} input
 * @returns {Promise<any>}
 */
export async function sendGeneralChatMessage(prisma, input) {
  const content = String(input.message ?? "").trim();
  if (!content) return { ok: false, error: "Message is required." };
  const surface = input.surface ?? "app";
  const conversation = await getOrCreateMerchantConversation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: input.conversationId,
    conversationType:
      input.actionRunId || input.recommendationId ? "action" : "general",
    surface,
    externalThreadId: input.externalThreadId,
    topic:
      input.actionRunId || input.recommendationId
        ? `action:${input.recommendationId ?? input.actionRunId}`
        : "general",
  });
  if (input.actionRunId || input.recommendationId) {
    await prisma.merchantMemoryConversation.update({
      where: { id: conversation.id },
      data: {
        context: {
          ...(conversation.context ?? {}),
          currentActionRunId: input.actionRunId ?? null,
          actionRunId: input.actionRunId ?? null,
          recommendationId: input.recommendationId ?? null,
        },
      },
    });
  }
  const persisted = await appendConversationMessage(prisma, {
    conversation,
    conversationId: conversation.id,
    merchantId: input.merchantId,
    shopId: input.shopId,
    role: "merchant",
    content,
    surface,
    externalMessageId: input.externalMessageId,
    recommendationId: input.recommendationId,
    actionRunId: input.actionRunId,
    metadata: input.metadata,
    safeSummary: content.length > 240 ? `${content.slice(0, 237)}...` : content,
  });
  if (persisted.duplicate) {
    return {
      ok: true,
      duplicate: true,
      conversationId: conversation.id,
      merchantMessageId: persisted.message.id,
      assistantMessage: null,
      citedContextIds: [],
    };
  }
  const actionChat = Boolean(input.actionRunId || input.recommendationId);
  const [context, actionEvidence] = await Promise.all([
    retrieveMerchantContext(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      task: actionChat ? "action_chat" : "general_chat",
      query: content,
      queryMessageId: persisted.message.id,
      conversationId: conversation.id,
      recommendationId: input.recommendationId,
      actionRunId: input.actionRunId,
      tokenBudget: 6000,
    }),
    actionChat
      ? getMerchantContextForQuestion(prisma, {
          merchantId: input.merchantId,
          shopId: input.shopId,
          recommendationId: input.recommendationId,
          actionRunId: input.actionRunId,
          message: content,
          logger: input.logger ?? log,
        })
      : Promise.resolve(null),
  ]);
  const promptContext = actionEvidence
    ? { ...context, actionEvidence }
    : context;
  if (actionEvidence) {
    await prisma.merchantMemoryConversation.update({
      where: { id: conversation.id },
      data: {
        context: {
          ...(conversation.context ?? {}),
          currentActionRunId: input.actionRunId ?? null,
          actionRunId: input.actionRunId ?? null,
          recommendationId: input.recommendationId ?? null,
          planEvidenceSnapshotId:
            actionEvidence.planEvidenceAtRecommendationTime?.snapshotId ?? null,
          contextRetrievedAt: new Date().toISOString(),
        },
      },
    });
  }
  const promptMessage = sanitizeMemoryText(content);
  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger: input.logger ?? log,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "general_chat",
      },
    });
  const commerce = await answerCommerceQuestion(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    message: promptMessage,
    actionContext: actionEvidence ?? context,
    recentMessages: context.workingMemory.map((/** @type {any} */ item) => ({
      role: item.role ?? "message",
      content: item.content,
    })),
    provider,
    logger: input.logger ?? log,
  });
  const generated = commerce.reply
    ? { reply: commerce.reply, citedContextIds: [] }
    : await generateGroundedReply({
        provider,
        message: promptMessage,
        context: promptContext,
        logger: input.logger ?? log,
      });
  const assistant = await appendConversationMessage(prisma, {
    conversation,
    conversationId: conversation.id,
    merchantId: input.merchantId,
    shopId: input.shopId,
    role: "assistant",
    content: generated.reply,
    surface,
    recommendationId: input.recommendationId,
    actionRunId: input.actionRunId,
    metadata: {
      citedContextIds: generated.citedContextIds,
      retrievalRunId: context.diagnosticId,
    },
    safeSummary: "Jefe answered from bounded Merchant Memory context.",
  });
  return {
    ok: true,
    duplicate: false,
    conversationId: conversation.id,
    merchantMessageId: persisted.message.id,
    assistantMessage: {
      id: assistant.message.id,
      content: assistant.message.content,
    },
    citedContextIds: generated.citedContextIds,
  };
}

/** @param {any} prisma @param {{ merchantId: string; shopId: string }} input */
export async function startNewGeneralChat(prisma, input) {
  return createMerchantConversation(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationType: "general",
    surface: "app",
    topic: "general",
  });
}

/**
 * Read-only Daily Home thread + compact app-chat history.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId?: string | null; take?: number; historyTake?: number }} input
 */
export async function getDailyChatExperience(prisma, input) {
  const history = await prisma.merchantMemoryConversation.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      surface: "app",
      OR: [
        { conversationType: "general" },
        { conversationType: "legacy", topic: "memory" },
      ],
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    take: input.historyTake ?? 30,
  });
  let active = input.conversationId
    ? (history.find(
        (/** @type {any} */ conversation) =>
          conversation.id === input.conversationId,
      ) ?? null)
    : (history[0] ?? null);
  if (input.conversationId && !active) {
    active = await prisma.merchantMemoryConversation.findFirst({
      where: {
        id: input.conversationId,
        merchantId: input.merchantId,
        shopId: input.shopId,
        surface: "app",
        OR: [
          { conversationType: "general" },
          { conversationType: "legacy", topic: "memory" },
        ],
      },
    });
    if (!active) active = history[0] ?? null;
  }
  if (!active) return { conversation: null, conversations: [], messages: [] };
  const messages = await prisma.merchantMemoryConversationMessage.findMany({
    where: {
      conversationId: active.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take ?? 20,
  });
  return {
    conversation: serializeConversation(active),
    conversations: history.map((/** @type {any} */ item) =>
      serializeConversation(item),
    ),
    messages: messages
      .reverse()
      .map((/** @type {any} */ item) => serializeMessage(item)),
  };
}

/** @param {{ provider: any; message: string; context: any; logger: any }} input */
async function generateGroundedReply(input) {
  const allowedIds = new Set(
    input.context.provenance.map((/** @type {any} */ item) => item.id),
  );
  const fallback = fallbackReply(input.context);
  if (!input.provider?.enabled || !input.provider.generateStructuredJson) {
    return { reply: fallback, citedContextIds: [] };
  }
  try {
    const result = await input.provider.generateStructuredJson({
      systemPrompt: [
        "You are Jefe, the merchant's grounded eCommerce manager.",
        "Answer the merchant directly using only the supplied Merchant Context packet.",
        "Current authoritative semantic memory outranks older episodes.",
        "Historical items are labelled and must never be described as current.",
        "Never claim you performed an action unless an action-ledger item says so.",
        "Return citedContextIds containing only ids from the packet that materially support the answer.",
        "If context is insufficient, say what is missing naturally; never discuss memory implementation.",
      ].join("\n"),
      prompt: JSON.stringify({
        merchantMessage: input.message,
        merchantContext: input.context,
      }),
      schema: GENERAL_CHAT_REPLY_SCHEMA,
      maxOutputTokens: 900,
    });
    const reply = String(result.json?.reply ?? "").trim();
    const citedContextIds = Array.isArray(result.json?.citedContextIds)
      ? [
          ...new Set(
            result.json.citedContextIds.filter(
              (/** @type {any} */ id) =>
                typeof id === "string" && allowedIds.has(id),
            ),
          ),
        ]
      : [];
    if (!reply || !numbersAreGrounded(reply, input.context)) {
      return { reply: fallback, citedContextIds: [] };
    }
    return { reply, citedContextIds };
  } catch (error) {
    input.logger.warn(
      "General chat generation unavailable; using grounded fallback",
      {
        error: error instanceof Error ? error.name : "UnknownError",
        provider: input.provider.provider,
        model: input.provider.model,
      },
    );
    return { reply: fallback, citedContextIds: [] };
  }
}

/** @param {any} context */
function fallbackReply(context) {
  const item =
    context.semanticMemory[0] ??
    context.actionMemory[0] ??
    context.episodicMemory[0] ??
    null;
  if (!item)
    return "I don’t have enough grounded information to answer that yet. Tell me the missing detail and I’ll work from it.";
  const prefix =
    item.temporalStatus === "historical"
      ? "From our earlier conversation—not as your current position—"
      : "From what I know about your business, ";
  return `${prefix}${String(item.content).replace(/[.!?]*$/, ".")}`;
}

/** @param {string} reply @param {any} context */
function numbersAreGrounded(reply, context) {
  const numbers = reply.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? [];
  if (numbers.length === 0) return true;
  const source = JSON.stringify({
    semanticMemory: context.semanticMemory,
    episodicMemory: context.episodicMemory,
    actionMemory: context.actionMemory,
    liveEvidence: context.liveEvidence,
  });
  return numbers.every((number) => source.includes(number));
}

/** @param {any} row */
function serializeConversation(row) {
  return {
    id: row.id,
    conversationType: row.conversationType,
    surface: row.surface,
    title:
      row.title ||
      (row.conversationType === "legacy"
        ? "Earlier conversation"
        : "New conversation"),
    lastMessageAt: (row.lastMessageAt ?? row.updatedAt).toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** @param {any} row */
function serializeMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    visibility: row.visibility,
  };
}
