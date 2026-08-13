// @ts-check

// What Jefe will accept from a merchant, and why — the rules the COMPOSER and the SERVER both
// need. Deliberately not a `.server` module: a file the browser rejects instantly costs nothing,
// and a file it lets through must be refused again on arrival. Two checks, ONE definition —
// duplicating the allow-list is how a composer ends up offering something the server bounces.

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

/** For the file picker's `accept`, so the OS dialog greys out what we would only refuse. */
export const ATTACHMENT_ACCEPT = READABLE_MIME_TYPES.join(",");

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
