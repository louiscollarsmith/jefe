// @ts-check

// Shopify mandatory GDPR / privacy compliance webhooks.
//
// Shopify requires every public app to implement three webhooks and to actually
// act on them (they are audited for App Store approval):
//
//   * customers/redact       – erase a specific customer's PII for one shop.
//   * customers/data_request – assemble the data held about a customer so the
//                              merchant can fulfil a subject-access request.
//   * shop/redact            – full teardown of a shop's data, fired ~48h after
//                              the app is uninstalled.
//
// Two hard rules govern this whole module:
//
//   1. The shop/merchant is ALWAYS resolved from the HMAC-verified shop domain
//      that the transport passed us (input.shopDomain, from the signed
//      X-Shopify-Shop-Domain header). Body fields (customer.email, shop_id,
//      shop_domain, orders_to_redact, …) are treated as untrusted target data
//      only — never as the authority for WHICH tenant to mutate.
//
//   2. The request body is never persisted verbatim. The body itself carries the
//      customer PII we are being asked to erase, so ledgering it would defeat the
//      point. customers/data_request records a deliberately sanitised export
//      (masked email + aggregates + non-sensitive order fields); the two redact
//      topics persist nothing (and shop/redact deletes existing ledger rows).
//
// Resolution is read-only: unlike the normal ingestion path we must NOT call
// ensureShopifyTenant here, because that would (re)create or reactivate a shop —
// exactly wrong for a redaction request arriving after uninstall.

import crypto from "node:crypto";
import { normalizeShopDomain } from "../../shopify/admin-graphql.server.js";
import { jsonObject } from "./normalize.server.js";
import { hashEmail, maskEmail, normalizeEmail } from "./canonical.server.js";
import { writeLedgerEvent } from "./ledger.server.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Ledger event types whose rawPayload can carry order-level customer PII (the
 * webhook + backfill order/refund records). Used to bound the scan when scrubbing
 * a redacted customer's order PII out of the ledger. Matched by prefix so future
 * order sub-topics (orders/paid, orders/fulfilled, …) are covered automatically.
 */
const ORDER_LEDGER_PREFIXES = [
  "shopify.webhook.orders",
  "shopify.backfill.order",
  "shopify.webhook.refunds",
  "shopify.backfill.refund",
];

/**
 * Entry point called from processShopifyWebhook for the three compliance topics.
 * Resolves the tenant read-only from the verified domain and dispatches.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   topic: string;
 *   shopDomain: string;
 *   body: unknown;
 *   webhookId?: string | null;
 *   rawBody?: string;
 *   triggeredAt?: string | null;
 * }} input
 */
export async function handleShopifyComplianceWebhook(prisma, input) {
  const shop = await findShopByVerifiedDomain(prisma, input.shopDomain);

  // Idempotent + safe when the shop is unknown (never installed, or already torn
  // down by a previous shop/redact delivery). Shopify only needs a 2xx.
  if (!shop) {
    return {
      status: "processed",
      topic: input.topic,
      outcome: "shop_not_found",
    };
  }

  switch (input.topic) {
    case "customers/redact":
      return redactCustomer(prisma, { shop, body: input.body });
    case "customers/data_request":
      return recordCustomerDataRequest(prisma, {
        shop,
        body: input.body,
        webhookId: input.webhookId ?? null,
        rawBody: input.rawBody ?? "",
        triggeredAt: input.triggeredAt ?? null,
      });
    case "shop/redact":
      return redactShop(prisma, { shop });
    default:
      // Not reachable: caller only routes COMPLIANCE_TOPICS here.
      return { status: "processed", topic: input.topic, outcome: "ignored" };
  }
}

