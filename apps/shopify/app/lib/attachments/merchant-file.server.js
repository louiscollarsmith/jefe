// @ts-check

// The Jefe Library — files a merchant chose to KEEP.
//
// Founder decision, 2026-08-13: *"have an option for clients to save files within Jefe ... or
// whether its like one-off info/analysis work"*. That settles the question
// `docs/rich-content-direction.md` had parked: the app now stores merchant files.
//
// ⭐ Bytes live in Postgres, deliberately. Deletion is a DELETE, which makes erasure trivially
// correct and verifiable; backups come with the database; there is no vendor, region or
// lifecycle policy to decide first. Every read path here selects `extractedText` and NEVER
// `content` — the bytes exist only so a merchant can download their own file back.
//
// ⛔ THE COPY MUST NOT PROMISE PRIVACY. "Keep" and "don't keep" both send the file to a model to
// be read; the choice is about whether it is stored afterwards. A merchant who reads "don't
// save" as "stays private" has been misled, and the damage is done at transmission, not when we
// notice. See the trap section in docs/rich-content-direction.md.

/** Never list more than this at once — a library is browsed, not paged through forever. */
export const LIBRARY_PAGE_SIZE = 50;

/** Columns that are safe and cheap to read. `content` is excluded ON PURPOSE — see above. */
const LIBRARY_FIELDS = Object.freeze({
  id: true,
  filename: true,
  mimeType: true,
  kind: true,
  byteSize: true,
  extractedText: true,
  source: true,
  conversationId: true,
  lastUsedAt: true,
  createdAt: true,
});

/**
 * Keep a file. Returns the stored row (without bytes), or null when there is nothing to store.
 *
 * @param {any} prisma
 * @param {{
 *   merchantId: string,
 *   shopId?: string | null,
 *   filename?: string | null,
 *   mimeType: string,
 *   kind: string,
 *   bytes: Buffer,
 *   extractedText: string,
 *   conversationId?: string | null,
 *   source?: string,
 *   logger?: Pick<Console, "info" | "warn" | "error">,
 * }} input
 */
export async function saveMerchantFile(prisma, input) {
  const bytes = input?.bytes;
  if (!bytes?.length) return null;
  const row = await prisma.merchantFile.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId ?? null,
      filename: safeName(input.filename),
      mimeType: String(input.mimeType ?? "application/octet-stream"),
      kind: String(input.kind ?? "document"),
      byteSize: bytes.length,
      content: bytes,
      extractedText: String(input.extractedText ?? ""),
      conversationId: input.conversationId ?? null,
      source: input.source ?? "chat",
    },
    select: LIBRARY_FIELDS,
  });
  // The filename is merchant-authored; log that a file was kept, never what they called it.
  input.logger?.info?.("merchant kept a file", {
    merchantId: input.merchantId,
    shopId: input.shopId ?? null,
    kind: row.kind,
    byteSize: row.byteSize,
  });
  return row;
}

/**
 * @param {any} prisma
 * @param {{ merchantId: string, shopId?: string | null, limit?: number }} input
 */
export async function listMerchantFiles(prisma, input) {
  return prisma.merchantFile.findMany({
    where: { merchantId: input.merchantId, ...(input.shopId ? { shopId: input.shopId } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(input.limit) || LIBRARY_PAGE_SIZE, LIBRARY_PAGE_SIZE),
    select: LIBRARY_FIELDS,
  });
}

/**
 * Read one file's TEXT back, scoped to its owner.
 *
 * ⚠️ `merchantId` is in the where clause, not checked after the fact. A library is the first
 * place a broken tenant boundary would show up as one merchant reading another's invoices.
 *
 * @param {any} prisma
 * @param {{ merchantId: string, fileId: string, touch?: boolean }} input
 */
export async function getMerchantFileText(prisma, input) {
  const row = await prisma.merchantFile.findFirst({
    where: { id: input.fileId, merchantId: input.merchantId },
    select: LIBRARY_FIELDS,
  });
  if (!row) return null;
  if (input.touch) {
    // "The invoice I sent last month" is findable because we record when it was last used.
    await prisma.merchantFile
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }
  return row;
}

/**
 * The bytes, for a download. The ONLY path that reads `content`.
 *
 * @param {any} prisma
 * @param {{ merchantId: string, fileId: string }} input
 */
export async function getMerchantFileBytes(prisma, input) {
  return prisma.merchantFile.findFirst({
    where: { id: input.fileId, merchantId: input.merchantId },
    select: { id: true, filename: true, mimeType: true, byteSize: true, content: true },
  });
}

/**
 * Delete a file. Hard delete, not a flag: a merchant who asks Jefe to forget a document has
 * asked for it to be gone, and a soft-deleted invoice is still an invoice we are holding.
 *
 * @param {any} prisma
 * @param {{ merchantId: string, fileId: string, logger?: Pick<Console, "info"> }} input
 * @returns {Promise<boolean>} whether a row was actually removed
 */
export async function deleteMerchantFile(prisma, input) {
  const { count } = await prisma.merchantFile.deleteMany({
    where: { id: input.fileId, merchantId: input.merchantId },
  });
  if (count > 0) {
    input.logger?.info?.("merchant deleted a file", {
      merchantId: input.merchantId,
      fileId: input.fileId,
    });
  }
  return count > 0;
}

/**
 * A filename is merchant-supplied text that gets rendered — keep it short and boring.
 * @param {unknown} value
 * @returns {string}
 */
function safeName(value) {
  if (typeof value !== "string") return "Untitled file";
  const cleaned = value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 120) : "Untitled file";
}
