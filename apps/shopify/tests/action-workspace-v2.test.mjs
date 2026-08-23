import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionWorkspace,
  prepareWorkflowStepsForWorkspaceV2,
  resolveWorkspaceFocus,
  workspacePlanItems,
} from "../app/lib/actions/action-workspace.server.js";

test("restock materialisation removes retrospective inventory review work", () => {
  const steps = [
    {
      id: "step_1",
      title: "Review low-cover inventory",
      capabilityRef: "assist:inventory_review",
      dependsOnStepIds: [],
    },
    {
      id: "step_2",
      title: "Build replenishment proposal",
      capabilityRef: "assist:replenishment_proposal",
      dependsOnStepIds: ["step_1"],
    },
    {
      id: "step_3",
      title: "Draft supplier email",
      capabilityRef: "assist:supplier_email_draft",
      dependsOnStepIds: ["step_2"],
    },
  ];

  const prepared = prepareWorkflowStepsForWorkspaceV2(steps, {
    title: "Prepare replenishment for low-cover products",
  });

  assert.deepEqual(
    prepared.map((step) => step.title),
    ["Build replenishment proposal", "Draft supplier email"],
  );
  assert.deepEqual(prepared[0].dependsOnStepIds, []);
});

test("workspace projects heterogeneous restock items instead of status steps", () => {
  const action = restockAction({
    steps: [
      step({
        id: "proposal",
        title: "Build replenishment proposal",
        capabilityRef: "assist:replenishment_proposal",
      }),
      step({
        id: "email",
        title: "Draft supplier communication",
        capabilityRef: "assist:supplier_email_draft",
        dependsOnStepIds: ["proposal"],
      }),
      step({
        id: "po",
        title: "Create purchase order",
        mode: "merchant_action",
        capabilityRef: "merchant_action:external_purchase_order",
        dependsOnStepIds: ["proposal"],
      }),
      step({
        id: "wait",
        title: "Supplier fulfilment",
        mode: "merchant_action",
        dependsOnStepIds: ["po"],
      }),
    ],
  });

  const workspace = buildActionWorkspace(action, {
    work: [
      work("proposal", "complete", {
        artifactType: "replenishment_proposal",
        summary: "90-day cover for 2 products.",
        inputHash: "h1",
      }),
      work("email", "available", null),
      work("po", "needs_input", null),
      work("wait", "blocked", null),
    ],
  });

  assert.equal(workspace.version, 2);
  assert.deepEqual(
    workspace.items.map((item) => [item.title, item.kind, item.state]),
    [
      ["Replenishment proposal", "decision", "current"],
      ["Supplier communication", "artifact", "not_created"],
      ["Create purchase order", "execution", "integration_limitation"],
      ["Supplier fulfilment", "external_wait", "waiting"],
    ],
  );
  assert.equal(workspace.artifacts[0].kind, "replenishment_proposal");
  assert.equal(workspace.currentFocus.kind, "integration_limitation");
});

test("inventory transfer approval is not materialised as merchant purchase-order work", () => {
  const steps = [
    step({
      id: "measure",
      title: "Confirm stock recovery",
      mode: "assist",
      capabilityRef: "assist:inventory_review",
      dependsOnStepIds: ["transfer"],
    }),
    step({
      id: "approval",
      title: "Approve the replenishment proposal",
      mode: "merchant_action",
      capabilityRef: "merchant_action:external_purchase_order",
      dependsOnStepIds: [],
      description:
        "Confirm that Jefe may use the supplied origin location, destination location, product and proposed replenishment quantity.",
    }),
    step({
      id: "transfer",
      title: "Create Shopify inventory transfer",
      mode: "execute",
      capabilityRef: "execute:shopify_inventory_transfer:restock",
      dependsOnStepIds: ["measure", "approval"],
    }),
  ];

  const prepared = prepareWorkflowStepsForWorkspaceV2(steps, {
    title: "Restore availability for Pear Skin Sipon",
    summary: "Approve the supplied replenishment proposal and have Jefe create the transfer.",
  });

  assert.deepEqual(
    prepared.map((item) => item.title),
    ["Confirm stock recovery", "Create Shopify inventory transfer"],
  );
  assert.deepEqual(
    prepared.find((item) => item.id === "transfer").dependsOnStepIds,
    [],
  );

  const workspace = buildActionWorkspace(
    restockAction({ steps }),
    {
      work: [
        work("measure", "blocked", null),
        work("transfer", "available", null),
      ],
    },
  );

  assert.equal(
    workspace.items.some((item) => item.semanticKey === "create_purchase_order"),
    false,
  );
  const transfer = workspace.items.find(
    (item) => item.capabilityRef === "execute:shopify_inventory_transfer:restock",
  );
  assert.equal(transfer.kind, "execution");
  assert.equal(transfer.intendedActor, "JEFE");
  assert.equal(transfer.approvalRequired, true);
  assert.equal(transfer.state, "approval_required");
  assert.equal(workspace.currentFocus.kind, "merchant_attention");
  assert.equal(workspace.currentFocus.itemKind, "execution");
});

