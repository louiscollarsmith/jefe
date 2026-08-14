import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMerchantActionStatus,
  getMerchantAttentionItems,
  getMerchantCompletedActions,
  getMerchantCurrentFocus,
  getMerchantCurrentFocuses,
  getMerchantInProgressActions,
  getMerchantProposedActions,
} from "../app/lib/actions/merchant-action.server.js";

test("merchant input beats running work and proposed recommendations", () => {
  const focus = getMerchantCurrentFocus({
    merchantActions: [
      action({ id: "proposal", status: "proposed", title: "Reduce excess stock" }),
      action({ id: "running", status: "in_progress", title: "Recover customers" }),
      action({
        id: "needs-you",
        status: "accepted",
        title: "Organise catalog product types",
        displaySteps: [
          step({
            mode: "merchant_action",
            status: "pending",
            description: "Review the categories before Jefe applies anything.",
          }),
        ],
      }),
    ],
  });

  assert.equal(focus.kind, "merchant_input");
  assert.equal(focus.priority, 2);
  assert.equal(focus.actionId, "needs-you");
  assert.equal(focus.headline, "Needs your attention");
  assert.equal(focus.ctaIntent, "chat.focus.start");
});

test("proposal only appears under Proposed, not Attention or In Progress", () => {
  const merchantActions = [
    action({ id: "proposal", status: "proposed", title: "Reduce excess stock" }),
  ];

  assert.deepEqual(getMerchantAttentionItems({ merchantActions }), []);
  assert.deepEqual(
    getMerchantProposedActions({ merchantActions }).map((item) => item.id),
    ["proposal"],
  );
  assert.deepEqual(getMerchantInProgressActions({ merchantActions }), []);
  assert.deepEqual(getMerchantCompletedActions({ merchantActions }), []);
});

test("accepted ready work appears in Attention and In Progress, not Proposed", () => {
  const merchantActions = [
    action({
      id: "ready",
      status: "accepted",
      actionRunId: "run-ready",
      executable: true,
      executionStatus: "proposed",
      displaySteps: [step({ mode: "execute", status: "ready" })],
    }),
  ];

  assert.deepEqual(
    getMerchantAttentionItems({ merchantActions }).map((item) => [
      item.attentionType,
      item.actionId,
    ]),
    [["STEP_READY", "ready"]],
  );
  assert.deepEqual(getMerchantProposedActions({ merchantActions }), []);
  assert.deepEqual(
    getMerchantInProgressActions({ merchantActions }).map((item) => item.id),
    ["ready"],
  );
  assert.deepEqual(getMerchantCompletedActions({ merchantActions }), []);
});

test("completed work appears only under Completed", () => {
  const merchantActions = [
    action({
      id: "completed",
      status: "completed",
      executionStatus: "applied",
      outcomeStatus: "measured",
      displaySteps: [
        step({ status: "completed" }),
        step({ id: "step-2", status: "completed" }),
      ],
    }),
  ];

  assert.deepEqual(getMerchantAttentionItems({ merchantActions }), []);
  assert.deepEqual(getMerchantProposedActions({ merchantActions }), []);
  assert.deepEqual(getMerchantInProgressActions({ merchantActions }), []);
  assert.deepEqual(
    getMerchantCompletedActions({ merchantActions }).map((item) => item.id),
    ["completed"],
  );
});

test("accepted recommendation stays accepted until workflow work starts", () => {
  const status = deriveMerchantActionStatus({
    recommendation: recommendation({
      reviewStatus: "ACCEPTED",
      steps: [step({ status: "READY" })],
    }),
  });

  assert.equal(status, "accepted");
});

test("accepted recommendation with a completed step derives as in progress", () => {
  const status = deriveMerchantActionStatus({
    recommendation: recommendation({
      reviewStatus: "accepted",
      steps: [
        step({ status: "completed" }),
        step({ id: "step-2", status: "ready" }),
      ],
    }),
  });

  assert.equal(status, "in_progress");
});

test("running autonomous work stays in In Progress but out of Attention", () => {
  const merchantActions = [
    action({
      id: "running",
      status: "in_progress",
      executionStatus: "approved",
      displaySteps: [step({ mode: "execute", status: "running" })],
    }),
  ];

  assert.deepEqual(getMerchantAttentionItems({ merchantActions }), []);
  assert.deepEqual(
    getMerchantInProgressActions({ merchantActions }).map((item) => item.id),
    ["running"],
  );
});

test("needs_merchant step status qualifies for Attention", () => {
  const merchantActions = [
    action({
      id: "needs-merchant-status",
      status: "in_progress",
      displaySteps: [step({ mode: "assist", status: "NEEDS_MERCHANT" })],
    }),
  ];

  assert.deepEqual(
    getMerchantAttentionItems({ merchantActions }).map((item) => [
      item.attentionType,
      item.actionId,
    ]),
    [["MERCHANT_INPUT_REQUIRED", "needs-merchant-status"]],
  );
});

test("needs_attention step status qualifies as an Attention problem", () => {
  const merchantActions = [
    action({
      id: "needs-attention-status",
      status: "in_progress",
      displaySteps: [step({ mode: "assist", status: "NEEDS_ATTENTION" })],
    }),
  ];

  assert.deepEqual(
    getMerchantAttentionItems({ merchantActions }).map((item) => [
      item.attentionType,
      item.actionId,
    ]),
    [["NEEDS_ATTENTION", "needs-attention-status"]],
  );
});

