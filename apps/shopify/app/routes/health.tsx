import db from "../db.server";
import {
  buildHealthPayload,
  checkDatabaseHealth,
  shouldPageOnDependencyFailure,
  buildWorkerHealth,
  buildDependencyHealth,
  getBootstrapJobHealth,
  isNeonPooledRuntimeUrl,
} from "../services/deployment-health.server";
import { logger } from "../lib/observability/logger.server";
import {
  getClientNavigationPercentiles,
  getLatencyPercentiles,
  getRouteLatencyPercentiles,
  getSsrRenderLatencyPercentiles,
} from "../lib/observability/perf.server";
import { getChatTurnPercentiles } from "../lib/observability/chat-turn-latency.server.js";
import { getWorkerLastTickAt } from "../lib/observability/heartbeat.server";
import { getWebhookHealth } from "../lib/observability/webhook-health.server";
import { getLlmProviderHealth } from "../lib/observability/llm-provider-health.server";
import { getInboundEmailHealth } from "../lib/email/inbound/health.server.js";
import { getEpisodicEmbeddingConfig } from "../lib/llm/config.server.js";
import { listActionTypes } from "../lib/actions/action-intent.server.js";
import { getActionStepRunHealth } from "../lib/actions/action-step-lifecycle.server.js";
import {
  getEmbeddingHealth,
  getEpisodeIndexHealth,
} from "../lib/observability/embedding-health.server.js";
import { getShopifyIntelligenceCoverageHealth } from "../lib/shopify/intelligence-coverage.server.js";
import { getShopifyApiCatalogHealth } from "../lib/shopify/api/retrieval.server.js";

export const loader = async () => {
  const [database, bootstrapJobs, actionStepRuns] = await Promise.all([
    checkDatabaseHealth(db),
    getBootstrapJobHealth(db),
    getActionStepRunHealth(db),
  ]);
  const episodeIndex =
    database.status === "ok"
      ? await getEpisodeIndexHealth(db).catch((error) => {
          logger.warn("Health check: episode index probe failed", {
            err: error,
          });
          return { status: "unavailable", counts: {}, recentFailures: [] };
        })
      : { status: "unavailable", counts: {}, recentFailures: [] };

  const payload = {
    ...buildHealthPayload(process.env),
    checks: {
      database: {
        status: database.status,
        latencyMs: database.latencyMs,
        pooledEndpoint: isNeonPooledRuntimeUrl(process.env.DATABASE_URL),
      },
      worker: buildWorkerHealth(getWorkerLastTickAt(), {
        enabled: process.env.ENABLE_SHOPIFY_BACKFILL_LOOP !== "false",
      }),
      bootstrapJobs,
      actionStepRuns,
      webhooks: getWebhookHealth(),
      inboundEmail: getInboundEmailHealth(),
      llmFallback: getLlmProviderHealth(),
      episodicEmbedding: {
        ...getEmbeddingHealth(getEpisodicEmbeddingConfig()),
        index: episodeIndex,
      },
      shopifyIntelligence: getShopifyIntelligenceCoverageHealth(),
      shopifyApiCatalog: getShopifyApiCatalogHealth(),
      ...buildDependencyHealth(process.env),
      // Which actions can actually WRITE to a store on this instance. Every go-live so far
      // has been a variable flip with no way to confirm it landed: the running process reads
      // its own env, and nothing outside could see the answer, so "is it live?" was verified
      // by deploying and hoping. This is engine truth (listActionTypes → registered + its
      // execute flag exactly "true"), never the raw env — no secret is exposed, only the
      // booleans an operator needs to trust a changelog entry that says "live".
      actions: listActionTypes(process.env).reduce(
        (acc: Record<string, boolean>, action) => {
          acc[action.actionType] = action.live;
          return acc;
        },
        {},
      ),
    },
    // Compatibility alias: this historical field times React SSR only. It does
    // not include auth/loaders/actions, so use ssrRenderLatency/routeLatency when
    // diagnosing application work.
    latency: getLatencyPercentiles(),
    ssrRenderLatency: getSsrRenderLatencyPercentiles(),
    routeLatency: getRouteLatencyPercentiles(),
    clientNavigation: getClientNavigationPercentiles(),
    // How long merchants are waiting for a chat reply on THIS instance, server-side
    // and as felt in the browser. In-process ring, so it answers "is Jefe slow right
    // now" without putting a query on the health path; the durable history is the
    // `chat_turn` events the ops panel reads.
    chatTurns: getChatTurnPercentiles(),
  };

  if (database.status !== "ok") {
    // Liveness intentionally stays 200: the process is up and able to serve.
    // We log the failing dependency for alerting rather than failing the check,
    // so a transient DB blip cannot cause Railway to recycle a healthy instance.
    // Within the post-deploy grace window the blip is expected and self-heals, so
    // it logs at WARN (no page); a sustained failure after that pages at ERROR.
    const uptimeSeconds = Math.round(process.uptime());
    const detail = {
      err: database.error,
      latencyMs: database.latencyMs,
      uptimeSeconds,
    };
    if (shouldPageOnDependencyFailure(uptimeSeconds)) {
      logger.error("Health check: database probe failed", detail);
    } else {
      logger.warn(
        "Health check: database probe failed during startup grace window",
        detail,
      );
    }
  }

  return new Response(JSON.stringify(payload), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
};
