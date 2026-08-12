import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_TITLE_MAX_LENGTH,
  renameGeneralChat,
} from "../app/lib/merchant-memory/general-chat.server.js";

// A chat is named from the merchant's first message, which is a guess — "hey jefe how're
// you" is not what that thread was about. `renameGeneralChat` lets them fix it.
//
// The properties that matter are the ones a merchant would notice going wrong:
//   - a rename STICKS (the auto-title must never overwrite it later),
//   - clearing the box is an UNDO, not a way to end up with a chat called "",
//   - a conversation belonging to another merchant/shop is invisible, not renameable.

const MERCHANT = "m1";
const SHOP = "s1";

function buildPrisma(rows) {
  const conversations = rows.map((row) => ({
    surface: "app",
    conversationType: "general",
    topic: "general",
    title: null,
    ...row,
  }));
  return {
    conversations,
    merchantMemoryConversation: {
      async findFirst({ where, select }) {
        const match = conversations.find((conversation) => {
          if (conversation.id !== where.id) return false;
          if (conversation.merchantId !== where.merchantId) return false;
          if (conversation.shopId !== where.shopId) return false;
          if (where.surface && conversation.surface !== where.surface) return false;
          if (where.OR) {
            const allowed = where.OR.some((clause) =>
              Object.entries(clause).every(
                ([key, value]) => conversation[key] === value,
              ),
            );
            if (!allowed) return false;
          }
          return true;
        });
        if (!match) return null;
        return select ? { id: match.id } : match;
      },
      async update({ where, data }) {
        const match = conversations.find(
          (conversation) => conversation.id === where.id,
        );
        Object.assign(match, data);
        return match;
      },
    },
  };
}

test("a merchant-typed name replaces the auto-title", async () => {
  const prisma = buildPrisma([
    { id: "c1", merchantId: MERCHANT, shopId: SHOP, title: "hey jefe how're you" },
  ]);
  const result = await renameGeneralChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    title: "Christmas stock plan",
  });
  assert.deepEqual(result, { ok: true, title: "Christmas stock plan" });
  assert.equal(prisma.conversations[0].title, "Christmas stock plan");
});

test("an empty name clears back to null, so the auto-title applies again", async () => {
  const prisma = buildPrisma([
    { id: "c1", merchantId: MERCHANT, shopId: SHOP, title: "Christmas stock plan" },
  ]);
  for (const blank of ["", "   ", "\n\t "]) {
    const result = await renameGeneralChat(prisma, {
      merchantId: MERCHANT,
      shopId: SHOP,
      conversationId: "c1",
      title: blank,
    });
    assert.deepEqual(result, { ok: true, title: null }, `blank input: ${JSON.stringify(blank)}`);
    // null, NOT "" — an empty string is a stored name that renders as a nameless chat.
    assert.equal(prisma.conversations[0].title, null);
  }
});

test("a multi-line paste collapses to one line", async () => {
  const prisma = buildPrisma([{ id: "c1", merchantId: MERCHANT, shopId: SHOP }]);
  const result = await renameGeneralChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    title: "  Q4   planning\nand   reorders  ",
  });
  assert.equal(result.ok, true);
  assert.equal(prisma.conversations[0].title, "Q4 planning and reorders");
});

test("an over-long name is clamped, never stored at full length", async () => {
  const prisma = buildPrisma([{ id: "c1", merchantId: MERCHANT, shopId: SHOP }]);
  const result = await renameGeneralChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    title: "x".repeat(CHAT_TITLE_MAX_LENGTH + 40),
  });
  assert.equal(result.ok, true);
  assert.equal(result.title.length, CHAT_TITLE_MAX_LENGTH);
  assert.ok(result.title.endsWith("…"));
});

test("another merchant's chat is not renameable", async () => {
  const prisma = buildPrisma([
    { id: "c1", merchantId: "someone-else", shopId: SHOP, title: "Their chat" },
  ]);
  const result = await renameGeneralChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    title: "Mine now",
  });
  assert.equal(result.ok, false);
  assert.equal(prisma.conversations[0].title, "Their chat");
});

test("the same merchant's chat on a different shop is not renameable", async () => {
  const prisma = buildPrisma([
    { id: "c1", merchantId: MERCHANT, shopId: "other-shop", title: "Other store" },
  ]);
  const result = await renameGeneralChat(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    conversationId: "c1",
    title: "Mine now",
  });
  assert.equal(result.ok, false);
  assert.equal(prisma.conversations[0].title, "Other store");
});

test("a missing conversation id is rejected before any query", async () => {
  const prisma = buildPrisma([{ id: "c1", merchantId: MERCHANT, shopId: SHOP }]);
  for (const id of ["", "   "]) {
    const result = await renameGeneralChat(prisma, {
      merchantId: MERCHANT,
      shopId: SHOP,
      conversationId: id,
      title: "Anything",
    });
    assert.equal(result.ok, false);
  }
});
