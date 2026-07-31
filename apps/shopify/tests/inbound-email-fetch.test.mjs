import assert from "node:assert/strict";
import test from "node:test";

import { fetchReceivedEmail } from "../app/lib/email/inbound/fetch.server.js";

/** A fake Resend client exposing just emails.receiving.get(id). */
function fakeClient(getImpl) {
  return { emails: { receiving: { get: getImpl } } };
}

test("returns the record on a successful fetch", async () => {
  const client = fakeClient(async (id) => ({
    data: { id, from: "a@b.com", to: ["jefe@x.com"], subject: "hi", text: "hello" },
    error: null,
  }));
  const res = await fetchReceivedEmail("in_1", { client, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.record.text, "hello");
});

test("a Resend error → not ok", async () => {
  const client = fakeClient(async () => ({ data: null, error: { message: "not found" } }));
  const res = await fetchReceivedEmail("in_1", { client, env: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "fetch_failed");
});

test("a thrown SDK/network error is swallowed (never propagates a raw error)", async () => {
  const client = fakeClient(async () => {
    throw new Error("boom shpat_secret");
  });
  const res = await fetchReceivedEmail("in_1", { client, env: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "fetch_error");
  assert.equal(res.error, undefined, "no raw error object leaks out");
});

test("a missing message id is refused before any client call", async () => {
  let called = false;
  const client = fakeClient(async () => {
    called = true;
    return { data: {}, error: null };
  });
  const res = await fetchReceivedEmail("", { client, env: {} });
  assert.deepEqual(res, { ok: false, reason: "no_message_id" });
  assert.equal(called, false);
});

test("no API key and no injected client → missing_api_key (never constructs a client)", async () => {
  const res = await fetchReceivedEmail("in_1", { env: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_api_key");
});
