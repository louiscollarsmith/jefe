#!/usr/bin/env node

/* global process */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import { ShopifyAdminGraphqlClient, normalizeShopDomain } from "../app/lib/shopify/admin-graphql.server.js";
import { loadFreshOfflineToken } from "../app/lib/shopify/offline-token.server.js";
import { buildMerchantPlanSnapshot } from "../app/lib/merchant-plan/candidates.server.js";
import { generateAgenticShopifyRecommendation } from "../app/lib/shopify/agentic-runtime/recommendation-agent.server.js";
import { runAgenticShopifyExecution } from "../app/lib/shopify/agentic-runtime/execution-agent.server.js";
import {
  acceptAgenticShopifyAction,
  materializeAgenticShopifyAction,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());

const args = new Set(process.argv.slice(2));
const reportDir = resolve(process.cwd(), "../../.context/agentic-shopify-runtime");
const reportPath = resolve(reportDir, "latest.json");
mkdirSync(reportDir, { recursive: true });

const stages = [];
const startedAt = new Date().toISOString();

runCommandStage("deterministic_agentic_runtime", [
  process.execPath,
  ["scripts/run-tests.mjs", "agentic-shopify-runtime.test.mjs", "shopify-api-gateway.test.mjs"],
]);

if (args.has("--live-luna")) {
  await runLiveLunaFixtureStage();
} else {
  stages.push(skipped("live_luna_unseen_action", "Pass --live-luna to use the configured real LLM provider."));
}

if (args.has("--real-shopify")) {
  await runRealDevShopifyStage();
} else {
  stages.push(skipped("real_dev_shopify_agentic_execution", "Pass --real-shopify to use an allowlisted development Shopify store."));
}

finish();

async function runLiveLunaFixtureStage() {
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    stages.push(blocked("live_luna_unseen_action", "OPENAI_API_KEY or GEMINI_API_KEY is required."));
    return;
  }
  const provider = createLlmProvider({
    logger: quietLogger(),
  });
  const client = fixtureShopifyClient();
  const started = Date.now();
  const result = await generateAgenticShopifyRecommendation({
    provider,
    client,
    merchantId: "fixture-merchant",
    shopId: "fixture-shop",
    shopDomain: "jefe-local-store.myshopify.com",
    snapshot: fixtureSnapshot(),
    grantedScopes: ["read_products", "write_products"],
    logger: quietLogger(),
  });
  const sawRetrievedOperations = (result.diagnostics?.retrievedOperations ?? []).length > 0;
  const sawShopifyRead = (result.diagnostics?.shopifyReads ?? []).some((row) => row.ok);
  stages.push({
    name: "live_luna_unseen_action",
    status:
      result.ok && result.status === "RECOMMEND_ACTION" && sawRetrievedOperations && sawShopifyRead
        ? "PASS"
        : "FAIL",
    durationMs: Date.now() - started,
    recommendation: result.recommendation ?? null,
    diagnostics: result.diagnostics ?? null,
    trace: result.trace ?? null,
  });
}

