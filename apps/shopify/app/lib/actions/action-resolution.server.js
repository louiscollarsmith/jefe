// @ts-check

// The resolution layer — turns a validated LLM action-intent into a deterministic,
// previewed, ledger-recorded PROPOSAL plus the SuggestedAction the surface renders.
//
//   intent → resolve (memory/query + safe sizing) → preview → structural eligibility
//   → autonomy mode → create a "proposed" ActionExecution row → SuggestedAction.
//
// No external write here: this is the propose half. The merchant's approval flips
// the row proposed→approved (approveAction), and — only when the write-flag is on —
// the typed adapter executes it. The LLM chose the verb + rough magnitude; the
// deterministic params (floored prices) are computed here + re-checked by the gate.

import { randomUUID } from "node:crypto";
import { validateActionIntent } from "./action-intent.server.js";
import { getActionMode } from "./action-autonomy-policy.server.js";
import { buildDeadStockClearanceProposal } from "./dead-stock-clearance.server.js";
import { track } from "../../services/analytics/event-log.server.js";
import {
  DEFAULT_CLEARANCE_CAPS,
  buildClearancePreview,
  computeClearanceAutoEligibility,
  isClearanceExecuteEnabled,
  resolveAutonomyMode,
} from "./clearance-adapter.server.js";

/**
 * Resolver for `price_markdown` on `dead_stock`: the deterministic half. Reads the
 * dead-stock proposal (only costed variants, markdown floored at unit cost), builds
 * the previewed changes. Returns null when there's nothing safe to act on.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; intent: import("./action-intent.server.js").ActionIntent }} input
 */
async function resolvePriceMarkdown(prisma, { merchantId, shopId, intent }) {
  const markdownPercent = Number(intent.params?.markdownPercent);
  const proposal = await buildDeadStockClearanceProposal(prisma, {
    merchantId,
    shopId,
    options: Number.isFinite(markdownPercent) ? { defaultDiscountPercent: markdownPercent } : undefined,
  });
  if (proposal.status !== "proposed") return null;
  const preview = buildClearancePreview(/** @type {any} */ (proposal));
  if (preview.variantCount === 0) return null; // all refused (below-floor / missing-floor) or none
  return { proposal, preview };
}

/**
 * Explicit dispatch, action-type → resolver. Stays explicit until a 2nd primitive
 * exists (no premature interface — the shared shape gets extracted from two real
 * ones, per the execution-contract owner).
 */
const RESOLVERS = /** @type {Record<string, typeof resolvePriceMarkdown>} */ ({
  price_markdown: resolvePriceMarkdown,
});

/** Round to 2 decimals (mirrors the clearance sizing math). @param {unknown} n */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Server-side money formatter for the SuggestedAction card. The card renders these
 * strings as-is, so currency lives here — mirrors the Daily Home `money()` helper
 * (symbol + en-GB grouping, whole units) so a persisted proposal reads identically to
 * the live surface. Kept here rather than imported from the `.tsx` because this layer
 * is plain-Node testable and the component is not importable into `.mjs` tests.
 * @param {number | null | undefined} amount
 * @param {string} [currency]
 */
export function formatMoney(amount, currency = "GBP") {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  const code = String(currency || "GBP").toUpperCase();
  const symbol =
    code === "GBP" ? "£"
    : code === "USD" || code === "CAD" || code === "AUD" ? "$"
    : code === "EUR" ? "€"
    : `${code} `;
  return symbol + Math.round(Number(amount)).toLocaleString("en-GB");
}

/**
 * The propose-time money snapshot persisted on the ActionExecution row, so the Daily
 * Home card renders key numbers + top items WITHOUT re-running the proposal. Totals are
 * summed over the items that SURVIVED the preview's floor gate (so the money always
 * agrees with the variant count shown), joined back to the proposal items for units +
 * trapped capital (the execution preview drops those). Raw numbers only — currency
 * formatting happens at read time against the shop currency (getActiveSuggestedAction).
 * @param {{ windowDays?: number; items?: Array<{ variantId: string | null; title?: string | null; unitsOnHand?: number; trappedCapital?: number; projectedRecovery?: number }> }} proposal
 * @param {{ changes?: Array<{ variantId: string }>; variantCount?: number }} preview
 */
