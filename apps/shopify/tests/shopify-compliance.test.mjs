import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { processShopifyWebhook } from "../app/lib/ingestion/shopify/webhooks.server.js";
import {
  hashEmail,
  normalizeEmail,
} from "../app/lib/ingestion/shopify/canonical.server.js";

const databaseUrl = process.env.DATABASE_URL;

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}

function client() {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

/**
 * A REST-shaped orders/create payload seeded with customer PII in every place
 * the app stores it (top level, customer object, addresses, client details,
 * note attributes). `name` is the order NUMBER and must survive redaction.
 */
function mockOrderPayload({ orderId, customerId, email, firstName, lastName, orderName }) {
  return {
    id: Number(orderId),
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    name: orderName,
    email,
    contact_email: email,
    phone: "+15550000001",
    financial_status: "paid",
    fulfillment_status: "fulfilled",
    currency: "GBP",
    subtotal_price: "42.00",
    total_price: "42.00",
    total_discounts: "0.00",
    total_tax: "0.00",
    total_shipping_price_set: { shop_money: { amount: "0.00", currency_code: "GBP" } },
    created_at: "2026-07-20T10:00:00Z",
    processed_at: "2026-07-20T10:05:00Z",
    updated_at: "2026-07-20T10:10:00Z",
    browser_ip: "203.0.113.7",
    client_details: { browser_ip: "203.0.113.7", user_agent: "Mozilla/5.0" },
    customer: {
      id: Number(customerId),
      admin_graphql_api_id: `gid://shopify/Customer/${customerId}`,
      email,
      first_name: firstName,
      last_name: lastName,
      phone: "+15550000001",
      default_address: {
        address1: "1 Test Street",
        city: "London",
        zip: "E1 6AN",
        country: "United Kingdom",
        phone: "+15550000001",
      },
    },
    billing_address: {
      first_name: firstName,
      last_name: lastName,
      name: `${firstName} ${lastName}`,
      address1: "1 Test Street",
      city: "London",
      zip: "E1 6AN",
      phone: "+15550000001",
    },
    shipping_address: {
      first_name: firstName,
      last_name: lastName,
      name: `${firstName} ${lastName}`,
      address1: "1 Test Street",
      city: "London",
      zip: "E1 6AN",
      phone: "+15550000001",
    },
    note_attributes: [
      { name: "jefe_customer_email", value: email },
      { name: "gift_wrap", value: "yes" },
    ],
    line_items: [
      {
        id: Number(`${orderId}01`),
        admin_graphql_api_id: `gid://shopify/LineItem/${orderId}01`,
        sku: "SKU-1",
        title: "Test Item",
        quantity: 1,
        price: "42.00",
      },
    ],
  };
}

async function ingestOrder(prisma, { shopDomain, order, webhookId }) {
  return processShopifyWebhook(prisma, {
    rawBody: JSON.stringify(order),
    topic: "orders/create",
    shopDomain,
    webhookId,
    triggeredAt: "2026-07-20T10:10:00Z",
    apiVersion: "2026-07",
  });
}

async function orderLedgerFor(prisma, shopId, orderGid) {
  const events = await prisma.ledgerEvent.findMany({
    where: { shopId, eventType: "shopify.webhook.orders/create" },
  });
  return events.find((event) => event.rawPayload?.admin_graphql_api_id === orderGid);
}

test("customers/redact erases exactly one customer and leaves others untouched", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for compliance tests");
    return;
  }

  const prisma = client();
  const suffix = uniqueSuffix();
  const shopDomain = `gdpr-redact-${suffix}.myshopify.com`;
  const aliceEmail = `alice-${suffix}@example.com`;
  const bobEmail = `bob-${suffix}@example.com`;
  const aliceOrderId = `700100${suffix.replace(/\D/g, "").slice(0, 6)}1`;
  const bobOrderId = `700100${suffix.replace(/\D/g, "").slice(0, 6)}2`;

  try {
    await ingestOrder(prisma, {
      shopDomain,
      webhookId: `wh-a-${suffix}`,
      order: mockOrderPayload({
        orderId: aliceOrderId,
        customerId: `900${suffix.replace(/\D/g, "").slice(0, 6)}1`,
        email: aliceEmail,
        firstName: "Alice",
        lastName: "Anderson",
        orderName: "#1001",
      }),
    });
    await ingestOrder(prisma, {
      shopDomain,
      webhookId: `wh-b-${suffix}`,
      order: mockOrderPayload({
        orderId: bobOrderId,
        customerId: `900${suffix.replace(/\D/g, "").slice(0, 6)}2`,
        email: bobEmail,
        firstName: "Bob",
        lastName: "Baker",
        orderName: "#1002",
      }),
    });

    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    });
    const aliceHash = hashEmail(normalizeEmail(aliceEmail));
    const bobHash = hashEmail(normalizeEmail(bobEmail));

    // Preconditions: both identities exist, both order ledgers carry the email.
    assert.equal(
      await prisma.customerIdentity.count({
        where: { shopId: shop.id, emailHash: aliceHash },
      }),
      1,
    );
    assert.equal(
      await prisma.customerIdentity.count({
        where: { shopId: shop.id, emailHash: bobHash },
      }),
      1,
    );

    const result = await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({
        shop_domain: shopDomain,
        customer: { id: Number(`900${suffix.replace(/\D/g, "").slice(0, 6)}1`), email: aliceEmail },
        orders_to_redact: [Number(aliceOrderId)],
      }),
      topic: "customers/redact",
      shopDomain,
      webhookId: `wh-redact-${suffix}`,
    });

    assert.equal(result.status, "processed");
    assert.equal(result.deletedIdentities, 1);
    assert.equal(result.scrubbedOrders, 1);
    assert.ok(result.scrubbedLedgerEvents >= 1);

    // Alice's identity is gone; Bob's remains.
    assert.equal(
      await prisma.customerIdentity.count({
        where: { shopId: shop.id, emailHash: aliceHash },
      }),
      0,
    );
    assert.equal(
      await prisma.customerIdentity.count({
        where: { shopId: shop.id, emailHash: bobHash },
      }),
      1,
    );

    // Alice's order rawPayload is scrubbed; order number + totals preserved.
    const aliceOrder = await prisma.order.findUniqueOrThrow({
      where: {
        shopId_externalId: {
          shopId: shop.id,
          externalId: `gid://shopify/Order/${aliceOrderId}`,
        },
      },
    });
    const aliceRaw = aliceOrder.rawPayload;
    assert.equal(aliceRaw.email, null);
    assert.equal(aliceRaw.contact_email, null);
    assert.equal(aliceRaw.phone, null);
    assert.equal(aliceRaw.browser_ip, null);
    assert.equal(aliceRaw.client_details, null);
    assert.equal(aliceRaw.customer.email, null);
    assert.equal(aliceRaw.customer.first_name, null);
    assert.equal(aliceRaw.customer.last_name, null);
    assert.equal(aliceRaw.customer.default_address, null);
    assert.equal(aliceRaw.billing_address, null);
    assert.equal(aliceRaw.shipping_address, null);
    assert.equal(aliceRaw.note_attributes.length, 1);
    assert.equal(aliceRaw.note_attributes[0].name, "gift_wrap");
    assert.equal(aliceRaw.name, "#1001"); // order number survives
    assert.equal(aliceRaw.total_price, "42.00"); // financial data survives
    assert.equal(aliceRaw.customer.admin_graphql_api_id, `gid://shopify/Customer/900${suffix.replace(/\D/g, "").slice(0, 6)}1`);
    assert.equal(aliceRaw._pii_redacted_reason, "customers/redact");

    // Bob's order is completely untouched.
    const bobOrder = await prisma.order.findUniqueOrThrow({
      where: {
        shopId_externalId: {
          shopId: shop.id,
          externalId: `gid://shopify/Order/${bobOrderId}`,
        },
      },
    });
    assert.equal(bobOrder.rawPayload.email, bobEmail);
    assert.equal(bobOrder.rawPayload._pii_redacted_reason, undefined);

    // Alice's order ledger is scrubbed; Bob's ledger still carries his email.
    const aliceLedger = await orderLedgerFor(prisma, shop.id, `gid://shopify/Order/${aliceOrderId}`);
    const bobLedger = await orderLedgerFor(prisma, shop.id, `gid://shopify/Order/${bobOrderId}`);
    assert.ok(aliceLedger);
    assert.equal(aliceLedger.rawPayload.email, null);
    assert.equal(aliceLedger.rawPayload.customer.email, null);
    assert.ok(bobLedger);
    assert.equal(bobLedger.rawPayload.email, bobEmail);

    // No ledger row anywhere in the shop still contains Alice's email.
    const allEvents = await prisma.ledgerEvent.findMany({ where: { shopId: shop.id } });
    for (const event of allEvents) {
      assert.ok(!JSON.stringify(event.rawPayload).includes(aliceEmail));
    }
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("customers/redact is idempotent and safe for an unknown customer/shop", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for compliance tests");
    return;
  }

  const prisma = client();
  const suffix = uniqueSuffix();
  const shopDomain = `gdpr-unknown-${suffix}.myshopify.com`;

  try {
    // Shop never installed -> processed, nothing to do.
    const missing = await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({
        shop_domain: shopDomain,
        customer: { id: 1, email: `nobody-${suffix}@example.com` },
        orders_to_redact: [],
      }),
      topic: "customers/redact",
      shopDomain,
      webhookId: `wh-missing-${suffix}`,
    });
    assert.equal(missing.status, "processed");
    assert.equal(missing.outcome, "shop_not_found");

    // Now install + ingest, then redact the same customer twice.
    await ingestOrder(prisma, {
      shopDomain,
      webhookId: `wh-i-${suffix}`,
      order: mockOrderPayload({
        orderId: `77${suffix.replace(/\D/g, "").slice(0, 8)}`,
        customerId: `88${suffix.replace(/\D/g, "").slice(0, 8)}`,
        email: `carol-${suffix}@example.com`,
        firstName: "Carol",
        lastName: "Clark",
        orderName: "#2001",
      }),
    });

    const redactBody = JSON.stringify({
      shop_domain: shopDomain,
      customer: { id: Number(`88${suffix.replace(/\D/g, "").slice(0, 8)}`), email: `carol-${suffix}@example.com` },
      orders_to_redact: [Number(`77${suffix.replace(/\D/g, "").slice(0, 8)}`)],
    });
    const first = await processShopifyWebhook(prisma, {
      rawBody: redactBody,
      topic: "customers/redact",
      shopDomain,
      webhookId: `wh-r1-${suffix}`,
    });
    const second = await processShopifyWebhook(prisma, {
      rawBody: redactBody,
      topic: "customers/redact",
      shopDomain,
      webhookId: `wh-r2-${suffix}`,
    });

    assert.equal(first.deletedIdentities, 1);
    assert.equal(second.deletedIdentities, 0); // already gone, still processed
    assert.equal(second.status, "processed");
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("compliance webhooks never persist the request body in the ledger", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for compliance tests");
    return;
  }

  const prisma = client();
  const suffix = uniqueSuffix();
  const shopDomain = `gdpr-nobody-${suffix}.myshopify.com`;
  const email = `dave-${suffix}@example.com`;
  const orderId = `66${suffix.replace(/\D/g, "").slice(0, 8)}`;
  const customerId = `55${suffix.replace(/\D/g, "").slice(0, 8)}`;

  try {
    await ingestOrder(prisma, {
      shopDomain,
      webhookId: `wh-d-${suffix}`,
      order: mockOrderPayload({
        orderId,
        customerId,
        email,
        firstName: "Dave",
        lastName: "Davies",
        orderName: "#3001",
      }),
    });
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    });

    await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({
        shop_domain: shopDomain,
        customer: { id: Number(customerId), email },
        orders_to_redact: [Number(orderId)],
      }),
      topic: "customers/redact",
      shopDomain,
      webhookId: `wh-dr-${suffix}`,
    });

    // No ledger event was created FOR the compliance topic itself...
    assert.equal(
      await prisma.ledgerEvent.count({
        where: { shopId: shop.id, eventType: "shopify.webhook.customers/redact" },
      }),
      0,
    );
    // ...and no ledger row anywhere in the shop carries the customer's email
    // (the pre-existing order ledger was scrubbed, no body was persisted).
    const events = await prisma.ledgerEvent.findMany({ where: { shopId: shop.id } });
    for (const event of events) {
      const serialized = JSON.stringify(event);
      assert.ok(!serialized.includes(email));
    }
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("customers/data_request records a sanitised, durable export", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for compliance tests");
    return;
  }

  const prisma = client();
  const suffix = uniqueSuffix();
  const shopDomain = `gdpr-dsar-${suffix}.myshopify.com`;
  const email = `erin-${suffix}@example.com`;
  const orderId = `44${suffix.replace(/\D/g, "").slice(0, 8)}`;
  const customerId = `33${suffix.replace(/\D/g, "").slice(0, 8)}`;

  try {
    await ingestOrder(prisma, {
      shopDomain,
      webhookId: `wh-e-${suffix}`,
      order: mockOrderPayload({
        orderId,
        customerId,
        email,
        firstName: "Erin",
        lastName: "Evans",
        orderName: "#4001",
      }),
    });
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain } },
    });

    const result = await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({
        shop_domain: shopDomain,
        customer: { id: Number(customerId), email },
        orders_requested: [Number(orderId)],
      }),
      topic: "customers/data_request",
      shopDomain,
      webhookId: `wh-dsar-${suffix}`,
    });

    assert.equal(result.status, "processed");
    assert.equal(result.outcome, "recorded");
    assert.equal(result.orderCount, 1);

    const record = await prisma.ledgerEvent.findFirstOrThrow({
      where: {
        shopId: shop.id,
        eventType: "shopify.compliance.customers_data_request",
      },
    });
    // The durable record holds the aggregate + non-sensitive order fields...
    assert.equal(record.payload.customer.found, true);
    assert.equal(record.payload.customer.emailHash, hashEmail(normalizeEmail(email)));
    assert.equal(record.payload.orders.length, 1);
    assert.equal(record.payload.orders[0].externalId, `gid://shopify/Order/${orderId}`);
    assert.equal(record.payload.orders[0].orderName, "#4001");
    assert.equal(Number(record.payload.orders[0].totalPrice), 42);
    // ...but never the raw email or a request body.
    assert.ok(!JSON.stringify(record.payload).includes(email));
    assert.deepEqual(record.rawPayload, {});

    // Duplicate delivery does not create a second record.
    await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({
        shop_domain: shopDomain,
        customer: { id: Number(customerId), email },
        orders_requested: [Number(orderId)],
      }),
      topic: "customers/data_request",
      shopDomain,
      webhookId: `wh-dsar-${suffix}`,
    });
    assert.equal(
      await prisma.ledgerEvent.count({
        where: {
          shopId: shop.id,
          eventType: "shopify.compliance.customers_data_request",
        },
      }),
      1,
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("shop/redact tears down one shop (and its 1:1 merchant), leaving another shop intact", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for compliance tests");
    return;
  }

  const prisma = client();
  const suffix = uniqueSuffix();
  const shopA = `gdpr-teardown-a-${suffix}.myshopify.com`;
  const shopB = `gdpr-teardown-b-${suffix}.myshopify.com`;

  try {
    await ingestOrder(prisma, {
      shopDomain: shopA,
      webhookId: `wh-ta-${suffix}`,
      order: mockOrderPayload({
        orderId: `11${suffix.replace(/\D/g, "").slice(0, 8)}`,
        customerId: `12${suffix.replace(/\D/g, "").slice(0, 8)}`,
        email: `fa-${suffix}@example.com`,
        firstName: "Fa",
        lastName: "A",
        orderName: "#5001",
      }),
    });
    await ingestOrder(prisma, {
      shopDomain: shopB,
      webhookId: `wh-tb-${suffix}`,
      order: mockOrderPayload({
        orderId: `21${suffix.replace(/\D/g, "").slice(0, 8)}`,
        customerId: `22${suffix.replace(/\D/g, "").slice(0, 8)}`,
        email: `fb-${suffix}@example.com`,
        firstName: "Fb",
        lastName: "B",
        orderName: "#6001",
      }),
    });

    const shopARow = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain: shopA } },
    });
    const shopBRow = await prisma.shop.findUniqueOrThrow({
      where: { platform_shopDomain: { platform: "shopify", shopDomain: shopB } },
    });

    const result = await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({ shop_id: 12345, shop_domain: shopA }),
      topic: "shop/redact",
      shopDomain: shopA,
      webhookId: `wh-sr-${suffix}`,
    });
    assert.equal(result.status, "processed");
    assert.equal(result.merchantDeleted, true);

    // Shop A and every dependent row is gone (scoped by shopId).
    assert.equal(
      await prisma.shop.findUnique({ where: { id: shopARow.id } }),
      null,
    );
    assert.equal(await prisma.order.count({ where: { shopId: shopARow.id } }), 0);
    assert.equal(
      await prisma.customerIdentity.count({ where: { shopId: shopARow.id } }),
      0,
    );
    assert.equal(
      await prisma.ledgerEvent.count({ where: { shopId: shopARow.id } }),
      0,
    );
    assert.equal(
      await prisma.product.count({ where: { shopId: shopARow.id } }),
      0,
    );
    assert.equal(
      await prisma.merchant.findUnique({ where: { id: shopARow.merchantId } }),
      null,
    );

    // Shop B is fully intact.
    assert.ok(await prisma.shop.findUnique({ where: { id: shopBRow.id } }));
    assert.equal(await prisma.order.count({ where: { shopId: shopBRow.id } }), 1);
    assert.equal(
      await prisma.customerIdentity.count({ where: { shopId: shopBRow.id } }),
      1,
    );
    assert.ok(await prisma.ledgerEvent.count({ where: { shopId: shopBRow.id } }) >= 1);
    assert.ok(
      await prisma.merchant.findUnique({ where: { id: shopBRow.merchantId } }),
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopA } });
    await prisma.merchant.deleteMany({ where: { name: shopB } });
    await prisma.$disconnect();
  }
});

