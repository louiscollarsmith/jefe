// @ts-check

// Approve → the RIGHT wire. One place that maps an action row's type to its execute path.
//
// Before this, the surface called `wireClearanceExecution` for every approval regardless of
// type. That was safe only because clearance was the sole executable action: the moment a
// second one existed, approving it hit the clearance wire, was refused as `wrong_primitive`,
// and the merchant's tap did nothing with no explanation. The registry and binding table are
// both keyed by action type; this is the third place that has to be, and the last one on the
// path from a merchant's tap to a store write.
//
// Fail-closed: an unknown type executes NOTHING rather than falling back to clearance.

import { wireClearanceExecution } from "./wire-clearance-execution.server.js";
import { wireListingCopyExecution } from "./wire-listing-copy-execution.server.js";
import { wireTidyUpExecution } from "./wire-tidy-up-execution.server.js";

/** actionType → its approve→execute entry point. */
const WIRES = {
  price_markdown: wireClearanceExecution,
  listing_copy: wireListingCopyExecution,
  tidy_up: wireTidyUpExecution,
};

/** The action types an approval can actually execute. */
export function listExecutableActionTypes() {
  return Object.keys(WIRES);
}

/**
 * Look up the run, dispatch to its own wire, and never guess. Returns the wire's own result
 * shape so callers keep reading `ok` / `executed` exactly as before.
 *
 * @param {any} prisma
 * @param {{ shop: string }} session
 * @param {{ merchantId: string; actionRunId: string; mode: "approve" | "auto" }} input
 * @param {any} [deps]  passed through to the wire (token loader / gql client seam)
 */
export async function executeApprovedAction(prisma, session, input, deps = {}) {
  const row = await prisma.actionExecution.findUnique({
    where: { runId: input.actionRunId },
    select: { actionType: true, merchantId: true },
  });
  if (!row || row.merchantId !== input.merchantId) {
    return { ok: false, executed: false, reason: "not_found" };
  }
  const wire = Object.prototype.hasOwnProperty.call(WIRES, row.actionType)
    ? WIRES[/** @type {keyof typeof WIRES} */ (row.actionType)]
    : null;
  if (!wire) {
    // A registered action type with no wire is a build gap, not a merchant error — surface it
    // as a refusal rather than silently doing nothing or, worse, running the wrong primitive.
    return { ok: false, executed: false, reason: `no_wire:${row.actionType}` };
  }
  return wire(prisma, session, input, deps);
}
