// @ts-check

/**
 * Redaction for structured log context.
 *
 * Jefe treats merchant and customer data as sensitive by default (see AGENTS.md
 * and the GDPR compliance work). Logs are useful only if we can attach context,
 * but that context must never leak secrets or customer PII. This module scrubs a
 * value before it is serialised to a log line:
 *
 * - keys that look like credentials/PII are replaced wholesale with `[redacted]`
 * - email-shaped substrings inside any string value become `[redacted-email]`
 * - recursion is bounded (depth + cycle guard) and long strings are truncated
 *
 * It is deliberately conservative: it would rather over-redact an operational
 * field than let a token or customer email reach stdout.
 */

const REDACTED = "[redacted]";
const REDACTED_SECRET = "[redacted-secret]";

/** Max recursion depth before we stop descending and mark the value. */
const DEFAULT_MAX_DEPTH = 8;

/** Strings longer than this are truncated to keep log lines bounded. */
const DEFAULT_MAX_STRING = 2000;

/**
 * Case-insensitive substring patterns. If a key contains any of these, its
 * value is redacted regardless of type. Keep this list broad — a false positive
 * only hides a field from logs; a false negative can leak a secret.
 */
// ⛔ CONTACT-PII KEYS REMOVED 2026-08-13 (founder's call): phone, telephone, mobile and
// msisdn keys are no longer masked, matching the removal of email/phone value scrubbing.
//
// What REMAINS masked, and why it was not part of "remove the PII scrubber":
//   - credentials (password, token, api key, cookie, private key, hmac…) — a leaked token is
//     account takeover, not a privacy question;
//   - ssn, card number, cvv, security code — financial-fraud class rather than ordinary
//     contact data, and Jefe should never see them in the first place, so masking them costs
//     nothing and removing them would be a different decision from the one that was made.
const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|(^|[-_])auth([-_]|$)|cookie|session[-_]?secret|credential|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|signing|hmac|encryption|ssn|card[-_]?number|cvv|security[-_]?code)/i;

/**
 * Matches email-shaped substrings inside free-text values. Not RFC-perfect on
 * purpose: the goal is to catch the common shapes customer emails take, not to
 * validate addresses.
 */
/**
 * High-confidence secret shapes that can end up inside free-text values —
 * error messages ("Shopify rejected token shpat_…"), URLs, or stringified
 * responses. Only well-known prefixed, high-entropy token formats are matched so
 * a legitimate operational string is never mistaken for a secret. A key-based
 * match (`isSensitiveKey`) already covers structured fields; this catches the
 * substring case where a secret is embedded in prose the key doesn't flag.
 */
const SECRET_VALUE_PATTERN =
  /\b(?:shp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}|(?:sk|rk|pk)_(?:live|test)_[0-9a-zA-Z]{16,}|whsec_[0-9a-zA-Z]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{36,})\b/g;

/** Bearer/authorization tokens in free text: keep the scheme, drop the token. */
const BEARER_VALUE_PATTERN = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * @param {string} value
 * @param {number} maxString
 * @returns {string}
 */
function scrubString(value, maxString) {
  // ⛔ EMAIL MASKING REMOVED — founder's call (Matt, 2026-08-13). Addresses now appear
  // verbatim in logs, Sentry and the activity event log behind admin.mynamejefe.com.
  //
  // SECRETS AND BEARER TOKENS ARE STILL MASKED, deliberately: an API key or `shpat_` token in
  // a log is account takeover, not a privacy question, and removing the PII scrubber was not
  // a request to publish our credentials. Same for the sensitive-KEY masking below.
  const scrubbed = value
    .replace(SECRET_VALUE_PATTERN, REDACTED_SECRET)
    .replace(BEARER_VALUE_PATTERN, (_m, scheme) => `${scheme} ${REDACTED_SECRET}`);
  if (scrubbed.length > maxString) {
    return `${scrubbed.slice(0, maxString)}…[truncated ${
      scrubbed.length - maxString
    } chars]`;
  }
  return scrubbed;
}

/**
 * Return a redacted deep copy of `input` safe to serialise into a log line.
 *
 * @template T
 * @param {T} input
 * @param {{ maxDepth?: number; maxString?: number }} [options]
 * @returns {unknown}
 */
export function redact(input, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxString = options.maxString ?? DEFAULT_MAX_STRING;
  const seen = new WeakSet();

  /**
   * @param {unknown} value
   * @param {number} depth
   * @returns {unknown}
   */
  function walk(value, depth) {
    if (value === null || value === undefined) return value;

    const type = typeof value;
    if (type === "string") return scrubString(/** @type {string} */ (value), maxString);
    if (type === "number" || type === "boolean") return value;
    if (type === "bigint") return `${value}n`;
    if (type === "function" || type === "symbol") return `[${type}]`;

    if (value instanceof Date) return value.toISOString();

    if (depth >= maxDepth) return "[Object: max depth]";

    if (value instanceof Error) {
      // Errors carry message/stack as NON-enumerable props, so Object.keys()
      // misses them and a raw Error would redact to `{}` — silently losing the
      // error. Extract them explicitly, scrub the free-text (emails/secrets) they
      // often contain, and keep own-enumerable extras (e.g. a typed error's
      // `status`) under the usual key-based redaction.
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const err = /** @type {Error & Record<string, unknown>} */ (value);
      /** @type {Record<string, unknown>} */
      const out = { name: err.name };
      out.message =
        typeof err.message === "string"
          ? scrubString(err.message, maxString)
          : err.message;
      if (typeof err.stack === "string") {
        out.stack = scrubString(err.stack, maxString);
      }
      for (const key of Object.keys(err)) {
        if (key === "name" || key === "message" || key === "stack") continue;
        out[key] = isSensitiveKey(key) ? REDACTED : walk(err[key], depth + 1);
      }
      seen.delete(value);
      return out;
    }

    if (Array.isArray(value)) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const mapped = value.map((item) => walk(item, depth + 1));
      seen.delete(value);
      return mapped;
    }

    if (type === "object") {
      const obj = /** @type {Record<string, unknown>} */ (value);
      if (seen.has(obj)) return "[Circular]";
      seen.add(obj);
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const key of Object.keys(obj)) {
        out[key] = isSensitiveKey(key) ? REDACTED : walk(obj[key], depth + 1);
      }
      seen.delete(obj);
      return out;
    }

    return String(value);
  }

  return walk(input, 0);
}