/**
 * customers/redact — erase one customer's PII, scoped strictly to this shop.
 *
 * Payload shape: { shop_domain, customer: { id, email }, orders_to_redact: [ids] }.
 *
 * What it does, and how each step is bounded so it can never touch another
 * customer or another shop:
 *
 *   1. Match the customer's CustomerIdentity row(s) by emailHash of the payload
 *      email AND/OR the Shopify customer gid, ALWAYS additionally filtered by
 *      { shopId: shop.id }. emailHash is the primary key we store and query on;
 *      shopifyCustomerId is a secondary match for payloads whose email we cannot
 *      normalise. If neither identifier is present nothing is matched.
 *   2. Build the set of the customer's order externalIds, every source filtered
 *      to this shop: (a) orderIds recorded on the matched identities, (b) the
 *      payload's orders_to_redact (mapped to order gids), (c) orders in THIS shop
 *      whose customerExternalId equals the customer gid.
 *   3. Scrub PII (email/name/address/phone/ip) out of rawPayload on exactly those
 *      orders (updated by primary id, re-checked against shopId) and out of the
 *      order/refund ledger events for this shop that reference the customer.
 *   4. Delete the matched CustomerIdentity row(s) (the record that holds the
 *      emailHash + maskedEmail), again filtered by shopId.
 *
 * Financial columns and order/line-item money fields are deliberately preserved;
 * only PII inside rawPayload is removed. Re-delivery is idempotent (already-
 * deleted rows are skipped, re-scrubbing is a no-op).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: ResolvedShop; body: unknown }} input
 */
async function redactCustomer(prisma, input) {
  const shopId = input.shop.id;
  const payload = jsonObject(input.body);
  const customer = jsonObject(payload.customer);

  const normalizedEmail = normalizeEmail(customer.email ?? payload.email);
  const emailHash = normalizedEmail ? hashEmail(normalizedEmail) : null;
  const customerGid = toGid("Customer", customer.id ?? payload.customer_id);

  // 1. Matched identities for THIS shop only.
  const identityMatchers = [
    ...(emailHash ? [{ emailHash }] : []),
    ...(customerGid ? [{ shopifyCustomerId: customerGid }] : []),
  ];
  const identities = identityMatchers.length
    ? await prisma.customerIdentity.findMany({
        where: { shopId, OR: identityMatchers },
      })
    : [];

  // 2. The customer's order externalIds, every source scoped to this shop.
  const orderExternalIds = new Set();
  for (const identity of identities) {
    const orderIds = jsonObject(identity.rawPayload).orderIds;
    if (Array.isArray(orderIds)) {
      for (const id of orderIds) if (typeof id === "string") orderExternalIds.add(id);
    }
  }
  const ordersToRedact = Array.isArray(payload.orders_to_redact)
    ? payload.orders_to_redact
    : [];
  for (const id of ordersToRedact) {
    const gid = toGid("Order", id);
    if (gid) orderExternalIds.add(gid);
  }
  if (customerGid) {
    const linked = await prisma.order.findMany({
      where: { shopId, customerExternalId: customerGid },
      select: { externalId: true },
    });
    for (const order of linked) orderExternalIds.add(order.externalId);
  }

  // 3a. Load and scrub the affected orders — strictly shopId + externalId ∈ set.
  const affectedOrders = orderExternalIds.size
    ? await prisma.order.findMany({
        where: { shopId, externalId: { in: [...orderExternalIds] } },
      })
    : [];

  // Token set (order gids + their numeric ids) used to recognise the customer's
  // orders inside ledger rawPayloads regardless of REST/GraphQL shape.
  const orderTokens = new Set();
  for (const value of orderExternalIds) addIdToken(orderTokens, value);
  for (const order of affectedOrders) addIdToken(orderTokens, order.externalId);

  let scrubbedOrders = 0;
  for (const order of affectedOrders) {
    await prisma.order.update({
      where: { id: order.id },
      data: { rawPayload: scrubOrderPii(order.rawPayload, "customers/redact") },
    });
    scrubbedOrders += 1;
  }

  // 3b. Scrub the customer's order/refund PII out of the ledger for this shop.
  const scrubbedLedgerEvents = await scrubCustomerLedgerEvents(prisma, {
    shopId,
    orderTokens,
    normalizedEmail,
  });

  // 4. Delete the identity row(s) — the stored emailHash + maskedEmail record.
  let deletedIdentities = 0;
  if (identities.length) {
    const result = await prisma.customerIdentity.deleteMany({
      where: { shopId, id: { in: identities.map((identity) => identity.id) } },
    });
    deletedIdentities = result.count;
  }

  return {
    status: "processed",
    topic: "customers/redact",
    outcome: "redacted",
    deletedIdentities,
    scrubbedOrders,
    scrubbedLedgerEvents,
  };
}

