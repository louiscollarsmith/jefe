import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSupportNumbers,
  extractNumericClaims,
  numericTextIsGrounded,
} from "../app/lib/llm/numeric-grounding.server.js";
import { parseAndValidateMerchantGoalsOutput } from "../app/lib/merchant-goals/schema.server.js";
import { parseAndValidateMerchantInsightsOutput } from "../app/lib/merchant-insights/schema.server.js";
import { parseAndValidateMerchantPlanOutput } from "../app/lib/merchant-plan/schema.server.js";

// These tests run without DATABASE_URL: the numeric-grounding guard and the
// validators that use it are pure functions over already-parsed model output.

test("extractNumericClaims keeps units attached and normalizes thousands", () => {
  assert.deepEqual(extractNumericClaims("56% of revenue"), ["56%"]);
  assert.deepEqual(extractNumericClaims("34 percent of revenue"), ["34%"]);
  assert.deepEqual(extractNumericClaims("open for 56 days"), ["56"]);
  assert.deepEqual(extractNumericClaims("reach 12,500 orders"), ["12500"]);
  assert.deepEqual(extractNumericClaims("average price of 45.64 GBP"), ["45.64"]);
  assert.deepEqual(extractNumericClaims("no numbers here"), []);
});

test("collectSupportNumbers builds from values only and excludes id/confidence", () => {
  // id is a cuid containing 56; conf is 0.56; the only real value is 12.
  const support = collectSupportNumbers({
    id: "clx56aa56bb",
    conf: 0.56,
    confidence: 0.56,
    precedence: 56,
    value: { percentage: 12 },
  });
  assert.equal(support.has("12%"), true);
  assert.equal(support.has("56"), false);
  assert.equal(support.has("56%"), false);
  assert.equal(support.has("0.56"), false);
});

test("collectSupportNumbers keeps array numbers distinct and skips citation id lists", () => {
  const support = collectSupportNumbers({
    id: "belief-1",
    supportingBeliefIds: ["clx900123", "clx500999"],
    value: { topVariants: [12, 500] },
  });
  assert.deepEqual([...support].sort(), ["12", "500"]);
  assert.equal(support.has("12500"), false);
});

test("collectSupportNumbers reads both `value` and `val` value shapes", () => {
  assert.equal(collectSupportNumbers({ value: { number: 7 } }).has("7"), true);
  assert.equal(collectSupportNumbers({ val: { number: 7 } }).has("7"), true);
});

test("(a) a percentage claim is rejected when only a cuid and confidence contain the digits", () => {
  const belief = { id: "clx56zz56", conf: 0.56, value: { percentage: 12 } };
  assert.equal(numericTextIsGrounded("56% of customers repeat", [belief]), false);
});

test("(b) a claim whose number matches a real belief value passes", () => {
  assert.equal(
    numericTextIsGrounded("56% of stock value", [
      { id: "belief-1", conf: 0.9, value: { percentage: 56 } },
    ]),
    true,
  );
  assert.equal(
    numericTextIsGrounded("24 products at 45.64", [
      { id: "belief-2", value: { count: 24, amount: 45.64, currency: "GBP" } },
    ]),
    true,
  );
});

test("(c) a merged array number no longer grounds a fabricated claim", () => {
  const belief = { id: "belief-1", value: { topVariants: [12, 500] } };
  assert.equal(numericTextIsGrounded("worth 12500 in total", [belief]), false);
  // The genuine individual values still ground.
  assert.equal(numericTextIsGrounded("12 variants", [belief]), true);
  assert.equal(numericTextIsGrounded("500 units", [belief]), true);
});

test("units stay attached: 56% is not grounded by a bare 56 (e.g. '56 days')", () => {
  const daysBelief = { id: "b", value: { text: "56 days average lead time" } };
  assert.equal(numericTextIsGrounded("56% of orders", [daysBelief]), false);
  // And a bare-number day claim is not grounded by a 56% value.
  const pctBelief = { id: "b", value: { percentage: 56 } };
  assert.equal(numericTextIsGrounded("ships in 56 days", [pctBelief]), false);
});

test("insight validation: a fabricated percentage backed only by id/confidence is rejected", () => {
  const suppliedBeliefs = [
    { id: "clx56aa56", conf: 0.56, value: { percentage: 12 } },
  ];
  const result = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Repeat rate looks strong",
          finding: "About 56% of customers are repeat buyers this quarter.",
          whyItMatters: "That would justify a retention investment now.",
          supportingBeliefIds: ["clx56aa56"],
          confidence: "high",
          category: "customers",
        },
      ],
    },
    { allowedBeliefIds: new Set(["clx56aa56"]), suppliedBeliefs },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported numerical claims/);
});

test("insight validation: the same percentage passes once a belief value carries it", () => {
  const suppliedBeliefs = [
    { id: "clx56aa56", conf: 0.56, value: { percentage: 56 } },
  ];
  const result = parseAndValidateMerchantInsightsOutput(
    {
      insights: [
        {
          title: "Repeat rate looks strong",
          finding: "About 56% of customers are repeat buyers this quarter.",
          whyItMatters: "That would justify a retention investment now.",
          supportingBeliefIds: ["clx56aa56"],
          confidence: "high",
          category: "customers",
        },
      ],
    },
    { allowedBeliefIds: new Set(["clx56aa56"]), suppliedBeliefs },
  );
  assert.equal(result.ok, true);
});

