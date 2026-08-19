import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_COMMAND,
  executeActionPlan,
} from "../app/lib/actions/action-command.server.js";
import {
  ACTION_INTERPRETER_VERSION,
  LLM_DOWN_INTERPRETER_REPLY,
  applyInterpreterPolicies,
  handleFocusedActionMessage,
  parseInterpretedPlan,
  resolveInterpretedOperations,
  resolveProductReference,
} from "../app/lib/actions/action-interpreter.server.js";
import { createOracleInterpreterProvider, oracleInterpretJson } from "./helpers/action-interpreter-oracle.mjs";

const quietLogger = { info() {}, warn() {}, error() {} };

const REPLENISHMENT_SNAPSHOT = {
  action: {
    id: "a-restock",
    title: "Review At-Risk Inventory and Prepare Replenishment",
    status: "accepted",
    plan: { coverDays: 120 },
  },
  plan: { values: { coverDays: 120 } },
  steps: [
    { id: "step-1", title: "Review low-cover inventory", status: "ready", orderIndex: 0 },
    { id: "step-2", title: "Build replenishment proposal", status: "waiting", orderIndex: 1 },
    { id: "step-3", title: "Draft supplier communication", status: "waiting", orderIndex: 2 },
  ],
  currentStep: { id: "step-1", title: "Review low-cover inventory", status: "ready" },
  constraints: [],
  scopeItems: [
    { title: "Pear Skin Sipon", available: 0, dailyVelocity: 0.1 },
    { title: "Picnic Xinomavro", available: 0, dailyVelocity: 0.1 },
  ],
  excluded: [],
};

const ADVANCE_PHRASES = [
  "Let's move on.",
  "Move to the next step.",
  "Proceed.",
  "Carry on.",
  "Okay, what's next — let's do that.",
  "I'm happy with this, continue.",
  "We've finished this part.",
  "This looks fine, onto the proposal.",
  "ok lets move to the next step",
];

const BACK_PHRASES = [
  "Go back.",
  "Take me back one.",
  "Previous step.",
  "Actually let's revisit what we just did.",
  "Go back two steps.",
];

const SKIP_PHRASES = [
  "Skip this.",
  "I don't need this bit.",
  "Leave this step out.",
  "I'll handle this myself.",
  "Forget the supplier message.",
  "Let's go past this part.",
];

const REVISION_PHRASES = [
  "Use 90 days.",
  "Let's make the target 90.",
  "Actually I'd rather carry 3 months.",
  "Change this to about 60 days.",
];

const CONSTRAINT_PHRASES = [
  "Only Pear.",
  "Leave Picnic out.",
  "Don't include Picnic.",
  "Ignore the other wine.",
  "Just do the first one.",
  "I only want Pear in this.",
];

test("interpreter schema drops hallucinated commands", () => {
  const parsed = parseInterpretedPlan({
    operations: [
      { command: "DELETE_STORE", arguments: {} },
      { command: "ADVANCE_STEP", arguments: {} },
    ],
    requiresClarification: false,
    confidence: 0.9,
    routing: "focused",
  });
  assert.deepEqual(
    parsed.operations.map((op) => op.command),
    [ACTION_COMMAND.ADVANCE_STEP],
  );
});

test("interpreter version is explicit for observability", () => {
  assert.equal(ACTION_INTERPRETER_VERSION, "1");
});

test("Stage B resolves Picnic and the other wine against known products", () => {
  const picnic = resolveProductReference("Picnic", [], REPLENISHMENT_SNAPSHOT, "exclude_product");
  assert.equal(picnic.product?.title, "Picnic Xinomavro");

  const other = resolveProductReference(
    "the other wine",
    [],
    {
      ...REPLENISHMENT_SNAPSHOT,
      scopeItems: [{ title: "Pear Skin Sipon" }],
      excluded: [{ title: "Picnic Xinomavro" }],
    },
    "include_again",
  );
  assert.equal(other.product?.title, "Picnic Xinomavro");
});

test("hypothetical language is forced to ANSWER rather than mutation", () => {
  const resolved = resolveInterpretedOperations(
    [
      {
        command: ACTION_COMMAND.REVISE_PLAN,
        params: { coverDays: 60, simulate: true, doNotMutate: true },
      },
    ],
    REPLENISHMENT_SNAPSHOT,
  );
  assert.equal(resolved.operations[0].command, ACTION_COMMAND.ANSWER);
  assert.equal(resolved.operations[0].params.simulate, true);
});

test("APPLY is demoted when the same turn also revises the plan", () => {
  const next = applyInterpreterPolicies([
    { command: ACTION_COMMAND.REVISE_PLAN, params: { markdownPercent: 20 } },
    { command: ACTION_COMMAND.APPLY_CHANGESET, params: {} },
  ]);
  assert.equal(next[1].command, ACTION_COMMAND.CREATE_CHANGESET);
});

