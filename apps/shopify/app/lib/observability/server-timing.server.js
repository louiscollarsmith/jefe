// @ts-check

import { logger as baseLogger } from "./logger.server.js";
import { recordRouteDuration } from "./perf.server.js";

const log = baseLogger.child({ component: "server-timing" });
const SLOW_ROUTE_MS = 700;

/**
 * One structured timing record per route plus in-memory phase percentiles.
 * Fixed route/phase labels only; request ids are infrastructure correlation
 * identifiers. No URL, form data, query values, or customer data is recorded.
 *
 * @param {Request} request
 * @param {string} route
 * @param {"loader" | "action"} kind
 */
export function createServerRouteTiming(request, route, kind) {
  const startedAt = performance.now();
  /** @type {Record<string, number>} */
  const phases = {};
  let finished = false;

  return {
    /** @template T @param {string} phase @param {() => Promise<T>} run */
    async measure(phase, run) {
      const phaseStartedAt = performance.now();
      try {
        return await run();
      } finally {
        const durationMs = Math.round(performance.now() - phaseStartedAt);
        phases[phase] = durationMs;
        recordRouteDuration(`${route}.${kind}.${phase}`, durationMs);
      }
    },
    /** @param {string} [outcome] */
    finish(outcome = "complete") {
      if (finished) return;
      finished = true;
      const durationMs = Math.round(performance.now() - startedAt);
      recordRouteDuration(`${route}.${kind}`, durationMs);
      const context = {
        route,
        kind,
        outcome,
        durationMs,
        phases,
        requestId: request.headers.get("x-railway-request-id"),
      };
      if (durationMs >= SLOW_ROUTE_MS) log.warn("Slow server route", context);
      else log.info("Server route", context);
    },
  };
}
