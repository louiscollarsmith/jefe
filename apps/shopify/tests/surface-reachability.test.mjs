import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

// Merchant Memory is the product's core object, and for a stretch of 2026-08-12 no merchant
// could open it. The home's "See everything Jefe knows" footer link was removed on purpose
// (the chat-log home shouldn't carry it) but it was the ONLY navigation off the home, and the
// replacement had not landed. The route kept serving `?view=memory` perfectly — nothing
// errored, nothing looked broken in the code, and the surface was simply unreachable.
//
// That is the failure mode these guard: a surface that renders fine and cannot be opened.
// Route handling is NOT reachability, so asserting the loader still reads `?view=memory`
// would have passed throughout the outage. Assert there is a way IN.

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const dailyHome = read("app/components/daily-home.tsx");
const settings = read("app/routes/app.settings.tsx");

test("the home has a way off it", () => {
  // The gear is the home's only door out by design. If it goes, Settings AND Merchant Memory
  // go with it, because Memory is reached through Settings.
  assert.match(dailyHome, /aria-label="Settings"/);
  assert.match(dailyHome, /settingsHref/);
});

test("Merchant Memory is reachable from settings", () => {
  assert.match(settings, /Everything Jefe knows/);
  assert.match(settings, /memoryHref/);
  assert.match(settings, /next\.set\("view", "memory"\)/);
});

test("navigation keeps the params embedded Shopify needs", () => {
  // A link that drops `host` breaks the embedded app rather than navigating it — the failure
  // looks like a dead click, so it is worth pinning. Both helpers must carry the existing
  // params forward and delete only the ones describing where you were.
  assert.match(dailyHome, /new URLSearchParams\(search\)/);
  assert.match(dailyHome, /for \(const key of \["view", "actionChat", "panel"\]\) params\.delete\(key\)/);
  assert.match(settings, /new URLSearchParams\(params\)/);
  assert.match(settings, /next\.delete\("panel"\)/);
});

test("the gear is not rendered without a search string to carry", () => {
  // The loading header has no params; a gear there would navigate away from the embedded
  // context and lose `host`. Better no door than a door onto the street.
  assert.match(dailyHome, /currentSearch \?\s*\(/);
});

test("the Memory entry is not wired into the founder-ordered panel list", () => {
  // PANELS is the nav contract and its order is founder-specified — Autonomy must stay first.
  // The Memory link sits outside it deliberately; this fails if someone "tidies" it into the
  // array, which would silently reorder the settings nav.
  const panelsStart = settings.indexOf("const PANELS");
  const panelsBlock = settings.slice(
    panelsStart,
    settings.indexOf("];", panelsStart) + 2,
  );
  assert.ok(panelsBlock.length > 0, "PANELS block should be findable");
  assert.doesNotMatch(panelsBlock, /view=memory|Everything Jefe knows/);
  const firstPanel = panelsBlock.slice(panelsBlock.indexOf("{ id:"));
  assert.match(firstPanel.slice(0, 40), /id: "autonomy"/);
});
