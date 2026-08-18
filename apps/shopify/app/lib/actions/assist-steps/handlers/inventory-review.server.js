// @ts-check

import { DEFAULT_RESTOCK_COVER_DAYS } from "../evidence.server.js";
import { formatAssistArtifactForChat } from "../format.server.js";

/** @param {any} context */
export async function runInventoryReviewAssist(context) {
  const items = Array.isArray(context.lowCoverProducts) ? context.lowCoverProducts : [];
  const stepTitle =
    context.step?.title ?? context.step?.label ?? "Review low-cover inventory items";
  if (items.length === 0) {
    const progress = {
      artifactType: "inventory_review",
      title: stepTitle,
      summary: "I couldn't find low-cover products in current store evidence.",
      detail:
        "Upload a stock sheet or tell me which SKUs to review, and I'll rebuild this proposal.",
      items: [],
      targetCoverDays: DEFAULT_RESTOCK_COVER_DAYS,
      nextPrompt: "Tell me which products to include, or send a file with current stock.",
    };
    return { progress, chatReply: formatAssistArtifactForChat(progress) };
  }
  const progress = {
    artifactType: "inventory_review",
    title: stepTitle,
    summary: `Reviewed ${items.length} low-cover product${items.length === 1 ? "" : "s"}.`,
    detail:
      "These are the items running below comfortable stock cover. Confirm the reorder quantities, or tell me what to change before I draft supplier communication.",
    items,
    targetCoverDays: DEFAULT_RESTOCK_COVER_DAYS,
    nextPrompt:
      "Does this look right? Once you confirm, I'll draft the supplier message for the next step.",
  };
  return { progress, chatReply: formatAssistArtifactForChat(progress) };
}
