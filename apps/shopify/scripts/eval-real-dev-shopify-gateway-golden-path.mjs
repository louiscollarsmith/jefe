#!/usr/bin/env node
/**
 * Real dev-store golden-path validation for the Agentic Shopify Gateway
 * (docs/ops/agentic-shopify-gateway-full/, Part 19-20). Runs the full lifecycle —
 * accepted Action -> real agent-composed mutation -> real Shopify write -> real
 * agent-composed verification query -> completed Action — against
 * jefe-local-store.myshopify.com, through SHOPIFY_AGENT_SURFACE=gateway.
 *
 * This performs a REAL, reversible Shopify write: adds one distinctive tag to a real active
 * product (a productUpdate mutation) -- one of the task brief's own suggested golden-path
 * domains, trivially reversible (remove the tag), and does not touch price or inventory.
 *
 * An earlier version of this script targeted collection creation + membership
 * (collectionCreate + collectionAddProducts), matching the winning recommendation from the
 * earlier catalogue-vs-gateway A/B. That surfaced a real, important finding instead of
 * completing: collectionAddProducts is not in mutation-safety.server.js's reviewed family
 * policies or known-good overrides, so it correctly requires a genuine, durable explicit
 * high-risk confirmation (api.merchant-actions.confirm-shopify-operation) before it can execute
 * -- deliberately not something an LLM tool call, or this script, can grant itself. The run
 * stopped there rather than bypassing it; see docs/ops/agentic-shopify-gateway-full/
 * 16-known-limitations.md for that trace and what it proves about the safety architecture.
 *
 * Requires: DATABASE_URL, a real offline Shopify Session for the target shop, LLM_ENABLED=true
 * with a real provider key. Real API cost and a real Shopify write — do not run under `node --test`.
 */

/* global process */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import { ShopifyAdminGraphqlClient } from "../app/lib/shopify/admin-graphql.server.js";
import {
  materializeAgenticShopifyAction,
  acceptAgenticShopifyAction,
} from "../app/lib/shopify/agentic-runtime/semantic-action.server.js";
import { runAgenticShopifyExecution } from "../app/lib/shopify/agentic-runtime/execution-agent.server.js";
import { runAgenticShopifyVerification } from "../app/lib/shopify/agentic-runtime/verification-agent.server.js";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());
process.env.SHOPIFY_AGENT_SURFACE = "gateway";

const SHOP_DOMAIN = "jefe-local-store.myshopify.com";
const startedAt = new Date().toISOString();
const prisma = new PrismaClient();
const logger = console;
const trace = { startedAt, shopDomain: SHOP_DOMAIN, steps: [] };

