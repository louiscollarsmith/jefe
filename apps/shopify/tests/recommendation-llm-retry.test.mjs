import assert from "node:assert/strict";
import test from "node:test";

import {
  withRecommendationLlmRetry,
  parseRetryAfterMs,
  RECOMMENDATION_LLM_RETRY_EVENT,
} from "../app/lib/shopify/agentic-runtime/recommendation-llm-retry.server.js";
import { runCandidateDrivenRecommendation, CANDIDATE_STATUS } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { SHOPIFY_AGENT_TOOL } from "../app/lib/shopify/agentic-runtime/tools.server.js";
import { LlmOutputValidationError, LlmProviderHttpError } from "../app/lib/llm/errors.server.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** No real delay — makes retry tests fast and deterministic (Part 15). */
function noWait() {
  const calls = [];
  const waitImpl = async (ms) => {
    calls.push(ms);
  };
  waitImpl.calls = calls;
  return waitImpl;
}

function http429(retryAfter = null) {
  return new LlmProviderHttpError("openai request failed with HTTP 429.", {
    provider: "openai",
    status: 429,
    code: "rate_limit",
    retryAfter,
  });
}

function http500() {
  return new LlmProviderHttpError("openai request failed with HTTP 500.", {
    provider: "openai",
    status: 500,
    code: "server_error",
  });
}

function networkReset() {
  return new Error("fetch failed: ECONNRESET");
}

function silentLogger() {
  const events = [];
  return {
    events,
    info: (event, detail) => events.push({ level: "info", event, detail }),
    warn: (event, detail) => events.push({ level: "warn", event, detail }),
    error: (event, detail) => events.push({ level: "error", event, detail }),
  };
}

// ---------------------------------------------------------------------------
// Unit tests: withRecommendationLlmRetry / parseRetryAfterMs
// ---------------------------------------------------------------------------

test("parseRetryAfterMs: numeric delay-seconds", () => {
  assert.equal(parseRetryAfterMs("15"), 15000);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(""), null);
});

test("parseRetryAfterMs: HTTP-date format", () => {
  const future = new Date(Date.now() + 20_000).toUTCString();
  const ms = parseRetryAfterMs(future);
  assert.ok(ms !== null && ms > 15_000 && ms <= 20_000, `expected ~20000ms, got ${ms}`);
  const past = new Date(Date.now() - 20_000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 0);
});

test("parseRetryAfterMs: unparseable value returns null", () => {
  assert.equal(parseRetryAfterMs("not-a-date-or-number"), null);
});

test("Part 13/20 core: retryable error retries the exact same invocation, no re-derivation", async () => {
  let calls = 0;
  const wait = noWait();
  const result = await withRecommendationLlmRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw http429();
      return { ok: true, calls };
    },
    { phase: "test", waitImpl: wait, logger: silentLogger() },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true, calls: 2 });
});

test("Part 15: multiple 429s then success — backoff occurs each time, same invocation retried", async () => {
  let calls = 0;
  const wait = noWait();
  const logger = silentLogger();
  const result = await withRecommendationLlmRetry(
    async () => {
      calls += 1;
      if (calls <= 2) throw http429();
      return { recovered: true };
    },
    { phase: "test", waitImpl: wait, logger },
  );
  assert.equal(calls, 3);
  assert.deepEqual(result, { recovered: true });
  assert.equal(wait.calls.length, 2, "expected exactly 2 backoff waits before the 3rd (successful) attempt");
  const recoveredEvent = logger.events.find((e) => e.event === RECOMMENDATION_LLM_RETRY_EVENT.recovered);
  assert.ok(recoveredEvent, "expected a recovered event to be logged");
  assert.equal(recoveredEvent.detail.attempt, 3);
});

test("Part 16: Retry-After numeric delay is honoured within bounds", async () => {
  let calls = 0;
  const wait = noWait();
  await withRecommendationLlmRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw http429("2");
      return { ok: true };
    },
    { phase: "test", waitImpl: wait, logger: silentLogger() },
  );
  assert.equal(wait.calls.length, 1);
  // 2s +/- 20% jitter = 1600-2400ms.
  assert.ok(wait.calls[0] >= 1600 && wait.calls[0] <= 2400, `expected ~2000ms, got ${wait.calls[0]}`);
});

