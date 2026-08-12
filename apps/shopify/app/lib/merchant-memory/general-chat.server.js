// @ts-check

import { Type } from "@google/genai";
import { createLlmProvider } from "../llm/provider.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import {
  appendConversationMessage,
  createMerchantConversation,
  enqueueCoalescingMemoryJob,
  EPISODE_PROCESS_JOB_TYPE,
  getOrCreateMerchantConversation,
  sanitizeMemoryText,
} from "./episodic-memory.server.js";
import { processPassiveMemoryMessage } from "./passive-memory.server.js";
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

const GENERAL_CHAT_MAX_INPUT_TOKENS = 8000;

const log = baseLogger.child({ component: "merchant-general-chat" });

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; message: string; conversationId?: string | null; surface?: string; externalThreadId?: string | null; externalMessageId?: string | null; recommendationId?: string | null; actionRunId?: string | null; metadata?: any; llmProvider?: import("../llm/provider.server.js").LlmProvider; messageDecisionProcessor?: typeof processPassiveMemoryMessage; logger?: Pick<Console, "info" | "warn" | "error"> }} input
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
    enqueue: false,
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
  let decision = {
    action: "general_chat",
    candidates: /** @type {any[]} */ ([]),
  };
  try {
    const processed = await (
      input.messageDecisionProcessor ?? processPassiveMemoryMessage
    )(prisma, {
      messageId: persisted.message.id,
      logger: input.logger ?? log,
    });
    decision = {
      action: processed.action ?? "general_chat",
      candidates: processed.candidates ?? [],
    };
  } catch (error) {
    (input.logger ?? log).warn(
      "Merchant message decision failed; continuing with general chat",
      {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.merchantId,
        shopId: input.shopId,
        messageId: persisted.message.id,
      },
    );
  } finally {
    try {
      await enqueueCoalescingMemoryJob(prisma, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        jobType: EPISODE_PROCESS_JOB_TYPE,
        priority: 35,
      });
    } catch (error) {
      (input.logger ?? log).warn("Merchant episode work could not be queued", {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.merchantId,
        shopId: input.shopId,
        messageId: persisted.message.id,
      });
    }
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
      historicalMode: decision.action === "historical_recall",
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
  const memoryReply = buildMemoryDecisionReply(decision, promptMessage);
  let generated;
  if (decision.action === "acknowledge_memory") {
    generated = {
      reply:
        memoryReply ??
        "I understood that as something you want me to remember, but I couldn’t safely save it as a durable preference. Please restate the rule and I’ll try again.",
      citedContextIds: [],
    };
  } else if (decision.action === "commerce_analysis") {
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
      requested: true,
    });
    generated = {
      reply: [memoryReply, commerce.reply].filter(Boolean).join("\n\n"),
      citedContextIds: [],
    };
  } else {
    const grounded = await generateGroundedReply({
      provider,
      message: promptMessage,
      context: promptContext,
      logger: input.logger ?? log,
    });
    generated = memoryReply
      ? { ...grounded, reply: `${memoryReply}\n\n${grounded.reply}` }
      : grounded;
  }
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

/** @param {{ action?: string; candidates?: any[] }} decision @param {string} sourceMessage */
export function buildMemoryDecisionReply(decision, sourceMessage) {
  const candidates = Array.isArray(decision.candidates)
    ? decision.candidates
    : [];
  const promoted = candidates.filter(
    (candidate) => candidate.status === "promoted",
  );
  if (promoted.length > 0) {
    const rules = promoted
      .map(memoryCandidateDescription)
      .filter(Boolean)
      .slice(0, 3);
    const detail = rules.length
      ? `: ${rules.join("; ")}`
      : `: “${sourceMessage.slice(0, 220)}”`;
    return `Got it — I’ve saved that for future decisions${detail}.`;
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.status === "rejected" && candidate.reasonCode === "no_change",
    )
  ) {
    return "Got it — I already have that saved for future decisions.";
  }
  if (candidates.some((candidate) => candidate.status === "conflict")) {
    return "I found that this conflicts with what I currently have saved, so I haven’t replaced it. I’ve kept it as an open question for you to resolve.";
  }
  return null;
}

