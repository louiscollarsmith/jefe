import assert from "node:assert/strict";
import test from "node:test";

import { processReadyBackfillJobs } from "../app/services/shopify-backfill-worker.server.js";
import {
  getWorkerLastTickAt,
  recordWorkerTick,
  __resetHeartbeat,
} from "../app/lib/observability/heartbeat.server.js";

// `/health` calls the worker `stale` once its last tick is older than 90s, and the loop
// stamped that heartbeat exactly once — at the top of a tick. But a tick drains SEVERAL ready
// jobs sequentially and then runs the whole maintenance chain, so a busy worker and a wedged
// worker looked identical after 90 seconds.
//
// The heaviest drain there is happens to be a merchant onboarding: the backfill phases
// enqueue one another deliberately (products, inventory, orders, delta, finalize, memory) so
// it doesn't feel stalled. So the condition that made the worker report dead was a store
// being imported — observed twice in production on 2026-08-12, both times with exactly one
// job running.
//
// The property asserted: real progress refreshes the heartbeat, and no progress does not.
// Jobs here take the `shop_uninstalled` cancel path, which is a genuine early return through
// the real claim logic rather than a stubbed handler.

/** @param {number} count How many queued jobs the double should yield before drying up. */
function buildPrisma(count) {
  let remaining = count;
  const job = () => ({
    id: `job-${remaining}`,
    jobType: "test_job",
    shopId: "s1",
    // Uninstalled → processNextBackfillJob cancels and returns a result without running a
    // handler. Still a completed unit of work, which is what the heartbeat is about.
    shop: { status: "uninstalled", shopDomain: "example.myshopify.com" },
    merchant: { id: "m1" },
  });
  const backfillJob = {
    findFirst: async () => (remaining > 0 ? (remaining -= 1, job()) : null),
    updateMany: async () => ({ count: 1 }),
    findMany: async () => [],
    update: async () => ({}),
    create: async () => ({}),
    count: async () => 0,
  };
  const empty = {
    findFirst: async () => null,
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    update: async () => ({}),
    create: async () => ({}),
    upsert: async () => ({}),
    count: async () => 0,
  };
  return new Proxy(
    { backfillJob, $transaction: async (/** @type {any} */ fn) => (typeof fn === "function" ? fn(empty) : []) },
    {
      get(target, prop) {
        if (prop in target) return /** @type {any} */ (target)[prop];
        if (prop === "then") return undefined;
        return empty;
      },
    },
  );
}

test("draining work refreshes the heartbeat", async () => {
  __resetHeartbeat();
  assert.equal(getWorkerLastTickAt(), null, "starts with no heartbeat");

  const results = await processReadyBackfillJobs(buildPrisma(3), { maxJobs: 5 });

  assert.equal(results.length, 3, "the double should have yielded three jobs");
  assert.ok(
    typeof getWorkerLastTickAt() === "number",
    "a completed job must leave a heartbeat behind",
  );
});

test("the heartbeat moves FORWARD during a drain, not just at the tick start", async () => {
  __resetHeartbeat();
  recordWorkerTick(1_000); // as the tick does, once, at the top
  assert.equal(getWorkerLastTickAt(), 1_000);

  await processReadyBackfillJobs(buildPrisma(2), { maxJobs: 5 });

  const after = getWorkerLastTickAt();
  assert.ok(
    typeof after === "number" && after > 1_000,
    `draining must advance the heartbeat past the tick-start stamp (got ${after})`,
  );
});

test("an empty queue does not fake a heartbeat", async () => {
  __resetHeartbeat();
  const results = await processReadyBackfillJobs(buildPrisma(0), { maxJobs: 5 });
  assert.equal(results.length, 0);
  // A loop with nothing to do is not evidence of a working loop — the tick-level stamp in the
  // caller covers that. Inventing one here would make a wedged queue look healthy, which is
  // the exact failure this whole signal exists to catch.
  assert.equal(getWorkerLastTickAt(), null);
});