test("Part 16: Retry-After HTTP-date delay is honoured (not ignored in favour of the fallback ladder)", async () => {
  let calls = 0;
  const wait = noWait();
  // A large target (60s) makes the assertion robust against toUTCString()'s whole-second
  // truncation and real scheduling overhead between computing the header and consuming it —
  // both are now a negligible fraction of the target, unlike a tight few-second window would be.
  // Exact-value precision is already covered deterministically by the parseRetryAfterMs unit
  // tests above; this test only needs to prove the header is used at all.
  const retryAfter = new Date(Date.now() + 60_000).toUTCString();
  await withRecommendationLlmRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw http429(retryAfter);
      return { ok: true };
    },
    { phase: "test", waitImpl: wait, logger: silentLogger() },
  );
  assert.equal(wait.calls.length, 1);
  // The fallback ladder's first rung is 15s; a correctly-honoured 60s Retry-After (capped at
  // MAX_SINGLE_DELAY_MS=90s, with up to -20% jitter) must land well above that, proving the
  // header — not the fallback default — drove the wait.
  assert.ok(wait.calls[0] > 20_000, `expected the 60s Retry-After to dominate the 15s fallback, got ${wait.calls[0]}`);
  assert.ok(wait.calls[0] <= 90_000, `expected the wait to respect MAX_SINGLE_DELAY_MS, got ${wait.calls[0]}`);
});

test("Part 17: retry budget exhausted — no infinite loop, throws the last error, diagnostics identify throttling", async () => {
  let calls = 0;
  const wait = noWait();
  const logger = silentLogger();
  await assert.rejects(
    () =>
      withRecommendationLlmRetry(
        async () => {
          calls += 1;
          throw http429();
        },
        { phase: "test", maxAttempts: 3, waitImpl: wait, logger },
      ),
    (error) => {
      assert.equal(error.status, 429);
      return true;
    },
  );
  assert.equal(calls, 3, "expected exactly maxAttempts calls, not an infinite loop");
  assert.equal(wait.calls.length, 2, "expected a wait before each retry, none after the final exhausted attempt");
  const exhausted = logger.events.find((e) => e.event === RECOMMENDATION_LLM_RETRY_EVENT.retryExhausted);
  assert.ok(exhausted, "expected a retryExhausted event");
  assert.equal(exhausted.detail.statusCode, 429);
  assert.equal(exhausted.detail.reason, "max_attempts_exceeded");
});

test("Part 17b: cumulative wait budget exhausted stops retrying even under maxAttempts", async () => {
  let calls = 0;
  const wait = noWait();
  const logger = silentLogger();
  await assert.rejects(() =>
    withRecommendationLlmRetry(
      async () => {
        calls += 1;
        throw http429();
      },
      { phase: "test", maxAttempts: 20, maxCumulativeWaitMs: 100, waitImpl: wait, logger },
    ),
  );
  // First fallback delay is 15000ms, far over the 100ms budget — must stop after attempt 1.
  assert.equal(calls, 1);
  const exhausted = logger.events.find((e) => e.event === RECOMMENDATION_LLM_RETRY_EVENT.retryExhausted);
  assert.equal(exhausted.detail.reason, "cumulative_budget_exceeded");
});

test("Part 18: non-retryable failure (schema/output validation) — no backoff, existing semantics apply", async () => {
  let calls = 0;
  const wait = noWait();
  await assert.rejects(
    () =>
      withRecommendationLlmRetry(
        async () => {
          calls += 1;
          throw new LlmOutputValidationError("Model output must be JSON.");
        },
        { phase: "test", waitImpl: wait, logger: silentLogger() },
      ),
    LlmOutputValidationError,
  );
  assert.equal(calls, 1, "non-retryable errors must not be retried");
  assert.equal(wait.calls.length, 0, "no backoff should occur for a deterministic error");
});

test("Part 18b: non-retryable auth failure (401) is not retried even though it is fallback-worthy elsewhere", async () => {
  let calls = 0;
  const wait = noWait();
  const authError = Object.assign(new Error("Unauthorized"), { status: 401 });
  await assert.rejects(() =>
    withRecommendationLlmRetry(
      async () => {
        calls += 1;
        throw authError;
      },
      { phase: "test", waitImpl: wait, logger: silentLogger() },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(wait.calls.length, 0);
});

test("Part 19: network reset / timeout is retried with the same in-place semantics as 429", async () => {
  let calls = 0;
  const wait = noWait();
  const result = await withRecommendationLlmRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw networkReset();
      return { recovered: true };
    },
    { phase: "test", waitImpl: wait, logger: silentLogger() },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { recovered: true });
});

test("5xx is retried like 429", async () => {
  let calls = 0;
  const wait = noWait();
  const result = await withRecommendationLlmRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw http500();
      return { recovered: true };
    },
    { phase: "test", waitImpl: wait, logger: silentLogger() },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { recovered: true });
});

// ---------------------------------------------------------------------------
// Integration tests: the candidate pipeline survives in-place 429s without
// restarting discovery, rescue, or repeating Shopify reads.
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  beliefs: [
    { id: "b-1", key: "catalog.draft_product_count", category: "catalog", value: { count: 1 }, authority: "deterministic" },
  ],
  goals: [],
  insights: [],
  goalCoaching: [],
  merchantContext: [],
  previousRecommendations: [],
  privacy: {},
  beliefCount: 1,
};