test("evaluation corpus: advance paraphrases interpret as ADVANCE_STEP", () => {
  for (const message of ADVANCE_PHRASES) {
    const json = oracleInterpretJson(message, REPLENISHMENT_SNAPSHOT);
    const parsed = parseInterpretedPlan(json);
    assert.equal(
      parsed.operations.some((op) => op.command === ACTION_COMMAND.ADVANCE_STEP),
      true,
      message,
    );
  }
});

test("evaluation corpus: back paraphrases interpret as GO_BACK or GO_TO_STEP", () => {
  for (const message of BACK_PHRASES) {
    const json = oracleInterpretJson(message, REPLENISHMENT_SNAPSHOT);
    const parsed = parseInterpretedPlan(json);
    const commands = parsed.operations.map((op) => op.command);
    assert.equal(
      commands.includes(ACTION_COMMAND.GO_BACK) || commands.includes(ACTION_COMMAND.GO_TO_STEP),
      true,
      message,
    );
  }
});

test("evaluation corpus: skip paraphrases interpret as SKIP_STEP", () => {
  for (const message of SKIP_PHRASES) {
    const json = oracleInterpretJson(message, REPLENISHMENT_SNAPSHOT);
    const parsed = parseInterpretedPlan(json);
    assert.equal(
      parsed.operations.some((op) => op.command === ACTION_COMMAND.SKIP_STEP),
      true,
      message,
    );
  }
});

test("evaluation corpus: revision paraphrases interpret as REVISE_PLAN", () => {
  for (const message of REVISION_PHRASES) {
    const json = oracleInterpretJson(message, REPLENISHMENT_SNAPSHOT);
    const parsed = parseInterpretedPlan(json);
    const revise = parsed.operations.find((op) => op.command === ACTION_COMMAND.REVISE_PLAN);
    assert.ok(revise, message);
    assert.ok(revise.params.coverDays === 90 || revise.params.coverDays === 60, message);
  }
});

test("evaluation corpus: constraint paraphrases interpret as ADD_CONSTRAINT", () => {
  for (const message of CONSTRAINT_PHRASES) {
    const json = oracleInterpretJson(message, REPLENISHMENT_SNAPSHOT);
    const parsed = parseInterpretedPlan(json);
    assert.equal(
      parsed.operations.some((op) => op.command === ACTION_COMMAND.ADD_CONSTRAINT),
      true,
      message,
    );
  }
});

test("evaluation corpus: multi-intent, negation, hypothetical, mixed question", () => {
  const multi = parseInterpretedPlan(
    oracleInterpretJson(
      "I think 120 days feels like too much stock. Let's do 90 and leave Picnic alone for now, then we can carry on.",
      REPLENISHMENT_SNAPSHOT,
    ),
  );
  assert.deepEqual(
    multi.operations.map((op) => op.command),
    [ACTION_COMMAND.ADD_CONSTRAINT, ACTION_COMMAND.REVISE_PLAN, ACTION_COMMAND.ADVANCE_STEP],
  );

  const negated = parseInterpretedPlan(
    oracleInterpretJson("Don't move on yet.", REPLENISHMENT_SNAPSHOT),
  );
  assert.equal(
    negated.operations.some((op) => op.command === ACTION_COMMAND.ADVANCE_STEP),
    false,
  );

  const hypothetical = parseInterpretedPlan(
    oracleInterpretJson("What would 60 days look like? Don't change it yet.", REPLENISHMENT_SNAPSHOT),
  );
  assert.equal(hypothetical.operations[0].command, ACTION_COMMAND.ANSWER);
  assert.equal(hypothetical.operations[0].params.simulate, true);
  assert.equal(hypothetical.operations[0].params.coverDays, 60);

  const mixed = parseInterpretedPlan(
    oracleInterpretJson("Why did you choose 120 days, and can we use 90 instead?", REPLENISHMENT_SNAPSHOT),
  );
  assert.equal(mixed.operations[0].command, ACTION_COMMAND.ANSWER);
  assert.equal(mixed.operations[1].command, ACTION_COMMAND.REVISE_PLAN);
  assert.equal(mixed.operations[1].params.coverDays, 90);

  const general = parseInterpretedPlan(
    oracleInterpretJson("How many products do I sell overall?", REPLENISHMENT_SNAPSHOT),
  );
  assert.equal(general.routing, "general_store");
});

