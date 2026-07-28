// @ts-check

/**
 * Typed Resend adapter.
 *
 * SAFETY: sending is gated behind ENABLE_EMAIL. When ENABLE_EMAIL is unset or
 * not exactly "true" (the default), this adapter NEVER contacts Resend — it logs
 * `[email disabled] would send <subject> to <to>` and returns a stub. A real
 * send happens only when ENABLE_EMAIL=true AND RESEND_API_KEY is present. The
 * `resend` package is imported lazily inside the send path, so the disabled
 * default never even loads the SDK.
 */

/**
 * @typedef {Object} SendEmailInput
 * @property {string} to Recipient address.
 * @property {string} subject
 * @property {string} html
 * @property {string} [text] Optional plaintext alternative.
 * @property {Record<string, string>} [headers] Extra headers (e.g. List-Unsubscribe).
 * @property {string} [from] Overrides RESEND_FROM_EMAIL.
 * @property {string} [replyTo] Overrides RESEND_REPLY_TO — sets the Reply-To
 *   address so replies to a send-only sender (e.g. hola@) still reach a real,
 *   monitored inbox rather than bouncing.
 */

/**
 * @typedef {Object} SendEmailResult
 * @property {boolean} delivered True only when Resend accepted the message.
 * @property {boolean} disabled True when ENABLE_EMAIL gated the send (no-op).
 * @property {string | null} id Resend message id when delivered, else null.
 * @property {string} [skipped] Reason a delivery was skipped while enabled.
 * @property {string} to
 * @property {string} subject
 */

/**
 * Whether real email sending is switched on. Defaults to false.
 * @returns {boolean}
 */
export function isEmailEnabled() {
  return String(process.env.ENABLE_EMAIL ?? "").trim().toLowerCase() === "true";
}

/**
 * Build the exact object handed to `resend.emails.send`. Pure + exported so the
 * from / reply-to / optional-field wiring stays unit-testable without the SDK.
 *
 * @param {{ to: string; subject: string; html: string; text?: string; headers?: Record<string, string>; from: string; replyTo?: string }} input
 * @returns {import("resend").CreateEmailOptions}
 */
export function buildResendPayload(input) {
  const { to, subject, html, text, headers, from, replyTo } = input;
  return {
    from,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
    ...(headers ? { headers } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

/**
 * Send an email through Resend, gated behind ENABLE_EMAIL.
 *
 * @param {SendEmailInput} input
 * @returns {Promise<SendEmailResult>}
 */
export async function sendEmail(input) {
  const { to, subject } = input;
  const from = input.from ?? process.env.RESEND_FROM_EMAIL ?? "";
  const replyTo = input.replyTo ?? process.env.RESEND_REPLY_TO ?? "";

  // Default path: email disabled -> never touch Resend.
  if (!isEmailEnabled()) {
    console.log(`[email disabled] would send ${subject} to ${to}`);
    return { delivered: false, disabled: true, id: null, to, subject };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      `[email] ENABLE_EMAIL=true but RESEND_API_KEY is missing — not sending "${subject}" to ${to}`,
    );
    return {
      delivered: false,
      disabled: false,
      id: null,
      skipped: "missing_api_key",
      to,
      subject,
    };
  }
  if (!from) {
    console.warn(
      `[email] ENABLE_EMAIL=true but RESEND_FROM_EMAIL is missing — not sending "${subject}" to ${to}`,
    );
    return {
      delivered: false,
      disabled: false,
      id: null,
      skipped: "missing_from",
      to,
      subject,
    };
  }

  // Lazily load the SDK so the disabled default never imports it.
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send(
    buildResendPayload({ ...input, from, replyTo: replyTo || undefined }),
  );

  if (error) {
    throw new Error(
      `Resend send failed for "${subject}" to ${to}: ${error.name ?? "error"} — ${error.message ?? String(error)}`,
    );
  }

  return {
    delivered: true,
    disabled: false,
    id: data?.id ?? null,
    to,
    subject,
  };
}
