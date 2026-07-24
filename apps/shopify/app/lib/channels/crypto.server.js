// @ts-check

import crypto from "node:crypto";

import { ChannelServiceError } from "./errors.server.js";

const CREDENTIAL_SECRET_ENV_KEYS = Object.freeze([
  "CHANNEL_CREDENTIAL_ENCRYPTION_SECRET",
  "SESSION_SECRET",
  "SHOPIFY_API_SECRET",
]);
const VERIFICATION_SECRET_ENV_KEYS = Object.freeze([
  "CHANNEL_VERIFICATION_SECRET",
  "SESSION_SECRET",
  "SHOPIFY_API_SECRET",
]);

/** @param {unknown} payload @param {Record<string, string | undefined>} [env] */
export function encryptChannelCredentialPayload(payload, env = process.env) {
  const key = encryptionKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

/** @param {string} encryptedPayload @param {Record<string, string | undefined>} [env] */
export function decryptChannelCredentialPayload(encryptedPayload, env = process.env) {
  const [version, encodedIv, encodedTag, encodedEncrypted] = encryptedPayload.split(":");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedEncrypted) {
    throw new ChannelServiceError("invalid_encrypted_secret");
  }

  const keys = encryptionKeys(env);
  if (keys.length === 0) throw new ChannelServiceError("provider_config_missing");

  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(encodedIv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedEncrypted, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext);
    } catch {
      // Try the next configured key for secret rotation.
    }
  }

  throw new ChannelServiceError("invalid_encrypted_secret");
}

/** @param {Record<string, string | undefined>} env */
function encryptionKey(env) {
  const keys = encryptionKeys(env);
  if (keys.length === 0) throw new ChannelServiceError("provider_config_missing");
  return keys[0];
}

/** @param {Record<string, string | undefined>} env */
function encryptionKeys(env) {
  return secretCandidates(env, CREDENTIAL_SECRET_ENV_KEYS).map((secret) =>
    crypto.createHash("sha256").update(secret).digest(),
  );
}

/** @param {string} value */
export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {number} [bytes] */
export function randomStateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function randomVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

/**
 * @param {string} code
 * @param {string} destination
 * @param {Record<string, string | undefined>} [env]
 */
export function hashVerificationCode(code, destination, env = process.env) {
  const secret = verificationSecret(env);
  const salt = crypto.randomBytes(16).toString("base64url");
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${salt}:${destination}:${code.trim()}`)
    .digest("base64url");
  return `v1:${salt}:${digest}`;
}

/**
 * @param {string} code
 * @param {string} destination
 * @param {string} storedHash
 * @param {Record<string, string | undefined>} [env]
 */
export function verifyVerificationCode(code, destination, storedHash, env = process.env) {
  const [version, salt, expected] = storedHash.split(":");
  if (version !== "v1" || !salt || !expected) return false;
  const secret = verificationSecret(env);
  const actual = crypto
    .createHmac("sha256", secret)
    .update(`${salt}:${destination}:${code.trim()}`)
    .digest("base64url");
  return timingSafeEqual(actual, expected);
}

/** @param {string} destination @param {Record<string, string | undefined>} [env] */
export function hashDestination(destination, env = process.env) {
  const secret = verificationSecret(env);
  return crypto.createHmac("sha256", secret).update(destination).digest("hex");
}

/** @param {Record<string, string | undefined>} env */
function verificationSecret(env) {
  const [secret] = secretCandidates(env, VERIFICATION_SECRET_ENV_KEYS);
  if (!secret) throw new ChannelServiceError("provider_config_missing");
  return secret;
}

/** @param {Record<string, string | undefined>} env @param {readonly string[]} keys */
function secretCandidates(env, keys) {
  /** @type {string[]} */
  const candidates = [];
  for (const key of keys) {
    const secret = env[key]?.trim();
    if (secret && secret.length >= 16 && !candidates.includes(secret)) {
      candidates.push(secret);
    }
  }
  return candidates;
}

/** @param {string} actual @param {string} expected */
function timingSafeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
