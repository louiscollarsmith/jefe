import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  deleteMerchantFile,
  getMerchantFileText,
  listMerchantFiles,
  saveMerchantFile,
} from "../app/lib/attachments/merchant-file.server.js";
import { readUploadedAttachment, ATTACHMENT_FIELD } from "../app/lib/attachments/attachment-message.server.js";

// The Jefe Library — files a merchant chose to keep. Founder decision, 2026-08-13.
//
// Two properties carry the most weight here:
//
//  1. TENANT ISOLATION. A library is the first place a broken boundary shows up as one merchant
//     reading another's invoices, so ownership is in the WHERE clause, never checked afterwards.
//  2. DERIVE AND DISCARD REMAINS THE DEFAULT. Bytes come back from the upload reader only when
//     the caller explicitly asks; a path that forgets to ask stores nothing. Storing must be
//     chosen, not be what happens when you do nothing.

/** An in-memory stand-in for the merchant_files table, with the scoping the real one has. */
function mockPrisma() {
  const rows = [];
  let seq = 0;
  const strip = (row) => {
    const { content, ...rest } = row;
    return rest;
  };
  const matches = (row, where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.merchantId === undefined || row.merchantId === where.merchantId) &&
    (where.shopId === undefined || row.shopId === where.shopId);
  return {
    rows,
    merchantFile: {
      create: async ({ data }) => {
        const row = { id: `f${++seq}`, createdAt: new Date(), lastUsedAt: null, ...data };
        rows.push(row);
        return strip(row);
      },
      findMany: async ({ where }) => rows.filter((r) => matches(r, where)).map(strip),
      findFirst: async ({ where, select }) => {
        const row = rows.find((r) => matches(r, where));
        if (!row) return null;
        return select?.content ? row : strip(row);
      },
      update: async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return strip(row);
      },
      deleteMany: async ({ where }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (matches(rows[i], where)) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
    },
  };
}

const FILE = {
  merchantId: "m1",
  shopId: "s1",
  filename: "costs.csv",
  mimeType: "text/csv",
  kind: "text",
  bytes: Buffer.from("sku,cost\nTIN-01,1.20"),
  extractedText: "sku,cost\nTIN-01,1.20",
};

test("a kept file comes back without its bytes", async () => {
  const prisma = mockPrisma();
  const saved = await saveMerchantFile(prisma, FILE);
  assert.equal(saved.filename, "costs.csv");
  assert.equal(saved.byteSize, FILE.bytes.length);
  // Listings and prompts use the extract; the bytes exist only for a download.
  assert.equal("content" in saved, false);
});

test("nothing is stored when there are no bytes", async () => {
  const prisma = mockPrisma();
  assert.equal(await saveMerchantFile(prisma, { ...FILE, bytes: Buffer.alloc(0) }), null);
  assert.equal(prisma.rows.length, 0);
});

test("⛔ one merchant cannot read, or delete, another's file", async () => {
  const prisma = mockPrisma();
  const mine = await saveMerchantFile(prisma, FILE);

  // Ownership is part of the query, not a check afterwards.
  assert.equal(await getMerchantFileText(prisma, { merchantId: "m2", fileId: mine.id }), null);
  assert.equal(await deleteMerchantFile(prisma, { merchantId: "m2", fileId: mine.id }), false);
  assert.equal(prisma.rows.length, 1, "someone else's delete must not remove it");

  const theirs = await listMerchantFiles(prisma, { merchantId: "m2" });
  assert.deepEqual(theirs, [], "another merchant's library is empty, not mine");
});

test("the owner can read and delete their own file, and delete is a real delete", async () => {
  const prisma = mockPrisma();
  const saved = await saveMerchantFile(prisma, FILE);
  const read = await getMerchantFileText(prisma, { merchantId: "m1", fileId: saved.id });
  assert.match(read.extractedText, /TIN-01/);

  assert.equal(await deleteMerchantFile(prisma, { merchantId: "m1", fileId: saved.id }), true);
  // Hard delete, not a flag — a merchant who asks Jefe to forget a document means gone.
  assert.equal(prisma.rows.length, 0);
  assert.equal(await deleteMerchantFile(prisma, { merchantId: "m1", fileId: saved.id }), false);
});

test("reading a file records that it was used, so 'the invoice I sent' stays findable", async () => {
  const prisma = mockPrisma();
  const saved = await saveMerchantFile(prisma, FILE);
  assert.equal(prisma.rows[0].lastUsedAt, null);
  await getMerchantFileText(prisma, { merchantId: "m1", fileId: saved.id, touch: true });
  assert.ok(prisma.rows[0].lastUsedAt instanceof Date);
});

test("the library listing never selects the bytes", () => {
  const source = fs.readFileSync(
    new URL("../app/lib/attachments/merchant-file.server.js", import.meta.url),
    "utf8",
  );
  // A listing that pulled 50 files' worth of bytes out of Postgres to render filenames would
  // be slow in a way nobody would notice until a merchant had a real library.
  const fields = source.slice(source.indexOf("const LIBRARY_FIELDS"), source.indexOf("});", source.indexOf("const LIBRARY_FIELDS")));
  assert.doesNotMatch(fields, /content/);
  // Exactly one path may read them.
  assert.equal((source.match(/content: true/g) ?? []).length, 1);
});

test("⭐ derive-and-discard is still the DEFAULT — bytes come back only when asked for", async () => {
  const form = new FormData();
  form.set(ATTACHMENT_FIELD, new File([Buffer.from("sku,cost\nTIN-01,1.20")], "costs.csv", { type: "text/csv" }));

  const discarded = await readUploadedAttachment(form, {});
  assert.equal(discarded.ok, true);
  assert.equal("bytes" in discarded, false, "a caller that does not ask cannot store anything");

  const kept = await readUploadedAttachment(form, { keepBytes: true });
  assert.equal(kept.ok, true);
  assert.ok(Buffer.isBuffer(kept.bytes));
  assert.equal(kept.kind, "text");
});

test("the surface offers the choice per upload, and defaults to NOT keeping", () => {
  const composer = fs.readFileSync(
    new URL("../app/components/daily-home.tsx", import.meta.url),
    "utf8",
  );
  // Storing by default would turn every casual screenshot into a retained record.
  assert.match(composer, /useState\(false\);/);
  assert.match(composer, /name="keepAttachment"/);
  assert.match(composer, /Keep this file/);
});

test("⛔ the copy never promises privacy, because both answers send the file to a model", () => {
  const view = fs.readFileSync(
    new URL("../app/components/merchant-library-view.tsx", import.meta.url),
    "utf8",
  );
  const composer = fs.readFileSync(
    new URL("../app/components/daily-home.tsx", import.meta.url),
    "utf8",
  );
  // A merchant who reads "don't save" as "stays private" has been misled, and the damage is
  // done at transmission rather than when we notice.
  for (const [name, source] of [["library view", view], ["composer", composer]]) {
    const rendered = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(rendered, /stays private|never leaves|only you can see|nobody else/i, name);
  }
});
