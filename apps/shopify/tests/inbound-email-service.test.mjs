import assert from "node:assert/strict";
import test from "node:test";

import { processInboundEmail } from "../app/lib/email/inbound/service.server.js";
import { emailHashOf } from "../app/lib/email/inbound/identity.server.js";

// signUnsubscribeToken (used when rendering an AI reply) reads process.env directly.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";

const ENV = {
  ENABLE_INBOUND_EMAIL: "true",
  INBOUND_AI_ADDRESS: "jefe@reply.mynamejefe.com",
  INBOUND_AI_FROM: "Jefe <jefe@mynamejefe.com>",
  INBOUND_TEAM_ADDRESS: "team@mynamejefe.com",
  RESEND_REPLY_TO: "matt@mynamejefe.com",
  EMAIL_APP_URL: "https://app.mynamejefe.com",
};

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** In-memory Prisma double covering the methods the service + resolver touch. */
function makeFakePrisma({ identities = [], sessions = [], shops = [], events = [], assistantReply = "" } = {}) {
  const eventRows = events.map((e) => ({ ...e }));
  const idRows = identities.map((r) => ({ ...r }));
  let seq = 1;
  return {
    _events: eventRows,
    inboundEmailEvent: {
      async findUnique({ where }) {
        const row = eventRows.find((e) => e.providerMessageId === where.providerMessageId);
        return row ? { id: row.id } : null;
      },
      async create({ data }) {
        const row = { id: `evt_${seq++}`, ...data };
        eventRows.push(row);
        return { id: row.id };
      },
      async update({ where, data }) {
        const row = eventRows.find((e) => e.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? null;
      },
    },
    emailIdentity: {
      async findUnique({ where }) {
        const row = idRows.find((i) => i.emailHash === where.emailHash);
        return row
          ? { merchantId: row.merchantId, shopId: row.shopId, shop: { shopDomain: row.shopDomain ?? null } }
          : null;
      },
      async upsert({ where, update, create }) {
        const row = idRows.find((i) => i.emailHash === where.emailHash);
        if (row) Object.assign(row, update);
        else idRows.push({ ...create });
        return {};
      },
    },
    session: {
      async findMany() {
        return sessions.map((s) => ({ ...s }));
      },
    },
    shop: {
      async findUnique({ where }) {
        const shop = shops.find((s) => s.shopDomain === where.platform_shopDomain.shopDomain);
        return shop ? { ...shop } : null;
      },
    },
    merchantMemoryConversationMessage: {
      async findFirst() {
        return assistantReply ? { content: assistantReply } : null;
      },
    },
  };
}

function spyEmail(result = { delivered: true, disabled: false, id: "re_out_1" }) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return { ...result, to: input.to, subject: input.subject };
  };
  return { fn, calls };
}

function spyConversation() {
  const calls = [];
  const fn = async (_prisma, input) => {
    calls.push(input);
    return { ok: true };
  };
  return { fn, calls };
}

function aiPayload(overrides = {}) {
  return {
    data: {
      from: "owner@shop.com",
      to: "jefe@reply.mynamejefe.com",
      subject: "How much dead stock?",
      text: "How much dead stock do I have right now?",
      spf: "pass",
      email_id: "in_1",
      ...overrides,
    },
  };
}

function knownSenderPrisma(extra = {}) {
  return makeFakePrisma({
    identities: [
      { emailHash: emailHashOf("owner@shop.com"), merchantId: "m1", shopId: "s1", shopDomain: "shop.myshopify.com" },
    ],
    assistantReply: "You have 12 units of dead stock across 3 SKUs.",
    ...extra,
  });
}

test("Door A (enabled, authenticated, known sender): runs the brain and replies", async () => {
  const prisma = knownSenderPrisma();
  const email = spyEmail();
  const brain = spyConversation();

  const res = await processInboundEmail(prisma, { payload: aiPayload() }, {
    env: ENV,
    logger: SILENT,
    sendEmailFn: email.fn,
    sendConversationFn: brain.fn,
  });

  assert.equal(res.outcome, "replied");
  assert.equal(res.door, "ai");

  // The brain saw the merchant's message, scoped to the resolved shop.
  assert.equal(brain.calls.length, 1);
  assert.equal(brain.calls[0].merchantId, "m1");
  assert.equal(brain.calls[0].shopId, "s1");
  assert.match(brain.calls[0].message, /dead stock/);

  // Exactly one reply, from Jefe, threaded back to Door A, self-identified as the AI.
  assert.equal(email.calls.length, 1);
  const sent = email.calls[0];
  assert.equal(sent.to, "owner@shop.com");
  assert.equal(sent.from, "Jefe <jefe@mynamejefe.com>");
  assert.equal(sent.replyTo, "jefe@reply.mynamejefe.com");
  assert.match(sent.text, /This is Jefe, your AI eCommerce manager/);
  assert.match(sent.text, /— Jefe/);
  assert.match(sent.html, /team@mynamejefe\.com/);
  assert.ok(sent.headers["List-Unsubscribe"], "one-click unsubscribe header set");

  assert.equal(prisma._events.at(-1).status, "replied");
});

