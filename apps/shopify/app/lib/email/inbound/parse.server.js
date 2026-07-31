// @ts-check

/**
 * Parse + classify a verified inbound-email webhook payload.
 *
 * The signature check (signature.server.js) authenticates that RESEND sent us the
 * request. This module does the rest of "verify before act": it normalises the
 * payload into a typed descriptor, evaluates the sender's SPF/DKIM/DMARC results
 * (so a spoofed From can't reach Jefe's brain), and decides which door the mail
 * hit — Door A (jefe@, the AI) or Door B (team@, humans).
 *
 * Deliberately tolerant: Resend's exact inbound field names are confirmed against
 * a live payload before go-live (chat 5), so every extractor accepts the handful
 * of shapes the payload could take and returns a `reason` rather than throwing.
 * Pure + side-effect-free so it runs on plain `node --test`.
 */

const DEFAULT_AI_ADDRESS = "jefe@mynamejefe.com";
const DEFAULT_TEAM_ADDRESS = "team@mynamejefe.com";

/** @param {unknown} value @returns {string} */
function asString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Pull a bare `local@domain` out of a `From`/`To` value that may be a plain
 * string, a `Display Name <addr>` string, or an object with an address field.
 * Lower-cased + trimmed. Returns "" when nothing address-shaped is found.
 * @param {unknown} value
 * @returns {string}
 */
export function extractEmailAddress(value) {
  if (value && typeof value === "object") {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return extractEmailAddress(obj.address ?? obj.email ?? obj.value ?? "");
  }
  const raw = asString(value).trim();
  if (!raw) return "";
  // `Display Name <addr@x>` → addr@x
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

/** First recipient address from `to` (array | string | object). @param {unknown} to */
function firstRecipient(to) {
  if (Array.isArray(to)) {
    for (const entry of to) {
      const addr = extractEmailAddress(entry);
      if (addr) return addr;
    }
    return "";
  }
  return extractEmailAddress(to);
}

/**
 * Normalise a payload's headers into a flat lookup (lower-cased header name →
 * value). Accepts an array of `{ name, value }` or a plain object.
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
function indexHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const name = asString(h?.name).toLowerCase();
      if (name) out[name] = asString(h?.value);
    }
  } else if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      out[k.toLowerCase()] = asString(v);
    }
  }
  return out;
}

/**
 * Best-effort HTML → text for the rare inbound with no text/plain part. Strips
 * tags + collapses whitespace; bounded, never throws.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Trim the quoted original off a reply so the brain sees only what the merchant
 * actually wrote. Conservative: cuts at the first common reply marker, and if that
 * would leave nothing, keeps the original text. Never throws.
 * @param {string} text
 * @returns {string}
 */
export function stripQuotedReply(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const markers = [
    /^\s*>/, // quoted line
    /^\s*On .+ wrote:\s*$/i, // "On <date>, <name> wrote:"
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
    /^\s*_{5,}\s*$/, // Outlook divider
    /^\s*From:\s.+/i, // forwarded/quoted header block
    /^\s*This is Jefe, your AI eCommerce manager/i, // our own reply header, quoted back
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (markers.some((m) => m.test(lines[i]))) {
      cut = i;
      break;
    }
  }
  const trimmed = lines.slice(0, cut).join("\n").trim();
  return trimmed || text.trim();
}

/**
 * @typedef {Object} ParsedInboundEmail
 * @property {string} from Bare sender address, lower-cased.
 * @property {string} to Bare (first) recipient address, lower-cased.
 * @property {string} subject
 * @property {string} text The merchant's message (quoted history trimmed).
 * @property {string} messageId Provider/Message-ID used for idempotency.
 * @property {{ spf: string | null; dkim: string | null; dmarc: string | null; source: string }} auth
 */

/**
 * Normalise a webhook payload into a ParsedInboundEmail, or a reason it can't be
 * acted on. `payload` is the already-JSON-parsed body.
 * @param {any} payload
 * @returns {{ ok: true; email: ParsedInboundEmail } | { ok: false; reason: string }}
 */
export function parseInboundEmail(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "malformed_payload" };
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;

  const from = extractEmailAddress(data.from ?? data.sender ?? data.envelope?.from);
  const to = firstRecipient(data.to ?? data.recipient ?? data.envelope?.to);
  if (!from) return { ok: false, reason: "no_sender" };
  if (!to) return { ok: false, reason: "no_recipient" };

  const headers = indexHeaders(data.headers);
  const rawText = asString(data.text ?? data.plain ?? data["body-plain"]);
  const html = asString(data.html ?? data["body-html"]);
  const text = stripQuotedReply(rawText || (html ? htmlToText(html) : ""));

  const messageId =
    asString(data.email_id) ||
    asString(data.id) ||
    asString(data.message_id) ||
    asString(headers["message-id"]) ||
    "";

  return {
    ok: true,
    email: {
      from,
      to,
      subject: asString(data.subject),
      text,
      messageId,
      auth: extractAuthResults(data, headers),
    },
  };
}

