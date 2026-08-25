#!/usr/bin/env node
/**
 * Catalogue vs Agentic Shopify Gateway A/B (docs/ops/agentic-shopify-gateway-recommendation-ab/).
 * Runs the exact same real merchant-facing Generate Proposal path
 * (runAgenticRecommendationInvestigation -> runCandidateDrivenRecommendation) twice, back to back,
 * against the same real Shopify session for jefe-local-store.myshopify.com — once with
 * SHOPIFY_AGENT_SURFACE=catalog, once with SHOPIFY_AGENT_SURFACE=gateway — and saves both full
 * traces plus a compact comparison summary.
 *
 * This is NOT a separate simplified evaluation harness: it calls the identical production
 * functions eval-real-dev-shopify-recommendation.mjs calls, with the identical merchant,
 * Merchant Memory snapshot, and recommendation gates. The only variable is SHOPIFY_AGENT_SURFACE.
 *
 * Requires: DATABASE_URL, a real offline Shopify Session for the target shop, LLM_ENABLED=true
 * with a real provider key. Two real recommendation runs' worth of LLM cost. Do not run under
 * `node --test`.
 *
 * If no usable session exists, this script fails fast with a clear error and writes nothing —
 * per docs/ops/agentic-shopify-gateway-recommendation-ab/, a missing live merchant session is a
 * blocker to report, never a reason to substitute a mocked "real-store" result.
 */

/* global process */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import {
  ensureAgenticRecommendationQueued,
  runAgenticRecommendationInvestigation,
} from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());

const SHOP_DOMAIN = "jefe-local-store.myshopify.com";
const prisma = new PrismaClient();

try {
  const shop = await prisma.shop.findFirst({
    where: { shopDomain: SHOP_DOMAIN },
    select: { id: true, merchantId: true, shopDomain: true, setupStatus: true, status: true },
  });
  if (!shop) {
    throw new Error(
      `BLOCKER: no local Shop row for ${SHOP_DOMAIN}. This dev environment's Shopify install state is currently empty ` +
        `(observed: local Postgres had zero Shop/Session rows). See docs/ops/agentic-shopify-gateway-recommendation-ab/05-real-merchant-authentication.md.`,
    );
  }

  const session = await prisma.session.findFirst({
    where: { shop: SHOP_DOMAIN, isOnline: false, accessToken: { not: "" } },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken || (session.expires && session.expires.getTime() <= Date.now())) {
    throw new Error(`BLOCKER: no usable, non-expired offline Shopify session for ${SHOP_DOMAIN}.`);
  }
  const scopes = String(session.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const logger = console;
  const dir = resolve(process.cwd(), "../../docs/ops/agentic-shopify-gateway-recommendation-ab");
  mkdirSync(dir, { recursive: true });

  const runs = [];
  for (const surface of ["catalog", "gateway"]) {
    process.env.SHOPIFY_AGENT_SURFACE = surface;
    const provider = createLlmProvider({
      logger,
      usage: { prisma, merchantId: shop.merchantId, shopId: shop.id, feature: "agentic_recommendation_ab_eval", runType: "MerchantPlanRun" },
    });
    if (!provider.enabled) throw new Error(`LLM provider not enabled (LLM_ENABLED/LLM_PROVIDER misconfigured).`);

    logger.info(`[ab-eval] surface=${surface} shop=${SHOP_DOMAIN} provider=${provider.provider} model=${provider.model}`);

    const queued = await ensureAgenticRecommendationQueued(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      sourceMode: "eval",
      resetAttempts: true,
    });
    if (queued.status !== "queued" && queued.status !== "reused") {
      throw new Error(`ensureAgenticRecommendationQueued did not produce a runnable run (surface=${surface}): ${JSON.stringify(queued)}`);
    }

    const startedAt = new Date().toISOString();
    const result = await runAgenticRecommendationInvestigation(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      shopDomain: SHOP_DOMAIN,
      accessToken: session.accessToken,
      scopes,
      runId: queued.run.id,
      sourceMode: "eval",
      llmProvider: provider,
      logger,
    });
    const completedAt = new Date().toISOString();

    const run = {
      surface,
      startedAt,
      completedAt,
      wallClockMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      provider: provider.provider,
      model: provider.model,
      status: result.status,
      result,
    };
    runs.push(run);
    writeFileSync(resolve(dir, `trace-${surface}.json`), `${JSON.stringify(run, null, 2)}\n`);
    logger.info(`[ab-eval] surface=${surface} status=${result.status} wallClockMs=${run.wallClockMs}`);
  }

  const summary = { shopDomain: SHOP_DOMAIN, generatedAt: new Date().toISOString(), runs: runs.map(summarizeRun) };
  writeFileSync(resolve(dir, "ab-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}

/** @param {any} run */
function summarizeRun(run) {
  const toolResults = run.result?.trace?.toolResults ?? run.result?.candidateQueue?.flatMap?.((c) => c.toolResults ?? []) ?? [];
  const schemaLookups = toolResults.filter((r) => r.tool === "shopify_schema" || r.tool === "retrieve_shopify_operations");
  const reads = toolResults.filter((r) => r.tool === "shopify_query" || r.tool === "call_shopify_operation");
  const failedReads = reads.filter((r) => !r.ok);
  return {
    surface: run.surface,
    status: run.status,
    wallClockMs: run.wallClockMs,
    provider: run.provider,
    model: run.model,
    schemaLookups: schemaLookups.length,
    reads: reads.length,
    successfulReads: reads.length - failedReads.length,
    failedReads: failedReads.length,
    candidatesDiscovered: run.result?.candidateQueue?.length ?? null,
  };
}