function scriptedProvider(router) {
  const calls = [];
  return {
    enabled: true,
    provider: "test",
    model: "scripted-luna",
    calls,
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const outcome = router(payload, calls);
      calls.push(payload);
      if (outcome instanceof Error) throw outcome;
      return { json: outcome, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
    },
  };
}

function fakeShopifyClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      }
      if (document.includes("products(")) {
        return {
          products: {
            edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      return {};
    },
  };
}

function baseInput(provider, overrides = {}) {
  return {
    provider,
    prisma: {
      shopifyOperationCall: { create: async () => ({}) },
      session: { findFirst: async () => ({ scope: "read_products,write_products" }) },
    },
    client: fakeShopifyClient(),
    merchantId: "00000000-0000-0000-0000-000000000041",
    shopId: "00000000-0000-0000-0000-000000000042",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: SNAPSHOT,
    grantedScopes: ["read_products", "write_products"],
    logger: { info() {}, warn() {}, error() {} },
    perCandidateIterations: 4,
    llmRetryWaitImpl: async () => {},
    ...overrides,
  };
}

function candidateFixture(candidateId, diagnosedProblem, priority) {
  return { candidateId, diagnosedProblem, priority, possibleIntervention: "make product purchasable" };
}

function readCall(operation = "products", variables = { first: 5 }) {
  return { tool: SHOPIFY_AGENT_TOOL.callOperation, arguments: { operation, variables, purpose: "Verify against Shopify state." } };
}

function retrieveCall(query = "products collections") {
  return { tool: SHOPIFY_AGENT_TOOL.retrieveOperations, arguments: { query, limit: 5 } };
}

function validRec(overrides = {}) {
  return {
    title: "Activate the stocked draft product",
    summary: "Publish a DRAFT product.",
    outcome: "The product becomes purchasable.",
    scope: "One draft product.",
    constraints: [],
    eligibilityCriteria: [{ resourceType: "Product", field: "status", operator: "eq", value: "DRAFT" }],
    materialExpectedEffects: ["Product moves from DRAFT to ACTIVE"],
    diagnosedProblem: "A stocked product is DRAFT and invisible to customers.",
    mechanism: "productUpdate sets status to ACTIVE, making it purchasable immediately.",
    whyThisAction: "Shopify read confirmed DRAFT status.",
    whyNow: "Every day it stays DRAFT is lost sellable assortment.",
    supportingBeliefIds: ["b-1"],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Read the product back and confirm status ACTIVE.",
    confidence: "strong",
    ...overrides,
  };
}

test("Part 13: 429 during candidate investigation retries in place — discovery stays at 1, queue unchanged, one Shopify read, recommendation completes", async () => {
  let productReads = 0;
  const client = {
    async request(document) {
      if (document.includes("currentAppInstallation")) return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      if (document.includes("products(")) {
        productReads += 1;
        return { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }], pageInfo: { hasNextPage: false } } };
      }
      return {};
    },
  };
  let investigationLlmCalls = 0;
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [candidateFixture("cand-a", "Draft product invisible", 1)] };
    }
    // candidate_investigation
    investigationLlmCalls += 1;
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall()] };
    if (investigationLlmCalls === 2) {
      // The very next LLM step (the one that would conclude the investigation) hits 429 once.
      return http429();
    }
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider, { client }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  const discoveryCalls = provider.calls.filter((p) => p.mode === "candidate_discovery" || p.mode === "rescue_discovery");
  assert.equal(discoveryCalls.length, 1, "DISCOVER_CANDIDATES must not be rerun after an in-place 429 recovery");
  assert.equal(result.diagnostics.candidateQueue.length, 1, "candidate queue must be unchanged by the retry");
  assert.equal(result.diagnostics.candidateQueue[0].candidateId, "cand-a");
  assert.equal(productReads, 1, "the Shopify read must not be repeated merely because the LLM step was throttled");
});

