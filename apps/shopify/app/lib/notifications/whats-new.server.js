// @ts-check

// Curated, merchant-facing "What's new" — the SINGLE source of truth for the
// product news a merchant actually reads. Deliberately DECOUPLED from the engineer
// CHANGELOG.md (which is dev-written: file paths, "shouldRevalidate", session refs):
// this is hand-written, in Jefe's voice, and only describes what a merchant can
// actually see. Rendered by BOTH the public /whats-new page and the app-home
// "New in Jefe" rail, so the two never drift.
//
// To add news: add an entry here (newest first). Keep it honest — describe only
// shipped, merchant-visible behaviour; never over-claim (the action layer is
// "suggests / you approve" while execution is gated).
//
// Plain @ts-check .js (not .ts) so the pure mapper is unit-testable under
// `node --test` — the repo invariant for testable logic.

/**
 * @typedef {Object} WhatsNewEntry
 * @property {string} date
 * @property {string} title
 * @property {string} body
 */

/**
 * @typedef {Object} AppHomeWhatsNewItem
 * @property {string} id
 * @property {string} date
 * @property {string} text
 * @property {string | null} tag
 * @property {string} body
 */

/** Newest first. Shown verbatim on /whats-new; the rail takes the top few.
 * @type {ReadonlyArray<WhatsNewEntry>} */
export const WHATS_NEW_ENTRIES = [
  {
    date: "July 2026",
    title: "Talk to Jefe, right in the app",
    body: "Ask Jefe anything or tell it what you know — straight from your home screen. It's one conversation, shared with email and Slack, and it remembers.",
  },
  {
    date: "July 2026",
    title: "Suggestions you can act on",
    body: "Jefe spots opportunities — like stock with cash tied up that hasn't sold in a while — and suggests what to do. You stay in control: approve it, adjust it, or decline with a reason it learns from.",
  },
  {
    date: "July 2026",
    title: "Your store's memory, in one place",
    body: "Jefe builds a living picture of how your business actually works — your products, orders and customers — and shows it back for you to confirm or correct. The more you correct it, the sharper it gets.",
  },
  {
    date: "July 2026",
    title: "A proper welcome",
    body: "When you connect Jefe you get a real hello — and a clear picture of what it's starting to learn about your store, so you know what's happening from minute one.",
  },
];

/**
 * The top few curated entries, shaped for the app-home "New in Jefe" rail. Pure +
 * sync (it's a hand-written const, not the filesystem changelog). `text` is the
 * headline; `body` is the plain-language description the rail shows beneath it.
 * @param {{ limit?: number }} [options]
 * @returns {AppHomeWhatsNewItem[]}
 */
export function loadAppHomeWhatsNew(options = {}) {
  const limit = options.limit ?? 3;
  return WHATS_NEW_ENTRIES.slice(0, Math.max(0, limit)).map((entry, index) => ({
    id: `wn-${index}`,
    date: entry.date,
    text: entry.title,
    tag: null,
    body: entry.body,
  }));
}
