// @ts-check

import { listActionTypes } from "./action-intent.server.js";
import { getActionMode } from "./action-autonomy-policy.server.js";

/**
 * The merchant's autonomy mode for each LIVE action type — registered in ACTION_REGISTRY
 * AND its execute-flag on, per `listActionTypes()` (today just `price_markdown`). One cheap
 * indexed `getActionMode` per live type → a `{ actionType: mode }` map.
 *
 * Feeds the Settings → Autonomy panel: a key present ⇒ that action type is live and renders
 * a real dial at the merchant's mode; absent ⇒ the roster keeps the design row visible but
 * gated ("Soon", or a needs-you prompt). A newly-graduated action (registry entry + flag on,
 * e.g. `product_status_change`) lights its dial here with no surface edit.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string }} input
 * @returns {Promise<Record<string, string>>}
 */
export async function getLiveActionModes(prisma, { merchantId }) {
  const live = listActionTypes().filter((t) => t.live);
  const entries = await Promise.all(
    live.map(
      async (t) =>
        /** @type {[string, string]} */ ([
          t.actionType,
          await getActionMode(prisma, { merchantId, actionType: t.actionType }),
        ]),
    ),
  );
  return Object.fromEntries(entries);
}
