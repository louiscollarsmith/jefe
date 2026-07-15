// @ts-check

import crypto from "node:crypto";

export const ACTION_STATUSES = Object.freeze([
  "proposed",
  "draft_prepared",
  "needs_approval",
  "approved",
  "rejected",
  "blocked",
  "execution_queued",
  "executing",
  "executed",
  "execution_failed",
  "measurement_pending",
  "measured",
  "verified",
  "expired",
  "cancelled",
]);

export const ACTION_VALUE_TYPES = Object.freeze([
  "estimated_revenue",
  "estimated_margin",
  "estimated_prevention",
  "verified_revenue",
  "verified_margin",
]);

export const ACTION_VERIFICATION_CLASSES = Object.freeze([
  "estimated",
  "verified",
]);

export const ACTION_RISK_LEVELS = Object.freeze(["low", "medium", "high"]);

export const ACTION_ACTOR_TYPES = Object.freeze([
  "merchant_user",
  "admin",
  "system",
]);

export const ACTION_EXECUTION_MODES = Object.freeze([
  "dry_run",
  "draft_only",
  "live_write_disabled",
  "live",
]);

export const ACTION_EXTERNAL_SYSTEMS = Object.freeze([
  "klaviyo",
  "shopify",
  "internal",
  "other",
]);

export const ACTION_BLOCKED_REASONS = Object.freeze([
  "approval_required",
  "house_rules_blocked",
  "audience_cap_exceeded",
  "freeze_mode_enabled",
  "live_write_disabled",
  "missing_connector",
  "missing_idempotency_key",
  "invalid_status",
  "value_verification_mismatch",
]);

const TERMINAL_STATUSES = new Set([
  "rejected",
  "blocked",
  "execution_failed",
  "expired",
  "cancelled",
]);

/** @type {Readonly<Record<string, string[]>>} */
const ALLOWED_TRANSITIONS = Object.freeze({
  proposed: ["draft_prepared", "needs_approval", "blocked", "expired", "cancelled"],
  draft_prepared: ["needs_approval", "blocked", "expired", "cancelled"],
  needs_approval: ["approved", "rejected", "blocked", "expired", "cancelled"],
  approved: ["execution_queued", "rejected", "blocked", "expired", "cancelled"],
  execution_queued: ["executing", "execution_failed", "cancelled"],
  executing: ["executed", "execution_failed"],
  executed: ["measurement_pending", "measured"],
  measurement_pending: ["measured"],
  measured: ["verified"],
});

/**
 * @param {unknown} value
 */
export function normalizeVerificationClass(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (!ACTION_VERIFICATION_CLASSES.includes(normalized)) {
    throw new Error(`Unsupported verification class: ${String(value)}`);
  }
  return normalized;
}

/**
 * @param {{ valueType: string; verificationClass: string }} input
 */
export function assertValueMatchesVerificationClass(input) {
  const verificationClass = normalizeVerificationClass(input.verificationClass);
  const valueType = String(input.valueType ?? "");

  if (verificationClass === "verified" && valueType.startsWith("estimated_")) {
    throw new Error("Estimated values cannot be stored as verified lift.");
  }
  if (verificationClass === "estimated" && valueType.startsWith("verified_")) {
    throw new Error("Verified value types require verified attribution.");
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   previousStatus: string;
 *   newStatus: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   reason?: string | null;
 *   requestSnapshot?: unknown;
 *   now?: Date;
 * }} input
 */
export async function recordActionAuditEvent(prisma, input) {
  const actor = input.actor ?? "system";
  const actorType = input.actorType ?? "system";
  const now = input.now ?? new Date();
  const requestSnapshot = toJson(input.requestSnapshot ?? {});

  const event = await prisma.actionApprovalEvent.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      actionId: input.actionId,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      actor,
      actorType,
      reason: input.reason ?? null,
      requestSnapshot,
      eventTs: now,
    },
  });

  await prisma.ledgerEvent.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      eventType: ledgerEventType(input.newStatus),
      source: "app",
      dedupeKey: `action-transition:${input.actionId}:${input.newStatus}:${event.id}`,
      idempotencyKey: `action-transition:${event.id}`,
      actorType,
      actorId: actor,
      payload: {
        actionId: input.actionId,
        approvalEventId: event.id,
        previousStatus: input.previousStatus,
        newStatus: input.newStatus,
        reason: input.reason ?? null,
      },
      rawPayload: requestSnapshot,
      eventTs: now,
    },
  });

  return event;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   newStatus: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   reason?: string | null;
 *   requestSnapshot?: unknown;
 *   now?: Date;
 *   data?: Record<string, unknown>;
 * }} input
 */
export async function transitionAction(prisma, input) {
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
    },
  });
  const previousStatus = action.status;

  validateTransition(previousStatus, input.newStatus, input.reason);

  const updated = await prisma.action.update({
    where: { id: action.id },
    data: {
      status: input.newStatus,
      ...(input.data ?? {}),
    },
  });

  await recordActionAuditEvent(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    previousStatus,
    newStatus: input.newStatus,
    actor: input.actor,
    actorType: input.actorType,
    reason: input.reason,
    requestSnapshot: input.requestSnapshot,
    now: input.now,
  });

  return updated;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   comment?: string | null;
 *   requestSnapshot?: unknown;
 *   now?: Date;
 * }} input
 */
