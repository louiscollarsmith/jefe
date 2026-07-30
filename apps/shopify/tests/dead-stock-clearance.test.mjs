import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  buildDeadStockClearanceProposal,
  sizeClearanceMarkdowns,
  toClearanceRecommendation,
} from "../app/lib/actions/dead-stock-clearance.server.js";

const databaseUrl = process.env.DATABASE_URL;

function uniqueSuffix() {
  return `clear-${process.hrtime.bigint()}`;
}

test("sizeClearanceMarkdowns floors markdowns at cost and never proposes below cost", () => {
  const proposal = sizeClearanceMarkdowns([
    // Room to discount: £100 price, £40 cost → 30% off = £70, well above the floor.
    { productId: "p1", variantId: "v1", title: "Alpha", unitsOnHand: 10, currentPrice: 100, unitCost: 40 },
    // Floor bites: £50 price, £45 cost → 30% off = £35 < £45, so floored to £45.
    { productId: "p2", variantId: "v2", title: "Beta", unitsOnHand: 4, currentPrice: 50, unitCost: 45 },
    // Already below cost: £30 price, £40 cost → excluded (clearing is a loss).
    { productId: "p3", variantId: "v3", title: "Gamma", unitsOnHand: 5, currentPrice: 30, unitCost: 40 },
  ]);

  assert.equal(proposal.deadStockVariantCount, 2);
  assert.equal(proposal.belowCostCount, 1);

  const alpha = proposal.items.find((item) => item.variantId === "v1");
  assert.equal(alpha.suggestedPrice, 70);
  assert.equal(alpha.discountPercent, 30);
  assert.equal(alpha.trappedCapital, 400); // 10 × 40
  assert.equal(alpha.projectedRecovery, 700); // 10 × 70

  const beta = proposal.items.find((item) => item.variantId === "v2");
  assert.equal(beta.suggestedPrice, 45); // floored at cost, NOT £35
  assert.equal(beta.discountPercent, 10); // (50 − 45) / 50
  assert.ok(beta.suggestedPrice >= beta.unitCost); // the safety invariant

  assert.equal(proposal.items[0].variantId, "v1"); // sorted by trapped capital desc
  assert.equal(proposal.totalTrappedCapital, 580); // 400 + 180
});

test("sizeClearanceMarkdowns skips items missing units, price or cost", () => {
  const proposal = sizeClearanceMarkdowns([
    { productId: "p", variantId: "a", unitsOnHand: 0, currentPrice: 100, unitCost: 40 }, // no stock
    { productId: "p", variantId: "b", unitsOnHand: 5, currentPrice: 0, unitCost: 40 }, // no price
    { productId: "p", variantId: "c", unitsOnHand: 5, currentPrice: 100 }, // no cost
  ]);
  assert.equal(proposal.deadStockVariantCount, 0);
  assert.equal(proposal.totalTrappedCapital, 0);
});

