#!/usr/bin/env node

/**
 * Development-only live Gemini evaluator for the focused-action runtime.
 *
 * This is intentionally outside `npm test`: it makes real model calls, uses a
 * local development database fixture, and exercises the same
 * handleFocusedActionMessage path used by the app.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

import { loadLocalEnv } from "./load-env.mjs";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import {
  getLlmConfig,
  DEFAULT_LLM_CHAT_FALLBACK_MODEL,
  DEFAULT_LLM_FALLBACK_MODEL,
} from "../app/lib/llm/config.server.js";
import { handleFocusedActionMessage } from "../app/lib/actions/agent/focused-action-turn.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";
import { logger as baseLogger } from "../app/lib/observability/logger.server.js";

loadLocalEnv(process.cwd());

const MERCHANT_ID = "00000000-0000-4000-8000-00000000e001";
const SHOP_ID = "00000000-0000-4000-8000-00000000e002";
const ACTOR = "focused-action-live-eval";
const REPORT_PATH = resolve(
  process.cwd(),
  "../../.context/focused-action-live-eval/latest.json",
);

const logger = baseLogger.child({ component: "focused-action-live-eval" });

const prisma = new PrismaClient();

const SCENARIOS = [
  {
    key: "A",
    title: "Hypothetical does not mutate",
    turns: ["What would it look like if we only held 90 days of cover?"],
    assert: [
      assertCanonicalCover(120),
      assertReplyMentions(/90/),
      assertTransferAbsent,
    ],
  },
  {
    key: "B",
    title: "Adopt the hypothetical",
    turns: [
      "What would it look like if we only held 90 days of cover?",
      "Great, change the plan to 90 days.",
    ],
    assert: [assertCanonicalCover(90), assertQuantities(9)],
  },
  {
    key: "C",
    title: "Structural replan from natural language",
    turns: [
      "What would it look like if we only held 90 days of cover?",
      "Great, change the plan to 90 days.",
      "We actually use Shopify transfers for this. Add a final step to create the stock transfer in Shopify.",
    ],
    assert: [
      assertCanonicalCover(90),
      assertTransferPresent,
      assertNoInternalValidationLeak,
      assertReplanInvoked,
    ],
  },
  {
    key: "D",
    title: "Implicit structural information",
    turns: [
      "We normally move this stock into our warehouse with a Shopify transfer before we're finished.",
    ],
    assert: [assertTransferPresent, assertReplanInvoked],
  },
  {
    key: "E",
    title: "Exploratory structural question",
    turns: ["What would adding a Shopify transfer step involve?"],
    assert: [assertTransferAbsent, assertNoMutation],
  },
  {
    key: "F",
    title: "Natural adoption after exploratory question",
    turns: [
      "What would adding a Shopify transfer step involve?",
      "Yeah, let's do that.",
    ],
    assert: [assertTransferPresent, assertReplanInvoked],
  },
  {
    key: "G",
    title: "Preserve prior decisions during replanning",
    turns: [
      "Change the plan to 90 days.",
      "We use Shopify transfers for this, so update the workflow.",
    ],
    assert: [assertCanonicalCover(90), assertTransferPresent],
  },
  {
    key: "H",
    title: "Replan with a change to an existing step",
    turns: [
      "We don't actually email the supplier, we call them. Change the plan to reflect that.",
    ],
    assert: [
      assertStepPresent(/call|phone/i),
      assertStepAbsent(/email/i),
      assertReplanInvoked,
    ],
  },
  {
    key: "I",
    title: "Add a prerequisite",
    turns: [
      "Before we order anything, I want to check the supplier's lead time.",
    ],
    assert: [assertStepPresent(/lead time/i), assertReplanInvoked],
  },
  {
    key: "J",
    title: "Remove unnecessary workflow",
    turns: ["We don't need supplier communication at all for this merchant."],
    assert: [
      assertStepAbsent(/supplier communication|email/i),
      assertReplanInvoked,
    ],
  },
  {
    key: "K-P",
    title: "Transfer execution runtime scenarios",
    blocked: true,
    turns: ["We use Shopify transfers for this, so update the workflow."],
    assert: [assertTransferRuntimeImplemented],
  },
  {
    key: "R",
    title: "Exact replan correction/removal journey",
    turns: [
      "What would it look like if we only held 90 days of cover?",
      "Great, change the plan to 90 days.",
      "We actually use Shopify transfers for this. Add a final step to create the stock transfer in Shopify.",
      "I meant purchase orders sorry.",
      "Actually remove that final step.",
      "Add the purchase order back at the end.",
      "Remove step 4.",
    ],
    assert: [assertExactReplanJourney],
  },
  {
    key: "Q1",
    title: "Rephrase resistance: 90-day adoption",
    turns: [
      "What would 90 days look like?",
      "Make the 90-day one the real plan.",
    ],
    assert: [assertCanonicalCover(90)],
  },
  {
    key: "Q2",
    title: "Rephrase resistance: transfer wording",
    turns: ["Put a Shopify stock transfer at the end too."],
    assert: [assertTransferPresent],
  },
  {
    key: "Q3",
    title: "Rephrase resistance: implicit transfer wording",
    turns: ["We transfer these internally in Shopify."],
    assert: [assertTransferPresent],
  },
];

async function main() {
  assertLocalDatabase();
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is required for npm run eval:focused-action-live.",
    );
  }

  const provider = createGeminiEvalProvider();
  const results = [];
  const selectedScenarios = scenarioSelection();
  const scenarios = SCENARIOS.filter((scenario) =>
    selectedScenarios.has(scenario.key),
  );

  process.stdout.write(
    `# focused-action live eval provider=${provider.provider} model=${provider.model} scenarios=${scenarios.map((row) => row.key).join(",")}\n`,
  );

  for (const scenario of scenarios) {
    process.stdout.write(`# scenario ${scenario.key}: ${scenario.title}\n`);
    const result = await runScenario(provider, scenario);
    results.push(result);
    await writeReport(buildReport(provider, results));
    process.stdout.write(
      result.ok ? "ok\n" : `not ok: ${result.failure?.message}\n`,
    );
  }

  const failed = results.filter((result) => !result.ok);
  await writeReport(buildReport(provider, results));

  if (failed.length > 0) {
    process.stderr.write(
      `\n${failed.length} focused-action live scenario(s) failed. Report: ${REPORT_PATH}\n`,
    );
    process.exit(1);
  }
}

function createGeminiEvalProvider() {
  const chat = getLlmConfig({ feature: "general_chat" });
  const model =
    process.env.LLM_FOCUSED_ACTION_EVAL_MODEL ||
    (chat.provider === "gemini"
      ? chat.model
      : chat.fallbackProvider === "gemini"
        ? chat.fallbackModel
        : DEFAULT_LLM_CHAT_FALLBACK_MODEL);
  return createLlmProvider({
    config: {
      ...chat,
      enabled: true,
      provider: "gemini",
      model,
      fallbackProvider: "gemini",
      fallbackModel:
        process.env.LLM_FOCUSED_ACTION_EVAL_FALLBACK_MODEL ||
        (model === chat.fallbackModel
          ? DEFAULT_LLM_FALLBACK_MODEL
          : chat.fallbackModel),
      timeoutMs: positiveInteger(
        process.env.LLM_FOCUSED_ACTION_EVAL_TIMEOUT_MS,
        chat.timeoutMs,
      ),
    },
    logger,
    usage: {
      prisma,
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      feature: "focused_action_live_eval",
      runType: "development_eval",
      runId: randomUUID(),
    },
  });
}

function buildReport(provider, results) {
  const failed = results.filter((result) => !result.ok);
  return {
    generatedAt: new Date().toISOString(),
    provider: provider.provider,
    model: provider.model,
    fallbackProvider: provider.fallbackProvider ?? null,
    fallbackModel: provider.fallbackModel ?? null,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
}

function scenarioSelection() {
  const raw = [
    ...process.argv.slice(2),
    ...(process.env.FOCUSED_ACTION_LIVE_SCENARIOS || "").split(","),
  ]
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  if (!raw.length) {
    return new Set(
      SCENARIOS.filter((scenario) => !scenario.blocked).map(
        (scenario) => scenario.key,
      ),
    );
  }
  const wanted = new Set(raw);
  const known = new Set(SCENARIOS.map((scenario) => scenario.key));
  for (const key of wanted) {
    if (!known.has(key)) {
      throw new Error(
        `Unknown focused-action live scenario "${key}". Known: ${[...known].join(", ")}.`,
      );
    }
  }
  return wanted;
}

async function runScenario(provider, scenario) {
  const fixture = await resetFixture(scenario.key);
  const transcript = [];
  const turns = [];
  let stateBeforeScenario = await inspect(fixture.actionId);

  for (const [index, message] of scenario.turns.entries()) {
    const before = await inspect(fixture.actionId);
    const startedAt = Date.now();
    let result;
    let error = null;
    try {
      result = await handleFocusedActionMessage(prisma, {
        message,
        merchantId: MERCHANT_ID,
        shopId: SHOP_ID,
        actionId: fixture.actionId,
        conversationId: fixture.conversationId,
        actor: ACTOR,
        provider,
        recentMessages: transcript.slice(-8),
        logger,
      });
    } catch (caught) {
      error = caught;
      result = {
        ok: false,
        reply: caught instanceof Error ? caught.message : String(caught),
        ledger: [],
        trace: null,
      };
    }
    const after = await inspect(fixture.actionId);
    const turn = {
      turn: index + 1,
      userMessage: message,
      assistantResponse: result.reply ?? "",
      durationMs: Date.now() - startedAt,
      model: provider.model,
      fallbackModel: provider.fallbackModel ?? null,
      structuredOutput: result.trace?.iterations ?? null,
      plannerError: result.trace?.plannerError ?? null,
      plannerErrorMessage: result.trace?.plannerErrorMessage ?? null,
      plannerErrorStatus: result.trace?.plannerErrorStatus ?? null,
      operationsRequested:
        result.trace?.iterations?.flatMap((row) => row.requestedTools ?? []) ??
        [],
      operationsApplied: (result.ledger ?? [])
        .filter((row) => row.ok)
        .map((row) => row.tool),
      ledger: result.ledger ?? [],
      structuralSnapshots: structuralSnapshots(result, before, after),
      stateBefore: before,
      stateAfter: after,
      error: error ? errorReport(error) : null,
    };
    turns.push(turn);
    transcript.push({ role: "user", content: message });
    transcript.push({ role: "assistant", content: result.reply ?? "" });
  }

  const finalState = await inspect(fixture.actionId);
  try {
    for (const assertion of scenario.assert) {
      await assertion({
        scenario,
        turns,
        finalState,
        initialState: stateBeforeScenario,
      });
    }
    return {
      key: scenario.key,
      title: scenario.title,
      ok: true,
      turns,
      finalState,
    };
  } catch (error) {
    return {
      key: scenario.key,
      title: scenario.title,
      ok: false,
      turns,
      initialState: stateBeforeScenario,
      finalState,
      failure: errorReport(error),
    };
  }
}

async function resetFixture(scenarioKey) {
  await prisma.merchant.deleteMany({ where: { id: MERCHANT_ID } });
  await prisma.merchant.create({
    data: { id: MERCHANT_ID, name: "Focused Action Live Eval" },
  });
  await prisma.shop.create({
    data: {
      id: SHOP_ID,
      merchantId: MERCHANT_ID,
      shopDomain: "focused-action-live-eval.myshopify.com",
      status: "active",
      setupStatus: "installed",
      onboardingCompletedAt: new Date(),
    },
  });

  const runId = randomUUID();
  const recommendationId = randomUUID();
  const workflowId = randomUUID();
  const actionId = randomUUID();
  const conversationId = randomUUID();
  const step1 = randomUUID();
  const step2 = randomUUID();
  const step3 = randomUUID();

  await prisma.merchantMemoryBelief.create({
    data: {
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      category: "inventory",
      key: "inventory.low_cover_products.trailing_30d",
      valueType: "json",
      status: "active",
      confidence: 0.99,
      value: {
        items: [
          {
            title: "Pear Skin Sipon",
            productId: "gid://shopify/Product/pear-skin-sipon",
            available: 0,
            dailyVelocity: 0.1,
            daysOfCover: 0,
          },
          {
            title: "Picnic Xinomavro",
            productId: "gid://shopify/Product/picnic-xinomavro",
            available: 0,
            dailyVelocity: 0.1,
            daysOfCover: 0,
          },
        ],
      },
    },
  });

  await prisma.merchantPlanRun.create({
    data: {
      id: runId,
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      status: "completed",
      snapshotVersion: "focused-action-live-eval",
      snapshotHash: `focused-action-live-eval-${scenarioKey}-${Date.now()}`,
      promptVersion: "focused-action-live-eval",
      schemaVersion: "focused-action-live-eval",
      provider: "fixture",
      modelIdentifier: "fixture",
      completedAt: new Date(),
    },
  });
  await prisma.merchantPlanRecommendation.create({
    data: {
      id: recommendationId,
      runId,
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      title: "Review At-Risk Inventory and Prepare Restock Plan",
      summary: "Prepare a replenishment plan for low-cover products.",
      whyThisAction:
        "Pear Skin Sipon and Picnic Xinomavro are below target cover.",
      whyNow: "The current stock position is below target.",
      startToday:
        "Review the low-cover products and prepare replenishment quantities.",
      expectedBenefit: "Reduce stockout risk.",
      successSignal: {
        description: "Low-cover products have a current replenishment plan.",
      },
      confidence: "high",
      reviewStatus: "proposed",
    },
  });
  await prisma.merchantRecommendationWorkflow.create({
    data: {
      id: workflowId,
      recommendationId,
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      version: 1,
      status: "draft",
      source: "focused_action_live_eval",
    },
  });
  await prisma.merchantRecommendationStep.createMany({
    data: [
      stepData(
        step1,
        workflowId,
        recommendationId,
        0,
        "Review low-cover inventory",
        "assist:inventory_review",
        [],
      ),
      stepData(
        step2,
        workflowId,
        recommendationId,
        1,
        "Build replenishment proposal",
        "assist:replenishment_proposal",
        [step1],
      ),
      stepData(
        step3,
        workflowId,
        recommendationId,
        2,
        "Draft supplier communication",
        "assist:supplier_email_draft",
        [step2],
      ),
    ],
  });
  await prisma.merchantAction.create({
    data: {
      id: actionId,
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      title: "Review At-Risk Inventory and Prepare Restock Plan",
      summary: "Prepare a replenishment plan for low-cover products.",
      status: "proposed",
      sourceRecommendationId: recommendationId,
      plan: { coverDays: 120 },
      progress: { evalScenario: scenarioKey },
      outcome: {},
    },
  });
  await prisma.merchantMemoryConversation.create({
    data: {
      id: conversationId,
      merchantId: MERCHANT_ID,
      shopId: SHOP_ID,
      focusedActionId: actionId,
      topic: "action",
      conversationType: "focused_action",
      surface: "development_eval",
      title: `Live eval ${scenarioKey}`,
      context: {},
      lastMessageAt: new Date(),
    },
  });

  return { actionId, conversationId };
}

function stepData(
  id,
  workflowId,
  recommendationId,
  orderIndex,
  title,
  capabilityRef,
  dependsOnStepIds,
) {
  return {
    id,
    workflowId,
    recommendationId,
    merchantId: MERCHANT_ID,
    shopId: SHOP_ID,
    orderIndex,
    title,
    description: title,
    status: orderIndex === 0 ? "pending" : "waiting",
    mode: "assist",
    capabilityRef,
    dependsOnStepIds,
    evidenceIds: [],
  };
}

async function inspect(actionId) {
  const state = await resolveActionState(prisma, {
    merchantId: MERCHANT_ID,
    shopId: SHOP_ID,
    actionId,
  });
  const action = await prisma.merchantAction.findFirst({
    where: { id: actionId, merchantId: MERCHANT_ID, shopId: SHOP_ID },
    select: { progress: true },
  });
  const progress =
    action?.progress &&
    typeof action.progress === "object" &&
    !Array.isArray(action.progress)
      ? action.progress
      : {};
  const revisions = Array.isArray(progress.revisions) ? progress.revisions : [];
  return {
    plan: state?.plan?.values ?? {},
    steps: (state?.work ?? []).map((row) => ({
      id: row.step.id,
      title: row.step.title,
      status: row.state,
      order: row.step.orderIndex ?? null,
      mode: row.step.mode,
      capabilityRef: row.step.capabilityRef,
      dependsOn: row.dependsOn,
    })),
    artifacts: state?.artifacts ?? [],
    proposal: (state?.scope?.items ?? []).map((item) => ({
      title: item.title,
      recommendedUnits: item.recommendedUnits ?? null,
    })),
    actionRevision: revisions.length,
  };
}

function structuralSnapshots(result, before, after) {
  return (result.ledger ?? [])
    .filter((row) => row.tool === "replan_action")
    .map((row) => {
      const replan = row.facts?.replan ?? null;
      const replanDetail = replan?.result ?? replan;
      return {
        intentClassification:
          result.trace?.iterations?.find((iteration) =>
            (iteration.requestedTools ?? []).includes("replan_action"),
          )?.intent ?? null,
        replanRequest: replanDetail?.replanRequest ?? null,
        plannerInputSummary: summarizeReplanRequest(
          replanDetail?.replanRequest ?? null,
        ),
        rawStructuredPlan: replanDetail?.rawStructuredPlan ?? null,
        validationResult: replanDetail?.validation ?? null,
        repairAttempt:
          replanDetail?.validation?.repairAttempted === true
            ? replanDetail?.validation
            : null,
        oldPlan: replanDetail?.before ?? before,
        desiredPlan: replanDetail?.plan ?? null,
        semanticDiff: {
          applied: replanDetail?.applied ?? null,
          changes: replan?.changes ?? row.changes ?? [],
        },
        persistedPlan: after.steps,
        stepIds: after.steps.map((step) => step.id),
        stepOrder: after.steps.map((step) => step.title),
        stepOwners: after.steps.map((step) => step.mode),
        stepCapabilities: after.steps.map((step) => step.capabilityRef),
        actionRevision: after.actionRevision,
      };
    });
}

function summarizeReplanRequest(request) {
  if (!request) return null;
  return {
    merchantInstruction: request.merchantInstruction ?? null,
    recentConversationCount: Array.isArray(request.recentConversation)
      ? request.recentConversation.length
      : 0,
    currentWorkflow: (request.currentWorkflow ?? []).map((step) => ({
      position: step.position,
      title: step.title,
      mode: step.mode,
      capabilityRef: step.capabilityRef,
    })),
    currentPlanValues: request.currentPlanValues ?? {},
    availableCapabilityCount: Array.isArray(request.availableCapabilities)
      ? request.availableCapabilities.length
      : 0,
  };
}

function assertCanonicalCover(expected) {
  return ({ finalState }) => {
    if (Number(finalState.plan.coverDays) !== expected) {
      throw new Error(
        `Expected canonical cover target ${expected}, got ${finalState.plan.coverDays}.`,
      );
    }
  };
}

function assertQuantities(expected) {
  return ({ finalState }) => {
    for (const item of finalState.proposal) {
      if (Number(item.recommendedUnits) !== expected) {
        throw new Error(
          `Expected ${item.title} quantity ${expected}, got ${item.recommendedUnits}.`,
        );
      }
    }
  };
}

function assertReplyMentions(pattern) {
  return ({ turns }) => {
    if (!pattern.test(turns.at(-1)?.assistantResponse ?? "")) {
      throw new Error(`Expected assistant response to match ${pattern}.`);
    }
  };
}

function assertTransferPresent({ finalState }) {
  if (
    !finalState.steps.some((step) =>
      /shopify transfer|stock transfer|inventory transfer/i.test(step.title),
    )
  ) {
    throw new Error(
      "Expected canonical plan to contain a Shopify transfer step.",
    );
  }
}

function assertTransferAbsent({ finalState }) {
  if (
    finalState.steps.some((step) =>
      /shopify transfer|stock transfer|inventory transfer/i.test(step.title),
    )
  ) {
    throw new Error(
      "Expected canonical plan not to contain a Shopify transfer step.",
    );
  }
}

function assertStepPresent(pattern) {
  return ({ finalState }) => {
    if (!finalState.steps.some((step) => pattern.test(step.title))) {
      throw new Error(
        `Expected canonical plan to contain a step matching ${pattern}.`,
      );
    }
  };
}

function assertStepAbsent(pattern) {
  return ({ finalState }) => {
    if (finalState.steps.some((step) => pattern.test(step.title))) {
      throw new Error(
        `Expected canonical plan not to contain a step matching ${pattern}.`,
      );
    }
  };
}

function assertNoInternalValidationLeak({ turns }) {
  const text = turns.map((turn) => turn.assistantResponse).join("\n");
  if (
    /add_plan_step|needs "title"|step title|capability reference|dependency id/i.test(
      text,
    )
  ) {
    throw new Error("Assistant leaked internal tool/schema metadata.");
  }
}

function assertReplanInvoked({ turns }) {
  if (!turns.some((turn) => turn.operationsApplied.includes("replan_action"))) {
    throw new Error("Expected replan_action to be applied.");
  }
}

function assertNoMutation({ initialState, finalState }) {
  if (JSON.stringify(initialState.steps) !== JSON.stringify(finalState.steps)) {
    throw new Error("Expected no canonical workflow mutation.");
  }
  if (JSON.stringify(initialState.plan) !== JSON.stringify(finalState.plan)) {
    throw new Error("Expected no canonical plan mutation.");
  }
}

function assertExactReplanJourney({ turns, initialState, finalState }) {
  assertTurnCount(turns, 7);
  assertPlanCover(turns[0].stateAfter, 120, "turn 1 must stay hypothetical");
  assertPlanCover(turns[1].stateAfter, 90, "turn 2 must persist 90-day cover");
  assertStepOrder(turns[2].stateAfter, [
    /review.*low-cover|low-cover.*inventory/i,
    /replenishment.*proposal/i,
    /supplier.*(email|communication)/i,
    /(shopify|stock|inventory).*transfer|transfer.*shopify/i,
  ]);
  assertPlanCover(turns[2].stateAfter, 90, "turn 3 must preserve 90 days");

  assertStepOrder(turns[3].stateAfter, [
    /review.*low-cover|low-cover.*inventory/i,
    /replenishment.*proposal/i,
    /supplier.*(email|communication)/i,
    /purchase order|\bpo\b/i,
  ]);
  assertPlanCover(turns[3].stateAfter, 90, "turn 4 must preserve 90 days");
  assertNoStep(turns[3].stateAfter, /(shopify|stock|inventory).*transfer|transfer.*shopify/i);
  assertStablePrefix(turns[0].stateBefore, turns[3].stateAfter, 3);

  assertStepOrder(turns[4].stateAfter, [
    /review.*low-cover|low-cover.*inventory/i,
    /replenishment.*proposal/i,
    /supplier.*(email|communication)/i,
  ]);
  assertStablePrefix(turns[0].stateBefore, turns[4].stateAfter, 3);

  assertStepOrder(turns[5].stateAfter, [
    /review.*low-cover|low-cover.*inventory/i,
    /replenishment.*proposal/i,
    /supplier.*(email|communication)/i,
    /purchase order|\bpo\b/i,
  ]);

  assertStepOrder(turns[6].stateAfter, [
    /review.*low-cover|low-cover.*inventory/i,
    /replenishment.*proposal/i,
    /supplier.*(email|communication)/i,
  ]);
  assertStablePrefix(turns[0].stateBefore, turns[6].stateAfter, 3);
  assertPlanCover(finalState, 90, "final state must preserve 90-day cover");
  assertNoInternalValidationLeak({ turns });

  for (const turn of [turns[2], turns[3], turns[4], turns[5], turns[6]]) {
    if (!turn.operationsApplied.includes("replan_action")) {
      throw new Error(`Expected turn ${turn.turn} to apply replan_action.`);
    }
    if (!turn.structuralSnapshots.length) {
      throw new Error(`Expected turn ${turn.turn} to record replan snapshots.`);
    }
  }
}

function assertTurnCount(turns, expected) {
  if (turns.length !== expected) {
    throw new Error(`Expected ${expected} turns, got ${turns.length}.`);
  }
}

function assertPlanCover(state, expected, message) {
  if (Number(state.plan.coverDays) !== expected) {
    throw new Error(`${message}; got ${state.plan.coverDays}.`);
  }
}

function assertStepOrder(state, patterns) {
  const titles = state.steps.map((step) => step.title);
  if (titles.length !== patterns.length) {
    throw new Error(
      `Expected ${patterns.length} current steps, got ${titles.length}: ${titles.join(" | ")}.`,
    );
  }
  for (const [index, pattern] of patterns.entries()) {
    if (!pattern.test(titles[index] ?? "")) {
      throw new Error(
        `Expected step ${index + 1} to match ${pattern}, got "${titles[index]}". Full order: ${titles.join(" | ")}.`,
      );
    }
  }
}

function assertNoStep(state, pattern) {
  const hit = state.steps.find((step) => pattern.test(step.title));
  if (hit) throw new Error(`Unexpected step "${hit.title}" in current plan.`);
}

function assertStablePrefix(before, after, count) {
  const beforeSteps = before.steps.slice(0, count);
  const afterSteps = after.steps.slice(0, count);
  for (let index = 0; index < count; index += 1) {
    if (beforeSteps[index]?.id !== afterSteps[index]?.id) {
      throw new Error(
        `Expected step ${index + 1} ID to stay ${beforeSteps[index]?.id}, got ${afterSteps[index]?.id}.`,
      );
    }
    if (beforeSteps[index]?.mode !== afterSteps[index]?.mode) {
      throw new Error(
        `Expected step ${index + 1} mode to stay ${beforeSteps[index]?.mode}, got ${afterSteps[index]?.mode}.`,
      );
    }
  }
}

function assertTransferRuntimeImplemented() {
  throw new Error(
    "Transfer preview/execution scenarios K-P are not wired into focused-action runtime yet. The adapter exists, but no agent tool/orchestrator can preview or execute execute:shopify_inventory_transfer:restock.",
  );
}

async function writeReport(report) {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(
    REPORT_PATH,
    `${JSON.stringify(redactReport(report), null, 2)}\n`,
  );
}

function redactReport(value) {
  return JSON.parse(
    JSON.stringify(value, (key, inner) => {
      if (/token|secret|password/i.test(key)) return "[redacted]";
      if (/apiKey|accessKey|privateKey/i.test(key)) return "[redacted]";
      return inner;
    }),
  );
}

function errorReport(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
}

function assertLocalDatabase() {
  const url = new URL(process.env.DATABASE_URL || "");
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(
      "Refusing to run live eval against a non-local DATABASE_URL.",
    );
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main()
  .catch(async (error) => {
    await writeReport({
      generatedAt: new Date().toISOString(),
      fatal: errorReport(error),
    });
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