test("dark flag: verified inbound is recorded + parked, nothing sent or interpreted", async () => {
  const prisma = knownSenderPrisma();
  const email = spyEmail();
  const brain = spyConversation();

  const res = await processInboundEmail(prisma, { payload: aiPayload() }, {
    env: { ...ENV, ENABLE_INBOUND_EMAIL: "false" },
    logger: SILENT,
    sendEmailFn: email.fn,
    sendConversationFn: brain.fn,
  });

  assert.equal(res.outcome, "parked");
  assert.equal(res.reason, "inbound_disabled");
  assert.equal(email.calls.length, 0);
  assert.equal(brain.calls.length, 0);
  assert.equal(prisma._events.at(-1).status, "parked");
  assert.equal(prisma._events.at(-1).safeReason, "inbound_disabled");
});

test("failed sender auth is parked, never actioned", async () => {
  const prisma = knownSenderPrisma();
  const email = spyEmail();
  const brain = spyConversation();

  const res = await processInboundEmail(prisma, { payload: aiPayload({ spf: "fail", dkim: "fail", dmarc: "fail" }) }, {
    env: ENV,
    logger: SILENT,
    sendEmailFn: email.fn,
    sendConversationFn: brain.fn,
  });

  assert.equal(res.outcome, "parked");
  assert.equal(res.reason, "auth_fail");
  assert.equal(email.calls.length, 0);
  assert.equal(brain.calls.length, 0);
});

test("a duplicate delivery (same message id) is ignored — no second reply", async () => {
  const prisma = knownSenderPrisma({
    events: [{ id: "evt_pre", providerMessageId: "in_1", status: "replied" }],
  });
  const email = spyEmail();
  const brain = spyConversation();

  const res = await processInboundEmail(prisma, { payload: aiPayload() }, {
    env: ENV,
    logger: SILENT,
    sendEmailFn: email.fn,
    sendConversationFn: brain.fn,
  });

  assert.equal(res.outcome, "duplicate");
  assert.equal(email.calls.length, 0);
  assert.equal(brain.calls.length, 0);
});

test("Door A from an unknown sender is parked — Jefe never replies to strangers", async () => {
  const prisma = makeFakePrisma({ assistantReply: "should not be used" });
  const email = spyEmail();
  const brain = spyConversation();

  const res = await processInboundEmail(prisma, { payload: aiPayload({ from: "stranger@elsewhere.com" }) }, {
    env: ENV,
    logger: SILENT,
    sendEmailFn: email.fn,
    sendConversationFn: brain.fn,
  });

  assert.equal(res.outcome, "parked");
  assert.equal(res.reason, "unknown_sender");
  assert.equal(email.calls.length, 0);
  assert.equal(brain.calls.length, 0);
});

test("Door B (team@) forwards to the human inbox; the brain is never involved", async () => {
  const prisma = makeFakePrisma();
  const email = spyEmail();
  const brain = spyConversation();

  const res = await processInboundEmail(
    prisma,
    { payload: aiPayload({ to: "team@mynamejefe.com", email_id: "in_team" }) },
    { env: ENV, logger: SILENT, sendEmailFn: email.fn, sendConversationFn: brain.fn },
  );

  assert.equal(res.outcome, "forwarded");
  assert.equal(res.door, "team");
  assert.equal(brain.calls.length, 0);
  assert.equal(email.calls.length, 1);
  assert.equal(email.calls[0].to, "matt@mynamejefe.com");
  assert.match(email.calls[0].text, /owner@shop\.com/);
});

test("when the send adapter is disabled, Door A records a stub (no throw)", async () => {
  const prisma = knownSenderPrisma();
  const email = spyEmail({ delivered: false, disabled: true, id: null });
  const brain = spyConversation();

  const res = await processInboundEmail(prisma, { payload: aiPayload() }, {
    env: ENV,
    logger: SILENT,
    sendEmailFn: email.fn,
    sendConversationFn: brain.fn,
  });

  assert.equal(res.outcome, "replied");
  assert.equal(res.reason, "reply_stubbed");
  assert.equal(prisma._events.at(-1).status, "reply_stubbed");
});
