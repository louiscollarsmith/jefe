import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { wireClearanceExecution } from "../app/lib/actions/wire-clearance-execution.server.js";

// Integration coverage for the go-live seam against the REAL DB (Prisma types, JSONB
// round-trip, the ledger's unique/cascade constraints) — complements the mock-prisma
// unit test. DB-gated: skips without DATABASE_URL, runs in the gate when the DB is up.
const databaseUrl = process.env.DATABASE_URL;

async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  }
}

/** Mock gql client (the deps.createGqlClient seam) over a shared price map. */
function makeGqlDep(priceByVariant) {
  const client = {
    request: async (query, variables) => {
      if (query.includes("productVariantsBulkUpdate")) {
        const v = variables.variants[0];
        priceByVariant.set(v.id, Number(v.price));
        return { productVariantsBulkUpdate: { productVariants: [{ id: v.id, price: v.price }], userErrors: [] } };
      }
      const id = variables.id;
      const price = priceByVariant.get(id);
      return { productVariant: price == null ? null : { id, price: String(price), product: { id: `prod-${id}` } } };
    },
  };
  return () => client;
}

async function seedProposed(prisma, { resolvedMode = "approve", merchantSetting = "approve_execute" } = {}) {
  const runId = randomUUID();
  const merchantId = randomUUID();
  const shopId = randomUUID();
  const variantId = `gid://shopify/ProductVariant/DBTEST-${runId.slice(0, 8)}`;
  const preview = {
    changes: [{ variantId, title: "DB-test Widget", fromPrice: 20, toPrice: 14, floorPrice: 12, discountPercent: 30 }],
    variantCount: 1,
    maxDiscountPercent: 30,
    refused: [],
    reversibilityPlan: [{ variantId, restorePrice: 20 }],
  };
  const row = await prisma.actionExecution.create({
    data: {
      runId, merchantId, shopId,
      actionType: "price_markdown", actionKind: "dead_stock_clearance",
      status: "proposed", merchantSetting, resolvedMode,
      eligibility: { reversible: true, withinCap: true, confident: true, autoEligible: resolvedMode === "auto" },
      confidence: 1, preview,
      caps: { maxVariants: 50, maxDiscountPercent: 60, minConfidence: 0.9 },
    },
    select: { id: true },
  });
  return { runId, merchantId, shopId, variantId, id: row.id };
}

test("dark-path: flag OFF records proposed→approved, writes nothing (real DB)", async (t) => {
  if (!databaseUrl) return t.skip("DATABASE_URL is required for the clearance execution DB test");
  const prisma = new PrismaClient();
  let seeded;
  try {
    seeded = await seedProposed(prisma);
    const res = await withEnv("CLEARANCE_EXECUTE_ENABLED", undefined, () =>
      wireClearanceExecution(prisma, { shop: "db-test.myshopify.com" }, {
        merchantId: seeded.merchantId, actionRunId: seeded.runId, mode: "approve",
      }),
    );
    assert.equal(res.executed, false);
    assert.equal(res.reason, "execution_disabled");
    assert.equal(res.status, "approved");
    const row = await prisma.actionExecution.findUnique({ where: { runId: seeded.runId }, select: { status: true, approvedBy: true, approvedAt: true } });
    assert.equal(row.status, "approved");
    assert.equal(row.approvedBy, seeded.merchantId);
    assert.ok(row.approvedAt != null);
    assert.equal(await prisma.actionExecutionWrite.count({ where: { executionId: seeded.id } }), 0);
  } finally {
    if (seeded) await prisma.actionExecution.deleteMany({ where: { runId: seeded.runId } });
    await prisma.$disconnect();
  }
});

test("flag ON: executes via injected client, writes the ledger, idempotent re-fire (real DB)", async (t) => {
  if (!databaseUrl) return t.skip("DATABASE_URL is required for the clearance execution DB test");
  const prisma = new PrismaClient();
  const shop = "db-test-on.myshopify.com";
  const sessionId = `dbtest-${randomUUID()}`;
  let seeded;
  try {
    seeded = await seedProposed(prisma);
    await prisma.session.create({ data: { id: sessionId, shop, state: "test", isOnline: false, accessToken: "test-token" } });
    const prices = new Map([[seeded.variantId, 20]]); // live == fromPrice → CAS passes
    const res = await withEnv("CLEARANCE_EXECUTE_ENABLED", "true", () =>
      wireClearanceExecution(prisma, { shop }, {
        merchantId: seeded.merchantId, actionRunId: seeded.runId, mode: "approve",
      }, { createGqlClient: makeGqlDep(prices) }),
    );
    assert.equal(res.executed, true);
    assert.equal(res.status, "applied");
    assert.equal(res.appliedCount, 1);
    assert.equal(prices.get(seeded.variantId), 14); // the (mock) store was written
    const row = await prisma.actionExecution.findUnique({ where: { runId: seeded.runId }, select: { status: true } });
    assert.equal(row.status, "applied");
    const writes = await prisma.actionExecutionWrite.findMany({ where: { executionId: seeded.id } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].status, "applied");

    // Re-fire the same runId — idempotent, no double write.
    const again = await withEnv("CLEARANCE_EXECUTE_ENABLED", "true", () =>
      wireClearanceExecution(prisma, { shop }, {
        merchantId: seeded.merchantId, actionRunId: seeded.runId, mode: "approve",
      }, { createGqlClient: makeGqlDep(prices) }),
    );
    assert.equal(again.executed, false);
    assert.equal(again.reason, "already_applied");
    assert.equal(await prisma.actionExecutionWrite.count({ where: { executionId: seeded.id } }), 1);
  } finally {
    if (seeded) await prisma.actionExecution.deleteMany({ where: { runId: seeded.runId } });
    await prisma.session.deleteMany({ where: { id: sessionId } });
    await prisma.$disconnect();
  }
});

test("flag ON: mode=auto refused when the dial didn't resolve to auto — row untouched (real DB)", async (t) => {
  if (!databaseUrl) return t.skip("DATABASE_URL is required for the clearance execution DB test");
  const prisma = new PrismaClient();
  let seeded;
  try {
    seeded = await seedProposed(prisma, { resolvedMode: "approve" });
    const res = await withEnv("CLEARANCE_EXECUTE_ENABLED", "true", () =>
      wireClearanceExecution(prisma, { shop: "db-test.myshopify.com" }, {
        merchantId: seeded.merchantId, actionRunId: seeded.runId, mode: "auto",
      }, { createGqlClient: makeGqlDep(new Map()) }),
    );
    assert.equal(res.reason, "auto_not_authorized");
    const row = await prisma.actionExecution.findUnique({ where: { runId: seeded.runId }, select: { status: true } });
    assert.equal(row.status, "proposed"); // never touched
    assert.equal(await prisma.actionExecutionWrite.count({ where: { executionId: seeded.id } }), 0);
  } finally {
    if (seeded) await prisma.actionExecution.deleteMany({ where: { runId: seeded.runId } });
    await prisma.$disconnect();
  }
});
