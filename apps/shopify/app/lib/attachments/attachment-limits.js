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

/** PDFs: read as text where they have a text layer, looked at by a model when they are scans. */
export const DOCUMENT_MIME_TYPES = Object.freeze(["application/pdf"]);

/** Word documents. `mammoth` extracts the words exactly — no model involved. */
export const WORD_MIME_TYPES = Object.freeze([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * Spreadsheets we can parse. `.xlsx`/`.xlsm` only — see extract-document-text.server.js for why
 * legacy binary `.xls` is deliberately excluded (the only npm library that reads it carries an
 * unfixed advisory).
 */
export const SPREADSHEET_MIME_TYPES = Object.freeze([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
]);

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
 * Spreadsheet formats we deliberately do NOT parse. Held separately from "unknown" so the
 * merchant gets a way forward — "re-save it as .xlsx or CSV" — rather than a flat refusal.
 * ⚠️ `application/vnd.ms-excel` is also what Windows reports for a plain `.csv`, which is why
 * `attachmentKind` consults the filename before this list is ever consulted.
 */
const UNPARSEABLE_SPREADSHEET_MIME_TYPES = Object.freeze([
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/** Keeps a single inline request within the provider's limits, and keeps a bad upload cheap. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** For the file picker's `accept`. `.csv` is listed by extension too — see `attachmentKind`. */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MIME_TYPES,
  ...DOCUMENT_MIME_TYPES,
  ...WORD_MIME_TYPES,
  ...SPREADSHEET_MIME_TYPES,
  ...TEXT_MIME_TYPES,
  ".csv",
  ".tsv",
  ".txt",
  ".md",
  ".xlsx",
  ".docx",
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
 * @returns {"image" | "document" | "word" | "spreadsheet" | "text" | null}
 */
export function attachmentKind(mimeType, filename) {
  const type = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  const name = typeof filename === "string" ? filename.toLowerCase() : "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  // ⚠️ Extension FIRST for the ambiguous ones. Windows reports a plain `.csv` as
  // application/vnd.ms-excel, which would otherwise be refused as an unparseable spreadsheet —
  // telling a merchant to save their CSV as the thing it already is.
  if ([".csv", ".tsv", ".txt", ".md"].includes(extension)) return "text";
  if ([".xlsx", ".xlsm"].includes(extension)) return "spreadsheet";
  if (extension === ".docx") return "word";

  if (IMAGE_MIME_TYPES.includes(type)) return "image";
  if (DOCUMENT_MIME_TYPES.includes(type)) return "document";
  if (WORD_MIME_TYPES.includes(type)) return "word";
  if (SPREADSHEET_MIME_TYPES.includes(type)) return "spreadsheet";
  if (TEXT_MIME_TYPES.includes(type)) return "text";
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
    if (UNPARSEABLE_SPREADSHEET_MIME_TYPES.includes(type)) {
      return "That's an older spreadsheet format — re-save it as .xlsx or CSV and I'll read every row.";
    }
    if (type.startsWith("video/")) {
      return "I can't watch video yet. A photo of the same thing works, or tell me what's in it.";
    }
    return "I can read photos, PDFs, Word docs, Excel files and CSVs — that one's a file type I can't open.";
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