test("focus queue keeps other actionable work available behind the top focus", () => {
  const focuses = getMerchantCurrentFocuses({
    merchantActions: [
      action({ id: "proposal", status: "proposed", title: "Reduce excess stock" }),
      action({
        id: "ready",
        status: "accepted",
        actionRunId: "run-ready",
        executable: true,
        executionStatus: "proposed",
        displaySteps: [step({ mode: "execute", status: "ready" })],
      }),
      action({
        id: "blocked",
        status: "in_progress",
        displaySteps: [step({ mode: "execute", status: "blocked" })],
      }),
      action({
        id: "needs-you",
        status: "accepted",
        displaySteps: [step({ mode: "merchant_action", status: "pending" })],
      }),
      action({ id: "measuring", status: "in_progress", title: "Measure markdown" }),
    ],
  });

  assert.deepEqual(
    focuses.map((focus) => [focus.kind, focus.actionId]),
    [
      ["action_problem", "blocked"],
      ["merchant_input", "needs-you"],
      ["action_ready", "ready"],
      ["recommendation", "proposal"],
    ],
  );
});

test("focus queue shows an action once even when it matches multiple reasons", () => {
  const focuses = getMerchantCurrentFocuses({
    merchantActions: [
      action({
        id: "needs-you-and-failed",
        status: "in_progress",
        executionStatus: "failed",
        displaySteps: [step({ mode: "merchant_action", status: "pending" })],
      }),
      action({ id: "proposal", status: "proposed" }),
    ],
  });

  assert.deepEqual(
    focuses.map((focus) => [focus.kind, focus.actionId]),
    [
      ["action_problem", "needs-you-and-failed"],
      ["recommendation", "proposal"],
    ],
  );
});

test("running work without attention lets a proposed recommendation take the hero", () => {
  const focus = getMerchantCurrentFocus({
    merchantActions: [
      action({ id: "running", status: "in_progress", title: "Recover customers" }),
      action({ id: "measuring", status: "in_progress", title: "Measure markdown" }),
      action({ id: "proposal", status: "proposed", title: "Reduce excess stock" }),
    ],
  });

  assert.equal(focus.kind, "recommendation");
  assert.equal(focus.priority, 4);
  assert.equal(focus.actionId, "proposal");
  assert.equal(focus.headline, "Here's what I'd do next.");
});

test("quiet progress is only a fallback when nothing actionable exists", () => {
  const focuses = getMerchantCurrentFocuses({
    merchantActions: [
      action({ id: "running", status: "in_progress", title: "Recover customers" }),
      action({ id: "measuring", status: "in_progress", title: "Measure markdown" }),
      action({ id: "proposal", status: "proposed", title: "Reduce excess stock" }),
    ],
  });

  assert.deepEqual(
    focuses.map((focus) => focus.kind),
    ["recommendation"],
  );

  const progressFocuses = getMerchantCurrentFocuses({
    merchantActions: [
      action({ id: "running", status: "in_progress", title: "Recover customers" }),
      action({ id: "measuring", status: "in_progress", title: "Measure markdown" }),
    ],
  });

  assert.deepEqual(
    progressFocuses.map((focus) => [focus.kind, focus.actionId]),
    [["progress", "running"]],
  );
});

test("accepted action with a ready executable step becomes the hero", () => {
  const focus = getMerchantCurrentFocus({
    merchantActions: [
      action({
        id: "ready",
        status: "accepted",
        actionRunId: "run-ready",
        executable: true,
        executionStatus: "proposed",
        displaySteps: [
          step({
            mode: "execute",
            status: "pending",
            description: "The first step is ready to start.",
          }),
        ],
      }),
    ],
  });

  assert.equal(focus.kind, "action_ready");
  assert.equal(focus.priority, 3);
  assert.equal(focus.actionRunId, "run-ready");
  assert.equal(focus.ctaIntent, "action.approve");
});

test("failed or blocked active actions beat proposed recommendations", () => {
  const failedFocus = getMerchantCurrentFocus({
    merchantActions: [
      action({ id: "proposal", status: "proposed" }),
      action({
        id: "failed",
        status: "in_progress",
        executionStatus: "failed",
      }),
    ],
  });
  assert.equal(failedFocus.kind, "action_problem");
  assert.equal(failedFocus.priority, 1);
  assert.equal(failedFocus.actionId, "failed");

  const blockedFocus = getMerchantCurrentFocus({
    merchantActions: [
      action({ id: "proposal", status: "proposed" }),
      action({
        id: "blocked",
        status: "accepted",
        displaySteps: [step({ mode: "execute", status: "blocked" })],
      }),
    ],
  });
  assert.equal(blockedFocus.kind, "action_problem");
  assert.equal(blockedFocus.actionId, "blocked");
});

test("empty action state renders a quiet all-clear focus", () => {
  const focus = getMerchantCurrentFocus({ merchantActions: [] });

  assert.equal(focus.kind, "empty");
  assert.equal(focus.priority, 99);
  assert.equal(focus.actionId, null);
  assert.equal(focus.headline, "Nothing needs your attention right now.");
});

function action(overrides = {}) {
  return {
    id: "action-1",
    title: "Action",
    summary: "A grounded action.",
    status: "in_progress",
    actionRunId: null,
    executable: false,
    executionStatus: "applied",
    outcomeStatus: "pending",
    displaySteps: [step()],
    ...overrides,
  };
}

function step(overrides = {}) {
  return {
    id: "step-1",
    label: "Step",
    description: "Step description.",
    status: "in_progress",
    mode: "execute",
    ...overrides,
  };
}

function recommendation({ reviewStatus = "proposed", steps = [] } = {}) {
  return {
    reviewStatus,
    workflows: [
      {
        steps,
      },
    ],
  };
}
