// @ts-check

import crypto from "node:crypto";

import { logger as baseLogger } from "../../observability/logger.server.js";
import { sendGeneralChatMessage } from "../../merchant-memory/general-chat.server.js";
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
import { fetchReceivedEmail } from "./fetch.server.js";
import { resolveShopBySender } from "./identity.server.js";
import { renderJefeReplyEmail } from "./reply.server.js";
import { recordInboundEmailOutcome } from "./health.server.js";

/**
 * Inbound-email orchestrator (feature #15). The signature-verified webhook route
 * hands a parsed `email.received` payload here; this decides — and, when enabled,
 * does — what happens next:
 *
 *   Door A (jefe@, the AI)  → sendGeneralChatMessage (the SAME brain as app +
 *                             Slack) → reply back out via the gated Resend adapter.
 *   Door B (team@, humans)  → forward to the human inbox (RESEND_REPLY_TO).
 *
 * TWO-STEP by necessity: Resend's `email.received` webhook is metadata-only (from /
 * to / subject / id — no body, no SPF/DKIM). So we act off the metadata for
 * classify + dedup + sender-resolution, then FETCH the full email by id
 * (`fetch.server.js`) to get the body (for the brain) and the sender's
 * authentication (for the verify-before-act gate). We only fetch for a KNOWN
 * sender on the enabled path — never for a stranger, and never while dark.
 *
 * Ships DARK behind ENABLE_INBOUND_EMAIL: verified inbound is recorded (so a live
 * round-trip is observable) but nothing is fetched, interpreted, or sent until a
 * human flips the flag. Idempotent via the `inbound_email_events` ledger. Hash-only
 * PII routing posture: the sender is stored only as a hash in this ledger. The
 * authenticated merchant message is retained in Merchant Memory and never logged.
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
  return (
    String(env.ENABLE_INBOUND_EMAIL ?? "")
      .trim()
      .toLowerCase() === "true"
  );
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
 * @param {import("./parse.server.js").ParsedInboundEmail} meta
 * @returns {string}
 */
function providerMessageIdFor(meta) {
  if (meta.messageId) return meta.messageId;
  const basis = `${meta.from}|${meta.to}|${meta.subject}`;
  return `derived:${crypto.createHash("sha256").update(basis).digest("hex")}`;
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
 * @param {{ payload: any }} input Already-JSON-parsed, signature-verified `email.received` body.
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   logger?: import("../../observability/logger.server.js").Logger;
 *   sendEmailFn?: typeof sendEmail;
 *   sendConversationFn?: typeof sendGeneralChatMessage;
 *   fetchReceivedEmailFn?: typeof fetchReceivedEmail;
 *   llmProvider?: any;
 * }} [opts]
 * @returns {Promise<ProcessInboundResult>}
 */