test("Part 14: 429 during rescue-candidate investigation retries in place — rescue discovery stays at 1, first-pass discovery not rerun, read not repeated", async () => {
  let collectionsReads = 0;
  const client = {
    async request(document) {
      if (document.includes("currentAppInstallation")) return { currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "write_products" }] } };
      if (document.includes("products(")) {
        return { products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Test Wine", status: "DRAFT" } }], pageInfo: { hasNextPage: false } } };
      }
      if (document.includes("collections(")) {
        collectionsReads += 1;
        return { collections: { edges: [], pageInfo: { hasNextPage: false } } };
      }
      return {};
    },
  };
  let rescueInvestigationCalls = 0;
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [candidateFixture("cand-a", "First pass problem", 1)] };
    }
    if (payload.mode === "rescue_discovery") {
      return { candidates: [candidateFixture("cand-rescue", "Materially different rescue problem", 1)] };
    }
    // candidate_investigation
    if (payload.focusCandidate.candidateId === "cand-a") {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("products")] };
      return { status: "NO_ACTIONABLE_OPPORTUNITY", blocker: "Disproven.", candidateDisposition: "REJECTED" };
    }
    // cand-rescue: a genuinely different read (collections, same granted scope as products),
    // isolated from cand-a's products read so this test measures the 429-retry's effect, not the
    // separate cross-candidate cache reuse.
    rescueInvestigationCalls += 1;
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall("collections", { first: 5 })] };
    if (rescueInvestigationCalls === 2) return http429();
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider, { client }));

  assert.equal(result.status, "RECOMMEND_ACTION");
  const firstPassDiscoveryCalls = provider.calls.filter((p) => p.mode === "candidate_discovery");
  const rescueDiscoveryCalls = provider.calls.filter((p) => p.mode === "rescue_discovery");
  assert.equal(firstPassDiscoveryCalls.length, 1, "first-pass discovery must not be rerun");
  assert.equal(rescueDiscoveryCalls.length, 1, "rescue discovery must not be rerun for a 429 inside rescue-candidate investigation");
  const rescueEntry = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-rescue");
  assert.equal(rescueEntry.status, CANDIDATE_STATUS.recommended);
  assert.equal(collectionsReads, 1, "the rescue candidate's Shopify read must not be repeated merely because the LLM step was throttled");
});

test("Part 18/20 integration: non-retryable validation failure inside a candidate does not trigger backoff and still pivots normally", async () => {
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      return { candidates: [candidateFixture("cand-a", "Bad candidate", 1), candidateFixture("cand-b", "Good candidate", 2)] };
    }
    if (payload.focusCandidate.candidateId === "cand-a") {
      if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall()] };
      // Missing required fields -> deterministic MISSING_FIELD validation failure, not an LLM infra error.
      return { status: "RECOMMEND_ACTION", recommendation: validRec({ title: "" }) };
    }
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall()] };
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));
  assert.equal(result.status, "RECOMMEND_ACTION");
  const queueA = result.diagnostics.candidateQueue.find((c) => c.candidateId === "cand-a");
  assert.equal(queueA.status, CANDIDATE_STATUS.nonExecutable);
});

test("Part 20: DISCOVER_CANDIDATES call count stays 1 even when discovery itself receives multiple 429s", async () => {
  let discoveryAttempts = 0;
  const provider = scriptedProvider((payload) => {
    if (payload.mode === "candidate_discovery") {
      discoveryAttempts += 1;
      if (discoveryAttempts <= 2) return http429();
      return { candidates: [candidateFixture("cand-a", "Draft product invisible", 1)] };
    }
    if (payload.iteration === 0) return { status: "CONTINUE", toolCalls: [readCall()] };
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await runCandidateDrivenRecommendation(baseInput(provider));

  assert.equal(result.status, "RECOMMEND_ACTION");
  assert.equal(discoveryAttempts, 3, "the invocation itself was attempted 3 times (2 failures + 1 success)");
  const loggedDiscoveryPayloads = provider.calls.filter((p) => p.mode === "candidate_discovery");
  // Only the successful attempt is ever recorded as a completed call in the pipeline's own
  // discoveryLog / candidate queue — the retries never produced a second DISCOVER_CANDIDATES
  // *phase transition* (no second PROGRESS_STATE.discoveringCandidates push, no candidate queue
  // rebuild). The scripted provider itself is invoked 3 times (that's the in-place retry working),
  // but the pipeline only ever ran the discovery *phase* once.
  assert.equal(loggedDiscoveryPayloads.length, 3);
  assert.equal(result.diagnostics.discoveryLog.length, 1, "only one discovery phase entry — the retries did not create additional phases");
});

test("generateAgenticShopifyRecommendation directly: 429 mid-loop retries the same turn without incrementing the outer iteration count", async () => {
  let attempts = 0;
  const provider = scriptedProvider((payload) => {
    attempts += 1;
    if (payload.iteration === 0) {
      if (attempts === 1) return http429();
      return { status: "CONTINUE", toolCalls: [retrieveCall(), readCall()] };
    }
    return { status: "RECOMMEND_ACTION", recommendation: validRec() };
  });

  const result = await generateAgenticShopifyRecommendation({
    ...baseInput(provider),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "RECOMMEND_ACTION");
  // Two outer turns (iteration 0, iteration 1) but 3 raw provider calls (iteration 0 failed once
  // then succeeded, iteration 1 succeeded) — proves the retry happened inside iteration 0's turn,
  // not as an extra outer iteration.
  const turnCount = result.trace.turns.filter((t) => t.status !== "SEMANTIC_REPAIR").length;
  assert.equal(turnCount, 2);
  assert.equal(attempts, 3);
});
