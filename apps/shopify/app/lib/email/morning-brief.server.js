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

import { unsubscribeHeaders, DEFAULT_LOGO_URL } from "./welcome.server.js";

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
  const logoUrl = process.env.EMAIL_LOGO_URL || DEFAULT_LOGO_URL;

  const subject = move
    ? `Your ${storeName} brief — one move today`
    : `Your ${storeName} brief — all clear today`;

  // --- plaintext (deliverability + text-only clients) ---
  const textLines = [
    greeting,
    "",
    move
      ? "Here's the one move I'd make today:"
      : "Nothing needs a decision from you today. I'm still reading your orders and stock, and I'll bring the next move when it's worth your time.",
  ];
  if (move) {
    textLines.push("", move.headline);
    if (move.why) textLines.push("", `Why: ${move.why}`);
  }
  if (input.metricLine) textLines.push("", `Where things stand: ${input.metricLine}.`);
  const text = [
    ...textLines,
    "",
    `Open Jefe: ${input.appUrl}`,
    "",
    "Reply to this email and it reaches me — same thread, same memory as the app.",
    "— Jefe",
    "",
    `Prefer a person? Email the team: ${input.humanEmail}`,
    `Turn off these emails: ${input.unsubscribeUrl}`,
  ].join("\n");

  // --- branded HTML (welcome/winback design system: navy band, cream card,
  // Georgia display, terracotta accent). No fabrication: the move + metric blocks
  // render only when the sender passed real data. ---
  const moveHtml = move
    ? `
      <tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:14px;letter-spacing:1.6px;text-transform:uppercase;color:#8c4030;padding-bottom:12px;">Today's move</td></tr>
      <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:20px;line-height:28px;color:#232a3d;padding-bottom:${move.why ? "12px" : "0"};">${escapeHtml(move.headline)}</td></tr>
      ${move.why ? `<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#6b7285;">${escapeHtml(move.why)}</td></tr>` : ""}`
    : `<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:26px;color:#4a5165;">Nothing needs a decision from you today. I'm still reading your orders and stock, and I'll bring the next move when it's worth your time.</td></tr>`;

  const metricHtml = input.metricLine
    ? `<tr><td style="background-color:#fffcf7;padding:18px 34px 0 34px;" class="pad">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="background-color:#f8ece7;border:1px solid #ecd9d1;border-radius:9px;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#4a5165;"><span style="color:#8c4030;font-weight:bold;">Where things stand</span> &nbsp;·&nbsp; ${escapeHtml(input.metricLine)}</td></tr></table>
    </td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light dark" /><meta name="supported-color-schemes" content="light dark" /><title>Your ${escapeHtml(storeName)} brief</title>
<style>@media only screen and (max-width:620px){.pad{padding-left:22px !important;padding-right:22px !important;}.h1{font-size:28px !important;line-height:34px !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:#ece5da;">
<span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;font-size:1px;line-height:1px;">${move ? "One move worth your time today, plus where things stand." : "You're all clear today — nothing needs a decision from you."}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#ece5da;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">
    <tr><td bgcolor="#1b2338" style="background-color:#1b2338;border-radius:14px 14px 0 0;padding:22px 34px;" class="pad">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td align="left"><img src="${escapeHtml(logoUrl)}" width="176" height="44" alt="Jefe" style="display:block;border:0;outline:none;text-decoration:none;height:44px;width:176px;" /></td>
        <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:14px;letter-spacing:1.6px;text-transform:uppercase;color:#9aa6c4;">Morning brief</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="#fffcf7" style="background-color:#fffcf7;padding:36px 34px 8px 34px;" class="pad">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:38px;color:#232a3d;" class="h1">${escapeHtml(greeting)}</td></tr>
      <tr><td height="20" style="height:20px;line-height:20px;font-size:0;">&nbsp;</td></tr>
      ${moveHtml}
      <tr><td height="26" style="height:26px;line-height:26px;font-size:0;">&nbsp;</td></tr>
      </table>
    </td></tr>
    ${metricHtml}
    <tr><td bgcolor="#fffcf7" style="background-color:#fffcf7;padding:22px 34px 8px 34px;" class="pad">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#8c4030" style="background-color:#8c4030;border-radius:9px;"><a href="${escapeHtml(input.appUrl)}" style="display:block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#fdfbf7;text-decoration:none;">Open Jefe →</a></td></tr></table>
    </td></tr>
    <tr><td bgcolor="#fffcf7" style="background-color:#fffcf7;padding:20px 34px 30px 34px;" class="pad">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#6b7285;">Reply to this email and it reaches me — same thread, same memory as the app.<br /><span style="font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#232a3d;">— Jefe</span></td></tr></table>
    </td></tr>
    <tr><td bgcolor="#fffcf7" style="background-color:#fffcf7;border-radius:0 0 14px 14px;border-top:1px solid #e7e0d5;padding:18px 34px;" class="pad">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:20px;color:#8b8f9d;">You're getting this because you turned on the morning brief in Jefe.<br /><a href="mailto:${escapeHtml(input.humanEmail)}" style="color:#8c4030;text-decoration:underline;">Prefer a person? Email the team</a> &nbsp;·&nbsp; <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#8b8f9d;text-decoration:underline;">Turn off these emails</a></td></tr></table>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text, headers: unsubscribeHeaders(input.unsubscribeUrl) };
}
