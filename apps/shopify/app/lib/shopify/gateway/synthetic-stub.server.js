// @ts-check
//
// Turns a validated, agent-authored GraphQL document (document.server.js) into the same
// ShopifyApiOperationStub shape the existing universal gateway (../api/gateway.server.js) expects
// from the generated catalog. This is the seam that lets the gateway execution path reuse
// idempotency, accepted-Action-revision authorization, blast-radius, explicit confirmation and the
// durable ShopifyOperationCall ledger UNCHANGED (Part 5: "Reuse the valuable parts of the current
// execution infrastructure ... Do not bypass these just because GraphQL is now agent-generated.")
//
// The one field that differs in kind from a catalog stub: `document` here is the agent's own
// printed GraphQL text (via graphql's print(), which also strips comments/whitespace noise), not a
// pre-generated bounded document. Argument/inputObject/enumType metadata is only populated when
// the root field happens to be present in the local schema index (see schema-index.server.js's
// documented coverage gap) — an empty arguments array is safe here because
// validateShopifyOperationVariables (catalog.server.js) treats "no declared arguments" as "nothing
// to check," and real argument validation already happened in document.server.js / will happen at
// Shopify's own GraphQL layer.

/**
 * @param {{
 *   analysis: ReturnType<typeof import("./document.server.js").analyzeGatewayDocument>;
 *   apiVersion: string;
 * }} input
 */
export function buildSyntheticGatewayStub(input) {
  const analysis = /** @type {any} */ (input.analysis);
  if (!analysis.ok) {
    throw new Error("buildSyntheticGatewayStub requires a successful analyzeGatewayDocument() result.");
  }
  return {
    id: `shopify.gateway.${input.apiVersion}.${analysis.operationKind.toLowerCase()}.${analysis.rootField}`,
    operation: analysis.rootField,
    operationKind: analysis.operationKind,
    domain: analysis.domain,
    description: `Agent-composed ${analysis.operationKind === "MUTATION" ? "mutation" : "query"} against ${analysis.rootField}.`,
    requiredScopes: analysis.requiredScopes,
    scopeConfidence: analysis.scopeConfidence,
    safety: analysis.safety,
    execution: analysis.execution,
    arguments: [],
    inputObjects: {},
    enumTypes: {},
    returnType: null,
    deprecation: { deprecated: false, reason: null },
    document: analysis.normalizedDocument,
    apiVersion: input.apiVersion,
    tags: ["gateway-generated"],
  };
}
