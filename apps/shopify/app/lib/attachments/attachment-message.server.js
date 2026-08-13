// @ts-check

// The seam between "a merchant picked a file in the composer" and "Jefe has words it can think
// with". `read-attachment.server.js` turns bytes into a description; this turns a multipart form
// field into a chat turn.
//
// DERIVE AND DISCARD still holds — the File is read, described, and dropped. Nothing here can
// persist bytes, and the composed message is ordinary conversation text, so the whole path needs
// no schema change and no blob store.
//
// ⚠️ The composed text is ATTRIBUTED TO THE MERCHANT (it becomes their message in the thread), so
// the model's description must be visibly labelled as a reading of a file rather than something
// the merchant typed. That labelling is the merchant's only chance to catch a misread invoice
// before Jefe reasons on it, so it is not decoration.

import {
  MAX_ATTACHMENT_BYTES,
  attachmentKind,
  attachmentRejectionReason,
} from "./attachment-limits.js";
import { readAttachment } from "./read-attachment.server.js";

/**
 * A whole request body ceiling, checked from Content-Length BEFORE the body is buffered.
 * `attachmentRejectionReason` is the honest per-file cap; this one exists so a hostile 500MB
 * POST is refused at the door rather than pulled into memory and then found to be too big.
 */
export const MAX_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024;

/** The composer's file field. Named here so route and component cannot drift apart. */
export const ATTACHMENT_FIELD = "attachment";

/**
 * @param {Request} request
 * @returns {string | null} a merchant-facing reason, or null when the body is a sane size
 */
export function oversizedUploadReason(request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) return null;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= MAX_UPLOAD_BYTES) return null;
  return "That file's too big for me to read — under 8MB and I'll manage it.";
}

/**
 * Build the message that gets stored and sent to the model.
 *
 * Pure, so the wording is testable without a provider. Returns "" when there is nothing worth
 * sending — the caller treats that as a rejection rather than storing an empty turn.
 *
 * @param {{ message?: string | null, filename?: string | null, extract?: string | null }} input
 * @returns {string}
 */
export function composeAttachmentMessage(input) {
  const message = String(input?.message ?? "").trim();
  const extract = String(input?.extract ?? "").trim();
  if (!extract) return message;
  const named = String(input?.filename ?? "").trim();
  // Labelled, so neither the merchant nor the model reads Jefe's OCR as the merchant's own words.
  const header = named
    ? `[Attached: ${named} — here is what I can see in it]`
    : "[Attached file — here is what I can see in it]";
  return message ? `${message}\n\n${header}\n${extract}` : `${header}\n${extract}`;
}

/**
 * Pull the composer's file out of a submitted form and read it.
 *
 * @param {FormData} formData
 * @param {{
 *   prisma?: any,
 *   merchantId?: string | null,
 *   shopId?: string | null,
 *   client?: { models: { generateContent: Function } },
 *   logger?: Pick<Console, "info" | "warn" | "error">,
 *   keepBytes?: boolean,
 * }} [options]
 * @returns {Promise<
 *   | null
 *   | { ok: true, text: string, filename: string | null, bytes?: Buffer, mimeType?: string, kind?: string }
 *   | { ok: false, reason: string }
 * >} null when the merchant attached nothing at all.
 */
export async function readUploadedAttachment(formData, options = {}) {
  const file = formData.get(ATTACHMENT_FIELD);
  // An empty file input still submits a zero-byte part in some browsers — that is "no
  // attachment", not a failed one, and must not turn a plain message into an error.
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") return null;
  if (!file.size) return null;

  const rejection = attachmentRejectionReason({
    mimeType: file.type,
    byteLength: file.size,
    filename: file.name,
  });
  if (rejection) return { ok: false, reason: rejection };

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await readAttachment({
    base64: buffer.toString("base64"),
    mimeType: file.type,
    byteLength: file.size,
    filename: file.name,
    prisma: options.prisma,
    merchantId: options.merchantId ?? null,
    shopId: options.shopId ?? null,
    client: options.client,
    logger: options.logger,
  });

  // ⭐ DERIVE AND DISCARD REMAINS THE DEFAULT. The bytes come back only when the caller asks
  // for them, which happens exactly when the merchant ticked "keep this file". Anything that
  // forgets to ask gets words, and the buffer goes out of scope — so the storing path has to
  // be chosen deliberately rather than being what happens if you do nothing.
  if (options.keepBytes && result.ok) {
    return {
      ...result,
      bytes: buffer,
      mimeType: file.type,
      kind: attachmentKind(file.type, file.name) ?? "document",
    };
  }
  return result;
}
