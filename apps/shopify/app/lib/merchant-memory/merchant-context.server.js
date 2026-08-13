// @ts-check

import crypto from "node:crypto";
import { logger as baseLogger } from "../observability/logger.server.js";
import { getMerchantMemoryV2Config } from "./config.server.js";
import { sanitizeMemoryText } from "./episodic-memory.server.js";
import { retrieveWorkingMemory } from "./retrievers/working-memory-retriever.server.js";
import { retrieveSemanticMemory } from "./retrievers/semantic-memory-retriever.server.js";
import {
  classifyHistoricalRecall,
  retrieveEpisodicMemory,
} from "./retrievers/episodic-memory-retriever.server.js";
import { retrieveActionMemory } from "./retrievers/action-memory-retriever.server.js";

export const MERCHANT_CONTEXT_VERSION = "merchant-context-v2";
export const MERCHANT_CONTEXT_TASKS = Object.freeze([
  "general_chat",
  "memory_edit",
  "memory_candidate_extraction",
  "insights",
  "goals",
  "plan",
  "action_chat",
  "store_understanding",
]);

const log = baseLogger.child({ component: "merchant-context" });
const CONTEXT_CHARS_PER_TOKEN = 2;

export class MerchantContextScopeError extends Error {
  constructor() {
    super("Merchant context requires both merchantId and shopId.");
    this.name = "MerchantContextScopeError";
  }
}

/**
 * The only broad Merchant Memory read contract. It composes small retrievers and
 * always returns a bounded packet with source-level provenance.
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; task: string; query?: string | null; queryMessageId?: string | null; conversationId?: string | null; focusedActionId?: string | null; recommendationId?: string | null; actionRunId?: string | null; tokenBudget?: number; now?: Date; historicalMode?: boolean; embeddingProvider?: typeof import("./embedding.server.js").embedMerchantMemoryText }} input
 * @returns {Promise<any>}
 */
export async function retrieveMerchantContext(prisma, input) {
  if (!input.merchantId || !input.shopId) throw new MerchantContextScopeError();
  if (!MERCHANT_CONTEXT_TASKS.includes(input.task)) {
    throw new Error(`Unsupported Merchant Context task: ${input.task}`);
  }
  const config = getMerchantMemoryV2Config();
  const query = sanitizeMemoryText(input.query ?? "");
  const historicalMode =
    typeof input.historicalMode === "boolean"
      ? input.historicalMode
      : classifyHistoricalRecall(query);
  const tokenBudget = Math.min(
    Math.max(500, input.tokenBudget ?? defaultBudget(input.task, config)),
    config.maximumTokenBudget,
  );
  const common = {
    merchantId: input.merchantId,
    shopId: input.shopId,
    now: input.now,
  };
  const [working, semantic, episodic, actions, openQuestions, liveEvidence] =
    await Promise.all([
      retrieveWorkingMemory(prisma, {
        ...common,
        conversationId: input.conversationId,
        take: 12,
      }),
      retrieveSemanticMemory(prisma, { ...common, take: 16 }),
      config.contextEnabled
        ? retrieveEpisodicMemory(prisma, {
            ...common,
            query,
            historicalMode,
            recommendationId: input.recommendationId,
            actionRunId: input.actionRunId,
            take: 8,
            embeddingProvider: input.embeddingProvider,
          })
        : Promise.resolve([]),
      retrieveActionMemory(prisma, {
        ...common,
        focusedActionId: input.focusedActionId,
        recommendationId: input.recommendationId,
        actionRunId: input.actionRunId,
        take: 8,
      }),
      retrieveOpenQuestions(prisma, { ...common, take: 5 }),
      retrieveLiveEvidence(prisma, { ...common, take: 12 }),
    ]);

  const candidateGroups = {
    workingMemory: working,
    semanticMemory: semantic,
    episodicMemory: episodic,
    actionMemory: actions,
    openQuestions,
    liveEvidence,
  };
  const assembled = assembleBoundedContext(candidateGroups, {
    tokenBudget,
    order: groupOrder(input.task, historicalMode),
  });
  const queryHash = crypto.createHash("sha256").update(query).digest("hex");
  const diagnosticId = config.contextEnabled
    ? await recordRetrievalRun(prisma, {
        ...input,
        queryHash,
        historicalMode,
        tokenBudget,
        tokenUsed: assembled.tokenUsed,
        candidateGroups,
        selectedGroups: assembled.groups,
        discardedCount: assembled.discardedCount,
      })
    : null;
  return {
    version: MERCHANT_CONTEXT_VERSION,
    task: input.task,
    queryClass: historicalMode
      ? "historical_recall"
      : actionQuery(query)
        ? "action_history"
        : "current",
    ...assembled.groups,
    provenance: Object.values(assembled.groups)
      .flat()
      .map((/** @type {any} */ item) => ({
        id: item.id,
        memoryType: item.memoryType,
        source: item.source,
      })),
    limits: {
      tokenBudget,
      tokenUsed: assembled.tokenUsed,
      discardedCount: assembled.discardedCount,
      counts: Object.fromEntries(
        Object.entries(assembled.groups).map(([key, items]) => [
          key,
          items.length,
        ]),
      ),
    },
    diagnosticId,
  };
}

/** @param {Record<string, any[]>} candidateGroups @param {{ tokenBudget: number; order: string[] }} input */
export function assembleBoundedContext(candidateGroups, input) {
  /** @type {Record<string, any[]>} */
  const groups = Object.fromEntries(
    Object.keys(candidateGroups).map((key) => [key, []]),
  );
  let tokenUsed = 0;
  let selectedCount = 0;
  for (const group of input.order) {
    for (const rawItem of candidateGroups[group] ?? []) {
      const item = boundContextItem(rawItem);
      const tokens = estimateTokens(item);
      if (tokens > input.tokenBudget - tokenUsed) continue;
      groups[group].push(item);
      tokenUsed += tokens;
      selectedCount += 1;
    }
  }
  const candidateCount = Object.values(candidateGroups).reduce(
    (sum, items) => sum + items.length,
    0,
  );
  return { groups, tokenUsed, discardedCount: candidateCount - selectedCount };
}

