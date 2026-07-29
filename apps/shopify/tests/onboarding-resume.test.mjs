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
    ["connect", "channels", "insights", "goals", "plan"],
  );
});

test("onboardingStepIndex orders steps; -1 for unknown/missing", () => {
  assert.equal(onboardingStepIndex("connect"), 0);
  assert.equal(onboardingStepIndex("plan"), 4);
  assert.ok(onboardingStepIndex("goals") > onboardingStepIndex("channels"));
  assert.equal(onboardingStepIndex("nope"), -1);
  assert.equal(onboardingStepIndex(null), -1);
});

test("readFurthestStep validates and defaults to connect", () => {
  assert.equal(readFurthestStep({ furthestStep: "goals" }), "goals");
  assert.equal(readFurthestStep({ furthestStep: "plan" }), "plan");
  // Malformed / missing / non-object → the safe default (never a wrong advance).
  assert.equal(readFurthestStep({ furthestStep: "nonsense" }), "connect");
  assert.equal(readFurthestStep({ furthestStep: 3 }), "connect");
  assert.equal(readFurthestStep({}), "connect");
  assert.equal(readFurthestStep(null), "connect");
  assert.equal(readFurthestStep("not-an-object"), "connect");
  assert.equal(readFurthestStep([1, 2]), "connect");
});

test("resolveOnboardingStep: channels stays reachable while memory generates", () => {
  // BUG-1 guarantee: explicit channels (or a channelProvider) is never clamped
  // back to connect by the readiness gate.
  assert.equal(
    resolveOnboardingStep({
      requestedStep: "channels",
      memoryReady: false,
      backfillComplete: false,
    }),
    "channels",
  );
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      hasChannelProvider: true,
      memoryReady: false,
      backfillComplete: false,
    }),
    "channels",
  );
});

test("resolveOnboardingStep: content steps are gated on readiness", () => {
  for (const step of ["insights", "goals", "plan"]) {
    assert.equal(
      resolveOnboardingStep({
        requestedStep: step,
        memoryReady: false,
        backfillComplete: true,
      }),
      "connect",
      `${step} without memory → connect`,
    );
    assert.equal(
      resolveOnboardingStep({
        requestedStep: step,
        memoryReady: true,
        backfillComplete: true,
      }),
      step,
      `${step} with data ready → ${step}`,
    );
  }
});

test("resolveOnboardingStep: no explicit step resumes at the furthest reached", () => {
  // BUG-2b fix: with data ready and no ?step=, resume where they left off rather
  // than resetting to connect.
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: true,
      backfillComplete: true,
      furthestStep: "channels",
    }),
    "channels",
  );
  assert.equal(
    resolveOnboardingStep({
      requestedStep: null,
      memoryReady: true,
      backfillComplete: true,
      furthestStep: "goals",
    }),
    "goals",
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
      furthestStep: "goals",
    }),
    "connect",
  );
});
