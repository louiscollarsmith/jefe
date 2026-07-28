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
const REDACTED_EMAIL = "[redacted-email]";

/** Max recursion depth before we stop descending and mark the value. */
const DEFAULT_MAX_DEPTH = 8;

/** Strings longer than this are truncated to keep log lines bounded. */
const DEFAULT_MAX_STRING = 2000;

/**
 * Case-insensitive substring patterns. If a key contains any of these, its
 * value is redacted regardless of type. Keep this list broad — a false positive
 * only hides a field from logs; a false negative can leak a secret.
 */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|(^|[-_])auth([-_]|$)|cookie|session[-_]?secret|credential|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|signing|hmac|encryption|ssn|card[-_]?number|cvv|security[-_]?code|phone[-_]?number|(^|[-_])phone([-_]|$)|mobile[-_]?number|telephone|msisdn)/i;

/**
 * Matches email-shaped substrings inside free-text values. Not RFC-perfect on
 * purpose: the goal is to catch the common shapes customer emails take, not to
 * validate addresses.
 */
const EMAIL_VALUE_PATTERN =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

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
  const withoutEmails = value.replace(EMAIL_VALUE_PATTERN, REDACTED_EMAIL);
  if (withoutEmails.length > maxString) {
    return `${withoutEmails.slice(0, maxString)}…[truncated ${
      withoutEmails.length - maxString
    } chars]`;
  }
  return withoutEmails;
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
