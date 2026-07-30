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
import { buildDeadStockClearanceProposal } from "./dead-stock-clearance.server.js";
import {
  DEFAULT_CLEARANCE_CAPS,
  buildClearancePreview,
  computeClearanceAutoEligibility,
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
  const preview = buildClearancePreview(proposal);
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

/**
 * Shape the render-ready SuggestedAction for the surface. Structured numbers only
 * (the surface owns currency + voice); the headline stays currency-free (count +
 * window are facts), money goes in keyNumbers for the surface to format.
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
    topItems: preview.changes.slice(0, 3).map((c) => ({
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
  // v1 default: the autonomy dial doesn't exist yet, so default to "approve_execute" —
  // Jefe proposes, the merchant approves, Jefe executes (propose-first). When the dial
  // lands (M3) read the merchant's per-action setting here. Settings:
  // "recommend" | "approve_execute" | "autonomous" → modes recommend | approve | auto.
  const merchantSetting = input.merchantSetting ?? "approve_execute";
  const eligibility = computeClearanceAutoEligibility(preview, confidence);
  const autonomy = resolveAutonomyMode(merchantSetting, eligibility);

  const runId = randomUUID();
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
