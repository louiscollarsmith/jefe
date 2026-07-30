-- Durable dedup for the changelog watcher: one row per CHANGELOG.md entry the
-- watcher has seen, keyed by a content hash, so a deploy/restart never
-- re-announces an entry to Slack. `seeded` marks entries that existed when the
-- watcher first ran (recorded, never announced) so turning it on doesn't flood
-- the channel. Also the durable source a public changelog page can render later.

CREATE TABLE "changelog_announcements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "entry_hash" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "posted_to_slack" BOOLEAN NOT NULL DEFAULT false,
  "seeded" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "changelog_announcements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "changelog_announcements_entry_hash_key"
  ON "changelog_announcements" ("entry_hash");

CREATE INDEX "changelog_announcements_section_idx"
  ON "changelog_announcements" ("section");
