#!/usr/bin/env node
/**
 * Real dev-store recommendation evaluation (task §23 of the universal-execution-runtime
 * workstream, founder-authorized 2026-08-25). Runs the real candidate-driven recommendation
 * pipeline — real Shopify reads against jefe-local-store.myshopify.com, real OpenAI calls —
 * and saves the complete candidate/disposition trace.
 *
 * This performs recommendation generation/investigation ONLY. runAgenticRecommendationInvestigation
 * never issues a Shopify mutation: the tool context it runs under sets recommendationMode: true,
 * and runShopifyAgentTool (tools.server.js) hard-denies any non-read-looking operation in that
 * mode server-side (RECOMMENDATION_WRITE_DENIED) — independent of what the model asks for.
 *
 * Requires: DATABASE_URL, a real offline Shopify Session for the target shop, LLM_ENABLED=true
 * with a real provider key. Real API cost — do not run under `node --test`.
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
const startedAt = new Date().toISOString();
const prisma = new PrismaClient();

try {
  const shop = await prisma.shop.findFirst({
    where: { shopDomain: SHOP_DOMAIN },
    select: { id: true, merchantId: true, shopDomain: true, setupStatus: true, status: true },
  });
  if (!shop) throw new Error(`No local Shop row for ${SHOP_DOMAIN}.`);

  const session = await prisma.session.findFirst({
    where: { shop: SHOP_DOMAIN, isOnline: false, accessToken: { not: "" } },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken || (session.expires && session.expires.getTime() <= Date.now())) {
    throw new Error(`No usable, non-expired offline Shopify session for ${SHOP_DOMAIN}.`);
  }
  const scopes = String(session.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const logger = console;
  const provider = createLlmProvider({
    logger,
    usage: { prisma, merchantId: shop.merchantId, shopId: shop.id, feature: "agentic_recommendation_eval", runType: "MerchantPlanRun" },
  });
  if (!provider.enabled) throw new Error(`LLM provider not enabled (LLM_ENABLED/LLM_PROVIDER misconfigured).`);

  logger.info(`[eval] shop=${SHOP_DOMAIN} setupStatus=${shop.setupStatus} scopes=${scopes.length} provider=${provider.provider} model=${provider.model}`);

  // Force a fresh, isolated MerchantPlanRun (never reuses/overwrites an existing row for this
  // merchant's current snapshot hash) via the same enqueue path a real Home retry uses — this
  // also exercises the sourceMode/retry-lineage fix from this same workstream end-to-end.
  const queued = await ensureAgenticRecommendationQueued(prisma, {
    merchantId: shop.merchantId,
    shopId: shop.id,
    sourceMode: "eval",
    resetAttempts: true,
  });
  if (queued.status !== "queued" && queued.status !== "reused") {
    throw new Error(`ensureAgenticRecommendationQueued did not produce a runnable run: ${JSON.stringify(queued)}`);
  }
  logger.info(`[eval] run queued: id=${queued.run.id} status=${queued.status}`);

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

  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    shopDomain: SHOP_DOMAIN,
    provider: provider.provider,
    model: provider.model,
    scopesGrantedCount: scopes.length,
    result,
  };

  const dir = resolve(process.cwd(), "docs/ops");
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, "shopify-real-dev-store-recommendation-2026-08-25.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  logger.info(`[eval] status=${result.status} runId=${result.runId ?? result.run?.id ?? "n/a"}`);
  logger.info(`[eval] saved trace to ${outPath}`);
  process.stdout.write(`${JSON.stringify({ status: result.status, outPath }, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}
