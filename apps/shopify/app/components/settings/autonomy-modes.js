// @ts-check

// The merchant-selectable autonomy modes — the single source of truth for the settings dial
// (AutonomyPanel). TWO modes (founder ruling 2026-08-12, recorded in AGENTS.md): advisory-only
// `recommend` was dropped as a SELECTABLE mode. The engine's stored keys + its handling of
// `recommend` (legacy rows + the fail-closed write-path guards) are UNTOUCHED — this is the UI
// mode set only. Extracted from AutonomyPanel.tsx so `autonomy-modes.test.mjs` can lock the set:
// a third dial mode can never reappear here without failing the test.

/** @typedef {"approve_execute" | "autonomous"} ActionMode */

/** The two selectable modes, in dial order. @type {readonly ("approve_execute" | "autonomous")[]} */
export const ACTION_MODES = ["approve_execute", "autonomous"];

/** @param {string} v @returns {v is ActionMode} */
export function isActionMode(v) {
  return v === "approve_execute" || v === "autonomous";
}

/**
 * A stored mode → what the picker shows. A legacy stored `recommend` (dropped as selectable;
 * ~none — the dial only went live 2026-08-12) displays as the safe default `approve_execute`
 * until the merchant next sets it. Anything unrecognised ⇒ null (the row falls through to a
 * "Soon" chip or its blocked prompt).
 * @param {string | undefined | null} raw
 * @returns {ActionMode | null}
 */
export function displayMode(raw) {
  if (!raw) return null;
  if (raw === "recommend") return "approve_execute";
  return isActionMode(raw) ? raw : null;
}
