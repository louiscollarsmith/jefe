// @ts-check

import crypto from "node:crypto";
import { Type } from "@google/genai";
import { Prisma as PrismaClientSql } from "@prisma/client";
import { createLlmProvider } from "../llm/provider.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";
import { embedMerchantMemoryText } from "./embedding.server.js";
import {
  createMessageEpisode,
  EPISODIC_INDEX_VERSION,
  extractEntityRefs,
  sanitizeMemoryText,
  vectorLiteral,
} from "./episodic-memory.server.js";
import { processPassiveMemoryMessage } from "./passive-memory.server.js";

const SUMMARY_SCHEMA = {
  type: Type.OBJECT,
  required: [
    "summary",
    "topics",
    "merchantStatements",
    "decisions",
    "jefeRecommendations",
    "unresolvedThreads",
    "referencedEntities",
  ],
  properties: {
    summary: { type: Type.STRING },
    topics: { type: Type.ARRAY, items: { type: Type.STRING } },
    merchantStatements: { type: Type.ARRAY, items: { type: Type.STRING } },
    decisions: { type: Type.ARRAY, items: { type: Type.STRING } },
    jefeRecommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
    unresolvedThreads: { type: Type.ARRAY, items: { type: Type.STRING } },
    referencedEntities: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
};

const log = baseLogger.child({ component: "merchant-episode-processor" });
const INACTIVITY_MS = 30 * 60 * 1000;

/** @param {any} prisma @param {{ merchantId: string; shopId: string; batchSize?: number; logger?: any; llmProvider?: any; now?: Date }} input */
export async function processMerchantEpisodeBatch(prisma, input) {
  const batchSize = Math.min(50, Math.max(1, input.batchSize ?? 20));
  const episodes = await prisma.merchantMemoryEpisode.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      OR: [
        { processingStatus: { in: ["pending", "stale"] } },
        { embeddingStatus: "pending" },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  let processed = 0;
  let failed = 0;
  for (const episode of episodes) {
    try {
      await processEpisode(prisma, episode, input);
      processed += 1;
    } catch (error) {
      failed += 1;
      await prisma.merchantMemoryEpisode.update({
        where: { id: episode.id },
        data: { processingStatus: "failed" },
      });
      (input.logger ?? log).warn("Merchant episode processing failed", {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.merchantId,
        shopId: input.shopId,
        episodeId: episode.id,
      });
    }
  }
  const summaries = await summariseInactiveConversations(prisma, input);
  const remaining = await prisma.merchantMemoryEpisode.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      OR: [
        { processingStatus: { in: ["pending", "stale"] } },
        { embeddingStatus: "pending" },
      ],
    },
  });
  return { processed, failed, summaries, remaining, requeue: remaining > 0 };
}

/** @param {any} prisma @param {{ merchantId: string; shopId: string; batchSize?: number }} input */
export async function backfillMerchantEpisodes(prisma, input) {
  const take = Math.min(500, Math.max(1, input.batchSize ?? 200));
  const ids =
    typeof prisma.$queryRaw === "function"
      ? await prisma.$queryRaw(PrismaClientSql.sql`
        SELECT message."id"
        FROM "merchant_memory_conversation_messages" AS message
        WHERE message."merchant_id" = ${input.merchantId}::uuid
          AND message."shop_id" = ${input.shopId}::uuid
          AND message."processing_status" = 'backfill_pending'
        ORDER BY message."created_at", message."id"
        LIMIT ${take}
      `)
      : [];
  const messageIds = /** @type {any[]} */ (ids).map((row) => row.id);
  if (messageIds.length > 0) {
    const messages = await prisma.merchantMemoryConversationMessage.findMany({
      where: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        id: { in: messageIds },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const message of messages) {
      await createMessageEpisode(prisma, message);
      await prisma.merchantMemoryConversationMessage.update({
        where: { id: message.id },
        data: {
          processingStatus: "pending",
          metadata: {
            ...(message.metadata && typeof message.metadata === "object"
              ? message.metadata
              : {}),
            historicalBackfill: true,
          },
        },
      });
    }
  }
  const remaining = await prisma.merchantMemoryConversationMessage.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      processingStatus: "backfill_pending",
    },
  });
  return { indexed: messageIds.length, remaining, requeue: remaining > 0 };
}

