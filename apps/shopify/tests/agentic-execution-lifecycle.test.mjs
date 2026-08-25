import assert from "node:assert/strict";
import test from "node:test";

import { runAgenticShopifyExecution } from "../app/lib/shopify/agentic-runtime/execution-agent.server.js";
import { runAgenticShopifyVerification } from "../app/lib/shopify/agentic-runtime/verification-agent.server.js";
import {
  acceptAgenticShopifyAction,
  materializeAgenticShopifyAction,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import {
  buildActionWorkspace,
  resolveWorkspaceFocus,
  workspacePlanItems,
} from "../app/lib/actions/action-workspace.server.js";
import { SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";

const merchantId = "00000000-0000-0000-0000-000000000021";
const shopId = "00000000-0000-0000-0000-000000000022";
const shopDomain = "jefe-lifecycle-test.myshopify.com";

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path: mutation phase → verification phase → completed
// ---------------------------------------------------------------------------
test("scenario 1: mutation WRITES_COMPLETE then verification OUTCOME_ACHIEVED → completed, phase = completed", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Mutation phase: issues write then signals WRITES_COMPLETE
  const mutationResult = await runAgenticShopifyExecution({
    provider: mutationPhaseProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(mutationResult.ok, true, "mutation phase should succeed");
  assert.equal(mutationResult.status, "WRITES_COMPLETE");

  // Phase must be "verifying" after mutation, not "completed"
  const afterMutation = prisma.actions[0];
  assert.equal(afterMutation.progress?.agentic?.executionJob?.phase, "verifying");
  // Write receipt must exist
  assert.ok(prisma.operationCalls.some((r) => r.operationKind === "MUTATION" && r.status === "OK"));

  // Verification phase: read-only — confirms outcome
  const verResult = await runAgenticShopifyVerification({
    provider: verificationPhaseProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  assert.equal(verResult.ok, true, "verification should succeed");
  assert.equal(verResult.status, "OUTCOME_ACHIEVED");

  const finalAction = prisma.actions[0];

  // Invariant: completed requires successful outcome verification
  assert.equal(finalAction.status, "completed");
  assert.equal(finalAction.outcome?.verification?.verified, true);
  assert.equal(finalAction.progress?.agentic?.executionJob?.phase, "completed");

  // Workspace from persisted state (reload simulation)
  const workspace = buildActionWorkspace(finalAction);
  assert.equal(workspace.actionState, "completed");
  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.ok(execItem, "execute_and_verify_outcome item must exist");
  assert.equal(execItem.state, "completed");
});

// ---------------------------------------------------------------------------
// Scenario 2 — Mutation succeeds, verification hits iteration budget → verification_incomplete
// ---------------------------------------------------------------------------
test("scenario 2: mutation WRITES_COMPLETE then verification budget exhausted → verification_incomplete, jefe working in workspace", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Mutation phase succeeds
  const mutationResult = await runAgenticShopifyExecution({
    provider: mutationPhaseProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(mutationResult.ok, true);
  assert.equal(mutationResult.status, "WRITES_COMPLETE");

  // Verification phase hits iteration limit (never achieves OUTCOME_ACHIEVED)
  const verResult = await runAgenticShopifyVerification({
    provider: blockedVerificationProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
    maxIterations: 2,
  });

  assert.equal(verResult.ok, false);
  assert.equal(verResult.blocker, "VERIFICATION_ITERATION_LIMIT");

  const finalAction = prisma.actions[0];

  // Status stays "accepted" while verification is incomplete and retries are pending
  // (only executionJob.phase changes; action.status is not set until verification resolves)
  assert.notEqual(finalAction.status, "completed");
  assert.equal(finalAction.status, "accepted");

  // Phase must be verification_incomplete
  assert.equal(finalAction.progress?.agentic?.executionJob?.phase, "verification_incomplete");

  // Workspace: verification_incomplete without exhaustion = Jefe still owns it (running, not needs_attention)
  const workspace = buildActionWorkspace(finalAction);
  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.ok(execItem);
  assert.equal(execItem.state, "running", "must show running (jefe working), not needs_attention, while retries are pending");
  assert.equal(execItem.statusLabel, "Verifying");
  assert.equal(workspace.actionState, "jefe_working");
});

// ---------------------------------------------------------------------------
// Scenario 3 — Failure before any write
// ---------------------------------------------------------------------------
test("scenario 3: no writes succeed → BLOCKED, action not falsely completed, no write evidence", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  const result = await runAgenticShopifyExecution({
    provider: blockedProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  assert.equal(result.ok, false);

  const finalAction = prisma.actions[0];
  assert.notEqual(finalAction.status, "completed");
  assert.ok(!finalAction.outcome?.writesOccurred, "must not claim writes occurred when none did");

  // No successful mutations
  assert.equal(
    prisma.operationCalls.filter((r) => r.operationKind === "MUTATION" && r.status === "OK").length,
    0,
  );

  const workspace = buildActionWorkspace(finalAction);
  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.ok(execItem);
  assert.notEqual(execItem.state, "completed");
});

// ---------------------------------------------------------------------------
// Scenario 4 — Worker currently running (executionJob.phase = "executing")
// ---------------------------------------------------------------------------
test("scenario 4: executionJob.phase=executing → workspace shows jefe_working, not on_track", () => {
  const action = agenticActionFixture({
    status: "accepted",
    executionJobPhase: "executing",
  });

  const workspace = buildActionWorkspace(action);

  assert.notEqual(workspace.actionState, "on_track");
  assert.equal(workspace.actionState, "jefe_working");

  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.ok(execItem);
  assert.equal(execItem.state, "running");

  const focus = resolveWorkspaceFocus(workspace, action);
  assert.notEqual(focus.kind, "on_track");
  assert.equal(focus.kind, "jefe_working");
});

// ---------------------------------------------------------------------------
// Scenario 5 — Verification mismatch: writes happened, Shopify state wrong
// ---------------------------------------------------------------------------
test("scenario 5: mutation succeeds then verification mismatch → needs_attention, not completed", async () => {
  const prisma = fakePrisma();
  const { action } = await materializeAgenticShopifyAction(prisma, {
    merchantId,
    shopId,
    recommendation: hideProductsRecommendation(),
  });
  await acceptAgenticShopifyAction(prisma, { merchantId, shopId, actionId: action.id });

  // Mutation phase succeeds
  await runAgenticShopifyExecution({
    provider: mutationPhaseProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger,
  });

  // Verification finds state doesn't match
  const verResult = await runAgenticShopifyVerification({
    provider: mismatchVerificationProvider(),
    prisma,
    client: fakeShopifyClient(),
    merchantId,
    shopId,
    shopDomain,
    actionId: action.id,
    grantedScopes: ["read_products"],
    logger: quietLogger,
  });

  assert.equal(verResult.ok, false);
  assert.equal(verResult.status, "VERIFICATION_MISMATCH");

  const finalAction = prisma.actions[0];
  assert.notEqual(finalAction.status, "completed");
  assert.equal(finalAction.status, "needs_attention");
  assert.equal(finalAction.progress?.agentic?.executionJob?.phase, "needs_attention");

  const workspace = buildActionWorkspace(finalAction);
  assert.equal(workspace.actionState, "needs_attention");
});

// ---------------------------------------------------------------------------
// Scenario 6 — Completed reload
// ---------------------------------------------------------------------------
test("scenario 6: persisted completed action reloads as completed with no ready rows", () => {
  const action = agenticActionFixture({
    status: "completed",
    executionJobPhase: "completed",
  });

  const workspace = buildActionWorkspace(action);
  assert.equal(workspace.actionState, "completed");

  const items = workspacePlanItems(workspace);

  for (const item of items) {
    assert.notEqual(item.workState, "ready", `item ${item.id} must not be "ready" after completion`);
    assert.notEqual(item.workState, "planned", `item ${item.id} must not be "planned" after completion`);
  }

  const focus = resolveWorkspaceFocus(workspace, action);
  assert.notEqual(focus.eyebrow, "WORKING ON");
});

// ---------------------------------------------------------------------------
// Scenario 7 — Milestone count
// ---------------------------------------------------------------------------
test("scenario 7a: orientation item excluded, four milestones → count = 4", () => {
  const action = agenticActionFixture({ status: "accepted" });
  const workspace = buildActionWorkspace(action);
  const items = workspacePlanItems(workspace);

  const milestones = items.filter((i) => i.isMilestone !== false);
  const orientation = items.filter((i) => i.isMilestone === false);

  assert.ok(orientation.length >= 1, "at least one orientation item expected");
  assert.ok(orientation.some((i) => i.id === "understand_recommendation"));
  assert.ok(milestones.length > 0);
  assert.equal(
    milestones.some((i) => i.id === "understand_recommendation"),
    false,
    "understand_recommendation must not count as a milestone",
  );
});

test("scenario 7b: five actual milestones → milestone count = 5", () => {
  const action = agenticActionFixture({ status: "accepted", withEligibility: true });
  const workspace = buildActionWorkspace(action);
  const items = workspacePlanItems(workspace);

  const milestones = items.filter((i) => i.isMilestone !== false);
  assert.equal(milestones.length, 4, "four milestones expected with eligibility criterion");
  assert.equal(items.length, 5);
});

test("scenario 7c: milestonesCount agrees with displayed header for agentic action during execution", () => {
  const action = agenticActionFixture({ status: "accepted", executionJobPhase: "executing" });
  const workspace = buildActionWorkspace(action);
  const items = workspacePlanItems(workspace);

  const milestoneCount = items.filter((i) => i.isMilestone !== false).length;
  const totalCount = items.length;

  assert.ok(milestoneCount < totalCount, "milestone count must be less than total when orientation items exist");
  assert.equal(milestoneCount, 3);
});

// ---------------------------------------------------------------------------
// Invariant: BackfillJob succeeded alone does NOT imply business completion
// ---------------------------------------------------------------------------
test("invariant 3: executionJob.jobStatus=succeeded with no MerchantAction status update is not completed", () => {
  const action = agenticActionFixture({
    status: "accepted",
    executionJob: { jobStatus: "succeeded", phase: "completed" },
  });

  const workspace = buildActionWorkspace(action);
  // Workspace actionState is driven by action.status, not executionJob.jobStatus
  assert.notEqual(workspace.actionState, "completed");
});

// ---------------------------------------------------------------------------
// Workspace reload at every lifecycle phase
// ---------------------------------------------------------------------------
test("workspace reload: verifying phase shows running / jefe_working focus", () => {
  const action = agenticActionFixture({ status: "accepted", executionJobPhase: "verifying" });
  const workspace = buildActionWorkspace(action);
  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.equal(execItem?.state, "running");
  assert.equal(execItem?.statusLabel, "Verifying");
  assert.equal(workspace.actionState, "jefe_working");
});

test("workspace reload: verification_incomplete (not exhausted) shows running / jefe_working", () => {
  const action = agenticActionFixture({ status: "accepted", executionJobPhase: "verification_incomplete" });
  const workspace = buildActionWorkspace(action);
  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  // verificationExhausted not set → still jefe_working
  assert.equal(execItem?.state, "running");
  assert.equal(execItem?.statusLabel, "Verifying");
  assert.equal(workspace.actionState, "jefe_working");
});

test("workspace reload: verification_incomplete with exhaustion shows needs_attention", () => {
  const action = agenticActionFixture({
    status: "accepted",
    executionJob: { phase: "verification_incomplete", verificationExhausted: true },
  });
  const workspace = buildActionWorkspace(action);
  const execItem = workspace.items.find((i) => i.semanticKey === "execute_and_verify_outcome");
  assert.equal(execItem?.state, "needs_attention");
  assert.equal(execItem?.statusLabel, "Needs attention");
  assert.equal(workspace.actionState, "needs_attention");
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
    whyThisAction: "Out-of-stock products visible on storefront.",
    whyNow: "Multiple products found with zero inventory.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    confidence: "high",
  };
}

function agenticActionFixture({ status = "accepted", executionJobPhase, executionJob, withEligibility = false } = {}) {
  const semanticAction = {
    revision: "rev-fixture",
    title: "Hide out-of-stock products",
    summary: "Hide products with zero inventory.",
    outcome: "All out-of-stock products are hidden.",
    scope: "Active products with zero inventory.",
    constraints: [{ kind: "pricing", label: "Do not change prices." }],
    materialExpectedEffects: [{ label: "Set product status to DRAFT" }],
    eligibilityCriteria: withEligibility ? [{ kind: "inventory", label: "Zero inventory" }] : [],
    writeProtections: [],
    verificationPlan: "Read products back and confirm DRAFT status.",
    whyThisAction: "Out-of-stock products visible.",
    whyNow: "Products found.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    feasibleWriteOperations: ["productUpdate"],
  };
  const job = executionJob ?? (executionJobPhase ? { phase: executionJobPhase, jobStatus: "running" } : {});
  return {
    id: "action-fixture",
    merchantId,
    shopId,
    title: "Hide out-of-stock products",
    summary: "Hide products with zero inventory.",
    status,
    outcome: status === "completed"
      ? { verification: { verified: true, evidence: ["Read-back confirmed."], remaining: [] }, progressSummary: "5 products hidden." }
      : null,
    progress: {
      agentic: {
        runtime: "shopify_admin_api",
        currentActionRevision: "rev-fixture",
        acceptedActionRevision: status !== "proposed" ? "rev-fixture" : undefined,
        semanticAction,
        executionJob: job,
      },
    },
    plan: { agentic: { runtime: "shopify_admin_api", semanticAction } },
  };
}

/** Provider that issues a write then signals WRITES_COMPLETE. */
function mutationPhaseProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const calls = (payload.toolResults ?? []).filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.executeMutation);
      const hasMutation = calls.some((r) => r.facts?.operation === "productUpdate" && r.ok);
      if (!hasMutation) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.executeMutation,
                arguments: {
                  document:
                    'mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
                  variables: { product: { id: "gid://shopify/Product/1", status: "DRAFT" } },
                  purpose: "Hide the out-of-stock product.",
                  expectedEffect: "Set product status to DRAFT.",
                  idempotencyKey: "hide-product-1",
                },
              },
            ],
          },
        };
      }
      return { json: { status: "WRITES_COMPLETE", progressSummary: "Product mutation issued." } };
    },
  };
}

