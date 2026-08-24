#!/usr/bin/env node
/**
 * Live reliability evaluation: recommendation-first candidate-driven investigation runtime.
 *
 * Measures whether the candidate-pipeline runtime (DISCOVER_CANDIDATES -> server-owned
 * candidateQueue -> per-candidate bounded investigation -> automatic pivot -> rescue pass)
 * reliably reaches a strong, grounded, executable first recommendation against the dev store,
 * instead of INVESTIGATION_FAILED from spending the whole budget on retrieve_shopify_operations
 * with zero Shopify reads.
 *
 * Usage:
 *   node scripts/eval-candidate-pipeline.mjs [--runs N] [--shop domain] [--delay ms]
 *     [--max-candidates N] [--per-candidate-iterations N]
 *
 * Requires:
 *   DATABASE_URL, OPENAI_API_KEY or GEMINI_API_KEY (in .env or environment)
 *   A local offline Shopify session for the target shop in the DB.
 */

/* global process */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import { runAgenticRecommendationInvestigation } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";
import { resolveExposure } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";
import { ACTIVE_BELIEF_STATUSES } from "../app/lib/merchant-memory/constants.server.js";
import { loadLocalEnv } from "./load-env.mjs";
import { normalizeShopDomain } from "../app/lib/shopify/admin-graphql.server.js";

loadLocalEnv(process.cwd());

const args = process.argv.slice(2);

function argValue(flag) {
  const eqForm = args.find((a) => a.startsWith(`${flag}=`));
  if (eqForm) return eqForm.split("=").slice(1).join("=");
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return undefined;
}

const RUNS = Number(argValue("--runs") ?? 5);
const RAW_SHOP = argValue("--shop")
  ?? process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP
  ?? "jefe-local-store.myshopify.com";
const SHOP_DOMAIN = normalizeShopDomain(RAW_SHOP);
const INTER_RUN_DELAY_MS = Number(argValue("--delay") ?? 180000);
const MAX_CANDIDATES_FIRST_PASS = Number(argValue("--max-candidates") ?? 5);
const PER_CANDIDATE_ITERATIONS = Number(argValue("--per-candidate-iterations") ?? 3);

const reportDir = resolve(process.cwd(), "../../.context/eval-candidate-pipeline");
const reportPath = resolve(reportDir, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const latestPath = resolve(reportDir, "latest.json");
mkdirSync(reportDir, { recursive: true });

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function quietLogger() {
  return { info: () => {}, debug: () => {}, warn: () => {}, error: console.error };
}

async function loadOfflineToken(shopDomain) {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
    select: { accessToken: true },
  });
  if (!session?.accessToken) throw new Error(`No offline session found for ${shopDomain}`);
  return session.accessToken;
}