test("shop/redact scopes strictly by shopId and keeps a shared merchant with other shops", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for compliance tests");
    return;
  }

  const prisma = client();
  const suffix = uniqueSuffix();
  const merchantName = `gdpr-shared-${suffix}`;
  const shopP = `gdpr-shared-p-${suffix}.myshopify.com`;
  const shopQ = `gdpr-shared-q-${suffix}.myshopify.com`;

  try {
    // One merchant deliberately owning two shops (not the normal Shopify path).
    const merchant = await prisma.merchant.create({
      data: {
        name: merchantName,
        shops: {
          create: [
            { platform: "shopify", shopDomain: shopP },
            { platform: "shopify", shopDomain: shopQ },
          ],
        },
      },
      include: { shops: true },
    });
    const shopPRow = merchant.shops.find((s) => s.shopDomain === shopP);
    const shopQRow = merchant.shops.find((s) => s.shopDomain === shopQ);

    for (const shop of [shopPRow, shopQRow]) {
      await prisma.order.create({
        data: {
          merchantId: merchant.id,
          shopId: shop.id,
          externalId: `gid://shopify/Order/${shop.id}`,
          rawPayload: { email: `owner-${shop.id}@example.com` },
        },
      });
      await prisma.customerIdentity.create({
        data: {
          merchantId: merchant.id,
          shopId: shop.id,
          emailHash: `hash-${shop.id}`,
          maskedEmail: "o****@example.com",
          source: "test",
        },
      });
      await prisma.ledgerEvent.create({
        data: {
          merchantId: merchant.id,
          shopId: shop.id,
          eventType: "shopify.webhook.orders/create",
          source: "shopify",
          rawPayload: { email: `owner-${shop.id}@example.com` },
        },
      });
    }

    const result = await processShopifyWebhook(prisma, {
      rawBody: JSON.stringify({ shop_id: 999, shop_domain: shopP }),
      topic: "shop/redact",
      shopDomain: shopP,
      webhookId: `wh-shared-${suffix}`,
    });
    assert.equal(result.status, "processed");
    // Merchant still owns shop Q, so the guard keeps the merchant alive.
    assert.equal(result.merchantDeleted, false);

    // Shop P torn down.
    assert.equal(await prisma.shop.findUnique({ where: { id: shopPRow.id } }), null);
    assert.equal(await prisma.order.count({ where: { shopId: shopPRow.id } }), 0);
    assert.equal(
      await prisma.customerIdentity.count({ where: { shopId: shopPRow.id } }),
      0,
    );
    assert.equal(await prisma.ledgerEvent.count({ where: { shopId: shopPRow.id } }), 0);

    // Shop Q and the shared merchant fully intact.
    assert.ok(await prisma.shop.findUnique({ where: { id: shopQRow.id } }));
    assert.equal(await prisma.order.count({ where: { shopId: shopQRow.id } }), 1);
    assert.equal(
      await prisma.customerIdentity.count({ where: { shopId: shopQRow.id } }),
      1,
    );
    assert.equal(await prisma.ledgerEvent.count({ where: { shopId: shopQRow.id } }), 1);
    assert.ok(await prisma.merchant.findUnique({ where: { id: merchant.id } }));
  } finally {
    await prisma.merchant.deleteMany({ where: { name: merchantName } });
    await prisma.$disconnect();
  }
});
