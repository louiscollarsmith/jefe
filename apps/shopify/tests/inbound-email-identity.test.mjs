import assert from "node:assert/strict";
import test from "node:test";

import {
  emailHashOf,
  recordEmailIdentity,
  recordEmailIdentityOnAuth,
  resolveShopBySender,
} from "../app/lib/email/inbound/identity.server.js";
import { hashRecipient } from "../app/lib/email/unsubscribe.server.js";

/**
 * Compact in-memory Prisma double covering only the methods the identity module
 * uses. Keeps these tests DB-free + deterministic on plain `node --test`.
 */
function makeFakePrisma({ identities = [], sessions = [], shops = [] } = {}) {
  const idRows = identities.map((r) => ({ ...r }));
  return {
    _identities: idRows,
    emailIdentity: {
      async findUnique({ where }) {
        const row = idRows.find((i) => i.emailHash === where.emailHash);
        if (!row) return null;
        return {
          merchantId: row.merchantId,
          shopId: row.shopId,
          shop: { shopDomain: row.shopDomain ?? null },
        };
      },
      async upsert({ where, update, create }) {
        const row = idRows.find((i) => i.emailHash === where.emailHash);
        if (row) Object.assign(row, update);
        else idRows.push({ ...create });
        return {};
      },
    },
    session: {
      async findMany() {
        return sessions.map((s) => ({ ...s }));
      },
    },
    shop: {
      async findUnique({ where }) {
        const domain = where.platform_shopDomain.shopDomain;
        const shop = shops.find((s) => s.shopDomain === domain);
        return shop ? { ...shop } : null;
      },
    },
  };
}

test("emailHashOf matches the shared unsubscribe hashing (consistent across features)", () => {
  assert.equal(emailHashOf("Owner@Shop.com"), hashRecipient("owner@shop.com"));
  assert.equal(emailHashOf("not-an-email"), null);
});

test("recordEmailIdentity upserts one row per hash; a later shop wins", async () => {
  const prisma = makeFakePrisma();
  await recordEmailIdentity(prisma, { merchantId: "m1", shopId: "s1", email: "owner@shop.com" });
  assert.equal(prisma._identities.length, 1);
  assert.equal(prisma._identities[0].emailHash, emailHashOf("owner@shop.com"));

  await recordEmailIdentity(prisma, { merchantId: "m2", shopId: "s2", email: "owner@shop.com" });
  assert.equal(prisma._identities.length, 1, "same hash → update, not a new row");
  assert.equal(prisma._identities[0].shopId, "s2");
});

test("recordEmailIdentity declines an invalid email", async () => {
  const prisma = makeFakePrisma();
  const res = await recordEmailIdentity(prisma, { merchantId: "m", shopId: "s", email: "nope" });
  assert.deepEqual(res, { recorded: false, reason: "no_email" });
});

test("resolveShopBySender resolves via the identity index", async () => {
  const emailHash = emailHashOf("owner@shop.com");
  const prisma = makeFakePrisma({
    identities: [{ emailHash, merchantId: "m1", shopId: "s1", shopDomain: "shop.myshopify.com" }],
  });
  const res = await resolveShopBySender(prisma, "Owner@Shop.com");
  assert.equal(res.source, "identity");
  assert.equal(res.merchantId, "m1");
  assert.equal(res.shopId, "s1");
  assert.equal(res.shopDomain, "shop.myshopify.com");
});

test("resolveShopBySender self-heals from an active Session and backfills the index", async () => {
  const prisma = makeFakePrisma({
    sessions: [{ shop: "shop.myshopify.com", email: "owner@shop.com" }],
    shops: [{ id: "s1", merchantId: "m1", shopDomain: "shop.myshopify.com" }],
  });
  const res = await resolveShopBySender(prisma, "owner@shop.com");
  assert.equal(res.source, "session");
  assert.equal(res.shopId, "s1");
  assert.equal(res.merchantId, "m1");
  // Backfilled so the next reply resolves via the fast path (and post-uninstall).
  assert.equal(prisma._identities.length, 1);
  assert.equal(prisma._identities[0].emailHash, emailHashOf("owner@shop.com"));
});

test("resolveShopBySender parks an unknown sender", async () => {
  const prisma = makeFakePrisma();
  const res = await resolveShopBySender(prisma, "stranger@elsewhere.com");
  assert.equal(res.shopId, null);
  assert.equal(res.source, "none");
  assert.equal(res.reason, "unknown_sender");
});

test("resolveShopBySender rejects a non-address sender", async () => {
  const prisma = makeFakePrisma();
  const res = await resolveShopBySender(prisma, "not-an-email");
  assert.equal(res.reason, "no_sender");
  assert.equal(res.emailHash, null);
});

test("recordEmailIdentityOnAuth uses the passed email, then falls back to the owner Session", async () => {
  const prisma = makeFakePrisma({
    sessions: [{ shop: "shop.myshopify.com", email: "owner@shop.com", accountOwner: true, expires: null }],
    shops: [{ id: "s1", merchantId: "m1", shopDomain: "shop.myshopify.com" }],
  });
  // No email passed → resolves the owner from Session.
  const res = await recordEmailIdentityOnAuth(prisma, { shopDomain: "shop.myshopify.com", email: null });
  assert.equal(res.recorded, true);
  assert.equal(prisma._identities[0].emailHash, emailHashOf("owner@shop.com"));
});

test("recordEmailIdentityOnAuth declines when the shop is unknown", async () => {
  const prisma = makeFakePrisma();
  const res = await recordEmailIdentityOnAuth(prisma, { shopDomain: "ghost.myshopify.com", email: "x@y.com" });
  assert.deepEqual(res, { recorded: false, reason: "no_shop" });
});
