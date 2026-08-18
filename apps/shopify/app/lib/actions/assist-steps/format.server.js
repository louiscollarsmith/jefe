// @ts-check

/** @param {unknown} progress */
export function isAssistStepArtifact(progress) {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return false;
  const artifactType = String(/** @type {any} */ (progress).artifactType ?? "").trim();
  if (!artifactType) return false;
  const summary = String(/** @type {any} */ (progress).summary ?? "").trim();
  return summary.length > 0;
}

/** @param {any} progress */
export function formatAssistArtifactForChat(progress) {
  if (!isAssistStepArtifact(progress)) return null;
  const lines = [];
  const title = String(progress.title ?? "Review proposal").trim();
  lines.push(title);
  if (progress.summary) lines.push(String(progress.summary));
  if (progress.detail) lines.push(String(progress.detail));
  if (Array.isArray(progress.items) && progress.items.length > 0) {
    lines.push("");
    for (const item of progress.items.slice(0, 6)) {
      lines.push(formatArtifactItem(item, progress));
    }
  }
  if (progress.body) {
    lines.push("");
    lines.push(String(progress.body));
  }
  if (progress.nextPrompt) lines.push("", String(progress.nextPrompt));
  return lines.join("\n");
}

/** @param {any} item @param {any} progress */
function formatArtifactItem(item, progress) {
  const parts = [`• ${item.title ?? "Item"}`];
  if (item.daysOfCover !== null && item.daysOfCover !== undefined) {
    parts.push(`${item.daysOfCover} days cover`);
  }
  if (item.available !== null && item.available !== undefined) {
    parts.push(`${item.available} in stock`);
  }
  if (item.recommendedUnitsAtDefaultCover !== null && item.recommendedUnitsAtDefaultCover !== undefined) {
    const days = progress.targetCoverDays ?? 120;
    parts.push(`suggest reordering ${item.recommendedUnitsAtDefaultCover} units (${days}-day cover)`);
  }
  return parts.join(" — ");
}

/** @param {any} progress */
export function assistArtifactSummaryLine(progress) {
  if (!isAssistStepArtifact(progress)) return null;
  return String(progress.summary ?? progress.detail ?? "").trim() || null;
}