export function buildProposalSummary(proposal, preview) {
  const byVariant = new Map(
    (proposal?.items ?? []).map((item) => [item.variantId, item]),
  );
  const surviving = (preview?.changes ?? [])
    .map((change) => byVariant.get(change.variantId))
    .filter(Boolean);
  let totalTrappedCapital = 0;
  let totalProjectedRecovery = 0;
  for (const item of surviving) {
    totalTrappedCapital += Number(item?.trappedCapital) || 0;
    totalProjectedRecovery += Number(item?.projectedRecovery) || 0;
  }
  return {
    windowDays: proposal?.windowDays ?? 90,
    variantCount: preview?.variantCount ?? surviving.length,
    totalTrappedCapital: round2(totalTrappedCapital),
    totalProjectedRecovery: round2(totalProjectedRecovery),
    topItems: surviving.slice(0, 3).map((item) => ({
      title: item?.title ?? item?.variantId ?? "Product",
      unitsOnHand: Number(item?.unitsOnHand) || 0,
      trappedCapital: Number(item?.trappedCapital) || 0,
    })),
  };
}

/**
 * Shape the immediate render-ready SuggestedAction returned at propose time (the
 * optimistic shape a caller can echo before a reload). The Daily Home surface itself
 * reads the persisted row via `getActiveSuggestedAction`, which formats money against
 * the shop currency; this immediate shape keeps money as raw numbers in keyNumbers.
 * @param {{ proposal: any; preview: any; runId: string; executable: boolean }} input
 */
export function toSuggestedAction({ proposal, preview, runId, executable }) {
  return {
    actionRunId: runId,
    actionType: "price_markdown",
    headline: `${preview.variantCount} product${preview.variantCount === 1 ? "" : "s"} with cash tied up haven't sold in ${proposal.windowDays} days — a floored clearance frees it.`,
    keyNumbers: [
      { label: "Trapped capital", value: proposal.totalTrappedCapital },
      { label: "Projected recovery", value: proposal.totalProjectedRecovery },
      { label: "Products", value: preview.variantCount },
    ],
    topItems: preview.changes.slice(0, 3).map((/** @type {any} */ c) => ({
      title: c.title ?? c.variantId,
      detail: `${c.fromPrice} → ${c.toPrice} (−${c.discountPercent}%)`,
    })),
    executable,
  };
}

/**
 * Propose an action from an LLM action-intent. Validates, resolves to a deterministic
 * preview, computes structural eligibility + the autonomy mode (merchant dial ×
 * structural gate), creates the `proposed` ActionExecution row (so the card gets a
 * runId), and returns the SuggestedAction. Writes nothing external.
 *
 * `executable` is intentionally `false` here: the card shows advisory-only until the
 * write-flag is live (avoids "I approved it, why didn't my prices change?"); the
 * surface flips it on when execution is enabled.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; intent: any; merchantSetting?: string; confidence?: number; writeEnabled?: boolean }} input
 */
export async function proposeActionFromIntent(prisma, input) {
  const validation = validateActionIntent(input.intent);
  if (!validation.ok) return { status: "invalid", reason: validation.reason };
  const intent = validation.intent;

  const resolver = RESOLVERS[intent.actionType];
  if (!resolver) return { status: "unsupported", reason: `no_resolver:${intent.actionType}` };

  const resolved = await resolver(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    intent,
  });
  if (!resolved) return { status: "no_opportunity" };
  const { proposal, preview } = resolved;

  // Deterministic proposal: the numbers are facts (only costed variants, floored at
  // cost), so the sizing confidence is full. Refine per data-completeness later.
  const confidence = input.confidence ?? 1;
  // The autonomy dial: read the merchant's mode for this action-type (defaults to
  // approve_execute / propose-first when unset — never auto by default). Callers/tests
  // may override. Settings recommend|approve_execute|autonomous → modes recommend|approve|auto.
  const merchantSetting =
    input.merchantSetting ??
    (await getActionMode(prisma, { merchantId: input.merchantId, actionType: intent.actionType }));
  const eligibility = computeClearanceAutoEligibility(preview, confidence);
  const autonomy = resolveAutonomyMode(merchantSetting, eligibility);

  const runId = randomUUID();
  // Persist the money summary alongside the execution preview so the Daily Home card
  // renders key numbers + top items without re-running the proposal (a read-time query).
  const proposalSummary = buildProposalSummary(proposal, preview);
  const execution = await prisma.actionExecution.create({
    data: {
      runId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: intent.actionType,
      actionKind: intent.targetKind === "dead_stock" ? "dead_stock_clearance" : intent.targetKind,
      status: "proposed",
      merchantSetting,
      resolvedMode: autonomy.mode,
      eligibility: /** @type {any} */ (eligibility),
      confidence,
      preview: /** @type {any} */ (preview),
      proposalSummary: /** @type {any} */ (proposalSummary),
      caps: /** @type {any} */ (DEFAULT_CLEARANCE_CAPS),
    },
    select: { id: true, runId: true, resolvedMode: true },
  });

  return {
    status: "proposed",
    execution,
    autonomy,
    suggestedAction: toSuggestedAction({
      proposal,
      preview,
      runId,
      // Executable only when the write path is live AND the mode isn't recommend-only.
      executable: input.writeEnabled === true && autonomy.mode !== "recommend",
    }),
  };
}

