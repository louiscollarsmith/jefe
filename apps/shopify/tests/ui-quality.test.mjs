import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeFiles = {
  revenue: "app/routes/app.revenue-margin.tsx",
  inventory: "app/routes/app.inventory-guardian.tsx",
  watchdog: "app/routes/app.watchdog.tsx",
  winback: "app/routes/app.klaviyo-winback.tsx",
  settings: "app/routes/app.manager-settings.tsx",
};

test("core Jefe pages use the UI Quality Playbook briefing layout", async () => {
  const [styles, ...routes] = await Promise.all([
    readFile("app/styles/manager-briefing.module.css", "utf8"),
    ...Object.values(routeFiles).map((file) => readFile(file, "utf8")),
  ]);

  assert.match(styles, /max-width: 880px/);
  assert.match(styles, /padding: 48px 24px 80px/);
  assert.match(styles, /\.actionCard/);
  assert.match(styles, /\.keyNumbers/);
  assert.match(styles, /\.moduleRow/);

  for (const route of routes) {
    assert.match(route, /manager-briefing\.module\.css/);
    assert.match(route, /styles\.briefing/);
    assert.match(route, /styles\.verdict/);
    assert.match(route, /styles\.actionCard/);
    assert.match(route, /styles\.keyNumbers/);
    assert.doesNotMatch(route, /bulk_operation_id|backfill_jobs|rules_consulted|raw payload/i);
  }
});

test("core Jefe pages expose one specific primary action or empty state", async () => {
  const revenue = await readFile(routeFiles.revenue, "utf8");
  const inventory = await readFile(routeFiles.inventory, "utf8");
  const watchdog = await readFile(routeFiles.watchdog, "utf8");
  const winback = await readFile(routeFiles.winback, "utf8");
  const settings = await readFile(routeFiles.settings, "utf8");

  assert.match(revenue, /Review product costs/);
  assert.match(revenue, /Gross profit is unavailable until more product costs are added/);
  assert.match(inventory, /Review stockout risk/);
  assert.match(inventory, /estimated prevention, not verified lift/);
  assert.match(inventory, /Out of stock with no recent demand/);
  assert.match(watchdog, /Open Watchdog alert/);
  assert.match(watchdog, /Estimated value at risk is prevention, not verified lift/);
  assert.match(winback, /Connect Klaviyo/);
  assert.match(winback, /Create Klaviyo draft/);
  assert.match(winback, /Draft only · Send disabled/);
  assert.match(winback, /No customer-facing email will be sent from Jefe/);
  assert.match(settings, /Set goals|Review rules|Confirm mode/);
  assert.match(settings, /Review product costs/);
  assert.match(settings, /Setup summary/);
});