test("LLM-down refuses natural-language mutations and keeps read-only fallback", async () => {
  const prisma = {
    merchantAction: {
      findFirst: async () => ({
        id: "a1",
        merchantId: "m1",
        shopId: "s1",
        title: "Markdown",
        status: "accepted",
        plan: {},
        progress: {},
        workflow: { steps: [] },
        displaySteps: [],
        currentStep: null,
      }),
      update: async ({ data }) => data,
    },
    merchantActionConstraint: { findMany: async () => [] },
    actionChangeSet: { findFirst: async () => null, findMany: async () => [] },
    merchantMemoryBelief: { findFirst: async () => null },
    merchantRecommendationStep: { findMany: async () => [] },
  };

  const mutation = await handleFocusedActionMessage(prisma, {
    message: "Exclude Picnic and move on.",
    merchantId: "m1",
    shopId: "s1",
    actionId: "a1",
    provider: { enabled: false },
    logger: quietLogger,
  });
  assert.equal(mutation.unavailable, true);
  assert.equal(mutation.ok, false);
  assert.equal(mutation.reply, LLM_DOWN_INTERPRETER_REPLY);
  assert.equal(mutation.command.reason, "agent_unavailable");

  const inspect = await handleFocusedActionMessage(prisma, {
    message: "Show me what you're proposing right now.",
    merchantId: "m1",
    shopId: "s1",
    actionId: "a1",
    provider: { enabled: false },
    logger: quietLogger,
  });
  assert.equal(inspect.unavailable, true);
  assert.equal(inspect.ok, false);
  assert.equal(inspect.command.type, ACTION_COMMAND.ANSWER);
  assert.equal(inspect.command.reason, "agent_unavailable");
});

test("executeActionPlan runs sequential operations and keeps earlier success", async () => {
  const calls = [];
  const prisma = {
    merchantAction: {
      findFirst: async () => ({
        id: "a1",
        merchantId: "m1",
        shopId: "s1",
        title: "Restock",
        status: "accepted",
        plan: { coverDays: 120 },
        progress: { preview: { changes: [] } },
        workflow: { id: "wf-1", steps: [] },
        displaySteps: [],
        currentStep: { id: "step-1", title: "Review", status: "ready" },
        sourceRecommendation: { workflows: [{ id: "wf-1", steps: [] }] },
        constraints: [],
        changeSets: [],
      }),
      update: async ({ data }) => {
        calls.push(data);
        return data;
      },
      updateMany: async () => ({ count: 1 }),
    },
    merchantActionConstraint: {
      findMany: async () => [],
      create: async ({ data }) => ({ id: "c1", status: "active", ...data }),
    },
    actionChangeSet: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }) => ({ id: "cs1", ...data, items: [], excluded: [] }),
      updateMany: async () => ({ count: 0 }),
    },
    merchantMemoryBelief: { findFirst: async () => null },
    merchantRecommendationStep: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    merchantActionEvent: { create: async ({ data }) => data },
    $transaction: async (run) => run(prisma),
  };

  const result = await executeActionPlan(prisma, {
    operations: [
      {
        command: ACTION_COMMAND.REVISE_PLAN,
        params: { coverDays: 90 },
      },
      {
        command: ACTION_COMMAND.ADVANCE_STEP,
        params: {},
      },
    ],
    merchantId: "m1",
    shopId: "s1",
    actionId: "a1",
    logger: quietLogger,
  });
  assert.equal(calls.some((row) => row.plan?.coverDays === 90), true);
  assert.equal(Array.isArray(result.results), true);
  assert.equal(result.results[0].command, ACTION_COMMAND.REVISE_PLAN);
  assert.equal(result.results[0].ok, true);
});

test("scripted interpreter understands move to the next step without regex routing", async () => {
  const json = oracleInterpretJson("ok lets move to the next step", REPLENISHMENT_SNAPSHOT);
  assert.equal(json.operations[0].command, ACTION_COMMAND.ADVANCE_STEP);
  const provider = createOracleInterpreterProvider();
  const result = await provider.generateStructuredJson({
    prompt: JSON.stringify({ merchantMessage: "ok lets move to the next step" }),
  });
  assert.equal(result.json.operations[0].command, ACTION_COMMAND.ADVANCE_STEP);
});

test("markdown golden conversation: revise and preview without applying, then apply", () => {
  const preview = parseInterpretedPlan(
    oracleInterpretJson(
      "Don't touch C, 25 feels a bit steep — make it 20 and show me what you'd change, but don't actually change Shopify yet.",
      {
        action: {
          status: "accepted",
          actionType: "price_markdown",
          currentStep: { mode: "execute", status: "ready" },
        },
      },
    ),
  );
  const commands = preview.operations.map((op) => op.command);
  assert.equal(commands.includes(ACTION_COMMAND.ADD_CONSTRAINT), true);
  assert.equal(commands.includes(ACTION_COMMAND.REVISE_PLAN), true);
  assert.equal(
    preview.operations.find((op) => op.command === ACTION_COMMAND.REVISE_PLAN)?.params.markdownPercent,
    20,
  );
  assert.equal(commands.includes(ACTION_COMMAND.CREATE_CHANGESET), true);
  assert.equal(commands.includes(ACTION_COMMAND.APPLY_CHANGESET), false);

  const apply = parseInterpretedPlan(
    oracleInterpretJson("Looks right — apply those changes.", {
      action: { status: "accepted", currentStep: { mode: "execute", status: "ready" } },
      currentChangeSet: { id: "cs-1" },
    }),
  );
  assert.equal(apply.operations[0].command, ACTION_COMMAND.APPLY_CHANGESET);
  assert.equal(apply.operations[0].params.explicitApply, true);
});
