// @ts-check

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Changelog watcher: announces new CHANGELOG.md entries to Slack on a schedule,
 * run from the worker tick (Railway infra — never a local routine).
 *
 * Design:
 *  - DURABLE dedup. Every parsed entry is keyed by a content hash and recorded
 *    in `changelog_announcements`, so a deploy/restart never re-announces. (The
 *    daily-digest's in-memory guard re-posts on every deploy; a changelog can't.)
 *  - SEED, don't flood. On the very first run the table is empty, so all current
 *    entries are recorded as `seeded` WITHOUT posting — turning the watcher on
 *    doesn't dump the whole backlog into the channel. Only entries that appear
 *    AFTER that (i.e. shipped in a later deploy) are announced.
 *  - Never throws. Wrapped so a parse/DB/network hiccup can't break the worker.
 *
 * Opt-in via ENABLE_CHANGELOG_WATCHER=true. Posts to CHANGELOG_WEBHOOK_URL, or
 * ALERT_WEBHOOK_URL (#jefe-slack) as a fallback.
 */

/** Re-parse + check at most this often (the worker ticks every ~15s). */
const CHECK_INTERVAL_MS = 15 * 60_000;
/** Cap announcements per run so a mis-parse can't spam the channel. */
const MAX_ANNOUNCE_PER_RUN = 8;

/** epoch ms of the last check; module-local throttle. Reset on restart. */
let lastCheckMs = 0;

/** @returns {boolean} */
export function isChangelogWatcherEnabled() {
  return (
    String(process.env.ENABLE_CHANGELOG_WATCHER ?? "").trim().toLowerCase() ===
    "true"
  );
}

/** @returns {string | undefined} */
function changelogWebhookUrl() {
  return process.env.CHANGELOG_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;
}

/**
 * Strip the markdown that would read as noise in plain text / Slack: bold,
 * inline code, and `[label](href)` links (kept as the label).
 * @param {string} value
 * @returns {string}
 */
export function stripMarkdown(value) {
  return String(value)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A short title for an entry: the first bolded phrase (the feature name in this
 * changelog's convention), else the leading text.
 * @param {string} body
 * @returns {string}
 */
export function extractTitle(body) {
  const bold = /\*\*(.+?)\*\*/.exec(body);
  const raw = bold ? bold[1] : body;
  return stripMarkdown(raw).slice(0, 160);
}

/**
 * A one-line summary for Slack: the first sentence (stripped), truncated.
 * @param {string} body
 * @returns {string}
 */
export function summarizeForSlack(body) {
  const stripped = stripMarkdown(body);
  // First sentence boundary after enough characters to skip "e.g." etc.
  const idx = stripped.indexOf(". ", 60);
  const sentence = idx > 0 ? stripped.slice(0, idx + 1) : stripped;
  return sentence.length > 320 ? `${sentence.slice(0, 317)}…` : sentence;
}

/**
 * @param {string} section @param {string} body
 * @returns {string}
 */
function hashEntry(section, body) {
  return crypto
    .createHash("sha256")
    .update(`${section}\n${body}`)
    .digest("hex");
}

/**
 * @typedef {Object} ChangelogEntry
 * @property {string} section The date heading, e.g. "2026-07-30".
 * @property {string} body The full entry text (markdown, single line).
 * @property {string} title Short feature-name title.
 * @property {string} hash Stable content hash (dedup key).
 */

/**
 * Parse CHANGELOG.md into flat entries. Pure + exported for tests. Assumes the
 * repo convention: `## YYYY-MM-DD` date headings, `### Added`-style subheadings
 * (ignored), and one entry per top-level `- ` bullet (single line).
 *
 * @param {string} markdown
 * @returns {ChangelogEntry[]} newest-first (file order)
 */
export function parseChangelogEntries(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  /** @type {ChangelogEntry[]} */
  const entries = [];
  let section = null;
  for (const line of lines) {
    // `## DATE` opens a section; `### Added` (three hashes) is NOT a section.
    const sectionMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (sectionMatch && !/^###/.test(line)) {
      section = sectionMatch[1].trim();
      continue;
    }
    const bulletMatch = /^-\s+(.*\S)\s*$/.exec(line);
    if (bulletMatch && section) {
      const body = bulletMatch[1].trim();
      entries.push({
        section,
        body,
        title: extractTitle(body),
        hash: hashEntry(section, body),
      });
    }
  }
  return entries;
}

/**
 * Candidate on-disk locations for CHANGELOG.md, tried in order (mirrors the
 * email template loader). The full source tree ships in every target env
 * (`node --test`, `shopify app dev`, and the prod Docker image's `COPY . .`).
 * @returns {string[]}
 */
function changelogCandidates() {
  return [
    fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url)),
    path.join(process.cwd(), "CHANGELOG.md"),
    path.join(process.cwd(), "apps", "shopify", "CHANGELOG.md"),
  ];
}

/**
 * Read CHANGELOG.md, or null if not found (never throws).
 * @returns {string | null}
 */
export function loadChangelogMarkdown() {
  for (const candidate of changelogCandidates()) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Format a single entry as a Slack message body (`{text}` webhook payload).
 * @param {ChangelogEntry} entry
 * @param {{ version?: string | null }} [options]
 * @returns {string}
 */
export function formatEntryForSlack(entry, options = {}) {
  // The SHA of the code that is RUNNING, not of some branch — this watcher reads the
  // CHANGELOG.md inside its own deploy, so by the time it can see an entry, that entry is live.
  // That is the whole reason the post can honestly say "live". (Matt, 2026-08-12: always
  // reference the commit — a changelog you cannot tie to a diff is a story, not a record.)
  const sha = String(options.version ?? "").trim().slice(0, 7);
  const footer = sha ? `\n_live · ${sha}_` : "";
  return `:memo: *Jefe changelog · ${entry.section}*\n${summarizeForSlack(entry.body)}${footer}\n---------`;
}

/**
 * Post one entry to a Slack incoming webhook. Returns true on a 2xx.
 * @param {string} webhookUrl
 * @param {ChangelogEntry} entry
 * @param {typeof fetch} fetchImpl
 * @param {string | null} [version]
 * @returns {Promise<boolean>}
 */
async function postEntryToSlack(webhookUrl, entry, fetchImpl, version) {
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: formatEntryForSlack(entry, { version }) }),
  });
  return res.ok;
}