/**
 * Find and scrub order/refund ledger events for this shop that belong to the
 * customer — matched by order-id token OR by the customer's email appearing in
 * the payload. Bounded to this shop and to order/refund event types.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; orderTokens: Set<string>; normalizedEmail: string | null }} input
 */
async function scrubCustomerLedgerEvents(prisma, input) {
  const events = await prisma.ledgerEvent.findMany({
    where: {
      shopId: input.shopId,
      OR: ORDER_LEDGER_PREFIXES.map((prefix) => ({
        eventType: { startsWith: prefix },
      })),
    },
  });

  let scrubbed = 0;
  for (const event of events) {
    const raw = jsonObject(event.rawPayload);
    if (!ledgerEventReferencesCustomer(raw, input.orderTokens, input.normalizedEmail)) {
      continue;
    }
    await prisma.ledgerEvent.update({
      where: { id: event.id },
      data: { rawPayload: scrubOrderPii(raw, "customers/redact") },
    });
    scrubbed += 1;
  }
  return scrubbed;
}

/**
 * customers/data_request — assemble what we hold about the customer and record a
 * durable, sanitised export the merchant/ops can act on. Nothing is emailed.
 *
 * Payload shape: { shop_domain, customer, orders_requested }.
 *
 * The stored record deliberately contains NO raw PII: the customer is described
 * by emailHash + maskedEmail + aggregates, and orders by their non-sensitive
 * fields (ids, name, statuses, totals, dates) — never rawPayload, email or
 * address. It is written to the ledger with a dedupe key so duplicate deliveries
 * do not create duplicate records, and with rawPayload left empty ({}) so the
 * "compliance webhooks never persist a body" invariant holds here too.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: ResolvedShop; body: unknown; webhookId: string | null; rawBody: string; triggeredAt: string | null }} input
 */
async function recordCustomerDataRequest(prisma, input) {
  const shopId = input.shop.id;
  const merchantId = input.shop.merchantId;
  const payload = jsonObject(input.body);
  const customer = jsonObject(payload.customer);

  const normalizedEmail = normalizeEmail(customer.email ?? payload.email);
  const emailHash = normalizedEmail ? hashEmail(normalizedEmail) : null;
  const maskedEmail = normalizedEmail ? maskEmail(normalizedEmail) : null;
  const customerGid = toGid("Customer", customer.id ?? payload.customer_id);
  const ordersRequested = Array.isArray(payload.orders_requested)
    ? payload.orders_requested.map((id) => String(id))
    : [];

  // Locate the identity (this shop only) to build the aggregate export.
  const identityMatchers = [
    ...(emailHash ? [{ emailHash }] : []),
    ...(customerGid ? [{ shopifyCustomerId: customerGid }] : []),
  ];
  const identity = identityMatchers.length
    ? await prisma.customerIdentity.findFirst({
        where: { shopId, OR: identityMatchers },
      })
    : null;

  // Gather the customer's orders (this shop only) for the non-sensitive export.
  const orderExternalIds = new Set();
  const identityOrderIds = jsonObject(identity?.rawPayload).orderIds;
  if (Array.isArray(identityOrderIds)) {
    for (const id of identityOrderIds) if (typeof id === "string") orderExternalIds.add(id);
  }
  for (const id of ordersRequested) {
    const gid = toGid("Order", id);
    if (gid) orderExternalIds.add(gid);
  }
  const orders = customerGid || orderExternalIds.size
    ? await prisma.order.findMany({
        where: {
          shopId,
          OR: [
            ...(customerGid ? [{ customerExternalId: customerGid }] : []),
            ...(orderExternalIds.size
              ? [{ externalId: { in: [...orderExternalIds] } }]
              : []),
          ],
        },
        select: {
          externalId: true,
          orderName: true,
          financialStatus: true,
          fulfillmentStatus: true,
          currency: true,
          subtotalPrice: true,
          totalPrice: true,
          totalDiscount: true,
          totalTax: true,
          totalShipping: true,
          processedAt: true,
          sourceCreatedAt: true,
        },
      })
    : [];

  const exportPayload = {
    topic: "customers/data_request",
    shopDomain: input.shop.shopDomain,
    requestedAt: new Date().toISOString(),
    customer: {
      found: Boolean(identity),
      emailHash,
      maskedEmail: identity?.maskedEmail ?? maskedEmail,
      shopifyCustomerId: identity?.shopifyCustomerId ?? customerGid,
      orderCount: identity?.orderCount ?? null,
      totalSpend: identity ? String(identity.totalSpend) : null,
      averageOrderValue: identity ? String(identity.averageOrderValue) : null,
      firstSeenOrderAt: identity?.firstSeenOrderAt ?? null,
      lastOrderAt: identity?.lastOrderAt ?? null,
      source: identity?.source ?? null,
    },
    ordersRequested,
    orders: orders.map((order) => ({
      externalId: order.externalId,
      orderName: order.orderName,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      currency: order.currency,
      subtotalPrice: order.subtotalPrice == null ? null : String(order.subtotalPrice),
      totalPrice: order.totalPrice == null ? null : String(order.totalPrice),
      totalDiscount: order.totalDiscount == null ? null : String(order.totalDiscount),
      totalTax: order.totalTax == null ? null : String(order.totalTax),
      totalShipping: order.totalShipping == null ? null : String(order.totalShipping),
      processedAt: order.processedAt,
      sourceCreatedAt: order.sourceCreatedAt,
    })),
  };

  const deliveryId =
    input.webhookId ||
    crypto.createHash("sha256").update(input.rawBody).digest("hex");

  const { event } = await writeLedgerEvent(prisma, {
    merchantId,
    shopId,
    eventType: "shopify.compliance.customers_data_request",
    source: "shopify",
    sourceEventId: input.webhookId,
    dedupeKey: `shopify:compliance:customers/data_request:${input.shop.shopDomain}:${deliveryId}`,
    payload: exportPayload,
    // Never the request body: the body carries raw PII.
    rawPayload: {},
    eventTs: parseDateOrNow(input.triggeredAt),
  });

  return {
    status: "processed",
    topic: "customers/data_request",
    outcome: "recorded",
    ledgerEventId: event.id,
    orderCount: orders.length,
  };
}

