import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_DISPLAY_STATE,
  deriveActionDisplayState,
  composerChipsFor,
} from "../app/lib/actions/action-display-state.server.js";

function derive(overrides = {}) {
  return deriveActionDisplayState({
    action: overrides.action ?? {},
    recommendation: overrides.recommendation ?? null,
    execution: overrides.execution ?? null,
    workflow: overrides.workflow ?? { steps: [] },
    events: overrides.events ?? [],
  });
}

test("proposed: fresh action, unaccepted, no execution", () => {
  const result = derive();
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.proposed);
  assert.equal(result.requiresMerchantInput, false);
  assert.equal(result.canExecute, false);
});

test("proposed: shares the ready CTA (Home has no separate Proposed shelf)", () => {
  const result = derive();
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.proposed);
  assert.equal(result.ctaLabel, "Review & run →");
});

test("ready: legacy runtime accepted, no step started", () => {
  const result = derive({
    action: { status: "accepted" },
    recommendation: { reviewStatus: "accepted" },
    workflow: { steps: [{ status: "ready" }] },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.ready);
  assert.equal(result.canExecute, true);
});

test("ready: agentic runtime, revision accepted, job not started", () => {
  const result = derive({
    action: {
      status: "accepted",
      progress: {
        agentic: { runtime: "shopify_admin_api", acceptedActionRevision: "sar_1" },
      },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.ready);
});

test("working: agentic executing", () => {
  const result = derive({
    action: {
      status: "accepted",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "executing" },
        },
      },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.working);
  assert.equal(result.canStop, true);
});

test("working: agentic verifying", () => {
  const result = derive({
    action: {
      status: "accepted",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "verifying" },
        },
      },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.working);
});

test("working: legacy step running", () => {
  const result = derive({
    action: { status: "in_progress" },
    workflow: { steps: [{ status: "running" }] },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.working);
});

test("needs_you: agentic blocking question with structured answer options", () => {
  const result = derive({
    action: {
      status: "needs_attention",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "needs_merchant_input" },
        },
      },
      outcome: {
        merchantMessage: "Where should the six promoted products appear?",
        answerOptions: ["Homepage feature", "Autumn Picks collection", "Both"],
      },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.needsYou);
  assert.equal(result.requiresMerchantInput, true);
  assert.equal(result.subtitle, "Where should the six promoted products appear?");
  const labels = result.chips.map((chip) => chip.label);
  assert.deepEqual(labels, [
    "Homepage feature",
    "Autumn Picks collection",
    "Both",
    "Why do you need this?",
  ]);
  assert.equal(result.chips[0].kind, "answer");
});

test("needs_you: verification mismatch has a real discrepancy, not a generic review", () => {
  const result = derive({
    action: {
      status: "needs_attention",
      outcome: { verificationMismatch: true },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.needsYou);
});

test("needs_you: legacy step explicitly needs_merchant", () => {
  const result = derive({
    action: { status: "needs_attention" },
    workflow: { steps: [{ status: "needs_merchant" }] },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.needsYou);
});

test("couldnt_complete: verification-exhausted is a fact, not an answerable question (NOT needs_you)", () => {
  const result = derive({
    action: {
      status: "needs_attention",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "verification_incomplete", verificationExhausted: true },
        },
      },
      outcome: { verificationExhausted: true, blocker: "VERIFICATION_RETRIES_EXHAUSTED" },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.couldntComplete);
  assert.notEqual(result.displayState, ACTION_DISPLAY_STATE.needsYou);
});

test("couldnt_complete: legacy reverted is NOT declined/stopped (regression pin for the bug fix)", () => {
  const result = derive({
    action: { status: "needs_attention" },
    execution: { status: "reverted", revertedAt: "2026-08-20T10:00:00.000Z", error: "boom" },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.couldntComplete);
  assert.notEqual(result.displayState, ACTION_DISPLAY_STATE.stopped);
});

test("couldnt_complete: agentic zero-write failure", () => {
  const result = derive({
    action: {
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "failed" },
        },
      },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.couldntComplete);
});

test("couldnt_complete: legacy step blocked with no specific merchant question", () => {
  const result = derive({
    action: { status: "needs_attention" },
    workflow: { steps: [{ status: "blocked" }] },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.couldntComplete);
});

test("couldnt_complete: agentic BLOCKED/PROVIDER_ERROR (generic needs_attention phase) does not fall through to proposed", () => {
  const result = derive({
    action: {
      status: "needs_attention",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "needs_attention" },
        },
      },
      outcome: { blocker: "ITERATION_LIMIT", status: "BLOCKED" },
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.couldntComplete);
});

test("stopped: agentic mid-flight interruption with partial writes", () => {
  const result = derive({
    action: { status: "stopped", outcome: { stoppedAt: "2026-08-20T10:00:00.000Z", stoppedAfterWrites: true } },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.stopped);
  assert.equal(result.subtitle, "Stopped partway through, at your request.");
});

test("stopped: pre-execution decline shown under Recent, distinct subtitle", () => {
  const result = derive({
    action: { status: "declined" },
    recommendation: { reviewStatus: "rejected" },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.stopped);
  assert.equal(result.subtitle, "You said no to this.");
});

test("stopped: pre-execution deferred (not now) also maps to stopped", () => {
  const result = derive({
    action: { status: "deferred" },
    recommendation: { reviewStatus: "deferred" },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.stopped);
});

test("done: execution + verification complete, no future-outcome-monitoring language", () => {
  const result = derive({
    action: {
      status: "completed",
      progress: {
        agentic: {
          runtime: "shopify_admin_api",
          acceptedActionRevision: "sar_1",
          executionJob: { phase: "completed" },
        },
      },
    },
    workflow: { steps: [{ status: "completed" }] },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.done);
  assert.ok(result.completedAt === null || typeof result.completedAt === "string");
  const haystack = `${result.subtitle} ${result.lifecycleEvents.map((e) => e.detail ?? "").join(" ")}`;
  assert.doesNotMatch(haystack, /compare.*return rate/i);
  assert.doesNotMatch(haystack, /on \d{1,2} (january|february|march|april|may|june|july|august|september|october|november|december)/i);
  assert.deepEqual(result.chips, []);
});

test("done: incomplete steps prevent a premature done (milestone leakage does not drive display state)", () => {
  const result = derive({
    action: { status: "completed" },
    workflow: {
      steps: [
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
        { status: "running" },
      ],
    },
  });
  assert.equal(result.displayState, ACTION_DISPLAY_STATE.working);
  // realWorldProgress must never leak internal step scaffolding — v1 has no
  // genuine business-stage source wired up, so it stays empty regardless.
  assert.deepEqual(result.realWorldProgress, []);
});

test("composerChipsFor: working state offers both stop chips via the same command", () => {
  const chips = composerChipsFor({
    displayState: ACTION_DISPLAY_STATE.working,
    latestBlockingQuestion: null,
    isAgentic: true,
    planStepTitles: [],
  });
  const stopChips = chips.filter((chip) => chip.intent === "action.stop_action");
  assert.equal(stopChips.length, 2);
  assert.deepEqual(
    stopChips.map((c) => c.label),
    ["Stop after this page", "Stop now"],
  );
});

test("composerChipsFor: legacy needs_you falls back to a generic CTA, no literal options", () => {
  const chips = composerChipsFor({
    displayState: ACTION_DISPLAY_STATE.needsYou,
    latestBlockingQuestion: { text: "Which supplier?", options: ["A", "B"] },
    isAgentic: false,
    planStepTitles: [],
  });
  assert.deepEqual(
    chips.map((c) => c.label),
    ["Answer Jefe →"],
  );
});

test("Home contract: active ordering is needs_you -> ready -> working, done+stopped are Recent-only and never count as open", () => {
  const rows = [
    { id: "a", action: { status: "accepted" }, recommendation: { reviewStatus: "accepted" } }, // ready
    { id: "b", action: { status: "completed" }, workflow: { steps: [{ status: "completed" }] } }, // done
    {
      id: "c",
      action: {
        status: "in_progress",
        progress: { agentic: { runtime: "shopify_admin_api", acceptedActionRevision: "r", executionJob: { phase: "executing" } } },
      },
    }, // working
    { id: "d", action: { status: "needs_attention" }, workflow: { steps: [{ status: "needs_merchant" }] } }, // needs_you
    { id: "e", action: { status: "declined" }, recommendation: { reviewStatus: "rejected" } }, // stopped (pre-execution)
  ];
  const results = rows.map((row) => ({ id: row.id, ...derive(row) }));

  const activeOrder = { needs_you: 0, ready: 1, working: 2 };
  const active = results
    .filter((r) => r.displayState in activeOrder)
    .sort((a, b) => activeOrder[a.displayState] - activeOrder[b.displayState]);
  assert.deepEqual(active.map((r) => r.id), ["d", "a", "c"]);

  const recent = results.filter((r) => ["done", "stopped", "couldnt_complete"].includes(r.displayState));
  assert.deepEqual(
    recent.map((r) => r.id).sort(),
    ["b", "e"],
  );

  // Done must never appear in the active/open ordering, regardless of grouping strategy.
  assert.ok(!active.some((r) => r.displayState === ACTION_DISPLAY_STATE.done));
});

test("composerChipsFor: ready state chips are Run changes / Change the plan / context-specific", () => {
  const chips = composerChipsFor({
    displayState: ACTION_DISPLAY_STATE.ready,
    latestBlockingQuestion: null,
    isAgentic: true,
    planStepTitles: ["Bora Line Rebula vintage"],
  });
  assert.deepEqual(
    chips.map((c) => c.label),
    ["Run changes", "Change something in the plan", "Leave Bora Line Rebula vintage out"],
  );
  assert.equal(chips[0].intent, "action.accept_plan");
});
