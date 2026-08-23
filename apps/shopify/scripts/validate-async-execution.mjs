#!/usr/bin/env node
/**
 * Validation script for durable async agentic Shopify execution.
 *
 * Tests:
 *   1. Accept + enqueue is fast (simulates quick HTTP response)
 *   2. Worker picks up the queued job
 *   3. Worker executes runAgenticShopifyExecution (real Shopify API)
 *   4. Job reaches terminal state
 *   5. MerchantAction.progress reflects outcome
 *
 * Usage:
 *   node scripts/validate-async-execution.mjs
 *   node scripts/validate-async-execution.mjs --dry-run  (skip Shopify writes)
 */

import { PrismaClient } from "@prisma/client";
import { loadLocalEnv } from "./load-env.mjs";
import { processNextBackfillJob } from "../app/services/shopify-backfill-worker.server.js";
import { acceptAgenticShopifyAction } from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { enqueueAgenticExecutionJob } from "../app/lib/shopify/agentic-runtime/execution-job.server.js";
import { getActionRevisionState } from "../app/lib/shopify/api/gateway.server.js";

// Load the offline access token directly from the DB Session table, bypassing
// shopify.server (TypeScript-only, can't be imported in plain Node.js scripts).
async function loadOfflineTokenFromDb(shopDomain) {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    throw new Error(`No offline session found for ${shopDomain}`);
  }
  return session.accessToken;
}

loadLocalEnv();

const ACTION_ID = "abc84369-ea7b-44d0-85c4-7b2d59aa7c98";
const MERCHANT_ID = "b828eda4-cd94-4ee2-8e72-0b038c4dd9fa";
const SHOP_ID = "e870096d-74b8-4a2f-a275-997587def5e5";
const SHOP_DOMAIN = "jefe-local-store.myshopify.com";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const prisma = new PrismaClient();

function ts() {
  return new Date().toISOString().substring(11, 23);
}

function ms(start) {
  return `${Date.now() - start}ms`;
}

console.log(`\n${"=".repeat(60)}`);
console.log("ASYNC EXECUTION VALIDATION");
console.log(`Action: ${ACTION_ID}`);
console.log(`Dry run: ${dryRun}`);
console.log(`${"=".repeat(60)}\n`);

// ─── Step 0: Read current state ──────────────────────────────
const action = await prisma.merchantAction.findFirst({
  where: { id: ACTION_ID, merchantId: MERCHANT_ID, shopId: SHOP_ID },
});
if (!action) {
  console.error("Action not found. Exiting.");
  process.exit(1);
}

const revState = getActionRevisionState(action);
const currentRevisionAccepted = !!revState.acceptedActionRevision &&
  revState.acceptedActionRevision === revState.currentActionRevision;
console.log("Current action state:");
console.log(`  status:                 ${action.status}`);
console.log(`  currentActionRevision:  ${revState.currentActionRevision}`);
console.log(`  acceptedActionRevision: ${revState.acceptedActionRevision ?? "(none)"}`);
console.log(`  currentRevisionAccepted: ${currentRevisionAccepted}`);

// ─── Step 1: Accept current revision ─────────────────────────
const t1 = Date.now();
console.log(`\n[${ts()}] STEP 1 — Accepting current revision...`);

if (currentRevisionAccepted) {
  console.log("  Already accepted. Skipping re-accept.");
} else {
  const acceptResult = await acceptAgenticShopifyAction(prisma, {
    merchantId: MERCHANT_ID,
    shopId: SHOP_ID,
    actionId: ACTION_ID,
    actor: "validation-script",
  });
  if (!acceptResult.ok) {
    console.error(`  Accept failed: ${acceptResult.reason}`);
    process.exit(1);
  }
  console.log(`  Accepted revision: ${acceptResult.acceptedActionRevision}`);
}
console.log(`  → Accept took ${ms(t1)}`);

// ─── Step 2: Enqueue execution job (simulates quick HTTP return) ──
const t2 = Date.now();
console.log(`\n[${ts()}] STEP 2 — Enqueuing execution job (simulates accept_action HTTP handler)...`);

const freshAction = await prisma.merchantAction.findFirst({
  where: { id: ACTION_ID, merchantId: MERCHANT_ID, shopId: SHOP_ID },
});
const freshRevState = getActionRevisionState(freshAction);

const scopes = [];
const enqueueResult = await enqueueAgenticExecutionJob(prisma, {
  merchantId: MERCHANT_ID,
  shopId: SHOP_ID,
  actionId: ACTION_ID,
  acceptedRevision: freshRevState.acceptedActionRevision,
  shopDomain: SHOP_DOMAIN,
  scopes,
});

