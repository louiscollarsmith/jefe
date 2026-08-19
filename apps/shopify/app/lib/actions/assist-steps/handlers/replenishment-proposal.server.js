// @ts-check

import { formatAssistArtifactForChat } from "../format.server.js";

/** @param {any} context */
export async function runReplenishmentProposalAssist(context) {
  const items = Array.isArray(context.lowCoverProducts) ? context.lowCoverProducts : [];
  const coverDays = Number(context.targetCoverDays) > 0 ? Number(context.targetCoverDays) : 120;
  const excluded = Array.isArray(context.resolvedContext?.scope?.excluded)
    ? context.resolvedContext.scope.excluded
    : [];
  const stepTitle =
    context.step?.title ?? context.step?.label ?? "Build replenishment proposal";
  if (items.length === 0) {
    const progress = {
      artifactType: "replenishment_proposal",
      title: stepTitle,
      summary: "I couldn't build a replenishment proposal from current evidence.",
      detail:
        "There are no eligible low-cover products in scope. Review the inventory step or adjust constraints.",
      items: [],
      targetCoverDays: coverDays,
      excluded,
      nextPrompt: "Tell me which products to include, or adjust the cover target.",
    };
    return { progress, chatReply: formatAssistArtifactForChat(progress) };
  }
  const progress = {
    artifactType: "replenishment_proposal",
    title: stepTitle,
    summary: `Replenishment proposal for ${items.length} product${items.length === 1 ? "" : "s"}.`,
    detail:
      "Recommended reorder quantities based on your current plan and constraints. Copy or edit before contacting the supplier.",
    items,
    targetCoverDays: coverDays,
    excluded,
    nextPrompt:
      "Does this look right? Once you confirm, I'll draft the supplier communication in the next step.",
  };
  return { progress, chatReply: formatReplenishmentProposalForChat(progress) };
}

/** @param {any} progress */
export function formatReplenishmentProposalForChat(progress) {
  const lines = ["REPLENISHMENT PROPOSAL", ""];
  for (const item of progress.items ?? []) {
    lines.push(String(item.title ?? "Item"));
    lines.push("");
    if (item.available != null) lines.push(`Available: ${item.available}`);
    if (item.dailyVelocity != null) lines.push(`Daily velocity: ${item.dailyVelocity}/day`);
    lines.push(`Target cover: ${progress.targetCoverDays ?? 120} days`);
    if (item.recommendedUnitsAtDefaultCover != null) {
      lines.push(`Recommended reorder: ${item.recommendedUnitsAtDefaultCover} units`);
    }
    lines.push("");
  }
  const excluded = Array.isArray(progress.excluded) ? progress.excluded : [];
  if (excluded.length > 0) {
    lines.push("Excluded:");
    for (const row of excluded.slice(0, 6)) {
      lines.push(`• ${row.title ?? row.reason ?? "Item"}`);
    }
    lines.push("");
  }
  if (progress.nextPrompt) lines.push(String(progress.nextPrompt));
  return lines.join("\n").trim();
}
