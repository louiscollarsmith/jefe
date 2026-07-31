// @ts-check

// Phase 2: the scheduled morning-brief sender — a worker step that, per merchant
// LOCAL send time, assembles the brief from REAL app-home data and sends it via the
// shared sendEmail adapter. This is the highest-consequence email path (scheduled
// bulk outbound to real merchants), so it is DARK by default and tightly guarded:
//
//   - Gated on BOTH ENABLE_MORNING_BRIEF and ENABLE_EMAIL (so it never claims a
//     day-key when sending is off — flipping ENABLE_EMAIL on later still sends today).
//   - resolveDelivery() decides whether/where (honors the enabled pref, a known
//     contact email, and the hard EmailPreference unsubscribe).
//   - isBriefDue() + a DURABLE per-(shop,category) day-key claim (NotificationScheduleState)
//     guarantee at-most-once per merchant-local day, across restarts/deploys.
//   - Bounded batch per tick (blast-radius cap); self-catching (never trips the loop).
//   - Reply-To routes brief replies to a real inbox (#15's constraint): the human
//     reply-to while inbound is dark, the Door-A AI address once ENABLE_INBOUND_EMAIL.
//
// The LLM never sends; this deterministic adapter does, only under the flags above.
// Brief COPY/template is chat 2's comms lane (see email/morning-brief.server.js v1).

import { isEmailEnabled, sendEmail } from "../email/resend.server.js";
import { renderMorningBriefEmail } from "../email/morning-brief.server.js";
import { DEFAULT_APP_URL, deriveStoreName } from "../email/welcome.server.js";
import { hashRecipient, signUnsubscribeToken } from "../email/unsubscribe.server.js";
import { getActiveSuggestedAction } from "../actions/action-resolution.server.js";
import { getNotificationPreference, resolveDelivery } from "./service.server.js";
import { isBriefDue, localClockFor } from "./schedule.server.js";
import { track } from "../../services/analytics/event-log.server.js";
import { logger as baseLogger } from "../observability/logger.server.js";

const log = baseLogger.child({ component: "notifications" });

const CATEGORY = "morning_brief";
/** Bound the outbound blast radius per tick (mirrors the win-back CAMPAIGN_BATCH). */
const BRIEF_BATCH = 100;

/** ENABLE_MORNING_BRIEF must be exactly "true"; dark otherwise. @returns {boolean} */
export function isMorningBriefEnabled() {
  return String(process.env.ENABLE_MORNING_BRIEF ?? "").trim().toLowerCase() === "true";
}

/**
 * Reply-To for a brief (#15's constraint): the Door-A AI address ONLY once inbound
 * is live (so replies aren't pointed at a Resend-inbound address before its MX
 * exists), otherwise the human reply-to inbox. Pure over an env object → testable.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function resolveBriefReplyTo(env = process.env) {
  const inboundLive = String(env.ENABLE_INBOUND_EMAIL ?? "").trim().toLowerCase() === "true";
  const human = env.RESEND_REPLY_TO || "";
  if (inboundLive && env.INBOUND_AI_ADDRESS) return env.INBOUND_AI_ADDRESS;
  return human || undefined;
}

/** The labelled human door for the footer. */
function humanDoorAddress() {
  return process.env.EMAIL_TEAM_ADDRESS || process.env.RESEND_REPLY_TO || "hola@mynamejefe.com";
}

/** Pull the bits we need from a shop's stored Shopify metadata. @param {unknown} rawPayload */
function shopifyMeta(rawPayload) {
  const shopify =
    rawPayload && typeof rawPayload === "object"
      ? /** @type {any} */ (rawPayload).shopify
      : null;
  const meta = shopify && typeof shopify === "object" ? shopify : {};
  return {
    timezone: typeof meta.ianaTimezone === "string" ? meta.ianaTimezone : undefined,
    storeName: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : null,
    currency: typeof meta.currencyCode === "string" && meta.currencyCode ? meta.currencyCode : "GBP",
  };
}

