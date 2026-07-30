// @ts-check

import crypto from "node:crypto";

/**
 * Win-back feedback: signed one-tap tokens for the "What made you uninstall?"
 * links in the farewell email.
 *
 * A token binds a shop domain + the recipient's email HASH (never plaintext) +
 * one reason code, and is HMAC-signed, so a feedback link cannot be forged or
 * edited to attribute a reason to a different store. The endpoint records a
 * PII-free `shop_uninstall_feedback` lifecycle event — the same event-log
 * pattern churn capture uses — not a column.
 *
 * Reason codes are LOCKED (shared with the email template + ops readback): edit
 * here and the template together, never one alone.
 */

const TOKEN_VERSION = "f1";

/**
 * Locked reason codes → human labels. The email renders one tap-link per key;
 * an open reply (no code) is the fifth path and needs no URL.
 * @type {Record<string, string>}
 */
export const FEEDBACK_REASONS = {
  too_early: "Too early for us",
  no_value: "Didn't see the value",
  too_complex: "Too complex",
  broke: "Something broke",
};

/**
 * @param {string} reason
 * @returns {boolean}
 */
export function isFeedbackReason(reason) {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_REASONS, reason);
}

/**
 * HMAC secret for signing feedback links. Shares the unsubscribe/session secret
 * so no new env var is needed; duplicated (not imported) to keep this module
 * independent of the unsubscribe module's internals.
 * @returns {string}
 */
function feedbackSecret() {
  const secret = (
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.SESSION_SECRET ||
    ""
  ).trim();
  if (!secret) {
    throw new Error(
      "EMAIL_UNSUBSCRIBE_SECRET (or SESSION_SECRET) must be set to sign feedback links",
    );
  }
  return secret;
}

/** @param {string | Buffer} value */
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

/**
 * Sign a one-tap feedback token binding shopDomain + emailHash + reason.
 * @param {{ shopDomain: string; emailHash: string; reason: string }} input
 * @returns {string}
 */
export function signFeedbackToken(input) {
  if (!isFeedbackReason(input.reason)) {
    throw new Error(`Unknown feedback reason: ${input.reason}`);
  }
  const body = b64url(
    JSON.stringify({
      v: TOKEN_VERSION,
      s: input.shopDomain,
      h: input.emailHash,
      r: input.reason,
    }),
  );
  const sig = b64url(
    crypto.createHmac("sha256", feedbackSecret()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

/**
 * Verify + parse a feedback token. Returns null on any tamper / malformed input
 * / bad signature / unknown reason — callers must treat null as "invalid link".
 * @param {string | null | undefined} token
 * @returns {{ shopDomain: string; emailHash: string; reason: string } | null}
 */
export function verifyFeedbackToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  let expected;
  let provided;
  try {
    expected = crypto
      .createHmac("sha256", feedbackSecret())
      .update(body)
      .digest();
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== TOKEN_VERSION ||
    typeof payload.s !== "string" ||
    typeof payload.h !== "string" ||
    typeof payload.r !== "string" ||
    !isFeedbackReason(payload.r)
  ) {
    return null;
  }
  return { shopDomain: payload.s, emailHash: payload.h, reason: payload.r };
}
