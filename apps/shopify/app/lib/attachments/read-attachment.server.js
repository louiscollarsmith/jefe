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
// entire inbox. It is redacted here, before it reaches a caller, because the caller's job is
// to store it and storing it is exactly what we must not do unredacted.

import { GoogleGenAI } from "@google/genai";

import { getLlmConfig } from "../llm/config.server.js";
import { assertExternalLlmCallAllowed } from "../llm/external-call-guard.server.js";
import { sanitizeMemoryText } from "../merchant-memory/episodic-memory.server.js";
import { recordLlmUsage } from "../llm/usage-recorder.server.js";

/** Formats a vision model can actually read. Anything else is refused rather than guessed at. */
export const READABLE_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

/** Keeps a single inline request within the provider's limits, and keeps a bad upload cheap. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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
 * @param {unknown} mimeType
 * @returns {boolean}
 */
export function isReadableAttachment(mimeType) {
  return typeof mimeType === "string" && READABLE_MIME_TYPES.includes(mimeType.toLowerCase());
}

/**
 * Refuse before spending anything — a bad upload should cost a validation branch, not a
 * provider round-trip. Returns a merchant-facing reason, or null when the file is fine.
 *
 * @param {{ mimeType?: unknown; byteLength?: unknown; filename?: unknown }} input
 * @returns {string | null}
 */
export function attachmentRejectionReason(input) {
  if (!isReadableAttachment(input?.mimeType)) {
    return "I can read photos and PDFs — that one's a file type I can't open.";
  }
  const bytes = Number(input?.byteLength);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "That file came through empty — worth trying again.";
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return "That file's too big for me to read — under 8MB and I'll manage it.";
  }
  return null;
}

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

  // The prompt ASKS the model to leave PII out; this makes sure of it. An instruction is a
  // preference, redaction is a guarantee, and this text is about to be stored in a thread.
  //
  // sanitizeMemoryText is the SAME redactor the conversation and working-memory paths use —
  // email, phone, card, Shopify secrets, customer names. Reusing it keeps one definition of
  // "safe to store"; a bespoke one here would be a fifth variant free to disagree with the
  // others, which is exactly how redaction went missing on the chat path earlier today.
  const text = sanitizeMemoryText(raw).slice(0, MAX_EXTRACT_CHARS).trim();
  if (!text) {
    return { ok: false, reason: "That file looked empty to me — worth checking it sent properly." };
  }

  return { ok: true, text, filename: safeFilename(input.filename) };
}

/** Base64 is 4 characters per 3 bytes; near enough to refuse an oversized upload early. */
function approximateBytes(base64) {
  if (typeof base64 !== "string" || !base64) return 0;
  return Math.floor((base64.length * 3) / 4);
}

/** A filename is merchant-supplied text that gets rendered — keep it short and boring. */
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
