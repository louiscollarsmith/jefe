/* global process */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createMockLlmProvider } from "../app/lib/llm/provider.server.js";
import { inspectActionIntentOpportunity } from "../app/lib/actions/action-resolution.server.js";
import { buildMerchantPlanSnapshot } from "../app/lib/merchant-plan/candidates.server.js";
import { parseAndValidateMerchantPlanOutput } from "../app/lib/merchant-plan/schema.server.js";
import {
  acceptMerchantPlanAndCompleteOnboarding,
  ensureMerchantPlanQueued,
  generateMerchantPlan,
  getLatestMerchantPlan,
  getMerchantPlanExperience,
  processMerchantPlanMessage,
} from "../app/lib/merchant-plan/service.server.js";
import {
  MERCHANT_PLAN_JOB_TYPE,
  PLAN_REVIEW_STATUS,
  PLAN_RUN_STATUS,
} from "../app/lib/merchant-plan/constants.server.js";
import { upsertDerivedBelief } from "../app/lib/merchant-memory/service.server.js";

const databaseUrl = process.env.DATABASE_URL;
const workerSource = fs.readFileSync(
  new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
  "utf8",
);
const routeSource = fs.readFileSync(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

process.env.LISTING_COPY_EXECUTE_ENABLED = "true";
process.env.CLEARANCE_EXECUTE_ENABLED = "true";
process.env.INVENTORY_TRANSFER_EXECUTE_ENABLED = "true";

test("Plan snapshot is bounded to safe memory, goals, insights, context and prior recommendations", async () => {
  const beliefs = Array.from({ length: 45 }, (_, index) =>
    beliefFixture({
      id: `belief-${index + 1}`,
      key:
        index === 0
          ? "business.description"
          : `orders.metric_${index + 1}`,
      value: { text: `Useful signal ${index + 1} for jane@example.com` },
      evidenceSummary: `Evidence included +44 7700 90012${index % 10}.`,
    }),
  );
  const prisma = {
    merchantGoalRun: {
      async findFirst() {
        return {
          id: "goal-run-1",
          horizons: [
            goalFixture("goal-3", "threeMonths", 1, ["belief-1"]),
            goalFixture("goal-6", "sixMonths", 2, ["belief-2"]),
            goalFixture("goal-12", "twelveMonths", 3, ["belief-3"]),
          ],
        };
      },
    },
    merchantInsightRun: {
      async findFirst() {
        return {
          id: "insight-run-1",
          findings: [
            {
              id: "insight-1",
              title: "Revenue depends on a focused product set",
              finding: "A few products carry the clearest demand signal.",
              whyItMatters: "That can shape the first action.",
              category: "products",
              confidence: "high",
              reviewStatus: "confirmed",
              supportingBeliefIds: ["belief-1", "missing-belief"],
            },
          ],
        };
      },
    },
    merchantMemoryBelief: {
      async findMany() {
        return beliefs;
      },
    },
    merchantMemoryEvidence: {
      async findMany() {
        return [
          {
            id: "context-1",
            sourceType: "merchant_goals",
            evidenceType: "merchant_goal_document_context",
            summary: "Planning document said avoid discount-led growth.",
            observedAt: new Date("2026-07-26T10:00:00Z"),
          },
          {
            id: "context-2",
            sourceType: "merchant_plan",
            evidenceType: "merchant_plan_refinement",
            summary: "Merchant refined Jefe's Plan: keep it lightweight.",
            observedAt: new Date("2026-07-26T11:00:00Z"),
          },
        ];
      },
    },
    merchantPlanRecommendation: {
      async findMany() {
        return [
          {
            id: "prior-plan-1",
            title: "Test an email reorder nudge",
            summary: "Prior plan summary.",
            reviewStatus: PLAN_REVIEW_STATUS.rejected,
            acceptedAt: null,
            rejectedAt: new Date("2026-07-26T11:30:00Z"),
            completedAt: null,
            createdAt: new Date("2026-07-26T11:00:00Z"),
            run: { supersededAt: null },
          },
        ];
      },
    },
  };

  const snapshot = await buildMerchantPlanSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  const serialized = JSON.stringify(snapshot.snapshot);

  assert.equal(snapshot.hasGoals, true);
  assert.equal(snapshot.snapshot.privacy.excludesRawShopifyRecords, true);
  assert.equal(snapshot.snapshot.privacy.excludesFullUploadedDocuments, true);
  assert.equal(snapshot.snapshot.beliefs.length <= 40, true);
  assert.equal(snapshot.snapshot.goals.length, 3);
  assert.equal(snapshot.snapshot.insights.length, 1);
  assert.equal(snapshot.snapshot.previousRecommendations.length, 1);
  assert.equal(serialized.includes("jane@example.com"), false);
  assert.equal(serialized.includes("+44 7700"), false);
  assert.equal(serialized.includes("missing-belief"), false);
  assert.equal(serialized.includes("rawPayload"), false);
});

test("Plan snapshot expands stockout counts into low-cover product evidence", async () => {
  const beliefs = [
    beliefFixture({
      id: "belief-count",
      key: "inventory.at_risk_stockout_count.trailing_30d",
      category: "inventory",
      value: { count: 2 },
      valueType: "number",
      evidenceSummary: "Two selling products have fewer than 21 days of stock cover.",
    }),
    beliefFixture({
      id: "belief-low-cover",
      key: "inventory.low_cover_products.trailing_30d",
      category: "inventory",
      valueType: "structured",
      value: {
        items: [
          { productId: "p1", title: "Yuzu Tonic", unitsSold: 30, available: 6, dailyVelocity: 1, daysOfCover: 6 },
          { productId: "p2", title: "Cherry Cola", unitsSold: 30, available: 12, dailyVelocity: 1, daysOfCover: 12 },
        ],
        topAtRiskProduct: { productId: "p1", title: "Yuzu Tonic", unitsSold: 30, available: 6, dailyVelocity: 1, daysOfCover: 6 },
        atRiskProductCount: 2,
        thresholdDays: 21,
        window: "trailing_30d",
      },
      evidenceSummary: "Low-cover product list calculated from orders and inventory.",
    }),
  ];
  const prisma = {
    merchantGoalRun: {
      async findFirst() {
        return {
          id: "goal-run-1",
          horizons: [
            goalFixture("goal-3", "threeMonths", 1, ["belief-count"]),
            goalFixture("goal-6", "sixMonths", 2, []),
            goalFixture("goal-12", "twelveMonths", 3, []),
          ],
        };
      },
    },
    merchantInsightRun: {
      async findFirst() {
        return {
          id: "insight-run-1",
          findings: [
            {
              id: "insight-1",
              title: "Stock cover risk",
              finding: "Low-cover products could interrupt momentum.",
              whyItMatters: "Jefe should protect current demand.",
              category: "inventory",
              confidence: "high",
              reviewStatus: "confirmed",
              supportingBeliefIds: ["belief-count"],
            },
          ],
        };
      },
    },
    merchantMemoryBelief: { async findMany() { return beliefs; } },
    merchantMemoryEvidence: { async findMany() { return []; } },
    merchantPlanRecommendation: { async findMany() { return []; } },
  };

  const snapshot = await buildMerchantPlanSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  const keys = snapshot.snapshot.beliefs.map((belief) => belief.key);
  const serialized = JSON.stringify(snapshot.snapshot.beliefs);

  assert.ok(keys.includes("inventory.at_risk_stockout_count.trailing_30d"));
  assert.ok(keys.includes("inventory.low_cover_products.trailing_30d"));
  assert.match(serialized, /Yuzu Tonic/);
  assert.match(serialized, /Cherry Cola/);
  assert.match(serialized, /daysOfCover/);
});

test("Plan snapshot turns low-cover evidence into a grounded inventory-transfer opportunity", async () => {
  const beliefs = [
    beliefFixture({
      id: "belief-low-cover",
      key: "inventory.low_cover_products.trailing_30d",
      category: "inventory",
      valueType: "structured",
      value: {
        items: [
          {
            productId: "product-1",
            title: "Yuzu Tonic",
            unitsSold: 30,
            available: 6,
            dailyVelocity: 1,
            daysOfCover: 6,
          },
          {
            productId: "product-2",
            title: "Cherry Cola",
            unitsSold: 30,
            available: 12,
            dailyVelocity: 1,
            daysOfCover: 12,
          },
        ],
        topAtRiskProduct: {
          productId: "product-1",
          title: "Yuzu Tonic",
          unitsSold: 30,
          available: 6,
          dailyVelocity: 1,
          daysOfCover: 6,
        },
        atRiskProductCount: 2,
        thresholdDays: 21,
        window: "trailing_30d",
      },
      evidenceSummary: "Low-cover product list calculated from orders and inventory.",
    }),
  ];
  const prisma = planSnapshotMock({
    beliefs,
    goalBeliefIds: ["belief-low-cover"],
    insightBeliefIds: ["belief-low-cover"],
    products: [
      {
        id: "product-1",
        externalId: "gid://shopify/Product/1",
        title: "Yuzu Tonic",
        vendor: "Mixer House",
        productType: "Soft Drink",
      },
      {
        id: "product-2",
        externalId: "gid://shopify/Product/2",
        title: "Cherry Cola",
        vendor: "Mixer House",
        productType: "Soft Drink",
      },
    ],
    variants: [
      {
        id: "variant-1",
        productId: "product-1",
        externalId: "gid://shopify/ProductVariant/1",
        title: "Single bottle",
        sku: "YUZU",
        inventoryItemExternalId: "gid://shopify/InventoryItem/1",
      },
      {
        id: "variant-2",
        productId: "product-2",
        externalId: "gid://shopify/ProductVariant/2",
        title: "Single bottle",
        sku: "CHERRY",
        inventoryItemExternalId: "gid://shopify/InventoryItem/2",
      },
    ],
    inventoryLevels: [
      {
        variantId: "variant-1",
        inventoryItemExternalId: "gid://shopify/InventoryItem/1",
        locationExternalId: "gid://shopify/Location/shop",
        available: 6,
      },
      {
        variantId: "variant-2",
        inventoryItemExternalId: "gid://shopify/InventoryItem/2",
        locationExternalId: "gid://shopify/Location/shop",
        available: 12,
      },
      {
        variantId: "variant-1",
        inventoryItemExternalId: "gid://shopify/InventoryItem/1",
        locationExternalId: "gid://shopify/Location/store",
        available: 0,
      },
    ],
  });

  const snapshot = await buildMerchantPlanSnapshot(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });
  const opportunity = snapshot.snapshot.opportunityCandidates.find(
    (item) => item.id === "opportunity_inventory_transfer_low_cover_restock",
  );
  const diagnostic = snapshot.snapshot.opportunityCandidateDiagnostics.find(
    (item) => item.capabilityRef === "execute:shopify_inventory_transfer:restock",
  );

  assert.ok(opportunity);
  assert.equal(opportunity.initialProposal.kind, "shopify_inventory_transfer");
  assert.equal(opportunity.initialProposal.lineItemCount, 2);
  assert.equal(opportunity.initialProposal.lineItems[0].quantity, 114);
  assert.equal(opportunity.potentialCapabilities[0].writeEnabled, true);
  assert.equal(diagnostic.gateResult, "accepted");
  assert.equal(diagnostic.suppliedToLuna, true);
});

