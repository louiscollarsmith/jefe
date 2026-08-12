// @ts-check

// The resolution layer — turns a validated LLM action-intent into a deterministic,
// previewed, ledger-recorded PROPOSAL plus the SuggestedAction the surface renders.
//
//   intent → resolve (memory/query + safe sizing) → preview → structural eligibility
//   → autonomy mode → create a "proposed" ActionExecution row → SuggestedAction.
//
// No external write here: this is the propose half. On approval, wireClearanceExecution
// records proposed→approved AND — only when the write-flag is on — the typed adapter
// executes it (there is no standalone approve step in the 3-mode model). The LLM chose
// the verb + rough magnitude; the deterministic params (floored prices) are computed
// here + re-checked by the gate.

import { randomUUID } from "node:crypto";
import { getActionDefinition, getRequiredScopes, isActionExecuteEnabled, validateActionIntent } from "./action-intent.server.js";
import { applyAutonomyPolicy, getActionMode, getActionPolicy } from "./action-autonomy-policy.server.js";
import { buildDeadStockClearanceProposal } from "./dead-stock-clearance.server.js";
import { track } from "../../services/analytics/event-log.server.js";
import {
  DEFAULT_CLEARANCE_CAPS,
  buildClearancePreview,
  computeClearanceAutoEligibility,
  resolveAutonomyMode,
} from "./clearance-adapter.server.js";

/**
 * Close the learn loop: adapt the default clearance markdown from the merchant's
 * Observe→Learn memory. Reads the action-decline-signal belief — if the merchant has
 * repeatedly declined clearances as "too aggressive", ease the default markdown so the
 * next proposal is gentler. Deterministic + bounded: only ever EASES (a smaller cut is
 * the safe direction), floored at 15%, and the primitive still floors every price at
 * unit cost regardless. Best-effort: a memory read never blocks a proposal. Returns the
 * base when there's no learnable signal (so it's a no-op until real declines exist).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; baseMarkdownPercent: number }} input
 * @returns {Promise<{ markdownPercent: number; adapted: boolean; reason?: string }>}
 */
async function adaptMarkdownFromMemory(prisma, input) {
  const base = input.baseMarkdownPercent;
  try {
    const belief = await prisma.merchantMemoryBelief?.findFirst?.({
      where: { merchantId: input.merchantId, shopId: input.shopId, key: "business.action_decline_signal.all_time" },
      orderBy: { updatedAt: "desc" },
      select: { value: true, status: true },
    });
    const status = String(belief?.status ?? "");
    if (belief && !status.includes("superseded") && !status.includes("rejected")) {
      const value = /** @type {any} */ (belief.value) ?? {};
      if (value.topReasonCategory === "too_aggressive" && (Number(value.totalDeclines) || 0) >= 2) {
        const gentler = Math.max(15, base - 10);
        if (gentler < base) return { markdownPercent: gentler, adapted: true, reason: "eased_after_too_aggressive_declines" };
      }
    }
  } catch {
    // Best-effort: never block a proposal on a memory read.
  }
  return { markdownPercent: base, adapted: false };
}

/**
 * Resolver for `price_markdown` on `dead_stock`: the deterministic half. Reads the
 * dead-stock proposal (only costed variants, markdown floored at unit cost), builds
 * the previewed changes. Returns null when there's nothing safe to act on.
 *
 * Returns the generic `{ preview, summary, magnitude }` binding shape. The SUMMARY is built
 * here rather than by the caller because its shape is inherently this primitive's — a
 * markdown percentage and trapped capital mean nothing to a status change. `magnitude` is
 * the small, named set of numbers the merchant's autonomy caps are expressed in.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; intent: import("./action-intent.server.js").ActionIntent; sourceRecommendation?: any }} input
 */
