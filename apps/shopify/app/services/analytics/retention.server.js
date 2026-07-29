// @ts-check

/**
 * Event-log retention. `activity_events` and `llm_usage_event` are append-only
 * and would grow forever; this prunes rows older than a configurable window so
 * the tables (and the ops-panel queries over them) stay bounded.
 *
 * OPT-IN: a no-op unless `ENABLE_EVENT_RETENTION=true`. Deleting observability
 * data is irreversible and premature at current volume, so it stays off until
 * the founder turns it on. Windows are env-tunable. Best-effort + non-throwing.
 */

const DAY_MS = 86_400_000;

/** In-memory "already pruned today" guard (a restart may re-run once; harmless). */
let lastPruneDay = /** @type {string | null} */ (null);

/**
 * Delete events older than the given windows. Returns per-table delete counts.
 * Each table is guarded independently so one failure doesn't block the other.
 *
 * @param {any} prisma
 * @param {{ activityDays?: number; usageDays?: number; now?: Date }} [opts]
 * @returns {Promise<{ activityDeleted: number; usageDeleted: number }>}
 */
export async function pruneOldEvents(prisma, opts = {}) {
  const now = opts.now ?? new Date();
  const activityDays = opts.activityDays ?? 365;
  const usageDays = opts.usageDays ?? 365;
  let activityDeleted = 0;
  let usageDeleted = 0;
  try {
    const r = await prisma.activityEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - activityDays * DAY_MS) } },
    });
    activityDeleted = r?.count ?? 0;
  } catch {
    /* best-effort */
  }
  try {
    const r = await prisma.llmUsageEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - usageDays * DAY_MS) } },
    });
    usageDeleted = r?.count ?? 0;
  } catch {
    /* best-effort */
  }
  return { activityDeleted, usageDeleted };
}

/**
 * Run {@link pruneOldEvents} at most once per UTC day, gated on
 * `ENABLE_EVENT_RETENTION`. Safe to call from every worker tick. No-op when
 * disabled; never throws.
 *
 * @param {any} prisma
 * @param {{ logger?: Pick<Console, "info" | "warn" | "error">; now?: Date; env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<{ activityDeleted: number; usageDeleted: number } | null>}
 */
export async function maybePruneOldEvents(prisma, opts = {}) {
  const env = opts.env ?? process.env;
  if (env.ENABLE_EVENT_RETENTION !== "true") return null;
  const now = opts.now ?? new Date();
  const dayKey = now.toISOString().slice(0, 10);
  if (lastPruneDay === dayKey) return null;
  lastPruneDay = dayKey;
  const activityDays = Number(env.EVENT_RETENTION_ACTIVITY_DAYS) || 365;
  const usageDays = Number(env.EVENT_RETENTION_USAGE_DAYS) || 365;
  const result = await pruneOldEvents(prisma, { activityDays, usageDays, now });
  if (result.activityDeleted || result.usageDeleted) {
    opts.logger?.info?.("Pruned old observability events", result);
  }
  return result;
}

/** Test helper: reset the once-per-day guard. */
export function __resetRetention() {
  lastPruneDay = null;
}
