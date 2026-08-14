import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkflowStepUpdatesFromReply,
  buildCurrentActionInput,
  buildGroundedFallbackReply,
} from "../app/lib/merchant-memory/general-chat.server.js";

// The grounded fallback interpolates a retrieved item's content straight into the reply.
// Not every retrieved item is prose — some carry a serialised belief value — so a merchant
// asking about growth was shown:
//
//   From what I know about your business, Trailing 90d: {"items":[{"name":"Meadowline",
//   "revenue":1527.5,"sharePercent":30.13}, …
//
// Found by the answer-quality harness against the holistic chat, on the path taken whenever
// both LLM providers fail. Raw JSON is never an answer; admitting the gap is better.

const ctx = (semantic) => ({
  queryClass: "general",
  semanticMemory: semantic,
  episodicMemory: [],
  actionMemory: [],
});

const actionCtx = (focusedAction, extraActionEvidence = {}) => ({
  ...ctx([{ content: "12-month goal: scale direct-to-consumer beverage sales" }]),
  actionEvidence: { focusedAction, ...extraActionEvidence },
});
const STEP_ONE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEP_TWO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_STEP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("a serialised belief value is never read out to the merchant", () => {
  const reply = buildGroundedFallbackReply("how is growth?", ctx([
    {
      content:
        'Trailing 90d: {"items":[{"name":"Meadowline","revenue":1527.5,"sharePercent":30.13}]}',
    },
  ]));

  assert.doesNotMatch(reply, /\{"/, "no JSON object may reach merchant copy");
  assert.doesNotMatch(reply, /sharePercent/);
  assert.match(reply, /couldn’t connect|couldn't connect/, "admits the gap instead");
});

test("a readable item is still used", () => {
  // Selection is by word overlap with the question, so the item has to share a term —
  // this test is about prose surviving the filter, not about the scorer.
  const reply = buildGroundedFallbackReply("how is revenue?", ctx([
    { content: "Revenue grew about 12% over the last 90 days" },
  ]));

  assert.match(reply, /Revenue grew about 12%/);
  assert.match(reply, /^From what I know about your business,/);
});

test("a readable item is preferred over a serialised one", () => {
  // The JSON item is first and would otherwise win on position.
  const reply = buildGroundedFallbackReply("how are repeat customers?", ctx([
    { content: 'Repeat customers coverage: {"ratio":1,"numerator":436}' },
    { content: "Repeat customers are about a third of all orders" },
  ]));

  assert.match(reply, /Repeat customers/);
  assert.doesNotMatch(reply, /ratio/);
});

test("key/value fragments are rejected too, not just full objects", () => {
  const reply = buildGroundedFallbackReply("what is the denominator?", ctx([
    { content: '"percentage": 100, "denominator": 436' },
  ]));

  assert.doesNotMatch(reply, /denominator/);
});

test("an empty context still produces the plain admission", () => {
  const reply = buildGroundedFallbackReply("how is growth?", ctx([]));
  assert.match(reply, /couldn’t connect|couldn't connect/);
});

test("current action input gives the model workflow evidence and quantity primitives", () => {
  const currentAction = buildCurrentActionInput(
    actionCtx(
      {
        title: "Restock Low-Cover Specialist Wines",
        summary:
          "Initiate supplier orders for at-risk products facing stockouts to protect upcoming specialist wine sales.",
        proposedSteps: [
          {
            id: STEP_ONE_ID,
            title: "Draft supplier restock communication",
            description:
              "Prepare an email or message to suppliers for the at-risk wines.",
            status: "pending",
            mode: "assist",
            capabilityRef: "assist:supplier_email_draft",
          },
        ],
      },
      {
        currentSystemContext: {
          blocks: [
            {
              kind: "structured_evidence",
              data: {
                key: "inventory.low_cover_products.trailing_30d",
                items: [
                  {
                    title: "Morgon Cote du Py",
                    available: 3,
                    dailyVelocity: 0.2,
                    daysOfCover: 15,
                  },
                ],
              },
            },
          ],
        },
      },
    ),
  );

  assert.equal(currentAction.title, "Restock Low-Cover Specialist Wines");
  assert.equal(
    currentAction.operationalContext.workflowSteps[0].capabilityRef,
    "assist:supplier_email_draft",
  );
  assert.deepEqual(currentAction.operationalContext.evidence.lowCoverProducts, [
    {
      title: "Morgon Cote du Py",
      available: 3,
      dailyVelocity: 0.2,
      daysOfCover: 15,
      recommendedUnitsAtDefaultCover: 21,
    },
  ]);
  assert.deepEqual(currentAction.operationalContext.primitives, [
    {
      ref: "restock_quantity_from_stock_cover",
      purpose:
        "Estimate purchase units for a restock/replenishment workflow step from current stock cover evidence.",
      defaultTargetCoverDays: 120,
      alternativeTargetCoverDays: [
        {
          days: 90,
          meaning: "leaner cash-light reorder",
        },
        {
          days: 180,
          meaning: "more conservative reorder for long lead times",
        },
      ],
      formula:
        "recommendedPurchaseUnits = ceil(max(0, dailyVelocity * targetCoverDays - available))",
      inputs:
        "Use lowCoverProducts[].dailyVelocity and lowCoverProducts[].available. If the merchant supplies a different targetCoverDays in the conversation, use that value.",
      output:
        "Mention recommended units as a recommendation for approval/correction, not as a completed order.",
    },
  ]);
});

test("current action input keeps stock-cover evidence generic for model interpretation", () => {
  const currentAction = buildCurrentActionInput(
    actionCtx(
      {
        title: "Restock Low-Cover Specialist Wines",
        summary:
          "Initiate supplier orders for at-risk products facing stockouts to protect upcoming specialist wine sales.",
        proposedSteps: [
          {
            id: STEP_ONE_ID,
            title: "Draft supplier restock communication",
            description:
              "Prepare an email or message to suppliers for the at-risk wines.",
            status: "pending",
            mode: "assist",
            capabilityRef: "assist:supplier_email_draft",
          },
        ],
      },
      {
        currentSystemContext: {
          blocks: [
            {
              kind: "structured_evidence",
              data: {
                key: "inventory.low_cover_products.trailing_30d",
                items: [
                  {
                    title: "Pear Skin Sipon",
                    available: 0,
                    dailyVelocity: 0.1,
                    daysOfCover: 0,
                  },
                  {
                    title: "Picnic Xinomavro",
                    available: 0,
                    dailyVelocity: 0.1,
                    daysOfCover: 0,
                  },
                ],
              },
            },
          ],
        },
      },
    ),
  );

  assert.deepEqual(
    currentAction.operationalContext.evidence.lowCoverProducts.map((item) => ({
      title: item.title,
      recommendedUnitsAtDefaultCover: item.recommendedUnitsAtDefaultCover,
    })),
    [
      { title: "Pear Skin Sipon", recommendedUnitsAtDefaultCover: 12 },
      { title: "Picnic Xinomavro", recommendedUnitsAtDefaultCover: 12 },
    ],
  );
  assert.equal(
    currentAction.operationalContext.primitives[0].inputs,
    "Use lowCoverProducts[].dailyVelocity and lowCoverProducts[].available. If the merchant supplies a different targetCoverDays in the conversation, use that value.",
  );
});

test("workflow step updates from the model cannot directly mutate lifecycle status", async () => {
  const updates = [];
  const prisma = {
    merchantRecommendationStep: {
      updateMany: async (args) => {
        updates.push(args);
        return { count: args.where.id === STEP_ONE_ID ? 1 : 0 };
      },
    },
  };

  const result = await applyWorkflowStepUpdatesFromReply(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
    logger: { info() {}, warn() {}, error() {} },
    actionEvidence: {
      focusedAction: {
        id: "action-1",
        proposedSteps: [
          { id: STEP_ONE_ID, title: "Draft supplier restock communication" },
        ],
      },
    },
    updates: [
      {
        stepId: STEP_ONE_ID,
        status: "completed",
        reason: "Merchant said step 1 complete.",
      },
      {
        stepId: OTHER_STEP_ID,
        status: "completed",
        reason: "Should be ignored.",
      },
      {
        stepId: STEP_ONE_ID,
        status: "superseded",
        reason: "Unsafe lifecycle transition from chat.",
      },
    ],
  });

  assert.deepEqual(result.applied, []);
  assert.deepEqual(updates, []);
});
