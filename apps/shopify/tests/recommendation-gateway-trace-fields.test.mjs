/**
 * Regression test for the gateway-no-action-forensics-2026-08-25 investigation.
 *
 * safeTrace() persists each MerchantPlanRun's tool-call trace. It was written against the old
 * catalog dispatcher's tool-result shape (`facts.query` / `facts.status`) and never updated when
 * the Agentic Shopify Gateway's tools (gateway/tools.server.js `runValidatedQuery`) started
 * populating the same concepts under `facts.document` / `facts.classification` instead. Net effect:
 * every persisted Gateway run recorded `query: null` and, for real reads, `status: null` — the
 * actual GraphQL text and result classification a candidate investigation used was unrecoverable
 * from a completed run, which is what made docs/ops/gateway-no-action-forensics-2026-08-25 unable
 * to show the exact query Luna sent to Shopify for the "products returned zero nodes" candidates.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { safeTrace } from "../app/lib/shopify/agentic-runtime/recommendation-service.server.js";

test("safeTrace preserves the Gateway tool result's document as `query`", () => {
  const trace = safeTrace({
    toolResults: [
      {
        tool: "shopify_query",
        ok: true,
        message: "products query executed.",
        facts: {
          operation: "products",
          domain: "catalog",
          document: 'query { products(first: 10, query: "title:\'Borderlands Discovery Four\'") { nodes { id title } } }',
          variables: {},
          classification: "FULL_SUCCESS",
        },
        error: null,
      },
    ],
  });

  const [row] = trace.toolResults;
  assert.equal(row.facts.query, trace.toolResults[0].facts.query);
  assert.match(row.facts.query, /title:'Borderlands Discovery Four'/);
  assert.equal(row.facts.status, "FULL_SUCCESS");
});

test("safeTrace still honours the catalog dispatcher's facts.query/facts.status shape", () => {
  const trace = safeTrace({
    toolResults: [
      {
        tool: "call_shopify_operation",
        ok: true,
        message: "products operation executed.",
        facts: { operation: "products", query: "legacy catalog document text", status: "ALREADY_AVAILABLE" },
        error: null,
      },
    ],
  });

  const [row] = trace.toolResults;
  assert.equal(row.facts.query, "legacy catalog document text");
  assert.equal(row.facts.status, "ALREADY_AVAILABLE");
});

test("safeTrace never persists raw response data or variables (call-site PII discipline)", () => {
  const trace = safeTrace({
    toolResults: [
      {
        tool: "shopify_query",
        ok: true,
        message: "customers query executed.",
        facts: {
          operation: "customers",
          document: "query { customers(first: 1) { nodes { id email } } }",
          variables: { email: "merchant-customer@example.com" },
          data: { customers: { nodes: [{ id: "gid://shopify/Customer/1", email: "merchant-customer@example.com" }] } },
          resourceIds: ["gid://shopify/Customer/1"],
          classification: "FULL_SUCCESS",
        },
        error: null,
      },
    ],
  });

  const [row] = trace.toolResults;
  assert.equal(row.facts.data, undefined);
  assert.equal(row.facts.variables, undefined);
  assert.equal(row.facts.resourceIds, undefined);
});
