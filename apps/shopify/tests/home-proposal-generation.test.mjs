import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  proposalGenerationBudget,
  startOfMerchantDay,
  countHomeProposalGenerationsSince,
  merchantHasProposedAction,
  isHomeProposalGenerationInFlight,
  getHomeProposalGenerationState,
  requestHomeProposalGeneration,
  HOME_PROPOSAL_SOURCE_MODE,
  DEFAULT_HOME_PROPOSAL_DAILY_CAP,
  HOME_STUCK_RUN_THRESHOLD_MS,
} from "../app/lib/merchant-plan/home-proposal-generation.server.js";

test("proposalGenerationBudget: under the cap → allowed with remaining", () => {
  const b = proposalGenerationBudget({ generatedToday: 2 });
  assert.equal(b.allowed, true);
  assert.equal(b.cap, DEFAULT_HOME_PROPOSAL_DAILY_CAP);
  assert.equal(b.remaining, 3);
  assert.equal(b.reason, null);
});

test("proposalGenerationBudget: exactly at the cap → blocked", () => {
  const b = proposalGenerationBudget({ generatedToday: 5 });
  assert.equal(b.allowed, false);
  assert.equal(b.remaining, 0);
  assert.equal(b.reason, "daily_cap_reached");
});

test("proposalGenerationBudget: junk inputs fall back safely", () => {
  assert.equal(proposalGenerationBudget({ generatedToday: NaN }).remaining, DEFAULT_HOME_PROPOSAL_DAILY_CAP);
  assert.equal(proposalGenerationBudget({ generatedToday: 0, cap: 0 }).cap, DEFAULT_HOME_PROPOSAL_DAILY_CAP);
});

test("startOfMerchantDay: midnight UTC of the merchant's local date", () => {
  const now = new Date("2026-08-12T01:30:00Z");
  assert.equal(startOfMerchantDay(now, "America/Los_Angeles").toISOString(), "2026-08-11T00:00:00.000Z");
  assert.equal(startOfMerchantDay(now, "UTC").toISOString(), "2026-08-12T00:00:00.000Z");
});

test("getHomeProposalGenerationState: eligible when under cap and no proposed action", async () => {
  const prisma = {
    merchantPlanRun: { count: async () => 0 },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: {
      count: async () => 2,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
  });
  assert.equal(state?.canGenerate, true);
  assert.equal(state?.generatedToday, 2);
  assert.equal(state?.remaining, 3);
});

test("getHomeProposalGenerationState: blocked when a proposed recommendation exists", async () => {
  const prisma = {
    merchantPlanRun: { count: async () => 0 },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => true,
      inFlight: async () => false,
    },
  });
  assert.equal(state?.canGenerate, false);
  assert.equal(state?.reason, "proposed_exists");
});

test("getHomeProposalGenerationState: blocked at daily cap even without a proposed action", async () => {
  const prisma = {
    merchantPlanRun: { count: async () => 5 },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: {
      count: async () => 5,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
  });
  assert.equal(state?.canGenerate, false);
  assert.equal(state?.reason, "daily_cap_reached");
});

test("getHomeProposalGenerationState: generating blocks another request", async () => {
  const recentUpdatedAt = new Date("2026-08-12T08:55:00Z"); // 5 min ago, within threshold
  const prisma = {
    merchantPlanRun: {
      count: async () => 1,
      findFirst: async () => ({ updatedAt: recentUpdatedAt, createdAt: recentUpdatedAt }),
    },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: {
      count: async () => 1,
      hasProposed: async () => false,
      inFlight: async () => true,
    },
  });
  assert.equal(state?.canGenerate, false);
  assert.equal(state?.reason, "generating");
  assert.equal(state?.isGenerating, true);
});

