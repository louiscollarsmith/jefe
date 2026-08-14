// @ts-check

import crypto from "node:crypto";
import { logger as baseLogger } from "../observability/logger.server.js";

export const EPISODIC_INDEX_VERSION = "episodic-v1";
export const EPISODE_PROCESS_JOB_TYPE = "merchant_episode_process";
export const EPISODE_BACKFILL_JOB_TYPE = "merchant_episode_backfill";

const log = baseLogger.child({ component: "merchant-episodic-memory" });

/**
 * Remove common direct customer identifiers before text is copied into search,
 * summaries, embeddings, or prompts. Canonical message content remains unchanged.
 * @param {string} value
 */
export function sanitizeMemoryText(value) {
  // ⛔ PII SCRUBBING REMOVED — founder's call (Matt, 2026-08-13), reaffirmed after the
  // exposure was spelled out. Customer emails, phone numbers, payment identifiers and names
  // now pass through UNCHANGED into prompts, stored conversation threads and Merchant Memory.
  //
  // What this means in practice, so nobody has to rediscover it: merchant-typed and
  // file-extracted text reaches the LLM provider verbatim, and lands in the activity event
  // log that feeds admin.mynamejefe.com — which is cross-merchant and currently has no login
  // (also his call, revisit ~early September). Those two decisions compound.
  //
  // Restoring is this function: the removed patterns are in git history at this commit.
  //
  // ⚠️ The Shopify credential pattern is deliberately KEPT. `shpat_…` is an access token, not
  // personal data — leaking one is account takeover rather than a privacy question, and it
  // was not what was asked for.
  return String(value ?? "")
    .replace(
      /\b(?:shpat|shpca|shppa|shpss)_[A-Za-z0-9_-]+\b/g,
      "[redacted secret]",
    )
    .trim();
}

/** @param {string} value */
export function conversationTitleFromMessage(value) {
  const clean = sanitizeMemoryText(value).replace(/\s+/g, " ");
  if (!clean) return null;
  return clean.length > 72 ? `${clean.slice(0, 69).trimEnd()}…` : clean;
}

/**
 * @param {import("@prisma/client").PrismaClient | any} prisma
 * @param {{ merchantId: string; shopId?: string | null; conversationType?: string; surface?: string; externalThreadId?: string | null; topic?: string; title?: string | null; context?: any; focusedActionId?: string | null }} input
 */
export async function createMerchantConversation(prisma, input) {
  return prisma.merchantMemoryConversation.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      topic: input.topic ?? topicForConversationType(input.conversationType),
      conversationType: input.conversationType ?? "general",
      surface: input.surface ?? "app",
      externalThreadId: input.externalThreadId ?? null,
      title: input.title ?? null,
      context: input.context ?? {},
      focusedActionId: input.focusedActionId ?? null,
      lastMessageAt: new Date(),
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient | any} prisma
 * @param {{ merchantId: string; shopId?: string | null; conversationId?: string | null; conversationType?: string; surface?: string; externalThreadId?: string | null; topic?: string }} input
 */
