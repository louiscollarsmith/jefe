// @ts-check

// What Jefe will accept from a merchant, and why — the rules the COMPOSER and the SERVER both
// need. Deliberately not a `.server` module: a file the browser rejects instantly costs nothing,
// and a file it lets through must be refused again on arrival. Two checks, ONE definition —
// duplicating the allow-list is how a composer ends up offering something the server bounces.

/** Formats a vision model can actually look at. */
export const IMAGE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Documents the same model reads page by page. */
export const DOCUMENT_MIME_TYPES = Object.freeze(["application/pdf"]);

/**
 * Formats that are already text. These never touch a model to be READ — decoding beats
 * describing: it is exact, free, instant, and a model cannot hallucinate a price that is
 * sitting there in row 40. A cost-per-item export is the single most useful file a merchant
 * can send, because margin work is blocked without it.
 */
export const TEXT_MIME_TYPES = Object.freeze([
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/tab-separated-values",
  "application/csv",
  "application/json",
]);

/**
 * Spreadsheets we cannot parse (no parser dependency in this app). Held separately from
 * "unknown" so the merchant gets a way forward — "save it as CSV" — instead of a refusal.
 */
const SPREADSHEET_MIME_TYPES = Object.freeze([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/** Keeps a single inline request within the provider's limits, and keeps a bad upload cheap. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** For the file picker's `accept`. `.csv` is listed by extension too — see `attachmentKind`. */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MIME_TYPES,
  ...DOCUMENT_MIME_TYPES,
  ...TEXT_MIME_TYPES,
  ".csv",
  ".tsv",
  ".txt",
  ".md",
].join(",");

/**
 * What KIND of thing this is, or null if we cannot read it.
 *
 * ⚠️ The filename is consulted on purpose. Windows reports a plain `.csv` as
 * `application/vnd.ms-excel`, so deciding on the MIME type alone would refuse a perfectly
 * readable CSV and tell the merchant to save it as the thing it already is.
 *
 * @param {unknown} mimeType
 * @param {unknown} [filename]
 * @returns {"image" | "document" | "text" | null}
 */
export function attachmentKind(mimeType, filename) {
  const type = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  const name = typeof filename === "string" ? filename.toLowerCase() : "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  if (IMAGE_MIME_TYPES.includes(type)) return "image";
  if (DOCUMENT_MIME_TYPES.includes(type)) return "document";
  if (TEXT_MIME_TYPES.includes(type)) return "text";
  // Extension as a fallback: browsers disagree about CSV, and some send no type at all.
  if ([".csv", ".tsv", ".txt", ".md"].includes(extension)) return "text";
  return null;
}

/**
 * @param {unknown} mimeType
 * @param {unknown} [filename]
 * @returns {boolean}
 */
export function isReadableAttachment(mimeType, filename) {
  return attachmentKind(mimeType, filename) !== null;
}

/**
 * Refuse before spending anything — a bad upload should cost a validation branch, not a
 * provider round-trip. Returns a merchant-facing reason, or null when the file is fine.
 *
 * ⛔ No dead ends: every refusal names something the merchant can actually do next.
 *
 * @param {{ mimeType?: unknown; byteLength?: unknown; filename?: unknown }} input
 * @returns {string | null}
 */
export function attachmentRejectionReason(input) {
  const kind = attachmentKind(input?.mimeType, input?.filename);
  if (!kind) {
    const type = typeof input?.mimeType === "string" ? input.mimeType.toLowerCase() : "";
    if (SPREADSHEET_MIME_TYPES.includes(type)) {
      return "I can't open Excel files yet — save it as CSV and I'll read every row.";
    }
    if (type.startsWith("video/")) {
      return "I can't watch video yet. A photo of the same thing works, or tell me what's in it.";
    }
    return "I can read photos, PDFs and CSVs — that one's a file type I can't open.";
  }
  const bytes = Number(input?.byteLength);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "That file came through empty — worth trying again.";
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return "That file's too big for me to read — under 8MB and I'll manage it.";
  }
  return null;
}