/**
 * shop/redact — full, permanent teardown of one shop's data (fires ~48h after
 * uninstall). Bounded strictly to shop.id and its merchant.
 *
 * Deletion strategy (over-explained because it is destructive):
 *
 *   A. Explicitly delete, WHERE shop_id = <this shop>, every table whose foreign
 *      key to shops is onDelete: SetNull — i.e. the rows that a plain
 *      `DELETE FROM shops` would orphan (their shop_id nulled) rather than
 *      remove. These are the ledger events (raw order PII), connector accounts
 *      (tokens), the channel_* tables (phone PII) and the merchant_memory_* /
 *      store_understanding tables (derived from the shop's data). Each delete is
 *      keyed on shopId, so it can never reach another shop.
 *   B. Delete the shop row. Postgres cascades every table whose FK to shops is
 *      onDelete: Cascade: products, variants, orders, order_line_items, refunds,
 *      inventory_levels, customer_identities, shop_backfill_statuses,
 *      backfill_jobs, and the merchant_insight_* / merchant_goal_* /
 *      merchant_plan_* run tables.
 *   C. If the merchant now has zero shops, delete the merchant too. Shopify
 *      installs are 1 merchant : 1 shop (ensureShopifyTenant creates a merchant
 *      per shop domain), so this removes the now-orphaned merchant and, via the
 *      merchant onDelete: Cascade that every table declares, sweeps up anything
 *      step A might not have enumerated. The `count === 0` guard means that if a
 *      merchant somehow owns other shops, it (and those shops) are left fully
 *      intact — the guard is what makes deleting the merchant safe.
 *
 * The whole teardown runs in one transaction so it is all-or-nothing. Re-delivery
 * is idempotent: the second time, the shop no longer resolves and we return
 * shop_not_found above.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shop: ResolvedShop }} input
 */
