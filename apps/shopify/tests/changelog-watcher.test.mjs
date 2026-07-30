import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  parseChangelogEntries,
  stripMarkdown,
  extractTitle,
  summarizeForSlack,
  formatEntryForSlack,
  isChangelogWatcherEnabled,
  maybePostChangelog,
} from "../app/services/changelog/changelog-watcher.server.js";

const databaseUrl = process.env.DATABASE_URL;

/** Save/restore an env var around a callback. */
async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

test("parseChangelogEntries extracts date sections + bullets, ignores ### subheads", () => {
  const md = [
    "# Changelog",
    "",
    "## 2026-07-30",
    "",
    "### Added",
    "",
    "- Added the **win-back email** — the churn-side counterpart. Full gate green.",
    "- Added **thing two** — another entry on the same day.",
    "",
    "## 2026-07-29",
    "",
    "### Added",
    "- Older **entry** — from yesterday.",
  ].join("\n");

  const entries = parseChangelogEntries(md);
  assert.equal(entries.length, 3, "three bullets, headings ignored");
  assert.equal(entries[0].section, "2026-07-30");
  assert.equal(entries[0].title, "win-back email");
  assert.equal(entries[2].section, "2026-07-29");
  // Hashes are stable across parses and unique per entry.
  assert.equal(entries[0].hash, parseChangelogEntries(md)[0].hash);
  assert.notEqual(entries[0].hash, entries[1].hash);
});

test("parseChangelogEntries tolerates empty / heading-only input", () => {
  assert.deepEqual(parseChangelogEntries(""), []);
  assert.deepEqual(parseChangelogEntries("# Changelog\n\n## 2026-07-30\n"), []);
});

test("stripMarkdown / extractTitle / summarizeForSlack clean markdown", () => {
  assert.equal(stripMarkdown("a **b** `c` [d](http://x)"), "a b c d");
  assert.equal(
    extractTitle("Added the **cost-sheet engine** — parses a spreadsheet"),
    "cost-sheet engine",
  );
  const summary = summarizeForSlack(
    "Added the **X** — does a thing that is genuinely useful for merchants. And more detail after.",
  );
  assert.ok(summary.startsWith("Added the X — does a thing"));
  assert.ok(!summary.includes("**"), "markdown stripped");
  assert.ok(!summary.includes("And more detail"), "trimmed to first sentence");
});

test("formatEntryForSlack includes the section + a summary line", () => {
  const [entry] = parseChangelogEntries("## 2026-07-30\n- **Feature** — did the thing.");
  const text = formatEntryForSlack(entry);
  assert.ok(text.includes("2026-07-30"));
  assert.ok(text.includes("Feature"));
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test("watcher is a no-op unless ENABLE_CHANGELOG_WATCHER=true", async () => {
  await withEnv("ENABLE_CHANGELOG_WATCHER", undefined, async () => {
    assert.equal(isChangelogWatcherEnabled(), false);
    const res = await maybePostChangelog(/** @type {any} */ ({}), {
      force: true,
      markdown: "## 2026-07-30\n- **x** — y.",
    });
    assert.equal(res, null);
  });
});

// ---------------------------------------------------------------------------
// Seed-then-announce (DB-backed, no real Slack)
// ---------------------------------------------------------------------------

test("watcher seeds the backlog on first run, then announces only new entries", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the changelog seed/announce test");
    return;
  }

  await withEnv("ENABLE_CHANGELOG_WATCHER", "true", async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    const sectionA = `zzztest-a-${Date.now()}`;
    const sectionB = `zzztest-b-${Date.now()}`;
    const md1 = `## ${sectionA}\n- **alpha** — first entry here.\n- **beta** — second entry here.`;
    const md2 = `## ${sectionB}\n- **gamma** — a brand new entry.\n${md1}`;

    /** @type {Array<{ url: string; body: any }>} */
    const calls = [];
    const fetchImpl = /** @type {any} */ (
      async (url, init) => {
        calls.push({ url, body: init?.body });
        return { ok: true };
      }
    );

    try {
      // Isolate: this table is exclusively the watcher's; start from empty so
      // the global "first run = empty table" heuristic is exercised cleanly.
      await prisma.changelogAnnouncement.deleteMany({});

      // Run 1 (first run): seed the two current entries, announce NOTHING.
      const first = await maybePostChangelog(prisma, {
        force: true,
        markdown: md1,
        webhookUrl: "https://slack.test/hook",
        fetchImpl,
      });
      assert.equal(first?.status, "seeded");
      assert.equal(first?.seeded, 2);
      assert.equal(calls.length, 0, "seed run must not post to Slack");
      assert.equal(await prisma.changelogAnnouncement.count(), 2);

      // Run 2: one genuinely new entry appears -> announce exactly it.
      const second = await maybePostChangelog(prisma, {
        force: true,
        markdown: md2,
        webhookUrl: "https://slack.test/hook",
        fetchImpl,
      });
      assert.equal(second?.status, "announced");
      assert.equal(second?.announced, 1);
      assert.equal(calls.length, 1, "exactly one Slack post for the new entry");
      assert.ok(String(calls[0].body).includes("gamma"));
      assert.equal(await prisma.changelogAnnouncement.count(), 3);

      // Run 3: nothing new -> no-op, no posts.
      const third = await maybePostChangelog(prisma, {
        force: true,
        markdown: md2,
        webhookUrl: "https://slack.test/hook",
        fetchImpl,
      });
      assert.equal(third?.status, "up_to_date");
      assert.equal(calls.length, 1, "no further posts when nothing is new");
    } finally {
      await prisma.changelogAnnouncement.deleteMany({});
      await prisma.$disconnect();
    }
  });
});
