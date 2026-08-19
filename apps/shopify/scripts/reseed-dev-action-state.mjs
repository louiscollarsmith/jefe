#!/usr/bin/env node
/**
 * Dev helper: reconcile workflow state for active merchant actions.
 *
 * Usage:
 *   node scripts/reseed-dev-action-state.mjs [--merchant-id=...] [--shop-id=...]
 *
 * Heals inconsistent step statuses and refreshes derived work projection so
 * local dev matches what resolveActionState() expects after fixture changes.
 */

import { PrismaClient } from "@prisma/client";
import { loadLocalEnv } from "./load-env.mjs";
import { healInconsistentWorkflow } from "../app/lib/actions/action-step-lifecycle.server.js";
import { resolveActionState } from "../app/lib/actions/action-state.server.js";

loadLocalEnv();

const prisma = new PrismaClient();
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [[match[1], match[2] ?? "true"]] : [];
  }),
);

const merchantId = args["merchant-id"] ?? process.env.RESEED_MERCHANT_ID ?? null;
const shopId = args["shop-id"] ?? process.env.RESEED_SHOP_ID ?? null;

if (!merchantId || !shopId) {
  console.error(
    "Usage: node scripts/reseed-dev-action-state.mjs --merchant-id=<id> --shop-id=<id>",
  );
  process.exit(1);
}

const actions = await prisma.merchantAction.findMany({
  where: {
    merchantId,
    shopId,
    status: { in: ["proposed", "accepted", "in_progress", "needs_attention"] },
  },
  select: { id: true, title: true, status: true },
  orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  take: 40,
});

/** @type {Array<{ id: string; title: string | null; healed: boolean; work: string | null }>} */
const results = [];

for (const action of actions) {
  const healed = await healInconsistentWorkflow(prisma, {
    merchantId,
    shopId,
    actionId: action.id,
    logger: console,
  });
  const state = await resolveActionState(prisma, {
    merchantId,
    shopId,
    actionId: action.id,
  });
  results.push({
    id: action.id,
    title: action.title,
    healed: healed.healed === true,
    work: state?.nextUsefulWork?.step?.title ?? null,
  });
}

console.log(`Reconciled ${results.length} action(s) for ${merchantId} / ${shopId}`);
for (const row of results) {
  console.log(
    `- ${row.id} "${row.title ?? "untitled"}" healed=${row.healed} next=${row.work ?? "none"}`,
  );
}

await prisma.$disconnect();
