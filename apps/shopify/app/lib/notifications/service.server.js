// @ts-check

// Notification preferences storage + resolution — the "how policy is used" layer
// over the registry. Mirrors action-autonomy-policy.server.js: one row per
// (merchant, category); an absent row (or an unset field) means "use the registry
// default"; every stored value is normalized on read so a bad value is never
// trusted. This composes with — never duplicates — Channels (the "where") and
// EmailPreference (the hard email opt-out).
//
// Nothing here sends. resolveDelivery() is the single read-only seam a (Phase 2)
// typed sender calls to learn WHETHER + WHERE to deliver; the LLM never calls it.

import {
  NOTIFICATION_CHANNEL_KEYS,
  SCHEDULE_FREQUENCIES,
  getNotificationCategory,
  listNotificationCategories,
} from "./registry.server.js";
import { getShopContactEmail } from "./contact-email.server.js";
import { listChannelConnections } from "../channels/service.server.js";
import { isEmailUnsubscribed, hashRecipient } from "../email/unsubscribe.server.js";

/** Providers that are real ChannelConnection destinations (email is resolved separately). */
const CONNECTION_CHANNELS = /** @type {const} */ (["slack", "whatsapp"]);

// ── normalizers (drop-unknown discipline, like normalizeAutonomyPolicy) ───────────

/**
 * Keep only known channel keys, canonical order, de-duped. Returns null when the
 * input is not an array (→ "unset", use the default); returns [] when the array
 * carries no known key (→ explicitly muted).
 * @param {unknown} raw
 * @returns {Array<"email"|"slack"|"whatsapp"> | null}
 */
export function normalizeChannels(raw) {
  if (!Array.isArray(raw)) return null;
  const present = new Set(raw);
  return NOTIFICATION_CHANNEL_KEYS.filter((key) => present.has(key));
}

/**
 * Normalize a schedule to a trusted {frequency,hour,minute,timezone?} or null.
 * Any out-of-range / unknown value collapses the whole schedule to null (→ default).
 * @param {unknown} raw
 * @returns {{ frequency: "daily"|"weekdays"|"off"; hour: number; minute: number; timezone?: string } | null}
 */
export function normalizeSchedule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = /** @type {Record<string, unknown>} */ (raw);
  const frequency = value.frequency;
  if (!SCHEDULE_FREQUENCIES.includes(/** @type {any} */ (frequency))) return null;
  const hour = Number(value.hour);
  const minute = Number(value.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  /** @type {{ frequency: any; hour: number; minute: number; timezone?: string }} */
  const out = { frequency, hour, minute };
  if (typeof value.timezone === "string" && value.timezone.trim()) {
    out.timezone = value.timezone.trim();
  }
  return out;
}

/**
 * Compact, display-ready send-time label for a schedule, e.g. "7:30am". Null when
 * there is no active time (no schedule, or frequency "off"). Pure — the Settings
 * email row renders exactly this, so it never shows a fabricated time.
 * @param {{ frequency?: string; hour?: number; minute?: number } | null | undefined} schedule
 * @returns {string | null}
 */
