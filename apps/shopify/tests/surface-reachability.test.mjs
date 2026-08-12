import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// Merchant Memory is the product's core object, and for a stretch of 2026-08-12 no merchant
// could open it. The home's "See everything Jefe knows" footer link was removed on purpose
// (the chat-log home shouldn't carry it) but it was the ONLY navigation off the home, and the
// replacement had not landed. The route kept serving `?view=memory` perfectly — nothing
// errored, nothing looked broken in the code, and the surface was simply unreachable.
//
// That is the failure mode these guard: a surface that renders fine and cannot be opened.
// Route handling is NOT reachability, so asserting the loader still reads `?view=memory`
// would have passed throughout the outage. Assert there is a way IN.

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const appShell = read("app/routes/app.tsx");
const dailyHome = read("app/components/daily-home.tsx");
const settings = read("app/routes/app.settings.tsx");

test("the home has a way off it", () => {
  // The top-right shell gear is the one way to Settings from the clean chat home. If it goes,
  // Settings AND Merchant Memory go with it, because Memory is reached through Settings.
  assert.match(appShell, /aria-label="Settings"/);
  assert.match(appShell, /appSettingsHref/);
});

test("Merchant Memory is reachable from settings", () => {
  assert.match(settings, /Everything Jefe knows/);
  assert.match(settings, /memoryHref/);
  assert.match(settings, /next\.set\("view", "memory"\)/);
});

test("navigation keeps the params embedded Shopify needs", () => {
  // A link that drops `host` breaks the embedded app rather than navigating it — the failure
  // looks like a dead click, so it is worth pinning. Helpers must carry the existing
  // params forward and delete only the ones describing where you were.
  assert.match(appShell, /new URLSearchParams\(search\)/);
  assert.match(appShell, /for \(const key of \["view", "actionChat", "panel"\]\) params\.delete\(key\)/);
  assert.match(settings, /new URLSearchParams\(params\)/);
  assert.match(settings, /next\.delete\("panel"\)/);
});

test("the home carries no memory footer link", () => {
  // Removed on Matt's call in 63d0337, then silently resurrected by a rebase in #81 (holistic
  // memory retrieval) — he asked for it gone twice. The gear → Settings → "Everything Jefe
  // knows" door above is the reachability guarantee, so this is safe to pin: the chat log home
  // carries no Memory link of its own, and a future rebase that drags it back fails here
  // instead of shipping.
  assert.doesNotMatch(dailyHome, /See everything Jefe knows/);
  assert.doesNotMatch(dailyHome, /to="\?view=memory"/);
});

test("the settings gear is shell chrome, not chat chrome", () => {
  assert.doesNotMatch(dailyHome, /aria-label="Settings"/);
  assert.doesNotMatch(dailyHome, /settingsHref/);
  assert.match(appShell, /showChrome \? \(/);
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