/**
 * Read the merchant's active (latest `proposed`) action as the render-ready
 * SuggestedAction the Daily Home card consumes. Reads the persisted money summary +
 * preview off the row — NO re-run of the proposal — and formats money server-side
 * against the shop currency (the card renders the strings as-is). Returns null when
 * there is no proposed action to show.
 *
 * `executable` is true only when there is a real proposed row AND the write path is
 * live (`CLEARANCE_EXECUTE_ENABLED`) AND the resolved mode is not recommend-only — it
 * gates the Approve/Decline controls. While the write flag is off (the default) the
 * card stays advisory, honestly: no live Approve button it cannot yet honour. `mode`
 * is the merchant's CURRENT dial for this action type (not the propose-time snapshot),
 * so the picker reflects any change since.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; currency?: string }} input
 * @returns {Promise<import("../../components/daily-home").SuggestedAction | null>}
 */
export async function getActiveSuggestedAction(prisma, input) {
  const row = await prisma.actionExecution.findFirst({
    where: { merchantId: input.merchantId, shopId: input.shopId, status: "proposed" },
    orderBy: { createdAt: "desc" },
    select: {
      runId: true,
      actionType: true,
      resolvedMode: true,
      proposalSummary: true,
      preview: true,
    },
  });
  if (!row) return null;

  const summary = /** @type {any} */ (row.proposalSummary) ?? {};
  const preview = /** @type {any} */ (row.preview) ?? {};
  const currency = input.currency || "GBP";
  const variantCount = Number(summary.variantCount ?? preview.variantCount ?? 0);
  if (!(variantCount > 0)) return null; // nothing safe to show

  const windowDays = Number(summary.windowDays ?? 90);
  const mode = await getActionMode(prisma, {
    merchantId: input.merchantId,
    actionType: row.actionType,
  });

  return {
    headline: `${variantCount} product${variantCount === 1 ? "" : "s"} with cash tied up haven't sold in ${windowDays} days — a floored clearance frees it.`,
    keyNumbers: [
      { label: "Trapped capital", value: formatMoney(summary.totalTrappedCapital, currency) },
      { label: "Projected recovery", value: formatMoney(summary.totalProjectedRecovery, currency) },
      { label: "Products", value: String(variantCount) },
    ],
    topItems: (Array.isArray(summary.topItems) ? summary.topItems : [])
      .slice(0, 3)
      .map((/** @type {any} */ item) => ({
        title: typeof item?.title === "string" ? item.title : "Product",
        detail: `${Number(item?.unitsOnHand) || 0} units · ${formatMoney(item?.trappedCapital, currency)} tied up`,
      })),
    executable: isClearanceExecuteEnabled() && row.resolvedMode !== "recommend",
    actionRunId: row.runId,
    actionType: row.actionType,
    mode,
  };
}

// NOTE: approval is NOT a standalone step. In the 3-mode model there is no
// approve-without-execute (recommend has no approve; approve_execute + autonomous
// both execute), so the approve→execute transition is owned by the execution-contract
// side (`wireClearanceExecution`), which records proposed→approved AND executes as one
// fn. This layer creates the proposed row and reads outcomes; it does not approve.

/**
 * Normalize a decline reason into the split shape {reasonCategory, reasonText}.
 * Accepts the new object form OR a legacy plain string (mapped to reasonText), so the
 * surface can migrate to the split without a breaking flag day.
 * @param {string | { reasonCategory?: string | null; reasonText?: string | null } | null | undefined} reason
 */
function normalizeDeclineReason(reason) {
  if (!reason) return { reasonCategory: null, reasonText: null };
  if (typeof reason === "string") {
    const text = reason.trim();
    return { reasonCategory: null, reasonText: text || null };
  }
  const category = typeof reason.reasonCategory === "string" ? reason.reasonCategory.trim() : "";
  const text = typeof reason.reasonText === "string" ? reason.reasonText.trim() : "";
  return { reasonCategory: category || null, reasonText: text || null };
}

