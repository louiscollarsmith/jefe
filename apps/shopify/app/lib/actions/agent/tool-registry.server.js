// @ts-check

/**
 * Typed tool registry for the focused Action Agent.
 *
 * Two properties matter here and are enforced by construction:
 *
 * 1. **Tools are scoped to the action type.** A replenishment action is never
 *    shown `apply_change_set` or a `markdownPercent` argument, so
 *    "updated markdown to 0%" on a restock is structurally impossible.
 *
 * 2. **Every tool returns the same shape**, including a deterministic
 *    `message` and machine-readable `facts`/`changes` computed by application
 *    code — not by the model. Response grounding reads only that ledger, which
 *    is what makes "Done." with no work impossible to emit.
 */

import { logger as baseLogger } from "../../observability/logger.server.js";
import { ACTION_COMMAND } from "../action-command.server.js";
import { resolveActionState } from "../action-state.server.js";
import { allowedPlanFields } from "../action-plan-schema.server.js";
import { reachCapability, runAssistStepById } from "./assist-runner.server.js";
import { recommendedPurchaseUnits } from "../action-capability.server.js";
import { normalizeMatch } from "../action-constraint.server.js";
import {
  SCOPE_STATUS,
  discoverListingCopyScope,
  emptyProposalMessage,
  formatListingCopyProposalSummary,
  persistListingCopyScope,
} from "../listing-copy-scope.server.js";

const log = baseLogger.child({ component: "action-agent-tools" });

export const TOOL_SCHEMA_VERSION = "2";

/** Effect classes. Only the last three can ground a success claim. */
export const TOOL_EFFECT = Object.freeze({
  read: "read",
  stateChange: "state_change",
  artifact: "artifact",
  externalWrite: "external_write",
});

/**
 * @typedef {Object} ToolResult
 * @property {string} tool
 * @property {boolean} ok
 * @property {string} effect
 * @property {string} message deterministic, application-authored
 * @property {Record<string, any>} facts
 * @property {Array<Record<string, any>>} changes
 * @property {any} artifact
 * @property {{ code: string; message: string; retryable?: boolean } | null} error
 * @property {{ code: string; message: string; needs?: any } | null} blocked
 */

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                            */
/* -------------------------------------------------------------------------- */

