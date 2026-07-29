// @ts-check

/**
 * Liveness payload for the `/health` route.
 *
 * This stays cheap and dependency-free: if the process can execute this, it is
 * alive. Railway uses `/health` as the service health check, so this must not
 * depend on the database or any external system succeeding. Dependency status
 * (see {@link checkDatabaseHealth}) is attached by the route as informational
 * detail and deliberately does not change the liveness result.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ now?: Date; uptimeSeconds?: number }} [options]
 */
export function buildHealthPayload(env = process.env, options = {}) {
  const now = options.now ?? new Date();
  const uptimeSeconds =
    options.uptimeSeconds ??
    (typeof process !== "undefined" && typeof process.uptime === "function"
      ? Math.round(process.uptime())
      : 0);
  return {
    ok: true,
    environment: env.APP_ENV || env.NODE_ENV || "development",
    version: env.APP_VERSION || env.RAILWAY_GIT_COMMIT_SHA || null,
    timestamp: now.toISOString(),
    uptimeSeconds,
  };
}

/**
 * @typedef {object} DatabaseHealth
 * @property {"ok" | "error"} status
 * @property {number} latencyMs
 * @property {string} [error] Raw error message — for server-side logging only,
 *   never expose this on the public health response.
 */

/**
 * Best-effort database connectivity probe. Runs a trivial `SELECT 1` with a
 * short timeout so a hung connection can't stall the health check. Never throws:
 * failures are returned as `{ status: "error" }` for the caller to log/surface.
 *
 * @param {{ $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown> }} prisma
 * @param {{ timeoutMs?: number; now?: () => number }} [options]
 * @returns {Promise<DatabaseHealth>}
 */
export async function checkDatabaseHealth(prisma, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const clock = options.now ?? (() => Date.now());
  const start = clock();
  try {
    await withTimeout(prisma.$queryRawUnsafe("SELECT 1"), timeoutMs);
    return { status: "ok", latencyMs: clock() - start };
  } catch (error) {
    return {
      status: "error",
      latencyMs: clock() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * HTTP status for a readiness check given the dependency probe results. Unlike
 * `/health` (liveness, always 200 while the process serves), readiness fails
 * closed — `503` when a required dependency is down — so Railway does not
 * promote or keep routing to an instance that cannot do real work.
 *
 * @param {DatabaseHealth} database
 * @returns {200 | 503}
 */
export function readinessStatus(database) {
  return database.status === "ok" ? 200 : 503;
}

/**
 * Whether a failed dependency probe should page (log at ERROR → Slack alert)
 * versus be treated as an expected startup blip (log at WARN → no page).
 *
 * Right after a deploy the DB pool is often still warming (Neon cold start, and
 * preDeploy `npm run migrate` just ran), so the first readiness/health probes can
 * fail and then self-heal within seconds. Paging on those is noise — and with
 * several sessions deploying, it fires constantly and trains the team to ignore
 * the channel. After the grace window a failure is real and pages. Readiness
 * still returns 503 during the window, so Railway holds traffic back correctly.
 *
 * @param {number} uptimeSeconds process uptime in seconds
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function shouldPageOnDependencyFailure(uptimeSeconds, env = process.env) {
  const graceSeconds = Number(env.READINESS_ALERT_GRACE_SECONDS) || 60;
  return uptimeSeconds >= graceSeconds;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
