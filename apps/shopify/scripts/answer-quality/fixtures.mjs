// @ts-check
//
// Store archetypes for the answer-quality harness.
//
// Two deliberately DIFFERENT kinds of business, because the failure mode this harness
// exists to catch is generic advice. A DTC skincare brand and a garden centre running
// Shopify POS should not receive interchangeable answers; if they do, that is a finding,
// not a coincidence (the founder's "agnostic in reach, specific in judgement" principle).
//
// Everything here is INVENTED. No real merchant, customer, product or brand appears, and
// nothing is copied out of a production database — a harness fixture that carries real
// trade would put real business detail in the repo. Emails are reserved-domain synthetic
// and hashed the way ingestion hashes them.
//
// Records are written into the SAME canonical tables Shopify ingestion writes to, then the
// REAL derivation pipeline (refreshBeliefs) produces the beliefs. Nothing about a belief is
// hand-authored — otherwise the harness would grade Jefe against a fiction of its own.

import { createHash } from "node:crypto";

/** Deterministic PRNG (mulberry32) — same seed, same store, every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} value */
const money = (value) => Number(value.toFixed(2));

/** Hash a synthetic email the way ingestion does, so identity rows look native. */
const emailHash = (email) => createHash("sha256").update(email.toLowerCase()).digest("hex");

/**
 * @typedef {object} Archetype
 * @property {string} key
 * @property {string} name
 * @property {string} shopDomain
 * @property {string} currency
 * @property {string} description   What a human would say this business IS.
 * @property {number} seed
 * @property {number} orderCount
 * @property {number} days          Days of order history to generate.
 * @property {number} costCoverage  Share of variants carrying a unit cost (0..1).
 * @property {number} posShare      Share of orders taken through Shopify POS (0..1).
 * @property {Array<{ title: string; type: string; vendor: string; price: number; cost: number; stock: number; weight: number; returnRate?: number }>} catalog
 */

/** @type {Archetype[]} */
export const ARCHETYPES = [
  {
    key: "dtc-skincare",
    name: "Bramble & Vine",
    shopDomain: "bramble-and-vine.myshopify.com",
    currency: "GBP",
    description:
      "Online-only DTC skincare brand. One hero serum carries the store, subscriptions-adjacent repeat buying, costs are tracked on nearly everything.",
    seed: 20260812,
    orderCount: 240,
    days: 120,
    costCoverage: 0.92,
    posShare: 0,
    catalog: [
      { title: "Rosehip Renewal Serum", type: "Serum", vendor: "Bramble & Vine", price: 42, cost: 11.5, stock: 38, weight: 34 },
      { title: "Oat Milk Cleanser", type: "Cleanser", vendor: "Bramble & Vine", price: 24, cost: 7.2, stock: 120, weight: 22 },
      { title: "Overnight Ceramide Mask", type: "Mask", vendor: "Bramble & Vine", price: 36, cost: 12.8, stock: 9, weight: 14, returnRate: 0.14 },
      { title: "Hyaluronic Mist", type: "Toner", vendor: "Bramble & Vine", price: 19, cost: 5.4, stock: 210, weight: 12 },
      { title: "Discovery Set", type: "Bundle", vendor: "Bramble & Vine", price: 55, cost: 21, stock: 47, weight: 10 },
      { title: "Bamboo Face Cloth", type: "Accessory", vendor: "Hedgerow Supply", price: 8, cost: 2.1, stock: 340, weight: 8 },
    ],
  },
  {
    key: "garden-centre-pos",
    name: "Thornbury Garden Centre",
    shopDomain: "thornbury-garden.myshopify.com",
    currency: "GBP",
    description:
      "Bricks-and-mortar garden centre with a Shopify POS till and a small online shop. Heavily seasonal, bulky low-margin goods, almost no cost prices entered.",
    seed: 20260813,
    orderCount: 300,
    days: 120,
    costCoverage: 0.08,
    posShare: 0.72,
    catalog: [
      { title: "Peat-Free Multipurpose Compost 50L", type: "Growing Media", vendor: "Thornbury", price: 9.5, cost: 6.1, stock: 480, weight: 40 },
      { title: "Bare Root Hedging — Hawthorn", type: "Plants", vendor: "Thornbury", price: 2.4, cost: 0.9, stock: 1500, weight: 30 },
      { title: "Terracotta Pot 40cm", type: "Pots", vendor: "Clayfield", price: 28, cost: 16, stock: 62, weight: 12, returnRate: 0.09 },
      { title: "Wildflower Seed Mix", type: "Seeds", vendor: "Meadowline", price: 6.5, cost: 2.2, stock: 240, weight: 18 },
      { title: "Garden Fork — Stainless", type: "Tools", vendor: "Rookery Tools", price: 46, cost: 27, stock: 18, weight: 6 },
      { title: "Winter Bird Food 12kg", type: "Wildlife", vendor: "Meadowline", price: 22, cost: 13.5, stock: 7, weight: 20 },
    ],
  },
];

/** @param {string} key */
export function archetype(key) {
  const found = ARCHETYPES.find((item) => item.key === key);
  if (!found) throw new Error(`Unknown archetype: ${key}. Known: ${ARCHETYPES.map((a) => a.key).join(", ")}`);
  return found;
}

/**
 * Generate the canonical records for an archetype. Pure — no database, no clock beyond
 * the caller-supplied `asOf`, so a run is reproducible and diffable.
 *
 * @param {Archetype} spec
 * @param {Date} asOf
 */
