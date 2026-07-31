import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { logger } from "../lib/observability/logger.server";
import { track } from "../services/analytics/event-log.server";
import {
  CORE_WEB_VITALS,
  classifyWebVital,
  formatWebVital,
  isKnownWebVital,
} from "../lib/observability/web-vitals.server.js";

const log = logger.child({ component: "web-vitals" });

// Cap per beacon so a malformed or abusive client can't flood the log or the DB.
const MAX_METRICS_PER_REPORT = 12;

/**
 * Real-user Web Vitals beacon. The embedded app registers
 * `shopify.webVitals.onReport` (App Bridge) and POSTs the metrics here with the
 * id-token bearer. We record the Core Web Vitals (LCP/INP/CLS) as PII-free
 * `activity_events` (topic "performance") so LCP trends are visible in the ops
 * panel and searchable, log the rest, and only page #jefe-slack (via the ops
 * alerter, deduped per-metric) when a value is genuinely "poor".
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let shopDomain: string;
  try {
    const { session } = await authenticateAppRequest(request);
    shopDomain = session.shop;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  let metrics: Array<{ name?: unknown; value?: unknown }> = [];
  try {
    const body = (await request.json()) as { metrics?: unknown };
    if (Array.isArray(body?.metrics)) {
      metrics = body.metrics as Array<{ name?: unknown; value?: unknown }>;
    }
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  for (const m of metrics.slice(0, MAX_METRICS_PER_REPORT)) {
    const name = String(m?.name ?? "").toUpperCase();
    const value = Number(m?.value);
    if (!isKnownWebVital(name) || !Number.isFinite(value)) continue;

    const band = classifyWebVital(name, value);
    const summary = formatWebVital(name, value);
    const context = { shopDomain, metric: name, value, band };

    if (band === "poor") {
      // Stable message (name only) so the alerter dedupes to ~1 ping / cooldown
      // per metric — the varying value rides in context, not the signature.
      log.error(`Poor Web Vital: ${name}`, context);
    } else if (band === "needs-improvement") {
      log.warn(`Web Vital needs improvement: ${name}`, context);
    } else {
      log.info(`Web Vital: ${name}`, context);
    }

    // Trend the three Core Web Vitals in the ops panel; secondary metrics
    // (FCP/TTFB/FID) are logged only, to keep the event stream lean.
    if (CORE_WEB_VITALS.includes(name)) {
      await track(prisma, {
        type: "web_vital",
        topic: "performance",
        shopDomain,
        summary,
        properties: { metric: name, value, band },
      });
    }
  }

  return new Response(null, { status: 204 });
}

// Resource route — no UI. A stray GET is a 404.
export function loader() {
  return new Response("Not found", { status: 404 });
}
