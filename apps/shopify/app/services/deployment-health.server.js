// @ts-check

import {
  DEFAULT_LLM_CHAT_FALLBACK_MODEL,
  DEFAULT_LLM_CHAT_FALLBACK_PROVIDER,
  DEFAULT_LLM_CHAT_MODEL,
  DEFAULT_LLM_CHAT_PROVIDER,
  DEFAULT_LLM_FALLBACK_MODEL,
  DEFAULT_LLM_FALLBACK_PROVIDER,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
} from "../lib/llm/config.server.js";

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
    deployment: {
      region: env.RAILWAY_REPLICA_REGION || null,
    },
    timestamp: now.toISOString(),
    uptimeSeconds,
  };
}

/**
 * Report whether a configured Neon runtime URL uses its pooled endpoint without
 * exposing the hostname, username, database, or credentials on `/health`.
 * @param {string | undefined} databaseUrl
 * @returns {boolean | null}
 */
export function isNeonPooledRuntimeUrl(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    if (!hostname.endsWith(".neon.tech")) return null;
    return hostname.includes("-pooler.");
  } catch {
    return null;
  }
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
 * Whether a backfill-loop failure should page (ERROR + Slack) versus be treated
 * as a transient blip (WARN, no page). The loop retries every tick, so a single
 * failed tick — a Neon connection drop, a deploy warmup, a one-off fluke —
 * self-heals on the next tick and is not alert-worthy. Only a SUSTAINED failure
 * pages: once the consecutive-failure streak reaches the threshold
 * (`BACKFILL_LOOP_PAGE_AFTER`, default 3 ≈ 45s at the 15s tick) it is a real
 * outage worth waking someone.
 *
 * Error-agnostic by design: it counts consecutive failed ticks rather than
 * matching Prisma error strings, so a new transient variant (e.g. "Response from
 * the Engine was empty") can't slip through and page on a single self-healing blip.
 *
 * @param {number} consecutiveFailures streak of consecutive failed ticks (>= 1 on a failure)
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function shouldPageOnWorkerError(consecutiveFailures, env = process.env) {
  const pageAfter = Number(env.BACKFILL_LOOP_PAGE_AFTER) || 3;
  return consecutiveFailures >= pageAfter;
}

/**
 * Non-gating worker-loop liveness for `/health`. The backfill loop ticks every
 * ~15s in the web process; if the last tick is older than the stale window the
 * loop is likely wedged (invisible today). Informational only — never flips
 * `/health` off 200.
 *
 * @param {number | null} lastTickAt epoch ms of the last tick (from the heartbeat), or null
 * @param {{ now?: number; staleMs?: number; enabled?: boolean }} [opts]
 * @returns {{ status: "ok" | "stale" | "starting" | "disabled"; lastTickAgoMs: number | null }}
 */
export function buildWorkerHealth(lastTickAt, opts = {}) {
  if (opts.enabled === false) return { status: "disabled", lastTickAgoMs: null };
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 90_000;
  if (lastTickAt == null) return { status: "starting", lastTickAgoMs: null };
  const ago = now - lastTickAt;
  return { status: ago > staleMs ? "stale" : "ok", lastTickAgoMs: ago };
}

/**
 * Non-gating health for the durable fast-onboarding lane. Self-catching so a
 * diagnostic query can never turn liveness into an outage.
 * @param {{ backfillJob: { count: (args: any) => Promise<number> } }} prisma
 * @param {{ now?: Date; staleMs?: number }} [options]
 */
export async function getBootstrapJobHealth(prisma, options = {}) {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.staleMs ?? 15 * 60_000));
  try {
    const [queued, running, failed, stale] = await Promise.all([
      prisma.backfillJob.count({ where: { jobType: "merchant_memory_bootstrap", status: "queued" } }),
      prisma.backfillJob.count({ where: { jobType: "merchant_memory_bootstrap", status: "running" } }),
      prisma.backfillJob.count({ where: { jobType: "merchant_memory_bootstrap", status: "failed" } }),
      prisma.backfillJob.count({
        where: {
          jobType: "merchant_memory_bootstrap",
          OR: [
            { status: "running", startedAt: { lt: staleBefore } },
            { status: "queued", runAfter: { lt: staleBefore } },
          ],
        },
      }),
    ]);
    return { status: "ok", queued, running, failed, stale };
  } catch {
    return { status: "unknown", queued: null, running: null, failed: null, stale: null };
  }
}

/**
 * Cheap dependency presence flags for `/health` — env checks only, no network
 * calls (so `/health` stays fast and can't hang on a flaky external probe).
 * Non-gating: informational, never fails the check.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ email: { configured: boolean }; slack: { configured: boolean }; llm: { enabled: boolean; provider: string; model: string; fallbackProvider: string; fallbackModel: string; chatProvider: string; chatModel: string; chatFallbackProvider: string; chatFallbackModel: string; openAiConfigured: boolean; groqConfigured: boolean; geminiConfigured: boolean; providerKeyPresent: boolean; chatProviderKeyPresent: boolean } }}
 */
export function buildDependencyHealth(env = process.env) {
  const provider = env.LLM_PROVIDER || DEFAULT_LLM_PROVIDER;
  const chatProvider = env.LLM_CHAT_PROVIDER || DEFAULT_LLM_CHAT_PROVIDER;
  const openAiConfigured = Boolean(env.OPENAI_API_KEY);
  const groqConfigured = Boolean(env.GROQ_API_KEY);
  const geminiConfigured = Boolean(env.GEMINI_API_KEY);
  /** @param {string} selectedProvider */
  const keyPresent = (selectedProvider) =>
    selectedProvider === "openai"
      ? openAiConfigured
      : selectedProvider === "groq"
      ? groqConfigured
      : selectedProvider === "gemini"
        ? geminiConfigured
        : false;
  return {
    email: { configured: env.ENABLE_EMAIL === "true" },
    slack: { configured: Boolean(env.ALERT_WEBHOOK_URL) },
    llm: {
      enabled:
        env.LLM_ENABLED === "true" ||
        (env.LLM_ENABLED !== "false" &&
          (openAiConfigured || geminiConfigured || groqConfigured)),
      provider,
      model: env.LLM_MODEL || DEFAULT_LLM_MODEL,
      fallbackProvider: env.LLM_FALLBACK_PROVIDER || DEFAULT_LLM_FALLBACK_PROVIDER,
      fallbackModel: env.LLM_FALLBACK_MODEL || DEFAULT_LLM_FALLBACK_MODEL,
      chatProvider,
      chatModel: env.LLM_CHAT_MODEL || DEFAULT_LLM_CHAT_MODEL,
      chatFallbackProvider:
        env.LLM_CHAT_FALLBACK_PROVIDER || DEFAULT_LLM_CHAT_FALLBACK_PROVIDER,
      chatFallbackModel:
        env.LLM_CHAT_FALLBACK_MODEL || DEFAULT_LLM_CHAT_FALLBACK_MODEL,
      // Reality vs intent: `provider` above is what we INTEND to use, but the
      // provider layer silently substitutes the fallback if the selected
      // provider's key is missing. Surfacing which keys are actually present (and
      // whether the selected provider's key is one of them) makes that silent
      // substitution visible instead of /health reporting a provider that isn't
      // serving. `providerKeyPresent: false` with `enabled: true` = substitution.
      openAiConfigured,
      groqConfigured,
      geminiConfigured,
      providerKeyPresent: keyPresent(provider),
      chatProviderKeyPresent: keyPresent(chatProvider),
    },
  };
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
