import assert from "node:assert/strict";
import test from "node:test";

import { selectPromptBeliefs } from "../app/lib/merchant-memory/conversation.server.js";
import {
  DETERMINISTIC_BELIEF_REGISTRY,
  retrievalTermsForBeliefKey,
} from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";

// Beliefs that derive correctly and never reach the model are worth nothing. Only 40 of
// 143 make it into the prompt, and which 40 was decided by keyword-matching the merchant's
// message against the belief KEY — an engineering identifier. This pins the fix.

const ACQUISITION = "business.acquisition_mix.trailing_90d";
const COHORT = "customers.cohort_mix.all_stored_history";
const DISCOUNT = "business.discount_code_mix.trailing_90d";

// A generous budget so the 40-belief cap binds rather than the character budget — this is
// a test about ranking, not about truncation.
const BUDGET = 200_000;

/** Every real belief, uniform confidence, so only relevance separates them. */
function allBeliefs() {
  return DETERMINISTIC_BELIEF_REGISTRY.map((definition, i) => ({
    id: `belief-${i}`,
    key: definition.key,
    category: definition.category,
    valueType: definition.valueType,
    value: 1,
    status: "active",
    confidence: 0.9,
    evidence: [],
  }));
}

function selectedKeys(message, context) {
  return new Set(
    selectPromptBeliefs({ beliefs: allBeliefs(), message, context }, BUDGET).map((b) => b.key),
  );
}

test("a merchant asking where orders come from actually gets the acquisition belief", () => {
  // ⛔ The defect. Merchants say this; they never say "acquisition", which was the only
  // word the belief was indexed under. It derived, tested green, and was never in the room.
  for (const message of [
    "where are my orders coming from?",
    "is the ad spend working?",
    "how much of this is instagram?",
    "are we getting anything from google",
  ]) {
    assert.ok(selectedKeys(message).has(ACQUISITION), `not retrieved for: "${message}"`);
  }
});

test("merchants get the cohort and discount beliefs in their own words", () => {
  for (const [message, key] of [
    ["do my customers ever come back?", COHORT],
    ["who are my most loyal buyers", COHORT],
    ["is our churn bad", COHORT],
    ["are the promo codes actually working", DISCOUNT],
    ["should we run another sale", DISCOUNT],
  ]) {
    assert.ok(selectedKeys(message).has(key), `${key} not retrieved for: "${message}"`);
  }
});

test("a vague question and a specific one do not select the same beliefs", () => {
  // ⚠️ GUARD, not a demonstration — this one passes on the old scoring too. The selectivity
  // weighting's real effect (a token in 27% of keys scoring 10 instead of 50) isn't
  // observable through selectPromptBeliefs alone, because the 40-slot cap fills either way.
  // What this pins is that the reweighting didn't collapse selection into one fixed set.
  // The two tests above are the ones that actually fail without the fix.
  const generic = selectedKeys("why are my orders down this month?");
  const specific = selectedKeys("why is my dead stock so high?");
  // Both still return a full prompt — the cap is unchanged.
  assert.equal(generic.size, 40);
  assert.equal(specific.size, 40);
  // But they must not be the same 40: a specific question should reshape the selection.
  const overlap = [...generic].filter((k) => specific.has(k)).length;
  assert.ok(overlap < 40, "a specific question selected exactly the same beliefs as a vague one");
});

test("a distinctive word still beats a structural one", () => {
  // The point isn't to weaken matching — it's to make rare tokens count for more than
  // ubiquitous ones. "clearance" appears in very few keys and should pull its belief in.
  const clearanceKeys = DETERMINISTIC_BELIEF_REGISTRY.map((d) => d.key).filter((k) =>
    k.includes("clearance"),
  );
  if (clearanceKeys.length === 0) return; // registry changed; nothing to assert
  const selected = selectedKeys("can we do a clearance on the old stock");
  assert.ok(
    clearanceKeys.some((k) => selected.has(k)),
    "a distinctive token failed to retrieve its own belief",
  );
});

test("the belief actually under discussion still outranks everything", () => {
  // Regression guard: the +100 for the belief being discussed must survive the reweighting,
  // or a follow-up question loses its own subject.
  const selected = selectedKeys("what about that", {
    lastDiscussedBeliefKeys: [ACQUISITION],
  });
  assert.ok(selected.has(ACQUISITION));
});

test("retrieval terms are lowercase and short enough to match real messages", () => {
  // These are substring-matched against a lowercased message. An uppercase term can never
  // match, and a long phrase almost never does — both fail silently, which is the whole
  // failure mode this file exists to prevent.
  for (const key of [ACQUISITION, COHORT, DISCOUNT]) {
    assert.ok(
      DETERMINISTIC_BELIEF_REGISTRY.some((d) => d.key === key),
      `${key} missing from registry`,
    );
  }
  for (const key of [ACQUISITION, COHORT, DISCOUNT]) {
    const terms = retrievalTermsForBeliefKey(key);
    assert.ok(terms.length > 0, `${key} has no retrieval terms`);
    for (const term of terms) {
      assert.equal(term, term.toLowerCase(), `term "${term}" is not lowercase`);
      assert.ok(term.length <= 20, `term "${term}" is too long to match a real message`);
    }
  }
});