async function resolvePriceMarkdown(prisma, { merchantId, shopId, intent, sourceRecommendation = null }) {
  const requested = Number(intent.params?.markdownPercent);
  // The effective default markdown that produced this proposal — the exact knob the
  // merchant edits (reviseAction round-trips it). Clamp to [0,100]; default 30.
  let markdownPercent = Number.isFinite(requested) ? Math.min(100, Math.max(0, requested)) : 30;
  // Close the learn loop: with no explicit markdown, adapt the default DOWN from the
  // merchant's decline history (gentler after "too aggressive" declines). Only eases.
  if (!Number.isFinite(requested)) {
    const adapted = await adaptMarkdownFromMemory(prisma, { merchantId, shopId, baseMarkdownPercent: markdownPercent });
    markdownPercent = adapted.markdownPercent;
  }
  const maxProducts = Number(intent.params?.maxProducts);
  const proposal = await buildDeadStockClearanceProposal(prisma, {
    merchantId,
    shopId,
    options: {
      defaultDiscountPercent: markdownPercent,
      maxProducts: Number.isInteger(maxProducts) && maxProducts > 0 ? maxProducts : undefined,
    },
  });
  if (proposal.status !== "proposed") return null;
  const preview = buildClearancePreview(/** @type {any} */ (proposal));
  if (preview.variantCount === 0) return null; // all refused (below-floor / missing-floor) or none
  const scope = Number.isInteger(maxProducts) && maxProducts > 0 ? { maxProducts } : null;
  const summary = buildProposalSummary(proposal, preview, markdownPercent, sourceRecommendation, scope);
  return {
    preview,
    summary,
    // What the merchant's autonomy caps are measured in, for this primitive. A primitive
    // with no magnitude (a status flip has none) returns {} and the caps simply don't bite.
    magnitude: {
      trappedCapital: summary.totalTrappedCapital,
      variantCount: preview.variantCount,
      maxDiscountPercent: preview.maxDiscountPercent,
    },
  };
}

/**
 * The PRIMITIVE BINDING TABLE — the seam that makes this layer generic, and the one place
 * an action type declares the behaviour that cannot live in the (metadata-only) registry.
 *
 * The registry says WHAT an action is; this says HOW this layer runs it. Everything here is
 * a function or a value the layer used to hardcode to clearance: the resolver, the safety
 * caps, the eligibility calculator, the ledger's `actionKind`, and the card presenters.
 *
 * ⚠️ Every field is REQUIRED. A partially-bound primitive is refused at module load
 * (see the assertion below) rather than silently inheriting clearance's behaviour — which
 * is exactly how the wrong-flag and wrong-caps bugs happened.
 *
 * ⚠️ Membership here — NOT the registry — is what makes an action proposable. A registry
 * entry with no binding returns `unsupported` and no row is ever created. Keep the two in
 * step: registering an action type without binding it makes it advertisable to the LLM but
 * unresolvable, and binding one without registering it makes it unreachable.
 *
 */

/**
 * @typedef {Object} PrimitiveBinding
 * @property {(prisma: any, input: { merchantId: string, shopId: string, intent: any, sourceRecommendation?: any }) => Promise<{ preview: any, summary: any, magnitude: Record<string, number|undefined> } | null>} resolve
 *   Deterministic half: find the targets, size the change safely, build the preview AND the
 *   persisted summary (both shapes are the primitive's own). null = no safe opportunity.
 * @property {Record<string, number>} caps  Structural blast-radius caps for this primitive.
 * @property {(preview: any, confidence: number, caps?: any) => { autoEligible: boolean, reversible: boolean, withinCap: boolean, confident: boolean, reasons: string[] }} computeEligibility
 * @property {(targetKind: string) => string} actionKindFor  Ledger `actionKind` from the intent's target.
 * @property {(input: { summary: any, preview: any, runId: string, executable: boolean }) => any} card
 *   Propose-time card (raw numbers). Each presenter names its OWN actionType — a hardcode
 *   that is correct once the function is explicitly one primitive's presenter.
 * @property {(input: { summary: any, preview: any, currency: string }) => { headline: string, keyNumbers: any[], topItems: any[] } | null} readCard
 *   Read-time card from the persisted row, money formatted. null = nothing safe to show.
 * @property {(status: string, count: number, summary: any) => string} executedHeadline
 * @property {(input: { summary: any, currency: string, missingScopes: string[] }) => any | null} scopeNudge
 *   The value-first permission ask, in this primitive's own terms.
 */

/** @type {Record<string, PrimitiveBinding>} */
const PRIMITIVES = {
  price_markdown: {
    resolve: resolvePriceMarkdown,
    caps: DEFAULT_CLEARANCE_CAPS,
    computeEligibility: computeClearanceAutoEligibility,
    actionKindFor: (targetKind) => (targetKind === "dead_stock" ? "dead_stock_clearance" : targetKind),
    card: clearanceProposeCard,
    readCard: clearanceReadCard,
    executedHeadline: clearanceExecutedHeadline,
    scopeNudge: clearanceScopeNudge,
  },
};

