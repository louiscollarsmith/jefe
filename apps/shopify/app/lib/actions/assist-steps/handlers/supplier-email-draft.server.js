// @ts-check

import { formatAssistArtifactForChat } from "../format.server.js";

/** @param {any} context */
export async function runSupplierEmailDraftAssist(context) {
  const inventoryArtifact = (context.priorStepArtifacts ?? []).find(
    (/** @type {any} */ entry) => entry.progress?.artifactType === "inventory_review",
  )?.progress;
  const items = Array.isArray(inventoryArtifact?.items) ? inventoryArtifact.items : [];
  const stepTitle =
    context.step?.title ??
    context.step?.label ??
    "Draft supplier replenishment communication";
  const lines = items.map((/** @type {any} */ item) => {
    const qty = item.recommendedUnitsAtDefaultCover;
    return qty
      ? `${item.title}: ${qty} units`
      : `${item.title}: please confirm quantity`;
  });
  const body =
    items.length > 0
      ? [
          "Hi,",
          "",
          "Could we please place a replenishment order for the following items?",
          "",
          ...lines.map((line) => `- ${line}`),
          "",
          "Please confirm lead time and availability.",
          "",
          "Thanks,",
        ].join("\n")
      : [
          "Hi,",
          "",
          "Could we please place a replenishment order for the low-cover items we discussed?",
          "",
          "Please confirm quantities, lead time, and availability.",
          "",
          "Thanks,",
        ].join("\n");
  const progress = {
    artifactType: "supplier_email_draft",
    title: stepTitle,
    summary:
      items.length > 0
        ? `Drafted a supplier email covering ${items.length} item${items.length === 1 ? "" : "s"}.`
        : "Drafted a supplier email template for you to complete.",
    detail: "Copy, edit, or send this outside Jefe. Tell me what to change before you contact the supplier.",
    body,
    items: items.map((/** @type {any} */ item) => ({
      title: item.title,
      recommendedUnitsAtDefaultCover: item.recommendedUnitsAtDefaultCover ?? null,
    })),
    nextPrompt:
      "Want me to change tone, quantities, or add delivery notes before you send it?",
  };
  return { progress, chatReply: formatAssistArtifactForChat(progress) };
}
