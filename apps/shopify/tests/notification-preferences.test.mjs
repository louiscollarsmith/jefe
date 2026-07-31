import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBriefSendTime,
  getNotificationPreference,
  listNotificationPreferences,
  normalizeChannels,
  normalizeSchedule,
  setNotificationPreference,
} from "../app/lib/notifications/service.server.js";
import {
  getNotificationCategory,
  listNotificationCategories,
} from "../app/lib/notifications/registry.server.js";

// In-memory mock of the notificationPreference model — mirrors the mockPolicyPrisma
// pattern in action-autonomy-policy.test.mjs (pure, no DB).
function mockPrefPrisma(rows = []) {
  const store = new Map(rows.map((r) => [r.category, r]));
  return {
    _rows: () => [...store.values()],
    notificationPreference: {
      findUnique: async ({ where }) => {
        const row = store.get(where.merchantId_category.category);
        return row ? { ...row } : null;
      },
      findMany: async () => [...store.values()].map((r) => ({ ...r })),
      upsert: async ({ where, create, update }) => {
        const category = where.merchantId_category.category;
        const existing = store.get(category);
        const next = existing ? { ...existing, ...update } : { category, ...create };
        store.set(category, next);
        return { ...next };
      },
    },
  };
}

test("normalizeChannels keeps only known keys in canonical order; non-array → null", () => {
  assert.deepEqual(normalizeChannels(["whatsapp", "email", "bogus"]), ["email", "whatsapp"]);
  assert.deepEqual(normalizeChannels([]), []); // explicitly muted
  assert.equal(normalizeChannels(null), null); // unset → default
  assert.equal(normalizeChannels("email"), null); // not an array → unset
  assert.deepEqual(normalizeChannels(["nope"]), []); // no known key left → muted
});

test("normalizeSchedule range-checks and drops bad values", () => {
  assert.deepEqual(normalizeSchedule({ frequency: "daily", hour: 7, minute: 30 }), {
    frequency: "daily",
    hour: 7,
    minute: 30,
  });
  assert.equal(normalizeSchedule({ frequency: "weekly", hour: 7, minute: 0 }), null); // bad frequency
  assert.equal(normalizeSchedule({ frequency: "daily", hour: 24, minute: 0 }), null); // hour out of range
  assert.equal(normalizeSchedule({ frequency: "daily", hour: 7, minute: 60 }), null); // minute out of range
  assert.equal(normalizeSchedule(null), null);
  assert.deepEqual(
    normalizeSchedule({ frequency: "weekdays", hour: 9, minute: 5, timezone: "Europe/London" }),
    { frequency: "weekdays", hour: 9, minute: 5, timezone: "Europe/London" },
  );
});

test("formatBriefSendTime renders 12-hour labels; null when off/invalid", () => {
  assert.equal(formatBriefSendTime({ frequency: "daily", hour: 7, minute: 30 }), "7:30am");
  assert.equal(formatBriefSendTime({ frequency: "daily", hour: 0, minute: 5 }), "12:05am");
  assert.equal(formatBriefSendTime({ frequency: "daily", hour: 12, minute: 0 }), "12:00pm");
  assert.equal(formatBriefSendTime({ frequency: "daily", hour: 17, minute: 0 }), "5:00pm");
  assert.equal(formatBriefSendTime({ frequency: "off", hour: 7, minute: 30 }), null);
  assert.equal(formatBriefSendTime(null), null);
});

test("getNotificationPreference returns the registry default when no row is stored", async () => {
  const prisma = mockPrefPrisma([]);
  const pref = await getNotificationPreference(prisma, { merchantId: "m1", category: "morning_brief" });
  const def = getNotificationCategory("morning_brief");
  assert.equal(pref.enabled, def.defaultEnabled);
  assert.deepEqual(pref.channels, [...def.defaultChannels]);
  assert.deepEqual(pref.schedule, { ...def.defaultSchedule });
  assert.equal(pref.schedulable, true);
});

test("getNotificationPreference merges stored overrides over the default; unknown → null", async () => {
  const prisma = mockPrefPrisma([
    { category: "morning_brief", enabled: false, channels: ["slack"], schedule: { frequency: "daily", hour: 9, minute: 0 } },
  ]);
  const pref = await getNotificationPreference(prisma, { merchantId: "m1", category: "morning_brief" });
  assert.equal(pref.enabled, false);
  assert.deepEqual(pref.channels, ["slack"]);
  assert.deepEqual(pref.schedule, { frequency: "daily", hour: 9, minute: 0 });
  assert.equal(await getNotificationPreference(prisma, { merchantId: "m1", category: "nope" }), null);
});

test("a non-schedulable category never carries a schedule", async () => {
  const prisma = mockPrefPrisma([]);
  const pref = await getNotificationPreference(prisma, { merchantId: "m1", category: "action_done" });
  assert.equal(pref.schedulable, false);
  assert.equal(pref.schedule, null);
});

test("listNotificationPreferences returns every registry category", async () => {
  const prisma = mockPrefPrisma([]);
  const all = await listNotificationPreferences(prisma, { merchantId: "m1" });
  assert.equal(all.length, listNotificationCategories().length);
  assert.deepEqual(
    all.map((p) => p.category).sort(),
    listNotificationCategories().map((c) => c.key).sort(),
  );
});

test("setNotificationPreference refuses an unknown category and writes nothing", async () => {
  const prisma = mockPrefPrisma([]);
  const res = await setNotificationPreference(prisma, { merchantId: "m1", category: "nope", patch: { enabled: true } });
  assert.equal(res.status, "invalid_category");
  assert.equal(prisma._rows().length, 0);
});

test("setNotificationPreference upserts normalized values; drops invalid schedule", async () => {
  const prisma = mockPrefPrisma([]);
  await setNotificationPreference(prisma, {
    merchantId: "m1",
    category: "morning_brief",
    patch: { enabled: false, schedule: { frequency: "daily", hour: 8, minute: 15 } },
  });
  let pref = await getNotificationPreference(prisma, { merchantId: "m1", category: "morning_brief" });
  assert.equal(pref.enabled, false);
  assert.deepEqual(pref.schedule, { frequency: "daily", hour: 8, minute: 15 });

  // A bad schedule normalizes to null → the category falls back to its default schedule.
  await setNotificationPreference(prisma, {
    merchantId: "m1",
    category: "morning_brief",
    patch: { schedule: { frequency: "daily", hour: 99, minute: 0 } },
  });
  pref = await getNotificationPreference(prisma, { merchantId: "m1", category: "morning_brief" });
  assert.deepEqual(pref.schedule, { ...getNotificationCategory("morning_brief").defaultSchedule });
});

test("setNotificationPreference forces schedule null on a non-schedulable category", async () => {
  const prisma = mockPrefPrisma([]);
  await setNotificationPreference(prisma, {
    merchantId: "m1",
    category: "action_done",
    patch: { schedule: { frequency: "daily", hour: 8, minute: 0 } },
  });
  const row = prisma._rows().find((r) => r.category === "action_done");
  assert.equal(row.schedule, null);
});
