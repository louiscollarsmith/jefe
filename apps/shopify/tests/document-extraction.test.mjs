import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import { readAttachment } from "../app/lib/attachments/read-attachment.server.js";
import { hasUsableText } from "../app/lib/attachments/extract-document-text.server.js";

// Spreadsheets, Word documents and text-layer PDFs, added 2026-08-13 on Matt's ask.
//
// ⭐ The property under test throughout is DECODE, DON'T DESCRIBE: a file that contains its own
// words is extracted exactly and never sent to a vision model. It matters commercially, not just
// architecturally — a cost-per-item sheet is the input Jefe's margin work is blocked without, and
// a described spreadsheet is a spreadsheet with invented numbers in it.
//
// These build a REAL .xlsx rather than a fixture, so the test exercises the actual parser
// against the actual format instead of a shape we assumed.

/** @returns {Promise<string>} base64 of a genuine xlsx workbook */
async function buildWorkbook(build) {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
}

const asXlsx = (base64) => ({
  base64,
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  filename: "costs.xlsx",
});

/** A model that must never be reached. */
const forbiddenClient = {
  models: {
    generateContent: async () => {
      throw new Error("a spreadsheet must never reach the vision model");
    },
  },
};

test("a real .xlsx is read exactly, without a provider request", async () => {
  const base64 = await buildWorkbook((wb) => {
    const sheet = wb.addWorksheet("Costs");
    sheet.addRow(["sku", "cost", "price"]);
    sheet.addRow(["TIN-01", 1.2, 3.5]);
    sheet.addRow(["TIN-02", 0.9, 2.75]);
  });

  const result = await readAttachment({ ...asXlsx(base64), client: forbiddenClient });
  assert.equal(result.ok, true);
  assert.match(result.text, /sku,cost,price/);
  // The numbers survive exactly. This is the entire argument for not describing a spreadsheet.
  assert.match(result.text, /TIN-01,1\.2,3\.5/);
  assert.match(result.text, /TIN-02,0\.9,2\.75/);
});

test("a formula cell yields its RESULT, not its source", async () => {
  // The merchant is asking about their numbers, not their spreadsheet. "=B2*3" is not a margin.
  const base64 = await buildWorkbook((wb) => {
    const sheet = wb.addWorksheet("Margins");
    sheet.addRow(["sku", "margin"]);
    sheet.addRow(["TIN-01", { formula: "B1*3", result: 4.5 }]);
  });

  const result = await readAttachment({ ...asXlsx(base64), client: forbiddenClient });
  assert.equal(result.ok, true);
  assert.match(result.text, /TIN-01,4\.5/);
  assert.doesNotMatch(result.text, /B1\*3/, "the formula source is not the answer");
});

test("a comma inside a cell cannot silently become an extra column", async () => {
  const base64 = await buildWorkbook((wb) => {
    const sheet = wb.addWorksheet("Suppliers");
    sheet.addRow(["name", "note"]);
    sheet.addRow(["Fish Co", "Lisbon, Portugal"]);
  });

  const result = await readAttachment({ ...asXlsx(base64), client: forbiddenClient });
  assert.equal(result.ok, true);
  // Quoted, so a downstream reader still sees two columns and not three.
  assert.match(result.text, /Fish Co,"Lisbon, Portugal"/);
});

test("a multi-sheet workbook says which tab each block came from", async () => {
  const base64 = await buildWorkbook((wb) => {
    wb.addWorksheet("Costs").addRow(["sku", "cost"]);
    wb.addWorksheet("Stock").addRow(["sku", "on_hand"]);
  });

  const result = await readAttachment({ ...asXlsx(base64), client: forbiddenClient });
  assert.equal(result.ok, true);
  assert.match(result.text, /# Costs/);
  assert.match(result.text, /# Stock/);
});

test("a single-sheet workbook is not cluttered with a sheet name", async () => {
  const base64 = await buildWorkbook((wb) => {
    wb.addWorksheet("Sheet1").addRow(["sku", "cost"]);
  });
  const result = await readAttachment({ ...asXlsx(base64), client: forbiddenClient });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.text, /^#/m);
});

test("a corrupt spreadsheet is refused with a way forward, never a stack trace", async () => {
  const result = await readAttachment({
    ...asXlsx(Buffer.from("this is not a workbook").toString("base64")),
    client: forbiddenClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /password-protected|save a copy as CSV/i);
  assert.doesNotMatch(result.reason, /Error|undefined|zip/i);
});

test("a corrupt Word document is refused with a way forward", async () => {
  const result = await readAttachment({
    base64: Buffer.from("not a docx").toString("base64"),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "brief.docx",
    client: forbiddenClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PDF or plain text/i);
});

test("a PDF with no text layer falls back to looking at it, not to 'empty'", async () => {
  // A scan or a photographed invoice. Telling the merchant their invoice was blank when it
  // plainly is not would be the worst possible answer here.
  let looked = false;
  const result = await readAttachment({
    base64: Buffer.from("%PDF-1.4 not really a pdf").toString("base64"),
    mimeType: "application/pdf",
    filename: "scan.pdf",
    client: {
      models: {
        generateContent: async () => {
          looked = true;
          return { text: "A supplier invoice for 40 tins, total £412." };
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(looked, true, "a scan is exactly when the vision model earns its request");
  assert.match(result.text, /£412/);
});

test("the text-layer threshold does not treat a letterhead as a readable document", () => {
  assert.equal(hasUsableText(""), false);
  assert.equal(hasUsableText("   \n  \n "), false);
  assert.equal(hasUsableText("INVOICE"), false, "a few stray characters is a scan, not text");
  assert.equal(hasUsableText("x".repeat(40)), true);
});