/** @type {Record<string, any>} */
const TOOLS = {
  get_action_state: {
    effect: TOOL_EFFECT.read,
    kinds: "*",
    description:
      "Read everything currently true about this action: plan values, scope, exclusions, work states, artifacts and staleness.",
    args: {},
    async run(/** @type {any} */ ctx) {
      const state = await ctx.reloadState();
      return ok("get_action_state", {
        effect: TOOL_EFFECT.read,
        message: "Loaded the current action state.",
        facts: snapshotFacts(state),
      });
    },
  },

  inspect_scope: {
    effect: TOOL_EFFECT.read,
    kinds: "*",
    description: "List which products are currently in scope and which are excluded, and why.",
    args: {},
    async run(/** @type {any} */ ctx) {
      const state = await ctx.reloadState();
      const included = scopeLines(state);
      const excluded = excludedTitles(state);
      const status = state?.scope?.status ?? null;
      return ok("inspect_scope", {
        effect: TOOL_EFFECT.read,
        message:
          status === SCOPE_STATUS.unresolved
            ? "Product scope has not been discovered yet for this action."
            : included.length
              ? `In scope: ${included.map((/** @type {any} */ row) => row.title).join(", ")}.${
                  excluded.length ? ` Excluded: ${excluded.join(", ")}.` : ""
                }`
              : excluded.length
                ? `Nothing is currently in scope. Excluded: ${excluded.join(", ")}.`
                : "Nothing is currently in scope for this action.",
        facts: { included, excluded, scopeStatus: status },
      });
    },
  },

  inspect_current_proposal: {
    effect: TOOL_EFFECT.read,
    kinds: "*",
    description:
      "Read the current proposal — what Jefe would do right now given the live plan, scope and constraints. Always available, even before any step has run.",
    args: {},
    async run(/** @type {any} */ ctx) {
      const state = await ctx.reloadState();
      const proposal = buildCurrentProposal(state);
      if (!proposal.lines.length) {
        return ok("inspect_current_proposal", {
          effect: TOOL_EFFECT.read,
          message: emptyProposalMessage(state),
          facts: {
            proposal: null,
            scopeStatus: state?.scope?.status ?? null,
            ...planFacts(state),
          },
        });
      }
      return ok("inspect_current_proposal", {
        effect: TOOL_EFFECT.read,
        message: proposal.summary,
        facts: { proposal: proposal.lines, ...planFacts(state) },
        artifact: { type: proposal.type, title: proposal.title, lines: proposal.lines },
      });
    },
  },

  inspect_history: {
    effect: TOOL_EFFECT.read,
    kinds: "*",
    description:
      "Read how this action has changed: plan revisions, scope changes and completed work, oldest first.",
    args: {},
    async run(/** @type {any} */ ctx) {
      const history = await ctx.loadHistory();
      if (!history.length) {
        return ok("inspect_history", {
          effect: TOOL_EFFECT.read,
          message: "Nothing has changed on this action yet.",
          facts: { history },
        });
      }

      const first = history[0] ?? {};
      const last = history[history.length - 1] ?? {};

      /** @type {any[]} */
      const firstChanges = Array.isArray(first.changes) ? first.changes : [];
      /** @type {any} */
      const firstResulting = first.resulting ?? {};
      /** @type {any} */
      const current = last.resulting ?? {};

      // Prefer persisted truth (`before`) to reconstructing original state.
      // Fall back to inversion only for legacy revisions.
      let original = first.before ?? null;
      if (!original) {
        original = { ...firstResulting };
        for (const change of firstChanges) {
          if (change?.field === "coverDays" && change.from != null) {
            original.coverDays = change.from;
          }
          if (change?.field === "excluded" && typeof change.added === "string") {
            const title = change.added;
            original.excluded = (original.excluded ?? []).filter((t) => t !== title);
            original.included = Array.isArray(original.included)
              ? [...new Set([...(original.included ?? []), title])]
              : [title];
          }
          if (change?.field === "included" && typeof change.added === "string") {
            const title = change.added;
            original.included = (original.included ?? []).filter((t) => t !== title);
            original.excluded = Array.isArray(original.excluded)
              ? [...new Set([...(original.excluded ?? []), title])]
              : [title];
          }
        }
      }

      const includedList = Array.isArray(original.included) ? original.included.join(" + ") : "";
      const currentIncludedList = Array.isArray(current.included)
        ? current.included.join(" + ")
        : "";
      const originalCover = original.coverDays != null ? Number(original.coverDays) : null;
      const currentCover = current.coverDays != null ? Number(current.coverDays) : null;

      const narrativeParts = [];
      narrativeParts.push(
        originalCover != null && includedList
          ? `Originally the recommendation covered ${includedList} at ${originalCover}-day cover.`
          : originalCover != null
            ? `Originally the recommendation used ${originalCover}-day cover.`
            : "Originally the recommendation was different.",
      );

      // Chronological, from oldest→newest.
      for (const rev of history) {
        const changes = Array.isArray(rev.changes) ? rev.changes : [];
        for (const change of changes) {
          if (change?.field === "coverDays") {
            const to = change.to;
            if (to != null) narrativeParts.push(`You moved to ${to}-day cover.`);
          }
          if (change?.field === "excluded" && typeof change.added === "string") {
            narrativeParts.push(`You removed ${change.added}.`);
          }
          if (change?.field === "included" && typeof change.added === "string") {
            narrativeParts.push(`You added ${change.added} back into scope.`);
          }
        }
      }

      if (currentCover != null && currentIncludedList) {
        narrativeParts.push(
          `The current proposal is ${currentIncludedList} at ${currentCover}-day cover.`,
        );
      } else if (currentCover != null) {
        narrativeParts.push(`The current proposal uses ${currentCover}-day cover.`);
      }

      return ok("inspect_history", {
        effect: TOOL_EFFECT.read,
        message: narrativeParts.join(" "),
        facts: { history },
      });
    },
  },

  simulate_plan: {
    effect: TOOL_EFFECT.read,
    kinds: "*",
    description:
      "Work out what a different plan value would produce WITHOUT saving it. Use for 'what would X look like', 'what if', and any request that says not to change anything yet.",
    args: {
      coverDays: { type: "number", min: 1, max: 730, kinds: ["restock", "generic"] },
      markdownPercent: { type: "number", min: 0, max: 90, kinds: ["markdown", "generic"] },
    },
    requiresOneOf: ["coverDays", "markdownPercent"],
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      const state = await ctx.reloadState();
      const simulated = simulateProposal(state, args);
      if (!simulated) {
        return fail("simulate_plan", {
          code: "NOTHING_TO_SIMULATE",
          message: "I don't have inventory figures to simulate against for this action.",
        });
      }
      return ok("simulate_plan", {
        effect: TOOL_EFFECT.read,
        message: simulated.summary,
        facts: {
          simulated: simulated.lines,
          simulatedWith: args,
          persistedPlanUnchanged: planFacts(state),
        },
        artifact: { type: "simulation", title: simulated.title, lines: simulated.lines },
      });
    },
  },

  update_plan: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Persist a change to this action's plan values. Only use when the merchant wants the change kept.",
    args: {
      coverDays: { type: "number", min: 1, max: 730, kinds: ["restock", "generic"] },
      markdownPercent: { type: "number", min: 0, max: 90, kinds: ["markdown", "generic"] },
      maxProducts: { type: "number", min: 1, max: 500 },
    },
    requiresOneOf: ["coverDays", "markdownPercent", "maxProducts"],
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      return ctx.runCommandWithDiff("update_plan", ACTION_COMMAND.REVISE_PLAN, {
        coverDays: args.coverDays,
        markdownPercent: args.markdownPercent,
        maxProducts: args.maxProducts,
      });
    },
  },

  exclude_product: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Take one product out of this action's scope. Use for 'leave X out', 'don't touch X', 'forget X for this one'.",
    args: { productTitle: { type: "string", required: true } },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      const resolvedTitle = ctx.resolveProductTitle(args.productTitle);
      if (resolvedTitle.ambiguous) {
        return needsClarification("exclude_product", resolvedTitle.question, resolvedTitle.candidates);
      }
      if (!resolvedTitle.title) {
        return fail("exclude_product", {
          code: "UNKNOWN_PRODUCT",
          message: `I couldn't find "${args.productTitle}" among the products on this action.`,
        });
      }
      return ctx.runCommandWithDiff("exclude_product", ACTION_COMMAND.ADD_CONSTRAINT, {
        scopeModification: { intent: "exclude_product", title: resolvedTitle.title },
        productTitle: resolvedTitle.title,
      });
    },
  },

  restrict_to_products: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Narrow this action to only the named products, excluding everything else. Use for 'only do X', 'just X'.",
    args: { productTitle: { type: "string", required: true } },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      const resolvedTitle = ctx.resolveProductTitle(args.productTitle);
      if (resolvedTitle.ambiguous) {
        return needsClarification(
          "restrict_to_products",
          resolvedTitle.question,
          resolvedTitle.candidates,
        );
      }
      if (!resolvedTitle.title) {
        return fail("restrict_to_products", {
          code: "UNKNOWN_PRODUCT",
          message: `I couldn't find "${args.productTitle}" among the products on this action.`,
        });
      }
      return ctx.runCommandWithDiff("restrict_to_products", ACTION_COMMAND.ADD_CONSTRAINT, {
        scopeModification: { intent: "include_only", title: resolvedTitle.title },
        productTitle: resolvedTitle.title,
      });
    },
  },

  include_product_again: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Put a previously excluded product back into scope. Use for 'put X back', 'add X again', 'undo excluding X'.",
    args: { productTitle: { type: "string" } },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      const excluded = excludedTitles(ctx.state);
      let title = args.productTitle ? ctx.resolveProductTitle(args.productTitle).title : null;
      if (!title && excluded.length === 1) title = excluded[0];
      if (!title) {
        return fail("include_product_again", {
          code: "UNKNOWN_PRODUCT",
          message: excluded.length
            ? `Which one should I put back — ${excluded.join(" or ")}?`
            : "Nothing is currently excluded from this action.",
        });
      }
      const constraint = ctx.findExclusionConstraint(title);
      if (!constraint) {
        return fail("include_product_again", {
          code: "NOT_EXCLUDED",
          message: `${title} is already in scope.`,
        });
      }
      return ctx.runCommandWithDiff("include_product_again", ACTION_COMMAND.REMOVE_CONSTRAINT, {
        constraintId: constraint.id,
        productTitle: title,
      });
    },
  },

  add_rule: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Add a durable scope rule that is not about a single product — e.g. exclude archived products, exclude a collection or tag.",
    args: {
      constraintKind: { type: "string", required: true },
      collectionTitle: { type: "string" },
      tag: { type: "string" },
      minInventory: { type: "number", min: 0 },
      minPrice: { type: "number", min: 0 },
    },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      return ctx.runCommandWithDiff("add_rule", ACTION_COMMAND.ADD_CONSTRAINT, {
        constraintKind: args.constraintKind,
        collectionTitle: args.collectionTitle,
        tag: args.tag,
        minInventory: args.minInventory,
        minPrice: args.minPrice,
      });
    },
  },

  remove_rule: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description: "Remove an existing scope rule by its id.",
    args: { constraintId: { type: "string", required: true } },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      return ctx.runCommandWithDiff("remove_rule", ACTION_COMMAND.REMOVE_CONSTRAINT, {
        constraintId: args.constraintId,
      });
    },
  },

  accept_plan: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description: "Accept the proposed plan so work can begin. Only when the merchant clearly agrees.",
    args: {},
    async run(/** @type {any} */ ctx) {
      return ctx.runCommandWithDiff("accept_plan", ACTION_COMMAND.ACCEPT_PLAN, {});
    },
  },

  skip_work: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Mark a piece of work as skipped because the merchant will handle it themselves or does not want it.",
    args: { stepId: { type: "string" } },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      return ctx.runCommandWithDiff("skip_work", ACTION_COMMAND.SKIP_STEP, { stepId: args.stepId });
    },
  },

  /* ----------------------------- restock only ----------------------------- */

  calculate_replenishment: {
    effect: TOOL_EFFECT.artifact,
    kinds: ["restock"],
    description:
      "Run the inventory review that works out reorder quantities from cover target, velocity and stock on hand.",
    args: {},
    async run(/** @type {any} */ ctx) {
      return ctx.reachCapabilityTool("calculate_replenishment", "assist:inventory_review");
    },
  },

  build_replenishment_proposal: {
    effect: TOOL_EFFECT.artifact,
    kinds: ["restock"],
    description:
      "Produce the replenishment proposal. Automatically runs the inventory review first if it is missing or out of date.",
    args: {},
    async run(/** @type {any} */ ctx) {
      return ctx.reachCapabilityTool(
        "build_replenishment_proposal",
        "assist:replenishment_proposal",
      );
    },
  },

  draft_supplier_email: {
    effect: TOOL_EFFECT.artifact,
    kinds: ["restock"],
    description:
      "Draft the supplier message for the current proposal. Automatically rebuilds the proposal first if it is out of date.",
    args: {},
    async run(/** @type {any} */ ctx) {
      return ctx.reachCapabilityTool("draft_supplier_email", "assist:supplier_email_draft");
    },
  },

  /* --------------------------- listing_copy only --------------------------- */

  discover_product_type_scope: {
    effect: TOOL_EFFECT.stateChange,
    kinds: ["listing_copy"],
    description:
      "Discover sellable products currently missing product types and propose types from the merchant's existing catalogue vocabulary. Safe read-only against the local catalog mirror — use before showing a proposal when scope is unresolved.",
    args: {},
    async run(/** @type {any} */ ctx) {
      const before = planFacts(ctx.state);
      const discovered = await discoverListingCopyScope(ctx.prisma, {
        merchantId: ctx.merchantId,
        shopId: ctx.shopId,
        maxProducts: ctx.state?.plan?.values?.maxProducts ?? null,
      });
      if (!discovered.ok) {
        return fail("discover_product_type_scope", {
          code: "DISCOVERY_UNAVAILABLE",
          message: "I couldn't read the product catalog to discover missing product types.",
        });
      }

      const persisted = await persistListingCopyScope(ctx.prisma, {
        merchantId: ctx.merchantId,
        shopId: ctx.shopId,
        actionId: ctx.actionId,
        preview: discovered.preview,
        discovery: discovered.discovery,
      });
      if (!persisted.ok) {
        return fail("discover_product_type_scope", {
          code: "PERSIST_FAILED",
          message: "I found products but couldn't save the discovered scope for this action.",
        });
      }

      const state = await ctx.reloadState();
      const proposal = buildCurrentProposal(state);
      const after = planFacts(state);
      const changes = diffFacts(before, after);
      const original = state?.scope?.originalEvidence ?? null;
      const originalCount = Number(original?.productCount ?? 0);
      const currentCount = proposal.lines.length;
      const historyNote =
        originalCount > 0 && originalCount !== currentCount
          ? ` Originally ${originalCount} product${originalCount === 1 ? "" : "s"}; ${currentCount} remain eligible now.`
          : "";

      if (!proposal.lines.length) {
        return ok("discover_product_type_scope", {
          effect: TOOL_EFFECT.stateChange,
          message: `I checked the current catalog and found no eligible products missing product types.${historyNote}`,
          facts: {
            scopeStatus: state?.scope?.status ?? null,
            unresolved: discovered.unresolved,
            discovery: discovered.discovery,
            ...after,
          },
          changes,
        });
      }

      return ok("discover_product_type_scope", {
        effect: TOOL_EFFECT.stateChange,
        message: `Found ${proposal.lines.length} product${proposal.lines.length === 1 ? "" : "s"} missing product types.${historyNote} ${formatListingCopyProposalSummary(proposal.lines)}`,
        facts: {
          scopeStatus: state?.scope?.status ?? null,
          proposal: proposal.lines,
          unresolved: discovered.unresolved,
          discovery: discovered.discovery,
          ...after,
        },
        changes,
        artifact: { type: proposal.type, title: proposal.title, lines: proposal.lines },
      });
    },
  },

  /* ---------------------------- write actions ----------------------------- */

  build_change_set: {
    effect: TOOL_EFFECT.artifact,
    kinds: ["markdown", "listing_copy", "tidy_up"],
    description:
      "Build the exact set of Shopify changes for review. This never touches Shopify — use it for 'show me what would change'. For product-type actions, discovers scope first when needed.",
    args: {},
    async run(/** @type {any} */ ctx) {
      if (ctx.kind === "listing_copy") {
        const current = ctx.state ?? (await ctx.reloadState());
        if (current?.scope?.status === SCOPE_STATUS.unresolved) {
          const discovered = await runTool(ctx, "discover_product_type_scope", {});
          if (!discovered.ok) return discovered;
          await ctx.reloadState();
        }
      }
      return ctx.runCommandWithDiff("build_change_set", ACTION_COMMAND.CREATE_CHANGESET, {});
    },
  },

  apply_change_set: {
    effect: TOOL_EFFECT.externalWrite,
    kinds: ["markdown", "listing_copy", "tidy_up"],
    description:
      "Apply the current reviewed Change Set to Shopify. Only when the merchant explicitly approves applying it. Never as part of the same request that changed the plan.",
    args: {},
    requiresExplicitApproval: true,
    async run(/** @type {any} */ ctx) {
      const executed = await ctx.runCommand(ACTION_COMMAND.APPLY_CHANGESET, {
        explicitApply: true,
      });
      const status = String(executed.changeSet?.status ?? "");
      const wrote = status === "applied" || status === "partial";

      // An external write is only claimable once the change set records that
      // it happened. "approved", "applying" and "queued" are not "applied".
      if (!executed.ok || !wrote) {
        return fail("apply_change_set", {
          code: String(executed.reason ?? "NOT_APPLIED").toUpperCase(),
          message:
            executed.reply ??
            "I couldn't apply those changes to your store. Nothing has been written.",
          retryable: true,
        });
      }
      return ok("apply_change_set", {
        effect: TOOL_EFFECT.externalWrite,
        message: executed.reply ?? "Applied the change set to your store.",
        facts: {
          changeSetId: executed.changeSet?.id ?? null,
          changeSetStatus: status,
          result: executed.result ?? executed.changeSet?.result ?? null,
        },
        changes: [{ field: "shopify", to: status }],
        artifact: null,
      });
    },
  },

  report_execution: {
    effect: TOOL_EFFECT.read,
    kinds: "*",
    description: "Read what was actually executed against Shopify and what the result was.",
    args: {},
    async run(/** @type {any} */ ctx) {
      const executed = await ctx.runCommand(ACTION_COMMAND.REPORT_EXECUTION, {});
      return ok("report_execution", {
        effect: TOOL_EFFECT.read,
        message: executed.reply ?? "No execution has been recorded for this action.",
        facts: { execution: executed.result ?? null },
      });
    },
  },

  run_work_item: {
    effect: TOOL_EFFECT.artifact,
    kinds: "*",
    description:
      "Run one named piece of Jefe-owned work by its id. Prefer the outcome tools above; use this only when the merchant names a specific step.",
    args: { stepId: { type: "string", required: true } },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      const result = await runAssistStepById(ctx.prisma, {
        merchantId: ctx.merchantId,
        shopId: ctx.shopId,
        actionId: ctx.actionId,
        stepId: args.stepId,
        actor: ctx.actor,
        conversationId: ctx.conversationId,
        logger: ctx.logger,
      });
      return assistResultToTool("run_work_item", result, await ctx.reloadState());
    },
  },

  add_plan_step: {
    effect: TOOL_EFFECT.stateChange,
    kinds: "*",
    description:
      "Add a new step to this action's plan. Use when the merchant wants to extend the workflow with an additional piece of work — for example 'add a step to create a Shopify transfer'. The step is persisted to the plan, not simulated.",
    args: {
      title: { type: "string", required: true },
      description: { type: "string" },
      capabilityRef: { type: "string" },
      mode: { type: "string" },
    },
    async run(/** @type {any} */ ctx, /** @type {any} */ args) {
      return ctx.runCommandWithDiff("add_plan_step", ACTION_COMMAND.ADD_PLAN_STEP, {
        title: args.title,
        description: args.description,
        capabilityRef: args.capabilityRef,
        mode: args.mode,
      });
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Per-action-type tool sets                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} kind action runtime kind
 * @returns {string[]} tool names this action type may use
 */
export function toolNamesForKind(kind) {
  return Object.entries(TOOLS)
    .filter(([, def]) => def.kinds === "*" || def.kinds.includes(kind))
    .map(([name]) => name);
}

/**
 * Tool documentation for the planner prompt, already narrowed to this action
 * type. Arguments that do not apply to the kind are not shown.
 *
 * @param {string} kind
 */
export function toolCatalogueForKind(kind) {
  return toolNamesForKind(kind).map((name) => {
    const def = TOOLS[name];
    const args = Object.entries(def.args ?? {})
      .filter(([, spec]) => !spec.kinds || spec.kinds.includes(kind))
      .map(([argName, spec]) => ({
        name: String(argName),
        type: String(spec.type ?? "string"),
        required: spec.required === true,
      }));
    return {
      name,
      effect: def.effect,
      description: def.description,
      arguments: args,
    };
  });
}

/**
 * Validate one proposed call before anything runs. Rejections are returned to
 * the model as tool results so it can correct itself — never hidden.
 *
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {string} kind
 */
export function validateToolCall(name, args, kind) {
  const def = TOOLS[name];
  if (!def) {
    return { ok: false, code: "UNKNOWN_TOOL", message: `There is no tool called "${name}".` };
  }
  if (def.kinds !== "*" && !def.kinds.includes(kind)) {
    return {
      ok: false,
      code: "TOOL_NOT_AVAILABLE",
      message: `"${name}" does not apply to this kind of action.`,
    };
  }

  /** @type {Record<string, any>} */
  const clean = {};
  /** @type {string[]} */
  const rejected = [];
  const planFields = allowedPlanFields(kind);

  for (const [key, raw] of Object.entries(args ?? {})) {
    const spec = (def.args ?? {})[key];
    if (!spec) {
      rejected.push(key);
      continue;
    }
    if (spec.kinds && !spec.kinds.includes(kind)) {
      rejected.push(key);
      continue;
    }
    if (raw == null) continue;
    if (spec.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          code: "INVALID_ARGUMENT",
          message: `"${key}" must be a number.`,
        };
      }
      if (spec.min != null && value < spec.min) {
        return {
          ok: false,
          code: "INVALID_ARGUMENT",
          message: `"${key}" must be at least ${spec.min}.`,
        };
      }
      if (spec.max != null && value > spec.max) {
        return {
          ok: false,
          code: "INVALID_ARGUMENT",
          message: `"${key}" must be ${spec.max} or less.`,
        };
      }
      clean[key] = value;
      continue;
    }
    const text = String(raw).trim();
    if (text) clean[key] = text;
  }

  // Belt and braces: a plan field that leaked past the arg spec still cannot
  // reach a plan write for the wrong action type.
  for (const key of ["coverDays", "markdownPercent", "maxProducts"]) {
    if (key in clean && (def.args ?? {})[key] && !planFields.has(key) && name === "update_plan") {
      delete clean[key];
      rejected.push(key);
    }
  }

  if (Array.isArray(def.requiresOneOf) && !def.requiresOneOf.some((/** @type {string} */ key) => key in clean)) {
    return {
      ok: false,
      code: "MISSING_ARGUMENT",
      message: rejected.length
        ? `${rejected.map((key) => `"${key}"`).join(", ")} ${
            rejected.length === 1 ? "does" : "do"
          } not apply to this action. Give one of: ${def.requiresOneOf.join(", ")}.`
        : `"${name}" needs one of: ${def.requiresOneOf.join(", ")}.`,
    };
  }

  for (const [key, spec] of Object.entries(def.args ?? {})) {
    if (spec.required && !(key in clean)) {
      return {
        ok: false,
        code: "MISSING_ARGUMENT",
        message: `"${name}" needs "${key}".`,
      };
    }
  }

  return { ok: true, args: clean, rejected, def };
}

