// @ts-check

import crypto from "node:crypto";

import { logger as baseLogger } from "../../observability/logger.server.js";
import { sendConversationMessage } from "../../merchant-memory/conversation.server.js";
import { sendEmail } from "../resend.server.js";
import { signUnsubscribeToken } from "../unsubscribe.server.js";
import { DEFAULT_APP_URL } from "../welcome.server.js";
import {
  classifyDoor,
  evaluateInboundAuth,
  parseInboundEmail,
  DEFAULT_AI_ADDRESS,
  DEFAULT_TEAM_ADDRESS,
} from "./parse.server.js";
import { resolveShopBySender } from "./identity.server.js";
import { renderJefeReplyEmail } from "./reply.server.js";
import { recordInboundEmailOutcome } from "./health.server.js";

/**
 * Inbound-email orchestrator (feature #15). The signature-verified webhook route
 * hands a parsed payload here; this decides — and, when enabled, does — what
 * happens next:
 *
 *   Door A (jefe@, the AI)  → sendConversationMessage (the SAME brain as app +
 *                             Slack) → reply back out via the gated Resend adapter.
 *   Door B (team@, humans)  → forward to the human inbox (RESEND_REPLY_TO).
 *
 * Ships DARK behind ENABLE_INBOUND_EMAIL: verified inbound is still recorded (so a
 * live round-trip is observable), but nothing runs the brain or sends until a
 * human flips the flag. Verify-before-act throughout: bad SPF/DKIM or an unknown
 * sender is parked, never actioned. Idempotent: the `inbound_email_events` ledger,
 * keyed by provider message id, means a webhook retry can't double-reply. Hash-only
 * PII posture: the sender is stored only as a hash; no body is ever persisted.
 *
 * @see app/lib/channels/service.server.js `processInboundSlackDm` (the sibling path)
 */

const log = baseLogger.child({ component: "inbound-email" });

/**
 * Whether inbound-email auto-actioning is switched on. Defaults to false — the
 * whole path is inert (records + parks) until a human flips this after a reviewed
 * live round-trip.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isInboundEmailEnabled(env = process.env) {
  return String(env.ENABLE_INBOUND_EMAIL ?? "").trim().toLowerCase() === "true";
}

/**
 * Resolve the configured addresses. Env-driven so provisioning (jefe@ / team@ and
 * whatever subdomain the MX lands on) is a config change, not a code change.
 * @param {Record<string, string | undefined>} env
 */
function getAddressConfig(env) {
  const aiAddress = (env.INBOUND_AI_ADDRESS || DEFAULT_AI_ADDRESS).trim();
  const teamAddress = (env.INBOUND_TEAM_ADDRESS || DEFAULT_TEAM_ADDRESS).trim();
  // AI replies come From the AI persona on the verified root domain; Reply-To is the
  // AI inbound address so the thread stays on Door A.
  const aiFrom = (env.INBOUND_AI_FROM || `Jefe <${DEFAULT_AI_ADDRESS}>`).trim();
  return { aiAddress, teamAddress, aiFrom };
}

/**
 * A stable id to dedup on. Prefers the provider/Message-ID; falls back to a hash of
 * the salient fields so an identical retry with no id still dedups.
 * @param {import("./parse.server.js").ParsedInboundEmail} email
 * @returns {string}
 */
function providerMessageIdFor(email) {
  if (email.messageId) return email.messageId;
  const basis = `${email.from}|${email.to}|${email.subject}|${email.text.slice(0, 200)}`;
  return `derived:${crypto.createHash("sha256").update(basis).digest("hex")}`;
}

