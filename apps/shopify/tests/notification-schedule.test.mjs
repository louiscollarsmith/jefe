import assert from "node:assert/strict";
import test from "node:test";
import { isBriefDue, localClockFor } from "../app/lib/notifications/schedule.server.js";

const FRI_0900Z = new Date("2026-07-31T09:00:00.000Z"); // a Friday
const SAT_0900Z = new Date("2026-08-01T09:00:00.000Z"); // the next day, a Saturday

test("localClockFor renders the merchant-local clock per timezone", () => {
  assert.deepEqual(localClockFor(FRI_0900Z, "UTC"), {
    localDay: "2026-07-31",
    hour: 9,
    minute: 0,
    weekday: "Fri",
  });
  const tokyo = localClockFor(FRI_0900Z, "Asia/Tokyo"); // UTC+9
  assert.equal(tokyo.localDay, "2026-07-31");
  assert.equal(tokyo.hour, 18);
  const la = localClockFor(FRI_0900Z, "America/Los_Angeles"); // UTC-7 (PDT)
  assert.equal(la.hour, 2);
  assert.equal(la.localDay, "2026-07-31");
  // An invalid timezone falls back to UTC rather than throwing.
  assert.equal(localClockFor(FRI_0900Z, "Not/AZone").hour, 9);
});

test("isBriefDue fires once the local time passes the scheduled hour (same instant, different tz)", () => {
  const schedule = { frequency: "daily", hour: 7, minute: 30 };
  assert.equal(isBriefDue({ schedule, lastFiredLocalDay: null }, FRI_0900Z, "UTC"), true); // 09:00 ≥ 07:30
  assert.equal(
    isBriefDue({ schedule, lastFiredLocalDay: null }, FRI_0900Z, "America/Los_Angeles"),
    false, // 02:00 < 07:30
  );
});

test("isBriefDue is at-most-once per merchant-local day", () => {
  const schedule = { frequency: "daily", hour: 7, minute: 30 };
  assert.equal(isBriefDue({ schedule, lastFiredLocalDay: "2026-07-31" }, FRI_0900Z, "UTC"), false);
  assert.equal(isBriefDue({ schedule, lastFiredLocalDay: "2026-07-30" }, FRI_0900Z, "UTC"), true);
});

test("frequency 'off' never fires; 'weekdays' skips the weekend", () => {
  assert.equal(
    isBriefDue({ schedule: { frequency: "off", hour: 7, minute: 30 }, lastFiredLocalDay: null }, FRI_0900Z, "UTC"),
    false,
  );
  assert.equal(localClockFor(SAT_0900Z, "UTC").weekday, "Sat");
  const weekdays = { frequency: "weekdays", hour: 7, minute: 30 };
  assert.equal(isBriefDue({ schedule: weekdays, lastFiredLocalDay: null }, SAT_0900Z, "UTC"), false);
  assert.equal(isBriefDue({ schedule: weekdays, lastFiredLocalDay: null }, FRI_0900Z, "UTC"), true);
});

test("a schedule's own timezone overrides the shop timezone", () => {
  const schedule = { frequency: "daily", hour: 7, minute: 30, timezone: "America/Los_Angeles" };
  // Shop tz UTC would be due (09:00), but the schedule's LA tz makes it 02:00 → not due.
  assert.equal(isBriefDue({ schedule, lastFiredLocalDay: null }, FRI_0900Z, "UTC"), false);
});

test("missing/invalid schedule → not due", () => {
  assert.equal(isBriefDue({ schedule: { frequency: "daily" }, lastFiredLocalDay: null }, FRI_0900Z, "UTC"), false);
  assert.equal(isBriefDue({ schedule: null, lastFiredLocalDay: null }, FRI_0900Z, "UTC"), false);
});
