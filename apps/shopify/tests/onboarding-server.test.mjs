import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  completePlanOnboarding,
  recordFurthestOnboardingStep,
} from "../app/services/onboarding.server.js";
import { readFurthestStep } from "../app/lib/onboarding/steps.js";
import { ensureShopifyTenant } from "../app/lib/ingestion/shopify/tenant.server.js";

const databaseUrl = process.env.DATABASE_URL;

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}

/** Set a shop's onboardingMetadata directly (test fixture). */
async function setMetadata(prisma, shopId, metadata) {
  await prisma.shop.update({
    where: { id: shopId },
    data: { onboardingMetadata: metadata },
  });
}

async function readMetadata(prisma, shopId) {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { onboardingMetadata: true, onboardingCompletedAt: true },
  });
  return shop;
}

test("recordFurthestOnboardingStep: advance / monotonic / unknown / preserve", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the onboarding persistence test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const shopDomain = `onbsvc-${suffix}.myshopify.com`;
  try {
    const { shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-${suffix}`,
      scopes: ["read_products"],
    });

    // Advance: connect -> insights.
    await setMetadata(prisma, shop.id, { furthestStep: "connect", keep: "me" });
    await recordFurthestOnboardingStep(prisma, {
      shopId: shop.id,
      step: "insights",
    });
    let meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "insights", "advances to a later step");
    assert.equal(meta.keep, "me", "reads fresh + preserves other metadata keys");

    // Advance further: insights -> plan.
    await recordFurthestOnboardingStep(prisma, { shopId: shop.id, step: "plan" });
    meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "plan");

    // Monotonic: a backward step is ignored (plan stays plan, not goals).
    await recordFurthestOnboardingStep(prisma, { shopId: shop.id, step: "goals" });
    meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "plan", "never regresses the furthest step");

    // Unknown step: no-op, no bad value written.
    await recordFurthestOnboardingStep(prisma, {
      shopId: shop.id,
      step: "not-a-step",
    });
    meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "plan", "ignores an unknown step");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("recordFurthestOnboardingStep: no-op on a missing shop (never throws)", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for this test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const result = await recordFurthestOnboardingStep(prisma, {
      shopId: "00000000-0000-0000-0000-000000000000",
      step: "plan",
    });
    assert.equal(result, null);
  } finally {
    await prisma.$disconnect();
  }
});

test("completePlanOnboarding stamps completion and preserves furthest step", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the completion test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const shopDomain = `onbsvc-done-${suffix}.myshopify.com`;
  try {
    const { shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-${suffix}`,
      scopes: ["read_products"],
    });
    await setMetadata(prisma, shop.id, { furthestStep: "plan" });

    await completePlanOnboarding(prisma, { shopId: shop.id });

    const { onboardingMetadata, onboardingCompletedAt } = await readMetadata(
      prisma,
      shop.id,
    );
    assert.ok(onboardingCompletedAt instanceof Date, "completion timestamp set");
    assert.equal(onboardingMetadata.completedStep, "plan");
    assert.equal(
      readFurthestStep(onboardingMetadata),
      "plan",
      "existing metadata (furthestStep) preserved through completion",
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});