export async function approveAction(prisma, input) {
  const now = input.now ?? new Date();

  return transitionAction(prisma, {
    ...input,
    newStatus: "approved",
    reason: input.comment ?? null,
    now,
    data: {
      approvedAt: now,
      approvedBy: input.actorType === "merchant_user" && isUuid(input.actor)
        ? input.actor
        : null,
      rejectedAt: null,
      rejectedBy: null,
      blockedReason: null,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   reason?: string | null;
 *   requestSnapshot?: unknown;
 *   now?: Date;
 * }} input
 */
export async function rejectAction(prisma, input) {
  const now = input.now ?? new Date();

  return transitionAction(prisma, {
    ...input,
    newStatus: "rejected",
    now,
    data: {
      rejectedAt: now,
      rejectedBy: input.actorType === "merchant_user" && isUuid(input.actor)
        ? input.actor
        : null,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   reason: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   requestSnapshot?: unknown;
 *   now?: Date;
 * }} input
 */
export async function blockAction(prisma, input) {
  return transitionAction(prisma, {
    ...input,
    newStatus: "blocked",
    data: { blockedReason: input.reason },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   reason?: string | null;
 *   requestSnapshot?: unknown;
 *   now?: Date;
 * }} input
 */
export async function cancelAction(prisma, input) {
  return transitionAction(prisma, {
    ...input,
    newStatus: "cancelled",
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   connector: string;
 *   idempotencyKey: string;
 *   request?: unknown;
 *   response?: unknown;
 *   externalDraftId?: string | null;
 *   now?: Date;
 * }} input
 */
export async function recordDraftPreparedExecution(prisma, input) {
  const now = input.now ?? new Date();
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
    },
  });

  const execution = await prisma.execution.upsert({
    where: {
      merchantId_idempotencyKey: {
        merchantId: input.merchantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      actionId: action.id,
      status: "draft_prepared",
      connector: input.connector,
      idempotencyKey: input.idempotencyKey,
      dryRun: true,
      request: toJson(input.request ?? {}),
      response: toJson(input.response ?? {}),
      completedAt: now,
    },
    update: {
      status: "draft_prepared",
      dryRun: true,
      request: toJson(input.request ?? {}),
      response: toJson(input.response ?? {}),
      completedAt: now,
    },
  });

  await prisma.action.update({
    where: { id: action.id },
    data: {
      externalDraftId: input.externalDraftId ?? action.externalDraftId,
    },
  });

  await recordActionAuditEvent(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    previousStatus: action.status,
    newStatus: action.status,
    actor: "system",
    actorType: "system",
    reason: "draft_prepared",
    requestSnapshot: {
      executionId: execution.id,
      executionStatus: execution.status,
      externalDraftId: input.externalDraftId ?? null,
    },
    now,
  });

  return execution;
}

/**
 * @param {any} action
 * @param {{
 *   houseRulesPass?: boolean;
 *   capsPass?: boolean;
 *   connectorAvailable?: boolean;
 *   liveWritesEnabled?: boolean;
 * }} options
 */
export function evaluateExecutionGates(action, options = {}) {
  const blockedReasons = [];
  const executionMode = action.executionMode ?? "dry_run";
  const externalSystem = action.externalSystem ?? "internal";
  const needsApproval = action.approvalRequired !== false &&
    !["dry_run", "draft_only"].includes(executionMode);

  if (TERMINAL_STATUSES.has(action.status)) {
    blockedReasons.push("invalid_status");
  }
  if (needsApproval && action.status !== "approved") {
    blockedReasons.push("approval_required");
  }
  if (!action.idempotencyKey) {
    blockedReasons.push("missing_idempotency_key");
  }
  if (options.houseRulesPass === false) {
    blockedReasons.push("house_rules_blocked");
  }
  if (options.capsPass === false) {
    blockedReasons.push("audience_cap_exceeded");
  }
  if (executionMode === "live_write_disabled") {
    blockedReasons.push("live_write_disabled");
  }
  if (executionMode === "live" && options.liveWritesEnabled !== true) {
    blockedReasons.push("live_write_disabled");
  }
  if (
    externalSystem !== "internal" &&
    options.connectorAvailable === false &&
    !["dry_run", "draft_only"].includes(executionMode)
  ) {
    blockedReasons.push("missing_connector");
  }

  return {
    ok: blockedReasons.length === 0,
    blockedReasons,
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   merchantId: string;
 *   shopId?: string | null;
 *   actionId: string;
 *   connector: string;
 *   executionIdempotencyKey: string;
 *   actor?: string;
 *   actorType?: "merchant_user" | "admin" | "system";
 *   request?: unknown;
 *   response?: unknown;
 *   houseRulesPass?: boolean;
 *   capsPass?: boolean;
 *   connectorAvailable?: boolean;
 *   liveWritesEnabled?: boolean;
 *   now?: Date;
 * }} input
 */
export async function executeAction(prisma, input) {
  const now = input.now ?? new Date();
  const action = await prisma.action.findFirstOrThrow({
    where: {
      id: input.actionId,
      merchantId: input.merchantId,
      shopId: input.shopId ?? undefined,
    },
  });
  const gates = evaluateExecutionGates(action, input);

  if (!gates.ok) {
    const reason = gates.blockedReasons[0] ?? "invalid_status";
    if (TERMINAL_STATUSES.has(action.status)) {
      await recordActionAuditEvent(prisma, {
        merchantId: action.merchantId,
        shopId: action.shopId,
        actionId: action.id,
        previousStatus: action.status,
        newStatus: action.status,
        actor: input.actor ?? "system",
        actorType: input.actorType ?? "system",
        reason,
        requestSnapshot: {
          blockedReasons: gates.blockedReasons,
          request: input.request ?? {},
        },
        now,
      });

      return {
        ok: false,
        blockedReasons: gates.blockedReasons,
        action,
        execution: null,
      };
    }

    const blocked = await blockAction(prisma, {
      merchantId: action.merchantId,
      shopId: action.shopId,
      actionId: action.id,
      reason,
      actor: input.actor ?? "system",
      actorType: input.actorType ?? "system",
      requestSnapshot: {
        blockedReasons: gates.blockedReasons,
        request: input.request ?? {},
      },
      now,
    });

    return {
      ok: false,
      blockedReasons: gates.blockedReasons,
      action: blocked,
      execution: null,
    };
  }

  await transitionAction(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    newStatus: "execution_queued",
    actor: input.actor ?? "system",
    actorType: input.actorType ?? "system",
    requestSnapshot: input.request,
    now,
  });
  await transitionAction(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    newStatus: "executing",
    actor: input.actor ?? "system",
    actorType: input.actorType ?? "system",
    requestSnapshot: input.request,
    now,
  });

  const execution = await prisma.execution.upsert({
    where: {
      merchantId_idempotencyKey: {
        merchantId: action.merchantId,
        idempotencyKey: input.executionIdempotencyKey,
      },
    },
    create: {
      merchantId: action.merchantId,
      shopId: action.shopId,
      actionId: action.id,
      status: action.executionMode === "dry_run" ? "dry_run_executed" : "executed",
      connector: input.connector,
      idempotencyKey: input.executionIdempotencyKey,
      dryRun: action.executionMode !== "live",
      request: toJson(input.request ?? {}),
      response: toJson(input.response ?? { mode: action.executionMode }),
      startedAt: now,
      completedAt: now,
    },
    update: {
      status: action.executionMode === "dry_run" ? "dry_run_executed" : "executed",
      dryRun: action.executionMode !== "live",
      request: toJson(input.request ?? {}),
      response: toJson(input.response ?? { mode: action.executionMode }),
      startedAt: now,
      completedAt: now,
    },
  });

  const executed = await transitionAction(prisma, {
    merchantId: action.merchantId,
    shopId: action.shopId,
    actionId: action.id,
    newStatus: "executed",
    actor: input.actor ?? "system",
    actorType: input.actorType ?? "system",
    requestSnapshot: {
      executionId: execution.id,
      request: input.request ?? {},
      response: input.response ?? {},
    },
    now,
  });

  return {
    ok: true,
    blockedReasons: [],
    action: executed,
    execution,
  };
}

/**
 * @param {string} previousStatus
 * @param {string} newStatus
 * @param {string | null | undefined} reason
 */
function validateTransition(previousStatus, newStatus, reason) {
  if (!ACTION_STATUSES.includes(newStatus)) {
    throw new Error(`Unsupported action status: ${newStatus}`);
  }
  if (newStatus === "blocked" && !reason) {
    throw new Error("Blocked actions require a reason.");
  }

  const allowed = ALLOWED_TRANSITIONS[previousStatus] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid action transition from ${previousStatus} to ${newStatus}.`,
    );
  }
}

/**
 * @param {string} status
 */
function ledgerEventType(status) {
  if (status === "approved") return "action.approved";
  if (status === "rejected") return "action.rejected";
  if (status === "blocked") return "action.blocked";
  if (status === "execution_queued") return "action.execution_queued";
  if (status === "executing") return "action.executing";
  if (status === "executed") return "action.executed";
  if (status === "execution_failed") return "action.external_call_failed";
  if (status === "verified") return "action.verified";
  return `action.${status}`;
}

/**
 * @param {unknown} value
 */
function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * @param {unknown} value
 * @returns {import("@prisma/client").Prisma.InputJsonValue}
 */
function toJson(value) {
  return /** @type {import("@prisma/client").Prisma.InputJsonValue} */ (
    JSON.parse(JSON.stringify(value ?? null))
  );
}

export function newActionIdempotencySuffix() {
  return crypto.randomUUID();
}