/**
 * The worker-tick hook. Opt-in, throttled, durable, non-throwing.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   logger?: Pick<Console, "info" | "warn" | "error">;
 *   now?: Date;
 *   fetchImpl?: typeof fetch;
 *   force?: boolean;
 *   markdown?: string;
 *   webhookUrl?: string;
 *   version?: string | null;
 * }} [opts]
 * @returns {Promise<{ status: string; seeded?: number; announced?: number } | null>}
 */
export async function maybePostChangelog(prisma, opts = {}) {
  if (!isChangelogWatcherEnabled()) return null;
  const now = opts.now ?? new Date();
  if (!opts.force && now.getTime() - lastCheckMs < CHECK_INTERVAL_MS) {
    return null;
  }
  lastCheckMs = now.getTime();

  const logger = opts.logger ?? console;
  try {
    const markdown = opts.markdown ?? loadChangelogMarkdown();
    if (!markdown) {
      logger.warn?.("changelog watcher: CHANGELOG.md not found; skipping");
      return { status: "no_changelog" };
    }
    const entries = parseChangelogEntries(markdown);
    if (entries.length === 0) return { status: "empty" };

    const known = await prisma.changelogAnnouncement.findMany({
      select: { entryHash: true },
    });
    const knownHashes = new Set(known.map((row) => row.entryHash));
    const fresh = entries.filter((entry) => !knownHashes.has(entry.hash));
    if (fresh.length === 0) return { status: "up_to_date" };

    // First-ever run: record the whole current changelog as seeded, announce
    // nothing. This is what stops enabling the watcher from flooding Slack.
    const firstRun = known.length === 0;
    if (firstRun) {
      await prisma.changelogAnnouncement.createMany({
        data: fresh.map((entry) => ({
          entryHash: entry.hash,
          section: entry.section,
          title: entry.title,
          body: entry.body,
          seeded: true,
          postedToSlack: false,
        })),
        skipDuplicates: true,
      });
      logger.info?.("changelog watcher: seeded baseline (no announcements)", {
        seeded: fresh.length,
      });
      return { status: "seeded", seeded: fresh.length };
    }

    // Subsequent runs: announce the new entries (newest first), capped.
    const webhookUrl = opts.webhookUrl ?? changelogWebhookUrl();
    const fetchImpl =
      opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    const toAnnounce = fresh.slice(0, MAX_ANNOUNCE_PER_RUN);
    if (fresh.length > MAX_ANNOUNCE_PER_RUN) {
      logger.warn?.("changelog watcher: capping announcements this run", {
        fresh: fresh.length,
        cap: MAX_ANNOUNCE_PER_RUN,
      });
    }

    let announced = 0;
    for (const entry of toAnnounce) {
      let posted = false;
      if (webhookUrl && fetchImpl) {
        try {
          posted = await postEntryToSlack(
            webhookUrl,
            entry,
            fetchImpl,
            opts.version ?? process.env.APP_VERSION ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
          );
        } catch (error) {
          logger.warn?.("changelog watcher: Slack post failed", {
            err: error,
            section: entry.section,
          });
        }
      }
      // Record regardless of post outcome so a webhook blip doesn't cause a
      // re-announce storm on the next run; a failed post is logged above.
      await prisma.changelogAnnouncement.createMany({
        data: [
          {
            entryHash: entry.hash,
            section: entry.section,
            title: entry.title,
            body: entry.body,
            seeded: false,
            postedToSlack: posted,
          },
        ],
        skipDuplicates: true,
      });
      if (posted) announced += 1;
    }

    logger.info?.("changelog watcher: announced new entries", {
      announced,
      considered: toAnnounce.length,
    });
    return { status: "announced", announced };
  } catch (error) {
    logger.error?.("changelog watcher failed", { err: error });
    return { status: "error" };
  }
}

/** Test seam: reset the in-memory throttle. */
export function __resetChangelogThrottleForTests() {
  lastCheckMs = 0;
}