/**
 * Pull SPF/DKIM/DMARC verdicts from the payload. Prefers structured fields, falls
 * back to the standard `Authentication-Results` header (RFC 8601) so we are not
 * hostage to Resend's exact field naming.
 * @param {any} data
 * @param {Record<string, string>} headers
 * @returns {ParsedInboundEmail["auth"]}
 */
function extractAuthResults(data, headers) {
  /** @param {unknown} v */
  const verdict = (v) => {
    if (typeof v === "string") return v.trim().toLowerCase() || null;
    if (v && typeof v === "object") {
      const s = asString(/** @type {any} */ (v).status ?? /** @type {any} */ (v).result);
      return s ? s.toLowerCase() : null;
    }
    return null;
  };

  let spf = verdict(data.spf);
  let dkim = verdict(data.dkim);
  let dmarc = verdict(data.dmarc);
  let source = "fields";

  if (!spf && !dkim && !dmarc) {
    const ar = headers["authentication-results"] || asString(data.authentication_results);
    if (ar) {
      source = "authentication-results";
      spf = matchVerdict(ar, "spf");
      dkim = matchVerdict(ar, "dkim");
      dmarc = matchVerdict(ar, "dmarc");
    } else {
      source = "none";
    }
  }
  return { spf, dkim, dmarc, source };
}

/** @param {string} ar @param {string} method @returns {string | null} */
function matchVerdict(ar, method) {
  const m = ar.toLowerCase().match(new RegExp(`\\b${method}=([a-z]+)`));
  return m ? m[1] : null;
}

/**
 * Decide whether the sender's authentication is good enough to act on. Fail-closed
 * ("never act on unauthenticated inbound"): a pass needs SPF or DKIM to pass with
 * DMARC not failing, OR DMARC itself passing. Anything indeterminate → not passed,
 * with a distinct reason so ops can see it (and we can tighten/loosen once the live
 * payload shape is confirmed).
 * @param {ParsedInboundEmail["auth"]} auth
 * @returns {{ pass: boolean; reason: string }}
 */
export function evaluateInboundAuth(auth) {
  const spfPass = auth.spf === "pass";
  const dkimPass = auth.dkim === "pass";
  const dmarcPass = auth.dmarc === "pass";
  const dmarcFail = auth.dmarc === "fail";

  if (dmarcPass) return { pass: true, reason: "dmarc_pass" };
  if ((spfPass || dkimPass) && !dmarcFail) {
    return { pass: true, reason: spfPass ? "spf_pass" : "dkim_pass" };
  }
  if (dmarcFail || auth.spf === "fail" || auth.dkim === "fail") {
    return { pass: false, reason: "auth_fail" };
  }
  return { pass: false, reason: "auth_unknown" };
}

/**
 * Which door did this recipient hit? Matches the configured AI/team addresses
 * exactly, then falls back to the local-part (`jefe@…` → AI, `team@…`/`humans@…` →
 * team) so a subdomain choice can't silently misroute. Unknown → parked.
 * @param {string} recipient bare lower-cased address
 * @param {Record<string, string | undefined>} [env]
 * @returns {"ai" | "team" | "unknown"}
 */
export function classifyDoor(recipient, env = process.env) {
  const addr = extractEmailAddress(recipient);
  if (!addr) return "unknown";
  const ai = (env.INBOUND_AI_ADDRESS || DEFAULT_AI_ADDRESS).trim().toLowerCase();
  const team = (env.INBOUND_TEAM_ADDRESS || DEFAULT_TEAM_ADDRESS).trim().toLowerCase();
  if (addr === ai) return "ai";
  if (addr === team) return "team";

  const localPart = addr.slice(0, addr.indexOf("@"));
  if (localPart === "jefe") return "ai";
  if (localPart === "team" || localPart === "humans") return "team";
  return "unknown";
}

export { DEFAULT_AI_ADDRESS, DEFAULT_TEAM_ADDRESS };
