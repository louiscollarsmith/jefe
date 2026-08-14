import assert from "node:assert/strict";
import test from "node:test";

import {
  changeConversationFocus,
  listChatsFocusedOnAction,
  referenceActionInConversation,
  startFocusedActionChat,
} from "../app/lib/merchant-memory/focused-action-chat.server.js";

const MERCHANT = "m1";
const SHOP = "s1";
const NOW = new Date("2026-08-13T10:00:00.000Z");

function buildPrisma({ actions = [], conversations = [] } = {}) {
  const state = {
    actions: actions.map(actionRow),
    conversations: conversations.map((row) => ({
      merchantId: MERCHANT,
      shopId: SHOP,
      surface: "app",
      conversationType: "general",
      topic: "general",
      status: "active",
      context: {},
      createdAt: NOW,
      updatedAt: NOW,
      lastMessageAt: NOW,
      ...row,
    })),
    messages: [],
    episodes: [],
    events: [],
    jobs: [],
    calls: {
      transactions: 0,
      actionReads: 0,
      reconciliationReads: 0,
      conversationUpdates: 0,
    },
    nextConversation: 1,
    nextMessage: 1,
    nextEvent: 1,
  };
  const prisma = {
    state,
    async $transaction(run) {
      state.calls.transactions += 1;
      return run({ ...prisma, $transaction: undefined });
    },
    merchantPlanRecommendation: {
      findMany: async () => {
        state.calls.reconciliationReads += 1;
        return [];
      },
    },
    actionExecution: {
      findMany: async () => {
        state.calls.reconciliationReads += 1;
        return [];
      },
    },
    merchantAction: {
      findFirst: async ({ where }) => {
        state.calls.actionReads += 1;
        return (
        state.actions.find(
          (action) =>
            action.id === where.id &&
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId,
          ) ?? null
        );
      },
      findMany: async ({ where }) =>
        state.actions.filter(
          (action) =>
            action.merchantId === where.merchantId &&
            action.shopId === where.shopId,
        ),
    },
    merchantMemoryConversation: {
      findMany: async ({ where }) =>
        state.conversations
          .filter(
            (conversation) =>
              conversation.merchantId === where.merchantId &&
              conversation.shopId === where.shopId &&
              conversation.surface === where.surface &&
              conversation.status === where.status &&
              conversation.focusedActionId === where.focusedActionId,
          )
          .sort((left, right) => right.lastMessageAt - left.lastMessageAt),
      findFirst: async ({ where }) =>
        state.conversations.find(
          (conversation) =>
            conversation.id === where.id &&
            conversation.merchantId === where.merchantId &&
            conversation.shopId === where.shopId &&
            (!where.surface || conversation.surface === where.surface) &&
            (!where.status || conversation.status === where.status),
        ) ?? null,
      create: async ({ data }) => {
        const conversation = {
          id: `c${state.nextConversation++}`,
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        state.conversations.push(conversation);
        return conversation;
      },
      update: async ({ where, data }) => {
        state.calls.conversationUpdates += 1;
        const conversation = state.conversations.find(
          (row) => row.id === where.id,
        );
        Object.assign(conversation, data, { updatedAt: NOW });
        return conversation;
      },
    },
    merchantMemoryConversationMessage: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const message = {
          id: `msg-${state.nextMessage++}`,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        state.messages.push(message);
        return message;
      },
    },
    merchantMemoryEpisode: {
      upsert: async ({ create }) => {
        const episode = {
          id: `episode-${state.episodes.length + 1}`,
          ...create,
        };
        state.episodes.push(episode);
        return episode;
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        const event = {
          id: `evt-${state.nextEvent++}`,
          createdAt: NOW,
          ...data,
        };
        state.events.push(event);
        return event;
      },
    },
    backfillJob: {
      findUnique: async () => state.jobs[0] ?? null,
      create: async ({ data }) => {
        const job = { id: `job-${state.jobs.length + 1}`, ...data };
        state.jobs.push(job);
        return job;
      },
      update: async ({ data }) => Object.assign(state.jobs[0], data),
    },
  };
  return prisma;
}

function actionRow(overrides = {}) {
  const runId =
    overrides.currentActionRunId ?? overrides.actionRunId ?? "run-1";
  return {
    id: overrides.id ?? "a1",
    merchantId: MERCHANT,
    shopId: SHOP,
    title: overrides.title ?? "Clear slow stock",
    summary: overrides.summary ?? "Markdown slow-moving stock.",
    status: overrides.status ?? "proposed",
    sourceRecommendationId: overrides.sourceRecommendationId ?? "rec-1",
    currentActionRunId: runId,
    progress: {},
    outcome: {},
    createdAt: NOW,
    updatedAt: NOW,
    sourceRecommendation: {
      id: overrides.sourceRecommendationId ?? "rec-1",
      title: overrides.title ?? "Clear slow stock",
      summary: overrides.summary ?? "Markdown slow-moving stock.",
      reviewStatus: "proposed",
      workflows: [],
      successSignal: {},
    },
    currentExecution: {
      runId,
      actionType: "price_markdown",
      actionKind: "dead_stock_clearance",
      status: "proposed",
      resolvedMode: "approve",
      preview: {},
      proposalSummary: {},
    },
    executions: [],
    ...overrides,
  };
}

