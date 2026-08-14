// @ts-check

import {
  appendConversationMessage,
  createMerchantConversation,
  conversationTitleFromMessage,
  enqueueCoalescingMemoryJob,
  EPISODE_PROCESS_JOB_TYPE,
} from "./episodic-memory.server.js";
import {
  getMerchantAction,
  getMerchantActionFocus,
  listMerchantActions,
} from "../actions/merchant-action.server.js";

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; take?: number }} input
 */
export async function listChatsFocusedOnAction(prisma, input) {
  if (!input.actionId || !prisma?.merchantMemoryConversation?.findMany)
    return [];
  const rows = await prisma.merchantMemoryConversation.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      surface: "app",
      focusedActionId: input.actionId,
      status: "active",
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    take: input.take ?? 12,
    include: { _count: { select: { messages: true } } },
  });
  return rows.map((/** @type {any} */ row) => ({
    id: row.id,
    title: row.title || "New chat",
    messageCount: row._count?.messages ?? 0,
    lastMessageAt: (row.lastMessageAt ?? row.updatedAt ?? row.createdAt)?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
  }));
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string; forceNew?: boolean }} input
 */
export async function startFocusedActionChat(prisma, input) {
  const action = await getMerchantActionFocus(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    actionId: input.actionId,
  });
  if (!action) return { ok: false, error: "That action could not be found." };
  const existing = input.forceNew
    ? []
    : await listChatsFocusedOnAction(prisma, input);
  if (existing.length) {
    return { ok: true, chooser: true, action, chats: existing };
  }
  const createFocusedConversation = async (/** @type {any} */ tx) => {
    const conversation = await createMerchantConversation(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      conversationType: "general",
      surface: "app",
      topic: "general",
      title: defaultChatTitle(action),
      context: focusedActionContextPatch(action),
      focusedActionId: action.id,
    });
    await recordFocusEvent(tx, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      conversation,
      conversationId: conversation.id,
      action,
      eventType: "focus_set",
      content: `Now working on: ${action.title}`,
      enqueue: false,
      touchConversation: false,
    });
    await appendConversationMessage(tx, {
      conversation,
      conversationId: conversation.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
      role: "assistant",
      content:
        "Ask me anything about this one. I can explain how I got here, change what it does, or hold it until you're ready.",
      surface: "app",
      recommendationId: action.sourceRecommendationId,
      actionRunId: action.actionRunId,
      safeSummary: "Jefe opened a chat focused on an action.",
      enqueue: false,
    });
    if (tx.backfillJob?.findUnique) {
      await enqueueCoalescingMemoryJob(tx, {
        merchantId: input.merchantId,
        shopId: input.shopId,
        jobType: EPISODE_PROCESS_JOB_TYPE,
        priority: 35,
      });
    }
    return conversation;
  };
  const conversation =
    typeof prisma.$transaction === "function"
      ? await prisma.$transaction(createFocusedConversation)
      : await createFocusedConversation(prisma);
  return { ok: true, chooser: false, action, conversationId: conversation.id };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId: string; actionId: string }} input
 */
export async function changeConversationFocus(prisma, input) {
  const [conversation, action] = await Promise.all([
    loadConversation(prisma, input),
    getMerchantAction(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    }),
  ]);
  if (!conversation) return { ok: false, error: "That chat could not be found." };
  if (!action) return { ok: false, error: "That action could not be found." };
  await prisma.merchantMemoryConversation.update({
    where: { id: conversation.id },
    data: {
      focusedActionId: action.id,
      conversationType: "general",
      context: { ...(conversation.context ?? {}), ...focusedActionContextPatch(action) },
    },
  });
  await recordFocusEvent(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    conversationId: conversation.id,
    action,
    eventType: conversation.focusedActionId ? "focus_changed" : "focus_set",
    content: `Now working on: ${action.title}`,
    metadata: {
      previousFocusedActionId: conversation.focusedActionId ?? null,
    },
  });
  return { ok: true, conversationId: conversation.id, action };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId: string; actionId: string }} input
 */
export async function referenceActionInConversation(prisma, input) {
  const [conversation, action] = await Promise.all([
    loadConversation(prisma, input),
    getMerchantAction(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionId: input.actionId,
    }),
  ]);
  if (!conversation) return { ok: false, error: "That chat could not be found." };
  if (!action) return { ok: false, error: "That action could not be found." };
  const result = await appendConversationMessage(prisma, {
    conversation,
    conversationId: conversation.id,
    merchantId: input.merchantId,
    shopId: input.shopId,
    role: "reference",
    content: action.title,
    surface: "app",
    recommendationId: action.sourceRecommendationId,
    actionRunId: action.actionRunId,
    metadata: {
      eventType: "action_referenced",
      referencedActionId: action.id,
      readOnly: true,
    },
    safeSummary: `Referenced action: ${action.title}`,
  });
  await prisma.merchantActionEvent.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: action.id,
      conversationId: conversation.id,
      messageId: result.message.id,
      eventType: "action_referenced",
      metadata: {
        focusedActionId: conversation.focusedActionId ?? null,
        readOnly: true,
      },
    },
  });
  return { ok: true, conversationId: conversation.id, action };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId: string }} input
 */
async function loadConversation(prisma, input) {
  if (!input.conversationId) return null;
  return prisma.merchantMemoryConversation.findFirst({
    where: {
      id: input.conversationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      surface: "app",
      status: "active",
    },
  });
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; conversationId: string; conversation?: any; action: any; eventType: string; content: string; metadata?: any; enqueue?: boolean; touchConversation?: boolean }} input
 */
async function recordFocusEvent(prisma, input) {
  const result = await appendConversationMessage(prisma, {
    conversation: input.conversation,
    conversationId: input.conversationId,
    merchantId: input.merchantId,
    shopId: input.shopId,
    role: "system",
    content: input.content,
    surface: "app",
    recommendationId: input.action.sourceRecommendationId,
    actionRunId: input.action.actionRunId,
    metadata: {
      eventType: input.eventType,
      focusedActionId: input.action.id,
      ...(input.metadata ?? {}),
    },
    safeSummary: input.content,
    enqueue: input.enqueue,
    touchConversation: input.touchConversation,
  });
  await prisma.merchantActionEvent.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      merchantActionId: input.action.id,
      conversationId: input.conversationId,
      messageId: result.message.id,
      eventType: input.eventType,
      metadata: input.metadata ?? {},
    },
  });
  return result;
}

/**
 * @param {any} action
 */
function defaultChatTitle(action) {
  const title = action?.sourceRecommendation?.title || action?.title || "";
  if (/restock|stock|cover|reorder/i.test(title)) return "Talking through restocking";
  if (/markdown|clearance|slow/i.test(title)) return "Talking through the markdown";
  if (/bundle/i.test(title)) return "Talking through the bundle";
  return conversationTitleFromMessage(`Talking through ${title}`) ?? "New chat";
}

/**
 * @param {any} action
 */
function focusedActionContextPatch(action) {
  return {
    focusedActionId: action.id,
    actionRunId: action.actionRunId ?? null,
    currentActionRunId: action.actionRunId ?? null,
    recommendationId: action.sourceRecommendationId ?? null,
  };
}

export { listMerchantActions };