/** @param {import("@prisma/client").PrismaClient} prisma @param {string} merchantId */
async function loadLatestAssistantReply(prisma, merchantId) {
  const reply = await prisma.merchantMemoryConversationMessage.findFirst({
    where: { merchantId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  return reply?.content?.trim() || "";
}

/**
 * @typedef {Object} ProcessInboundResult
 * @property {"replied" | "forwarded" | "parked" | "duplicate" | "failed"} outcome
 * @property {string} reason
 * @property {"ai" | "team" | "unknown"} [door]
 */

/**
 * Process one verified inbound email. Never throws (self-catching) so a slow LLM or
 * a Resend failure can't turn into a non-200 that makes Resend retry + double-send.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ payload: any }} input Already-JSON-parsed, signature-verified body.
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   logger?: import("../../observability/logger.server.js").Logger;
 *   sendEmailFn?: typeof sendEmail;
 *   sendConversationFn?: typeof sendConversationMessage;
 *   llmProvider?: any;
 * }} [opts]
 * @returns {Promise<ProcessInboundResult>}
 */
export async function processInboundEmail(prisma, input, opts = {}) {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? log;
  const sendEmailFn = opts.sendEmailFn ?? sendEmail;
  const sendConversationFn = opts.sendConversationFn ?? sendConversationMessage;
  const startedAt = Date.now();

  /** @param {ProcessInboundResult["outcome"]} outcome @param {string} reason @param {"ai"|"team"|"unknown"} [door] */
  const finish = (outcome, reason, door) => {
    if (outcome !== "duplicate") {
      recordInboundEmailOutcome({
        outcome: outcome === "failed" ? "failed" : outcome === "replied" ? "replied" : outcome === "forwarded" ? "forwarded" : "parked",
        ms: Date.now() - startedAt,
      });
    }
    return { outcome, reason, ...(door ? { door } : {}) };
  };

  let ledgerId = /** @type {string | null} */ (null);
  /** @param {any} data */
  const updateLedger = async (data) => {
    if (!ledgerId) return;
    await prisma.inboundEmailEvent.update({ where: { id: ledgerId }, data }).catch((error) => {
      logger.warn("inbound-email ledger update failed", { err: error });
    });
  };

  try {
    const parsed = parseInboundEmail(input.payload);
    if (!parsed.ok) {
      logger.warn("inbound email unparseable", { reason: parsed.reason });
      return finish("parked", parsed.reason);
    }
    const email = parsed.email;
    const door = classifyDoor(email.to, env);
    const providerMessageId = providerMessageIdFor(email);
    const senderHash = crypto.createHash("sha256").update(email.from).digest("hex");

    // Idempotency: a retry of the same message must not be processed twice.
    const existing = await prisma.inboundEmailEvent.findUnique({
      where: { providerMessageId },
      select: { id: true },
    });
    if (existing) {
      logger.info("inbound email duplicate ignored", { door, providerMessageId });
      return finish("duplicate", "duplicate");
    }

    // Claim a ledger row (identifiers + outcome only; never the body, sender hashed).
    try {
      const row = await prisma.inboundEmailEvent.create({
        data: {
          providerMessageId,
          door,
          emailHash: senderHash,
          status: "received",
          metadata: {
            authSource: email.auth.source,
            subjectLength: email.subject.length,
            textLength: email.text.length,
          },
        },
        select: { id: true },
      });
      ledgerId = row.id;
    } catch (error) {
      // Unique-violation race: another delivery claimed it first → treat as duplicate.
      logger.info("inbound email claim lost (concurrent) — treating as duplicate", {
        door,
        providerMessageId,
      });
      return finish("duplicate", "duplicate_race");
    }

    // Verify-before-act: sender authentication (SPF/DKIM/DMARC).
    const authVerdict = evaluateInboundAuth(email.auth);
    if (!authVerdict.pass) {
      logger.warn("inbound email failed sender auth — parked", {
        door,
        authSource: email.auth.source,
        reason: authVerdict.reason,
      });
      await updateLedger({ status: "parked", safeReason: authVerdict.reason });
      return finish("parked", authVerdict.reason, door);
    }

    // Dark flag: record the verified inbound but take no action until flipped on.
    if (!isInboundEmailEnabled(env)) {
      logger.info("inbound email received while disabled — parked (dark)", { door });
      await updateLedger({ status: "parked", safeReason: "inbound_disabled" });
      return finish("parked", "inbound_disabled", door);
    }

    if (door === "unknown") {
      logger.warn("inbound email to an unrecognised address — parked", {});
      await updateLedger({ status: "parked", safeReason: "unknown_door" });
      return finish("parked", "unknown_door", door);
    }

    if (door === "team") {
      return await handleTeamDoor(prisma, {
        email,
        env,
        logger,
        sendEmailFn,
        updateLedger,
        finish,
      });
    }

    return await handleAiDoor(prisma, {
      email,
      env,
      logger,
      sendEmailFn,
      sendConversationFn,
      llmProvider: opts.llmProvider,
      updateLedger,
      finish,
    });
  } catch (error) {
    logger.error("inbound email processing crashed", { err: error });
    await updateLedger({ status: "failed", safeReason: "error" });
    return finish("failed", "error");
  }
}

/**
 * Door A: run the sender's message through the shared conversation brain and send
 * Jefe's reply back out (self-identified as the AI, human door in the footer).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} ctx
 * @returns {Promise<ProcessInboundResult>}
 */
async function handleAiDoor(prisma, ctx) {
  const { email, env, logger, sendEmailFn, sendConversationFn, llmProvider, updateLedger, finish } = ctx;

  const resolved = await resolveShopBySender(prisma, email.from);
  if (!resolved.shopId || !resolved.merchantId) {
    // Never reply to a sender we can't map to a shop.
    logger.warn("inbound AI email from unknown sender — parked", { source: resolved.source });
    await updateLedger({ status: "parked", safeReason: "unknown_sender", emailHash: resolved.emailHash });
    return finish("parked", "unknown_sender", "ai");
  }

  await updateLedger({
    status: "processing",
    shopId: resolved.shopId,
    merchantId: resolved.merchantId,
    emailHash: resolved.emailHash,
  });

  // Same conversation service as the in-app chat + Slack: stores the merchant
  // message, interprets it, stores Jefe's reply as an assistant message.
  await sendConversationFn(prisma, {
    merchantId: resolved.merchantId,
    shopId: resolved.shopId,
    message: email.text,
    llmProvider,
    logger,
  });

  const replyText = await loadLatestAssistantReply(prisma, resolved.merchantId);
  if (!replyText) {
    logger.warn("inbound AI email produced no reply — parked", { shopId: resolved.shopId });
    await updateLedger({ status: "failed", safeReason: "no_reply" });
    return finish("failed", "no_reply", "ai");
  }

  const { aiAddress, teamAddress, aiFrom } = getAddressConfig(env);
  const appUrl = (env.EMAIL_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  const unsubscribeUrl =
    resolved.shopDomain && resolved.emailHash
      ? `${appUrl}/e/unsubscribe?t=${signUnsubscribeToken({ shopDomain: resolved.shopDomain, emailHash: resolved.emailHash })}`
      : undefined;

  const rendered = renderJefeReplyEmail({
    replyText,
    originalSubject: email.subject,
    teamAddress,
    appUrl,
    unsubscribeUrl,
  });

  const sent = await sendEmailFn({
    to: email.from,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: aiFrom,
    replyTo: aiAddress,
    ...(unsubscribeUrl
      ? {
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
  });

  await updateLedger({
    status: sent.disabled ? "reply_stubbed" : sent.delivered ? "replied" : "reply_failed",
    safeReason: sent.disabled ? "email_disabled" : sent.delivered ? null : (sent.skipped ?? "not_delivered"),
    metadata: { replyProviderId: sent.id ?? null, replyDisabled: Boolean(sent.disabled) },
  });
  logger.info("inbound AI email answered", {
    shopId: resolved.shopId,
    delivered: Boolean(sent.delivered),
    disabled: Boolean(sent.disabled),
  });
  return finish("replied", sent.disabled ? "reply_stubbed" : "replied", "ai");
}

/**
 * Door B: forward a human-directed email to the monitored team inbox
 * (RESEND_REPLY_TO). The AI→human auto-escalation *classifier* is Phase 2; this is
 * just the address routing so team@ mail (if routed through the webhook rather than
 * a mail-host alias) is never a dead end.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} ctx
 * @returns {Promise<ProcessInboundResult>}
 */
async function handleTeamDoor(prisma, ctx) {
  const { email, env, logger, sendEmailFn, updateLedger, finish } = ctx;
  const humanInbox = (env.RESEND_REPLY_TO || "").trim();
  if (!humanInbox) {
    logger.warn("inbound team email but no RESEND_REPLY_TO configured — parked", {});
    await updateLedger({ status: "parked", safeReason: "no_human_inbox" });
    return finish("parked", "no_human_inbox", "team");
  }

  const subject = `[Jefe team] ${email.subject || "(no subject)"}`;
  const forwardText = [
    `A merchant emailed the Jefe team door (${email.to}).`,
    `From: ${email.from}`,
    email.subject ? `Subject: ${email.subject}` : "",
    "",
    email.text || "(no text body)",
  ]
    .filter(Boolean)
    .join("\n");

  const sent = await sendEmailFn({
    to: humanInbox,
    subject,
    html: `<pre style="white-space:pre-wrap;font-family:inherit;">${forwardText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
    text: forwardText,
    replyTo: email.from,
  });

  await updateLedger({
    status: sent.disabled ? "forward_stubbed" : sent.delivered ? "forwarded" : "forward_failed",
    safeReason: sent.disabled ? "email_disabled" : sent.delivered ? null : (sent.skipped ?? "not_delivered"),
  });
  logger.info("inbound team email forwarded", { delivered: Boolean(sent.delivered), disabled: Boolean(sent.disabled) });
  return finish("forwarded", sent.disabled ? "forward_stubbed" : "forwarded", "team");
}
