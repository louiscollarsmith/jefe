// @ts-check

import crypto from "node:crypto";

/**
 * Verify an inbound Slack request signature (the `v0` scheme).
 *
 * Slack signs every request with `X-Slack-Signature` +
 * `X-Slack-Request-Timestamp`, computed over the RAW request body. We recompute
 * the HMAC and compare in constant time, and reject stale timestamps so a
 * captured request can't be replayed. Never throws — returns false on anything
 * malformed so the caller can 401.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * @param {{
 *   signingSecret: string | undefined;
 *   signature: string | null;
 *   timestamp: string | null;
 *   rawBody: string;
 *   nowSeconds?: number;
 * }} input
 * @returns {boolean}
 */
export function verifySlackSignature(input) {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signingSecret || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex")}`;

  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  return (
    provided.length === computed.length &&
    crypto.timingSafeEqual(provided, computed)
  );
}
