// @ts-check
import { loadRun, markPhase, persistRun } from "./manifest.mjs";
import { resolveShopifyAccessToken } from "./credentials.mjs";
import { assertWriteSafety } from "./safety.mjs";

export async function cleanupSyntheticRun({
  shopDomain,
  runId,
  dryRun = false,
  allowNonemptyStore = true,
  credentialSource = "db",
}) {
  assertWriteSafety({ shopDomain, allowNonemptyStore });
  await resolveShopifyAccessToken({ shopDomain, source: credentialSource });
  const { dataset, manifest } = loadRun({ shopDomain, runId });
  const tags = dataset.meta.syntheticTags;
  const summary = {
    dryRun,
    shopDomain,
    runId,
    selectorTags: tags,
    plannedDeletes: {
      refunds: Object.keys(manifest.sourceToShopifyIds.refunds).length,
      orders: Object.keys(manifest.sourceToShopifyIds.orders).length,
      customers: Object.keys(manifest.sourceToShopifyIds.customers).length,
      products: Object.keys(manifest.sourceToShopifyIds.products).length,
    },
    note: "Cleanup is intentionally tag-scoped to the selected seed_run. Live deletion mutations should be enabled only after confirming the target store's current schema and deletion semantics.",
  };
  if (!dryRun) markPhase(manifest, "cleanup", "blocked_by_schema_confirmation", 0);
  persistRun({ dataset, manifest });
  return summary;
}