async function redactShop(prisma, input) {
  const shopId = input.shop.id;
  const merchantId = input.shop.merchantId;
  const scoped = { where: { shopId } };

  const summary = await prisma.$transaction(
    async (tx) => {
      // A. SetNull-on-shop-delete tables — delete explicitly, strictly by shopId.
      //    Ordered children-before-parents where a non-null FK links them.
      await tx.channelMessageDelivery.deleteMany(scoped);
      await tx.channelVerificationChallenge.deleteMany(scoped);
      await tx.channelOAuthState.deleteMany(scoped);
      await tx.channelCredential.deleteMany(scoped);
      await tx.channelConnection.deleteMany(scoped);
      await tx.ledgerEvent.deleteMany(scoped);
      await tx.connectorAccount.deleteMany(scoped);
      await tx.merchantMemoryConversationMessage.deleteMany(scoped);
      await tx.merchantMemoryOpenQuestion.deleteMany(scoped);
      await tx.merchantMemoryConversation.deleteMany(scoped);
      await tx.merchantMemoryEvidence.deleteMany(scoped);
      await tx.merchantMemoryBeliefHistory.deleteMany(scoped);
      await tx.merchantMemoryBelief.deleteMany(scoped);
      await tx.merchantMemoryRefreshRun.deleteMany(scoped);
      await tx.storeUnderstandingRun.deleteMany(scoped);

      // B. Delete the shop; cascade removes all onDelete: Cascade children.
      await tx.shop.delete({ where: { id: shopId } });

      // C. Guarded merchant cleanup (1 merchant : 1 shop for Shopify installs).
      const remainingShops = await tx.shop.count({ where: { merchantId } });
      const merchantDeleted = remainingShops === 0;
      if (merchantDeleted) {
        await tx.merchant.delete({ where: { id: merchantId } });
      }
      return { merchantDeleted };
    },
    { timeout: 120000, maxWait: 120000 },
  );

  return {
    status: "processed",
    topic: "shop/redact",
    outcome: "redacted",
    shopId,
    merchantDeleted: summary.merchantDeleted,
  };
}

/**
 * @typedef {{ id: string; merchantId: string; shopDomain: string }} ResolvedShop
 */

/**
 * Read-only tenant resolution from the HMAC-verified shop domain. Never creates
 * or reactivates a shop (unlike ensureShopifyTenant).
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} shopDomain
 * @returns {Promise<ResolvedShop | null>}
 */
async function findShopByVerifiedDomain(prisma, shopDomain) {
  if (!shopDomain) return null;
  const normalized = normalizeShopDomain(shopDomain);
  const shop = await prisma.shop.findUnique({
    where: { platform_shopDomain: { platform: "shopify", shopDomain: normalized } },
    select: { id: true, merchantId: true, shopDomain: true },
  });
  return shop;
}

/**
 * Does this ledger rawPayload belong to the customer being redacted?
 *
 * @param {Record<string, any>} raw
 * @param {Set<string>} orderTokens
 * @param {string | null} normalizedEmail
 */
function ledgerEventReferencesCustomer(raw, orderTokens, normalizedEmail) {
  for (const token of collectOrderIdTokens(raw)) {
    if (orderTokens.has(token)) return true;
  }
  if (normalizedEmail && deepIncludesString(raw, normalizedEmail)) return true;
  return false;
}

/**
 * Candidate order identifiers present in a raw payload (order- or refund-shaped),
 * as gid + numeric tokens. Only tokens that also appear in the redacted
 * customer's order-token set will match, so non-order ids (e.g. a refund's own
 * id) can never cause a false positive.
 *
 * @param {Record<string, any>} raw
 * @returns {string[]}
 */
function collectOrderIdTokens(raw) {
  const order = jsonObject(raw.order);
  const candidates = [
    raw.admin_graphql_api_id,
    raw.id,
    raw.order_id,
    raw.admin_graphql_api_order_id,
    order.admin_graphql_api_id,
    order.id,
  ];
  const tokens = new Set();
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = String(candidate);
    if (value) {
      tokens.add(value);
      const tail = gidTail(value);
      if (tail) tokens.add(tail);
    }
  }
  return [...tokens];
}

/**
 * Redact PII out of an order-shaped rawPayload, returning a scrubbed deep clone.
 *
 * Deliberately targeted rather than a blanket key sweep, so that the order's own
 * `name` (the order number, e.g. "#1001") and all financial fields survive while
 * genuine PII is removed:
 *   - scalar PII at the top level and inside `customer` (email/phone/name/ip),
 *   - whole address + client/payment container objects,
 *   - note / note_attributes entries that look like an email or phone.
 * A `_pii_redacted_at` / `_pii_redacted_reason` marker is stamped for audit.
 *
 * @param {unknown} rawPayload
 * @param {string} reason
 */
