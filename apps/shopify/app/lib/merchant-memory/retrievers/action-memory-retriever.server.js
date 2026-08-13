// @ts-check

/** @param {any} prisma @param {{ merchantId: string; shopId: string; focusedActionId?: string | null; recommendationId?: string | null; actionRunId?: string | null; take?: number }} input */
export async function retrieveActionMemory(prisma, input) {
  const take = input.take ?? 8;
  const focusedActionId = uuid(input.focusedActionId);
  const exactRunId = uuid(input.actionRunId);
  const recommendationId = uuid(input.recommendationId);
  const [
    focusedAction,
    recentExecutions,
    recentRecommendations,
    linkedMessages,
    exactExecution,
    exactRecommendation,
  ] = await Promise.all([
    focusedActionId && prisma.merchantAction?.findFirst
      ? prisma.merchantAction.findFirst({
          where: {
            id: focusedActionId,
            merchantId: input.merchantId,
            shopId: input.shopId,
          },
        })
      : null,
    prisma.actionExecution?.findMany
      ? prisma.actionExecution.findMany({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
          },
          include: { writes: { orderBy: { appliedAt: "desc" }, take: 20 } },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: take * 2,
        })
      : [],
    prisma.merchantPlanRecommendation?.findMany
      ? prisma.merchantPlanRecommendation.findMany({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: take * 2,
        })
      : [],
    prisma.merchantMemoryConversationMessage?.findMany
      ? prisma.merchantMemoryConversationMessage.findMany({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            OR: [
              { actionRunId: { not: null } },
              { recommendationId: { not: null } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take: 40,
          select: {
            id: true,
            conversationId: true,
            actionRunId: true,
            recommendationId: true,
          },
        })
      : [],
    exactRunId && prisma.actionExecution?.findFirst
      ? prisma.actionExecution.findFirst({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            runId: exactRunId,
          },
          include: { writes: { orderBy: { appliedAt: "desc" }, take: 20 } },
        })
      : null,
    recommendationId && prisma.merchantPlanRecommendation?.findFirst
      ? prisma.merchantPlanRecommendation.findFirst({
          where: {
            merchantId: input.merchantId,
            shopId: input.shopId,
            id: recommendationId,
          },
        })
      : null,
  ]);
  const executions = dedupeRows(
    [exactExecution, ...recentExecutions].filter(Boolean),
  );
  const recommendations = dedupeRows(
    [exactRecommendation, ...recentRecommendations].filter(Boolean),
  );
  /** @type {any[]} */
  const items = [];
  if (focusedAction) {
    items.push({
      id: `merchant_action:${focusedAction.id}`,
      memoryType: "action",
      content: `${focusedAction.title}: ${focusedAction.summary}`,
      data: {
        actionId: focusedAction.id,
        title: focusedAction.title,
        summary: focusedAction.summary,
        status: focusedAction.status,
        sourceRecommendationId: focusedAction.sourceRecommendationId,
        actionRunId: focusedAction.currentActionRunId,
        role: "focused_mutation_target",
      },
      authority: "merchant_action",
      confidence: null,
      temporalStatus: "current",
      occurredAt: (focusedAction.updatedAt ?? focusedAction.createdAt ?? new Date(0)).toISOString(),
      scope: { shopId: input.shopId },
      source: {
        type: "merchant_action",
        actionId: focusedAction.id,
      },
      score: { exact: 2, recency: 1 },
    });
  }
  for (const row of executions) {
    items.push({
      id: `action:${row.runId}`,
      memoryType: "action",
      content: actionContent(row),
      data: {
        runId: row.runId,
        actionType: row.actionType,
        actionKind: row.actionKind,
        status: row.status,
        resolvedMode: row.resolvedMode,
        preview: compact(row.preview),
        outcomeStatus: row.outcomeStatus,
        outcome: compact(row.outcome),
        writes: row.writes.map((/** @type {any} */ write) => ({
          targetRef: write.targetRef,
          status: write.status,
          appliedAt: write.appliedAt?.toISOString() ?? null,
        })),
      },
      authority: "action_ledger",
      confidence: row.confidence,
      temporalStatus: "current",
      occurredAt: (row.updatedAt ?? row.createdAt ?? new Date(0)).toISOString(),
      scope: { shopId: input.shopId },
      source: {
        type: "action_execution",
        runId: row.runId,
        executionId: row.id,
        messageIds: linkedMessages
          .filter(
            (/** @type {any} */ message) => message.actionRunId === row.runId,
          )
          .map((/** @type {any} */ message) => message.id),
        conversationIds: [
          ...new Set(
            linkedMessages
              .filter(
                (/** @type {any} */ message) =>
                  message.actionRunId === row.runId,
              )
              .map((/** @type {any} */ message) => message.conversationId),
          ),
        ],
      },
      score: {
        exact: exactRunId && row.runId === exactRunId ? 1 : 0,
        recency: 1,
      },
    });
  }
  for (const row of recommendations) {
    items.push({
      id: `recommendation:${row.id}`,
      memoryType: "action",
      content: `${row.title}: ${row.summary}`,
      data: {
        recommendationId: row.id,
        title: row.title,
        summary: row.summary,
        status: row.reviewStatus,
        expectedBenefit: row.expectedBenefit,
      },
      authority: "plan_recommendation",
      confidence: confidenceNumber(row.confidence),
      temporalStatus: "current",
      occurredAt: (row.updatedAt ?? row.createdAt ?? new Date(0)).toISOString(),
      scope: { shopId: input.shopId },
      source: {
        type: "merchant_plan_recommendation",
        recommendationId: row.id,
        messageIds: linkedMessages
          .filter(
            (/** @type {any} */ message) => message.recommendationId === row.id,
          )
          .map((/** @type {any} */ message) => message.id),
        conversationIds: [
          ...new Set(
            linkedMessages
              .filter(
                (/** @type {any} */ message) =>
                  message.recommendationId === row.id,
              )
              .map((/** @type {any} */ message) => message.conversationId),
          ),
        ],
      },
      score: { exact: recommendationId === row.id ? 1 : 0, recency: 1 },
    });
  }
  return items
    .sort(
      (left, right) =>
        Number(right.score.exact) - Number(left.score.exact) ||
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
    )
    .slice(0, take);
}

/** @param {any[]} rows */
function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/** @param {any} row */
function actionContent(row) {
  const outcome =
    row.outcomeStatus === "measured"
      ? ` Outcome: ${JSON.stringify(compact(row.outcome))}.`
      : "";
  return `${row.actionType} is ${row.status}.${outcome}`;
}

/** @param {any} value */
function compact(value) {
  if (!value || typeof value !== "object") return value ?? null;
  /** @type {Record<string, any>} */
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    if (/customer|email|phone|address|payload|token|secret/i.test(key))
      continue;
    output[key] = Array.isArray(item) ? item.slice(0, 5) : item;
  }
  return output;
}

/** @param {unknown} value */
function uuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)
    ? value
    : null;
}

/** @param {unknown} value */
function confidenceNumber(value) {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.7;
  if (value === "low") return 0.5;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
