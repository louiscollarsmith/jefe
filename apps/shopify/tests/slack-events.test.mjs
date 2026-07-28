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

test("handleSlackEvent acknowledges a message.im DM without logging its text", () => {
  const ts = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    event: { type: "message", channel_type: "im", user: "U1", text: "secret message body" },
  });
  const logged = [];
  const result = handleSlackEvent({
    signingSecret: SECRET,
    signature: sign(rawBody, ts),
    timestamp: String(ts),
    rawBody,
    retryNum: null,
    logger: { info: (message, context) => logged.push({ message, context }) },
  });

  assert.equal(result.status, 200);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].context.teamId, "T1");
  assert.equal(logged[0].context.eventId, "Ev1");
  // The merchant's message text must never reach the logs.
  assert.doesNotMatch(JSON.stringify(logged), /secret message body/);
});

test("handleSlackEvent ignores the bot's own messages and non-DM channels", () => {
  const ts = Math.floor(Date.now() / 1000);
  for (const event of [
    { type: "message", channel_type: "im", bot_id: "B1", text: "from jefe" },
    { type: "message", channel_type: "channel", text: "in a channel" },
    { type: "message", channel_type: "im", subtype: "message_changed" },
  ]) {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T1", event });
    const logged = [];
    const result = handleSlackEvent({
      signingSecret: SECRET,
      signature: sign(rawBody, ts),
      timestamp: String(ts),
      rawBody,
      logger: { info: (message, context) => logged.push({ message, context }) },
    });
    assert.equal(result.status, 200);
    assert.equal(logged.length, 0, "no inbound-DM log for ignored events");
  }
});
