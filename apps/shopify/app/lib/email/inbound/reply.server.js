// @ts-check

/**
 * Render Jefe's outbound reply to an inbound Door A (AI) email.
 *
 * This is where the founder's hard constraint lives, in code: every AI reply
 * self-identifies as the AI at the top ("This is Jefe, your AI eCommerce
 * manager"), signs "— Jefe" (NEVER a human name — a permanent guardrail,
 * consistent with CLAUDE.md's "never present model inference as a human"), and
 * always shows the human door (Door B, team@) one obvious click away in the
 * footer. Copy must never let a merchant think the AI is a person.
 *
 * Pure: no env, no network, no DB — the service passes in the resolved addresses
 * and links. Runs on plain `node --test`.
 */

export const JEFE_IDENTITY_LINE = "This is Jefe, your AI eCommerce manager.";

/** @param {string} s */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `Re: <subject>` without doubling an existing `Re:`. Falls back to a sensible
 * default when the inbound had no subject.
 * @param {string | null | undefined} originalSubject
 * @returns {string}
 */
export function buildReplySubject(originalSubject) {
  const s = (originalSubject ?? "").trim();
  if (!s) return "Re: your note to Jefe";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Body text → HTML paragraphs, escaped. @param {string} body */
function bodyToHtml(body) {
  return body
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px;">${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/**
 * @typedef {Object} RenderJefeReplyInput
 * @property {string} replyText Jefe's answer (from the conversation brain).
 * @property {string | null} [originalSubject]
 * @property {string} teamAddress The human door (Door B), e.g. team@mynamejefe.com.
 * @property {string} [appUrl] For a link to the in-app chat surface.
 * @property {string} [unsubscribeUrl] One-click unsubscribe URL (also set as a header by the caller).
 */

/**
 * @typedef {Object} RenderedReply
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 */

/**
 * Render the reply email. The identity line leads, the answer follows, the "— Jefe"
 * sign-off closes, and the footer always carries the human door + (optional)
 * unsubscribe.
 * @param {RenderJefeReplyInput} input
 * @returns {RenderedReply}
 */
export function renderJefeReplyEmail(input) {
  const replyText = (input.replyText ?? "").trim();
  const teamAddress = input.teamAddress.trim();
  const subject = buildReplySubject(input.originalSubject);

  const humanDoorText = `Prefer a person? Talk to the Jefe team → ${teamAddress}`;
  const whoAnswersText =
    "You're emailing with Jefe, your AI eCommerce manager — same memory as the app. Just reply and it reaches me.";

  const text = [
    JEFE_IDENTITY_LINE,
    "",
    replyText,
    "",
    "— Jefe",
    "",
    "—",
    whoAnswersText,
    humanDoorText,
    ...(input.unsubscribeUrl ? ["", `Turn off these emails: ${input.unsubscribeUrl}`] : []),
  ].join("\n");

  const teamHref = `mailto:${escapeHtml(teamAddress)}`;
  const html = `<!-- Door A (AI) reply. Self-identifies as the AI; signs "— Jefe"; human door always present. -->
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px;">
  <p style="margin:0 0 16px;font-weight:600;">${escapeHtml(JEFE_IDENTITY_LINE)}</p>
  ${bodyToHtml(replyText)}
  <p style="margin:0 0 24px;">— Jefe</p>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:0 0 12px;">
  <p style="margin:0 0 8px;font-size:13px;color:#666;">${escapeHtml(whoAnswersText)}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#666;">Prefer a person? <a href="${teamHref}" style="color:#1a1a1a;">Talk to the Jefe team → ${escapeHtml(teamAddress)}</a></p>
  ${input.unsubscribeUrl ? `<p style="margin:0;font-size:12px;color:#999;"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#999;">Turn off these emails</a></p>` : ""}
</div>`;

  return { subject, html, text };
}
