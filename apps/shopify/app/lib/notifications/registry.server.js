// @ts-check

// The notification-category registry — the deterministic source of truth for the
// notification/communication TYPES Jefe can send a merchant. It mirrors the
// conversational-belief and action-type registries: a merchant's stored
// NotificationPreference row carries ONLY explicit overrides, and everything
// unset falls back to the defaults declared here. So the registry alone defines
// the full roster the Settings surface renders and the (Phase 2) senders resolve.
//
// This layer is preference/shape only. It performs no sends and knows nothing
// about delivery mechanics — resolveDelivery() in service.server.js composes
// these defaults with the merchant's connected channels + email opt-out, and a
// typed sender (never the LLM) performs the actual send.

/**
 * Delivery channel keys a notification can target. "email" is first-class here
 * (resolved via the shop contact email + EmailPreference opt-out) even though it
 * is not a ChannelConnection provider the way slack/whatsapp are.
 */
export const NOTIFICATION_CHANNEL_KEYS = /** @type {const} */ ([
  "email",
  "slack",
  "whatsapp",
]);

/** Allowed schedule frequencies for schedulable categories. */
export const SCHEDULE_FREQUENCIES = /** @type {const} */ (["daily", "weekdays", "off"]);

/**
 * @typedef {Object} NotificationSchedule
 * @property {"daily"|"weekdays"|"off"} frequency
 * @property {number} hour   0-23, merchant-local
 * @property {number} minute 0-59
 * @property {string} [timezone] IANA tz; when omitted a sender uses the shop's ianaTimezone
 */

/**
 * @typedef {Object} NotificationCategory
 * @property {string} key
 * @property {string} label
 * @property {string} description
 * @property {boolean} schedulable   whether a send time applies (vs event-driven)
 * @property {boolean} defaultEnabled
 * @property {ReadonlyArray<"email"|"slack"|"whatsapp">} defaultChannels
 * @property {NotificationSchedule | null} defaultSchedule
 */

const CATEGORIES = /** @type {ReadonlyArray<NotificationCategory>} */ (Object.freeze([
  Object.freeze({
    key: "morning_brief",
    label: "Morning brief",
    description: "What Jefe would do today, and why — a short daily read.",
    schedulable: true,
    defaultEnabled: true,
    defaultChannels: Object.freeze(["email"]),
    // 7:30 mirrors the value the welcome email has always promised — but now it
    // is a real, stored, changeable preference rather than hardcoded copy.
    defaultSchedule: Object.freeze({ frequency: "daily", hour: 7, minute: 30 }),
  }),
  Object.freeze({
    key: "tidy_up",
    label: "Tidy-up list",
    description: "Store fixes worth a few minutes — broken links, stale stock, unclaimed refunds.",
    schedulable: false,
    defaultEnabled: true,
    defaultChannels: Object.freeze(["email"]),
    defaultSchedule: null,
  }),
  Object.freeze({
    key: "action_needs_approval",
    label: "Actions that need you",
    description: "When Jefe has a move ready and is waiting on your approval.",
    schedulable: false,
    defaultEnabled: true,
    defaultChannels: Object.freeze(["slack", "whatsapp", "email"]),
    defaultSchedule: null,
  }),
  Object.freeze({
    key: "action_done",
    label: "What Jefe did",
    description: "A note after Jefe completes an approved or autonomous action.",
    schedulable: false,
    defaultEnabled: true,
    defaultChannels: Object.freeze(["email"]),
    defaultSchedule: null,
  }),
  Object.freeze({
    key: "product_updates",
    label: "New in Jefe",
    description: "Occasional notes when something new ships.",
    schedulable: false,
    defaultEnabled: true,
    defaultChannels: Object.freeze(["email"]),
    defaultSchedule: null,
  }),
]));

/** @type {ReadonlyMap<string, NotificationCategory>} */
const BY_KEY = new Map(CATEGORIES.map((category) => [category.key, category]));

/** All notification categories, in display order. @returns {ReadonlyArray<NotificationCategory>} */
export function listNotificationCategories() {
  return CATEGORIES;
}

/** Look up a category definition by key, or null if unknown. @param {string} key */
export function getNotificationCategory(key) {
  return BY_KEY.get(key) ?? null;
}

/** @param {string} key */
export function isNotificationCategory(key) {
  return typeof key === "string" && BY_KEY.has(key);
}

/** @param {string} channel */
export function isNotificationChannel(channel) {
  return NOTIFICATION_CHANNEL_KEYS.includes(/** @type {any} */ (channel));
}

export { CATEGORIES as NOTIFICATION_CATEGORIES };