export async function processInboundEmail(prisma, input, opts = {}) {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? log;
  const startedAt = Date.now();

  /** @param {ProcessInboundResult["outcome"]} outcome @param {string} reason @param {"ai"|"team"|"unknown"} [door] */
  const finish = (outcome, reason, door) => {
    if (outcome !== "duplicate") {
      recordInboundEmailOutcome({
        outcome:
          outcome === "failed"
            ? "failed"
            : outcome === "replied"
              ? "replied"
              : outcome === "forwarded"
                ? "forwarded"
                : "parked",
        ms: Date.now() - startedAt,
      });
    }
    return { outcome, reason, ...(door ? { door } : {}) };
  };

  let ledgerId = /** @type {string | null} */ (null);
  /** @param {any} data */
  const updateLedger = async (data) => {
    if (!ledgerId) return;
    await prisma.inboundEmailEvent
      .update({ where: { id: ledgerId }, data })
      .catch((error) => {
        logger.warn("inbound-email ledger update failed", { err: error });
      });
  };

  try {
    // The webhook is metadata-only — this gives us from / to / subject / id.
    const parsed = parseInboundEmail(input.payload);
    if (!parsed.ok) {
      logger.warn("inbound email unparseable", { reason: parsed.reason });
      return finish("parked", parsed.reason);
    }
    const meta = parsed.email;
    const door = classifyDoor(meta.to, env);
    const providerMessageId = providerMessageIdFor(meta);
    const senderHash = crypto
      .createHash("sha256")
      .update(meta.from)
      .digest("hex");

    // Idempotency: a retry of the same message must not be processed twice.
    const existing = await prisma.inboundEmailEvent.findUnique({
      where: { providerMessageId },
      select: { id: true },
    });
    if (existing) {
      logger.info("inbound email duplicate ignored", {
        door,
        providerMessageId,
      });
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
          metadata: { subjectLength: meta.subject.length },
        },
        select: { id: true },
      });
      ledgerId = row.id;
    } catch {
      // Unique-violation race: another delivery claimed it first → treat as duplicate.
      logger.info(
        "inbound email claim lost (concurrent) — treating as duplicate",
        {
          door,
          providerMessageId,
        },
      );
      return finish("duplicate", "duplicate_race");
    }

    // Dark flag: record the verified inbound but take NO action (no fetch, no
    // interpret, no send) until a human flips it on.
    if (!isInboundEmailEnabled(env)) {
      logger.info("inbound email received while disabled — parked (dark)", {
        door,
      });
      await updateLedger({ status: "parked", safeReason: "inbound_disabled" });
      return finish("parked", "inbound_disabled", door);
    }

    if (door === "unknown") {
      logger.warn("inbound email to an unrecognised address — parked", {});
      await updateLedger({ status: "parked", safeReason: "unknown_door" });
      return finish("parked", "unknown_door", door);
    }

    const ctx = {
      meta,
      env,
      logger,
      sendEmailFn: opts.sendEmailFn ?? sendEmail,
      sendConversationFn: opts.sendConversationFn ?? sendGeneralChatMessage,
      fetchReceivedEmailFn: opts.fetchReceivedEmailFn ?? fetchReceivedEmail,
      llmProvider: opts.llmProvider,
      updateLedger,
      finish,
    };
    return door === "team"
      ? await handleTeamDoor(prisma, ctx)
      : await handleAiDoor(prisma, ctx);
  } catch (error) {
    logger.error("inbound email processing crashed", { err: error });
    await updateLedger({ status: "failed", safeReason: "error" });
    return finish("failed", "error");
  }
}

/**
 * Door A: resolve the sender → fetch the full email → verify SPF/DKIM → run the
 * conversation brain → send Jefe's reply (self-identified as the AI, human door in
 * the footer). We resolve BEFORE fetching so a stranger is parked without an API
 * call, and gate on the fetched email's authentication before acting.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} ctx
 * @returns {Promise<ProcessInboundResult>}
 */
