// @ts-check

/**
 * Agent traces exist to answer one question in one place: **why did Jefe say
 * that?** A trace holds the message, the state before, every tool request with
 * its validation and result, the state after, and the grounding inputs to the
 * final wording.
 *
 * Traces contain merchant business data (product titles, quantities), so they
 * are logged in structured form and stored on the action's own progress record
 * — never in a separate uncontrolled sink.
 */

import { logger as baseLogger } from "../../observability/logger.server.js";

const log = baseLogger.child({ component: "action-agent-trace" });

/** Keep stored traces small enough to be safe on a JSON column. */
const MAX_STORED_TRACES = 5;
const MAX_MESSAGE_CHARS = 500;

/**
 * @param {{
 *   merchantMessageId: string | null;
 *   conversationId: string | null;
 *   focusedActionId: string;
 *   message: string;
 *   model: string | null;
 *   provider: string | null;
 *   agentVersion: string;
 *   promptVersion: string;
 *   toolSchemaVersion: string;
 *   stateBefore: any;
 * }} input
 */
export function startAgentTrace(input) {
  return {
    startedAt: new Date().toISOString(),
    merchantMessageId: input.merchantMessageId,
    conversationId: input.conversationId,
    focusedActionId: input.focusedActionId,
    message: String(input.message ?? "").slice(0, MAX_MESSAGE_CHARS),
    model: input.model,
    provider: input.provider,
    agentVersion: input.agentVersion,
    promptVersion: input.promptVersion,
    toolSchemaVersion: input.toolSchemaVersion,
    stateBefore: input.stateBefore,
    /** @type {any[]} */
    iterations: [],
    /** @type {any[]} */
    ledger: [],
    stateAfter: /** @type {any} */ (null),
    outcome: /** @type {string | null} */ (null),
    modelReply: /** @type {string | null} */ (null),
    finalReply: /** @type {string | null} */ (null),
    usedModelProse: false,
    bounded: false,
    plannerError: /** @type {string | null} */ (null),
    routing: "focused",
  };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 * @param {any} trace
 * @param {Pick<Console, "info" | "warn" | "error">} [logger]
 */
export function recordAgentTrace(prisma, input, trace, logger = log) {
  const finished = { ...trace, finishedAt: new Date().toISOString() };

  logger.info("action agent trace", {
    merchantId: input.merchantId,
    shopId: input.shopId,
    focusedActionId: input.actionId,
    merchantMessageId: finished.merchantMessageId,
    conversationId: finished.conversationId,
    model: finished.model,
    agentVersion: finished.agentVersion,
    promptVersion: finished.promptVersion,
    toolSchemaVersion: finished.toolSchemaVersion,
    outcome: finished.outcome,
    routing: finished.routing,
    iterations: finished.iterations.length,
    toolCalls: (finished.ledger ?? []).map(
      (/** @type {any} */ row) => `${row.tool}:${row.ok ? "ok" : row.error?.code ?? row.blocked?.code ?? "fail"}`,
    ),
    usedModelProse: finished.usedModelProse,
    bounded: finished.bounded,
    plannerError: finished.plannerError,
  });

  // Storage is best-effort diagnostics: a trace write must never fail a turn.
  void persistTrace(prisma, input, compactTrace(finished)).catch((error) => {
    logger.warn?.("could not store agent trace", {
      focusedActionId: input.actionId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
  });

  return finished;
}

/** @param {any} trace */
function compactTrace(trace) {
  return {
    ...trace,
    stateBefore: trace.stateBefore,
    stateAfter: trace.stateAfter,
    ledger: (trace.ledger ?? []).map((/** @type {any} */ row) => ({
      tool: row.tool,
      ok: row.ok,
      effect: row.effect,
      message: row.message,
      changes: row.changes,
      error: row.error,
      blocked: row.blocked,
      artifactType: row.artifact?.type ?? null,
    })),
  };
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 * @param {any} trace
 */
async function persistTrace(prisma, input, trace) {
  if (!prisma?.merchantAction?.findFirst || !prisma?.merchantAction?.update) return;
  const row = await prisma.merchantAction.findFirst({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
    select: { id: true, progress: true },
  });
  if (!row) return;
  const progress =
    row.progress && typeof row.progress === "object" && !Array.isArray(row.progress)
      ? row.progress
      : {};
  const traces = Array.isArray(progress.agentTraces) ? progress.agentTraces : [];
  traces.push(trace);
  await prisma.merchantAction.update({
    where: { id: row.id },
    data: { progress: { ...progress, agentTraces: traces.slice(-MAX_STORED_TRACES) } },
  });
}

/**
 * Read the stored traces for the dev inspector.
 *
 * @param {any} prisma
 * @param {{ merchantId: string; shopId: string; actionId: string }} input
 */
export async function listAgentTraces(prisma, input) {
  const row = await prisma.merchantAction.findFirst({
    where: { id: input.actionId, merchantId: input.merchantId, shopId: input.shopId },
    select: { progress: true },
  });
  const progress =
    row?.progress && typeof row.progress === "object" && !Array.isArray(row.progress)
      ? row.progress
      : {};
  return Array.isArray(progress.agentTraces) ? progress.agentTraces : [];
}
