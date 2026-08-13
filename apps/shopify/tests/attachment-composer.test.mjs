import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  ATTACHMENT_FIELD,
  MAX_UPLOAD_BYTES,
  composeAttachmentMessage,
  oversizedUploadReason,
  readUploadedAttachment,
} from "../app/lib/attachments/attachment-message.server.js";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
} from "../app/lib/attachments/attachment-limits.js";

// The composer half of "a merchant can send Jefe a photo". `read-attachment.test.mjs` already
// covers turning bytes into words; this covers the seam either side of it — the form field, the
// size guard that runs before the body is buffered, and the sentence that ends up in the thread.
//
// The property that matters most: the model's reading of the file is stored as the MERCHANT'S
// message, so it has to be visibly labelled as a reading rather than as something they typed.
// Unlabelled, a misread invoice becomes an unchallengeable merchant-stated fact.

function stubClient(text) {
  return {
    models: {
      generateContent: async () => ({
        text,
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    },
  };
}

function formWithFile(bytes, { type = "image/jpeg", name = "shelf.jpg" } = {}) {
  const form = new FormData();
  form.set(ATTACHMENT_FIELD, new File([bytes], name, { type }));
  return form;
}

test("a file with no words is a complete message", () => {
  const composed = composeAttachmentMessage({
    message: "",
    filename: "invoice.pdf",
    extract: "Supplier invoice, 40 tins, £412 total.",
  });
  assert.match(composed, /invoice\.pdf/);
  assert.match(composed, /£412/);
  assert.doesNotMatch(composed, /^\n/, "no leading blank line when they typed nothing");
});

test("the model's reading is labelled, never passed off as the merchant's words", () => {
  const composed = composeAttachmentMessage({
    message: "what do you make of this?",
    filename: "invoice.pdf",
    extract: "Supplier invoice, 40 tins.",
  });
  // Their words come first and survive intact.
  assert.match(composed, /^what do you make of this\?/);
  // And the extract is marked as Jefe's reading of a file.
  assert.match(composed, /\[Attached: invoice\.pdf — here is what I can see in it\]/);
  assert.ok(
    composed.indexOf("what do you make") < composed.indexOf("[Attached"),
    "the merchant speaks first",
  );
});

test("a missing filename does not produce a broken label", () => {
  const composed = composeAttachmentMessage({ message: "", filename: null, extract: "A shelf." });
  assert.match(composed, /\[Attached file — here is what I can see in it\]/);
  assert.doesNotMatch(composed, /null|undefined/);
});

test("no extract leaves the typed message exactly as it was", () => {
  assert.equal(composeAttachmentMessage({ message: "hello", extract: "" }), "hello");
  assert.equal(composeAttachmentMessage({ message: "hello" }), "hello");
  // Nothing at all is empty, which the caller treats as "do not store a turn".
  assert.equal(composeAttachmentMessage({}), "");
});

test("an oversized body is refused from Content-Length, before it is buffered", () => {
  const oversized = new Request("https://example.test", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": String(MAX_UPLOAD_BYTES + 1),
    },
  });
  assert.match(oversizedUploadReason(oversized), /too big/);

  const fine = new Request("https://example.test", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=x",
      "content-length": String(MAX_ATTACHMENT_BYTES),
    },
  });
  assert.equal(oversizedUploadReason(fine), null);
});

test("an ordinary text message is never touched by the upload guard", () => {
  // Every non-attachment intent on this route goes through the same guard; a missing or absurd
  // Content-Length on a normal form must not turn a chat message into an error.
  for (const headers of [
    { "content-type": "application/x-www-form-urlencoded", "content-length": "99999999999" },
    { "content-type": "application/x-www-form-urlencoded" },
  ]) {
    const request = new Request("https://example.test", { method: "POST", headers });
    assert.equal(oversizedUploadReason(request), null);
  }
});

test("no attachment is null, not a failure", async () => {
  assert.equal(await readUploadedAttachment(new FormData()), null);
  // Some browsers submit an empty part for an untouched file input.
  const empty = new FormData();
  empty.set(ATTACHMENT_FIELD, new File([], "", { type: "application/octet-stream" }));
  assert.equal(await readUploadedAttachment(empty), null);
});

