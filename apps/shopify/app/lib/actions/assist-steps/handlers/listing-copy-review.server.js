// @ts-check

import { formatAssistArtifactForChat } from "../format.server.js";

/**
 * Assist review for listing-copy / categorise-unassigned steps: show the actual
 * products and proposed types from the typed preview, never a generic checklist.
 *
 * @param {any} context
 */
export async function runListingCopyReviewAssist(context) {
  const items = listingCopyItemsFromContext(context);
  const stepTitle = context.step?.title ?? "Categorise unassigned products";
  if (items.length === 0) {
    const progress = {
      artifactType: "listing_copy_review",
      title: stepTitle,
      summary: "I don't have the unassigned-product proposal loaded for this step yet.",
      detail:
        "Start the execute step and I'll work from the live listing-copy preview. I will not invent a taxonomy.",
      items: [],
      nextPrompt: "Tell me to start the write, or ask what I'll change once the proposal is attached.",
    };
    return { progress, chatReply: formatAssistArtifactForChat(progress) };
  }
  const progress = {
    artifactType: "listing_copy_review",
    title: stepTitle,
    summary: `Proposed product types for ${items.length} unassigned product${items.length === 1 ? "" : "s"}.`,
    detail: "Types come from your existing catalogue vocabulary — I fill blanks, I don't retag products you already typed.",
    items: items.slice(0, 8).map((/** @type {any} */ item) => ({
      title: item.title,
      proposedType: item.toType,
    })),
    nextPrompt: "Tell me to start if this looks right, or say which products to leave alone.",
  };
  return { progress, chatReply: formatListingCopyReview(progress) };
}

/** @param {any} context */
function listingCopyItemsFromContext(context) {
  const action = context?.action ?? null;
  const preview = action?.progress?.preview ?? {};
  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  const previewItems = Array.isArray(action?.previewItems) ? action.previewItems : [];
  const rows = changes.length ? changes : previewItems;
  return rows
    .map((/** @type {any} */ item) => ({
      title: String(item?.title ?? item?.productTitle ?? "").trim(),
      toType: String(item?.toType ?? item?.proposedType ?? "").trim(),
    }))
    .filter((/** @type {any} */ item) => item.title);
}

/** @param {any} progress */
function formatListingCopyReview(progress) {
  const lines = [progress.title, progress.summary, progress.detail, ""];
  for (const item of progress.items ?? []) {
    lines.push(
      item.proposedType ? `• ${item.title} → ${item.proposedType}` : `• ${item.title}`,
    );
  }
  if (progress.nextPrompt) lines.push("", progress.nextPrompt);
  return lines.filter(Boolean).join("\n");
}
