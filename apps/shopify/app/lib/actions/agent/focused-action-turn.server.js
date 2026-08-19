// @ts-check

/**
 * Entry point for every merchant message sent while an action is focused.
 *
 * This is the only route. Buttons still call `executeActionCommand` directly
 * with an explicit command — that is deterministic UI, not language — but no
 * merchant sentence is matched against phrases anywhere in this path.
 */

import { logger as baseLogger } from "../../observability/logger.server.js";
import { ACTION_COMMAND } from "../action-command.server.js";
import { normalizeChatText } from "../action-constraint.server.js";
import {
  ACTION_AGENT_VERSION,
  TURN_OUTCOME,
  runFocusedActionAgent,
} from "./agent-loop.server.js";

const log = baseLogger.child({ component: "focused-action-chat" });

export const AGENT_UNAVAILABLE_REPLY =
  "I couldn't process that right now. Try again in a moment, or use the controls on the action.";

/**
 * @param {any} prisma
 * @param {{
 *   message: string;
 *   merchantId: string;
 *   shopId: string;
 *   actionId: string;
 *   conversationId?: string | null;
 *   merchantMessageId?: string | null;
 *   actor?: string | null;
 *   session?: { shop: string } | null;
 *   provider?: any;
 *   recentMessages?: Array<{ role?: string; content?: string }>;
 *   executeDeps?: any;
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 * }} input
 */
export async function handleFocusedActionMessage(prisma, input) {
  const logger = input.logger ?? log;
  const message = normalizeChatText(input.message);

  const pending = await readPendingClarification(prisma, input);

  const result = await runFocusedActionAgent(prisma, {
    ...input,
    message,
    actor: input.actor ?? input.merchantId,
    pendingClarification: pending,
    logger,
  });

  if (result.unavailable) {
    return {
      ok: false,
      routing: "focused",
      reply: AGENT_UNAVAILABLE_REPLY,
      outcome: TURN_OUTCOME.failed,
      command: { type: ACTION_COMMAND.ANSWER, ok: false, reason: "agent_unavailable" },
      unavailable: true,
    };
  }

  if (result.routing === "general_store") {
    await writePendingClarification(prisma, input, null);
    return {
      ok: true,
      routing: "general_store",
      reply: "",
      outcome: result.outcome,
      command: { type: ACTION_COMMAND.ANSWER, ok: true, reason: "general_store" },
    };
  }

  await writePendingClarification(
    prisma,
    input,
    result.outcome === TURN_OUTCOME.needsClarification
      ? { question: result.reply, originalMessage: message, askedAt: new Date().toISOString() }
      : null,
  );

  return {
    ok: result.ok,
    routing: "focused",
    reply: result.reply,
    outcome: result.outcome,
    artifacts: result.artifacts ?? [],
    changes: result.changes ?? [],
    ledger: result.ledger ?? [],
    trace: result.trace ?? null,
    command: {
      type:
        result.outcome === TURN_OUTCOME.needsClarification
          ? ACTION_COMMAND.NEEDS_CLARIFICATION
          : ACTION_COMMAND.ANSWER,
      ok: result.ok,
      reason: null,
      agentVersion: ACTION_AGENT_VERSION,
      tools: (result.ledger ?? []).map((/** @type {any} */ row) => row.tool),
      outcome: result.outcome,
    },
  };
}

/** @param {any} prisma @param {any} input */
async function readPendingClarification(prisma, input) {
  if (!prisma?.merchantAction?.findFirst) return null;
  try {
    const row = await prisma.merchantAction.findFirst({
      where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
      select: { progress: true },
    });
    const progress = jsonObject(row?.progress);
    return progress.pendingClarification ?? null;
  } catch {
    return null;
  }
}

/** @param {any} prisma @param {any} input @param {any} pending */
async function writePendingClarification(prisma, input, pending) {
  if (!prisma?.merchantAction?.findFirst || !prisma?.merchantAction?.update) return;
  try {
    const row = await prisma.merchantAction.findFirst({
      where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
      select: { id: true, progress: true },
    });
    if (!row) return;
    const progress = jsonObject(row.progress);
    if (!pending && !progress.pendingClarification) return;
    const next = { ...progress };
    if (pending) next.pendingClarification = pending;
    else delete next.pendingClarification;
    await prisma.merchantAction.update({ where: { id: row.id }, data: { progress: next } });
  } catch {
    // Clarification memory is a convenience; losing it must not break the turn.
  }
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}
