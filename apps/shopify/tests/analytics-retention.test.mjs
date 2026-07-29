import assert from "node:assert/strict";
import test from "node:test";
import {
  pruneOldEvents,
  maybePruneOldEvents,
  __resetRetention,
} from "../app/services/analytics/retention.server.js";

const NOW = new Date("2026-07-29T00:00:00.000Z");

function fakePrisma(counts = { activity: 0, usage: 0 }) {
  const calls = { activity: null, usage: null };
  return {
    calls,
    activityEvent: {
      async deleteMany(args) {
        calls.activity = args;
        return { count: counts.activity };
      },
    },
    llmUsageEvent: {
      async deleteMany(args) {
        calls.usage = args;
        return { count: counts.usage };
      },
    },
  };
}

test("pruneOldEvents deletes older than window and returns counts", async () => {
  const prisma = fakePrisma({ activity: 3, usage: 5 });
  const r = await pruneOldEvents(prisma, { activityDays: 30, usageDays: 60, now: NOW });
  assert.deepEqual(r, { activityDeleted: 3, usageDeleted: 5 });
  assert.equal(
    prisma.calls.activity.where.createdAt.lt.toISOString(),
    "2026-06-29T00:00:00.000Z",
  );
  assert.equal(
    prisma.calls.usage.where.createdAt.lt.toISOString(),
    "2026-05-30T00:00:00.000Z",
  );
});

test("pruneOldEvents never throws on a DB error", async () => {
  const prisma = {
    activityEvent: {
      async deleteMany() {
        throw new Error("db down");
      },
    },
    llmUsageEvent: {
      async deleteMany() {
        return { count: 0 };
      },
    },
  };
  const r = await pruneOldEvents(prisma, { now: NOW });
  assert.deepEqual(r, { activityDeleted: 0, usageDeleted: 0 });
});

test("maybePruneOldEvents is a no-op unless enabled", async () => {
  __resetRetention();
  const prisma = fakePrisma();
  const r = await maybePruneOldEvents(prisma, { now: NOW, env: {} });
  assert.equal(r, null);
  assert.equal(prisma.calls.activity, null);
});

test("maybePruneOldEvents runs at most once per day when enabled", async () => {
  __resetRetention();
  const prisma = fakePrisma({ activity: 1, usage: 0 });
  const env = { ENABLE_EVENT_RETENTION: "true" };
  const first = await maybePruneOldEvents(prisma, { now: NOW, env });
  assert.deepEqual(first, { activityDeleted: 1, usageDeleted: 0 });
  prisma.calls.activity = null;
  const second = await maybePruneOldEvents(prisma, { now: NOW, env });
  assert.equal(second, null);
  assert.equal(prisma.calls.activity, null);
});
