// @ts-check

// Reading what a merchant sends Jefe — a photo of a shelf, a supplier invoice, a packing list.
//
// DERIVE AND DISCARD. Matt's ruling for voice notes (2026-07-31) generalises: take the file,
// extract the understanding, keep the text, drop the bytes. The app has no blob storage, and
// acquiring one is a vendor + retention + GDPR decision that belongs to the founder rather
// than to whoever happens to be writing the upload path.
//
// So this module deliberately CANNOT persist a file. It takes bytes, returns words, and the
// bytes go out of scope. A merchant who wants to open the file again later needs the file
// library described in docs/rich-content-direction.md, which is a different and larger build.
//
// ⚠️ What comes back is UNTRUSTED MERCHANT-SUPPLIED CONTENT that has been through a model.
// An invoice carries customer names, addresses and card fragments; a screenshot can carry an
// entire inbox — and since 2026-08-13 that content is NOT scrubbed before it is stored or
// prompted with (founder's call, applied across every surface). The prompt below still asks
// the model to omit personal details, but asking is a preference, not a guarantee.

import { GoogleGenAI } from "@google/genai";

import {
  ATTACHMENT_ACCEPT,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  TEXT_MIME_TYPES,
  attachmentKind,
  attachmentRejectionReason,
  isReadableAttachment,
} from "./attachment-limits.js";
import { getLlmConfig } from "../llm/config.server.js";
import { assertExternalLlmCallAllowed } from "../llm/external-call-guard.server.js";
import { sanitizeMemoryText } from "../merchant-memory/episodic-memory.server.js";
import { recordLlmUsage } from "../llm/usage-recorder.server.js";

// The allow-list and the size cap live in a browser-safe module so the composer can refuse a
// file before uploading it and the server can refuse the same file on arrival, from one
// definition. Re-exported here because this module was the original home of both.
export {
  ATTACHMENT_ACCEPT,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  TEXT_MIME_TYPES,
  attachmentKind,
  attachmentRejectionReason,
  isReadableAttachment,
};

/**
 * How much of a text file is worth carrying. A cost export can be 20k rows; the useful signal
 * is in the columns and the first few hundred lines, and the rest is tokens forever.
 * Bigger than the vision budget because a CSV IS the data — there is no description step.
 */
const MAX_TEXT_CHARS = 12000;

/** How much extracted text is worth keeping. A wall of OCR helps nobody and costs tokens forever. */
const MAX_EXTRACT_CHARS = 4000;

const READ_PROMPT = [
  "You are reading a file a shop owner has just sent to their AI commerce manager.",
  "Describe what it shows, in plain English, as if telling them what you can see.",
  "Pull out anything a shop owner would want remembered: products, quantities, prices, costs,",
  "supplier or brand names, dates, order or invoice numbers, and any totals.",
  "If it is a photo of stock or a shelf, say what the products are and roughly how many.",
  "Do NOT invent anything you cannot see. If the file is unreadable or blank, say exactly that.",
  "Do NOT include customer names, email addresses, phone numbers, or card details in your answer.",
  "Return prose, no preamble, no markdown headings.",
].join(" ");

/**
 * Read an attachment and return what it says. Never returns the file, and never stores it.
 *
 * @param {{
 *   base64: string,
 *   mimeType: string,
 *   byteLength?: number,
 *   filename?: string | null,
 *   prisma?: any,
 *   merchantId?: string | null,
 *   shopId?: string | null,
 *   client?: { models: { generateContent: Function } },
 *   logger?: Pick<Console, "info" | "warn" | "error">,
 * }} input
 * @returns {Promise<{ ok: true, text: string, filename: string | null } | { ok: false, reason: string }>}
 */
