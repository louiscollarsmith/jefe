/**
 * Semantic/tool-plan evaluation suite for focused actions.
 *
 * Important: these tests are runtime-focused. The scripted provider supplies
 * the model's intended tool plan; we assert that application execution and
 * state transitions are correct regardless of the merchant's phrasing and
 * the turn ordering.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { recommendedPurchaseUnits } from "../app/lib/actions/action-capability.server.js";
import { TURN_OUTCOME } from "../app/lib/actions/agent/turn-outcome.server.js";

import {
  MERCHANT,
  SHOP,
  buildActionFixture,
  quietLogger,
} from "./helpers/action-fixture.mjs";
import {
  eagerlyDoneProvider,
  scriptedProvider,
} from "./helpers/scripted-agent.mjs";

const unitsFor = (coverDays) =>
  recommendedPurchaseUnits({ available: 0, dailyVelocity: 0.1 }, coverDays);

function turn(prisma, message, toolCalls, finalReply = null) {
  return handleFocusedActionMessage(prisma, {
    message,
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: eagerlyDoneProvider(toolCalls, finalReply),
    logger: quietLogger,
  });
}

function state(prisma) {
  return resolveActionState(prisma, {
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
  });
}

function stepByTitle(prisma, fragment) {
  return prisma.state.steps.find((row) =>
    row.title.toLowerCase().includes(fragment),
  );
}

function supplierRuns(prisma) {
  const supplierStep = stepByTitle(prisma, "supplier");
  return prisma.state.stepRuns.filter((row) => row.stepId === supplierStep.id)
    .length;
}

test("scenario A - different wording: picnic only; show proposal only; no email", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(
    prisma,
    "Give me Picnic only and aim for about three months of stock. Where does that leave us?",
    [
      {
        tool: "restrict_to_products",
        arguments: { productTitle: "Picnic Xinomavro" },
      },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 0);

  const s = await state(prisma);
  assert.deepEqual(
    s.scope.items.map((item) => item.title),
    ["Picnic Xinomavro"],
  );
  assert.equal(s.scope.items[0].recommendedUnits, unitsFor(90));
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /\b9\b/);
});

test("scenario B - hypothetical: simulate 2 months; don't update anything", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(
    prisma,
    "If we only carried two months instead, what would I need to order? Just show me — don't update anything.",
    [{ tool: "simulate_plan", arguments: { coverDays: 60 } }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.noAction);
  assert.equal(
    prisma.state.action.plan.coverDays,
    120,
    "simulation must not persist",
  );
  assert.equal(
    supplierRuns(prisma),
    0,
    "no supplier email should be generated",
  );
  assert.equal(
    prisma.state.stepRuns.length,
    0,
    "simulation must not run assist steps",
  );
  assert.match(result.reply, /\b6\b/);
});

test("scenario C - adopt hypothetical: persist 60-day plan after a simulation", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  await turn(prisma, "What would 60 days look like? Just show me.", [
    { tool: "simulate_plan", arguments: { coverDays: 60 } },
  ]);

  const result = await turn(
    prisma,
    "Actually, let's go with that.",
    [
      { tool: "update_plan", arguments: { coverDays: 60 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(prisma.state.action.plan.coverDays, 60);
  const s = await state(prisma);
  const first = s.scope.items[0];
  assert.equal(first.recommendedUnits, unitsFor(60));
  assert.match(result.reply, /\b6\b/);
});

test("scenario D - desired outcome: create supplier note artifact", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  const result = await turn(
    prisma,
    "I need something I can send to the supplier.",
    [{ tool: "draft_supplier_email", arguments: {} }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 1);

  const supplierStep = stepByTitle(prisma, "supplier");
  assert.equal(supplierStep.status, "completed");
  assert.equal(supplierStep.progress.artifactType, "supplier_email_draft");

  assert.match(result.reply, /Draft supplier communication/);
  assert.match(result.reply, /Picnic Xinomavro/);
  assert.match(result.reply, /\b12\b/);
});

test("scenario E - backtrack: put Pear back; rebuild proposal; do NOT draft email", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  await turn(
    prisma,
    "Draft the supplier email for Picnic only at 90 days.",
    [
      {
        tool: "exclude_product",
        arguments: { productTitle: "Pear Skin Sipon" },
      },
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "draft_supplier_email", arguments: {} },
    ],
    null,
  );

  const draftsBefore = supplierRuns(prisma);
  assert.equal(draftsBefore, 1);

  const result = await turn(
    prisma,
    "Scrap that draft for now. Put Pear back in and recalculate.",
    [
      {
        tool: "include_product_again",
        arguments: { productTitle: "Pear Skin Sipon" },
      },
      { tool: "build_replenishment_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(
    supplierRuns(prisma),
    draftsBefore,
    "no new supplier email should be generated",
  );

  const s = await state(prisma);
  const titles = s.scope.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ["Pear Skin Sipon", "Picnic Xinomavro"].sort());
  assert.equal(s.scope.items[0].recommendedUnits, unitsFor(90));
});

test("scenario F - question + change: move from 60 back to 90 days", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Create persisted history for "why are we using 60 days" narrative.
  await turn(prisma, "Use 60 days.", [
    { tool: "update_plan", arguments: { coverDays: 60 } },
  ]);

  const result = await turn(
    prisma,
    "Why were we using 60 days? Put it back to 90 and show me the difference.",
    [
      { tool: "update_plan", arguments: { coverDays: 90 } },
      { tool: "inspect_current_proposal", arguments: {} },
    ],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.match(result.reply, /\b9\b/);

  // Validate that history is based on persisted revisions.
  const history = await turn(
    prisma,
    "What changed from the original?",
    [{ tool: "inspect_history", arguments: {} }],
    null,
  );
  assert.equal(history.outcome, TURN_OUTCOME.noAction);
  assert.match(history.reply, /\b60\b/);
  assert.match(history.reply, /\b90\b/);
});

test("scenario G - completely different ordering: simulate → persist → supplier note", async () => {
  const prisma = buildActionFixture({ kind: "restock" });

  // Turn 1: simulation only.
  await turn(
    prisma,
    "Before we do anything, what would 90 days look like for Picnic only?",
    [
      {
        tool: "restrict_to_products",
        arguments: { productTitle: "Picnic Xinomavro" },
      },
      { tool: "simulate_plan", arguments: { coverDays: 90 } },
    ],
    null,
  );

  assert.equal(
    prisma.state.action.plan.coverDays,
    120,
    "simulation must not persist",
  );
  assert.equal(supplierRuns(prisma), 0);

  // Turn 2: persist.
  const persisted = await turn(
    prisma,
    "Okay, make that the plan.",
    [{ tool: "update_plan", arguments: { coverDays: 90 } }],
    null,
  );
  assert.equal(persisted.outcome, TURN_OUTCOME.success);
  assert.equal(prisma.state.action.plan.coverDays, 90);

  // Turn 3: downstream artifact generation.
  const emailed = await turn(
    prisma,
    "Give me the supplier note.",
    [{ tool: "draft_supplier_email", arguments: {} }],
    null,
  );

  assert.equal(emailed.outcome, TURN_OUTCOME.success);
  assert.equal(supplierRuns(prisma), 1);
  assert.match(emailed.reply, /Picnic Xinomavro/);
  assert.match(emailed.reply, /\b9\b/);
});

const TRANSFER_STEP = {
  title: "Create Shopify transfer",
  description: "Move approved replenishment quantities between Shopify locations",
  capabilityRef: "execute:shopify_inventory_transfer:restock",
};

const BASE_REPLANNED_STEPS = [
  {
    semanticKey: "review_low_cover_inventory",
    title: "Review low-cover inventory",
    description:
      "Review at-risk SKUs, stock cover, and suggested reorder quantities.",
    mode: "assist",
    capabilityRef: "assist:inventory_review",
    dependsOn: [],
  },
  {
    semanticKey: "build_replenishment_proposal",
    title: "Build replenishment proposal",
    description:
      "Prepare the replenishment proposal from the current cover target.",
    mode: "assist",
    capabilityRef: "assist:replenishment_proposal",
    dependsOn: ["review_low_cover_inventory"],
  },
  {
    semanticKey: "draft_supplier_communication",
    title: "Draft supplier email",
    description:
      "Draft supplier communication for the approved replenishment.",
    mode: "assist",
    capabilityRef: "assist:supplier_email_draft",
    dependsOn: ["build_replenishment_proposal"],
  },
];

const TRANSFER_REPLANNED_STEP = {
  semanticKey: "create_shopify_transfer",
  title: "Create Shopify inventory transfer",
  description:
    "Create the Shopify inventory transfer for the approved replenishment quantities.",
  mode: "execute",
  capabilityRef: "execute:shopify_inventory_transfer:restock",
  dependsOn: ["draft_supplier_communication"],
};

const PURCHASE_ORDER_REPLANNED_STEP = {
  semanticKey: "create_purchase_order",
  title: "Create purchase order",
  description: "Raise the purchase order outside Jefe for the replenishment.",
  mode: "merchant_action",
  capabilityRef: "merchant_action:external_purchase_order",
  dependsOn: ["draft_supplier_communication"],
};

function replanProvider(agentToolCalls) {
  return scriptedProvider((payload) => {
    if (payload?.task === "action_replan") {
      return {
        plan: {
          goal: "Prepare the replenishment and create the Shopify stock transfer.",
          steps: [...BASE_REPLANNED_STEPS, TRANSFER_REPLANNED_STEP],
        },
      };
    }
    if (
      Array.isArray(payload?.toolResultsThisTurn) &&
      payload.toolResultsThisTurn.length > 0
    ) {
      return { done: true, finalReply: null, toolCalls: [] };
    }
    return { done: false, finalReply: null, toolCalls: agentToolCalls };
  });
}

function contextualReplanProvider(observedReplanPayloads = []) {
  return scriptedProvider((payload) => {
    if (payload?.task === "action_replan") {
      observedReplanPayloads.push(payload);
      return { plan: desiredPlanForInstruction(payload) };
    }
    if (
      Array.isArray(payload?.toolResultsThisTurn) &&
      payload.toolResultsThisTurn.length > 0
    ) {
      return { done: true, finalReply: null, toolCalls: [] };
    }
    const message = String(payload?.merchantMessage ?? "").toLowerCase();
    if (/what would.*90 days/.test(message)) {
      return {
        done: false,
        finalReply: null,
        toolCalls: [{ tool: "simulate_plan", arguments: { coverDays: 90 } }],
      };
    }
    if (/change the plan to 90|make.*90/.test(message)) {
      return {
        done: false,
        finalReply: null,
        toolCalls: [{ tool: "update_plan", arguments: { coverDays: 90 } }],
      };
    }
    return {
      done: false,
      finalReply: null,
      toolCalls: [
        {
          tool: "replan_action",
          arguments: { merchantInstruction: payload?.merchantMessage },
        },
      ],
    };
  });
}

function desiredPlanForInstruction(payload) {
  const instruction = String(payload?.merchantInstruction ?? "").toLowerCase();
  const recent = JSON.stringify(payload?.recentConversation ?? []);
  if (/purchase order|purchase orders|\bpo\b|\bpos\b/.test(instruction)) {
    return {
      goal: "Prepare the replenishment and raise a purchase order.",
      steps: [...BASE_REPLANNED_STEPS, PURCHASE_ORDER_REPLANNED_STEP],
    };
  }
  if (/shopify transfer|stock transfer|inventory transfer/.test(instruction)) {
    return {
      goal: "Prepare the replenishment and create the Shopify stock transfer.",
      steps: [...BASE_REPLANNED_STEPS, TRANSFER_REPLANNED_STEP],
    };
  }
  if (/remove step 4|remove that final step|remove the final step/.test(instruction)) {
    return {
      goal: "Prepare the replenishment with supplier communication.",
      steps: [...BASE_REPLANNED_STEPS],
    };
  }
  if (/i meant/.test(instruction) && /shopify transfers/i.test(recent)) {
    return {
      goal: "Prepare the replenishment and raise a purchase order.",
      steps: [...BASE_REPLANNED_STEPS, PURCHASE_ORDER_REPLANNED_STEP],
    };
  }
  return {
    goal: "Prepare the replenishment with supplier communication.",
    steps: [...BASE_REPLANNED_STEPS],
  };
}

function currentSteps(prisma) {
  return prisma.state.steps
    .filter((row) => String(row.status ?? "") !== "superseded")
    .sort((a, b) => Number(a.orderIndex ?? 0) - Number(b.orderIndex ?? 0));
}

function currentTitles(prisma) {
  return currentSteps(prisma).map((step) => step.title);
}

function currentModes(prisma) {
  return currentSteps(prisma).map((step) => step.mode);
}

function appendTranscript(transcript, message, result) {
  transcript.push({ role: "user", content: message });
  transcript.push({ role: "assistant", content: result.reply ?? "" });
}

function transferSteps(prisma) {
  return prisma.state.steps.filter((row) =>
    /shopify transfer|shopify inventory transfer|stock transfer|inventory transfer/i.test(
      String(row.title ?? ""),
    ),
  );
}

function assertTransferStepPersisted(prisma, initialCount) {
  assert.equal(
    prisma.state.steps.length,
    initialCount + 1,
    "canonical plan must gain exactly one new step",
  );
  const added = transferSteps(prisma);
  assert.equal(
    added.length,
    1,
    "transfer step must be persisted, not chat-only",
  );
  assert.equal(added[0].capabilityRef, TRANSFER_STEP.capabilityRef);
  assert.ok(
    added[0].dependsOnStepIds.length > 0,
    "new step must declare dependencies on existing workflow steps",
  );
  const knownIds = new Set(
    prisma.state.steps.filter((row) => row !== added[0]).map((row) => row.id),
  );
  assert.ok(
    added[0].dependsOnStepIds.every((id) => knownIds.has(id)),
    "dependsOnStepIds must reference real step IDs, not LLM placeholders",
  );
}

test("scenario H - plan mutation: add Shopify transfer step (wording variant 1)", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  const result = await turn(
    prisma,
    "Add another step to move this into Shopify.",
    [{ tool: "add_plan_step", arguments: TRANSFER_STEP }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assertTransferStepPersisted(prisma, initialCount);
  assert.match(result.reply, /Create Shopify transfer/i);
});

test("structural replan: merchant does not need to supply add_plan_step title", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  await turn(prisma, "Great, change the plan to 90 days.", [
    { tool: "update_plan", arguments: { coverDays: 90 } },
  ]);

  const result = await handleFocusedActionMessage(prisma, {
    message:
      "We actually use Shopify transfers for this. Add a final step to create the stock transfer in Shopify.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: replanProvider([{ tool: "replan_action", arguments: {} }]),
    logger: quietLogger,
  });

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(
    prisma.state.action.plan.coverDays,
    90,
    "replan must preserve the current cover target",
  );
  assertTransferStepPersisted(prisma, initialCount);
  assert.doesNotMatch(
    result.reply,
    /needs "title"|step title|what should the new step be called/i,
  );
});

test("compatibility: missing-title add_plan_step is routed through replanning, not leaked", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  const result = await handleFocusedActionMessage(prisma, {
    message:
      "We actually use Shopify transfers for this. Add a final step to create the stock transfer in Shopify.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider: replanProvider([{ tool: "add_plan_step", arguments: {} }]),
    logger: quietLogger,
  });

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assertTransferStepPersisted(prisma, initialCount);
  assert.doesNotMatch(
    result.reply,
    /add_plan_step|needs "title"|step title|what should the new step be called/i,
  );
});

test("structural replanning preserves order, corrections, removals, identity and plan decisions", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const observedReplans = [];
  const provider = contextualReplanProvider(observedReplans);
  const transcript = [];
  const initial = currentSteps(prisma);
  const initialIds = initial.map((step) => step.id);
  const initialModes = initial.map((step) => step.mode);

  async function say(message) {
    const result = await handleFocusedActionMessage(prisma, {
      message,
      merchantId: MERCHANT,
      shopId: SHOP,
      actionId: prisma.state.action.id,
      provider,
      recentMessages: transcript.slice(-8),
      logger: quietLogger,
    });
    appendTranscript(transcript, message, result);
    assert.doesNotMatch(
      result.reply,
      /add_plan_step|needs "title"|step title|dependency id|capability reference|couldn't safely revise/i,
    );
    return result;
  }

  await say("What would it look like if we only held 90 days of cover?");
  assert.equal(
    prisma.state.action.plan.coverDays,
    120,
    "hypothetical cover must not persist",
  );

  await say("Great, change the plan to 90 days.");
  assert.equal(prisma.state.action.plan.coverDays, 90);

  await say(
    "We actually use Shopify transfers for this. Add a final step to create the stock transfer in Shopify.",
  );
  assert.deepEqual(currentTitles(prisma), [
    "Review low-cover inventory",
    "Build replenishment proposal",
    "Draft supplier email",
    "Create Shopify inventory transfer",
  ]);
  assert.deepEqual(
    currentSteps(prisma).slice(0, 3).map((step) => step.id),
    initialIds,
    "unchanged steps must preserve IDs after adding transfer",
  );
  assert.deepEqual(currentModes(prisma).slice(0, 3), initialModes);
  const transferId = currentSteps(prisma)[3].id;

  await say("I meant purchase orders sorry.");
  assert.deepEqual(currentTitles(prisma), [
    "Review low-cover inventory",
    "Build replenishment proposal",
    "Draft supplier email",
    "Create purchase order",
  ]);
  assert.deepEqual(
    currentSteps(prisma).slice(0, 3).map((step) => step.id),
    initialIds,
    "unchanged steps must preserve IDs when transfer is replaced by PO",
  );
  assert.deepEqual(currentModes(prisma).slice(0, 3), initialModes);
  assert.equal(prisma.state.action.plan.coverDays, 90);
  assert.equal(
    prisma.state.steps.find((step) => step.id === transferId)?.status,
    "superseded",
    "replaced transfer step must leave a superseded history row",
  );
  assert.ok(
    observedReplans.at(-1)?.recentConversation?.some((message) =>
      /shopify transfers/i.test(message.content),
    ),
    "correction replanning must receive recent conversation context",
  );
  const firstPurchaseId = currentSteps(prisma)[3].id;

  await say("Actually remove that final step.");
  assert.deepEqual(currentTitles(prisma), [
    "Review low-cover inventory",
    "Build replenishment proposal",
    "Draft supplier email",
  ]);
  assert.deepEqual(currentSteps(prisma).map((step) => step.id), initialIds);
  assert.equal(
    prisma.state.steps.find((step) => step.id === firstPurchaseId)?.status,
    "superseded",
  );

  await say("Add the purchase order back at the end.");
  assert.deepEqual(currentTitles(prisma), [
    "Review low-cover inventory",
    "Build replenishment proposal",
    "Draft supplier email",
    "Create purchase order",
  ]);
  assert.equal(currentSteps(prisma)[3].title, "Create purchase order");
  assert.notEqual(
    currentSteps(prisma)[3].id,
    firstPurchaseId,
    "a previously removed step should remain historical when re-added",
  );

  await say("Remove step 4.");
  assert.deepEqual(currentTitles(prisma), [
    "Review low-cover inventory",
    "Build replenishment proposal",
    "Draft supplier email",
  ]);
  assert.deepEqual(currentSteps(prisma).map((step) => step.id), initialIds);
  assert.equal(prisma.state.action.plan.coverDays, 90);
});

test("structural replanning repairs invalid model plans before failing the merchant turn", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  let repairSeen = false;
  const provider = scriptedProvider((payload) => {
    if (payload?.task === "action_replan") {
      return {
        plan: {
          goal: "Broken draft",
          steps: [{ semanticKey: "create_shopify_transfer" }],
        },
      };
    }
    if (payload?.task === "action_replan_repair") {
      repairSeen = true;
      assert.equal(payload.validationError.reason, "missing_step_title");
      return {
        plan: {
          goal: "Prepare the replenishment and create the Shopify stock transfer.",
          steps: [...BASE_REPLANNED_STEPS, TRANSFER_REPLANNED_STEP],
        },
      };
    }
    if (
      Array.isArray(payload?.toolResultsThisTurn) &&
      payload.toolResultsThisTurn.length > 0
    ) {
      return { done: true, finalReply: null, toolCalls: [] };
    }
    return {
      done: false,
      finalReply: null,
      toolCalls: [{ tool: "replan_action", arguments: {} }],
    };
  });

  const result = await handleFocusedActionMessage(prisma, {
    message: "Add the Shopify transfer as the final step.",
    merchantId: MERCHANT,
    shopId: SHOP,
    actionId: prisma.state.action.id,
    provider,
    logger: quietLogger,
  });

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assert.equal(repairSeen, true);
  assert.equal(currentSteps(prisma).at(-1)?.title, "Create Shopify inventory transfer");
  assert.doesNotMatch(result.reply, /missing_step_title|schema|invalid/i);
});

test("scenario I - plan mutation: add Shopify transfer step (wording variant 2)", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  const result = await turn(
    prisma,
    "We use transfers in Shopify after this.",
    [{ tool: "add_plan_step", arguments: TRANSFER_STEP }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assertTransferStepPersisted(prisma, initialCount);
});

test("scenario J - plan mutation: add Shopify transfer step (wording variant 3)", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  const result = await turn(
    prisma,
    "Before we're finished, create the stock transfer in Shopify too.",
    [{ tool: "add_plan_step", arguments: TRANSFER_STEP }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assertTransferStepPersisted(prisma, initialCount);
});

test("scenario K - plan mutation: add Shopify transfer as final step (wording variant 4)", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  const result = await turn(
    prisma,
    "Can you add a Shopify transfer as the final step?",
    [{ tool: "add_plan_step", arguments: TRANSFER_STEP }],
    null,
  );

  assert.equal(result.outcome, TURN_OUTCOME.success);
  assertTransferStepPersisted(prisma, initialCount);
  const added = transferSteps(prisma)[0];
  const lastExisting = prisma.state.steps
    .filter((row) => row.id !== added.id)
    .sort((a, b) => Number(b.orderIndex ?? 0) - Number(a.orderIndex ?? 0))[0];
  assert.ok(
    added.dependsOnStepIds.includes(lastExisting.id),
    "final transfer step should depend on the prior workflow step",
  );
});

test("scenario L - exploratory: what would a Shopify transfer step involve (no plan mutation)", async () => {
  const prisma = buildActionFixture({ kind: "restock" });
  const initialCount = prisma.state.steps.length;

  const result = await turn(
    prisma,
    "Actually don't change anything yet — what would a Shopify transfer step involve?",
    [],
    "A Shopify transfer step would move the approved replenishment quantities between two Shopify locations. I haven't changed your plan.",
  );

  assert.equal(
    prisma.state.steps.length,
    initialCount,
    "exploratory question must not mutate plan",
  );
  assert.equal(transferSteps(prisma).length, 0);
  assert.equal(result.outcome, TURN_OUTCOME.noAction);
  assert.match(result.reply, /haven't changed/i);
});
