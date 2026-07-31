import db from "../db.server";
import {
  buildHealthPayload,
  checkDatabaseHealth,
  shouldPageOnDependencyFailure,
  buildWorkerHealth,
  buildDependencyHealth,
} from "../services/deployment-health.server";
import { logger } from "../lib/observability/logger.server";
import { getLatencyPercentiles } from "../lib/observability/perf.server";
import { getWorkerLastTickAt } from "../lib/observability/heartbeat.server";
import { getWebhookHealth } from "../lib/observability/webhook-health.server";
import { getInboundEmailHealth } from "../lib/email/inbound/health.server.js";

export const loader = async () => {
  const database = await checkDatabaseHealth(db);

  const payload = {
    ...buildHealthPayload(process.env),
    checks: {
      database: { status: database.status, latencyMs: database.latencyMs },
      worker: buildWorkerHealth(getWorkerLastTickAt(), {
        enabled: process.env.ENABLE_SHOPIFY_BACKFILL_LOOP !== "false",
      }),
      webhooks: getWebhookHealth(),
      inboundEmail: getInboundEmailHealth(),
      ...buildDependencyHealth(process.env),
    },
    latency: getLatencyPercentiles(),
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