export async function getOrCreateMerchantConversation(prisma, input) {
  const surface = input.surface ?? "app";
  const conversationType = input.conversationType ?? "general";
  const tenantWhere = {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
  };
  if (input.conversationId) {
    const selected = await prisma.merchantMemoryConversation.findFirst({
      where: { id: input.conversationId, ...tenantWhere },
    });
    if (!selected)
      throw new Error("Conversation was not found for this merchant and shop.");
    return selected;
  }
  if (input.externalThreadId) {
    const external = await prisma.merchantMemoryConversation.findFirst({
      where: {
        ...tenantWhere,
        surface,
        externalThreadId: input.externalThreadId,
        status: "active",
      },
      orderBy: { lastMessageAt: "desc" },
    });
    if (external) return external;
    return createMerchantConversation(prisma, input);
  }
  const existing = await prisma.merchantMemoryConversation.findFirst({
    where: {
      ...tenantWhere,
      conversationType,
      surface,
      topic: input.topic ?? undefined,
      status: "active",
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
  });
  return existing ?? createMerchantConversation(prisma, input);
}

/**
 * Persist one canonical message and its rebuildable message episode atomically.
 * @param {import("@prisma/client").PrismaClient | any} prisma
 * @param {{ conversationId: string; merchantId: string; shopId?: string | null; role: string; content: string; conversation?: any; surface?: string; externalMessageId?: string | null; recommendationId?: string | null; actionRunId?: string | null; metadata?: any; structuredOperation?: any; operationStatus?: string | null; relatedBeliefIds?: string[]; relatedOpenQuestionId?: string | null; safeSummary?: string | null; enqueue?: boolean; touchConversation?: boolean }} input
 */
export async function appendConversationMessage(prisma, input) {
  const content = String(input.content ?? "").trim();
  if (!content) throw new Error("Message is required.");
  const surface = input.surface ?? "app";

  if (input.externalMessageId) {
    const duplicate = await prisma.merchantMemoryConversationMessage.findFirst({
      where: {
        merchantId: input.merchantId,
        surface,
        externalMessageId: input.externalMessageId,
      },
    });
    if (duplicate) return { message: duplicate, duplicate: true };
  }

  const run = async (/** @type {any} */ tx) => {
    const conversation =
      input.conversation ??
      (await tx.merchantMemoryConversation.findFirst({
        where: {
          id: input.conversationId,
          merchantId: input.merchantId,
          shopId: input.shopId ?? null,
        },
      }));
    if (
      !conversation ||
      conversation.id !== input.conversationId ||
      conversation.merchantId !== input.merchantId ||
      (conversation.shopId ?? null) !== (input.shopId ?? null)
    ) {
      throw new Error("Conversation was not found for this merchant and shop.");
    }
    const message = await tx.merchantMemoryConversationMessage.create({
      data: {
        conversationId: conversation.id,
        merchantId: input.merchantId,
        shopId: input.shopId ?? null,
        role: input.role,
        content,
        surface,
        externalMessageId: input.externalMessageId ?? null,
        recommendationId: input.recommendationId ?? null,
        actionRunId: input.actionRunId ?? null,
        metadata: input.metadata ?? {},
        structuredOperation: input.structuredOperation ?? undefined,
        operationStatus: input.operationStatus ?? null,
        relatedBeliefIds: input.relatedBeliefIds ?? [],
        relatedOpenQuestionId: input.relatedOpenQuestionId ?? null,
        safeSummary: input.safeSummary ?? null,
        processingStatus: "pending",
      },
    });
    if (tx.merchantMemoryEpisode?.upsert)
      await createMessageEpisode(tx, message);
    const title =
      conversation.title || input.role !== "merchant"
        ? undefined
        : conversationTitleFromMessage(content);
    if (tx.merchantMemoryEpisode?.upsert && input.touchConversation !== false) {
      await tx.merchantMemoryConversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: message.createdAt,
          ...(title ? { title } : {}),
        },
      });
    }
    if (input.enqueue !== false && input.shopId && tx.backfillJob?.findUnique) {
      await enqueueCoalescingMemoryJob(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        jobType: EPISODE_PROCESS_JOB_TYPE,
        priority: 35,
      });
    }
    return { message, duplicate: false };
  };

  try {
    return typeof prisma.$transaction === "function"
      ? await prisma.$transaction(run)
      : await run(prisma);
  } catch (error) {
    if (input.externalMessageId && isUniqueConstraintError(error)) {
      const duplicate =
        await prisma.merchantMemoryConversationMessage.findFirst({
          where: {
            merchantId: input.merchantId,
            surface,
            externalMessageId: input.externalMessageId,
          },
        });
      if (duplicate) return { message: duplicate, duplicate: true };
    }
    throw error;
  }
}