/** @param {any} prisma @param {any} episode @param {any} input */
async function processEpisode(prisma, episode, input) {
  if (episode.embeddingStatus === "pending" && episode.searchText) {
    const embedded = await embedMerchantMemoryText(episode.searchText, {
      taskType: "RETRIEVAL_DOCUMENT",
      prisma,
      merchantId: episode.merchantId,
      shopId: episode.shopId,
    });
    if (embedded?.values) {
      const vector = vectorLiteral(embedded.values);
      await prisma.$executeRaw(PrismaClientSql.sql`
        UPDATE "merchant_memory_episodes"
        SET "embedding" = ${vector}::vector,
            "embedding_status" = 'ready',
            "embedding_model" = ${embedded.model},
            "embedding_dimensions" = ${embedded.dimensions},
            "embedding_error_code" = NULL,
            "embedded_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${episode.id}::uuid
          AND "merchant_id" = ${episode.merchantId}::uuid
      `);
    } else {
      await prisma.merchantMemoryEpisode.update({
        where: { id: episode.id },
        data: {
          embeddingStatus: embedded ? "failed" : "disabled",
          embeddingModel: embedded?.model ?? null,
          embeddingDimensions: embedded?.dimensions ?? null,
          embeddingErrorCode: embedded?.errorCode ?? null,
        },
      });
    }
  }
  if (
    episode.documentType === "message" &&
    episode.sourceMessageIds.length > 0
  ) {
    if (episode.role === "merchant") {
      const source = await prisma.merchantMemoryConversationMessage.findUnique({
        where: { id: episode.sourceMessageIds[0] },
        select: { metadata: true },
      });
      if (source?.metadata?.historicalBackfill) {
        await prisma.merchantMemoryConversationMessage.update({
          where: { id: episode.sourceMessageIds[0] },
          data: { processingStatus: "complete" },
        });
      } else {
        await processPassiveMemoryMessage(prisma, {
          messageId: episode.sourceMessageIds[0],
          llmProvider: input.llmProvider,
          logger: input.logger,
        });
      }
    } else {
      await prisma.merchantMemoryConversationMessage.updateMany({
        where: {
          id: { in: episode.sourceMessageIds },
          merchantId: episode.merchantId,
        },
        data: { processingStatus: "complete" },
      });
    }
  }
  await prisma.merchantMemoryEpisode.update({
    where: { id: episode.id },
    data: { processingStatus: "complete" },
  });
}

/** @param {any} prisma @param {any} input */
async function summariseInactiveConversations(prisma, input) {
  const now = input.now ?? new Date();
  const conversations = await prisma.merchantMemoryConversation.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      OR: [
        { closedAt: { not: null } },
        { lastMessageAt: { lte: new Date(now.getTime() - INACTIVITY_MS) } },
      ],
    },
    orderBy: { lastMessageAt: "desc" },
    take: 10,
  });
  let created = 0;
  for (const conversation of conversations) {
    const messages = await prisma.merchantMemoryConversationMessage.findMany({
      where: {
        conversationId: conversation.id,
        merchantId: input.merchantId,
        shopId: input.shopId,
        visibility: "current",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
    for (const segment of segmentMessages(messages)) {
      const sourceHash = crypto
        .createHash("sha256")
        .update(
          `${EPISODIC_INDEX_VERSION}:summary:${segment.map((message) => message.id).join(":")}`,
        )
        .digest("hex");
      const existing = await prisma.merchantMemoryEpisode.findUnique({
        where: {
          conversationId_documentType_sourceHash: {
            conversationId: conversation.id,
            documentType: "summary",
            sourceHash,
          },
        },
        select: { id: true },
      });
      if (existing) continue;
      const summary = await generateStructuredSummary(prisma, {
        ...input,
        conversation,
        messages: segment,
      });
      await prisma.merchantMemoryEpisode.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          conversationId: conversation.id,
          documentType: "summary",
          role: null,
          sourceMessageIds: segment.map(
            (/** @type {any} */ message) => message.id,
          ),
          searchText: summarySearchText(summary),
          structuredSummary: summary,
          entityRefs: [
            ...new Set(
              segment.flatMap((message) => extractEntityRefs(message.content)),
            ),
          ],
          occurredAt:
            segment.at(-1)?.createdAt ??
            conversation.lastMessageAt ??
            conversation.updatedAt,
          visibility: "current",
          sourceHash,
          processingStatus: "pending",
          embeddingStatus: "pending",
        },
      });
      created += 1;
    }
  }
  return created;
}

