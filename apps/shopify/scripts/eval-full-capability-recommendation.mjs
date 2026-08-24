#!/usr/bin/env node
/**
 * Controlled capability evaluation: re-runs the candidate-driven recommendation pipeline for a
 * real merchant against the full ~810-operation Shopify catalog with assumeAllScopesGranted,
 * to answer "if permissions were not the constraint, what could Jefe discover and propose?" —
 * and to separate that from what's blocked by evidence, safety classification, or genuine
 * Shopify API limits (never scope, since scope is deliberately assumed away here).
 *
 * This does not call live Shopify (a fake, read-returning client stands in) and does not write
 * to MerchantPlanRun/MerchantPlanRecommendation — it calls runCandidateDrivenRecommendation
 * directly, in-memory, so a real merchant's actual Merchant Memory snapshot can be replayed
 * without mutating their real recommendation history. It does call a real LLM provider.
 *
 * Usage:
 *   node scripts/eval-full-capability-recommendation.mjs --merchant <id> --shop <shopId>
 *
 * Requires: DATABASE_URL, GEMINI_API_KEY or OPENAI_API_KEY (real LLM calls — this incurs real
 * API cost and must not be run under `node --test`, which hard-disables external LLM calls).
 */

/* global process */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import { buildAgenticRecommendationSnapshot } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";
import { runCandidateDrivenRecommendation } from "../app/lib/shopify/agentic-runtime/candidate-pipeline.server.js";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const MERCHANT_ID = argValue("--merchant", null);
const SHOP_ID = argValue("--shop", null);
if (!MERCHANT_ID || !SHOP_ID) {
  process.stderr.write("Usage: node scripts/eval-full-capability-recommendation.mjs --merchant <id> --shop <id>\n");
  process.exit(2);
}

const prisma = new PrismaClient();

// The recommendation-agent's server-side capability binding and the execution/verification
// agents all read via this fake client — no live Shopify network call, no expired-token
// dependency. Reads are answered generically enough to satisfy `call_shopify_operation`'s
// investigation step without asserting a specific store's data (this is a capability/coverage
// evaluation, not a data-fidelity one — the merchant's real Merchant Memory snapshot supplies
// the actual evidence Luna reasons from).
// All real Shopify Admin API scopes (docs/shopify-full-scope-audit.md §1), reported as granted
// by this eval harness's fake transport only — this is what "if permissions were not the
// constraint" means for a controlled evaluation. assumeAllScopesGranted (the production-facing
// flag) never reaches the gateway at all (tests/shopify-eval-mode-isolation.test.mjs); this is
// a property of the eval script's own fake client, the same pattern candidate-pipeline.test.mjs
// already uses (its fakeShopifyClient() reports a fixed granted-scope list too).
const EVAL_ALL_SCOPES = [
  "read_products", "write_products", "read_orders", "write_orders", "read_all_orders",
  "read_order_edits", "write_order_edits", "read_customers", "write_customers",
  "read_inventory", "write_inventory", "read_inventory_transfers", "write_inventory_transfers",
  "read_locations", "write_locations", "read_discounts", "write_discounts",
  "read_price_rules", "write_price_rules", "read_draft_orders", "write_draft_orders",
  "read_returns", "write_returns", "read_gift_cards", "write_gift_cards",
  "read_fulfillments", "write_fulfillments", "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders", "read_assigned_fulfillment_orders",
  "write_assigned_fulfillment_orders", "read_content", "write_content",
  "read_online_store_navigation", "write_online_store_navigation", "read_online_store_pages",
  "read_markets", "write_markets", "read_marketing_events", "write_marketing_events",
  "read_publications", "write_publications", "read_metaobjects", "write_metaobjects",
  "read_metaobject_definitions", "write_metaobject_definitions",
];

function fakeShopifyClient() {
  const pageInfo = { hasNextPage: false };
  return {
    async request(document) {
      if (document.includes("currentAppInstallation")) {
        return { currentAppInstallation: { accessScopes: EVAL_ALL_SCOPES.map((handle) => ({ handle })) } };
      }
      // Generic, plausible non-empty read shapes so the investigation-sufficiency check
      // registers a genuine successful read — an empty {} response is indistinguishable from
      // "no read attempted" to the pipeline's own validator. This evaluates capability/safety
      // coverage, not data fidelity, so the content is deliberately generic.
      if (document.includes("products(") || document.includes("query") && document.includes("product")) {
        return {
          products: { edges: [{ node: { id: "gid://shopify/Product/1", title: "Eval Fixture Product", status: "ACTIVE" } }], pageInfo },
        };
      }
      if (document.includes("orders(")) {
        return {
          orders: { edges: [{ node: { id: "gid://shopify/Order/1", createdAt: new Date().toISOString() } }], pageInfo },
        };
      }
      if (document.includes("customers(")) {
        return {
          customers: { edges: [{ node: { id: "gid://shopify/Customer/1" } }], pageInfo },
        };
      }
      if (document.includes("inventoryItem")) {
        return { inventoryItem: { id: "gid://shopify/InventoryItem/1", sku: "EVAL-1", unitCost: null } };
      }
      if (document.includes("locations(")) {
        return { locations: { edges: [{ node: { id: "gid://shopify/Location/1", name: "Eval Location" } }], pageInfo } };
      }
      return { __typename: "EvalFixtureResponse" };
    },
  };
}

async function main() {
  const snapshotResult = await buildAgenticRecommendationSnapshot(prisma, { merchantId: MERCHANT_ID, shopId: SHOP_ID });
  if (!snapshotResult.hasGoals) {
    process.stderr.write("Merchant does not have 3 completed goal horizons; snapshot may be thin.\n");
  }
  const logger = { info() {}, warn: console.warn, error: console.error };
  const provider = createLlmProvider({ logger });
  if (!provider.enabled) {
    process.stderr.write("LLM provider disabled — set LLM_ENABLED=true and a real API key.\n");
    process.exit(2);
  }

  const result = await runCandidateDrivenRecommendation({
    provider,
    prisma,
    client: fakeShopifyClient(),
    merchantId: MERCHANT_ID,
    shopId: SHOP_ID,
    shopDomain: "eval-mode.myshopify.com",
    grantedScopes: [],
    assumeAllScopesGranted: true,
    snapshot: snapshotResult.snapshot,
    logger,
    maxCandidatesFirstPass: 8,
    maxCandidatesRescue: 4,
    perCandidateIterations: 4,
  });

  const report = {
    merchantId: MERCHANT_ID,
    shopId: SHOP_ID,
    at: new Date().toISOString(),
    mode: "assumeAllScopesGranted=true (controlled evaluation — not a real merchant grant)",
    status: result.status,
    blocker: result.blocker ?? null,
    recommendation: result.recommendation
      ? {
          title: result.recommendation.title,
          diagnosedProblem: result.recommendation.diagnosedProblem,
          feasibleWriteOperations: result.recommendation.feasibleWriteOperations,
        }
      : null,
    candidateQueue: result.diagnostics?.candidateQueue ?? [],
    discoveryLog: result.diagnostics?.discoveryLog ?? [],
    progressLog: result.trace?.progressLog ?? [],
    toolResults: (result.trace?.toolResults ?? []).map((row) => ({
      tool: row.tool,
      ok: row.ok,
      message: row.message,
      operation: row.facts?.operation ?? null,
      status: row.facts?.status ?? null,
      error: row.error ?? null,
    })),
  };

  const dir = resolve(process.cwd(), "../../docs/ops/eval-full-capability-recommendation");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nSaved: ${path}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
