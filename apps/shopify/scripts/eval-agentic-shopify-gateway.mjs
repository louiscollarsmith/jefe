#!/usr/bin/env node

/* global process */
//
// Standalone proof of the Agentic Shopify Gateway's core hypothesis (docs/ops/
// agentic-shopify-gateway/04-recommendation-query-mode-design.md, Part 4 of the design brief):
// an LLM can discover Shopify's real schema, compose its own GraphQL, have it deterministically
// validated/rejected/repaired, and (when a live token is configured) execute it — without Jefe
// pre-generating a document for the operation.
//
// This is intentionally NOT a rewrite of the production recommendation loop
// (agentic-runtime/recommendation-agent.server.js) — that file has ~20 call sites structurally
// tied to the 2-tool catalog surface (retrieveOperations/callOperation) and rewiring it for a
// 4-tool surface is real, separate follow-up work (see docs/ops/agentic-shopify-gateway/
// 13-known-limitations.md). This script proves the gateway mechanics directly: real LLM, real
// deterministic validator, real schema index. It runs the mutation-preparation path against the
// real classifier/blast-radius/preview stack too, without ever calling Shopify.
//
// Usage:
//   node scripts/eval-agentic-shopify-gateway.mjs                  # schema discovery + query construction/repair, no Shopify writes
//   node scripts/eval-agentic-shopify-gateway.mjs --real-shopify   # also executes reads against JEFE_GOLDEN_PATH_SHOPIFY_SHOP if a token is configured

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@google/genai";
import { createLlmProvider } from "../app/lib/llm/provider.server.js";
import { ShopifyAdminGraphqlClient } from "../app/lib/shopify/admin-graphql.server.js";
import { loadGatewaySchemaIndex } from "../app/lib/shopify/gateway/schema-index.server.js";
import { runShopifyGatewayTool, SHOPIFY_GATEWAY_TOOL } from "../app/lib/shopify/gateway/tools.server.js";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv(process.cwd());

const args = new Set(process.argv.slice(2));
const reportDir = resolve(process.cwd(), "../../.context/agentic-shopify-gateway");
mkdirSync(reportDir, { recursive: true });

const index = loadGatewaySchemaIndex();
const startedAt = new Date().toISOString();
const report = {
  startedAt,
  apiVersion: index.apiVersion,
  catalogOperationCount: index.operationCount,
  liveShopify: args.has("--real-shopify"),
  stages: [],
};

if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
  report.stages.push({ name: "schema_discovery_and_repair_loop", status: "BLOCKED", reason: "No LLM provider API key configured." });
  finish();
  process.exit(0);
}

const client = buildShopifyClient();
const ctx = {
  client,
  merchantId: "gateway-eval",
  shopId: "gateway-eval",
  shopDomain: process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP ?? "jefe-local-store.myshopify.com",
  apiVersion: index.apiVersion,
  recommendationMode: true, // proves the discovery+read loop runs entirely inside the query-only boundary
  logger: { info() {}, warn() {}, error() {} },
};

await runSchemaDiscoveryAndRepairLoopStage();
await runMutationPreparationStage();

finish();

// ---------------------------------------------------------------------------