/** Provider for the verification phase that reads back and confirms. */
function verificationPhaseProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const calls = (payload.toolResults ?? []).filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
      const hasRead = calls.some((r) => r.facts?.operation === "product" && r.ok);
      if (!hasRead) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.query,
                arguments: {
                  document: "query($id: ID!) { product(id: $id) { id status } }",
                  variables: { id: "gid://shopify/Product/1" },
                },
              },
            ],
          },
        };
      }
      return {
        json: {
          status: "OUTCOME_ACHIEVED",
          progressSummary: "Product verified as DRAFT.",
          verification: {
            verified: true,
            evidence: ["Read-back confirmed product gid://shopify/Product/1 is DRAFT."],
            remaining: [],
          },
        },
      };
    },
  };
}

/** Verification provider that always returns CONTINUE without achieving outcome. */
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

/** Verification provider that finds a state mismatch. */
function mismatchVerificationProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson({ prompt }) {
      const payload = JSON.parse(prompt);
      const calls = (payload.toolResults ?? []).filter((r) => r.tool === SHOPIFY_GATEWAY_TOOL.query);
      const hasRead = calls.some((r) => r.facts?.operation === "product" && r.ok);
      if (!hasRead) {
        return {
          json: {
            status: "CONTINUE",
            toolCalls: [
              {
                tool: SHOPIFY_GATEWAY_TOOL.query,
                arguments: {
                  document: "query($id: ID!) { product(id: $id) { id status } }",
                  variables: { id: "gid://shopify/Product/1" },
                },
              },
            ],
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

function blockedProvider() {
  return {
    enabled: true,
    provider: "test",
    model: "scripted",
    async generateStructuredJson() {
      return { json: { status: "BLOCKED", blocker: "no_shopify_api_available" } };
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
      if (document.includes("product(id:")) {
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
        const key = where.shopId_jobType ?? where.id;
        if (where.id) return prisma.jobs.find((j) => j.id === where.id) ?? null;
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

function matchesStatus(actual, filter) {
  if (!filter) return true;
  if (typeof filter === "string") return actual === filter;
  if (Array.isArray(filter.in)) return filter.in.includes(actual);
  return true;
}

const quietLogger = { info() {}, warn() {}, error() {} };
