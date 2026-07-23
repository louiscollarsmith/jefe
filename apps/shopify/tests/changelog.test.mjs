import assert from "node:assert/strict";
import test from "node:test";
import {
  loadChangelog,
  parseChangelogMarkdown,
} from "../app/services/changelog.server.js";

test("changelog parser reads dated entries and allowed sections", () => {
  const entries = parseChangelogMarkdown(`# Changelog

## 2026-07-14

### Added

- Added Changelog v0.

### Changed

- Improved evidence backfill copy.

### Noise

- This should not render.

---

## 2026-07-13

### Fixed

- Fixed product webhook state.
`);

  assert.deepEqual(entries, [
    {
      date: "2026-07-14",
      sections: [
        { category: "Added", items: ["Added Changelog v0."] },
        { category: "Changed", items: ["Improved evidence backfill copy."] },
      ],
    },
    {
      date: "2026-07-13",
      sections: [
        { category: "Fixed", items: ["Fixed product webhook state."] },
      ],
    },
  ]);
});

test("changelog parser ignores non-Jefe date formats", () => {
  const entries = parseChangelogMarkdown(`# @shopify/shopify-app-template-react-router

## 2026.07.16

### Fixed

- Fixed Shopify history setup progress.
`);

  assert.deepEqual(entries, []);
});

test("changelog loader finds the app changelog from the app workspace", async () => {
  const entries = await loadChangelog();

  assert.ok(entries.length >= 4);
  assert.equal(entries[0].date, "2026-07-23");
  assert.ok(
    entries[0].sections.some((section) =>
      section.items.some((item) =>
        item.includes("Store Understanding pass after deterministic Merchant Memory rebuilds"),
      ),
    ),
  );
});