/** @param {any} summary */
function summarySearchText(summary) {
  return sanitizeMemoryText(
    [
      summary.summary,
      ...(summary.topics ?? []),
      ...(summary.merchantStatements ?? []),
      ...(summary.decisions ?? []),
      ...(summary.jefeRecommendations ?? []),
      ...(summary.unresolvedThreads ?? []),
      ...(summary.referencedEntities ?? []),
    ].join(" "),
  ).slice(0, 6000);
}

/** @param {any} prisma @param {any} input */
async function generateStructuredSummary(prisma, input) {
  const fallback = deterministicSummary(input.messages);
  const provider =
    input.llmProvider ??
    createLlmProvider({
      logger: input.logger ?? log,
      usage: {
        prisma,
        merchantId: input.merchantId,
        shopId: input.shopId,
        feature: "conversation_summary",
      },
    });
  if (!provider?.enabled || !provider.generateStructuredJson) return fallback;
  try {
    const result = await provider.generateStructuredJson({
      systemPrompt: [
        "Summarise a merchant conversation for historical retrieval.",
        "Separate merchant statements, decisions, Jefe recommendations, and unresolved threads.",
        "A summary is not evidence and must not turn Jefe suggestions into merchant facts.",
        "Do not include customer personal data.",
      ].join("\n"),
      prompt: JSON.stringify({
        messages: input.messages.map((/** @type {any} */ message) => ({
          role: message.role,
          content: sanitizeMemoryText(message.content),
        })),
      }),
      schema: SUMMARY_SCHEMA,
      maxOutputTokens: 1000,
    });
    return normaliseSummary(result.json, fallback);
  } catch (error) {
    (input.logger ?? log).warn(
      "Conversation summary generation unavailable; using deterministic summary",
      {
        error: error instanceof Error ? error.name : "UnknownError",
        merchantId: input.merchantId,
        shopId: input.shopId,
        conversationId: input.conversation.id,
      },
    );
    return fallback;
  }
}

/** @param {any[]} messages */
export function segmentMessages(messages) {
  const segments = [];
  let index = 0;
  while (index < messages.length) {
    const segment = [];
    let characters = 0;
    while (index < messages.length && segment.length < 20) {
      const message = messages[index];
      const length = String(message.content ?? "").length;
      if (segment.length > 0 && characters + length > 6000) break;
      segment.push(message);
      characters += length;
      index += 1;
    }
    if (segment.length === 0) break;
    segments.push(segment);
    if (index < messages.length) index = Math.max(0, index - 1);
  }
  return segments;
}

/** @param {any[]} messages */
function deterministicSummary(messages) {
  const merchant = messages
    .filter((message) => message.role === "merchant")
    .map((message) => sanitizeMemoryText(message.content));
  const assistant = messages
    .filter((message) => message.role === "assistant")
    .map((message) => sanitizeMemoryText(message.content));
  return {
    summary: [...merchant.slice(-3), ...assistant.slice(-2)]
      .join(" ")
      .slice(0, 1200),
    topics: [],
    merchantStatements: merchant.slice(-5),
    decisions: [],
    jefeRecommendations: assistant.slice(-5),
    unresolvedThreads: [],
    referencedEntities: [
      ...new Set(
        messages.flatMap((message) => extractEntityRefs(message.content)),
      ),
    ],
  };
}

/** @param {any} value @param {any} fallback */
function normaliseSummary(value, fallback) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.summary !== "string" ||
    !value.summary.trim()
  )
    return fallback;
  const array = (/** @type {string} */ key) =>
    Array.isArray(value[key])
      ? value[key].filter((item) => typeof item === "string").slice(0, 10)
      : [];
  return {
    summary: sanitizeMemoryText(value.summary).slice(0, 1200),
    topics: array("topics"),
    merchantStatements: array("merchantStatements"),
    decisions: array("decisions"),
    jefeRecommendations: array("jefeRecommendations"),
    unresolvedThreads: array("unresolvedThreads"),
    referencedEntities: array("referencedEntities"),
  };
}