test("Plan structured validation rejects unsupported IDs, generic plans and missing success signals", () => {
  const validOutput = planOutputFixture();
  const valid = parseAndValidateMerchantPlanOutput(validOutput, validationContext());
  const unsupported = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        supportingBeliefIds: ["unknown-belief"],
      },
    },
    validationContext(),
  );
  const generic = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        title: "Improve retention",
        summary: "Improve retention through better marketing.",
      },
    },
    validationContext(),
  );
  const missingSignal = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        successSignal: {},
      },
    },
    validationContext(),
  );
  const duplicate = parseAndValidateMerchantPlanOutput(
    validOutput,
    {
      ...validationContext(),
      previousRecommendations: [
        {
          title: validOutput.selectedRecommendation.title,
          summary: validOutput.selectedRecommendation.summary,
          reviewStatus: PLAN_REVIEW_STATUS.rejected,
        },
      ],
    },
  );
  const goalGroundedNumber = parseAndValidateMerchantPlanOutput(
    {
      ...validOutput,
      selectedRecommendation: {
        ...validOutput.selectedRecommendation,
        whyThisAction:
          "This supports the agreed 98% stock accuracy target before larger retention work.",
        successSignal: {
          description: "Stock accuracy is visibly closer to the agreed goal.",
          timeframe: "within 14 days",
          target: "98% stock accuracy",
        },
      },
    },
    validationContext(),
  );

  assert.equal(valid.ok, true);
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /belief that was not supplied/);
  assert.equal(generic.ok, false);
  assert.match(generic.error, /generic/);
  assert.equal(missingSignal.ok, false);
  assert.match(missingSignal.error, /success signal/);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /duplicates/);
  assert.equal(goalGroundedNumber.ok, true);
});

