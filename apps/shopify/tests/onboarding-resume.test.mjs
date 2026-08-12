import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_STEPS,
  onboardingStepIndex,
  readFurthestStep,
  resolveOnboardingStep,
} from "../app/lib/onboarding/steps.js";

test("ONBOARDING_STEPS is the canonical order", () => {
  assert.deepEqual(
    [...ONBOARDING_STEPS],
    ["connect", "context", "insight", "action", "app"],
  );
});

test("onboardingStepIndex orders steps; -1 for unknown/missing", () => {
  assert.equal(onboardingStepIndex("connect"), 0);
  assert.equal(onboardingStepIndex("app"), 4);
  assert.ok(onboardingStepIndex("action") > onboardingStepIndex("insight"));
  assert.equal(onboardingStepIndex("channels"), -1);
  assert.equal(onboardingStepIndex("nope"), -1);
  assert.equal(onboardingStepIndex(null), -1);
});

test("readFurthestStep validates and defaults to connect", () => {
  assert.equal(readFurthestStep({ furthestStep: "insight" }), "insight");
  assert.equal(readFurthestStep({ furthestStep: "app" }), "app");
  assert.equal(readFurthestStep({ furthestStep: "plan" }), "context");
  // Malformed / missing / non-object → the safe default (never a wrong advance).
  assert.equal(readFurthestStep({ furthestStep: "nonsense" }), "connect");
  assert.equal(readFurthestStep({ furthestStep: 3 }), "connect");
  assert.equal(readFurthestStep({}), "connect");
  assert.equal(readFurthestStep(null), "connect");
  assert.equal(readFurthestStep("not-an-object"), "connect");
  assert.equal(readFurthestStep([1, 2]), "connect");
});

test("resolveOnboardingStep: channels is no longer an onboarding step", () => {
  assert.equal(
    resolveOnboardingStep({
      requestedStep: "channels",
      memoryReady: false,
      backfillComplete: false,
    }),
    "connect",
  );
  assert.equal(readFurthestStep({ furthestStep: "channels" }), "connect");
});

test("resolveOnboardingStep honors explicit fast-flow scenes", () => {
  for (const step of ["context", "insight", "action", "app"]) {
    assert.equal(
      resolveOnboardingStep({
        requestedStep: step,
        memoryReady: false,
        backfillComplete: false,
      }),
      step,
      `${step} requested while not ready → ${step}`,
    );
    assert.equal(
      resolveOnboardingStep({
        requestedStep: step,
        memoryReady: true,
        backfillComplete: true,
      }),
      step,
      `${step} ready → ${step}`,
    );
  }
});

test("resolveOnboardingStep: the no-explicit-step (resume) path still gates on readiness", () => {
  // The gate moved to only the resume path: with no ?step= and data still
  // generating, hold at Connect rather than resuming into empty content.
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: false,
      backfillComplete: false,
      furthestStep: "action",
    }),
    "connect",
  );
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: true,
      backfillComplete: true,
      furthestStep: "action",
    }),
    "action",
  );
});

test("resolveOnboardingStep: no explicit step resumes at the furthest reached", () => {
  // BUG-2b fix: with data ready and no ?step=, resume where they left off rather
  // than resetting to connect.
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: true,
      backfillComplete: true,
      furthestStep: "insight",
    }),
    "insight",
  );
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: true,
      backfillComplete: true,
      furthestStep: "action",
    }),
    "action",
  );
  // Never advanced → connect.
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: true,
      backfillComplete: true,
      furthestStep: "connect",
    }),
    "connect",
  );
  // Memory still generating → connect regardless of furthest.
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: false,
      backfillComplete: false,
      furthestStep: "action",
    }),
    "connect",
  );
});
