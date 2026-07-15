// @ts-check

/**
 * Prepare a Klaviyo campaign/list draft through a typed adapter boundary.
 *
 * v0 is deliberately dry-run only. The return shape mirrors the data a real
 * adapter will need, without persisting raw customer emails or sending.
 *
 * @param {{ actionId: string; idempotencyKey: string; privateKeyRef?: string | null; dryRun?: boolean; campaignName: string; discountPercent: number; audience: { treatmentCount: number; holdoutCount: number }; stagedSend: Array<Record<string, unknown>> }} input
 */
export async function prepareKlaviyoWinbackDraft(input) {
  if (input.dryRun !== true) {
    throw new Error("Live Klaviyo writes are not enabled for winback v0.");
  }

  return {
    connector: "klaviyo",
    dryRun: true,
    actionId: input.actionId,
    externalDraftId: null,
    campaignName: input.campaignName,
    idempotencyKey: input.idempotencyKey,
    privateKeyRef: input.privateKeyRef ?? null,
    audience: {
      treatmentCount: input.audience.treatmentCount,
      holdoutCount: input.audience.holdoutCount,
    },
    stagedSend: input.stagedSend,
    status: "draft_prepared_for_approval",
    note: "Dry-run preview only. No Klaviyo campaign was created or sent.",
  };
}