test("Plan validation keeps registry-valid workflow capabilities and rejects unsupported execute paths", () => {
  const base = planOutputFixture();
  const clearanceRecommendation = {
    ...base.selectedRecommendation,
    title: "Clear old stock with a floored markdown",
    summary:
      "Mark down unsold stock so cash tied up in stale inventory can be recovered without selling below cost.",
    whyThisAction:
      "The supplied memory points to old stock with cash tied up, so a floored clearance is the cleanest next move.",
    whyNow:
      "The stock is already unsold, and a small markdown gives a quick read on whether demand returns.",
    startToday:
      "Review the old-stock products Jefe found and approve the capped markdown preview.",
    workflow: {
      steps: [
        {
          id: "step_1",
          title: "Review old stock",
          description: "Check the products with cash tied up before approving the markdown.",
          completionCriteria: "The products to clear are understood.",
          mode: "assist",
          capabilityRef: "assist:merchant_checklist",
        },
        {
          id: "step_2",
          title: "Approve the markdown",
          description: "Use the floored clearance preview so prices do not drop below cost.",
          completionCriteria: "The markdown preview is approved for execution.",
          mode: "execute",
          capabilityRef: "execute:price_markdown:dead_stock",
          dependsOnStepIds: ["step_1"],
        },
      ],
    },
    successSignal: {
      description: "Look for old stock moving after the markdown.",
      timeframe: "within two weeks",
    },
    expectedBenefit:
      "A clearance can free trapped capital while keeping a cost floor on every product.",
  };
  const withExecutableStep = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: clearanceRecommendation,
    },
    validationContext(),
  );
  assert.equal(withExecutableStep.ok, true);
  assert.equal(withExecutableStep.recommendation.workflow.steps[1].mode, "execute");
  assert.equal(
    withExecutableStep.recommendation.workflow.steps[1].capabilityRef,
    "execute:price_markdown:dead_stock",
  );

  const unknownStepCapability = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: {
        ...base.selectedRecommendation,
        workflow: {
          steps: [
            {
              id: "step_1",
              title: "Create supplier transfer",
              description: "Create a supplier transfer when stock is ordered.",
              completionCriteria: "Inbound stock is tracked.",
              mode: "execute",
              capabilityRef: "execute:shopify_transfer:create",
            },
          ],
        },
      },
    },
    validationContext(),
  );
  assert.equal(unknownStepCapability.ok, false);
  assert.match(unknownStepCapability.error, /Jefe-owned Shopify execute capability/);

  const stillValid = parseAndValidateMerchantPlanOutput(base, validationContext());
  assert.equal(stillValid.ok, true);
  assert.equal(
    stillValid.recommendation.workflow.steps.some((step) => step.mode === "execute"),
    true,
  );

  const noExecutableStep = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: {
        ...base.selectedRecommendation,
        workflow: {
          steps: [
            {
              id: "step_1",
              title: "Prepare a checklist",
              description: "Prepare useful next steps for the merchant to carry out manually.",
              completionCriteria: "The checklist is ready.",
              mode: "assist",
              capabilityRef: "assist:merchant_checklist",
            },
          ],
        },
      },
    },
    validationContext(),
  );
  assert.equal(noExecutableStep.ok, false);
  assert.match(noExecutableStep.error, /Jefe-owned Shopify execute capability/);

  const inventedProvenDemand = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      candidates: [
        {
          ...base.candidates[0],
          opportunityId: "opportunity_proven_demand_selling_push",
          action: "Focus the next selling push on proven demand",
        },
      ],
      selectedRecommendation: {
        ...base.selectedRecommendation,
        candidateId: "candidate_1",
        opportunityId: "opportunity_proven_demand_selling_push",
        title: "Focus the next selling push on proven demand",
        summary:
          "Prioritise products with proven demand for the next selling push.",
      },
    },
    {
      ...validationContext(),
      allowedOpportunityIds: new Set(["opportunity_listing_copy_missing_product_type"]),
    },
  );
  assert.equal(inventedProvenDemand.ok, false);
  assert.match(inventedProvenDemand.error, /opportunity that was not supplied/);
});

