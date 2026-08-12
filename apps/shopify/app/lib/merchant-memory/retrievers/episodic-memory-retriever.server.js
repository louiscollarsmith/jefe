// @ts-check

import { Prisma } from "@prisma/client";
import { embedMerchantMemoryText } from "../embedding.server.js";
import {
  extractEntityRefs,
  sanitizeMemoryText,
  vectorLiteral,
} from "../episodic-memory.server.js";

const RRF_K = 60;

/** @param {string} query */
export function classifyHistoricalRecall(query) {
  return /\b(did(?:n['’]t| not)? we (?:talk|discuss)|what did (?:i|we) (?:say|tell|decide)|previously|before|at the time|used to|earlier conversation|conversation history)\b/i.test(
    query,
  );
}

/** @param {string} query */
export function containsUnresolvedDeicticReference(query) {
  return (
    /\b(this|that|it|those|these|the one|that recommendation)\b/i.test(query) &&
    query.trim().split(/\s+/).length < 18
  );
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; query?: string | null; take?: number; historicalMode?: boolean; recommendationId?: string | null; actionRunId?: string | null; embeddingProvider?: typeof embedMerchantMemoryText }} input
 */
export async function retrieveEpisodicMemory(prisma, input) {
  if (!prisma.merchantMemoryEpisode?.findMany) return [];
  const query = sanitizeMemoryText(input.query ?? "");
  const historicalMode =
    input.historicalMode ?? classifyHistoricalRecall(query);
  const take = input.take ?? 8;
  const deictic = containsUnresolvedDeicticReference(query);
  const initialRefs = new Set(
    [
      ...extractEntityRefs(query),
      input.recommendationId,
      input.actionRunId,
    ].filter(Boolean),
  );
  const [initialExactRows, lexicalRows, recentRows, vectorRows] =
    await Promise.all([
      exactReferenceSearch(prisma, {
        ...input,
        refs: [...initialRefs],
        historicalMode,
        take: 24,
      }),
      query
        ? lexicalSearch(prisma, { ...input, query, historicalMode, take: 24 })
        : [],
      recentSearch(prisma, {
        ...input,
        historicalMode,
        take: deictic ? 18 : 10,
      }),
      query
        ? vectorSearch(prisma, { ...input, query, historicalMode, take: 24 })
        : [],
    ]);
  const exactRefs = new Set(initialRefs);
  let exactRows = initialExactRows;
  if (deictic && exactRefs.size === 0) {
    for (const row of recentRows.slice(0, 6)) {
      for (const ref of refsForRow(row)) exactRefs.add(ref);
    }
    exactRows = await exactReferenceSearch(prisma, {
      ...input,
      refs: [...exactRefs],
      historicalMode,
      take: 24,
    });
  }
  const scores = new Map();
  const rowsById = new Map();
  addRanked(scores, rowsById, exactRows, "exact", 3);
  addRanked(scores, rowsById, lexicalRows, "lexical", 1.5);
  addRanked(scores, rowsById, vectorRows, "vector", 1);
  addRanked(scores, rowsById, recentRows, "recency", deictic ? 1.25 : 0.75);
  for (const row of [...rowsById.values()]) {
    const refs = refsForRow(row);
    if (refs.some((ref) => exactRefs.has(ref))) {
      const current = scores.get(row.id) ?? { total: 0, components: {} };
      current.total += 3 / (RRF_K + 1);
      current.components.exact = 3 / (RRF_K + 1);
      scores.set(row.id, current);
    }
  }
  const selected = [...rowsById.values()]
    .sort(
      (left, right) =>
        (scores.get(right.id)?.total ?? 0) -
          (scores.get(left.id)?.total ?? 0) ||
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
    )
    .filter(dedupeBySourceMessage())
    .slice(0, take);
  const adjacency = await retrieveAdjacentMessages(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    rows: selected,
  });
  return selected.map((row) => ({
    id: `episode:${row.id}`,
    memoryType: "episodic",
    content: row.searchText,
    data: {
      ...(row.structuredSummary ?? {}),
      adjacentMessages: adjacency.get(row.id) ?? [],
    },
    role: row.role,
    authority:
      row.role === "merchant"
        ? "merchant_statement"
        : row.documentType === "summary"
          ? "derived_summary"
          : "jefe_response",
    confidence: row.role === "merchant" ? 1 : null,
    temporalStatus:
      row.visibility === "historical_only" ? "historical" : "current",
    occurredAt: new Date(row.occurredAt).toISOString(),
    scope: { shopId: row.shopId },
    source: {
      type: "conversation_episode",
      episodeId: row.id,
      conversationId: row.conversationId,
      messageIds: row.sourceMessageIds ?? [],
    },
    score: scores.get(row.id)?.components ?? {},
  }));
}

