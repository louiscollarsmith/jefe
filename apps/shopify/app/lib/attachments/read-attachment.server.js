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
import {
  extractDocxText,
  extractPdfText,
  extractSpreadsheetText,
  hasUsableText,
} from "./extract-document-text.server.js";
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

  // ⭐ DECODE, DON'T DESCRIBE. Anything that already contains its own words — a CSV, a
  // spreadsheet, a Word doc, a PDF with a text layer — is extracted exactly. That is instant,
  // free, and a model cannot hallucinate a cost that is sitting in row 40. The vision model is
  // the FALLBACK, for things that are genuinely pictures.
  const kind = attachmentKind(input?.mimeType, input?.filename);
  if (kind === "text") return finishWithText(decodeUtf8(input.base64), input);

  if (kind === "spreadsheet" || kind === "word" || kind === "document") {
    try {
      const buffer = Buffer.from(input.base64, "base64");
      const extracted =
        kind === "spreadsheet"
          ? await extractSpreadsheetText(buffer)
          : kind === "word"
            ? await extractDocxText(buffer)
            : await extractPdfText(buffer);
      if (kind !== "document" || hasUsableText(extracted)) {
        return finishWithText({ ok: true, text: extracted }, input);
      }
      // A scanned PDF extracts to nothing — that is exactly the case a vision model earns its
      // request on, so fall through rather than telling the merchant their invoice was empty.
      input.logger?.info?.("PDF has no text layer; falling back to vision", {
        merchantId: input.merchantId ?? null,
        shopId: input.shopId ?? null,
      });
    } catch (error) {
      input.logger?.warn?.("Document could not be parsed", {
        merchantId: input.merchantId ?? null,
        shopId: input.shopId ?? null,
        kind,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      if (kind !== "document") {
        // A corrupt or password-protected file. No dead ends — name a way forward.
        return {
          ok: false,
          reason:
            kind === "spreadsheet"
              ? "I couldn't open that spreadsheet — if it's password-protected, save a copy as CSV and I'll read it."
              : "I couldn't open that document — a PDF or plain text version would work.",
        };
      }
      // A PDF that fails to parse might still be readable as a picture.
    }
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
 * Decode raw bytes as UTF-8, refusing anything that is plainly not text.
 *
 * @param {string} base64
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
function decodeUtf8(base64) {
  let decoded = "";
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "I couldn't make that file out — is it definitely a text file?" };
  }
  // A binary file mislabelled as text (a .xls renamed to .csv) either carries NUL bytes or
  // decodes to a wall of U+FFFD. The U+FFFD case is COUNTED, not "contains one": a real export
  // can carry a stray bad byte, and refusing a merchant's cost file over one character would be
  // its own failure.
  const replacementCount = (decoded.match(/\uFFFD/g) ?? []).length;
  if (decoded.includes("\u0000") || (replacementCount > 20 && replacementCount > decoded.length * 0.01)) {
    return {
      ok: false,
      reason: "That looked like a text file but isn't one I can read — if it's a spreadsheet, save it as .xlsx or CSV.",
    };
  }
  return { ok: true, text: decoded };
}

/**
 * Trim, cap and return extracted text — the single exit for every non-vision format, so a CSV,
 * a spreadsheet, a Word doc and a text-layer PDF are all treated identically from here.
 *
 * ⚠️ Truncation is STATED, never silent. A merchant who sends a 20,000-row cost export and gets
 * advice based on the first 300 needs to know that — otherwise Jefe confidently answers "your
 * worst margin is X" having never seen most of the file.
 *
 * @param {{ ok: true, text: string } | { ok: false, reason: string }} decoded
 * @param {{ filename?: string | null }} input
 * @returns {{ ok: true, text: string, filename: string | null } | { ok: false, reason: string }}
 */
function finishWithText(decoded, input) {
  if (!decoded.ok) return decoded;
  const trimmed = String(decoded.text ?? "").trim();
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

  return { ok: true, text: sanitizeMemoryText(text), filename: safeFilename(input?.filename) };
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