test("Plan validation keeps inventory-transfer approval attached to the Jefe execute step", () => {
  const base = planOutputFixture();
  const inventoryTransferRecommendation = {
    ...base.selectedRecommendation,
    title: "Restore availability for Pear Skin Sipon",
    summary:
      "Approve the supplied replenishment proposal and have Jefe create the Shopify inventory transfer.",
    whyThisAction:
      "The supplied evidence shows Pear Skin Sipon is low-cover and has a concrete transfer proposal.",
    whyNow:
      "The product can be put back on a path to availability through a bounded Shopify transfer.",
    startToday:
      "Approve Jefe creating the Shopify inventory transfer with the supplied locations, product and quantity.",
    workflow: {
      steps: [
        {
          id: "transfer",
          title: "Create Shopify inventory transfer",
          description:
            "Approve Jefe using the supplied origin location, destination location, product and proposed quantity, then Jefe creates the transfer.",
          completionCriteria: "The Shopify inventory transfer is created.",
          mode: "execute",
          capabilityRef: "execute:shopify_inventory_transfer:restock",
          dependsOnStepIds: [],
        },
      ],
    },
    successSignal: {
      description: "The transfer exists in Shopify and can be received by the destination location.",
      timeframe: "after approval",
    },
    expectedBenefit:
      "Creating the transfer gives the merchant a concrete replenishment state to receive against.",
  };

  const valid = parseAndValidateMerchantPlanOutput(
    { ...base, selectedRecommendation: inventoryTransferRecommendation },
    validationContext(),
  );
  assert.equal(valid.ok, true);

  const purchaseOrderPrerequisite = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: {
        ...inventoryTransferRecommendation,
        workflow: {
          steps: [
            {
              id: "approval",
              title: "Approve the replenishment proposal",
              description:
                "Confirm that Jefe may use the supplied origin location, destination location, product and proposed quantity.",
              completionCriteria: "The proposal is approved.",
              mode: "merchant_action",
              capabilityRef: "merchant_action:external_purchase_order",
            },
            {
              id: "transfer",
              title: "Create Shopify inventory transfer",
              description: "Create the transfer after approval.",
              completionCriteria: "The Shopify inventory transfer is created.",
              mode: "execute",
              capabilityRef: "execute:shopify_inventory_transfer:restock",
              dependsOnStepIds: ["approval"],
            },
          ],
        },
      },
    },
    validationContext(),
  );
  assert.equal(purchaseOrderPrerequisite.ok, false);
  assert.match(purchaseOrderPrerequisite.error, /approval is not merchant work/i);

  const cyclicWorkflow = parseAndValidateMerchantPlanOutput(
    {
      ...base,
      selectedRecommendation: {
        ...inventoryTransferRecommendation,
        workflow: {
          steps: [
            {
              id: "measure",
              title: "Confirm stock recovery",
              description: "Check whether stock cover improves after the transfer.",
              completionCriteria: "The stock recovery check is complete.",
              mode: "assist",
              capabilityRef: "assist:inventory_review",
              dependsOnStepIds: ["transfer"],
            },
            {
              id: "transfer",
              title: "Create Shopify inventory transfer",
              description: "Create the transfer after the recovery check.",
              completionCriteria: "The Shopify inventory transfer is created.",
              mode: "execute",
              capabilityRef: "execute:shopify_inventory_transfer:restock",
              dependsOnStepIds: ["measure"],
            },
          ],
        },
      },
    },
    validationContext(),
  );
  assert.equal(cyclicWorkflow.ok, false);
  assert.match(cyclicWorkflow.error, /dependency cycles/i);
});

test("Plan actionability dry-run rejects executable capabilities with no concrete opportunity", async () => {
  const result = await inspectActionIntentOpportunity(
    {
      product: {
        async findMany() {
          return [];
        },
      },
    },
    {
      merchantId: "merchant-1",
      shopId: "shop-1",
      intent: {
        actionType: "listing_copy",
        targetKind: "missing_product_type",
      },
    },
  );

  assert.equal(result.status, "no_opportunity");
});

