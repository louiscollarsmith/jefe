// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG_FILENAME = "CHANGELOG.md";
const CHANGELOG_PATH = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  CHANGELOG_FILENAME,
);
const CHANGELOG_CATEGORIES = new Set([
  "Added",
  "Changed",
  "Fixed",
  "Removed",
  "Security",
  "Internal",
]);

/**
 * @typedef {object} ChangelogSection
 * @property {string} category
 * @property {string[]} items
 */

/**
 * @typedef {object} ChangelogEntry
 * @property {string} date
 * @property {ChangelogSection[]} sections
 */

/**
 * @param {string} markdown
 * @returns {ChangelogEntry[]}
 */
export function parseChangelogMarkdown(markdown) {
  /** @type {ChangelogEntry[]} */
  const entries = [];
  /** @type {ChangelogEntry | null} */
  let currentEntry = null;
  /** @type {ChangelogSection | null} */
  let currentSection = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const dateMatch = line.match(/^## (\d{4})-(\d{2})-(\d{2})$/);
    const sectionMatch = line.match(/^### (.+)$/);
    const itemMatch = line.match(/^- (.+)$/);

    if (dateMatch) {
      currentEntry = {
        date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
        sections: [],
      };
      entries.push(currentEntry);
      currentSection = null;
      continue;
    }

    if (sectionMatch && currentEntry) {
      const category = sectionMatch[1];

      if (!CHANGELOG_CATEGORIES.has(category)) {
        currentSection = null;
        continue;
      }

      currentSection = { category, items: [] };
      currentEntry.sections.push(currentSection);
      continue;
    }

    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1]);
    }
  }

  return entries
    .map((entry) => ({
      ...entry,
      sections: entry.sections.filter((section) => section.items.length > 0),
    }))
    .filter((entry) => entry.sections.length > 0);
}

export async function loadChangelog() {
  const markdown = await readFile(CHANGELOG_PATH, "utf8");

  return parseChangelogMarkdown(markdown);
}
