#!/usr/bin/env node
/**
 * 10-run live Luna evaluation: Full Merchant Memory Exposure.
 *
 * Measures whether removing the 40-belief recency cap and honouring llmExposure
 * materially improves recommendation breadth for the dev merchant.
 *
 * Usage:
 *   node scripts/eval-full-memory-exposure.mjs [--runs N] [--shop jefe-local-store.myshopify.com]
 *
 * Requires:
 *   DATABASE_URL, OPENAI_API_KEY or GEMINI_API_KEY (in .env or environment)
 *   A local offline Shopify session for the target shop in the DB.
 *
 * Does NOT require JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED — recommendation
 * investigation is read-only from Shopify's perspective.
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
import { DETERMINISTIC_BELIEF_REGISTRY } from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";

loadLocalEnv(process.cwd());

const args = process.argv.slice(2);

function argValue(flag) {
  const eqForm = args.find((a) => a.startsWith(`${flag}=`));
  if (eqForm) return eqForm.split("=").slice(1).join("=");
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return undefined;
}

const RUNS = Number(argValue("--runs") ?? 10);
const RAW_SHOP = argValue("--shop")
  ?? process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP
  ?? "jefe-local-store.myshopify.com";
const SHOP_DOMAIN = normalizeShopDomain(RAW_SHOP);

const reportDir = resolve(process.cwd(), "../../.context/eval-full-memory-exposure");
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
  const [allBeliefs, goals, insights, actions, watermark] = await Promise.all([
    prisma.merchantMemoryBelief.findMany({
      where: { merchantId, shopId, status: { in: ACTIVE_BELIEF_STATUSES }, supersededAt: null },
      select: { id: true, key: true, category: true, status: true, precedence: true, value: true, updatedAt: true },
    }),
    prisma.merchantGoalRun.findFirst({
      where: { merchantId, shopId, status: "completed", supersededAt: null },
      include: { horizons: { orderBy: { orderIndex: "asc" } } },
      orderBy: { completedAt: "desc" },
    }),
    prisma.merchantInsightRun.findFirst({
      where: { merchantId, shopId, status: "completed", sourceMode: "full", supersededAt: null },
      include: { findings: { orderBy: { orderIndex: "asc" } } },
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

  // Build exposure map from registry
  const registryMap = new Map(DETERMINISTIC_BELIEF_REGISTRY.map((e) => [e.key, e.llmExposure]));

  const core = allBeliefs.filter((b) => {
    const e = registryMap.get(b.key);
    return !e || e === "Core or category retrieval";
  });
  const onDemand = allBeliefs.filter((b) => registryMap.get(b.key) === "On-demand; promote only when decision-relevant");
  const guardrail = allBeliefs.filter((b) => registryMap.get(b.key) === "Internal guardrail; use to set confidence");
  const visible = [...core, ...onDemand];

  // Check for specific canary beliefs
  const canaries = [
    "business.revenue_trend.trailing_180d",
    "customers.repeat_customer_rate.all_time",
    "customers.repeat_revenue_share.all_time",
    "orders.multi_item_order_share.trailing_90d",
    "business.zero_sales_day_share.trailing_90d",
    "products.product_momentum.trailing_60d",
    "products.top_returned_products.trailing_180d",
    "inventory.retail_value_of_available_stock",
    "catalog.out_of_stock_product_count",
    "business.revenue_by_region.trailing_90d",
  ];
  const canaryState = Object.fromEntries(
    canaries.map((key) => {
      const b = allBeliefs.find((belief) => belief.key === key);
      return [key, b ? { found: true, value: b.value, exposure: resolveExposure(key) } : { found: false }];
    }),
  );

  return {
    totalActive: allBeliefs.length,
    visible: visible.length,
    core: core.length,
    onDemand: onDemand.length,
    guardrail: guardrail.length,
    goalCount: goals?.horizons?.length ?? 0,
    hasGoals: (goals?.horizons?.length ?? 0) === 3,
    insightCount: insights?.findings?.length ?? 0,
    activeActions: (actions ?? []).map((a) => ({ id: a.id, title: a.title, status: a.status })),
    shopifyMirrorWatermark: watermark?.updatedAt?.toISOString() ?? null,
    canaries: canaryState,
  };
}

function extractHypothesisText(h) {
  if (!h) return null;
  if (typeof h === "string") return h;
  // hypothesis objects have { hypothesis, status, reason, relevantOperations, ... }
  return h.hypothesis ?? h.text ?? h.description ?? JSON.stringify(h);
}

function summarizeTrace(trace) {
  if (!trace?.turns?.length) return { turns: 0, hypotheses: [], rawHypotheses: [], coverageEvolution: [] };
  const hypotheses = [];
  const rawHypotheses = [];
  const coverageEvolution = [];
  for (const turn of trace.turns) {
    const considered = turn.hypothesesConsidered ?? [];
    for (const h of considered) {
      rawHypotheses.push(h);
      const text = extractHypothesisText(h);
      if (text && !hypotheses.includes(text)) hypotheses.push(text);
    }
    if (turn.coverageLedger || turn.coverageUpdate) {
      coverageEvolution.push({
        turn: turn.status,
        update: turn.coverageUpdate ?? null,
        ledger: turn.coverageLedger ?? null,
      });
    }
  }
  return {
    turns: trace.turns.length,
    hypotheses,
    rawHypotheses,
    coverageEvolution,
    toolCalls: trace.turns.reduce((n, t) => n + (t.toolCallCount ?? 0), 0),
  };
}

function summarizeDiagnostics(diagnostics) {
  if (!diagnostics) return {};
  return {
    shopifyReads: (diagnostics.shopifyReads ?? []).length,
    successfulReads: (diagnostics.shopifyReads ?? []).filter((r) => r.ok).length,
    retrievedOperations: (diagnostics.retrievedOperations ?? []).length,
    rejectedInterventions: (diagnostics.rejectedInterventions ?? []).length,
    coverageLedger: diagnostics.coverageLedger ?? null,
    opportunityCoverage: diagnostics.opportunityCoverage ?? null,
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
  console.log(`  Full Memory Exposure Evaluation — ${RUNS} runs`);
  console.log(`  Shop: ${SHOP_DOMAIN}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error("OPENAI_API_KEY or GEMINI_API_KEY is required");
  }

  // Find merchant
  const shop = await prisma.shop.findFirst({
    where: { shopDomain: SHOP_DOMAIN },
    select: { id: true, merchantId: true, shopDomain: true },
  });
  if (!shop) throw new Error(`No Shop row found for ${SHOP_DOMAIN} — is the app installed locally?`);

  console.log(`Merchant: ${shop.merchantId}  Shop: ${shop.id}`);

  // Load access token
  const accessToken = await loadOfflineToken(SHOP_DOMAIN);
  console.log(`Offline token loaded.\n`);

  // Capture pre-run state
  console.log("Capturing pre-run Merchant Memory state...");
  const preState = await captureMerchantState(shop.merchantId, shop.id);
  console.log(`  Total active beliefs: ${preState.totalActive}`);
  console.log(`  Model-visible (core + on_demand): ${preState.visible}`);
  console.log(`  Core: ${preState.core}  On-demand: ${preState.onDemand}  Guardrail: ${preState.guardrail}`);
  console.log(`  Goals: ${preState.goalCount}  Insights: ${preState.insightCount}`);
  console.log(`  Active Actions: ${preState.activeActions.length}`);
  console.log(`  Shopify watermark: ${preState.shopifyMirrorWatermark ?? "(none)"}`);
  console.log(`  Has 3 goals: ${preState.hasGoals}`);

  if (!preState.hasGoals) {
    console.error("\n⚠️  Merchant has no completed goal run with 3 horizons — recommendation will return missing_completed_goals.");
    console.error("   Run merchant onboarding first to populate goals.");
  }

  console.log("\nCanary signal availability:");
  for (const [key, state] of Object.entries(preState.canaries)) {
    const mark = state.found ? "✓" : "✗";
    const extra = state.found ? ` = ${JSON.stringify(state.value)} [${state.exposure}]` : " (not populated)";
    console.log(`  ${mark} ${key}${extra}`);
  }

  const runs = [];
  const startedAt = new Date().toISOString();

  // Delay between runs to stay within API rate limits.
  // Each recommendation run makes 4-8 LLM calls; 120s gives rate limits time to recover.
  const INTER_RUN_DELAY_MS = Number(argValue("--delay") ?? 120000);

  // Run 10 independent investigations
  for (let i = 0; i < RUNS; i++) {
    if (i > 0) {
      console.log(`  (waiting ${INTER_RUN_DELAY_MS / 1000}s before next run...)`);
      await new Promise((resolve) => setTimeout(resolve, INTER_RUN_DELAY_MS));
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
        forceFreshRun: true, // salt the hash so each run is independent
        logger: quietLogger(),
      });

      const outcome = classifyOutcome(result);
      const traceSummary = summarizeTrace(result.trace);
      const diagSummary = summarizeDiagnostics(result.diagnostics);
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
        turns: traceSummary.turns,
        toolCalls: traceSummary.toolCalls,
        initialHypotheses: traceSummary.hypotheses.slice(0, 5),
        allHypotheses: traceSummary.hypotheses,
        shopifyReads: diagSummary.successfulReads,
        retrievedOperations: diagSummary.retrievedOperations,
        rejectedInterventions: diagSummary.rejectedInterventions,
        coverageLedger: diagSummary.coverageLedger,
        recommendation: rec ? {
          title: rec.title,
          summary: rec.summary,
          // persisted recommendation has diagnosedProblem/mechanism inside successSignal
          diagnosedProblem: rec.successSignal?.diagnosedProblem ?? rec.diagnosedProblem ?? null,
          mechanism: rec.successSignal?.mechanism ?? rec.mechanism ?? null,
          confidence: rec.confidence,
          supportingBeliefIds: rec.supportingBeliefIds ?? [],
          feasibleWriteOperations: rec.successSignal?.feasibleWriteOperations ?? rec.feasibleWriteOperations ?? [],
          outcome: rec.startToday ?? rec.outcome,
          whyThisAction: rec.whyThisAction,
          whyNow: rec.whyNow,
        } : null,
        usage: result.diagnostics?.usage ?? null,
      };

      runs.push(runRecord);

      console.log(`  Outcome: ${outcome}`);
      console.log(`  Turns: ${traceSummary.turns}  Shopify reads: ${diagSummary.successfulReads}  Op retrievals: ${diagSummary.retrievedOperations}`);
      if (traceSummary.hypotheses.length > 0) {
        console.log(`  Hypotheses (${traceSummary.hypotheses.length}):`);
        for (const h of traceSummary.hypotheses.slice(0, 6)) {
          console.log(`    - ${String(h).slice(0, 120)}`);
        }
      }
      if (rec) {
        console.log(`  → Recommendation: "${rec.title}"`);
        console.log(`    Problem: ${rec.diagnosedProblem?.slice(0, 100)}`);
      }
      if (result.blocker) {
        console.log(`  Blocker: ${result.blocker}`);
      }
    } catch (error) {
      const runRecord = {
        run: i + 1,
        outcome: "FAILED",
        durationMs: Date.now() - runStart,
        error: error instanceof Error ? error.message : String(error),
      };
      runs.push(runRecord);
      console.error(`  ERROR: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Aggregate diversity
  const allHypotheses = runs.flatMap((r) => r.allHypotheses ?? []);
  const uniqueHypotheses = [...new Set(allHypotheses)];
  const recommendations = runs.filter((r) => r.outcome === "RECOMMENDATION");
  const noOpportunity = runs.filter((r) => r.outcome === "NO_ACTIONABLE_OPPORTUNITY");
  const incomplete = runs.filter((r) => r.outcome === "INVESTIGATION_INCOMPLETE");
  const failed = runs.filter((r) => r.outcome === "FAILED");

  const report = {
    evalId: `full-memory-${startedAt}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      shop: SHOP_DOMAIN,
      runs: RUNS,
      implementation: "full-memory-exposure",
      commit: process.env.APP_VERSION ?? "unknown",
    },
    preRunState: preState,
    runs,
    summary: {
      recommendations: recommendations.length,
      noActionableOpportunity: noOpportunity.length,
      investigationIncomplete: incomplete.length,
      failed: failed.length,
      uniqueHypothesesAcrossRuns: uniqueHypotheses.length,
      uniqueHypotheses,
      avgTurns: runs.reduce((s, r) => s + (r.turns ?? 0), 0) / runs.length,
      avgShopifyReads: runs.reduce((s, r) => s + (r.shopifyReads ?? 0), 0) / runs.length,
      avgHypothesesPerRun: runs.reduce((s, r) => s + (r.allHypotheses?.length ?? 0), 0) / runs.length,
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
  console.log(`  Failed:                   ${failed.length}/${RUNS}`);
  console.log(`  Unique hypotheses across all runs: ${uniqueHypotheses.length}`);
  console.log(`  Avg turns/run:    ${report.summary.avgTurns.toFixed(1)}`);
  console.log(`  Avg Shopify reads: ${report.summary.avgShopifyReads.toFixed(1)}`);
  console.log(`  Avg hypotheses/run: ${report.summary.avgHypothesesPerRun.toFixed(1)}`);
  console.log(`\n  Report saved to:`);
  console.log(`    ${reportPath}`);
  console.log(`    ${latestPath}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  prisma.$disconnect().finally(() => process.exit(1));
});