/**
 * Every field of the binding contract, as STATIC property reads. Adding a field to
 * PrimitiveBinding and forgetting it here means it stops being enforced — keep them in step.
 *
 * ⚠️ Deliberately not `fields.map((f) => binding[f])`: these files are `// @ts-check`, and
 * indexing a typed object with a widened `string` key is TS7053. That exact mistake in
 * `enforceBlastRadiusCap` put main's typecheck red and blocked every lane's preflight until
 * another session cleaned it up (`4c3493d`). Static reads only in this file.
 * @param {PrimitiveBinding} b
 */
function bindingContract(b) {
  return {
    resolve: b.resolve,
    caps: b.caps,
    computeEligibility: b.computeEligibility,
    actionKindFor: b.actionKindFor,
    card: b.card,
    readCard: b.readCard,
    executedHeadline: b.executedHeadline,
    scopeNudge: b.scopeNudge,
  };
}

for (const [actionType, binding] of Object.entries(PRIMITIVES)) {
  for (const [field, value] of Object.entries(bindingContract(binding))) {
    if (value == null) {
      throw new Error(`Primitive binding "${actionType}" is missing "${field}" — a partial binding would silently inherit clearance's behaviour.`);
    }
  }
}

/**
 * The bound primitive for an action type, or null. Fail-closed by design: every caller
 * treats null as "cannot do this", never as "fall back to clearance".
 * @param {string} actionType
 * @returns {PrimitiveBinding | null}
 */
function getPrimitive(actionType) {
  return Object.prototype.hasOwnProperty.call(PRIMITIVES, actionType)
    ? PRIMITIVES[actionType]
    : null;
}

/** Action types this layer can actually propose — the binding table, not the registry. */
export function listResolvableActionTypes() {
  return Object.keys(PRIMITIVES);
}

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
 * @param {{ windowDays?: number; eligibleDeadStockVariantCount?: number; items?: Array<{ variantId: string | null; title?: string | null; unitsOnHand?: number; trappedCapital?: number; projectedRecovery?: number }> }} proposal
 * @param {{ changes?: Array<{ variantId: string }>; variantCount?: number }} preview
 * @param {number} [markdownPercent]  The requested default % that produced the proposal — the knob the merchant edits.
 * @param {any} [sourceRecommendation]
 * @param {any} [scope]
 */
export function buildProposalSummary(proposal, preview, markdownPercent, sourceRecommendation = null, scope = null) {
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
    eligibleVariantCount:
      Number(proposal?.eligibleDeadStockVariantCount) ||
      Number(preview?.variantCount) ||
      surviving.length,
    markdownPercent: Number.isFinite(Number(markdownPercent)) ? Number(markdownPercent) : undefined,
    scope: scope ?? null,
    totalTrappedCapital: round2(totalTrappedCapital),
    totalProjectedRecovery: round2(totalProjectedRecovery),
    sourceRecommendation: normalizeSourceRecommendation(sourceRecommendation),
    topItems: surviving.slice(0, 3).map((item) => ({
      title: item?.title ?? item?.variantId ?? "Product",
      unitsOnHand: Number(item?.unitsOnHand) || 0,
      trappedCapital: Number(item?.trappedCapital) || 0,
    })),
  };
}

/** @param {any} recommendation */
function normalizeSourceRecommendation(recommendation) {
  if (!recommendation || typeof recommendation !== "object") return null;
  return {
    id: typeof recommendation.id === "string" ? recommendation.id : null,
    runId: typeof recommendation.runId === "string" ? recommendation.runId : null,
    title: String(recommendation.title ?? "").trim(),
    summary: String(recommendation.summary ?? "").trim(),
    whyThisAction: String(recommendation.whyThisAction ?? "").trim(),
    whyNow: String(recommendation.whyNow ?? "").trim(),
    successSignal:
      recommendation.successSignal && typeof recommendation.successSignal === "object"
        ? recommendation.successSignal
        : null,
    primaryGoalId: typeof recommendation.primaryGoalId === "string" ? recommendation.primaryGoalId : null,
    supportingGoalIds: cleanStringList(recommendation.supportingGoalIds),
    expectedBenefit: String(recommendation.expectedBenefit ?? "").trim(),
    supportingBeliefIds: cleanStringList(recommendation.supportingBeliefIds),
    supportingInsightIds: cleanStringList(recommendation.supportingInsightIds),
  };
}

