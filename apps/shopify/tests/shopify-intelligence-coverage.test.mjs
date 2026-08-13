import assert from "node:assert/strict";
import test from "node:test";

import { DETERMINISTIC_BELIEF_REGISTRY } from "../app/lib/merchant-memory/deterministic-belief-registry.server.js";
import {
  ACCESS_STRATEGY,
  AVAILABILITY_STATE,
  REPRESENTATIVE_INVESTIGATIONS,
  SHOPIFY_INTELLIGENCE_REQUIREMENTS,
  buildShopifyIntelligenceCoverageReport,
  evidenceRequirementsForBelief,
  getShopifyEvidenceRequirement,
  listRepresentativeInvestigations,
} from "../app/lib/shopify/intelligence-coverage.server.js";

test("coverage catalog measures P0 evidence Jefe needs, not Shopify schema fields", () => {
  const report = buildShopifyIntelligenceCoverageReport("P0");

  assert.equal(report.requiredEvidenceCount, 31);
  assert.equal(report.accessibleViaMirror, 23);
  assert.equal(report.accessibleViaOnDemand, 7);
  assert.equal(report.unavailableOrBlocked, 1);
  assert.equal(report.effectiveCoveragePercent, 96.8);
  assert.deepEqual(
    report.remainingGaps.map((gap) => gap.id),
    ["orders.acquisition_journey"],
  );
});

test("coverage report includes the P1 effective coverage line", () => {
  const report = buildShopifyIntelligenceCoverageReport("P1");

  assert.equal(report.requiredEvidenceCount, 7);
  assert.equal(report.accessibleViaMirror, 2);
  assert.equal(report.accessibleViaOnDemand, 5);
  assert.equal(report.unavailableOrBlocked, 0);
  assert.equal(report.effectiveCoveragePercent, 100);
  assert.deepEqual(report.remainingGaps, []);
});

test("P0 requirements are either accessible or explicitly blocked with a reason", () => {
  const p0 = SHOPIFY_INTELLIGENCE_REQUIREMENTS.filter(
    (item) => item.priority === "P0",
  );
  assert.ok(p0.length > 20);

  for (const item of p0) {
    assert.ok(Object.values(ACCESS_STRATEGY).includes(item.accessStrategy));
    assert.ok(Object.values(AVAILABILITY_STATE).includes(item.availabilityState));
    assert.ok(item.useCases.length > 0, `${item.id} has no intelligence use case`);

    const accessible =
      item.availabilityState === AVAILABILITY_STATE.known ||
      item.availabilityState === AVAILABILITY_STATE.unknown;
    if (!accessible || item.accessStrategy === ACCESS_STRATEGY.ignore) {
      assert.ok(item.blockingReason, `${item.id} needs a blocking/ignore reason`);
    }
  }
});

test("representative investigations validate the tool taxonomy", () => {
  const investigations = listRepresentativeInvestigations();
  assert.deepEqual(investigations, REPRESENTATIVE_INVESTIGATIONS);
  assert.ok(investigations.length >= 8);

  for (const investigation of investigations) {
    assert.ok(investigation.requiredEvidence.length >= 3, `${investigation.id} has too little evidence mapped`);
    assert.ok(investigation.candidateTools.length >= 1, `${investigation.id} has no candidate tools`);
    for (const evidenceId of investigation.requiredEvidence) {
      assert.ok(getShopifyEvidenceRequirement(evidenceId), `${investigation.id} references unknown evidence ${evidenceId}`);
    }
  }

  const revenue = investigations.find((item) => item.id === "revenue_decline");
  assert.ok(revenue.candidateTools.includes("shopify_analyse_sales_mix"));
  assert.ok(revenue.candidateTools.includes("shopify_analyse_returns"));
});

test("Shopify-backed deterministic beliefs map to evidence requirements", () => {
  const shopifyBeliefs = DETERMINISTIC_BELIEF_REGISTRY.filter((definition) =>
    Array.isArray(definition.dependencies) &&
    definition.dependencies.some((dependency) =>
      [
        "orders",
        "line_items",
        "products",
        "variants",
        "inventory_levels",
        "refunds",
        "customer_identities",
      ].includes(dependency),
    ),
  );
  assert.ok(shopifyBeliefs.length > 50);

  for (const definition of shopifyBeliefs) {
    const evidence = evidenceRequirementsForBelief(definition.key, definition);
    assert.ok(evidence.length > 0, `${definition.key} has no Shopify evidence mapping`);
    for (const evidenceId of evidence) {
      assert.ok(getShopifyEvidenceRequirement(evidenceId), `${definition.key} references unknown evidence ${evidenceId}`);
    }
  }
});
