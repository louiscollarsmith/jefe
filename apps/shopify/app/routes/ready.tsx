import db from "../db.server";
import {
  buildHealthPayload,
  checkDatabaseHealth,
  readinessStatus,
  shouldPageOnDependencyFailure,
} from "../services/deployment-health.server";
import { logger } from "../lib/observability/logger.server";

/**
 * Readiness probe. Unlike `/health` (liveness — always 200 while the process is
 * up), `/ready` fails closed with `503` when a required dependency (the
 * database) is unreachable, so a broken deploy is not promoted and traffic is
 * not routed to an instance that cannot serve real requests. This is the path
 * Railway's healthcheck points at.
 */
export const loader = async () => {
  const database = await checkDatabaseHealth(db);
  const status = readinessStatus(database);

  const payload = {
    ...buildHealthPayload(process.env),
    ready: status === 200,
    checks: {
      database: { status: database.status, latencyMs: database.latencyMs },
    },
  };

  if (status !== 200) {
    // A DB blip inside the post-deploy grace window is an expected, self-healing
    // startup transient, so log it at WARN (no page). A sustained failure after
    // the window is real and logs at ERROR (pages). 503 is returned either way,
    // so Railway correctly holds traffic back during startup.
    const uptimeSeconds = Math.round(process.uptime());
    const detail = {
      err: database.error,
      latencyMs: database.latencyMs,
      uptimeSeconds,
    };
    if (shouldPageOnDependencyFailure(uptimeSeconds)) {
      logger.error("Readiness check failed", detail);
    } else {
      logger.warn("Readiness check failed during startup grace window", detail);
    }
  }

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
};