/** @param {unknown} value */
function cleanStringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

// ── price_markdown presenters ────────────────────────────────────────────────────
// Each primitive owns how it describes itself. These three hardcode "price_markdown"
// and dead-stock wording — correct, now that they are explicitly ONE primitive's
// presenters reached through the binding table rather than the only path there is.
// `getActiveSuggestedAction` used to render this clearance headline for whatever row it
// loaded, so a second action type would have been announced to the merchant as a clearance.

/**
 * Propose-time card. Built from the persisted SUMMARY rather than the raw proposal, so the
 * money agrees with the variant count shown and with what the merchant sees on reload.
 *
 * ⚠️ Deliberate fix, not a refactor artefact: this read `proposal.totalTrappedCapital` —
 * the total over ALL dead-stock items, including those the preview's cost floor REFUSED —
 * while the read-time card reads the summary's total over surviving items only. The same
 * proposal could therefore quote two different figures depending on whether the page had
 * been reloaded. The summary is the honest one (it matches the products actually listed).
 * @param {{ summary: any; preview: any; runId: string; executable: boolean }} input
 */
function clearanceProposeCard({ summary, preview, runId, executable }) {
  return toSuggestedAction({ proposal: summary, preview, runId, executable });
}

/**
 * Read-time card from the persisted row, money formatted against the shop currency.
 * Returns null when there is nothing safe to show.
 * @param {{ summary: any; preview: any; currency: string }} input
 */
