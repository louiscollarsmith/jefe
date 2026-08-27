/**
 * Regression suite for "Make Agentic Verification a Real Resumable Read-Only Phase"
 *
 * Ten tests covering the invariants stated in the spec:
 *  1. Phase correctness across 5 writes
 *  2. Structural write block in verification mode
 *  3. Crash after writes — verification runs from durable receipts, zero mutations
 *  4. Iteration exhaustion after writes — retry doesn't replay mutations
 *  5. Idempotency-window independence — recovery issues 0 mutation calls
 *  6. Verification mismatch → needs_attention, no writes
 *  7. Crash during verification — restart reads may repeat, can still complete
 *  8. Duplicate verification workers — idempotent, neither mutates
 *  9. Receipt association by revision — revision A receipts never used for revision B
 * 10. Fresh reload at each phase — workspace projection correct from DB alone
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runAgenticShopifyExecution } from "../app/lib/shopify/agentic-runtime/execution-agent.server.js";
import { runAgenticShopifyVerification } from "../app/lib/shopify/agentic-runtime/verification-agent.server.js";
import {
  acceptAgenticShopifyAction,
  materializeAgenticShopifyAction,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { buildActionWorkspace } from "../app/lib/actions/action-workspace.server.js";
import { enqueueAgenticVerificationRetryJob, MAX_VERIFICATION_RETRIES } from "../app/lib/shopify/agentic-runtime/execution-job.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

const merchantId = "00000000-0000-0000-0000-000000000031";
const shopId    = "00000000-0000-0000-0000-000000000032";
const shopDomain = "jefe-verification-test.myshopify.com";

// ---------------------------------------------------------------------------
// Test 1 — Phase correctness across 5 writes
//
// Invariant: phase stays "executing" while each write is issued. The transition
// to "verifying" may only happen after WRITES_COMPLETE is returned from the
// mutation loop — never during mutation iteration.
// ---------------------------------------------------------------------------
test("test 1: phase stays executing during all writes; transitions to verifying only at WRITES_COMPLETE", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  const phaseSnapshots = [];
  const capturingPrisma = phaseCapturePrisma(prisma, phaseSnapshots);

  const result = await runAgenticShopifyExecution({
    provider: fiveWriteProvider(),
    prisma: capturingPrisma,
    client: fakeShopifyClient(),
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "WRITES_COMPLETE");

  // Every phase written during the mutation loop (before the final WRITES_COMPLETE
  // transition) must be "executing".
  const duringMutation = phaseSnapshots.slice(0, -1);
  for (const snapshot of duringMutation) {
    assert.equal(
      snapshot.phase,
      "executing",
      `phase must not leave "executing" during mutation: got "${snapshot.phase}" at step ${snapshot.step}`,
    );
  }

  // The final phase snapshot (from WRITES_COMPLETE) must be "verifying".
  const finalSnapshot = phaseSnapshots.at(-1);
  assert.equal(
    finalSnapshot?.phase,
    "verifying",
    `final phase must be "verifying" after WRITES_COMPLETE, got "${finalSnapshot?.phase}"`,
  );
});

// ---------------------------------------------------------------------------
// Test 2 — Structural write block in verification mode
//
// Invariant: any mutation call from within runAgenticShopifyVerification returns
// VERIFICATION_WRITE_DENIED without touching Shopify. No mutation receipt is created.
// ---------------------------------------------------------------------------
test("test 2: verification rejects mutation attempts structurally; no receipt created", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Seed a fake accepted revision and a mutation receipt so the verification
  // agent has something to work with.
  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };
  prisma.operationCalls.push(fakeReceipt(action.id, "rev-1"));

  let shopifyCallCount = 0;
  const countingClient = {
    async request(document) {
      if (document.includes("productUpdate")) shopifyCallCount += 1;
      return fakeShopifyClient().request(document);
    },
  };

  const verResult = await runAgenticShopifyVerification({
    provider: mutationAttemptVerificationProvider(),
    prisma,
    client: countingClient,
    merchantId, shopId, shopDomain,
    actionId: action.id,
    // Inject write receipts directly so the agent has context
    writeReceipts: [fakeReceipt(action.id, "rev-1")],
    grantedScopes: ["read_products"],
    logger: quietLogger,
    maxIterations: 3,
  });

  // The provider eventually backs off and achieves OUTCOME_ACHIEVED after the
  // mutation is denied, OR the provider escalates to BLOCKED. Either way:
  assert.equal(shopifyCallCount, 0, "Shopify mutation must not have been called");

  // No mutation receipt must have been created during verification
  const mutationReceiptsAfter = prisma.operationCalls.filter(
    (r) => r.operationKind === "MUTATION" && r.merchantActionId === action.id,
  );
  // Only the pre-seeded receipt should exist (created before verification ran)
  assert.equal(
    mutationReceiptsAfter.length,
    1,
    "no new mutation receipts must be created during verification",
  );
});

// ---------------------------------------------------------------------------
// Test 3 — Crash after writes; verification runs from durable receipts
//
// Invariant: when phase = "verifying" at entry (crash-recovery scenario), the
// verification runtime loads write receipts from DB and achieves the outcome
// without issuing any Shopify mutations.
// ---------------------------------------------------------------------------
test("test 3: crash recovery — verification succeeds from durable DB receipts, zero mutations", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Simulate a crash that left phase = "verifying" and wrote receipts
  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-crash";
  prisma.operationCalls.push(
    fakeReceipt(action.id, "rev-crash", "productUpdate"),
    fakeReceipt(action.id, "rev-crash", "productUpdate"),
  );

  let shopifyMutationCount = 0;
  const guardClient = {
    async request(document) {
      if (document.includes("productUpdate")) shopifyMutationCount += 1;
      return fakeShopifyClient().request(document);
    },
  };

  const verResult = await runAgenticShopifyVerification({
    provider: verificationProvider(),
    prisma,
    client: guardClient,
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  assert.equal(verResult.ok, true, "verification should succeed in crash-recovery scenario");
  assert.equal(shopifyMutationCount, 0, "zero Shopify mutations must occur during verification");

  // Action must be completed
  assert.equal(prisma.actions[0].status, "completed");
  assert.equal(prisma.actions[0].progress?.agentic?.executionJob?.phase, "completed");
});

// ---------------------------------------------------------------------------
// Test 4 — Iteration exhaustion after writes; retry does not replay mutations
//
// Invariant: if the first verification attempt hits the iteration budget (and
// returns VERIFICATION_ITERATION_LIMIT), a retry job is enqueued and the retry
// attempts zero additional Shopify mutations.
// ---------------------------------------------------------------------------
test("test 4: iteration exhaustion queues retry; retry does not replay mutations", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Set up state as if mutation phase completed
  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-exhaustion";
  prisma.operationCalls.push(fakeReceipt(action.id, "rev-exhaustion"));

  // First attempt: budget exhausted (all CONTINUE, never OUTCOME_ACHIEVED)
  const firstAttempt = await runAgenticShopifyVerification({
    provider: blockedVerificationProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
    maxIterations: 2,
  });

  assert.equal(firstAttempt.ok, false);
  assert.equal(firstAttempt.blocker, "VERIFICATION_ITERATION_LIMIT");
  assert.equal(
    prisma.actions[0].progress?.agentic?.executionJob?.phase,
    "verification_incomplete",
  );

  // Enqueue retry (simulating what the worker would do)
  await enqueueAgenticVerificationRetryJob(prisma, {
    merchantId, shopId,
    actionId: action.id,
    acceptedRevision: "rev-exhaustion",
    verificationRetryCount: 1,
  });

  // Retry attempt: succeeds using durable receipts
  let retryMutationCount = 0;
  const retryClient = {
    async request(document) {
      if (document.includes("productUpdate")) retryMutationCount += 1;
      return fakeShopifyClient().request(document);
    },
  };

  const retryAttempt = await runAgenticShopifyVerification({
    provider: verificationProvider(),
    prisma,
    client: retryClient,
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  assert.equal(retryAttempt.ok, true, "retry should succeed");
  assert.equal(retryMutationCount, 0, "retry must not issue any Shopify mutations");
  assert.equal(prisma.actions[0].status, "completed");
});

// ---------------------------------------------------------------------------
// Test 5 — Idempotency-window independence
//
// Invariant: a verification retry that runs after any provider-level idempotency
// window has expired must not issue any mutation calls. Verification is purely
// a read concern; the mutation phase is closed.
// ---------------------------------------------------------------------------
test("test 5: verification retry issues zero mutation calls regardless of idempotency window", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Simulate expired idempotency window: receipts exist but the gateway
  // would reject any new mutation with the same key (return code 422).
  prisma.actions[0].progress.agentic.executionJob = { phase: "verification_incomplete", verificationRetryCount: 1 };
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-idempotent";
  prisma.operationCalls.push(fakeReceipt(action.id, "rev-idempotent"));

  const mutationsAttempted = [];
  const idempotencyExpiredClient = {
    async request(document, variables) {
      if (document.includes("productUpdate")) {
        mutationsAttempted.push({ document, variables });
        throw new Error("Idempotency window expired — 422");
      }
      return fakeShopifyClient().request(document, variables);
    },
  };

  const result = await runAgenticShopifyVerification({
    provider: verificationProvider(),
    prisma,
    client: idempotencyExpiredClient,
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  // Regardless of whether the verification succeeded or not, zero mutations must have been attempted
  assert.equal(
    mutationsAttempted.length,
    0,
    `verification runtime must not attempt mutations; attempted: ${mutationsAttempted.length}`,
  );
  assert.equal(result.ok, true, "verification should succeed reading current state");
});

// ---------------------------------------------------------------------------
// Test 6 — Verification mismatch
//
// Invariant: when the verifier reads Shopify and finds state does not match the
// expected outcome, action becomes needs_attention. No new writes occur.
// ---------------------------------------------------------------------------
test("test 6: verification mismatch → needs_attention, no new writes, mismatch evidence persisted", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-mismatch";
  prisma.operationCalls.push(fakeReceipt(action.id, "rev-mismatch"));

  const mutationsAttempted = [];
  const guardClient = {
    async request(document, variables) {
      if (document.includes("productUpdate")) mutationsAttempted.push({ document, variables });
      return fakeShopifyClient().request(document, variables);
    },
  };

  const result = await runAgenticShopifyVerification({
    provider: mismatchVerificationProvider(),
    prisma,
    client: guardClient,
    merchantId, shopId, shopDomain,
    actionId: action.id,
    writeReceipts: [fakeReceipt(action.id, "rev-mismatch")],
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "VERIFICATION_MISMATCH");
  assert.equal(mutationsAttempted.length, 0, "no mutations during mismatch verification");

  const finalAction = prisma.actions[0];
  assert.equal(finalAction.status, "needs_attention");
  assert.equal(finalAction.progress?.agentic?.executionJob?.phase, "needs_attention");
  assert.equal(finalAction.outcome?.verificationMismatch, true, "mismatch evidence must be persisted");
  assert.ok(
    typeof finalAction.outcome?.mismatch === "string" && finalAction.outcome.mismatch.length > 0,
    "mismatch description must be non-empty",
  );
});

// ---------------------------------------------------------------------------
// Test 7 — Crash during verification; restart reads may repeat, can complete
//
// Invariant: if a crash occurs mid-verification (phase = "verifying"), a new
// verification run loading durable receipts from DB can still reach OUTCOME_ACHIEVED.
// Read operations may repeat (idempotent), but never mutate.
// ---------------------------------------------------------------------------
test("test 7: crash during verification — restart completes via durable receipts, reads may repeat", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Simulate: crashed during verification, receipts already in DB
  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-mid-verify";
  prisma.operationCalls.push(fakeReceipt(action.id, "rev-mid-verify"));

  let readCount = 0;
  let mutationCount = 0;
  const trackingClient = {
    async request(document, variables) {
      if (document.includes("productUpdate")) mutationCount += 1;
      else readCount += 1;
      return fakeShopifyClient().request(document, variables);
    },
  };

  const result = await runAgenticShopifyVerification({
    provider: verificationProvider(),
    prisma,
    client: trackingClient,
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  assert.equal(mutationCount, 0, "crash restart must issue zero mutations");
  assert.ok(readCount >= 1, "at least one read must occur during verification");
  assert.equal(result.ok, true, "verification must complete after crash recovery");
  assert.equal(prisma.actions[0].status, "completed");
});

// ---------------------------------------------------------------------------
// Test 8 — Duplicate verification workers; idempotent, neither mutates
//
// Invariant: if two verification workers race (both receive phase = "verifying"),
// the terminal state is idempotent — the action ends up "completed" regardless
// of ordering, and neither worker issues mutations.
// ---------------------------------------------------------------------------
test("test 8: duplicate verification workers — idempotent, no mutations, consistent terminal state", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-race";
  prisma.operationCalls.push(fakeReceipt(action.id, "rev-race"));

  let mutationCount = 0;
  const guardClient = {
    async request(document, variables) {
      if (document.includes("productUpdate")) mutationCount += 1;
      return fakeShopifyClient().request(document, variables);
    },
  };

  // Both workers run concurrently (simulated sequentially — real races are
  // covered by the idempotency of markActionExecutionOutcome at the DB layer)
  const [r1, r2] = await Promise.all([
    runAgenticShopifyVerification({
      provider: verificationProvider(), prisma, client: guardClient,
      merchantId, shopId, shopDomain, actionId: action.id,
      writeReceipts: [fakeReceipt(action.id, "rev-race")],
      grantedScopes: ["read_products"], logger: quietLogger,
    }),
    runAgenticShopifyVerification({
      provider: verificationProvider(), prisma, client: guardClient,
      merchantId, shopId, shopDomain, actionId: action.id,
      writeReceipts: [fakeReceipt(action.id, "rev-race")],
      grantedScopes: ["read_products"], logger: quietLogger,
    }),
  ]);

  assert.equal(mutationCount, 0, "neither worker may issue mutations");

  // Both must see a success (or one sees "completed" already)
  const bothOk = r1.ok && r2.ok;
  const oneOk = r1.ok || r2.ok;
  assert.ok(oneOk, "at least one worker must succeed");

  // Terminal state must be completed
  assert.equal(prisma.actions[0].status, "completed");
  assert.equal(prisma.actions[0].progress?.agentic?.executionJob?.phase, "completed");

  if (bothOk) {
    // Both succeeded — idempotent
    assert.equal(r1.status, "OUTCOME_ACHIEVED");
    assert.equal(r2.status, "OUTCOME_ACHIEVED");
  }
});

// ---------------------------------------------------------------------------
// Test 9 — Receipt association by revision
//
// Invariant: write receipts from revision A must not be used when verifying
// revision B. The verifier only reads receipts matching the acceptedActionRevision.
// ---------------------------------------------------------------------------
test("test 9: receipt association — revision A receipts never surfaced to revision B verification", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId, shopId, recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Revision A receipts (should NOT be used for B verification)
  prisma.operationCalls.push(
    fakeReceipt(action.id, "rev-A", "productUpdate"),
    fakeReceipt(action.id, "rev-A", "productUpdate"),
  );

  // Revision B: no receipts at all
  prisma.actions[0].progress.agentic.acceptedActionRevision = "rev-B";
  prisma.actions[0].progress.agentic.executionJob = { phase: "verifying" };

  const receiptsSeenByVerifier = [];
  const spyPrisma = {
    ...prisma,
    shopifyOperationCall: {
      ...prisma.shopifyOperationCall,
      findMany: async (args) => {
        const results = await prisma.shopifyOperationCall.findMany(args);
        receiptsSeenByVerifier.push(...results);
        return results;
      },
    },
  };

  // Verification for rev-B should see 0 receipts (rev-A filtered out)
  await runAgenticShopifyVerification({
    provider: verificationWithReceiptCheckProvider(receiptsSeenByVerifier),
    prisma: spyPrisma,
    client: fakeShopifyClient(),
    merchantId, shopId, shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
    maxIterations: 2,
  });

  // Only rev-B receipts should have been surfaced (there are none)
  const revAReceipts = receiptsSeenByVerifier.filter((r) => r.acceptedActionRevision === "rev-A");
  assert.equal(
    revAReceipts.length,
    0,
    "rev-A receipts must not be surfaced to rev-B verification",
  );
});

// ---------------------------------------------------------------------------
// Test 10 — Fresh reload at each lifecycle phase
//
// Invariant: the workspace projection is correct from DB-persisted state alone
// at every phase. No in-memory continuity required.
// ---------------------------------------------------------------------------
test("test 10: workspace projection correct from DB state at every lifecycle phase", () => {
  const phases = [
    {
      phase: "executing",
      expectedState: "running",
      expectedLabel: "Jefe working",
      expectedActionState: "jefe_working",
    },
    {
      phase: "verifying",
      expectedState: "running",
      expectedLabel: "Verifying",
      expectedActionState: "jefe_working",
    },
    {
      phase: "verification_incomplete",
      expectedState: "running",
      expectedLabel: "Verifying",
      expectedActionState: "jefe_working",
    },
    {
      phase: "completed",
      status: "completed",
      expectedState: "completed",
      expectedLabel: null,
      expectedActionState: "completed",
    },
    {
      phase: "needs_attention",
      status: "needs_attention",
      expectedState: "needs_attention",
      expectedLabel: "Needs attention",
      expectedActionState: "needs_attention",
    },
  ];

  for (const { phase, status, expectedState, expectedLabel, expectedActionState } of phases) {
    const action = makeActionAtPhase(phase, status ?? "accepted");
    const workspace = buildActionWorkspace(action);
    const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");

    assert.ok(execItem, `execute_and_verify_outcome item must exist at phase "${phase}"`);
    assert.equal(
      execItem.state,
      expectedState,
      `at phase "${phase}": execItem.state must be "${expectedState}", got "${execItem.state}"`,
    );
    if (expectedLabel !== null) {
      assert.equal(
        execItem.statusLabel,
        expectedLabel,
        `at phase "${phase}": statusLabel must be "${expectedLabel}", got "${execItem.statusLabel}"`,
      );
    }
    assert.equal(
      workspace.actionState,
      expectedActionState,
      `at phase "${phase}": workspace.actionState must be "${expectedActionState}", got "${workspace.actionState}"`,
    );
  }

  // verification_incomplete + verificationExhausted = true → needs_attention
  const exhaustedAction = makeActionAtPhase("verification_incomplete", "accepted", { verificationExhausted: true });
  const exhaustedWorkspace = buildActionWorkspace(exhaustedAction);
  const exhaustedItem = exhaustedWorkspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.equal(exhaustedItem?.state, "needs_attention");
  assert.equal(exhaustedItem?.statusLabel, "Needs attention");
  assert.equal(exhaustedWorkspace.actionState, "needs_attention");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hideProductsRecommendation() {
  return {
    title: "Hide active products that are currently out of stock",
    summary: "Hide products to prevent customers seeing out-of-stock items.",
    outcome: "All out-of-stock products are hidden from the storefront.",
    scope: "Active products with zero inventory.",
    constraints: ["Do not change prices."],
    materialExpectedEffects: ["Set product status to DRAFT for qualifying products"],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: "Read each product back and confirm status is DRAFT.",
    reversalStrategy: "Fixture reversal strategy.",
    whyThisAction: "Out-of-stock products visible on storefront.",
    whyNow: "Multiple products found with zero inventory.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    confidence: "high",
  };
}

function makeActionAtPhase(phase, status, extraJobFields = {}) {
  const semanticAction = {
    revision: "rev-fixture",
    title: "Hide out-of-stock products",
    summary: "Hide products with zero inventory.",
    outcome: "All out-of-stock products are hidden.",
    scope: "Active products with zero inventory.",
    constraints: [],
    materialExpectedEffects: [{ label: "Set product status to DRAFT" }],
    eligibilityCriteria: [],
    writeProtections: [],
    verificationPlan: "Read products back and confirm DRAFT status.",
    reversalStrategy: "Fixture reversal strategy.",
    whyThisAction: "Out-of-stock products visible.",
    whyNow: "Products found.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
  };
  return {
    id: `action-phase-${phase}`,
    merchantId,
    shopId,
    title: "Hide out-of-stock products",
    summary: "Hide products with zero inventory.",
    status,
    outcome: status === "completed"
      ? { verification: { verified: true, evidence: [], remaining: [] }, progressSummary: "Done." }
      : status === "needs_attention"
      ? { verificationMismatch: true, mismatch: "Product still ACTIVE." }
      : null,
    progress: {
      agentic: {
        runtime: "shopify_admin_api",
        currentActionRevision: "rev-fixture",
        acceptedActionRevision: "rev-fixture",
        semanticAction,
        executionJob: { phase, jobStatus: "running", ...extraJobFields },
      },
    },
    plan: { agentic: { runtime: "shopify_admin_api", semanticAction } },
  };
}

function fakeReceipt(actionId, revision, operation = "productUpdate") {
  return {
    id: `receipt-${Math.random().toString(36).slice(2)}`,
    merchantId,
    shopId,
    merchantActionId: actionId,
    acceptedActionRevision: revision,
    operationKind: "MUTATION",
    operationName: operation,
    operationId: operation,
    purpose: "Hide the product.",
    expectedEffect: "Set status to DRAFT.",
    resourceIds: ["gid://shopify/Product/1"],
    status: "OK",
    createdAt: new Date(),
  };
}

/** Provider that issues 5 writes sequentially then signals WRITES_COMPLETE. */
function fiveWriteProvider() {
  let writeCount = 0;
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const completedWrites = (payload.toolResults ?? []).filter(
        (r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation && r.ok,
      ).length;
      if (completedWrites < 5) {
        writeCount += 1;
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [{
              tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
              arguments: {
                document:
                  'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
                variables: { product: { id: `gid://shopify/Product/${writeCount}`, status: "DRAFT" } },
                purpose: `Hide product ${writeCount}.`,
                expectedEffect: "Set status to DRAFT.",
                idempotencyKey: `hide-product-${writeCount}`,
              },
            }],
          },
        };
      }
      return { json: { status: "WRITES_COMPLETE", progressSummary: "5 products hidden." } };
    },
  };
}

