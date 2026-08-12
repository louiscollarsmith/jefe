// @ts-check

import { sanitizeMemoryText } from "../episodic-memory.server.js";

/** @param {any} prisma @param {{ merchantId: string; shopId: string; conversationId?: string | null; take?: number }} input */
export async function retrieveWorkingMemory(prisma, input) {
  if (
    !input.conversationId ||
    !prisma.merchantMemoryConversation?.findFirst ||
    !prisma.merchantMemoryConversationMessage?.findMany
  )
    return [];
  const conversation = await prisma.merchantMemoryConversation.findFirst({
    where: {
      id: input.conversationId,
      merchantId: input.merchantId,
      shopId: input.shopId,
    },
    select: { id: true },
  });
  if (!conversation) return [];
  const rows = await prisma.merchantMemoryConversationMessage.findMany({
    where: {
      conversationId: conversation.id,
      merchantId: input.merchantId,
      shopId: input.shopId,
      visibility: "current",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take ?? 12,
  });
  return rows.reverse().map((/** @type {any} */ row) => ({
    id: `message:${row.id}`,
    memoryType: "working",
    content: sanitizeMemoryText(row.content),
    role: row.role,
    authority: row.role === "merchant" ? "merchant_statement" : "jefe_response",
    confidence: row.role === "merchant" ? 1 : null,
    temporalStatus: "current",
    occurredAt: row.createdAt.toISOString(),
    scope: { shopId: input.shopId },
    source: {
      type: "conversation_message",
      conversationId: row.conversationId,
      messageIds: [row.id],
    },
    score: { working: 1 },
  }));
}
