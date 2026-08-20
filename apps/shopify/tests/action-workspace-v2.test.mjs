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
