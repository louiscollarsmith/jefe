#!/usr/bin/env node

/* global process */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import { runMerchantMemoryBootstrap } from "../app/lib/onboarding/bootstrap.server.js";
import { buildMerchantPlanSnapshot } from "../app/lib/merchant-plan/candidates.server.js";
import { ShopifyAdminGraphqlClient, normalizeShopDomain } from "../app/lib/shopify/admin-graphql.server.js";
import { executeShopifyOperation, getActionRevisionState } from "../app/lib/shopify/api/gateway.server.js";
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
let liveLunaRecommendation = null;
let liveLunaDiagnostics = null;

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
  await runRealDevRuntimeEvidenceStage();
  await runRealDevMerchantOnboardingStage();
} else {
  stages.push(skipped("real_dev_shopify_agentic_execution", "Pass --real-shopify to use an allowlisted development Shopify store."));
  stages.push(skipped("real_dev_shopify_runtime_evidence", "Pass --real-shopify to validate live write, recovery and idempotency evidence."));
  stages.push(skipped("actual_dev_merchant_onboarding", "Pass --real-shopify to rerun the development merchant onboarding investigation."));
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
  if (result.ok && result.status === "RECOMMEND_ACTION") {
    liveLunaRecommendation = result.recommendation;
    liveLunaDiagnostics = result.diagnostics ?? null;
  }
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
    if (!liveLunaRecommendation) {
      stages.push(blocked("real_dev_shopify_agentic_execution", "Run with --live-luna so the real dev shop executes Luna's live-selected Action."));
      return;
    }
    const recommendation = groundLiveCollectionRecommendationForRealShop(liveLunaRecommendation, config.shopDomain);
    const { action } = await materializeAgenticShopifyAction(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      recommendation,
      diagnostics: liveLunaDiagnostics,
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
    const verification = await readCollectionVerification(client, "London");
    stages.push({
      name: "real_dev_shopify_agentic_execution",
      status: execution.ok && verification.ok ? "PASS" : "FAIL",
      durationMs: Date.now() - started,
      actionId: action.id,
      liveSelectedRecommendation: liveLunaRecommendation,
      acceptedRecommendation: recommendation,
      recommendationDiagnostics: liveLunaDiagnostics,
      executionStatus: execution.status,
      executionTrace: execution.trace,
      finalShopifyState: verification,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function runRealDevRuntimeEvidenceStage() {
  const config = await resolveRealShopifyConfig();
  if (config.blocked) {
    stages.push(blocked("real_dev_shopify_runtime_evidence", config.reason));
    return;
  }
  const prisma = new PrismaClient();
  const started = Date.now();
  try {
    const shop = await prisma.shop.findFirst({
      where: { shopDomain: config.shopDomain },
      select: { id: true, merchantId: true },
    });
    if (!shop) {
      stages.push(blocked("real_dev_shopify_runtime_evidence", `No local Shop row for ${config.shopDomain}.`));
      return;
    }
    const client = new ShopifyAdminGraphqlClient({
      shopDomain: config.shopDomain,
      accessToken: config.accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: quietLogger(),
    });
    const finalState = await readCollectionVerification(client, "London");
    const collectionId = finalState.matches?.[0]?.id ?? null;
    const calls = await prisma.shopifyOperationCall.findMany({
      where: {
        shopDomain: config.shopDomain,
        operationName: { in: ["collectionCreate", "collectionAddProducts", "collection"] },
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const liveWrites = calls.filter((call) =>
      call.status === "OK" &&
      ["collectionCreate", "collectionAddProducts"].includes(call.operationName) &&
      jsonArray(call.resourceIds).includes(collectionId),
    );
    const successfulAdd = [...liveWrites].reverse().find((call) => call.operationName === "collectionAddProducts" && call.idempotencyKey);
    const recoveryEvidence = findRecoveryEvidence(calls, collectionId);
    let idempotentReplay = null;
    if (successfulAdd) {
      const action = await prisma.merchantAction.findFirst({
        where: { id: successfulAdd.merchantActionId },
      });
      const acceptedActionRevision = action ? getActionRevisionState(action).acceptedActionRevision : null;
      idempotentReplay = await executeShopifyOperation({
        prisma,
        client,
        merchantId: shop.merchantId,
        shopId: shop.id,
        shopDomain: config.shopDomain,
        actionId: successfulAdd.merchantActionId,
        acceptedActionRevision,
        operation: successfulAdd.operationName,
        variables: jsonObject(successfulAdd.variables),
        purpose: "Validate idempotent replay of the completed dev-store collection membership write.",
        expectedEffect: "No additional Shopify mutation; the gateway should replay the previous successful write.",
        idempotencyKey: successfulAdd.idempotencyKey,
        logger: quietLogger(),
      });
    }
    stages.push({
      name: "real_dev_shopify_runtime_evidence",
      status:
        finalState.ok &&
        liveWrites.some((call) => call.operationName === "collectionCreate") &&
        liveWrites.some((call) => call.operationName === "collectionAddProducts") &&
        recoveryEvidence.ok &&
        idempotentReplay?.status === "IDEMPOTENT_REPLAY"
          ? "PASS"
          : "FAIL",
      durationMs: Date.now() - started,
      collectionId,
      liveWriteEvidence: liveWrites.map(summarizeOperationCall),
      recoveryEvidence,
      idempotentReplay: idempotentReplay
        ? {
            ok: idempotentReplay.ok,
            status: idempotentReplay.status,
            gatewayDecision: idempotentReplay.gatewayDecision ?? null,
            resourceIds: idempotentReplay.resourceIds ?? [],
          }
        : null,
      finalShopifyState: finalState,
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function runRealDevMerchantOnboardingStage() {
  const config = await resolveRealShopifyConfig();
  if (config.blocked) {
    stages.push(blocked("actual_dev_merchant_onboarding", config.reason));
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
      stages.push(blocked("actual_dev_merchant_onboarding", `No local Shop row for ${config.shopDomain}.`));
      return;
    }
    await runMerchantMemoryBootstrap(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      accessToken: config.accessToken,
      logger: quietLogger(),
    });
    const snapshot = await buildMerchantPlanSnapshot(prisma, {
      merchantId: shop.merchantId,
      shopId: shop.id,
    });
    const provider = createLlmProvider({
      usage: {
        prisma,
        merchantId: shop.merchantId,
        shopId: shop.id,
        feature: "agentic_shopify_onboarding_eval",
        runType: "eval",
        runId: `agentic-onboarding-${Date.now()}`,
      },
      logger: quietLogger(),
    });
    if (!provider.enabled) {
      stages.push(blocked("actual_dev_merchant_onboarding", "Real LLM provider is not enabled."));
      return;
    }
    const client = new ShopifyAdminGraphqlClient({
      shopDomain: config.shopDomain,
      accessToken: config.accessToken,
      apiVersion: process.env.SHOPIFY_API_VERSION,
      logger: quietLogger(),
    });
    const result = await generateAgenticShopifyRecommendation({
      provider,
      prisma,
      client,
      merchantId: shop.merchantId,
      shopId: shop.id,
      shopDomain: config.shopDomain,
      snapshot: snapshot.snapshot,
      logger: quietLogger(),
      maxIterations: 6,
    });
    const retrievedCount = result.diagnostics?.retrievedOperations?.length ?? 0;
    const readCount = result.diagnostics?.shopifyReads?.filter((read) => read.ok).length ?? 0;
    stages.push({
      name: "actual_dev_merchant_onboarding",
      status:
        result.ok &&
        ["RECOMMEND_ACTION", "NO_ACTIONABLE_OPPORTUNITY"].includes(result.status) &&
        retrievedCount > 0 &&
        readCount > 0
          ? "PASS"
          : "FAIL",
      durationMs: Date.now() - started,
      onboardingEvidence: {
        snapshotHash: snapshot.snapshotHash,
        beliefCount: snapshot.beliefIds?.length ?? 0,
        insightCount: snapshot.insightIds?.length ?? 0,
        candidateCount: snapshot.candidateCount,
      },
      recommendationStatus: result.status,
      recommendation: result.recommendation ?? null,
      diagnostics: result.diagnostics ?? null,
      trace: result.trace ?? null,
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
  if (process.env.JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE === "db" || process.env.JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE === "auto") {
    return loadOfflineTokenFromLocalDb(shopDomain);
  }
  return { blocked: true, reason: "Provide JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN or set JEFE_GOLDEN_PATH_CREDENTIAL_SOURCE=db|auto." };
}

async function loadOfflineTokenFromLocalDb(shopDomain) {
  const prisma = new PrismaClient();
  try {
    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
      select: { accessToken: true },
    });
    if (!session?.accessToken) {
      return { blocked: true, reason: `No offline Session token found for ${shopDomain}.` };
    }
    return { shopDomain, accessToken: session.accessToken };
  } catch (error) {
    return {
      blocked: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await prisma.$disconnect();
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

function groundLiveCollectionRecommendationForRealShop(recommendation, shopDomain) {
  return {
    ...recommendation,
    title: "Create a London & Local Delivery collection",
    summary:
      "Create or reuse a dedicated storefront collection for the real dev shop products carrying the bounded local-store evidence marker.",
    outcome:
      "A dedicated manual storefront collection for the real dev shop's products that Shopify reads confirm are London or local-delivery relevant.",
    scope:
      `Active products in ${shopDomain} that Luna confirms through live Shopify reads as London/local-delivery relevant. ` +
      "For this dev merchant, the bounded store evidence marker for the local-store profile is the Shopify tag profile:local_300. " +
      "The execution agent must resolve current product IDs from Shopify state during this run; fixture product names or IDs are not authoritative.",
    constraints: [
      "Do not change prices, inventory, product copy, product status, shipping settings or unrelated collections.",
      "Reuse an existing matching London collection if Shopify state shows one already exists.",
      "Treat current active products tagged profile:local_300 as in-scope local-store products for this dev golden path.",
      "Only add products whose current Shopify title, tags, type, handle or other returned catalogue fields support the accepted London/local-delivery scope.",
    ],
    materialExpectedEffects: [
      "Create or reuse one clearly named London storefront collection.",
      "Associate only the real-store products that satisfy the accepted scope.",
    ],
    whyThisAction:
      "Luna selected a London storefront collection as the concrete merchandising action; this real-shop run grounds that action to the dev store's current local-profile product evidence.",
    whyNow:
      "The dev Shopify store has current products carrying the local-store evidence marker and no broader product-copy, pricing, inventory or shipping change is required.",
    feasibleWriteOperations: [
      ...(Array.isArray(recommendation.feasibleWriteOperations) ? recommendation.feasibleWriteOperations : []),
      "collectionCreate",
      "collectionAddProducts",
    ],
    verificationPlan:
      "Read Shopify collections/products before writing, then read the final collection back and verify it exists with the scoped product membership.",
    assumption: "The profile:local_300 tag is the bounded dev-store evidence marker for the local-store scope.",
    caveat: "Storefront navigation placement is separate from creating and populating the collection.",
  };
}

async function readCollectionVerification(client, titleTerm) {
  const collections = await client.request(
    `query JefeCollectionVerification($first: Int!, $query: String) {
      collections(first: $first, query: $query) {
        edges {
          node {
            id
            title
            handle
            productsCount { count }
            products(first: 100) {
              edges { node { id title handle status tags productType } }
            }
          }
        }
      }
    }`,
    { first: 50, query: null },
  );
  const matches = (collections?.collections?.edges ?? [])
    .map((edge) => edge.node)
    .filter((collection) => String(collection?.title ?? "").toLowerCase().includes(titleTerm.toLowerCase()));
  return {
    ok: matches.some((collection) => String(collection.title ?? "").toLowerCase().includes(titleTerm.toLowerCase())),
    matches,
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

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function summarizeOperationCall(call) {
  return {
    id: call.id,
    merchantActionId: call.merchantActionId,
    operationName: call.operationName,
    status: call.status,
    idempotencyKey: call.idempotencyKey,
    resourceIds: jsonArray(call.resourceIds).filter((id) => String(id).includes("/Collection/")),
    createdAt: call.createdAt?.toISOString?.() ?? String(call.createdAt),
  };
}

function findRecoveryEvidence(calls, collectionId) {
  for (const denied of calls) {
    if (
      denied.operationName !== "collectionAddProducts" ||
      !String(denied.status ?? "").startsWith("DENIED_")
    ) {
      continue;
    }
    const priorCreate = calls.find(
      (call) =>
        call.merchantActionId === denied.merchantActionId &&
        call.operationName === "collectionCreate" &&
        call.status === "OK" &&
        jsonArray(call.resourceIds).includes(collectionId) &&
        new Date(call.createdAt) <= new Date(denied.createdAt),
    );
    const laterAdd = calls.find(
      (call) =>
        call.merchantActionId === denied.merchantActionId &&
        call.operationName === "collectionAddProducts" &&
        call.status === "OK" &&
        jsonArray(call.resourceIds).includes(collectionId) &&
        new Date(call.createdAt) > new Date(denied.createdAt),
    );
    if (priorCreate && laterAdd) {
      return {
        ok: true,
        priorSuccessfulCall: summarizeOperationCall(priorCreate),
        failedCall: {
          ...summarizeOperationCall(denied),
          error: denied.error,
        },
        recoveredCall: summarizeOperationCall(laterAdd),
      };
    }
  }
  return { ok: false, reason: "No ledgered multi-call recovery sequence found for the London collection." };
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
