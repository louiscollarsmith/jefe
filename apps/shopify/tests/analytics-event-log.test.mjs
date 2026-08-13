import assert from "node:assert/strict";
import test from "node:test";
import { track } from "../app/services/analytics/event-log.server.js";

function fakePrisma() {
  const created = [];
  return {
    created,
    activityEvent: {
      async create(args) {
        created.push(args.data);
        return { id: "evt_1", ...args.data };
      },
    },
  };
}

test("track writes an event with defaulted nulls", async () => {
  const prisma = fakePrisma();
  const ok = await track(prisma, {
    type: "shop_installed",
    topic: "onboarding",
    shopDomain: "jaspers-market.myshopify.com",
    summary: "Installed jaspers-market.myshopify.com",
  });
  assert.equal(ok, true);
  assert.equal(prisma.created.length, 1);
  const row = prisma.created[0];
  assert.equal(row.type, "shop_installed");
  assert.equal(row.topic, "onboarding");
  assert.equal(row.shopDomain, "jaspers-market.myshopify.com");
  assert.equal(row.merchantId, null);
  assert.equal(row.shopId, null);
  assert.deepEqual(row.properties, {});
});

test("track redacts sensitive properties before persisting", async () => {
  const prisma = fakePrisma();
  await track(prisma, {
    type: "channel_connected",
    shopDomain: "s.myshopify.com",
    properties: { channel: "slack", accessToken: "secret", contact: "a@b.com" },
  });
  const props = prisma.created[0].properties;
  assert.equal(props.channel, "slack");
  assert.equal(props.accessToken, "[redacted]");
  // PII scrubbing removed 2026-08-13 (founder's call). NOTE: this log feeds the ops panel
  // at admin.mynamejefe.com, which is cross-merchant and currently has no login.
  assert.equal(props.contact, "a@b.com");
});

test("track never throws and returns false on a DB error", async () => {
  const prisma = {
    activityEvent: {
      async create() {
        throw new Error("db down");
      },
    },
  };
  let result;
  await assert.doesNotReject(async () => {
    result = await track(prisma, { type: "memory_rebuilt", shopDomain: "s.myshopify.com" });
  });
  assert.equal(result, false);
});

test("track ignores an event with no type", async () => {
  const prisma = fakePrisma();
  const ok = await track(prisma, /** @type {any} */ ({ shopDomain: "s.myshopify.com" }));
  assert.equal(ok, false);
  assert.equal(prisma.created.length, 0);
});