test("getLatestMerchantPlan reads the latest completed run without a snapshot or queueing", async () => {
  const calls = [];
  // Mock prisma implements ONLY merchantPlanRun.findFirst. If the reader tried
  // to rebuild the belief snapshot or queue generation it would touch other
  // models/methods absent here and throw, proving this path is read-only.
  const prisma = {
    merchantPlanRun: {
      async findFirst(args) {
        calls.push(args);
        return {
          id: "plan-run-1",
          status: PLAN_RUN_STATUS.completed,
          snapshotHash: "hash-1",
          safeErrorCode: null,
          lastError: null,
          completedAt: new Date("2026-07-27T09:00:00Z"),
          failedAt: null,
          supersededAt: null,
          recommendation: {
            id: "rec-1",
            title: "Send a focused reorder nudge",
            summary: "One small reorder message.",
            primaryGoalId: "goal-3",
            supportingGoalIds: ["goal-6"],
            whyThisAction: "Repeat-purchase opportunity.",
            whyNow: "Small enough to start today.",
            startToday: "Draft the first message.",
            workflows: [
              {
                id: "workflow-1",
                version: 1,
                status: "draft",
                source: "plan_generation",
                steps: [
                  {
                    id: "step-1",
                    orderIndex: 0,
                    title: "Choose",
                    description: "Pick a segment.",
                    completionCriteria: null,
                    status: "draft",
                    mode: "assist",
                    capabilityRef: "assist:merchant_checklist",
                    dependsOnStepIds: [],
                    evidenceIds: [],
                  },
                ],
              },
            ],
            successSignal: { description: "Replies or purchases.", timeframe: "two weeks" },
            expectedBenefit: "Short feedback loop.",
            supportingBeliefIds: ["belief-1"],
            supportingInsightIds: ["insight-1"],
            confidence: "reasonable",
            assumption: null,
            caveat: null,
            reviewStatus: PLAN_REVIEW_STATUS.proposed,
            acceptedAt: null,
            rejectedAt: null,
          },
        };
      },
    },
  };

  const result = await getLatestMerchantPlan(prisma, {
    merchantId: "merchant-1",
    shopId: "shop-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.status, PLAN_RUN_STATUS.completed);
  assert.equal(calls[0].where.merchantId, "merchant-1");
  assert.equal(calls[0].where.shopId, "shop-1");
  assert.equal("snapshotHash" in calls[0].where, false);
  assert.deepEqual(calls[0].include, {
    recommendation: {
      include: {
        workflows: {
          orderBy: { version: "desc" },
          take: 1,
          include: { steps: { orderBy: { orderIndex: "asc" } } },
        },
        run: { select: { result: true } },
      },
    },
  });
  assert.deepEqual(calls[0].orderBy, { completedAt: "desc" });
  assert.equal(result.selectedRun.id, "plan-run-1");
  assert.equal(
    result.selectedRun.recommendation.title,
    "Send a focused reorder nudge",
  );

  const empty = await getLatestMerchantPlan(
    { merchantPlanRun: { async findFirst() { return null; } } },
    { merchantId: "merchant-1", shopId: "shop-1" },
  );
  assert.deepEqual(empty, { selectedRun: null });
});

test("Plan generation is wired to the async worker and not browser page load", () => {
  assert.equal(MERCHANT_PLAN_JOB_TYPE, "merchant_plan_generate");
  assert.match(workerSource, /MERCHANT_PLAN_JOB_TYPE/);
  assert.match(workerSource, /generateMerchantPlan/);
  assert.match(routeSource, /intent === "plan\.retry"[\s\S]*ensureMerchantPlanQueued/);
  assert.doesNotMatch(
    routeSource,
    /activeStep === "plan"[\s\S]{0,240}ensureMerchantPlanQueued/,
  );
  assert.doesNotMatch(routeSource, /generateMerchantPlan\(/);
});

test("Plan onboarding uses the shared topic-scoped chat composer", () => {
  assert.match(routeSource, /Update your Plan by chatting with Jefe/);
  assert.match(routeSource, /OnboardingChat/);
  assert.match(routeSource, /CONVERSATION_TOPICS\.onboardingPlan/);
  assert.match(routeSource, /isPlanConversationAssistantMessage/);
  assert.match(routeSource, /JefePlanApprovalPill/);
  assert.match(routeSource, /Action 1 of 1 · Ready to review/);
  assert.match(routeSource, /JefePlanStartIcon/);
  assert.match(routeSource, /Why Jefe suggests this/);
  assert.doesNotMatch(routeSource, /JefePlanRefinement/);
  assert.doesNotMatch(routeSource, /Why this action/);
  assert.doesNotMatch(
    routeSource,
    /I&apos;ll use that context to choose a better first move/,
  );
});

test("merchant Plan generation persists exactly one recommendation", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Plan persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createPlanFixture(prisma, suffix);
    const queued = await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    await removeQueuedPlanGenerationJob(prisma, shop.id);
    const snapshot = queued.snapshot.snapshot;
    const result = await generateMerchantPlan(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: planOutputFixture({
          beliefId: snapshot.beliefs[0].id,
          insightId: snapshot.insights[0].id,
          goalId: snapshot.goals[0].id,
          supportingGoalId: snapshot.goals[1].id,
          opportunityIds: snapshot.opportunityCandidates.map((item) => item.id),
        }),
      }),
      logger: silentLogger,
    });
    const run = await prisma.merchantPlanRun.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
      include: { recommendation: true },
    });
    const recommendations = await prisma.merchantPlanRecommendation.findMany({
      where: { merchantId: merchant.id, shopId: shop.id },
    });
    const workflow = await prisma.merchantRecommendationWorkflow.findFirst({
      where: { recommendationId: recommendations[0].id },
      include: { steps: { orderBy: { orderIndex: "asc" } } },
    });
    const evidenceSnapshot = await prisma.merchantPlanEvidenceSnapshot.findUnique({
      where: { recommendationId: recommendations[0].id },
    });
    const action = await prisma.merchantAction.findFirst({
      where: { sourceRecommendationId: recommendations[0].id },
    });
    const experience = await getMerchantPlanExperience(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });

    assert.equal(result.status, PLAN_RUN_STATUS.completed);
    assert.equal(recommendations.length, 1);
    assert.ok(workflow);
    assert.equal(workflow.status, "draft");
    assert.equal(workflow.steps.length, 2);
    assert.equal(workflow.steps[0].mode, "assist");
    assert.ok(evidenceSnapshot);
    assert.equal(evidenceSnapshot.snapshotVersion, "plan_evidence_snapshot_v1");
    assert.equal(Array.isArray(evidenceSnapshot.blocksJson), true);
    assert.ok(snapshot.opportunityCandidates.length >= 1);
    assert.equal(snapshot.opportunityCandidates[0].id, "opportunity_listing_copy_missing_product_type");
    assert.equal(snapshot.opportunityCandidates[0].affectedEntities.length, 1);
    assert.equal(snapshot.opportunityCandidates[0].initialProposal.kind, "product_type_updates");
    assert.equal(run.result.selectedOpportunityId, "opportunity_listing_copy_missing_product_type");
    assert.equal(run.result.selectedOpportunity.initialProposal.kind, "product_type_updates");
    assert.ok(action);
    assert.equal(action.progress.selectedOpportunity.initialProposal.kind, "product_type_updates");
    assert.equal(run.recommendation.title, "Categorise uncategorised products");
    assert.equal(experience.currentRun.id, run.id);
    assert.equal(experience.stale, false);
    assert.equal(Array.isArray(run.result.candidateSummaries), true);
    assert.equal(JSON.stringify(run.result).includes("chain-of-thought"), false);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Plan acceptance emits executable workflow steps → proposed clearance row (no store write)", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Plan persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createPlanFixture(prisma, suffix);
    // Seed one dead-stock variant: ACTIVE product, stock on hand, a known unit cost,
    // and NO sales in the window → a real, safe clearance opportunity for the emit.
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `deadprod-${suffix}`,
        title: "Dusty Parka",
        status: "ACTIVE",
        variants: {
          create: [
            { merchantId: merchant.id, shopId: shop.id, externalId: `deadvar-${suffix}`, sku: "DEAD", price: "200.00", unitCost: "80.00" },
          ],
        },
      },
      include: { variants: true },
    });
    await prisma.inventoryLevel.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        variantId: product.variants[0].id,
        inventoryItemExternalId: `ii-dead-${suffix}`,
        locationExternalId: "loc-1",
        available: 10,
      },
    });

    const queued = await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    await removeQueuedPlanGenerationJob(prisma, shop.id);
    const snapshot = queued.snapshot.snapshot;
    await generateMerchantPlan(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: clearancePlanOutputFixture({
          beliefId: snapshot.beliefs[0].id,
          insightId: snapshot.insights[0].id,
          goalId: snapshot.goals[0].id,
          supportingGoalId: snapshot.goals[1].id,
          opportunityIds: snapshot.opportunityCandidates.map((item) => item.id),
        }),
      }),
      logger: silentLogger,
    });

    const recommendation = await prisma.merchantPlanRecommendation.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
      include: {
        workflows: {
          include: { steps: { orderBy: { orderIndex: "asc" } } },
        },
      },
    });
    assert.equal(
      await prisma.actionExecution.count({
        where: { merchantId: merchant.id, shopId: shop.id, status: "proposed" },
      }),
      0,
      "draft workflow generation does not create executable action rows",
    );

    await acceptMerchantPlanAndCompleteOnboarding(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      recommendationId: recommendation.id,
    });

    const activeWorkflow = await prisma.merchantRecommendationWorkflow.findFirst({
      where: { recommendationId: recommendation.id },
      include: { steps: { orderBy: { orderIndex: "asc" } } },
    });
    const executableStep = activeWorkflow.steps.find((step) => step.mode === "execute");
    const proposed = await prisma.actionExecution.findFirst({
      where: { merchantId: merchant.id, shopId: shop.id, status: "proposed" },
    });
    assert.equal(activeWorkflow.status, "active");
    assert.equal(activeWorkflow.steps[0].status, "ready");
    assert.equal(
      activeWorkflow.steps.slice(1).every((step) => step.status === "waiting"),
      true,
    );
    assert.ok(proposed, "accepting the workflow created a proposed action row");
    assert.equal(proposed.recommendationStepId, executableStep.id);
    assert.equal(proposed.actionType, "price_markdown");
    assert.equal(proposed.actionKind, "dead_stock_clearance");
    assert.equal(proposed.resolvedMode, "approve"); // default dial → propose-first, never auto
    assert.equal(proposed.proposalSummary.variantCount, 1);
    assert.equal(Number(proposed.proposalSummary.markdownPercent), 30); // the emit's advisory % round-tripped
    assert.equal(Number(proposed.proposalSummary.totalTrappedCapital), 800); // 10 units × £80 cost
  } finally {
    // ActionExecution has no merchant FK cascade → clean it up explicitly first.
    const leftover = await prisma.merchant.findFirst({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    if (leftover) {
      await prisma.actionExecution.deleteMany({ where: { merchantId: leftover.id } });
    }
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

test("Plan refinement records evidence, marks the current Plan and queues regeneration", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for Merchant Plan persistence tests");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const suffix = uniqueSuffix();
  try {
    const { merchant, shop } = await createPlanFixture(prisma, suffix);
    const queued = await ensureMerchantPlanQueued(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    await removeQueuedPlanGenerationJob(prisma, shop.id);
    const snapshot = queued.snapshot.snapshot;
    await generateMerchantPlan(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      runId: queued.run.id,
      llmProvider: createMockLlmProvider({
        operation: planOutputFixture({
          beliefId: snapshot.beliefs[0].id,
          insightId: snapshot.insights[0].id,
          goalId: snapshot.goals[0].id,
          supportingGoalId: snapshot.goals[1].id,
          opportunityIds: snapshot.opportunityCandidates.map((item) => item.id),
        }),
      }),
      logger: silentLogger,
    });
    const recommendation = await prisma.merchantPlanRecommendation.findFirstOrThrow({
      where: { merchantId: merchant.id, shopId: shop.id },
    });
    const result = await processMerchantPlanMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      recommendationId: recommendation.id,
      message: "Avoid email for now; start with stock cleanup.",
      runAfter: new Date("2999-01-01T00:00:00Z"),
    });
    const updatedRecommendation =
      await prisma.merchantPlanRecommendation.findUniqueOrThrow({
        where: { id: recommendation.id },
      });
    const evidence = await prisma.merchantMemoryEvidence.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        evidenceType: "merchant_plan_refinement",
      },
    });
    const job = await prisma.backfillJob.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        jobType: MERCHANT_PLAN_JOB_TYPE,
        status: "queued",
      },
    });
    const conversation = await prisma.merchantMemoryConversation.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        topic: "onboarding_plan",
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    assert.equal(result.ok, true);
    assert.equal(
      updatedRecommendation.reviewStatus,
      PLAN_REVIEW_STATUS.refinementRequested,
    );
    assert.ok(evidence);
    assert.match(evidence.summary, /stock-focused/);
    assert.ok(job);
    assert.ok(conversation);
    assert.equal(conversation.messages.at(-2).role, "merchant");
    assert.equal(conversation.messages.at(-1).role, "assistant");
    assert.match(
      conversation.messages.at(-1).content,
      /I interpreted your guidance as:/,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: `Merchant Plan Test ${suffix}` },
    });
    await prisma.$disconnect();
  }
});

