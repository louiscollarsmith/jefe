// @ts-check

// Turning a merchant's file into text, without a model where that is possible.
//
// ⭐ The governing principle: DECODE, DON'T DESCRIBE. A spreadsheet, a text-layer PDF and a
// Word document all contain their own words already. Extracting them is exact, instant and
// free; asking a vision model to describe them is approximate, slow, costs a request, and can
// invent a number that was never there. A model is the FALLBACK for things that are genuinely
// pictures — a photo of a shelf, a scan of an invoice — not the default.
//
// Every parser is imported dynamically. They are large, and most requests never touch one.
//
// ⚠️ NOT the same extractor as `merchant-goals/service.server.js`, which has its own pdf/docx
// path with different caps and merchant-facing wording. That one should move onto this module;
// it is left alone here because it is a working surface and this landed on a client-onboarding
// day. See the follow-up task.

/** Legacy binary `.xls` (BIFF) and `.ods` are deliberately NOT supported — see the note below. */
export const SPREADSHEET_EXTENSIONS = Object.freeze([".xlsx", ".xlsm"]);

/**
 * Read a spreadsheet as text, one line per row, comma-separated — the same shape a CSV arrives
 * in, so everything downstream treats them identically.
 *
 * ⛔ `.xlsx` only, on purpose. The only library that reads legacy binary `.xls` is SheetJS, and
 * the copy published to npm (`xlsx@0.18.5`) is frozen with an unfixed prototype-pollution
 * advisory — SheetJS moved distribution to their own CDN. A merchant with a genuine `.xls` is
 * told to re-save it, which takes them ten seconds, rather than us carrying that dependency.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractSpreadsheetText(buffer) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  // exceljs types the parameter as the DOM `Buffer`; a Node Buffer is what it actually wants.
  await workbook.xlsx.load(/** @type {any} */ (buffer));

  /** @type {string[]} */
  const lines = [];
  workbook.eachSheet((sheet) => {
    // Named, because "which tab is this from" is the first question a multi-sheet workbook
    // raises and the answer is otherwise lost the moment the rows are flattened.
    if (workbook.worksheets.length > 1) lines.push(`# ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      lines.push(values.map(cellToText).join(","));
    });
  });
  return lines.join("\n");
}

/**
 * A cell can be a formula result, a hyperlink, a date or rich text. Take the value a person
 * would see — a formula's `.result`, not its source — because the merchant is asking about
 * their numbers, not their spreadsheet.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cellToText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const cell = /** @type {any} */ (value);
    if ("result" in cell) return cellToText(cell.result);
    if ("text" in cell) return cellToText(cell.text);
    if ("hyperlink" in cell) return cellToText(cell.text ?? cell.hyperlink);
    if (Array.isArray(cell.richText)) return cell.richText.map((/** @type {any} */ r) => r.text).join("");
    return "";
  }
  const text = String(value);
  // A cell containing a comma would otherwise silently become two columns.
  return text.includes(",") || text.includes('"') ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return parsed.text ?? "";
  } finally {
    await parser.destroy();
  }
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractDocxText(buffer) {
  const mammoth = await import("mammoth");
  const parsed = await mammoth.extractRawText({ buffer });
  return parsed.value ?? "";
}

/**
 * Is there enough here to be worth using, or is this a scan that needs eyes?
 *
 * A photographed or scanned PDF extracts to nothing (or to a few stray characters from a
 * letterhead). That is the case where a vision model genuinely earns its request, so the
 * threshold decides between "read it exactly" and "look at it".
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasUsableText(text) {
  return String(text ?? "").replace(/\s+/g, "").length >= 40;
}
