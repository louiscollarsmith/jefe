import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentRejectionReason,
  isReadableAttachment,
  readAttachment,
} from "../app/lib/attachments/read-attachment.server.js";

// A merchant sending Jefe a photo of a shelf or a supplier invoice. DERIVE AND DISCARD, per
// Matt's voice-note ruling (2026-07-31): take the bytes, keep the words, never persist the
// file — the app has no blob store and acquiring one is a founder decision.
//
// The properties worth pinning are the safety ones. What comes back is merchant-supplied
// content that has been through a model and is about to be written into a conversation
// thread, so it must be redacted BEFORE a caller can store it, and a file we cannot read must
// produce a sentence rather than silence.

/** A stub model. Returns whatever text the test wants, and records what it was sent. */
function stubClient(text, capture = {}) {
  return {
    models: {
      generateContent: async (req) => {
        capture.request = req;
        return { text, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
      },
    },
  };
}

const IMAGE = { base64: "aGVsbG8=", mimeType: "image/jpeg", byteLength: 2048 };

test("only formats a model can actually read are accepted", () => {
  assert.equal(isReadableAttachment("image/jpeg"), true);
  assert.equal(isReadableAttachment("application/pdf"), true);
  assert.equal(isReadableAttachment("IMAGE/PNG"), true, "case should not decide this");
  // Refused rather than guessed at — a .mov sent to a vision model burns a request and fails.
  assert.equal(isReadableAttachment("video/quicktime"), false);
  assert.equal(isReadableAttachment("application/zip"), false);
  assert.equal(isReadableAttachment(undefined), false);
});

test("a bad upload is refused before any provider round-trip", () => {
  // Cheap failures should stay cheap.
  assert.match(
    attachmentRejectionReason({ mimeType: "video/mp4", byteLength: 10 }),
    /photos and PDFs/,
  );
  assert.match(
    attachmentRejectionReason({ mimeType: "image/png", byteLength: MAX_ATTACHMENT_BYTES + 1 }),
    /too big/,
  );
  assert.match(attachmentRejectionReason({ mimeType: "image/png", byteLength: 0 }), /empty/);
  assert.equal(attachmentRejectionReason({ mimeType: "image/png", byteLength: 1000 }), null);
});

test("every refusal is a sentence a merchant can act on, never a dead end", () => {
  for (const bad of [
    { mimeType: "video/mp4", byteLength: 10 },
    { mimeType: "image/png", byteLength: MAX_ATTACHMENT_BYTES + 1 },
    { mimeType: "image/png", byteLength: 0 },
  ]) {
    const reason = attachmentRejectionReason(bad);
    assert.ok(reason && reason.length > 12, "a refusal must explain itself");
    assert.doesNotMatch(reason, /error|invalid|unsupported|failed/i, `reads as a stack trace: ${reason}`);
  }
});

test("the file reaches the model as inline data, and the bytes are not returned", async () => {
  const capture = {};
  const result = await readAttachment({
    ...IMAGE,
    filename: "shelf.jpg",
    client: stubClient("Three shelves of tinned fish, roughly forty tins.", capture),
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /tinned fish/);
  assert.equal(result.filename, "shelf.jpg");
  // The caller gets words, never the file — this module cannot be used to persist bytes.
  assert.equal("base64" in result, false);
  assert.equal(capture.request.contents[0].parts[0].inlineData.mimeType, "image/jpeg");
});

test("customer details are redacted before a caller can store them", async () => {
  // An invoice carries names, emails and phone numbers. The prompt ASKS the model to leave
  // them out; asking is a preference, and this text is about to be written into a thread.
  const result = await readAttachment({
    ...IMAGE,
    client: stubClient(
      "Invoice for jane.fairfax@example.com, phone 07700 900123, total £412.",
    ),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.text, /jane\.fairfax@example\.com/);
  assert.doesNotMatch(result.text, /07700 900123/);
  // The commercially useful part survives.
  assert.match(result.text, /412/);
});

test("a model that returns nothing produces a sentence, not silence", async () => {
  const result = await readAttachment({ ...IMAGE, client: stubClient("   ") });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("a provider failure is caught and answered, never thrown at the merchant", async () => {
  const result = await readAttachment({
    ...IMAGE,
    client: {
      models: {
        generateContent: async () => {
          throw new Error("upstream exploded");
        },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /tell me what's in it/i, "no dead ends — offer a way forward");
  assert.doesNotMatch(result.reason, /exploded|Error/);
});

test("a hostile filename cannot smuggle anything into the thread", async () => {
  const result = await readAttachment({
    ...IMAGE,
    filename: "in\nvoice\t<script>alert(1)</script>".padEnd(400, "x"),
    client: stubClient("A supplier invoice."),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.filename, /[\r\n\t]/, "newlines would break the rendered line");
  assert.ok(result.filename.length <= 120, "a 400-character filename is not a filename");
});

test("an oversized file never reaches the provider", async () => {
  let called = false;
  const result = await readAttachment({
    base64: "x".repeat(20 * 1024 * 1024),
    mimeType: "image/png",
    client: {
      models: {
        generateContent: async () => {
          called = true;
          return { text: "should never happen" };
        },
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, false, "size is checked before we spend a request");
});