export function generateStore(spec, asOf) {
  const random = rng(spec.seed);
  const products = spec.catalog.map((item, index) => ({
    externalId: `gid://synthetic/Product/${spec.key}/${index + 1}`,
    title: item.title,
    handle: item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    status: "active",
    vendor: item.vendor,
    productType: item.type,
    variant: {
      externalId: `gid://synthetic/Variant/${spec.key}/${index + 1}`,
      sku: `${spec.key.toUpperCase().slice(0, 3)}-${String(index + 1).padStart(3, "0")}`,
      price: item.price,
      // Cost coverage is a real, load-bearing difference between these two businesses:
      // the garden centre genuinely cannot be given margin advice, and Jefe must say so
      // rather than inventing a number.
      unitCost: index / spec.catalog.length < spec.costCoverage ? item.cost : null,
      inventoryItemExternalId: `gid://synthetic/InventoryItem/${spec.key}/${index + 1}`,
      available: item.stock,
    },
    weight: item.weight,
    returnRate: item.returnRate ?? 0.02,
  }));

  const totalWeight = products.reduce((sum, product) => sum + product.weight, 0);
  /** Pick a product by catalogue weight, so one hero SKU dominates as it would in life. */
  const pickProduct = () => {
    let ticket = random() * totalWeight;
    for (const product of products) {
      ticket -= product.weight;
      if (ticket <= 0) return product;
    }
    return products[products.length - 1];
  };

  const customerPool = Array.from({ length: Math.round(spec.orderCount * 0.62) }, (_, index) => {
    const email = `synthetic.customer.${spec.key}.${String(index + 1).padStart(4, "0")}@example.com`;
    return { externalId: `gid://synthetic/Customer/${spec.key}/${index + 1}`, email };
  });

  const orders = [];
  const refunds = [];
  for (let index = 0; index < spec.orderCount; index += 1) {
    // Recent-weighted so a trailing-90d window is denser than the tail, and a
    // trend derivation has something real to find.
    const ageDays = Math.floor(spec.days * Math.pow(random(), 1.4));
    const placedAt = new Date(asOf.getTime() - ageDays * 24 * 60 * 60 * 1000);
    const customer = customerPool[Math.floor(random() * customerPool.length)];
    const lineCount = 1 + (random() < 0.34 ? 1 : 0) + (random() < 0.12 ? 1 : 0);
    const lines = [];
    for (let line = 0; line < lineCount; line += 1) {
      const product = pickProduct();
      const quantity = 1 + (random() < 0.22 ? 1 : 0);
      lines.push({
        product,
        quantity,
        unitPrice: product.variant.price,
        totalPrice: money(product.variant.price * quantity),
      });
    }
    const subtotal = money(lines.reduce((sum, line) => sum + line.totalPrice, 0));
    const discount = random() < 0.28 ? money(subtotal * (random() < 0.5 ? 0.1 : 0.2)) : 0;
    const shipping = spec.posShare > random() ? 0 : money(subtotal > 60 ? 0 : 3.95);
    const tax = money((subtotal - discount) * 0.2);
    const isPos = random() < spec.posShare;
    orders.push({
      externalId: `gid://synthetic/Order/${spec.key}/${index + 1}`,
      orderName: `#${1000 + index}`,
      customerExternalId: customer.externalId,
      customerEmail: customer.email,
      financialStatus: "paid",
      fulfillmentStatus: "fulfilled",
      sourceName: isPos ? "pos" : "web",
      shippingCountry: isPos ? "GB" : random() < 0.12 ? "IE" : "GB",
      currency: spec.currency,
      subtotalPrice: subtotal,
      totalDiscount: discount,
      totalTax: tax,
      totalShipping: shipping,
      totalPrice: money(subtotal - discount + tax + shipping),
      processedAt: placedAt,
      lines,
    });

    const returnChance = lines[0].product.returnRate;
    if (random() < returnChance) {
      refunds.push({
        orderIndex: index,
        externalId: `gid://synthetic/Refund/${spec.key}/${index + 1}`,
        amount: money(lines[0].totalPrice),
        processedAt: new Date(placedAt.getTime() + 6 * 24 * 60 * 60 * 1000),
      });
    }
  }

  // Customer identities are derived from the orders, not invented alongside them — a
  // roster that disagrees with the orders produced false repeat-rate beliefs before.
  const identityMap = new Map();
  for (const order of orders) {
    const existing = identityMap.get(order.customerEmail) ?? {
      email: order.customerEmail,
      externalId: order.customerExternalId,
      orderCount: 0,
      totalSpend: 0,
      firstSeenOrderAt: order.processedAt,
      lastOrderAt: order.processedAt,
    };
    existing.orderCount += 1;
    existing.totalSpend = money(existing.totalSpend + order.totalPrice);
    if (order.processedAt < existing.firstSeenOrderAt) existing.firstSeenOrderAt = order.processedAt;
    if (order.processedAt > existing.lastOrderAt) existing.lastOrderAt = order.processedAt;
    identityMap.set(order.customerEmail, existing);
  }
  const identities = [...identityMap.values()].map((identity) => ({
    ...identity,
    emailHash: emailHash(identity.email),
    maskedEmail: identity.email.replace(/^(.).*(@.*)$/, "$1***$2"),
    averageOrderValue: money(identity.totalSpend / identity.orderCount),
  }));

  return { products, orders, refunds, identities };
}
