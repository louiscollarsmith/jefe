import db from "../db.server";
import {
  buildHealthPayload,
  checkDatabaseHealth,
} from "../services/deployment-health.server";
import { logger } from "../lib/observability/logger.server";

export const loader = async () => {
  const database = await checkDatabaseHealth(db);

  const payload = {
    ...buildHealthPayload(process.env),
    checks: {
      database: { status: database.status, latencyMs: database.latencyMs },
    },
  };

  if (database.status !== "ok") {
    // Liveness intentionally stays 200: the process is up and able to serve.
    // We log the failing dependency for alerting rather than failing the check,
    // so a transient DB blip cannot cause Railway to recycle a healthy instance.
    // (A stricter readiness gate is a separate, deliberate decision.)
    logger.error("Health check: database probe failed", {
      err: database.error,
      latencyMs: database.latencyMs,
    });
  }

  return new Response(JSON.stringify(payload), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
};