function clearanceReadCard({ summary, preview, currency }) {
  const variantCount = Number(summary.variantCount ?? preview.variantCount ?? 0);
  if (!(variantCount > 0)) return null;
  const windowDays = Number(summary.windowDays ?? 90);
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
 * Merge the structural eligibility with the mode-resolution outcome into the record the row
 * persists — the payload of Jefe's "here's what I couldn't do, and what you'd need to change"
 * raise.
 *
 * ⚠️ Before this, two of the three signals were computed and thrown away: `resolveAutonomyMode`
 * returns a `reason` and `applyAutonomyPolicy` a `reason` + `policyViolations`, and
 * `proposeActionFromIntent` handed both to `maybeEmitPlanAction`, which logs only `status` and
 * `runId`. Only `eligibility.reasons` survived. That was harmless while a settings dial carried
 * the story; under Matt's runtime-eligibility ruling (2026-08-12) — merchant sets autonomous,
 * Jefe does what it safely can and RAISES what it can't, with actionable steps — these ARE the
 * raise's content, so they have to outlive the function that computes them.
 *
 * Additive: the structural keys keep their existing shape and position, so every existing reader
 * of `eligibility` is unaffected. Goes in the existing `eligibility` Json column — no migration.
 * @param {{ autoEligible: boolean, reversible: boolean, withinCap: boolean, confident: boolean, reasons: string[] }} eligibility
 * @param {{ mode: string, reason: string, policyViolations?: string[] }} autonomy
 */
export function buildEligibilityRecord(eligibility, autonomy) {
  return {
    ...eligibility,
    // Why the run landed in the mode it did — "merchant_autonomous_and_eligible",
    // "autonomous_not_eligible_degraded", "exceeds_autonomy_policy", …
    modeReason: autonomy?.reason ?? null,
    // Which merchant-set autonomy cap blocked an otherwise-eligible auto run, if any.
    policyViolations: Array.isArray(autonomy?.policyViolations) ? autonomy.policyViolations : [],
    // True when the merchant asked for autonomous and Jefe could not honour it — the single
    // flag a raise can key on without re-deriving the reason strings.
    degradedFromAutonomous: autonomy?.reason === "autonomous_not_eligible_degraded" || autonomy?.reason === "exceeds_autonomy_policy",
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
 * @param {{ merchantId: string; shopId: string; intent: any; merchantSetting?: string; confidence?: number; writeEnabled?: boolean; sourceRecommendation?: any }} input
 */
export async function proposeActionFromIntent(prisma, input) {
  const validation = validateActionIntent(input.intent);
  if (!validation.ok) return { status: "invalid", reason: validation.reason };
  const intent = validation.intent;

  // The BINDING, not the registry, is what makes an action proposable — and it carries the
  // caps, eligibility calculator and presenters this function used to hardcode to clearance.
  const primitive = getPrimitive(intent.actionType);
  if (!primitive) return { status: "unsupported", reason: `no_resolver:${intent.actionType}` };

  const resolved = await primitive.resolve(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    intent,
    sourceRecommendation: input.sourceRecommendation,
  });
  if (!resolved) return { status: "no_opportunity" };
  const { preview, summary: proposalSummary, magnitude } = resolved;

  // Deterministic proposal: the numbers are facts (only costed variants, floored at
  // cost), so the sizing confidence is full. Refine per data-completeness later.
  const confidence = input.confidence ?? 1;
  // The autonomy dial: read the merchant's mode for this action-type (defaults to
  // approve_execute / propose-first when unset — never auto by default). Callers/tests
  // may override. Settings recommend|approve_execute|autonomous → modes recommend|approve|auto.
  const merchantSetting =
    input.merchantSetting ??
    (await getActionMode(prisma, { merchantId: input.merchantId, actionType: intent.actionType }));
  const eligibility = primitive.computeEligibility(preview, confidence, primitive.caps);
  const baseAutonomy = resolveAutonomyMode(merchantSetting, eligibility);
  // Governance: apply the merchant's autonomy POLICY on top of the resolved mode — an
  // "auto" run over a per-action-type cap ("autonomous up to £X") degrades to approve-
  // first. No-op unless the mode is auto AND a cap is set AND exceeded. The magnitude the
  // caps read is the primitive's own — a status flip has none, so its caps never bite.
  const policy = await getActionPolicy(prisma, { merchantId: input.merchantId, actionType: intent.actionType });
  const autonomy = applyAutonomyPolicy(baseAutonomy, policy, magnitude);

  const runId = randomUUID();
  const execution = await prisma.actionExecution.create({
    data: {
      runId,
      merchantId: input.merchantId,
      shopId: input.shopId,
      actionType: intent.actionType,
      actionKind: primitive.actionKindFor(intent.targetKind),
      status: "proposed",
      merchantSetting,
      resolvedMode: autonomy.mode,
      eligibility: /** @type {any} */ (buildEligibilityRecord(eligibility, autonomy)),
      confidence,
      preview: /** @type {any} */ (preview),
      proposalSummary: /** @type {any} */ (proposalSummary),
      // This primitive's OWN caps — persisting DEFAULT_CLEARANCE_CAPS regardless meant the
      // ledger recorded limits that were never the ones actually enforced.
      caps: /** @type {any} */ (primitive.caps),
    },
    select: { id: true, runId: true, resolvedMode: true },
  });

  return {
    status: "proposed",
    execution,
    autonomy,
    suggestedAction: primitive.card({
      summary: proposalSummary,
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

  // Describe the row with ITS OWN presenter. An action type this layer cannot describe
  // renders NOTHING — never someone else's headline. Before, the clearance wording was
  // emitted for whatever row was loaded, so a second action type would have been
  // announced to the merchant as a dead-stock clearance.
  const primitive = getPrimitive(row.actionType);
  const card = primitive?.readCard({ summary, preview, currency }) ?? null;
  if (!card) return null; // nothing safe to show

  const mode = await getActionMode(prisma, {
    merchantId: input.merchantId,
    actionType: row.actionType,
  });

  return {
    ...card,
    // Gated on THIS row's own action type, not on clearance's flag. Reading
    // isClearanceExecuteEnabled() here meant a second registered type would inherit
    // CLEARANCE_EXECUTE_ENABLED — `true` in production — and render a live Approve button
    // its own write path had never been switched on for.
    executable: isActionExecuteEnabled(row.actionType) && row.resolvedMode !== "recommend",
    actionRunId: row.runId,
    actionType: row.actionType,
    mode,
    // The proposed default % (the knob the edit control POSTs back to reviseAction).
    markdownPercent: typeof summary.markdownPercent === "number" ? summary.markdownPercent : undefined,
    sourceRecommendation: normalizeSourceRecommendation(summary.sourceRecommendation),
  };
}

/**
 * Format a measured clearance outcome for the "what Jefe did" feed — money in the shop
 * currency plus a pre-formatted one-liner (the surface renders strings as-is).
 * @param {any} outcome  the row's stored measureClearanceOutcome result
 * @param {string} currency
 */
function formatExecutedOutcome(outcome, currency) {
  const variantsCleared = Number(outcome?.variantsCleared) || 0;
  const variantsSold = Number(outcome?.variantsSold) || 0;
  const unitsMoved = Number(outcome?.unitsMoved) || 0;
  const revenueRecovered = Number(outcome?.revenueRecovered) || 0;
  return {
    variantsCleared,
    variantsSold,
    unitsMoved,
    revenueRecovered: formatMoney(revenueRecovered, currency),
    effectivenessRatePercent: Number(outcome?.effectivenessRatePercent) || 0,
    summary: `${variantsSold} of ${variantsCleared} cleared product${variantsCleared === 1 ? "" : "s"} sold · ${unitsMoved} unit${unitsMoved === 1 ? "" : "s"} moved · ${formatMoney(revenueRecovered, currency)} recovered`,
  };
}

/**
 * A short "what Jefe did" headline for one executed CLEARANCE. Reached through the binding
 * table — an action type with no presenter gets a neutral line rather than this wording.
 * @param {string} status @param {number} variantCount @param {any} summary
 */
function clearanceExecutedHeadline(status, variantCount, summary) {
  const source = normalizeSourceRecommendation(summary?.sourceRecommendation);
  if (status === "rejected" && source?.title) return source.title;
  const noun = `${variantCount} product${variantCount === 1 ? "" : "s"}`;
  if (status === "reverted") return `Reverted a clearance on ${noun}`;
  if (status === "rejected") return `Declined a clearance on ${noun}`;
  const pct = Number.isFinite(Number(summary?.markdownPercent)) ? ` (−${Number(summary.markdownPercent)}%)` : "";
  const partial = status === "partially_applied" ? " (some skipped)" : "";
  return `Marked ${noun} down for clearance${pct}${partial}`;
}

/**
 * The action timeline feed — completed and declined actions off the action_executions
 * ledger, most recent first. Applied entries include measured outcome once Observe has
 * scored them; rejected entries include a small merchant-facing learning line stored
 * in proposalSummary at decline time.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; currency?: string; limit?: number }} input
 */
export async function getExecutedActionFeed(prisma, input) {
  const currency = input.currency || "GBP";
  const rows = await prisma.actionExecution.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      status: { in: ["applied", "partially_applied", "reverted", "rejected"] },
    },
    orderBy: [{ appliedAt: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
    take: Number.isFinite(Number(input.limit)) ? Number(input.limit) : 20,
    select: {
      runId: true,
      actionType: true,
      status: true,
      appliedAt: true,
      revertedAt: true,
      updatedAt: true,
      preview: true,
      proposalSummary: true,
      outcome: true,
      outcomeStatus: true,
    },
  });

  return rows.map((row) => {
    const preview = /** @type {any} */ (row.preview) ?? {};
    const summary = /** @type {any} */ (row.proposalSummary) ?? {};
    const variantCount = Number(summary.variantCount ?? preview.variantCount ?? 0);
    const measured =
      row.outcomeStatus === "measured" && row.outcome && typeof row.outcome === "object";
    return {
      actionRunId: row.runId,
      actionType: row.actionType,
      status: row.status,
      // This row's OWN presenter. An unrecognised type gets a neutral, honest line —
      // never "Marked N products down for clearance" for something that was not one.
      headline:
        getPrimitive(row.actionType)?.executedHeadline(row.status, variantCount, summary)
        ?? `${row.status === "rejected" ? "Declined" : row.status === "reverted" ? "Reverted" : "Completed"} an action on your store`,
      appliedAt: row.appliedAt?.toISOString?.() ?? null,
      revertedAt: row.revertedAt?.toISOString?.() ?? null,
      rejectedAt: row.status === "rejected" ? row.updatedAt?.toISOString?.() ?? null : null,
      declineLearning:
        row.status === "rejected"
          ? String(summary?.decline?.learning ?? "Jefe will avoid repeating that move without a stronger reason.")
          : null,
      sourceRecommendation: normalizeSourceRecommendation(summary.sourceRecommendation),
      baselineSignal: baselineSignalFromSummary(summary, currency),
      currentSignal: currentSignalFromOutcome(row, summary, currency),
      outcome: measured
        ? { measured: true, ...formatExecutedOutcome(/** @type {any} */ (row.outcome), currency) }
        : { measured: false },
    };
  });
}

/**
 * @param {any} summary
 * @param {string} currency
 */
function baselineSignalFromSummary(summary, currency) {
  const variants = Number(summary?.variantCount) || 0;
  const trapped = formatMoney(summary?.totalTrappedCapital, currency);
  if (variants > 0) return `${variants} product${variants === 1 ? "" : "s"} · ${trapped} tied up`;
  return null;
}

/**
 * @param {any} row
 * @param {any} summary
 * @param {string} currency
 */
function currentSignalFromOutcome(row, summary, currency) {
  if (row?.outcomeStatus !== "measured" || !row?.outcome) {
    return baselineSignalFromSummary(summary, currency);
  }
  const outcome = /** @type {any} */ (row.outcome);
  const variantsSold = Number(outcome.variantsSold) || 0;
  const recovered = formatMoney(outcome.revenueRecovered, currency);
  return `${variantsSold} sold since the move · ${recovered} recovered`;
}

/**
 * Read the granted Shopify OAuth scopes for a shop, from its offline session (the token
 * the write path actually uses). Empty when there's no offline session yet.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; shopDomain?: string }} input
 */
async function getGrantedShopifyScopes(prisma, input) {
  let domain = input.shopDomain;
  if (!domain) {
    const shop = await prisma.shop.findUnique({ where: { id: input.shopId }, select: { shopDomain: true } });
    domain = shop?.shopDomain ?? undefined;
  }
  if (!domain) return [];
  const session = await prisma.session.findFirst({
    where: { shop: domain, isOnline: false },
    orderBy: { expires: "desc" },
    select: { scope: true },
  });
  return String(session?.scope ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * The "scope-gated opportunity" signal — when Jefe has a VALUABLE action ready but the
 * merchant hasn't granted the Shopify scope it needs to execute. Drives the value-first
 * re-consent nudge (the in-app prompt + the activation email): "Jefe found £X it can
 * free for you — grant Edit-products access to let it act." Returns null when there's
 * no opportunity, the scope is already granted, or the action needs no write scope.
 *
 * Value-led by design: we only nudge when there's real money on the table (a proposable
 * clearance), so the ask reads like activation, not a bare "grant more access" request.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; shopDomain?: string; currency?: string }} input
 * @returns {Promise<{ actionType: string; missingScopes: string[]; productCount: number; trappedCapital: string; projectedRecovery: string; headline: string } | null>}
 */
export async function getScopeGatedOpportunity(prisma, input) {
  const currency = input.currency || "GBP";
  const granted = await getGrantedShopifyScopes(prisma, { shopId: input.shopId, shopDomain: input.shopDomain });

  // Every action this layer can actually propose, not just clearance. Scope-gating is
  // per-action — a merchant may have granted write_products and not write_inventory — so
  // the nudge has to name the action whose value is actually blocked.
  for (const actionType of listResolvableActionTypes()) {
    const required = getRequiredScopes(actionType);
    if (required.length === 0) continue; // no write scope needed → nothing to nudge
    const missingScopes = required.filter((scope) => !granted.includes(scope));
    if (missingScopes.length === 0) continue; // already granted → the action can just run

    // Scope check FIRST: it is a cheap array compare, while resolving hits the database.
    // The old order resolved a full proposal before discovering the scope was already
    // granted, doing the expensive half to reach "nothing to nudge".
    const primitive = getPrimitive(actionType);
    const targetKind = getActionDefinition(actionType)?.targetKinds?.[0];
    if (!primitive || !targetKind) continue;
    const resolved = await primitive.resolve(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      intent: { actionType, targetKind },
    });
    if (!resolved) continue; // no real value behind this permission → never nudge for it

    const nudge = primitive.scopeNudge({ summary: resolved.summary, currency, missingScopes });
    if (nudge) return { actionType, missingScopes, ...nudge };
  }
  return null;
}

/**
 * The clearance flavour of the value-first permission ask. Per-primitive because the ask has
 * to name what the merchant actually gets — "free the cash in these products" is meaningless
 * for a primitive that moves stock or tags a customer.
 * @param {{ summary: any; currency: string; missingScopes: string[] }} input
 */
function clearanceScopeNudge({ summary, currency }) {
  const productCount = Number(summary?.variantCount) || 0;
  if (productCount < 1) return null;
  const trapped = formatMoney(summary.totalTrappedCapital, currency);
  return {
    productCount,
    trappedCapital: trapped,
    projectedRecovery: formatMoney(summary.totalProjectedRecovery, currency),
    headline: `Jefe found ${trapped} tied up in ${productCount} product${productCount === 1 ? "" : "s"} it can clear for you — grant "Edit products" access to let it act.`,
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
    select: {
      id: true,
      runId: true,
      merchantId: true,
      shopId: true,
      status: true,
      actionType: true,
      proposalSummary: true,
    },
  });
  if (!execution || execution.merchantId !== input.merchantId) return { status: "not_found" };
  if (execution.status !== "proposed") {
    return { status: "not_proposable", currentStatus: execution.status };
  }
  const { reasonCategory, reasonText } = normalizeDeclineReason({
    reasonCategory: input.reasonCategory ?? null,
    reasonText: input.reasonText ?? input.reason ?? null,
  });
  const learning = declineLearningSentence(reasonCategory, reasonText);
  const proposalSummary = {
    ...(execution.proposalSummary && typeof execution.proposalSummary === "object"
      ? /** @type {any} */ (execution.proposalSummary)
      : {}),
    decline: {
      reasonCategory,
      reasonText,
      learning,
      recordedAt: new Date().toISOString(),
    },
  };
  const rejected = await prisma.actionExecution.update({
    where: { runId: input.actionRunId },
    data: { status: "rejected", proposalSummary },
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
 * @param {string | null} reasonCategory
 * @param {string | null} reasonText
 */
function declineLearningSentence(reasonCategory, reasonText) {
  if (reasonCategory === "discount_free") {
    return "You wanted this move kept discount-free, so Jefe will not repeat this clearance as-is.";
  }
  if (reasonCategory === "defer") {
    return "You asked to hold this move for now, so Jefe will bring back a better-timed recommendation.";
  }
  if (reasonCategory === "too_aggressive") {
    return "You said the move was too aggressive, so Jefe will be gentler next time.";
  }
  if (reasonCategory === "wrong_products") {
    return "You said the products were wrong, so Jefe will re-check the target set before suggesting this again.";
  }
  if (reasonCategory === "bad_timing") {
    return "You said the timing was wrong, so Jefe will wait for a stronger moment.";
  }
  if (reasonText) return "Jefe saved your reason and will use it when choosing the next move.";
  return "Jefe learned this was not the right move right now.";
}

/**
 * Revise a proposed action's magnitude — the "edit this suggestion" half. Re-runs the
 * proposal at the merchant's requested markdown (still floored + capped by the
 * primitive: the merchant suggests, the safety math is never overridden), creates a
 * fresh proposed row, and supersedes the old one so only the revision is active. Writes
 * nothing external. Chat 2's surface POSTs `action.edit` here.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; actionRunId: string; params?: { markdownPercent?: number; maxProducts?: number } }} input
 */
export async function reviseAction(prisma, input) {
  const existing = await prisma.actionExecution.findUnique({
    where: { runId: input.actionRunId },
    select: {
      id: true, runId: true, merchantId: true, shopId: true,
      status: true, actionType: true, actionKind: true, merchantSetting: true,
      proposalSummary: true,
    },
  });
  if (!existing || existing.merchantId !== input.merchantId) return { status: "not_found" };
  if (existing.status !== "proposed") {
    return { status: "not_revisable", currentStatus: existing.status };
  }
  const targetKind =
    existing.actionKind === "dead_stock_clearance" ? "dead_stock" : existing.actionKind;
  const markdownPercent = Number(input.params?.markdownPercent);
  const maxProducts = Number(input.params?.maxProducts);
  const params = {
    ...(Number.isFinite(markdownPercent) ? { markdownPercent } : {}),
    ...(Number.isInteger(maxProducts) && maxProducts > 0 ? { maxProducts } : {}),
  };
  const reproposed = await proposeActionFromIntent(prisma, {
    merchantId: existing.merchantId,
    shopId: existing.shopId,
    intent: {
      actionType: existing.actionType,
      targetKind,
      params: Object.keys(params).length ? params : undefined,
    },
    merchantSetting: existing.merchantSetting, // preserve the merchant's dial
    writeEnabled: isActionExecuteEnabled(existing.actionType), // this action's own flag, not clearance's
    sourceRecommendation: /** @type {any} */ (existing.proposalSummary)?.sourceRecommendation ?? null,
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
