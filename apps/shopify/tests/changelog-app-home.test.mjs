import assert from "node:assert/strict";
import test from "node:test";
import {
  friendlyChangelogDate,
  mapChangelogEntriesToAppHome,
} from "../app/lib/notifications/changelog-app-home.js";

const ENTRIES = [
  {
    date: "2026-07-30",
    sections: [{ category: "Fixed", items: ["An older fix"] }],
  },
  {
    date: "2026-07-31",
    sections: [
      { category: "Added", items: ["**Feature** with `code` and a [link](https://x.test)"] },
      { category: "Internal", items: ["ci pipeline tweak"] },
    ],
  },
];

test("mapChangelogEntriesToAppHome is newest-first and strips markdown", () => {
  const rows = mapChangelogEntriesToAppHome(ENTRIES);
  // Newest entry (2026-07-31) leads.
  assert.equal(rows[0].date, "31 Jul 2026");
  assert.equal(rows[0].text, "Feature with code and a link"); // bold/code/link stripped
  assert.equal(rows[0].tag, "Added");
  assert.equal(rows[0].id, "2026-07-31-0-0");
  // The older entry follows.
  assert.equal(rows[1].text, "An older fix");
  assert.equal(rows[1].date, "30 Jul 2026");
});

test("Internal-only sections are dropped (not merchant-facing)", () => {
  const rows = mapChangelogEntriesToAppHome(ENTRIES);
  assert.ok(!rows.some((r) => r.tag === "Internal"));
  assert.ok(!rows.some((r) => r.text.includes("ci pipeline")));
});

test("the limit is respected", () => {
  const many = [
    {
      date: "2026-07-31",
      sections: [{ category: "Added", items: ["a", "b", "c", "d", "e"] }],
    },
  ];
  assert.equal(mapChangelogEntriesToAppHome(many, { limit: 2 }).length, 2);
});

test("non-array input yields an empty list (never throws)", () => {
  assert.deepEqual(mapChangelogEntriesToAppHome(null), []);
  assert.deepEqual(mapChangelogEntriesToAppHome(undefined), []);
});

test("friendlyChangelogDate formats ISO dates and falls back gracefully", () => {
  assert.equal(friendlyChangelogDate("2026-07-31"), "31 Jul 2026");
  assert.equal(friendlyChangelogDate("not-a-date"), "not-a-date");
});
