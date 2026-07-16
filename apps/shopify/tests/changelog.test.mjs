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

- Improved Daily Verdict copy.

### Noise

- This should not render.

---

## 2026-07-13

### Fixed

- Fixed onboarding state.
`);

  assert.deepEqual(entries, [
    {
      date: "2026-07-14",
      sections: [
        { category: "Added", items: ["Added Changelog v0."] },
        { category: "Changed", items: ["Improved Daily Verdict copy."] },
      ],
    },
    {
      date: "2026-07-13",
      sections: [
        { category: "Fixed", items: ["Fixed onboarding state."] },
      ],
    },
  ]);
});

test("changelog parser accepts the app changelog date format", () => {
  const entries = parseChangelogMarkdown(`# @shopify/shopify-app-template-react-router

## 2026.07.16

### Fixed

- Fixed Shopify history setup progress.
`);

  assert.deepEqual(entries, [
    {
      date: "2026-07-16",
      sections: [
        { category: "Fixed", items: ["Fixed Shopify history setup progress."] },
      ],
    },
  ]);
});

test("changelog loader finds the app changelog from the app workspace", async () => {
  const entries = await loadChangelog({ cwd: process.cwd() });

  assert.ok(entries.length >= 2);
  assert.equal(entries[0].date, "2026-07-16");
  assert.ok(
    entries[0].sections.some((section) =>
      section.items.some((item) => item.includes("Shopify history setup")),
    ),
  );
});
