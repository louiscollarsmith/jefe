// @ts-check

/**
 * Turn the stored eligibility record into the sentence a merchant reads when Jefe is not
 * going to do this one itself.
 *
 * Deterministic and in code, not in a prompt: this is Jefe explaining its own limits, and it
 * must say the same thing every time for the same state.
 *
 * Returns null when there is nothing specific to say, so the surface can keep its own general
 * line rather than inventing a reason. Never fabricates a cause it does not have.
 *
 * @param {any} eligibility
 * @returns {{ reason: string; detail: string | null } | null}
 */
export function buildActionRaise(eligibility) {
  if (!eligibility || typeof eligibility !== "object") return null;
  const violations = Array.isArray(eligibility.policyViolations)
    ? eligibility.policyViolations.filter((/** @type {any} */ v) => typeof v === "string" && v)
    : [];

  // A cap the merchant set is the most useful thing to say, because it is the one thing they
  // can change, and saying which cap matters more than saying that one exists.
  if (violations.length) {
    return {
      reason: "This is bigger than the limit you set for me, so I've left it with you.",
      detail: violations.join("; "),
    };
  }
  if (eligibility.degradedFromAutonomous === true) {
    return {
      reason:
        "You've asked me to run things like this on my own, and I couldn't be confident enough on this one - so it's yours to call.",
      detail: null,
    };
  }
  if (eligibility.reversible === false) {
    return {
      reason: "I can't undo this one cleanly, so I won't do it without you.",
      detail: null,
    };
  }
  return null;
}