/** @param {any} prisma @param {any} message */
export async function createMessageEpisode(prisma, message) {
  const sourceHash = hashValue(
    `${EPISODIC_INDEX_VERSION}:message:${message.id}`,
  );
  return prisma.merchantMemoryEpisode.upsert({
    where: {
      conversationId_documentType_sourceHash: {
        conversationId: message.conversationId,
        documentType: "message",
        sourceHash,
      },
    },
    create: {
      merchantId: message.merchantId,
      shopId: message.shopId ?? null,
      conversationId: message.conversationId,
      documentType: "message",
      role: message.role,
      sourceMessageIds: [message.id],
      searchText: sanitizeMemoryText(message.content),
      entityRefs: extractEntityRefs(message.content),
      relatedBeliefIds: message.relatedBeliefIds ?? [],
      recommendationId: message.recommendationId ?? null,
      actionRunId: message.actionRunId ?? null,
      occurredAt: message.createdAt,
      visibility: message.visibility ?? "current",
      sourceHash,
      indexVersion: EPISODIC_INDEX_VERSION,
      processingStatus: "pending",
      embeddingStatus: "pending",
    },
    update: {
      searchText: sanitizeMemoryText(message.content),
      entityRefs: extractEntityRefs(message.content),
      relatedBeliefIds: message.relatedBeliefIds ?? [],
      visibility: message.visibility ?? "current",
      processingStatus: "pending",
      embeddingStatus: "pending",
      embeddingErrorCode: null,
    },
  });
}

/** @param {any} prisma @param {{ merchantId: string; messageId: string; beliefId: string }} input */
export async function linkConversationMessageToBelief(prisma, input) {
  const message = await prisma.merchantMemoryConversationMessage.findFirst({
    where: { id: input.messageId, merchantId: input.merchantId },
    select: { id: true, relatedBeliefIds: true },
  });
  if (!message) return false;
  await prisma.merchantMemoryConversationMessage.update({
    where: { id: message.id },
    data: {
      relatedBeliefIds: [
        ...new Set([...message.relatedBeliefIds, input.beliefId]),
      ],
    },
  });
  const episodes = await prisma.merchantMemoryEpisode.findMany({
    where: {
      merchantId: input.merchantId,
      sourceMessageIds: { has: message.id },
    },
    select: { id: true, relatedBeliefIds: true },
  });
  await Promise.all(
    episodes.map((/** @type {any} */ episode) =>
      prisma.merchantMemoryEpisode.update({
        where: { id: episode.id },
        data: {
          relatedBeliefIds: [
            ...new Set([...episode.relatedBeliefIds, input.beliefId]),
          ],
        },
      }),
    ),
  );
  return true;
}

/**
 * Coalescing queue semantics: never reset a running job. Source rows are the
 * durable wake-up signal; the worker sweeper requeues terminal jobs when needed.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; jobType: string; priority?: number }} input
 */
export async function enqueueCoalescingMemoryJob(prisma, input) {
  const where = {
    shopId_jobType: { shopId: input.shopId, jobType: input.jobType },
  };
  const existing = await prisma.backfillJob.findUnique({ where });
  if (!existing) {
    try {
      return await prisma.backfillJob.create({
        data: {
          merchantId: input.merchantId,
          shopId: input.shopId,
          jobType: input.jobType,
          status: "queued",
          priority: input.priority ?? 35,
          runAfter: new Date(),
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return prisma.backfillJob.findUnique({ where });
    }
  }
  if (existing.status === "running" || existing.status === "queued")
    return existing;
  return prisma.backfillJob.update({
    where: { id: existing.id },
    data: {
      status: "queued",
      priority: input.priority ?? existing.priority,
      runAfter: new Date(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
    },
  });
}

/** @param {string} value */
export function extractEntityRefs(value) {
  const refs = [];
  for (const match of String(value).matchAll(
    /\b(?:gid:\/\/shopify\/[A-Za-z]+\/\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi,
  )) {
    refs.push(match[0]);
  }
  return [...new Set(refs)].slice(0, 20);
}

/** @param {string} value */
export function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {number[]} values */
export function vectorLiteral(values) {
  if (
    !Array.isArray(values) ||
    values.length !== 768 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("A 768-dimensional finite embedding is required.");
  }
  return `[${values.join(",")}]`;
}

/** @param {string | undefined} conversationType */
function topicForConversationType(conversationType) {
  if (conversationType === "goal_coaching") return "onboarding_goals";
  if (conversationType === "plan_refinement") return "onboarding_plan";
  if (conversationType === "memory_review") return "memory";
  return "general";
}

/** @param {unknown} error */
function isUniqueConstraintError(error) {
  return /** @type {any} */ (error)?.code === "P2002";
}

/** @param {any} input */
export function logEpisodeProcessingFailure(input) {
  log.warn("Merchant Memory episode processing failed", input);
}