try {
  const shop = await prisma.shop.findFirst({ where: { shopDomain: SHOP_DOMAIN }, select: { id: true, merchantId: true } });
  if (!shop) throw new Error(`No local Shop row for ${SHOP_DOMAIN}.`);

  const session = await prisma.session.findFirst({
    where: { shop: SHOP_DOMAIN, isOnline: false, accessToken: { not: "" } },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken || (session.expires && session.expires.getTime() <= Date.now())) {
    throw new Error(`No usable, non-expired offline Shopify session for ${SHOP_DOMAIN}.`);
  }
  const scopes = String(session.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const client = new ShopifyAdminGraphqlClient({ shopDomain: SHOP_DOMAIN, accessToken: session.accessToken, logger });

  // Step 1: real read to select one real product to tag.
  const productsResult = await client.request(
    `query { products(first: 5, query: "status:active") { nodes { id title tags } } }`,
  );
  const candidate = (productsResult?.products?.nodes ?? [])[0];
  if (!candidate) throw new Error("No active product found to run the golden-path test against.");
  trace.steps.push({ step: "real_read_candidate", ok: true, candidate });
  logger.info(`[golden-path] selected real product ${candidate.id} ("${candidate.title}")`);

  const testTag = `jefe-gateway-golden-path-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;

  // Step 2: materialize a real semantic Action (skips re-deriving the recommendation via a full
  // discovery pass -- the recommendation reasoning itself was already proven live in the earlier
  // A/B; this test specifically proves accept -> execute -> verify through the Gateway).
  const recommendation = {
    title: `[TEST] Jefe Gateway golden-path product tag (${testTag})`,
    summary: `Automated golden-path validation: add a distinctive test tag to one real product. Trivially reversible by removing the tag. Created ${startedAt}.`,
    outcome: `Product ${candidate.id} ("${candidate.title}") has the tag "${testTag}" added to its existing tags.`,
    scope: `One existing active product (${candidate.id}); no price or inventory data changed.`,
    constraints: ["Do not change prices.", "Do not change inventory.", "Do not remove any existing tag.", "Only add the one new tag."],
    materialExpectedEffects: [`Add tag "${testTag}" to product ${candidate.id}`],
    feasibleWriteOperations: ["productUpdate"],
    verificationPlan: `Read the product back and confirm its tags now include "${testTag}".`,
    whyThisAction: "Automated golden-path validation of the Agentic Shopify Gateway execution lifecycle.",
    whyNow: "docs/ops/agentic-shopify-gateway-full/ Part 19-20.",
    supportingBeliefIds: [],
    supportingInsightIds: [],
    confidence: "high",
  };
  const { action } = await materializeAgenticShopifyAction(prisma, { merchantId: shop.merchantId, shopId: shop.id, recommendation });
  trace.steps.push({ step: "materialize_action", ok: true, actionId: action.id, recommendation });
  logger.info(`[golden-path] materialized action ${action.id}`);

  const acceptResult = await acceptAgenticShopifyAction(prisma, { merchantId: shop.merchantId, shopId: shop.id, actionId: action.id });
  trace.steps.push({ step: "accept_action", ok: acceptResult.ok, acceptResult });
  if (!acceptResult.ok) throw new Error(`Failed to accept action: ${JSON.stringify(acceptResult)}`);
  logger.info(`[golden-path] accepted action ${action.id}, revision ${acceptResult.acceptedActionRevision}`);

  const provider = createLlmProvider({
    logger,
    usage: { prisma, merchantId: shop.merchantId, shopId: shop.id, feature: "agentic_execution_golden_path_gateway", runType: "MerchantAction" },
  });
  if (!provider.enabled) throw new Error("LLM provider not enabled.");

  // Step 3: REAL execution through the Gateway -- the agent writes its own GraphQL for
  // collectionCreate/collectionAddProducts and executes it against the real store.
  const executionResult = await runAgenticShopifyExecution({
    provider,
    prisma,
    client,
    merchantId: shop.merchantId,
    shopId: shop.id,
    shopDomain: SHOP_DOMAIN,
    actionId: action.id,
    grantedScopes: scopes,
    logger,
  });
  trace.steps.push({ step: "execution", ok: executionResult.ok, status: executionResult.status, wroteToShopify: executionResult.wroteToShopify, result: executionResult });
  logger.info(`[golden-path] execution status=${executionResult.status} wroteToShopify=${executionResult.wroteToShopify}`);
  if (executionResult.status !== "WRITES_COMPLETE") {
    throw new Error(`Execution did not reach WRITES_COMPLETE: ${executionResult.status} / ${executionResult.blocker ?? ""}`);
  }

  // Step 4: REAL verification through the Gateway -- the agent writes its own read query to
  // confirm the collection now exists with the intended products.
  const verificationResult = await runAgenticShopifyVerification({
    provider,
    prisma,
    client,
    merchantId: shop.merchantId,
    shopId: shop.id,
    shopDomain: SHOP_DOMAIN,
    actionId: action.id,
    grantedScopes: scopes,
    logger,
  });
  trace.steps.push({ step: "verification", ok: verificationResult.ok, status: verificationResult.status, result: verificationResult });
  logger.info(`[golden-path] verification status=${verificationResult.status}`);

  const finalAction = await prisma.merchantAction.findFirst({ where: { id: action.id } });
  trace.steps.push({ step: "final_action_state", status: finalAction?.status ?? null, outcome: finalAction?.outcome ?? null });

  trace.completedAt = new Date().toISOString();
  trace.finalStatus = finalAction?.status ?? null;
  trace.ok = finalAction?.status === "completed";

  const dir = resolve(process.cwd(), "../../docs/ops/agentic-shopify-gateway-full");
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, "real-dev-store-golden-path-trace.json");
  writeFileSync(outPath, `${JSON.stringify(trace, null, 2)}\n`);
  logger.info(`[golden-path] final action status: ${trace.finalStatus}`);
  logger.info(`[golden-path] trace saved to ${outPath}`);
  logger.info(`[golden-path] NOTE: product ${candidate.id} in ${SHOP_DOMAIN} now has tag "${testTag}" — safe to remove manually.`);
  process.stdout.write(`${JSON.stringify({ ok: trace.ok, finalStatus: trace.finalStatus, testTag, outPath }, null, 2)}\n`);
} catch (error) {
  trace.completedAt = new Date().toISOString();
  trace.ok = false;
  trace.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  const dir = resolve(process.cwd(), "../../docs/ops/agentic-shopify-gateway-full");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "real-dev-store-golden-path-trace.json"), `${JSON.stringify(trace, null, 2)}\n`);
  console.error("[golden-path] FAILED:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