test("requestHomeProposalGeneration: enqueues a home run when eligible", async () => {
  const calls = [];
  const result = await requestHomeProposalGeneration(/** @type {any} */ ({ $transaction: (fn) => fn({}) }), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-12T09:00:00Z"),
    deps: {
      count: async () => 1,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
    ensureQueued: async (_p, input) => {
      calls.push(input);
      return { status: "queued" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceMode, HOME_PROPOSAL_SOURCE_MODE);
  assert.equal(calls[0].resetAttempts, true);
});

test("requestHomeProposalGeneration: refuses when proposed action exists", async () => {
  let called = false;
  const result = await requestHomeProposalGeneration(/** @type {any} */ ({ $transaction: (fn) => fn({}) }), {
    merchantId: "m1",
    shopId: "s1",
    deps: {
      count: async () => 0,
      hasProposed: async () => true,
      inFlight: async () => false,
    },
    ensureQueued: async () => {
      called = true;
      return { status: "queued" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "proposed_exists");
  assert.equal(called, false);
});

test("requestHomeProposalGeneration: sixth generation is rejected server-side", async () => {
  let called = false;
  const result = await requestHomeProposalGeneration(/** @type {any} */ ({ $transaction: (fn) => fn({}) }), {
    merchantId: "m1",
    shopId: "s1",
    deps: {
      count: async () => DEFAULT_HOME_PROPOSAL_DAILY_CAP,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
    ensureQueued: async () => {
      called = true;
      return { status: "queued" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "daily_cap_reached");
  assert.equal(called, false);
});

test("requestHomeProposalGeneration: reused snapshot does not count as ok enqueue", async () => {
  const result = await requestHomeProposalGeneration(/** @type {any} */ ({ $transaction: (fn) => fn({}) }), {
    merchantId: "m1",
    shopId: "s1",
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
    ensureQueued: async () => ({ status: "reused" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "nothing_new");
});

test("requestHomeProposalGeneration: concurrent in-flight request is blocked", async () => {
  let called = false;
  const result = await requestHomeProposalGeneration(/** @type {any} */ ({ $transaction: (fn) => fn({}) }), {
    merchantId: "m1",
    shopId: "s1",
    deps: {
      count: async () => 1,
      hasProposed: async () => false,
      inFlight: async () => true,
    },
    ensureQueued: async () => {
      called = true;
      return { status: "queued" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "generating");
  assert.equal(called, false);
});

test("merchantHasProposedAction: true when a proposed row exists", async () => {
  const prisma = {
    merchantAction: {
      count: async ({ where }) => (where.status === "proposed" ? 1 : 0),
    },
  };
  assert.equal(
    await merchantHasProposedAction(/** @type {any} */ (prisma), { merchantId: "m1", shopId: "s1" }),
    true,
  );
});

test("no proactive recommendation architecture remains in live code", () => {
  const workerSource = readFileSync(
    new URL("../app/services/shopify-backfill-worker.server.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workerSource, /ENABLE_PROACTIVE_RECOMMENDATIONS/);
  assert.doesNotMatch(workerSource, /maybeGenerateProactiveRecommendations/);
  assert.doesNotMatch(workerSource, /PROACTIVE_SWEEP_INTERVAL_MS/);

  const routeSource = readFileSync(new URL("../app/routes/app._index.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /proactive-recommendations/);
  assert.match(routeSource, /home\.generate_proposal/);
  assert.match(routeSource, /getHomeProposalGenerationState/);

  const homeSource = readFileSync(new URL("../app/components/daily-home.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(homeSource, /NextRecommendationWait/);
  assert.doesNotMatch(homeSource, /hourly_check/);
  assert.doesNotMatch(homeSource, /Jefe checks again/);
  assert.match(homeSource, /ReadingYourStoreCard/);
  assert.match(homeSource, /Generate another proposal/);

  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.doesNotMatch(envExample, /ENABLE_PROACTIVE_RECOMMENDATIONS/);
});

test("terminal lifecycle modules no longer schedule proactive generation", () => {
  for (const file of [
    "../app/lib/actions/action-command.server.js",
    "../app/lib/actions/action-resolution.server.js",
    "../app/lib/actions/action-step-lifecycle.server.js",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /scheduleProactivePlanAfterTerminalState/);
    assert.doesNotMatch(source, /proactive-recommendation-trigger/);
  }
});

test("getLatestMerchantPlan surfaces agentic and home-triggered runs, not proactive", () => {
  const source = readFileSync(
    new URL("../app/lib/merchant-plan/service.server.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /sourceMode: \{ in: \[AGENTIC_RECOMMENDATION_SOURCE_MODE, "full", "home"\] \}/);
  assert.doesNotMatch(source, /"proactive"/);
});

test("countHomeProposalGenerationsSince only counts completed home runs", async () => {
  const queries = [];
  const prisma = {
    merchantPlanRun: {
      count: async (args) => {
        queries.push(args);
        return 3;
      },
    },
  };
  const since = new Date("2026-08-12T00:00:00Z");
  assert.equal(await countHomeProposalGenerationsSince(/** @type {any} */ (prisma), { merchantId: "m1", since }), 3);
  assert.equal(queries[0].where.sourceMode, HOME_PROPOSAL_SOURCE_MODE);
  assert.equal(queries[0].where.status, "completed");
});

test("isHomeProposalGenerationInFlight detects queued home runs", async () => {
  const prisma = {
    merchantPlanRun: {
      count: async ({ where }) =>
        where.sourceMode === HOME_PROPOSAL_SOURCE_MODE && where.status?.in?.length === 2 ? 1 : 0,
    },
  };
  assert.equal(
    await isHomeProposalGenerationInFlight(/** @type {any} */ (prisma), { merchantId: "m1", shopId: "s1" }),
    true,
  );
});

test("getHomeProposalGenerationState: surfaces no_actionable_opportunity terminal state", async () => {
  const prisma = {
    merchantPlanRun: {
      count: async () => 0,
      findFirst: async () => ({ status: "no_actionable_opportunity" }),
    },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
  });
  assert.equal(state?.canGenerate, true);
  assert.equal(state?.isGenerating, false);
  assert.equal(state?.terminalStatus, "no_actionable_opportunity");
});

test("getHomeProposalGenerationState: surfaces failed terminal state", async () => {
  const prisma = {
    merchantPlanRun: {
      count: async () => 0,
      findFirst: async () => ({ status: "failed" }),
    },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
  });
  assert.equal(state?.canGenerate, true);
  assert.equal(state?.terminalStatus, "failed");
});

test("getHomeProposalGenerationState: no terminal status when proposed action exists", async () => {
  const prisma = {
    merchantPlanRun: { count: async () => 0 },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => true,
      inFlight: async () => false,
    },
  });
  assert.equal(state?.canGenerate, false);
  assert.equal(state?.reason, "proposed_exists");
  assert.equal(state?.terminalStatus, null);
});

test("getHomeProposalGenerationState: no terminal status when generating (run is recent)", async () => {
  const recentUpdatedAt = new Date("2026-08-23T08:59:00Z"); // 1 min ago, well within threshold
  const prisma = {
    merchantPlanRun: {
      count: async () => 0,
      findFirst: async () => ({ updatedAt: recentUpdatedAt, createdAt: recentUpdatedAt }),
    },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => true,
    },
  });
  assert.equal(state?.isGenerating, true);
  assert.equal(state?.terminalStatus, null);
});

test("HOME_STUCK_RUN_THRESHOLD_MS is exported and a positive finite number", () => {
  assert.equal(typeof HOME_STUCK_RUN_THRESHOLD_MS, "number");
  assert.ok(Number.isFinite(HOME_STUCK_RUN_THRESHOLD_MS));
  assert.ok(HOME_STUCK_RUN_THRESHOLD_MS > 0);
});

test("getHomeProposalGenerationState: stuck run treated as failed and allows retry", async () => {
  // Run was last updated 20 minutes ago — past any reasonable threshold.
  const stuckAt = new Date("2026-08-23T08:40:00Z");
  const prisma = {
    merchantPlanRun: {
      count: async () => 0,
      findFirst: async () => ({ updatedAt: stuckAt, createdAt: stuckAt }),
    },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    stuckRunThresholdMs: 10 * 60 * 1000, // 10 min threshold for test
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => true,
    },
  });
  assert.equal(state?.isGenerating, false, "stuck run must not block the generating state");
  assert.equal(state?.canGenerate, true, "stuck run must allow retry");
  assert.equal(state?.terminalStatus, "failed", "stuck run surfaces as failed terminal");
});

test("getHomeProposalGenerationState: run within threshold is not considered stuck", async () => {
  const recentAt = new Date("2026-08-23T08:52:00Z"); // 8 min ago
  const prisma = {
    merchantPlanRun: {
      count: async () => 0,
      findFirst: async () => ({ updatedAt: recentAt, createdAt: recentAt }),
    },
  };
  const state = await getHomeProposalGenerationState(/** @type {any} */ (prisma), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    stuckRunThresholdMs: 10 * 60 * 1000, // 10 min threshold for test
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => true,
    },
  });
  assert.equal(state?.isGenerating, true, "recent run must remain generating");
  assert.equal(state?.terminalStatus, null);
});

test("worker run update does not overwrite sourceMode on the merchantPlanRun", () => {
  const source = readFileSync(
    new URL("../app/lib/shopify/agentic-runtime/recommendation-service.server.js", import.meta.url),
    "utf8",
  );
  // The status:running update and the status:completed update in persistAgenticRecommendation
  // must NOT include sourceMode: AGENTIC_RECOMMENDATION_SOURCE_MODE, otherwise home-triggered
  // runs would lose their sourceMode and polling would stop prematurely.
  const runningUpdateBlock = source.match(/status: PLAN_RUN_STATUS\.running[\s\S]*?}\s*,\s*\}/)?.[0] ?? "";
  assert.doesNotMatch(
    runningUpdateBlock,
    /sourceMode:\s*AGENTIC_RECOMMENDATION_SOURCE_MODE/,
    "status:running update must not overwrite sourceMode",
  );
  // The completed update is inside persistAgenticRecommendation.
  const completedUpdateBlock = source.match(/status: PLAN_RUN_STATUS\.completed[\s\S]*?}\s*,\s*\}/)?.[0] ?? "";
  assert.doesNotMatch(
    completedUpdateBlock,
    /sourceMode:\s*AGENTIC_RECOMMENDATION_SOURCE_MODE/,
    "status:completed update in persistAgenticRecommendation must not overwrite sourceMode",
  );
});

test("requestHomeProposalGeneration: passes sourceMode: home to ensureQueued", async () => {
  const calls = [];
  const result = await requestHomeProposalGeneration(/** @type {any} */ ({ $transaction: (fn) => fn({}) }), {
    merchantId: "m1",
    shopId: "s1",
    now: new Date("2026-08-23T09:00:00Z"),
    deps: {
      count: async () => 0,
      hasProposed: async () => false,
      inFlight: async () => false,
    },
    ensureQueued: async (_p, input) => {
      calls.push(input);
      return { status: "queued" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].sourceMode, HOME_PROPOSAL_SOURCE_MODE);
  assert.equal(calls[0].resetAttempts, true);
});