test("workspace plan items carry semantic labels and no raw status badge", () => {
  const workspace = buildActionWorkspace(
    restockAction({
      steps: [
        step({
          id: "proposal",
          title: "Build replenishment proposal",
          capabilityRef: "assist:replenishment_proposal",
        }),
      ],
    }),
    { work: [work("proposal", "complete", { artifactType: "replenishment_proposal" })] },
  );

  const rows = workspacePlanItems(workspace);
  assert.equal(rows[0].status, null);
  assert.equal(rows[0].statusLabel, "Current");
  assert.equal(rows[0].itemKind, "decision");
});

test("workspace refresh rebuilds items from the current workflow after replanning", () => {
  const workspace = buildActionWorkspace({
    ...restockAction({
      steps: [
        step({
          id: "proposal",
          title: "Build replenishment proposal",
          capabilityRef: "assist:replenishment_proposal",
        }),
        step({
          id: "po",
          title: "Create purchase order",
          mode: "merchant_action",
          capabilityRef: "merchant_action:external_purchase_order",
          dependsOnStepIds: ["proposal"],
        }),
      ],
    }),
    progress: {
      workspace: {
        version: 2,
        items: [
          {
            id: "create_shopify_transfer",
            semanticKey: "create_shopify_transfer",
            stepId: "old-transfer",
            title: "Create Shopify inventory transfer",
            kind: "execution",
            state: "ready",
          },
        ],
      },
    },
  });

  assert.deepEqual(
    workspace.items.map((item) => item.title),
    ["Replenishment proposal", "Create purchase order"],
  );
});

test("focus resolver prioritises merchant input before optional work", () => {
  const focus = resolveWorkspaceFocus({
    items: [
      {
        id: "proposal",
        stepId: "proposal",
        title: "Replenishment proposal",
        kind: "decision",
        state: "current",
      },
      {
        id: "po",
        stepId: "po",
        title: "Create purchase order",
        kind: "merchant_action",
        state: "needs_merchant",
        description: "Raise the purchase order outside Jefe.",
      },
    ],
  });

  assert.equal(focus.kind, "merchant_attention");
  assert.equal(focus.headline, "Create purchase order");
});

