// @ts-check

import crypto from "node:crypto";

/**
 * Verify an inbound Resend webhook signature (the Svix scheme Resend uses).
 *
 * Resend signs webhooks via Svix: three headers — `svix-id`, `svix-timestamp`,
 * `svix-signature` — over the RAW request body. The signed payload is
 * `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256'd with the endpoint
 * secret, base64-encoded. The secret is delivered as `whsec_<base64>`; the actual
 * key is the base64-decode of the part after the prefix. The `svix-signature`
 * header is a space-delimited list of `v1,<sig>` entries (there can be several —
 * during key rotation) and we accept a constant-time match against ANY of them.
 *
 * Like the Slack verifier: never throws (returns false on anything malformed so
 * the caller can 401), rejects stale timestamps to block replay, and — critically
 * — refuses when no secret is configured, so we never act on unauthenticated
 * inbound mail.
 *
 * @see https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 * @see https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Decode a Svix endpoint secret (`whsec_<base64>` or a bare base64 string) into
 * the raw HMAC key bytes. Returns null when unusable.
 * @param {string} secret
 * @returns {Buffer | null}
 */
function decodeSecret(secret) {
  const trimmed = secret.trim();
  if (!trimmed) return null;
  const base64 = trimmed.startsWith("whsec_") ? trimmed.slice(6) : trimmed;
  try {
    const key = Buffer.from(base64, "base64");
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Compare a computed base64 signature against a space-delimited `svix-signature`
 * header in constant time. Each entry is `v1,<base64sig>`; we only trust the `v1`
 * scheme. Returns true on the first constant-time match.
 * @param {string} header
 * @param {string} expectedBase64
 * @returns {boolean}
 */
function matchesAnySignature(header, expectedBase64) {
  const expected = Buffer.from(expectedBase64, "utf8");
  let matched = false;
  for (const part of header.split(" ")) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    const version = part.slice(0, comma);
    const value = part.slice(comma + 1);
    if (version !== "v1" || !value) continue;
    const provided = Buffer.from(value, "utf8");
    // Constant-time on equal length; keep scanning either way so timing does not
    // reveal which entry (if any) matched.
    if (
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected)
    ) {
      matched = true;
    }
  }
  return matched;
}

/**
 * @param {{
 *   secret: string | undefined;
 *   svixId: string | null;
 *   svixTimestamp: string | null;
 *   svixSignature: string | null;
 *   rawBody: string;
 *   nowSeconds?: number;
 * }} input
 * @returns {boolean}
 */
export function verifyResendWebhookSignature(input) {
  const { secret, svixId, svixTimestamp, svixSignature, rawBody } = input;
  if (!secret || !svixId || !svixTimestamp || !svixSignature) return false;

  const ts = Number(svixTimestamp);
  if (!Number.isInteger(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const key = decodeSecret(secret);
  if (!key) return false;

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", key)
    .update(signedPayload)
    .digest("base64");

  return matchesAnySignature(svixSignature, expected);
}

/**
 * Whether an inbound-webhook signing secret is configured. The route uses this to
 * distinguish "not configured yet" (park, don't 401-loop) from a real bad
 * signature.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isInboundSignatureConfigured(env = process.env) {
  return Boolean((env.RESEND_INBOUND_WEBHOOK_SECRET ?? "").trim());
}