async function runRealDevShopifyStage() {
  const config = await resolveRealShopifyConfig();
  if (config.blocked) {
    stages.push(blocked("real_dev_shopify_agentic_execution", config.reason));
    return;
  }
  const prisma = new PrismaClient();
  const started = Date.now();
  try {
    const shop = await prisma.shop.findFirst({
      where: { shopDomain: config.shopDomain },
      select: { id: true, merchantId: true, shopDomain: true },
    });
    if (!shop) {
      stages.push(blocked("real_dev_shopify_agentic_execution", `No local Shop row for ${config.shopDomain}.`));
      return;
    }
    const provider = createLlmProvider({
      usage: {
        prisma,
        merchantId: shop.merchantId,
        shopId: shop.id,
        feature: "agentic_shopify_runtime_eval",
        runType: "eval",
        runId: `agentic-${Date.now()}`,
      },
      logger: quietLogger(),
    });
    if (!provider.enabled) {
      stages.push(blocked("real_dev_shopify_agentic_execution", "Real LLM provider is not enabled."));
      return;
    }
    const client = new ShopifyAdminGraphqlClient({
      shopDomain: config.shopDomain,
      accessToken: config.accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: quietLogger(),
    });
    const snapshot = await buildMerchantPlanSnapshot(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
    });
    const recommendation = await generateAgenticShopifyRecommendation({
      provider,
      prisma,
      client,
      merchantId: shop.merchantId,
      shopId: shop.id,
      shopDomain: config.shopDomain,
      snapshot: snapshot.snapshot,
      logger: quietLogger(),
    });
    if (!recommendation.ok || recommendation.status !== "RECOMMEND_ACTION") {
      stages.push({
        name: "real_dev_shopify_agentic_execution",
        status: recommendation.status === "NO_ACTIONABLE_OPPORTUNITY" ? "BLOCKED" : "FAIL",
        durationMs: Date.now() - started,
        recommendationStatus: recommendation.status,
        diagnostics: recommendation.diagnostics ?? null,
        trace: recommendation.trace ?? null,
      });
      return;
    }
    const { action } = await materializeAgenticShopifyAction(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      recommendation: recommendation.recommendation,
      diagnostics: recommendation.diagnostics,
    });
    const accepted = await acceptAgenticShopifyAction(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      actionId: action.id,
      actor: "agentic-runtime-eval",
    });
    if (!accepted.ok) throw new Error(`Could not accept generated action: ${accepted.reason}`);
    const execution = await runAgenticShopifyExecution({
      provider,
      prisma,
      client,
      merchantId: shop.merchantId,
      shopId: shop.id,
      shopDomain: config.shopDomain,
      actionId: action.id,
      logger: quietLogger(),
    });
    stages.push({
      name: "real_dev_shopify_agentic_execution",
      status: execution.ok ? "PASS" : "FAIL",
      durationMs: Date.now() - started,
      actionId: action.id,
      recommendation: recommendation.recommendation,
      recommendationDiagnostics: recommendation.diagnostics,
      executionStatus: execution.status,
      executionTrace: execution.trace,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function resolveRealShopifyConfig() {
  if (process.env.JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED !== "true") {
    return { blocked: true, reason: "Set JEFE_GOLDEN_PATH_SHOPIFY_WRITE_ENABLED=true to allow dev-store writes." };
  }
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    return { blocked: true, reason: "OPENAI_API_KEY or GEMINI_API_KEY is required." };
  }
  if (!process.env.DATABASE_URL) {
    return { blocked: true, reason: "DATABASE_URL is required." };
  }
  const rawShop = String(process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP ?? "").trim();
  if (!rawShop) return { blocked: true, reason: "JEFE_GOLDEN_PATH_SHOPIFY_SHOP is required." };
  const shopDomain = normalizeShopDomain(rawShop);
  const allowed = splitList(process.env.JEFE_GOLDEN_PATH_ALLOWED_SHOPS);
  if (!allowed.includes(shopDomain)) {
    return { blocked: true, reason: `${shopDomain} is not in JEFE_GOLDEN_PATH_ALLOWED_SHOPS.` };
  }
  const envToken = process.env.JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (envToken) return { shopDomain, accessToken: envToken };
  try {
    return { shopDomain, accessToken: await loadFreshOfflineToken(shopDomain) };
  } catch (error) {
    return {
      blocked: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function runCommandStage(name, commandTuple) {
  const [command, commandArgs] = commandTuple;
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  stages.push({
    name,
    status: result.status === 0 ? "PASS" : "FAIL",
    durationMs: Date.now() - started,
    command: [command, ...commandArgs].join(" "),
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  });
  if (result.status !== 0) finish(result.status ?? 1);
}

function fixtureSnapshot() {
  return {
    privacy: { excludesCredentialsAndTokens: true },
    goals: [{ id: "goal-local", title: "Make local delivery easier to shop" }],
    insights: [],
    beliefs: [
      {
        id: "belief-local-delivery",
        key: "merchant.local_delivery_priority",
        label: "London delivery priority",
        val: "The merchant wants London delivery products to be easier to find.",
        status: "active",
      },
    ],
    merchantContext: [],
    previousRecommendations: [],
  };
}

function fixtureShopifyClient() {
  return {
    async request(document) {
      if (document.includes("products(")) {
        return {
          products: {
            edges: [
              { node: { id: "gid://shopify/Product/1", title: "London Jacket" } },
              { node: { id: "gid://shopify/Product/2", title: "London Tote" } },
            ],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      return {};
    },
  };
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}

function splitList(value) {
  return String(value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function skipped(name, reason) {
  return { name, status: "SKIPPED", reason };
}

function blocked(name, reason) {
  return { name, status: "BLOCKED", reason };
}

function tail(value) {
  const text = String(value ?? "");
  return text.length > 6000 ? text.slice(-6000) : text;
}

function finish(exitCode) {
  const failed = stages.filter((stage) => stage.status === "FAIL");
  const blockedStages = stages.filter((stage) => stage.status === "BLOCKED");
  const status = failed.length ? "FAIL" : blockedStages.length ? "BLOCKED" : "PASS";
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        stages,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`AGENTIC SHOPIFY RUNTIME ${status}\nreport=${reportPath}\n`);
  if (exitCode != null) process.exit(exitCode);
  if (status === "FAIL") process.exit(1);
  if (status === "BLOCKED") process.exit(2);
}