async function handleAiDoor(prisma, ctx) {
  const {
    meta,
    env,
    logger,
    sendEmailFn,
    sendConversationFn,
    fetchReceivedEmailFn,
    llmProvider,
    updateLedger,
    finish,
  } = ctx;

  const resolved = await resolveShopBySender(prisma, meta.from);
  if (!resolved.shopId || !resolved.merchantId) {
    // Never reply to (or even fetch) a sender we can't map to a shop.
    logger.warn("inbound AI email from unknown sender — parked", {
      source: resolved.source,
    });
    await updateLedger({
      status: "parked",
      safeReason: "unknown_sender",
      emailHash: resolved.emailHash,
    });
    return finish("parked", "unknown_sender", "ai");
  }

  await updateLedger({
    status: "processing",
    shopId: resolved.shopId,
    merchantId: resolved.merchantId,
    emailHash: resolved.emailHash,
  });

  // Step 2: fetch the full email (body + auth headers) by id.
  const fetched = await fetchReceivedEmailFn(meta.messageId, { env });
  if (!fetched.ok || !fetched.record) {
    logger.warn("inbound AI email fetch failed — could not retrieve body", {
      reason: fetched.reason,
    });
    await updateLedger({
      status: "failed",
      safeReason: fetched.reason ?? "fetch_failed",
    });
    return finish("failed", fetched.reason ?? "fetch_failed", "ai");
  }
  const full = parseInboundEmail(fetched.record);
  if (!full.ok) {
    logger.warn("inbound AI fetched email unparseable — parked", {
      reason: full.reason,
    });
    await updateLedger({ status: "failed", safeReason: "fetched_unparseable" });
    return finish("failed", "fetched_unparseable", "ai");
  }

  // Verify-before-act: sender authentication (SPF/DKIM/DMARC), read from the FETCHED
  // email's headers — it is not in the webhook metadata.
  const authVerdict = evaluateInboundAuth(full.email.auth);
  if (!authVerdict.pass) {
    logger.warn("inbound AI email failed sender auth — parked", {
      authSource: full.email.auth.source,
      reason: authVerdict.reason,
    });
    await updateLedger({ status: "parked", safeReason: authVerdict.reason });
    return finish("parked", authVerdict.reason, "ai");
  }

  const messageText = full.email.text;
  if (!messageText) {
    logger.warn("inbound AI email had no body — parked", {
      shopId: resolved.shopId,
    });
    await updateLedger({ status: "parked", safeReason: "empty_body" });
    return finish("parked", "empty_body", "ai");
  }

  // Same conversation service as the in-app chat + Slack: stores the merchant
  // message and its own grounded reply in one stable email thread.
  const conversationResult = await sendConversationFn(prisma, {
    merchantId: resolved.merchantId,
    shopId: resolved.shopId,
    message: messageText,
    surface: "email",
    externalThreadId: `email:${resolved.emailHash}`,
    externalMessageId: providerMessageIdFor(meta),
    metadata: { inboundProviderMessageId: providerMessageIdFor(meta) },
    llmProvider,
    logger,
  });
  const replyText = conversationResult?.assistantMessage?.content?.trim();
  if (!replyText) {
    logger.warn("inbound AI email produced no reply — failed", {
      shopId: resolved.shopId,
    });
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
    originalSubject: meta.subject || full.email.subject,
    teamAddress,
    appUrl,
    unsubscribeUrl,
  });

  const sent = await sendEmailFn({
    to: meta.from,
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
    status: sent.disabled
      ? "reply_stubbed"
      : sent.delivered
        ? "replied"
        : "reply_failed",
    safeReason: sent.disabled
      ? "email_disabled"
      : sent.delivered
        ? null
        : (sent.skipped ?? "not_delivered"),
    metadata: {
      replyProviderId: sent.id ?? null,
      replyDisabled: Boolean(sent.disabled),
      authSource: full.email.auth.source,
    },
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
 * (RESEND_REPLY_TO). Fetches the full email so the human sees the body; if the
 * fetch fails, forwards the metadata alone. The AI→human auto-escalation
 * *classifier* is Phase 2; this is just the address routing so team@ mail is never
 * a dead end.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {any} ctx
 * @returns {Promise<ProcessInboundResult>}
 */
async function handleTeamDoor(prisma, ctx) {
  const {
    meta,
    env,
    logger,
    sendEmailFn,
    fetchReceivedEmailFn,
    updateLedger,
    finish,
  } = ctx;
  const humanInbox = (env.RESEND_REPLY_TO || "").trim();
  if (!humanInbox) {
    logger.warn(
      "inbound team email but no RESEND_REPLY_TO configured — parked",
      {},
    );
    await updateLedger({ status: "parked", safeReason: "no_human_inbox" });
    return finish("parked", "no_human_inbox", "team");
  }

  const fetched = await fetchReceivedEmailFn(meta.messageId, { env });
  const full =
    fetched.ok && fetched.record ? parseInboundEmail(fetched.record) : null;
  const body =
    full && full.ok
      ? full.email.text
      : "(body unavailable — fetch failed; see Resend)";

  const subject = `[Jefe team] ${meta.subject || "(no subject)"}`;
  const forwardText = [
    `A merchant emailed the Jefe team door (${meta.to}).`,
    `From: ${meta.from}`,
    meta.subject ? `Subject: ${meta.subject}` : "",
    "",
    body,
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
    replyTo: meta.from,
  });

  await updateLedger({
    status: sent.disabled
      ? "forward_stubbed"
      : sent.delivered
        ? "forwarded"
        : "forward_failed",
    safeReason: sent.disabled
      ? "email_disabled"
      : sent.delivered
        ? null
        : (sent.skipped ?? "not_delivered"),
  });
  logger.info("inbound team email forwarded", {
    delivered: Boolean(sent.delivered),
    disabled: Boolean(sent.disabled),
  });
  return finish(
    "forwarded",
    sent.disabled ? "forward_stubbed" : "forwarded",
    "team",
  );
}
