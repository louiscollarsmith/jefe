// @ts-check

import crypto from "node:crypto";

import {
  hashEmail,
  normalizeEmail,
} from "../ingestion/shopify/canonical.server.js";

/**
 * One-click unsubscribe: signed tokens + the per-recipient preference store.
 *
 * The token binds a shop domain to a recipient's email HASH (never the plaintext
 * email) and is HMAC-signed, so an unsubscribe link cannot be forged or edited
 * to silence a different recipient. `email_preferences` rows are keyed the same
 * way, so no plaintext email is ever stored for suppression.
 */

const TOKEN_VERSION = "u1";

/** @returns {string} */
function unsubscribeSecret() {
  const secret = (
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.SESSION_SECRET ||
    ""
  ).trim();
  if (!secret) {
    throw new Error(
      "EMAIL_UNSUBSCRIBE_SECRET (or SESSION_SECRET) must be set to sign unsubscribe links",
    );
  }
  return secret;
}

/** @param {crypto.BinaryLike} value */
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

/**
 * sha256 hash of a recipient email (normalised first). Null when no email.
 * @param {string | null | undefined} email
 * @returns {string | null}
 */
export function hashRecipient(email) {
  const normalized = normalizeEmail(email ?? "");
  return normalized ? hashEmail(normalized) : null;
}

/**
 * Sign a one-click unsubscribe token binding shopDomain + emailHash.
 * @param {{ shopDomain: string; emailHash: string }} input
 * @returns {string}
 */
export function signUnsubscribeToken(input) {
  const body = b64url(
    JSON.stringify({ v: TOKEN_VERSION, s: input.shopDomain, h: input.emailHash }),
  );
  const sig = b64url(
    crypto.createHmac("sha256", unsubscribeSecret()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

/**
 * Verify + parse a token. Returns null on any tamper / malformed input / bad
 * signature — callers must treat null as "invalid link".
 * @param {string | null | undefined} token
 * @returns {{ shopDomain: string; emailHash: string } | null}
 */
export function verifyUnsubscribeToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  let expected;
  let provided;
  try {
    expected = crypto
      .createHmac("sha256", unsubscribeSecret())
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
    typeof payload.h !== "string"
  ) {
    return null;
  }
  return { shopDomain: payload.s, emailHash: payload.h };
}

/**
 * Whether a recipient has unsubscribed from Jefe emails for this shop.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; emailHash: string | null }} input
 * @returns {Promise<boolean>}
 */
export async function isEmailUnsubscribed(prisma, input) {
  if (!input.emailHash) return false;
  const pref = await prisma.emailPreference.findUnique({
    where: {
      shopId_emailHash: { shopId: input.shopId, emailHash: input.emailHash },
    },
    select: { unsubscribedAt: true },
  });
  return Boolean(pref?.unsubscribedAt);
}

/**
 * Record an unsubscribe (idempotent upsert).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ shopId: string; emailHash: string; source?: string | null }} input
 */
export async function recordUnsubscribe(prisma, input) {
  const now = new Date();
  await prisma.emailPreference.upsert({
    where: {
      shopId_emailHash: { shopId: input.shopId, emailHash: input.emailHash },
    },
    update: { unsubscribedAt: now, source: input.source ?? null },
    create: {
      shopId: input.shopId,
      emailHash: input.emailHash,
      unsubscribedAt: now,
      source: input.source ?? null,
    },
  });
}
