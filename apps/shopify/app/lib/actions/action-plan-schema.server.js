// @ts-check

/**
 * Action-type plan schemas. The LLM and runtime may only read/write fields
 * valid for the current action kind — e.g. replenishment cannot set markdown.
 */

import { actionRuntimeKind } from "./resolved-action-context.server.js";

/** @typedef {"restock" | "markdown" | "listing_copy" | "tidy_up" | "generic"} ActionKind */

/** @type {Record<string, Set<string>>} */
export const ACTION_PLAN_FIELDS = Object.freeze({
  restock: new Set(["coverDays", "maxProducts"]),
  markdown: new Set(["markdownPercent", "maxProducts"]),
  listing_copy: new Set(["maxProducts"]),
  tidy_up: new Set(["maxProducts"]),
  generic: new Set(["coverDays", "markdownPercent", "maxProducts"]),
});

/**
 * @param {string} [kind]
 * @returns {Set<string>}
 */
export function allowedPlanFields(kind = "generic") {
  return ACTION_PLAN_FIELDS[kind] ?? ACTION_PLAN_FIELDS.generic;
}

/**
 * Strip plan fields that do not belong on this action type.
 *
 * @param {any} action
 * @param {Record<string, number>} patch
 * @returns {{ patch: Record<string, number>; rejected: string[] }}
 */
export function validatePlanPatch(action, patch) {
  const kind = actionRuntimeKind(action);
  const allowed = allowedPlanFields(kind);
  /** @type {Record<string, number>} */
  const valid = {};
  /** @type {string[]} */
  const rejected = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!allowed.has(key)) {
      rejected.push(key);
      continue;
    }
    if (Number.isFinite(Number(value))) {
      valid[key] = Number(value);
    }
  }
  return { patch: valid, rejected };
}

/**
 * Human-readable revision summary scoped to the action type.
 *
 * @param {any} action
 * @param {Record<string, number>} patch
 */
export function describePlanRevision(action, patch) {
  const bits = [];
  if (patch.coverDays != null) {
    bits.push(`cover to ${patch.coverDays} days`);
  }
  if (patch.markdownPercent != null) {
    bits.push(`markdown to ${patch.markdownPercent}%`);
  }
  if (patch.maxProducts != null) {
    bits.push(`scope to the top ${patch.maxProducts} products`);
  }
  if (bits.length === 0) return "Updated the plan.";
  return `Updated ${bits.join(" and ")}.`;
}

/**
 * Compact plan schema description for the LLM agent.
 *
 * @param {any} action
 */
export function planSchemaForAgent(action) {
  const kind = actionRuntimeKind(action);
  const fields = [...allowedPlanFields(kind)];
  return { kind, fields };
}