/** @param {any} prisma @param {any} input */
async function retrieveOpenQuestions(prisma, input) {
  if (!prisma.merchantMemoryOpenQuestion?.findMany) return [];
  const rows = await prisma.merchantMemoryOpenQuestion.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: "open",
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: input.take,
  });
  return rows.map((/** @type {any} */ row) => ({
    id: `question:${row.id}`,
    memoryType: "question",
    content: row.question,
    data: {
      questionKey: row.questionKey,
      reason: row.reason,
      answerType: row.answerType,
      answerOptions: row.answerOptions,
    },
    authority: "open_question",
    confidence: null,
    temporalStatus: "current",
    occurredAt: row.createdAt.toISOString(),
    scope: { shopId: input.shopId },
    source: { type: "merchant_memory_open_question", questionId: row.id },
    score: { priority: 1 / Math.max(1, row.priority) },
  }));
}

/** @param {any} prisma @param {any} input */
async function retrieveLiveEvidence(prisma, input) {
  if (!prisma.merchantMemoryEvidence?.findMany) return [];
  const rows = await prisma.merchantMemoryEvidence.findMany({
    where: {
      merchantId: input.merchantId,
      OR: [{ shopId: input.shopId }, { shopId: null }],
    },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
    take: input.take,
  });
  return rows.map((/** @type {any} */ row) => ({
    id: `evidence:${row.id}`,
    memoryType: "evidence",
    content: sanitizeMemoryText(row.summary),
    data: { evidenceType: row.evidenceType, beliefId: row.beliefId },
    authority: row.sourceType,
    confidence: null,
    temporalStatus: "current",
    occurredAt: (row.observedAt ?? row.createdAt).toISOString(),
    scope: { shopId: row.shopId },
    source: {
      type: "merchant_memory_evidence",
      evidenceId: row.id,
      sourceReference: row.sourceReference,
    },
    score: { recency: 1 },
  }));
}

/** @param {any} prisma @param {any} input */
async function recordRetrievalRun(prisma, input) {
  if (!prisma.merchantContextRetrievalRun?.create) return null;
  try {
    const row = await prisma.merchantContextRetrievalRun.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        queryMessageId: input.queryMessageId ?? null,
        task: input.task,
        queryHash: input.queryHash,
        strategy: {
          version: MERCHANT_CONTEXT_VERSION,
          lexical: true,
          vector: true,
          recency: true,
          adjacency: true,
          authorityFirst: !input.historicalMode,
        },
        historicalMode: input.historicalMode,
        candidateCounts: Object.fromEntries(
          Object.entries(input.candidateGroups).map(([key, items]) => [
            key,
            /** @type {any[]} */ (items).length,
          ]),
        ),
        selectedItems: Object.values(input.selectedGroups)
          .flat()
          .map((/** @type {any} */ item) => ({
            id: item.id,
            memoryType: item.memoryType,
            score: item.score,
            source: item.source,
          })),
        tokenBudget: input.tokenBudget,
        tokenUsed: input.tokenUsed,
        discardedCount: input.discardedCount,
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    log.warn("Merchant context diagnostic could not be persisted", {
      error: error instanceof Error ? error.name : "UnknownError",
      merchantId: input.merchantId,
      shopId: input.shopId,
      task: input.task,
      queryHash: input.queryHash,
    });
    return null;
  }
}

/** @param {string} task @param {boolean} historicalMode */
function groupOrder(task, historicalMode) {
  if (historicalMode)
    return [
      "workingMemory",
      "episodicMemory",
      "semanticMemory",
      "actionMemory",
      "openQuestions",
      "liveEvidence",
    ];
  if (task === "action_chat")
    return [
      "workingMemory",
      "actionMemory",
      "semanticMemory",
      "episodicMemory",
      "liveEvidence",
      "openQuestions",
    ];
  if (["insights", "goals", "plan", "store_understanding"].includes(task)) {
    return [
      "semanticMemory",
      "liveEvidence",
      "actionMemory",
      "episodicMemory",
      "openQuestions",
      "workingMemory",
    ];
  }
  return [
    "workingMemory",
    "semanticMemory",
    "actionMemory",
    "episodicMemory",
    "openQuestions",
    "liveEvidence",
  ];
}

/** @param {string} task @param {ReturnType<typeof getMerchantMemoryV2Config>} config */
function defaultBudget(task, config) {
  return ["insights", "goals", "plan", "store_understanding"].includes(task)
    ? config.maximumTokenBudget
    : config.defaultChatTokenBudget;
}

/** @param {any} item */
function boundContextItem(item) {
  const content = String(item.content ?? "");
  return {
    ...item,
    content: content.length > 1600 ? `${content.slice(0, 1597)}...` : content,
    data: boundData(item.data),
  };
}

/** @param {any} data */
function boundData(data) {
  if (!data || typeof data !== "object") return data ?? {};
  const json = JSON.stringify(data);
  if (json.length <= 2400) return data;
  return { summary: `${json.slice(0, 2397)}...` };
}

/** @param {any} value */
function estimateTokens(value) {
  return Math.max(
    1,
    Math.ceil(JSON.stringify(value).length / CONTEXT_CHARS_PER_TOKEN),
  );
}

/** @param {string} query */
function actionQuery(query) {
  return /\b(recommendation|action|approved|executed|applied|reverted|what happened)\b/i.test(
    query,
  );
}