test("(d) goal validation rejects an ungrounded target number and accepts a grounded one", () => {
  const groundedBelief = {
    id: "belief-1",
    value: { number: 500 },
    evidence: [{ summary: "Repeat customers placed 500 orders last year." }],
  };
  const cleanGoal = (title, description) => ({
    title,
    description,
    supportingBeliefIds: ["belief-1"],
  });

  const ungrounded = parseAndValidateMerchantGoalsOutput(
    {
      threeMonths: cleanGoal(
        "Grow revenue to 900 repeat orders",
        "Focus buying around proven demand to reach 900 repeat orders.",
      ),
      sixMonths: cleanGoal(
        "Increase repeat revenue",
        "Use the catalogue shape to create a clearer replenishment path.",
      ),
      twelveMonths: cleanGoal(
        "Expand specialist range growth",
        "Use confirmed demand patterns to expand without diluting focus.",
      ),
    },
    { allowedBeliefIds: new Set(["belief-1"]), suppliedBeliefs: [groundedBelief] },
  );
  assert.equal(ungrounded.ok, false);
  assert.match(ungrounded.error, /unsupported numerical claims/);

  const grounded = parseAndValidateMerchantGoalsOutput(
    {
      threeMonths: cleanGoal(
        "Grow revenue to 500 repeat orders",
        "Focus buying around proven demand to reach 500 repeat orders.",
      ),
      sixMonths: cleanGoal(
        "Increase repeat revenue",
        "Use the catalogue shape to create a clearer replenishment path.",
      ),
      twelveMonths: cleanGoal(
        "Expand specialist range growth",
        "Use confirmed demand patterns to expand without diluting focus.",
      ),
    },
    { allowedBeliefIds: new Set(["belief-1"]), suppliedBeliefs: [groundedBelief] },
  );
  assert.equal(grounded.ok, true);
});

test("(e) plan validation allows 100% only for cited bounded coverage metrics", () => {
  const coverageBelief = {
    id: "belief-coverage",
    key: "products.cost_coverage",
    val: {
      percentage: 0,
      ratio: 0,
      denominator: 30,
      activeVariants: 30,
    },
  };
  const goal = {
    id: "goal-1",
    title: "Establish profit visibility",
    description: "Build margin visibility from current cost coverage.",
  };
  const insight = {
    id: "insight-1",
    title: "Costs are missing",
    finding: "Cost coverage is currently 0% across 30 active variants.",
  };
  const plan = {
    candidates: [
      candidate("candidate_1", "Populate cost-per-item data"),
      candidate("candidate_2", "Audit inventory records"),
      candidate("candidate_3", "Review product categorisation"),
    ],
    selectedRecommendation: {
      candidateId: "candidate_1",
      title: "Populate cost-per-item data",
      summary: "Add missing cost data for the active variants.",
      primaryGoalId: "goal-1",
      supportingGoalIds: [],
      whyThisAction:
        "Cost coverage is at 0%, so adding costs creates the baseline for profit visibility.",
      whyNow: "This is the foundation for margin decisions.",
      startToday: "Start with the active variants that are missing cost data.",
      executionSteps: [
        {
          title: "Gather costs",
          description: "Collect unit costs for the active variants.",
        },
      ],
      successSignal: {
        description: "Cost coverage moves from 0% toward 100%.",
        timeframe: "As costs are entered.",
      },
      expectedBenefit: "Jefe can reason from profit instead of revenue alone.",
      supportingBeliefIds: ["belief-coverage"],
      supportingInsightIds: ["insight-1"],
      confidence: "strong",
    },
  };

  const grounded = parseAndValidateMerchantPlanOutput(plan, {
    allowedBeliefIds: new Set(["belief-coverage"]),
    allowedInsightIds: new Set(["insight-1"]),
    allowedGoalIds: new Set(["goal-1"]),
    suppliedBeliefs: [coverageBelief],
    suppliedInsights: [insight],
    suppliedGoals: [goal],
  });
  assert.equal(grounded.ok, true);

  const ungrounded = parseAndValidateMerchantPlanOutput(plan, {
    allowedBeliefIds: new Set(["belief-coverage"]),
    allowedInsightIds: new Set(["insight-1"]),
    allowedGoalIds: new Set(["goal-1"]),
    suppliedBeliefs: [{ ...coverageBelief, key: "products.active_variants" }],
    suppliedInsights: [insight],
    suppliedGoals: [goal],
  });
  assert.equal(ungrounded.ok, false);
  assert.match(ungrounded.error, /unsupported numerical claims/);
});

function candidate(id, action) {
  return {
    id,
    action,
    goalAlignment: "Supports the current goal.",
    whyRelevant: "The supplied memory makes this relevant.",
    supportingBeliefIds: ["belief-coverage"],
    supportingInsightIds: ["insight-1"],
    expectedEffort: "small",
    timeToUsefulSignal: "as soon as the work starts",
  };
}