/** @param {any} prisma @param {any} input */
async function exactReferenceSearch(prisma, input) {
  const refs = input.refs
    .filter(
      (/** @type {any} */ ref) => typeof ref === "string" && ref.length > 0,
    )
    .slice(0, 20);
  if (refs.length === 0 || typeof prisma.$queryRaw !== "function") return [];
  const visibility = input.historicalMode
    ? Prisma.sql`episode."visibility" IN ('current', 'historical_only')`
    : Prisma.sql`episode."visibility" = 'current'`;
  const predicates = refs.map(
    (/** @type {string} */ ref) => Prisma.sql`
    episode."recommendation_id"::text = ${ref}
    OR episode."action_run_id"::text = ${ref}
    OR episode."entity_refs_json" @> ${JSON.stringify([ref])}::jsonb
  `,
  );
  return prisma.$queryRaw(Prisma.sql`
    SELECT episode."id", episode."shop_id" AS "shopId", episode."conversation_id" AS "conversationId",
           episode."document_type" AS "documentType", episode."role", episode."source_message_ids" AS "sourceMessageIds",
           episode."search_text" AS "searchText", episode."structured_summary_json" AS "structuredSummary",
           episode."entity_refs_json" AS "entityRefs", episode."recommendation_id" AS "recommendationId",
           episode."action_run_id" AS "actionRunId", episode."occurred_at" AS "occurredAt", episode."visibility"
    FROM "merchant_memory_episodes" AS episode
    WHERE episode."merchant_id" = ${input.merchantId}::uuid
      AND (episode."shop_id" = ${input.shopId}::uuid OR episode."shop_id" IS NULL)
      AND ${visibility}
      AND (${Prisma.join(predicates, " OR ")})
    ORDER BY episode."occurred_at" DESC
    LIMIT ${input.take}
  `);
}

