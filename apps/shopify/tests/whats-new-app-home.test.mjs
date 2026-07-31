import assert from "node:assert/strict";
import test from "node:test";
import {
  WHATS_NEW_ENTRIES,
  loadAppHomeWhatsNew,
} from "../app/lib/notifications/whats-new.server.js";

test("loadAppHomeWhatsNew shapes curated entries for the rail (headline + body, stable ids)", () => {
  const rows = loadAppHomeWhatsNew({ limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, WHATS_NEW_ENTRIES[0].title); // headline
  assert.equal(rows[0].body, WHATS_NEW_ENTRIES[0].body); // plain-language description
  assert.equal(rows[0].date, WHATS_NEW_ENTRIES[0].date);
  assert.equal(rows[0].tag, null);
  assert.equal(rows[0].id, "wn-0");
  assert.equal(rows[1].id, "wn-1");
});

test("defaults to the top 3 and never exceeds the curated list", () => {
  assert.equal(loadAppHomeWhatsNew().length, Math.min(3, WHATS_NEW_ENTRIES.length));
  const all = loadAppHomeWhatsNew({ limit: 999 });
  assert.equal(all.length, WHATS_NEW_ENTRIES.length);
});

test("curated entries are merchant-facing — no engineer noise (file paths / dev jargon)", () => {
  for (const entry of WHATS_NEW_ENTRIES) {
    const blob = `${entry.title} ${entry.body}`;
    assert.ok(!/\.(tsx?|jsx?|mjs)\b/.test(blob), `no source paths: ${entry.title}`);
    assert.ok(!/shouldRevalidate|Promise\.all|CHANGELOG|preflight/i.test(blob), `no dev jargon: ${entry.title}`);
    assert.ok(entry.title.length > 0 && entry.body.length > 0);
  }
});