export async function readAttachment(input) {
  const rejection = attachmentRejectionReason({
    mimeType: input?.mimeType,
    byteLength: input?.byteLength ?? approximateBytes(input?.base64),
    filename: input?.filename,
  });
  if (rejection) return { ok: false, reason: rejection };

  // A CSV, TSV or text file is already the answer. Decoding it is exact, free and instant, and
  // a model cannot hallucinate a cost that is sitting in row 40 — so text never goes to a
  // provider to be READ. (The chat turn still reasons over it, as it would over typed text.)
  if (attachmentKind(input?.mimeType, input?.filename) === "text") {
    return readTextAttachment(input);
  }

  const config = getLlmConfig();
  const injected = Boolean(input.client);
  if ((!config.enabled || !config.geminiApiKey) && !injected) {
    return { ok: false, reason: "I can't read files just now — try telling me what's in it." };
  }
  assertExternalLlmCallAllowed({ hasInjectedTransport: injected });

  const model = config.fallbackModel || "gemini-flash-lite-latest";
  const client = input.client ?? new GoogleGenAI({ apiKey: config.geminiApiKey });

  let response;
  try {
    response = await client.models.generateContent({
      model,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: input.mimeType, data: input.base64 } },
            { text: READ_PROMPT },
          ],
        },
      ],
    });
  } catch (error) {
    input.logger?.warn?.("Attachment could not be read", {
      merchantId: input.merchantId ?? null,
      shopId: input.shopId ?? null,
      mimeType: input.mimeType,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    if (input.prisma) {
      await recordLlmUsage(input.prisma, {
        provider: "gemini",
        model,
        feature: "attachment_read",
        runType: "vision",
        status: "error",
        merchantId: input.merchantId ?? null,
        shopId: input.shopId ?? null,
        usage: null,
      }).catch(() => {});
    }
    // No dead ends: the merchant gets a sentence, not a stack trace or silence.
    return { ok: false, reason: "I couldn't make that file out — tell me what's in it and I'll take it from there." };
  }

  const raw = extractText(response).trim();
  if (input.prisma) {
    await recordLlmUsage(input.prisma, {
      provider: "gemini",
      model,
      feature: "attachment_read",
      runType: "vision",
      status: "ok",
      merchantId: input.merchantId ?? null,
      shopId: input.shopId ?? null,
      usage: {
        inputTokens: response?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response?.usageMetadata?.candidatesTokenCount ?? null,
        totalTokens: response?.usageMetadata?.totalTokenCount ?? null,
      },
    }).catch(() => {});
  }
  if (!raw) {
    return { ok: false, reason: "That file looked empty to me — worth checking it sent properly." };
  }

  // Still routed through sanitizeMemoryText so there is ONE definition of "safe to store"
  // rather than a bespoke variant here. Since 2026-08-13 that function masks Shopify
  // credentials only — personal data passes through, by founder decision.
  const text = sanitizeMemoryText(raw).slice(0, MAX_EXTRACT_CHARS).trim();
  if (!text) {
    return { ok: false, reason: "That file looked empty to me — worth checking it sent properly." };
  }

  return { ok: true, text, filename: safeFilename(input.filename) };
}

/**
 * Decode a text file and keep as much of it as is worth carrying.
 *
 * ⚠️ Truncation is STATED, never silent. A merchant who sends a 20,000-row cost export and gets
 * advice based on the first 300 needs to know that — otherwise Jefe confidently answers "your
 * worst margin is X" having never seen most of the file.
 *
 * @param {{ base64: string, mimeType: string, filename?: string | null }} input
 * @returns {{ ok: true, text: string, filename: string | null } | { ok: false, reason: string }}
 */
function readTextAttachment(input) {
  let decoded = "";
  try {
    decoded = Buffer.from(input.base64, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "I couldn't make that file out — is it definitely a text file?" };
  }
  // A binary file mislabelled as text arrives as replacement characters; describing it as data
  // would be worse than saying so.
  // A binary file mislabelled as text (a .xls renamed to .csv) either carries NUL bytes or
  // decodes to a wall of U+FFFD. Both are refused with a way forward rather than described as
  // data. The U+FFFD case is COUNTED, not "contains one": a real export can carry a stray bad
  // byte, and refusing a merchant's cost file over one character would be its own failure.
  const replacementCount = (decoded.match(/\uFFFD/g) ?? []).length;
  if (decoded.includes("\u0000") || (replacementCount > 20 && replacementCount > decoded.length * 0.01)) {
    return {
      ok: false,
      reason: "That looked like a text file but isn't one I can read — if it's a spreadsheet, save it as CSV.",
    };
  }
  const trimmed = decoded.trim();
  if (!trimmed) {
    return { ok: false, reason: "That file looked empty to me — worth checking it sent properly." };
  }

  const lines = trimmed.split(/\r?\n/);
  let text = trimmed;
  if (text.length > MAX_TEXT_CHARS) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > MAX_TEXT_CHARS) break;
      kept.push(line);
      used += line.length + 1;
    }
    // Whole lines only — half a CSV row reads as a corrupt value rather than a cut-off file.
    text = `${kept.join("\n")}\n… showing the first ${kept.length} of ${lines.length} lines.`;
  }

  return { ok: true, text: sanitizeMemoryText(text), filename: safeFilename(input.filename) };
}

/**
 * Base64 is 4 characters per 3 bytes; near enough to refuse an oversized upload early.
 * @param {unknown} base64
 * @returns {number}
 */
function approximateBytes(base64) {
  if (typeof base64 !== "string" || !base64) return 0;
  return Math.floor((base64.length * 3) / 4);
}

/**
 * A filename is merchant-supplied text that gets rendered — keep it short and boring.
 * @param {unknown} value
 * @returns {string | null}
 */
function safeFilename(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 120);
}

/** @param {any} response */
function extractText(response) {
  if (typeof response?.text === "string") return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((/** @type {any} */ p) => (typeof p?.text === "string" ? p.text : "")).join(" ");
}