/** @param {any} prisma @param {{ merchantId: string; shopId: string; rows: any[] }} input */
async function retrieveAdjacentMessages(prisma, input) {
  const result = new Map();
  if (!prisma.merchantMemoryConversationMessage?.findFirst) return result;
  await Promise.all(
    input.rows.map(async (row) => {
      const sourceId = row.sourceMessageIds?.[0];
      if (!sourceId) return;
      const source = await prisma.merchantMemoryConversationMessage.findFirst({
        where: {
          id: sourceId,
          conversationId: row.conversationId,
          merchantId: input.merchantId,
          shopId: input.shopId,
        },
        select: { id: true, createdAt: true },
      });
      if (!source) return;
      const [before, after] = await Promise.all([
        prisma.merchantMemoryConversationMessage.findFirst({
          where: {
            conversationId: row.conversationId,
            merchantId: input.merchantId,
            shopId: input.shopId,
            visibility: "current",
            OR: [
              { createdAt: { lt: source.createdAt } },
              { createdAt: source.createdAt, id: { lt: source.id } },
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        prisma.merchantMemoryConversationMessage.findFirst({
          where: {
            conversationId: row.conversationId,
            merchantId: input.merchantId,
            shopId: input.shopId,
            visibility: "current",
            OR: [
              { createdAt: { gt: source.createdAt } },
              { createdAt: source.createdAt, id: { gt: source.id } },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
      ]);
      result.set(
        row.id,
        [before, after].filter(Boolean).map((message) => ({
          id: message.id,
          role: message.role,
          content: sanitizeMemoryText(message.content),
          occurredAt: message.createdAt.toISOString(),
        })),
      );
    }),
  );
  return result;
}

/** @param {any} prisma @param {any} input */
async function lexicalSearch(prisma, input) {
  if (typeof prisma.$queryRaw !== "function")
    return fallbackLexicalSearch(prisma, input);
  const visibility = input.historicalMode
    ? Prisma.sql`episode."visibility" IN ('current', 'historical_only')`
    : Prisma.sql`episode."visibility" = 'current'`;
  return prisma.$queryRaw(Prisma.sql`
    SELECT episode."id", episode."shop_id" AS "shopId", episode."conversation_id" AS "conversationId",
           episode."document_type" AS "documentType", episode."role", episode."source_message_ids" AS "sourceMessageIds",
           episode."search_text" AS "searchText", episode."structured_summary_json" AS "structuredSummary",
           episode."entity_refs_json" AS "entityRefs", episode."recommendation_id" AS "recommendationId",
           episode."action_run_id" AS "actionRunId", episode."occurred_at" AS "occurredAt", episode."visibility",
           ts_rank_cd(episode."search_vector", websearch_to_tsquery('simple', ${input.query}))::float AS "lexicalScore"
    FROM "merchant_memory_episodes" AS episode
    WHERE episode."merchant_id" = ${input.merchantId}::uuid
      AND (episode."shop_id" = ${input.shopId}::uuid OR episode."shop_id" IS NULL)
      AND ${visibility}
      AND episode."search_vector" @@ websearch_to_tsquery('simple', ${input.query})
    ORDER BY "lexicalScore" DESC, episode."occurred_at" DESC
    LIMIT ${input.take}
  `);
}

/** @param {any} prisma @param {any} input */
async function vectorSearch(prisma, input) {
  if (typeof prisma.$queryRaw !== "function") return [];
  const embedded = await (input.embeddingProvider ?? embedMerchantMemoryText)(
    input.query,
    {
      taskType: "RETRIEVAL_QUERY",
      prisma,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
  );
  if (!embedded?.values) return [];
  const vector = vectorLiteral(embedded.values);
  const visibility = input.historicalMode
    ? Prisma.sql`episode."visibility" IN ('current', 'historical_only')`
    : Prisma.sql`episode."visibility" = 'current'`;
  return prisma.$queryRaw(Prisma.sql`
    SELECT episode."id", episode."shop_id" AS "shopId", episode."conversation_id" AS "conversationId",
           episode."document_type" AS "documentType", episode."role", episode."source_message_ids" AS "sourceMessageIds",
           episode."search_text" AS "searchText", episode."structured_summary_json" AS "structuredSummary",
           episode."entity_refs_json" AS "entityRefs", episode."recommendation_id" AS "recommendationId",
           episode."action_run_id" AS "actionRunId", episode."occurred_at" AS "occurredAt", episode."visibility",
           (1 - (episode."embedding" <=> ${vector}::vector))::float AS "vectorScore"
    FROM "merchant_memory_episodes" AS episode
    WHERE episode."merchant_id" = ${input.merchantId}::uuid
      AND (episode."shop_id" = ${input.shopId}::uuid OR episode."shop_id" IS NULL)
      AND ${visibility}
      AND episode."embedding" IS NOT NULL
    ORDER BY episode."embedding" <=> ${vector}::vector
    LIMIT ${input.take}
  `);
}

/** @param {any} prisma @param {any} input */
async function recentSearch(prisma, input) {
  const rows = await prisma.merchantMemoryEpisode.findMany({
    where: {
      merchantId: input.merchantId,
      OR: [{ shopId: input.shopId }, { shopId: null }],
      visibility: input.historicalMode
        ? { in: ["current", "historical_only"] }
        : "current",
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: input.take,
  });
  return rows;
}

/** @param {any} prisma @param {any} input */
async function fallbackLexicalSearch(prisma, input) {
  const rows = await recentSearch(prisma, { ...input, take: 100 });
  const terms = input.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((/** @type {string} */ term) => term.length > 2);
  return rows
    .map((/** @type {any} */ row) => ({
      ...row,
      lexicalScore: terms.filter((/** @type {string} */ term) =>
        row.searchText.toLowerCase().includes(term),
      ).length,
    }))
    .filter((/** @type {any} */ row) => row.lexicalScore > 0)
    .sort(
      (/** @type {any} */ left, /** @type {any} */ right) =>
        right.lexicalScore - left.lexicalScore,
    )
    .slice(0, input.take);
}

/** @param {Map<string, any>} scores @param {Map<string, any>} rowsById @param {any[]} rows @param {string} component @param {number} weight */
function addRanked(scores, rowsById, rows, component, weight) {
  rows.forEach((row, index) => {
    rowsById.set(row.id, row);
    const score = weight / (RRF_K + index + 1);
    const current = scores.get(row.id) ?? { total: 0, components: {} };
    current.total += score;
    current.components[component] = score;
    scores.set(row.id, current);
  });
}

/** @param {any} row */
function refsForRow(row) {
  const refs = Array.isArray(row.entityRefs) ? row.entityRefs : [];
  return [...refs, row.recommendationId, row.actionRunId].filter(Boolean);
}

function dedupeBySourceMessage() {
  const seen = new Set();
  return (/** @type {any} */ row) => {
    const key = row.sourceMessageIds?.[0] ?? row.sourceHash ?? row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