function planOutputFixture({
  beliefId = "belief-1",
  insightId = "insight-1",
  goalId = "goal-3",
  supportingGoalId = "goal-6",
  opportunityIds = [
    "opportunity_listing_copy_missing_product_type",
    "opportunity_price_markdown_dead_stock",
    "opportunity_tidy_up_stale_listing",
  ],
} = {}) {
  const opportunityId = opportunityIds[0] ?? "opportunity_listing_copy_missing_product_type";
  return {
    candidates: opportunityIds.slice(0, 5).map((id, index) =>
      candidateFixture(`candidate_${index + 1}`, id, actionForOpportunity(id), beliefId, insightId),
    ),
    selectedRecommendation: {
      candidateId: "candidate_1",
      opportunityId,
      title: "Categorise uncategorised products",
      summary:
        "Set product types on uncategorised Shopify products so the range is cleaner for customers and for Jefe's own store understanding.",
      primaryGoalId: goalId,
      supportingGoalIds: [supportingGoalId],
      whyThisAction:
        "The supplied memory and insight point to catalogue gaps that Jefe can correct through Shopify product updates.",
      whyNow:
        "It is small enough to begin today and creates a cleaner product range before larger merchandising work.",
      startToday:
        "Review the uncategorised products and approve Jefe's product-type updates.",
      workflow: {
        steps: [
          {
            id: "step_1",
            title: "Review proposed product types",
            description: "Check the product types Jefe proposes for products that currently have none.",
            completionCriteria: "The proposed product types are ready for approval.",
            mode: "assist",
            capabilityRef: "assist:merchant_checklist",
          },
          {
            id: "step_2",
            title: "Apply product types in Shopify",
            description: "Jefe updates the product type field on the approved uncategorised products.",
            completionCriteria: "The approved product type updates have been written to Shopify.",
            mode: "execute",
            capabilityRef: "execute:listing_copy:missing_product_type",
            dependsOnStepIds: ["step_1"],
          },
        ],
      },
      successSignal: {
        description: "Look for product type coverage improving on the affected products.",
        timeframe: "within two weeks",
      },
      expectedBenefit:
        "This gives the merchant and Jefe a cleaner catalogue structure without changing product copy or pricing.",
      supportingBeliefIds: [beliefId],
      supportingInsightIds: [insightId],
      confidence: "reasonable",
    },
  };
}