/** Provider for verification that confirms outcome after one read. */
function verificationProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const reads = (payload.toolResults ?? []).filter(
        (r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.ok,
      );
      if (!reads.length) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [{
              tool: SHOPIFY_GATEWAY_TOOL.query,
              arguments: {
                document: "query($id: ID!) { product(id: $id) { id status } }",
                variables: { id: "gid://shopify/Product/1" },
              },
            }],
          },
        };
      }
      return {
        json: {
          status: "OUTCOME_ACHIEVED",
          progressSummary: "Product verified as DRAFT.",
          verification: {
            verified: true,
            evidence: ["Product gid://shopify/Product/1 is DRAFT."],
            remaining: [],
          },
        },
      };
    },
  };
}

/** Provider that first attempts a mutation (should be blocked), then backs off to read + OUTCOME_ACHIEVED. */
function mutationAttemptVerificationProvider() {
  let attemptedMutation = false;
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const results = payload.toolResults ?? [];

      if (!attemptedMutation) {
        attemptedMutation = true;
        // Try a mutation — the tool layer must reject this
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [{
              tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
              arguments: {
                document:
                  'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
                variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                purpose: "Attempting mutation in verification (must be blocked).",
                expectedEffect: "Should be rejected.",
                idempotencyKey: "ver-mutation-attempt",
              },
            }],
          },
        };
      }

      // After blocked mutation, do a read
      const reads = results.filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.facts?.operation === "product" && r.ok);
      if (!reads.length) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [{
              tool: SHOPIFY_GATEWAY_TOOL.query,
              arguments: {
                document: "query($id: ID!) { product(id: $id) { id status } }",
                variables: { id: "gid://shopify/Product/1" },
              },
            }],
          },
        };
      }
      return {
        json: {
          status: "OUTCOME_ACHIEVED",
          progressSummary: "Read confirmed DRAFT.",
          verification: { verified: true, evidence: ["Product is DRAFT."], remaining: [] },
        },
      };
    },
  };
}

