import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  isInboundSignatureConfigured,
  verifyResendWebhookSignature,
} from "../app/lib/email/inbound/signature.server.js";

const keyBytes = Buffer.from("super-secret-signing-key-0123456789abc");
const SECRET = "whsec_" + keyBytes.toString("base64");
const SVIX_ID = "msg_2abc";
const NOW = 1_722_400_000; // fixed clock
const BODY = JSON.stringify({ type: "email.received", data: { from: "a@b.com" } });

function signWith(key, id, ts, body) {
  return crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

function validInput(overrides = {}) {
  const ts = String(NOW);
  const sig = signWith(keyBytes, SVIX_ID, ts, BODY);
  return {
    secret: SECRET,
    svixId: SVIX_ID,
    svixTimestamp: ts,
    svixSignature: `v1,${sig}`,
    rawBody: BODY,
    nowSeconds: NOW,
    ...overrides,
  };
}

test("a correctly-signed Svix payload verifies", () => {
  assert.equal(verifyResendWebhookSignature(validInput()), true);
});

test("the whsec_ prefix is optional (bare base64 secret also works)", () => {
  assert.equal(
    verifyResendWebhookSignature(validInput({ secret: keyBytes.toString("base64") })),
    true,
  );
});

test("a signature from a different secret is rejected", () => {
  const wrongKey = Buffer.from("a-different-key-entirely-9876543210");
  const ts = String(NOW);
  const sig = signWith(wrongKey, SVIX_ID, ts, BODY);
  assert.equal(
    verifyResendWebhookSignature(validInput({ svixSignature: `v1,${sig}` })),
    false,
  );
});

test("a tampered body is rejected (signature no longer matches)", () => {
  assert.equal(
    verifyResendWebhookSignature(validInput({ rawBody: BODY + " " })),
    false,
  );
});

test("a stale timestamp (> 5 min skew) is rejected — replay guard", () => {
  assert.equal(
    verifyResendWebhookSignature(validInput({ nowSeconds: NOW + 6 * 60 })),
    false,
  );
});

test("missing secret / headers are refused, never trusted", () => {
  assert.equal(verifyResendWebhookSignature(validInput({ secret: undefined })), false);
  assert.equal(verifyResendWebhookSignature(validInput({ svixId: null })), false);
  assert.equal(verifyResendWebhookSignature(validInput({ svixTimestamp: null })), false);
  assert.equal(verifyResendWebhookSignature(validInput({ svixSignature: null })), false);
});

test("a non-numeric timestamp is rejected", () => {
  assert.equal(verifyResendWebhookSignature(validInput({ svixTimestamp: "not-a-number" })), false);
});

test("multiple space-delimited signatures (key rotation) — any valid one passes", () => {
  const ts = String(NOW);
  const good = signWith(keyBytes, SVIX_ID, ts, BODY);
  assert.equal(
    verifyResendWebhookSignature(validInput({ svixSignature: `v1,AAAABBBBoldsig v1,${good}` })),
    true,
  );
});

test("a non-v1 scheme entry is ignored", () => {
  const ts = String(NOW);
  const good = signWith(keyBytes, SVIX_ID, ts, BODY);
  assert.equal(
    verifyResendWebhookSignature(validInput({ svixSignature: `v2,${good}` })),
    false,
  );
});

test("isInboundSignatureConfigured reflects the env var", () => {
  assert.equal(isInboundSignatureConfigured({}), false);
  assert.equal(isInboundSignatureConfigured({ RESEND_INBOUND_WEBHOOK_SECRET: "  " }), false);
  assert.equal(isInboundSignatureConfigured({ RESEND_INBOUND_WEBHOOK_SECRET: SECRET }), true);
});