export function formatBriefSendTime(schedule) {
  if (!schedule || schedule.frequency === "off") return null;
  const hour = Number(schedule.hour);
  const minute = Number(schedule.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const period = hour < 12 ? "am" : "pm";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")}${period}`;
}

/**
 * The effective preference for a category = registry default overlaid with the
 * merchant's stored overrides. Pure. @param {import("./registry.server.js").NotificationCategory} definition @param {any} row
 */
function mergeEffective(definition, row) {
  const storedChannels = row ? normalizeChannels(row.channels) : null;
  const storedSchedule =
    definition.schedulable && row ? normalizeSchedule(row.schedule) : null;
  return {
    category: definition.key,
    label: definition.label,
    description: definition.description,
    schedulable: definition.schedulable,
    enabled:
      row && typeof row.enabled === "boolean" ? row.enabled : definition.defaultEnabled,
    channels: storedChannels ?? [...definition.defaultChannels],
    schedule: definition.schedulable
      ? storedSchedule ??
        (definition.defaultSchedule ? { ...definition.defaultSchedule } : null)
      : null,
  };
}

/** @typedef {ReturnType<typeof mergeEffective>} EffectiveNotificationPreference */

// ── reads ─────────────────────────────────────────────────────────────────────

/**
 * Read one category's effective preference (registry default + stored overrides).
 * Returns null only for an unknown category.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; category: string }} input
 * @returns {Promise<EffectiveNotificationPreference | null>}
 */
export async function getNotificationPreference(prisma, input) {
  const definition = getNotificationCategory(input.category);
  if (!definition) return null;
  const row = await prisma.notificationPreference.findUnique({
    where: {
      merchantId_category: { merchantId: input.merchantId, category: input.category },
    },
  });
  return mergeEffective(definition, row);
}

/**
 * The full roster (every registry category, merged with any stored overrides) —
 * what the Settings surface renders. One query, merged in code.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string }} input
 * @returns {Promise<EffectiveNotificationPreference[]>}
 */
export async function listNotificationPreferences(prisma, input) {
  const rows = await prisma.notificationPreference.findMany({
    where: { merchantId: input.merchantId },
  });
  const byCategory = new Map(rows.map((row) => [row.category, row]));
  return listNotificationCategories().map((definition) =>
    mergeEffective(definition, byCategory.get(definition.key) ?? null),
  );
}

// ── writes ──────────────────────────────────────────────────────────────────────

/**
 * Upsert a merchant's preference for a category. Only known fields are stored, each
 * normalized (an unknown category is refused; a bad channel/schedule value is dropped),
 * so a reader can always trust storage. A patch field set to null resets it to the
 * registry default.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; category: string; patch: { enabled?: boolean | null; channels?: unknown; schedule?: unknown } }} input
 * @returns {Promise<{ status: "ok" | "invalid_category"; category: string }>}
 */
export async function setNotificationPreference(prisma, input) {
  const definition = getNotificationCategory(input.category);
  if (!definition) return { status: "invalid_category", category: input.category };

  const patch = input.patch ?? {};
  /** @type {{ enabled?: boolean | null; channels?: any; schedule?: any }} */
  const data = {};
  if ("enabled" in patch) {
    data.enabled = patch.enabled == null ? null : Boolean(patch.enabled);
  }
  if ("channels" in patch) {
    data.channels = normalizeChannels(patch.channels); // null → reset to default
  }
  if ("schedule" in patch) {
    // A schedule is meaningless on a non-schedulable category — always null there.
    data.schedule = definition.schedulable ? normalizeSchedule(patch.schedule) : null;
  }

  await prisma.notificationPreference.upsert({
    where: {
      merchantId_category: { merchantId: input.merchantId, category: input.category },
    },
    create: { merchantId: input.merchantId, category: input.category, ...data },
    update: data,
  });
  return { status: "ok", category: input.category };
}

// ── resolution (the sender seam) ──────────────────────────────────────────────────

/**
 * Compose a category's effective preference with what can ACTUALLY be delivered
 * right now: connected slack/whatsapp destinations, and a known, non-unsubscribed
 * email address. Read-only; the single seam a (Phase 2) typed sender consults —
 * the LLM never calls this. Returns the resolved channels plus PII-free reasons
 * anything was suppressed (for honest surfacing / logging — the address itself is
 * only ever in `destination`, never a reason string).
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; category: string }} input
 * @returns {Promise<{ deliver: boolean; channels: Array<{ channel: string; destination: string | null }>; suppressed: string[] }>}
 */
export async function resolveDelivery(prisma, input) {
  const pref = await getNotificationPreference(prisma, input);
  if (!pref) return { deliver: false, channels: [], suppressed: ["unknown_category"] };
  if (!pref.enabled) return { deliver: false, channels: [], suppressed: ["disabled"] };

  const wanted = new Set(pref.channels);
  /** @type {Array<{ channel: string; destination: string | null }>} */
  const channels = [];
  /** @type {string[]} */
  const suppressed = [];

  if (CONNECTION_CHANNELS.some((provider) => wanted.has(provider))) {
    const connections = await listChannelConnections(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
    });
    for (const provider of CONNECTION_CHANNELS) {
      if (!wanted.has(provider)) continue;
      const connection = connections.find((row) => row.provider === provider);
      if (connection && connection.connected) {
        channels.push({
          channel: provider,
          destination: connection.maskedDestination ?? connection.accountName ?? null,
        });
      } else {
        suppressed.push(`${provider}_not_connected`);
      }
    }
  }

  if (wanted.has("email")) {
    const address = await getShopContactEmail(prisma, { shopId: input.shopId });
    if (!address) {
      suppressed.push("email_no_address");
    } else if (
      await isEmailUnsubscribed(prisma, {
        shopId: input.shopId,
        emailHash: hashRecipient(address),
      })
    ) {
      suppressed.push("email_unsubscribed");
    } else {
      channels.push({ channel: "email", destination: address });
    }
  }

  return { deliver: channels.length > 0, channels, suppressed };
}
