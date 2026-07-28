#!/usr/bin/env node
// Usage analytics report (internal/developer-facing).
//
// Prints a read-only snapshot of how clients are using Jefe — onboarding funnel,
// engagement, generation health and the job queue — computed from existing
// tables. No new instrumentation; pure metric logic lives in
// app/services/analytics/usage-report.server.js (unit-tested).
//
//   cd apps/shopify
//   npm run analytics                 # formatted report against DATABASE_URL
//   npm run analytics -- --json       # machine-readable JSON
//   npm run analytics -- --days=30    # active-window size (default 7)
//
// Point DATABASE_URL (or DATABASE_PUBLIC_URL) at the environment you want to
// read. For prod, use the public proxy URL, not the internal host.

import { PrismaClient } from "@prisma/client";
import {
  buildUsageReport,
  formatUsageReport,
} from "../app/services/analytics/usage-report.server.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: npm run analytics -- [--json] [--days=N]",
      "",
      "  --json     Emit the report as JSON instead of formatted text.",
      "  --days=N   Active-window size in days (default 7).",
      "",
      "Reads DATABASE_URL (falls back to DATABASE_PUBLIC_URL).",
    ].join("\n"),
  );
  process.exit(0);
}

const asJson = args.includes("--json");
const daysArg = args.find((a) => a.startsWith("--days="));
const parsedDays = daysArg ? Number.parseInt(daysArg.split("=")[1], 10) : NaN;
const windowDays = Number.isInteger(parsedDays) && parsedDays > 0 ? parsedDays : 7;

const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!databaseUrl) {
  console.error(
    "analytics-report: no database URL. Set DATABASE_URL (or DATABASE_PUBLIC_URL).",
  );
  process.exit(1);
}

const prisma = new PrismaClient(
  process.env.DATABASE_URL ? {} : { datasources: { db: { url: databaseUrl } } },
);

/**
 * Count rows grouped by a status-like field, returned as { value: count }.
 */
async function groupCount(delegate, field) {
  const rows = await delegate.groupBy({ by: [field], _count: { _all: true } });
  const out = {};
  for (const row of rows) {
    out[String(row[field] ?? "unknown")] = row._count._all;
  }
  return out;
}

async function main() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const merchants = await prisma.merchant.count();
  const shopsTotal = await prisma.shop.count();
  const setupStatus = await groupCount(prisma.shop, "setupStatus");
  const backfillStarted = await prisma.shop.count({
    where: { backfillStartedAt: { not: null } },
  });
  const backfillCompleted = await prisma.shop.count({
    where: { backfillCompletedAt: { not: null } },
  });
  const onboardingCompleted = await prisma.shop.count({
    where: { onboardingCompletedAt: { not: null } },
  });
  const installedInWindow = await prisma.shop.count({
    where: { createdAt: { gte: windowStart } },
  });

  const channels = await groupCount(prisma.channelConnection, "status");
  const totalBeliefs = await prisma.merchantMemoryBelief.count();
  const memoryMerchants = await prisma.merchantMemoryBelief.groupBy({
    by: ["merchantId"],
    _count: { _all: true },
  });

  const insights = await groupCount(prisma.merchantInsightRun, "status");
  const goals = await groupCount(prisma.merchantGoalRun, "status");
  const plan = await groupCount(prisma.merchantPlanRun, "status");
  const jobs = await groupCount(prisma.backfillJob, "status");

  const activeShops = await prisma.ledgerEvent.groupBy({
    by: ["shopId"],
    where: { eventTs: { gte: windowStart } },
    _count: { _all: true },
  });

  const report = buildUsageReport({
    generatedAt: now.toISOString(),
    windowDays,
    merchants,
    shops: {
      total: shopsTotal,
      setupStatus,
      backfillStarted,
      backfillCompleted,
      onboardingCompleted,
      installedInWindow,
    },
    channels,
    memory: {
      totalBeliefs,
      merchantsWithBeliefs: memoryMerchants.length,
    },
    generation: { insights, goals, plan },
    jobs,
    activity: { activeInWindow: activeShops.length },
  });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatUsageReport(report));
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error("analytics-report failed:", error?.message ?? error);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
