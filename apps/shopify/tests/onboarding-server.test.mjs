import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  completePlanOnboarding,
  recordFurthestOnboardingStep,
  skipOnboarding,
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

    // Advance: connect -> context.
    await setMetadata(prisma, shop.id, { furthestStep: "connect", keep: "me" });
    await recordFurthestOnboardingStep(prisma, {
      shopId: shop.id,
      step: "context",
    });
    let meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "context", "advances to a later step");
    assert.equal(meta.keep, "me", "reads fresh + preserves other metadata keys");

    // Advance further: context -> action.
    await recordFurthestOnboardingStep(prisma, { shopId: shop.id, step: "action" });
    meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "action");

    // Monotonic: a backward step is ignored.
    await recordFurthestOnboardingStep(prisma, { shopId: shop.id, step: "insight" });
    meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "action", "never regresses the furthest step");

    // Unknown step: no-op, no bad value written.
    await recordFurthestOnboardingStep(prisma, {
      shopId: shop.id,
      step: "not-a-step",
    });
    meta = (await readMetadata(prisma, shop.id)).onboardingMetadata;
    assert.equal(readFurthestStep(meta), "action", "ignores an unknown step");
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
      step: "app",
    });
    assert.equal(result, null);
  } finally {
    await prisma.$disconnect();
  }
});

test("skipOnboarding marks the shop onboarded, tagged as a skip", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the skip test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const shopDomain = `onbsvc-skip-${suffix}.myshopify.com`;
  try {
    const { shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-${suffix}`,
      scopes: ["read_products"],
    });
    await setMetadata(prisma, shop.id, { furthestStep: "channels", keep: "me" });

    await skipOnboarding(prisma, { shopId: shop.id });

    const { onboardingMetadata, onboardingCompletedAt } = await readMetadata(
      prisma,
      shop.id,
    );
    assert.ok(onboardingCompletedAt instanceof Date, "completion timestamp set");
    assert.equal(onboardingMetadata.completedSource, "skipped");
    assert.equal(onboardingMetadata.completedStep, "skipped");
    assert.equal(onboardingMetadata.keep, "me", "existing metadata preserved");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
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
      onboardingMetadata.furthestStep,
      "plan",
      "legacy metadata stays preserved through completion",
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});