test("buildDeadStockClearanceProposal finds only in-stock, unsold, costed variants", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for clearance proposal DB test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  try {
    const merchant = await prisma.merchant.create({
      data: {
        name: `Clearance ${suffix}`,
        shops: { create: { shopDomain: `clear-${suffix}.myshopify.com`, rawPayload: {} } },
      },
      include: { shops: true },
    });
    const shop = merchant.shops[0];
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `prod-${suffix}`,
        title: "Test Product",
        status: "ACTIVE",
        variants: {
          create: [
            { merchantId: merchant.id, shopId: shop.id, externalId: `dead-${suffix}`, sku: "DEAD", price: "100.00", unitCost: "40.00" },
            { merchantId: merchant.id, shopId: shop.id, externalId: `sold-${suffix}`, sku: "SOLD", price: "100.00", unitCost: "40.00" },
            { merchantId: merchant.id, shopId: shop.id, externalId: `nostock-${suffix}`, sku: "NOSTOCK", price: "100.00", unitCost: "40.00" },
            { merchantId: merchant.id, shopId: shop.id, externalId: `nocost-${suffix}`, sku: "NOCOST", price: "100.00" },
          ],
        },
      },
      include: { variants: true },
    });
    const byExt = new Map(product.variants.map((v) => [v.externalId, v]));
    const dead = byExt.get(`dead-${suffix}`);
    const sold = byExt.get(`sold-${suffix}`);
    const nostock = byExt.get(`nostock-${suffix}`);
    const nocost = byExt.get(`nocost-${suffix}`);

    await prisma.inventoryLevel.createMany({
      data: [
        { merchantId: merchant.id, shopId: shop.id, variantId: dead.id, inventoryItemExternalId: `ii-dead-${suffix}`, locationExternalId: "loc-1", available: 10 },
        { merchantId: merchant.id, shopId: shop.id, variantId: sold.id, inventoryItemExternalId: `ii-sold-${suffix}`, locationExternalId: "loc-1", available: 10 },
        { merchantId: merchant.id, shopId: shop.id, variantId: nostock.id, inventoryItemExternalId: `ii-nostock-${suffix}`, locationExternalId: "loc-1", available: 0 },
        { merchantId: merchant.id, shopId: shop.id, variantId: nocost.id, inventoryItemExternalId: `ii-nocost-${suffix}`, locationExternalId: "loc-1", available: 10 },
      ],
    });

    // A recent order that sold the "sold" variant → excludes it from dead stock.
    await prisma.order.create({
      data: {
        merchantId: merchant.id,
        shopId: shop.id,
        externalId: `order-${suffix}`,
        currency: "GBP",
        totalPrice: "100.00",
        processedAt: new Date(),
        lineItems: {
          create: {
            merchantId: merchant.id,
            shopId: shop.id,
            productId: product.id,
            variantId: sold.id,
            externalId: `li-${suffix}`,
            quantity: 1,
            unitPrice: "100.00",
            totalPrice: "100.00",
          },
        },
      },
    });

    const proposal = await buildDeadStockClearanceProposal(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });

    // Only "dead" qualifies: sold (recent sale), nostock (0 units) and nocost
    // (no cost to floor) are all correctly excluded.
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.deadStockVariantCount, 1);
    assert.equal(proposal.items[0].variantId, dead.id);
    assert.equal(proposal.items[0].suggestedPrice, 70);
    assert.equal(proposal.items[0].trappedCapital, 400);
  } finally {
    await prisma.merchant.deleteMany({ where: { name: `Clearance ${suffix}` } });
    await prisma.$disconnect();
  }
});

test("toClearanceRecommendation shapes a proposal into an advisory recommendation (top 3, advisory-only)", () => {
  const proposal = {
    status: "proposed",
    windowDays: 90,
    deadStockVariantCount: 4,
    belowCostCount: 1,
    totalTrappedCapital: 5000,
    totalProjectedRecovery: 3200,
    items: [
      { variantId: "v1", title: "A", unitsOnHand: 10, currentPrice: 200, suggestedPrice: 140, discountPercent: 30, trappedCapital: 2000 },
      { variantId: "v2", title: "B", unitsOnHand: 5, currentPrice: 100, suggestedPrice: 70, discountPercent: 30, trappedCapital: 1500 },
      { variantId: "v3", title: "C", unitsOnHand: 8, currentPrice: 50, suggestedPrice: 35, discountPercent: 30, trappedCapital: 1000 },
      { variantId: "v4", title: "D", unitsOnHand: 3, currentPrice: 40, suggestedPrice: 28, discountPercent: 30, trappedCapital: 500 },
    ],
  };
  const rec = toClearanceRecommendation(proposal);
  assert.equal(rec.status, "available");
  assert.equal(rec.kind, "dead_stock_clearance");
  assert.equal(rec.variantCount, 4);
  assert.equal(rec.trappedCapital, 5000);
  assert.equal(rec.projectedRecovery, 3200);
  assert.equal(rec.belowCostCount, 1);
  assert.equal(rec.executable, false); // advisory only — surfacing can never trigger a write
  assert.equal(rec.topItems.length, 3); // headline items, capped
  assert.equal(rec.topItems[0].variantId, "v1");
});

test("toClearanceRecommendation returns no_opportunity when there is nothing to clear", () => {
  assert.equal(toClearanceRecommendation({ status: "no_dead_stock", windowDays: 90, items: [] }).status, "no_opportunity");
  assert.equal(
    toClearanceRecommendation({ status: "proposed", windowDays: 90, deadStockVariantCount: 0, items: [] }).status,
    "no_opportunity",
  );
  assert.equal(toClearanceRecommendation(null).status, "no_opportunity");
});
