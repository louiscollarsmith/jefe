// @ts-check

// Pure timezone-aware scheduling for time-based notifications (the morning brief).
// No I/O, no Date.now() — `now` is always passed in, so this is fully unit-testable
// at a fixed instant across timezones (mirrors the winback dueCampaignStep pattern).
// Nothing here sends; the worker consults isBriefDue() then claims the day-key.

/**
 * The merchant-local wall clock for an instant, via Intl (no external dep).
 * Returns the local calendar day (YYYY-MM-DD), hour (0-23), minute, and short
 * weekday ("Mon".."Sun"). Falls back to UTC if the timezone is invalid.
 * @param {Date} now
 * @param {string} [timezone] IANA tz
 * @returns {{ localDay: string; hour: number; minute: number; weekday: string }}
 */
export function localClockFor(now, timezone) {
  let parts;
  try {
    parts = partsFor(now, timezone || "UTC");
  } catch {
    parts = partsFor(now, "UTC");
  }
  return {
    localDay: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

/**
 * @param {Date} now @param {string} timezone
 * @returns {{ year: string; month: string; day: string; hour: string; minute: string; weekday: string }}
 */
function partsFor(now, timezone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  /** @type {any} */
  const out = {};
  for (const part of fmt.formatToParts(now)) out[part.type] = part.value;
  return out;
}

/**
 * Whether a schedulable notification is due to fire NOW for a shop:
 *   - not "off";
 *   - on a weekday if frequency is "weekdays";
 *   - hasn't already fired on today's merchant-local day (the durable guard);
 *   - the merchant-local time has reached the scheduled hour:minute.
 * Pure — the caller passes `now` + the shop's timezone. A schedule may carry its
 * own timezone; otherwise the shop's is used. Bad/incomplete input → not due.
 * @param {{ schedule?: { frequency?: string; hour?: number; minute?: number; timezone?: string } | null; lastFiredLocalDay?: string | null }} state
 * @param {Date} now
 * @param {string} [timezone] the shop's IANA tz
 * @returns {boolean}
 */
export function isBriefDue(state, now, timezone) {
  const schedule = state?.schedule;
  if (!schedule || schedule.frequency === "off") return false;
  const dueHour = Number(schedule.hour);
  const dueMinute = Number(schedule.minute);
  if (!Number.isFinite(dueHour) || !Number.isFinite(dueMinute)) return false;

  const clock = localClockFor(now, schedule.timezone || timezone || "UTC");
  if (schedule.frequency === "weekdays" && (clock.weekday === "Sat" || clock.weekday === "Sun")) {
    return false;
  }
  if (state.lastFiredLocalDay === clock.localDay) return false; // already fired today
  return clock.hour * 60 + clock.minute >= dueHour * 60 + dueMinute;
}