/**
 * Shape a PII-safe "merchant declined an action" event — WHICH action, and (if given)
 * why, split into a structured category + free text. Feeds Observe→Learn alongside the
 * outcome loop: a declined suggestion + reason is as useful a signal as one that
 * worked. Send a category / short text only — PII-safe, never customer data.
 * @param {{ merchantId: string; shopId?: string | null; actionType: string; runId: string }} execution
 * @param {string | { reasonCategory?: string | null; reasonText?: string | null }} [reason]
 */
export function buildActionDeclinedEvent(execution, reason) {
  const { reasonCategory, reasonText } = normalizeDeclineReason(reason);
  const label = reasonCategory ?? reasonText;
  return {
    type: "merchant_action_declined",
    topic: "action_feedback",
    summary: `Declined ${execution.actionType}${label ? `: ${label}` : ""}`,
    merchantId: execution.merchantId,
    shopId: execution.shopId ?? undefined,
    properties: {
      actionType: execution.actionType,
      reasonCategory: reasonCategory ?? null,
      reasonText: reasonText ?? null,
      runId: execution.runId,
    },
  };
}

/**
 * Record a merchant declining a proposed action: proposed → rejected, with the decline
 * reason split into a structured category + optional free text (both PII-safe, never
 * customer data). A legacy single `reason` string is still accepted (mapped to text)
 * during the surface migration. Nothing is written to the store; the proposal is
 * dropped and the decline + reason feed the action-feedback corpus.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionRunId: string; reasonCategory?: string | null; reasonText?: string | null; reason?: string | null }} input
 */
export async function rejectAction(prisma, input) {
  const execution = await prisma.actionExecution.findUnique({
    where: { runId: input.actionRunId },
    select: { id: true, runId: true, merchantId: true, shopId: true, status: true, actionType: true },
  });
  if (!execution || execution.merchantId !== input.merchantId) return { status: "not_found" };
  if (execution.status !== "proposed") {
    return { status: "not_proposable", currentStatus: execution.status };
  }
  const rejected = await prisma.actionExecution.update({
    where: { runId: input.actionRunId },
    data: { status: "rejected" },
    select: { id: true, runId: true, status: true },
  });
  // Observe→Learn: capture the decline + split reason (best-effort; never blocks the reply).
  void track(
    prisma,
    buildActionDeclinedEvent(execution, {
      reasonCategory: input.reasonCategory ?? null,
      reasonText: input.reasonText ?? input.reason ?? null,
    }),
  );
  return { status: "rejected", execution: rejected };
}

/**
 * Revise a proposed action's magnitude — the "edit this suggestion" half. Re-runs the
 * proposal at the merchant's requested markdown (still floored + capped by the
 * primitive: the merchant suggests, the safety math is never overridden), creates a
 * fresh proposed row, and supersedes the old one so only the revision is active. Writes
 * nothing external. Chat 2's surface POSTs `action.edit` here.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionRunId: string; params?: { markdownPercent?: number } }} input
 */
export async function reviseAction(prisma, input) {
  const existing = await prisma.actionExecution.findUnique({
    where: { runId: input.actionRunId },
    select: {
      id: true, runId: true, merchantId: true, shopId: true,
      status: true, actionType: true, actionKind: true, merchantSetting: true,
    },
  });
  if (!existing || existing.merchantId !== input.merchantId) return { status: "not_found" };
  if (existing.status !== "proposed") {
    return { status: "not_revisable", currentStatus: existing.status };
  }
  const targetKind =
    existing.actionKind === "dead_stock_clearance" ? "dead_stock" : existing.actionKind;
  const markdownPercent = Number(input.params?.markdownPercent);
  const reproposed = await proposeActionFromIntent(prisma, {
    merchantId: existing.merchantId,
    shopId: existing.shopId,
    intent: {
      actionType: existing.actionType,
      targetKind,
      params: Number.isFinite(markdownPercent) ? { markdownPercent } : undefined,
    },
    merchantSetting: existing.merchantSetting, // preserve the merchant's dial
    writeEnabled: isClearanceExecuteEnabled(),
  });
  if (reproposed.status !== "proposed") {
    // No safe revision (e.g. the opportunity is gone) — leave the original in place.
    return { status: reproposed.status, reason: reproposed.reason };
  }
  // Supersede the original so only the revision is active (getActiveSuggestedAction
  // reads the latest `proposed`, and the execution path only runs proposed/approved —
  // `superseded` can never be executed).
  await prisma.actionExecution.update({
    where: { runId: input.actionRunId },
    data: { status: "superseded" },
  });
  return {
    status: "revised",
    superseded: existing.runId,
    execution: reproposed.execution,
    autonomy: reproposed.autonomy,
    suggestedAction: reproposed.suggestedAction,
  };
}