async function captureMerchantState(merchantId, shopId) {
  const [allBeliefs, goals, actions, watermark] = await Promise.all([
    prisma.merchantMemoryBelief.findMany({
      where: { merchantId, shopId, status: { in: ACTIVE_BELIEF_STATUSES }, supersededAt: null },
      select: { id: true, key: true },
    }),
    prisma.merchantGoalRun.findFirst({
      where: { merchantId, shopId, status: "completed", supersededAt: null },
      include: { horizons: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.merchantAction?.findMany({
      where: { merchantId, shopId, status: { in: ["proposed", "accepted"] } },
      select: { id: true, title: true, status: true },
    }).catch(() => []),
    prisma.shopBackfillStatus?.findFirst({
      where: { shopId, domain: "merchant_memory" },
      select: { updatedAt: true },
    }).catch(() => null),
  ]);
  const visible = allBeliefs.filter((b) => resolveExposure(b.key) !== "guardrail");
  return {
    totalActive: allBeliefs.length,
    visible: visible.length,
    hasGoals: (goals?.horizons?.length ?? 0) === 3,
    activeActions: (actions ?? []).map((a) => ({ id: a.id, title: a.title, status: a.status })),
    shopifyMirrorWatermark: watermark?.updatedAt?.toISOString() ?? null,
  };
}

function classifyOutcome(result) {
  if (!result) return "UNKNOWN";
  if (result.status === "completed") return "RECOMMENDATION";
  if (result.status === "no_actionable_opportunity") return "NO_ACTIONABLE_OPPORTUNITY";
  if (result.status === "investigation_incomplete") return "INVESTIGATION_INCOMPLETE";
  if (result.status === "failed") return "FAILED";
  if (result.status === "missing_completed_goals") return "MISSING_GOALS";
  return `OTHER:${result.status}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Candidate-Driven Recommendation Pipeline — Live Reliability Eval`);
  console.log(`  Shop: ${SHOP_DOMAIN}  Runs: ${RUNS}  Delay: ${INTER_RUN_DELAY_MS}ms`);
  console.log(`  maxCandidatesFirstPass=${MAX_CANDIDATES_FIRST_PASS} perCandidateIterations=${PER_CANDIDATE_ITERATIONS}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error("OPENAI_API_KEY or GEMINI_API_KEY is required");
  }

  const shop = await prisma.shop.findFirst({
    where: { shopDomain: SHOP_DOMAIN },
    select: { id: true, merchantId: true, shopDomain: true },
  });
  if (!shop) throw new Error(`No Shop row found for ${SHOP_DOMAIN} — is the app installed locally?`);
  console.log(`Merchant: ${shop.merchantId}  Shop: ${shop.id}`);

  const accessToken = await loadOfflineToken(SHOP_DOMAIN);
  console.log(`Offline token loaded.\n`);

  const preState = await captureMerchantState(shop.merchantId, shop.id);
  console.log(`Model-visible beliefs: ${preState.visible}/${preState.totalActive}  Has 3 goals: ${preState.hasGoals}`);
  console.log(`Active Actions: ${preState.activeActions.length}  Watermark: ${preState.shopifyMirrorWatermark ?? "(none)"}\n`);
  if (!preState.hasGoals) {
    console.error("⚠️  Merchant has no completed goal run with 3 horizons — recommendation will return missing_completed_goals.\n");
  }

  const runs = [];
  const startedAt = new Date().toISOString();

  for (let i = 0; i < RUNS; i++) {
    if (i > 0) {
      console.log(`  (waiting ${INTER_RUN_DELAY_MS / 1000}s before next run...)`);
      await new Promise((r) => setTimeout(r, INTER_RUN_DELAY_MS));
    }
    console.log(`\n─── Run ${i + 1}/${RUNS} ────────────────────────────────────────`);
    const runStart = Date.now();
    try {
      const provider = createLlmProvider({ logger: quietLogger() });
      const result = await runAgenticRecommendationInvestigation(prisma, {
        merchantId: shop.merchantId,
        shopId: shop.id,
        shopDomain: SHOP_DOMAIN,
        accessToken,
        llmProvider: provider,
        forceFreshRun: true,
        logger: quietLogger(),
        maxCandidatesFirstPass: MAX_CANDIDATES_FIRST_PASS,
        perCandidateIterations: PER_CANDIDATE_ITERATIONS,
      });

      const outcome = classifyOutcome(result);
      const diagnostics = result.diagnostics ?? {};
      const candidateQueue = diagnostics.candidateQueue ?? [];
      const discoveryLog = diagnostics.discoveryLog ?? [];
      const progressLog = result.trace?.progressLog ?? [];
      const rec = result.recommendation ?? null;

      const runRecord = {
        run: i + 1,
        outcome,
        durationMs: Date.now() - runStart,
        runId: result.runId ?? null,
        status: result.status ?? null,
        blocker: result.blocker ?? null,
        provider: provider.provider,
        model: provider.model,
        candidateQueue: candidateQueue.map((c) => ({
          candidateId: c.candidateId,
          diagnosedProblem: c.diagnosedProblem,
          priority: c.priority,
          status: c.status,
          reason: c.reason,
        })),
        discoveryLog: discoveryLog.map((d) => ({ rescue: d.rescue, candidateCount: d.candidateCount })),
        progressStates: progressLog.map((p) => p.state),
        llmCallCount: diagnostics.llmCallCount ?? null,
        recommendation: rec ? {
          title: rec.title,
          summary: rec.summary,
          diagnosedProblem: rec.successSignal?.diagnosedProblem ?? rec.diagnosedProblem ?? null,
          mechanism: rec.successSignal?.mechanism ?? rec.mechanism ?? null,
          confidence: rec.confidence,
          supportingBeliefIds: rec.supportingBeliefIds ?? [],
          feasibleWriteOperations: rec.successSignal?.feasibleWriteOperations ?? rec.feasibleWriteOperations ?? [],
          outcome: rec.startToday ?? rec.outcome,
          whyThisAction: rec.whyThisAction,
          whyNow: rec.whyNow,
        } : null,
      };

      runs.push(runRecord);

      console.log(`  Outcome: ${outcome}   (${((Date.now() - runStart) / 1000).toFixed(0)}s)`);
      console.log(`  Candidates investigated: ${candidateQueue.length}   LLM calls: ${diagnostics.llmCallCount ?? "n/a"}`);
      for (const c of candidateQueue) {
        console.log(`    [${c.status}] ${c.diagnosedProblem?.slice(0, 90)}${c.reason ? ` — ${String(c.reason).slice(0, 90)}` : ""}`);
      }
      if (rec) {
        console.log(`  → Recommendation: "${rec.title}"`);
        console.log(`    Problem: ${rec.diagnosedProblem?.slice(0, 110)}`);
      }
      if (result.blocker) console.log(`  Blocker: ${result.blocker}`);
    } catch (error) {
      runs.push({
        run: i + 1,
        outcome: "FAILED",
        durationMs: Date.now() - runStart,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`  ERROR: ${error instanceof Error ? error.message : error}`);
    }
  }

  const recommendations = runs.filter((r) => r.outcome === "RECOMMENDATION");
  const noOpportunity = runs.filter((r) => r.outcome === "NO_ACTIONABLE_OPPORTUNITY");
  const incomplete = runs.filter((r) => r.outcome === "INVESTIGATION_INCOMPLETE");
  const failed = runs.filter((r) => r.outcome === "FAILED" || r.outcome?.startsWith("OTHER"));

  const report = {
    evalId: `candidate-pipeline-${startedAt}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      shop: SHOP_DOMAIN,
      runs: RUNS,
      maxCandidatesFirstPass: MAX_CANDIDATES_FIRST_PASS,
      perCandidateIterations: PER_CANDIDATE_ITERATIONS,
      implementation: "candidate-driven-recommendation-pipeline",
    },
    preRunState: preState,
    runs,
    summary: {
      recommendations: recommendations.length,
      noActionableOpportunity: noOpportunity.length,
      investigationIncomplete: incomplete.length,
      failed: failed.length,
      protocolCompletionRate: (RUNS - failed.length) / RUNS,
      recommendationRate: recommendations.length / RUNS,
    },
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(latestPath, JSON.stringify(report, null, 2));

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Recommendations:          ${recommendations.length}/${RUNS}`);
  console.log(`  No actionable opportunity: ${noOpportunity.length}/${RUNS}`);
  console.log(`  Investigation incomplete:  ${incomplete.length}/${RUNS}`);
  console.log(`  Failed:                    ${failed.length}/${RUNS}`);
  console.log(`\n  Report saved to:\n    ${reportPath}\n    ${latestPath}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  prisma.$disconnect().finally(() => process.exit(1));
});