function clearancePlanOutputFixture(options = {}) {
  const opportunityId = "opportunity_price_markdown_dead_stock";
  const opportunityIds = [
    opportunityId,
    ...((options.opportunityIds ?? []).filter((id) => id !== opportunityId)),
  ];
  const output = planOutputFixture({ ...options, opportunityIds });
  return {
    ...output,
    selectedRecommendation: {
      ...output.selectedRecommendation,
      candidateId: "candidate_1",
      opportunityId,
      title: "Clear old stock with a floored markdown",
      summary:
        "Mark down unsold stock so cash tied up in stale inventory can be recovered without selling below cost.",
      whyThisAction:
        "The supplied memory points to old stock with cash tied up, so a floored clearance is the cleanest next move.",
      whyNow:
        "The stock is already unsold, and a small markdown gives a quick read on whether demand returns.",
      startToday:
        "Review the old-stock products Jefe found and approve the capped markdown preview.",
      workflow: {
        steps: [
          {
            id: "step_1",
            title: "Review old stock",
            description: "Check the products with cash tied up before approving the markdown.",
            completionCriteria: "The products to clear are understood.",
            mode: "assist",
            capabilityRef: "assist:merchant_checklist",
          },
          {
            id: "step_2",
            title: "Approve the markdown",
            description: "Use the floored clearance preview so prices do not drop below cost.",
            completionCriteria: "The markdown preview is approved for execution.",
            mode: "execute",
            capabilityRef: "execute:price_markdown:dead_stock",
            dependsOnStepIds: ["step_1"],
          },
        ],
      },
      successSignal: {
        description: "Look for old stock moving after the markdown.",
        timeframe: "within two weeks",
      },
      expectedBenefit:
        "A clearance can free trapped capital while keeping a cost floor on every product.",
    },
  };
}

function candidateFixture(id, opportunityId, action, beliefId, insightId) {
  return {
    id,
    opportunityId,
    action,
    goalAlignment: "Primarily advances the three-month goal.",
    whyRelevant: "It is supported by the current Merchant Memory and onboarding insight.",
    supportingBeliefIds: [beliefId],
    supportingInsightIds: [insightId],
    expectedEffort: "small",
    timeToUsefulSignal: "within two weeks",
    respectedConstraints: ["keeps scope narrow"],
  };
}

function actionForOpportunity(opportunityId) {
  if (opportunityId === "opportunity_price_markdown_dead_stock") {
    return "Clear dead stock with a floored markdown";
  }
  if (opportunityId === "opportunity_tidy_up_stale_listing") {
    return "Archive unbuyable stale products";
  }
  return "Categorise uncategorised products";
}

function validationContext() {
  return {
    allowedBeliefIds: new Set(["belief-1"]),
    allowedInsightIds: new Set(["insight-1"]),
    allowedGoalIds: new Set(["goal-3", "goal-6", "goal-12"]),
    allowedOpportunityIds: new Set([
      "opportunity_listing_copy_missing_product_type",
      "opportunity_price_markdown_dead_stock",
      "opportunity_tidy_up_stale_listing",
    ]),
    suppliedBeliefs: [
      {
        id: "belief-1",
        label: "Repeat purchase signal",
        val: { text: "repeat purchase signal" },
      },
    ],
    suppliedInsights: [
      {
        id: "insight-1",
        title: "Stock accuracy is the immediate dependency",
        finding: "Stock accuracy affects the current three-month goal.",
      },
    ],
    suppliedGoals: [
      {
        id: "goal-3",
        title: "Restore operational confidence",
        description: "Reach 98% stock accuracy within the three-month goal.",
      },
      {
        id: "goal-6",
        title: "Increase repeat revenue",
        description: "Build from the stock accuracy foundation after 6 months.",
      },
      {
        id: "goal-12",
        title: "Grow disciplined revenue",
        description: "Keep the 12-month direction aligned with profitable growth.",
      },
    ],
    previousRecommendations: [],
  };
}

function planSnapshotMock({
  beliefs,
  goalBeliefIds = [],
  insightBeliefIds = [],
  products = [],
  variants = [],
  inventoryLevels = [],
} = {}) {
  return {
    merchantGoalRun: {
      async findFirst() {
        return {
          id: "goal-run-1",
          horizons: [
            goalFixture("goal-3", "threeMonths", 1, goalBeliefIds),
            goalFixture("goal-6", "sixMonths", 2, []),
            goalFixture("goal-12", "twelveMonths", 3, []),
          ],
        };
      },
    },
    merchantInsightRun: {
      async findFirst() {
        return {
          id: "insight-run-1",
          findings: [
            {
              id: "insight-1",
              title: "Stock cover risk",
              finding: "Low-cover products could interrupt momentum.",
              whyItMatters: "Jefe should protect current demand.",
              category: "inventory",
              confidence: "high",
              reviewStatus: "confirmed",
              supportingBeliefIds: insightBeliefIds,
            },
          ],
        };
      },
    },
    merchantMemoryBelief: {
      async findMany() {
        return beliefs;
      },
      async findFirst(args = {}) {
        const key = args?.where?.key;
        return beliefs.find((belief) => belief.key === key) ?? null;
      },
    },
    merchantMemoryEvidence: { async findMany() { return []; } },
    merchantPlanRecommendation: { async findMany() { return []; } },
    product: {
      async findMany() {
        return products;
      },
    },
    variant: {
      async findMany() {
        return variants;
      },
    },
    inventoryLevel: {
      async findMany() {
        return inventoryLevels;
      },
    },
    order: {
      async findFirst() {
        return null;
      },
    },
    orderLineItem: {
      async findMany() {
        return [];
      },
    },
  };
}

