import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { verifySlackSignature } from "../app/lib/channels/slack-signature.server.js";
import { handleSlackEvent } from "../app/lib/channels/slack-events.server.js";

const SECRET = "test-slack-signing-secret";

function sign(rawBody, ts, secret = SECRET) {
  const base = `v0:${ts}:${rawBody}`;
  return `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
}

test("verifySlackSignature accepts a correct signature and rejects tampering/replay", () => {
  const ts = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ type: "event_callback" });
  const sig = sign(rawBody, ts);

  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, signature: sig, timestamp: String(ts), rawBody }),
    true,
  );
  // Wrong secret / tampered body / missing pieces all fail closed.
  assert.equal(
    verifySlackSignature({ signingSecret: "nope", signature: sig, timestamp: String(ts), rawBody }),
    false,
  );
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, signature: sig, timestamp: String(ts), rawBody: rawBody + "x" }),
    false,
  );
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, signature: null, timestamp: String(ts), rawBody }),
    false,
  );
  assert.equal(
    verifySlackSignature({ signingSecret: undefined, signature: sig, timestamp: String(ts), rawBody }),
    false,
  );
  // Stale timestamp (> 5 min) is rejected as a replay.
  const oldTs = ts - 60 * 10;
  assert.equal(
    verifySlackSignature({
      signingSecret: SECRET,
      signature: sign(rawBody, oldTs),
      timestamp: String(oldTs),
      rawBody,
      nowSeconds: ts,
    }),
    false,
  );
});

test("handleSlackEvent answers the url_verification challenge only when signed", () => {
  const ts = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
  const signed = {
    signingSecret: SECRET,
    signature: sign(rawBody, ts),
    timestamp: String(ts),
    rawBody,
  };

  const ok = handleSlackEvent(signed);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "abc123");
  assert.equal(ok.contentType, "text/plain");

  // An unsigned/invalid request never echoes the challenge — it 401s.
  const bad = handleSlackEvent({ ...signed, signature: "v0=deadbeef" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body, undefined);
});

test("handleSlackEvent returns the parsed DM for a message.im (for the route to dispatch)", () => {
  const ts = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      text: "hi jefe",
    },
  });
  const result = handleSlackEvent({
    signingSecret: SECRET,
    signature: sign(rawBody, ts),
    timestamp: String(ts),
    rawBody,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.inboundDm, {
    teamId: "T1",
    channelId: "D1",
    userId: "U1",
    text: "hi jefe",
    eventId: "Ev1",
  });
});

test("handleSlackEvent ignores bot messages, non-DM channels, edits, and empty text", () => {
  const ts = Math.floor(Date.now() / 1000);
  for (const event of [
    { type: "message", channel_type: "im", bot_id: "B1", channel: "D1", text: "from jefe" },
    { type: "message", channel_type: "channel", channel: "C1", text: "in a channel" },
    { type: "message", channel_type: "im", subtype: "message_changed", channel: "D1" },
    { type: "message", channel_type: "im", channel: "D1", text: "   " },
  ]) {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T1", event });
    const result = handleSlackEvent({
      signingSecret: SECRET,
      signature: sign(rawBody, ts),
      timestamp: String(ts),
      rawBody,
    });
    assert.equal(result.status, 200);
    assert.equal(result.inboundDm, undefined, "no inboundDm for ignored events");
  }
});