test("agentic Shopify Actions project semantic context as ready to discuss", () => {
  const action = {
    id: "action-agentic",
    title: "Create an Available Proven Wines storefront collection",
    summary: "Make proven in-stock wines easier to browse.",
    status: "proposed",
    sourceRecommendationId: "rec-agentic",
    sourceRecommendation: {
      id: "rec-agentic",
      title: "Create an Available Proven Wines storefront collection",
      whyThisAction: "Available proven wines are hard to find in the storefront.",
      whyNow: "The store has enough available proven wines to merit a collection.",
      successSignal: {
        description: "A storefront collection exists for available proven wines.",
      },
    },
    plan: {
      agentic: {
        runtime: "shopify_admin_api",
        currentActionRevision: "sar_123",
        semanticAction: {
          outcome: "Create a storefront collection for available proven wines.",
          whyThisAction: "Available proven wines are hard to find in the storefront.",
          scope: {
            summary: "Known candidate scope: available wines with recent demand.",
            items: [
              { title: "Chateau Test 2020", productId: "gid://shopify/Product/1" },
              { title: "Barolo Test 2019", productId: "gid://shopify/Product/2" },
            ],
          },
          constraints: [{ kind: "inventory", label: "Only include products with inventory > 0" }],
          materialExpectedEffects: [
            { label: "Create or update one Shopify collection for available proven wines." },
            { label: "Attach the qualifying products to that collection." },
          ],
          verificationPlan: "Read Shopify back and confirm the collection and products exist.",
        },
      },
    },
    progress: {
      agentic: {
        runtime: "shopify_admin_api",
        currentActionRevision: "sar_123",
      },
    },
  };

  const workspace = buildActionWorkspace(action);
  const rows = workspacePlanItems(workspace);

  assert.equal(workspace.kind, "agentic_shopify");
  assert.equal(workspace.actionState, "ready_to_discuss");
  assert.equal(workspace.currentFocus.eyebrow, "Ready to discuss");
  assert.deepEqual(
    rows.map((row) => [row.title, row.statusLabel, row.workspaceState]),
    [
      // Before acceptance: pre-execution items carry no static descriptive label;
      // only the execute row carries "After acceptance" to signal the gate.
      ["Review what Jefe found", "Planned", "planned"],
      ["Confirm the candidate scope", "Planned", "planned"],
      ["Agree constraints", "Planned", "planned"],
      ["Execute and verify the outcome", "After acceptance", "planned"],
    ],
  );
  assert.match(workspace.candidateScope.summary, /Known candidate scope/);
  assert.equal(workspace.materialExpectedEffects.length, 2);
});

test("completed agentic Shopify Actions render semantic milestones as historical plan items", () => {
  const action = {
    id: "action-agentic-completed",
    title: "Create an in-stock Cases & Bundles collection",
    summary: "Make larger-format purchase easier to discover.",
    status: "completed",
    sourceRecommendationId: "rec-agentic",
    plan: {
      agentic: {
        runtime: "shopify_admin_api",
        currentActionRevision: "sar_done",
        semanticAction: {
          outcome: "Create a storefront collection for in-stock bundles.",
          scope: {
            summary: "Borderlands Discovery Four is the only eligible product.",
            items: [
              {
                title: "Borderlands Discovery Four",
                productId: "gid://shopify/Product/1",
              },
            ],
          },
          constraints: [{ kind: "inventory", label: "Only include products with 3+ available" }],
          materialExpectedEffects: [{ label: "Create one Shopify collection." }],
          verificationPlan: "Read Shopify back and confirm collection membership.",
        },
      },
    },
    progress: {
      agentic: {
        runtime: "shopify_admin_api",
        currentActionRevision: "sar_done",
        acceptedActionRevision: "sar_done",
      },
    },
    outcome: {
      verification: { verified: true },
      progressSummary: "Created and verified the collection.",
    },
  };

  const workspace = buildActionWorkspace(action);
  const rows = workspacePlanItems(workspace);

  assert.equal(workspace.actionState, "completed");
  assert.equal(workspace.currentFocus.kind, "completed");
  assert.deepEqual(
    rows.map((row) => [row.title, row.statusLabel, row.workspaceState, row.suppressStatus]),
    [
      ["Review what Jefe found", null, "historical", true],
      ["Confirm the candidate scope", null, "historical", true],
      ["Agree constraints", null, "historical", true],
      ["Execute and verify the outcome", null, "historical", true],
    ],
  );
});

function restockAction({ steps }) {
  return {
    id: "action-1",
    title: "Review At-Risk Inventory and Prepare Restock Plan",
    summary: "Prepare a replenishment plan for low-cover products.",
    status: "in_progress",
    progress: {},
    workflow: { steps },
  };
}

function step(overrides) {
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.title,
    status: "draft",
    mode: overrides.mode ?? "assist",
    capabilityRef: overrides.capabilityRef ?? null,
    dependsOnStepIds: overrides.dependsOnStepIds ?? [],
    progress: {},
    ...overrides,
  };
}

function work(stepId, state, validResult) {
  return {
    step: { id: stepId },
    state,
    stale: state === "needs_updating",
    validResult,
    blockers: state === "blocked" ? [{ reason: "Waiting on earlier work." }] : [],
  };
}