test("listChatsFocusedOnAction returns every active chat for one action", async () => {
  const prisma = buildPrisma({
    conversations: [
      { id: "c-old", title: "Earlier markdown chat", focusedActionId: "a1" },
      {
        id: "c-new",
        title: "Latest markdown chat",
        focusedActionId: "a1",
        lastMessageAt: new Date("2026-08-13T11:00:00.000Z"),
      },
      { id: "c-other", title: "Other action", focusedActionId: "a2" },
    ],
  });

  const chats = await listChatsFocusedOnAction(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
  });

  assert.deepEqual(
    chats.map((chat) => chat.id),
    ["c-new", "c-old"],
  );
});

test("startFocusedActionChat offers existing chats before creating another one", async () => {
  const prisma = buildPrisma({
    actions: [{ id: "a1" }],
    conversations: [
      { id: "c1", title: "Already talking", focusedActionId: "a1" },
    ],
  });

  const result = await startFocusedActionChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.chooser, true);
  assert.deepEqual(
    result.chats.map((chat) => chat.id),
    ["c1"],
  );
  assert.equal(prisma.state.conversations.length, 1);
});

test("startFocusedActionChat atomically creates one focused chat and one coalesced job", async () => {
  const prisma = buildPrisma({
    actions: [
      { id: "a1" },
      ...Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}` })),
    ],
  });

  const result = await startFocusedActionChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: "a1",
    forceNew: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.chooser, false);
  assert.equal(result.conversationId, "c1");
  assert.equal(prisma.state.conversations.length, 1);
  assert.equal(prisma.state.conversations[0].focusedActionId, "a1");
  assert.deepEqual(
    prisma.state.messages.map((message) => [
      message.role,
      message.metadata?.eventType,
    ]),
    [
      ["system", "focus_set"],
      ["assistant", undefined],
    ],
  );
  assert.equal(prisma.state.messages.length, 2);
  assert.equal(prisma.state.episodes.length, 2);
  assert.equal(prisma.state.events.length, 1);
  assert.equal(prisma.state.events[0].eventType, "focus_set");
  assert.equal(prisma.state.jobs.length, 1);
  assert.equal(prisma.state.calls.transactions, 1);
  assert.equal(prisma.state.calls.conversationUpdates, 1);
  assert.equal(prisma.state.calls.actionReads, 1);
  assert.equal(prisma.state.calls.reconciliationReads, 0);
});

test("changeConversationFocus persists the new focus and writes a system event", async () => {
  const prisma = buildPrisma({
    actions: [
      { id: "a2", title: "Restock hero SKU", sourceRecommendationId: "rec-2" },
    ],
    conversations: [{ id: "c1", focusedActionId: "a1" }],
  });

  const result = await changeConversationFocus(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    actionId: "a2",
  });

  assert.equal(result.ok, true);
  assert.equal(prisma.state.conversations[0].focusedActionId, "a2");
  assert.equal(prisma.state.conversations[0].context.focusedActionId, "a2");
  assert.equal(prisma.state.messages[0].role, "system");
  assert.equal(prisma.state.messages[0].metadata.eventType, "focus_changed");
  assert.equal(prisma.state.events[0].eventType, "focus_changed");
});

test("referenceActionInConversation records a read-only reference without changing focus", async () => {
  const prisma = buildPrisma({
    actions: [
      { id: "a1", title: "Clear slow stock" },
      { id: "a2", title: "Restock hero SKU", sourceRecommendationId: "rec-2" },
    ],
    conversations: [{ id: "c1", focusedActionId: "a1" }],
  });

  const result = await referenceActionInConversation(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    actionId: "a2",
  });

  assert.equal(result.ok, true);
  assert.equal(prisma.state.conversations[0].focusedActionId, "a1");
  assert.equal(prisma.state.messages[0].role, "reference");
  assert.equal(prisma.state.messages[0].metadata.referencedActionId, "a2");
  assert.equal(prisma.state.messages[0].metadata.readOnly, true);
  assert.equal(prisma.state.events[0].eventType, "action_referenced");
  assert.equal(prisma.state.events[0].metadata.readOnly, true);
});