function beliefFixture({
  id,
  key,
  category = "orders",
  value,
  valueType = "string",
  status = "inferred",
  evidenceSummary,
}) {
  return {
    id,
    merchantId: "merchant-1",
    shopId: "shop-1",
    category,
    key,
    value,
    valueType,
    status,
    confidence: "0.9000",
    confidenceReason: "Supported by stored evidence.",
    precedence: 40,
    evidence: [
      {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: evidenceSummary,
        metadata: {},
        observedAt: new Date("2026-07-26T09:00:00Z"),
        createdAt: new Date("2026-07-26T09:00:00Z"),
      },
    ],
  };
}

function goalFixture(id, horizon, orderIndex, supportingBeliefIds) {
  return {
    id,
    horizon,
    orderIndex,
    title: `${horizon} revenue goal`,
    description: "Grow revenue from supported evidence.",
    supportingBeliefIds,
  };
}

async function createPlanFixture(prisma, suffix) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Merchant Plan Test ${suffix}`,
      shops: {
        create: {
          shopDomain: `merchant-plan-${suffix}.myshopify.com`,
          rawPayload: { source: "test" },
        },
      },
    },
    include: { shops: true },
  });
  const shop = merchant.shops[0];
  const beliefs = [];
  for (const belief of [
    {
      key: "business.description",
      category: "business",
      value: { text: "Specialist wine merchant" },
    },
    {
      key: "customers.repeat_purchase_rate",
      category: "customers",
      value: { percentage: 24, period: "stored history" },
      valueType: "percentage",
    },
    {
      key: "orders.average_order_value.all_time",
      category: "orders",
      value: { amount: 64, currency: "GBP" },
      valueType: "currency_amount",
    },
  ]) {
    const result = await upsertDerivedBelief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      category: belief.category,
      key: belief.key,
      value: belief.value,
      valueType: belief.valueType ?? "string",
      confidence: 0.9,
      confidenceReason: "Test fixture.",
      observedAt: new Date("2026-07-26T09:00:00Z"),
      evidence: {
        sourceType: "system_derivation",
        evidenceType: "deterministic_calculation",
        summary: `Fixture belief for ${belief.key}.`,
        observedAt: new Date("2026-07-26T09:00:00Z"),
      },
    });
    beliefs.push(result.belief);
  }

  const insightRun = await prisma.merchantInsightRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      status: "completed",
      beliefSnapshotVersion: "test",
      beliefSnapshotHash: `insight-${suffix}`,
      relevantBeliefIds: beliefs.map((belief) => belief.id),
      promptVersion: "test",
      schemaVersion: "test",
      completedAt: new Date("2026-07-26T09:05:00Z"),
      findings: {
        create: {
          merchantId: merchant.id,
          shopId: shop.id,
          orderIndex: 1,
          title: "Repeat purchase has room to grow",
          finding: "A repeat-purchase signal is present in Merchant Memory.",
          whyItMatters: "It can shape the first practical action.",
          confidence: "medium",
          category: "retention",
          supportingBeliefIds: [beliefs[1].id],
          reviewStatus: "confirmed",
        },
      },
    },
    include: { findings: true },
  });

  await prisma.merchantGoalRun.create({
    data: {
      merchantId: merchant.id,
      shopId: shop.id,
      status: "completed",
      beliefSnapshotVersion: "test",
      beliefSnapshotHash: `goal-${suffix}`,
      relevantBeliefIds: beliefs.map((belief) => belief.id),
      insightRunId: insightRun.id,
      promptVersion: "test",
      schemaVersion: "test",
      completedAt: new Date("2026-07-26T09:10:00Z"),
      horizons: {
        create: [
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "threeMonths",
            orderIndex: 1,
            title: "Grow repeat revenue",
            description: "Use supported customer behaviour to build repeat sales.",
            supportingBeliefIds: [beliefs[1].id],
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "sixMonths",
            orderIndex: 2,
            title: "Increase customer value",
            description: "Build from early repeat-purchase learning.",
            supportingBeliefIds: [beliefs[1].id],
          },
          {
            merchantId: merchant.id,
            shopId: shop.id,
            horizon: "twelveMonths",
            orderIndex: 3,
            title: "Grow revenue with discipline",
            description: "Scale the strongest supported growth loop.",
            supportingBeliefIds: [beliefs[2].id],
          },
        ],
      },
    },
  });

  await prisma.product.createMany({
    data: [
      {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `typed-wine-1-${suffix}`,
        title: "Foundry Syrah",
        vendor: "Foundry Estate",
        productType: "Wine",
        status: "ACTIVE",
      },
      {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `typed-wine-2-${suffix}`,
        title: "Foundry Merlot",
        vendor: "Foundry Estate",
        productType: "Wine",
        status: "ACTIVE",
      },
      {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `typed-wine-3-${suffix}`,
        title: "Foundry Pinot Noir",
        vendor: "Foundry Estate",
        productType: "Wine",
        status: "ACTIVE",
      },
      {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `untyped-wine-${suffix}`,
        title: "Foundry Grenache",
        vendor: "Foundry Estate",
        productType: "",
        status: "ACTIVE",
      },
    ],
  });

  return { merchant, shop };
}

async function removeQueuedPlanGenerationJob(prisma, shopId) {
  await prisma.backfillJob.deleteMany({
    where: {
      shopId,
      jobType: MERCHANT_PLAN_JOB_TYPE,
    },
  });
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
