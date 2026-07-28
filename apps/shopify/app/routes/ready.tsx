import db from "../db.server";
import {
  buildHealthPayload,
  checkDatabaseHealth,
  readinessStatus,
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
    logger.error("Readiness check failed", {
      err: database.error,
      latencyMs: database.latencyMs,
    });
  }

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
};