/** Provider that reports VERIFICATION_MISMATCH after reading. */
function mismatchVerificationProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const reads = (payload.toolResults ?? []).filter(
        (r) => r.tool === SHOPIFY_GATEWAY_TOOL.query && r.ok,
      );
      if (!reads.length) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [{
              tool: SHOPIFY_GATEWAY_TOOL.query,
              arguments: {
                document: "query($id: ID!) { product(id: $id) { id status } }",
                variables: { id: "gid://shopify/Product/1" },
              },
            }],
          },
        };
      }
      return {
        json: {
          status: "VERIFICATION_MISMATCH",
          blocker: "Product is still ACTIVE, not DRAFT.",
          verification: {
            verified: false,
            mismatch: "Product is still ACTIVE, not DRAFT.",
            evidence: [],
            remaining: ["Confirm product status"],
          },
        },
      };
    },
  };
}

/** Provider that always returns CONTINUE without making tool calls (exhausts iteration budget). */
function blockedVerificationProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson() {
      return { json: { status: "CONTINUE", toolCalls: [] } };
    },
  };
}

/**
 * Provider that checks receipts array during verification.
 * Used in Test 9 to verify revision filtering.
 */
function verificationWithReceiptCheckProvider(receiptsRef) {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      // The prompt includes executedMutations — this is what the receipts are surfaced as
      const mutations = payload.executedMutations ?? [];
      // Push any mutations the LLM sees into our spy
      for (const m of mutations) receiptsRef.push({ acceptedActionRevision: m._revision });
      // Just block — we don't need to complete for this test
      return { json: { status: "BLOCKED", blocker: "test_stop" } };
    },
  };
}