/**
 * Send the morning brief to every merchant whose local send time has arrived today
 * and hasn't already received it. DARK unless ENABLE_MORNING_BRIEF && ENABLE_EMAIL.
 * Self-catching: never throws into the worker tick.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; now?: Date }} [options]
 * @returns {Promise<{ skipped?: string; sent: number; considered: number }>}
 */
export async function maybeSendMorningBriefs(prisma, options = {}) {
  const logger = options.logger ?? log;
  // Both flags required — so we never claim a day-key while sending is a no-op.
  if (!isMorningBriefEnabled() || !isEmailEnabled()) {
    return { skipped: "disabled", sent: 0, considered: 0 };
  }
  const now = options.now ?? new Date();
  const replyTo = resolveBriefReplyTo();
  const humanEmail = humanDoorAddress();
  const appUrl = process.env.EMAIL_APP_URL || DEFAULT_APP_URL;

  let sent = 0;
  let considered = 0;
  try {
    const shops = await prisma.shop.findMany({
      where: {
        onboardingCompletedAt: { not: null },
        uninstalledAt: null,
        contactEmail: { not: null },
      },
      select: { id: true, merchantId: true, shopDomain: true, rawPayload: true },
      take: BRIEF_BATCH,
    });

    for (const shop of shops) {
      considered += 1;
      try {
        const meta = shopifyMeta(shop.rawPayload);
        const pref = await getNotificationPreference(prisma, {
          merchantId: shop.merchantId,
          category: CATEGORY,
        });
        if (!pref || !pref.enabled || !pref.schedule) continue;

        const state = await prisma.notificationScheduleState.findUnique({
          where: { shopId_category: { shopId: shop.id, category: CATEGORY } },
        });
        if (!isBriefDue({ schedule: pref.schedule, lastFiredLocalDay: state?.lastFiredLocalDay ?? null }, now, meta.timezone)) {
          continue;
        }

        // Confirm we can actually deliver (enabled × email address × not unsubscribed)
        // BEFORE claiming the day, so a non-deliverable shop retries next tick.
        const delivery = await resolveDelivery(prisma, {
          merchantId: shop.merchantId,
          shopId: shop.id,
          category: CATEGORY,
        });
        const email = delivery.channels.find((channel) => channel.channel === "email");
        if (!delivery.deliver || !email?.destination) {
          logger.info?.("morning brief not deliverable; skipping", {
            shopId: shop.id,
            suppressed: delivery.suppressed,
          });
          continue;
        }

        // Durable at-most-once-per-local-day claim (compare-and-set on the prior value,
        // which handles first-ever null + concurrent ticks). Only the winner sends.
        const { localDay } = localClockFor(now, meta.timezone);
        if (state?.lastFiredLocalDay === localDay) continue;
        const claimed = await claimDay(prisma, {
          merchantId: shop.merchantId,
          shopId: shop.id,
          previous: state?.lastFiredLocalDay ?? null,
          localDay,
          hasRow: Boolean(state),
        });
        if (!claimed) continue;

        const suggested = await getActiveSuggestedAction(prisma, {
          merchantId: shop.merchantId,
          shopId: shop.id,
          currency: meta.currency,
        });
        const storeName = meta.storeName || deriveStoreName(shop.shopDomain);
        const metricLine = await buildMetricLine(prisma, {
          merchantId: shop.merchantId,
          shopId: shop.id,
          currency: meta.currency,
          now,
        });
        const unsubscribeUrl = `${appUrl.replace(/\/+$/, "")}/e/unsubscribe?t=${signUnsubscribeToken({
          shopDomain: shop.shopDomain,
          emailHash: hashRecipient(email.destination) ?? "",
        })}`;

        const brief = renderMorningBriefEmail({
          storeName,
          merchantName: null, // no reliable first name yet — honest, no fabricated greeting
          move: suggested?.headline ? { headline: suggested.headline, why: suggested.note ?? null } : null,
          metricLine, // real 30-day orders/revenue, or null when there's nothing to say
          appUrl: `${appUrl.replace(/\/+$/, "")}/?shop=${encodeURIComponent(shop.shopDomain)}`,
          unsubscribeUrl,
          humanEmail,
        });

        const result = await sendEmail({
          to: email.destination,
          subject: brief.subject,
          html: brief.html,
          text: brief.text,
          headers: brief.headers,
          replyTo,
        });
        if (result.delivered) sent += 1;

        // PII-free health signal — never the address, only outcome flags.
        void track(prisma, {
          type: "notification_sent",
          topic: "notifications",
          shopId: shop.id,
          merchantId: shop.merchantId,
          properties: { category: CATEGORY, channel: "email", delivered: result.delivered, disabled: result.disabled },
        });
      } catch (error) {
        logger.warn?.("morning brief send failed for shop; continuing", {
          shopId: shop.id,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (sent > 0) logger.info?.("morning briefs sent", { sent, considered });
    return { sent, considered };
  } catch (error) {
    logger.warn?.("morning brief batch failed; loop continues", {
      err: error instanceof Error ? error.message : String(error),
    });
    return { skipped: "error", sent, considered };
  }
}

/**
 * Compare-and-set the day-key. Returns true iff THIS call claimed today. Handles
 * first-ever (create, unique-violation-safe) and subsequent (CAS on the prior value,
 * which is null-safe in Prisma equality).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; previous: string | null; localDay: string; hasRow: boolean }} input
 * @returns {Promise<boolean>}
 */
async function claimDay(prisma, input) {
  if (input.hasRow) {
    const claim = await prisma.notificationScheduleState.updateMany({
      where: { shopId: input.shopId, category: CATEGORY, lastFiredLocalDay: input.previous },
      data: { lastFiredLocalDay: input.localDay },
    });
    return claim.count > 0;
  }
  try {
    await prisma.notificationScheduleState.create({
      data: {
        merchantId: input.merchantId,
        shopId: input.shopId,
        category: CATEGORY,
        lastFiredLocalDay: input.localDay,
      },
    });
    return true;
  } catch {
    // Unique violation — another tick created the row first; it owns today.
    return false;
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Real 30-day orders + revenue as a compact "where things stand" line, or null
 * when there's nothing honest to say (no orders in the window). One indexed
 * aggregate — Order has a [merchant_id, processed_at] index — on the same
 * processedAt/totalPrice basis the app home uses, so the figures are consistent.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; currency: string; now: Date }} input
 * @returns {Promise<string | null>}
 */
async function buildMetricLine(prisma, input) {
  const since = new Date(input.now.getTime() - THIRTY_DAYS_MS);
  const agg = await prisma.order.aggregate({
    where: { merchantId: input.merchantId, shopId: input.shopId, processedAt: { gte: since } },
    _count: { _all: true },
    _sum: { totalPrice: true },
  });
  const orders = agg._count?._all ?? 0;
  const revenue = agg._sum?.totalPrice != null ? Number(agg._sum.totalPrice) : null;
  return formatMetricLine({ orders, revenue, currency: input.currency });
}

/**
 * Shape the metric line. Pure. Null when there are no orders (nothing honest to
 * say); omits revenue when it's absent or zero. Never fabricates a figure.
 * @param {{ orders: number; revenue: number | null; currency: string }} input
 * @returns {string | null}
 */
export function formatMetricLine(input) {
  const orders = Number(input.orders);
  if (!Number.isFinite(orders) || orders <= 0) return null;
  const orderText = `${orders.toLocaleString("en-GB")} ${orders === 1 ? "order" : "orders"}`;
  const revenue = input.revenue;
  if (revenue != null && Number.isFinite(Number(revenue)) && Number(revenue) > 0) {
    return `${orderText} and ${formatBriefMoney(Number(revenue), input.currency)} in the last 30 days`;
  }
  return `${orderText} in the last 30 days`;
}

/** @param {number} amount @param {string} currency */
function formatBriefMoney(amount, currency) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString("en-GB")} ${currency}`;
  }
}