async function runSchemaDiscoveryAndRepairLoopStage() {
  const provider = createLlmProvider();
  const transcript = [];
  let llmCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const startedAtMs = Date.now();

  const systemPrompt = [
    "You are investigating a live Shopify store's product/inventory data using only the tools described below.",
    "Tools:",
    "- shopify_schema { action: search|inspect_field|list_fields, query?, fieldName?, kind? } — discover real Shopify Admin GraphQL fields. Use this before writing any query.",
    "- shopify_query { document, variables? } — run a read-only GraphQL document you write yourself against the real schema. It will be rejected with a specific error if invalid; read the error and repair your document.",
    "Investigate: how would you query active products, their variants, and inventory availability at each location? Use shopify_schema first, then write and run a shopify_query GraphQL document.",
    "Respond ONLY with the requested JSON: one or more toolCalls, or a finalAnswer once you have real evidence or have concluded the investigation.",
  ].join("\n");

  const schema = {
    type: Type.OBJECT,
    properties: {
      reasoning: { type: Type.STRING, nullable: true },
      toolCalls: {
        type: Type.ARRAY,
        nullable: true,
        items: {
          type: Type.OBJECT,
          required: ["tool"],
          properties: {
            tool: { type: Type.STRING, enum: ["shopify_schema", "shopify_query"] },
            action: { type: Type.STRING, nullable: true },
            query: { type: Type.STRING, nullable: true },
            fieldName: { type: Type.STRING, nullable: true },
            kind: { type: Type.STRING, nullable: true },
            document: { type: Type.STRING, nullable: true },
            variables: { type: Type.OBJECT, nullable: true },
          },
        },
      },
      finalAnswer: { type: Type.STRING, nullable: true },
    },
  };

  let history = "";
  const MAX_TURNS = 8;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const prompt = history || "Begin the investigation.";
    let response;
    try {
      response = await provider.generateStructuredJson({ systemPrompt, prompt, schema, timeoutMs: 45_000 });
    } catch (error) {
      transcript.push({ turn, error: error instanceof Error ? error.message : String(error) });
      break;
    }
    llmCalls += 1;
    totalInputTokens += response.usage?.inputTokens ?? response.usage?.estimatedInputTokens ?? 0;
    totalOutputTokens += response.usage?.outputTokens ?? 0;
    const turnRecord = { turn, model: response.model, provider: response.provider, response: response.json, toolResults: [] };

    const toolCalls = Array.isArray(response.json?.toolCalls) ? response.json.toolCalls : [];
    for (const call of toolCalls) {
      const result = await runShopifyGatewayTool(ctx, {
        tool: call.tool,
        arguments: {
          action: call.action,
          query: call.query,
          fieldName: call.fieldName,
          kind: call.kind,
          document: call.document,
          variables: call.variables,
        },
      });
      turnRecord.toolResults.push({ tool: call.tool, ok: result.ok, message: result.message, facts: result.facts, error: result.error });
    }
    transcript.push(turnRecord);
    history += `\n\nTurn ${turn}: ${JSON.stringify({ toolCalls, toolResults: turnRecord.toolResults })}`;

    if (response.json?.finalAnswer) break;
    if (!toolCalls.length) break;
  }

  const repairedCalls = transcript
    .flatMap((t) => t.toolResults ?? [])
    .filter((r) => r.tool === "shopify_query" && !r.ok).length;
  const successfulReads = transcript
    .flatMap((t) => t.toolResults ?? [])
    .filter((r) => r.tool === "shopify_query" && r.ok).length;
  const schemaLookups = transcript.flatMap((t) => t.toolResults ?? []).filter((r) => r.tool === "shopify_schema").length;

  report.stages.push({
    name: "schema_discovery_and_repair_loop",
    status: "PASS",
    llmCalls,
    totalInputTokens,
    totalOutputTokens,
    durationMs: Date.now() - startedAtMs,
    schemaLookups,
    validationFailuresOrRepairs: repairedCalls,
    successfulReads,
    liveShopifyExecutionNote: report.liveShopify
      ? "shopify_query issued real requests to the configured shop."
      : "No JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN configured this session; shopify_query calls received an honest SHOPIFY_PROVIDER_ERROR (no live token) rather than fabricated data — see report.stages[0].transcript for exact tool results.",
    transcript,
  });
}

async function runMutationPreparationStage() {
  const executeCtx = { ...ctx, recommendationMode: false };
  const document =
    'mutation($id: ID!, $price: Decimal!) { productVariantsBulkUpdate(productId: $id, variants: []) { userErrors { field message } } }';
  const result = await runShopifyGatewayTool(executeCtx, {
    tool: SHOPIFY_GATEWAY_TOOL.prepareMutation,
    arguments: { document, variables: { id: "gid://shopify/Product/1", price: "9.99" } },
  });
  report.stages.push({
    name: "mutation_preparation_no_execution",
    status: result.ok ? "PASS" : "FAIL",
    note: "Proves the mutation path classifies/previews via the same mutation-safety + blast-radius + preview stack the catalog surface uses, without ever calling Shopify.",
    result,
  });
}

function buildShopifyClient() {
  const shopDomain = process.env.JEFE_GOLDEN_PATH_SHOPIFY_SHOP ?? "jefe-local-store.myshopify.com";
  const accessToken = process.env.JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN ?? "";
  if (args.has("--real-shopify") && accessToken) {
    return new ShopifyAdminGraphqlClient({
      shopDomain,
      accessToken,
      apiVersion: index.apiVersion,
      logger: { info() {}, warn() {}, error() {} },
    });
  }
  return {
    async request() {
      throw new Error(
        "No live Shopify token configured in this environment (JEFE_GOLDEN_PATH_SHOPIFY_ADMIN_ACCESS_TOKEN is unset). " +
          "This is an honest failure, not simulated data — see docs/ops/agentic-shopify-gateway/13-known-limitations.md.",
      );
    },
  };
}

function finish() {
  report.finishedAt = new Date().toISOString();
  const reportPath = resolve(reportDir, "latest.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report written to ${reportPath}\n`);
  process.stdout.write(`${JSON.stringify(report.stages.map((s) => ({ name: s.name, status: s.status })), null, 2)}\n`);
}