test("a file type we cannot read is refused without spending a request", async () => {
  let called = false;
  const result = await readUploadedAttachment(
    formWithFile("x".repeat(100), { type: "video/quicktime", name: "clip.mov" }),
    {
      client: {
        models: {
          generateContent: async () => {
            called = true;
            return { text: "never" };
          },
        },
      },
    },
  );
  assert.equal(result.ok, false);
  // Video now gets its own sentence (see the video test below); what this one pins is that the
  // refusal happened before any provider request.
  assert.match(result.reason, /can't watch video/i);
  assert.equal(called, false);
});

test("a good file becomes words the thread can hold", async () => {
  const result = await readUploadedAttachment(formWithFile("x".repeat(2048)), {
    client: stubClient("Three shelves of tinned fish, roughly forty tins."),
  });
  assert.equal(result.ok, true);
  assert.equal(result.filename, "shelf.jpg");
  assert.match(result.text, /tinned fish/);
  // Derive and discard: the caller cannot get the bytes back out of this.
  assert.equal("base64" in result, false);
});

test("the composer offers exactly what the server accepts", () => {
  const source = fs.readFileSync(
    new URL("../app/components/daily-home.tsx", import.meta.url),
    "utf8",
  );
  // One allow-list, shared. A hardcoded accept string here is how a composer starts offering
  // files the server bounces.
  assert.match(source, /accept=\{ATTACHMENT_ACCEPT\}/);
  assert.match(source, /attachmentRejectionReason/);
  assert.match(source, /type="file"/);
  assert.match(source, /name="attachment"/);
  // Multipart only when there is a file — a plain message should not pay for it.
  assert.match(source, /encType=\{attachedFile \? "multipart\/form-data" : undefined\}/);
  // A file on its own must be sendable — a fresh upload OR one picked from the library
  // (the picker landed the same day; see merchant-library.test.mjs).
  assert.match(source, /required=\{!attachedFile && !pickedFile\}/);
  assert.ok(ATTACHMENT_ACCEPT.includes("application/pdf"));
});

test("the route reads the upload and reports a rejection rather than swallowing it", () => {
  const route = fs.readFileSync(
    new URL("../app/routes/app._index.tsx", import.meta.url),
    "utf8",
  );
  assert.match(route, /readUploadedAttachment\(formData/);
  assert.match(route, /composeAttachmentMessage\(/);
  // No dead ends: a file Jefe cannot read produces a sentence, not silence.
  assert.match(route, /kind: "attachment"/);
  // And the guard runs before the body is parsed.
  assert.ok(
    route.indexOf("oversizedUploadReason(request)") < route.indexOf("await request.formData()"),
    "the size guard must run before the body is buffered",
  );
});

// --- text formats (CSV/TSV/plain), added 2026-08-13 ---
//
// Matt asked whether it could be "a csv or xls or a video". CSV is the one that matters most:
// a cost-per-item export is the input margin work is blocked without, and it needs no model to
// read — decoding is exact where describing can hallucinate.

import {
  attachmentKind,
  attachmentRejectionReason as rejectionReason,
} from "../app/lib/attachments/attachment-limits.js";
import { readAttachment } from "../app/lib/attachments/read-attachment.server.js";

const csv = (body) => ({
  base64: Buffer.from(body, "utf8").toString("base64"),
  mimeType: "text/csv",
  filename: "costs.csv",
});

test("a CSV is read without spending a provider request", async () => {
  let called = false;
  const result = await readAttachment({
    ...csv("sku,cost,price\nTIN-01,1.20,3.50\nTIN-02,0.90,2.75"),
    client: {
      models: {
        generateContent: async () => {
          called = true;
          return { text: "never" };
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(called, false, "decoding beats describing — no model call for text");
  // The numbers survive EXACTLY. This is the whole reason text does not go to a vision model.
  assert.match(result.text, /TIN-01,1\.20,3\.50/);
});

test("a Windows CSV reported as an Excel MIME type is still read", () => {
  // Windows Chrome reports a plain .csv as application/vnd.ms-excel. Deciding on the MIME type
  // alone would tell the merchant to save it as the thing it already is.
  assert.equal(attachmentKind("application/vnd.ms-excel", "costs.csv"), "text");
  assert.equal(rejectionReason({ mimeType: "application/vnd.ms-excel", filename: "costs.csv", byteLength: 100 }), null);
});

test("a modern .xlsx is accepted — it is parsed, not refused", () => {
  // This test used to assert the opposite. .xlsx became readable on 2026-08-13; see
  // document-extraction.test.mjs for the round-trip through a real workbook.
  assert.equal(
    rejectionReason({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "costs.xlsx",
      byteLength: 5000,
    }),
    null,
  );
});

test("a LEGACY .xls is refused with a way forward, not a dead end", () => {
  // Deliberately unsupported: the only npm library that reads binary BIFF carries an unfixed
  // advisory. Ten seconds of the merchant's time beats a permanent dependency.
  const reason = rejectionReason({
    mimeType: "application/vnd.ms-excel",
    filename: "costs.xls",
    byteLength: 5000,
  });
  assert.match(reason, /re-save it as \.xlsx or CSV/i);
});

test("video is refused with something the merchant can actually do", () => {
  const reason = rejectionReason({ mimeType: "video/mp4", filename: "clip.mp4", byteLength: 5000 });
  assert.match(reason, /photo of the same thing|tell me what's in it/i);
});

test("truncation of a long file is stated, never silent", async () => {
  const rows = Array.from({ length: 4000 }, (_, i) => `SKU-${i},1.${i % 100},9.99`).join("\n");
  const result = await readAttachment(csv(`sku,cost,price\n${rows}`));
  assert.equal(result.ok, true);
  // Jefe must not answer "your worst margin is X" having silently seen a fraction of the file.
  assert.match(result.text, /showing the first \d+ of \d+ lines/);
  // Whole lines only — half a row reads as a corrupt value rather than a cut-off file.
  const body = result.text.split("\n").filter((l) => !l.startsWith("…"));
  assert.ok(body.every((l) => l.split(",").length === 3), "no half-written row");
});

test("a binary file renamed to .csv is refused rather than described as data", async () => {
  const result = await readAttachment({
    base64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]).toString("base64"),
    mimeType: "text/csv",
    filename: "costs.csv",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /save it as \.xlsx or CSV/i);
});
