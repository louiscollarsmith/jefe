// @ts-check

/**
 * Fetch the full inbound email by id (the second half of the two-step inbound
 * flow).
 *
 * Resend's `email.received` webhook is **metadata-only** — it carries from / to /
 * subject / a message id / attachment list, but NOT the body and NOT the sender's
 * SPF/DKIM/DMARC results. To get those we call the Receiving API by id
 * (`resend.emails.receiving.get(id)` — confirmed against the installed SDK: it
 * returns `{ from, to, subject, text, html, headers, message_id, … }`). The body
 * feeds the conversation brain; the `Authentication-Results` header is where the
 * verify-before-act SPF/DKIM gate reads the sender's authenticity.
 *
 * The SDK client is injectable so the service is testable without a network call,
 * and the whole thing is defensive (returns a reason, never throws) so a fetch
 * failure parks the mail rather than crashing the webhook.
 */

/**
 * @typedef {Object} FetchReceivedEmailResult
 * @property {boolean} ok
 * @property {any} [record] The raw Receiving-API email (parse with parseInboundEmail).
 * @property {string} [reason] Why the fetch didn't yield a record.
 */

/**
 * @param {string} messageId The inbound email id from the `email.received` event.
 * @param {{ env?: Record<string, string | undefined>; client?: any }} [opts]
 *   `client` is an object exposing `emails.receiving.get(id)` — injected in tests.
 * @returns {Promise<FetchReceivedEmailResult>}
 */
export async function fetchReceivedEmail(messageId, opts = {}) {
  const env = opts.env ?? process.env;
  if (!messageId) return { ok: false, reason: "no_message_id" };

  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (!opts.client && !apiKey) return { ok: false, reason: "missing_api_key" };

  try {
    let client = opts.client;
    if (!client) {
      const { Resend } = await import("resend");
      client = new Resend(apiKey);
    }
    const { data, error } = await client.emails.receiving.get(messageId);
    if (error || !data) return { ok: false, reason: "fetch_failed" };
    return { ok: true, record: data };
  } catch {
    // Swallow the SDK/network error (it may embed identifiers) — the caller parks.
    return { ok: false, reason: "fetch_error" };
  }
}