function scrubOrderPii(rawPayload, reason) {
  // rawPayload is stored JSON (no Dates/undefined/functions), so a JSON round
  // trip is a faithful, dependency-free deep clone that leaves the DB value
  // untouched until we write the scrubbed copy back.
  const payload = JSON.parse(JSON.stringify(jsonObject(rawPayload)));

  redactScalarPii(payload);
  redactContainerPii(payload);

  const customer = payload.customer;
  if (customer && typeof customer === "object") {
    redactScalarPii(customer);
    redactContainerPii(customer);
    nullKey(customer, "name"); // person name lives on the customer object
  }

  if ("note" in payload) payload.note = null;
  if ("Note" in payload) payload.Note = null;
  scrubNoteAttributes(payload);

  payload._pii_redacted_at = new Date().toISOString();
  payload._pii_redacted_reason = reason;
  return payload;
}

const SCALAR_PII_KEYS = [
  "email",
  "contact_email",
  "contactEmail",
  "phone",
  "sms",
  "first_name",
  "firstName",
  "last_name",
  "lastName",
  "browser_ip",
  "customer_ip",
];

const CONTAINER_PII_KEYS = [
  "billing_address",
  "billingAddress",
  "shipping_address",
  "shippingAddress",
  "default_address",
  "defaultAddress",
  "addresses",
  "client_details",
  "clientDetails",
  "payment_details",
  "paymentDetails",
];

/** @param {Record<string, any>} obj */
function redactScalarPii(obj) {
  for (const key of SCALAR_PII_KEYS) if (key in obj) obj[key] = null;
}

/** @param {Record<string, any>} obj */
function redactContainerPii(obj) {
  for (const key of CONTAINER_PII_KEYS) if (key in obj) obj[key] = null;
}

/**
 * @param {Record<string, any>} obj
 * @param {string} key
 */
function nullKey(obj, key) {
  if (key in obj) obj[key] = null;
}

/**
 * Drop note_attributes entries that carry contact PII (an email/phone value, or a
 * name/key that mentions email/phone), keeping benign operational attributes.
 *
 * @param {Record<string, any>} payload
 */
function scrubNoteAttributes(payload) {
  for (const field of ["note_attributes", "noteAttributes"]) {
    const attributes = payload[field];
    if (!Array.isArray(attributes)) continue;
    payload[field] = attributes.filter((attribute) => {
      const name = String(
        attribute?.name ?? attribute?.key ?? attribute?.Name ?? "",
      ).toLowerCase();
      const value = String(attribute?.value ?? attribute?.Value ?? "");
      const sensitive =
        /email|e-mail|phone|mobile|tel/.test(name) ||
        EMAIL_RE.test(value.trim().toLowerCase());
      return !sensitive;
    });
  }
}

/**
 * Iterative deep search for a string (case-insensitive substring) anywhere in a
 * JSON-like value. Iterative to avoid stack overflow on pathological nesting.
 *
 * @param {unknown} value
 * @param {string} needle
 */
function deepIncludesString(value, needle) {
  const target = needle.toLowerCase();
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (current == null) continue;
    if (typeof current === "string") {
      if (current.toLowerCase().includes(target)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (typeof current === "object") {
      for (const item of Object.values(current)) stack.push(item);
    }
  }
  return false;
}

/**
 * @param {Set<string>} set
 * @param {string | null | undefined} externalId
 */
function addIdToken(set, externalId) {
  if (!externalId) return;
  set.add(externalId);
  const tail = gidTail(externalId);
  if (tail) set.add(tail);
}

/**
 * Build a Shopify gid from a numeric/string/gid id, or null.
 *
 * @param {string} resource
 * @param {unknown} value
 */
function toGid(resource, value) {
  if (value == null) return null;
  if (typeof value === "string" && value.startsWith("gid://")) return value;
  const id =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string" && value.trim() !== ""
        ? value.trim()
        : null;
  return id ? `gid://shopify/${resource}/${id}` : null;
}

/**
 * The trailing numeric id of a gid (gid://shopify/Order/123 -> "123"), or null
 * when the value has no path separator (already a bare id).
 * @param {string} value
 */
function gidTail(value) {
  if (typeof value !== "string" || !value.includes("/")) return null;
  const tail = value.split("/").pop();
  return tail || null;
}

/** @param {string | null} value */
function parseDateOrNow(value) {
  if (typeof value !== "string" || !value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
