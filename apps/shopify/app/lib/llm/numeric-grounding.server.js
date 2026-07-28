// @ts-nocheck

/**
 * Shared numeric-grounding guard for the merchant-facing LLM validators
 * (merchant-insights, merchant-plan, merchant-goals).
 *
 * Product guarantee: never present model inference as fact. A generated number
 * (percentage, currency amount, count, decimal) may only pass validation when
 * the SAME number appears in the VALUES of the beliefs / insights / goals that
 * were supplied to the model as support.
 *
 * This module fixes three weaknesses of the previous substring guard:
 *   1. Identifiers (cuids) and confidence scores no longer count as support.
 *      Support is built from belief VALUES only; metadata keys (id, conf,
 *      confidence, precedence, *Id / *Ids citation lists) are skipped so a claim
 *      of "56%" cannot be grounded by a cuid containing "56" or by conf 0.56.
 *   2. Distinct numbers are never merged. Support numbers are collected by
 *      walking the value structure (arrays element by element), so an array
 *      value of [12, 500] yields the tokens "12" and "500" and can never ground
 *      a fabricated "12500".
 *   3. Units stay attached. A percentage claim ("56%" / "56 percent") is a
 *      distinct token from a bare "56", so it cannot be grounded by a value that
 *      merely happens to contain 56 in a different unit (e.g. "56 days").
 */

// Keys whose contents are metadata rather than merchant facts. Their digits
// (random cuid characters, confidence decimals, precedence, citation id lists)
// must never ground a numeric claim.
function isMetadataKey(key) {
  if (typeof key !== "string") return false;
  if (key === "id") return true;
  if (/_ids?$/i.test(key)) return true; // belief_id, supporting_belief_ids
  if (/[a-z]Ids?$/.test(key)) return true; // beliefId, supportingBeliefIds, primaryGoalId
  const lower = key.toLowerCase();
  if (lower === "conf" || lower === "confidence") return true;
  if (lower === "precedence") return true;
  return false;
}

// A value under one of these keys is a percentage even when stored as a bare
// number (e.g. { percentage: 56 }), so it is emitted with its unit.
function isPercentKey(key) {
  return typeof key === "string" && /percent/i.test(key);
}

// One numeric token, with an optional trailing percentage unit ("%" or the word
// "percent"/"percentage"). Thousands separators inside the number are allowed
// (e.g. "12,500") but a comma followed by a space is a list boundary, not part
// of the number, so distinct numbers stay distinct.
const NUMBER_WITH_UNIT = /(\d(?:[\d,]*\d)?(?:\.\d+)?)(\s*%|\s*percent)?/gi;

/** Strip thousands separators and any trailing dot from a numeric core. */
function normalizeNumberCore(core) {
  return String(core).replace(/,/g, "").replace(/\.$/, "");
}

/**
 * Collect numeric tokens from a free-text string into `target`. Percentages
 * keep their unit ("56%"); everything else is a bare number ("56", "45.64").
 * @param {string} text
 * @param {Set<string>} target
 */
function collectNumbersFromString(text, target) {
  for (const match of String(text ?? "").matchAll(NUMBER_WITH_UNIT)) {
    const core = normalizeNumberCore(match[1]);
    if (!core || !/\d/.test(core)) continue;
    target.add(match[2] ? `${core}%` : core);
  }
  return target;
}

/**
 * Numeric claim tokens found in generated model text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractNumericClaims(text) {
  return [...collectNumbersFromString(text, new Set())];
}

/**
 * Recursively collect the numeric tokens that legitimately appear in the VALUES
 * of a supplied support object (a belief / insight / goal, or an array of them).
 * Metadata keys are skipped, array elements are tokenized separately, and
 * numbers under a percentage key are emitted with their unit.
 * @param {any} value
 * @returns {Set<string>}
 */
export function collectSupportNumbers(value) {
  const target = new Set();
  walkValue(value, null, target);
  return target;
}

/** @param {any} value @param {string | null} key @param {Set<string>} target */
function walkValue(value, key, target) {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return;
    const core = normalizeNumberCore(String(value));
    target.add(isPercentKey(key) ? `${core}%` : core);
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value === "string") {
    // A bare-number string under a percentage key ("56") is a percentage;
    // otherwise take whatever units the text itself carries.
    if (isPercentKey(key) && /^\s*\d(?:[\d,]*\d)?(?:\.\d+)?\s*$/.test(value)) {
      target.add(`${normalizeNumberCore(value.trim())}%`);
      return;
    }
    collectNumbersFromString(value, target);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, key, target);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (isMetadataKey(childKey)) continue;
      walkValue(childValue, childKey, target);
    }
  }
}

/**
 * True when every numeric claim in `text` is grounded in the values of
 * `supportObjects`. Text with no numeric claims is always grounded.
 * @param {string} text
 * @param {any[]} supportObjects
 * @returns {boolean}
 */
export function numericTextIsGrounded(text, supportObjects) {
  const claims = extractNumericClaims(text);
  if (claims.length === 0) return true;
  const support = collectSupportNumbers(supportObjects);
  return claims.every((claim) => support.has(claim));
}
