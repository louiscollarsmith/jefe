// @ts-check

// Morning-brief email render (Phase 2). Pure: no I/O, no network — takes an
// already-assembled brief payload (real app-home data; the sender gathers it) and
// returns subject/html/text/headers for the shared sendEmail adapter.
//
// COPY/VOICE OWNERSHIP: this is a functional **v1** so the dark sender is testable
// end-to-end. The branded template + final "— Jefe" voice is chat 2's comms lane
// (matches welcome/winback) — chat 2 refines the HTML/copy here; the sender +
// scheduling + Reply-To/footer wiring is stable underneath. Never a human name in
// the signature (permanent guardrail); never fabricated content (the sender only
// passes real data, and omits a section when the data isn't there).

import { unsubscribeHeaders } from "./welcome.server.js";

/**
 * @typedef {Object} MorningBriefInput
 * @property {string} storeName
 * @property {string | null} [merchantName] First name for the greeting, if known.
 * @property {{ headline: string; why?: string | null } | null} [move] The day's suggested action, if any.
 * @property {string | null} [metricLine] A short "where things stand" line, e.g. "Last 30 days: 46 orders · £2,762".
 * @property {string} appUrl Deep link to open Jefe.
 * @property {string} unsubscribeUrl Signed one-click unsubscribe URL.
 * @property {string} humanEmail The labelled human door (team@ / hola@).
 */

/**
 * @typedef {Object} RenderedBrief
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 * @property {Record<string, string>} headers
 */

/** @param {string} value */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the morning brief. Pure.
 * @param {MorningBriefInput} input
 * @returns {RenderedBrief}
 */
export function renderMorningBriefEmail(input) {
  const storeName = (input.storeName || "your store").trim();
  const greetingName = input.merchantName ? input.merchantName.trim() : "";
  const greeting = greetingName ? `Morning, ${greetingName}.` : "Morning.";

  const move = input.move && input.move.headline ? input.move : null;
  const bodyLines = move
    ? [
        "Here's what I'd do today:",
        "",
        move.headline,
        ...(move.why ? ["", `Why: ${move.why}`] : []),
      ]
    : [
        "Nothing needs a decision from you today. I'm still reading your orders and stock, and I'll bring the next move when it's worth your time.",
      ];
  if (input.metricLine) {
    bodyLines.push("", `Where things stand: ${input.metricLine}.`);
  }

  const subject = move
    ? `Your ${storeName} brief — one move today`
    : `Your ${storeName} brief — all clear today`;

  const text = [
    greeting,
    "",
    ...bodyLines,
    "",
    `Open Jefe: ${input.appUrl}`,
    "",
    "Reply to this email and it reaches me — same thread, same memory as the app.",
    "— Jefe",
    "",
    `Prefer a human? Email the team: ${input.humanEmail}`,
    `Turn off these emails: ${input.unsubscribeUrl}`,
  ].join("\n");

  const htmlBody = bodyLines
    .map((line) => (line ? `<p style="margin:0 0 12px">${escapeHtml(line)}</p>` : ""))
    .join("");
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#2b2b2b;max-width:560px">`,
    `<p style="margin:0 0 16px">${escapeHtml(greeting)}</p>`,
    htmlBody,
    `<p style="margin:20px 0"><a href="${escapeHtml(input.appUrl)}" style="background:#8c4030;color:#fdfbf7;text-decoration:none;font-weight:600;border-radius:6px;padding:10px 16px;display:inline-block">Open Jefe</a></p>`,
    `<p style="margin:16px 0 4px;color:#555">Reply to this email and it reaches me — same thread, same memory as the app.</p>`,
    `<p style="margin:0 0 16px">— Jefe</p>`,
    `<p style="margin:0;font-size:12.5px;color:#888">Prefer a human? <a href="mailto:${escapeHtml(input.humanEmail)}" style="color:#8c4030">Email the team</a> · <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#888">Turn off these emails</a></p>`,
    `</div>`,
  ].join("");

  return { subject, html, text, headers: unsubscribeHeaders(input.unsubscribeUrl) };
}