/** @param {any} candidate */
function memoryCandidateDescription(candidate) {
  const value = candidate.proposedValue;
  if (candidate.operationType === "retract") return "the earlier rule is retired";
  if (candidate.key === "policies.allow_blanket_storewide_discounts") {
    return value?.boolean === false
      ? "don’t use blanket storewide discounts"
      : "blanket storewide discounts are allowed";
  }
  if (candidate.key === "policies.margin_cost_basis") {
    return value?.option === "shopify_cost_per_item"
      ? "always use Shopify Cost per item when assessing margin"
      : null;
  }
  if (candidate.key === "policies.never_recommend" && value?.text) {
    const text = String(value.text).replace(/[.!?]+$/, "").trim();
    const prohibition = text.match(/^(?:do not|don't|dont)\s+(.+)$/i);
    return prohibition
      ? `never ${lowercaseFirst(prohibition[1])}`
      : /^avoid\s+/i.test(text)
        ? lowercaseFirst(text)
        : `avoid ${lowercaseFirst(text)}`;
  }
  if (candidate.key === "preferences.optimisation_priority" && value?.option) {
    return `${String(value.option).replaceAll("_", " ")} is the current optimisation priority`;
  }
  return null;
}

/** @param {string} value */
function lowercaseFirst(value) {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
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
  const fallback = buildGroundedFallbackReply(input.message, input.context);
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
      maxInputTokens: GENERAL_CHAT_MAX_INPUT_TOKENS,
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

/** @param {string} message @param {any} context */
/**
 * Is this retrieved content something a person could read aloud?
 *
 * Deliberately conservative — it only rejects the shapes that are unmistakably serialised
 * data, because the cost of wrongly rejecting a real sentence is one less grounded reply,
 * while the cost of accepting JSON is a merchant reading `{"ratio":1,"numerator":436}`.
 * @param {unknown} content
 */
function isReadableProse(content) {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return false;
  if (/[{[]\s*["{]/.test(text)) return false; // {"…  [{…  [" …
  if (/"\s*:\s*/.test(text)) return false; // "key": …
  return true;
}

/**
 * @param {string} message
 * @param {any} context
 */
export function buildGroundedFallbackReply(message, context) {
  const historical = context.queryClass === "historical_recall";
  const groups = historical
    ? [context.episodicMemory, context.actionMemory, context.semanticMemory]
    : [context.semanticMemory, context.episodicMemory, context.actionMemory];
  const normalizedMessage = normalizeComparableText(message);
  const items = groups
    .flat()
    .filter(
      (item) => normalizeComparableText(item?.content) !== normalizedMessage,
    )
    // Retrieved items are not all prose. Some carry a serialised belief value, and this
    // reply path interpolates content verbatim — so a merchant asking about growth was
    // shown `From what I know about your business, Trailing 90d: {"items":[{"name":...`.
    // Raw JSON is never an answer; skip those and let a readable item (or the plain
    // admission below) win instead.
    .filter((item) => isReadableProse(item?.content));
  const item = mostRelevantItem(message, items);
  if (!item) {
    return historical
      ? "I couldn’t find a relevant earlier conversation to answer that reliably. Try naming the topic or recommendation you mean."
      : "I couldn’t connect that request to grounded information yet. Tell me which part you want me to revisit.";
  }
  const content = String(item.content).replace(/[.!?]*$/, ".");
  if (historical || item.temporalStatus === "historical") {
    return `From our earlier conversation: ${content}`;
  }
  return `From what I know about your business, ${content}`;
}

/** @param {string} query @param {any[]} items */
function mostRelevantItem(query, items) {
  const queryTerms = meaningfulTerms(query);
  if (queryTerms.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const contentTerms = meaningfulTerms(item?.content ?? "");
    const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
    const score = overlap / queryTerms.size;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/** @param {string} value */
function meaningfulTerms(value) {
  const stop = new Set([
    "about",
    "again",
    "before",
    "could",
    "from",
    "have",
    "please",
    "said",
    "that",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
  ]);
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((term) => term.length > 2 && !stop.has(term)) ?? [],
  );
}

/** @param {unknown} value */
function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
