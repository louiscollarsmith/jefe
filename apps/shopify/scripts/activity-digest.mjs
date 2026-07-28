#!/usr/bin/env node
// Jefe activity digest — a compact "what's been going on" feed, posted to the
// ops Slack channel. Reuses the alerting webhook rail (push, not a dashboard).
//
//   cd apps/shopify
//   npm run activity-digest -- --sample            # no DB: print a demo digest
//   npm run activity-digest -- --dry-run           # fetch real data, print (don't post)
//   npm run activity-digest -- --hours=24          # window (default 24)
//   ACTIVITY_WEBHOOK_URL=… npm run activity-digest  # fetch + post to Slack
//
// Slack webhook: ACTIVITY_WEBHOOK_URL, falling back to ALERT_WEBHOOK_URL.
// Database: DATABASE_URL, falling back to DATABASE_PUBLIC_URL. Point it at prod
// (public proxy URL) to digest real activity.

import { PrismaClient } from "@prisma/client";
import {
  buildActivityFeed,
  formatActivityDigest,
} from "../app/services/analytics/activity-feed.server.js";

const args = process.argv.slice(2);
const sample = args.includes("--sample");
const dryRun = args.includes("--dry-run") || sample;
const hoursArg = args.find((a) => a.startsWith("--hours="));
const parsedHours = hoursArg ? Number.parseInt(hoursArg.split("=")[1], 10) : NaN;
const windowHours = Number.isInteger(parsedHours) && parsedHours > 0 ? parsedHours : 24;

const CONNECTED_CHANNEL = (status) =>
  !["not_connected", "disconnected", "revoked", "error", "failed"].includes(status);

const RUN_SOURCES = [
  { model: "merchantMemoryRefreshRun", ok: "memory_rebuilt", feature: "memory" },
  { model: "merchantInsightRun", ok: "insights_generated", feature: "insights" },
  { model: "merchantGoalRun", ok: "goals_generated", feature: "goals" },
  { model: "merchantPlanRun", ok: "plan_generated", feature: "plan" },
];

function sampleEvents(now) {
  const at = (minsAgo) => new Date(now.getTime() - minsAgo * 60000).toISOString();
  return [
    { ts: at(12), type: "shop_installed", shopDomain: "jaspers-market.myshopify.com" },
    { ts: at(28), type: "channel_connected", shopDomain: "jaspers-market.myshopify.com", detail: "slack" },
    { ts: at(41), type: "memory_rebuilt", shopDomain: "northwind.myshopify.com" },
    { ts: at(55), type: "insights_generated", shopDomain: "northwind.myshopify.com" },
    { ts: at(63), type: "generation_failed", shopDomain: "acme.myshopify.com", detail: "plan" },
    { ts: at(90), type: "plan_generated", shopDomain: "maya-cosmetics.myshopify.com" },
    { ts: at(140), type: "onboarding_completed", shopDomain: "jaspers-market.myshopify.com" },
    { ts: at(300), type: "memory_rebuilt", shopDomain: "acme.myshopify.com" },
  ];
}

async function fetchEvents(prisma, now, cutoff) {
  const events = [];
  const push = (ts, type, shopDomain, detail) => {
    if (ts && shopDomain) events.push({ ts: new Date(ts).toISOString(), type, shopDomain, detail });
  };

  // Shops carry install / onboarding / backfill milestones directly.
  const shops = await prisma.shop.findMany({
    select: {
      id: true,
      shopDomain: true,
      createdAt: true,
      onboardingCompletedAt: true,
      backfillCompletedAt: true,
    },
  });
  const domainById = new Map(shops.map((s) => [s.id, s.shopDomain]));
  for (const s of shops) {
    if (s.createdAt >= cutoff) push(s.createdAt, "shop_installed", s.shopDomain);
    if (s.onboardingCompletedAt && s.onboardingCompletedAt >= cutoff)
      push(s.onboardingCompletedAt, "onboarding_completed", s.shopDomain);
    if (s.backfillCompletedAt && s.backfillCompletedAt >= cutoff)
      push(s.backfillCompletedAt, "backfill_completed", s.shopDomain);
  }

  // Generation/memory runs: classify by status; use updatedAt as the event time
  // (always set, unlike completedAt on failures).
  for (const src of RUN_SOURCES) {
    try {
      const rows = await prisma[src.model].findMany({
        where: { updatedAt: { gte: cutoff } },
        select: { shopId: true, status: true, completedAt: true, updatedAt: true },
      });
      for (const r of rows) {
        const domain = domainById.get(r.shopId);
        if (!domain) continue;
        const ts = r.completedAt ?? r.updatedAt;
        if (r.status === "failed") push(r.updatedAt, "generation_failed", domain, src.feature);
        else if (["complete", "completed", "succeeded"].includes(r.status))
          push(ts, src.ok, domain);
      }
    } catch (error) {
      console.error(`(skipped ${src.model}: ${error?.message ?? error})`);
    }
  }

  // Channel connections.
  try {
    const channels = await prisma.channelConnection.findMany({
      where: { updatedAt: { gte: cutoff } },
      select: { shopId: true, status: true, updatedAt: true },
    });
    for (const c of channels) {
      const domain = c.shopId ? domainById.get(c.shopId) : null;
      if (domain && CONNECTED_CHANNEL(c.status)) push(c.updatedAt, "channel_connected", domain, c.status);
    }
  } catch (error) {
    console.error(`(skipped channelConnection: ${error?.message ?? error})`);
  }

  return events;
}

async function postToSlack(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook returned HTTP ${res.status}`);
}

async function main() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  let events;
  let prisma;
  if (sample) {
    events = sampleEvents(now);
  } else {
    const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
    if (!databaseUrl) {
      console.error("activity-digest: set DATABASE_URL (or DATABASE_PUBLIC_URL), or use --sample.");
      process.exit(1);
    }
    prisma = new PrismaClient(
      process.env.DATABASE_URL ? {} : { datasources: { db: { url: databaseUrl } } },
    );
    events = await fetchEvents(prisma, now, cutoff);
  }

  const feed = buildActivityFeed(events, { now, windowHours });
  const text =
    (sample ? "🧪 *(sample data — demo of the activity digest format)*\n" : "") +
    formatActivityDigest(feed);

  if (prisma) await prisma.$disconnect();

  const webhookUrl = process.env.ACTIVITY_WEBHOOK_URL || process.env.ALERT_WEBHOOK_URL;
  if (dryRun || !webhookUrl) {
    console.log(text);
    if (!dryRun && !webhookUrl) {
      console.error("\n(no ACTIVITY_WEBHOOK_URL/ALERT_WEBHOOK_URL set — printed instead of posting)");
    }
    return;
  }

  await postToSlack(webhookUrl, text);
  console.log(`Posted activity digest (${feed.totalEvents} events, ${feed.activeShops} shops) to Slack.`);
}

main().catch((error) => {
  console.error("activity-digest failed:", error?.message ?? error);
  process.exit(1);
});