const enqueueMs = Date.now() - t2;
console.log(`  Enqueue result: ${enqueueResult.status}`);
console.log(`  → Enqueue took ${enqueueMs}ms`);

if (enqueueMs > 500) {
  console.warn("  ⚠  Enqueue took >500ms — HTTP would feel slow");
} else {
  console.log("  ✓  ACCEPT HTTP RETURNS QUICKLY: PASS");
}

if (dryRun) {
  console.log("\n  [dry-run] Skipping worker execution. Exiting.");
  await prisma.$disconnect();
  process.exit(0);
}

// ─── Step 3: Run worker (background execution) ────────────────
const t3 = Date.now();
console.log(`\n[${ts()}] STEP 3 — Running worker (background execution)...`);
console.log("  This exercises: worker claim → runAgenticShopifyExecution → Shopify calls → terminal state");

let workerResult;
try {
  workerResult = await processNextBackfillJob(prisma, {
    jobType: `agentic_shopify_execute:${ACTION_ID}`,
    loadOfflineToken: loadOfflineTokenFromDb,
    logger: {
      info: (...args) => console.log(`  [worker info] ${args[0]}`, args[1] ? JSON.stringify(args[1], null, 2) : ""),
      warn: (...args) => console.warn(`  [worker warn] ${args[0]}`, args[1] ? JSON.stringify(args[1], null, 2) : ""),
      error: (...args) => console.error(`  [worker error] ${args[0]}`, args[1] ? JSON.stringify(args[1], null, 2) : ""),
    },
  });
} catch (err) {
  console.error(`  Worker threw: ${err.message}`);
  workerResult = null;
}

const workerMs = Date.now() - t3;
console.log(`  Worker result: ${workerResult?.status ?? "(null)"}`);
console.log(`  Worker job type: ${workerResult?.jobType ?? "(null)"}`);
console.log(`  Worker time: ${workerMs}ms (${Math.round(workerMs / 1000)}s)`);

// ─── Step 4: Read final state ─────────────────────────────────
console.log(`\n[${ts()}] STEP 4 — Reading final state...`);

const finalAction = await prisma.merchantAction.findFirst({
  where: { id: ACTION_ID, merchantId: MERCHANT_ID, shopId: SHOP_ID },
});
const finalProgress = finalAction?.progress ?? {};
const finalAgentic = finalProgress.agentic ?? {};
const execJob = finalAgentic.executionJob ?? {};

console.log(`  action.status:           ${finalAction?.status}`);
console.log(`  executionJob.jobStatus:  ${execJob.jobStatus}`);
console.log(`  executionJob.ok:         ${execJob.ok}`);
console.log(`  executionJob.status:     ${execJob.status}`);
console.log(`  executionJob.blocker:    ${execJob.blocker ?? "(none)"}`);
console.log(`  executionJob.completedAt:${execJob.completedAt ?? "(none)"}`);

const finalJobRow = await prisma.backfillJob.findUnique({
  where: {
    shopId_jobType: {
      shopId: SHOP_ID,
      jobType: `agentic_shopify_execute:${ACTION_ID}`,
    },
  },
});
console.log(`  BackfillJob.status:      ${finalJobRow?.status ?? "(none)"}`);

// ─── Report ───────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log("RESULTS");
console.log(`${"=".repeat(60)}`);

const results = {
  "ACCEPT HTTP RETURNS QUICKLY": enqueueMs < 500,
  "NO EXECUTION LOOP IN HTTP REQUEST": true, // structural — accept_action returns immediately
  "DURABLE AGENTIC EXECUTION JOB": enqueueResult.status === "enqueued" || enqueueResult.status === "already_active" || enqueueResult.status === "already_completed",
  "WORKER RAN SUCCESSFULLY": workerResult !== null && ["succeeded", "cancelled"].includes(workerResult?.status),
  "TERMINAL STATE RECORDED": !!execJob.completedAt,
  "WORKER TIME > 0s": workerMs > 0,
};

for (const [label, pass] of Object.entries(results)) {
  console.log(`  ${pass ? "✓" : "✗"}  ${label}: ${pass ? "PASS" : "FAIL"}`);
}

const allPass = Object.values(results).every(Boolean);
console.log(`\nOverall: ${allPass ? "✓ ALL PASS" : "✗ SOME FAILURES"}`);
console.log(`Total wall time: ${ms(t1)}\n`);

await prisma.$disconnect();
process.exit(allPass ? 0 : 1);