function fakeShopifyClient() {
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return {
          currentAppInstallation: {
            accessScopes: [
              { handle: "read_products" },
              { handle: "write_products" },
            ],
          },
        };
      }
      if (document.includes("productUpdate")) {
        return {
          productUpdate: {
            product: { id: "gid://shopify/Product/1", status: "DRAFT" },
            userErrors: [],
          },
        };
      }
      if (document.includes("product")) {
        return {
          product: {
            id: "gid://shopify/Product/1",
            title: "Cold Bench Six",
            status: "DRAFT",
            handle: "cold-bench-six",
            productType: "Wine",
            tags: [],
          },
        };
      }
      return {};
    },
  };
}

function fakePrisma() {
  const prisma = {
    actions: [],
    events: [],
    operationCalls: [],
    jobs: [],
    $transaction: async (run) => run(prisma),
    backfillJob: {
      findUnique: async ({ where }) => {
        if (where.id) return prisma.jobs.find((j) => j.id === where.id) ?? null;
        const key = where.shopId_jobType;
        return (
          prisma.jobs.find(
            (j) => j.shopId === key.shopId && j.jobType === key.jobType,
          ) ?? null
        );
      },
      upsert: async ({ where, create, update }) => {
        const key = where.shopId_jobType;
        const existing = prisma.jobs.find(
          (j) => j.shopId === key.shopId && j.jobType === key.jobType,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `job-${prisma.jobs.length + 1}`, ...create, createdAt: new Date() };
        prisma.jobs.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = prisma.jobs.find((j) => j.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? null;
      },
    },
    merchantAction: {
      create: async ({ data }) => {
        const row = {
          id: `action-${prisma.actions.length + 1}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        prisma.actions.push(row);
        return row;
      },
      findFirst: async ({ where }) =>
        prisma.actions.find(
          (row) =>
            (!where.id || row.id === where.id) &&
            (!where.merchantId || row.merchantId === where.merchantId) &&
            (!where.shopId || row.shopId === where.shopId) &&
            matchesStatus(row.status, where.status),
        ) ?? null,
      update: async ({ where, data }) => {
        const row = prisma.actions.find((item) => item.id === where.id);
        if (row) Object.assign(row, data, { updatedAt: new Date() });
        return row ?? null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of prisma.actions) {
          if (
            (!where.id || row.id === where.id) &&
            (!where.merchantId || row.merchantId === where.merchantId) &&
            (!where.shopId || row.shopId === where.shopId) &&
            matchesStatus(row.status, where.status)
          ) {
            Object.assign(row, data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
    },
    merchantActionEvent: {
      create: async ({ data }) => {
        prisma.events.push(data);
        return data;
      },
      findMany: async () => prisma.events,
    },
    actionChangeSet: {
      findFirst: async () => null,
    },
    shopifyOperationCall: {
      create: async ({ data }) => {
        const row = {
          id: `op-${prisma.operationCalls.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        prisma.operationCalls.push(row);
        return row;
      },
      findMany: async ({ where, take } = {}) =>
        prisma.operationCalls
          .filter(
            (row) =>
              (!where?.merchantId || row.merchantId === where.merchantId) &&
              (!where?.shopId || row.shopId === where.shopId) &&
              (!where?.merchantActionId || row.merchantActionId === where.merchantActionId) &&
              (!where?.acceptedActionRevision || row.acceptedActionRevision === where.acceptedActionRevision) &&
              (!where?.operationKind || row.operationKind === where.operationKind) &&
              (!where?.status?.in || where.status.in.includes(row.status)),
          )
          .slice(0, take ?? prisma.operationCalls.length),
    },
  };
  return prisma;
}

/**
 * Wraps a fakePrisma and captures every executionJob phase written via
 * merchantAction.update. Used in Test 1 to verify phase transition timing.
 */
function phaseCapturePrisma(basePrisma, snapshots) {
  let step = 0;
  return {
    ...basePrisma,
    merchantAction: {
      ...basePrisma.merchantAction,
      update: async (args) => {
        const result = await basePrisma.merchantAction.update(args);
        const job = args.data?.progress?.agentic?.executionJob;
        if (job?.phase) {
          snapshots.push({ step: step++, phase: job.phase });
        }
        return result;
      },
    },
  };
}

function matchesStatus(actual, filter) {
  if (!filter) return true;
  if (typeof filter === "string") return actual === filter;
  if (Array.isArray(filter.in)) return filter.in.includes(actual);
  return true;
}

const quietLogger = { info() {}, warn() {}, error() {} };
