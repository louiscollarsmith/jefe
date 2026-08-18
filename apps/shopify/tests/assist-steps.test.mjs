import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAssistArtifactForChat,
  isAssistStepArtifact,
} from "../app/lib/actions/assist-steps/format.server.js";
import { runInventoryReviewAssist } from "../app/lib/actions/assist-steps/handlers/inventory-review.server.js";
import { runSupplierEmailDraftAssist } from "../app/lib/actions/assist-steps/handlers/supplier-email-draft.server.js";
import { resolveAssistHandler } from "../app/lib/actions/assist-steps/registry.server.js";
import { recommendedPurchaseUnits } from "../app/lib/actions/assist-steps/evidence.server.js";

test("inventory review assist produces a merchant-visible artifact", async () => {
  const result = await runInventoryReviewAssist({
    step: { title: "Review low-cover inventory items" },
    lowCoverProducts: [
      {
        title: "Morgon Cote du Py",
        available: 3,
        dailyVelocity: 0.2,
        daysOfCover: 15,
        recommendedUnitsAtDefaultCover: 21,
      },
    ],
  });

  assert.equal(isAssistStepArtifact(result.progress), true);
  assert.equal(result.progress.artifactType, "inventory_review");
  assert.match(result.chatReply ?? "", /Morgon Cote du Py/);
  assert.match(result.chatReply ?? "", /21 units/);
});

test("supplier draft assist uses prior inventory review items", async () => {
  const result = await runSupplierEmailDraftAssist({
    step: { title: "Draft supplier replenishment communication" },
    priorStepArtifacts: [
      {
        progress: {
          artifactType: "inventory_review",
          items: [
            {
              title: "Pear Skin Sipon",
              recommendedUnitsAtDefaultCover: 12,
            },
          ],
        },
      },
    ],
  });

  assert.equal(result.progress.artifactType, "supplier_email_draft");
  assert.match(result.progress.body, /Pear Skin Sipon/);
  assert.match(result.progress.body, /12 units/);
});

test("assist handler resolves from capability ref and step title", () => {
  assert.equal(
    resolveAssistHandler({ capabilityRef: "assist:inventory_review" }),
    resolveAssistHandler({ title: "Review low-cover inventory items" }),
  );
  assert.equal(
    resolveAssistHandler({ capabilityRef: "assist:supplier_email_draft" }),
    resolveAssistHandler({ title: "Draft supplier replenishment communication" }),
  );
  assert.equal(
    resolveAssistHandler({ capabilityRef: "assist:listing_copy_review" }),
    resolveAssistHandler({ title: "Categorise unassigned products" }),
  );
});

test("recommended purchase units follow stock-cover formula", () => {
  assert.equal(
    recommendedPurchaseUnits({ available: 3, dailyVelocity: 0.2 }, 120),
    21,
  );
});

test("formatAssistArtifactForChat rejects empty artifacts", () => {
  assert.equal(isAssistStepArtifact({ artifactType: "inventory_review" }), false);
  assert.match(
    formatAssistArtifactForChat({
      artifactType: "inventory_review",
      summary: "Reviewed 1 product.",
      items: [{ title: "Wine A", daysOfCover: 12, recommendedUnitsAtDefaultCover: 8 }],
      targetCoverDays: 120,
    }) ?? "",
    /Reviewed 1 product/,
  );
  assert.match(
    formatAssistArtifactForChat({
      artifactType: "inventory_review",
      summary: "Reviewed 1 product.",
      items: [{ title: "Wine A", daysOfCover: 12, recommendedUnitsAtDefaultCover: 8 }],
      targetCoverDays: 120,
    }) ?? "",
    /Wine A/,
  );
});