/**
 * Execute one validated tool call.
 *
 * @param {any} ctx tool context (see agent-loop)
 * @param {string} name
 * @param {Record<string, any>} args
 * @returns {Promise<ToolResult>}
 */
export async function runTool(ctx, name, args) {
  const validated = validateToolCall(name, args, ctx.kind);
  if (!validated.ok) {
    return fail(name, {
      code: String(validated.code ?? "INVALID_TOOL_CALL"),
      message: String(validated.message ?? "That call wasn't valid."),
    });
  }
  try {
    const result = await TOOLS[name].run(ctx, validated.args);
    return { ...result, tool: name, args: validated.args };
  } catch (error) {
    ctx.logger?.error?.("action tool threw", {
      tool: name,
      actionId: ctx.actionId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return fail(name, {
      code: "TOOL_THREW",
      message: "Something went wrong on my side running that. Nothing was changed.",
      retryable: true,
    });
  }
}

/** @param {string} name */
export function toolEffect(name) {
  return TOOLS[name]?.effect ?? TOOL_EFFECT.read;
}

/** @param {string} name */
export function toolRequiresExplicitApproval(name) {
  return TOOLS[name]?.requiresExplicitApproval === true;
}

/* -------------------------------------------------------------------------- */
/* Result constructors                                                         */
/* -------------------------------------------------------------------------- */

/** @param {string} tool @param {Partial<ToolResult>} rest @returns {ToolResult} */
export function ok(tool, rest) {
  return {
    tool,
    ok: true,
    effect: rest.effect ?? TOOL_EFFECT.read,
    message: rest.message ?? "",
    facts: rest.facts ?? {},
    changes: rest.changes ?? [],
    artifact: rest.artifact ?? null,
    error: null,
    blocked: null,
  };
}

/** @param {string} tool @param {{ code: string; message: string; retryable?: boolean }} error @returns {ToolResult} */
export function fail(tool, error) {
  return {
    tool,
    ok: false,
    effect: TOOL_EFFECT.read,
    message: error.message,
    facts: {},
    changes: [],
    artifact: null,
    error: { code: error.code, message: error.message, retryable: error.retryable === true },
    blocked: null,
  };
}

/** @param {string} tool @param {{ code: string; message: string; needs?: any }} blocked @returns {ToolResult} */
export function blockedResult(tool, blocked) {
  return {
    tool,
    ok: false,
    effect: TOOL_EFFECT.read,
    message: blocked.message,
    facts: {},
    changes: [],
    artifact: null,
    error: null,
    blocked: { code: blocked.code, message: blocked.message, needs: blocked.needs ?? null },
  };
}

/** @param {string} tool @param {string} question @param {any[]} candidates @returns {ToolResult} */
function needsClarification(tool, question, candidates) {
  return {
    ...blockedResult(tool, { code: "AMBIGUOUS", message: question, needs: candidates }),
    // Surfaced by the loop as NEEDS_CLARIFICATION rather than a failure.
    facts: { clarificationQuestion: question, candidates },
  };
}

/* -------------------------------------------------------------------------- */
/* Fact extraction — the grounding source of truth                             */
/* -------------------------------------------------------------------------- */

/** @param {any} state */
export function planFacts(state) {
  const values = state?.plan?.values ?? {};
  return {
    coverDays: values.coverDays ?? null,
    markdownPercent: values.markdownPercent ?? null,
    maxProducts: values.maxProducts ?? null,
    scopeStatus: state?.scope?.status ?? null,
    included: scopeLines(state).map((/** @type {any} */ row) => row.title),
    excluded: excludedTitles(state),
  };
}

/** @param {any} state */
export function workflowStepTitles(state) {
  return (state?.work ?? [])
    .map((/** @type {any} */ row) => String(row.step?.title ?? "").trim())
    .filter(Boolean);
}

/** @param {any} state */
export function snapshotFacts(state) {
  return {
    ...planFacts(state),
    lifecycle: state?.lifecycle ?? null,
    proposal: buildCurrentProposal(state).lines,
    work: (state?.work ?? []).map((/** @type {any} */ row) => ({
      stepId: row.step.id,
      title: row.step.title,
      state: row.state,
      stale: row.stale === true,
    })),
    artifacts: state?.artifacts ?? [],
  };
}

/** @param {any} state */
export function scopeLines(state) {
  return (state?.scope?.items ?? []).map((/** @type {any} */ item) => ({
    title: item.title ?? item.productTitle ?? "Item",
    units: item.recommendedUnits ?? null,
    available: item.available ?? null,
    dailyVelocity: item.dailyVelocity ?? null,
    fromPrice: item.fromPrice ?? null,
    toPrice: item.toPrice ?? null,
    fromType: item.fromType ?? null,
    toType: item.toType ?? item.proposedType ?? null,
    confidence: item.confidence ?? null,
    because: item.because ?? item.reason ?? null,
  }));
}

/** @param {any} state */
export function excludedTitles(state) {
  return (state?.scope?.excluded ?? [])
    .map((/** @type {any} */ item) => String(item.title ?? "").trim())
    .filter(Boolean);
}

/**
 * The current proposal, always derivable from live plan + scope. This is what
 * makes "what's the proposal?" answerable at any time, including before any
 * step has run.
 *
 * @param {any} state
 */
export function buildCurrentProposal(state) {
  const kind = state?.action?.kind ?? "generic";
  const items = scopeLines(state);
  const values = state?.plan?.values ?? {};

  if (kind === "restock") {
    const lines = items
      .filter((/** @type {any} */ row) => row.units != null)
      .map((/** @type {any} */ row) => ({ title: row.title, units: row.units }));
    const title = values.coverDays != null ? `Proposal (${values.coverDays}-day cover)` : "Proposal";
    return {
      type: "replenishment_proposal",
      title,
      lines,
      summary: lines.length
        ? `Current proposal: ${lines
            .map((/** @type {any} */ row) => `${row.title} — ${row.units} units`)
            .join("; ")}${values.coverDays != null ? ` at ${values.coverDays}-day cover` : ""}.`
        : "There is nothing to reorder in the current scope.",
    };
  }

  if (kind === "listing_copy") {
    const lines = items
      .filter((/** @type {any} */ row) => row.toType)
      .map((/** @type {any} */ row) => ({
        title: row.title,
        fromType: row.fromType || "none",
        toType: row.toType,
        confidence: row.confidence ?? null,
        because: row.because ?? null,
      }));
    return {
      type: "product_type_proposal",
      title: "Proposed product types",
      lines,
      summary: lines.length
        ? formatListingCopyProposalSummary(lines)
        : emptyProposalMessage(state),
    };
  }

  const lines = items.map((/** @type {any} */ row) => ({
    title: row.title,
    fromPrice: row.fromPrice,
    toPrice: row.toPrice,
  }));
  return {
    type: "change_preview",
    title: values.markdownPercent != null ? `Proposal (${values.markdownPercent}% off)` : "Proposal",
    lines,
    summary: lines.length
      ? `Current proposal covers ${lines.length} product${lines.length === 1 ? "" : "s"}${
          values.markdownPercent != null ? ` at ${values.markdownPercent}% off` : ""
        }.`
      : "There is nothing in the current proposal.",
  };
}

/**
 * Hypothetical quantities. Deliberately pure: it reads state and returns
 * numbers, and cannot write anything.
 *
 * @param {any} state
 * @param {{ coverDays?: number; markdownPercent?: number }} args
 */
export function simulateProposal(state, args) {
  const items = state?.scope?.items ?? [];
  if (!items.length) return null;

  if (args.coverDays != null) {
    const coverDays = Number(args.coverDays);
    const lines = items.map((/** @type {any} */ item) => ({
      title: item.title ?? item.productTitle ?? "Item",
      units: recommendedPurchaseUnits(
        { available: item.available ?? 0, dailyVelocity: item.dailyVelocity },
        coverDays,
      ),
    }));
    const current = state?.plan?.values?.coverDays ?? null;
    return {
      title: `If cover were ${coverDays} days`,
      lines,
      summary: `At ${coverDays} days of cover: ${lines
        .map((/** @type {any} */ row) => `${row.title} — ${row.units} units`)
        .join("; ")}.${current != null ? ` The saved plan is still ${current} days.` : ""}`,
    };
  }

  if (args.markdownPercent != null) {
    const markdownPercent = Number(args.markdownPercent);
    const lines = items.map((/** @type {any} */ item) => {
      const from = Number(item.fromPrice);
      const to = Number.isFinite(from)
        ? Math.round(from * (1 - markdownPercent / 100) * 100) / 100
        : null;
      return { title: item.title ?? "Item", fromPrice: item.fromPrice ?? null, toPrice: to };
    });
    const current = state?.plan?.values?.markdownPercent ?? null;
    return {
      title: `If markdown were ${markdownPercent}%`,
      lines,
      summary: `At ${markdownPercent}% off, ${lines.length} product${
        lines.length === 1 ? "" : "s"
      } would change.${current != null ? ` The saved plan is still ${current}%.` : ""}`,
    };
  }

  return null;
}

/**
 * Diff two fact snapshots into merchant-legible changes. This — not the
 * model — is what a success sentence is allowed to claim.
 *
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 */
export function diffFacts(before, after) {
  /** @type {Array<Record<string, any>>} */
  const changes = [];
  for (const field of ["coverDays", "markdownPercent", "maxProducts"]) {
    if (before[field] !== after[field] && after[field] != null) {
      changes.push({ field, from: before[field] ?? null, to: after[field] });
    }
  }
  const addedExclusions = (after.excluded ?? []).filter(
    (/** @type {string} */ title) => !(before.excluded ?? []).includes(title),
  );
  const removedExclusions = (before.excluded ?? []).filter(
    (/** @type {string} */ title) => !(after.excluded ?? []).includes(title),
  );
  for (const title of addedExclusions) changes.push({ field: "excluded", added: title });
  for (const title of removedExclusions) changes.push({ field: "included", added: title });
  if (before.lifecycle !== after.lifecycle && after.lifecycle) {
    changes.push({ field: "status", from: before.lifecycle ?? null, to: after.lifecycle });
  }
  const beforeSteps = before.workStepTitles ?? [];
  const afterSteps = after.workStepTitles ?? [];
  for (const title of afterSteps.filter((/** @type {string} */ t) => !beforeSteps.includes(t))) {
    changes.push({ field: "plan_step_added", added: title });
  }
  for (const title of beforeSteps.filter((/** @type {string} */ t) => !afterSteps.includes(t))) {
    changes.push({ field: "plan_step_removed", removed: title });
  }
  return changes;
}

/** @param {Array<Record<string, any>>} changes */
export function describeChanges(changes) {
  return changes
    .map((change) => {
      if (change.field === "coverDays") return `cover target is now ${change.to} days`;
      if (change.field === "markdownPercent") return `markdown is now ${change.to}%`;
      if (change.field === "maxProducts") return `scope is now the top ${change.to} products`;
      if (change.field === "excluded") return `${change.added} is excluded`;
      if (change.field === "included") return `${change.added} is back in scope`;
      if (change.field === "status") return `the action is now ${String(change.to).replace(/_/g, " ")}`;
      if (change.field === "plan_step_added") return `added "${change.added}" to the plan`;
      if (change.field === "plan_step_removed") return `removed "${change.removed}" from the plan`;
      return null;
    })
    .filter(Boolean);
}

/**
 * @param {string} tool
 * @param {any} result assist-runner result
 * @param {any} state post-run canonical state
 * @returns {ToolResult}
 */
export function assistResultToTool(tool, result, state) {
  if (!result.ok) {
    if (result.code === "MERCHANT_INPUT_REQUIRED" || result.code === "PLAN_NOT_ACCEPTED") {
      return blockedResult(tool, {
        code: result.code,
        message: result.message,
        needs: result.blockers ?? null,
      });
    }
    return fail(tool, {
      code: result.code ?? "ASSIST_FAILED",
      message: result.message ?? "I couldn't finish that.",
      retryable: result.retryable === true,
    });
  }

  const artifact = normalizeArtifact(result.artifact);
  if (artifactIsEmpty(artifact)) {
    // The handler ran but produced nothing usable. Completing a step is not the
    // same as producing a result, and only the second one is worth claiming.
    return blockedResult(tool, {
      code: "NO_OUTPUT",
      message:
        artifact?.summary ??
        `I ran "${result.title ?? "that work"}" but it didn't produce anything usable.`,
    });
  }

  const proposal = buildCurrentProposal(state);
  const ranTitles = (result.ran ?? [])
    .filter((/** @type {any} */ row) => row.ok && !row.alreadyCurrent && !row.deduplicated)
    .map((/** @type {any} */ row) => row.title)
    .filter(Boolean);

  return ok(tool, {
    effect: TOOL_EFFECT.artifact,
    message: result.alreadyCurrent
      ? `"${result.title}" was already up to date.`
      : `Completed "${result.title}".${ranTitles.length > 1 ? ` (Ran: ${ranTitles.join(", ")}.)` : ""}`,
    facts: {
      completed: result.title ?? null,
      ranSteps: ranTitles,
      alreadyCurrent: result.alreadyCurrent === true,
      proposal: proposal.lines,
      ...planFacts(state),
    },
    artifact: artifact ?? {
      type: proposal.type,
      title: proposal.title,
      lines: proposal.lines,
    },
  });
}

/**
 * An artifact that enumerates nothing is an artifact that says "I could not".
 * @param {any} artifact
 */
function artifactIsEmpty(artifact) {
  if (!artifact) return false;
  if (artifact.body) return false;
  if (!Array.isArray(artifact.lines)) return false;
  return artifact.lines.length === 0;
}

/** @param {any} artifact */
export function normalizeArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return null;
  if (!artifact.artifactType && !artifact.type) return null;
  const rows = Array.isArray(artifact.lines)
    ? artifact.lines
    : Array.isArray(artifact.items)
      ? artifact.items
      : null;
  return {
    type: artifact.artifactType ?? artifact.type,
    title: artifact.title ?? null,
    summary: artifact.summary ?? null,
    body: artifact.body ?? artifact.draft ?? null,
    lines: rows ? rows.map(normalizeArtifactLine) : null,
  };
}

/**
 * Assist handlers emit rich item rows; the merchant-facing renderer needs a
 * title and the one number that matters. Keeping this mapping here means the
 * grounded reply shows real quantities rather than bare product names.
 *
 * @param {any} row
 */
function normalizeArtifactLine(row) {
  if (!row || typeof row !== "object") return row;
  const units = row.units ?? row.recommendedUnits ?? row.recommendedUnitsAtDefaultCover ?? null;
  return {
    title: row.title ?? row.productTitle ?? "Item",
    ...(units != null ? { units } : {}),
    ...(row.fromPrice != null ? { fromPrice: row.fromPrice } : {}),
    ...(row.toPrice != null ? { toPrice: row.toPrice } : {}),
  };
}

export { TOOLS as ACTION_AGENT_TOOL_DEFINITIONS, log as toolLogger, normalizeMatch, resolveActionState, reachCapability };
