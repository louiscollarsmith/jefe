// @ts-check

// Maps the engineer-facing CHANGELOG.md (parsed by services/changelog.server.js)
// into the compact rows the app-home right rail ("New in Jefe") renders. Pure
// mapper + a thin loader; nothing fabricated — it only reshapes real changelog
// entries. Internal-only notes are dropped (not merchant-facing) and markdown is
// stripped so no raw `code`/**bold**/[links] leak into the rail.

import { loadChangelog } from "../../services/changelog.server.js";
import { stripMarkdown } from "../../services/changelog/changelog-watcher.server.js";

const DEFAULT_LIMIT = 6;

/**
 * @typedef {Object} AppHomeChangelogItem
 * @property {string} id
 * @property {string} date  friendly, display-ready
 * @property {string} text
 * @property {string | null} tag  the changelog category (e.g. "Added")
 */

/**
 * Friendly, timezone-stable date label for an ISO `YYYY-MM-DD` string. Mirrors the
 * changelog route's formatting (Europe/London) so the rail and the full changelog
 * page read the same. Falls back to the raw string if it can't be parsed.
 * @param {string} date
 * @returns {string}
 */
export function friendlyChangelogDate(date) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(parsed);
}

/**
 * Flatten parsed changelog entries into newest-first app-home rows. Pure — takes
 * the same shape `loadChangelog()` returns and returns display-ready items.
 * @param {Array<{ date: string; sections: Array<{ category: string; items: string[] }> }>} entries
 * @param {{ limit?: number }} [options]
 * @returns {AppHomeChangelogItem[]}
 */
export function mapChangelogEntriesToAppHome(entries, options = {}) {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Array.isArray(entries)) return [];

  const ordered = [...entries].sort((a, b) =>
    String(b?.date ?? "").localeCompare(String(a?.date ?? "")),
  );

  /** @type {AppHomeChangelogItem[]} */
  const rows = [];
  for (const entry of ordered) {
    if (!entry || !Array.isArray(entry.sections)) continue;
    const friendly = friendlyChangelogDate(entry.date);
    entry.sections.forEach((section, sectionIndex) => {
      if (!section || section.category === "Internal") return; // engineer-only
      if (!Array.isArray(section.items)) return;
      section.items.forEach((item, itemIndex) => {
        const text = stripMarkdown(item);
        if (!text) return;
        rows.push({
          id: `${entry.date}-${sectionIndex}-${itemIndex}`,
          date: friendly,
          text,
          tag: section.category ?? null,
        });
      });
    });
    if (rows.length >= limit) break;
  }
  return rows.slice(0, limit);
}

/**
 * Load + map the changelog for the app-home rail. Server-only (reads CHANGELOG.md).
 * Never throws into the loader — an unreadable changelog yields an empty rail.
 * @param {{ limit?: number }} [options]
 * @returns {Promise<AppHomeChangelogItem[]>}
 */
export async function loadAppHomeChangelog(options = {}) {
  try {
    const entries = await loadChangelog();
    return mapChangelogEntriesToAppHome(entries, options);
  } catch {
    return [];
  }
}
